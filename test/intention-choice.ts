// P6-0：Intention Choice——三态选择、单条 internal、去重与不执行动作。
import assert from 'node:assert/strict'
import { chooseIntentions, evidenceKeyOf } from '../packages/core/dist/intention-choice.js'
import type { IntentionCandidate } from '../packages/core/dist/intention-candidate.js'

let passed = 0
const test = (name: string, fn: () => void): void => {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const NOW = '2026-01-10T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const LATER = new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString()

function candidate(id: string, score: number, evidence: string[] = [`ev_${id}`]): IntentionCandidate {
  return {
    intentionId: id,
    attentionId: `att_${id}`,
    kind: 'open-plan',
    scope: { kind: 'personal' },
    title: `计划 ${id}`,
    score,
    evidenceIds: evidence,
    createdAt: NOW,
    expiresAt: LATER,
  }
}

test('最高分只产生 1 条 internal，其余 defer', () => {
  const result = chooseIntentions({ now: NOW, personaId: 'main', candidates: [candidate('a', 0.9), candidate('b', 0.7)] })
  assert.equal(result.internal?.intentionId, 'a')
  assert.equal(result.decisions.filter((decision) => decision.choice === 'internal').length, 1)
  const deferred = result.decisions.find((decision) => decision.intentionId === 'b')!
  assert.equal(deferred.choice, 'defer')
  assert.equal(deferred.reason, 'lower-priority')
  assert.equal(typeof deferred.revisitAt, 'string')
  assert.equal(typeof deferred.revisitCondition, 'string')
})

test('空候选不产生任何选择', () => {
  const result = chooseIntentions({ now: NOW, personaId: 'main', candidates: [] })
  assert.equal(result.internal, null)
  assert.deepEqual(result.decisions, [])
})

test('过期候选直接 abandon', () => {
  const expired = { ...candidate('a', 0.9), expiresAt: new Date(NOW_MS - 1000).toISOString() }
  const result = chooseIntentions({ now: NOW, personaId: 'main', candidates: [expired] })
  assert.equal(result.decisions[0]!.choice, 'abandon')
  assert.equal(result.decisions[0]!.reason, 'expired')
})

test('contact scope 缺 id 直接 abandon', () => {
  const bad = { ...candidate('a', 0.9), scope: { kind: 'contact' as const } }
  const result = chooseIntentions({ now: NOW, personaId: 'main', candidates: [bad] })
  assert.equal(result.decisions[0]!.reason, 'scope-unknown')
})

test('空证据直接 abandon', () => {
  const result = chooseIntentions({ now: NOW, personaId: 'main', candidates: [candidate('a', 0.9, [])] })
  assert.equal(result.decisions[0]!.reason, 'missing-evidence')
})

test('prior 已关注同一证据时 abandon，避免每轮重复', () => {
  const current = candidate('b', 0.9, ['ev_same'])
  const prior = [{ intentionId: 'a', choice: 'internal' as const, evidenceKey: evidenceKeyOf(['ev_same']) }]
  const result = chooseIntentions({ now: NOW, personaId: 'main', candidates: [current], prior })
  assert.equal(result.decisions[0]!.choice, 'abandon')
  assert.equal(result.decisions[0]!.reason, 'duplicate-evidence')
})

test('prior 是同一条候选时不算重复证据', () => {
  const current = candidate('a', 0.9, ['ev_same'])
  const prior = [{ intentionId: 'a', choice: 'internal' as const, evidenceKey: evidenceKeyOf(['ev_same']) }]
  const result = chooseIntentions({ now: NOW, personaId: 'main', candidates: [current], prior })
  assert.equal(result.decisions[0]!.choice, 'internal')
})

test('allowAction 不会产生动作，只保留 internal', () => {
  const result = chooseIntentions({ now: NOW, personaId: 'main', candidates: [candidate('a', 0.9)], allowAction: true })
  assert.equal(result.decisions[0]!.choice, 'internal')
  assert.equal(result.decisions.some((decision) => decision.choice === ('act' as never)), false)
})

console.log(`intention-choice: ${passed} 通过 / 0 失败`)
