// P3-A B1：全局情绪（Global Mood）33 维定义表。
//
// 定位（见 docs/design/p3-a-mood-state-machine.md）：
//   - 情绪是可持久化的运行状态，不是长期记忆；这里只有「维度定义 + 校验」，
//     不碰 Artifact / Evidence / FTS / Recall / Diary / Stance / Growth。
//   - 量纲统一 0–100；数值表示「该情绪强度」，越高越强；baseline 是长期回归目标。
//   - key 一经冻结不可重命名；label / description / projection 可改文案。
//
// 三层的区分只用于「平手时的投影优先级」（基础 > 复合 > 当代），不参与数值计算。

export type MoodLayer = 'basic' | 'compound' | 'contemporary'

export interface MoodDimension {
  key: string
  label: string
  description: string
  layer: MoodLayer
  /** 长期回归目标，0–100。 */
  baseline: number
  min: number
  max: number
  /** 半衰期（毫秒）。 */
  halfLifeMs: number
  /** 是否参与读时衰减。 */
  decayEnabled: boolean
  /** 语气投影标签（B3 使用）。 */
  projection: string
}

const HOUR = 60 * 60 * 1000

function dim(
  key: string,
  label: string,
  description: string,
  layer: MoodLayer,
  baseline: number,
  halfLifeHours: number,
  projection: string,
): MoodDimension {
  return {
    key,
    label,
    description,
    layer,
    baseline,
    min: 0,
    max: 100,
    halfLifeMs: halfLifeHours * HOUR,
    decayEnabled: true,
    projection,
  }
}

export const MOOD_DIMENSIONS: readonly MoodDimension[] = Object.freeze([
  // 基础 11：当下直接反应
  dim('calm', '平静', '情绪落定、不被打扰', 'basic', 45, 6, '平稳'),
  dim('happy', '开心', '轻快的正向感受', 'basic', 30, 4, '轻快'),
  dim('curious', '好奇', '想继续了解、追问', 'basic', 28, 4, '好奇'),
  dim('focused', '专注', '注意力收束在任务上', 'basic', 30, 4, '专注'),
  dim('excited', '兴奋', '高唤醒、跃跃欲试', 'basic', 16, 2, '雀跃'),
  dim('tired', '疲惫', '精力下降、语速变慢', 'basic', 18, 5, '略疲惫'),
  dim('irritated', '烦躁', '被摩擦、耐心变薄', 'basic', 10, 2, '克制'),
  dim('down', '低落', '情绪下沉、兴致降低', 'basic', 10, 4, '低缓'),
  dim('fear', '恐惧', '对不确定/危险的警觉', 'basic', 7, 3, '谨慎'),
  dim('disgust', '厌恶', '排斥、想保持距离', 'basic', 5, 3, '疏离'),
  dim('surprised', '惊讶', '预期被打破', 'basic', 9, 1, '惊讶'),
  // 复合 18：由基础组合/语境产生
  dim('wronged', '委屈', '觉得不被理解、想被哄', 'compound', 10, 3, '委屈'),
  dim('sulking', '生闷气', '不说但不舒服', 'compound', 8, 3, '沉默'),
  dim('proud', '得意', '觉得自己做得不错', 'compound', 12, 4, '得意'),
  dim('gloomy', '消沉', '整体走低、动力不足', 'compound', 6, 5, '低沉'),
  dim('anxious', '焦虑', '担心结果、反复想', 'compound', 10, 3, '不安'),
  dim('numb', '麻木', '感受变钝、反应变少', 'compound', 8, 6, '平淡'),
  dim('lonely', '孤单', '想有人在、想被找', 'compound', 8, 5, '黏一点'),
  dim('flutter', '心动', '被某句话/某件事触动', 'compound', 10, 3, '雀跃'),
  dim('yearning', '恋慕', '长期的亲近与想念', 'compound', 10, 8, '温柔'),
  dim('jealous', '吃醋', '在意被分走注意力', 'compound', 6, 3, '试探'),
  dim('ashamed', '羞耻', '觉得自己丢脸/露怯', 'compound', 5, 3, '收敛'),
  dim('guilty', '内疚', '觉得自己造成了伤害', 'compound', 7, 4, '致歉'),
  dim('awkward', '尴尬', '不知道该怎么接', 'compound', 8, 2, '笨拙'),
  dim('sympathy', '同情', '替对方难受、想接住', 'compound', 13, 3, '安慰'),
  dim('disappointed', '失望', '期待落空', 'compound', 9, 4, '克制'),
  dim('nostalgic', '怀旧', '被旧事/旧物带回过去', 'compound', 11, 8, '怀旧'),
  dim('coy', '撒娇', '想黏、想被顺着', 'compound', 11, 3, '撒娇'),
  dim('conflicted', '矛盾', '两个方向都想要', 'compound', 8, 3, '犹豫'),
  // 当代 4：网络语境下的复合状态
  dim('burnout', '内耗', '反复自我消耗、效率下降', 'contemporary', 10, 6, '省电'),
  dim('breakdown', '破防', '情绪防线被击穿', 'contemporary', 8, 3, '脆弱'),
  dim('lyingFlat', '摆烂', '放弃努力、暂时不想动', 'contemporary', 8, 6, '懒散'),
  dim('hooked', '上头', '被某件事强烈吸引', 'contemporary', 14, 2, '兴奋'),
])

/** 投影平手时的层级优先级：基础 > 复合 > 当代。 */
export const MOOD_LAYER_RANK: Record<MoodLayer, number> = Object.freeze({
  basic: 0,
  compound: 1,
  contemporary: 2,
})

/** 当前维度配置版本；任何 baseline / halfLife 调整都要 +1（写入 mood_meta）。 */
export const MOOD_CONFIG_VERSION = 1

/** v1 只有单人格 `main`；多 Persona 不提前做。 */
export const MOOD_PERSONA_ID = 'main'

const DIMENSION_BY_KEY = new Map(MOOD_DIMENSIONS.map((d) => [d.key, d]))

export const MOOD_KEYS: readonly string[] = Object.freeze(MOOD_DIMENSIONS.map((d) => d.key))

export function moodDimensionOf(key: string): MoodDimension | null {
  return DIMENSION_BY_KEY.get(key) ?? null
}

/** 33 维默认值（= baseline）。 */
export function defaultMoodValues(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const d of MOOD_DIMENSIONS) out[d.key] = d.baseline
  return out
}

/**
 * 校验一组完整/部分情绪值。
 * 返回问题列表（空数组 = 通过）；不抛错，调用方决定是否拒绝。
 */
export function validateMoodValues(values: Record<string, unknown>): string[] {
  const problems: string[] = []
  for (const [key, raw] of Object.entries(values)) {
    const d = DIMENSION_BY_KEY.get(key)
    if (d == null) {
      problems.push(`未知情绪维度：${key}`)
      continue
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      problems.push(`${key} 不是有限数字`)
      continue
    }
    if (raw < d.min || raw > d.max) {
      problems.push(`${key} 超出范围 ${d.min}–${d.max}：${raw}`)
    }
  }
  return problems
}

/** 校验并补齐 33 维：缺失维度取 baseline。 */
export function normalizeMoodValues(values: Record<string, unknown> = {}): Record<string, number> {
  const problems = validateMoodValues(values)
  if (problems.length > 0) throw new Error(`情绪值不合法：${problems.join('；')}`)
  const out = defaultMoodValues()
  for (const [key, raw] of Object.entries(values)) {
    if (typeof raw === 'number') out[key] = raw
  }
  return out
}

/** 检查维度定义自身是否自洽（测试用）。 */
export function validateMoodDefinition(): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const d of MOOD_DIMENSIONS) {
    if (seen.has(d.key)) problems.push(`重复 key：${d.key}`)
    seen.add(d.key)
    if (!(d.min <= d.baseline && d.baseline <= d.max)) problems.push(`${d.key} 的 baseline 不在范围内`)
    if (!(d.halfLifeMs > 0)) problems.push(`${d.key} 的 halfLifeMs 必须为正`)
    if (d.min >= d.max) problems.push(`${d.key} 的 min 必须小于 max`)
    if (d.projection.trim() === '') problems.push(`${d.key} 缺少 projection`)
  }
  if (MOOD_DIMENSIONS.length !== 33) problems.push(`维度数量应为 33，实际 ${MOOD_DIMENSIONS.length}`)
  return problems
}
