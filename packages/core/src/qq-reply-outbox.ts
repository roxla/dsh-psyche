// P4-B-4-1：QQ 私聊离线回复队列（Schema v24）。
//
// 边界（docs/design/p4-b-4-private-reply-outbox.md）：
// - 只接管「已经生成、已经通过授权、尚未确认被 OneBot 接受」的私聊回复；
//   不接管离线收消息、不重新生成模型输出、不碰主动 Outbox / 群聊 / 跨平台。
// - 本模块只做持久化与状态机，不 import 任何 QQ 实现；发送在 B-4-2 接线。
// - 正文只落本表；日志与诊断只允许 replyId / 脱敏引用 / 稳定错误码。
import { createHash } from 'node:crypto'
import type { Db } from './adapter.js'
import { CODE, PsycheError, invalid } from './errors.js'
import type { ChatSendResult } from './chat-transport.js'

export const QQ_REPLY_STATUSES = [
  'pending',
  'dispatching',
  'sent',
  'failed',
  'unknown',
  'expired',
  'cancelled',
] as const

export type QqReplyStatus = (typeof QQ_REPLY_STATUSES)[number]

export const QQ_REPLY_TTL_MS = 30 * 60 * 1000
export const QQ_REPLY_TTL_MIN_MS = 5 * 60 * 1000
export const QQ_REPLY_TTL_MAX_MS = 24 * 60 * 60 * 1000

/** 容量计入 pending + dispatching + unknown；达到上限拒绝，不淘汰。 */
export const QQ_REPLY_GLOBAL_CAPACITY = 500
export const QQ_REPLY_CONTACT_CAPACITY = 100

export const QQ_REPLY_MAX_ATTEMPTS = 3
export const QQ_REPLY_BACKOFF_START_MS = 30 * 1000
export const QQ_REPLY_BACKOFF_MAX_MS = 10 * 60 * 1000

/** 终态正文在活动库保留 24 小时；历史备份遵守独立保留策略。 */
export const QQ_REPLY_RETENTION_MS = 24 * 60 * 60 * 1000

export const QQ_REPLY_ERROR = Object.freeze({
  capacity: 'E_REPLY_OUTBOX_CAPACITY',
  conflict: 'E_REPLY_OUTBOX_CONFLICT',
  conflictState: 'E_REPLY_OUTBOX_STATE',
  ownerMismatch: 'E_REPLY_OUTBOX_OWNER_MISMATCH',
})

export interface QqReplyOutboxRow {
  readonly replyId: string
  readonly personaId: string
  readonly contactId: string
  readonly platform: string
  readonly stableUserId: string
  readonly sessionId: string
  readonly sessionSeq: number
  readonly turn: number | null
  readonly step: number | null
  readonly transportId: string
  readonly targetKind: 'private'
  readonly payloadText: string
  readonly textHash: string
  readonly quoteMessageId: string | null
  readonly status: QqReplyStatus
  readonly attempts: number
  readonly lastErrorCode: string | null
  readonly receipt: string | null
  readonly createdAt: string
  readonly expiresAt: string
  readonly retryAt: string | null
  readonly dispatchStartedAt: string | null
  readonly sentAt: string | null
  readonly terminalAt: string | null
  readonly updatedAt: string
}

interface QqReplyDbRow {
  reply_id: string
  persona_id: string
  contact_id: string
  platform: string
  stable_user_id: string
  session_id: string
  session_seq: number
  turn: number | null
  step: number | null
  transport_id: string
  target_kind: 'private'
  payload_text: string
  text_hash: string
  quote_message_id: string | null
  status: QqReplyStatus
  attempts: number
  last_error_code: string | null
  receipt: string | null
  created_at: string
  expires_at: string
  retry_at: string | null
  dispatch_started_at: string | null
  sent_at: string | null
  terminal_at: string | null
  updated_at: string
}

const QQ_ID = /^[1-9]\d{0,19}$/
const SESSION_PREFIX = 'qq-private-'

function text(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} 必须是非空字符串`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw invalid(`${field} 不能超过 ${max} 字符`)
  return trimmed
}

function optionalText(value: unknown, field: string, max = 500): string | null {
  if (value === undefined || value === null) return null
  return text(value, field, max)
}

function time(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} 必须是非空 ISO 时间`)
  const trimmed = value.trim()
  if (!Number.isFinite(Date.parse(trimmed))) throw invalid(`${field} 不是合法时间：${trimmed}`)
  return trimmed
}

function positiveInt(value: unknown, field: string, max = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw invalid(`${field} 必须是 1..${max} 的整数`)
  }
  return value
}

function optionalInt(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalid(`${field} 必须是非负整数`)
  }
  return value
}

function fail(code: string, message: string): PsycheError {
  return new PsycheError(CODE.state, message, { reason: code })
}

export function hashReplyText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
}

export function replyIdOf(
  personaId: string,
  contactId: string,
  sessionId: string,
  sessionSeq: number,
): string {
  return `qr_${createHash('sha256')
    .update(`${personaId}\u0000${contactId}\u0000${sessionId}\u0000${sessionSeq}`, 'utf8')
    .digest('hex')
    .slice(0, 24)}`
}

export function toQqReplyRow(row: QqReplyDbRow): QqReplyOutboxRow {
  return {
    replyId: row.reply_id,
    personaId: row.persona_id,
    contactId: row.contact_id,
    platform: row.platform,
    stableUserId: row.stable_user_id,
    sessionId: row.session_id,
    sessionSeq: row.session_seq,
    turn: row.turn,
    step: row.step,
    transportId: row.transport_id,
    targetKind: row.target_kind,
    payloadText: row.payload_text,
    textHash: row.text_hash,
    quoteMessageId: row.quote_message_id,
    status: row.status,
    attempts: row.attempts,
    lastErrorCode: row.last_error_code,
    receipt: row.receipt,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    retryAt: row.retry_at,
    dispatchStartedAt: row.dispatch_started_at,
    sentAt: row.sent_at,
    terminalAt: row.terminal_at,
    updatedAt: row.updated_at,
  }
}

export interface QqReplyEnqueueInput {
  readonly personaId: string
  readonly contactId: string
  readonly stableUserId: string
  readonly sessionId: string
  readonly sessionSeq: number
  readonly turn?: number | null
  readonly step?: number | null
  readonly transportId: string
  readonly payloadText: string
  readonly quoteMessageId?: string | null
  readonly ttlMs?: number
  readonly now?: string
}

export interface QqReplyEnqueueResult {
  readonly row: QqReplyOutboxRow
  readonly duplicate: boolean
}

/** 发送前复核：返回稳定原因码则取消该条；返回 null 表示可发送。 */
export type QqReplyAuthorization = (row: QqReplyOutboxRow) => string | null

export interface QqReplyClaimInput {
  readonly limit: number
  readonly authorization: QqReplyAuthorization
  readonly transportCheck: (row: QqReplyOutboxRow) => boolean
  readonly now?: string
}

export interface QqReplyStoreOptions {
  readonly db: Db
  readonly ownerId: string
  readonly now?: () => string
}

/**
 * 私聊回复队列的唯一写入口。
 * 多步写一律走 `db.transaction()`（BEGIN IMMEDIATE）；网络发送不在本类里。
 */
export class QqReplyOutboxStore {
  readonly db: Db
  readonly ownerId: string
  #now: () => string

  constructor(options: QqReplyStoreOptions) {
    this.db = options.db
    this.ownerId = text(options.ownerId, 'ownerId', 120)
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  now(): string {
    return this.#now()
  }

  get(replyId: string): QqReplyOutboxRow | undefined {
    const row = this.db.get<QqReplyDbRow>(`SELECT * FROM qq_reply_outbox WHERE reply_id = ?`, [replyId])
    return row ? toQqReplyRow(row) : undefined
  }

  getBySessionSeq(
    personaId: string,
    contactId: string,
    sessionId: string,
    sessionSeq: number,
  ): QqReplyOutboxRow | undefined {
    const row = this.db.get<QqReplyDbRow>(
      `SELECT * FROM qq_reply_outbox
        WHERE persona_id = ? AND contact_id = ? AND session_id = ? AND session_seq = ?`,
      [personaId, contactId, sessionId, sessionSeq],
    )
    return row ? toQqReplyRow(row) : undefined
  }

  list(status?: QqReplyStatus, limit = 100): QqReplyOutboxRow[] {
    const rows = status
      ? this.db.all<QqReplyDbRow>(
          `SELECT * FROM qq_reply_outbox WHERE status = ? ORDER BY created_at ASC LIMIT ?`,
          [status, limit],
        )
      : this.db.all<QqReplyDbRow>(`SELECT * FROM qq_reply_outbox ORDER BY created_at ASC LIMIT ?`, [limit])
    return rows.map(toQqReplyRow)
  }

  countActive(contactId?: string): number {
    if (contactId) {
      const row = this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM qq_reply_outbox
          WHERE contact_id = ? AND status IN ('pending','dispatching','unknown')`,
        [contactId],
      )
      return row?.n ?? 0
    }
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM qq_reply_outbox
        WHERE status IN ('pending','dispatching','unknown')`,
    )
    return row?.n ?? 0
  }

  enqueue(input: QqReplyEnqueueInput): QqReplyEnqueueResult {
    const personaId = text(input.personaId, 'personaId', 120)
    const contactId = text(input.contactId, 'contactId', 120)
    const stableUserId = text(input.stableUserId, 'stableUserId', 20)
    if (!QQ_ID.test(stableUserId)) throw invalid('stableUserId 必须是纯数字 QQ 号')
    const sessionId = text(input.sessionId, 'sessionId', 200)
    if (!sessionId.startsWith(SESSION_PREFIX)) throw invalid(`sessionId 必须是 ${SESSION_PREFIX}*`)
    const sessionSeq = positiveInt(input.sessionSeq, 'sessionSeq')
    const transportId = text(input.transportId, 'transportId', 120)
    const payloadText = text(input.payloadText, 'payloadText', 8000)
    const quoteMessageId = optionalText(input.quoteMessageId, 'quoteMessageId', 120)
    const ttl = typeof input.ttlMs === 'number' && Number.isFinite(input.ttlMs)
      ? Math.min(QQ_REPLY_TTL_MAX_MS, Math.max(QQ_REPLY_TTL_MIN_MS, Math.floor(input.ttlMs)))
      : QQ_REPLY_TTL_MS
    const now = time(input.now ?? this.now(), 'now')
    const replyId = replyIdOf(personaId, contactId, sessionId, sessionSeq)
    const textHash = hashReplyText(payloadText)
    const expiresAt = new Date(Date.parse(now) + ttl).toISOString()

    return this.db.transaction(() => {
      this.#expireDue(now)

      // 幂等优先：同一 (persona, contact, session, session_seq) 已存在时，
      // 无论队列是否已满都按既有记录结算；内容不一致才视为冲突。
      const existing = this.getBySessionSeq(personaId, contactId, sessionId, sessionSeq)
      if (existing) {
        if (
          existing.payloadText !== payloadText
          || existing.textHash !== textHash
          || existing.transportId !== transportId
          || existing.quoteMessageId !== quoteMessageId
        ) {
          throw fail(QQ_REPLY_ERROR.conflict, '同一 session_seq 已存在不同内容的回复')
        }
        return { row: existing, duplicate: true }
      }

      const global = this.countActive()
      if (global >= QQ_REPLY_GLOBAL_CAPACITY) {
        throw fail(QQ_REPLY_ERROR.capacity, '离线回复队列已满，拒绝入队')
      }
      const perContact = this.countActive(contactId)
      if (perContact >= QQ_REPLY_CONTACT_CAPACITY) {
        throw fail(QQ_REPLY_ERROR.capacity, '该联系人的离线回复队列已满，拒绝入队')
      }

      const inserted = this.db.run(
        `INSERT INTO qq_reply_outbox (
           reply_id, persona_id, contact_id, platform, stable_user_id, session_id, session_seq,
           turn, step, transport_id, target_kind, payload_text, text_hash, quote_message_id,
           status, attempts, created_at, expires_at, updated_at
         ) VALUES (?, ?, ?, 'qq', ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?, 'pending', 0, ?, ?, ?)
         ON CONFLICT(persona_id, contact_id, session_id, session_seq) DO NOTHING`,
        [
          replyId,
          personaId,
          contactId,
          stableUserId,
          sessionId,
          sessionSeq,
          optionalInt(input.turn, 'turn'),
          optionalInt(input.step, 'step'),
          transportId,
          payloadText,
          textHash,
          quoteMessageId,
          now,
          expiresAt,
          now,
        ],
      )
      if (inserted.changes === 0) {
        const again = this.getBySessionSeq(personaId, contactId, sessionId, sessionSeq)
        if (!again) throw fail(QQ_REPLY_ERROR.conflictState, '幂等冲突但找不到既有记录')
        if (
          again.payloadText !== payloadText
          || again.textHash !== textHash
          || again.transportId !== transportId
          || again.quoteMessageId !== quoteMessageId
        ) {
          throw fail(QQ_REPLY_ERROR.conflict, '同一 session_seq 已存在不同内容的回复')
        }
        return { row: again, duplicate: true }
      }
      const row = this.get(replyId)
      if (!row) throw fail(QQ_REPLY_ERROR.conflictState, '入队成功但读取失败')
      return { row, duplicate: false }
    })
  }

  /**
   * 逐条领取：同 Contact 单飞，unknown 阻塞同 Contact 后续；发送前复核失败的行直接取消。
   */
  claim(input: QqReplyClaimInput): QqReplyOutboxRow[] {
    const limit = positiveInt(input.limit, 'limit', 50)
    const now = time(input.now ?? this.now(), 'now')
    return this.db.transaction(() => {
      this.#expireDue(now)

      const busy = new Set(
        this.db
          .all<{ contact_id: string }>(
            `SELECT DISTINCT contact_id FROM qq_reply_outbox WHERE status = 'dispatching'`,
          )
          .map((row) => row.contact_id),
      )
      const unknown = new Set(
        this.db
          .all<{ contact_id: string }>(
            `SELECT DISTINCT contact_id FROM qq_reply_outbox WHERE status = 'unknown'`,
          )
          .map((row) => row.contact_id),
      )

      // FIFO 队首优先：先锁定每个 Contact 的最早未终结任务，再判断能否领取。
      // 队首仍在 dispatching/unknown，或 retry_at 尚未到期时，整个 Contact 阻塞；
      // 不能跳过队首去领取更晚的消息。
      const activeRows = this.db.all<QqReplyDbRow>(
        `SELECT * FROM qq_reply_outbox
          WHERE status IN ('pending','dispatching','unknown')
          ORDER BY created_at ASC, session_seq ASC, reply_id ASC`,
      )
      const heads = new Map<string, QqReplyDbRow>()
      for (const raw of activeRows) {
        if (!heads.has(raw.contact_id)) heads.set(raw.contact_id, raw)
      }

      const claimed: QqReplyOutboxRow[] = []
      for (const raw of heads.values()) {
        if (claimed.length >= limit) break
        const row = toQqReplyRow(raw)
        if (busy.has(row.contactId) || unknown.has(row.contactId)) continue
        if (row.status !== 'pending') continue
        if (row.retryAt !== null && row.retryAt > now) continue

        const reason = input.authorization(row)
        if (reason) {
          this.db.run(
            `UPDATE qq_reply_outbox
                SET status = 'cancelled', last_error_code = ?, terminal_at = ?, updated_at = ?
              WHERE reply_id = ? AND status = 'pending'`,
            [reason, now, now, row.replyId],
          )
          continue
        }
        if (!input.transportCheck(row)) break

        const updated = this.db.run(
          `UPDATE qq_reply_outbox
              SET status = 'dispatching', attempts = attempts + 1,
                  dispatch_started_at = ?, retry_at = NULL, updated_at = ?
            WHERE reply_id = ? AND status = 'pending'`,
          [now, now, row.replyId],
        )
        if (updated.changes === 1) {
          const next = this.get(row.replyId)
          if (next) claimed.push(next)
        }
      }
      return claimed
    })
  }

  /**
   * 回执落库。网络调用不在事务内；状态守卫保证只有 dispatching 的行能结算。
   */
  applyResult(replyId: string, result: ChatSendResult, nowInput?: string): QqReplyOutboxRow | undefined {
    const now = time(nowInput ?? this.now(), 'now')
    return this.db.transaction(() => {
      const row = this.get(replyId)
      if (!row) throw new PsycheError(CODE.notFound, `找不到离线回复记录：${replyId}`)
      if (row.status !== 'dispatching') return row

      if (result.outcome === 'accepted') {
        this.db.run(
          `UPDATE qq_reply_outbox
              SET status = 'sent', receipt = ?, sent_at = ?, terminal_at = ?, updated_at = ?
            WHERE reply_id = ? AND status = 'dispatching'`,
          [result.messageId ?? null, now, now, now, replyId],
        )
      } else if (result.outcome === 'permanent') {
        this.db.run(
          `UPDATE qq_reply_outbox
              SET status = 'failed', last_error_code = ?, terminal_at = ?, updated_at = ?
            WHERE reply_id = ? AND status = 'dispatching'`,
          [result.errorCode ?? 'permanent_failure', now, now, replyId],
        )
      } else if (result.outcome === 'unknown') {
        this.db.run(
          `UPDATE qq_reply_outbox
              SET status = 'unknown', last_error_code = ?, updated_at = ?
            WHERE reply_id = ? AND status = 'dispatching'`,
          [result.errorCode ?? 'unknown_result', now, replyId],
        )
      } else {
        const delay = Math.min(
          QQ_REPLY_BACKOFF_MAX_MS,
          QQ_REPLY_BACKOFF_START_MS * 2 ** Math.max(0, row.attempts - 1),
        )
        const retryAt = new Date(Date.parse(now) + delay).toISOString()
        if (row.attempts >= QQ_REPLY_MAX_ATTEMPTS || retryAt >= row.expiresAt) {
          this.db.run(
            `UPDATE qq_reply_outbox
                SET status = 'expired', last_error_code = ?, terminal_at = ?, updated_at = ?
              WHERE reply_id = ? AND status = 'dispatching'`,
            [result.errorCode ?? 'retry_exhausted', now, now, replyId],
          )
        } else {
          this.db.run(
            `UPDATE qq_reply_outbox
                SET status = 'pending', last_error_code = ?, retry_at = ?, updated_at = ?
              WHERE reply_id = ? AND status = 'dispatching'`,
            [result.errorCode ?? 'retryable_failure', retryAt, now, replyId],
          )
        }
      }
      return this.get(replyId)
    })
  }

  /** 进程启动时把上次中断的 dispatching 统一转 unknown，绝不自动重发。 */
  recoverInflight(nowInput?: string): number {
    const now = time(nowInput ?? this.now(), 'now')
    const result = this.db.run(
      `UPDATE qq_reply_outbox
          SET status = 'unknown', last_error_code = 'worker_restart', updated_at = ?
        WHERE status = 'dispatching'`,
      [now],
    )
    return result.changes
  }

  /** pending 到期转 expired；unknown 到期转 expired（保留结果不确定，解除同 Contact 阻塞）。 */
  expireDue(nowInput?: string): number {
    const now = time(nowInput ?? this.now(), 'now')
    return this.db.transaction(() => this.#expireDue(now))
  }

  #expireDue(now: string): number {
    const pending = this.db.run(
      `UPDATE qq_reply_outbox
          SET status = 'expired', last_error_code = 'reply_ttl_expired', terminal_at = ?, updated_at = ?
        WHERE status = 'pending' AND expires_at <= ?`,
      [now, now, now],
    )
    const unknown = this.db.run(
      `UPDATE qq_reply_outbox
          SET status = 'expired', last_error_code = 'unknown_unresolved_expired', terminal_at = ?, updated_at = ?
        WHERE status = 'unknown' AND expires_at <= ?`,
      [now, now, now],
    )
    return pending.changes + unknown.changes
  }

  /** Owner 本机人工裁决；unknown 只能 confirmed received / not received，不重发。 */
  resolveUnknown(
    replyId: string,
    verdict: 'received' | 'not-received',
    by: string,
    nowInput?: string,
  ): QqReplyOutboxRow | undefined {
    if (by !== this.ownerId) throw fail(QQ_REPLY_ERROR.ownerMismatch, '只有 Owner 可以裁决 unknown 结果')
    const now = time(nowInput ?? this.now(), 'now')
    return this.db.transaction(() => {
      const row = this.get(replyId)
      if (!row) throw new PsycheError(CODE.notFound, `找不到离线回复记录：${replyId}`)
      if (row.status !== 'unknown') throw fail(QQ_REPLY_ERROR.conflictState, '只有 unknown 记录可以人工裁决')
      if (verdict === 'received') {
        this.db.run(
          `UPDATE qq_reply_outbox
              SET status = 'sent', sent_at = COALESCE(sent_at, ?), terminal_at = ?, updated_at = ?
            WHERE reply_id = ? AND status = 'unknown'`,
          [now, now, now, replyId],
        )
      } else {
        this.db.run(
          `UPDATE qq_reply_outbox
              SET status = 'failed', last_error_code = 'owner_confirmed_not_received', terminal_at = ?, updated_at = ?
            WHERE reply_id = ? AND status = 'unknown'`,
          [now, now, replyId],
        )
      }
      return this.get(replyId)
    })
  }

  cancelPending(replyId: string, by: string, reason = 'owner_cancelled', nowInput?: string): boolean {
    if (by !== this.ownerId) throw fail(QQ_REPLY_ERROR.ownerMismatch, '只有 Owner 可以取消排队回复')
    const now = time(nowInput ?? this.now(), 'now')
    const result = this.db.run(
      `UPDATE qq_reply_outbox
          SET status = 'cancelled', last_error_code = ?, terminal_at = ?, updated_at = ?
        WHERE reply_id = ? AND status = 'pending'`,
      [reason, now, now, replyId],
    )
    return result.changes === 1
  }

  /** 只清理终态；调用前先 expireDue，unknown 不会在这里被误删。 */
  cleanupTerminal(nowInput?: string, retentionMs = QQ_REPLY_RETENTION_MS, limit = 200): number {
    const now = time(nowInput ?? this.now(), 'now')
    const cutoff = new Date(Date.parse(now) - retentionMs).toISOString()
    const result = this.db.run(
      `DELETE FROM qq_reply_outbox
        WHERE reply_id IN (
          SELECT reply_id FROM qq_reply_outbox
           WHERE status IN ('sent','failed','expired','cancelled')
             AND terminal_at IS NOT NULL AND terminal_at <= ?
           ORDER BY terminal_at ASC LIMIT ?
        )`,
      [cutoff, limit],
    )
    return result.changes
  }
}
