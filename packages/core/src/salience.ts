/**
 * 显著度（设计文档 v14 §21.2 + 评审第 5 点，P2 第一批）。
 *
 * 职责：在一堆结论里判断「哪几条更重、哪几条已经站得很稳」，只用于排序、折叠顺序、意识海亮度。
 * 为什么纯函数：不碰数据库、不调模型，除 `now` 外不读外部状态；`artifact_revisions.salience` 只是写入时的快照。
 * 被谁调用：`cognition.ts`（deriveSalienceNow 从库里读行喂进来）、`panel.ts`（排序结果与展示）。
 * 计分三样（评审第 5 点）：独立经历数（同一 independenceKey 只算一次）、复核次数、实际后果。
 * 关键不变量：分数**不注入模型**、不进任何判据；固化 ≠ 永远正确，有反证照样能被 revise / clash 改掉。
 */

/** 算法版本：改动任何系数、阈值、去重方式都必须改这个串，否则旧分数无法解释。 */
export const SALIENCE_ALGORITHM_VERSION = 'sal-1'

/**
 * 三份独立经历就算固化（`>=`，不含等于 3 的歧义）。
 * 对应「同一件事被三个不同窗口／平台确认过」，而不是「同一个窗口说了三遍」。
 */
export const SOLID_GROUP_MIN = 3

/**
 * 两次独立验证也算固化（对应评审里的 `independentVerificationCount >= 2`）。
 * 与「经历数」是**或**关系：攒经历或反复复核，任一条路走到头都算稳。
 */
export const SOLID_VERIFY_MIN = 2

/**
 * 最近一次提到之后的半衰期（天）。每过 30 天系数减半，但不会减到 0。
 * 遗忘是降召回（排到后面），不是删历史——`retracted` / `forgotten` 是另一套状态。
 */
export const SALIENCE_HALF_LIFE_DAYS = 30

/** 分数下限：再冷也不会归零，只是排到后面去。低于它的衰减结果一律抬回 0.35。 */
export const SALIENCE_RECENCY_FLOOR = 0.35

/**
 * 证据与结论的关系。只有 `supports` 计入「独立经历」，`contradicts` 计入反驳，
 * `qualifies` / `contextualizes` 仅用于检索上下文，不参与计分。
 */
export type SalienceRelation = 'supports' | 'contradicts' | 'qualifies' | 'contextualizes'

/** 一条证据的记分输入：关系 + 独立键——只有这两样参与「独立经历」的去重与计数。 */
export interface SalienceEvidenceInput {
  relation: SalienceRelation
  /** 由 Capture 生成的独立键；模型填不了。空串表示这条证据没法判断独立性。 */
  independenceKey: string
}

/** 一条结论（head revision）的完整记分输入，由 cognition.ts 的 SQL 读出来后喂进来。 */
export interface SalienceInput {
  artifactId: string
  kind: string
  revision: number
  state: string
  confidence: string
  statement: string
  /** 这一版是什么时候建的（用于「记得多久了」，不参与计分）。 */
  createdAt: string
  /** 这条结论最后一次被改写的时间。 */
  updatedAt: string
  /** 最后一次被提到的时间（触发事件里最新的那条），没有就用 `updatedAt`。 */
  lastSeenAt: string
  evidence: SalienceEvidenceInput[]
  /** 复核确认过几次（`review_result` 触发事件，按事件去重）。 */
  verificationCount: number
  /** 实际后果：反驳事件、行动结果事件、明确矛盾关系的条数。 */
  consequenceCount: number
}

/** 分数的拆解（原始分 + 两个系数），面板上要显示「为什么是这个分」。 */
export interface SalienceComponents {
  /** 独立经历数（去重后的 supports 键数）。 */
  independentActivityGroups: number
  /** 独立验证次数。 */
  independentVerificationCount: number
  /** 反驳类证据条数（记分用）。 */
  contradictions: number
  /** 实际后果条数。 */
  consequences: number
  /** 原始分（衰减与状态惩罚之前）。 */
  raw: number
  /** 时间衰减系数 0.35–1。 */
  recency: number
  /** 状态惩罚系数 0.25–1。 */
  statePenalty: number
}

/** 单条结论的排名结果：分数、是否固化、拆解与一句话理由。 */
export interface SalienceEntry {
  artifactId: string
  kind: string
  statement: string
  revision: number
  state: string
  /** 0–6 之间的最终分（保留三位小数）。 */
  score: number
  solid: boolean
  components: SalienceComponents
  /** 一句话说明它凭什么这么重（给观测台看）。 */
  reasons: string[]
}

/**
 * 状态惩罚系数：越「不像还活着」的结论乘得越小，但都有地板（≥ 0.25）。
 * 认不出来的状态用 0.6 兜底，而不是 0——宁可低估，也不要让一条新状态凭空消失。
 */
const STATE_PENALTY: Readonly<Record<string, number>> = Object.freeze({
  active: 1,
  challenged: 0.9,
  draft: 0.8,
  testing: 0.85,
  superseded: 0.25,
  retracted: 0.25,
  forgotten: 0.25,
  deprecated: 0.3,
})

/** 解析成毫秒；空值或脏字符串返回 NaN（由调用方决定怎么兜，不要在这里猜 0）。 */
function ms(value: string | null | undefined): number {
  if (!value) return NaN
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? NaN : parsed
}

/** 四舍五入到 `digits` 位小数；只为了输出稳定（避免 1.9999999999 这种数进快照）。 */
function round(value: number, digits = 3): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * 时间衰减：30 天减半，最低 0.35（不会因为冷掉就彻底消失）。
 *
 * 参数 `lastSeenAt`：最后一次被提到的时间；`now`：当前时刻。
 * 返回：0.35–1 之间的系数。未来时间（时钟回拨、脏数据）按 0 天处理，系数 1。
 * 边界：任一时间解析失败都直接给地板 0.35——宁可按最冷算，也不要 NaN 传染整个分数。
 */
export function recencyOf(lastSeenAt: string, now: string): number {
  const seen = ms(lastSeenAt)
  const at = ms(now)
  if (Number.isNaN(seen) || Number.isNaN(at)) return SALIENCE_RECENCY_FLOOR
  const ageDays = Math.max(0, (at - seen) / 86_400_000)
  return clamp01(0.5 ** (ageDays / SALIENCE_HALF_LIFE_DAYS), SALIENCE_RECENCY_FLOOR)
}

/** 把系数夹在 [floor, 1]；上限 1 是「刚提过」的最大值，衰减只会让它变小。 */
function clamp01(value: number, floor: number): number {
  return Math.max(floor, Math.min(1, value))
}

/**
 * 算一条结论的显著度。
 *
 * 参数 `input`：一条结论的 head revision + 它的证据、复核次数、后果条数。
 * 参数 `now`：当前时刻，只用于时间衰减——传不同 `now` 会得到不同分数，这是**唯一**的时间依赖。
 * 返回：0–6 之间的分数（raw 上限 1+2+1.2+1.2 = 5.4，再乘系数）、是否固化、分量明细、人话理由。
 * 边界：`verificationCount` / `consequenceCount` 先取整并夹到 ≥ 0，NaN 也变 0，不会污染分数。
 */
export function salienceOf(input: SalienceInput, now: string): SalienceEntry {
  const groups = new Set<string>()
  const contradicted = new Set<string>()
  for (const evidence of input.evidence) {
    // 空独立键直接跳过：说不清「这是哪一段经历」的证据不能拿去凑独立经历数。
    const key = typeof evidence.independenceKey === 'string' ? evidence.independenceKey.trim() : ''
    if (!key) continue
    if (evidence.relation === 'supports') groups.add(key)
    if (evidence.relation === 'contradicts') contradicted.add(key)
  }

  const independentActivityGroups = groups.size
  const independentVerificationCount = Math.max(0, Math.trunc(input.verificationCount))
  const contradictions = contradicted.size
  const consequences = Math.max(0, Math.trunc(input.consequenceCount))

  // 三样东西各自封顶，免得某一项把分数拉到没有上限：
  //   经历：每段 +0.5，最多 +2（4 段就够顶格，再多说明不了更重）；
  //   复核：每次 +0.4，最多 +1.2；后果：每条 +0.6、反驳 +0.2，合计最多 +1.2。
  // 基线 1：哪怕只有一条直接来源也不是 0 分（冷启动的结论也要能排上号）。
  const supportTerm = Math.min(2, 0.5 * independentActivityGroups)
  const verifyTerm = Math.min(1.2, 0.4 * independentVerificationCount)
  const consequenceTerm = Math.min(1.2, 0.6 * consequences + 0.2 * contradictions)
  const raw = 1 + supportTerm + verifyTerm + consequenceTerm

  // 分数 = 原始分 × 时间衰减 × 状态惩罚；三步都只减不增，所以 raw 就是分数上限。
  const recency = recencyOf(input.lastSeenAt || input.updatedAt, now)
  const statePenalty = STATE_PENALTY[input.state] ?? 0.6
  const score = round(raw * recency * statePenalty)

  // 固化只看「独立经历」与「复核次数」两条硬指标，与分数高低无关：
  // 一条刚写下的结论也可能因为来源够多而直接固化。
  const solid =
    independentActivityGroups >= SOLID_GROUP_MIN || independentVerificationCount >= SOLID_VERIFY_MIN

  const reasons: string[] = []
  if (independentActivityGroups > 0) reasons.push(`${independentActivityGroups} 个独立经历`)
  if (independentVerificationCount > 0) reasons.push(`${independentVerificationCount} 次复核确认`)
  if (consequences > 0) reasons.push(`${consequences} 次实际后果`)
  if (contradictions > 0) reasons.push(`${contradictions} 条反驳证据`)
  if (recency < 0.99) reasons.push(`${Math.round((1 - recency) * 100)}% 时间衰减`)
  if (statePenalty < 1) reasons.push(`状态 ${input.state}`)
  if (reasons.length === 0) reasons.push('只有一条直接来源')

  return {
    artifactId: input.artifactId,
    kind: input.kind,
    statement: input.statement,
    revision: input.revision,
    state: input.state,
    score,
    solid,
    components: {
      independentActivityGroups,
      independentVerificationCount,
      contradictions,
      consequences,
      raw: round(raw),
      recency: round(recency),
      statePenalty,
    },
    reasons,
  }
}

/**
 * 排序：固化优先 → 分数高优先 → id 升序。
 *
 * 返回新数组（不改入参）。最后那一条纯粹为了让同分时结果也稳定
 * （同一个库算两次必须一模一样，否则面板每次刷新顺序都在跳）。
 */
export function rankSalience(entries: readonly SalienceEntry[]): SalienceEntry[] {
  return [...entries].sort((a, b) => {
    if (a.solid !== b.solid) return a.solid ? -1 : 1
    if (b.score !== a.score) return b.score - a.score
    if (a.artifactId !== b.artifactId) return a.artifactId < b.artifactId ? -1 : 1
    return 0
  })
}

/**
 * 批量算 + 排序的便捷入口。
 *
 * 参数 `inputs`：一批结论的输入；`now`：当前时刻（全批共用，保证同一批里衰减口径一致）。
 * 返回：按 `rankSalience` 排好的新数组；空输入返回空数组。
 */
export function deriveSalience(inputs: readonly SalienceInput[], now: string): SalienceEntry[] {
  return rankSalience(inputs.map((input) => salienceOf(input, now)))
}
