// P6-0：Attention 派生——确定性、证据门槛与五类来源边界。
import assert from 'node:assert/strict'
import { MAX_ATTENTION_ITEMS, scanAttention, type AttentionInput } from '../packages/core/dist/intention-attention.js'

let passed = 0
const test = (name: string, fn: () => void): void => {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const NOW = '2026-01-10T12:00:00.000Z'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const ago = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString()
const base = (): AttentionInput => ({ now: NOW })

test('情绪偏离不足或持续不足都不产生关注项', () => {
  const short = scanAttention({ ...base(), mood: [{ dim: 'happy', value: 50, baseline: 45, sustainedTurns: 4, evidenceIds: ['m1'] }] })
  assert.equal(short.items.length, 0)
  const brief = scanAttention({ ...base(), mood: [{ dim: 'happy', value: 70, baseline: 45, sustainedTurns: 2, evidenceIds: ['m1'] }] })
  assert.equal(brief.items.length, 0)
})

test('情绪持续偏离产生 personal 关注项并带证据', () => {
  const result = scanAttention({ ...base(), mood: [{ dim: 'happy', value: 70, baseline: 45, sustainedTurns: 3, evidenceIds: ['m1', 'm2'] }] })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]!.kind, 'mood-affect')
  assert.deepEqual(result.items[0]!.scope, { kind: 'personal' })
  assert.deepEqual(result.items[0]!.evidenceIds, ['m1', 'm2'])
})

test('Affect 强度门槛与 contact scope', () => {
  const low = scanAttention({ ...base(), affect: [{ contactId: 'ct_1', dim: 'tension', value: 39, evidenceIds: ['a1'] }] })
  assert.equal(low.items.length, 0)
  const high = scanAttention({ ...base(), affect: [{ contactId: 'ct_1', dim: 'tension', value: 40, evidenceIds: ['a1'] }] })
  assert.equal(high.items.length, 1)
  assert.deepEqual(high.items[0]!.scope, { kind: 'contact', id: 'ct_1' })
})

test('空闲只由可信的最近互动与安静起点判断', () => {
  const trusted = scanAttention({
    ...base(),
    activity: { lastInteractionAt: ago(14 * HOUR), quietSince: ago(3 * HOUR), evidenceIds: ['act1'] },
  })
  assert.equal(trusted.items.length, 1)
  assert.equal(trusted.items[0]!.kind, 'idle-window')

  const onlyLast = scanAttention({ ...base(), activity: { lastInteractionAt: ago(14 * HOUR), evidenceIds: ['act1'] } })
  assert.equal(onlyLast.items.length, 0)
  const tooShort = scanAttention({
    ...base(),
    activity: { lastInteractionAt: ago(14 * HOUR), quietSince: ago(1 * HOUR), evidenceIds: ['act1'] },
  })
  assert.equal(tooShort.items.length, 0)
})

test('未完成承诺需要超过 24h 且带证据', () => {
  const stale = scanAttention({
    ...base(),
    commitments: [{ id: 'cm_1', statement: '把回忆整理完', status: 'open', updatedAt: ago(2 * DAY), evidenceIds: ['e1'] }],
  })
  assert.equal(stale.items.length, 1)
  assert.equal(stale.items[0]!.kind, 'open-commitment')

  const fresh = scanAttention({
    ...base(),
    commitments: [{ id: 'cm_1', statement: '把回忆整理完', status: 'open', updatedAt: ago(HOUR), evidenceIds: ['e1'] }],
  })
  assert.equal(fresh.items.length, 0)
})

test('未完成计划与承诺分开记录', () => {
  const result = scanAttention({
    ...base(),
    plans: [{ id: 'pl_1', statement: '学完那本书', status: 'open', updatedAt: ago(3 * DAY), evidenceIds: ['p1'] }],
  })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]!.kind, 'open-plan')
})

test('主题反复出现的次数与时间窗', () => {
  const once = scanAttention({ ...base(), themes: [{ key: '星海', count: 2, lastSeenAt: ago(DAY), evidenceIds: ['t1'] }] })
  assert.equal(once.items.length, 0)
  const repeated = scanAttention({ ...base(), themes: [{ key: '星海', count: 3, lastSeenAt: ago(DAY), evidenceIds: ['t1'] }] })
  assert.equal(repeated.items.length, 1)
  assert.equal(repeated.items[0]!.kind, 'recurring-theme')

  const old = scanAttention({ ...base(), themes: [{ key: '星海', count: 4, lastSeenAt: ago(30 * DAY), evidenceIds: ['t1'] }] })
  assert.equal(old.items.length, 0)
})

test('证据不足被跳过并记录原因，不静默伪造', () => {
  const result = scanAttention({
    ...base(),
    commitments: [{ id: 'cm_2', statement: '空证据', status: 'open', updatedAt: ago(2 * DAY), evidenceIds: [] }],
  })
  assert.equal(result.items.length, 0)
  assert.equal(result.skipped.some((item) => item.reason === 'missing-evidence'), true)
})

test('确定性 id：同一输入两次结果一致', () => {
  const input: AttentionInput = {
    ...base(),
    commitments: [{ id: 'cm_3', statement: '同一件事', status: 'open', updatedAt: ago(2 * DAY), evidenceIds: ['e1'] }],
  }
  assert.equal(scanAttention(input).items[0]!.attentionId, scanAttention(input).items[0]!.attentionId)
})

test('上限 20 条并如实报告截断', () => {
  const themes = Array.from({ length: 25 }, (_, index) => ({
    key: `th_${index}`,
    count: 3,
    lastSeenAt: ago(DAY),
    evidenceIds: [`t${index}`],
  }))
  const result = scanAttention({ ...base(), themes })
  assert.equal(result.items.length, MAX_ATTENTION_ITEMS)
  assert.equal(result.truncated, 5)
})

test('类型顺序稳定：承诺优先于计划与主题', () => {
  const result = scanAttention({
    ...base(),
    commitments: [{ id: 'cm_1', statement: '承诺', status: 'open', updatedAt: ago(2 * DAY), evidenceIds: ['e1'] }],
    plans: [{ id: 'pl_1', statement: '计划', status: 'open', updatedAt: ago(2 * DAY), evidenceIds: ['p1'] }],
    themes: [{ key: '主题', count: 5, lastSeenAt: ago(DAY), evidenceIds: ['t1'] }],
  })
  assert.deepEqual(result.items.map((item) => item.kind), ['open-commitment', 'open-plan', 'recurring-theme'])
})

console.log(`intention-attention: ${passed} 通过 / 0 失败`)
