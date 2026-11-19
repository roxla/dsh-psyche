/**
 * 来源分类（设计文档 v15 §38，批次 A2）。
 *
 * 职责：回答「这条结论是**怎么来的**」，把散在 Evidence / Source / Artifact Lineage /
 * 提案记录里的线索合成**一个**标签，供 recall / stances / fetch / 面板统一显示。
 *
 * 一条必须先说清的话：**来源分类不是可信度等级**。
 * `user-stated` 只说明「这句话是用户说的」，不代表内容已被外部验证；
 * `observed` 只说明「有外部痕迹」，不代表这条结论理解对了；
 * `inferred` 也不是「更差」，它只是诚实地说「这条没有外部依据」。
 * 所以这里只输出类别与依据，不输出分数、不参与任何排序或闸门——排序由
 * `salience.ts` 负责，闸门由成长层负责，两者都不读这个字段做判据。
 *
 * 为什么单独成文件：`store.ts` 里的 recall/stances/fetch 三处都要展示来源，
 * 如果各写一遍「有没有 origin='user'」，三处一定漂移；这里是一份实现、一份测试。
 *
 * 纯函数边界（v14 §30.1）：零 IO、零数据库、零模型调用，输入是已经查出来的行。
 */

/**
 * 五类来源。
 *
 * - `confirmed`：人明确确认过这条（提案决策、人判 review），**优先于其余四类**；
 * - `user-stated`：至少一条用户来源（用户说的是什么）；
 * - `observed`：至少一条外部来源（网页/视频/文件，带可核验痕迹的优先）；
 * - `synthesized`：没有用户/外部来源，但有血缘（从别的结论推出来、合成出来）；
 * - `inferred`：只有自身来源、没有血缘——纯粹的推断。
 */
export type ProvenanceKind = 'confirmed' | 'user-stated' | 'observed' | 'synthesized' | 'inferred'

/** 五类的固定顺序（面板分组、文档、测试共用一份）。 */
export const PROVENANCE_KINDS: readonly ProvenanceKind[] = Object.freeze(['confirmed', 'user-stated', 'observed', 'synthesized', 'inferred'])

/** 给面板看的中文名。刻意用「我说的/我看到的」这种第一人称，别写成可信度分级。 */
export const PROVENANCE_LABELS: Readonly<Record<ProvenanceKind, string>> = Object.freeze({
  confirmed: '人确认过',
  'user-stated': '你告诉我的',
  observed: '外面看到的',
  synthesized: '综合出来的',
  inferred: '我自己推的',
})

/**
 * 一条来源的判定输入（来自 `sources` 表的一行，只取判定要用的列）。
 * 其它列（sender、room、时间）不参与分类——来源和「在哪儿说的」是两件事。
 */
export interface ProvenanceSourceInput {
  /** `sources.origin`，库里有 CHECK 约束，这里仍然按字符串接，避免上游类型扩散。 */
  origin: string
  /** `sources.kind`：model / user / web / video / file … */
  kind?: string | null
  /** 外部来源痕迹四件套，任一存在即算「可核验」。 */
  provider?: string | null
  canonicalUrl?: string | null
  workspaceRef?: string | null
  contentHash?: string | null
}

/** 血缘关系（`artifact_lineage.relation`）里哪些算「从别的结论推出来」。 */
const SYNTHESIS_RELATIONS: readonly string[] = Object.freeze(['derivedFrom', 'splitFrom', 'composedFrom', 'synthesizedFrom'])

/** `provenanceOf()` 的输入：已经查好的行，而不是 id。 */
export interface ProvenanceInput {
  /** 支撑**这一版**结论的来源行（版本敏感性由调用方保证）。 */
  sources: readonly ProvenanceSourceInput[]
  /** 该版本的血缘关系（`derivedFrom` 等）；没有血缘传空数组。 */
  lineage?: readonly string[]
  /**
   * 人是否对**这条结论本身**做过明确决定：提案被 owner 接受、或人判 review。
   * 注意「人听过这条」不算，「人确认过这条算数」才算。
   */
  confirmedByHuman?: boolean
}

/** 分类结果：类别 + 依据 + 计数。 */
export interface ProvenanceResult {
  kind: ProvenanceKind
  label: string
  /** 命中的依据，按人话写，供 `psyche_fetch` 与面板直接显示。 */
  reasons: string[]
  counts: {
    user: number
    external: number
    self: number
    /** 外部来源里带 provider/canonicalUrl/workspaceRef/contentHash 的条数。 */
    traceable: number
    total: number
  }
  /** 外部来源是否至少有一条可核验痕迹（批次 D 的「证据是否还有效」从这里起步）。 */
  hasTraceableExternal: boolean
  /** 命中的血缘关系（去重、保持输入顺序）。 */
  lineageRelations: string[]
}

/** 空来源也要能分类：那是 inferred，不是未知。 */
const EMPTY_COUNTS = Object.freeze({ user: 0, external: 0, self: 0, traceable: 0, total: 0 })

/** 外部痕迹判定：有痕迹说明日后还能回去核，没痕迹就只是「听说过」。 */
function hasTrace(source: ProvenanceSourceInput): boolean {
  return Boolean(
    String(source.provider ?? '').trim() ||
      String(source.canonicalUrl ?? '').trim() ||
      String(source.workspaceRef ?? '').trim() ||
      String(source.contentHash ?? '').trim(),
  )
}

/**
 * 判定来源类别。
 *
 * 优先级（**顺序就是判据**，别调换）：confirmed → user-stated → observed → synthesized → inferred。
 * - `confirmed` 最优先：人确认过的是哪一类都无所谓，确认本身就是最强的一种来源；
 * - `synthesized` 排在 `observed` 之后：只要有一手来源，它就是「有依据的」，
 *   血缘只说明它还经过一次加工，不改变「依据从哪来」；
 * - `synthesized` 与 `inferred` 的区别**只看有没有血缘**：有血缘 = 从别的结论推的，
 *   没血缘 = 从当前上下文里想出来的。两者都只有自身来源，但可回溯程度不同。
 *
 * 未知 origin（既不是 user/external/self）按 self 计，但**不会**被当成用户来源——
 * 宁可少认领一个来源，也不要把一条没人说过的结论标成「你告诉我的」。
 */
export function provenanceOf(input: ProvenanceInput): ProvenanceResult {
  const sources = input.sources ?? []
  const counts = { ...EMPTY_COUNTS, total: sources.length }
  for (const source of sources) {
    const origin = String(source.origin ?? '').trim().toLowerCase()
    if (origin === 'user') counts.user += 1
    else if (origin === 'external') {
      counts.external += 1
      if (hasTrace(source)) counts.traceable += 1
    } else counts.self += 1
  }

  const lineageRelations: string[] = []
  for (const relation of input.lineage ?? []) {
    const value = String(relation ?? '').trim()
    if (!value || lineageRelations.includes(value)) continue
    if (SYNTHESIS_RELATIONS.includes(value)) lineageRelations.push(value)
  }
  const hasTraceableExternal = counts.traceable > 0
  const reasons: string[] = []

  let kind: ProvenanceKind
  if (input.confirmedByHuman) {
    kind = 'confirmed'
    reasons.push('人对这条结论做过明确确认')
  } else if (counts.user > 0) {
    kind = 'user-stated'
    reasons.push(`${counts.user} 条用户来源`)
  } else if (counts.external > 0) {
    kind = 'observed'
    reasons.push(`${counts.external} 条外部来源`)
    if (hasTraceableExternal) reasons.push(`其中 ${counts.traceable} 条留有可核验痕迹（${traceHint(sources)}）`)
    else reasons.push('外部来源没有留痕迹：只记得「听说过」，核不回去了')
  } else if (lineageRelations.length > 0) {
    kind = 'synthesized'
    reasons.push(`从已有结论推出来（${lineageRelations.join('/')}），没有新的外部来源`)
  } else {
    kind = 'inferred'
    reasons.push(counts.total === 0 ? '没有任何来源记录' : `只有自身来源（${counts.self} 条）`)
  }

  return { kind, label: PROVENANCE_LABELS[kind], reasons, counts, hasTraceableExternal, lineageRelations }
}

/** 把命中的痕迹类型拼成人话，例如「网页、文件」。 */
function traceHint(sources: readonly ProvenanceSourceInput[]): string {
  const seen: string[] = []
  for (const source of sources) {
    if (String(source.origin ?? '').trim().toLowerCase() !== 'external') continue
    if (!hasTrace(source)) continue
    const label = String(source.canonicalUrl ?? '').trim()
      ? '网页'
      : String(source.workspaceRef ?? '').trim()
        ? '文件'
        : String(source.contentHash ?? '').trim()
          ? '指纹'
          : '提供方'
    if (!seen.includes(label)) seen.push(label)
  }
  return seen.join('、')
}

/**
 * 一版结论的**来源说明行**，给 `psyche_fetch` / `psyche_recall` 的渲染直接用。
 * 例：`你告诉我的（2 条用户来源）`。
 */
export function provenanceLine(result: ProvenanceResult): string {
  const detail = result.reasons[0] ?? ''
  return detail ? `${result.label}（${detail}）` : result.label
}
