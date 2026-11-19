/**
 * P2-CAP-1c3-C：Recovery Scanner。
 *
 * 职责只有一件：把「持久化日志里有、Sources 里还没有」的对话消息补齐。
 * 它不判断值不值得记，也不调用 remember / revise —— 和实时捕获一样，只写 Source。
 *
 * 与另外两个入口共用同一套归一：
 * - `classifySessionEvent()`（capture-host）决定「这条消息能不能捕、正文取哪段」；
 * - `captureKey = String(seq)`、`platform/sessionRef` 与实时捕获一致，靠 v4 唯一索引幂等；
 * - Fork 继承前缀用 `inherited_event_count` 过滤。
 *
 * 扫描协议（v27.2）：
 * 1. `open(id, 'read')` 拿一个稳定快照，先分页读一遍只取实际 maxSeq 作 `scanTargetSeq`；
 * 2. 用 Owner UUID 认领 Cursor（CAS + 租约），拿不到说明别的扫描器在跑 → busy；
 * 3. 从 Cursor 的 `scan_index` 开始按**事件下标**分页，按实际 seq 升序处理；
 * 4. 每条先写 Source、成功后才推进水位；失败就停在失败事件前，lease 释放但水位保留；
 * 5. 忽略事件与水位同一次 `advance` 提交（按 ruleVersion 分组），重放不重复计数；
 * 6. 到 target 或预算上限就释放租约；新事件留给下一轮。
 *
 * 明确不做：不扫描 headless（没有 sessionPersistence 服务）、不读已压缩日志、
 * 不把「扫描过」说成「所有消息都至少捕获一次」——那是 1c3-D 的验收口径。
 */

import { randomUUID } from 'node:crypto'
import {
  classifySessionEvent,
  DSH_PLATFORM,
  type CaptureInputLike,
  type CaptureSink,
  type SessionEventLike,
} from './capture-host.js'
import { inheritedCountOf, type GhostContextLike, type PersistenceHandleLike, type PersistenceServiceLike } from './sync-recovery.js'
import {
  CaptureCursorStore,
  type CaptureCursorClaim,
  type CaptureCursorIdentity,
} from './capture-cursor.js'

export interface RecoveryScannerScope {
  enabled: boolean
  allowSessions?: string[]
  excludeSessions?: string[]
}

export interface RecoveryScannerOptions {
  sink: CaptureSink
  cursors: CaptureCursorStore
  /** Host 上下文：不显式注入 persistence 时用它取 `sessionPersistence`。 */
  ctx?: GhostContextLike
  /** 不传就从宿主 `ctx.get('sessionPersistence')` 取。 */
  persistence?: PersistenceServiceLike | null
  scope: RecoveryScannerScope
  /** 单次扫描最多处理多少条「候选事件」（捕获或忽略都算），到上限就释放租约留给下一轮。 */
  maxEventsPerScan?: number
  /** 每次 `read(offset, length)` 的条数。 */
  pageSize?: number
  /** 单条正文上限，必须与实时捕获同值。 */
  maxText?: number
  /** Cursor 租约时长（毫秒）。 */
  leaseMs?: number
  /** 过滤规则版本：每轮固定，写进 ignored_summary 分组。 */
  ruleVersion?: string
  personaId?: string
  logger?: { warn?: (message: string) => void }
}

export type RecoveryScanStatus = 'scanned' | 'busy' | 'unsupported' | 'skipped' | 'empty' | 'failed'

export interface RecoveryScanResult {
  ok: boolean
  status: RecoveryScanStatus
  sessionRef: string
  targetSeq: number | null
  scanned: number
  captured: number
  replayed: number
  ignored: number
  /** 停在哪个 seq（捕获失败或租约丢失时）；null 表示没有停。 */
  failedSeq: number | null
  reachedTarget: boolean
  /** 是否因为达到单次预算而提前释放。 */
  budgetHit: boolean
  error?: string
}

export interface RecoveryScannerStats {
  scans: number
  captured: number
  replayed: number
  ignored: number
  busy: number
  failed: number
  lastError: string | null
  stopped: boolean
}

const DEFAULT_MAX_EVENTS = 1000
const DEFAULT_PAGE_SIZE = 500
const DEFAULT_LEASE_MS = 60_000

/** 从一页 read 结果里取事件数组：只认 `events`，别猜别的形状。 */
function eventsOf(page: unknown): SessionEventLike[] {
  if (!page || typeof page !== 'object') return []
  const events = (page as { events?: unknown }).events
  return Array.isArray(events) ? (events as SessionEventLike[]) : []
}

/**
 * 忽略原因只用于统计，不用于任何判断。
 * 能拿到 type 就按 type 分，拿不到归 'unknown'——不要把「分不出原因」写成「不重要」。
 */
function ignoreReasonOf(event: SessionEventLike): string {
  const type = typeof event?.type === 'string' ? event.type : ''
  return type || 'unknown'
}

export class RecoveryScanner {
  readonly #options: RecoveryScannerOptions
  readonly #cursors: CaptureCursorStore
  readonly #maxEvents: number
  readonly #pageSize: number
  readonly #maxText: number
  readonly #leaseMs: number
  readonly #ruleVersion: string
  readonly #personaId: string
  #stopped = false
  #stats: RecoveryScannerStats = {
    scans: 0,
    captured: 0,
    replayed: 0,
    ignored: 0,
    busy: 0,
    failed: 0,
    lastError: null,
    stopped: false,
  }

  constructor(options: RecoveryScannerOptions) {
    this.#options = options
    this.#cursors = options.cursors
    this.#maxEvents = Math.max(1, Math.floor(options.maxEventsPerScan ?? DEFAULT_MAX_EVENTS))
    this.#pageSize = Math.max(1, Math.min(5000, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)))
    this.#maxText = Math.max(100, Math.floor(options.maxText ?? 8000))
    this.#leaseMs = Math.max(1000, Math.floor(options.leaseMs ?? DEFAULT_LEASE_MS))
    this.#ruleVersion = options.ruleVersion ?? 'v1'
    this.#personaId = options.personaId ?? 'main'
  }

  stop(): void {
    this.#stopped = true
    this.#stats.stopped = true
  }

  stats(): RecoveryScannerStats {
    return { ...this.#stats }
  }

  /** 对指定会话扫描一次。可重入：同一会话同时只能有一个扫描器拿到租约。 */
  async scanSession(sessionId: string): Promise<RecoveryScanResult> {
    const base: RecoveryScanResult = {
      ok: true,
      status: 'skipped',
      sessionRef: sessionId,
      targetSeq: null,
      scanned: 0,
      captured: 0,
      replayed: 0,
      ignored: 0,
      failedSeq: null,
      reachedTarget: false,
      budgetHit: false,
    }
    if (this.#stopped) return base
    if (!this.#scopeAllows(sessionId)) return base

    const service = this.#persistence()
    if (!service) return { ...base, status: 'unsupported' }

    let handle: PersistenceHandleLike | null = null
    try {
      const entries = await Promise.resolve(service.list())
      const rows = Array.isArray(entries) ? entries : []
      if (!rows.some((row) => row?.header?.id === sessionId)) return { ...base, status: 'skipped' }

      handle = (await Promise.resolve(service.open(sessionId, 'read'))) as PersistenceHandleLike | null
      if (!handle || typeof handle.read !== 'function') return { ...base, status: 'unsupported' }

      // 第一遍：同一个快照读一遍，只取实际 maxSeq 作为终点。
      const targetSeq = await this.#maxSeqOf(handle)
      if (targetSeq < 0) return { ...base, status: 'empty' }
      base.targetSeq = targetSeq

      const identity: CaptureCursorIdentity = {
        personaId: this.#personaId,
        platform: DSH_PLATFORM,
        sessionRef: sessionId,
      }
      const row = this.#cursors.read(identity)
      let lastScanned = row?.lastScannedSeq ?? -1
      let scanIndex = row?.scanIndex ?? 0
      if (lastScanned >= targetSeq) {
        // 水位已经追上终点：没有新事件，不需要认领。
        return { ...base, reachedTarget: true }
      }

      const owner = randomUUID()
      let claim = this.#cursors.claim(identity, {
        owner,
        scanTargetSeq: targetSeq,
        ruleVersion: this.#ruleVersion,
        leaseMs: this.#leaseMs,
      })
      if (!claim) {
        this.#stats.busy += 1
        return { ...base, status: 'busy' }
      }

      const inherited = inheritedCountOf(handle)
      const ignored = new Map<string, number>()
      let scanned = 0
      let captured = 0
      let replayed = 0
      let ignoredCount = 0
      let failedSeq: number | null = null
      let reachedTarget = false
      let budgetHit = false
      let error: string | undefined

      try {
        while (scanIndex <= targetSeq) {
          const page = await this.#readPage(handle, scanIndex)
          const events = eventsOf(page)
          if (events.length === 0) {
            reachedTarget = true
            break
          }
          let pageDone = false
          for (const event of events) {
            const seq = typeof event?.seq === 'number' && Number.isFinite(event.seq) ? event.seq : null
            if (seq === null) {
              // 没有 seq 的事件无法用 captureKey 幂等，直接跳过；不假装处理过。
              ignored.set('no-seq', (ignored.get('no-seq') ?? 0) + 1)
              ignoredCount += 1
              scanIndex += 1
              continue
            }
            // 新事件（target 之后）：本轮不处理，留给下一轮。
            if (seq > targetSeq) {
              reachedTarget = true
              pageDone = true
              break
            }
            // Fork 继承前缀：不是这一支自己的经历。
            if (seq < inherited) {
              scanIndex += 1
              continue
            }
            if (seq <= lastScanned) {
              // 已处理过（崩溃重放/上一轮已推进）：只移动下标，不重复计数。
              scanIndex += 1
              continue
            }
            const classified = classifySessionEvent(event, { maxText: this.#maxText })
            if (!classified) {
              const reason = ignoreReasonOf(event)
              ignored.set(reason, (ignored.get(reason) ?? 0) + 1)
              ignoredCount += 1
              scanIndex += 1
              continue
            }
            const input: CaptureInputLike = {
              platform: DSH_PLATFORM,
              channel: 'desktop',
              sessionRef: sessionId,
              captureKey: String(seq),
              messageId: classified.messageId,
              origin: classified.role === 'user' ? 'user' : 'self',
              kind: classified.role === 'user' ? 'message' : 'model',
              text: classified.text,
              at: typeof event.time === 'string' ? event.time : new Date().toISOString(),
              metadata: {
                dsh: {
                  sessionId,
                  seq,
                  role: classified.role,
                  recovered: true,
                  ruleVersion: this.#ruleVersion,
                  ...(classified.role === 'user' ? {} : { interrupted: classified.interrupted }),
                },
              },
            }
            try {
              const result = await this.#options.sink.capture(input)
              if (result && result.replayed) replayed += 1
              else captured += 1
            } catch (captureError) {
              failedSeq = seq
              error = captureError instanceof Error ? `${captureError.name}: ${captureError.message}` : String(captureError)
              pageDone = true
              break
            }
            lastScanned = seq
            scanIndex += 1
            scanned += 1
            if (scanned >= this.#maxEvents) {
              budgetHit = true
              pageDone = true
              break
            }
          }
          if (pageDone) break
          // 每页结束把水位+下标+忽略统计一起提交；拿不到（租约丢失）就停。
          const advanced = this.#cursors.advance(claim, {
            lastScannedSeq: lastScanned,
            scanIndex,
            ignoredSummary: JSON.stringify(this.#summariseIgnored(ignored)),
            ruleVersion: this.#ruleVersion,
            leaseMs: this.#leaseMs,
          })
          if (!advanced) {
            claim = null
            break
          }
          claim = advanced
          if (events.length < this.#pageSize) {
            reachedTarget = true
            break
          }
        }

        if (claim) {
          // 失败也提交「已经成功处理的前缀」，但不越过失败事件：
          // 水位只到失败前一条，下一轮从失败处继续。
          const advanced = this.#cursors.advance(claim, {
            lastScannedSeq: lastScanned,
            scanIndex,
            ignoredSummary: JSON.stringify(this.#summariseIgnored(ignored)),
            ruleVersion: this.#ruleVersion,
            leaseMs: this.#leaseMs,
          })
          claim = advanced ?? null
        }
        if (claim) this.#cursors.release(claim)

        const result: RecoveryScanResult = {
          ok: failedSeq === null,
          status: failedSeq === null ? 'scanned' : 'failed',
          sessionRef: sessionId,
          targetSeq,
          scanned,
          captured,
          replayed,
          ignored: ignoredCount,
          failedSeq,
          reachedTarget,
          budgetHit,
          ...(error === undefined ? {} : { error }),
        }
        if (failedSeq === null) {
          this.#stats.scans += 1
          this.#stats.captured += captured
          this.#stats.replayed += replayed
          this.#stats.ignored += ignoredCount
        } else {
          this.#stats.failed += 1
          this.#stats.lastError = error ?? null
        }
        return result
      } finally {
        // 任何异常路径都不留活租约：release 不校验过期，失败最多是下次接管。
        if (claim) {
          try {
            this.#cursors.release(claim)
          } catch {
            // 释放失败不影响本次结论；过期后别的扫描器可以接管
          }
        }
      }
    } catch (error) {
      this.#stats.failed += 1
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      this.#stats.lastError = message
      this.#options.logger?.warn?.(`[psyche-recovery] 扫描失败：${message}`)
      return { ...base, ok: false, status: 'failed', error: message }
    } finally {
      if (handle) {
        try {
          await Promise.resolve(handle.close())
        } catch {
          // 关闭失败不影响扫描结论
        }
      }
    }
  }

  #scopeAllows(sessionId: string): boolean {
    const scope = this.#options.scope
    if (!scope.enabled) return false
    if (scope.excludeSessions && scope.excludeSessions.includes(sessionId)) return false
    if (scope.allowSessions && scope.allowSessions.length > 0 && !scope.allowSessions.includes(sessionId)) return false
    return true
  }

  #persistence(): PersistenceServiceLike | null {
    const injected = this.#options.persistence
    if (injected) return injected
    const service = this.#options.ctx?.get?.('sessionPersistence') as PersistenceServiceLike | undefined
    if (!service || typeof service.list !== 'function' || typeof service.open !== 'function') return null
    return service
  }

  async #readPage(handle: PersistenceHandleLike, offset: number): Promise<unknown> {
    return Promise.resolve(handle.read(offset, this.#pageSize))
  }

  /** 同一快照读一遍，取实际最大 seq；不做「长度 - 1」之类的下标推算。 */
  async #maxSeqOf(handle: PersistenceHandleLike): Promise<number> {
    let maxSeq = -1
    let offset = 0
    for (;;) {
      const events = eventsOf(await this.#readPage(handle, offset))
      if (events.length === 0) break
      for (const event of events) {
        const seq = typeof event?.seq === 'number' && Number.isFinite(event.seq) ? event.seq : null
        if (seq !== null && seq > maxSeq) maxSeq = seq
      }
      if (events.length < this.#pageSize) break
      offset += events.length
    }
    return maxSeq
  }

  /** `{ [ruleVersion]: { [reason]: count } }`：重放不重复累计。 */
  #summariseIgnored(ignored: Map<string, number>): Record<string, Record<string, number>> {
    if (ignored.size === 0) return {}
    const counts: Record<string, number> = {}
    for (const [reason, count] of ignored) counts[reason] = count
    return { [this.#ruleVersion]: counts }
  }
}
