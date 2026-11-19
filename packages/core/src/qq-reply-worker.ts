/**
 * P4-B-4-2b：私聊回复 Outbox 的唯一发送 Worker。
 *
 * 约束（见 `docs/audit/p4-b-4-2-preaudit.md` 与 GPT 冻结结论）：
 * - 只有 `qq.replyOutbox.enabled=true` 时才由本 Worker 发送；关闭时走原有直发路径，两者互斥。
 * - 同一时刻最多一条在途（全局单在途），禁止并发领取多条。
 * - 重启/启动时先把遗留 `dispatching` 收敛为 `unknown`，不自动重发。
 * - 结果严格交给 Store 的 `applyResult` 映射；429 由 Transport 标记 retryable，Worker 不自行重试。
 * - 不调用 `transport.send` 之外的发送入口，不做跨平台降级。
 */
import type { ChatSendResult, ChatTarget, ChatTransport } from './chat-transport.js'
import type { QqReplyOutboxRow } from './qq-reply-outbox.js'

/** Worker 只依赖 Store 的这四个能力，便于测试与替换。 */
export interface QqReplyWorkerStore {
  recoverInflight(now?: string): number
  claim(input: {
    readonly limit: number
    readonly authorization: (row: QqReplyOutboxRow) => string | null
    readonly transportCheck: (row: QqReplyOutboxRow) => boolean
    readonly now?: string
  }): QqReplyOutboxRow[]
  applyResult(replyId: string, result: ChatSendResult, now?: string): QqReplyOutboxRow | undefined
  expireDue?(now?: string): number
}

export interface QqReplyWorkerLogger {
  warn(message: string, meta?: Record<string, unknown>): void
}

export interface QqReplyWorkerOptions {
  readonly store: QqReplyWorkerStore
  readonly transport: ChatTransport
  readonly targetOf: (row: QqReplyOutboxRow) => ChatTarget | null
  readonly authorization?: (row: QqReplyOutboxRow) => string | null
  readonly intervalMs?: number
  readonly logger?: QqReplyWorkerLogger
  readonly now?: () => string
}

const DEFAULT_INTERVAL_MS = 2_000

export class QqReplyWorker {
  readonly store: QqReplyWorkerStore
  readonly transport: ChatTransport
  #targetOf: (row: QqReplyOutboxRow) => ChatTarget | null
  #authorization: (row: QqReplyOutboxRow) => string | null
  #intervalMs: number
  #logger: QqReplyWorkerLogger | undefined
  #now: () => string
  #timer: ReturnType<typeof setInterval> | null = null
  #running = false
  #ticking = false
  #recovered = false

  constructor(options: QqReplyWorkerOptions) {
    this.store = options.store
    this.transport = options.transport
    this.#targetOf = options.targetOf
    this.#authorization = options.authorization ?? (() => null)
    this.#intervalMs = Math.max(250, options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.#logger = options.logger
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  /** 启动：先收敛遗留 dispatching，再开始定时领取；重复调用幂等。 */
  start(): void {
    if (this.#running) return
    if (!this.#recovered) {
      const recovered = this.store.recoverInflight(this.#now())
      this.#recovered = true
      if (recovered > 0) {
        this.#logger?.warn('[psyche][qq] 启动时存在未完成发送，已收敛为 unknown，不自动重发', { recovered })
      }
    }
    this.#running = true
    this.#timer = setInterval(() => { void this.tick() }, this.#intervalMs)
    if (typeof this.#timer === 'object' && this.#timer !== null && 'unref' in this.#timer) {
      ;(this.#timer as { unref?: () => void }).unref?.()
    }
    void this.tick()
  }

  /** 停止领取；已在途的一条仍会走完并写回结果。 */
  async stop(): Promise<void> {
    this.#running = false
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    while (this.#ticking) await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }

  get running(): boolean {
    return this.#running
  }

  /**
   * 领取并发送一条。无可用发送或通道未连接时直接返回。
   * 公开给测试与宿主手动触发；正常由 start() 定时调用。
   */
  async tick(): Promise<void> {
    if (!this.#running || this.#ticking) return
    if (this.transport.status() !== 'connected') return
    this.#ticking = true
    try {
      this.store.expireDue?.(this.#now())
      const rows = this.store.claim({
        limit: 1,
        authorization: (row) => {
          if (row.transportId !== this.transport.id) return 'transport-mismatch'
          if (row.platform !== this.transport.platform) return 'platform-mismatch'
          return this.#authorization(row)
        },
        transportCheck: (row) =>
          row.transportId === this.transport.id && row.platform === this.transport.platform,
        now: this.#now(),
      })
      const row = rows[0]
      if (row === undefined) return
      const target = this.#targetOf(row)
      if (target === null) {
        this.store.applyResult(row.replyId, { outcome: 'permanent', errorCode: 'target-unresolved' }, this.#now())
        return
      }
      let result: ChatSendResult
      try {
        result = await this.transport.send(target, {
          text: row.payloadText,
          replyToMessageId: row.quoteMessageId ?? null,
        })
      } catch (error) {
        // 发送路径抛错无法判断是否已送达：按 unknown 处理，绝不自动重发。
        result = {
          outcome: 'unknown',
          errorCode: error instanceof Error ? error.name : 'send_threw',
        }
      }
      this.store.applyResult(row.replyId, result, this.#now())
      if (result.outcome === 'unknown' || result.outcome === 'permanent') {
        this.#logger?.warn('[psyche][qq] Outbox 发送未成功', {
          replyId: row.replyId,
          outcome: result.outcome,
          errorCode: result.errorCode ?? '',
        })
      }
    } catch (error) {
      this.#logger?.warn('[psyche][qq] Outbox Worker 领取失败（不阻塞后续轮次）', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.#ticking = false
    }
  }
}
