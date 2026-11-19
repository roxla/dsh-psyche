/**
 * 质量闸（Quality Guard）：一条候选内容「值不值得进长期记忆」的本地打分。
 *
 * 定位（D1-6）：
 * - 纯函数、零 IO、零模型调用；只给建议，不写库、不拦截（拦截归 Admission）；
 * - 分数**绝不参与注入排序**——排序看证据数/版本/时间/相关性，质量分只用于
 *   「归档/标注/观测」；
 * - 三档：high ≥ 60、medium 30–59、low < 30；阈值是**建议值**，等
 *   admission_observations 收到 200 条真实记录后再校准（D1-7）。
 *
 * 八类信号（扣分项，从 100 起）：
 * meta 寒暄/元信息 −45、self_reference 自指 −15、too_short 过短 −80（例外 −40）、
 * duplicate_chars 复读 −50、noise 纯噪声 −60、near_duplicate 近重复 −80（外部传入）。
 */
export const QUALITY_SCORE_START = 100
export const QUALITY_THRESHOLD_HIGH = 60
export const QUALITY_THRESHOLD_MEDIUM = 30

export type QualityLevel = 'high' | 'medium' | 'low'
export type QualitySignal =
  | 'meta'
  | 'self_reference'
  | 'too_short'
  | 'duplicate_chars'
  | 'noise'
  | 'near_duplicate'

export interface QualityAssessment {
  /** 0–100。 */
  score: number
  level: QualityLevel
  /** 命中的信号（空数组 = 没有明显问题）。 */
  signals: readonly QualitySignal[]
  /** 给人看的一句话解释；不参与排序。 */
  reason: string
}

export interface QualityOptions {
  /** 内容类型；constraint / preference 允许更短。 */
  kind?: string
  /** 与已有内容的相似度（0–1）；由调用方算好传入，本模块不算相似度。 */
  similarity?: number
  /** 允许的最短字符数（去标点后），默认 8。 */
  minChars?: number
}

const META_WORDS = [
  '嗯',
  '哦',
  '好的',
  '好',
  '收到',
  '在吗',
  '在不在',
  '哈哈',
  '哈哈哈',
  '666',
  '谢谢',
  '多谢',
  'ok',
  'okay',
  'hi',
  'hello',
  '早',
  '晚安',
  '拜拜',
  '再见',
]

const SELF_REFERENCE = [
  '作为ai',
  '作为 ai',
  '作为模型',
  '作为一个模型',
  '作为语言模型',
  '作为一个语言模型',
  '我是ai',
  '我是 ai',
  '我是人工智能',
  'i am an ai',
  'as an ai',
]

/** 短句里出现这些词时，可能是「约束/偏好」，不按寒暄打死。 */
const INTENT_WORDS = ['不', '别', '喜欢', '讨厌', '怕', '忌', '过敏', '必须', '一定要']

const PUNCT = /[\s，。！？、；：""''（）【】…—,.!?;:'"()[\]{}<>·~`@#$%^&*+=|\\/-]/g

/** 去掉空白与标点后的正文，用于长度/噪声判断。 */
export function coreText(text: string): string {
  return (text ?? '').replace(PUNCT, '')
}

/** 单字符最大占比（用于复读判断）；全同字返回 1。 */
function maxCharRatio(text: string): number {
  if (!text) return 0
  const counts = new Map<string, number>()
  let best = 0
  for (const ch of text) {
    const next = (counts.get(ch) ?? 0) + 1
    counts.set(ch, next)
    if (next > best) best = next
  }
  return best / text.length
}

/** 是否出现连续 5 个及以上同一字符。 */
function hasRepeatedRun(text: string, run = 5): boolean {
  if (text.length < run) return false
  let streak = 1
  for (let i = 1; i < text.length; i += 1) {
    streak = text[i] === text[i - 1] ? streak + 1 : 1
    if (streak >= run) return true
  }
  return false
}

function levelOf(score: number): QualityLevel {
  if (score >= QUALITY_THRESHOLD_HIGH) return 'high'
  if (score >= QUALITY_THRESHOLD_MEDIUM) return 'medium'
  return 'low'
}

/**
 * 给一条候选内容打分。
 * @param text 正文（已经过 capture 清洗）
 * @param options kind / similarity / minChars
 */
export function assessQuality(text: string, options: QualityOptions = {}): QualityAssessment {
  const signals: QualitySignal[] = []
  let score = QUALITY_SCORE_START
  const raw = (text ?? '').trim()
  const core = coreText(raw)
  const lowered = raw.toLowerCase()
  const kind = options.kind ?? ''
  const minChars = options.minChars ?? 8

  // 1. 纯噪声：去标点后为空（或只剩 1 个字符）→ 直接判 low，不再叠加别的信号。
  if (core.length <= 1) {
    return { score: 10, level: 'low', signals: ['noise'], reason: '纯标点或单字，没有可记住的信息' }
  }

  // 2. 元信息/寒暄：整句就是寒暄词（允许尾部标点）→ 停在 medium，不叠加「过短」。
  const stripped = lowered.replace(PUNCT, '')
  if (stripped && META_WORDS.some((word) => stripped === word || stripped.startsWith(word) && stripped.length <= word.length + 2)) {
    return { score: 55, level: 'medium', signals: ['meta'], reason: '寒暄/确认类内容，没有新信息' }
  }

  // 3. 自指：模型自述身份，不是关于用户/世界的事实。
  if (SELF_REFERENCE.some((word) => lowered.includes(word))) {
    signals.push('self_reference')
    score -= 15
  }

  // 4. 过短：信息量不足；约束/偏好类允许 4 字起，扣分减半。
  if (core.length < minChars && core.length > 1) {
    signals.push('too_short')
    const exempt = (kind === 'constraint' || kind === 'preference') && INTENT_WORDS.some((word) => raw.includes(word)) && core.length >= 4
    score -= exempt ? 40 : 80
  }

  // 5. 复读：连续同字，或单字符占比过高。
  if (hasRepeatedRun(core) || maxCharRatio(core) > 0.4) {
    signals.push('duplicate_chars')
    score -= 80
  }

  // 6. 近重复：相似度由调用方算好传入（P2 接 bigram 索引）。
  if (typeof options.similarity === 'number' && options.similarity > 0.85) {
    signals.push('near_duplicate')
    score -= 80
  }

  score = Math.max(0, Math.min(100, score))
  const level = levelOf(score)
  const reason = signals.length === 0 ? '没有发现明显问题' : `命中 ${signals.join(' / ')}`

  return { score, level, signals, reason }
}

/** 只是「建议归档」还是「可以进记忆」的粗判定；Admission 仍按自己的策略决定。 */
export function isWorthRemembering(assessment: QualityAssessment): boolean {
  return assessment.level !== 'low'
}
