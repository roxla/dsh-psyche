// Mood 衰减纯函数（P3-A B1）。
//
// 模型：指数回落，半衰期由维度定义给出。
//   M(t) = baseline + (M0 - baseline) * 0.5 ^ (elapsed / halfLifeMs)
//
// 语义边界：
//   - 双向向 baseline 趋近（高于则回落、低于则回升，单调不过冲）——B0 §4.1 / §4.2.5；
//   - elapsed <= 0（时钟回拨、同毫秒）返回原值，不做反向计算；
//   - 读时调用，不写库——衰减是派生值，持久化的是「最后一次写入的值 + updated_at」。
import { moodDimensionOf } from './mood-schema.js'

export type MoodValues = Record<string, number>

export interface MoodDecayOptions {
  now?: number
}

/** 把数值夹到 [min, max]；非有限数按 min 处理。 */
export function clampMood(value: number, min = 0, max = 100): number {
  const numeric = Number(value)
  const safe = Number.isFinite(numeric) ? numeric : min
  return Math.min(max, Math.max(min, safe))
}

/**
 * 对单个维度做指数衰减。
 *
 * @param dimension 维度 key（必须存在于 MOOD_DIMENSIONS）
 * @param value 持久化的值
 * @param elapsedMs 距上次写入经过的毫秒数（<=0 返回原值）
 */
export function decayMoodValue(dimension: string, value: number, elapsedMs: number): number {
  const definition = moodDimensionOf(dimension)
  if (!definition) {
    throw new Error(`未知情绪维度：${dimension}`)
  }
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return definition.baseline
  const clamped = clampMood(numeric, definition.min, definition.max)
  if (!definition.decayEnabled) return clamped
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return clamped
  const factor = 0.5 ** (elapsedMs / definition.halfLifeMs)
  return clampMood(definition.baseline + (clamped - definition.baseline) * factor, definition.min, definition.max)
}

/**
 * 对一组原始值逐维衰减，返回新对象（不修改入参）。
 *
 * `updatedAt` 为空或晚于 now 时返回原值副本——读侧不能因为时钟问题把情绪算飞。
 */
export function effectiveMoodValues(raw: MoodValues, updatedAt: string | null, options: MoodDecayOptions = {}): MoodValues {
  const nowMs = Number.isFinite(options.now) ? Number(options.now) : Date.now()
  const updatedMs = updatedAt ? Date.parse(updatedAt) : Number.NaN
  const result: MoodValues = {}
  for (const [dimension, value] of Object.entries(raw)) {
    const definition = moodDimensionOf(dimension)
    if (!definition) continue
    const numeric = Number(value)
    if (!Number.isFinite(updatedMs) || nowMs <= updatedMs) {
      result[dimension] = Number.isFinite(numeric) ? numeric : definition.baseline
      continue
    }
    result[dimension] = decayMoodValue(dimension, numeric, nowMs - updatedMs)
  }
  return result
}
