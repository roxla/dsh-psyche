// P3-C-3a：OutboxWorker —— 只被测试或显式调用驱动的循环。
//
// 不注册到宿主启动流程（C-3a 不接真实主动发送）；只有测试显式 start() 才会定时领取。
// 单条异常不终止循环；stop() 之后不再调度。
import type { OutboundRunResult } from './proactive-outbound-service.js'
import { EMPTY_RUN_RESULT, OutboundService } from './proactive-outbound-service.js'
import { invalid } from './errors.js'

export interface OutboxWorkerOptions {
  readonly service: OutboundService
  readonly intervalMs?: number
  readonly limit?: number
  readonly outboxId?: string
  readonly onError?: (error: unknown) => void
}

export const OUTBOX_WORKER_DEFAULT_INTERVAL_MS = 1000

export class OutboxWorker {
  readonly service: OutboundService
  #intervalMs: number
  #limit: number
  #outboxId: string | undefined
  #onError: (error: unknown) => void
  #timer: ReturnType<typeof setTimeout> | null = null
  #stopped = true
  #ticking = false

  constructor(options: OutboxWorkerOptions) {
    if (!options || typeof options !== 'object') throw invalid('OutboxWorker 需要配置')
    if (!(options.service instanceof OutboundService)) throw invalid('service 必须是 OutboundService')
    const intervalMs = Math.floor(Number(options.intervalMs ?? OUTBOX_WORKER_DEFAULT_INTERVAL_MS))
    if (!Number.isFinite(intervalMs) || intervalMs < 50) throw invalid('intervalMs 不能小于 50ms')
    const limit = Math.floor(Number(options.limit ?? 5))
    if (!Number.isFinite(limit) || limit < 1) throw invalid('limit 必须是正整数')
    this.service = options.service
    this.#intervalMs = intervalMs
    this.#limit = limit
    this.#outboxId = options.outboxId
    this.#onError = options.onError ?? (() => undefined)
  }

  get running(): boolean {
    return !this.#stopped
  }

  get intervalMs(): number {
    return this.#intervalMs
  }

  start(): void {
    if (!this.#stopped) return
    this.#stopped = false
    this.#schedule(0)
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  /** 单次领取+发送；可由测试直接调用，也可被 start() 的计时器调用。 */
  async tickOnce(): Promise<OutboundRunResult> {
    if (this.#ticking) return EMPTY_RUN_RESULT
    this.#ticking = true
    try {
      return await this.service.runOnce({ limit: this.#limit, outboxId: this.#outboxId })
    } catch (error) {
      this.#onError(error)
      return EMPTY_RUN_RESULT
    } finally {
      this.#ticking = false
    }
  }

  #schedule(delayMs: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.tickOnce().then(() => {
        if (!this.#stopped) this.#schedule(this.#intervalMs)
      })
    }, Math.max(0, delayMs))
    // 不阻止进程退出（测试以外没有宿主常驻需求）。
    this.#timer.unref?.()
  }
}
