// P6-0：Intention Projection——只读投影产物，不注册 Context、不注入模型。
//
// 契约（docs/design/p6-0-autonomous-intention.md）：
//   - 最多 1 条，≤120 字；没有选中的 internal 时返回 null，不伪造念头。
//   - observeOnly 恒为 true；后续只能经 PsycheProjectionComposer 的可选分段接入。
//   - 不出现「检测到」「内部触发」「系统」这类播报式措辞；预算不足时由调用方先舍弃本段。
//   - 证据、scope 由上游保证已过 Scope/Disclosure 校验；这里只做文案裁剪。

import type { IntentionCandidate } from './intention-candidate.js'
import type { ChoiceDecision } from './intention-choice.js'

export const INTENTION_PROJECTION_VERSION = 1

/** 「此刻的念头」最多多少字符。 */
export const INTENTION_LINE_MAX_CHARS = 120

const BANNED_PHRASES = ['检测到', '内部触发', '系统播报', '触发已生成'] as const

export interface IntentionProjection {
  version: number
  observeOnly: true
  /** 没有 internal 选项时为 null。 */
  line: string | null
  intentionId: string | null
  evidenceIds: string[]
  truncated: boolean
}

export interface ProjectIntentionInput {
  candidates: readonly IntentionCandidate[]
  decisions: readonly ChoiceDecision[]
  maxChars?: number
}

function sanitize(text: string): string {
  let next = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  for (const phrase of BANNED_PHRASES) next = next.split(phrase).join('')
  return next.replace(/\s+/g, ' ').trim()
}

function lineFor(candidate: IntentionCandidate): string {
  const title = sanitize(candidate.title)
  switch (candidate.kind) {
    case 'open-commitment':
      return `想把「${title}」这件事接着做一点。`
    case 'open-plan':
      return `想继续「${title}」的计划。`
    case 'mood-affect':
      return '想先照顾一下现在的感受，再决定下一步。'
    case 'recurring-theme':
      return `又想到「${title}」，想再看看。`
    case 'idle-window':
      return '这段安静里，想找点喜欢的事做。'
    default:
      return '想接着处理一件还没放下的事。'
  }
}

export function projectIntention(input: ProjectIntentionInput): IntentionProjection {
  const maxChars = Math.max(20, Math.min(INTENTION_LINE_MAX_CHARS, Math.trunc(input.maxChars ?? INTENTION_LINE_MAX_CHARS)))
  const internal = input.decisions.find((decision) => decision.choice === 'internal')
  if (!internal) {
    return {
      version: INTENTION_PROJECTION_VERSION,
      observeOnly: true,
      line: null,
      intentionId: null,
      evidenceIds: [],
      truncated: false,
    }
  }
  const candidate = input.candidates.find((item) => item.intentionId === internal.intentionId)
  if (!candidate) {
    return {
      version: INTENTION_PROJECTION_VERSION,
      observeOnly: true,
      line: null,
      intentionId: null,
      evidenceIds: [],
      truncated: false,
    }
  }

  const raw = lineFor(candidate)
  const truncated = raw.length > maxChars
  const line = truncated ? `${raw.slice(0, Math.max(0, maxChars - 1))}…` : raw
  return {
    version: INTENTION_PROJECTION_VERSION,
    observeOnly: true,
    line,
    intentionId: candidate.intentionId,
    evidenceIds: [...candidate.evidenceIds],
    truncated,
  }
}
