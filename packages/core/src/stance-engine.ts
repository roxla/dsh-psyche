// P2 Completion Batch 阶段 3：StanceEngine 的「计划」部分（纯函数）。
//
// 为什么单独拆成纯函数：
// - 合成规则要能脱离数据库单测（同输入必须同输出）；
// - 判定与写入分开，Core 只负责把 plan 落库，失败策略集中在 #applyStancePlan；
// - 阶段 3 的验收要求「确定性/可重复」——只有纯函数能严格证明这一点。
//
// 设计冻结见 docs/design/p2-stance-engine.md。
// 要点：分组与方向只看显式 stanceGroup / stanceDirection，绝不从正文猜；
// 身份键 = `${group}:${direction}`；正文由模板确定性生成，不调模型。

/** 立场方向：只接受显式标注，不从文本推断。 */
export type StanceDirection = 'for' | 'against' | 'neutral'
/** 方向 → 中文标签；只用于拼正文，不参与判定。 */
export const STANCE_DIRECTION_LABELS: Readonly<Record<StanceDirection, string>> = Object.freeze({
  for: '倾向肯定',
  against: '倾向否定',
  neutral: '保持中立',
})

/** 参与合成的一条 belief 快照（由 Core 从库里读好传进来，纯函数不读库）。 */
export interface StanceBeliefInput {
  artifactId: string
  revision: number
  state: 'active'
  statement: string
  confidence: 'low' | 'medium' | 'high'
  updatedAt: string
  group: string
  direction: StanceDirection
  /** 该 belief 当前 revision 的证据 independence_key（已按跨会话去重前收集）。 */
  evidenceKeys: string[]
  /** 该 belief 当前 revision 的来源会话（用于「至少跨 2 个会话」门槛）。 */
  sessionRefs: string[]
}

/** 已存在的 stance 快照；null 表示还没有对应身份。 */
export interface ExistingStanceInput {
  statement: string
  state: 'active' | 'challenged'
  basis: { artifactId: string; revision: number }[]
  /** 当前 head 的独立证据键（跨 belief 去重后）；用于判断「只是多了证据」有没有变。 */
  evidenceKeys: string[]
}

/** skip 的原因：每一条都要能对外解释「为什么这次没合成」。 */
export type StanceSkipReason =
  | 'insufficient-beliefs'
  | 'unresolved-tension'
  | 'internal-conflict'
  | 'insufficient-evidence'
  | 'no-change'

/** 合成计划：Core 只按它落库，纯函数不产生任何副作用。 */
export type StancePlan =
  | { action: 'skip'; reason: StanceSkipReason; key: string }
  | {
      action: 'create'
      key: string
      group: string
      direction: StanceDirection
      statement: string
      basis: { artifactId: string; revision: number }[]
      evidenceKeys: string[]
      sessionCount: number
    }
  | {
      action: 'revise'
      key: string
      group: string
      direction: StanceDirection
      statement: string
      basis: { artifactId: string; revision: number }[]
      evidenceKeys: string[]
      sessionCount: number
      changedBecause: 'basis' | 'evidence' | 'statement'
    }

/** 身份键：分组 + 方向，两者都必须是显式标注。 */
export function stanceKeyOf(group: string, direction: StanceDirection): string {
  return `${group}:${direction}`
}

/** 置信度排序权重：合成正文取「最可信的那条 belief」。 */
const CONFIDENCE_RANK: Readonly<Record<StanceBeliefInput['confidence'], number>> = Object.freeze({
  high: 3,
  medium: 2,
  low: 1,
})

function compareBeliefs(left: StanceBeliefInput, right: StanceBeliefInput): number {
  const rankDiff = CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence]
  if (rankDiff !== 0) return rankDiff
  const timeDiff = right.updatedAt.localeCompare(left.updatedAt)
  if (timeDiff !== 0) return timeDiff
  return left.artifactId.localeCompare(right.artifactId)
}

function basisKey(basis: { artifactId: string; revision: number }[]): string {
  return basis
    .map((item) => `${item.artifactId}@${item.revision}`)
    .sort()
    .join(',')
}

function evidenceKeyOf(keys: string[]): string {
  return [...new Set(keys)].sort().join('\u0000')
}

/**
 * 计算一次合成计划。
 *
 * @param input.beliefs 调用方已按「同组同向」取得候选；函数会再过滤一遍 active 与非空字段。
 * @param input.existing 该 stanceKey 已有的 stance；没有就传 null。
 * @param input.conflicts 组内存在 contradicts 关系的 artifact id（可选）。
 * @param input.unresolvedTensionArtifacts 卷入未解决 Tension 的 artifact id（可选）。
 */
export function planStanceSynthesis(input: {
  beliefs: StanceBeliefInput[]
  existing: ExistingStanceInput | null
  conflicts?: ReadonlySet<string>
  unresolvedTensionArtifacts?: ReadonlySet<string>
}): StancePlan {
  const active = input.beliefs.filter(
    (belief) =>
      belief.state === 'active' &&
      belief.group.trim().length > 0 &&
      (belief.direction === 'for' || belief.direction === 'against' || belief.direction === 'neutral'),
  )
  const first = active[0]
  const key = first ? stanceKeyOf(first.group, first.direction) : ''

  // 门槛一：至少两条同组同向的 active belief
  if (!first || active.length < 2) {
    return { action: 'skip', reason: 'insufficient-beliefs', key }
  }
  // 门槛二：组内没有未解决的 Tension
  if (
    input.unresolvedTensionArtifacts &&
    active.some((belief) => input.unresolvedTensionArtifacts?.has(belief.artifactId))
  ) {
    return { action: 'skip', reason: 'unresolved-tension', key }
  }
  // 门槛三：参与合成的 belief 之间没有 contradicts
  if (input.conflicts && active.some((belief) => input.conflicts?.has(belief.artifactId))) {
    return { action: 'skip', reason: 'internal-conflict', key }
  }

  const sorted = [...active].sort(compareBeliefs)
  const evidenceKeys = [...new Set(sorted.flatMap((belief) => belief.evidenceKeys))].sort()
  const sessionRefs = new Set(sorted.flatMap((belief) => belief.sessionRefs).filter(Boolean))

  // 门槛四：跨 belief 去重后的独立证据 ≥2，且至少跨 2 个会话
  if (evidenceKeys.length < 2 || sessionRefs.size < 2) {
    return { action: 'skip', reason: 'insufficient-evidence', key }
  }

  const representative = sorted[0]
  const statement = `关于 ${first.group}，${STANCE_DIRECTION_LABELS[first.direction]}：${representative.statement}`
  const basis = sorted
    .map((belief) => ({ artifactId: belief.artifactId, revision: belief.revision }))
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId))

  const common = {
    key,
    group: first.group,
    direction: first.direction,
    statement,
    basis,
    evidenceKeys,
    sessionCount: sessionRefs.size,
  }

  // 没有既有身份：新建
  if (input.existing === null) {
    return { action: 'create', ...common }
  }

  // 有身份：只有实质变化才修订
  const basisChanged = basisKey(input.existing.basis) !== basisKey(basis)
  const evidenceChanged = evidenceKeyOf(input.existing.evidenceKeys) !== evidenceKeyOf(evidenceKeys)
  const statementChanged = input.existing.statement !== statement

  if (!basisChanged && !evidenceChanged && !statementChanged) {
    return { action: 'skip', reason: 'no-change', key }
  }

  return {
    action: 'revise',
    ...common,
    changedBecause: basisChanged ? 'basis' : evidenceChanged ? 'evidence' : 'statement',
  }
}
