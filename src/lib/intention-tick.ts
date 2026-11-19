/**
 * P6-2/P6-3：把已有账本派生成意愿候选，并落进 intentions 表。
 *
 * 边界（GPT 冻结的 P6-2/P6-3 约束）：
 * - 只读已有 events/event_sources/sources/mood/affect/intentions；不写 Source/Event/Artifact/Growth。
 * - 不调模型、不发送、不建 Draft/Approval/Outbox、不改 identity。
 * - 状态物化与 intention_events 追加在 reconcileIntentions 的同一事务内完成。
 * - P6-3 接入四类：未完成承诺、反复主题、空闲时段、情绪/关系偏离；
 *   open-plan 没有可靠数据源，保持 PARTIAL，不伪造。
 */
import type { Db } from 'dsh-psyche-core'
import {
  buildIntentionCandidates,
  chooseIntentions,
  evidenceKeyOf,
  listIntentions,
  reconcileIntentions,
  scanAttention,
  type PriorIntentionDecision,
} from 'dsh-psyche-core'
import { collectAttentionSignals } from './intention-providers.js'

export interface IntentionTickInput {
  db: Db
  now: string
  personaId: string
  /** 关闭时只做 TTL 过期，不产生新候选。 */
  enabled?: boolean
}

export interface IntentionTickResult {
  enabled: boolean
  attention: number
  candidates: number
  created: number
  updated: number
  expired: number
  skipped: number
  error?: string
}

function priorDecisions(db: Db, personaId: string): PriorIntentionDecision[] {
  return listIntentions(db, { personaId })
    .filter((row) => row.status === 'internal' || row.status === 'deferred')
    .map((row) => ({
      intentionId: row.intentionId,
      choice: row.status === 'internal' ? ('internal' as const) : ('defer' as const),
      evidenceKey: evidenceKeyOf(row.evidenceIds),
    }))
}

/**
 * 跑一次意愿 tick。异常一律吞掉并返回 error：turn-stopping 不能被它拖垮。
 */
export function runIntentionTick(input: IntentionTickInput): IntentionTickResult {
  const enabled = input.enabled !== false
  const empty: IntentionTickResult = {
    enabled,
    attention: 0,
    candidates: 0,
    created: 0,
    updated: 0,
    expired: 0,
    skipped: 0,
  }
  const nowMs = Date.parse(input.now)
  if (!Number.isFinite(nowMs) || input.personaId.trim().length === 0) return empty

  try {
    if (!enabled) {
      const expired = reconcileIntentions(input.db, {
        now: input.now,
        personaId: input.personaId,
        candidates: [],
        decisions: [],
      })
      return { ...empty, expired: expired.expired }
    }

    let skippedCommitments = 0
    const signals = collectAttentionSignals(input.db, input.personaId, input.now, () => {
      skippedCommitments += 1
    })
    const hasSignal =
      signals.commitments.length > 0 ||
      signals.themes.length > 0 ||
      signals.mood.length > 0 ||
      signals.affect.length > 0 ||
      signals.activity !== undefined
    if (!hasSignal) {
      const expired = reconcileIntentions(input.db, {
        now: input.now,
        personaId: input.personaId,
        candidates: [],
        decisions: [],
      })
      return { ...empty, expired: expired.expired, skipped: skippedCommitments }
    }

    const attention = scanAttention({
      now: input.now,
      commitments: signals.commitments,
      themes: signals.themes,
      activity: signals.activity,
      mood: signals.mood,
      affect: signals.affect,
    })
    const candidates = buildIntentionCandidates({
      now: input.now,
      personaId: input.personaId,
      attention: attention.items,
    })
    if (candidates.candidates.length === 0) {
      return {
        ...empty,
        attention: attention.items.length,
        skipped: skippedCommitments + attention.skipped.length,
      }
    }

    const choice = chooseIntentions({
      now: input.now,
      personaId: input.personaId,
      candidates: candidates.candidates,
      prior: priorDecisions(input.db, input.personaId),
    })
    const result = reconcileIntentions(input.db, {
      now: input.now,
      personaId: input.personaId,
      candidates: candidates.candidates,
      decisions: choice.decisions,
    })
    return {
      enabled,
      attention: attention.items.length,
      candidates: candidates.candidates.length,
      created: result.created,
      updated: result.updated,
      expired: result.expired,
      skipped: result.skipped + skippedCommitments + attention.skipped.length + candidates.skipped.length,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...empty, error: message.slice(0, 200) }
  }
}
