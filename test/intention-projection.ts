// P6-0：Intention Projection——只读、单条、≤120 字、无播报式措辞。
import assert from 'node:assert/strict'
import { INTENTION_LINE_MAX_CHARS, projectIntention } from '../packages/core/dist/intention-projection.js'
import type { IntentionCandidate } from '../packages/core/dist/intention-candidate.js'
import type { ChoiceDecision } from '../packages/core/dist/intention-choice.js'

let passed = 0
const test = (name: string, fn: () => void): void => {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const NOW = '2026-01-10T12:00:00.000Z'
const LATER = '2026-01-11T12:00:00.000Z'

function candidate(overrides: Partial<IntentionCandidate> = {}): IntentionCandidate {
  return {
    intentionId: 'int_1',
    attentionId: 'att_1',
    kind: 'open-commitment',
    scope: { kind: 'personal' },
    title: '把相册整理完',
    score: 0.9,
    evidenceIds: ['ev_1'],
    createdAt: NOW,
    expiresAt: LATER,
    ...overrides,
  }
}

function internal(id = 'int_1'): ChoiceDecision {
  return { intentionId: id, choice: 'internal', reason: 'selected' }
}

test('没有 internal 时返回 null，不伪造念头', () => {
  const projection = projectIntention({ candidates: [candidate()], decisions: [{ intentionId: 'int_1', choice: 'defer', reason: 'lower-priority' }] })
  assert.equal(projection.line, null)
  assert.equal(projection.observeOnly, true)
})

test('选中 internal 时输出一条自然短句', () => {
  const projection = projectIntention({ candidates: [candidate()], decisions: [internal()] })
  assert.equal(projection.observeOnly, true)
  assert.equal(projection.intentionId, 'int_1')
  assert.equal(typeof projection.line, 'string')
  assert.match(projection.line!, /相册/)
  assert.match(projection.line!, /接着做/)
})

test('最多一条，且长度不超过上限', () => {
  const projection = projectIntention({ candidates: [candidate()], decisions: [internal()] })
  assert.equal((projection.line!.match(/\n/g) ?? []).length, 0)
  assert.ok(projection.line!.length <= INTENTION_LINE_MAX_CHARS)
})

test('长标题会被截断并标记 truncated', () => {
  const projection = projectIntention({ candidates: [candidate({ title: '很长的计划'.repeat(40) })], decisions: [internal()] })
  assert.equal(projection.truncated, true)
  assert.ok(projection.line!.length <= INTENTION_LINE_MAX_CHARS)
})

test('播报式措辞会被移除', () => {
  const projection = projectIntention({
    candidates: [candidate({ title: '检测到内部触发系统播报' })],
    decisions: [internal()],
  })
  assert.equal(projection.line!.includes('检测到'), false)
  assert.equal(projection.line!.includes('内部触发'), false)
  assert.equal(projection.line!.includes('系统播报'), false)
})

test('没有对应候选时返回 null', () => {
  const projection = projectIntention({ candidates: [], decisions: [internal('missing')] })
  assert.equal(projection.line, null)
  assert.equal(projection.intentionId, null)
})

test('证据引用只读回显，不新增来源', () => {
  const projection = projectIntention({ candidates: [candidate({ evidenceIds: ['ev_a', 'ev_b'] })], decisions: [internal()] })
  assert.deepEqual(projection.evidenceIds, ['ev_a', 'ev_b'])
})

test('版本号存在且 observeOnly 恒为 true', () => {
  const projection = projectIntention({ candidates: [candidate()], decisions: [internal()] })
  assert.equal(projection.version, 1)
  assert.equal(projection.observeOnly, true)
})

console.log(`intention-projection: ${passed} 通过 / 0 失败`)
