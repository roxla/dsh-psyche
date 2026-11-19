// P3-B-3：关系投影的纯规则层——把档位/信任/当下感受压成一行受控文本。
//
// 契约（docs/design/p3-b-relationship-ledger.md §4）：
//   - 只输出档位标签、信任档位、至多一条当下感受（≥40 才出现）。
//   - 不出现数值、contact_id、信号计数、证据、manual_override 或内部 key。
//   - 本层不做 IO、不读时钟；无 Contact 或读取失败由调用方决定不注入。
//   - 投影不写库，每轮现算。

import { AFFECT_KEYS, type AffectDimensionKey } from './contact-affect.js'
import type { TrustBand } from './contact-trust.js'
import { invalid } from './errors.js'

export const RELATIONSHIP_PROJECTION_VERSION = 1

/** 当下感受进入投影的门槛：低于它说明还没强到值得说。 */
export const AFFECT_NOTICE_THRESHOLD = 40

export type AffinityBandKey =
  | 'very_close'
  | 'high'
  | 'friendly'
  | 'neutral'
  | 'cautious'
  | 'distant'
  | 'hostile'

/** 与 store.ts 的 BANDS 文案保持一致；投影层不 import store，避免循环依赖。 */
export const RELATIONSHIP_BAND_LABELS: Readonly<Record<AffinityBandKey, string>> = Object.freeze({
  very_close: '非常亲近',
  high: '较高',
  friendly: '友好',
  neutral: '中立',
  cautious: '谨慎',
  distant: '疏远',
  hostile: '强烈反感',
})

/** 信任只给档位词，不给分数；v1 的 `unassessed` 对应 null，调用方不输出该段。 */
export const RELATIONSHIP_TRUST_LABELS: Readonly<Record<TrustBand, string>> = Object.freeze({
  high: '较高',
  medium: '一般',
  low: '较低',
})

export const AFFECT_NOTICE_LABELS: Readonly<Record<AffectDimensionKey, string>> = Object.freeze({
  warmth: '此刻觉得亲近',
  tension: '此刻有些紧绷',
  hurt: '此刻有些受伤',
  missing: '此刻有些想念',
  irritation: '此刻有些烦躁',
})

export interface RelationshipAffectNotice {
  dimension: AffectDimensionKey
  value: number
}

export interface RelationshipBrief {
  affinityBand: AffinityBandKey
  trustBand: TrustBand | null
  affect: readonly RelationshipAffectNotice[]
}

export interface RelationshipProjection {
  text: string
  /** 只给诊断使用，不进 Prompt。 */
  version: number
}

function bandLabel(band: unknown): string {
  if (typeof band !== 'string' || !(band in RELATIONSHIP_BAND_LABELS)) {
    throw invalid(`未知的关系档位：${String(band)}`)
  }
  return RELATIONSHIP_BAND_LABELS[band as AffinityBandKey]
}

function trustLabel(band: TrustBand | null): string | null {
  if (band === null) return null
  if (band !== 'high' && band !== 'medium' && band !== 'low') {
    throw invalid(`未知的信任档位：${String(band)}`)
  }
  return RELATIONSHIP_TRUST_LABELS[band]
}

/**
 * 挑「最强的一条当下感受」：≥阈值才出现；同分按冻结的 AFFECT_KEYS 顺序，不依赖数组遍历。
 * 非法维度/非有限值直接忽略——它们不应该让整行投影失败。
 */
function strongestNotice(affect: readonly RelationshipAffectNotice[]): string | null {
  let best: { key: AffectDimensionKey; value: number } | null = null
  for (const key of AFFECT_KEYS) {
    for (const item of affect) {
      if (item.dimension !== key) continue
      if (!Number.isFinite(item.value) || item.value < AFFECT_NOTICE_THRESHOLD) continue
      if (best === null || item.value > best.value) best = { key, value: item.value }
    }
  }
  return best === null ? null : AFFECT_NOTICE_LABELS[best.key]
}

/** 把一份关系快照压成一行；纯函数，同一输入永远同一输出。 */
export function projectRelationshipBrief(brief: RelationshipBrief): RelationshipProjection {
  if (brief === null || typeof brief !== 'object') throw invalid('关系投影输入必须是对象')
  const parts = [`关系：${bandLabel(brief.affinityBand)}。`]
  const trust = trustLabel(brief.trustBand)
  if (trust !== null) parts.push(`信任：${trust}。`)
  const notice = strongestNotice(Array.isArray(brief.affect) ? brief.affect : [])
  if (notice !== null) parts.push(`${notice}。`)
  return Object.freeze({
    text: parts.join(''),
    version: RELATIONSHIP_PROJECTION_VERSION,
  })
}
