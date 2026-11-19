// P3-B-2：Contact Affect 的纯规则层——五维、半衰期、向 0 冷却、单次上限。
//
// 契约（docs/design/p3-b-relationship-ledger.md §2.2 / §3.3）：
//   - 五维只描述「对某个人的当下感受」，与全局 Mood 是两套状态，互不写入。
//   - 基线是 0：没有感受就该回到 0，而不是停在某个中性值。
//   - 半衰期冻结：warmth 8h / tension 3h / hurt 12h / missing 12h / irritation 2h。
//   - 一次互动一维最多 ±10；证据由 Core 校验，本层不做 IO。

export type AffectDimensionKey = 'warmth' | 'tension' | 'hurt' | 'missing' | 'irritation'

export interface AffectDimensionDefinition {
  key: AffectDimensionKey
  label: string
  halfLifeMs: number
}

const HOUR = 60 * 60 * 1000

/** 五维冻结；改半衰期要升 AFFECT_RULE_VERSION 并同步设计稿。 */
export const AFFECT_DIMENSIONS: readonly AffectDimensionDefinition[] = Object.freeze([
  Object.freeze({ key: 'warmth', label: '暖意', halfLifeMs: 8 * HOUR }),
  Object.freeze({ key: 'tension', label: '紧张', halfLifeMs: 3 * HOUR }),
  Object.freeze({ key: 'hurt', label: '受伤', halfLifeMs: 12 * HOUR }),
  Object.freeze({ key: 'missing', label: '想念', halfLifeMs: 12 * HOUR }),
  Object.freeze({ key: 'irritation', label: '烦躁', halfLifeMs: 2 * HOUR }),
])

export const AFFECT_RULE_VERSION = '1'
export const AFFECT_MAX_VALUE = 100
/** 单次互动对单个维度的影响上限（绝对值）。 */
export const AFFECT_PER_SIGNAL_CAP = 10

export const AFFECT_KEYS: readonly AffectDimensionKey[] = Object.freeze(
  AFFECT_DIMENSIONS.map((dimension) => dimension.key),
)

export function affectDimensionOf(key: string): AffectDimensionDefinition | undefined {
  return AFFECT_DIMENSIONS.find((dimension) => dimension.key === key)
}

export function clampAffectValue(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(AFFECT_MAX_VALUE, Math.max(0, value))
}

/** 向 0 冷却：value * 0.5^(elapsed / halfLife)；已经在 0 就不动。 */
export function decayAffectValue(
  dimension: AffectDimensionDefinition | string,
  value: number,
  elapsedMs: number,
): number {
  const definition = typeof dimension === 'string' ? affectDimensionOf(dimension) : dimension
  if (!definition) return 0
  const clamped = clampAffectValue(value)
  if (clamped <= 0) return 0
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return clamped
  return clampAffectValue(clamped * Math.pow(0.5, elapsedMs / definition.halfLifeMs))
}

export type ContactAffectValues = Record<AffectDimensionKey, number>

export function defaultAffectValues(): ContactAffectValues {
  return { warmth: 0, tension: 0, hurt: 0, missing: 0, irritation: 0 }
}

/**
 * 把持久化行按各自的 updated_at 冷却到 now。
 * 缺行 / 非法值按 0 处理，不抛给调用方（投影与面板是只读路径）。
 */
export function effectiveAffectValues(
  raw: Partial<Record<string, { value: number; updatedAt: string }>>,
  now: string | number | Date,
): ContactAffectValues {
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime()
  const out = defaultAffectValues()
  for (const definition of AFFECT_DIMENSIONS) {
    const row = raw[definition.key]
    if (!row) continue
    const updatedMs = Date.parse(row.updatedAt)
    const elapsed = Number.isFinite(updatedMs) && Number.isFinite(nowMs) ? Math.max(0, nowMs - updatedMs) : 0
    out[definition.key] = decayAffectValue(definition, Number(row.value), elapsed)
  }
  return out
}

export interface ContactAffectUpdate {
  dimension: AffectDimensionKey
  delta: number
  evidenceRefs: string[]
}

export interface ContactAffectInput {
  opId?: string
  contactId?: string
  updates?: ContactAffectUpdate[]
  now?: string
}

export interface ContactAffectPayload {
  ok: true
  contactId: string
  applied: Array<{ dimension: AffectDimensionKey; before: number; delta: number; after: number }>
  values: ContactAffectValues
  ruleVersion: string
  replayed: boolean
  updatedAt: string
}
