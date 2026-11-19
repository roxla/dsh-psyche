// P3-A B3-1：全局情绪（Global Mood）语气投影——纯函数。
//
// 定位（docs/design/p3-a-b3-tone-projection.md）：
//   - 输入只有 `loadMood()` 已算好的有效值；本模块不读库、不写库、不调模型、不看宿主。
//   - 只投影「高于 baseline 的正向偏离」；`value <= baseline` 不参与（B0-REV-4）。
//   - 输出最多 1 主 + 1 辅；同标签先去重；辅助需同时过 blendGap 与兼容白名单。
//   - 输出不含维度 key / 数值 / 强度 / 权重 / 候选顺序。
//
// 确定性：同一输入必须得到完全相同的结果；层级只在 strength 平手时参与排序。

import { MOOD_DIMENSIONS, MOOD_KEYS, MOOD_LAYER_RANK, type MoodLayer } from './mood-schema.js'
import type { MoodValues } from './mood-decay.js'
import { invalid } from './errors.js'

/** 投影结构版本：改标签/阈值/白名单才 +1；与 MOOD_CONFIG_VERSION / MOOD_RULES_VERSION 无关。 */
export const MOOD_PROJECTION_VERSION = 1

/** 进入候选的最小正向偏离强度（含等于）。 */
export const MOOD_STRENGTH_THRESHOLD = 0.15

/** 主辅语气允许的最大强度差（严格小于）。 */
export const MOOD_BLEND_GAP = 0.1

/** 无候选时的中性语气。 */
export const MOOD_NEUTRAL_TONE = '平稳'

/** strength / blendGap 的整数刻度：1e-9。整数比较是全序，规避容差比较的传递性问题。 */
const STRENGTH_BUCKET_SCALE = 1e9

/**
 * 允许融合的标签对（无序）。封闭集合：新增/删除任何一对都要升 MOOD_PROJECTION_VERSION。
 * 默认不兼容；只有列在这里的组合才能成为辅助语气。
 */
export const MOOD_COMPATIBLE_TONE_PAIRS: readonly (readonly [string, string])[] = Object.freeze(
  (
    [
      ['轻快', '好奇'],
      ['轻快', '雀跃'],
      ['好奇', '专注'],
      ['好奇', '惊讶'],
      ['温柔', '安慰'],
      ['温柔', '怀旧'],
      ['委屈', '撒娇'],
      ['委屈', '黏一点'],
      ['沉默', '低缓'],
      ['低沉', '平淡'],
      ['得意', '雀跃'],
      ['致歉', '收敛'],
      ['笨拙', '收敛'],
      ['省电', '平淡'],
      ['懒散', '平淡'],
      ['脆弱', '黏一点'],
      ['犹豫', '试探'],
      ['兴奋', '雀跃'],
      ['专注', '克制'],
    ] as const
  ).map((pair) => Object.freeze([pair[0], pair[1]] as const)),
)

const COMPATIBLE_SET: ReadonlySet<string> = (() => {
  const set = new Set<string>()
  for (const [a, b] of MOOD_COMPATIBLE_TONE_PAIRS) {
    set.add(tonePairKey(a, b))
    set.add(tonePairKey(b, a))
  }
  return set
})()

function tonePairKey(a: string, b: string): string {
  return `${a}\u0000${b}`
}

export interface MoodProjection {
  tone: string
  secondary: string | null
  neutral: boolean
  projectionVersion: number
}

interface Candidate {
  key: string
  label: string
  layer: MoodLayer
  strength: number
  /** `Math.round(strength * 1e9)`：排序只看整数桶，保证比较器是全序（传递、反对称、自反）。 */
  bucket: number
}

const KNOWN_KEYS: ReadonlySet<string> = new Set(MOOD_KEYS)

function assertMoodValues(value: unknown): asserts value is MoodValues {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('情绪投影输入必须是对象')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) {
      throw invalid(`情绪投影包含未知维度: ${key}`, { key })
    }
  }
  for (const dimension of MOOD_DIMENSIONS) {
    const current = record[dimension.key]
    if (current === undefined) {
      throw invalid(`情绪投影缺少维度: ${dimension.key}`, { key: dimension.key })
    }
    if (typeof current !== 'number' || !Number.isFinite(current)) {
      throw invalid(`情绪投影数值必须是有限数字: ${dimension.key}`, {
        key: dimension.key,
        value: typeof current === 'number' ? String(current) : typeof current,
      })
    }
    if (current < dimension.min || current > dimension.max) {
      throw invalid(`情绪投影数值超出范围: ${dimension.key}`, {
        key: dimension.key,
        value: current,
        min: dimension.min,
        max: dimension.max,
      })
    }
  }
}

/** 确定性比较：strength 桶降序 → 层级 → key 字典序。整数桶比较保证全序。 */
function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.bucket !== b.bucket) return b.bucket - a.bucket
  const byLayer = MOOD_LAYER_RANK[a.layer] - MOOD_LAYER_RANK[b.layer]
  if (byLayer !== 0) return byLayer
  if (a.key === b.key) return 0
  return a.key < b.key ? -1 : 1
}

/** 先按标签去重（同标签保留排序最靠前的），再全局排序。 */
function rankedCandidates(values: MoodValues): Candidate[] {
  const unique = new Map<string, Candidate>()
  for (const dimension of MOOD_DIMENSIONS) {
    const value = values[dimension.key]
    if (value === undefined || value <= dimension.baseline) continue
    const strength = (value - dimension.baseline) / Math.max(1, 100 - dimension.baseline)
    if (strength < MOOD_STRENGTH_THRESHOLD) continue
    const candidate: Candidate = {
      key: dimension.key,
      label: dimension.projection,
      layer: dimension.layer,
      strength,
      bucket: Math.round(strength * STRENGTH_BUCKET_SCALE),
    }
    const existing = unique.get(candidate.label)
    if (existing === undefined || compareCandidates(candidate, existing) < 0) {
      unique.set(candidate.label, candidate)
    }
  }
  return [...unique.values()].sort(compareCandidates)
}

function isCompatible(a: string, b: string): boolean {
  return a !== b && COMPATIBLE_SET.has(tonePairKey(a, b))
}

function neutralProjection(): MoodProjection {
  return Object.freeze({
    tone: MOOD_NEUTRAL_TONE,
    secondary: null,
    neutral: true,
    projectionVersion: MOOD_PROJECTION_VERSION,
  })
}

/**
 * 33 维有效值 → 主语气 + 至多一个辅助语气。
 *
 * 输入必须是完整的 33 维有限数值（loadMood 的返回形状）；未知维度、缺维、非有限值、
 * 越界值一律抛 `E_VALIDATION`，由调用方（B3-2）负责中性降级——这里不静默转 0。
 * 纯函数：不读写数据库、不调用模型、不依赖宿主运行环境。
 */
export function projectMoodTone(values: MoodValues): MoodProjection {
  assertMoodValues(values)
  const ranked = rankedCandidates(values)
  if (ranked.length === 0) return neutralProjection()

  const primary = ranked[0]!
  const second = ranked[1]
  let secondary: string | null = null
  if (second !== undefined) {
    // 差值按 1e-9 粒度取整后比较，避免浮点误差把数学上 0.10 的组合放行。
    // 设计边界是 `gap < 0.10`，再留 1e-9 安全边界 ⇒ 粒度为 1e-9 时要求 gapNanos < 1e8 - 1。
    const gapNanos = Math.round((primary.strength - second.strength) * STRENGTH_BUCKET_SCALE)
    const limitNanos = Math.round(MOOD_BLEND_GAP * STRENGTH_BUCKET_SCALE) - 1
    if (gapNanos < limitNanos && isCompatible(primary.label, second.label)) {
      secondary = second.label
    }
  }

  return Object.freeze({
    tone: primary.label,
    secondary,
    neutral: false,
    projectionVersion: MOOD_PROJECTION_VERSION,
  })
}
