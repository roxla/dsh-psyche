// P3-C-2：主动联系的 Draft——纯函数，不读库、不读系统时钟、不调模型、不发送、不持久化。
//
// 契约（docs/design/p3-c-proactive-contact.md §6）：
//   - 草稿只能引用候选里已有的证据，不得编造事实、承诺或时间；没有证据不生成草稿。
//   - 正文 ≤ 500 字；超过时用 segmentDraftText() 生成与审批完全一致的分段预览。
//   - 编辑产生新 revision，不覆盖旧稿；审批（C-3）必须绑定 revision。
//   - 内容变化导致 draftHash 变化；相同输入得到相同 hash。
//   - tone 只影响措辞，来自 P3-A 投影，不改变事实/请求/边界。

import { createHash } from 'node:crypto'
import { invalid } from './errors.js'
import type { ProactiveCandidate } from './proactive-candidate.js'

export const PROACTIVE_DRAFT_VERSION = 1

/** 草稿正文长度上限（与审批预览一致）。 */
export const MAX_DRAFT_CHARS = 500

/** 草稿最多引用的证据条数。 */
export const MAX_DRAFT_EVIDENCE = 32

export interface ProactiveDraft {
  draftId: string
  revision: number
  candidateId: string
  contactId: string
  triggerId: string
  text: string
  tone: string
  evidenceRefs: string[]
  /** 正文 + 证据 + 语气的稳定摘要；内容变化必然变化。 */
  draftHash: string
  createdAt: string
}

/** 可引用证据的最小投影：ref 来自候选，text 是允许写入草稿的事实摘要。 */
export interface ProactiveDraftEvidence {
  ref: string
  text: string
}

export interface CreateDraftInput {
  candidate: ProactiveCandidate
  text: string
  evidenceRefs: readonly (string | undefined)[]
  evidence: readonly ProactiveDraftEvidence[]
  tone?: string
  now: string
  revision?: number
}

function requireTime(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} 必须是非空 ISO 时间字符串`)
  const text = value.trim()
  if (!Number.isFinite(Date.parse(text))) throw invalid(`${field} 不是合法时间：${text}`)
  return text
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} 必须是非空字符串`)
  return value.trim()
}

function normaliseRefs(refs: unknown): string[] {
  if (!Array.isArray(refs)) throw invalid('evidenceRefs 必须是数组')
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of refs) {
    if (item === undefined || item === null || item === '') continue
    if (typeof item !== 'string') throw invalid('evidenceRefs 只能包含字符串')
    const text = item.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  if (out.length === 0) throw invalid('草稿至少需要一条证据引用')
  if (out.length > MAX_DRAFT_EVIDENCE) throw invalid(`evidenceRefs 不能超过 ${MAX_DRAFT_EVIDENCE} 条`)
  return out
}

function normaliseEvidence(list: unknown): Map<string, string> {
  if (!Array.isArray(list)) throw invalid('evidence 必须是数组')
  const map = new Map<string, string>()
  for (const item of list) {
    if (typeof item !== 'object' || item === null) throw invalid('evidence 条目必须是对象')
    const ref = requireText((item as ProactiveDraftEvidence).ref, 'evidence.ref')
    const text = requireText((item as ProactiveDraftEvidence).text, 'evidence.text')
    if (map.has(ref)) throw invalid(`证据引用重复：${ref}`)
    map.set(ref, text)
  }
  return map
}

function shortHash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32)
}

/** 草稿正文分段：每段 ≤ limit 字符；不切分单词，按原文顺序切片。 */
export function segmentDraftText(text: string, limit: number = MAX_DRAFT_CHARS): string[] {
  const value = requireText(text, 'text')
  const size = Math.floor(limit)
  if (!Number.isFinite(size) || size < 1) throw invalid('limit 必须是正整数')
  const out: string[] = []
  for (let index = 0; index < value.length; index += size) out.push(value.slice(index, index + size))
  return out
}

function draftHashOf(fields: {
  candidateId: string
  contactId: string
  triggerId: string
  tone: string
  text: string
  refs: readonly string[]
}): string {
  // 只覆盖内容；revision 不参与，否则「同一内容升 revision」无法被判为无变化。
  return shortHash([
    String(PROACTIVE_DRAFT_VERSION),
    fields.candidateId,
    fields.contactId,
    fields.triggerId,
    fields.tone,
    fields.text,
    ...fields.refs,
  ])
}

/**
 * 生成一份草稿。校验链：候选存在 → 正文非空且 ≤ 500 字 → 证据非空且都在候选中 →
 * 证据目录里都有可引用的正文 → revision 与 hash 确定。
 */
export function createProactiveDraft(input: CreateDraftInput): ProactiveDraft {
  if (typeof input !== 'object' || input === null) throw invalid('draft 输入必须是对象')
  const candidate = input.candidate
  if (typeof candidate !== 'object' || candidate === null) throw invalid('candidate 不能为空')
  const candidateId = requireText(candidate.candidateId, 'candidate.candidateId')
  const contactId = requireText(candidate.contactId, 'candidate.contactId')
  const triggerId = requireText(candidate.triggerId, 'candidate.triggerId')
  const candidateEvidence = Array.isArray(candidate.evidence) ? candidate.evidence.slice() : []

  const now = requireTime(input.now, 'now')
  const text = requireText(input.text, 'text')
  if (text.length > MAX_DRAFT_CHARS) {
    throw invalid(`草稿正文不能超过 ${MAX_DRAFT_CHARS} 字；超长请先分段预览`)
  }
  const tone = input.tone === undefined ? '' : requireText(input.tone, 'tone')
  const refs = normaliseRefs(input.evidenceRefs)

  for (const ref of refs) {
    if (!candidateEvidence.includes(ref)) throw invalid(`证据不在候选范围内：${ref}`)
  }
  const catalogue = normaliseEvidence(input.evidence)
  for (const ref of refs) {
    if (!catalogue.has(ref)) throw invalid(`缺少可引用的证据正文：${ref}`)
  }

  const revision = input.revision === undefined ? 1 : Math.floor(input.revision)
  if (!Number.isFinite(revision) || revision < 1) throw invalid('revision 必须是正整数')

  const draftHash = draftHashOf({ candidateId, contactId, triggerId, tone, text, refs })
  return Object.freeze({
    draftId: `drf_${shortHash([candidateId, contactId]).slice(0, 16)}`,
    revision,
    candidateId,
    contactId,
    triggerId,
    text,
    tone,
    evidenceRefs: Object.freeze([...refs]) as unknown as string[],
    draftHash,
    createdAt: now,
  })
}

/**
 * 编辑草稿：生成 revision + 1 的新稿，不覆盖旧稿；内容未变化时拒绝。
 * 审批方（C-3）必须绑定返回的 revision 与 draftHash。
 */
export function reviseProactiveDraft(
  previous: ProactiveDraft,
  input: Omit<CreateDraftInput, 'candidate' | 'revision' | 'now'> & { candidate: ProactiveCandidate; now: string },
): ProactiveDraft {
  if (typeof previous !== 'object' || previous === null) throw invalid('previous 不能为空')
  const next = createProactiveDraft({ ...input, revision: previous.revision + 1 })
  if (next.draftHash === previous.draftHash) throw invalid('草稿内容没有变化，不产生新 revision')
  return next
}

/** 判断一份草稿是否仍与审批时绑定的 revision/hash 一致（C-3 发送前复核用）。 */
export function draftMatchesApproval(
  draft: ProactiveDraft,
  approval: { draftId?: string; draftRevision?: number; draftHash?: string },
): boolean {
  if (typeof draft !== 'object' || draft === null) return false
  if (typeof approval !== 'object' || approval === null) return false
  if (approval.draftId !== undefined && approval.draftId !== draft.draftId) return false
  if (approval.draftRevision !== undefined && approval.draftRevision !== draft.revision) return false
  if (approval.draftHash !== undefined && approval.draftHash !== draft.draftHash) return false
  return true
}
