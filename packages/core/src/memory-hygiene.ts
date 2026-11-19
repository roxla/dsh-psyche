/**
 * P5-5 记忆整理与淡忘（append-only 事件账本）。
 *
 * 边界（P5-5 冻结方案）：
 * - 只写事件，不搬动 evidence、不改 revision、不删除历史；
 * - 合并要求同一可见域：从双方证据推导来源域集合必须完全相等，disclosure 必须相同；
 * - 一个 duplicate 只能有一个有效 canonical；禁止自合并与链式合并；
 * - 当前态由最大事件 id 决定，不按时间字符串排序；
 * - 所有写操作要求 Owner 身份 `os:`，并在事务内复核当前态；
 * - stale 只给候选，不自动归档；受保护类型不进入候选。
 */
import type { Db } from './adapter.js'
import { PREFIX } from './ids.js'

export type MemoryEventAction = 'merge' | 'unmerge' | 'archive' | 'restore'

export interface MemoryWriteOptions {
  by: string
  reason?: string
  now?: Date
  personaId?: string
}

export interface ArtifactScopeInfo {
  visibility: string[]
  disclosure: string
}

export interface DuplicateCluster {
  key: string
  kind: string
  statement: string
  canonicalId: string
  duplicates: string[]
}

export interface StaleCandidate {
  artifactId: string
  kind: string
  statement: string
  updatedAt: string
  salience: number
  independentEvidenceCount: number
}

const PERSONA = 'main'
const OWNER_PATTERN = /^os:[A-Za-z0-9_.:-]+$/
const PROTECTED_KINDS = new Set(['stance', 'relationship'])

function shaKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

function artifactExists(db: Db, artifactId: string, personaId: string): boolean {
  return (
    db.get('SELECT 1 FROM artifacts WHERE artifact_id = ? AND persona_id = ?', [artifactId, personaId]) !==
    undefined
  )
}

function headRevision(db: Db, artifactId: string): number | null {
  const row = db.get<{ revision: number }>(
    'SELECT max(revision) AS revision FROM artifact_revisions WHERE artifact_id = ?',
    [artifactId],
  )
  return row?.revision ?? null
}

/** 最新事件动作：merge/unmerge/archive/restore 或 null。 */
export function latestMergeAction(db: Db, duplicateArtifactId: string): MemoryEventAction | null {
  const row = db.get<{ action: MemoryEventAction }>(
    `SELECT action FROM memory_merge_events WHERE duplicate_artifact_id = ?
      ORDER BY id DESC LIMIT 1`,
    [duplicateArtifactId],
  )
  return row?.action ?? null
}

export function latestArchiveAction(db: Db, artifactId: string): MemoryEventAction | null {
  const row = db.get<{ action: MemoryEventAction }>(
    `SELECT action FROM memory_archive_events WHERE artifact_id = ?
      ORDER BY id DESC LIMIT 1`,
    [artifactId],
  )
  return row?.action ?? null
}

export function activeCanonicalOf(db: Db, duplicateArtifactId: string): string | null {
  const row = db.get<{ canonical_artifact_id: string }>(
    `SELECT canonical_artifact_id FROM memory_merge_events
      WHERE duplicate_artifact_id = ? ORDER BY id DESC LIMIT 1`,
    [duplicateArtifactId],
  )
  return row?.canonical_artifact_id ?? null
}

/** 从某条 artifact 的最新 revision 证据推导来源域集合与披露等级。 */
export function artifactScopeInfo(db: Db, artifactId: string): ArtifactScopeInfo | null {
  const revision = headRevision(db, artifactId)
  if (revision === null) return null
  const head = db.get<{ disclosure: string }>(
    'SELECT disclosure FROM artifact_revisions WHERE artifact_id = ? AND revision = ?',
    [artifactId, revision],
  )
  if (!head) return null
  const rows = db.all<{
    origin: string | null
    channel: string | null
    room_id: string | null
    sender_contact_id: string | null
  }>(
    `SELECT s.origin AS origin, s.channel AS channel, s.room_id AS room_id,
            s.sender_contact_id AS sender_contact_id
       FROM artifact_evidence e
       JOIN sources s ON s.source_id = e.source_id
      WHERE e.artifact_id = ? AND e.revision = ?`,
    [artifactId, revision],
  )
  if (rows.length === 0) return null
  const visibility = new Set<string>()
  for (const row of rows) {
    const origin = (row.origin ?? '').toLowerCase()
    const channel = (row.channel ?? '').toLowerCase()
    if (row.room_id && (origin === 'group' || channel.includes('group') || channel.includes('room'))) {
      visibility.add(`room:${row.room_id}`)
    } else if (
      row.sender_contact_id &&
      (origin === 'private' || channel.includes('private') || channel.includes('qq'))
    ) {
      visibility.add(`contact:${row.sender_contact_id}`)
    } else {
      visibility.add('personal')
    }
  }
  return { visibility: [...visibility].sort(), disclosure: head.disclosure }
}

function sameScope(a: ArtifactScopeInfo, b: ArtifactScopeInfo): boolean {
  return (
    a.disclosure === b.disclosure &&
    a.visibility.length === b.visibility.length &&
    a.visibility.every((item, index) => item === b.visibility[index])
  )
}

/** 合并：只写事件，不搬 evidence、不改 revision。 */
export function mergeArtifacts(
  db: Db,
  canonicalId: string,
  duplicateId: string,
  options: MemoryWriteOptions,
): { merged: boolean; already: boolean; canonicalId: string; duplicateId: string } {
  if (!OWNER_PATTERN.test(options.by)) throw new Error('E_OWNER_UNVERIFIED')
  const personaId = options.personaId ?? PERSONA
  const at = (options.now ?? new Date()).toISOString()
  return db.transaction(() => {
    if (!artifactExists(db, canonicalId, personaId) || !artifactExists(db, duplicateId, personaId)) {
      throw new Error('E_ARTIFACT_NOT_FOUND')
    }
    if (canonicalId === duplicateId) throw new Error('E_MERGE_SELF')
    if (latestArchiveAction(db, canonicalId) === 'archive') throw new Error('E_MERGE_CANONICAL_ARCHIVED')
    if (latestArchiveAction(db, duplicateId) === 'archive') throw new Error('E_MERGE_DUPLICATE_ARCHIVED')
    if (latestMergeAction(db, canonicalId) === 'merge') throw new Error('E_MERGE_CHAIN')
    if (activeCanonicalOf(db, duplicateId) === canonicalId) {
      return { merged: false, already: true, canonicalId, duplicateId }
    }
    if (latestMergeAction(db, duplicateId) === 'merge') throw new Error('E_MERGE_DUPLICATE_BUSY')
    const canonicalScope = artifactScopeInfo(db, canonicalId)
    const duplicateScope = artifactScopeInfo(db, duplicateId)
    if (!canonicalScope || !duplicateScope || !sameScope(canonicalScope, duplicateScope)) {
      throw new Error('E_SCOPE_MISMATCH')
    }
    // P5-R：合并条件必须在事务内重新校验，不能只信 CLI 传来的两个 ID。
    if (duplicateKeyOf(db, canonicalId) === null || duplicateKeyOf(db, canonicalId) !== duplicateKeyOf(db, duplicateId)) {
      throw new Error('E_NOT_DUPLICATE')
    }
    db.run(
      `INSERT INTO memory_merge_events
         (persona_id, canonical_artifact_id, duplicate_artifact_id, action, at, by, reason)
       VALUES (?, ?, ?, 'merge', ?, ?, ?)`,
      [personaId, canonicalId, duplicateId, at, options.by, options.reason ?? null],
    )
    return { merged: true, already: false, canonicalId, duplicateId }
  })
}

export function unmergeArtifacts(
  db: Db,
  canonicalId: string,
  duplicateId: string,
  options: MemoryWriteOptions,
): { unmerged: boolean; already: boolean } {
  if (!OWNER_PATTERN.test(options.by)) throw new Error('E_OWNER_UNVERIFIED')
  const personaId = options.personaId ?? PERSONA
  const at = (options.now ?? new Date()).toISOString()
  return db.transaction(() => {
    const current = activeCanonicalOf(db, duplicateId)
    if (latestMergeAction(db, duplicateId) !== 'merge' || current !== canonicalId) {
      return { unmerged: false, already: true }
    }
    db.run(
      `INSERT INTO memory_merge_events
         (persona_id, canonical_artifact_id, duplicate_artifact_id, action, at, by, reason)
       VALUES (?, ?, ?, 'unmerge', ?, ?, ?)`,
      [personaId, canonicalId, duplicateId, at, options.by, options.reason ?? null],
    )
    return { unmerged: true, already: false }
  })
}

export function archiveArtifact(
  db: Db,
  artifactId: string,
  options: MemoryWriteOptions,
): { archived: boolean; already: boolean } {
  if (!OWNER_PATTERN.test(options.by)) throw new Error('E_OWNER_UNVERIFIED')
  const personaId = options.personaId ?? PERSONA
  const at = (options.now ?? new Date()).toISOString()
  return db.transaction(() => {
    if (!artifactExists(db, artifactId, personaId)) throw new Error('E_ARTIFACT_NOT_FOUND')
    if (latestArchiveAction(db, artifactId) === 'archive') return { archived: false, already: true }
    db.run(
      `INSERT INTO memory_archive_events (persona_id, artifact_id, action, at, by, reason)
       VALUES (?, ?, 'archive', ?, ?, ?)`,
      [personaId, artifactId, at, options.by, options.reason ?? null],
    )
    return { archived: true, already: false }
  })
}

export function restoreArtifact(
  db: Db,
  artifactId: string,
  options: MemoryWriteOptions,
): { restored: boolean; already: boolean } {
  if (!OWNER_PATTERN.test(options.by)) throw new Error('E_OWNER_UNVERIFIED')
  const personaId = options.personaId ?? PERSONA
  const at = (options.now ?? new Date()).toISOString()
  return db.transaction(() => {
    if (!artifactExists(db, artifactId, personaId)) throw new Error('E_ARTIFACT_NOT_FOUND')
    if (latestArchiveAction(db, artifactId) !== 'archive') return { restored: false, already: true }
    db.run(
      `INSERT INTO memory_archive_events (persona_id, artifact_id, action, at, by, reason)
       VALUES (?, ?, 'restore', ?, ?, ?)`,
      [personaId, artifactId, at, options.by, options.reason ?? null],
    )
    return { restored: true, already: false }
  })
}

interface HeadRow {
  artifact_id: string
  kind: string
  statement: string
  subject_refs: string
  disclosure: string
  updated_at: string
  salience: number
  independent_evidence_count: number
}

function activeHeads(db: Db, personaId: string): HeadRow[] {
  return db.all<HeadRow>(
    `SELECT a.artifact_id AS artifact_id, a.kind AS kind, r.statement AS statement,
            r.subject_refs AS subject_refs, r.disclosure AS disclosure, r.updated_at AS updated_at,
            r.salience AS salience, r.independent_evidence_count AS independent_evidence_count
       FROM artifacts a
       JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
        AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
      WHERE a.persona_id = ?
        AND r.state = 'active'
        ${andMemoryActive('a')}
      ORDER BY r.updated_at DESC, a.artifact_id ASC`,
    [personaId],
  )
}

/** 默认召回应使用的「未被归档且不是活跃 duplicate」谓词；alias 为 artifacts 表别名。 */
export function andMemoryActive(alias: string): string {
  return `AND NOT EXISTS (
    SELECT 1 FROM memory_archive_events mae
     WHERE mae.artifact_id = ${alias}.artifact_id
       AND mae.action = 'archive'
       AND mae.id = (SELECT MAX(id) FROM memory_archive_events WHERE artifact_id = mae.artifact_id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM memory_merge_events mme
     WHERE mme.duplicate_artifact_id = ${alias}.artifact_id
       AND mme.action = 'merge'
       AND mme.id = (SELECT MAX(id) FROM memory_merge_events WHERE duplicate_artifact_id = mme.duplicate_artifact_id)
  )`
}

/** 单条 Artifact 头版本的确定性重复键：kind + statement 哈希 + 排序后的 subject 集合。 */
function duplicateKeyOf(db: Db, artifactId: string): string | null {
  const row = db.get<{ kind: string; statement: string; subject_refs: string }>(
    `SELECT a.kind AS kind, r.statement AS statement, r.subject_refs AS subject_refs
       FROM artifacts a
       JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
        AND r.revision = (SELECT MAX(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
      WHERE a.artifact_id = ?`,
    [artifactId],
  )
  if (!row) return null
  const subjects = parseSubjects(row.subject_refs).sort()
  return `${row.kind}\u0000${shaKey(row.statement)}\u0000${subjects.join(',')}`
}

/** 确定性重复簇：同 kind + 完全相同 statement + subject 集合相同 + 同一可见域/披露等级。 */
export function findDuplicateClusters(db: Db, options: { personaId?: string } = {}): DuplicateCluster[] {  const personaId = options.personaId ?? PERSONA
  const heads = activeHeads(db, personaId)
  const buckets = new Map<string, HeadRow[]>()
  for (const head of heads) {
    const subjects = parseSubjects(head.subject_refs)
    const key = `${head.kind}\u0000${shaKey(head.statement)}\u0000${subjects.join(',')}`
    const list = buckets.get(key) ?? []
    list.push(head)
    buckets.set(key, list)
  }
  const clusters: DuplicateCluster[] = []
  for (const [key, rows] of buckets) {
    if (rows.length < 2) continue
    const byScope = new Map<string, HeadRow[]>()
    for (const row of rows) {
      const info = artifactScopeInfo(db, row.artifact_id)
      if (!info) continue
      const scopeKey = `${info.disclosure}\u0000${info.visibility.join(',')}`
      const list = byScope.get(scopeKey) ?? []
      list.push(row)
      byScope.set(scopeKey, list)
    }
    for (const group of byScope.values()) {
      if (group.length < 2) continue
      const sorted = [...group].sort(
        (a, b) =>
          b.independent_evidence_count - a.independent_evidence_count ||
          a.updated_at.localeCompare(b.updated_at) ||
          a.artifact_id.localeCompare(b.artifact_id),
      )
      clusters.push({
        key,
        kind: sorted[0].kind,
        statement: sorted[0].statement,
        canonicalId: sorted[0].artifact_id,
        duplicates: sorted.slice(1).map((row) => row.artifact_id),
      })
    }
  }
  return clusters.sort((a, b) => a.key.localeCompare(b.key))
}

/** 180 天未更新、低 salience、独立证据 ≤1 的候选；受保护类型不进入。 */
export function findStaleCandidates(
  db: Db,
  options: { personaId?: string; now?: Date; days?: number; maxSalience?: number } = {},
): StaleCandidate[] {
  const personaId = options.personaId ?? PERSONA
  const now = options.now ?? new Date()
  const days = options.days ?? 180
  const maxSalience = options.maxSalience ?? 0.2
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
  return activeHeads(db, personaId)
    .filter(
      (row) =>
        !PROTECTED_KINDS.has(row.kind) &&
        row.updated_at < cutoff &&
        row.salience <= maxSalience &&
        row.independent_evidence_count <= 1,
    )
    .map((row) => ({
      artifactId: row.artifact_id,
      kind: row.kind,
      statement: row.statement,
      updatedAt: row.updated_at,
      salience: row.salience,
      independentEvidenceCount: row.independent_evidence_count,
    }))
}

export function listArchived(db: Db, options: { personaId?: string } = {}): string[] {
  const personaId = options.personaId ?? PERSONA
  return db
    .all<{ artifact_id: string }>(
      `SELECT artifact_id FROM memory_archive_events e
        WHERE e.persona_id = ?
          AND e.action = 'archive'
          AND e.id = (SELECT MAX(id) FROM memory_archive_events WHERE artifact_id = e.artifact_id)
        ORDER BY artifact_id`,
      [personaId],
    )
    .map((row) => row.artifact_id)
}

export function listMergedDuplicates(db: Db, options: { personaId?: string } = {}): string[] {
  const personaId = options.personaId ?? PERSONA
  return db
    .all<{ artifact_id: string }>(
      `SELECT duplicate_artifact_id AS artifact_id FROM memory_merge_events e
        WHERE e.persona_id = ?
          AND e.action = 'merge'
          AND e.id = (SELECT MAX(id) FROM memory_merge_events WHERE duplicate_artifact_id = e.duplicate_artifact_id)
        ORDER BY duplicate_artifact_id`,
      [personaId],
    )
    .map((row) => row.artifact_id)
}

function parseSubjects(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).sort() : []
  } catch {
    return []
  }
}

export { PREFIX as MEMORY_PREFIX }
