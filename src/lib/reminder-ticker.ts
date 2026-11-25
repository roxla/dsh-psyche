/**
 * 提醒到期的定时器。
 *
 * 第 52 轮外部评审把这件事拆成两半：**插件负责「何时扫」，Core 负责「扫到什么做什么」**。
 * 这个类只做前者——它不认识 reminders 表，只认识一个 `() => Promise<number>` 回调。
 * 这样做的好处是 Cron 逻辑能单独测（注入假时钟或直接调 `runOnce()`），
 * 而「到期后该干什么」留在 Core 里用固定时钟测。
 *
 * 三条纪律：
 * 1. **递归 setTimeout，不是 setInterval**——一次 tick 慢于间隔时，setInterval 会堆积
 *    多个并发 tick，递归 setTimeout 保证同一时刻只有一个在跑。
 * 2. **停用后在途 tick 不再排下一次**——`#stopped` 在 `stop()` 里置位，tick 结束时检查。
 * 3. **异常不终止循环**——投递层炸了不应该让提醒永远不再扫；`onError` 收日志，循环继续。
 */

export interface ReminderTickerOptions {
  /** 跑一轮扫描，返回本轮处理条数（只用于日志）。 */
  tick: () => Promise<number>
  /** 两轮之间至少隔多久，默认 60 秒。 */
  intervalMs?: number
  /** 本轮失败时的上报口，默认静默。 */
  onError?: (error: unknown) => void
  /** 定时器实现，测试可替换。 */
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown
  clearTimeoutImpl?: (handle: unknown) => void
}

export const REMINDER_TICK_DEFAULT_MS = 60_000

export class ReminderTicker {
  readonly #tick: () => Promise<number>
  readonly #intervalMs: number
  readonly #onError: (error: unknown) => void
  readonly #setTimeout: (fn: () => void, ms: number) => unknown
  readonly #clearTimeout: (handle: unknown) => void
  #timer: unknown = null
  #stopped = true
  #running = false

  constructor(options: ReminderTickerOptions) {
    this.#tick = options.tick
    this.#intervalMs = options.intervalMs ?? REMINDER_TICK_DEFAULT_MS
    this.#onError = options.onError ?? (() => {})
    this.#setTimeout = options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms))
    this.#clearTimeout = options.clearTimeoutImpl ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  get running(): boolean {
    return !this.#stopped
  }

  /** 启用：立刻扫一次，然后按间隔递归排下一次。重复调用是幂等的。 */
  start(): void {
    if (!this.#stopped) return
    this.#stopped = false
    void this.runOnce()
  }

  /** 停用：清掉待执行的定时器；已经在跑的那一轮跑完后不会再排下一次。 */
  stop(): void {
    this.#stopped = true
    if (this.#timer !== null) {
      this.#clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  /**
   * 手动跑一轮。测试可以直接调它，不必等定时器。
   * 返回值是本轮 tick() 的结果；正在跑时返回 -1（不并发）。
   */
  async runOnce(): Promise<number> {
    if (this.#running) return -1
    this.#running = true
    let handled = 0
    try {
      handled = await this.#tick()
    } catch (error) {
      this.#onError(error)
    } finally {
      this.#running = false
      // 停用后不再排下一次——这是 stop() 能真正停下来的依据。
      if (!this.#stopped) this.#schedule()
    }
    return handled
  }

  #schedule(): void {
    if (this.#timer !== null) this.#clearTimeout(this.#timer)
    this.#timer = this.#setTimeout(() => {
      this.#timer = null
      void this.runOnce()
    }, this.#intervalMs)
  }
}
