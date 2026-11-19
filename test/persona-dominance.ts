/**
 * P7-1：人格主导（Section + waterfall 改写 + 表达约束）自检。
 *
 * 跑法：`node test/persona-dominance.ts`（要求先 `npm run build`）。
 */
import {
  HOST_DISCIPLINE_TEXT,
  PERSONA_EXPRESSION_NAME,
  PERSONA_EXPRESSION_TEXT,
  PERSONA_SECTION_NAME,
  createPersonaDominance,
  expressionTextFor,
  injectDominanceSections,
} from '../dist/lib/persona-dominance.js'
import type { PersonaProjection } from '../dist/lib/persona-runtime.js'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`)
  }
}

const ready: PersonaProjection = {
  status: 'ready',
  text: '我是大肥鱼，一条普通的鲸鱼娘。',
  hash: 'a'.repeat(64),
  chars: 15,
  tokens: 20,
}

function make(options?: {
  enabled?: boolean
  dominance?: boolean
  bound?: boolean
  projection?: PersonaProjection
}) {
  return createPersonaDominance({
    enabled: () => options?.enabled !== false,
    dominance: () => options?.dominance === true,
    resolveAgent: (agent) => Boolean(options?.bound) && agent?.id === 'agent-1',
    read: () => options?.projection ?? ready,
  })
}

function assembly(sections: Array<{ name: string; text: string }>) {
  return { sections, contexts: [], tools: [], variables: {} }
}

const agent = { id: 'agent-1', session: { id: 's1' } }

const disabled = make({ dominance: true, bound: true, enabled: false })({ agent })
check('enabled=false 不生效', disabled === null)

const off = make({ dominance: false, bound: true })({ agent })
check('dominance=false 不生效', off === null)

const unbound = make({ dominance: true, bound: false })({ agent })
check('未绑定 Agent 不生效', unbound === null)

const pending = make({
  dominance: true,
  bound: true,
  projection: { status: 'uninitialized' },
})({ agent })
check('未锁定人格不生效', pending === null)

const active = make({ dominance: true, bound: true })({ agent })
check('ready 返回原文', active?.text === ready.text, active)
check('表达式段 ≤120 字', PERSONA_EXPRESSION_TEXT.length <= 120, PERSONA_EXPRESSION_TEXT.length)
check('表达式段含结论优先', PERSONA_EXPRESSION_TEXT.includes('结论'))
check('reserved 表达收着', expressionTextFor('reserved').includes('短句'))
check('expressive 表达更放松', expressionTextFor('expressive').includes('放松'))
check('balanced 用默认表达', expressionTextFor('balanced') === PERSONA_EXPRESSION_TEXT)
check('三档表达都不超 120 字', ['reserved', 'balanced', 'expressive'].every((band) => expressionTextFor(band).length <= 120))

const target = assembly([
  { name: 'harness:identity', text: 'harness' },
  { name: 'deployment:persona-prefix', text: 'You are a coding agent powered by the {{model}} model.' },
  { name: 'team:policy', text: 'tools' },
])
const injected = injectDominanceSections(target.sections, ready.text, expressionTextFor('balanced'))
check('原子注入成功', injected !== null)
const host = injected?.[2]
check('prefix 段被替换为纪律句', host?.text === HOST_DISCIPLINE_TEXT, host?.text)
check('纪律句不含人格原文', !String(host?.text).includes(ready.text), host?.text)
check('人格段插在宿主身份句之前', injected?.[1]?.name === PERSONA_SECTION_NAME && injected?.[1]?.text === ready.text)
const personaHits = (injected ?? []).filter((item) => item.text.includes(ready.text)).length
check('整段人格只出现一次', personaHits === 1, personaHits)
check('工具段不受影响', injected?.[3]?.name === 'team:policy' && injected?.[3]?.text === 'tools')
check('表达段在末尾', injected?.[4]?.name === PERSONA_EXPRESSION_NAME && injected?.[4]?.text === PERSONA_EXPRESSION_TEXT)
check('输入数组未被修改', target.sections.length === 3 && target.sections[1].text.includes('coding agent'))

const suffix = assembly([
  { name: 'deployment:persona-prefix', text: 'You are a coding agent powered by the {{model}} model.' },
  { name: 'deployment:persona-suffix', text: 'suffix' },
])
const withSuffix = injectDominanceSections(suffix.sections, ready.text, expressionTextFor('balanced'))
check(
  '表达段插在 persona-suffix 之前',
  withSuffix?.[0]?.name === PERSONA_SECTION_NAME &&
    withSuffix?.[2]?.name === PERSONA_EXPRESSION_NAME &&
    withSuffix?.[3]?.name === 'deployment:persona-suffix',
  withSuffix?.map((item) => item.name),
)

const noExpression = injectDominanceSections(
  assembly([{ name: 'deployment:persona-prefix', text: 'You are a coding agent powered by the {{model}} model.' }]).sections,
  ready.text,
  '',
)
check('表达为空时不追加表达段', noExpression?.length === 2 && noExpression[0].name === PERSONA_SECTION_NAME)

const noPrefix = assembly([{ name: 'harness:identity', text: 'h' }])
check('无 prefix 段时原子失败', injectDominanceSections(noPrefix.sections, ready.text, 'x') === null)
check('失败时原数组不变', noPrefix.sections.length === 1)

const duplicated = assembly([
  { name: 'deployment:persona-prefix', text: 'You are a coding agent powered by the {{model}} model.' },
  { name: 'deployment:persona-prefix', text: 'b' },
])
check('重复 prefix 段拒绝注入', injectDominanceSections(duplicated.sections, ready.text, 'x') === null)
check('重复 prefix 时原样保留', duplicated.sections[0].text.includes('coding agent') && duplicated.sections[1].text === 'b')

const unknownText = assembly([{ name: 'deployment:persona-prefix', text: 'Something else' }])
check('未知 prefix 文案拒绝注入', injectDominanceSections(unknownText.sections, ready.text, 'x') === null)

const alreadyInjected = assembly([
  { name: PERSONA_SECTION_NAME, text: 'old' },
  { name: 'deployment:persona-prefix', text: 'You are a coding agent powered by the {{model}} model.' },
])
check('已有同名人格段拒绝重复注入', injectDominanceSections(alreadyInjected.sections, ready.text, 'x') === null)

const emptyPersona = injectDominanceSections(
  assembly([{ name: 'deployment:persona-prefix', text: 'You are a coding agent powered by the {{model}} model.' }]).sections,
  '',
  'x',
)
check('空人格拒绝注入', emptyPersona === null)

const drift = make({
  dominance: true,
  bound: true,
  projection: { status: 'drift' } as PersonaProjection,
})({ agent })
check('identity drift 不生效', drift === null)

let readErrors = 0
const failing = createPersonaDominance({
  enabled: () => true,
  dominance: () => true,
  resolveAgent: (item) => item?.id === 'agent-1',
  read: () => {
    throw new Error('identity read failed')
  },
  onError: () => {
    readErrors += 1
  },
})
check('读取失败回退 null 且不抛出', failing({ agent }) === null && readErrors === 1)

let reads = 0
const snapshot = createPersonaDominance({
  enabled: () => true,
  dominance: () => true,
  resolveAgent: (item) => item?.id === 'agent-1',
  read: () => {
    reads += 1
    return ready
  },
})
const round = { agent }
const first = snapshot(round)
const second = snapshot(round)
check('同一轮快照只读一次且结果一致', reads === 1 && first === second, reads)

const duplicatePersona = assembly([
  { name: 'deployment:persona', text: 'You are a coding agent powered by the {{model}} model.' },
  { name: 'deployment:persona', text: 'b' },
])
check('重复 deployment:persona 段拒绝注入', injectDominanceSections(duplicatePersona.sections, ready.text, 'x') === null)
check('重复 deployment:persona 原样保留', duplicatePersona.sections[0].text.includes('coding agent') && duplicatePersona.sections[1].text === 'b')

console.log(`\npersona-dominance: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
