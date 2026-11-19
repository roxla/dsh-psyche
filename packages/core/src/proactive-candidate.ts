// P3-C-2：主动联系的 Candidate——纯函数，不读库、不读系统时钟、不调模型、不发送、不持久化。
//
// 契约（docs/design/p3-c-proactive-contact.md §5）：
//   - Candidate 不能改变 C-1 的 Eligibility 结果：只有 status === 'eligible' 的联系人才进入候选。
//   - 排序只影响「先看谁」，不是权限；Affinity / Trust / Mood 都不能让 rejected 复活。
//   - 同一输入稳定排序：分数降序，同分按 contactId 字典序，不依赖对象遍历顺序。
//   - 单次扫描最多 20 条，超出截断并如实报告。
//   - candidateId 由 contactId + triggerId 确定性推导；C-2 不承诺跨重启 exactly-once。

import { createHash } from 'node:crypto'
import { invalid } from './errors.js'
import { deriveCandidateId, type ProactiveTrigger } from './proactive-trigger.js'
import type { EligibilityResult, ProactiveRelationshipSnapshot } from './proactive-eligibility.js'

export const PROACTIVE_CANDIDATE_VERSION = 1

/** 单次扫描的候选上限。 */
export const MAX_CANDIDATES_PER_SCAN = 20

/** 单个候选最多携带多少条证据引用。 */
export const MAX_CANDIDATE_EVIDENCE = 32

/** 单条证据引用最长字符数。 */
export const MAX_CANDIDATE_REF_CHARS = 200

export type ProactiveCandidateReason = 'reconnect' | 'milestone' | 'owner-request' | 'care'

export const PROACTIVE_CANDIDATE_REASONS: readonly ProactiveCandidateReason[] = Object.freeze([
  'reconnect',
  'milestone',
  'owner-request',
  'care',
])

export interface ProactiveCandidate {
  candidateId: string
  contactId: string
  triggerId: string
  reason: ProactiveCandidateReason
  /** 只用于排序，不是权限。 */
  score: number
  evidence: string[]
  createdAt: string
}

export interface ProactiveCandidateContact {
  contactId: string
  eligibility: EligibilityResult
  relationship?: ProactiveRelationshipSnapshot
  /** 最近一次互动时间（ISO）；用于「很久没联系」排序。 */
  lastInteractionAt?: string
  /** 是否有未兑现的约定；只影响排序。 */
  unresolvedCommitment?: boolean
  /** Contact Affect 最强一维的强度（0–100）；只影响排序。 */
  affect?: number
  /** 显式指定的候选理由；缺省时按 trigger / 证据 / 间隔推导。 */
  reason?: ProactiveCandidateReason
  /** 该联系人近期可引用的证据 id；必须非空。 */
  evidence?: readonly (string | undefined)[]
}

export interface BuildCandidatesInput {
  trigger: ProactiveTrigger
  now: string
  contacts: readonly ProactiveCandidateContact[]
  limit?: number
}

export interface SkippedCandidateContact {
  contactId: string
  status: 'ineligible' | 'waiting' | 'rejected'
  reasonCodes: string[]
}

export interface CandidateScanResult {
  candidates: ProactiveCandidate[]
  considered: number
  skipped: SkippedCandidateContact[]
  truncated: number
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} 必须是非空字符串`)
  return value.trim()
}

function requireTime(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} 必须是非空 ISO 时间字符串`)
  const text = value.trim()
  if (!Number.isFinite(Date.parse(text))) throw invalid(`${field} 不是合法时间：${text}`)
  return text
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) throw invalid('候选分数必须是有限数')
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100))
}

function normaliseEvidence(refs: unknown): string[] {
  if (refs === undefined || refs === null) return []
  if (!Array.isArray(refs)) throw invalid('evidence 必须是数组')
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of refs) {
    if (item === undefined || item === null || item === '') continue
    if (typeof item !== 'string') throw invalid('evidence 只能包含字符串')
    const text = item.trim()
    if (text === '' || seen.has(text)) continue
    if (text.length > MAX_CANDIDATE_REF_CHARS) {
      throw invalid(`evidence 单条不能超过 ${MAX_CANDIDATE_REF_CHARS} 字符`)
    }
    seen.add(text)
    out.push(text)
  }
  if (out.length > MAX_CANDIDATE_EVIDENCE) throw invalid(`evidence 不能超过 ${MAX_CANDIDATE_EVIDENCE} 条`)
  return out
}

function daysBetween(now: string, since: string): number {
  return Math.max(0, (Date.parse(now) - Date.parse(since)) / 86_400_000)
}

function trustScore(trust: ProactiveRelationshipSnapshot['trust'] | undefined): number {
  switch (trust) {
    case 'high':
      return 20
    case 'medium':
      return 12
    case 'low':
      return 5
    default:
      return 0
  }
}

function deriveReason(input: ProactiveCandidateContact, trigger: ProactiveTrigger, now: string): ProactiveCandidateReason {
  if (input.reason !== undefined) {
    if (!PROACTIVE_CANDIDATE_REASONS.includes(input.reason)) {
      throw invalid(`未知的候选理由：${String(input.reason)}`)
    }
    return input.reason
  }
  if (trigger.kind === 'owner_request') return 'owner-request'
  if (trigger.kind === 'milestone') return 'milestone'
  if (typeof input.affect === 'number' && input.affect >= 40) return 'care'
  if (input.lastInteractionAt !== undefined && daysBetween(now, requireTime(input.lastInteractionAt, 'lastInteractionAt')) >= 14) {
    return 'reconnect'
  }
  return 'care'
}

/**
 * 计算候选排序分数（0–100）。分数只是优先级，不是资格、同意或审批的替代。
 * 只读输入，不产生副作用。
 */
export function scoreProactiveCandidate(
  input: ProactiveCandidateContact,
  trigger: ProactiveTrigger,
  now: string,
): number {
  const affinity = input.relationship?.affinity
  if (affinity !== undefined && (typeof affinity !== 'number' || !Number.isFinite(affinity))) {
    throw invalid('relationship.affinity 必须是有限数')
  }
  const affinityScore = Math.max(0, Math.min(100, affinity ?? 0)) * 0.3

  const trust = trustScore(input.relationship?.trust)

  let recency = 0
  if (input.lastInteractionAt !== undefined) {
    const days = daysBetween(now, requireTime(input.lastInteractionAt, 'lastInteractionAt'))
    recency = Math.min(20, days * 1.5)
  }

  const affect = input.affect ?? 0
  if (typeof affect !== 'number' || !Number.isFinite(affect) || affect < 0 || affect > 100) {
    throw invalid('affect 必须是 0–100 的有限数')
  }
  const affectScore = affect * 0.15

  const commitmentScore = input.unresolvedCommitment === true ? 8 : 0
  const ownerBoost = trigger.kind === 'owner_request' ? 15 : 0

  return clampScore(affinityScore + trust + recency + affectScore + commitmentScore + ownerBoost)
}

/**
 * 由合格联系人构建候选。只接受 C-1 判定为 eligible 的联系人；
 * rejected / waiting 一律不产生候选（原因码如实返回供审计）。
 */
export function buildProactiveCandidates(input: BuildCandidatesInput): CandidateScanResult {
  if (typeof input !== 'object' || input === null) throw invalid('candidate 输入必须是对象')
  const trigger = input.trigger
  if (typeof trigger !== 'object' || trigger === null) throw invalid('trigger 不能为空')
  const triggerId = requireText(trigger.triggerId, 'trigger.triggerId')
  const now = requireTime(input.now, 'now')
  const limit = input.limit === undefined ? MAX_CANDIDATES_PER_SCAN : Math.floor(input.limit)
  if (!Number.isFinite(limit) || limit < 1) throw invalid('limit 必须是正整数')
  const cap = Math.min(MAX_CANDIDATES_PER_SCAN, limit)
  if (!Array.isArray(input.contacts)) throw invalid('contacts 必须是数组')

  const skipped: SkippedCandidateContact[] = []
  const built: ProactiveCandidate[] = []

  for (const contact of input.contacts) {
    const contactId = requireText(contact?.contactId, 'contact.contactId')
    const eligibility = contact.eligibility
    if (typeof eligibility !== 'object' || eligibility === null) throw invalid('eligibility 不能为空')
    if (eligibility.eligible !== true || eligibility.status !== 'eligible') {
      skipped.push({
        contactId,
        status: eligibility.status === 'waiting' ? 'waiting' : 'rejected',
        reasonCodes: Array.isArray(eligibility.reasonCodes) ? eligibility.reasonCodes.map(String) : [],
      })
      continue
    }
    const evidence = normaliseEvidence(contact.evidence)
    if (evidence.length === 0) {
      // 没有可引用证据的合格联系人也不能形成候选：草稿不得凭空编造。
      skipped.push({ contactId, status: 'ineligible', reasonCodes: ['no-evidence'] })
      continue
    }
    const reason = deriveReason(contact, trigger, now)
    built.push({
      candidateId: deriveCandidateId(contactId, triggerId),
      contactId,
      triggerId,
      reason,
      score: scoreProactiveCandidate(contact, trigger, now),
      evidence,
      createdAt: now,
    })
  }

  built.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.contactId.localeCompare(b.contactId)))
  const truncated = Math.max(0, built.length - cap)
  const candidates = built.slice(0, cap)

  return { candidates, considered: input.contacts.length, skipped, truncated }
}

/** 候选内容的稳定摘要（不含时间，便于测试与审计）；不用于任何权限判断。 */
export function candidateDigest(candidate: ProactiveCandidate): string {
  const parts = [
    String(PROACTIVE_CANDIDATE_VERSION),
    candidate.candidateId,
    candidate.contactId,
    candidate.triggerId,
    candidate.reason,
    String(candidate.score),
    ...candidate.evidence,
  ]
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32)
}
