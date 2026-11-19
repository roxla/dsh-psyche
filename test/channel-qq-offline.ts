// R6-3C-Offline：QQ Channel Adapter 契约与骨架（离线）。
//
// 覆盖用户 m24385 的 7 项 + 两个边界：
// 1. SnowLuma 事件 → ChannelIdentityClaim（私聊稳定 QQ 号、群聊稳定群号）；
// 2. Host 受控注册入口（白名单、definition.id 一致、无 registry/bind 暴露）；
// 3. 统一走 resolveTrustedBinding（Adapter 不自己建绑定）；
// 4. Scope：私聊按 Contact、群聊按 Room 且 contactId=null；
// 5. 注入来源继续由 CAP-2 的 source.psyche 标记负责（本测试只断言 claim 不夹带身份字段）；
// 6. 生命周期：注册、注销、关闭；注销后旧授权不可再用；
// 7. Capture 排除复用 CAP-2（本文件不重复，见 test/capture-host.ts）。
//
// 边界：群聊事件带发送者 QQ 号，但绑定后 contactId 必须为 null，
// 且群聊 Scope 查不到该发送者的私聊记忆——「群成员」不等于「私聊 Contact 权限」。
//
// 跑法：node test/channel-qq-offline.ts（需要先 npm run build && pnpm --filter dsh-psyche-qq run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { ChannelAdapterRegistry, resolveTrustedBinding } from '../dist/lib/channel-binding.js'
import { RuntimeInputStore } from '../dist/lib/runtime-input.js'
import { recallMemory } from '../dist/lib/recall.js'
import { HostChannelRegistry } from '../dist/lib/host-channels.js'
import { createQqAdapter, toIdentityClaim } from '../packages/qq/dist/index.js'

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

// ── A. 事件解析 ─────────────────────────────────────────────────────────────
const privateClaim = toIdentityClaim({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 10001 })
eq('A1 好友私聊 → private claim', privateClaim, { kind: 'private', stableUserId: '10001', channelId: null })

const groupClaim = toIdentityClaim({ post_type: 'message', message_type: 'group', user_id: 10002, group_id: 20001 })
eq('A2 群聊事件 → group claim（带外部群号）', groupClaim, {
  kind: 'group',
  stableUserId: '10002',
  externalRoomId: '20001',
  channelId: null,
})
ok('A3 claim 不夹带 contactId/roomId/surface/trustedSource', groupClaim !== null
  && !('contactId' in groupClaim) && !('roomId' in groupClaim)
  && !('surface' in groupClaim) && !('trustedSource' in groupClaim))

eq('A4 非 message 事件 → null', toIdentityClaim({ post_type: 'notice', message_type: 'private', sub_type: 'friend', user_id: 10001 }), null)
eq('A5 缺 user_id → null', toIdentityClaim({ post_type: 'message', message_type: 'private', sub_type: 'friend' }), null)
eq('A6 群聊缺 group_id → null', toIdentityClaim({ post_type: 'message', message_type: 'group', user_id: 10001 }), null)
eq('A7 非数字身份（显示名）→ null', toIdentityClaim({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: '小明' }), null)
eq('A8 前导零/空串 → null', toIdentityClaim({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: '010001' }), null)
eq('A9 未知 message_type → null', toIdentityClaim({ post_type: 'message', message_type: 'guild', user_id: 10001 }), null)
ok('A10 数字字符串 QQ 号可用', toIdentityClaim({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: '10003' }) !== null)
// OneBot 11：private + group 是「从群聊发起的临时会话」，不是好友私聊。
eq('A11 private+group（群临时会话）→ null', toIdentityClaim({ post_type: 'message', message_type: 'private', sub_type: 'group', user_id: 10001, group_id: 20001 }), null)
eq('A12 private+other → null', toIdentityClaim({ post_type: 'message', message_type: 'private', sub_type: 'other', user_id: 10001 }), null)
eq('A13 private 缺 sub_type → null（不猜好友身份）', toIdentityClaim({ post_type: 'message', message_type: 'private', user_id: 10001 }), null)

// ── B. Adapter 骨架与生命周期 ───────────────────────────────────────────────
const qq = createQqAdapter()
eq('B1 definition 平台与能力白名单', [qq.definition.adapterId, qq.definition.platform], ['qq-snowluma', 'qq'])
eq('B2 allowedSurfaces 不含 personal', [...(qq.definition.allowedSurfaces ?? [])], ['private', 'group'])
ok('B3 未 announce 时 resolveIdentity → null', qq.definition.resolveIdentity({ agentId: 's1', sessionId: 's1', platform: 'qq' }) === null)
qq.announce('s1', privateClaim)
eq('B4 announce 后可取回声明', qq.definition.resolveIdentity({ agentId: 's1', sessionId: 's1', platform: 'qq' }), privateClaim)
qq.forget('s1')
ok('B5 forget 后回到 null', qq.definition.resolveIdentity({ agentId: 's1', sessionId: 's1', platform: 'qq' }) === null)
qq.announce('s2', privateClaim)
qq.dispose()
ok('B6 dispose 后 resolveIdentity → null', qq.definition.resolveIdentity({ agentId: 's2', sessionId: 's2', platform: 'qq' }) === null)
eq('B7 dispose 后 size=0', qq.size(), 0)
const closedAdapter = createQqAdapter()
closedAdapter.announce('s3', { kind: 'personal', stableUserId: '10001' })
eq('B8 拒绝 personal 声明（QQ 没有个人表面）', closedAdapter.size(), 0)

// ── C. Host 受控注册入口 ────────────────────────────────────────────────────
const hostChannels = new HostChannelRegistry()
// qq-snowluma 现在在 Host 白名单里：Host 授权 platform=qq、surfaces=private/group，
// Adapter 只能声明这组，不能自己扩平台或加 personal。
hostChannels.register('qq-snowluma', { adapterId: 'qq-snowluma', platform: 'qq', allowedSurfaces: ['private', 'group'], resolveIdentity: () => null })
eq('C1 qq-snowluma 在 Host 授权下可注册', [hostChannels.has('qq-snowluma'), hostChannels.size()], [true, 1])
let unknownBlocked = false
try {
  hostChannels.register('not-a-real-adapter' as never, { adapterId: 'not-a-real-adapter', platform: 'qq', allowedSurfaces: ['private'], resolveIdentity: () => null })
} catch (error) {
  unknownBlocked = error instanceof Error && error.name === 'HostChannelRegistrationError'
}
ok('C2 白名单外 adapterId 被拒绝', unknownBlocked)
hostChannels.register('host-desktop', {
  adapterId: 'host-desktop',
  platform: 'desktop',
  allowedSurfaces: ['personal', 'private'],
  resolveIdentity: async () => ({ kind: 'personal', stableUserId: 'owner-1' }),
})
eq('C3 host-desktop 可注册', [hostChannels.has('host-desktop'), hostChannels.size()], [true, 2])
let duplicateBlocked = false
try {
  hostChannels.register('host-desktop', {
    adapterId: 'host-desktop',
    platform: 'desktop',
    allowedSurfaces: ['personal', 'private'],
    resolveIdentity: () => null,
  })
} catch {
  duplicateBlocked = true
}
ok('C4 重复注册被拒绝', duplicateBlocked)
let idMismatchBlocked = false
try {
  hostChannels.register('host-desktop', { adapterId: 'qq-snowluma', platform: 'qq', allowedSurfaces: ['private', 'group'], resolveIdentity: () => null })
} catch (error) {
  idMismatchBlocked = error instanceof Error && error.name === 'HostChannelRegistrationError'
}
ok('C5 definition.adapterId 不一致被拒绝', idMismatchBlocked)
let platformMismatchBlocked = false
try {
  hostChannels.register('qq-snowluma', { adapterId: 'qq-snowluma', platform: 'desktop', allowedSurfaces: ['private', 'group'], resolveIdentity: () => null })
} catch (error) {
  platformMismatchBlocked = error instanceof Error && error.name === 'HostChannelRegistrationError'
}
ok('C6 platform 与 Host 授权不一致被拒绝', platformMismatchBlocked)
let surfaceMismatchBlocked = false
try {
  hostChannels.register('qq-snowluma', { adapterId: 'qq-snowluma', platform: 'qq', allowedSurfaces: ['personal', 'private', 'group'], resolveIdentity: () => null })
} catch (error) {
  surfaceMismatchBlocked = error instanceof Error && error.name === 'HostChannelRegistrationError'
}
ok('C7 多声明 personal 表面被拒绝', surfaceMismatchBlocked)
hostChannels.dispose()
let disposedBlocked = false
try {
  hostChannels.register('host-desktop', { adapterId: 'host-desktop', platform: 'desktop', allowedSurfaces: ['personal', 'private'], resolveIdentity: () => null })
} catch {
  disposedBlocked = true
}
ok('C8 Host 注册表关闭后拒绝注册', disposedBlocked)
ok('C9 Host 注册表关闭后 resolve → null', await hostChannels.resolve({} as never, { agentId: 'x', sessionId: 'x' }) === null)

// ── D. 可信绑定与 Scope（模块级；Host 将来通过白名单注册 QQ Adapter） ────────
const dir = mkdtempSync(join(tmpdir(), 'psyche-qq-offline-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })
const now = new Date().toISOString()

db.run(
  `INSERT INTO contacts (contact_id, persona_id, platform, stable_user_id, created_at, updated_at)
   VALUES ('ct_qqa', 'main', 'qq', '10001', ?, ?)`,
  [now, now],
)
db.run(
  `INSERT INTO contacts (contact_id, persona_id, platform, stable_user_id, created_at, updated_at)
   VALUES ('ct_qqb', 'main', 'qq', '10002', ?, ?)`,
  [now, now],
)
db.run(
  `INSERT INTO rooms (room_id, persona_id, platform, channel, external_room_id, title, capture_mode, active, created_at, updated_at)
   VALUES ('rr_qq_a', 'main', 'qq', 'group', '20001', 'A 群', 'mentioned_only', 1, ?, ?)`,
  [now, now],
)

let seq = 0
async function capture(text, platform, channel, extra = {}) {
  seq += 1
  const captured = await core.capture({
    platform,
    channel,
    sessionRef: `qq-offline-s${seq}`,
    origin: 'user',
    kind: 'message',
    text,
    ...extra,
  })
  return captured.sourceId
}

async function remember(text, sourceIds, subjectRefs) {
  const result = await core.remember({
    text,
    kind: 'fact',
    statement: text,
    sourceIds,
    disclosure: 'public',
    ...(subjectRefs === undefined ? {} : { subjectRefs }),
  })
  if (!result.artifactId) throw new Error(`未升格：${JSON.stringify(result)}`)
  return result.artifactId
}

// A 的私聊记忆 + A 群的群记忆
const C_A = await remember('A 私聊说周五去看展', [
  await capture('A 私聊说周五去看展', 'qq', 'private', { senderContactId: 'ct_qqa' }),
  await capture('A 私聊说周五去看展（补充）', 'qq', 'private', { senderContactId: 'ct_qqa' }),
])
const R_A = await remember('A 群约了周六露营', [
  await capture('A 群约了周六露营', 'qq', 'group', { roomId: 'rr_qq_a' }),
  await capture('A 群约了周六露营（补充）', 'qq', 'group', { roomId: 'rr_qq_a' }),
])

const registry = new ChannelAdapterRegistry()
const store = new RuntimeInputStore()
const adapter = createQqAdapter()
registry.register(adapter.definition)

const resolveContact = async (input) => {
  const resolved = await core.resolveContact({ platform: input.platform, stableUserId: input.stableUserId })
  return { contactId: resolved.contactId }
}

// 私聊：Session s-qq-a 收到 A 的私聊消息（必须是 friend 细分）
adapter.announce('s-qq-a', toIdentityClaim({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 10001 }))
const privateBinding = await resolveTrustedBinding(
  { db, store, registry, resolveContact },
  { agentId: 's-qq-a', sessionId: 's-qq-a', platformHint: 'qq' },
)
ok('D1 私聊绑定成功', privateBinding !== null)
eq('D2 私聊 surface=private、contactId 解析为 A', [privateBinding?.surface, privateBinding?.contactId], ['private', 'ct_qqa'])
eq('D3 私聊 roomId=null', privateBinding?.roomId, null)

// 群聊：Session s-qq-ra 收到 A 在群 20001 的发言
adapter.announce('s-qq-ra', toIdentityClaim({ post_type: 'message', message_type: 'group', user_id: 10001, group_id: 20001 }))
const groupBinding = await resolveTrustedBinding(
  { db, store, registry, resolveContact },
  { agentId: 's-qq-ra', sessionId: 's-qq-ra', platformHint: 'qq' },
)
ok('D4 群聊绑定成功', groupBinding !== null)
eq('D5 群聊 surface=group、roomId 解析为 A 群', [groupBinding?.surface, groupBinding?.roomId], ['group', 'rr_qq_a'])
eq('D6 群聊 contactId 必须为 null（不因发送者 QQ 号获得私聊权限）', groupBinding?.contactId, null)

// 群聊 Scope 只能看到群记忆，看不到该发送者的私聊记忆
const groupRecall = await recallMemory(
  db,
  { text: '周五去看展' },
  { contactId: null, platform: 'qq', roomId: 'rr_qq_a', surface: 'group' },
)
eq('D7 群聊查不到 A 的私聊记忆', groupRecall.items.filter((item) => item.artifactId === C_A).length, 0)
const groupRecallRoom = await recallMemory(
  db,
  { text: '周六露营' },
  { contactId: null, platform: 'qq', roomId: 'rr_qq_a', surface: 'group' },
)
ok('D8 群聊能看到 A 群自己的记忆', groupRecallRoom.items.some((item) => item.artifactId === R_A))

// 私聊 Scope 能看到私聊记忆
const privateRecall = await recallMemory(
  db,
  { text: '周五去看展' },
  { contactId: 'ct_qqa', platform: 'qq', roomId: null, surface: 'private' },
)
ok('D9 私聊能看到自己的私聊记忆', privateRecall.items.some((item) => item.artifactId === C_A))

// 未登记会话 → 不绑定（只允许全局）
eq(
  'D10 未登记会话不产生绑定',
  await resolveTrustedBinding({ db, store, registry, resolveContact }, { agentId: 's-x', sessionId: 's-x', platformHint: 'qq' }),
  null,
)

// ── E. 注销与旧授权 ────────────────────────────────────────────────────────
const registration = registry.register(createQqAdapter({ adapterId: 'qq-retire' }).definition)
registration.dispose()
adapter.dispose()
eq('E1 adapter dispose 后 resolveIdentity → null', adapter.definition.resolveIdentity({ agentId: 's-qq-a', sessionId: 's-qq-a', platform: 'qq' }), null)

opened.db.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n[R6-3C-Offline] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
