// P3-C-3a：OutboundService —— 把 OutboxStore 的状态机接到 ChatTransport。
//
// 边界：只负责「领取已审批的行 → 复核 → 调 transport.send → 落回执」。
// 不生成草稿、不做模型决策、不自动重发、不跨平台降级。
// 日志只记录 outbox_id/approval_id/status，绝不打印 payload_text。
import {
  OUTBOX_APPROVAL_VALIDITY_MS,
  OUTBOX_ERROR,
  OUTBOX_MAX_ACTIVE,
  OUTBOX_TTL_MS,
  OutboxStore,
  outboxIdOf,
  type ClaimBatchInput,
  type ConsentReader,
  type OutboxEnqueueInput,
  type OutboxEnqueueResult,
  type OutboxStatus,
  type ProactiveAllowReader,
  type ProactiveOutboxRow,
} from './proactive-outbox.js'
import type { ChatTarget, ChatTransport } from './chat-transport.js'
import { CODE, PsycheError, invalid } from './errors.js'

export interface OutboundServiceOptions {
  readonly store: OutboxStore
  readonly transport: ChatTransport
  readonly consentReader: ConsentReader
  readonly allowReader: ProactiveAllowReader
  /** 与 store.ownerId 相同；审批的 decidedBy 只能来自可信本地 Owner。 */
  readonly ownerId: string
  readonly logger?: (event: string, data?: Record<string, unknown>) => void
}

export interface OutboundRunResult {
  readonly claimed: number
  readonly sent: number
  readonly failed: number
  readonly unknown: number
  readonly retryable: number
  readonly expired: number
  readonly cancelled: number
}

export const EMPTY_RUN_RESULT: OutboundRunResult = Object.freeze({
  claimed: 0,
  sent: 0,
  failed: 0,
  unknown: 0,
  retryable: 0,
  expired: 0,
  cancelled: 0,
})

export interface ApproveEnqueueInput extends Omit<OutboxEnqueueInput, 'decision' | 'decidedBy'> {
  readonly decidedBy: string
}

export class OutboundService {
  readonly store: OutboxStore
  readonly transport: ChatTransport
  readonly ownerId: string
  #consentReader: ConsentReader
  #allowReader: ProactiveAllowReader
  #logger: (event: string, data?: Record<string, unknown>) => void

  constructor(options: OutboundServiceOptions) {
    if (!options || typeof options !== 'object') throw invalid('OutboundService 需要配置')
    if (!(options.store instanceof OutboxStore)) throw invalid('store 必须是 OutboxStore')
    if (!options.transport || typeof options.transport.send !== 'function') throw invalid('transport 必须实现 ChatTransport')
    if (typeof options.consentReader !== 'function' || typeof options.allowReader !== 'function') {
      throw invalid('consentReader / allowReader 必须是函数')
    }
    if (typeof options.ownerId !== 'string' || options.ownerId.trim() === '') throw invalid('ownerId 不能为空')
    if (options.ownerId !== options.store.ownerId) {
      throw new PsycheError(CODE.state, 'OutboundService 与 OutboxStore 的 Owner 不一致', {
        reason: OUTBOX_ERROR.approvalOwner,
      })
    }
    this.store = options.store
    this.transport = options.transport
    this.ownerId = options.ownerId
    this.#consentReader = options.consentReader
    this.#allowReader = options.allowReader
    this.#logger = options.logger ?? (() => undefined)
  }

  /** 审批 + 入队：两者原子；owner 由构造参数决定，不接受调用方伪造的 owner。 */
  approveAndEnqueue(input: ApproveEnqueueInput): OutboxEnqueueResult {
    if (!input || typeof input !== 'object') throw invalid('审批输入必须是对象')
    if (input.decidedBy !== this.ownerId) {
      throw new PsycheError(CODE.state, '审批人不是可信本地 Owner', { reason: OUTBOX_ERROR.approvalOwner })
    }
    return this.store.enqueue({ ...input, decision: 'approved', decidedBy: this.ownerId })
  }

  /** 领取并可发送的 Transport 是否匹配（业务授权由 store 的 #recheck 负责）。 */
  transportCheck = (row: ProactiveOutboxRow): boolean => {
    if (row.transportId !== this.transport.id) return false
    if (row.platform !== this.transport.platform) return false
    const cap = this.transport.capabilities()
    return cap.text === true && cap.proactive === true
  }

  /**
   * 一轮：先看通道是否至少可用；未连接时不领取，避免白白消耗 attempts。
   * 领取后逐条发送；单条异常按 unknown 落库，绝不让异常中断其余行。
   */
  async runOnce(options: { limit?: number; now?: string; outboxId?: string } = {}): Promise<OutboundRunResult> {
    const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? OUTBOX_MAX_ACTIVE)))
    const now = options.now ?? this.store.now()
    const state = this.transport.status()
    if (state === 'disconnected' || state === 'unknown') {
      this.#logger('outbound.skip_offline', { state })
      return EMPTY_RUN_RESULT
    }

    const claimInput: ClaimBatchInput = {
      limit,
      consentReader: this.#consentReader,
      allowReader: this.#allowReader,
      transportCheck: this.transportCheck,
      now,
      outboxId: options.outboxId,
    }
    const rows = this.store.claimBatch(claimInput)
    if (rows.length === 0) return EMPTY_RUN_RESULT

    let sent = 0
    let failed = 0
    let unknown = 0
    let retryable = 0

    for (const row of rows) {
      // 领取后且调用 send 前掉线：明确未发，终止并要求重新审批，不扩大为自动重试。
      const liveState = this.transport.status()
      if (liveState === 'disconnected' || liveState === 'unknown') {
        this.store.applyResult(row.outboxId, { outcome: 'permanent', errorCode: 'transport_offline_before_send' }, now)
        failed += 1
        continue
      }
      let result
      try {
        result = await this.transport.send(this.#targetOf(row), { text: row.payloadText })
      } catch {
        // 请求已发出但结果不可知：只能核验，不能自动重发。
        result = { outcome: 'unknown' as const, errorCode: 'transport_exception' }
      }
      const applied = this.store.applyResult(row.outboxId, result, now)
      if (!applied.applied) continue
      const status: OutboxStatus | undefined = applied.status
      if (status === 'sent') sent += 1
      else if (status === 'failed') failed += 1
      else if (status === 'unknown') unknown += 1
      else if (status === 'pending') retryable += 1
      this.#logger('outbound.result', {
        outboxId: row.outboxId,
        approvalId: row.approvalId,
        status,
        errorCode: result.errorCode ?? null,
      })
    }

    return {
      claimed: rows.length,
      sent,
      failed,
      unknown,
      retryable,
      expired: 0,
      cancelled: 0,
    }
  }

  #targetOf(row: ProactiveOutboxRow): ChatTarget {
    return row.targetKind === 'group'
      ? { kind: 'group', platform: row.platform, groupId: row.stableUserId }
      : { kind: 'private', platform: row.platform, stableUserId: row.stableUserId }
  }
}

export { OUTBOX_APPROVAL_VALIDITY_MS, OUTBOX_TTL_MS, outboxIdOf }
