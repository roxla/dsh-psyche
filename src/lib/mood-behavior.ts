/**
 * P5-4 心情行为化（mood-behavior-v1，模块级纯函数）。
 *
 * 契约见 docs/design/p5-mood-behavior-contract.md，外部评审后的冻结口径见
 * docs/design/p5-mood-behavior-implementation.md：
 *   - 33 维逐项方向（+1 / -1 / 0），不能按「越高越积极」一刀切；
 *   - 每层取绝对偏离最大的两个有效维度，按 0.7 / 0.3 聚合；
 *   - 层权 base=0.25、compound=0.30、contemporary=0.45；Mood 总贡献 0.75；
 *   - Affect 统一符号公式 + 方向权重，总贡献 0.25；
 *   - 档位滞回 ±0.35 / ±0.25，跨档一次只走一档，每 Turn 最多变化一次；
 *   - Turn 身份使用 Host `agent/pre-step` 的 payload.turn（可信单调值）。
 */

import { moodDimensionOf, type MoodValues } from 'dsh-psyche-core'

export const MOOD_BEHAVIOR_VERSION = 'mood-behavior-v1'

export type MoodBand = 'reserved' | 'balanced' | 'expressive'

export const MOOD_BAND_LABELS: Record<MoodBand, string> = {
  reserved: '克制',
  balanced: '平稳',
  expressive: '展开',
}

/** 每层只取绝对偏离最大的两个有效维度；缺失按 0 计。 */
const LAYER_WEIGHTS: Record<'basic' | 'compound' | 'contemporary', number> = {
  basic: 0.25,
  compound: 0.3,
  contemporary: 0.45,
}

const MOOD_WEIGHT = 0.75
const AFFECT_WEIGHT = 0.25

const ENTER_EXPRESSIVE = 0.35
const EXIT_EXPRESSIVE = 0.25
const ENTER_RESERVED = -0.35
const EXIT_RESERVED = -0.25

/**
 * 33 维方向。正向维度：值高于 baseline 时更像「打开/积极」；
 * 负向维度：值高于 baseline 时更像「收紧/消极」；0 表示不表达倾向。
 * 必须逐项显式，避免把所有维度升高都当成积极表达。
 */
export const MOOD_DIRECTION: Readonly<Record<string, 1 | 0 | -1>> = Object.freeze({
  // basic
  calm: 1,
  happy: 1,
  curious: 1,
  focused: 1,
  excited: 1,
  tired: -1,
  irritated: -1,
  down: -1,
  fear: -1,
  disgust: -1,
  surprised: 0,
  // compound
  wronged: -1,
  sulking: -1,
  proud: 1,
  gloomy: -1,
  anxious: -1,
  numb: -1,
  lonely: -1,
  flutter: 1,
  yearning: 1,
  jealous: -1,
  ashamed: -1,
  guilty: -1,
  awkward: -1,
  sympathy: 1,
  disappointed: -1,
  nostalgic: 1,
  coy: 1,
  conflicted: -1,
  // contemporary
  burnout: -1,
  breakdown: -1,
  lyingFlat: -1,
  hooked: 1,
})

export type AffectDim = 'warmth' | 'tension' | 'hurt' | 'missing' | 'irritation'

/** Affect 方向权重（missing 表示想念，不等于积极表达，权重 0）。 */
const AFFECT_WEIGHTS: Record<AffectDim, number> = {
  warmth: 0.45,
  tension: -0.2,
  hurt: -0.25,
  missing: 0,
  irritation: -0.1,
}

export interface MoodBehaviorInput {
  mood: MoodValues
  affect?: Partial<Record<AffectDim, number>> | null
  previousBand?: MoodBand | null
  turn?: number | null
}

export interface MoodBehaviorResult {
  band: MoodBand
  score: number
  moodScore: number
  affectScore: number
  changed: boolean
  version: typeof MOOD_BEHAVIOR_VERSION
}

/** baseline 两侧分别归一化；避免 baseline=0/100 时除零，也避免负向维度符号反转。 */
function normalizedDeviation(value: number, baseline: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) return 0
  const denominator = value >= baseline ? Math.max(1, 100 - baseline) : Math.max(1, baseline)
  return (value - baseline) / denominator
}

function clip(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 每层：方向化偏离 → 取绝对值最大的两个 → 0.7 / 0.3 聚合。 */
export function moodScore(values: MoodValues): number {
  const byLayer: Record<'basic' | 'compound' | 'contemporary', number[]> = {
    basic: [],
    compound: [],
    contemporary: [],
  }
  for (const [key, direction] of Object.entries(MOOD_DIRECTION)) {
    const dimension = moodDimensionOf(key)
    if (dimension === null || direction === 0) continue
    const raw = values[key]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    byLayer[dimension.layer].push(direction * normalizedDeviation(raw, dimension.baseline))
  }
  let total = 0
  for (const layer of ['basic', 'compound', 'contemporary'] as const) {
    const sorted = byLayer[layer].map((value) => clip(value, -1, 1)).sort((a, b) => Math.abs(b) - Math.abs(a))
    const top = sorted[0] ?? 0
    const second = sorted[1] ?? 0
    total += LAYER_WEIGHTS[layer] * (0.7 * top + 0.3 * second)
  }
  return clip(total, -1, 1)
}

/** Affect 统一符号公式：先归一化偏差，再乘方向权重，最后裁剪。 */
export function affectScore(affect?: Partial<Record<AffectDim, number>> | null): number {
  if (!affect) return 0
  let total = 0
  for (const [key, weight] of Object.entries(AFFECT_WEIGHTS) as Array<[AffectDim, number]>) {
    const value = affect[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    total += weight * clip(normalizedDeviation(value, 0), -1, 1)
  }
  return clip(total, -1, 1)
}

/**
 * 滞回档位状态。Turn 由调用方提供可信值；同一 Turn 内重复组装不会推进驻留，
 * 没有可信 Turn 时一律回到 balanced（不伪造历史）。
 */
export class MoodBehaviorState {
  #band: MoodBand = 'balanced'
  #lastTurn: number | null = null

  get band(): MoodBand {
    return this.#band
  }

  reset(): void {
    this.#band = 'balanced'
    this.#lastTurn = null
  }

  decide(score: number, turn?: number | null): { band: MoodBand; changed: boolean } {
    if (typeof turn !== 'number' || !Number.isFinite(turn)) {
      return { band: 'balanced', changed: this.#band !== 'balanced' }
    }
    if (this.#lastTurn !== null && turn === this.#lastTurn) {
      return { band: this.#band, changed: false }
    }
    if (this.#lastTurn !== null && turn < this.#lastTurn) {
      // Turn 回退（Host 异常）不推进，保持当前档位。
      return { band: this.#band, changed: false }
    }
    const previous = this.#band
    let next: MoodBand = previous
    if (previous === 'balanced') {
      if (score >= ENTER_EXPRESSIVE) next = 'expressive'
      else if (score <= ENTER_RESERVED) next = 'reserved'
    } else if (previous === 'expressive') {
      if (score <= EXIT_RESERVED) next = 'balanced'
      else if (score <= EXIT_EXPRESSIVE) next = 'balanced'
    } else {
      if (score >= ENTER_EXPRESSIVE) next = 'balanced'
      else if (score >= EXIT_RESERVED) next = 'balanced'
    }
    this.#band = next
    this.#lastTurn = turn
    return { band: next, changed: next !== previous }
  }
}

/** 组合 33 维 + Affect，得到总 score 与档位。 */
export function computeMoodBehavior(
  input: MoodBehaviorInput,
  state?: MoodBehaviorState,
): MoodBehaviorResult {
  const moodPart = moodScore(input.mood)
  const affectPart = affectScore(input.affect)
  const score = clip(MOOD_WEIGHT * moodPart + AFFECT_WEIGHT * affectPart, -1, 1)
  if (state) {
    const decided = state.decide(score, input.turn)
    return {
      band: decided.band,
      score,
      moodScore: moodPart,
      affectScore: affectPart,
      changed: decided.changed,
      version: MOOD_BEHAVIOR_VERSION,
    }
  }
  const band: MoodBand = score >= ENTER_EXPRESSIVE ? 'expressive' : score <= ENTER_RESERVED ? 'reserved' : 'balanced'
  return { band, score, moodScore: moodPart, affectScore: affectPart, changed: false, version: MOOD_BEHAVIOR_VERSION }
}

/**
 * Host 可信 Turn 时钟：只在 `agent/pre-step` 回调里记录 payload.turn。
 * 键与 `MoodBehaviorState` 一致（agentId|sessionId），保证状态隔离；
 * 重复 Turn、回退 Turn 都不推进。卸载时调用 clear()。
 */
export class MoodTurnClock {
  #turns = new Map<string, number>()

  record(agent: MoodAgentRef | null | undefined, turn: unknown): void {
    const key = moodStateKey(agent)
    if (key === null) return
    if (typeof turn !== 'number' || !Number.isFinite(turn) || turn < 0) return
    const previous = this.#turns.get(key)
    if (previous !== undefined && turn <= previous) return
    this.#turns.set(key, turn)
  }

  get(agent: MoodAgentRef | null | undefined): number | null {
    const key = moodStateKey(agent)
    if (key === null) return null
    return this.#turns.get(key) ?? null
  }

  clear(): void {
    this.#turns.clear()
  }
}

export interface MoodAgentRef {
  id?: string
  session?: { id?: string }
}

export function moodStateKey(agent: MoodAgentRef | null | undefined): string | null {
  if (!agent) return null
  const agentId = typeof agent.id === 'string' ? agent.id : ''
  const sessionId = typeof agent.session?.id === 'string' ? agent.session.id : ''
  if (agentId === '' && sessionId === '') return null
  return `${agentId}|${sessionId}`
}

/** 去掉数字与多余空白；不把数值/命令写进 prompt。 */
function sanitizeProjection(text: string): string {
  return text
    .replace(/[0-9０-９]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[。！？!?，,；;]+$/g, '')
    .trim()
}

const BAND_LINES: Record<MoodBand, string> = {
  reserved: '表达：收着说，简短克制。',
  balanced: '表达：平稳自然。',
  expressive: '表达：可以更展开一些。',
}

/**
 * 单出口 Mood 投影：档位决定表达强度，tone 只补充不冲突的情绪色彩。
 * 总长不超过 120 字符（契约上限；目标 ≤80）。
 */
export function renderMoodProjection(band: MoodBand, toneText?: string | null): string {
  const tone = sanitizeProjection(toneText ?? '')
  const bandLine = BAND_LINES[band] ?? BAND_LINES.balanced
  const merged = tone.length > 0 ? `${bandLine}${tone}。` : bandLine
  return sanitizeProjection(merged).slice(0, 120)
}
