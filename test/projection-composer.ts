import assert from 'node:assert/strict'
import {
  PROJECTION_MAX_CHARS,
  PROJECTION_MAX_TOKENS,
  PROJECTION_POLICY_VERSION,
  composeProjections,
} from '../dist/lib/projection-composer.js'
import { estimatePersonaTokens } from '../dist/lib/persona-runtime.js'

let failed = 0
let passed = 0
function check(label: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const discipline = '隐私与范围纪律：未知即拒绝。'
const persona = '我是心灵，一个有长期记忆的助手。'
const growth = '当前处于信任阶段。'
const mood = '语气平稳。'
const relationship = '与当前联系人关系普通。'

check('P1 序列化顺序 discipline→persona→growth→mood→relationship', () => {
  const result = composeProjections({ memoryDiscipline: discipline, persona: { text: persona }, growth: { text: growth }, mood: { text: mood }, relationship: { text: relationship } })
  assert.deepEqual(result.kept, ['memoryDiscipline', 'persona', 'growth', 'mood', 'relationship'])
  const order = [discipline, persona, growth, mood, relationship].map((part) => result.text.indexOf(part))
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
  assert.equal(result.text.split('\n\n').length, 5)
})

check('P1b 意愿段存在时追加在最后，且不改变必需层顺序', () => {
  const intention = '此刻的念头：想把上次没读完的书接着读完。'
  const result = composeProjections({
    memoryDiscipline: discipline,
    persona: { text: persona },
    growth: { text: growth },
    mood: { text: mood },
    relationship: { text: relationship },
    intention: { text: intention },
  })
  assert.deepEqual(result.kept, ['memoryDiscipline', 'persona', 'growth', 'mood', 'relationship', 'intention'])
  assert.ok(result.text.endsWith(intention))
})

check('P1c 预算不足时意愿段最先被丢弃', () => {
  const intention = '此刻的念头：想把上次没读完的书接着读完。'
  const full = composeProjections({
    memoryDiscipline: discipline,
    persona: { text: persona },
    growth: { text: growth },
    mood: { text: mood },
    relationship: { text: relationship },
    intention: { text: intention },
  })
  const tight = composeProjections(
    {
      memoryDiscipline: discipline,
      persona: { text: persona },
      growth: { text: growth },
      mood: { text: mood },
      relationship: { text: relationship },
      intention: { text: intention },
    },
    { maxTokens: PROJECTION_MAX_TOKENS, maxChars: full.text.length - intention.length - 2 },
  )
  assert.ok(!tight.kept.includes('intention'))
  assert.ok(tight.dropped.includes('intention'))
  assert.ok(tight.kept.includes('relationship'))
})

check('P2 全块可容纳时无告警、预算为默认值', () => {
  const result = composeProjections({ memoryDiscipline: discipline, persona: { text: persona }, growth: { text: growth }, mood: { text: mood }, relationship: { text: relationship } })
  assert.deepEqual(result.warnings, [])
  assert.equal(result.policyVersion, PROJECTION_POLICY_VERSION)
  assert.equal(result.usedChars, result.text.length)
  assert.equal(result.usedTokens, estimatePersonaTokens(result.text))
})

check('P3 超字符预算时先丢 relationship', () => {
  const four = [discipline, persona, growth, mood].join('\n\n').length
  const result = composeProjections(
    { memoryDiscipline: discipline, persona: { text: persona }, growth: { text: growth }, mood: { text: mood }, relationship: { text: relationship } },
    { maxTokens: 10_000, maxChars: four },
  )
  assert.deepEqual(result.dropped, ['relationship'])
  assert.ok(result.kept.includes('growth'))
  assert.ok(result.kept.includes('mood'))
  assert.ok(result.usedChars <= four)
})

check('P4 预算更紧时按 relationship→mood→growth 丢块', () => {
  const two = `${discipline}\n\n${persona}`.length
  const result = composeProjections(
    { memoryDiscipline: discipline, persona: { text: persona }, growth: { text: growth }, mood: { text: mood }, relationship: { text: relationship } },
    { maxTokens: 10_000, maxChars: two },
  )
  assert.deepEqual(result.dropped, ['relationship', 'mood', 'growth'])
  assert.deepEqual(result.kept, ['memoryDiscipline', 'persona'])
})

check('P5 必需层超限时人格整块省略、纪律保留', () => {
  const result = composeProjections(
    { memoryDiscipline: discipline, persona: { text: persona }, growth: { text: growth }, mood: { text: mood }, relationship: { text: relationship } },
    { maxTokens: 10_000, maxChars: discipline.length + 1 },
  )
  assert.deepEqual(result.kept, ['memoryDiscipline'])
  assert.equal(result.text, discipline)
  assert.ok(result.warnings.includes('persona-over-budget'))
  assert.ok(result.dropped.includes('growth'))
  assert.ok(!result.text.includes(persona))
  assert.equal(result.usedChars, discipline.length)
})

check('P6 人格关闭时只丢人格，其余可选块仍可保留', () => {
  const result = composeProjections({ memoryDiscipline: discipline, persona: { text: persona, enabled: false }, growth: { text: growth }, mood: { text: mood } })
  assert.deepEqual(result.kept, ['memoryDiscipline', 'growth', 'mood'])
  assert.ok(!result.text.includes(persona))
})

check('P7 空可选块不计入也不重复 dropped', () => {
  const result = composeProjections({ memoryDiscipline: discipline, persona: { text: persona }, mood: { text: '   ' } })
  assert.deepEqual(result.kept, ['memoryDiscipline', 'persona'])
  assert.deepEqual(result.dropped, ['mood'])
  assert.equal(result.text, `${discipline}\n\n${persona}`)
})

check('P8 token 估算使用同一 v1 算法且为估算', () => {
  const result = composeProjections({ memoryDiscipline: '', persona: { text: '你好' } })
  assert.equal(result.usedChars, 2)
  assert.equal(result.usedTokens, estimatePersonaTokens('你好'))
  assert.ok(result.warnings.includes('memory-discipline-missing'))
})

check('P9 默认预算常量未被越界', () => {
  assert.equal(PROJECTION_MAX_TOKENS, 6_000)
  assert.equal(PROJECTION_MAX_CHARS, 8_000)
})

check('P10 不修改输入块', () => {
  const input = { memoryDiscipline: discipline, persona: { text: persona }, growth: { text: growth } }
  const before = JSON.stringify(input)
  composeProjections(input)
  assert.equal(JSON.stringify(input), before)
})

console.log(`\n${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exit(1)
