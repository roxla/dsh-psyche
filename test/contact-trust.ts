// P3-B-2 Contact Trust 测试：专用写入口、独立性、单次 ±20、revision、读取校正与隔离。
//
// 验收口径（docs/design/p3-b-relationship-ledger.md §3.4）：
// - 初始 unassessed（getRelationship().trust === null），不是 50；
// - 只接受 decidedBy='owner'；persona / 模型自报返回 E_VALIDATION；
// - 至少两条独立证据（按活动窗口去重，不是数组长度）；
// - 单次变化 ≤ ±20；0–100；写新 revision 而不是覆盖旧行；
// - 读取只认 payload.type='contact_trust_assessment' + subject_refs 精确成员；
// - 不同 Contact 的 Trust 不互相串。
//
// 跑法：node test/contact-trust.ts（需要先 npm run build）
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODE } from '../packages/core/dist/errors.js'
import { openDatabase, migrate } from '../packages/core/dist/adapter.js'
import { Core } from '../packages/core/dist/store.js'
import { isContactTrustPayload, trustBandOf } from '../packages/core/dist/contact-trust.js'

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
const dir = mkdtempSync(join(tmpdir(), 'psyche-trust-'))
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const T0 = '2026-11-12T04:00:00.000Z'

console.log('\n[P3-B-2] Contact Trust')

// 两个联系人：alice 做信任评估，bob 做隔离对照
const alice = await core.resolveContact({ platform: 'qq', stableUserId: '30001', displayName: 'Alice' })
const bob = await core.resolveContact({ platform: 'qq', stableUserId: '30002', displayName: 'Bob' })

const aliceInitial = await core.getRelationship(alice.contactId)
eq('A1 初始 Trust 为 unassessed（null）', aliceInitial.trust, null)

// 两条独立证据：不同会话 → 不同活动窗口
const ev1 = await core.capture({ text: '她每次都记得我说过的话', sessionRef: 'trust-a', at: T0, senderContactId: alice.contactId })
const ev2 = await core.capture({ text: '这次她主动来问我近况', sessionRef: 'trust-b', at: T0, senderContactId: alice.contactId })
const sameWindow1 = await core.capture({ text: '同一窗口第一条', sessionRef: 'trust-c', at: T0 })
const sameWindow2 = await core.capture({ text: '同一窗口第二条', sessionRef: 'trust-c', at: T0 })
ok('A2 两个独立 sourceId', ev1.sourceId !== ev2.sourceId)
ok('A3 同会话两条落在同一窗口', sameWindow1.sourceId !== sameWindow2.sourceId)

// ── B. 权限与证据校验 ─────────────────────────────────────
await rejects('B1 persona 不得复核 Trust', CODE.validation, () =>
  core.reviewContactTrust({
    contactId: alice.contactId,
    proposedValue: 50,
    evidenceRefs: [ev1.sourceId, ev2.sourceId],
    decidedBy: 'persona',
    now: T0,
  }),
)
await rejects('B2 缺少 decidedBy 拒绝', CODE.validation, () =>
  core.reviewContactTrust({
    contactId: alice.contactId,
    proposedValue: 50,
    evidenceRefs: [ev1.sourceId, ev2.sourceId],
    now: T0,
  }),
)
await rejects('B3 单条证据拒绝', CODE.validation, () =>
  core.reviewContactTrust({
    contactId: alice.contactId,
    proposedValue: 50,
    evidenceRefs: [ev1.sourceId],
    decidedBy: 'owner',
    now: T0,
  }),
)
await rejects('B4 同窗口两条不算独立证据', CODE.validation, () =>
  core.reviewContactTrust({
    contactId: alice.contactId,
    proposedValue: 50,
    evidenceRefs: [sameWindow1.sourceId, sameWindow2.sourceId],
    decidedBy: 'owner',
    now: T0,
  }),
)
await rejects('B5 非 Source 证据拒绝', CODE.validation, () =>
  core.reviewContactTrust({
    contactId: alice.contactId,
    proposedValue: 50,
    evidenceRefs: [ev1.sourceId, 'evt_missing'],
    decidedBy: 'owner',
    now: T0,
  }),
)

// ── C. 首次评估 ───────────────────────────────────────────
const first = await core.reviewContactTrust({
  opId: 'trust-op-1',
  contactId: alice.contactId,
  proposedValue: 55,
  evidenceRefs: [ev1.sourceId, ev2.sourceId],
  decidedBy: 'owner',
  now: T0,
})
eq('C1 首次评估 value=55', first.value, 55)
eq('C2 band=medium', first.band, 'medium')
eq('C3 revision=1', first.revision, 1)
eq('C4 previous=null', first.previous, null)
ok('C5 产出 ct_ 之外的 artifactId', first.artifactId.startsWith('art_'), first.artifactId)

const read1 = await core.getRelationship(alice.contactId)
near('C6 读取 Trust value', read1.trust?.value ?? -1, 55)
eq('C7 读取 Trust band', read1.trust?.band, 'medium')
eq('C8 读取 Trust revision', read1.trust?.revision, 1)

// ── D. 改口与单次上限 ─────────────────────────────────────
await rejects('D1 单次变化超过 ±20 拒绝', CODE.validation, () =>
  core.reviewContactTrust({
    contactId: alice.contactId,
    proposedValue: 76,
    evidenceRefs: [ev1.sourceId, ev2.sourceId],
    decidedBy: 'owner',
    now: T0,
  }),
)
const raised = await core.reviewContactTrust({
  opId: 'trust-op-2',
  contactId: alice.contactId,
  proposedValue: 70,
  evidenceRefs: [ev1.sourceId, ev2.sourceId],
  decidedBy: 'owner',
  now: T0,
})
eq('D2 55→70 允许（±20 内）', raised.value, 70)
eq('D3 revision 递增', raised.revision, 2)
eq('D4 previous 记录旧值', raised.previous, { value: 55, band: 'medium' })
eq('D5 70 分是 high', raised.band, 'high')

const read2 = await core.getRelationship(alice.contactId)
near('D6 读取取最新 revision 的值', read2.trust?.value ?? -1, 70)
eq('D7 读取 revision=2', read2.trust?.revision, 2)

// ── E. 幂等与隔离 ─────────────────────────────────────────
const replayed = await core.reviewContactTrust({
  opId: 'trust-op-1',
  contactId: alice.contactId,
  proposedValue: 55,
  evidenceRefs: [ev1.sourceId, ev2.sourceId],
  decidedBy: 'owner',
  now: T0,
})
ok('E1 同 opId 重放', replayed.replayed === true)
eq('E2 重放不推进 revision', replayed.revision, 1)

const bobRead = await core.getRelationship(bob.contactId)
eq('E3 另一个联系人仍是 unassessed', bobRead.trust, null)

// subject_refs 精确匹配：每个 revision 只挂当前 contactId 这一个成员
const subjectOk = db.get<{ n: number }>(
  `SELECT COUNT(*) AS n FROM artifact_revisions
    WHERE json_valid(subject_refs) = 1
      AND json_array_length(subject_refs) = 1
      AND json_extract(subject_refs, '$[0]') = ?`,
  [alice.contactId],
) as { n: number }
eq('E4 subject_refs 只挂当前联系人且精确匹配', subjectOk.n, 2)

// ── F. payload 判别与档位 ─────────────────────────────────
ok('F1 错误 payload 不被当 Trust', !isContactTrustPayload({ type: 'other', value: 90, band: 'high' }))
ok('F2 合法 payload 判别通过', isContactTrustPayload({ type: 'contact_trust_assessment', value: 70, band: 'high' }))
eq('F3 档位 low', trustBandOf(39), 'low')
eq('F4 档位 medium', trustBandOf(40), 'medium')
eq('F5 档位 high', trustBandOf(70), 'high')

db.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n[P3-B-2 contact-trust] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exit(1)
