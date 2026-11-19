// P3-B-2：Contact Trust 的规则与契约——只有 Core 的专用入口能写，模型不能自封信任。
//
// 契约（docs/design/p3-b-relationship-ledger.md §3.4）：
//   - 初始状态是 unassessed（未评估），不是 50 分。
//   - 评估后 0–100；单次变化不超过 ±20；至少两条独立证据。
//   - 首次评估后信的是 band（low/medium/high）与 value；关系分数不授予任何操作权限。
//   - 改口走新 revision；撤回后不再读取为有效 Trust。
//   - Trust 存在 Artifact 的 payload 里：payload.type='contact_trust_assessment'。

export type TrustBand = 'low' | 'medium' | 'high'

/** 0–100 的档位边界：>=70 high，>=40 medium，其余 low。 */
export const TRUST_HIGH_MIN = 70
export const TRUST_MEDIUM_MIN = 40

/** 单次复核允许的最大变化量（绝对值）。 */
export const MAX_TRUST_DELTA = 20

/** 一次评估至少需要多少条独立证据。 */
export const MIN_TRUST_EVIDENCE = 2

export const TRUST_RULE_VERSION = '1'

export function trustBandOf(value: number): TrustBand {
  if (value >= TRUST_HIGH_MIN) return 'high'
  if (value >= TRUST_MEDIUM_MIN) return 'medium'
  return 'low'
}

export function clampTrustValue(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export interface ContactTrustBasis {
  evidenceRefs: string[]
  ruleVersion: string
  decidedBy: 'owner'
}

export interface ContactTrustPayload {
  type: 'contact_trust_assessment'
  value: number
  band: TrustBand
  basis: ContactTrustBasis
}

/** 判断一个 relationship Artifact 的 payload 是不是 Trust 评估（不是则不能当信任读）。 */
export function isContactTrustPayload(payload: unknown): payload is ContactTrustPayload {
  if (typeof payload !== 'object' || payload === null) return false
  const record = payload as Record<string, unknown>
  if (record.type !== 'contact_trust_assessment') return false
  if (typeof record.value !== 'number' || !Number.isFinite(record.value)) return false
  if (record.value < 0 || record.value > 100) return false
  if (record.band !== 'low' && record.band !== 'medium' && record.band !== 'high') return false
  return true
}

export interface ContactTrustReviewInput {
  opId?: string
  contactId?: string
  proposedValue?: number
  evidenceRefs?: string[]
  decidedBy?: 'owner' | 'persona'
  now?: string
}

export interface ContactTrustReviewPayload {
  ok: true
  contactId: string
  artifactId: string
  revision: number
  value: number
  band: TrustBand
  previous: { value: number; band: TrustBand } | null
  decidedBy: 'owner'
  ruleVersion: string
  replayed: boolean
}
