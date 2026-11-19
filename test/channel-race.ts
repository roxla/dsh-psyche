// R6-4A/B：异步生命周期竞态。
//
// 要证明的不是「隔离矩阵更大」，而是：销毁和注销之后，任何迟到的异步结果
// 都没有能力把旧权限重新写回来。
//
// 覆盖：
// A1. resolveIdentity 挂起中 Agent 被销毁 → 迟到的声明不能绑定
// A2. Contact 解析挂起中 Agent 被销毁 → 迟到的解析不能绑定
// A3. Adapter 注销后 resolveIdentity 才返回 → 拒绝
// A4. Adapter A 注销、同 ID 注册 B、A 的旧 Promise 返回 → 不得用 B 的能力
// A5. 新 Agent 复用同一 Session ID → 旧任务不得覆盖新绑定
// A6. disposed 后使用旧代际再绑定 → E_STATE
// A7. 重复注册同 ID → E_STATE
// A8. 正常路径（代际有效）仍然绑定成功
//
// 跑法：node test/channel-race.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import {
  AgentBindingLifecycle,
  ChannelAdapterRegistry,
  resolveTrustedBinding,
} from '../dist/lib/channel-binding.js'
import { RuntimeInputStore } from '../dist/lib/runtime-input.js'

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

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-channel-race-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const now = new Date().toISOString()
db.run(
  `INSERT INTO rooms (room_id, persona_id, platform, channel, external_room_id, title, capture_mode, active, created_at, updated_at)
   VALUES ('rr_race_group', 'main', 'qq', 'group', 'race-8888', '竞态测试群', 'mentioned_only', 1, ?, ?)`,
  [now, now],
)

function makeDeps(registry, store, lifecycle, contactHook) {
  return {
    db,
    store,
    registry,
    lifecycle,
    resolveContact: async (input) => {
      if (contactHook !== undefined) {
        const hooked = await contactHook(input)
        if (hooked !== undefined) return hooked
      }
      const resolved = await core.resolveContact({ platform: input.platform, stableUserId: input.stableUserId })
      return { contactId: resolved.contactId }
    },
  }
}

console.log('\n[R6-4] 异步生命周期竞态')

// ── A1：resolveIdentity 挂起中 Agent 被销毁 ──────────────────────────────
{
  const registry = new ChannelAdapterRegistry()
  const store = new RuntimeInputStore()
  const lifecycle = new AgentBindingLifecycle()
  const gate = deferred()
  registry.register({
    adapterId: 'race-a1',
    platform: 'race-a1',
    allowedSurfaces: ['private'],
    resolveIdentity: async () => {
      await gate.promise
      return { kind: 'private', stableUserId: 'u-a1' }
    },
  })
  const generation = lifecycle.begin('sess-a1')
  const pending = resolveTrustedBinding(makeDeps(registry, store, lifecycle), {
    agentId: 'sess-a1',
    sessionId: 'sess-a1',
    generation,
    platformHint: 'race-a1',
  })
  lifecycle.end('sess-a1')
  gate.resolve()
  await rejectsCode('A1 resolveIdentity 挂起中销毁 → 迟到声明被丢弃', () => pending, 'E_STATE')
  eq('A1 销毁后没有留下绑定', store.size(), 0)
}

// ── A2：Contact 解析挂起中 Agent 被销毁 ──────────────────────────────────
{
  const registry = new ChannelAdapterRegistry()
  const store = new RuntimeInputStore()
  const lifecycle = new AgentBindingLifecycle()
  const gate = deferred()
  registry.register({
    adapterId: 'race-a2',
    platform: 'race-a2',
    allowedSurfaces: ['private'],
    resolveIdentity: async () => ({ kind: 'private', stableUserId: 'u-a2' }),
  })
  const generation = lifecycle.begin('sess-a2')
  const pending = resolveTrustedBinding(
    makeDeps(registry, store, lifecycle, async () => {
      await gate.promise
      return { contactId: 'ct_a2_race' }
    }),
    { agentId: 'sess-a2', sessionId: 'sess-a2', generation, platformHint: 'race-a2' },
  )
  lifecycle.end('sess-a2')
  gate.resolve()
  await rejectsCode('A2 Contact 解析挂起中销毁 → 迟到解析被丢弃', () => pending, 'E_STATE')
  eq('A2 销毁后没有留下绑定', store.size(), 0)
}

// ── A3：Adapter 注销后 resolveIdentity 才返回 ────────────────────────────
{
  const registry = new ChannelAdapterRegistry()
  const store = new RuntimeInputStore()
  const lifecycle = new AgentBindingLifecycle()
  const gate = deferred()
  const registration = registry.register({
    adapterId: 'race-a3',
    platform: 'race-a3',
    allowedSurfaces: ['private'],
    resolveIdentity: async () => {
      await gate.promise
      return { kind: 'private', stableUserId: 'u-a3' }
    },
  })
  const generation = lifecycle.begin('sess-a3')
  const pending = resolveTrustedBinding(makeDeps(registry, store, lifecycle), {
    agentId: 'sess-a3',
    sessionId: 'sess-a3',
    generation,
    platformHint: 'race-a3',
  })
  registration.dispose()
  gate.resolve()
  await rejectsCode('A3 注销后迟到的身份声明被丢弃', () => pending, 'E_STATE')
  eq('A3 store 为空', store.size(), 0)
}

// ── A4：同 ID 重新注册，旧 Promise 不得用新能力 ─────────────────────────
{
  const registry = new ChannelAdapterRegistry()
  const store = new RuntimeInputStore()
  const lifecycle = new AgentBindingLifecycle()
  const gate = deferred()
  const oldRegistration = registry.register({
    adapterId: 'race-a4',
    platform: 'race-a4',
    allowedSurfaces: ['private'],
    resolveIdentity: async () => {
      await gate.promise
      return { kind: 'private', stableUserId: 'u-old' }
    },
  })
  const generation = lifecycle.begin('sess-a4')
  const pending = resolveTrustedBinding(makeDeps(registry, store, lifecycle), {
    agentId: 'sess-a4',
    sessionId: 'sess-a4',
    generation,
    platformHint: 'race-a4',
  })
  oldRegistration.dispose()
  registry.register({
    adapterId: 'race-a4',
    platform: 'race-a4',
    allowedSurfaces: ['private'],
    resolveIdentity: async () => ({ kind: 'private', stableUserId: 'u-new' }),
  })
  gate.resolve()
  await rejectsCode('A4 旧注册的迟到结果被丢弃', () => pending, 'E_STATE')
  eq('A4 新注册没有被旧任务写入', store.read('sess-a4'), null)
}

// ── A5：新 Agent 复用同一 Session ID ────────────────────────────────────
{
  const registry = new ChannelAdapterRegistry()
  const store = new RuntimeInputStore()
  const lifecycle = new AgentBindingLifecycle()
  const gate = deferred()
  registry.register({
    adapterId: 'race-a5',
    platform: 'race-a5',
    allowedSurfaces: ['private'],
    resolveIdentity: async (context) => {
      if (context.agentId === 'agent-old') {
        await gate.promise
        return { kind: 'private', stableUserId: 'u-old' }
      }
      return { kind: 'private', stableUserId: 'u-new' }
    },
  })
  const generationOld = lifecycle.begin('sess-a5')
  const pendingOld = resolveTrustedBinding(makeDeps(registry, store, lifecycle), {
    agentId: 'agent-old',
    sessionId: 'sess-a5',
    generation: generationOld,
    platformHint: 'race-a5',
  })
  lifecycle.end('sess-a5')
  const generationNew = lifecycle.begin('sess-a5')
  const boundNew = await resolveTrustedBinding(makeDeps(registry, store, lifecycle), {
    agentId: 'agent-new',
    sessionId: 'sess-a5',
    generation: generationNew,
    platformHint: 'race-a5',
  })
  gate.resolve()
  await rejectsCode('A5 旧 Agent 的迟到结果被丢弃', () => pendingOld, 'E_STATE')
  eq('A5 新 Agent 的绑定没有被旧任务覆盖', store.read('sess-a5')?.stableUserId, 'u-new')
  eq('A5 新绑定返回的是新身份', boundNew?.stableUserId, 'u-new')
}

// ── A6：disposed 后用旧代际再绑定 ───────────────────────────────────────
{
  const registry = new ChannelAdapterRegistry()
  const store = new RuntimeInputStore()
  const lifecycle = new AgentBindingLifecycle()
  registry.register({
    adapterId: 'race-a6',
    platform: 'race-a6',
    allowedSurfaces: ['private'],
    resolveIdentity: async () => ({ kind: 'private', stableUserId: 'u-a6' }),
  })
  const generation = lifecycle.begin('sess-a6')
  lifecycle.end('sess-a6')
  await rejectsCode('A6 销毁后用旧代际绑定被拒绝', () => resolveTrustedBinding(makeDeps(registry, store, lifecycle), {
    agentId: 'sess-a6',
    sessionId: 'sess-a6',
    generation,
    platformHint: 'race-a6',
  }), 'E_STATE')
  eq('A6 store 为空', store.size(), 0)
}

// ── A7：重复注册同 ID ──────────────────────────────────────────────────
{
  const registry = new ChannelAdapterRegistry()
  registry.register({
    adapterId: 'race-a7',
    platform: 'race-a7',
    allowedSurfaces: ['private'],
    resolveIdentity: async () => ({ kind: 'private', stableUserId: 'u-a7' }),
  })
  await rejectsCode('A7 重复注册同 ID 被拒绝', async () => {
    registry.register({
      adapterId: 'race-a7',
      platform: 'race-a7',
      allowedSurfaces: ['private'],
      resolveIdentity: async () => ({ kind: 'private', stableUserId: 'u-a7b' }),
    })
  }, 'E_STATE')
}

// ── A8：正常路径仍然绑定成功 ────────────────────────────────────────────
{
  const registry = new ChannelAdapterRegistry()
  const store = new RuntimeInputStore()
  const lifecycle = new AgentBindingLifecycle()
  registry.register({
    adapterId: 'race-a8',
    platform: 'qq',
    allowedSurfaces: ['group'],
    resolveIdentity: async () => ({ kind: 'group', stableUserId: 'u-a8', externalRoomId: 'race-8888' }),
  })
  const generation = lifecycle.begin('sess-a8')
  const bound = await resolveTrustedBinding(makeDeps(registry, store, lifecycle), {
    agentId: 'sess-a8',
    sessionId: 'sess-a8',
    generation,
    platformHint: 'qq',
  })
  eq('A8 代际有效时仍能绑定', bound?.surface, 'group')
  eq('A8 群绑定解析出 Room', bound?.roomId, 'rr_race_group')
  eq('A8 store 读回一致', store.read('sess-a8')?.groupId, 'race-8888')
}

console.log(`\n[R6-4] ${passed} 通过 ${failed} 失败`)
db.close()
rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exit(1)
