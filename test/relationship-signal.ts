// P3-B-1 关系账本测试：身份解析、信号写入、好感重算、日上限、幂等与手动覆盖。
//
// 验收口径（docs/design/p3-b-relationship-ledger.md）：
// - 身份键 (platform, stable_user_id)：同名不同平台是两个人；
// - 分值由 Core 按规则表推导，调用方不传 baseDelta/confidence；
// - 同一 independence_key 只算一次；同 opId 重放不二次写；
// - 单条 |delta| ≤ 4，24h 净变化 ≤ ±8，manual_override=1 时重算跳过；
// - silence 只记账不改好感；affinity 夹在 0–100。
//
// 跑法：node test/relationship-signal.ts（需要先 npm run build）
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
const dir = mkdtempSync(join(tmpdir(), 'psyche-rel-signal-'))
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const T0 = '2026-11-12T04:00:00.000Z'
const signalCount = () => Number((db.get<{ n: number }>('SELECT COUNT(*) AS n FROM relationship_signals') as { n: number }).n)
const affinityOf = (contactId: string) =>
  db.get<{ affinity: number; band: string; manual_override: number }>(
    'SELECT affinity, band, manual_override FROM relationship_affinity_state WHERE contact_id = ?',
    [contactId],
  )

console.log('\n[P3-B-1] 关系账本与好感重算')

// ── A. 身份 ────────────────────────────────────────────────
const alice = await core.resolveContact({ platform: 'qq', stableUserId: '10001', displayName: 'Alice' })
const aliceAgain = await core.resolveContact({ platform: 'qq', stableUserId: '10001' })
const aliceElsewhere = await core.resolveContact({ platform: 'telegram', stableUserId: '10001' })
ok('A1 resolveContact 返回 ct_ 前缀', alice.contactId.startsWith('ct_'), alice.contactId)
eq('A2 同平台同 id 解析到同一 Contact', aliceAgain.contactId, alice.contactId)
ok('A3 同 id 不同平台是另一个 Contact', aliceElsewhere.contactId !== alice.contactId)
const renamed = await core.resolveContact({ platform: 'qq', stableUserId: '10001', displayName: 'Alice²' })
eq('A4 显示名更新后回读一致', renamed.displayName, 'Alice²')
const initial = affinityOf(alice.contactId)
eq('A5 新建档案好感初值 50', initial?.affinity, 50)
eq('A6 初值档位 neutral', initial?.band, 'neutral')

// 造一条真实 Source 作为证据；不存在的 id 必须被拒
const captured = await core.capture({ text: '真实证据', sessionRef: 'rel-1', at: T0 })
const evidenceId = captured.sourceId
ok('A7 capture 产出 sourceId', typeof evidenceId === 'string' && evidenceId.startsWith('src_'), evidenceId)

// ── B. 信号推导与写入 ─────────────────────────────────────
const s1 = await core.recordRelationshipSignal({
  opId: 'rel-op-1',
  contactId: alice.contactId,
  signalType: 'ordinary_interaction',
  polarity: 'positive',
  evidenceRefs: [evidenceId],
  independenceKey: 'msg-1',
  now: T0,
})
eq('B1 首次写入 duplicate=false', s1.duplicate, false)
eq('B2 ordinary 基准分 3', s1.baseDelta, 3)
near('B3 ordinary 中置信折后 1.8', Number(s1.appliedDelta), 1.8)
near('B4 好感 50 + 1.8 = 51.8', Number(affinityOf(alice.contactId)?.affinity), 51.8)
eq('B5 账本 1 行', signalCount(), 1)

const dup = await core.recordRelationshipSignal({
  contactId: alice.contactId,
  signalType: 'ordinary_interaction',
  polarity: 'positive',
  evidenceRefs: [evidenceId],
  independenceKey: 'msg-1',
  now: T0,
})
eq('B6 同 independenceKey 标记 duplicate', dup.duplicate, true)
eq('B7 同 independenceKey 返回同一 signalId', dup.signalId, s1.signalId)
eq('B8 重复不新增账本行', signalCount(), 1)
near('B9 重复不改好感', Number(affinityOf(alice.contactId)?.affinity), 51.8)

const replay = await core.recordRelationshipSignal({
  opId: 'rel-op-1',
  contactId: alice.contactId,
  signalType: 'ordinary_interaction',
  polarity: 'positive',
  evidenceRefs: [evidenceId],
  independenceKey: 'msg-1',
  now: T0,
})
eq('B10 同 opId 同参重放 replayed=true', replay.replayed, true)

await rejects('B11 未知信号类型拒绝', CODE.validation, () =>
  core.recordRelationshipSignal({
    contactId: alice.contactId, signalType: 'made_up', polarity: 'positive',
    evidenceRefs: [evidenceId], independenceKey: 'bad-1', now: T0,
  }),
)
await rejects('B12 方向与规则冲突拒绝', CODE.validation, () =>
  core.recordRelationshipSignal({
    contactId: alice.contactId, signalType: 'commitment_kept', polarity: 'negative',
    evidenceRefs: [evidenceId], independenceKey: 'bad-2', now: T0,
  }),
)
await rejects('B13 neutral 不能用于有分值的类型', CODE.validation, () =>
  core.recordRelationshipSignal({
    contactId: alice.contactId, signalType: 'commitment_kept', polarity: 'neutral',
    evidenceRefs: [evidenceId], independenceKey: 'bad-3', now: T0,
  }),
)
await rejects('B14 缺证据拒绝', CODE.validation, () =>
  core.recordRelationshipSignal({
    contactId: alice.contactId, signalType: 'commitment_kept', polarity: 'positive',
    independenceKey: 'bad-4', now: T0,
  }),
)
await rejects('B15 不存在的证据拒绝', CODE.validation, () =>
  core.recordRelationshipSignal({
    contactId: alice.contactId, signalType: 'commitment_kept', polarity: 'positive',
    evidenceRefs: ['src_missing'], independenceKey: 'bad-5', now: T0,
  }),
)
await rejects('B16 不存在的 Contact 抛 E_NOT_FOUND', CODE.notFound, () =>
  core.recordRelationshipSignal({
    contactId: 'ct_missing', signalType: 'repair', polarity: 'positive',
    evidenceRefs: [evidenceId], independenceKey: 'bad-6', now: T0,
  }),
)
await rejects('B17 空 independenceKey 拒绝', CODE.validation, () =>
  core.recordRelationshipSignal({
    contactId: alice.contactId, signalType: 'repair', polarity: 'positive',
    evidenceRefs: [evidenceId], independenceKey: '  ', now: T0,
  }),
)
await rejects('B18 证据超过 32 条拒绝', CODE.validation, () =>
  core.recordRelationshipSignal({
    contactId: alice.contactId, signalType: 'repair', polarity: 'positive',
    evidenceRefs: Array.from({ length: 33 }, (_, i) => `src_${i}`), independenceKey: 'bad-7', now: T0,
  }),
)

// ── C. 上限与特殊信号 ────────────────────────────────────
const bob = await core.resolveContact({ platform: 'qq', stableUserId: '20002', displayName: 'Bob' })
const violation = await core.recordRelationshipSignal({
  contactId: bob.contactId, signalType: 'boundary_violated', polarity: 'negative',
  evidenceRefs: [evidenceId], independenceKey: 'v-1', now: T0,
})
eq('C1 越界基准 5 被单条上限截断为 -4', violation.appliedDelta, -4)
near('C2 好感 50 - 4 = 46', Number(affinityOf(bob.contactId)?.affinity), 46)

const silence = await core.recordRelationshipSignal({
  contactId: bob.contactId, signalType: 'silence', polarity: 'neutral',
  evidenceRefs: [evidenceId], independenceKey: 'sil-1', now: T0,
})
eq('C3 silence applied=0', silence.appliedDelta, 0)
near('C4 silence 不改好感', Number(affinityOf(bob.contactId)?.affinity), 46)

const carol = await core.resolveContact({ platform: 'qq', stableUserId: '30003' })
const k1 = await core.recordRelationshipSignal({
  contactId: carol.contactId, signalType: 'commitment_kept', polarity: 'positive',
  evidenceRefs: [evidenceId], independenceKey: 'k-1', now: T0,
})
const k2 = await core.recordRelationshipSignal({
  contactId: carol.contactId, signalType: 'commitment_kept', polarity: 'positive',
  evidenceRefs: [evidenceId], independenceKey: 'k-2', now: T0,
})
const k3 = await core.recordRelationshipSignal({
  contactId: carol.contactId, signalType: 'commitment_kept', polarity: 'positive',
  evidenceRefs: [evidenceId], independenceKey: 'k-3', now: T0,
})
eq('C5 第一条 +4', k1.appliedDelta, 4)
eq('C6 第二条 +4', k2.appliedDelta, 4)
eq('C7 第三条触顶 +0', k3.appliedDelta, 0)
near('C8 日上限后好感 58', Number(affinityOf(carol.contactId)?.affinity), 58)

const later = '2026-11-13T05:00:00.000Z' // 25 小时后，窗口已滚出
const k4 = await core.recordRelationshipSignal({
  contactId: carol.contactId, signalType: 'commitment_kept', polarity: 'positive',
  evidenceRefs: [evidenceId], independenceKey: 'k-4', now: later,
})
eq('C9 25 小时后窗口重置，再 +4', k4.appliedDelta, 4)
near('C10 好感 62', Number(affinityOf(carol.contactId)?.affinity), 62)

// manual_override：重算必须跳过，但账本仍记账
db.run('UPDATE relationship_affinity_state SET affinity = ?, band = ?, manual_override = 1 WHERE contact_id = ?', [70, 'friendly', carol.contactId])
const manual = await core.recordRelationshipSignal({
  contactId: carol.contactId, signalType: 'commitment_broken', polarity: 'negative',
  evidenceRefs: [evidenceId], independenceKey: 'k-5', now: later,
})
eq('C11 manual_override 标记回传', manual.manualOverride, true)
eq('C12 手动覆盖时 applied 仍记账', manual.appliedDelta, -4)
near('C13 手动覆盖时好感不变', Number(affinityOf(carol.contactId)?.affinity), 70)

// 夹到 100
db.run('UPDATE relationship_affinity_state SET affinity = ?, band = ?, manual_override = 0 WHERE contact_id = ?', [99, 'very_close', carol.contactId])
const dave = await core.resolveContact({ platform: 'qq', stableUserId: '40004' })
db.run('UPDATE relationship_affinity_state SET affinity = ?, band = ?, manual_override = 0 WHERE contact_id = ?', [99, 'very_close', dave.contactId])
await core.recordRelationshipSignal({
  contactId: dave.contactId, signalType: 'commitment_kept', polarity: 'positive',
  evidenceRefs: [evidenceId], independenceKey: 'd-1', now: later,
})
near('C14 好感夹在 100', Number(affinityOf(dave.contactId)?.affinity), 100)

console.log(`\n[P3-B relationship-signal] ${passed} 通过 ${failed} 失败`)
db.close()
rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exit(1)
