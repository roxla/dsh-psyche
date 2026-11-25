/**
 * Q5-F：把「日常原话召回」从 Composer 挪到 `agent/pre-step`。
 *
 * 为什么要挪：Composer 拿不到本轮用户问题。`ProjectionAssembly` 只有
 * `agent.id` / `agent.session.id`，宿主 `SessionSurface` 只给 `nodes` 序号、
 * 不给正文，于是 `buildConversationRecall()` 只能走「取最近一轮」兜底，
 * 结果把「别人问过同一句话 + 答不知道」顶进了提示（第 28–32 轮真机证据）。
 *
 * pre-step 是唯一同时具备两样东西的位置：
 *   1. `payload.messages` —— 本轮新增输入（时序探针实测：跨轮只带本轮、
 *      工具后续 step 为空数组）；
 *   2. `decision.messages` —— 即将提交给模型的完整消息列表（可以摘旧块）。
 *
 * 但 `role === 'user'` 不等于「用户说的话」：时序探针实测三种 kind
 * （`user` / `agent-message` / `subagent-settled`）role 全是 user。
 * 因此这里先判接收者、再按 `source.kind === 'user'` 取正文，
 * 拿不到唯一可归属的输入就不要猜。
 */

/** 注入块的来源标记；摘旧块时只认它，不看正文（正文可被复制或伪造）。 */
export const RECALL_INJECTION = 'conversation-recall'

/** 注入消息 id 前缀，与记忆注入块保持同一命名习惯。 */
export const RECALL_MESSAGE_PREFIX = 'msg_psyche_recall_'

export type RecallQueryStatus =
  /** 拿到唯一可归属的本轮用户输入。 */
  | 'ok'
  /** 接收者是委派会话：即使带 kind=user 也不能读主人日常记忆。 */
  | 'delegated'
  /** 接收者身份未经验证：宁可这次不查，也不要把不该给的内容递出去。 */
  | 'receiver-unverified'
  /** 本轮只有工具/代理事件，没有真人输入。 */
  | 'no-user-input'
  /** 有候选，但不止一条、无法唯一定位。 */
  | 'current-user-message-unresolved'

export type RecallQueryMode = 'none' | 'continue' | 'specific'

export interface RecallQuery {
  status: RecallQueryStatus
  /** 仅 status === 'ok' 时非空。 */
  query: string | null
  /** 命中消息的宿主 id（便于与回执对照）。 */
  messageId: string | null
  queryMode: RecallQueryMode
}

const CONTINUE_INTENT = /接着|上次|继续|然后|刚才|之前说|还没说完|说到哪/

/** 从 DSH 消息的 content 里取纯文本；跳过非文本 part。 */
export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part)
      continue
    }
    if (part !== null && typeof part === 'object') {
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n').trim()
}

interface RawMessage {
  id?: unknown
  role?: unknown
  source?: unknown
  content?: unknown
}

export function sourceKindOf(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return null
  const source = (raw as RawMessage).source
  if (source === null || typeof source !== 'object') return null
  const kind = (source as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : null
}

function idOf(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return null
  const id = (raw as RawMessage).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * 判定这一轮该不该查、拿什么查。
 *
 * 顺序是有意为之，而且**默认可读范围是空**：
 *
 * 1. **先判委派**。子代理收到的那条也是 `kind='user'`（父代理 send_message
 *    发过去的），单看 kind 会把它当成主人发问，从而让委派会话读到主人的
 *    日常原话。
 * 2. **再判身份是否已验证**。这一条是 fail-closed 的兜底：`Agent` 上没有
 *    `meta`、`RuntimeInputStore.readForAgent()` 对桌面主会话与子代理都返回
 *    null——两点决定了「这个会话是不是有权限读主人记忆」在当前版本里
 *    **没有可信判据**。判不出来就不查，而不是默认放行。
 *    （第 35 轮真实宿主回执抓到过反例：子代理被当成 desktop 主会话，
 *    召回到了另一个项目的会话来源。）
 * 3. 只有在接收者身份已验证、且委派信号明确为否时，才进入正文提取。
 */
export function delegationOfAgent(agent: unknown): boolean | null {
  const session = (agent as { session?: { header?: unknown } } | null | undefined)?.session
  const header = session?.header as
    | { delegationDepth?: unknown; origin?: unknown }
    | null
    | undefined
  if (header === null || header === undefined) return null
  // 宿主把委派深度持久化在 header 里：顶层会话缺席（＝0），子代理为父深度 + 1。
  // `@deepseek-ai/dsh-session` 的 `SessionHeader.delegationDepth` 注释原文：
  // 「Delegation depth: absent (zero) for a top-level session, parent depth + 1
  //  for a subagent child. Persisted so a recursion budget survives restart and resume.」
  if (typeof header.delegationDepth === 'number') return header.delegationDepth > 0
  // 退一步用展示用分类；注释明说它「不是可继续性的证明」，所以只作否定信号用。
  if (header.origin === 'subagent') return true
  // header 在、两个字段都没有：这是顶层会话，不是「判不出」。
  return false
}

export function extractRecallQuery(input: {
  messages: unknown[] | undefined
  delegated: boolean | null
  /** 宿主是否已经可信地确认过这个接收者的身份与渠道（`delegated !== null` 即可信）。 */
  receiverVerified: boolean
}): RecallQuery {
  if (input.delegated === null) {
    return { status: 'receiver-unverified', query: null, messageId: null, queryMode: 'none' }
  }
  if (input.delegated) {
    return { status: 'delegated', query: null, messageId: null, queryMode: 'none' }
  }
  if (!input.receiverVerified) {
    return { status: 'receiver-unverified', query: null, messageId: null, queryMode: 'none' }
  }
  const messages = Array.isArray(input.messages) ? input.messages : []
  const candidates = messages.filter((raw) => sourceKindOf(raw) === 'user')
  if (candidates.length === 0) {
    return { status: 'no-user-input', query: null, messageId: null, queryMode: 'none' }
  }
  if (candidates.length > 1) {
    // 有候选但无法唯一定位：宁可这次不查，也不要固定取第一条去猜。
    return {
      status: 'current-user-message-unresolved',
      query: null,
      messageId: null,
      queryMode: 'none',
    }
  }
  const only = candidates[0]
  const text = textOfContent((only as RawMessage).content)
  if (text.length === 0) {
    return { status: 'no-user-input', query: null, messageId: idOf(only), queryMode: 'none' }
  }
  return {
    status: 'ok',
    query: text,
    messageId: idOf(only),
    queryMode: CONTINUE_INTENT.test(text) ? 'continue' : 'specific',
  }
}

/** 摘掉历史里的旧召回块（含本次要重写的那一块）。 */
export function stripRecallBlocks(messages: unknown[]): unknown[] {
  return messages.filter((raw) => {
    const id = idOf(raw)
    if (id !== null && id.startsWith(RECALL_MESSAGE_PREFIX)) return false
    if (raw === null || typeof raw !== 'object') return true
    const source = (raw as RawMessage).source
    if (source === null || typeof source !== 'object') return true
    const marker = (source as { psyche?: unknown }).psyche
    if (marker === null || typeof marker !== 'object') return true
    return (marker as { injection?: unknown }).injection !== RECALL_INJECTION
  })
}

/**
 * 造一条召回注入块。
 *
 * 与记忆注入块同形：`role:'user'` 让 Provider 看到正文，
 * `source.kind` 不是 `'user'` 让聊天投影把它渲染成可折叠的上下文行，
 * 而不是冒充用户说的话。
 */
export function buildRecallMessage(input: {
  text: string
  sourceIds: string[]
  sessionRef: string | null
  id: string
}): unknown {
  return {
    id: `${RECALL_MESSAGE_PREFIX}${input.id}`,
    role: 'user',
    content: [{ type: 'text', text: input.text }],
    source: {
      kind: 'psyche-memory',
      form: 'notice',
      summary: `日常对话召回 · ${input.sourceIds.length} 条来源`,
      psyche: {
        injection: RECALL_INJECTION,
        sourceIds: input.sourceIds,
        sessionRef: input.sessionRef,
      },
    },
  }
}
