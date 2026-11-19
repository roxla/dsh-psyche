// P3-C-1：主动联系的 Trigger——纯函数，不读库、不读时钟、不调模型、不发送。
//
// 契约（docs/design/p3-c-proactive-contact.md §3）：
//   - v1 只有三类触发：owner_request / scheduled_review / milestone；全部只产生候选，不产生发送。
//   - triggerId 由可信输入确定性推导：同一输入 → 同一 id；不承诺跨重启「只扫描一次」。
//   - scheduled_review 与 Mood 的 scheduled initiator 是两件事，不能互相推导。
//   - evidenceRefs 只做引用，不解析正文；空串、超长、非字符串一律拒绝，不静默丢弃。

import { createHash } from 'node:crypto'
import { invalid } from './errors.js'

export type ProactiveTriggerKind = 'owner_request' | 'scheduled_review' | 'milestone'

/** 冻结的三类触发；新增类型要改契约并升 PROACTIVE_TRIGGER_VERSION。 */
export const PROACTIVE_TRIGGER_KINDS: readonly ProactiveTriggerKind[] = Object.freeze([
  'owner_request',
  'scheduled_review',
  'milestone',
])

export const PROACTIVE_TRIGGER_VERSION = 1

/** 单次触发最多带多少条证据引用。 */
export const MAX_TRIGGER_REFS = 32

/** 单条引用最长字符数（与证据链其它 id 口径一致）。 */
export const MAX_TRIGGER_REF_CHARS = 200

export interface ProactiveTriggerInput {
  kind: ProactiveTriggerKind
  /** 触发发生时主人给定的可信时间（ISO 字符串）。 */
  now: string
  contactId?: string
  triggerId?: string
  evidenceRefs?: readonly (string | undefined)[]
}

export interface ProactiveTrigger {
  triggerId: string
  kind: ProactiveTriggerKind
  contactId?: string
  evidenceRefs: string[]
  createdAt: string
}

function requireTime(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} 必须是非空 ISO 时间字符串`)
  const text = value.trim()
  if (!Number.isFinite(Date.parse(text))) throw invalid(`${field} 不是合法时间：${text}`)
  return text
}

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalid(`${field} 必须是字符串`)
  const text = value.trim()
  if (text === '') throw invalid(`${field} 不能为空`)
  if (text.length > MAX_TRIGGER_REF_CHARS) throw invalid(`${field} 超过 ${MAX_TRIGGER_REF_CHARS} 字符`)
  return text
}

/** 规范化证据引用：去空、去重、保序、限制条数与长度；非法类型直接报错，不跳过。 */
export function normaliseTriggerRefs(refs: unknown): string[] {
  if (refs === undefined || refs === null) return []
  if (!Array.isArray(refs)) throw invalid('evidenceRefs 必须是数组')
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of refs) {
    if (item === undefined || item === null || item === '') continue
    if (typeof item !== 'string') throw invalid('evidenceRefs 只能包含字符串')
    const text = item.trim()
    if (text === '' || seen.has(text)) continue
    if (text.length > MAX_TRIGGER_REF_CHARS) throw invalid(`evidenceRefs 单条不能超过 ${MAX_TRIGGER_REF_CHARS} 字符`)
    seen.add(text)
    out.push(text)
  }
  if (out.length > MAX_TRIGGER_REFS) throw invalid(`evidenceRefs 不能超过 ${MAX_TRIGGER_REFS} 条`)
  return out
}

function shortHash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

/** 由输入确定性推导 triggerId；不读系统时钟、不依赖对象遍历顺序。 */
export function deriveTriggerId(input: ProactiveTriggerInput): string {
  const kind = input.kind
  const contactId = input.contactId ?? ''
  const now = requireTime(input.now, 'now')
  const refs = normaliseTriggerRefs(input.evidenceRefs)
  return `trg_${shortHash([String(PROACTIVE_TRIGGER_VERSION), kind, contactId, now, ...refs])}`
}

/** 校验并冻结一次触发；显式传入 triggerId 时原样采用（仍校验格式）。 */
export function proactiveTriggerOf(input: ProactiveTriggerInput): ProactiveTrigger {
  if (typeof input !== 'object' || input === null) throw invalid('trigger 输入必须是对象')
  if (!PROACTIVE_TRIGGER_KINDS.includes(input.kind)) {
    throw invalid(`未知的 trigger kind：${String(input.kind)}`)
  }
  const now = requireTime(input.now, 'now')
  const contactId = optionalId(input.contactId, 'contactId')
  const evidenceRefs = normaliseTriggerRefs(input.evidenceRefs)
  const explicit = optionalId(input.triggerId, 'triggerId')
  const triggerId = explicit ?? deriveTriggerId({ ...input, now, evidenceRefs })
  const trigger: ProactiveTrigger = {
    triggerId,
    kind: input.kind,
    evidenceRefs,
    createdAt: now,
  }
  if (contactId !== undefined) trigger.contactId = contactId
  return Object.freeze(trigger)
}

/** 候选 id 由 contactId + triggerId 确定性推导；C-1 只保证同输入同 id，不承诺跨重启一次。 */
export function deriveCandidateId(contactId: string, triggerId: string): string {
  const contact = optionalId(contactId, 'contactId')
  const trigger = optionalId(triggerId, 'triggerId')
  if (contact === undefined || trigger === undefined) throw invalid('候选 id 需要 contactId 与 triggerId')
  return `cand_${shortHash([contact, trigger])}`
}
