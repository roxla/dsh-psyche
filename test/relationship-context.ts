// P3-B-3 关系 Prompt Context 测试：独立 context、按当前 Agent 解析、每轮重算、只读、失败不注入。
//
// 跑法：node test/relationship-context.ts（需要先 npm run build）
import assert from 'node:assert/strict'
import {
  RELATIONSHIP_CONTEXT_NAME,
  RELATIONSHIP_CONTEXT_ORDER,
  RELATIONSHIP_CONTEXT_PREAMBLE,
  createRelationshipContextProvider,
  registerRelationshipContext,
  type RelationshipContactBinding,
} from '../packages/core/dist/relationship-context.js'
import type { RelationshipBrief } from '../packages/core/dist/relationship-projection.js'

let passed = 0
let failed = 0
function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}
function eq(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

const FIXED_NOW = '2026-11-12T12:00:00.000Z'
const FRIENDLY: RelationshipBrief = { affinityBand: 'friendly', trustBand: null, affect: [] }
const CLOSE_TRUSTED: RelationshipBrief = {
  affinityBand: 'very_close',
  trustBand: 'high',
  affect: [{ dimension: 'warmth', value: 55 }],
}

type Agent = { id?: string; session?: { id?: string } }

function makeProvider(options: {
  binding?: RelationshipContactBinding | null | ((agent: Agent) => RelationshipContactBinding | null)
  brief?: RelationshipBrief | (() => RelationshipBrief)
  enabled?: boolean
  now?: string
  resolveCalls?: { count: number }
  errors?: unknown[]
} = {}) {
  const binding = options.binding === undefined ? { contactId: 'ct_alice', platform: 'qq', groupId: null } : options.binding
  return createRelationshipContextProvider({
    enabled: () => options.enabled !== false,
    resolve: (agent) => {
      if (options.resolveCalls !== undefined) options.resolveCalls.count += 1
      return typeof binding === 'function' ? binding(agent) : binding
    },
    readBrief: () => {
      const value = options.brief ?? FRIENDLY
      return typeof value === 'function' ? value() : value
    },
    now: () => options.now ?? FIXED_NOW,
    onError: (error) => options.errors?.push(error),
  })
}

// A. 基础形状与内容
{
  const provider = makeProvider({ brief: CLOSE_TRUSTED })
  eq('A1 context 名独立', provider.name, RELATIONSHIP_CONTEXT_NAME)
  eq('A2 context 顺序在语气块之前', provider.order, RELATIONSHIP_CONTEXT_ORDER)
  const text = provider.text({ agent: { id: 'qq-private-10001' } })
  ok('A3 出现档位/信任/感受', text.includes('关系：非常亲近。') && text.includes('信任：较高。') && text.includes('此刻觉得亲近'), text)
  ok('A4 不出现 contact id', !text.includes('ct_alice'), text)
  ok('A5 不出现数字', !/[0-9]/.test(text), text)
  ok('A6 块首声明不是指令', text.startsWith(RELATIONSHIP_CONTEXT_PREAMBLE), text)
  ok('A7 内容为两行', text.split('\n').length === 2, text)
  eq('A8 重复调用结果一致', provider.text({ agent: { id: 'x' } }), text)
}

// B. 跳过与失败（都返回空串）
{
  const messages = { agent: { id: 'qq-private-10001' } }
  eq('B1 无绑定', makeProvider({ binding: null }).text(messages), '')
  eq(
    'B2 非 QQ 平台',
    makeProvider({ binding: { contactId: 'ct_a', platform: 'desktop', groupId: null } }).text(messages),
    '',
  )
  eq(
    'B3 QQ 群聊',
    makeProvider({ binding: { contactId: 'ct_a', platform: 'qq', groupId: '123' } }).text(messages),
    '',
  )
  eq('B4 contactId 为空', makeProvider({ binding: { contactId: '', platform: 'qq', groupId: null } }).text(messages), '')
  eq('B5 关闭开关', makeProvider({ enabled: false }).text(messages), '')
  eq('B6 没有 agent（诊断/非会话）', makeProvider().text({}), '')
  const errors: unknown[] = []
  const broken = makeProvider({
    errors,
    brief: () => {
      throw new Error('db bytes gone')
    },
  })
  eq('B7 读取失败返回空串', broken.text(messages), '')
  ok('B8 读取失败回调一次', errors.length === 1 && String(errors[0]).includes('db bytes gone'))
  const invalid = makeProvider({ brief: () => ({ affinityBand: 'nope' as RelationshipBrief['affinityBand'], trustBand: null, affect: [] }) })
  eq('B9 投影失败返回空串', invalid.text(messages), '')
}

// C. 按当前 Agent 解析、不缓存、每轮重算
{
  const resolveCalls = { count: 0 }
  let brief = FRIENDLY
  const provider = makeProvider({
    resolveCalls,
    brief: () => brief,
    binding: (agent: Agent) =>
      agent.id === 'qq-private-10001'
        ? { contactId: 'ct_a', platform: 'qq', groupId: null }
        : { contactId: 'ct_b', platform: 'qq', groupId: null },
  })
  const textA = provider.text({ agent: { id: 'qq-private-10001' } })
  ok('C1 解析第一个 Agent', resolveCalls.count === 1 && textA.includes('关系：友好。'))
  const textB = provider.text({ agent: { id: 'qq-private-10002' } })
  ok('C2 切换 Agent 重新解析', resolveCalls.count === 2 && textB.includes('关系：友好。'))
  brief = CLOSE_TRUSTED
  const textA2 = provider.text({ agent: { id: 'qq-private-10001' } })
  ok('C3 每次调用重新读快照', resolveCalls.count === 3 && textA2.includes('信任：较高。'))
  eq('C4 不同 Agent 不串用（解析次数 3）', resolveCalls.count, 3)
}

// D. 注册与生命周期
{
  const registered: Array<{ name: string; order?: number; text: (assembly: { agent?: Agent }) => string }> = []
  let disposed = 0
  const api = {
    context(options: { name: string; order?: number; text: (assembly: { agent?: Agent }) => string }) {
      registered.push(options)
      return () => {
        disposed += 1
      }
    },
  }
  const registration = registerRelationshipContext({
    api,
    resolve: () => ({ contactId: 'ct_a', platform: 'qq', groupId: null }),
    readBrief: () => FRIENDLY,
    now: () => FIXED_NOW,
  })
  ok('D1 注册返回 disposer', registration !== null && typeof registration.dispose === 'function')
  eq('D2 只注册一个 context', registered.length, 1)
  eq('D3 注册名独立', registered[0]?.name, RELATIONSHIP_CONTEXT_NAME)
  ok('D4 provider 可按 Agent 渲染', (registered[0]?.text({ agent: { id: 'x' } }) ?? '').includes('关系：友好。'))
  registration?.dispose()
  eq('D5 disposer 只注销自己', disposed, 1)
  const failing = registerRelationshipContext({
    api: { context: () => { throw new Error('already registered') } },
    resolve: () => null,
    readBrief: () => FRIENDLY,
  })
  eq('D6 注册失败返回 null', failing, null)
}

// E. 内容边界
{
  const provider = makeProvider({ brief: FRIENDLY })
  const text = provider.text({ agent: { id: 'x' } })
  ok('E1 unassessed 不出现信任段', !text.includes('信任：'))
  ok('E2 无感受时不编造', !text.includes('此刻'))
  ok('E3 块首声明完整', text.startsWith(RELATIONSHIP_CONTEXT_PREAMBLE))
}

assert.equal(failed, 0)
console.log(`\n[P3-B-3 relationship-context] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
