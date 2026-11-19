// Tension 持久化（P2 Completion Batch 阶段 1，schema v15）。
//
// 边界（与 `tensions.ts` 的纯函数状态机分工）：
// - 状态机、探测、阈值、pairKey 全在 `tensions.ts`，这里**不重写**；
// - 这里只负责「把已经判定过的东西追加成版本行」和「按 pairKey 幂等」；
// - 两侧绑 artifactId + revision，不绑对象；不存 Source / Event 正文。
//
// 追加写：每次状态变化 append 一版（version+1），head = MAX(version)；
// 不 UPDATE、不物理删。旧版本保留，才能回答「它当初为什么是 open」。

import { nowIso, type Db, type SqlParam } from './adapter.js'
import { PREFIX, newId } from './ids.js'
import { CODE, PsycheError } from './errors.js'
import {
  TENSION_ALGORITHM_VERSION,
  assertTransition,
  type TensionActor,
  type TensionCandidate,
  type TensionCandidateItem,
  type TensionDetectOptions,
  type TensionKind,
  type TensionOrigin,
  type TensionRecord,
  type TensionResolution,
  type TensionSide,
  type TensionStatus,
  detectTensions,
  normalizeSubjects,
} from './tensions.js'

/** 仍然「活着」的状态：同一 pairKey 只允许一条。 */
const ACTIVE_STATUSES: readonly TensionStatus[] = Object.freeze(['open', 'investigating', 'parked'])

export interface TensionStoreDeps {
  now?: () => string
  newId?: () => string
}

export interface TensionFilter {
  status?: TensionStatus | readonly TensionStatus[]
  artifactId?: string
  kind?: TensionKind
  limit?: number
}

export interface TensionTransitionInput {
  note?: string | null
  eventId?: string | null
  sourceIds?: readonly string[] | null
  actor?: TensionActor
  resolution?: TensionResolution | null
  resolvedArtifactId?: string | null
  resolvedRevision?: number | null
}

interface TensionRow {
  tension_id: string
  version: number
  pair_key: string
  left_artifact_id: string
  left_revision: number
  left_kind: string
  left_state: string
  left_statement: string
  left_subjects: string
  right_artifact_id: string
  right_revision: number
  right_kind: string
  right_state: string
  right_statement: string
  right_subjects: string
  kind: string
  origin: string
  status: string
  severity: string
  basis: string
  opened_at: string
  opened_by: string
  changed_at: string
  changed_by: string
  resolution: string | null
  note: string | null
  event_id: string | null
  resolved_artifact_id: string | null
  resolved_revision: number | null
  previous_tension_id: string | null
  algorithm_version: string
}

function parseSubjects(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.map((item) => String(item)) : []
  } catch {
    return []
  }
}

function parseBasis(raw: string): TensionRecord['basis'] {
  try {
    const value = JSON.parse(raw) as Partial<TensionRecord['basis']>
    return {
      sharedSubjects: Array.isArray(value.sharedSubjects) ? value.sharedSubjects.map(String) : [],
      similarity: typeof value.similarity === 'number' ? value.similarity : 0,
      negatedLeft: value.negatedLeft === true,
      negatedRight: value.negatedRight === true,
      negationMarkers: Array.isArray(value.negationMarkers) ? value.negationMarkers.map(String) : [],
      algorithmVersion: String(value.algorithmVersion ?? TENSION_ALGORITHM_VERSION),
    }
  } catch {
    return {
      sharedSubjects: [],
      similarity: 0,
      negatedLeft: false,
      negatedRight: false,
      negationMarkers: [],
      algorithmVersion: TENSION_ALGORITHM_VERSION,
    }
  }
}

function sideOf(prefix: 'left' | 'right', row: TensionRow): TensionSide {
  return {
    artifactId: row[`${prefix}_artifact_id`],
    revision: Number(row[`${prefix}_revision`]),
    kind: row[`${prefix}_kind`],
    state: row[`${prefix}_state`],
    statement: row[`${prefix}_statement`],
    subjectRefs: parseSubjects(row[`${prefix}_subjects`]),
  }
}

function recordOf(row: TensionRow): TensionRecord {
  return {
    tensionId: row.tension_id,
    version: Number(row.version),
    pairKey: row.pair_key,
    left: sideOf('left', row),
    right: sideOf('right', row),
    kind: row.kind as TensionKind,
    origin: row.origin as TensionOrigin,
    status: row.status as TensionStatus,
    severity: row.severity as TensionRecord['severity'],
    basis: parseBasis(row.basis),
    openedAt: row.opened_at,
    openedBy: row.opened_by as TensionActor,
    changedAt: row.changed_at,
    changedBy: row.changed_by as TensionActor,
    resolution: (row.resolution as TensionResolution | null) ?? null,
    note: row.note,
    eventId: row.event_id,
    resolvedArtifactId: row.resolved_artifact_id,
    resolvedRevision: row.resolved_revision === null ? null : Number(row.resolved_revision),
    previousTensionId: row.previous_tension_id,
  }
}

const SELECT_COLUMNS = `tension_id, version, pair_key,
  left_artifact_id, left_revision, left_kind, left_state, left_statement, left_subjects,
  right_artifact_id, right_revision, right_kind, right_state, right_statement, right_subjects,
  kind, origin, status, severity, basis, opened_at, opened_by, changed_at, changed_by,
  resolution, note, event_id, resolved_artifact_id, resolved_revision, previous_tension_id,
  algorithm_version`

/** 一条张力的 head（MAX(version)）。 */
export function getTension(db: Db, tensionId: string): TensionRecord | null {
  const row = db.get<TensionRow>(
    `SELECT ${SELECT_COLUMNS} FROM tension_versions
      WHERE tension_id = ?
      ORDER BY version DESC LIMIT 1`,
    [tensionId],
  )
  return row ? recordOf(row) : null
}

/** 按 pairKey 找仍然活着的记录（幂等登记用）。 */
export function findActiveTensionByPair(db: Db, pairKey: string): TensionRecord | null {
  const row = db.get<TensionRow>(
    `SELECT ${SELECT_COLUMNS} FROM tension_versions t
      WHERE t.pair_key = ? AND t.status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})
        AND t.version = (SELECT MAX(version) FROM tension_versions x WHERE x.tension_id = t.tension_id)
      ORDER BY t.opened_at DESC LIMIT 1`,
    [pairKey, ...ACTIVE_STATUSES],
  )
  return row ? recordOf(row) : null
}

/** 列出 head（一条张力只出现一次）。 */
export function listTensions(db: Db, filter: TensionFilter = {}): TensionRecord[] {
  const clauses: string[] = [
    `t.version = (SELECT MAX(version) FROM tension_versions x WHERE x.tension_id = t.tension_id)`,
  ]
  const params: SqlParam[] = []
  const statuses = filter.status === undefined ? [] : Array.isArray(filter.status) ? [...filter.status] : [filter.status]
  if (statuses.length > 0) {
    clauses.push(`t.status IN (${statuses.map(() => '?').join(', ')})`)
    params.push(...statuses)
  }
  if (filter.artifactId) {
    clauses.push(`(t.left_artifact_id = ? OR t.right_artifact_id = ?)`)
    params.push(filter.artifactId, filter.artifactId)
  }
  if (filter.kind) {
    clauses.push(`t.kind = ?`)
    params.push(filter.kind)
  }
  const limit = Math.max(1, Math.min(200, Math.floor(filter.limit ?? 50)))
  params.push(limit)
  const rows = db.all<TensionRow>(
    `SELECT ${SELECT_COLUMNS} FROM tension_versions t
      WHERE ${clauses.join(' AND ')}
      ORDER BY t.changed_at DESC, t.tension_id ASC
      LIMIT ?`,
    params,
  )
  return rows.map(recordOf)
}

function insertVersion(db: Db, record: TensionRecord): void {
  db.run(
    `INSERT INTO tension_versions (
       tension_id, version, pair_key,
       left_artifact_id, left_revision, left_kind, left_state, left_statement, left_subjects,
       right_artifact_id, right_revision, right_kind, right_state, right_statement, right_subjects,
       kind, origin, status, severity, basis, opened_at, opened_by, changed_at, changed_by,
       resolution, note, event_id, resolved_artifact_id, resolved_revision, previous_tension_id,
       algorithm_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.tensionId,
      record.version,
      record.pairKey,
      record.left.artifactId,
      record.left.revision,
      record.left.kind,
      record.left.state,
      record.left.statement,
      JSON.stringify(record.left.subjectRefs),
      record.right.artifactId,
      record.right.revision,
      record.right.kind,
      record.right.state,
      record.right.statement,
      JSON.stringify(record.right.subjectRefs),
      record.kind,
      record.origin,
      record.status,
      record.severity,
      JSON.stringify(record.basis),
      record.openedAt,
      record.openedBy,
      record.changedAt,
      record.changedBy,
      record.resolution,
      record.note,
      record.eventId,
      record.resolvedArtifactId,
      record.resolvedRevision,
      record.previousTensionId,
      TENSION_ALGORITHM_VERSION,
    ],
  )
}

/**
 * 登记一条候选张力。**幂等**：同一 pairKey 已有活着的记录时直接返回它。
 * 返回 `{ record, created }`——`created=false` 表示是既有记录，调用方不要重复计数。
 */
export function registerTension(
  db: Db,
  candidate: TensionCandidate,
  actor: TensionActor = 'core',
  deps: TensionStoreDeps = {},
): { record: TensionRecord; created: boolean } {
  const existing = findActiveTensionByPair(db, candidate.pairKey)
  if (existing) return { record: existing, created: false }

  const at = (deps.now ?? nowIso)()
  const record: TensionRecord = {
    tensionId: (deps.newId ?? (() => newId(PREFIX.tension)))(),
    version: 1,
    pairKey: candidate.pairKey,
    left: candidate.left,
    right: candidate.right,
    kind: candidate.kind,
    origin: 'clash',
    status: 'open',
    severity: 'medium',
    basis: candidate.basis,
    openedAt: at,
    openedBy: actor,
    changedAt: at,
    changedBy: actor,
    resolution: null,
    note: null,
    eventId: null,
    resolvedArtifactId: null,
    resolvedRevision: null,
    previousTensionId: null,
  }
  insertVersion(db, record)
  return { record, created: true }
}

/**
 * 状态转移：按 `assertTransition` 校验后追加新版本。**写库、不开事务**（调用方负责事务）。
 * 返回新 head。注意 `withdrawn` 是终态；再次出现由新 pairKey 自然生成新记录。
 */
export function transitionTension(
  db: Db,
  tensionId: string,
  to: TensionStatus,
  input: TensionTransitionInput = {},
  deps: TensionStoreDeps = {},
): TensionRecord {
  const current = getTension(db, tensionId)
  if (!current) throw new PsycheError(CODE.notFound, `张力不存在：${tensionId}`)
  const { reopened } = assertTransition(current.status, to, {
    eventId: input.eventId ?? null,
    note: input.note ?? null,
    sourceIds: input.sourceIds ?? null,
  })
  const at = (deps.now ?? nowIso)()
  const actor = input.actor ?? 'human'
  const next: TensionRecord = {
    ...current,
    version: current.version + 1,
    status: to,
    changedAt: at,
    changedBy: actor,
    note: input.note ?? current.note,
    eventId: input.eventId ?? current.eventId,
    resolution: input.resolution ?? current.resolution,
    resolvedArtifactId: input.resolvedArtifactId ?? current.resolvedArtifactId,
    resolvedRevision: input.resolvedRevision ?? current.resolvedRevision,
    // 解决后重开：指回自己（历史串联），创建时保持原值
    previousTensionId: reopened ? tensionId : current.previousTensionId,
  }
  insertVersion(db, next)
  return next
}

/**
 * 探测 + 落库。只处理 `allowStates`（默认 active / challenged），只登记新 pairKey，
 * 不自动解决已有张力——解决需要人/规则裁决，不能由探测猜。
 */
export function syncTensions(
  db: Db,
  items: readonly TensionCandidateItem[],
  options: TensionDetectOptions & { actor?: TensionActor } = {},
  deps: TensionStoreDeps = {},
): { created: number; skipped: number; tensionIds: string[] } {
  const existing = new Set<string>()
  for (const row of db.all<{ pair_key: string }>(
    `SELECT DISTINCT t.pair_key FROM tension_versions t
      WHERE t.status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})
        AND t.version = (SELECT MAX(version) FROM tension_versions x WHERE x.tension_id = t.tension_id)`,
    [...ACTIVE_STATUSES],
  )) {
    existing.add(row.pair_key)
  }
  const candidates = detectTensions(items, { ...options, existingPairKeys: existing })
  const tensionIds: string[] = []
  let created = 0
  for (const candidate of candidates) {
    const result = registerTension(db, candidate, options.actor ?? 'core', deps)
    if (result.created) {
      created += 1
      tensionIds.push(result.record.tensionId)
    }
  }
  return { created, skipped: candidates.length - created, tensionIds }
}
