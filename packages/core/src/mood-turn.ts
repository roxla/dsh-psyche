// P3-A B2：每轮情绪写入编排（纯编排，不做 IO、不读消息正文）。
//
// 一次 applyMoodTurn = 判定 Initiator → 算 deltas → 走 B1 的 applyMood 事务。
// 幂等键在 Core 内部生成，调用方（插件接线层）只负责「把这一轮可信的输入交进来」。
//
// 冻结口径：docs/design/p3-a-b2-turn-evaluation.md。
//   - v1 只有 user 真正算 delta；persona / scheduled 识别来源后跳过；
//   - unknown 不产生 delta，也不写库；
//   - 无命中信号 / 空文本不写空转历史；
//   - 单维单轮上限 maxDelta（默认 8）；|delta| < 1 丢弃；
//   - reason = `turn:<sessionRef>:<turn>`，op_id 见 moodTurnOpId。
import type { Db } from './adapter.js'
import { CODE, PsycheError } from './errors.js'
import { MOOD_PERSONA_ID } from './mood-schema.js'
import { applyMood } from './mood-store.js'
import { evaluateMoodDeltas } from './mood-evaluator.js'
import { resolveMoodInitiator } from './mood-initiator.js'
import type { MoodInitiator, MoodTrustedTokens } from './mood-initiator.js'
import {
  MOOD_RULES_VERSION,
  describeMoodViolations,
  validateMoodCandidate,
} from './mood-rules.js'
import type { MoodCandidateDelta, MoodEventType } from './mood-rules.js'

const MAX_TURN_TEXT = 8000
const MAX_OP_ID = 200

export interface MoodTurnInput {
  /** 会话身份；与 recall_runs.session_ref 同一套。 */
  sessionRef: string
  /** 轮号；来自宿主 turn 事件，必须 >= 1。 */
  turn: number
  /** 这一轮真实用户消息的文本（可多段，拼接预算 8000 字符）。 */
  texts?: readonly string[]
  /** 与 texts 对齐的消息 id；缺省时由 Core 生成轮内稳定占位 id。 */
  evidenceIds?: readonly (string | undefined)[]
  /** 本轮事件类型；缺省按 user_message。 */
  eventType?: MoodEventType
  /** 判定层读到的规则表版本；与 MOOD_RULES_VERSION 不一致则整批拒绝。 */
  configVersion?: number
  /** 判定层自报置信度（0–1）；低于规则阈值则整批拒绝。 */
  confidence?: number
  /** 轮首已固化的 Initiator；给了就不再从消息重算。 */
  initiator?: MoodInitiator
  /** Core 内部可信 token（v1 无生产者，为 P3-C 预留）。 */
  tokens?: MoodTrustedTokens | null
  /** 显式覆盖真实用户消息数；默认按 texts 非空段数算。 */
  userMessageCount?: number
  maxDelta?: number
  /** 应用时间；数字按毫秒时间戳、字符串按 ISO 接收，默认 nowIso()。 */
  now?: number | string
}

export interface MoodTurnResult {
  opId: string
  initiator: MoodInitiator
  /** 是否真的写了库（重放时为 false）。 */
  applied: boolean
  /** 同 op_id 之前已写过。 */
  replayed: boolean
  /** applied / replayed / untrusted-initiator / initiator-not-user / invalid-turn /
   *  invalid-turn-key / no-content / no-signal / candidate-rejected / persona-not-initialized。 */
  reason: string
  values: Record<string, number> | null
  stateVersion: number | null
  updatedAt: string | null
  distress: boolean
  signals: string[]
  /** candidate-rejected 时的可读摘要；其它情况为空。 */
  violations?: string
}

/** `turnKey = <sessionRef>:<turn>`（B0 §3.3）。 */
export function moodTurnKey(sessionRef: string, turn: number): string {
  return `${sessionRef}:${turn}`
}

/** `op_id = mood:<persona>:<sessionRef>:<turn>`，与设计冻结审计 §2 一致。 */
export function moodTurnOpId(sessionRef: string, turn: number, personaId: string = MOOD_PERSONA_ID): string {
  return `mood:${personaId}:${moodTurnKey(sessionRef, turn)}`
}

function normalizeSessionRef(value: unknown): string {
  const sessionRef = typeof value === 'string' ? value.trim() : ''
  if (sessionRef === '') throw new PsycheError(CODE.validation, 'MoodTurn: sessionRef 不能为空')
  return sessionRef.slice(0, 200)
}

function validTurn(value: unknown): number | null {
  const turn = Number(value)
  if (!Number.isInteger(turn) || turn < 1) return null
  return turn
}

function normalizeTexts(value: readonly string[] | undefined): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  let budget = MAX_TURN_TEXT
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    if (budget <= 0) break
    out.push(text.slice(0, budget))
    budget -= text.length
  }
  return out
}

function toNowText(value: number | string | undefined): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 40)
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  return undefined
}

function skip(
  opId: string,
  initiator: MoodInitiator,
  reason: string,
  extra: Partial<Pick<MoodTurnResult, 'distress' | 'signals' | 'violations'>> = { distress: false, signals: [] },
): MoodTurnResult {
  return {
    opId,
    initiator,
    applied: false,
    replayed: false,
    reason,
    values: null,
    stateVersion: null,
    updatedAt: null,
    distress: extra.distress ?? false,
    signals: extra.signals ?? [],
    ...(extra.violations === undefined ? {} : { violations: extra.violations }),
  }
}

/**
 * 应用一轮情绪变化。
 *
 * 调用方必须先确认「这一轮已经结束、文本可信」再调用；本函数不做重试、不做定时器。
 */
export function applyMoodTurn(db: Db, input: MoodTurnInput): MoodTurnResult {
  const sessionRef = normalizeSessionRef(input?.sessionRef)
  const turn = validTurn(input?.turn)
  if (turn === null) return skip('', 'unknown', 'invalid-turn')
  const opId = moodTurnOpId(sessionRef, turn)
  if (opId.length > MAX_OP_ID) return skip(opId, 'unknown', 'invalid-turn-key')

  const texts = normalizeTexts(input?.texts)
  const userMessageCount = input?.userMessageCount ?? texts.length
  const declared = input?.initiator
  const initiator: MoodInitiator =
    declared === 'user' || declared === 'persona' || declared === 'scheduled' || declared === 'unknown'
      ? declared
      : resolveMoodInitiator({ userMessageCount, tokens: input?.tokens ?? null }).initiator
  if (initiator === 'unknown') return skip(opId, initiator, 'untrusted-initiator')
  // v1：persona / scheduled 只识别来源，不评估文本。
  if (initiator !== 'user') return skip(opId, initiator, 'initiator-not-user')
  if (texts.length === 0) return skip(opId, initiator, 'no-content')

  // 证据 id：调用方没给就生成本轮稳定占位 id（结构占位，不代表来源）。
  const fallbackIds = texts.map((_text, index) => `${moodTurnKey(sessionRef, turn)}:${index}`)
  const evidenceIds: string[] = texts.map((_text, index) => {
    const raw = Array.isArray(input?.evidenceIds) ? input.evidenceIds[index] : undefined
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim().slice(0, 200) : fallbackIds[index]
  })

  const evaluation = evaluateMoodDeltas({ texts, evidenceIds, maxDelta: input?.maxDelta })
  const extra = { distress: evaluation.distress, signals: evaluation.signals }
  if (Object.keys(evaluation.deltas).length === 0) return skip(opId, initiator, 'no-signal', extra)

  const candidate: { deltas: MoodCandidateDelta[] } = {
    deltas: Object.entries(evaluation.deltas).map(([dimension, delta]) => ({
      dimension,
      delta,
      evidenceMessageIds: evaluation.evidence[dimension] ?? evidenceIds,
    })),
  }
  const validation = validateMoodCandidate(candidate, {
    eventType: input?.eventType ?? 'user_message',
    allowedEvidenceIds: evidenceIds,
    maxDelta: input?.maxDelta,
    configVersion: input?.configVersion ?? MOOD_RULES_VERSION,
    confidence: input?.confidence,
  })
  if (!validation.ok) {
    return skip(opId, initiator, 'candidate-rejected', {
      ...extra,
      violations: describeMoodViolations(validation.violations),
    })
  }

  // |delta| < 1 视为噪声；distress 的 down:+1 正好保留。
  const deltas: Record<string, number> = {}
  for (const [key, value] of Object.entries(validation.deltas)) {
    if (Math.abs(value) >= 1) deltas[key] = value
  }
  if (Object.keys(deltas).length === 0) return skip(opId, initiator, 'no-signal', extra)

  // 未初始化（没有 persona_config）时直接跳过，不在这里建 mood 行。
  const persona = db.get<Record<string, unknown>>(
    'SELECT persona_id FROM persona_config WHERE persona_id = ?',
    [MOOD_PERSONA_ID],
  )
  if (!persona) return skip(opId, initiator, 'persona-not-initialized', extra)

  const result = applyMood(db, {
    opId,
    deltas,
    reason: `turn:${moodTurnKey(sessionRef, turn)}`,
    now: toNowText(input?.now),
  })
  return {
    opId,
    initiator,
    applied: result.applied,
    replayed: result.replayed,
    reason: result.replayed ? 'replayed' : 'applied',
    values: result.values,
    stateVersion: result.stateVersion,
    updatedAt: result.updatedAt,
    distress: evaluation.distress,
    signals: evaluation.signals,
  }
}

export type { MoodInitiator, MoodTrustedTokens } from './mood-initiator.js'
