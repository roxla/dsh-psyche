// P6-2：自主意愿的持久化与选择反馈。
//
// 契约（GPT P6-2 冻结裁决）：
// - 状态机：internal -> deferred -> abandoned/expired；终态不可原地复活。
// - semantic_key 稳定：同一 persona 下，非终态同一 semantic_key 只保留一条。
// - 每 Persona 最多 3 条非终态；TTL 24h 自首次创建，恢复不刷新。
// - 状态物化与 intention_events 追加必须在同一事务。
// - observed 只代表「被投影观察」，不等于用户确认、经验学习或行动。
// - 证据撤销/失效时停止投影；TTL 到期只改状态，不物理删除。
import { createHash } from 'node:crypto'
import type { Db } from './adapter.js'
import type { ChoiceDecision, IntentionChoice } from './intention-choice.js'
import type { IntentionCandidate } from './intention-candidate.js'

export const INTENTION_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_ACTIVE_INTENTIONS = 3
/** 终态去重窗口：窗口内同一 semantic_key + 同一证据摘要不得复活。 */
export const INTENTION_REVIVAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export type IntentionStatus = 'internal' | 'deferred' | 'abandoned' | 'expired'
export type IntentionEventAction = 'created' | 'chosen' | 'deferred' | 'abandoned' | 'expired' | 'observed'

export interface IntentionRow {
  intentionId: string
  personaId: string
  attentionId: string
  semanticKey: string
  type: string
  statement: string
  score: number
  status: IntentionStatus
  scope: string
  evidenceIds: string[]
  evidenceDigest: string
  reasonCode: string | null
  reevaluateAt: number | null
  reevaluateCondition: string | null
  revision: number
  createdAt: number
  updatedAt: number
  expiresAt: number
  terminalAt: number | null
}

export interface ReconcileResult {
  created: number
  updated: number
  deferred: number
  abandoned: number
  expired: number
  skipped: number
}

interface RawRow {
  intention_id: string
  persona_id: string
  attention_id: string
  semantic_key: string
  type: string
  statement: string
  score: number
  status: IntentionStatus
  scope: string
  evidence_json: string
  evidence_digest: string
  reason_code: string | null
  reevaluate_at: number | null
  reevaluate_condition: string | null
  revision: number
  created_at: number
  updated_at: number
  expires_at: number
  terminal_at: number | null
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 去掉系统播报腔，保留一句人话；与 src/lib/intention-context.ts 同口径。 */
export function normalizeIntentionStatement(text: string): string {
  return text
    .replace(/(检测到|内部触发|系统播报|已生成)[：:，,\s]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

export function scopeKeyOf(scope: IntentionCandidate['scope']): string {
  if (scope.kind === 'personal') return 'personal'
  return `${scope.kind}:${scope.id}`
}

export function semanticKeyOf(personaId: string, type: string, statement: string, scope: IntentionCandidate['scope']): string {
  const seed = `${personaId}|${type}|${normalizeIntentionStatement(statement)}|${scopeKeyOf(scope)}`
  return `sem:${sha256(seed).slice(0, 24)}`
}

export function evidenceDigestOf(evidenceIds: readonly string[]): string {
  const sorted = [...evidenceIds].map((id) => id.trim()).filter((id) => id.length > 0).sort()
  return `ev:${sha256(sorted.join('|')).slice(0, 24)}`
}

function parseEvidence(json: string): string[] {
  try {
    const value = JSON.parse(json)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function toRow(row: RawRow): IntentionRow {
  return {
    intentionId: row.intention_id,
    personaId: row.persona_id,
    attentionId: row.attention_id,
    semanticKey: row.semantic_key,
    type: row.type,
    statement: row.statement,
    score: row.score,
    status: row.status,
    scope: row.scope,
    evidenceIds: parseEvidence(row.evidence_json),
    evidenceDigest: row.evidence_digest,
    reasonCode: row.reason_code,
    reevaluateAt: row.reevaluate_at,
    reevaluateCondition: row.reevaluate_condition,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    terminalAt: row.terminal_at,
  }
}

function appendEvent(
  db: Db,
  input: {
    intentionId: string
    personaId: string
    action: IntentionEventAction
    at: number
    reasonCode?: string
    detail?: unknown
  },
): void {
  db.prepare(
    `INSERT INTO intention_events (intention_id, persona_id, action, at, reason_code, detail_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.intentionId,
    input.personaId,
    input.action,
    input.at,
    input.reasonCode ?? null,
    input.detail === undefined ? null : JSON.stringify(input.detail),
  )
}

export function getIntention(db: Db, intentionId: string): IntentionRow | null {
  const row = db.get<RawRow>(`SELECT * FROM intentions WHERE intention_id=?`, [intentionId])
  return row ? toRow(row) : null
}

export function listIntentions(
  db: Db,
  options: { personaId?: string; statuses?: readonly IntentionStatus[]; limit?: number } = {},
): IntentionRow[] {
  const personaId = options.personaId ?? 'main'
  const statuses = options.statuses ?? ['internal', 'deferred']
  const placeholders = statuses.map(() => '?').join(',')
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100))
  return db
    .all<RawRow>(
      `SELECT * FROM intentions WHERE persona_id=? AND status IN (${placeholders})
        ORDER BY score DESC, created_at ASC LIMIT ?`,
      [personaId, ...statuses, limit],
    )
    .map(toRow)
}

export function listIntentionEvents(db: Db, intentionId: string): { action: IntentionEventAction; at: number; reasonCode: string | null }[] {
  return db
    .all<{ action: IntentionEventAction; at: number; reason_code: string | null }>(
      `SELECT action, at, reason_code FROM intention_events WHERE intention_id=? ORDER BY event_id ASC`,
      [intentionId],
    )
    .map((row) => ({ action: row.action, at: row.at, reasonCode: row.reason_code }))
}

function expireOverdue(db: Db, personaId: string, nowMs: number): number {
  const overdue = db.all<{ intention_id: string }>(
    `SELECT intention_id FROM intentions
      WHERE persona_id=? AND status IN ('internal','deferred') AND expires_at <= ?`,
    [personaId, nowMs],
  )
  for (const row of overdue) {
    db.prepare(
      `UPDATE intentions SET status='expired', terminal_at=?, updated_at=?, reason_code='ttl' WHERE intention_id=?`,
    ).run(nowMs, nowMs, row.intention_id)
    appendEvent(db, { intentionId: row.intention_id, personaId, action: 'expired', at: nowMs, reasonCode: 'ttl' })
  }
  return overdue.length
}

function decisionFor(decisions: readonly ChoiceDecision[], intentionId: string): ChoiceDecision | null {
  return decisions.find((decision) => decision.intentionId === intentionId) ?? null
}

/**
 * 把本轮候选与选择结果落库。
 *
 * 只持久化「内部关注/延后/放弃」；不产生 Draft/Approval/Outbox，不发消息。
 * 同一 semantic_key 的终态在同一证据摘要下不会复活；新证据才允许新建候选。
 */
export function reconcileIntentions(
  db: Db,
  input: {
    now: string
    personaId?: string
    candidates: readonly IntentionCandidate[]
    decisions: readonly ChoiceDecision[]
  },
): ReconcileResult {
  const personaId = (input.personaId ?? 'main').trim()
  const nowMs = Date.parse(input.now)
  const result: ReconcileResult = { created: 0, updated: 0, deferred: 0, abandoned: 0, expired: 0, skipped: 0 }
  if (!Number.isFinite(nowMs) || personaId.length === 0) return result

  return db.transaction(() => {
    result.expired = expireOverdue(db, personaId, nowMs)

    const active = listIntentions(db, { personaId, statuses: ['internal', 'deferred'], limit: 100 })
    const activeBySemantic = new Map(active.map((row) => [row.semanticKey, row]))
    let activeCount = active.length

    for (const candidate of input.candidates) {
      const decision = decisionFor(input.decisions, candidate.intentionId)
      if (!decision) {
        result.skipped += 1
        continue
      }
      const statement = normalizeIntentionStatement(candidate.title)
      if (statement.length === 0) {
        result.skipped += 1
        continue
      }
      const semanticKey = semanticKeyOf(personaId, candidate.kind, statement, candidate.scope)
      const scope = scopeKeyOf(candidate.scope)
      const evidenceIds = [...new Set(candidate.evidenceIds)].filter((id) => typeof id === 'string' && id.length > 0).sort()
      const evidenceDigest = evidenceDigestOf(evidenceIds)
      const evidenceJson = JSON.stringify(evidenceIds)
      const existing = activeBySemantic.get(semanticKey)

      if (existing) {
        const nextChoice: IntentionChoice = decision.choice === 'abandon' ? 'abandon' : decision.choice
        if (nextChoice === 'abandon') {
          db.prepare(
            `UPDATE intentions SET status='abandoned', reason_code=?, terminal_at=?, updated_at=?, revision=revision+1
              WHERE intention_id=?`,
          ).run(decision.reason, nowMs, nowMs, existing.intentionId)
          appendEvent(db, {
            intentionId: existing.intentionId,
            personaId,
            action: 'abandoned',
            at: nowMs,
            reasonCode: decision.reason,
          })
          activeBySemantic.delete(semanticKey)
          activeCount -= 1
          result.abandoned += 1
          continue
        }

        const nextStatus: IntentionStatus = nextChoice === 'internal' ? 'internal' : 'deferred'
        const digestChanged = evidenceDigest !== existing.evidenceDigest
        const statusChanged = nextStatus !== existing.status
        const revisitAt = decision.revisitAt ? Date.parse(decision.revisitAt) : null
        const revisitChanged =
          (revisitAt ?? null) !== (existing.reevaluateAt ?? null) ||
          (decision.revisitCondition ?? null) !== (existing.reevaluateCondition ?? null)

        if (!digestChanged && !statusChanged && !revisitChanged) {
          result.skipped += 1
          continue
        }
        if (digestChanged || statusChanged || revisitChanged) {
          db.prepare(
            `UPDATE intentions SET status=?, evidence_json=?, evidence_digest=?, reason_code=?,
               reevaluate_at=?, reevaluate_condition=?, updated_at=?, revision=revision+1
             WHERE intention_id=?`,
          ).run(
            nextStatus,
            evidenceJson,
            evidenceDigest,
            nextStatus === 'internal' ? null : decision.reason,
            nextStatus === 'deferred' ? revisitAt : null,
            nextStatus === 'deferred' ? (decision.revisitCondition ?? null) : null,
            nowMs,
            existing.intentionId,
          )
          if (statusChanged) {
            appendEvent(db, {
              intentionId: existing.intentionId,
              personaId,
              action: nextStatus === 'internal' ? 'chosen' : 'deferred',
              at: nowMs,
              reasonCode: nextStatus === 'internal' ? 'selected' : decision.reason,
            })
          }
          result.updated += 1
        }
        continue
      }

      // 终态去重：窗口内同一语义键 + 同一证据摘要不得复活。
      const terminal = db.get<RawRow>(
        `SELECT * FROM intentions
          WHERE persona_id=? AND semantic_key=? AND status IN ('abandoned','expired')
            AND terminal_at IS NOT NULL AND terminal_at >= ?
          ORDER BY terminal_at DESC LIMIT 1`,
        [personaId, semanticKey, nowMs - INTENTION_REVIVAL_WINDOW_MS],
      )
      if (terminal && toRow(terminal).evidenceDigest === evidenceDigest) {
        result.skipped += 1
        continue
      }

      if (activeCount >= MAX_ACTIVE_INTENTIONS) {
        result.skipped += 1
        continue
      }

      if (decision.choice === 'abandon') {
        insertIntention(db, {
          candidate,
          personaId,
          semanticKey,
          statement,
          scope,
          evidenceIds,
          evidenceDigest,
          evidenceJson,
          status: 'abandoned',
          reasonCode: decision.reason,
          reevaluateAt: null,
          reevaluateCondition: null,
          nowMs,
          score: candidate.score,
        })
        appendEvent(db, {
          intentionId: candidate.intentionId,
          personaId,
          action: 'abandoned',
          at: nowMs,
          reasonCode: decision.reason,
        })
        result.abandoned += 1
        continue
      }

      const status: IntentionStatus = decision.choice === 'internal' ? 'internal' : 'deferred'
      insertIntention(db, {
        candidate,
        personaId,
        semanticKey,
        statement,
        scope,
        evidenceIds,
        evidenceDigest,
        evidenceJson,
        status,
        reasonCode: status === 'deferred' ? decision.reason : null,
        reevaluateAt: status === 'deferred' && decision.revisitAt ? Date.parse(decision.revisitAt) : null,
        reevaluateCondition: status === 'deferred' ? (decision.revisitCondition ?? null) : null,
        nowMs,
        score: candidate.score,
      })
      appendEvent(db, {
        intentionId: candidate.intentionId,
        personaId,
        action: 'created',
        at: nowMs,
        reasonCode: decision.reason,
      })
      appendEvent(db, {
        intentionId: candidate.intentionId,
        personaId,
        action: status === 'internal' ? 'chosen' : 'deferred',
        at: nowMs,
        reasonCode: decision.reason,
      })
      activeBySemantic.set(semanticKey, (getIntention(db, candidate.intentionId) as IntentionRow))
      activeCount += 1
      result.created += 1
      if (status === 'deferred') result.deferred += 1
    }

    return result
  })
}

function insertIntention(
  db: Db,
  input: {
    candidate: IntentionCandidate
    personaId: string
    semanticKey: string
    statement: string
    scope: string
    evidenceIds: string[]
    evidenceDigest: string
    evidenceJson: string
    status: IntentionStatus
    reasonCode: string | null
    reevaluateAt: number | null
    reevaluateCondition: string | null
    nowMs: number
    score: number
  },
): void {
  const candidateExpiry = Date.parse(input.candidate.expiresAt)
  const expiresAt =
    Number.isFinite(candidateExpiry) && candidateExpiry > input.nowMs
      ? Math.min(input.nowMs + INTENTION_TTL_MS, candidateExpiry)
      : input.nowMs + INTENTION_TTL_MS
  db.prepare(
    `INSERT INTO intentions (
       intention_id, persona_id, attention_id, semantic_key, type, statement, score, status, scope,
       evidence_json, evidence_digest, reason_code, reevaluate_at, reevaluate_condition,
       revision, created_at, updated_at, expires_at, terminal_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    input.candidate.intentionId,
    input.personaId,
    input.candidate.attentionId,
    input.semanticKey,
    input.candidate.kind,
    input.statement,
    input.score,
    input.status,
    input.scope,
    input.evidenceJson,
    input.evidenceDigest,
    input.reasonCode,
    input.reevaluateAt,
    input.reevaluateCondition,
    input.nowMs,
    input.nowMs,
    expiresAt,
    input.status === 'abandoned' ? input.nowMs : null,
  )
}

/** 记录「被投影观察」；只对仍存活的 internal/deferred 生效，不改变状态。 */
export function markIntentionsObserved(
  db: Db,
  input: { now: string; personaId?: string; intentionIds: readonly string[] },
): number {
  const nowMs = Date.parse(input.now)
  const personaId = input.personaId ?? 'main'
  if (!Number.isFinite(nowMs) || input.intentionIds.length === 0) return 0
  const unique = [...new Set(input.intentionIds)].filter((id) => typeof id === 'string' && id.length > 0)
  return db.transaction(() => {
    let appended = 0
    for (const intentionId of unique) {
      const row = db.get<{ status: IntentionStatus }>(`SELECT status FROM intentions WHERE intention_id=? AND persona_id=?`, [
        intentionId,
        personaId,
      ])
      if (!row || (row.status !== 'internal' && row.status !== 'deferred')) continue
      appendEvent(db, { intentionId, personaId, action: 'observed', at: nowMs, detail: { source: 'projection' } })
      appended += 1
    }
    return appended
  })
}

/** 主动延后：只允许 internal/deferred；revisitAt 必须落在 now 与 expiresAt 之间；不延长 TTL。 */
export function deferIntention(
  db: Db,
  input: {
    now: string
    intentionId: string
    personaId?: string
    reason: string
    revisitAt: string
    condition: string
  },
): boolean {
  const nowMs = Date.parse(input.now)
  const revisitMs = Date.parse(input.revisitAt)
  const personaId = input.personaId ?? 'main'
  if (!Number.isFinite(nowMs) || !Number.isFinite(revisitMs) || revisitMs <= nowMs) return false
  return db.transaction(() => {
    const row = db.get<{
      status: IntentionStatus
      expires_at: number
      reevaluate_at: number | null
      reevaluate_condition: string | null
      reason_code: string | null
    }>(
      `SELECT status, expires_at, reevaluate_at, reevaluate_condition, reason_code
         FROM intentions WHERE intention_id=? AND persona_id=?`,
      [input.intentionId, personaId],
    )
    if (!row || (row.status !== 'internal' && row.status !== 'deferred')) return false
    if (revisitMs >= row.expires_at) return false
    if (
      row.status === 'deferred' &&
      row.reevaluate_at === revisitMs &&
      row.reevaluate_condition === input.condition &&
      row.reason_code === input.reason
    ) {
      return true
    }
    db.prepare(
      `UPDATE intentions SET status='deferred', reason_code=?, reevaluate_at=?, reevaluate_condition=?,
         updated_at=?, revision=revision+1
       WHERE intention_id=?`,
    ).run(input.reason, revisitMs, input.condition, nowMs, input.intentionId)
    appendEvent(db, {
      intentionId: input.intentionId,
      personaId,
      action: 'deferred',
      at: nowMs,
      reasonCode: input.reason,
    })
    return true
  })
}

/** 主动放弃（例如证据撤销）；终态，不删除历史。 */
export function abandonIntention(
  db: Db,
  input: { now: string; intentionId: string; personaId?: string; reason: string },
): boolean {
  const nowMs = Date.parse(input.now)
  const personaId = input.personaId ?? 'main'
  if (!Number.isFinite(nowMs)) return false
  return db.transaction(() => {
    const row = db.get<{ status: IntentionStatus }>(`SELECT status FROM intentions WHERE intention_id=? AND persona_id=?`, [
      input.intentionId,
      personaId,
    ])
    if (!row || row.status === 'abandoned' || row.status === 'expired') return false
    db.prepare(
      `UPDATE intentions SET status='abandoned', reason_code=?, terminal_at=?, updated_at=?, revision=revision+1
        WHERE intention_id=?`,
    ).run(input.reason, nowMs, nowMs, input.intentionId)
    appendEvent(db, {
      intentionId: input.intentionId,
      personaId,
      action: 'abandoned',
      at: nowMs,
      reasonCode: input.reason,
    })
    return true
  })
}
