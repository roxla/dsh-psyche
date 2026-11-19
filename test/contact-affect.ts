// P3-B-2 Contact Affect 测试：五维、冷却回 0、单次上限、证据、幂等、隔离与历史不可变。
//
// 验收口径（docs/design/p3-b-relationship-ledger.md §2.2 / §3.3）：
// - 五维 baseline=0，半衰期 warmth 8h / tension 3h / hurt 12h / missing 12h / irritation 2h；
// - 单维单次 |delta| ≤ 10；每维至少一条真实证据；同批不重复维度；
// - 先按 updated_at 冷却到 now 再加 delta；clamp 0–100；
// - op_id 重放不二次写；跨联系人隔离；
// - 历史行由 Schema v20 触发器保证不可 UPDATE / 手工 DELETE（删 Contact 的级联除外）。
//
// 跑法：node test/contact-affect.ts（需要先 npm run build）
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODE } from '../packages/core/dist/errors.js'
import { openDatabase, migrate } from '../packages/core/dist/adapter.js'
import { Core } from '../packages/core/dist/store.js'

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
function near(label: string, actual: number, expected: number, tolerance = 1e-6): void {
  ok(label, Math.abs(actual - expected) <= tolerance, { actual, expected })
}
async function rejects(label: string, code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
    ok(label, false, { reason: '没有抛错' })
  } catch (error) {
    const actual = (error as { code?: string }).code
    ok(label, actual === code, { actual, code, message: (error as Error).message })
  }
}

const log = { info() {}, debug() {}, warn() {}, error() {} }
const dir = mkdtempSync(join(tmpdir(), 'psyche-affect-'))
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const T0 = '2026-11-12T04:00:00.000Z'
const HOUR = 60 * 60 * 1000
const historyCount = () =>
  Number((db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_affect_history') as { n: number }).n)
const stateCount = () =>
  Number((db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_affect_state') as { n: number }).n)

console.log('\n[P3-B-2] Contact Affect')

// ── A. 初始与读路径 ───────────────────────────────────────
const alice = await core.resolveContact({ platform: 'qq', stableUserId: '20001', displayName: 'Alice' })
const bob = await core.resolveContact({ platform: 'qq', stableUserId: '20002', displayName: 'Bob' })
const empty = await core.loadContactAffect(alice.contactId, { now: T0 })
eq('A1 初始五维全 0', empty.values, { warmth: 0, tension: 0, hurt: 0, missing: 0, irritation: 0 })
eq('A2 读路径不建状态行', stateCount(), 0)
await rejects('A3 不存在的 Contact 抛 E_NOT_FOUND', CODE.notFound, () =>
  core.loadContactAffect('ct_missing', { now: T0 }),
)

const captured = await core.capture({ text: '今天聊得很开心', sessionRef: 'aff-1', at: T0 })
const evidenceId = captured.sourceId
ok('A4 capture 产出 sourceId', typeof evidenceId === 'string' && evidenceId.startsWith('src_'), evidenceId)

// ── B. 写入与幂等 ─────────────────────────────────────────
const first = await core.recordContactAffect({
  opId: 'aff-op-1',
  contactId: alice.contactId,
  updates: [{ dimension: 'warmth', delta: 3, evidenceRefs: [evidenceId] }],
  now: T0,
})
eq('B1 warmth +3', first.values.warmth, 3)
eq('B2 只写一个状态行', stateCount(), 1)
eq('B3 历史一行', historyCount(), 1)

const replay = await core.recordContactAffect({
  opId: 'aff-op-1',
  contactId: alice.contactId,
  updates: [{ dimension: 'warmth', delta: 3, evidenceRefs: [evidenceId] }],
  now: T0,
})
ok('B4 同 opId 重放', replay.replayed === true)
eq('B5 重放不新增历史', historyCount(), 1)

// ── C. 冷却 ───────────────────────────────────────────────
db.run(`UPDATE contact_affect_state SET updated_at = ? WHERE contact_id = ? AND dimension = 'warmth'`, [
  new Date(Date.parse(T0) - 8 * HOUR).toISOString(),
  alice.contactId,
])
const decayed = await core.loadContactAffect(alice.contactId, { now: T0 })
near('C1 8h 后暖意减半', decayed.values.warmth, 1.5)
db.run(`UPDATE contact_affect_state SET updated_at = ? WHERE contact_id = ? AND dimension = 'warmth'`, [
  new Date(Date.parse(T0) - 16 * HOUR).toISOString(),
  alice.contactId,
])
const decayed2 = await core.loadContactAffect(alice.contactId, { now: T0 })
near('C2 16h 后暖意 1/4', decayed2.values.warmth, 0.75)

// ── D. 校验 ───────────────────────────────────────────────
await rejects('D1 未知维度拒绝', CODE.validation, () =>
  core.recordContactAffect({
    contactId: alice.contactId,
    updates: [{ dimension: 'rage' as never, delta: 1, evidenceRefs: [evidenceId] }],
    now: T0,
  }),
)
await rejects('D2 单次超过 ±10 拒绝', CODE.validation, () =>
  core.recordContactAffect({
    contactId: alice.contactId,
    updates: [{ dimension: 'warmth', delta: 11, evidenceRefs: [evidenceId] }],
    now: T0,
  }),
)
await rejects('D3 缺证据拒绝', CODE.validation, () =>
  core.recordContactAffect({
    contactId: alice.contactId,
    updates: [{ dimension: 'warmth', delta: 1, evidenceRefs: [] }],
    now: T0,
  }),
)
await rejects('D4 证据不存在拒绝', CODE.validation, () =>
  core.recordContactAffect({
    contactId: alice.contactId,
    updates: [{ dimension: 'warmth', delta: 1, evidenceRefs: ['src_missing'] }],
    now: T0,
  }),
)
await rejects('D5 同批重复维度拒绝', CODE.validation, () =>
  core.recordContactAffect({
    contactId: alice.contactId,
    updates: [
      { dimension: 'warmth', delta: 1, evidenceRefs: [evidenceId] },
      { dimension: 'warmth', delta: 2, evidenceRefs: [evidenceId] },
    ],
    now: T0,
  }),
)

// ── E. 上限与负向 ─────────────────────────────────────────
await core.recordContactAffect({
  opId: 'aff-op-cap-1',
  contactId: bob.contactId,
  updates: [{ dimension: 'warmth', delta: 10, evidenceRefs: [evidenceId] }],
  now: T0,
})
const capped = await core.recordContactAffect({
  opId: 'aff-op-cap-2',
  contactId: bob.contactId,
  updates: [{ dimension: 'warmth', delta: 10, evidenceRefs: [evidenceId] }],
  now: T0,
})
near('E1 两次 +10 到 20', capped.values.warmth, 20)
const floor = await core.recordContactAffect({
  opId: 'aff-op-floor',
  contactId: bob.contactId,
  updates: [{ dimension: 'irritation', delta: -5, evidenceRefs: [evidenceId] }],
  now: T0,
})
near('E2 从 0 减不越下界', floor.values.irritation, 0)

for (let i = 0; i < 9; i += 1) {
  await core.recordContactAffect({
    opId: `aff-op-max-${i}`,
    contactId: bob.contactId,
    updates: [{ dimension: 'warmth', delta: 10, evidenceRefs: [evidenceId] }],
    now: T0,
  })
}
const maxed = await core.loadContactAffect(bob.contactId, { now: T0 })
near('E3 上限夹到 100', maxed.values.warmth, 100)
const over = await core.recordContactAffect({
  opId: 'aff-op-over',
  contactId: bob.contactId,
  updates: [{ dimension: 'warmth', delta: 10, evidenceRefs: [evidenceId] }],
  now: T0,
})
near('E4 已 100 不再增长', over.values.warmth, 100)

// ── F. 隔离 ───────────────────────────────────────────────
const aliceNow = await core.loadContactAffect(alice.contactId, { now: T0 })
near('F1 Bob 的写入不影响 Alice', aliceNow.values.warmth, 0.75)
const bobNow = await core.loadContactAffect(bob.contactId, { now: T0 })
near('F2 Bob 自己的值独立', bobNow.values.warmth, 100)

// ── G. 历史不可变 ─────────────────────────────────────────
let updateBlocked = false
try {
  db.run(`UPDATE contact_affect_history SET value = 999`)
} catch (error) {
  updateBlocked = /append-only/.test((error as Error).message)
}
ok('G1 历史 UPDATE 被库级触发器拦下', updateBlocked)
let deleteBlocked = false
try {
  db.run(`DELETE FROM contact_affect_history`)
} catch (error) {
  deleteBlocked = /append-only/.test((error as Error).message)
}
ok('G2 历史手工 DELETE 被拦下', deleteBlocked)
const beforeCascade = historyCount()
const bobHistory = Number(
  (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_affect_history WHERE contact_id = ?', [
    bob.contactId,
  ]) as { n: number }).n,
)
db.run(`DELETE FROM contacts WHERE contact_id = ?`, [bob.contactId])
eq('G3 删 Contact 时级联清空该人历史', historyCount(), beforeCascade - bobHistory)

db.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n[P3-B-2 contact-affect] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exit(1)
