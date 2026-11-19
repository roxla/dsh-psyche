// P2-FTS5 E5.5-B：RuntimeInput 可信绑定与隔离测试。
// R6-3A 起：bind() 只接受 Host 发放的一次性绑定能力（普通插件/请求体不能直接绑定）。
//
// 冻结语义（p2-fts5-e5.5-b-runtime-input.md）：
// 1. 身份只来自可信 Channel Adapter / Host，不来自模型参数、用户自我介绍、显示名或候选字段。
// 2. 绑定以 sessionId 为键，会话内不可换人；重复绑定同一身份幂等。
// 3. 请求快照 = 会话身份 + 本次 turn/step/purpose；没有绑定必须返回 null（降级为无私有记忆）。
// 4. 不同 Agent/会话并发交错读取不得串人；同 Contact 的两个 Session 的 channel/group 独立。
// 5. 绑定对象冻结，下游无法改写身份字段。
// 6. R6-3A：绑定能力与 Session/platform 绑定、用完即焚；伪造能力被拒绝。
//
// 跑法：node test/runtime-input.ts（需要先 npm run build）
import {
  createHostBindingCapability,
  createRuntimeInput,
  RuntimeInputStore,
  sessionMatches,
} from '../dist/lib/runtime-input.js'

const NOW = '2026-11-06T00:00:00.000Z'

let passed = 0
let failed = 0

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

function throwsCode(label, fn, code) {
  try {
    fn()
    ok(label, false, { threw: false, expected: code })
  } catch (error) {
    eq(label, error?.code, code)
  }
}

function fields(overrides = {}) {
  return {
    platform: 'qq',
    stableUserId: 'u-1001',
    contactId: 'ct_alpha1',
    sessionId: 'session-a',
    trustedSource: 'channel-adapter',
    ...overrides,
  }
}

/** 模拟 Host：为一份即将写入的身份申请一次性能力。 */
function hostCap(overrides = {}) {
  return createHostBindingCapability({ sessionId: 'session-a', platform: 'qq', adapterId: null, ...overrides })
}

function bind(store, input) {
  return store.bind(hostCap({ sessionId: input.sessionId, platform: input.platform }), input)
}

// §1 形状与冻结
const one = createRuntimeInput(fields(), () => NOW)
eq('S1 平台原样保留', one.platform, 'qq')
eq('S2 stableUserId 原样保留', one.stableUserId, 'u-1001')
eq('S3 contactId 原样保留', one.contactId, 'ct_alpha1')
eq('S4 boundAt 由注入时钟给出', one.boundAt, NOW)
ok('S5 绑定对象被冻结', Object.isFrozen(one))
eq('S6 可选字段缺省是 undefined', one.channelId, undefined)

// §2 校验拒绝
throwsCode('S7 缺 platform 拒绝', () => createRuntimeInput(fields({ platform: '' }), () => NOW), 'E_VALIDATION')
throwsCode('S8 缺 stableUserId 拒绝', () => createRuntimeInput(fields({ stableUserId: '  ' }), () => NOW), 'E_VALIDATION')
throwsCode('S9 缺 sessionId 拒绝', () => createRuntimeInput(fields({ sessionId: '' }), () => NOW), 'E_VALIDATION')
throwsCode('S10 contactId 非 ct_ 前缀拒绝', () => createRuntimeInput(fields({ contactId: 'user-1' }), () => NOW), 'E_VALIDATION')
throwsCode('S11 trustedSource 不接受 model', () => createRuntimeInput(fields({ trustedSource: 'model' }), () => NOW), 'E_VALIDATION')
ok('S12 contactId 允许 null（无法可信识别）', createRuntimeInput(fields({ contactId: null }), () => NOW).contactId === null)

// §3 绑定幂等与不可变
const store = new RuntimeInputStore({ now: () => NOW })
const first = bind(store, fields())
const again = bind(store, fields())
ok('S13 同会话同身份重复绑定返回同一对象', first === again)
eq('S14 size 只加一次', store.size(), 1)
throwsCode('S15 同会话换 stableUserId 拒绝', () => bind(store, fields({ stableUserId: 'u-9999' })), 'E_STATE')
throwsCode('S16 同会话换 platform 拒绝', () => bind(store, fields({ platform: 'desktop' })), 'E_STATE')

// §3.1 R6-1：会话身份的全部维度都不可变（换群/换 Contact 必须换 Session）
const storeIm = new RuntimeInputStore({ now: () => NOW })
const imBase = { sessionId: 'session-im', channelId: 'ch-1', groupId: 'g-1' }
bind(storeIm, fields(imBase))
throwsCode('S16a 同会话换 contactId 拒绝', () => bind(storeIm, fields({ ...imBase, contactId: 'ct_beta1' })), 'E_STATE')
throwsCode('S16b 同会话换 groupId 拒绝', () => bind(storeIm, fields({ ...imBase, groupId: 'g-2' })), 'E_STATE')
throwsCode('S16c 同会话换 channelId 拒绝', () => bind(storeIm, fields({ ...imBase, channelId: 'ch-2' })), 'E_STATE')
throwsCode('S16d 同会话换 trustedSource 拒绝', () => bind(storeIm, fields({ ...imBase, trustedSource: 'host' })), 'E_STATE')
throwsCode('S16e 同会话换 contactId 为 null 拒绝', () => bind(storeIm, fields({ ...imBase, contactId: null })), 'E_STATE')
ok('S16f 六维完全一致的重复绑定幂等', bind(storeIm, fields(imBase)) === storeIm.read('session-im'))

// §3.2 R6-3A：绑定能力
throwsCode('S43 没有能力直接绑定被拒绝', () => store.bind(undefined, fields({ sessionId: 'session-raw' })), 'E_VALIDATION')
throwsCode('S44 伪造能力对象被拒绝', () => store.bind({ sessionId: 'session-raw', platform: 'qq' }, fields({ sessionId: 'session-raw' })), 'E_VALIDATION')
throwsCode('S45 能力属于别的 Session 被拒绝', () => store.bind(hostCap({ sessionId: 'session-other' }), fields({ sessionId: 'session-cap' })), 'E_STATE')
throwsCode('S46 能力属于别的 platform 被拒绝', () => store.bind(hostCap({ sessionId: 'session-cap', platform: 'desktop' }), fields({ sessionId: 'session-cap' })), 'E_STATE')
const onceStore = new RuntimeInputStore({ now: () => NOW })
const usedCap = hostCap({ sessionId: 'session-once' })
onceStore.bind(usedCap, fields({ sessionId: 'session-once' }))
onceStore.clear('session-once')
throwsCode('S47 同一能力第二次使用被拒绝', () => onceStore.bind(usedCap, fields({ sessionId: 'session-once' })), 'E_STATE')
const adapterCap = hostCap({ sessionId: 'session-adapter', adapterId: 'adapter-a' })
throwsCode(
  'S48 Adapter 能力不能签发 host 来源',
  () => new RuntimeInputStore({ now: () => NOW }).bind(adapterCap, fields({ sessionId: 'session-adapter', trustedSource: 'host' })),
  'E_STATE',
)

// §4 身份隔离
const store2 = new RuntimeInputStore({ now: () => NOW })
const qq = bind(store2, fields({ sessionId: 'session-qq', platform: 'qq', stableUserId: 'u-1', contactId: 'ct_qq1' }))
const desktop = bind(store2, fields({ sessionId: 'session-desktop', platform: 'desktop', stableUserId: 'u-1', contactId: 'ct_dt1' }))
ok('S17 同 stableUserId 不同 platform 是两个联系人', qq.contactId !== desktop.contactId)
const other = bind(store2, fields({ sessionId: 'session-b', stableUserId: 'u-2', contactId: 'ct_beta1', channelId: 'group-1' }))
ok('S18 不同 stableUserId 不同 contact', other.contactId !== qq.contactId)
eq('S19 同 Contact 的另一个 Session 仍保留同一 contactId', bind(store2, fields({ sessionId: 'session-qq2', contactId: 'ct_qq1' })).contactId, 'ct_qq1')
eq('S20 同 Contact 两个 Session 的 channelId 各自独立', store2.read('session-b')?.channelId, 'group-1')
eq('S21 另一个 Session 没有 groupId', store2.read('session-qq')?.groupId, undefined)

// §5 并发交错（A、B 的读取以 session 为键，不串）
const store3 = new RuntimeInputStore({ now: () => NOW })
bind(store3, fields({ sessionId: 'session-A', stableUserId: 'u-A', contactId: 'ct_aaaa1', channelId: 'channel-A' }))
bind(store3, fields({ sessionId: 'session-B', stableUserId: 'u-B', contactId: 'ct_bbbb1', channelId: 'channel-B' }))
const reqA1 = store3.requestFor({ id: 'session-A' }, { turn: 1, step: 1 })
const reqB1 = store3.requestFor({ id: 'session-B' }, { turn: 2, step: 1 })
ok('S22 交错请求 A 仍是 A 的身份', reqA1?.contactId === 'ct_aaaa1' && reqA1?.stableUserId === 'u-A')
ok('S23 交错请求 B 仍是 B 的身份', reqB1?.contactId === 'ct_bbbb1' && reqB1?.stableUserId === 'u-B')
ok('S24 A/B 的 requestId 不同', reqA1 !== null && reqB1 !== null && reqA1.requestId !== reqB1.requestId)
ok('S25 A/B 的 channelId 不串', reqA1?.channelId === 'channel-A' && reqB1?.channelId === 'channel-B')

// §6 请求快照与续轮
const first12 = store.requestFor({ id: 'session-a' }, { turn: 3, step: 2 })
eq('S26 请求快照保留 turn', first12?.turn, 3)
eq('S27 请求快照保留 step', first12?.step, 2)
eq('S28 默认 purpose 是 chat', first12?.purpose, 'chat')
const again12 = store.requestFor({ id: 'session-a' }, { turn: 3, step: 2 })
ok('S29 同一 turn/step 两次请求 requestId 不同（请求级快照）', first12?.requestId !== again12?.requestId)
eq('S30 但身份字段完全一致（续轮沿用）', first12?.contactId, again12?.contactId)
eq('S31 自定义 purpose 保留', store.requestFor({ id: 'session-a' }, { turn: 1, step: 1, purpose: 'compaction' })?.purpose, 'compaction')
throwsCode('S32 purpose 过长拒绝', () => store.requestFor({ id: 'session-a' }, { turn: 1, step: 1, purpose: 'x'.repeat(61) }), 'E_VALIDATION')
const missing = new RuntimeInputStore()
eq('S33 未绑定会话的请求快照为 null', missing.requestFor({ id: 'session-none' }, { turn: 1, step: 1 }), null)
eq('S34 没有 agent 时的请求快照为 null', missing.requestFor(undefined, { turn: 1, step: 1 }), null)

// §7 读取与清空
ok('S35 readForAgent 支持 agent.session.id', store.readForAgent({ session: { id: 'session-a' } })?.contactId === 'ct_alpha1')
ok('S36 readForAgent 优先 agent.id', store.readForAgent({ id: 'session-a', session: { id: 'session-other' } })?.sessionId === 'session-a')
eq('S37 未知会话读回 null', store.read('session-unknown'), null)
ok('S38 clear 后读不到', store.clear('session-a') === true && store.read('session-a') === null)

// §8 session 匹配与篡改
const match = bind(store, fields({ sessionId: 'session-m' }))
ok('S39 sessionMatches 命中', sessionMatches(match, { id: 'session-m' }) === true)
ok('S40 sessionMatches 不命中', sessionMatches(match, { id: 'session-other' }) === false)
ok('S41 sessionMatches 空 agent 为 false', sessionMatches(match, null) === false)
try {
  match.platform = 'desktop'
} catch {
  /* 严格模式下冻结对象赋值会抛错，忽略 */
}
eq('S42 篡改后读回仍是原值', store.read('session-m')?.platform, 'qq')

console.log(`[runtime-input] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
