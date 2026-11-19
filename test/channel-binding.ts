// R6-3A：可信 Channel Binding 契约测试。
//
// 冻结原则：Adapter 可以提供身份声明，但只有 Host 能把声明转换成可信 RuntimeInput。
//
// 覆盖：
// 1. 未注册 Adapter → 不产生绑定（只允许全局）；
// 2. 伪造 trustedSource / 直接调 bind → 拒绝；
// 3. group 声明缺 externalRoomId → 拒绝；
// 4. private 声明带群上下文 → 拒绝；
// 5. surface 不在 Adapter 注册白名单 → 拒绝；
// 6. platform 与注册平台不一致 → 不认领；
// 7. Adapter 不能指定别的 Session / 用别人的认领结果覆盖；
// 8. Agent disposed 后旧能力失效、绑定被清理；
// 9. 同一 Session 六维任意变化 → E_STATE；
// 10. 同一 Session 相同绑定重复执行 → 幂等；
// 11. 绑定失败 → store 里没有身份（只允许全局）。
//
// 跑法：node test/channel-binding.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { ChannelAdapterRegistry, resolveTrustedBinding } from '../dist/lib/channel-binding.js'
import { RuntimeInputStore, createHostBindingCapability } from '../dist/lib/runtime-input.js'

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

async function rejectsCode(label, fn, code) {
  try {
    await fn()
    ok(label, false, { threw: false, expected: code })
  } catch (error) {
    eq(label, error?.code, code)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-channel-binding-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const now = new Date().toISOString()
db.run(
  `INSERT INTO rooms (room_id, persona_id, platform, channel, external_room_id, title, capture_mode, active, created_at, updated_at)
   VALUES ('rr_qq_8888', 'main', 'qq', 'group', '8888', '测试群', 'mentioned_only', 1, ?, ?)`,
  [now, now],
)

const registry = new ChannelAdapterRegistry()
const store = new RuntimeInputStore()
const deps = {
  db,
  store,
  registry,
  resolveContact: async (input) => {
    const resolved = await core.resolveContact({ platform: input.platform, stableUserId: input.stableUserId })
    return { contactId: resolved.contactId }
  },
}

const QQ_PRIVATE_CLAIM = (stableUserId) => ({ kind: 'private', stableUserId, channelId: `ch-${stableUserId}` })

console.log('\n[R6-3A] 可信 Channel Binding')

// CB-01 未注册 Adapter
try {
  const binding = await resolveTrustedBinding(deps, { agentId: 'agent-none', sessionId: 'session-none' })
  eq('CB-01 未注册 Adapter 不产生绑定', binding, null)
  eq('CB-02 store 保持为空', store.size(), 0)
} catch (error) {
  ok('CB-01 未注册 Adapter 不产生绑定', false, { threw: String(error) })
  ok('CB-02 store 保持为空', false, { threw: String(error) })
}

// CB-03 普通插件/请求体伪造 trustedSource，直接 bind 被拒绝
await rejectsCode(
  'CB-03 无能力直接绑定被拒绝',
  () => store.bind({ platform: 'qq', trustedSource: 'channel-adapter' }, {
    platform: 'qq',
    stableUserId: 'u-forge',
    contactId: null,
    sessionId: 'session-forge',
    trustedSource: 'channel-adapter',
  }),
  'E_VALIDATION',
)

// 注册私聊 Adapter
registry.register({
  adapterId: 'adapter-private',
  platform: 'qq',
  allowedSurfaces: ['private'],
  resolveIdentity: (context) => (context.sessionId.startsWith('sess-private') ? QQ_PRIVATE_CLAIM('u-alice') : null),
})
const privateBinding = await resolveTrustedBinding(deps, {
  agentId: 'sess-private-1',
  sessionId: 'sess-private-1',
  platformHint: 'qq',
})
ok('CB-04 私聊绑定成功且 surface=private', privateBinding?.surface === 'private')
ok('CB-05 私聊绑定解析出 Contact', typeof privateBinding?.contactId === 'string' && privateBinding.contactId.startsWith('ct_'))
eq('CB-06 私聊绑定没有 roomId', privateBinding?.roomId, null)
eq('CB-07 私聊绑定的 trustedSource 是 channel-adapter', privateBinding?.trustedSource, 'channel-adapter')
eq('CB-08 store 里能读回同一会话', store.read('sess-private-1')?.contactId, privateBinding?.contactId)

// CB-09 同一 Session 相同绑定重复执行 → 幂等
const again = await resolveTrustedBinding(deps, { agentId: 'sess-private-1', sessionId: 'sess-private-1', platformHint: 'qq' })
ok('CB-09 相同身份重复绑定幂等', again?.contactId === privateBinding?.contactId && store.size() === 1)

// CB-10 同一 Session 换身份 → E_STATE（另一个 Adapter 认领同一 Session 且声明了不同身份）
{
  const switchStore = new RuntimeInputStore()
  const aliceRegistry = new ChannelAdapterRegistry()
  aliceRegistry.register({
    adapterId: 'adapter-alice',
    platform: 'qq',
    allowedSurfaces: ['private'],
    resolveIdentity: () => QQ_PRIVATE_CLAIM('u-alice'),
  })
  await resolveTrustedBinding(
    { ...deps, registry: aliceRegistry, store: switchStore },
    { agentId: 'sess-switch', sessionId: 'sess-switch' },
  )
  const bobRegistry = new ChannelAdapterRegistry()
  bobRegistry.register({
    adapterId: 'adapter-bob',
    platform: 'qq',
    allowedSurfaces: ['private'],
    resolveIdentity: () => QQ_PRIVATE_CLAIM('u-bob'),
  })
  await rejectsCode(
    'CB-10 同 Session 换身份被拒绝',
    () => resolveTrustedBinding(
      { ...deps, registry: bobRegistry, store: switchStore },
      { agentId: 'sess-switch', sessionId: 'sess-switch' },
    ),
    'E_STATE',
  )
}

// CB-11 group 声明缺 externalRoomId
const registryGroup = new ChannelAdapterRegistry()
registryGroup.register({
  adapterId: 'adapter-group-bad',
  platform: 'qq',
  allowedSurfaces: ['group'],
  resolveIdentity: () => ({ kind: 'group', stableUserId: 'u-alice', externalRoomId: '' }),
})
await rejectsCode(
  'CB-11 group 缺 externalRoomId 被拒绝',
  () => resolveTrustedBinding({ ...deps, registry: registryGroup, store: new RuntimeInputStore() }, { agentId: 'sess-g0', sessionId: 'sess-g0' }),
  'E_VALIDATION',
)

// CB-12 private 声明带群上下文
const registryPrivateRoom = new ChannelAdapterRegistry()
registryPrivateRoom.register({
  adapterId: 'adapter-private-room',
  platform: 'qq',
  allowedSurfaces: ['private'],
  resolveIdentity: () => ({ kind: 'private', stableUserId: 'u-alice', externalRoomId: '8888' }),
})
await rejectsCode(
  'CB-12 私聊声明带群上下文被拒绝',
  () => resolveTrustedBinding({ ...deps, registry: registryPrivateRoom, store: new RuntimeInputStore() }, { agentId: 'sess-p2', sessionId: 'sess-p2' }),
  'E_VALIDATION',
)

// CB-13 surface 不在注册白名单
const registryNoGroup = new ChannelAdapterRegistry()
registryNoGroup.register({
  adapterId: 'adapter-group-denied',
  platform: 'qq',
  allowedSurfaces: ['private'],
  resolveIdentity: () => ({ kind: 'group', stableUserId: 'u-alice', externalRoomId: '8888' }),
})
await rejectsCode(
  'CB-13 未获授权的 surface 被拒绝',
  () => resolveTrustedBinding({ ...deps, registry: registryNoGroup, store: new RuntimeInputStore() }, { agentId: 'sess-g1', sessionId: 'sess-g1' }),
  'E_STATE',
)

// CB-14 platform 不一致不认领
const cross = await resolveTrustedBinding(deps, { agentId: 'sess-private-1', sessionId: 'sess-web-1', platformHint: 'web' })
eq('CB-14 platformHint 不匹配时不认领', cross, null)

// CB-15 group 正常绑定：roomId 由 Core 解析、contactId 不开放
const registryGroupOk = new ChannelAdapterRegistry()
registryGroupOk.register({
  adapterId: 'adapter-group-ok',
  platform: 'qq',
  allowedSurfaces: ['group'],
  resolveIdentity: () => ({ kind: 'group', stableUserId: 'u-alice', externalRoomId: '8888' }),
})
const groupBinding = await resolveTrustedBinding(
  { ...deps, registry: registryGroupOk, store: new RuntimeInputStore() },
  { agentId: 'sess-g2', sessionId: 'sess-g2' },
)
ok('CB-15 group 绑定 surface=group', groupBinding?.surface === 'group')
ok('CB-16 group 绑定解析出 roomId', typeof groupBinding?.roomId === 'string' && groupBinding.roomId.length > 0)
eq('CB-17 群聊不开放发送者 Contact 域', groupBinding?.contactId, null)
eq('CB-18 group 绑定保存 groupId', groupBinding?.groupId, '8888')

// CB-19 group Room 未落库 → roomId=null（拒绝 Room 记忆，不退回 private）
const registryGroupMissing = new ChannelAdapterRegistry()
registryGroupMissing.register({
  adapterId: 'adapter-group-missing',
  platform: 'qq',
  allowedSurfaces: ['group'],
  resolveIdentity: () => ({ kind: 'group', stableUserId: 'u-alice', externalRoomId: '9999' }),
})
const missingRoom = await resolveTrustedBinding(
  { ...deps, registry: registryGroupMissing, store: new RuntimeInputStore() },
  { agentId: 'sess-g3', sessionId: 'sess-g3' },
)
eq('CB-19 Room 未落库时 roomId=null（fail closed）', missingRoom?.roomId, null)

// CB-20 Adapter 不能指定别的 Session 能力
{
  const capability = createHostBindingCapability({ sessionId: 'sess-other', platform: 'qq', adapterId: 'adapter-private' })
  await rejectsCode(
    'CB-20 能力不能用于别的 Session',
    () => store.bind(capability, {
      platform: 'qq',
      stableUserId: 'u-alice',
      contactId: privateBinding?.contactId ?? null,
      sessionId: 'sess-else',
      trustedSource: 'channel-adapter',
    }),
    'E_STATE',
  )
}

// CB-21 用别人的认领结果覆盖已有 Session → E_STATE
{
  const capability = createHostBindingCapability({ sessionId: 'sess-private-1', platform: 'qq', adapterId: 'adapter-b' })
  await rejectsCode(
    'CB-21 不能覆盖已绑定 Session',
    () => store.bind(capability, {
      platform: 'qq',
      stableUserId: 'u-bob',
      contactId: null,
      sessionId: 'sess-private-1',
      trustedSource: 'channel-adapter',
    }),
    'E_STATE',
  )
}

// CB-22 Agent disposed 后绑定被清理、旧能力失效
{
  const capability = createHostBindingCapability({ sessionId: 'sess-dispose', platform: 'qq', adapterId: null })
  store.bind(capability, {
    platform: 'qq',
    stableUserId: 'u-carol',
    contactId: null,
    sessionId: 'sess-dispose',
    trustedSource: 'channel-adapter',
  })
  store.clear('sess-dispose')
  await rejectsCode(
    'CB-22 disposed 后旧能力不能再次绑定',
    () => store.bind(capability, {
      platform: 'qq',
      stableUserId: 'u-carol',
      contactId: null,
      sessionId: 'sess-dispose',
      trustedSource: 'channel-adapter',
    }),
    'E_STATE',
  )
}

// CB-23 注销 Adapter 后不再认领
{
  const registryTemp = new ChannelAdapterRegistry()
  const handle = registryTemp.register({
    adapterId: 'adapter-temp',
    platform: 'qq',
    allowedSurfaces: ['private'],
    resolveIdentity: () => QQ_PRIVATE_CLAIM('u-temp'),
  })
  const before = await resolveTrustedBinding({ ...deps, registry: registryTemp, store: new RuntimeInputStore() }, { agentId: 'sess-t1', sessionId: 'sess-t1' })
  ok('CB-23 注销前可认领', before !== null)
  handle.dispose()
  const after = await resolveTrustedBinding({ ...deps, registry: registryTemp, store: new RuntimeInputStore() }, { agentId: 'sess-t2', sessionId: 'sess-t2' })
  eq('CB-24 注销后不再认领', after, null)
}

// CB-25 Contact 解析失败 → 不产生绑定（调用方按无身份只允许全局）
{
  const failStore = new RuntimeInputStore()
  const failRegistry = new ChannelAdapterRegistry()
  failRegistry.register({
    adapterId: 'adapter-fail',
    platform: 'qq',
    allowedSurfaces: ['private'],
    resolveIdentity: () => QQ_PRIVATE_CLAIM('u-fail'),
  })
  let threw = false
  try {
    await resolveTrustedBinding(
      {
        ...deps,
        registry: failRegistry,
        store: failStore,
        resolveContact: async () => {
          throw new Error('contact boom')
        },
      },
      { agentId: 'sess-fail', sessionId: 'sess-fail' },
    )
  } catch {
    threw = true
  }
  ok('CB-25 Contact 解析失败时不产生绑定', threw && failStore.size() === 0)
}

try {
  opened.db.close()
} catch {
  /* 已关闭 */
}
try {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
} catch {
  /* Windows 句柄释放慢时忽略；临时目录由系统清理 */
}
console.log(`[channel-binding] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
