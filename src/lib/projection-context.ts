/**
 * P5-2b：统一投影 Context（`psyche-projections`，order 60）。
 *
 * 设计口径（P5-2 GPT 问答冻结）：
 * - 投影预算 6000 token / 8000 字符，不含 Recall 正文；Recall 保留自己的独立上限。
 * - 必需层：隐私/Scope 纪律 + 完整人格；人格放不下整块省略，纪律不可截断。
 * - 可选层：Growth / Mood / Relationship；保留优先级 Growth > Mood > Relationship，
 *   超预算按 Relationship -> Mood -> Growth 整块丢弃。
 * - 序列化顺序：discipline -> persona -> growth -> mood -> relationship。
 * - 启动模式互斥：`projection.enabled=true` 时只注册本 Context，不再注册
 *   `psyche-memory` Section、`psyche-persona`、`psyche-mood-tone`、
 *   `psyche-relationship`；`false` 时完全沿用旧四件套。切换模式需要插件重载。
 * - 卸载：先置 `disposed`，所有回调立即返回空串；只有 `active===0` 才允许再注册。
 *   文本回调是同步的，本进程内不会出现「回调执行中跨卸载」；Host 异步组装若迟到取文本，
 *   只会拿到空串，不会产出旧内容。
 */
import { composeProjections, type ProjectionBudget, type ProjectionInput } from './projection-composer.js'
import type { AssemblyReceiptStore, AssemblyReceiver } from './assembly-receipt.js'

export const PROJECTION_CONTEXT_NAME = 'psyche-projections'
export const PROJECTION_CONTEXT_ORDER = 60

/** 宿主 Context 注册口；与 systemPrompt.context 的形状一致。 */
export interface ProjectionContextApi {
  context(options: {
    name: string
    order?: number
    text: (assembly?: { agent?: { id?: string; session?: { id?: string } } }) => string
  }): () => void
}

export interface ProjectionContextSources {
  discipline: () => string
  persona: (assembly?: ProjectionAssembly) => string
  growth: () => string
  mood: (assembly?: ProjectionAssembly) => string
  relationship: (assembly?: ProjectionAssembly) => string
  /** P6-1：可选意愿分段；未提供或返回空串时整块省略。 */
  intention?: (assembly?: ProjectionAssembly) => string
  /**
   * G1-B：同一项目的只读 Brief。返回空串即整块省略——
   * 「这个会话没绑定项目」和「绑了但还没存过 Checkpoint」都走这条静默路径。
   */
  projectBrief?: (assembly?: ProjectionAssembly) => string
  /**
   * Q5-A：最近聊过什么（原话召回）。
   * 与 projectBrief 互补——那个答「接着做什么」，这个答「上次说到哪」。
   * 同样静默：找不到就返回空串，不返回占位文本。
   */
  conversationRecall?: (assembly?: ProjectionAssembly) => string
}

export interface ProjectionAssembly {
  agent?: { id?: string; session?: { id?: string } }
}

/**
 * 组装回执用的元数据：这一次调用的接收方身份与两个块的明细。
 *
 * 采样点必须在这里（`#render` 拿到 `composeProjections()` 结果之后），
 * 而不是放在召回函数内部——否则「召回到了但被预算裁掉」会被误报成「已组装」。
 */
export interface ProjectionReceiptMeta {
  channel: AssemblyReceiver['channel']
  delegated: boolean
  delegatedBy: AssemblyReceiver['delegatedBy']
  turnId?: string | null
  recallSourceIds?: string[]
  recallSessionRef?: string | null
  recallSkipped?: string | null
  projectCheckpointId?: string | null
  projectRevision?: number | null
}

export interface ProjectionControllerOptions {
  api: ProjectionContextApi
  sources: ProjectionContextSources
  onError?: (error: unknown) => void
  /** P7-2：dominance 接管时由调用方扣掉人格/表达占用后的剩余预算。 */
  budget?: (assembly?: ProjectionAssembly) => ProjectionBudget | undefined
  /** 只读组装回执；不传就不记录（测试里默认不开）。 */
  receipts?: AssemblyReceiptStore
  /** 回执元数据；只有传了 `receipts` 才会被调用。 */
  receiptMeta?: (assembly?: ProjectionAssembly) => ProjectionReceiptMeta
}

/**
 * 生命周期与启动模式门控。
 *
 * `start()` 最多注册一次；注册失败返回 false，由调用方回退 legacy。
 * `dispose()` 幂等；disposed 后回调恒返回空串。
 */
export class ProjectionController {
  #api: ProjectionContextApi
  #sources: ProjectionContextSources
  #onError?: (error: unknown) => void
  #budget?: (assembly?: ProjectionAssembly) => ProjectionBudget | undefined
  #receipts?: AssemblyReceiptStore
  #receiptMeta?: (assembly?: ProjectionAssembly) => ProjectionReceiptMeta
  #dispose: (() => void) | null = null
  #disposed = false
  #active = 0

  constructor(options: ProjectionControllerOptions) {
    this.#api = options.api
    this.#sources = options.sources
    this.#onError = options.onError
    this.#budget = options.budget
    this.#receipts = options.receipts
    this.#receiptMeta = options.receiptMeta
  }

  get disposed(): boolean {
    return this.#disposed
  }

  get active(): number {
    return this.#active
  }

  get started(): boolean {
    return this.#dispose !== null
  }

  start(): boolean {
    if (this.#disposed) return false
    if (this.#dispose !== null) return true
    try {
      this.#dispose = this.#api.context({
        name: PROJECTION_CONTEXT_NAME,
        order: PROJECTION_CONTEXT_ORDER,
        text: (assembly) => this.#render(assembly),
      })
      return true
    } catch (error) {
      this.#onError?.(error)
      this.#dispose = null
      return false
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    const dispose = this.#dispose
    this.#dispose = null
    if (dispose === null) return
    try {
      dispose()
    } catch (error) {
      this.#onError?.(error)
    }
  }

  #render(assembly?: ProjectionAssembly): string {    if (this.#disposed) return ''
    this.#active += 1
    try {
      const safe = (read: () => string): string => {
        try {
          const value = read()
          return typeof value === 'string' ? value : ''
        } catch (error) {
          this.#onError?.(error)
          return ''
        }
      }
      const input: ProjectionInput = {
        memoryDiscipline: safe(this.#sources.discipline),
        persona: { text: safe(() => this.#sources.persona(assembly)) },
        projectBrief: this.#sources.projectBrief
          ? { text: safe(() => this.#sources.projectBrief!(assembly)) }
          : undefined,
        conversationRecall: this.#sources.conversationRecall
          ? { text: safe(() => this.#sources.conversationRecall!(assembly)) }
          : undefined,
        growth: { text: safe(this.#sources.growth) },
        mood: { text: safe(() => this.#sources.mood(assembly)) },
        relationship: { text: safe(() => this.#sources.relationship(assembly)) },
        intention: this.#sources.intention
          ? { text: safe(() => this.#sources.intention!(assembly)) }
          : undefined,
      }
      const result = composeProjections(input, this.#budget?.(assembly))
      this.#recordReceipt(assembly, input, result)
      return result.text
    } catch (error) {
      this.#onError?.(error)
      return ''
    } finally {
      this.#active -= 1
    }
  }

  /**
   * 记一条组装回执。
   *
   * 放在这里而不是召回函数里，是因为只有这里同时知道两件事：
   * 这一块有没有被 `composeProjections` 保留，以及最终文本占了多少字符。
   * 召回函数只能说「我返回了一段文本」，说不出「它进了提示没有」。
   */
  #recordReceipt(
    assembly: ProjectionAssembly | undefined,
    input: ProjectionInput,
    result: {
      kept: readonly string[]
      dropped: readonly string[]
      usedChars: number
      usedTokens: number
      warnings: readonly string[]
    },
  ): void {
    const store = this.#receipts
    if (store === undefined) return
    try {
      const meta = this.#receiptMeta?.(assembly)
      const inputs: Record<string, string | undefined> = {
        memoryDiscipline: input.memoryDiscipline,
        persona: input.persona?.text,
        projectBrief: input.projectBrief?.text,
        conversationRecall: input.conversationRecall?.text,
        growth: input.growth?.text,
        mood: input.mood?.text,
        relationship: input.relationship?.text,
        intention: input.intention?.text,
      }
      store.record({
        receiver: {
          channel: meta?.channel ?? 'unknown',
          delegated: meta?.delegated ?? false,
          delegatedBy: meta?.delegatedBy ?? 'none',
          sessionId: assembly?.agent?.session?.id ?? null,
          turnId: meta?.turnId ?? null,
        },
        inputs,
        kept: [...result.kept],
        dropped: [...result.dropped],
        warnings: [...result.warnings],
        usedChars: result.usedChars,
        usedTokens: result.usedTokens,
        recallSourceIds: meta?.recallSourceIds,
        recallSessionRef: meta?.recallSessionRef ?? null,
        recallSkipped: meta?.recallSkipped ?? null,
        projectCheckpointId: meta?.projectCheckpointId ?? null,
        projectRevision: meta?.projectRevision ?? null,
      })
    } catch (error) {
      // 回执是诊断设施，写失败不能影响正常的提示组装。
      this.#onError?.(error)
    }
  }
}

/**
 * 只读持久化成长阶段（`phase_state`），不使用 `deriveGrowthNow()` 的预测值。
 * 缺库/缺行/非法值都返回空串，不阻断装配。
 */
export function readPersistedGrowthLine(
  db: { get?: <T>(sql: string, params?: unknown[]) => T | undefined } | null,
  labels: Record<string, string>,
): string {
  if (db === null || typeof db.get !== 'function') return ''
  try {
    const row = db.get<{ phase: string }>(`SELECT phase FROM phase_state WHERE persona_id = ?`, ['main'])
    const phase = typeof row?.phase === 'string' ? row.phase : ''
    const label = labels[phase]
    if (typeof label !== 'string' || label.length === 0) return ''
    return `成长阶段：${label}（只描述当前成长位置，不是任务、权限或对用户的评价）`
  } catch {
    return ''
  }
}
