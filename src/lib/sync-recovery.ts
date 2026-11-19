/**
 * P2-CAP-1c1：Ghost 补采（Host 层，纯逻辑、可单测）。
 *
 * 解决什么：实时 `session/event` 是 fire-and-forget，插件重启/队列溢出/进程退出时
 * 可能有用户消息没进 Source。1c0 探针确认 web/desktop 模板提供
 * `ctx.sessionPersistence`（JSONL 会话日志，可 list / open read / 分页 read）。
 *
 * 补采时机：新会话轮次开始（`turn/start`）时，读同一会话的持久化日志，
 * 看「这一轮之前最近的一条真实用户消息」是否已有 Source；没有就补一条。
 *
 * 边界（都是刻意的）：
 * 1. 只补 Source。不调 remember / clash / revise / review，不碰成长/关系/人格。
 * 2. 不追「队列溢出时丢了哪几条」——没有原文就没有可恢复的事实。这里只覆盖
 *    “上一轮用户消息没落库”这一种可确认的缺口。
 * 3. 幂等靠 1a 的 captureKey（= user 事件的 seq）；重复补采只会拿到原 Source。
 * 4. 没有持久化服务（如 headless 模板）时明确降级：警告一次、不再轮询，不假装能补采。
 * 5. `read()` 返回的是快照（eventState='shared-frozen'），read 句柄不能 flush。
 */

import { classifySessionEvent } from './capture-host.js'
import type { CaptureInputLike, CaptureScope, SessionEventLike, SessionLike } from './capture-host.js'

/** 兼容 list 返回的条目形状：只需要 header.id。 */
export interface PersistenceEntryLike {
  header?: { id?: string }
}

/** read 句柄只需要 read / close / inheritedEventCount。 */
export interface PersistenceHandleLike {
  read(offset: number, length: number): unknown | Promise<unknown>
  close(): unknown | Promise<unknown>
  inheritedEventCount?: number | (() => number)
}

export interface PersistenceServiceLike {
  list(): unknown | Promise<unknown>
  open(id: string, mode: 'read'): unknown | Promise<unknown>
}

/** Host 只需要「能取到服务」这一件事，测试里用假对象。 */
export interface GhostContextLike {
  get?(name: string): unknown
}

export interface GhostSink {
  capture(input: CaptureInputLike): Promise<{ replayed?: boolean; sourceId?: string } | void>
}

export interface GhostSyncHostOptions {
  ctx: GhostContextLike
  sink: GhostSink
  scope: CaptureScope
  /** 每次 read 最多读多少条事件（默认 200）。 */
  maxScan?: number
  /** 只补「最近这么多毫秒内」的用户消息（默认 5 分钟），防止首次扫描把陈年会话全补进来。 */
  lookbackMs?: number
  logger?: { debug?(message: string): void; warn?(message: string): void }
}

export interface GhostSyncHostStats {
  /** 收到并识别的 turn/start 条数。 */
  turnsSeen: number
  /** 实际读完持久化日志的次数。 */
  polls: number
  /** 补采成功（新写入）的条数。 */
  recovered: number
  /** 补采时命中幂等、已有 Source 的条数。 */
  replayed: number
  /** 因范围（白名单/排除/关闭）跳过的条数。 */
  skipped: number
  /** 失败次数（已记录，不重试；下次 turn/start 会再试）。 */
  failed: number
  lastError: string | null
  stopped: boolean
}

interface TurnStartFact {
  seq: number
  time: number
}

interface UserFact {
  seq: number
  time: number
  text: string
  messageId: string | null
}

const DEFAULT_MAX_SCAN = 200
const DEFAULT_LOOKBACK_MS = 5 * 60 * 1000
const DSH_PLATFORM = 'dsh-session'
const DSH_CHANNEL = 'desktop'

function timestampOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** 从 read 的返回值里取出事件数组；形状不对返回空数组，不抛。 */
export function eventsOf(page: unknown): unknown[] {
  if (!page || typeof page !== 'object') return []
  const events = (page as { events?: unknown }).events
  return Array.isArray(events) ? events : []
}

/**
 * 事件里是否含真实用户输入。
 *
 * 过滤规则**必须**与实时捕获共用 `classifySessionEvent`：以前这里自己实现了一套
 * `textOf`，会把 reasoning 块拼进正文、也不做密钥过滤；补采进来的「用户原话」
 * 和实时捕获的正文因此可能不一样。
 */
export function isRealUserMessage(event: unknown): UserFact | null {
  const classified = classifySessionEvent(event as SessionEventLike)
  if (!classified || classified.role !== 'user') return null
  const fact = event as SessionEventLike
  const seq = typeof fact.seq === 'number' ? fact.seq : null
  const time = timestampOf(fact.time)
  if (seq === null || time === null || !classified.text) return null
  return {
    seq,
    time,
    text: classified.text,
    messageId: classified.messageId,
  }
}

/** 事件是否是 turn/start，返回轮次序号与时间。 */
export function turnStartOf(event: unknown): TurnStartFact | null {
  if (!event || typeof event !== 'object') return null
  const fact = event as SessionEventLike
  if (fact.type !== 'turn/start') return null
  const seq = typeof fact.seq === 'number' ? fact.seq : null
  const time = timestampOf(fact.time)
  if (seq === null || time === null) return null
  return { seq, time }
}

/**
 * Fork 会话的继承前缀长度。
 *
 * DSH 的会话日志在 Fork 时会带上父会话的事件前缀；`inheritedEventCount`
 * 表示前 N 条（seq 0..N-1）来自父会话，不是子会话自己的经历。
 * 补采必须跳过这段，否则会把父会话的用户消息当成子会话的缺口再补一遍。
 */
export function inheritedCountOf(handle: unknown): number {
  if (!handle || typeof handle !== 'object') return 0
  const raw = (handle as { inheritedEventCount?: unknown }).inheritedEventCount
  const value = typeof raw === 'function' ? (raw as () => unknown)() : raw
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

/**
 * Ghost 补采器。
 *
 * 只在 `turn/start` 时工作：读同一会话的持久化日志，找这一轮开始之前、
 * 最近的一条真实用户消息；如果它的 captureKey 在库里还没有 Source，才补一条。
 */
export class GhostSyncHost {
  readonly #options: GhostSyncHostOptions
  readonly #maxScan: number
  readonly #lookbackMs: number
  readonly #turnStarts = new Map<string, TurnStartFact>()
  readonly #polling = new Set<string>()
  readonly #stats: GhostSyncHostStats = {
    turnsSeen: 0,
    polls: 0,
    recovered: 0,
    replayed: 0,
    skipped: 0,
    failed: 0,
    lastError: null,
    stopped: false,
  }
  #warnedMissingPersistence = false

  constructor(options: GhostSyncHostOptions) {
    this.#options = options
    this.#maxScan = Math.max(1, Math.min(2000, Math.floor(options.maxScan ?? DEFAULT_MAX_SCAN)))
    this.#lookbackMs = Math.max(1000, Math.floor(options.lookbackMs ?? DEFAULT_LOOKBACK_MS))
  }

  /** 监听入口：只认 turn/start；范围外的会话直接跳过。 */
  handle(session: SessionLike, event: SessionEventLike): void {
    if (this.#stats.stopped) return
    const turn = turnStartOf(event)
    if (!turn) return
    const sessionId = typeof session?.id === 'string' ? session.id : ''
    if (!sessionId) return
    if (!this.#scopeAllows(sessionId)) {
      this.#stats.skipped += 1
      return
    }
    this.#stats.turnsSeen += 1
    this.#turnStarts.set(sessionId, turn)
    void this.poll(sessionId)
  }

  /** 公开给恢复/测试：对指定会话做一次补采检查。 */
  async poll(sessionId: string): Promise<void> {
    if (this.#stats.stopped || this.#polling.has(sessionId)) return
    const turn = this.#turnStarts.get(sessionId)
    if (!turn) return
    const service = this.#persistenceService()
    if (!service) return
    this.#polling.add(sessionId)
    try {
      const entries = await Promise.resolve(service.list())
      const rows = Array.isArray(entries) ? (entries as PersistenceEntryLike[]) : []
      const found = rows.some((row) => row?.header?.id === sessionId)
      if (!found) return
      const handle = (await Promise.resolve(service.open(sessionId, 'read'))) as PersistenceHandleLike | null
      if (!handle || typeof handle.read !== 'function') return
      const inherited = inheritedCountOf(handle)
      let page: unknown = null
      try {
        page = await Promise.resolve(handle.read(0, this.#maxScan))
      } finally {
        try {
          await Promise.resolve(handle.close())
        } catch {
          // 关闭失败不影响本次补采结论
        }
      }
      this.#stats.polls += 1
      const events = eventsOf(page)
      const users = events.map((event) => isRealUserMessage(event)).filter((item): item is UserFact => item !== null)
      const now = Date.now()
      // 只找「这一轮开始之前」的上一轮用户消息：seq 与时间都要早于 turn/start。
      // 本轮自己的 user/message（seq 更大、时间更晚）由实时监听负责，不在这里补。
      const candidate = users
        .filter(
          (user) =>
            user.seq >= inherited &&
            user.seq < turn.seq &&
            user.time < turn.time &&
            user.time >= now - this.#lookbackMs,
        )
        .sort((a, b) => b.seq - a.seq)[0]
      if (!candidate) return
      const result = await this.#options.sink.capture({
        platform: DSH_PLATFORM,
        channel: DSH_CHANNEL,
        sessionRef: sessionId,
        captureKey: String(candidate.seq),
        messageId: candidate.messageId,
        origin: 'user',
        kind: 'message',
        text: candidate.text,
        at: new Date(candidate.time).toISOString(),
        metadata: { dsh: { recovered: true, turnStartSeq: turn.seq } },
      })
      if (result && result.replayed) this.#stats.replayed += 1
      else this.#stats.recovered += 1
    } catch (error) {
      this.#stats.failed += 1
      this.#stats.lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      this.#options.logger?.warn?.(`[psyche-ghost] 补采失败：${this.#stats.lastError}`)
    } finally {
      this.#polling.delete(sessionId)
    }
  }

  stop(): void {
    this.#stats.stopped = true
  }

  /** 等当前正在跑的补采结束（5ms 轮询，最多 2s）。 */
  async drain(): Promise<void> {
    const deadline = Date.now() + 2000
    while (this.#polling.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  stats(): GhostSyncHostStats {
    return { ...this.#stats }
  }

  #scopeAllows(sessionId: string): boolean {
    const scope = this.#options.scope
    if (!scope.enabled) return false
    if (scope.excludeSessions && scope.excludeSessions.includes(sessionId)) return false
    if (scope.allowSessions && scope.allowSessions.length > 0 && !scope.allowSessions.includes(sessionId)) {
      return false
    }
    return true
  }

  #persistenceService(): PersistenceServiceLike | null {
    const service = this.#options.ctx.get?.('sessionPersistence') as PersistenceServiceLike | undefined
    if (!service || typeof service.list !== 'function' || typeof service.open !== 'function') {
      if (!this.#warnedMissingPersistence) {
        this.#warnedMissingPersistence = true
        this.#options.logger?.warn?.('[psyche-ghost] 当前宿主没有 sessionPersistence，历史补采不可用')
      }
      return null
    }
    return service
  }
}
