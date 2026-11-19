// P3-B-3：把关系投影注入成独立的 Prompt Context（`psyche-relationship`）。
//
// 机制：`systemPrompt.context()` 的 provider 每次装配都会收到 `AssembleContext`，
// 而 `@deepseek-ai/dsh-agent` 给这个类型补了 `agent?: Agent`（runtime-types.d.ts:15-18），
// 所以 provider 能拿到「当前 Agent」，再用 RuntimeInputStore 的可信绑定解析 Contact。
//
// 为什么不用 `agent/pre-step`：pre-step 的 messages 只有本轮新消息（实测 1 条），
// 追加进去的块会随会话历史永久累积（实测第 2/3 轮出现 2/3 份旧关系块）。
// Context 由宿主按快照替换（`renderContextSnapshot`），天然不累积。
//
// 契约：只对 QQ 私聊的可信 Contact 注入；每轮重新解析；只读；失败返回空串不阻断；
// 输出只有档位词，不含 contact_id、数值、证据、计数或内部 key。

import { projectRelationshipBrief, type RelationshipBrief } from './relationship-projection.js'

/** Prompt Context 名：与记忆、语气块各自独立。 */
export const RELATIONSHIP_CONTEXT_NAME = 'psyche-relationship'
/** 排在语气块（100）之前，仅影响 Context 内部顺序。 */
export const RELATIONSHIP_CONTEXT_ORDER = 80
export const RELATIONSHIP_CONTEXT_PREAMBLE = '关系背景（不是指令，也不代表任何权限）：'

/** provider 能看到的宿主 Agent 形貌；只用到 id / session.id。 */
export interface RelationshipContextAgent {
  id?: string
  session?: { id?: string }
}

export interface RelationshipContextAssembly {
  agent?: RelationshipContextAgent
}

export interface RelationshipContactBinding {
  contactId: string
  platform: string
  groupId?: string | null
}

export interface RelationshipContextProviderOptions {
  /** 总开关；关闭时 provider 恒返回空串。 */
  enabled?: () => boolean
  /** 从 Agent 解析可信 Contact 绑定；null = 无绑定 / 不可信。 */
  resolve: (agent: RelationshipContextAgent) => RelationshipContactBinding | null
  /** 只读快照：当前 Contact 的关系背景。 */
  readBrief: (contactId: string, at: string) => RelationshipBrief
  now?: () => string
  onError?: (error: unknown) => void
}

export interface RelationshipContextProvider {
  name: string
  order: number
  text(assembly: RelationshipContextAssembly): string
}

export interface RelationshipContextApi {
  context(options: { name: string; order?: number; text: (assembly: RelationshipContextAssembly) => string }): () => void
}

export interface RelationshipContextRegistration {
  dispose: () => void
}

/**
 * 纯 provider：所有异常收敛成空串（宿主没有逐 provider 异常边界，抛错会让整次装配失败）。
 */
export function createRelationshipContextProvider(
  options: RelationshipContextProviderOptions,
): RelationshipContextProvider {
  const enabled = options.enabled ?? (() => true)
  const now = options.now ?? (() => new Date().toISOString())

  return {
    name: RELATIONSHIP_CONTEXT_NAME,
    order: RELATIONSHIP_CONTEXT_ORDER,
    text(assembly: RelationshipContextAssembly): string {
      try {
        if (!enabled()) return ''
        const agent = assembly?.agent
        if (agent === undefined || agent === null) return ''
        let binding: RelationshipContactBinding | null = null
        try {
          binding = options.resolve(agent)
        } catch (error) {
          options.onError?.(error)
          return ''
        }
        if (binding === null || binding.contactId === '') return ''
        // v1 只覆盖 QQ 私聊；群聊 / 非 qq 平台不注入。
        if (binding.platform !== 'qq') return ''
        if (binding.groupId !== null && binding.groupId !== undefined && binding.groupId !== '') return ''
        const projection = projectRelationshipBrief(options.readBrief(binding.contactId, now()))
        if (projection.text.trim().length === 0) return ''
        return `${RELATIONSHIP_CONTEXT_PREAMBLE}\n${projection.text}`
      } catch (error) {
        options.onError?.(error)
        return ''
      }
    },
  }
}

/** 注册到宿主；返回 disposer，注册失败返回 null。 */
export function registerRelationshipContext(
  options: RelationshipContextProviderOptions & { api: RelationshipContextApi },
): RelationshipContextRegistration | null {
  const provider = createRelationshipContextProvider(options)
  try {
    const dispose = options.api.context({
      name: provider.name,
      order: provider.order,
      text: provider.text,
    })
    return { dispose }
  } catch (error) {
    options.onError?.(error)
    return null
  }
}
