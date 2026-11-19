// P6-0：Intention Candidate——把关注项收敛成「想做的下一步」。
//
// 契约（docs/design/p6-0-autonomous-intention.md）：
//   - 纯函数：不读库、不调模型、不发送、不持久化、不创建 Draft/Approval/Outbox。
//   - 只有 Attention 能产生候选；证据为空、作用域非法直接跳过。
//   - 每 Persona 最多 3 条候选，TTL 24 小时；只用于运行期临时状态，不承诺跨重启恢复。
//   - 稳定候选键：同一 persona + attentionId 永远得到同一 intentionId。
//   - 排序只影响「先看哪一个」，不是权限。

import { createHash } from 'node:crypto'
import type { AttentionItem, AttentionKind } from './intention-attention.js'

export const INTENTION_CANDIDATE_VERSION = 1

/** 每个 Persona 最多保留多少条候选。 */
export const MAX_INTENTION_CANDIDATES = 3

/** 运行期临时状态的存活时间。 */
export const INTENTION_TTL_MS = 24 * 60 * 60 * 1000

const BASE_SCORE: Readonly<Record<AttentionKind, number>> = Object.freeze({
  'open-commitment': 0.9,
  'open-plan': 0.7,
  'mood-affect': 0.75,
  'recurring-theme': 0.6,
  'idle-window': 0.5,
})

export interface IntentionCandidate {
  intentionId: string
  attentionId: string
  kind: AttentionKind
  scope: AttentionItem['scope']
  title: string
  /** 0–1；只用于排序，不是权限。 */
  score: number
  evidenceIds: string[]
  createdAt: string
  expiresAt: string
}

export type CandidateSkipReason = 'invalid-now' | 'invalid-persona' | 'invalid-attention' | 'duplicate'

export interface CandidateSkip {
  attentionId: string
  reason: CandidateSkipReason
}

export interface BuildCandidatesInput {
  now: string
  personaId: string
  attention: readonly AttentionItem[]
  limit?: number
}

export interface CandidateResult {
  candidates: IntentionCandidate[]
  skipped: CandidateSkip[]
  truncated: number
}

function parseTime(value: string): number | null {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export function deriveIntentionId(personaId: string, attentionId: string): string {
  const digest = createHash('sha256').update(`${personaId}|${attentionId}`).digest('hex').slice(0, 16)
  return `int:${digest}`
}

export function buildIntentionCandidates(input: BuildCandidatesInput): CandidateResult {
  const nowMs = parseTime(input.now)
  const personaId = typeof input.personaId === 'string' ? input.personaId.trim() : ''
  if (nowMs === null) {
    return { candidates: [], skipped: [{ attentionId: '*', reason: 'invalid-now' }], truncated: 0 }
  }
  if (personaId.length === 0 || personaId.length > 200) {
    return { candidates: [], skipped: [{ attentionId: '*', reason: 'invalid-persona' }], truncated: 0 }
  }

  const limit = Math.max(1, Math.min(MAX_INTENTION_CANDIDATES, Math.trunc(input.limit ?? MAX_INTENTION_CANDIDATES)))
  const skipped: CandidateSkip[] = []
  const seen = new Set<string>()
  const candidates: IntentionCandidate[] = []

  for (const item of input.attention) {
    if (!item || typeof item.attentionId !== 'string' || item.attentionId.length === 0) {
      skipped.push({ attentionId: 'unknown', reason: 'invalid-attention' })
      continue
    }
    if (item.evidenceIds.length === 0 || item.scope === undefined) {
      skipped.push({ attentionId: item.attentionId, reason: 'invalid-attention' })
      continue
    }
    if (seen.has(item.attentionId)) {
      skipped.push({ attentionId: item.attentionId, reason: 'duplicate' })
      continue
    }
    seen.add(item.attentionId)

    const createdAt = item.detectedAt && parseTime(item.detectedAt) !== null ? item.detectedAt : input.now
    const score = BASE_SCORE[item.kind] + Math.max(0, Math.min(1, item.confidence)) * 0.2
    candidates.push({
      intentionId: deriveIntentionId(personaId, item.attentionId),
      attentionId: item.attentionId,
      kind: item.kind,
      scope: item.scope,
      title: item.title,
      score: Math.min(1, Number(score.toFixed(4))),
      evidenceIds: [...item.evidenceIds],
      createdAt,
      expiresAt: new Date(nowMs + INTENTION_TTL_MS).toISOString(),
    })
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return left.intentionId < right.intentionId ? -1 : left.intentionId > right.intentionId ? 1 : 0
  })

  const truncated = Math.max(0, candidates.length - limit)
  return { candidates: candidates.slice(0, limit), skipped, truncated }
}
