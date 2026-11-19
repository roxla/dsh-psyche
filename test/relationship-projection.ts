// P3-B-3 关系投影测试：把档位/信任/当下感受压成一行受控文本，且不泄露内部数据。
//
// 验收口径（docs/design/p3-b-relationship-ledger.md §4）：
// - 只输出档位标签 + 信任档位（如有）+ 至多一条当下感受（≥40 才出现）；
// - 不出现数值、contact_id、信号计数、证据或内部 key；
// - 无 Contact → E_NOT_FOUND（由调用方决定不注入）；读取失败不注入「中立」；
// - 每轮现算、不写库；同一输入同一输出。
//
// 跑法：node test/relationship-projection.ts（需要先 npm run build）
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODE } from '../packages/core/dist/errors.js'
import { openDatabase, migrate } from '../packages/core/dist/adapter.js'
import { Core } from '../packages/core/dist/store.js'
import {
  AFFECT_NOTICE_THRESHOLD,
  RELATIONSHIP_PROJECTION_VERSION,
  projectRelationshipBrief,
} from '../packages/core/dist/relationship-projection.js'

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
const dir = mkdtempSync(join(tmpdir(), 'psyche-projection-'))
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const T0 = '2026-11-12T04:00:00.000Z'

console.log('\n[P3-B-3] Relationship Projection')

// ── A. 纯投影规则 ─────────────────────────────────────────
const bandCases = [
  ['very_close', '非常亲近'],
  ['high', '较高'],
  ['friendly', '友好'],
  ['neutral', '中立'],
  ['cautious', '谨慎'],
  ['distant', '疏远'],
  ['hostile', '强烈反感'],
] as const
for (const [band, label] of bandCases) {
  const text = projectRelationshipBrief({ affinityBand: band, trustBand: null, affect: [] }).text
  eq(`A 档位 ${band} -> ${label}`, text, `关系：${label}。`)
}

const noTrust = projectRelationshipBrief({ affinityBand: 'friendly', trustBand: null, affect: [] }).text
ok('A 未评估信任不输出信任段', !noTrust.includes('信任'))

for (const [band, label] of [['high', '较高'], ['medium', '一般'], ['low', '较低']] as const) {
  const text = projectRelationshipBrief({ affinityBand: 'friendly', trustBand: band, affect: [] }).text
  eq(`A 信任 ${band} -> ${label}`, text, `关系：友好。信任：${label}。`)
}

const below = projectRelationshipBrief({
  affinityBand: 'neutral',
  trustBand: null,
  affect: [{ dimension: 'warmth', value: AFFECT_NOTICE_THRESHOLD - 0.01 }],
}).text
ok('A 低于阈值不输出当下感受', !below.includes('此刻'))

const atThreshold = projectRelationshipBrief({
  affinityBand: 'neutral',
  trustBand: null,
  affect: [{ dimension: 'warmth', value: AFFECT_NOTICE_THRESHOLD }],
}).text
ok('A 达到阈值输出当下感受', atThreshold.includes('此刻觉得亲近'), atThreshold)

const strongest = projectRelationshipBrief({
  affinityBand: 'neutral',
  trustBand: null,
  affect: [
    { dimension: 'hurt', value: 45 },
    { dimension: 'missing', value: 60 },
    { dimension: 'tension', value: 50 },
  ],
}).text
ok('A 只输出最强的一条', strongest.includes('此刻有些想念') && !strongest.includes('受伤'), strongest)

const tie = projectRelationshipBrief({
  affinityBand: 'neutral',
  trustBand: null,
  affect: [
    { dimension: 'tension', value: 50 },
    { dimension: 'warmth', value: 50 },
  ],
}).text
ok('A 同分按 AFFECT_KEYS 顺序取 warmth', tie.includes('此刻觉得亲近'), tie)

const withNumberLike = projectRelationshipBrief({
  affinityBand: 'friendly',
  trustBand: 'medium',
  affect: [{ dimension: 'missing', value: 88 }],
}).text
ok('A 文本不含任何数字', !/[0-9]/.test(withNumberLike), withNumberLike)
ok('A 文本不含内部 id 前缀', !withNumberLike.includes('ct_') && !withNumberLike.includes('art_'))

const first = projectRelationshipBrief({ affinityBand: 'high', trustBand: 'low', affect: [] })
const second = projectRelationshipBrief({ affinityBand: 'high', trustBand: 'low', affect: [] })
eq('A 同一输入同一输出', first, second)
ok('A 结果是冻结对象', Object.isFrozen(first))
eq('A 投影版本', first.version, RELATIONSHIP_PROJECTION_VERSION)

try {
  projectRelationshipBrief({ affinityBand: 'unknown' as never, trustBand: null, affect: [] })
  ok('A 未知档位抛 E_VALIDATION', false, { reason: '没有抛错' })
} catch (error) {
  ok('A 未知档位抛 E_VALIDATION', (error as { code?: string }).code === CODE.validation)
}
try {
  projectRelationshipBrief({ affinityBand: 'friendly', trustBand: 'great' as never, affect: [] })
  ok('A 未知信任档位抛 E_VALIDATION', false, { reason: '没有抛错' })
} catch (error) {
  ok('A 未知信任档位抛 E_VALIDATION', (error as { code?: string }).code === CODE.validation)
}

// ── B. 快照读取与投影 ─────────────────────────────────────
const alice = await core.resolveContact({ platform: 'qq', stableUserId: '41001', displayName: 'Alice' })
const bob = await core.resolveContact({ platform: 'qq', stableUserId: '41002', displayName: 'Bob' })

const initial = core.readRelationshipBrief(alice.contactId, { now: T0 })
eq('B1 新联系人档位 neutral', initial.affinityBand, 'neutral')
eq('B2 新联系人信任未评估', initial.trustBand, null)
eq('B3 新联系人五维全 0', initial.affect.map((item) => item.value), [0, 0, 0, 0, 0])

const ev = await core.capture({ text: '她记得我说过的话', sessionRef: 'proj-a', at: T0, senderContactId: alice.contactId })
for (let i = 0; i < 4; i += 1) {
  await core.recordContactAffect({
    contactId: alice.contactId,
    updates: [{ dimension: 'warmth', delta: 10, evidenceRefs: [ev.sourceId] }],
    now: T0,
  })
}
const warm = core.readRelationshipBrief(alice.contactId, { now: T0 })
ok('B4 warmth 40 出现在备注', warm.affect.find((item) => item.dimension === 'warmth')?.value === 40)
const warmText = projectRelationshipBrief(warm).text
ok('B5 投影含「此刻觉得亲近」', warmText.includes('此刻觉得亲近'), warmText)

const later = '2026-11-12T12:00:00.000Z' // 8h 后 warmth 减半到 20，低于门槛
const decayed = core.readRelationshipBrief(alice.contactId, { now: later })
const decayedText = projectRelationshipBrief(decayed).text
ok('B6 冷却后不再输出当下感受', !decayedText.includes('此刻'), decayedText)

const bobText = projectRelationshipBrief(core.readRelationshipBrief(bob.contactId, { now: T0 })).text
ok('B7 另一个联系人不受影响', !bobText.includes('此刻') && bobText.includes('中立'), bobText)

const src2 = await core.capture({ text: '这次她主动来问我近况', sessionRef: 'proj-b', at: T0, senderContactId: alice.contactId })
await core.reviewContactTrust({
  contactId: alice.contactId,
  proposedValue: 55,
  evidenceRefs: [ev.sourceId, src2.sourceId],
  decidedBy: 'owner',
  now: T0,
})
const trusted = projectRelationshipBrief(core.readRelationshipBrief(alice.contactId, { now: T0 })).text
ok('B8 信任评估进入投影', trusted.includes('信任：一般'), trusted)
ok('B9 投影仍不含数字', !/[0-9]/.test(trusted), trusted)

await rejects('B10 未知 Contact 抛 E_NOT_FOUND', CODE.notFound, async () => {
  core.readRelationshipBrief('ct_missing', { now: T0 })
})

// 只读：投影前后 Mood / 非关系表行数不变（简化为 relationship_signals 与 artifacts 计数）
const beforeRows = db.get<{ n: number }>('SELECT count(*) AS n FROM artifacts') as { n: number }
core.readRelationshipBrief(alice.contactId, { now: T0 })
const afterRows = db.get<{ n: number }>('SELECT count(*) AS n FROM artifacts') as { n: number }
eq('B11 投影不写 artifacts', afterRows.n, beforeRows.n)

db.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n[P3-B-3 relationship-projection] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exit(1)
