// P3-A B2：情绪候选的 Core 校验层（纯函数，零 IO、零模型、零随机）。
//
// 口径：docs/design/p3-a-b2-turn-judgment.md §3–§4。
//   - 候选只能来自「判定层」，Core 才拥有写入权；
//   - 候选结构异常整批拒绝，不做「丢掉坏维度继续写」；
//   - 合法数值按规则表 maxDelta 硬限幅；
//   - 证据必须属于本轮允许的消息集合。
import { MOOD_KEYS } from './mood-schema.js'

/** 规则表版本；与 mood_meta.config_version 同源，用于配置漂移检测。 */
export const MOOD_RULES_VERSION = 1

export type MoodEventType = 'user_message' | 'persona_action' | 'scheduled_event' | 'unknown'
export type MoodDirection = 'up' | 'down' | 'both'

export interface MoodRule {
  eventType: MoodEventType
  /** 该事件类型允许改的维度；空数组表示「只识别、不写入」。 */
  allowedDimensions: readonly string[]
  allowedDirection: MoodDirection
  /** 单维单次硬上限（候选层，不等于 applyMood 的单次 100）。 */
  maxDelta: number
  /** 判定层自报置信度低于阈值时整批拒绝。 */
  confidenceThreshold: number
  configVersion: number
}

/**
 * 事件规则表。
 *
 * v1 只有 `user_message` 有可写维度；persona/scheduled 来源在 DSH 侧尚无可信
 * 行为事件生产者（只有消息流），因此先冻结为空表——识别出来也不写，等 P3-C。
 */
export const MOOD_RULES: readonly MoodRule[] = Object.freeze([
  Object.freeze({
    eventType: 'user_message' as const,
    allowedDimensions: MOOD_KEYS,
    allowedDirection: 'both' as const,
    maxDelta: 8,
    confidenceThreshold: 0.5,
    configVersion: MOOD_RULES_VERSION,
  }),
  Object.freeze({
    eventType: 'persona_action' as const,
    allowedDimensions: Object.freeze([] as string[]),
    allowedDirection: 'up' as const,
    maxDelta: 4,
    confidenceThreshold: 0.7,
    configVersion: MOOD_RULES_VERSION,
  }),
  Object.freeze({
    eventType: 'scheduled_event' as const,
    allowedDimensions: Object.freeze([] as string[]),
    allowedDirection: 'both' as const,
    maxDelta: 4,
    confidenceThreshold: 0.7,
    configVersion: MOOD_RULES_VERSION,
  }),
  Object.freeze({
    eventType: 'unknown' as const,
    allowedDimensions: Object.freeze([] as string[]),
    allowedDirection: 'both' as const,
    maxDelta: 0,
    confidenceThreshold: 1,
    configVersion: MOOD_RULES_VERSION,
  }),
])

export function moodRuleOf(eventType: MoodEventType): MoodRule {
  return MOOD_RULES.find((rule) => rule.eventType === eventType) ?? MOOD_RULES[3]
}

export interface MoodCandidateDelta {
  dimension: string
  delta: number
  evidenceMessageIds: readonly string[]
}

export interface MoodCandidate {
  deltas: readonly MoodCandidateDelta[]
}

export type MoodViolationCode =
  | 'candidate-shape'
  | 'forbidden-field'
  | 'unknown-dimension'
  | 'dimension-not-allowed'
  | 'delta-not-finite'
  | 'direction-not-allowed'
  | 'delta-too-large'
  | 'evidence-missing'
  | 'evidence-not-allowed'
  | 'duplicate-dimension'
  | 'config-version-mismatch'
  | 'confidence-too-low'
  | 'empty-candidate'

export interface MoodCandidateViolation {
  code: MoodViolationCode
  dimension?: string
  detail?: string
}

export interface MoodCandidateContext {
  eventType: MoodEventType
  /** 本轮允许参与判定的消息 id；给了就要求证据非空且全部命中。 */
  allowedEvidenceIds?: readonly string[]
  /** 调用方更严的上限；与规则表取较小值。 */
  maxDelta?: number
  /** 判定层读到的配置版本；不一致整批拒绝。 */
  configVersion?: number
  /** 判定层自报置信度（0–1）；低于规则阈值整批拒绝。 */
  confidence?: number
}

export interface MoodCandidateAccepted {
  ok: true
  deltas: Record<string, number>
  evidence: Record<string, string[]>
}

export interface MoodCandidateRejected {
  ok: false
  reason: 'candidate-rejected'
  violations: MoodCandidateViolation[]
}

export type MoodCandidateValidation = MoodCandidateAccepted | MoodCandidateRejected

const TOP_LEVEL_KEYS = new Set(['deltas'])
const DELTA_KEYS = new Set(['dimension', 'delta', 'evidenceMessageIds'])
const MAX_EVIDENCE_IDS = 32

function reject(violations: MoodCandidateViolation[]): MoodCandidateRejected {
  return { ok: false, reason: 'candidate-rejected', violations }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 校验判定层交来的候选。
 *
 * 任何一处不合规都整批拒绝（返回 violations 供日志/测试），不写部分结果。
 */
export function validateMoodCandidate(candidate: unknown, ctx: MoodCandidateContext): MoodCandidateValidation {
  const rule = moodRuleOf(ctx.eventType)
  const violations: MoodCandidateViolation[] = []

  if (ctx.configVersion !== undefined && ctx.configVersion !== rule.configVersion) {
    return reject([{ code: 'config-version-mismatch', detail: `${ctx.configVersion} != ${rule.configVersion}` }])
  }
  if (ctx.confidence !== undefined && (!Number.isFinite(ctx.confidence) || ctx.confidence < rule.confidenceThreshold)) {
    return reject([{ code: 'confidence-too-low', detail: String(ctx.confidence) }])
  }
  if (!isPlainObject(candidate)) return reject([{ code: 'candidate-shape', detail: 'not an object' }])
  for (const key of Object.keys(candidate)) {
    if (!TOP_LEVEL_KEYS.has(key)) violations.push({ code: 'forbidden-field', detail: key })
  }
  const list = candidate.deltas
  if (!Array.isArray(list)) return reject([{ code: 'candidate-shape', detail: 'deltas is not an array' }])
  if (list.length === 0) {
    violations.push({ code: 'empty-candidate' })
    return reject(violations)
  }

  const allowed = new Set(MOOD_KEYS)
  const evidenceAllowed = ctx.allowedEvidenceIds === undefined ? null : new Set(ctx.allowedEvidenceIds)
  const effectiveMax = Math.min(
    rule.maxDelta,
    typeof ctx.maxDelta === 'number' && Number.isFinite(ctx.maxDelta) ? ctx.maxDelta : rule.maxDelta,
  )
  const seen = new Set<string>()
  const deltas: Record<string, number> = {}
  const evidence: Record<string, string[]> = {}

  for (const item of list) {
    if (!isPlainObject(item)) {
      violations.push({ code: 'candidate-shape', detail: 'delta entry is not an object' })
      continue
    }
    for (const key of Object.keys(item)) {
      if (!DELTA_KEYS.has(key)) violations.push({ code: 'forbidden-field', detail: key })
    }
    const dimension = typeof item.dimension === 'string' ? item.dimension : ''
    const delta = item.delta
    const ids = item.evidenceMessageIds

    if (!allowed.has(dimension)) {
      violations.push({ code: 'unknown-dimension', dimension })
      continue
    }
    if (seen.has(dimension)) {
      violations.push({ code: 'duplicate-dimension', dimension })
      continue
    }
    seen.add(dimension)
    if (!rule.allowedDimensions.includes(dimension)) {
      violations.push({ code: 'dimension-not-allowed', dimension })
      continue
    }
    if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) {
      violations.push({ code: 'delta-not-finite', dimension })
      continue
    }
    if (rule.allowedDirection === 'up' && delta < 0) {
      violations.push({ code: 'direction-not-allowed', dimension })
      continue
    }
    if (rule.allowedDirection === 'down' && delta > 0) {
      violations.push({ code: 'direction-not-allowed', dimension })
      continue
    }
    if (Math.abs(delta) > effectiveMax) {
      violations.push({ code: 'delta-too-large', dimension, detail: String(delta) })
      continue
    }
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_EVIDENCE_IDS) {
      violations.push({ code: 'evidence-missing', dimension })
      continue
    }
    const cleanIds: string[] = []
    let evidenceBad = false
    for (const id of ids) {
      if (typeof id !== 'string' || id.trim() === '') {
        evidenceBad = true
        break
      }
      const trimmed = id.trim().slice(0, 200)
      if (evidenceAllowed !== null && !evidenceAllowed.has(trimmed)) {
        violations.push({ code: 'evidence-not-allowed', dimension, detail: trimmed })
        evidenceBad = true
        break
      }
      cleanIds.push(trimmed)
    }
    if (evidenceBad) continue
    deltas[dimension] = round2(delta)
    evidence[dimension] = cleanIds
  }

  if (violations.length > 0) return reject(violations)
  return { ok: true, deltas, evidence }
}

/** 从候选里提取违反项的可读摘要（日志用，不参与判定）。 */
export function describeMoodViolations(violations: readonly MoodCandidateViolation[]): string {
  return violations
    .slice(0, 6)
    .map((item) => (item.dimension === undefined ? item.code : `${item.code}:${item.dimension}`))
    .join(',')
}
