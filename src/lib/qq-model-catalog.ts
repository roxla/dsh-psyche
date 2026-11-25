// QQ 默认模型选择用的「宿主能力目录」适配层。
//
// 目的只有一件：把宿主的 provider / model / reasoningEffort 三层目录，包成一个
// 可以直接喂给控制中心页面的同步视图 + 一个保存前必须通过的校验。
//
// 为什么单独一层而不是直接 import dsh-llm：
//   `@deepseek-ai/dsh-llm` 是 optional peer dependency（由宿主提供）。这里只
//   用 `import type`，运行时对象由调用方注入，所以宿主没装 llm 时插件照常启动，
//   只是模型编辑页显示「目录不可用」并禁用保存。
//
// 一条硬约束来自 llm 服务自己的注释：loop 构造的请求是 **deep-frozen** 的
// （`llm/stream` 的 `options` 注释原文：「arrives deep-frozen (mutation throws)」），
// 所以插件**不能**在 `llm/stream` 里改写 reasoningEffort。本版因此只做
// 「保存 + 下次重建 Agent 生效」：provider/model 由 `#ensureAgent()` 传给
// `AgentOptions` 时生效，effort 仅保存并标注当前版本不生效。
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

export interface QqModelProviderInfo {
  id: string
  name: string
}

export interface QqModelOption {
  provider: string
  id: string
  name: string
  description?: string
}

export interface QqEffortOption {
  id: string
  name: string
  description?: string
}

/** 一次目录快照。`available=false` 时前端必须禁用保存，不能拿「上次保存值」当有效值用。 */
export interface QqModelCatalogView {
  available: boolean
  error?: string
  providers: QqModelProviderInfo[]
  models: QqModelOption[]
  efforts: QqEffortOption[]
  defaultEffort?: string
}

export interface QqModelSelectionInput {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface QqModelCatalog {
  /** 全量目录快照。宿主没有 llm 服务或目录抛错时返回 `available:false`，不抛。 */
  view: () => Promise<QqModelCatalogView>
  /** 单个 provider/model 的档位。模型没有档位时返回 `notOffered:true`。 */
  efforts: (provider: string, model: string) => Promise<QqModelEffortsView>
  /** 保存前校验：返回 `null` 表示通过，否则返回给用户看的中文原因。 */
  validate: (selection: QqModelSelectionInput) => Promise<string | null>
}

export interface QqModelEffortsView {
  available: boolean
  notOffered: boolean
  error?: string
  efforts: QqEffortOption[]
  defaultEffort?: string
}

const EMPTY: QqModelCatalogView = { available: false, error: '宿主没有提供 llm 服务', providers: [], models: [], efforts: [] }

/**
 * 用宿主的 `llm` 服务造一个目录适配器。
 * `getLlm()` 每次调用都重新取，因为 llm 服务可能晚于插件注册。
 */
export function createQqModelCatalog(getLlm: () => LlmRuntime | null): QqModelCatalog {
  const requireLlm = (): LlmRuntime => {
    const llm = getLlm()
    if (llm === null) throw new Error('宿主没有提供 llm 服务')
    return llm
  }

  return {
    async view(): Promise<QqModelCatalogView> {
      let llm: LlmRuntime
      try {
        llm = requireLlm()
      } catch (error) {
        return { ...EMPTY, error: errorText(error) }
      }
      try {
        const providers = (await llm.listProviders()).map((item) => ({ id: item.id, name: item.name }))
        const models: QqModelOption[] = []
        for (const provider of providers) {
          const listed = await llm.listModels(provider.id)
          for (const model of listed) {
            const option: QqModelOption = { provider: model.provider, id: model.id, name: model.name }
            if (model.description !== undefined) option.description = model.description
            models.push(option)
          }
        }
        // 档位只在「已保存的那个 provider/model」上有意义：目录里不可能把所有
        // 模型的 efforts 都拉一遍（代价高且多数模型没有档位）。
        const efforts: QqEffortOption[] = []
        let defaultEffort: string | undefined
        if (models.length > 0) {
          const first = models[0]
          const resolved = await safeResolve(llm, first.provider, first.id)
          if (resolved?.reasoning !== undefined) {
            for (const effort of resolved.reasoning.efforts) {
              const option: QqEffortOption = { id: effort.id, name: effort.name }
              if (effort.description !== undefined) option.description = effort.description
              efforts.push(option)
            }
            if (resolved.reasoning.defaultEffort !== undefined) defaultEffort = resolved.reasoning.defaultEffort
          }
        }
        const view: QqModelCatalogView = { available: true, providers, models, efforts }
        if (defaultEffort !== undefined) view.defaultEffort = defaultEffort
        return view
      } catch (error) {
        return { ...EMPTY, error: errorText(error) }
      }
    },

    async efforts(provider: string, model: string): Promise<QqModelEffortsView> {
      if (provider === '' || model === '') {
        return { available: true, notOffered: true, efforts: [] }
      }
      let llm: LlmRuntime
      try {
        llm = requireLlm()
      } catch (error) {
        return { available: false, notOffered: false, error: errorText(error), efforts: [] }
      }
      try {
        const resolved = await safeResolve(llm, provider, model)
        const reasoning = resolved?.reasoning
        if (reasoning === undefined || reasoning.efforts.length === 0) {
          return { available: true, notOffered: true, efforts: [] }
        }
        const list: QqEffortOption[] = []
        for (const effort of reasoning.efforts) {
          const option: QqEffortOption = { id: effort.id, name: effort.name }
          if (effort.description !== undefined) option.description = effort.description
          list.push(option)
        }
        const result: QqModelEffortsView = { available: true, notOffered: false, efforts: list }
        if (reasoning.defaultEffort !== undefined) result.defaultEffort = reasoning.defaultEffort
        return result
      } catch (error) {
        return { available: false, notOffered: false, error: errorText(error), efforts: [] }
      }
    },

    async validate(selection: QqModelSelectionInput): Promise<string | null> {
      let llm: LlmRuntime
      try {
        llm = requireLlm()
      } catch (error) {
        return errorText(error)
      }
      try {
        const providers = await llm.listProviders()
        if (!providers.some((item) => item.id === selection.provider)) {
          return `宿主没有这个提供方：${selection.provider}`
        }
        const models = await llm.listModels(selection.provider)
        if (!models.some((item) => item.id === selection.model)) {
          return `这个提供方下没有该模型：${selection.model}`
        }
        if (selection.reasoningEffort !== undefined && selection.reasoningEffort !== '') {
          const resolved = await safeResolve(llm, selection.provider, selection.model)
          const efforts = resolved?.reasoning?.efforts ?? []
          if (!efforts.some((item) => item.id === selection.reasoningEffort)) {
            // 模型没有档位却指定了档位，是明确的坏选择，不能靠「运行时忽略」蒙过去。
            return efforts.length === 0
              ? `模型 ${selection.model} 没有可选的推理档位`
              : `模型 ${selection.model} 不支持档位 ${selection.reasoningEffort}`
          }
        }
        return await deepValidate(llm, selection)
      } catch (error) {
        return errorText(error)
      }
    },
  }
}

async function safeResolve(llm: LlmRuntime, provider: string, model: string) {
  try {
    return await llm.resolveModelInfo(provider, model)
  } catch {
    // 目录里能列出、但解析不了精确信息，按「没有档位」处理：宁可不给档位，
    // 也不要让用户选一个保存得进去、发出去被拒的值。
    return null
  }
}

/**
 * 交给宿主自己的调用配置校验做最后一道：它会在 provider I/O 之前拒绝不受支持的
 * 显式 effort（不裁剪、不别名）。宿主没有这个方法时直接放行——前面三步已经够用。
 */
async function deepValidate(llm: LlmRuntime, selection: QqModelSelectionInput): Promise<string | null> {
  const resolve = (llm as unknown as { resolveCallConfig?: (config: unknown) => Promise<unknown> }).resolveCallConfig
  if (typeof resolve !== 'function') return null
  try {
    await resolve.call(llm, {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort !== undefined && selection.reasoningEffort !== ''
        ? { reasoningEffort: selection.reasoningEffort }
        : {}),
    })
    return null
  } catch (error) {
    return errorText(error)
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : '未知错误'
}
