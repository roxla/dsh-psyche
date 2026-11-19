/**
 * P5-3b 成长候选确认（append-only 决策账本）。
 *
 * 边界（P5-3b 冻结方案）：
 * - confirm/reject/withdraw 与候选 status 物化在同一事务；
 * - 决策账本 growth_confirmations 是唯一事实源，status 只是同事务物化；
 * - 确认前复算 canonical JSON 哈希，拒绝内容变化后的旧确认；
 * - 撤回只针对已确认候选，追加 withdraw，不删历史；
 * - 投影只读：只返回最新 confirm 且未撤回、scope=personal 的已确认变化；
 *   contact/room 专属变化不在此版本自动跨域投影。
 */
import { createHash } from 'node:crypto'
import type { Db } from './adapter.js'
import { PREFIX, newId } from './ids.js'

export type GrowthDecision = 'confirm' | 'reject' | 'withdraw'
export type GrowthCandidateStatus = 'proposed' | 'superseded' | 'rejected' | 'confirmed' | 'withdrawn'

export interface GrowthCandidateView {
  candidateId: string
  type: string
  statement: string
  scope: string
  subjectRefs: string[]
  independentCount: number
  status: GrowthCandidateStatus
  latestDecision: GrowthDecision | null
  decidedBy: string | null
  decidedAt: string | null
  createdAt: string
}

export interface DecideGrowthOptions {
  candidateId: string
  decision: GrowthDecision
  decidedBy: string
  now?: Date
  personaId?: string
  /** 调用方预先看到的哈希；给出时必须与当前内容一致。 */
  expectedHash?: string
}

export interface ConfirmedGrowthChange {
  candidateId: string
  statement: string
  decidedAt: string
  decidedBy: string
}

const PERSONA = 'main'
const MAX_STATEMENT = 120

interface CandidateRow {
  candidate_id: string
  persona_id: string
  type: string
  statement: string
  scope: string
  subject_refs: string
  independent_count: number
  status: GrowthCandidateStatus
  created_at: string
}

interface SourceRow {
  source_id: string
  independence_key: string
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 固定键序 JSON：数组按字符串排序后拼接，避免属性顺序影响哈希。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

function sourcesOf(db: Db, candidateId: string): SourceRow[] {
  return db
    .all<SourceRow>(
      `SELECT s.source_id, COALESCE(s.independence_key, s.activity_window_key, 'source:'||s.source_id) AS independence_key
         FROM growth_candidate_sources g
         JOIN sources s ON s.source_id = g.source_id
        WHERE g.candidate_id=?
        ORDER BY s.source_id ASC`,
      [candidateId],
    )
    .map((row) => row)
}

/** 候选内容哈希：确认前复算，不与提案时快照一致即拒绝。 */
export function growthCandidateContentHash(db: Db, candidateId: string): { hash: string; sourcesHash: string; evidenceCount: number } {
  const candidate = db.get<CandidateRow>(
    `SELECT candidate_id, persona_id, type, statement, scope, subject_refs, independent_count, status, created_at
       FROM growth_candidates WHERE candidate_id=?`,
    [candidateId],
  )
  if (!candidate) throw new Error('E_CANDIDATE_NOT_FOUND')
  const sources = sourcesOf(db, candidateId)
  const payload = {
    candidateId: candidate.candidate_id,
    type: candidate.type,
    statement: candidate.statement,
    scope: candidate.scope,
    subjectRefs: JSON.parse(candidate.subject_refs || '[]') as string[],
    sources: sources.map((source) => ({ sourceId: source.source_id, independenceKey: source.independence_key })),
  }
  return {
    hash: sha256(canonicalJson(payload)),
    sourcesHash: sha256(canonicalJson(sources.map((source) => source.independence_key))),
    evidenceCount: Number(candidate.independent_count),
  }
}

function latestDecision(db: Db, candidateId: string): { decision: GrowthDecision; decided_by: string; decided_at: string; content_hash: string } | null {
  return (
    db.get<{ decision: GrowthDecision; decided_by: string; decided_at: string; content_hash: string }>(
      `SELECT decision, decided_by, decided_at, content_hash
         FROM growth_confirmations
        WHERE candidate_id=?
        ORDER BY decided_at DESC, rowid DESC LIMIT 1`,
      [candidateId],
    ) ?? null
  )
}

/**
 * 对候选作一次决策。
 *
 * - confirm：候选必须 proposed 且无任何决策；写 confirmed 并追加 confirm；
 * - reject：候选必须 proposed 且无任何决策；写 rejected 并追加 reject；
 * - withdraw：最新决策必须是 confirm；写 withdrawn 并追加 withdraw；
 * - 同一 confirm 重复提交且哈希一致时返回原决策（幂等）。
 */
export function decideGrowthCandidate(db: Db, options: DecideGrowthOptions): {
  decision: GrowthDecision
  candidateId: string
  idempotent: boolean
} {
  const nowText = (options.now ?? new Date()).toISOString()
  const personaId = options.personaId ?? PERSONA
  if (!/^os:[A-Za-z0-9_.:-]+$/.test(options.decidedBy)) throw new Error('E_OWNER_UNVERIFIED')

  const candidate = db.get<CandidateRow>(
    `SELECT candidate_id, persona_id, type, statement, scope, subject_refs, independent_count, status, created_at
       FROM growth_candidates WHERE candidate_id=? AND persona_id=?`,
    [options.candidateId, personaId],
  )
  if (!candidate) throw new Error('E_CANDIDATE_NOT_FOUND')

  return db.transaction(() => {
    const current = growthCandidateContentHash(db, options.candidateId)
    const latest = latestDecision(db, options.candidateId)

    if (options.decision === 'confirm') {
      if (latest?.decision === 'confirm') {
        if (latest.content_hash === current.hash) {
          return { decision: 'confirm' as const, candidateId: candidate.candidate_id, idempotent: true }
        }
        throw new Error('E_CONFIRM_HASH_MISMATCH')
      }
      if (latest) throw new Error('E_CANDIDATE_DECIDED')
      if (candidate.status !== 'proposed') throw new Error('E_CANDIDATE_NOT_PROPOSED')
      if (!options.expectedHash) throw new Error('E_CONFIRM_HASH_REQUIRED')
      if (options.expectedHash !== current.hash) throw new Error('E_CONFIRM_HASH_MISMATCH')
      db.prepare(`UPDATE growth_candidates SET status='confirmed', updated_at=? WHERE candidate_id=?`).run(
        nowText,
        candidate.candidate_id,
      )
      insertDecision(db, candidate, 'confirm', options.decidedBy, nowText, current)
      return { decision: 'confirm' as const, candidateId: candidate.candidate_id, idempotent: false }
    }

    if (options.decision === 'reject') {
      if (latest?.decision === 'reject') {
        return { decision: 'reject' as const, candidateId: candidate.candidate_id, idempotent: true }
      }
      if (latest) throw new Error('E_CANDIDATE_DECIDED')
      if (candidate.status !== 'proposed') throw new Error('E_CANDIDATE_NOT_PROPOSED')
      db.prepare(`UPDATE growth_candidates SET status='rejected', updated_at=? WHERE candidate_id=?`).run(
        nowText,
        candidate.candidate_id,
      )
      insertDecision(db, candidate, 'reject', options.decidedBy, nowText, current)
      return { decision: 'reject' as const, candidateId: candidate.candidate_id, idempotent: false }
    }

    if (latest?.decision !== 'confirm') throw new Error('E_CANDIDATE_NOT_CONFIRMED')
    if (latest.content_hash !== current.hash) throw new Error('E_CONFIRM_HASH_MISMATCH')
    db.prepare(`UPDATE growth_candidates SET status='withdrawn', updated_at=? WHERE candidate_id=?`).run(
      nowText,
      candidate.candidate_id,
    )
    insertDecision(db, candidate, 'withdraw', options.decidedBy, nowText, current)
    return { decision: 'withdraw' as const, candidateId: candidate.candidate_id, idempotent: false }
  }, { important: true })
}

function insertDecision(
  db: Db,
  candidate: CandidateRow,
  decision: GrowthDecision,
  decidedBy: string,
  decidedAt: string,
  snapshot: { hash: string; sourcesHash: string; evidenceCount: number },
): void {
  db.prepare(
    `INSERT INTO growth_confirmations
      (confirmation_id, candidate_id, persona_id, decision, decided_by, decided_at,
       content_hash, statement, scope, evidence_count, sources_hash, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    newId(PREFIX.confirmation),
    candidate.candidate_id,
    candidate.persona_id,
    decision,
    decidedBy,
    decidedAt,
    snapshot.hash,
    candidate.statement,
    candidate.scope,
    snapshot.evidenceCount,
    snapshot.sourcesHash,
    decidedAt,
  )
}

/** 决策可作用的候选状态：撤回只能针对已确认（或已撤回，用于幂等预览）。 */
export function decisionCandidateStatuses(decision: GrowthDecision): GrowthCandidateStatus[] {
  return decision === 'withdraw' ? ['confirmed', 'withdrawn'] : ['proposed']
}

/** 列出候选（默认只看待确认）。 */
export function listGrowthCandidates(db: Db, options: { personaId?: string; status?: GrowthCandidateStatus; limit?: number } = {}): GrowthCandidateView[] {
  const personaId = options.personaId ?? PERSONA
  const status = options.status ?? 'proposed'
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200))
  const rows = db
    .all<CandidateRow>(
      `SELECT candidate_id, persona_id, type, statement, scope, subject_refs, independent_count, status, created_at
         FROM growth_candidates
        WHERE persona_id=? AND status=?
        ORDER BY created_at ASC, candidate_id ASC LIMIT ?`,
      [personaId, status, limit],
    )
    .map((row) => row)
  return rows.map((row) => {
    const latest = latestDecision(db, row.candidate_id)
    return {
      candidateId: row.candidate_id,
      type: row.type,
      statement: row.statement,
      scope: row.scope,
      subjectRefs: JSON.parse(row.subject_refs || '[]') as string[],
      independentCount: Number(row.independent_count),
      status: row.status,
      latestDecision: latest?.decision ?? null,
      decidedBy: latest?.decided_by ?? null,
      decidedAt: latest?.decided_at ?? null,
      createdAt: row.created_at,
    }
  })
}

/** 投影只读：最新 confirm 且无后续 withdraw、scope=personal 的已确认变化。 */
export function readConfirmedGrowthChanges(
  db: Db,
  options: { personaId?: string; limit?: number } = {},
): ConfirmedGrowthChange[] {
  const personaId = options.personaId ?? PERSONA
  const limit = Math.max(1, Math.min(options.limit ?? 3, 10))
  const rows = db
    .all<{ candidate_id: string; statement: string; decided_at: string; decided_by: string; content_hash: string }>(
      `SELECT c.candidate_id, c.statement, g.decided_at, g.decided_by, g.content_hash
         FROM growth_candidates c
         JOIN growth_confirmations g
           ON g.candidate_id = c.candidate_id
          AND g.decision = 'confirm'
        WHERE c.persona_id=? AND c.status='confirmed' AND c.scope='personal'
          AND NOT EXISTS (
            SELECT 1 FROM growth_confirmations w
             WHERE w.candidate_id = c.candidate_id AND w.decision='withdraw'
               AND (w.decided_at > g.decided_at OR (w.decided_at = g.decided_at AND w.rowid > g.rowid))
          )
          AND g.content_hash = (
            SELECT h.content_hash FROM growth_confirmations h
             WHERE h.candidate_id = c.candidate_id AND h.decision='confirm'
             ORDER BY h.decided_at DESC, h.rowid DESC LIMIT 1
          )
        ORDER BY g.decided_at DESC LIMIT ?`,
      [personaId, limit],
    )
    .map((row) => row)
    // P5-R：投影前重新授权——当前内容仍与确认快照一致，且全部证据仍在、未被外部来源删除事件下架。
    .filter((row) => confirmedChangeStillValid(db, row.candidate_id, row.content_hash))
  return rows.map((row) => ({
    candidateId: row.candidate_id,
    statement: truncate(row.statement, MAX_STATEMENT),
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  }))
}

function confirmedChangeStillValid(db: Db, candidateId: string, confirmedHash: string): boolean {
  let current: { hash: string }
  try {
    current = growthCandidateContentHash(db, candidateId)
  } catch {
    return false
  }
  if (current.hash !== confirmedHash) return false
  const sources = db.all<{ source_id: string }>(
    'SELECT source_id FROM growth_candidate_sources WHERE candidate_id = ?',
    [candidateId],
  )
  if (sources.length === 0) return false
  for (const source of sources) {
    const exists = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sources WHERE source_id = ?', [source.source_id])
    if (Number(exists?.n ?? 0) === 0) return false
    const deleted = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM external_source_deletion_events WHERE source_id = ?',
      [source.source_id],
    )
    if (Number(deleted?.n ?? 0) > 0) return false
  }
  return true
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/** 单行投影文本；日期只到天。 */
export function formatConfirmedGrowthLine(change: ConfirmedGrowthChange): string {
  return `最近确认的成长：${change.statement}（${change.decidedAt.slice(0, 10)}）`
}
