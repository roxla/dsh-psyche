// P6-0：Intention Choice——「注意到」之后，明确选择停留、延后还是放弃。
//
// 契约（docs/design/p6-0-autonomous-intention.md）：
//   - 纯函数：不执行任何动作、不发送、不调模型、不写账本。
//   - 只有三种结果：internal（仅保留为内部关注）、defer（延后评估，附原因与下次允许条件）、
//     abandon（放弃当前候选；没有实质新证据时不得立即重新生成）。
//   - 每 Persona 同一时刻最多 1 条 internal；其余按分数稳定排序后 defer。
//   - 同一证据去重：prior 里已经内部关注/延后过同一证据，直接 abandon，避免每轮重复「新意愿」。
//   - 不提供 action 能力；调用方即使传入 allowAction 也不会被执行。

import { createHash } from 'node:crypto'
import type { IntentionCandidate } from './intention-candidate.js'

export const INTENTION_CHOICE_VERSION = 1

/** defer 之后最早允许重新评估的间隔。 */
export const DEFER_REVISIT_MS = 6 * 60 * 60 * 1000

export type IntentionChoice = 'internal' | 'defer' | 'abandon'

export type ChoiceReason =
  | 'selected'
  | 'lower-priority'
  | 'expired'
  | 'scope-unknown'
  | 'missing-evidence'
  | 'duplicate-evidence'

export interface PriorIntentionDecision {
  intentionId: string
  choice: IntentionChoice
  evidenceKey: string
}

export interface ChoiceDecision {
  intentionId: string
  choice: IntentionChoice
  reason: ChoiceReason
  /** 仅 defer 时存在：最早允许重新评估的时间。 */
  revisitAt?: string
  /** 仅 defer 时存在：重新评估必须满足的条件。 */
  revisitCondition?: string
}

export interface ChooseIntentionsInput {
  now: string
  personaId: string
  candidates: readonly IntentionCandidate[]
  prior?: readonly PriorIntentionDecision[]
  /** 显式声明不支持动作；传 true 也不会产生动作。 */
  allowAction?: boolean
}

export interface ChoiceResult {
  decisions: ChoiceDecision[]
  internal: ChoiceDecision | null
  deferred: number
  abandoned: number
}

export function evidenceKeyOf(evidenceIds: readonly string[]): string {
  const normalized = [...evidenceIds].map((id) => id.trim()).filter((id) => id.length > 0).sort()
  return createHash('sha256').update(normalized.join('|')).digest('hex').slice(0, 16)
}

function parseTime(value: string): number | null {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function validScope(candidate: IntentionCandidate): boolean {
  const scope = candidate.scope
  if (scope.kind === 'personal') return scope.id === undefined
  return (scope.kind === 'contact' || scope.kind === 'room') && typeof scope.id === 'string' && scope.id.trim().length > 0
}

export function chooseIntentions(input: ChooseIntentionsInput): ChoiceResult {
  const nowMs = parseTime(input.now)
  if (nowMs === null) {
    return { decisions: [], internal: null, deferred: 0, abandoned: 0 }
  }

  const priorByEvidence = new Map<string, PriorIntentionDecision>()
  for (const prior of input.prior ?? []) {
    if (!prior || typeof prior.evidenceKey !== 'string') continue
    priorByEvidence.set(prior.evidenceKey, prior)
  }

  const decisions: ChoiceDecision[] = []
  let internal: ChoiceDecision | null = null
  let deferred = 0
  let abandoned = 0

  const ordered = [...input.candidates].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return left.intentionId < right.intentionId ? -1 : left.intentionId > right.intentionId ? 1 : 0
  })

  for (const candidate of ordered) {
    const expiresMs = parseTime(candidate.expiresAt)
    if (expiresMs === null || nowMs >= expiresMs) {
      decisions.push({ intentionId: candidate.intentionId, choice: 'abandon', reason: 'expired' })
      abandoned += 1
      continue
    }
    if (!validScope(candidate)) {
      decisions.push({ intentionId: candidate.intentionId, choice: 'abandon', reason: 'scope-unknown' })
      abandoned += 1
      continue
    }
    if (candidate.evidenceIds.length === 0) {
      decisions.push({ intentionId: candidate.intentionId, choice: 'abandon', reason: 'missing-evidence' })
      abandoned += 1
      continue
    }

    const evidenceKey = evidenceKeyOf(candidate.evidenceIds)
    const prior = priorByEvidence.get(evidenceKey)
    if (prior && prior.intentionId !== candidate.intentionId) {
      decisions.push({ intentionId: candidate.intentionId, choice: 'abandon', reason: 'duplicate-evidence' })
      abandoned += 1
      continue
    }

    if (internal === null) {
      const decision: ChoiceDecision = { intentionId: candidate.intentionId, choice: 'internal', reason: 'selected' }
      decisions.push(decision)
      internal = decision
      continue
    }

    const revisitMs = Math.min(nowMs + DEFER_REVISIT_MS, expiresMs)
    const decision: ChoiceDecision = {
      intentionId: candidate.intentionId,
      choice: 'defer',
      reason: 'lower-priority',
      revisitAt: new Date(revisitMs).toISOString(),
      revisitCondition: '当前内部关注处理完，或候选证据出现实质变化',
    }
    decisions.push(decision)
    deferred += 1
  }

  return { decisions, internal, deferred, abandoned }
}
