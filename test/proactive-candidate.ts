// P3-C-2 Candidate 专测：过滤、排序、上限、确定性、校验、无副作用。
import assert from 'node:assert/strict'
import {
  MAX_CANDIDATES_PER_SCAN,
  buildProactiveCandidates,
  candidateDigest,
  scoreProactiveCandidate,
} from '../packages/core/dist/proactive-candidate.js'
import { deriveCandidateId, proactiveTriggerOf } from '../packages/core/dist/proactive-trigger.js'

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

function eligible(contactId: string, extras: Record<string, unknown> = {}) {
  return {
    contactId,
    eligibility: { eligible: true, status: 'eligible' as const, reasonCodes: [] },
    evidence: [`src_${contactId}`],
    ...extras,
  }
}

function ineligible(contactId: string, status: 'rejected' | 'waiting', codes: string[]) {
  return {
    contactId,
    eligibility: { eligible: false, status, reasonCodes: codes },
    evidence: [`src_${contactId}`],
  }
}

// 1. 过滤：只有 eligible 才产生候选
{
  const result = buildProactiveCandidates({
    trigger,
    now: NOW,
    contacts: [
      eligible('ct_a'),
      ineligible('ct_b', 'rejected', ['no-consent']),
      ineligible('ct_c', 'waiting', ['channel-unavailable']),
    ],
  })
  check(result.candidates.length === 1, 'rejected/waiting 不进入候选')
  check(result.candidates[0].contactId === 'ct_a', '只有 eligible 进入候选')
  check(result.skipped.length === 2, '被跳过联系人如实记录')
  check(result.skipped[0].status === 'rejected' && result.skipped[0].reasonCodes[0] === 'no-consent', '拒绝原因保留')
  check(result.skipped[1].status === 'waiting', '等待状态保留（不是淘汰）')
}

// 2. 无证据不生成候选
{
  const result = buildProactiveCandidates({
    trigger,
    now: NOW,
    contacts: [{ contactId: 'ct_noev', eligibility: { eligible: true, status: 'eligible' as const, reasonCodes: [] }, evidence: [] }],
  })
  check(result.candidates.length === 0, '无证据不产生候选')
  check(result.skipped[0].reasonCodes[0] === 'no-evidence', '记录 no-evidence')
}

// 3. 排序稳定：分数降序，同分按 contactId
{
  const low = eligible('ct_low', { relationship: { affinity: 10, trust: 'unassessed' as const } })
  const high = eligible('ct_high', { relationship: { affinity: 90, trust: 'high' as const } })
  const tieB = eligible('ct_tie_b', { relationship: { affinity: 50, trust: 'medium' as const } })
  const tieA = eligible('ct_tie_a', { relationship: { affinity: 50, trust: 'medium' as const } })
  const result = buildProactiveCandidates({ trigger, now: NOW, contacts: [low, high, tieB, tieA] })
  check(result.candidates[0].contactId === 'ct_high', '高好感高信任排前')
  check(result.candidates[1].contactId === 'ct_tie_a', '同分按 contactId 字典序（a 在 b 前）')
  check(result.candidates[2].contactId === 'ct_tie_b', '同分顺序稳定')
  check(result.candidates[3].contactId === 'ct_low', '低分排后')
}

// 4. 排序只影响顺序，不影响资格（rejected 高分也不复活）
{
  const rejectedHigh = {
    contactId: 'ct_rejected',
    eligibility: { eligible: false, status: 'rejected' as const, reasonCodes: ['no-consent'] },
    evidence: ['src_x'],
    relationship: { affinity: 100, trust: 'high' as const },
  }
  const result = buildProactiveCandidates({ trigger, now: NOW, contacts: [rejectedHigh, eligible('ct_ok')] })
  check(result.candidates.length === 1 && result.candidates[0].contactId === 'ct_ok', '高 Affinity 不能让 rejected 复活')
}

// 5. 上限 20
{
  const contacts = Array.from({ length: 25 }, (_, index) => eligible(`ct_${String(index).padStart(3, '0')}`))
  const result = buildProactiveCandidates({ trigger, now: NOW, contacts })
  check(result.candidates.length === MAX_CANDIDATES_PER_SCAN, '候选截断到 20')
  check(result.truncated === 5, '截断数量如实报告')
  check(result.considered === 25, '扫描数量如实报告')
}

// 6. 确定性 id 与摘要
{
  const input = { trigger, now: NOW, contacts: [eligible('ct_id')] }
  const first = buildProactiveCandidates(input).candidates[0]
  const second = buildProactiveCandidates(input).candidates[0]
  check(first.candidateId === second.candidateId, '相同输入 candidateId 相同')
  check(first.candidateId === deriveCandidateId('ct_id', trigger.triggerId), 'candidateId 与 trigger 推导一致')
  check(candidateDigest(first) === candidateDigest(second), '相同候选摘要相同')
}

// 7. 理由推导
{
  const ownerTrigger = proactiveTriggerOf({ kind: 'owner_request', now: NOW })
  const result = buildProactiveCandidates({ trigger: ownerTrigger, now: NOW, contacts: [eligible('ct_owner')] })
  check(result.candidates[0].reason === 'owner-request', 'owner_request 推导 owner-request')
  const milestone = proactiveTriggerOf({ kind: 'milestone', now: NOW })
  const m = buildProactiveCandidates({ trigger: milestone, now: NOW, contacts: [eligible('ct_m')] })
  check(m.candidates[0].reason === 'milestone', 'milestone 推导 milestone')
  const care = buildProactiveCandidates({ trigger, now: NOW, contacts: [eligible('ct_care', { affect: 55 })] })
  check(care.candidates[0].reason === 'care', '高感受强度推导 care')
  const reconnect = buildProactiveCandidates({
    trigger,
    now: NOW,
    contacts: [eligible('ct_re', { lastInteractionAt: '2026-10-01T00:00:00.000Z' })],
  })
  check(reconnect.candidates[0].reason === 'reconnect', '长期未互动推导 reconnect')
}

// 8. 分数边界
{
  const score = scoreProactiveCandidate(
    eligible('ct_s', { relationship: { affinity: 100, trust: 'high' as const }, affect: 100, unresolvedCommitment: true }),
    proactiveTriggerOf({ kind: 'owner_request', now: NOW }),
    NOW,
  )
  check(score > 0 && score <= 100, '分数在 0–100')
  const zero = scoreProactiveCandidate(eligible('ct_z'), trigger, NOW)
  check(zero === 0, '无关系无互动分数为 0')
}

// 9. 输入校验
{
  throwsValidation(() => buildProactiveCandidates({ trigger, now: 'not-a-time', contacts: [] }), '非法 now 拒绝')
  throwsValidation(() => buildProactiveCandidates({ trigger, now: NOW, contacts: [{ contactId: '', eligibility: { eligible: true, status: 'eligible', reasonCodes: [] } }] }), '空 contactId 拒绝')
  throwsValidation(() => buildProactiveCandidates({ trigger, now: NOW, contacts: [eligible('ct_bad', { affect: 101 })] }), '越界 affect 拒绝')
  throwsValidation(() => buildProactiveCandidates({ trigger, now: NOW, contacts: [eligible('ct_bad2', { reason: 'nope' })] }), '未知 reason 拒绝')
  throwsValidation(() => buildProactiveCandidates({ trigger, now: NOW, contacts: [eligible('ct_ev', { evidence: 'src' })] }), 'evidence 非数组拒绝')
  throwsValidation(() => buildProactiveCandidates({ trigger, now: NOW, contacts: [], limit: 0 }), 'limit 0 拒绝')
  throwsValidation(() => buildProactiveCandidates({ trigger, now: NOW, contacts: [eligible('ct_long', { evidence: ['x'.repeat(201)] })] }), '超长证据引用拒绝')
}

// 10. 不修改输入
{
  const contact = eligible('ct_mut', { evidence: ['src_a', 'src_b'] })
  const before = contact.evidence.join('|')
  buildProactiveCandidates({ trigger, now: NOW, contacts: [contact] })
  check(contact.evidence.join('|') === before, '输入证据数组未被修改')
}

console.log(`[P3-C-2 proactive-candidate] ${passed} 通过 0 失败`)
