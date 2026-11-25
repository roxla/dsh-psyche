// P3-A B2：每轮用户文本缓冲（宿主内存，不落盘、不进日志、不写库）。
//
// 只收集 pre-step 里 `source.kind === 'user'` 的真实用户消息；
// 按 `(sessionId, turn)` 分桶，`agent/turn-stopping` 取走即清空。
// 外部插件注入（source.kind === 'plugin'）、system / runtime-context、
// **psyche 自己的记忆注入**（source.kind 仍是 user，靠 source.psyche 标记或
// `msg_psyche_` id 前缀排除，与 CaptureHost 的 R6-CAP-2 同一判定）、
// assistant 消息一律不收。
//
// 有界：会话数 / 每会话轮数 / 单轮字符数都有上限，满了按插入顺序淘汰旧桶，
// 不做无界增长，也不因为溢出而抛错。
const USER_KIND = 'user'

export interface MoodTurnBufferOptions {
  /** 单轮参与判定的正文上限（字符），默认 4000。 */
  maxText?: number
  /** 同时保留的会话上限，默认 64。 */
  maxSessions?: number
  /** 每个会话保留的轮数上限，默认 4。 */
  maxTurnsPerSession?: number
  /** 逗号分隔的会话 id 排除表；命中则不收集。 */
  excludeSessions?: string
  /** 轮首固化的规则版本；缺省时下游按当前 MOOD_RULES_VERSION 处理。 */
  configVersion?: number
}

export interface MoodTurnText {
  sessionId: string
  turn: number
  texts: string[]
  /** 与 texts 对齐的消息 id（DSH message.id；缺失时为空串）。 */
  evidenceIds: string[]
  /** 轮首固化的来源；本缓冲只收真实用户消息，所以恒为 user。 */
  initiator: 'user'
  /** 轮首固化的规则版本（之后改规则不回溯已完成轮次）。 */
  configVersion: number | undefined
  userMessageCount: number
}

interface Bucket {
  turn: number
  texts: string[]
  ids: string[]
  userMessages: number
  configVersion: number | undefined
}

interface SessionBucket {
  turns: Map<number, Bucket>
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.floor(numeric)))
}

function csvSet(value: string | undefined): Set<string> {
  const out = new Set<string>()
  for (const item of String(value ?? '').split(',')) {
    const id = item.trim()
    if (id !== '') out.add(id)
  }
  return out
}

/** 从 DSH 的 UserMessage.content 里抽文本；跳过 reasoning / tool_* 等非正文块。 */
export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    const type = typeof record.type === 'string' ? record.type : ''
    if (type !== '' && type !== 'text') continue
    if (typeof record.text === 'string') parts.push(record.text)
    else if (typeof record.content === 'string') parts.push(record.content)
  }
  return parts.join('\n')
}

export interface MoodMessageLike {
  id?: string
  source?: { kind?: string; psyche?: unknown } | null
  content?: unknown
}

export interface MoodUserEntry {
  id: string
  text: string
}

/**
 * Psyche 自己的 pre-step 注入消息同样带 source.kind='user'（Provider 要 user 语义），
 * 靠 source.psyche.injection === 'memory-context' 或旧版 `msg_psyche_` id 前缀排除。
 * 与 CaptureHost.isInjectionMessage 保持同一判定：正文里的 `<memory-context>` 不可信。
 */
function isInjectionMessage(record: MoodMessageLike): boolean {
  const marker = record.source?.psyche
  if (marker !== null && typeof marker === 'object') {
    const injection = (marker as { injection?: unknown }).injection
    if (injection === 'memory-context') return true
  }
  const id = typeof record.id === 'string' ? record.id : ''
  return id.startsWith('msg_psyche_')
}

/**
 * 从一批消息里挑出真实用户消息（文本 + id）。
 * 只认 `source.kind === 'user'`——这是宿主的分类，不看 role、不看内容；
 * 再排除 psyche 自己的注入消息。
 */
export function userEntriesOf(messages: readonly unknown[] | undefined): MoodUserEntry[] {
  if (!Array.isArray(messages)) return []
  const out: MoodUserEntry[] = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const record = message as MoodMessageLike
    if (record.source?.kind !== USER_KIND) continue
    if (isInjectionMessage(record)) continue
    const text = textOfContent(record.content).trim()
    if (text === '') continue
    const id = typeof record.id === 'string' ? record.id.trim().slice(0, 200) : ''
    out.push({ id, text })
  }
  return out
}

/** 兼容旧调用：只要文本。 */
export function userTextsOf(messages: readonly unknown[] | undefined): string[] {
  return userEntriesOf(messages).map((entry) => entry.text)
}

export class MoodTurnBuffer {
  readonly #maxText: number
  readonly #maxSessions: number
  readonly #maxTurnsPerSession: number
  readonly #excluded: Set<string>
  readonly #configVersion: number | undefined
  readonly #sessions = new Map<string, SessionBucket>()

  constructor(options: MoodTurnBufferOptions = {}) {
    this.#maxText = clampInt(options.maxText, 4000, 100, 20000)
    this.#maxSessions = clampInt(options.maxSessions, 64, 1, 512)
    this.#maxTurnsPerSession = clampInt(options.maxTurnsPerSession, 4, 1, 32)
    this.#excluded = csvSet(options.excludeSessions)
    this.#configVersion = Number.isFinite(options.configVersion) ? Number(options.configVersion) : undefined
  }

  get size(): number {
    return this.#sessions.size
  }

  /** 当前会话里已收的轮数（诊断/测试用）。 */
  turnsOf(sessionId: string): number[] {
    const session = this.#sessions.get(sessionId)
    return session ? [...session.turns.keys()] : []
  }

  /** 当前轮已收的字符数（诊断/测试用）。 */
  charsOf(sessionId: string, turn: number): number {
    return this.#sessions.get(sessionId)?.turns.get(turn)?.texts.join('\n').length ?? 0
  }

  /**
   * 收集一批已进入本轮的 claimed 消息。
   * 返回 false 表示没有可收集内容（被排除 / 无真实用户消息 / 非法入参）。
   */
  record(sessionId: string, turn: number, messages: readonly unknown[] | undefined): boolean {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
    const turnNo = Number(turn)
    if (sid === '' || !Number.isInteger(turnNo) || turnNo < 1) return false
    if (this.#excluded.has(sid)) return false
    const fresh = userEntriesOf(messages)
    if (fresh.length === 0) return false

    let session = this.#sessions.get(sid)
    if (session === undefined) {
      session = { turns: new Map() }
      this.#sessions.set(sid, session)
      // 淘汰最老的会话（Map 保持插入顺序）。
      while (this.#sessions.size > this.#maxSessions) {
        const oldest = this.#sessions.keys().next()
        if (oldest.done === true) break
        this.#sessions.delete(oldest.value)
      }
    }

    let bucket = session.turns.get(turnNo)
    if (bucket === undefined) {
      bucket = {
        turn: turnNo,
        texts: [],
        ids: [],
        userMessages: 0,
        configVersion: this.#configVersion,
      }
      session.turns.set(turnNo, bucket)
      while (session.turns.size > this.#maxTurnsPerSession) {
        const oldest = session.turns.keys().next()
        if (oldest.done === true) break
        session.turns.delete(oldest.value)
      }
    }
    bucket.userMessages += fresh.length
    for (const entry of fresh) {
      bucket.texts.push(entry.text)
      bucket.ids.push(entry.id)
    }
    // 超预算时保留最近的部分（用户刚说的话优先级更高），id 与文本一起裁剪。
    const joined = bucket.texts.join('\n')
    if (joined.length > this.#maxText) {
      const texts: string[] = []
      const ids: string[] = []
      let budget = this.#maxText
      for (let index = bucket.texts.length - 1; index >= 0 && budget > 0; index -= 1) {
        const text = bucket.texts[index]
        const id = bucket.ids[index] ?? ''
        if (text.length + 1 > budget) {
          texts.unshift(text.slice(text.length - budget))
          ids.unshift(id)
          break
        }
        texts.unshift(text)
        ids.unshift(id)
        budget -= text.length + 1
      }
      bucket.texts = texts
      bucket.ids = ids
    }
    return true
  }

  /** 取走某一轮的文本并清空该轮；没有内容返回 null。 */
  take(sessionId: string, turn: number): MoodTurnText | null {
    const session = this.#sessions.get(sessionId)
    if (session === undefined) return null
    const bucket = session.turns.get(turn)
    if (bucket === undefined) return null
    session.turns.delete(turn)
    if (session.turns.size === 0) this.#sessions.delete(sessionId)
    if (bucket.texts.length === 0) return null
    return {
      sessionId,
      turn,
      texts: [...bucket.texts],
      evidenceIds: [...bucket.ids],
      initiator: 'user',
      configVersion: bucket.configVersion,
      userMessageCount: bucket.userMessages,
    }
  }

  /** 会话销毁时清掉它的全部缓冲。 */
  dropSession(sessionId: string): void {
    this.#sessions.delete(sessionId)
  }

  clear(): void {
    this.#sessions.clear()
  }
}
