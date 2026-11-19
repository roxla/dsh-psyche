// P3-C-3a：主动联系发件箱（Outbox）。
//
// 边界（docs/design/p3-c-3a-outbox-implementation.md）：
// - 只做持久化、事务领取、状态迁移、重启恢复；不调模型、不生成草稿、不发送。
// - approval 与 enqueue 是一个原子业务操作：行存在 = Owner 已批准且入队成功。
// - 审批绑定字段不可变（数据库触发器 + Store 校验）；payload_text 是真正获批的正文。
// - 发送前复核由 Worker 在事务内调用本模块完成；这里不 import 任何传输实现。
import { createHash } from 'node:crypto'
import type { Db } from './adapter.js'
import { CODE, PsycheError, invalid } from './errors.js'
import type { ChatSendResult } from './chat-transport.js'

export const OUTBOX_STATUSES = [
  'pending',
  'dispatching',
  'sent',
  'failed',
  'unknown',
  'expired',
  'cancelled',
] as const

export type OutboxStatus = (typeof OUTBOX_STATUSES)[number]

/** 容量：pending + dispatching + unknown；达到上限拒绝新入队，不淘汰旧记录。 */
export const OUTBOX_MAX_ACTIVE = 200

/** 入队后 10 分钟未发送则过期；不因重试重置。 */
export const OUTBOX_TTL_MS = 10 * 60 * 1000

/** Owner 审批有效期 24 小时（从 decidedAt 起算）。 */
export const OUTBOX_APPROVAL_VALIDITY_MS = 24 * 60 * 60 * 1000

/** 速率闸：通道 20 条/分钟、同联系人 60 秒、全局 50 条/小时。 */
export const OUTBOX_CHANNEL_LIMIT = 20
export const OUTBOX_CHANNEL_WINDOW_MS = 60 * 1000
export const OUTBOX_CONTACT_WINDOW_MS = 60 * 1000
export const OUTBOX_GLOBAL_LIMIT = 50
export const OUTBOX_GLOBAL_WINDOW_MS = 60 * 60 * 1000

/** retryAfterMs 的冻结安全区间。 */
export const OUTBOX_RETRY_MIN_MS = 30 * 1000
export const OUTBOX_RETRY_MAX_MS = 10 * 60 * 1000

export type OutboxTargetKind = 'private' | 'group'

export interface OutboundConsent {
  readonly contactId?: string
  readonly status: 'granted' | 'revoked' | 'expired'
  readonly grantedAt?: string
  readonly sourceId?: string
  readonly expiresAt?: string
  readonly revokedAt?: string
}

export type ProactiveAllowStatus = 'allowed' | 'revoked' | 'missing' | 'unknown' | 'error'

export type ConsentReader = (contactId: string) => OutboundConsent | null
export type ProactiveAllowReader = (contactId: string) => ProactiveAllowStatus

export interface ProactiveOutboxRow {
  readonly outboxId: string
  readonly approvalId: string
  readonly draftId: string
  readonly draftRevision: number
  readonly draftHash: string
  readonly contactId: string
  readonly platform: string
  readonly stableUserId: string
  readonly transportId: string
  readonly targetKind: OutboxTargetKind
  readonly payloadText: string
  readonly textHash: string
  status: OutboxStatus
  readonly attempts: number
  readonly lastErrorCode: string | null
  readonly receipt: string | null
  readonly decidedBy: string
  readonly approvalDecidedAt: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly retryAt: string | null
  readonly dispatchStartedAt: string | null
  readonly sentAt: string | null
  readonly updatedAt: string
}

interface OutboxDbRow {
  outbox_id: string
  approval_id: string
  draft_id: string
  draft_revision: number
  draft_hash: string
  contact_id: string
  platform: string
  stable_user_id: string
  transport_id: string
  target_kind: OutboxTargetKind
  payload_text: string
  text_hash: string
  status: OutboxStatus
  attempts: number
  last_error_code: string | null
  receipt: string | null
  decided_by: string
  approval_decided_at: string
  created_at: string
  expires_at: string
  retry_at: string | null
  dispatch_started_at: string | null
  sent_at: string | null
  updated_at: string
}

function toRow(input: OutboxDbRow): ProactiveOutboxRow {
  return {
    outboxId: input.outbox_id,
    approvalId: input.approval_id,
    draftId: input.draft_id,
    draftRevision: input.draft_revision,
    draftHash: input.draft_hash,
    contactId: input.contact_id,
    platform: input.platform,
    stableUserId: input.stable_user_id,
    transportId: input.transport_id,
    targetKind: input.target_kind,
    payloadText: input.payload_text,
    textHash: input.text_hash,
    status: input.status,
    attempts: input.attempts,
    lastErrorCode: input.last_error_code,
    receipt: input.receipt,
    decidedBy: input.decided_by,
    approvalDecidedAt: input.approval_decided_at,
    createdAt: input.created_at,
    expiresAt: input.expires_at,
    retryAt: input.retry_at,
    dispatchStartedAt: input.dispatch_started_at,
    sentAt: input.sent_at,
    updatedAt: input.updated_at,
  }
}

function textHashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)
}

export function outboxIdOf(approvalId: string, draftHash: string): string {
  return `ob_${createHash('sha256').update(`${approvalId}\u0000${draftHash}`, 'utf8').digest('hex').slice(0, 16)}`
}

function requireText(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} 必须是非空字符串`)
  const text = value.trim()
  if (text.length > max) throw invalid(`${field} 不能超过 ${max} 字符`)
  return text
}

function requireTime(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} 必须是非空 ISO 时间`)
  const text = value.trim()
  if (!Number.isFinite(Date.parse(text))) throw invalid(`${field} 不是合法时间：${text}`)
  return text
}

function clampRetryAfter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return OUTBOX_RETRY_MIN_MS
  return Math.min(OUTBOX_RETRY_MAX_MS, Math.max(OUTBOX_RETRY_MIN_MS, Math.floor(value)))
}

function outboxError(code: string, message: string): PsycheError {
  return new PsycheError(CODE.state, message, { reason: code })
}

export const OUTBOX_ERROR = Object.freeze({
  capacity: 'E_OUTBOX_CAPACITY',
  approvalConflict: 'E_OUTBOX_APPROVAL_CONFLICT',
  approvalExpired: 'E_OUTBOX_APPROVAL_EXPIRED',
  approvalOwner: 'E_OUTBOX_APPROVAL_OWNER',
  consentMissing: 'E_OUTBOX_CONSENT_MISSING',
  consentNotGranted: 'E_OUTBOX_CONSENT_NOT_GRANTED',
  contactMismatch: 'E_OUTBOX_CONTACT_MISMATCH',
  draftMismatch: 'E_OUTBOX_DRAFT_MISMATCH',
  state: 'E_OUTBOX_STATE',
  ownerMismatch: 'E_OUTBOX_OWNER_MISMATCH',
})

const BINDING_FIELDS: readonly (keyof ProactiveOutboxRow)[] = Object.freeze([
  'approvalId',
  'draftId',
  'draftRevision',
  'draftHash',
  'contactId',
  'platform',
  'stableUserId',
  'transportId',
  'payloadText',
  'textHash',
  'decidedBy',
  'approvalDecidedAt',
])

export interface OutboxContactInput {
  readonly contactId: string
  readonly platform: string
  readonly stableUserId: string
}

export interface OutboxDraftInput {
  readonly draftId: string
  readonly revision: number
  readonly draftHash: string
  readonly contactId: string
  readonly text: string
}

export interface OutboxEnqueueInput {
  readonly approvalId: string
  readonly draft: OutboxDraftInput
  readonly contact: OutboxContactInput
  readonly transportId: string
  readonly targetKind?: OutboxTargetKind
  readonly consent: OutboundConsent | null
  readonly decision: 'approved' | 'rejected'
  readonly decidedBy: string
  readonly decidedAt: string
  readonly payloadText?: string
  readonly now?: string
}

export interface OutboxEnqueueResult {
  readonly row: ProactiveOutboxRow
  readonly duplicate: boolean
}

export interface ClaimBatchInput {
  readonly limit: number
  /** 人工入口只派发这次选定的审批，不顺便领取其他旧任务。 */
  readonly outboxId?: string
  readonly consentReader: ConsentReader
  readonly allowReader: ProactiveAllowReader
  /** 通道与平台、能力是否仍匹配（技术能力，不起业务授权作用）。 */
  readonly transportCheck: (row: ProactiveOutboxRow) => boolean
  readonly now?: string
}

export interface OutboxStoreOptions {
  readonly db: Db
  /** 可信本地 Owner 身份；审批的 decidedBy 必须与之相同。 */
  readonly ownerId: string
  readonly now?: () => string
}

/**
 * Outbox 的唯一写入口。所有多步写都走 `db.transaction()`（BEGIN IMMEDIATE）。
 * 网络发送不在本类里，回执由 `applyResult` 单独事务落库。
 */
export class OutboxStore {
  readonly db: Db
  readonly ownerId: string
  #now: () => string

  constructor(options: OutboxStoreOptions) {
    this.db = options.db
    this.ownerId = requireText(options.ownerId, 'ownerId', 120)
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  now(): string {
    return this.#now()
  }

  get(outboxId: string): ProactiveOutboxRow | undefined {
    const row = this.db.get<OutboxDbRow>(`SELECT * FROM proactive_outbox WHERE outbox_id = ?`, [outboxId])
    return row ? toRow(row) : undefined
  }

  getByApproval(approvalId: string): ProactiveOutboxRow | undefined {
    const row = this.db.get<OutboxDbRow>(`SELECT * FROM proactive_outbox WHERE approval_id = ?`, [approvalId])
    return row ? toRow(row) : undefined
  }

  list(input: { status?: OutboxStatus; limit?: number } = {}): ProactiveOutboxRow[] {
    const limit = Math.min(500, Math.max(1, Math.floor(input.limit ?? 100)))
    const rows = input.status
      ? this.db.all<OutboxDbRow>(
          `SELECT * FROM proactive_outbox WHERE status = ? ORDER BY created_at, outbox_id LIMIT ?`,
          [input.status, limit],
        )
      : this.db.all<OutboxDbRow>(`SELECT * FROM proactive_outbox ORDER BY created_at, outbox_id LIMIT ?`, [limit])
    return rows.map(toRow)
  }

  /** pending + dispatching + unknown；容量判断与状态展示都用这个口径。 */
  countActive(): number {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM proactive_outbox
        WHERE status IN ('pending', 'dispatching', 'unknown')`,
    )
    return Number(row?.n ?? 0)
  }

  /**
   * 审批 + 入队（原子）。容量不足、审批过期、Consent 无效都会在插入前失败，
   * 不留下「已持久化但无效」的审批快照。
   */
  enqueue(input: OutboxEnqueueInput): OutboxEnqueueResult {
    if (input.decision !== 'approved') throw invalid('只有 approved 的审批才能入队')
    const now = requireTime(input.now ?? this.now(), 'now')
    const nowMs = Date.parse(now)
    const approvalId = requireText(input.approvalId, 'approvalId', 120)
    const decidedBy = requireText(input.decidedBy, 'decidedBy', 120)
    const decidedAt = requireTime(input.decidedAt, 'decidedAt')
    const decidedMs = Date.parse(decidedAt)
    if (decidedBy !== this.ownerId) {
      throw outboxError(OUTBOX_ERROR.approvalOwner, '审批人不是可信本地 Owner')
    }
    if (decidedMs > nowMs) throw invalid('审批时间不能晚于当前时间')
    if (nowMs - decidedMs > OUTBOX_APPROVAL_VALIDITY_MS) {
      throw outboxError(OUTBOX_ERROR.approvalExpired, '审批已超过 24 小时有效期')
    }

    const draft = input.draft
    if (!draft || typeof draft !== 'object') throw invalid('draft 不能为空')
    const draftId = requireText(draft.draftId, 'draft.draftId', 120)
    const draftHash = requireText(draft.draftHash, 'draft.draftHash', 120)
    const draftRevision = Math.floor(Number(draft.revision))
    if (!Number.isFinite(draftRevision) || draftRevision < 1) throw invalid('draft.revision 必须是正整数')
    if (requireText(draft.contactId, 'draft.contactId', 120) !== requireText(input.contact?.contactId, 'contact.contactId', 120)) {
      throw outboxError(OUTBOX_ERROR.draftMismatch, '草稿与联系人绑定不一致')
    }
    const contactId = requireText(input.contact.contactId, 'contact.contactId', 120)
    const platform = requireText(input.contact.platform, 'contact.platform', 40)
    const stableUserId = requireText(input.contact.stableUserId, 'contact.stableUserId', 120)
    const transportId = requireText(input.transportId, 'transportId', 120)
    const targetKind: OutboxTargetKind = input.targetKind ?? 'private'
    if (targetKind !== 'private') throw invalid('主动 v1 只允许 private 目标')

    const consent = input.consent
    if (!consent) throw outboxError(OUTBOX_ERROR.consentMissing, '缺少联系人的主动联系同意')
    if (consent.status !== 'granted') throw outboxError(OUTBOX_ERROR.consentNotGranted, '联系人当前未同意主动联系')
    if (consent.expiresAt !== undefined && Date.parse(consent.expiresAt) <= nowMs) {
      throw outboxError(OUTBOX_ERROR.consentNotGranted, '联系人的主动联系同意已过期')
    }

    const payloadText = requireText(input.payloadText ?? draft.text, 'payloadText', 500)
    const textHash = textHashOf(payloadText)
    const outboxId = outboxIdOf(approvalId, draftHash)
    const expiryCandidates = [
      nowMs + OUTBOX_TTL_MS,
      decidedMs + OUTBOX_APPROVAL_VALIDITY_MS,
      consent.expiresAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(consent.expiresAt),
    ]
    const expiresAt = new Date(Math.min(...expiryCandidates)).toISOString()

    const row: ProactiveOutboxRow = {
      outboxId,
      approvalId,
      draftId,
      draftRevision,
      draftHash,
      contactId,
      platform,
      stableUserId,
      transportId,
      targetKind,
      payloadText,
      textHash,
      status: 'pending',
      attempts: 0,
      lastErrorCode: null,
      receipt: null,
      decidedBy,
      approvalDecidedAt: decidedAt,
      createdAt: now,
      expiresAt,
      retryAt: null,
      dispatchStartedAt: null,
      sentAt: null,
      updatedAt: now,
    }

    return this.db.transaction(() => {
      const existing = this.getByApproval(approvalId)
      if (existing) {
        for (const field of BINDING_FIELDS) {
          if (existing[field] !== row[field]) {
            throw outboxError(OUTBOX_ERROR.approvalConflict, '同一 approval_id 的绑定字段不一致')
          }
        }
        return { row: existing, duplicate: true }
      }
      if (this.countActive() >= OUTBOX_MAX_ACTIVE) {
        throw outboxError(OUTBOX_ERROR.capacity, `发件箱待处理已达上限 ${OUTBOX_MAX_ACTIVE}`)
      }
      this.db.run(
        `INSERT INTO proactive_outbox
           (outbox_id, approval_id, draft_id, draft_revision, draft_hash, contact_id, platform,
            stable_user_id, transport_id, target_kind, payload_text, text_hash, status, attempts,
            last_error_code, receipt, decided_by, approval_decided_at, created_at, expires_at,
            retry_at, dispatch_started_at, sent_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.outboxId,
          row.approvalId,
          row.draftId,
          row.draftRevision,
          row.draftHash,
          row.contactId,
          row.platform,
          row.stableUserId,
          row.transportId,
          row.targetKind,
          row.payloadText,
          row.textHash,
          row.status,
          row.attempts,
          row.lastErrorCode,
          row.receipt,
          row.decidedBy,
          row.approvalDecidedAt,
          row.createdAt,
          row.expiresAt,
          row.retryAt,
          row.dispatchStartedAt,
          row.sentAt,
          row.updatedAt,
        ],
      )
      return { row, duplicate: false }
    })
  }

  /**
   * 逐条领取：在同一事务里选择 → 六项复核 → 速率闸（含本批已领取）→ 置 dispatching。
   * 失败的行置 cancelled 并继续；速率额度不足时停止领取（不取消行）。
   */
  claimBatch(input: ClaimBatchInput): ProactiveOutboxRow[] {
    if (typeof input !== 'object' || input === null) throw invalid('claimBatch 输入必须是对象')
    const limit = Math.floor(Number(input.limit))
    if (!Number.isFinite(limit) || limit < 1) throw invalid('limit 必须是正整数')
    const now = requireTime(input.now ?? this.now(), 'now')
    const nowMs = Date.parse(now)
    if (typeof input.consentReader !== 'function' || typeof input.allowReader !== 'function') {
      throw invalid('consentReader / allowReader 必须是函数')
    }
    if (typeof input.transportCheck !== 'function') throw invalid('transportCheck 必须是函数')
    const selectedId = input.outboxId === undefined ? null : requireText(input.outboxId, 'outboxId', 120)

    return this.db.transaction(() => {
      this.expireDue(now)
      const claimed: ProactiveOutboxRow[] = []
      while (claimed.length < limit) {
        const candidate = this.db.get<OutboxDbRow>(
          `SELECT o.* FROM proactive_outbox o
            WHERE o.status = 'pending'
              AND (o.retry_at IS NULL OR o.retry_at <= ?)
              AND o.expires_at > ?
              AND (? IS NULL OR o.outbox_id = ?)
              AND NOT EXISTS (
                SELECT 1 FROM proactive_outbox d
                 WHERE d.contact_id = o.contact_id AND d.status = 'dispatching'
              )
            ORDER BY o.created_at, o.outbox_id
            LIMIT 1`,
          [now, now, selectedId, selectedId],
        )
        if (!candidate) break
        const row = toRow(candidate)
        const failure = this.#recheck(row, input, now, nowMs)
        if (failure) {
          this.#cancelPending(row.outboxId, failure, now)
          continue
        }
        if (!this.#rateAllows(row, now, nowMs)) break
        const changes = this.db.run(
          `UPDATE proactive_outbox
              SET status = 'dispatching', attempts = attempts + 1,
                  dispatch_started_at = ?, updated_at = ?
            WHERE outbox_id = ? AND status = 'pending'`,
          [now, now, row.outboxId],
        ).changes
        if (changes !== 1) continue
        claimed.push({
          ...row,
          status: 'dispatching',
          attempts: row.attempts + 1,
          dispatchStartedAt: now,
          updatedAt: now,
        })
      }
      return claimed
    })
  }

  /** 回执落库；只接受 dispatching 的行，重复/过期回执返回 applied=false。 */
  applyResult(outboxId: string, result: ChatSendResult, nowInput?: string): { applied: boolean; status?: OutboxStatus } {
    if (typeof result !== 'object' || result === null) throw invalid('result 不能为空')
    const now = requireTime(nowInput ?? this.now(), 'now')
    const nowMs = Date.parse(now)
    return this.db.transaction(() => {
      const row = this.get(outboxId)
      if (!row || row.status !== 'dispatching') return { applied: false, status: row?.status }
      switch (result.outcome) {
        case 'accepted':
          this.db.run(
            `UPDATE proactive_outbox
                SET status = 'sent', sent_at = ?, receipt = ?, last_error_code = NULL, updated_at = ?
              WHERE outbox_id = ? AND status = 'dispatching'`,
            [now, result.messageId ?? null, now, outboxId],
          )
          return { applied: true, status: 'sent' as const }
        case 'permanent':
          this.db.run(
            `UPDATE proactive_outbox
                SET status = 'failed', last_error_code = ?, updated_at = ?
              WHERE outbox_id = ? AND status = 'dispatching'`,
            [result.errorCode ?? 'permanent', now, outboxId],
          )
          return { applied: true, status: 'failed' as const }
        case 'unknown':
          this.db.run(
            `UPDATE proactive_outbox
                SET status = 'unknown', last_error_code = ?, updated_at = ?
              WHERE outbox_id = ? AND status = 'dispatching'`,
            [result.errorCode ?? 'unknown', now, outboxId],
          )
          return { applied: true, status: 'unknown' as const }
        case 'retryable': {
          // 主动发送仅对明确 429 重试。通用 Transport 的离线/未知可重试分类不能直接授权重发。
          if (result.errorCode !== 'rate_limited' && result.errorCode !== 'retcode:429') {
            this.db.run(
              `UPDATE proactive_outbox SET status = 'unknown', last_error_code = 'unclassified_retryable', updated_at = ?
                WHERE outbox_id = ? AND status = 'dispatching'`, [now, outboxId],
            )
            return { applied: true, status: 'unknown' as const }
          }
          const retryAtMs = nowMs + clampRetryAfter(result.retryAfterMs)
          if (retryAtMs >= Date.parse(row.expiresAt)) {
            this.db.run(
              `UPDATE proactive_outbox
                  SET status = 'expired', last_error_code = ?, updated_at = ?
                WHERE outbox_id = ? AND status = 'dispatching'`,
              [result.errorCode ?? 'retryable', now, outboxId],
            )
            return { applied: true, status: 'expired' as const }
          }
          this.db.run(
            `UPDATE proactive_outbox
                SET status = 'pending', last_error_code = ?, retry_at = ?,
                    dispatch_started_at = NULL, updated_at = ?
              WHERE outbox_id = ? AND status = 'dispatching'`,
            [result.errorCode ?? 'retryable', new Date(retryAtMs).toISOString(), now, outboxId],
          )
          return { applied: true, status: 'pending' as const }
        }
        default:
          throw invalid(`未知发送结果：${String(result.outcome)}`)
      }
    })
  }

  /** 领取后进程崩溃/重启：dispatching 一律转 unknown，绝不自动重发。 */
  recoverInflight(nowInput?: string): number {
    const now = requireTime(nowInput ?? this.now(), 'now')
    return this.db.transaction(() =>
      this.db.run(
        `UPDATE proactive_outbox
            SET status = 'unknown', last_error_code = 'worker_restart', updated_at = ?
          WHERE status = 'dispatching'`,
        [now],
      ).changes,
    )
  }

  /** 过期扫描：pending 且 expires_at <= now → expired。 */
  markExpired(nowInput?: string): number {
    const now = requireTime(nowInput ?? this.now(), 'now')
    return this.db.transaction(() => this.expireDue(now))
  }

  /** Owner 核验 unknown：received → sent；not-received → failed（需重新审批）。 */
  resolveUnknown(
    outboxId: string,
    verdict: 'received' | 'not-received',
    by: string,
    note?: string,
    nowInput?: string,
  ): ProactiveOutboxRow {
    if (verdict !== 'received' && verdict !== 'not-received') throw invalid('verdict 只能是 received 或 not-received')
    requireText(by, 'by', 120)
    if (by !== this.ownerId) throw outboxError(OUTBOX_ERROR.ownerMismatch, '只有 Owner 能核验 unknown')
    const now = requireTime(nowInput ?? this.now(), 'now')
    return this.db.transaction(() => {
      const row = this.get(outboxId)
      if (!row) throw new PsycheError(CODE.notFound, `找不到发件箱记录：${outboxId}`)
      if (row.status !== 'unknown') throw outboxError(OUTBOX_ERROR.state, `只有 unknown 可以核验，当前是 ${row.status}`)
      const receipt = JSON.stringify({
        resolvedBy: by,
        resolvedAt: now,
        verdict,
        note: note ?? null,
        previousErrorCode: row.lastErrorCode,
      })
      this.db.run(
        `UPDATE proactive_outbox SET status = ?, receipt = ?, updated_at = ?
          WHERE outbox_id = ? AND status = 'unknown'`,
        [verdict === 'received' ? 'sent' : 'failed', receipt, now, outboxId],
      )
      return this.get(outboxId) as ProactiveOutboxRow
    })
  }

  /** Owner 取消 pending；已领走的不在此列。 */
  cancel(outboxId: string, by: string, reason = 'cancelled', nowInput?: string): ProactiveOutboxRow {
    requireText(by, 'by', 120)
    if (by !== this.ownerId) throw outboxError(OUTBOX_ERROR.ownerMismatch, '只有 Owner 能取消发件箱')
    const now = requireTime(nowInput ?? this.now(), 'now')
    return this.db.transaction(() => {
      const row = this.get(outboxId)
      if (!row) throw new PsycheError(CODE.notFound, `找不到发件箱记录：${outboxId}`)
      if (row.status !== 'pending') throw outboxError(OUTBOX_ERROR.state, `只有 pending 可以取消，当前是 ${row.status}`)
      this.db.run(
        `UPDATE proactive_outbox SET status = 'cancelled', last_error_code = ?, updated_at = ?
          WHERE outbox_id = ? AND status = 'pending'`,
        [reason, now, outboxId],
      )
      return this.get(outboxId) as ProactiveOutboxRow
    })
  }

  /** 事务内过期扫描；供 claimBatch 复用（已在外层事务里，db.transaction 会并入）。 */
  private expireDue(now: string): number {
    return this.db.run(
      `UPDATE proactive_outbox SET status = 'expired', last_error_code = 'expired', updated_at = ?
        WHERE status = 'pending' AND expires_at <= ?`,
      [now, now],
    ).changes
  }

  #cancelPending(outboxId: string, reason: string, now: string): void {
    this.db.run(
      `UPDATE proactive_outbox SET status = 'cancelled', last_error_code = ?, updated_at = ?
        WHERE outbox_id = ? AND status = 'pending'`,
      [reason, now, outboxId],
    )
  }

  #rateAllows(row: ProactiveOutboxRow, now: string, nowMs: number): boolean {
    const channelCutoff = new Date(nowMs - OUTBOX_CHANNEL_WINDOW_MS).toISOString()
    const contactCutoff = new Date(nowMs - OUTBOX_CONTACT_WINDOW_MS).toISOString()
    const globalCutoff = new Date(nowMs - OUTBOX_GLOBAL_WINDOW_MS).toISOString()
    const channel = Number(
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM proactive_outbox
          WHERE transport_id = ?
            AND ((status = 'sent' AND COALESCE(sent_at, updated_at) >= ?)
              OR (status = 'dispatching' AND dispatch_started_at >= ?))`,
        [row.transportId, channelCutoff, channelCutoff],
      )?.n ?? 0,
    )
    if (channel >= OUTBOX_CHANNEL_LIMIT) return false
    const contact = Number(
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM proactive_outbox
          WHERE contact_id = ? AND status = 'sent' AND COALESCE(sent_at, updated_at) >= ?`,
        [row.contactId, contactCutoff],
      )?.n ?? 0,
    )
    if (contact >= 1) return false
    const global = Number(
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM proactive_outbox
          WHERE (status = 'sent' AND COALESCE(sent_at, updated_at) >= ?)
             OR (status = 'dispatching' AND dispatch_started_at >= ?)`,
        [globalCutoff, globalCutoff],
      )?.n ?? 0,
    )
    return global < OUTBOX_GLOBAL_LIMIT
  }

  /** 发送前六项复核；返回稳定错误码，全部通过返回 null。 */
  #recheck(row: ProactiveOutboxRow, input: ClaimBatchInput, now: string, nowMs: number): string | null {
    if (row.targetKind !== 'private') return 'unsupported_target'
    // 1. Consent：实时读取，不用入队快照
    let consent: OutboundConsent | null
    try {
      consent = input.consentReader(row.contactId)
    } catch {
      return 'consent_reader_error'
    }
    if (!consent) return 'consent_missing'
    if (consent.status === 'revoked') return 'consent_revoked'
    if (consent.status === 'expired') return 'consent_expired'
    if (consent.status !== 'granted') return 'consent_missing'
    if (consent.expiresAt !== undefined && Date.parse(consent.expiresAt) <= nowMs) return 'consent_expired'

    // 2. 主动联系业务授权：独立于 transport capabilities
    let allow: ProactiveAllowStatus
    try {
      allow = input.allowReader(row.contactId)
    } catch {
      return 'allow_reader_error'
    }
    if (allow !== 'allowed') return `allow_${allow}`

    // 3. Approval：仍要满足 24h 窗口与可信 Owner
    if (row.decidedBy !== this.ownerId) return 'approval_owner_mismatch'
    if (nowMs - Date.parse(row.approvalDecidedAt) > OUTBOX_APPROVAL_VALIDITY_MS) return 'approval_expired'

    // 4. Contact 身份
    const contact = this.db.get<{ platform: string; stable_user_id: string }>(
      `SELECT platform, stable_user_id FROM contacts WHERE contact_id = ?`,
      [row.contactId],
    )
    if (!contact || contact.platform !== row.platform || contact.stable_user_id !== row.stableUserId) {
      return 'contact_mismatch'
    }

    // 5. 内容绑定：正文与 hash 一致；绑定字段非空
    if (row.draftId === '' || row.draftHash === '' || row.draftRevision < 1) return 'content_mismatch'
    if (textHashOf(row.payloadText) !== row.textHash) return 'content_mismatch'
    if (row.payloadText.trim() === '' || row.payloadText.length > 500) return 'content_mismatch'
    if (row.expiresAt <= now) return 'expired'

    // 6. Transport：精确 id/platform + 技术能力 proactive
    if (!input.transportCheck(row)) return 'transport_mismatch'
    return null
  }
}
