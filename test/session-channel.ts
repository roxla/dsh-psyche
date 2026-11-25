// Q5：渠道判定——「谁来问」决定「能读到哪一侧的记忆」。
//
// 起因：第 28 轮真实宿主测试发现，`conversationRecall` 原来把 `platform` 写死成
// 桌面三种值，那只说明「查不到 QQ 自己的源」；反过来，QQ 会话调用时仍然会读到
// 桌面会话的原文。这里把判定抽成纯函数并断言两侧互不可见。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '../dist/lib/adapter.js'
import { buildConversationRecall } from '../dist/lib/conversation-recall.js'
import { briefPlatformFor, isDelegatedAgent, resolveSessionChannel } from '../dist/lib/session-channel.js'

let passed = 0
const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const logger = { debug() {}, info() {}, warn() {}, error() {} }
const OWNER = '695115698'

type Db = Awaited<ReturnType<typeof openDatabase>>['db']

interface Fixture {
  dir: string
  db: Db
  close: () => void
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-channel-'))
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger })
  migrate(opened.db, logger)
  return {
    dir,
    db: opened.db,
    close: () => {
      opened.db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

interface SeedOptions {
  id: string
  kind: 'message' | 'model'
  text: string
  at: string
  platform: string
  channel: string
  sessionRef: string
}

function seed(db: Db, options: SeedOptions): void {
  db.run(
    `INSERT INTO sources (
       source_id, persona_id, platform, channel, session_ref, kind, text,
       captured_at, created_at, origin
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      options.id,
      'main',
      options.platform,
      options.channel,
      options.sessionRef,
      options.kind,
      options.text,
      options.at,
      options.at,
      'user',
    ],
  )
}

// ---- 纯函数判定 ----

await test('拿不到会话标识时判成 other，什么都读不到', () => {
  assert.equal(resolveSessionChannel(null, OWNER).kind, 'other')
  assert.equal(resolveSessionChannel('', OWNER).kind, 'other')
  assert.deepEqual(resolveSessionChannel(undefined, OWNER).platforms, [])
})

await test('Owner 的 QQ 私聊：只读 qq 的 private 源', () => {
  const channel = resolveSessionChannel(`qq-private-${OWNER}`, OWNER)
  assert.equal(channel.kind, 'owner-private')
  assert.deepEqual(channel.platforms, ['qq'])
  assert.equal(channel.sourceChannel, 'private')
})

await test('别人的 QQ 私聊判成 other', () => {
  assert.equal(resolveSessionChannel('qq-private-10001', OWNER).kind, 'other')
})

await test('Owner 未配置时，连 Owner 号也不认（fail-closed）', () => {
  assert.equal(resolveSessionChannel(`qq-private-${OWNER}`, '').kind, 'other')
  assert.equal(resolveSessionChannel(`qq-private-${OWNER}`, null).kind, 'other')
})

await test('QQ 群聊判成 other', () => {
  assert.equal(resolveSessionChannel('qq-group-987654321', OWNER).kind, 'other')
})

await test('桌面会话：给三种 platform，且不额外限制 channel', () => {
  const channel = resolveSessionChannel('c9d88fae-5ebc-44b5-bdec-2698c3f16155', OWNER)
  assert.equal(channel.kind, 'desktop')
  assert.deepEqual(channel.platforms, ['dsh-session', 'dsh', 'desktop'])
  assert.equal(channel.sourceChannel, null)
})

await test('项目 Brief 只在桌面侧装配', () => {
  assert.equal(briefPlatformFor(resolveSessionChannel('abc', OWNER)), 'desktop')
  assert.equal(briefPlatformFor(resolveSessionChannel(`qq-private-${OWNER}`, OWNER)), null)
  assert.equal(briefPlatformFor(resolveSessionChannel('qq-group-1', OWNER)), null)
})

// ---- 第 29 轮补的两条边界 ----

await test('可信绑定优先于会话标识形状', () => {
  // 形状看着像 Owner 私聊，但绑定说这是群聊 → 按绑定走。
  const group = resolveSessionChannel(`qq-private-${OWNER}`, OWNER, {
    platform: 'qq',
    contactId: 'ct_x',
    groupId: '987654321',
  })
  assert.equal(group.kind, 'other')
  // 形状判不出来（UUID），但绑定说这是 QQ 私聊且联系人就是 Owner → 认。
  const owner = resolveSessionChannel('957d9082-0000-0000-0000-000000000000', OWNER, {
    platform: 'qq',
    contactId: 'ct_owner',
    stableUserId: OWNER,
  })
  assert.equal(owner.kind, 'owner-private')
  assert.deepEqual(owner.platforms, ['qq'])
  assert.equal(owner.sourceChannel, 'private')
  // 绑定说是 QQ 私聊，但不是 Owner → 读不到。
  assert.equal(
    resolveSessionChannel('957d9082-1111-1111-1111-111111111111', OWNER, {
      platform: 'qq',
      contactId: 'ct_friend',
      stableUserId: '10001',
    }).kind,
    'other',
  )
  // 绑定说是桌面侧 → 三种 platform 全给。
  const desktop = resolveSessionChannel('957d9082-2222-2222-2222-222222222222', OWNER, {
    platform: 'desktop',
    contactId: null,
  })
  assert.equal(desktop.kind, 'desktop')
  assert.deepEqual(desktop.platforms, ['dsh-session', 'dsh', 'desktop'])
})

await test('没有绑定时退回形状判定（桌面会话本来就无绑定）', () => {
  assert.equal(resolveSessionChannel('c9d88fae-5ebc-44b5-bdec-2698c3f16155', OWNER, null).kind, 'desktop')
  assert.equal(resolveSessionChannel(`qq-private-${OWNER}`, OWNER, null).kind, 'owner-private')
})

await test('子代理会话按宿主 meta 判定，不看 UUID 形状', () => {
  assert.equal(isDelegatedAgent({ origin: 'subagent' }), true)
  assert.equal(isDelegatedAgent({ delegationDepth: 1 }), true)
  assert.equal(isDelegatedAgent({ delegationDepth: 0 }), false)
  assert.equal(isDelegatedAgent({ origin: 'user' }), false)
  assert.equal(isDelegatedAgent({}), false)
  assert.equal(isDelegatedAgent(null), false)
  assert.equal(isDelegatedAgent(undefined), false)
  // 关键反例：纯 UUID 的主会话和子会话形状完全相同，形状判断不得作为依据。
  const uuids = ['957d9082-3333-3333-3333-333333333333', 'c9d88fae-5ebc-44b5-bdec-2698c3f16155']
  for (const id of uuids) assert.equal(isDelegatedAgent({}), false)
})

// ---- 端到端：两侧互不可见 ----

const f = await setup()
seed(f.db, {
  id: 'src_d1', kind: 'message', platform: 'dsh-session', channel: 'desktop',
  sessionRef: 'session-desktop-1', at: '2026-02-01T09:00:00.000Z',
  text: '蓝盒子的标签是松针七号，这是桌面会话里说的事实',
})
seed(f.db, {
  id: 'src_q1', kind: 'message', platform: 'qq', channel: 'private',
  sessionRef: `qq-private-${OWNER}`, at: '2026-02-01T10:00:00.000Z',
  text: 'QQ 私聊里说过：周末去看海',
})
seed(f.db, {
  id: 'src_q2', kind: 'message', platform: 'qq', channel: 'group',
  sessionRef: 'qq-group-987654321', at: '2026-02-01T11:00:00.000Z',
  text: '群里有人说：明天开会改到下午',
})

await test('桌面会话召回桌面原文，不含任何 QQ 内容', () => {
  const channel = resolveSessionChannel('session-desktop-2', OWNER)
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: channel.platforms,
    sourceChannel: channel.sourceChannel,
    currentSessionRef: 'session-desktop-2',
    query: '蓝盒子',
    now: '2026-02-02T10:00:00.000Z',
  })
  assert.deepEqual(
    result.items.map((item) => item.sourceIds).flat(),
    ['src_d1'],
  )
  assert.ok(result.text !== null && result.text.includes('松针七号'))
})

await test('Owner 私聊召回到私聊原文，不含桌面和群聊内容', () => {
  const channel = resolveSessionChannel(`qq-private-${OWNER}`, OWNER)
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: channel.platforms,
    sourceChannel: channel.sourceChannel,
    currentSessionRef: `qq-private-${OWNER}`,
    query: '周末',
    now: '2026-02-02T10:00:00.000Z',
  })
  // 当前会话自己被排除，所以这里应当什么也召不到——证明它不会去读桌面或群聊。
  assert.equal(result.skipped, 'no-match')
})

await test('Owner 私聊在另一个会话里回忆时，只读到 private，不读 group', () => {
  const channel = resolveSessionChannel(`qq-private-${OWNER}`, OWNER)
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: channel.platforms,
    sourceChannel: channel.sourceChannel,
    currentSessionRef: 'some-other-session',
    query: '说过什么',
    now: '2026-02-02T10:00:00.000Z',
  })
  const ids = result.items.map((item) => item.sourceIds).flat()
  assert.ok(ids.includes('src_q1'), '要读到私聊源')
  assert.ok(!ids.includes('src_q2'), '群聊源不能出现在私聊上下文里')
  assert.ok(!ids.includes('src_d1'), '桌面源不能出现在 QQ 上下文里')
})

await test('其他 QQ 会话（other）平台列表为空，召回直接跳过', () => {
  const channel = resolveSessionChannel('qq-private-10001', OWNER)
  assert.equal(channel.platforms.length, 0)
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: channel.platforms,
    now: '2026-02-02T10:00:00.000Z',
  })
  assert.equal(result.text, null)
  assert.equal(result.skipped, 'no-persona')
})

console.log(`${passed} 通过 0 失败`)
f.close()
