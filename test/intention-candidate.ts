// P6-0：Intention Candidate——稳定键、上限、TTL 与证据门槛。
import assert from 'node:assert/strict'
import { buildIntentionCandidates, deriveIntentionId, INTENTION_TTL_MS, MAX_INTENTION_CANDIDATES } from '../packages/core/dist/intention-candidate.js'
import type { AttentionItem } from '../packages/core/dist/intention-attention.js'

let passed = 0
const test = (name: string, fn: () => void): void => {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const NOW = '2026-01-10T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)

function item(kind: AttentionItem['kind'], index: number, confidence = 0.5): AttentionItem {
  return {
    attentionId: `att:${kind}:${index}`,
    kind,
    scope: { kind: 'personal' },
    title: `关注 ${index}`,
    evidenceIds: [`ev_${index}`],
    confidence,
    detectedAt: NOW,
  }
}

test('空输入返回空候选', () => {
  assert.deepEqual(buildIntentionCandidates({ now: NOW, personaId: 'main', attention: [] }).candidates, [])
})

test('候选 id 与 persona/attention 稳定绑定', () => {
  const result = buildIntentionCandidates({ now: NOW, personaId: 'main', attention: [item('open-commitment', 1)] })
  assert.equal(result.candidates[0]!.intentionId, deriveIntentionId('main', 'att:open-commitment:1'))
})

test('每 Persona 最多 3 条候选并报告截断', () => {
  const attention = Array.from({ length: 5 }, (_, index) => item('open-plan', index))
  const result = buildIntentionCandidates({ now: NOW, personaId: 'main', attention })
  assert.equal(result.candidates.length, MAX_INTENTION_CANDIDATES)
  assert.equal(result.truncated, 2)
})

test('TTL 固定为 24 小时', () => {
  const result = buildIntentionCandidates({ now: NOW, personaId: 'main', attention: [item('open-plan', 1)] })
  assert.equal(Date.parse(result.candidates[0]!.expiresAt), NOW_MS + INTENTION_TTL_MS)
})

test('空证据的关注项不能变成候选', () => {
  const bad = { ...item('open-plan', 1), evidenceIds: [] }
  const result = buildIntentionCandidates({ now: NOW, personaId: 'main', attention: [bad] })
  assert.equal(result.candidates.length, 0)
  assert.equal(result.skipped.some((entry) => entry.reason === 'invalid-attention'), true)
})

test('重复 attentionId 只保留一条', () => {
  const one = item('open-plan', 1)
  const result = buildIntentionCandidates({ now: NOW, personaId: 'main', attention: [one, one] })
  assert.equal(result.candidates.length, 1)
  assert.equal(result.skipped.some((entry) => entry.reason === 'duplicate'), true)
})

test('分数按类型与可信度排序：承诺优先', () => {
  const result = buildIntentionCandidates({
    now: NOW,
    personaId: 'main',
    attention: [item('open-plan', 1, 0.9), item('open-commitment', 2, 0.1), item('idle-window', 3, 1)],
  })
  assert.equal(result.candidates[0]!.kind, 'open-commitment')
  assert.equal(result.candidates[1]!.kind, 'open-plan')
  assert.equal(result.candidates[2]!.kind, 'idle-window')
})

test('无效 now / persona 返回空集合并记录原因', () => {
  const badNow = buildIntentionCandidates({ now: 'not-a-date', personaId: 'main', attention: [item('open-plan', 1)] })
  assert.equal(badNow.candidates.length, 0)
  assert.equal(badNow.skipped[0]!.reason, 'invalid-now')
  const badPersona = buildIntentionCandidates({ now: NOW, personaId: '   ', attention: [item('open-plan', 1)] })
  assert.equal(badPersona.skipped[0]!.reason, 'invalid-persona')
})

test('候选只影响排序，不带任何 action 能力', () => {
  const result = buildIntentionCandidates({ now: NOW, personaId: 'main', attention: [item('open-plan', 1)] })
  assert.equal('action' in result.candidates[0]!, false)
  assert.equal('send' in result.candidates[0]!, false)
})

console.log(`intention-candidate: ${passed} 通过 / 0 失败`)
