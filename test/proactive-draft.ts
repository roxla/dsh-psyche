// P3-C-2 Draft 专测：证据约束、长度、revision/hash、审批绑定、确定性、隔离。
import assert from 'node:assert/strict'
import {
  MAX_DRAFT_CHARS,
  createProactiveDraft,
  draftMatchesApproval,
  reviseProactiveDraft,
  segmentDraftText,
} from '../packages/core/dist/proactive-draft.js'
import { buildProactiveCandidates } from '../packages/core/dist/proactive-candidate.js'
import { proactiveTriggerOf } from '../packages/core/dist/proactive-trigger.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}

function throwsValidation(run: () => unknown, label: string): void {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  check(caught instanceof Error && (caught as { code?: string }).code === 'E_VALIDATION', label)
}

const NOW = '2026-11-12T10:00:00.000Z'
const trigger = proactiveTriggerOf({ kind: 'scheduled_review', now: NOW })

function candidateFor(contactId: string, evidence: string[]) {
  const result = buildProactiveCandidates({
    trigger,
    now: NOW,
    contacts: [{ contactId, eligibility: { eligible: true, status: 'eligible', reasonCodes: [] }, evidence }],
  })
  return result.candidates[0]
}

const candidate = candidateFor('ct_a', ['src_a', 'src_b'])
const catalogue = [
  { ref: 'src_a', text: '上周聊到想去看展' },
  { ref: 'src_b', text: '她说过最近工作很忙' },
]

// 1. 基本生成
{
  const draft = createProactiveDraft({
    candidate,
    text: '上次聊到看展，最近正好有场展览，想去的话可以一起。',
    evidenceRefs: ['src_a'],
    evidence: catalogue,
    tone: '轻快',
    now: NOW,
  })
  check(draft.revision === 1, '首稿 revision 1')
  check(draft.draftId.startsWith('drf_') && draft.draftId.length > 12, 'draftId 形状正确')
  check(/^[0-9a-f]{32}$/.test(draft.draftHash), 'draftHash 是 32 位十六进制')
  check(draft.contactId === 'ct_a' && draft.candidateId === candidate.candidateId, '草稿绑定候选与联系人')
  check(draft.triggerId === trigger.triggerId, '草稿携带 triggerId')
  check(draft.evidenceRefs.length === 1 && draft.evidenceRefs[0] === 'src_a', '证据引用保留')
  check(draft.tone === '轻快', '语气保留')
}

// 2. 确定性
{
  const input = { candidate, text: '上次聊到看展。', evidenceRefs: ['src_a'], evidence: catalogue, tone: '平稳', now: NOW }
  check(createProactiveDraft(input).draftHash === createProactiveDraft(input).draftHash, '相同输入 hash 相同')
}

// 3. 证据约束
{
  throwsValidation(
    () => createProactiveDraft({ candidate, text: '随便说说。', evidenceRefs: ['src_other'], evidence: catalogue, now: NOW }),
    '引用候选之外的证据拒绝',
  )
  throwsValidation(
    () => createProactiveDraft({ candidate, text: '随便说说。', evidenceRefs: ['src_a'], evidence: [], now: NOW }),
    '缺少证据正文拒绝',
  )
  throwsValidation(
    () => createProactiveDraft({ candidate, text: '随便说说。', evidenceRefs: [], evidence: catalogue, now: NOW }),
    '无证据拒绝',
  )
  throwsValidation(
    () => createProactiveDraft({ candidate, text: '  ', evidenceRefs: ['src_a'], evidence: catalogue, now: NOW }),
    '空正文拒绝',
  )
}

// 4. 长度
{
  const long = '字'.repeat(MAX_DRAFT_CHARS)
  const draft = createProactiveDraft({ candidate, text: long, evidenceRefs: ['src_a'], evidence: catalogue, now: NOW })
  check(draft.text.length === MAX_DRAFT_CHARS, '500 字允许')
  throwsValidation(
    () => createProactiveDraft({ candidate, text: long + '字', evidenceRefs: ['src_a'], evidence: catalogue, now: NOW }),
    '501 字拒绝（要求先分段预览）',
  )
  const segments = segmentDraftText('字'.repeat(1200))
  check(segments.length === 3 && segments[0].length === 500 && segments[2].length === 200, '分段预览 500/500/200')
  check(segments.join('') === '字'.repeat(1200), '分段拼接与原文一致')
}

// 5. tone 影响 hash
{
  const base = { candidate, text: '上次聊到看展。', evidenceRefs: ['src_a'], evidence: catalogue, now: NOW }
  const a = createProactiveDraft({ ...base, tone: '平稳' })
  const b = createProactiveDraft({ ...base, tone: '轻快' })
  check(a.draftHash !== b.draftHash, '语气变化导致 hash 变化')
}

// 6. 编辑产生新 revision，不覆盖旧稿
{
  const first = createProactiveDraft({ candidate, text: '上次聊到看展。', evidenceRefs: ['src_a'], evidence: catalogue, now: NOW })
  const second = reviseProactiveDraft(first, {
    candidate,
    text: '上次聊到看展，最近有场展览。',
    evidenceRefs: ['src_a', 'src_b'],
    evidence: catalogue,
    tone: '平稳',
    now: NOW,
  })
  check(second.revision === first.revision + 1, '编辑 revision +1')
  check(second.draftId === first.draftId, '编辑不换 draftId')
  check(second.draftHash !== first.draftHash, '编辑后 hash 变化')
  check(first.revision === 1 && first.evidenceRefs.length === 1, '旧稿未被覆盖')
  throwsValidation(
    () => reviseProactiveDraft(first, { candidate, text: '上次聊到看展。', evidenceRefs: ['src_a'], evidence: catalogue, now: NOW }),
    '内容未变化拒绝新 revision',
  )
}

// 7. 审批绑定
{
  const draft = createProactiveDraft({ candidate, text: '上次聊到看展。', evidenceRefs: ['src_a'], evidence: catalogue, now: NOW })
  check(draftMatchesApproval(draft, { draftId: draft.draftId, draftRevision: draft.revision, draftHash: draft.draftHash }), '审批与草稿一致')
  check(!draftMatchesApproval(draft, { draftRevision: draft.revision + 1 }), 'revision 不一致')
  check(!draftMatchesApproval(draft, { draftHash: 'deadbeef' }), 'hash 不一致')
  check(!draftMatchesApproval(draft, { draftId: 'drf_other' }), 'draftId 不一致')
}

// 8. 跨联系人隔离
{
  const other = candidateFor('ct_b', ['src_b'])
  throwsValidation(
    () => createProactiveDraft({ candidate: other, text: '聊聊展。', evidenceRefs: ['src_a'], evidence: catalogue, now: NOW }),
    '不能引用另一联系人的证据',
  )
}

// 9. 输入校验
{
  throwsValidation(() => createProactiveDraft({ candidate, text: 'x', evidenceRefs: ['src_a'], evidence: catalogue, now: 'bad' }), '非法 now 拒绝')
  throwsValidation(() => createProactiveDraft({ candidate, text: 'x', evidenceRefs: ['src_a'], evidence: catalogue, revision: 0, now: NOW }), '非法 revision 拒绝')
}

console.log(`[P3-C-2 proactive-draft] ${passed} 通过 0 失败`)
