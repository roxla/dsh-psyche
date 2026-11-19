// P3-B 关系账本的纯规则层（B-1 / B-2 共用）
//
// 职责边界：
// - 这里只做「信号 → 分值」的确定性推导，不碰数据库、不发事件、不读宿主状态。
// - 调用方（Core）负责身份校验、证据校验、事务、幂等与投影；本文件不决定谁能写。
// - 规则表带 `ruleVersion`：账本行记住当时用的是哪版规则，未来改分值不会污染旧账。
//
// 为什么分值由 Core 推导而不是调用方传：
// 模型能看到的只是对话内容。如果允许调用方提交 baseDelta/confidence，
// 等于把「关系怎么变」的定价权交给模型，一次 prompt 注入就能刷好感。
// 这里把每种信号的基准分、置信折扣、单次上限、24 小时净变化上限全部写死，
// 调用方只能选「发生的是哪类信号」，选错类型还有 direction 校验兜底。
//
// 边界（B-1 只实现这一层 + 账本写入）：
// - 不做 Contact Affect、不做 Trust 判定、不做主动联系。
// - `silence` 是「一段时间没有互动」的事实信号：baseDelta 为 0，只进账本，不改好感。
// - 好感是长期档位，不是当下情绪；affect 在 B-2 单独存。

/** 账本规则版本：写进 relationship_signals.rule_version，读侧按版本解释旧分。 */
export const RELATIONSHIP_RULE_VERSION = '1'

/** 单条信号对好感的净影响上限（正负同限）；超过的按此截断。 */
export const RELATIONSHIP_SIGNAL_DELTA_CAP = 4

/** 同一联系人 24 小时内累计净变化上限（正负同限）。 */
export const RELATIONSHIP_DAILY_DELTA_CAP = 8

/** 好感取值范围；与 relationship_affinity_state 的 CHECK 语义一致。 */
export const RELATIONSHIP_AFFINITY_MIN = 0
export const RELATIONSHIP_AFFINITY_MAX = 100

/** 关系信号类型：语义上「发生了什么」，方向另由 polarity 表达。 */
export type RelationshipSignalType =
  | 'ordinary_interaction'
  | 'commitment_kept'
  | 'commitment_broken'
  | 'boundary_violated'
  | 'repair'
  | 'silence'

/** 信号方向：positive / negative / neutral。neutral 只能用于不改分的信号。 */
export type RelationshipPolarity = 'positive' | 'negative' | 'neutral'

/** 证据置信度：决定基准分打折多少，由信号类型决定，调用方不能自选。 */
export type RelationshipConfidence = 'low' | 'medium' | 'high'

/** 一条信号的推导规则。direction 为 both 时允许正负两种方向。 */
export interface RelationshipSignalRule {
  signalType: RelationshipSignalType
  direction: RelationshipPolarity | 'both'
  /** 未打折的基准分值；负号表示方向由 polarity 决定，这里只存大小。 */
  baseDelta: number
  confidence: RelationshipConfidence
  /** 给人看的说明，仅日志/文档用，不参与计算。 */
  note: string
}

/** 冻结的信号规则表；顺序无关，查找按 signalType。 */
export const RELATIONSHIP_SIGNAL_RULES: readonly RelationshipSignalRule[] = Object.freeze([
  {
    signalType: 'ordinary_interaction',
    direction: 'both',
    baseDelta: 3,
    confidence: 'medium',
    note: '普通互动；无承诺、无边界事件时的基础分',
  },
  {
    signalType: 'commitment_kept',
    direction: 'positive',
    baseDelta: 4,
    confidence: 'high',
    note: '对方明确承诺并兑现',
  },
  {
    signalType: 'commitment_broken',
    direction: 'negative',
    baseDelta: 4,
    confidence: 'high',
    note: '对方明确承诺但未兑现',
  },
  {
    signalType: 'boundary_violated',
    direction: 'negative',
    baseDelta: 5,
    confidence: 'high',
    note: '越界行为；单条按上限截断到 -4',
  },
  {
    signalType: 'repair',
    direction: 'positive',
    baseDelta: 2,
    confidence: 'medium',
    note: '冲突后的修复动作；只部分抵消，不抹掉越界事实',
  },
  {
    signalType: 'silence',
    direction: 'neutral',
    baseDelta: 0,
    confidence: 'high',
    note: '一段时间没有互动的事实；只进账本，不改好感',
  },
])

/** 按类型取规则；未知类型返回 null，由调用方转成 E_VALIDATION。 */
export function relationshipSignalRule(signalType: string): RelationshipSignalRule | null {
  return RELATIONSHIP_SIGNAL_RULES.find((rule) => rule.signalType === signalType) ?? null
}

/** 置信度折扣：高置信按满分，中置信六折，低置信三折（低置信只用于未来扩展）。 */
export function relationshipConfidenceWeight(confidence: RelationshipConfidence): number {
  if (confidence === 'high') return 1
  if (confidence === 'medium') return 0.6
  return 0.3
}

/** 保留两位小数，避免浮点尾数写进账本。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 把 delta 夹在 [-cap, +cap]。 */
export function clampRelationshipDelta(delta: number, cap: number): number {
  if (!Number.isFinite(delta)) return 0
  return Math.max(-cap, Math.min(cap, delta))
}

/** 推导结果；appliedDelta 已经打折扣并按单条上限截断，方向由 polarity 决定。 */
export interface DerivedRelationshipDelta {
  signalType: RelationshipSignalType
  polarity: RelationshipPolarity
  rule: RelationshipSignalRule
  /** 规则表里的原始基准分（大小）。 */
  baseDelta: number
  /** 折扣后、截断前的带符号分值。 */
  rawDelta: number
  /** 最终写入账本的 applied_delta。 */
  appliedDelta: number
  ruleVersion: string
}

/**
 * 推导一条信号的 applied_delta。
 * 返回 null 表示「类型未知 / 方向与规则冲突 / 分值非法」，调用方应拒绝整笔写入。
 * 注意：daily cap 需要读账本，不在纯函数里做；由 Core 在事务内调用 clampDailyDelta。
 */
export function deriveRelationshipDelta(
  signalType: string,
  polarity: string,
): DerivedRelationshipDelta | null {
  const rule = relationshipSignalRule(signalType)
  if (!rule) return null
  if (polarity !== 'positive' && polarity !== 'negative' && polarity !== 'neutral') return null
  // direction 是规则层的第一道闸：承诺兑现不能被写成 negative，沉默不能被写成 positive
  if (rule.direction !== 'both' && rule.direction !== polarity) return null
  // neutral 只允许用在 baseDelta 为 0 的信号上；否则就是「不表态却想加分」
  if (polarity === 'neutral' && rule.baseDelta !== 0) return null
  if (!Number.isFinite(rule.baseDelta) || rule.baseDelta < 0) return null

  const sign = polarity === 'positive' ? 1 : polarity === 'negative' ? -1 : 0
  const weighted = rule.baseDelta * relationshipConfidenceWeight(rule.confidence) * sign
  const appliedDelta = round2(clampRelationshipDelta(weighted, RELATIONSHIP_SIGNAL_DELTA_CAP))
  return {
    signalType: rule.signalType,
    polarity,
    rule,
    baseDelta: rule.baseDelta,
    rawDelta: round2(weighted),
    appliedDelta,
    ruleVersion: RELATIONSHIP_RULE_VERSION,
  }
}

/**
 * 24 小时净变化闸：windowDelta 是已有窗口内 applied_delta 之和（不含本条）。
 * 返回本条实际允许写入的 delta；若窗口已到顶，返回 0（信号仍记账，但不改好感）。
 * 这样「越界一次 −4」不会被同类事件在一天内刷成 −40，同时保留事件事实。
 */
export function clampDailyDelta(windowDelta: number, delta: number): number {
  if (!Number.isFinite(windowDelta) || !Number.isFinite(delta)) return 0
  const base = Math.max(-RELATIONSHIP_DAILY_DELTA_CAP, Math.min(RELATIONSHIP_DAILY_DELTA_CAP, windowDelta))
  const next = base + delta
  const clamped = Math.max(-RELATIONSHIP_DAILY_DELTA_CAP, Math.min(RELATIONSHIP_DAILY_DELTA_CAP, next))
  return round2(clamped - base)
}

/** 把好感夹在 0–100 并保留两位小数。 */
export function clampAffinity(value: number): number {
  if (!Number.isFinite(value)) return RELATIONSHIP_AFFINITY_MIN
  const bounded = Math.max(RELATIONSHIP_AFFINITY_MIN, Math.min(RELATIONSHIP_AFFINITY_MAX, value))
  return round2(bounded)
}
