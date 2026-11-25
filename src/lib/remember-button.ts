/**
 * 「记住这条」按钮的服务层。
 *
 * 设计稿：`docs/design/remember-button-v1.md` / v1.1。核心约束：
 * 1. 只接受 `sessionId + assistantMessageId`，身份与正文都不从客户端拿；
 * 2. 读会话事件定位 assistant 回复与其前面的真实 user 消息，配对 Capture 已写入的 Source；
 * 3. 纯规则提炼、零模型调用；
 * 4. 去重顺序：精确重复 → 否定冲突 → 高相似追加 → 新建；
 * 5. 写入固定 opId（`btn:<sessionId>:<assistantMessageId>`），重放返回首次结果。
 *
 * 这里不碰 HTTP/UI：路由与按钮只负责传两个 id 和展示 `action`。
 */

import type { Db, RuntimeInput } from 'dsh-psyche-core'

/** 一次按钮请求最多扫多少条会话事件（防大历史拖死一次点击）。 */
export const REMEMBER_MAX_SCAN = 50000
/** 长会话兜底：第一次扫描被截断且没找到目标时，放宽一次到这么多事件。 */
export const REMEMBER_FULL_SCAN = 200000
/** 提炼出的结论长度上限（字符）。 */
export const REMEMBER_MAX_STATEMENT = 120
/** 至少这么长的句子才值得记（字符，去空白）。 */
export const REMEMBER_MIN_STATEMENT = 8
/** 高相似判定：bigram Jaccard ≥ 0.8 视为同一条的补充。 */
export const REMEMBER_SIMILARITY = 0.8

export type RememberAction = 'created' | 'appended' | 'duplicate' | 'conflict'

export interface RememberButtonResult {
  ok: true
  action: RememberAction
  artifactId: string | null
  revision: number | null
  statement: string
}

export interface RememberPersistenceHandle {
  read(offset: number, length: number): unknown | Promise<unknown>
  close(): unknown | Promise<unknown>
}

export interface RememberPersistence {
  open(id: string, mode: 'read'): unknown | Promise<unknown>
}

export interface RememberSessionEvent {
  seq?: number
  time?: string
  type?: string
  /** `assistant/message` 用 data.message；`user/message` 的 data 本身就是消息（content/source/id 直接在 data 上）。 */
  data?: {
    message?: Record<string, unknown>
    content?: unknown
    source?: unknown
    id?: unknown
  } & Record<string, unknown>
}

export interface RememberCoreLike {
  remember(input: Record<string, unknown>): Promise<{ artifactId?: string; revision?: number } & Record<string, unknown>>
  appendEvidence(
    artifactId: string,
    input: Record<string, unknown>,
    scope?: { contactId?: string | null },
  ): Promise<{ artifactId?: string; revision?: number } & Record<string, unknown>>
  clash(input: Record<string, unknown>): Promise<Record<string, unknown>>
  /** 用户主动点按钮时的兜底采集：本地会话没开 capture 也不会卡在「来源未采集」。 */
  capture(input: Record<string, unknown>): Promise<Record<string, unknown>>
  db: Db
}

export interface RememberButtonDeps {
  core: () => Promise<RememberCoreLike>
  runtimeInputs: { read(sessionId: string): RuntimeInput | null }
  persistence: RememberPersistence | null
}

const SESSION_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/
const MESSAGE_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/

/** 明确失败：路由把它转成 4xx，前端只展示 message。 */
export class RememberButtonError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RememberButtonError'
    this.code = code
  }
}

/** 无 Contact 绑定、headless、群聊按钮禁用等：环境不支持，不是数据错误。 */
export class RememberUnsupportedError extends RememberButtonError {
  constructor(message = '这个会话没有可归属的联系人，不能把记忆挂到某个人名下') {
    super('E_UNSUPPORTED', message)
    this.name = 'RememberUnsupportedError'
  }
}

function requireId(value: unknown, pattern: RegExp, field: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || !pattern.test(text)) {
    throw new RememberButtonError('E_EMPTY_STATEMENT', `${field} 不合法`)
  }
  return text
}

/** 从 read() 的返回值里取事件数组；形状不对返回空数组，不抛。 */
function eventsOf(page: unknown): RememberSessionEvent[] {
  if (page === null || typeof page !== 'object') return []
  const events = (page as { events?: unknown }).events
  return Array.isArray(events) ? (events as RememberSessionEvent[]) : []
}

function messageOf(event: RememberSessionEvent): Record<string, unknown> | null {
  const message = event.data?.message
  return message !== null && typeof message === 'object' ? message : null
}

/**
 * `user/message` 的 data 本身就是 UserMessage（不带 `.message` 包一层），
 * 与 `assistant/message` 的结构不同——这一点踩过：按 assistant 的形状读 user
 * 永远读不到，按钮会报「前面没有找到真实用户消息」。
 */
function userMessageOf(event: RememberSessionEvent): Record<string, unknown> | null {
  const data = event.data
  if (data === null || typeof data !== 'object') return null
  if (Array.isArray(data.content) || typeof data.content === 'string') return data
  const nested = data.message
  return nested !== null && typeof nested === 'object' ? nested : null
}

/** 从后往前找与 assistantMessageId 匹配的 assistant/message 事件下标；找不到返回 -1。 */
function findAssistantIndex(events: RememberSessionEvent[], assistantMessageId: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const message = messageOf(event ?? {})
    if (event?.type !== 'assistant/message' || message === null) continue
    if (message.id === assistantMessageId) return index
  }
  return -1
}

/** 注入块不是用户说的话：source.psyche 由 Host 写入，正文不可伪造。 */
function isInjectionSource(source: unknown): boolean {
  if (source === null || typeof source !== 'object') return false
  const psyche = (source as { psyche?: unknown }).psyche
  if (psyche === null || typeof psyche !== 'object') return false
  return (psyche as { injection?: unknown }).injection === 'memory-context'
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block !== null && typeof block === 'object') {
      const typed = block as { type?: unknown; text?: unknown }
      if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
    }
  }
  return parts.join('\n').trim()
}

/** 去 markdown 标记与空白，保留句子。 */
export function cleanForStatement(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*+\d.\s]+/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** 寒暄/确认类短句：不单独成为一条记忆。 */
const FILLER = [
  '你好',
  '您好',
  '早上好',
  '晚上好',
  '晚安',
  '谢谢',
  '多谢',
  '感谢',
  '好的',
  '好呀',
  '收到',
  '明白',
  '了解',
  '没问题',
  '哈哈',
  '嗯',
  '哦',
  '行',
  '可以',
  '稍等',
]

export function isFillerSentence(text: string): boolean {
  const trimmed = text.trim().replace(/[，。！？、,.!?~\s]+$/u, '')
  if (trimmed.length === 0) return true
  if (trimmed.length <= 4) return true
  return FILLER.some((prefix) => trimmed === prefix || trimmed.startsWith(prefix))
}

/** 从一段文本里提炼一句可记的结论；提不出来返回 null。 */
export function extractStatement(text: string): string | null {
  const cleaned = cleanForStatement(text)
  if (cleaned.length === 0) return null
  const sentences = cleaned
    .split(/(?<=[。！？!?；;\n])/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
  for (const sentence of sentences) {
    const trimmed = sentence.replace(/^[，。！？、,.!?~\s]+/u, '').trim()
    if (isFillerSentence(trimmed)) continue
    const compact = trimmed.replace(/\s+/gu, '')
    if (compact.length < REMEMBER_MIN_STATEMENT) continue
    return trimmed.slice(0, REMEMBER_MAX_STATEMENT)
  }
  const fallback = cleaned.replace(/\s+/gu, '')
  if (fallback.length >= REMEMBER_MIN_STATEMENT) return cleaned.slice(0, REMEMBER_MAX_STATEMENT)
  return null
}

const BELIEF_HINTS = ['我觉得', '我认为', '建议', '最好', '偏好', '喜欢', '不喜欢', '在意', '讨厌']

/** 结论类型：偏好/观点句归 belief，其余默认 fact。 */
export function kindOf(statement: string): 'fact' | 'belief' {
  return BELIEF_HINTS.some((hint) => statement.includes(hint)) ? 'belief' : 'fact'
}

function bigrams(text: string): Set<string> {
  const compact = text.replace(/[\s，。！？、,.!?~"'“”‘’()（）]/gu, '')
  const grams = new Set<string>()
  for (let index = 0; index + 1 < compact.length; index += 1) {
    grams.add(compact.slice(index, index + 2))
  }
  return grams
}

/** bigram Jaccard；两条都太短时返回 0，避免「好的↔好呀」误判。 */
export function similarity(a: string, b: string): number {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const gram of left) if (right.has(gram)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

const NEGATION = /[不没无别未]|没有|不是|不要|不能|不会/u

/** 同主体且一正一负：视为矛盾，交给 clash 记录，不写进同一条结论。 */
export function looksContradictory(a: string, b: string): boolean {
  if (similarity(a, b) < 0.5) return false
  return NEGATION.test(a) !== NEGATION.test(b)
}

export interface RememberMessageInput {
  sessionId: string
  assistantMessageId: string
}

/**
 * 主流程：定位消息 → 配对 Source → 提炼 → 去重 → 写入。
 *
 * 抛错都是 `RememberButtonError`（带 code），不返回半截结果。
 */
export async function rememberAssistantMessage(
  deps: RememberButtonDeps,
  input: RememberMessageInput,
): Promise<RememberButtonResult> {
  const sessionId = requireId(input.sessionId, SESSION_PATTERN, 'sessionId')
  const assistantMessageId = requireId(input.assistantMessageId, MESSAGE_PATTERN, 'assistantMessageId')
  const binding = deps.runtimeInputs.read(sessionId)
  if (binding === null || binding.contactId === null || binding.contactId === undefined) {
    throw new RememberUnsupportedError()
  }
  if (binding.groupId !== null && binding.groupId !== undefined) {
    throw new RememberUnsupportedError('群聊里的回复不能挂到发送者的私聊记忆上')
  }
  if (deps.persistence === null) {
    throw new RememberUnsupportedError('当前宿主没有会话持久化服务，无法定位这条回复')
  }
  const handle = (await Promise.resolve(deps.persistence.open(sessionId, 'read'))) as RememberPersistenceHandle | null
  if (handle === null || typeof handle.read !== 'function') {
    throw new RememberUnsupportedError('读不到这个会话的记录')
  }
  let events: RememberSessionEvent[]
  try {
    events = eventsOf(await Promise.resolve(handle.read(0, REMEMBER_MAX_SCAN)))
    // 长会话（工具调用多、事件数以万计）第一次扫描可能被截断：目标回复在末尾，
    // 只读前 N 条永远找不到。找不到且恰好读满时放宽一次全量扫描。
    if (events.length >= REMEMBER_MAX_SCAN && findAssistantIndex(events, assistantMessageId) < 0) {
      events = eventsOf(await Promise.resolve(handle.read(0, REMEMBER_FULL_SCAN)))
    }
  } finally {
    try {
      await Promise.resolve(handle.close())
    } catch {
      // 读句柄关不掉不影响结果。
    }
  }
  const assistantIndex = findAssistantIndex(events, assistantMessageId)
  if (assistantIndex < 0) {
    const assistantEvents = events.filter((event) => event?.type === 'assistant/message')
    const recent = assistantEvents.slice(-3).map((event) => String(messageOf(event ?? {})?.id ?? '?'))
    const diagnostic = `events=${events.length}, assistant=${assistantEvents.length}, recent=${recent.join('|')}`
    console.warn(`[psyche][remember] 定位失败 session=${sessionId} id=${assistantMessageId} ${diagnostic}`)
    throw new RememberButtonError('E_NOT_FOUND', `找不到这条回复，可能已经被清理（${diagnostic}）`)
  }
  const assistantMessage = messageOf(events[assistantIndex]) ?? {}
  const assistantText = extractContentText(assistantMessage.content)
  let userEvent: RememberSessionEvent | null = null
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const message = userMessageOf(event)
    if (message === null) continue
    // 只有真正的人类输入才算；注入块、runtime-context、技能目录都不是。
    const source = message.source
    if (source !== null && typeof source === 'object' && (source as { kind?: unknown }).kind !== 'user') continue
    if (isInjectionSource(source)) continue
    if (extractContentText(message.content).length === 0) continue
    userEvent = event
    break
  }
  if (userEvent === null) {
    throw new RememberButtonError('E_NOT_FOUND', '这条回复前面没有找到真实用户消息')
  }
  const userMessage = userMessageOf(userEvent) ?? {}
  const userText = extractContentText(userMessage.content)
  const statement = extractStatement(assistantText) ?? extractStatement(userText)
  if (statement === null) {
    throw new RememberButtonError('E_EMPTY_STATEMENT', '这条回复里没有可提炼的陈述句')
  }
  // 按钮记录的是「用户说过什么」——这是关于用户的事实，不是 AI 自己的信念。
  // 用 belief 会把单轮证据（同活动窗口=1 个独立组）卡在门槛外，什么都落不下来；
  // 收窄成 fact 才符合 Core 的晋升规则（fact 1 条证据即可）。
  const kind = 'fact' as const
  const core = await deps.core()
  const db = core.db
  const captureKey = typeof userEvent.seq === 'number' ? String(userEvent.seq) : null
  if (captureKey === null) {
    throw new RememberButtonError('E_SOURCE_MISSING', '用户消息缺少序号，无法匹配已采集的来源')
  }
  let source = findSource(db, binding.platform, sessionId, captureKey)
  if (source === null) {
    // 用户点按钮本身就是「我要把这一条存下来」的明确动作：本地会话没开
    // capture 时，补采本轮 user 原文（`capture_key` 幂等，不会重复落库）。
    // 只补这一条，不打开全局采集，也不改 capture 开关。
    const channel = binding.groupId !== null && binding.groupId !== undefined ? 'group' : binding.platform === 'desktop' ? 'desktop' : 'private'
    try {
      await core.capture({
        platform: binding.platform,
        channel,
        origin: 'user',
        kind: 'message',
        text: userText,
        sessionRef: sessionId,
        captureKey,
        senderContactId: binding.contactId,
      })
    } catch (error) {
      console.warn('[psyche][remember] 补采失败', { sessionId, captureKey, error: String(error) })
    }
    source = findSource(db, binding.platform, sessionId, captureKey)
  }
  if (source === null) {
    throw new RememberButtonError('E_SOURCE_MISSING', '这条对话还没有被采集，先等一轮再点')
  }
  if (source.quarantined) {
    throw new RememberButtonError('E_SOURCE_QUARANTINED', '这条来源已被隔离，不能作为证据')
  }
  const opId = `btn:${sessionId}:${assistantMessageId}`
  // 去重只在「当前 Contact 自己可见」的结论里做：按钮写的是 restricted，FTS 的
  // public 检索看不到它——用同 Contact head 列表比较，既避免漏判也不会跨人。
  const existing = pickExisting(db, statement, binding.contactId)
  if (existing.type === 'duplicate') {
    return { ok: true, action: 'duplicate', artifactId: existing.artifactId, revision: existing.revision, statement }
  }
  if (existing.type === 'conflict') {
    await core.clash({
      targetId: existing.artifactId,
      text: `「${statement}」与已有结论「${existing.statement}」不一致`,
      statement,
      sourceIds: [source.sourceId],
      confidence: 'medium',
      opId,
    })
    return { ok: true, action: 'conflict', artifactId: existing.artifactId, revision: null, statement }
  }
  if (existing.type === 'appended') {
    const appended = await core.appendEvidence(
      existing.artifactId,
      { sourceIds: [source.sourceId], relation: 'supports', opId },
      { contactId: binding.contactId },
    )
    return {
      ok: true,
      action: 'appended',
      artifactId: existing.artifactId,
      revision: appended.revision ?? existing.revision,
      statement,
    }
  }
  const created = await core.remember({
    kind,
    statement,
    text: statement,
    sourceIds: [source.sourceId],
    subjectRefs: [binding.contactId],
    disclosure: 'restricted',
    eventType: 'conversation',
    opId,
  })
  return {
    ok: true,
    action: 'created',
    artifactId: created.artifactId ?? null,
    revision: created.revision ?? null,
    statement,
  }
}

interface SourceRow {
  sourceId: string
  quarantined: boolean
}

/** 精确配对：platform + session_ref + capture_key，任一不匹配都不算。 */
function findSource(db: Db, platform: string, sessionId: string, captureKey: string): SourceRow | null {
  const statement = db.prepare(
    `SELECT s.source_id AS source_id,
            CASE WHEN q.source_id IS NULL THEN 0 ELSE 1 END AS quarantined
       FROM sources s
       LEFT JOIN quarantined_sources q ON q.source_id = s.source_id
      WHERE s.platform = ? AND s.session_ref = ? AND s.capture_key = ?
      LIMIT 1`,
  )
  const row = statement.get(platform, sessionId, captureKey) as
    | { source_id?: unknown; quarantined?: unknown }
    | undefined
  if (row === undefined || typeof row.source_id !== 'string') return null
  return { sourceId: row.source_id, quarantined: Number(row.quarantined) === 1 }
}

interface ExistingHit {
  artifact_id: string
  revision: number
  statement: string
}

/**
 * 在「当前 Contact 自己可见」的结论里找同句 / 矛盾 / 高相似。
 *
 * 不用 `searchFts`：按钮写入的是 restricted，FTS 的公开检索看不到它，
 * 拿 FTS 做去重会永远判「新结论」。这里只读该 Contact 的 head，且不跨人。
 */
function pickExisting(
  db: Db,
  statement: string,
  contactId: string,
):
  | { type: 'duplicate' | 'appended' | 'conflict'; artifactId: string; revision: number; statement: string }
  | { type: 'new' } {
  const rows = db
    .prepare(
      `SELECT a.artifact_id AS artifact_id, r.revision AS revision, r.statement AS statement
         FROM artifacts a
         JOIN artifact_revisions r
           ON r.artifact_id = a.artifact_id
          AND r.revision = (SELECT MAX(r2.revision) FROM artifact_revisions r2 WHERE r2.artifact_id = a.artifact_id)
        WHERE r.state IN ('active', 'challenged')
          AND json_valid(r.subject_refs) = 1
          AND EXISTS (SELECT 1 FROM json_each(r.subject_refs) WHERE value = ?)
        ORDER BY r.updated_at DESC
        LIMIT 200`,
    )
    .all(contactId) as ExistingHit[]
  for (const head of rows) {
    const other = typeof head.statement === 'string' ? head.statement : ''
    if (other.length === 0) continue
    if (other.trim() === statement.trim()) {
      return { type: 'duplicate', artifactId: head.artifact_id, revision: head.revision, statement: other }
    }
    if (looksContradictory(statement, other)) {
      return { type: 'conflict', artifactId: head.artifact_id, revision: head.revision, statement: other }
    }
    if (similarity(statement, other) >= REMEMBER_SIMILARITY) {
      return { type: 'appended', artifactId: head.artifact_id, revision: head.revision, statement: other }
    }
  }
  return { type: 'new' }
}
