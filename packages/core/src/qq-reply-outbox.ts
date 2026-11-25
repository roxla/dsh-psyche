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
import { writeReminderOutcome } from './reminders.js'

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
  /**
   * 12a：入队时刻的授权代次。`null` 表示这条是迁移 35 之前写入的、没有快照——
   * 派发前必须按「缺少授权快照」停止，不能拿当前代次补上。
   */
  readonly accessEpoch: number | null
  /**
   * 第 53 轮外部评审 P1-A：这条队列若来自提醒，记住提醒身份。
   * worker 领取与发送前按它复核提醒是否仍待投递；终态也回写提醒。
   */
  readonly reminderId: string | null
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
  access_epoch?: number | null
  reminder_id?: string | null
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
    accessEpoch: typeof row.access_epoch === 'number' ? row.access_epoch : null,
    reminderId: typeof row.reminder_id === 'string' && row.reminder_id.length > 0 ? row.reminder_id : null,
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
  /** 12a：入队时刻的授权代次；不给就是「没有快照」，派发前会被停止。 */
  readonly accessEpoch?: number | null
  /** 第 53 轮 P1-A：来自提醒时带上提醒身份，worker 据此复核取消与回写终态。 */
  readonly reminderId?: string | null
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
  /**
   * 第 56 轮 P1-B：提醒行撞上「允许回复时段」时返回下一次可试的时刻（ISO）。
   *
   * 只有提醒行（`reminderId !== null`）会被延后；普通对话回复仍按原口径取消。
   * 返回 null / 不传这个回调表示「不受时段限制」，行为与以前一致。
   */
  readonly nextAllowedAt?: (row: QqReplyOutboxRow, now: string) => string | null
}

/**
 * 私聊回复队列的唯一写入口。
 * 多步写一律走 `db.transaction()`（BEGIN IMMEDIATE）；网络发送不在本类里。
 */
/**
 * 队列行要撑到 `until` 之后一点（提醒 TTL 只有 10 分钟，光改 `retry_at` 会被到期扫描判死）。
 *
 * 但「暂无可用时段」是用一个远未来时刻占位的，`until + 1h` 会溢出到公元 10000 年——
 * 那种字符串按字典序比 `9999-…` 还小，`MAX()` 反而保留了旧值。所以超过 9000 年就直接用
 * `until` 本身当到期时间。
 */
function expiresFor(until: string): string {
  const at = Date.parse(until)
  if (!Number.isFinite(at) || at > Date.parse('9000-01-01T00:00:00.000Z')) return until
  return new Date(at + 60 * 60 * 1000).toISOString()
}

/**
 * 第 57 轮 P1-D：把「放到远未来等配置恢复」与「等下一个允许窗口」分开报告。
 *
 * 两者都走同一条延后写入，但原因码不同：前者是 `config-corrupt`（不依赖时间的暂停），
 * 后者是 `outside-reply-window`。调用方据此区分「配置坏了」与「时段没到」。
 */
function holdReasonFor(until: string): string {
  const at = Date.parse(until)
  return !Number.isFinite(at) || at > Date.parse('9000-01-01T00:00:00.000Z')
    ? 'config-corrupt'
    : 'outside-reply-window'
}

export interface RefreshDeferredRepliesInput {
  /** 只用到读/写两句 SQL：`ReminderDb` 形状的库也能传进来。 */
  db: {
    all<T>(sql: string, params?: readonly (string | number | null)[]): T[]
    run(sql: string, params?: readonly (string | number | null)[]): unknown
  }
  now: string
  /** `open` = 现在就能发；`wait` = 等到 `until`。 */
  plan: (row: QqReplyOutboxRow) => { kind: 'open' } | { kind: 'wait'; until: string }
}

/**
 * 按**当前**规则重算「还在等窗口」的提醒队列行（第 9 轮评审第 4 条）。
 *
 * 只碰 `reminder_id IS NOT NULL AND status = 'pending' AND retry_at > now` 的行：
 * - 窗口提前开（规则改早）→ 清空 `retry_at`，这一轮就能被领取；
 * - 窗口推迟或从暂停恢复 → 把 `retry_at`（以及 `expires_at`）改成新时刻。
 *
 * 不做事件驱动的即时重算：这里只需要「下一轮扫描时能触及被旧时间过滤的行」。
 */
export function refreshDeferredReplies(input: RefreshDeferredRepliesInput): number {
  const horizon = input.db.all<QqReplyDbRow>(
    `SELECT * FROM qq_reply_outbox
      WHERE reminder_id IS NOT NULL AND status = 'pending' AND retry_at IS NOT NULL
        AND retry_at > ?
      ORDER BY created_at ASC, reply_id ASC`,
    [input.now],
  )
  let changed = 0
  for (const raw of horizon) {
    const row = toQqReplyRow(raw)
    const plan = input.plan(row)
    if (plan.kind === 'open') {
      const result = input.db.run(
        `UPDATE qq_reply_outbox SET retry_at = NULL, updated_at = ?
          WHERE reply_id = ? AND status = 'pending'`,
        [input.now, row.replyId],
      ) as { changes?: number } | number | null
      changed += typeof result === 'number' ? result : Number(result?.changes ?? 0)
      continue
    }
    if (plan.until === row.retryAt) continue
    const result = input.db.run(
      `UPDATE qq_reply_outbox
          SET retry_at = ?, expires_at = MAX(expires_at, ?), updated_at = ?
        WHERE reply_id = ? AND status = 'pending'`,
      [plan.until, expiresFor(plan.until), input.now, row.replyId],
    ) as { changes?: number } | number | null
    changed += typeof result === 'number' ? result : Number(result?.changes ?? 0)
  }
  return changed
}

export class QqReplyOutboxStore {
  readonly db: Db
  readonly ownerId: string
  #now: () => string
  #nextAllowedAt: (row: QqReplyOutboxRow, now: string) => string | null

  constructor(options: QqReplyStoreOptions) {
    this.db = options.db
    this.ownerId = text(options.ownerId, 'ownerId', 120)
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#nextAllowedAt = options.nextAllowedAt ?? (() => null)
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
           status, attempts, created_at, expires_at, updated_at, access_epoch, reminder_id
         ) VALUES (?, ?, ?, 'qq', ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)
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
          typeof input.accessEpoch === 'number' ? input.accessEpoch : null,
          typeof input.reminderId === 'string' && input.reminderId.length > 0 ? input.reminderId : null,
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
   * 第 53 轮 P1-A：提醒行现在还能不能发。
   *
   * 返回 `null` = 可以发；返回稳定原因码 = 失败关闭。三条都不许放过：
   * 关联的提醒不存在（被清理/被删）、提醒已不是 `pending`（取消/已发/失败）、
   * 提醒已不在「已入队」状态（`unknown` 说明上一次结果没确认，不能再投一次）。
   *
   * 不查 `due_at`：到期与否是扫描侧的事，这里只回答「这条提醒还该不该送出去」。
   */
  reminderBlockReason(row: QqReplyOutboxRow): string | null {
    if (row.reminderId === null) return null
    const reminder = this.db.get<{ status: string; delivery_state: string }>(
      `SELECT status, delivery_state FROM reminders
        WHERE persona_id = ? AND reminder_id = ?`,
      [row.personaId, row.reminderId],
    )
    if (reminder === undefined) return 'reminder-missing'
    if (reminder.status !== 'pending') return `reminder-${reminder.status}`
    if (reminder.delivery_state !== 'pending') return `reminder-${reminder.delivery_state}`
    return null
  }

  /**
   * 第 56 轮 P1-B：把提醒行延后到下一个可发时刻，而不是取消。
   *
   * 只对提醒行生效（普通对话回复撞上时段仍按原口径取消）。队列行保持
   * `pending`、`retry_at` 推到下一个窗口起点；提醒行不动——它仍是
   * `pending/pending`，与「已入队后遇到窗外」的冻结组合一致。
   *
   * `expires_at` 必须一起推后：提醒队列行的 TTL 只有 10 分钟，延后到下一个
   * 窗口（可能几小时后）必然超过它，否则 `#expireDue` 会把这条判过期并把提醒
   * 写成 failed——等于绕了个圈还是判死。
   */
  #deferOutsideWindow(row: QqReplyOutboxRow, now: string, allowNonReminder = false): string | null {
    if (row.reminderId === null && !allowNonReminder) return null
    const until = this.#nextAllowedAt(row, now)
    if (until === null || until <= now) return null
    this.db.run(
      `UPDATE qq_reply_outbox
          SET status = CASE WHEN status = 'dispatching' THEN 'pending' ELSE status END,
              retry_at = ?, expires_at = MAX(expires_at, ?), dispatch_started_at = NULL, updated_at = ?
        WHERE reply_id = ? AND status IN ('pending', 'dispatching')`,
      [until, expiresFor(until), now, row.replyId],
    )
    return until
  }

  /**
   * 发送前的第二次复核（worker 在真正调用 `transport.send` 之前调）。
   *
   * 领取和发送之间有窗口：用户可能在这段时间里取消。这里除了重新确认提醒，
   * 还确认队列行仍在 `dispatching`——期间被别的路径结算过就直接停。
   * 复核不通过时**就地**把队列行收敛成 `cancelled`，worker 不需要再调 `applyResult`；
   * 提醒行不在这里改，因为拦住它的正是别人已经写好的终态。
   */
  recheckForSend(replyId: string, nowInput?: string): string | null {
    const now = time(nowInput ?? this.now(), 'now')
    return this.db.transaction(() => {
      const row = this.get(replyId)
      if (row === undefined) return 'reply-missing'
      if (row.status !== 'dispatching') return `reply-${row.status}`
      // P1-B：领取时在窗内、发送前刚关窗 —— 放回队列等下一个窗口，本次零发送。
      // 这是「预计发送时间不等于发送许可」那一条：窗口关了就不发，但不能判死。
      // P1-D：覆盖层不可信也是同一类「可恢复暂停」——放回队列（含普通对话行），
      // 恢复配置后按最新代次与时段再复核，而不是把消息判死。
      const until = this.#deferOutsideWindow(row, now, true)
      if (until !== null) return holdReasonFor(until)
      const blocked = this.reminderBlockReason(row)
      if (blocked === null) return null
      this.db.run(
        `UPDATE qq_reply_outbox
            SET status = 'cancelled', last_error_code = ?, terminal_at = ?, updated_at = ?
          WHERE reply_id = ? AND status = 'dispatching'`,
        [blocked, now, now, replyId],
      )
      return blocked
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
          // P1-B：只有提醒行的「窗外」可以延后；撤权、归属不符、epoch 失效仍然失败关闭。
          // P1-D：配置不可信是可恢复暂停——普通行也放回队列，恢复后按最新名单重判。
          const recoverable = reason === 'outside-reply-window' || reason === 'config-corrupt'
          if (recoverable && this.#deferOutsideWindow(row, now, reason === 'config-corrupt') !== null) {
            continue
          }
          this.db.run(
            `UPDATE qq_reply_outbox
                SET status = 'cancelled', last_error_code = ?, terminal_at = ?, updated_at = ?
              WHERE reply_id = ? AND status = 'pending'`,
            [reason, now, now, row.replyId],
          )
          // 队列行取消了就不会再发：提醒必须跟着落「确定没发出去」，
          // 否则它永远停在 pending/pending，界面还显示已排队。
          this.#settleReminder(row, 'failed', now)
          continue
        }
        // 第 53 轮 P1-A：领取时先复核提醒。已取消/已终态的提醒不许再被领走，
        // 但这里只取消队列行——提醒本身的状态是别人写的终态，不去覆盖。
        const reminderBlocked = this.reminderBlockReason(row)
        if (reminderBlocked !== null) {
          this.db.run(
            `UPDATE qq_reply_outbox
                SET status = 'cancelled', last_error_code = ?, terminal_at = ?, updated_at = ?
              WHERE reply_id = ? AND status = 'pending'`,
            [reminderBlocked, now, now, row.replyId],
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

      // 这一笔结果对应的提醒终态；null 表示还要重试，提醒继续停在「已入队」。
      let reminderOutcome: 'sent' | 'failed' | 'unknown' | null = null
      if (result.outcome === 'accepted') {
        this.db.run(
          `UPDATE qq_reply_outbox
              SET status = 'sent', receipt = ?, sent_at = ?, terminal_at = ?, updated_at = ?
            WHERE reply_id = ? AND status = 'dispatching'`,
          [result.messageId ?? null, now, now, now, replyId],
        )
        reminderOutcome = 'sent'
      } else if (result.outcome === 'permanent') {
        this.db.run(
          `UPDATE qq_reply_outbox
              SET status = 'failed', last_error_code = ?, terminal_at = ?, updated_at = ?
            WHERE reply_id = ? AND status = 'dispatching'`,
          [result.errorCode ?? 'permanent_failure', now, now, replyId],
        )
        reminderOutcome = 'failed'
      } else if (result.outcome === 'unknown') {
        this.db.run(
          `UPDATE qq_reply_outbox
              SET status = 'unknown', last_error_code = ?, updated_at = ?
            WHERE reply_id = ? AND status = 'dispatching'`,
          [result.errorCode ?? 'unknown_result', now, replyId],
        )
        reminderOutcome = 'unknown'
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
          // 退避到过期也是终态：这条不会再发了，提醒必须如实记成没发出去。
          reminderOutcome = 'failed'
        } else {
          this.db.run(
            `UPDATE qq_reply_outbox
                SET status = 'pending', last_error_code = ?, retry_at = ?, updated_at = ?
              WHERE reply_id = ? AND status = 'dispatching'`,
            [result.errorCode ?? 'retryable_failure', retryAt, now, replyId],
          )
        }
      }
      // 提醒终态与队列终态必须同一个事务：迟到的发送结果不许覆盖已生效的取消。
      this.#settleReminder(row, reminderOutcome, now)
      return this.get(replyId)
    })
  }

  /**
   * 把一笔队列结果落到提醒上（**必须**在调用方的事务里）。
   *
   * 两条纪律：
   * - 提醒已经不是 `pending`（被取消/已终态）时一律不写它——重放旧结果不能复活取消；
   *   如果这一笔还要重试，就把队列行停掉，取消过的提醒不许再发第二次。
   * - 其余按冻结表落终态；`null` 表示还在退避重试，提醒保持「已入队」不动。
   */
  #settleReminder(
    row: QqReplyOutboxRow,
    outcome: 'sent' | 'failed' | 'unknown' | null,
    now: string,
  ): void {
    if (row.reminderId === null) return
    const reminder = this.db.get<{ status: string }>(
      `SELECT status FROM reminders WHERE persona_id = ? AND reminder_id = ?`,
      [row.personaId, row.reminderId],
    )
    if (reminder === undefined) return
    if (reminder.status !== 'pending') {
      if (outcome === null) {
        this.db.run(
          `UPDATE qq_reply_outbox
              SET status = 'cancelled', last_error_code = 'reminder_cancelled', terminal_at = ?, updated_at = ?
            WHERE reply_id = ? AND status = 'pending'`,
          [now, now, row.replyId],
        )
      }
      return
    }
    if (outcome === null) return
    writeReminderOutcome({
      db: this.db,
      personaId: row.personaId,
      reminderId: row.reminderId,
      now,
      outcome,
    })
  }

  /** 进程启动时把上次中断的 dispatching 统一转 unknown，绝不自动重发。 */
  recoverInflight(nowInput?: string): number {
    const now = time(nowInput ?? this.now(), 'now')
    return this.db.transaction(() => {
      // 中断时可能已经发出去了也可能没有：提醒跟着记 unknown，不重投。
      const inflight = this.db.all<{ persona_id: string; reminder_id: string }>(
        `SELECT persona_id, reminder_id FROM qq_reply_outbox
          WHERE status = 'dispatching' AND reminder_id IS NOT NULL`,
      )
      const result = this.db.run(
        `UPDATE qq_reply_outbox
            SET status = 'unknown', last_error_code = 'worker_restart', updated_at = ?
          WHERE status = 'dispatching'`,
        [now],
      )
      for (const row of inflight) {
        writeReminderOutcome({
          db: this.db,
          personaId: row.persona_id,
          reminderId: row.reminder_id,
          now,
          outcome: 'unknown',
        })
      }
      return result.changes
    })
  }

  /** pending 到期转 expired；unknown 到期转 expired（保留结果不确定，解除同 Contact 阻塞）。 */
  expireDue(nowInput?: string): number {
    const now = time(nowInput ?? this.now(), 'now')
    return this.db.transaction(() => this.#expireDue(now))
  }

  #expireDue(now: string): number {
    // 到期转 expired 的提醒任务不会再发：提醒必须跟着落「确定没发出去」。
    const expiring = this.db.all<{ persona_id: string; reminder_id: string }>(
      `SELECT persona_id, reminder_id FROM qq_reply_outbox
        WHERE status = 'pending' AND reminder_id IS NOT NULL AND expires_at <= ?`,
      [now],
    )
    const pending = this.db.run(
      `UPDATE qq_reply_outbox
          SET status = 'expired', last_error_code = 'reply_ttl_expired', terminal_at = ?, updated_at = ?
        WHERE status = 'pending' AND expires_at <= ?`,
      [now, now, now],
    )
    for (const row of expiring) {
      writeReminderOutcome({
        db: this.db,
        personaId: row.persona_id,
        reminderId: row.reminder_id,
        now,
        outcome: 'failed',
      })
    }
    const unknown = this.db.run(
      `UPDATE qq_reply_outbox
          SET status = 'expired', last_error_code = 'unknown_unresolved_expired', terminal_at = ?, updated_at = ?
        WHERE status = 'unknown' AND expires_at <= ?`,
      [now, now, now],
    )
    return pending.changes + unknown.changes
  }

  /**
   * Owner 本机人工裁决；unknown 只能 confirmed received / not received，不重发。
   *
   * 第 15 轮 P1-C：允许裁决「从 unknown 过期成 expired」的行。判定依据不是 `expired` 本身，
   * 而是 `last_error_code === 'unknown_unresolved_expired'`——它只由 `#expireDue` 在处理
   * unknown 行时写下，证明这一条**真的发生过结果不确定的发送尝试**。普通 pending 过期
   * （`reply_ttl_expired`）永远不许标成「已收到」，否则等于凭空造一条投递记录。
   */
  resolveUnknown(
    replyId: string,
    verdict: 'received' | 'not-received',
    by: string,
    nowInput?: string,
  ): QqReplyOutboxRow | undefined {
    const now = time(nowInput ?? this.now(), 'now')
    return this.db.transaction(() => {
      const row = this.get(replyId)
      if (!row) throw new PsycheError(CODE.notFound, `找不到离线回复记录：${replyId}`)
      return this.#applyUnknownVerdict(row, verdict, by, now)
    })
  }

  /**
   * 按**提醒 ID** 裁决（P1-C 的工具入口）：先找到该提醒挂着的队列行，再走同一个裁决路径，
   * 保证「只有 resolveUnknown 能越过 unknown 闸门」这条不变量不被第二个写入口打洞。
   */
  resolveUnknownByReminder(input: {
    reminderId: string
    verdict: 'received' | 'not-received'
    by: string
    now?: string
  }): { status: 'resolved' | 'not-found' | 'conflict'; row?: QqReplyOutboxRow; replyId?: string; reason?: string } {
    const now = time(input.now ?? this.now(), 'now')
    try {
      return this.db.transaction(() => {
        const reminder = this.db.get<{
          status: string
          delivery_state: string | null
          persona_id: string
          contact_id: string
        }>(
        'SELECT status, delivery_state, persona_id, contact_id FROM reminders WHERE reminder_id = ?',
        [input.reminderId],
      )
      if (!reminder) return { status: 'not-found' as const, reason: 'reminder-missing' }
      if (reminder.status !== 'pending' || reminder.delivery_state !== 'unknown') {
        return {
          status: 'conflict' as const,
          reason: `reminder-${reminder.status}/${reminder.delivery_state ?? 'null'}`,
        }
      }
      const row = this.db.get<QqReplyDbRow>(
        `SELECT * FROM qq_reply_outbox WHERE reminder_id = ? ORDER BY created_at DESC LIMIT 1`,
        [input.reminderId],
      )
      if (!row) return { status: 'not-found' as const, reason: 'reply-missing' }
      const mapped = toQqReplyRow(row)
      // 关联核对（第 16 轮第 1 条）：提醒与队列行必须是同一个 persona、同一个 contact，
      // 队列行的会话名也必须是该联系人自己的私聊会话——三条任一不符都说明关联被串了。
      if (reminder.persona_id !== mapped.personaId || reminder.contact_id !== mapped.contactId) {
        return { status: 'conflict' as const, replyId: mapped.replyId, reason: 'association-mismatch' }
      }
      if (mapped.sessionId !== `qq-private-${mapped.stableUserId}`) {
        return { status: 'conflict' as const, replyId: mapped.replyId, reason: 'session-mismatch' }
      }
      // 队列行本身的状态也要核：提醒仍在 `pending/unknown`，但队列行可能是「普通 pending 过期」
      // （`reply_ttl_expired`）——那种过期不能凭 expired 就当裁决资格，必须拒绝且零写入。
      // 只有 `unknown_unresolved_expired` 才是「之前确实有过一次结果不确定的发送尝试」。
      const resolved = this.#applyUnknownVerdict(mapped, input.verdict, input.by, now)
      return { status: 'resolved' as const, row: resolved, replyId: mapped.replyId }
    })
  } catch (error) {
    // 裁决内部的任何失败都必须先抛出事务，让整笔回滚，再在这里翻成「冲突」返回。
    // （在事务回调里直接 catch 会拿到「队列行改了、提醒没改」的半成品，第 16 轮第 1 条点的就是它。）
    const reason = (error as { detail?: { reason?: string } }).detail?.reason
    // 越权不是「状态冲突」，必须原样抛给调用方（工具层要能区分成 no-permission）。
    if (reason === QQ_REPLY_ERROR.ownerMismatch) throw error
    return { status: 'conflict' as const, reason: reason ?? 'reply-conflict' }
  }
  }

  /**
   * 裁决的唯一实现：校验「这一条确实结果不确定」→ 两个终态一起写 → 越过 unknown 闸门回写提醒。
   *
   * 第 16 轮评审加了三条硬约束（都是「静默成功」的常见口子）：
   * ① 关联必须成立：挂着的提醒要同 persona、同 contact，且提醒本身还在 `pending/unknown`；
   * ② 每条 UPDATE 都必须恰好命中 1 行，命中 0 行就抛错回滚——不能「队列行改了、提醒没改」还提交成功；
   * ③ 裁决人 / 时间 / 结论落到 `qq_reply_verdicts`（`reply_id` 是主键，第二个相反裁决撞约束回滚），
   *    `terminal_at` 只表示「进入终态的时刻」，过期行早就有了它，不能拿它充当裁决时间。
   */
  #applyUnknownVerdict(
    row: QqReplyOutboxRow,
    verdict: 'received' | 'not-received',
    by: string,
    now: string,
  ): QqReplyOutboxRow | undefined {
    if (by !== this.ownerId) throw fail(QQ_REPLY_ERROR.ownerMismatch, '只有 Owner 可以裁决 unknown 结果')
    const fromUnknown = row.status === 'unknown'
    const fromUnknownExpired =
      row.status === 'expired' && row.lastErrorCode === 'unknown_unresolved_expired'
    if (!fromUnknown && !fromUnknownExpired) {
      throw fail(QQ_REPLY_ERROR.conflictState, '只有 unknown 记录可以人工裁决')
    }
    if (row.reminderId !== null) {
      const linked = this.db.get<{ persona_id: string; contact_id: string; status: string; delivery_state: string | null }>(
        'SELECT persona_id, contact_id, status, delivery_state FROM reminders WHERE reminder_id = ?',
        [row.reminderId],
      )
      if (!linked) throw fail(QQ_REPLY_ERROR.conflictState, '投递记录挂着的提醒已不存在')
      if (linked.persona_id !== row.personaId || linked.contact_id !== row.contactId) {
        throw fail(QQ_REPLY_ERROR.conflictState, '提醒与投递记录归属不一致')
      }
      if (linked.status !== 'pending' || linked.delivery_state !== 'unknown') {
        throw fail(
          QQ_REPLY_ERROR.conflictState,
          `提醒已不是结果不确定：reminder-${linked.status}/${linked.delivery_state ?? 'null'}`,
        )
      }
    }
    const updated =
      verdict === 'received'
        ? this.db.run(
            `UPDATE qq_reply_outbox
                SET status = 'sent', sent_at = COALESCE(sent_at, ?), terminal_at = COALESCE(terminal_at, ?),
                    updated_at = ?, last_error_code = NULL
              WHERE reply_id = ? AND status IN ('unknown', 'expired')`,
            [now, now, now, row.replyId],
          )
        : this.db.run(
            `UPDATE qq_reply_outbox
                SET status = 'failed', last_error_code = 'owner_confirmed_not_received',
                    terminal_at = COALESCE(terminal_at, ?), updated_at = ?
              WHERE reply_id = ? AND status IN ('unknown', 'expired')`,
            [now, now, row.replyId],
          )
    if (updated.changes !== 1) {
      throw fail(QQ_REPLY_ERROR.conflictState, '裁决没有命中这条投递记录')
    }
    const recorded = this.db.run(
      `INSERT INTO qq_reply_verdicts (reply_id, reminder_id, persona_id, verdict, decided_by, decided_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [row.replyId, row.reminderId, row.personaId, verdict, by, now],
    )
    if (recorded.changes !== 1) {
      throw fail(QQ_REPLY_ERROR.conflictState, '这条投递记录已经裁决过了')
    }
    // 人工裁决同时把提醒从「结果不确定」里解出来，否则它会一直停在 unknown。
    // 这是**唯一**允许越过 unknown 闸门的写入口（第 55 轮 A15）。
    if (row.reminderId !== null) {
      const wrote = writeReminderOutcome({
        db: this.db,
        personaId: row.personaId,
        reminderId: row.reminderId,
        now,
        outcome: verdict === 'received' ? 'sent' : 'failed',
        allowFromUnknown: true,
      })
      // 提醒侧写不动就整笔回滚：宁可裁决失败重来，也不要「队列行说发了、提醒还停在待裁决」。
      if (!wrote) throw fail(QQ_REPLY_ERROR.conflictState, '提醒没有从「结果不确定」写出去')
    }
    return this.get(row.replyId)
  }

  cancelPending(replyId: string, by: string, reason = 'owner_cancelled', nowInput?: string): boolean {
    if (by !== this.ownerId) throw fail(QQ_REPLY_ERROR.ownerMismatch, '只有 Owner 可以取消排队回复')
    const now = time(nowInput ?? this.now(), 'now')
    return this.db.transaction(() => {
      const row = this.get(replyId)
      const result = this.db.run(
        `UPDATE qq_reply_outbox
            SET status = 'cancelled', last_error_code = ?, terminal_at = ?, updated_at = ?
          WHERE reply_id = ? AND status = 'pending'`,
        [reason, now, now, replyId],
      )
      // Owner 撤掉的是这条队列行；对应提醒不能继续挂着「已排队」，落成取消。
      if (result.changes === 1 && row !== undefined && row.reminderId !== null) {
        writeReminderOutcome({
          db: this.db,
          personaId: row.personaId,
          reminderId: row.reminderId,
          now,
          outcome: 'cancelled',
        })
      }
      return result.changes === 1
    })
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
