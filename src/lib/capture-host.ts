/**
 * P2-CAP-1b：DSH Session 事件的实时捕获器（Host 层，纯逻辑、可单测）。
 *
 * 位置：`session/event` 监听 → 类型过滤 → 归一化 → 有界队列 → 消费器 → `Core.capture()`。
 *
 * 三条边界（写在代码里，防止以后顺手加功能）：
 * 1. 只写 Source。这里不调 remember / clash / revise / review，不碰成长、关系、人格。
 * 2. `session/event` 是 Post-commit、fire-and-forget：监听器抛错不会回滚已提交的事件，
 *    也不保证 Source 一定写成。所以监听器只做同步过滤 + 轻量归一，真正的写入交给队列消费器。
 * 3. SQLite 驱动仍然是同步 API。这里的队列只控制积压与处理顺序，不是 Worker；
 *    不能说「数据库操作已经移出 Host 主线程」。
 *
 * 事件事实（D1-CAP-0 探针实测，见 docs/audit/d1-cap0-events.md）：
 * - 签名 `(session, event)`，event = `{ type, seq, time, data }`，seq 在会话内单调递增。
 * - `user/message` 的 data 就是 UserMessage；`data.source.kind` 区分 user / runtime-context / skill-catalog。
 * - `assistant/message` 的 data.message 才是消息，`source.kind` 应为 model；可能带 interrupted。
 * - `assistant/attempt` 是流式尝试，不是消息；tool/* 与 system/message 都不是对话。
 *
 * 为什么不把 `data.source?.kind === 'user'` 当成统一过滤条件：那样只捕用户输入，
 * 会漏掉心灵自己的回复——1b 要的是双向对话。
 */
/**
 * 捕获器只依赖「往 Core 递一条 Source」这一点，用本地最小类型而不是 Contract 类型：
 * 根包不额外依赖 contract 包，Host 层与契约解耦（契约仍由 Core 侧校验）。
 */
export interface CaptureInputLike {
  platform?: string
  channel?: string
  /** 这条消息属于哪个 Contact（QQ 私聊必须有，否则来源域解析成 unknown 直接不可见）。 */
  senderContactId?: string | null
  sessionRef?: string
  captureKey?: string | null
  messageId?: string | null
  origin?: string
  kind?: string
  text?: string | null
  at?: string
  metadata?: Record<string, unknown>
}

/** DSH 会话在 sources.platform / channel 上的取值。 */
export const DSH_PLATFORM = 'dsh-session'
export const DSH_CHANNEL = 'desktop'

/**
 * 会话 id 决定来源域：`qq-private-<id>` 是 QQ 私聊、`qq-group-<id>` 是 QQ 群。
 * 以前这里写死 dsh-session/desktop，结果 QQ 消息被记成 desktop personal 域，
 * 跨渠道可见——来源域准入看着生效、实际失效。
 */
export function sourceChannelOfSession(sessionId: string): { platform: string; channel: string } {
  if (sessionId.startsWith('qq-private-')) return { platform: 'qq', channel: 'private' }
  if (sessionId.startsWith('qq-group-')) return { platform: 'qq', channel: 'group' }
  return { platform: DSH_PLATFORM, channel: DSH_CHANNEL }
}

/** 捕获器只依赖宿主会话对象里真正用到的字段，避免把 DSH 类型带进 Core。 */
export interface SessionLike {
  id?: string
}

export interface SessionEventLike {
  type?: string
  seq?: number
  time?: string | number
  data?: unknown
}

/** 消费器接口：只要「能 capture」这一件事，测试里用 mock 替身即可。 */
export interface CaptureSink {
  capture(input: CaptureInputLike): Promise<{ replayed?: boolean; sourceId?: string } | void>
}

/** 一条通过过滤、准备入队的会话消息。 */
export interface NormalizedCapture {
  input: CaptureInputLike
  /** 来源角色（用于日志与测试断言，不写进库的独立字段）。 */
  role: 'user' | 'assistant'
  interrupted: boolean
}

export interface CaptureScope {
  enabled: boolean
  allowSessions?: string[]
  excludeSessions?: string[]
}

export interface CaptureHostOptions {
  sink: CaptureSink
  scope: CaptureScope
  /** 队列上限：满了记 overflow + dropped，不静默丢。 */
  maxQueue?: number
  /** 单条正文上限（字符），超出截断。 */
  maxText?: number
  /** 会话 → 可信 Contact 的只读查询（Host 绑定），用于给 Source 落 senderContactId。 */
  resolveSender?: (sessionId: string) => string | null
  logger?: { debug?(message: string): void; warn?(message: string): void }
}

export interface CaptureHostStats {
  /** 收到的原始事件数（含被过滤掉的）。 */
  received: number
  /** 通过过滤、进入队列的条数。 */
  enqueued: number
  /** 被过滤掉或范围不允许的条数。 */
  skipped: number
  /** 消费成功的条数（含重放）。 */
  captured: number
  /** 其中命中幂等、拿到原 Source 的条数。 */
  replayed: number
  /** 消费失败的条数（已记录，不自动重试——1c 再做失败保留与补采）。 */
  failed: number
  /** 因队列满被丢弃的条数（overflow=true 时）。 */
  dropped: number
  overflow: boolean
  lastError: string | null
  queueLength: number
  stopped: boolean
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|pk|ghp|gho|ghu|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{16,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
]

/** 明显是密钥/私钥/令牌的正文不落库（普通个人信息不算秘密，不在这里拦）。 */
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text))
}

/** 这些块的 text 是模型内部过程，不是用户看到的回复，不能落成 Source 正文。 */
const HIDDEN_BLOCK_TYPES = new Set([
  'reasoning',
  'thinking',
  'analysis',
  'redacted_thinking',
  'tool_use',
  'tool_call',
  'toolCall',
  'tool_result',
  'toolResult',
])

/** 从消息 content（字符串 / 文本块数组 / 带 text 的对象）里取最终可见文本。 */
export function extractText(content: unknown): string | null {
  if (typeof content === 'string') {
    const text = content.trim()
    return text || null
  }
  if (Array.isArray(content)) {
    const visible: string[] = []
    const others: string[] = []
    for (const part of content) {
      if (typeof part === 'string') {
        visible.push(part)
        continue
      }
      if (!part || typeof part !== 'object') continue
      const item = part as Record<string, unknown>
      if (typeof item.text !== 'string') continue
      const blockType = typeof item.type === 'string' ? item.type : ''
      if (HIDDEN_BLOCK_TYPES.has(blockType)) continue
      if (blockType === 'text' || blockType === 'markdown') visible.push(item.text)
      else others.push(item.text)
    }
    // 有明确的 text/markdown 块时只取这些：assistant 消息里常混着 reasoning，
    // 把它当正文会把模型的内心话写进「她说过的话」。
    const chosen = visible.length > 0 ? visible : others
    const text = chosen.join('\n').trim()
    return text || null
  }
  if (content && typeof content === 'object') {
    const item = content as Record<string, unknown>
    const blockType = typeof item.type === 'string' ? item.type : ''
    if (HIDDEN_BLOCK_TYPES.has(blockType)) return null
    if (typeof item.text === 'string') {
      const text = item.text.trim()
      return text || null
    }
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function truncate(text: string, maxText: number): string {
  if (text.length <= maxText) return text
  return `${text.slice(0, maxText - 1)}…`
}

/**
 * 把一条 Session 事件归一成「是否可捕获的对话」；返回 null 表示这条事件不该被捕获。
 *
 * 三个入口（实时 `CaptureHost`、Ghost 补采、Recovery Scanner）必须共用这个函数，
 * 否则 reasoning 过滤、密钥过滤、块选择各写一套，迟早漂移出两种「正文」。
 *
 * 过滤表（与 §23.0 的 1b 表一致）：
 * - user/message + source.kind='user' → 捕获（origin=user, kind=message）
 * - user/message 其他 source.kind → 忽略（注入上下文、技能文件、目标延续消息）
 * - assistant/message + data.message.source.kind='model' → 捕获（origin=self, kind=model）
 * - assistant/message 其他来源 → 忽略
 * - assistant/attempt、tool/*、system/message、developer/message、未知类型 → 忽略
 */
export interface ClassifiedSessionEvent {
  role: 'user' | 'assistant'
  text: string
  interrupted: boolean
  messageId: string | null
  /** 可信桥接随消息带来的非正文元数据（当前只有 QQ 媒体类型/数量）。 */
  metadata?: Record<string, unknown>
}

/**
 * Psyche 自己的 pre-step 注入消息：role 仍是 user、`source.kind` 仍是 user
 * （Provider 需要 user 语义），靠 `source.psyche` 标记（R6-CAP-2 起）或旧版
 * `msg_psyche_` id 前缀识别。
 *
 * 不能用正文里的 `<memory-context>` 判断——正文可以被任意插件伪造；而这个判断
 * 的结果只是「不采集」，伪造标记不会获得任何特权，只会让第三方自己的消息也
 * 不进记忆。采集注入块则会把系统生成的记忆提示当成用户提供的事实，形成
 * Runtime Injection → Source → Event 的自证环，QQ 接入后会跨渠道扩散。
 */
const CAPTURED_MEDIA_TYPES = new Set([
  'image', 'mface', 'face', 'record', 'video', 'file', 'forward', 'json', 'xml', 'dice', 'rps', 'shake', 'poke',
])

/**
 * 桥接可能把媒体类型/数量挂在 `source.psyche.media`。只接受白名单类型与 1..99 的计数，
 * 任何文件名、URL、路径都不会从这里进入库。
 */
function mediaSummaryFromSource(source: Record<string, unknown> | null): Array<{ type: string; count: number }> | undefined {
  const psyche = asRecord(source?.psyche)
  if (!psyche || !Array.isArray(psyche.media)) return undefined
  const summary: Array<{ type: string; count: number }> = []
  for (const item of psyche.media.slice(0, 8)) {
    const record = asRecord(item)
    const type = typeof record?.type === 'string' ? record.type : ''
    const count = typeof record?.count === 'number' ? Math.floor(record.count) : 0
    if (!CAPTURED_MEDIA_TYPES.has(type) || count < 1 || count > 99) continue
    const found = summary.find((entry) => entry.type === type)
    if (found) found.count = Math.min(99, found.count + count)
    else summary.push({ type, count })
  }
  return summary.length > 0 ? summary : undefined
}

function isInjectionMessage(
  data: Record<string, unknown>,
  source: Record<string, unknown> | null,
): boolean {
  // M06：只读识别旧 Lingban 注入标记，用来排除历史会话里的注入块；
  // 它不被当作可信 Psyche 注入证明，也不恢复旧工具/服务/接口。
  const marker = asRecord(source?.psyche) ?? asRecord(source?.lingban)
  if (marker !== null && marker.injection === 'memory-context') return true
  const id = typeof data.id === 'string' ? data.id : null
  return id !== null && (id.startsWith('msg_psyche_') || id.startsWith('msg_lingban_'))
}

export function classifySessionEvent(
  event: SessionEventLike | null | undefined,
  options: { maxText?: number } = {},
): ClassifiedSessionEvent | null {
  const type = typeof event?.type === 'string' ? event.type : ''
  if (type !== 'user/message' && type !== 'assistant/message') return null

  const data = asRecord(event?.data)
  if (!data) return null

  const maxText = options.maxText ?? 8000

  if (type === 'user/message') {
    const source = asRecord(data.source)
    const sourceKind = typeof source?.kind === 'string' ? source.kind : null
    // 只有真正的人类输入才是经历；runtime-context / skill-catalog 是系统注入。
    if (sourceKind !== 'user') return null
    // R6-CAP-2：Psyche 自己的注入消息同样带 source.kind='user'，单独排除。
    if (isInjectionMessage(data, source)) return null
    const text = extractText(data.content)
    if (!text || looksSecret(text)) return null
    const media = mediaSummaryFromSource(source)
    return {
      role: 'user',
      text: truncate(text, maxText),
      interrupted: false,
      messageId: typeof data.id === 'string' ? data.id : null,
      ...(media ? { metadata: { media } } : {}),
    }
  }

  const message = asRecord(data.message)
  if (!message) return null
  const messageSource = asRecord(message.source) ?? asRecord(data.source)
  const messageKind = typeof messageSource?.kind === 'string' ? messageSource.kind : null
  // assistant/message 里只有真正提交到消息表面的模型回复才算对话；
  // attempt 不是消息、工具结果也不是（它们在别的 type 上，这里再兜一层 source）。
  if (messageKind !== 'model') return null
  const text = extractText(message.content)
  if (!text || looksSecret(text)) return null
  return {
    role: 'assistant',
    text: truncate(text, maxText),
    interrupted: data.interrupted === true || message.interrupted === true,
    messageId: typeof message.id === 'string' ? message.id : null,
  }
}

/** 在 classify 之上补 session / seq / 时间，组装成 `Core.capture()` 的入参。 */
export function normalizeSessionEvent(
  session: SessionLike | null | undefined,
  event: SessionEventLike | null | undefined,
  options: {
    maxText?: number
    /** 从 Host 的可信绑定里取这条会话属于哪个 Contact；取不到就写 null。 */
    resolveSender?: (sessionId: string) => string | null
  } = {},
): NormalizedCapture | null {
  const sessionId = typeof session?.id === 'string' ? session.id.trim() : ''
  if (!sessionId) return null

  const classified = classifySessionEvent(event, options)
  if (!classified) return null

  const seq = typeof event?.seq === 'number' && Number.isFinite(event.seq) ? event.seq : null
  // captureKey 用 seq，不用正文 Hash：同一个人在别的轮次完全可能说同一句话。
  const captureKey = seq === null ? null : String(seq)
  const at = typeof event?.time === 'string' ? event.time : new Date().toISOString()
  // role 由 classify 决定，origin/kind 只在这里映射一次，避免两个入口给不同值。
  const isUser = classified.role === 'user'
  const source = sourceChannelOfSession(sessionId)
  return {
    role: classified.role,
    interrupted: classified.interrupted,
    input: {
      platform: source.platform,
      channel: source.channel,
      senderContactId: options.resolveSender?.(sessionId) ?? null,
      sessionRef: sessionId,
      captureKey,
      messageId: classified.messageId,
      origin: isUser ? 'user' : 'self',
      kind: isUser ? 'message' : 'model',
      text: classified.text,
      at,
      metadata: {
        dsh: { sessionId, seq, role: classified.role, ...(isUser ? {} : { interrupted: classified.interrupted }) },
        ...(classified.metadata ?? {}),
      },
    },
  }
}

/**
 * 有界异步队列 + 串行消费器。
 *
 * 生命周期：`handle()` 只入队，`#pump()` 串行消费；`stop()` 停止接收，`drain()` 排空。
 * 队列满时记 dropped/overflow，不静默丢；消费失败记 failed/lastError（1c 再做持久化重试）。
 */
export class CaptureHost {
  #options: CaptureHostOptions
  #queue: CaptureInputLike[] = []
  #running = false
  #stopped = false
  #stats = {
    received: 0,
    enqueued: 0,
    skipped: 0,
    captured: 0,
    replayed: 0,
    failed: 0,
    dropped: 0,
    overflow: false,
    lastError: null as string | null,
  }

  constructor(options: CaptureHostOptions) {
    this.#options = options
  }

  /** 同步入口：监听器里只做过滤 + 入队，await 发生在消费器里。 */
  handle(session: SessionLike | null | undefined, event: SessionEventLike | null | undefined): void {
    if (this.#stopped) return
    this.#stats.received += 1
    if (!this.#scopeAllows(session)) {
      this.#stats.skipped += 1
      return
    }
    const normalized = normalizeSessionEvent(session, event, {
      maxText: this.#options.maxText,
      ...(this.#options.resolveSender ? { resolveSender: this.#options.resolveSender } : {}),
    })
    if (!normalized) {
      this.#stats.skipped += 1
      return
    }
    const maxQueue = this.#options.maxQueue ?? 200
    if (this.#queue.length >= maxQueue) {
      this.#stats.dropped += 1
      this.#stats.overflow = true
      this.#stats.lastError = `捕获队列已满（${maxQueue}），丢弃了 ${this.#stats.dropped} 条`
      this.#options.logger?.warn?.(`[psyche] ${this.#stats.lastError}`)
      return
    }
    this.#queue.push(normalized.input)
    this.#stats.enqueued += 1
    void this.#pump()
  }

  /** 停止接收新事件（卸载第一步）。 */
  stop(): void {
    this.#stopped = true
  }

  /** 等待队列排空（卸载第二步、测试收尾用）。 */
  async drain(): Promise<void> {
    if (!this.#running && this.#queue.length > 0) await this.#pump()
    while (this.#running) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  stats(): CaptureHostStats {
    return {
      ...this.#stats,
      queueLength: this.#queue.length,
      stopped: this.#stopped,
    }
  }

  #scopeAllows(session: SessionLike | null | undefined): boolean {
    const scope = this.#options.scope
    if (!scope.enabled) return false
    const id = typeof session?.id === 'string' ? session.id : ''
    if (!id) return false
    if (scope.excludeSessions?.includes(id)) return false
    if (scope.allowSessions && scope.allowSessions.length > 0) return scope.allowSessions.includes(id)
    return true
  }

  async #pump(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      while (this.#queue.length > 0) {
        const input = this.#queue.shift()
        if (!input) break
        try {
          const result = await this.#options.sink.capture(input)
          this.#stats.captured += 1
          if (result && typeof result === 'object' && result.replayed === true) {
            this.#stats.replayed += 1
          }
        } catch (error) {
          this.#stats.failed += 1
          this.#stats.lastError = error instanceof Error ? error.message : String(error)
          this.#options.logger?.warn?.(
            `[psyche] 捕获失败（${input.captureKey ?? '无幂等键'}）：${this.#stats.lastError}`,
          )
        }
      }
    } finally {
      this.#running = false
    }
  }
}
