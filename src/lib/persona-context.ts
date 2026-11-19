/**
 * P5-1a：`psyche-persona` Context 注册壳。
 *
 * - 只注册单个只读 Provider；order 90，位于 memory Section 之后、mood-tone 之前。
 * - 只有 `ready` 才返回原文；失败状态返回空串，不注入旧文本或部分内容。
 * - 不接管其他 Context，不做总预算协调（属 P5-2）。
 */
import {
  readPersonaProjection,
  type PersonaProjection,
} from './persona-runtime.js'

export const PERSONA_CONTEXT_NAME = 'psyche-persona'
export const PERSONA_CONTEXT_ORDER = 90

/**
 * P5-1b：把「可信 Psyche 绑定」判断收成一个纯函数，供宿主接线与单测共用。
 * 无 Agent、无绑定、读取抛错都返回 false（不注入）。
 */
export function createPersonaAgentGate(
  readForAgent: (agent: { id?: string; session?: { id?: string } }) => unknown,
): (agent: PersonaAssembly['agent']) => boolean {
  return (agent) => {
    if (agent === undefined || agent === null) return false
    try {
      const binding = readForAgent(agent)
      return binding !== null && binding !== undefined
    } catch {
      return false
    }
  }
}

export interface PersonaPromptApi {
  context(options: { name: string; order: number; text: (assembly?: PersonaAssembly) => string }): () => void
}

/** provider 能看到的宿主装配上下文；P5-1b 只用它做 Agent 绑定判断。 */
export interface PersonaAssembly {
  agent?: { id?: string; session?: { id?: string } }
}

export interface PersonaRegistration {
  dispose: () => void
  /** 当前注册的 Provider（测试可直接调用）。 */
  text: (assembly?: PersonaAssembly) => string
  /** 最近一次读取的投影（不缓存，供诊断）。 */
  read: () => PersonaProjection
}

export interface PersonaRegisterOptions {
  api: PersonaPromptApi
  /** 可信数据根的读取器：每次 assembly 取当前值，允许晚于注册解析完成。 */
  dataDir: string | (() => string)
  enabled?: boolean
  maxChars?: number
  maxTokens?: number
  tokenizer?: (text: string) => number
  /** 只对可信 Psyche Agent 注入；缺省允许（单测/旧行为）。 */
  resolveAgent?: (agent: PersonaAssembly['agent']) => boolean
  /** P7-1：dominance 接管时让位，避免与 Section/waterfall 重复注入。 */
  suppress?: (assembly?: PersonaAssembly) => boolean
  onError?: (error: unknown) => void
}

/**
 * 构造同步 Provider：任何异常都收敛为空串，保证 Prompt Assembly 不被人格故障打断。
 * P5-1b：没有可信 Agent 绑定时不注入，避免共享注册点把人格带给其他 Profile。
 */
export function createPersonaProvider(options: {
  read: () => PersonaProjection
  resolveAgent?: (agent: PersonaAssembly['agent']) => boolean
  suppress?: (assembly?: PersonaAssembly) => boolean
  onError?: (error: unknown) => void
}): (assembly?: PersonaAssembly) => string {
  return (assembly?: PersonaAssembly) => {
    try {
      if (options.suppress?.(assembly)) return ''
      if (options.resolveAgent && !options.resolveAgent(assembly?.agent)) return ''
      const projection = options.read()
      return projection.status === 'ready' && projection.text ? projection.text : ''
    } catch (error) {
      options.onError?.(error)
      return ''
    }
  }
}

/**
 * 注册 `psyche-persona`。`enabled=false` 时不注册，返回 `null`。
 * 调用方负责在 effect cleanup 中 `dispose()`；同一时刻只注册一次。
 */
export function registerPersonaContext(options: PersonaRegisterOptions): PersonaRegistration | null {
  if (options.enabled === false) return null
  const read = () => {
    const dataDir = typeof options.dataDir === 'function' ? options.dataDir() : options.dataDir
    return readPersonaProjection({
      dataDir,
      enabled: options.enabled,
      maxChars: options.maxChars,
      maxTokens: options.maxTokens,
      tokenizer: options.tokenizer,
    })
  }
  const text = createPersonaProvider({
    read,
    resolveAgent: options.resolveAgent,
    suppress: options.suppress,
    onError: options.onError,
  })
  const dispose = options.api.context({
    name: PERSONA_CONTEXT_NAME,
    order: PERSONA_CONTEXT_ORDER,
    text,
  })
  return { dispose, text, read }
}
