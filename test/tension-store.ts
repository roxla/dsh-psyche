// Tension 持久化（P2 Completion Batch 阶段 1，schema v16）。
//
// 验收口径：
// - 追加写：每次状态变化一版，旧版本仍在；head = MAX(version)；
// - pairKey 幂等：同一对结论只允许一条活着的记录；
// - 状态机不重写：非法转移由 `assertTransition` 拒绝（缺材料也拒绝）；
// - 两侧绑 artifactId + revision，不绑对象；
// - 探测落库只登记新 pairKey，不自动解决已有张力。
//
// 跑法：node test/tension-store.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { pairKeyOf, type TensionCandidateItem } from '../dist/lib/tensions.js'
import {
  findActiveTensionByPair,
  getTension,
  listTensions,
  registerTension,
  syncTensions,
  transitionTension,
} from '../dist/lib/tension-store.js'

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
function throws(label: string, fn: () => unknown, code?: string): void {
  try {
    fn()
    ok(label, false, { threw: false })
  } catch (error) {
    const actual = (error as { code?: string }).code
    ok(label, code === undefined || actual === code, { actual, expected: code })
  }
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-tension-store-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)

console.log('\n[Tension Store] schema v16')

eq('schema 版本是 42', Number((db.get('PRAGMA user_version') as { user_version?: number }).user_version ?? 0), 42)
const tables = db.all<{ name: string }>(
  `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'fts_index%' AND name NOT LIKE 'sqlite_%'`,
)
eq('表数 81（含 project handoff 七张、提醒与授权代次、裁决证据）', tables.length, 81)
ok('tension_versions 存在', tables.some((t) => t.name === 'tension_versions'))

const left: TensionCandidateItem = {
  artifactId: 'art_left',
  revision: 1,
  kind: 'fact',
  state: 'active',
  statement: '用户喜欢乌龙茶',
  subjectRefs: ['user', 'topic:tea'],
}
const right: TensionCandidateItem = {
  artifactId: 'art_right',
  revision: 1,
  kind: 'fact',
  state: 'active',
  statement: '用户不喜欢乌龙茶',
  subjectRefs: ['user', 'topic:tea'],
}
const pairKey = pairKeyOf(left, right)

console.log('\n[Tension Store] 登记与幂等')
const first = syncTensions(db, [left, right], { actor: 'core' })
eq('探测登记 1 条', first.created, 1)
ok('返回 tensionId', first.tensionIds.length === 1)
const tensionId = first.tensionIds[0]!
const head1 = getTension(db, tensionId)
ok('head 初始 open / version 1', head1?.status === 'open' && head1?.version === 1, head1)
eq('pairKey 与两侧绑定', [head1?.pairKey, head1?.left.artifactId, head1?.right.revision], [pairKey, 'art_left', 1])

const again = syncTensions(db, [left, right], { actor: 'core' })
eq('重跑幂等：不新增', again.created, 0)
eq('listTensions 只有一条', listTensions(db).length, 1)

console.log('\n[Tension Store] 状态机（缺材料拒绝）')
throws(
  '进 investigating 必须带 sourceIds',
  () => transitionTension(db, tensionId, 'investigating'),
  undefined,
)
const investigating = transitionTension(db, tensionId, 'investigating', { sourceIds: ['src_1'], note: '拿到了新口供' })
eq('investigating version=2', [investigating.status, investigating.version], ['investigating', 2])
eq('旧版本仍在（2 版）', Number((db.get('SELECT COUNT(*) AS n FROM tension_versions WHERE tension_id = ?', [tensionId]) as { n: number }).n), 2)

throws('parked 必须写 note', () => transitionTension(db, tensionId, 'parked'))
const parked = transitionTension(db, tensionId, 'parked', { note: '先放着，等下次喝茶' })
eq('parked version=3', [parked.status, parked.version], ['parked', 3])

throws('parked 不能直接 resolved（状态机不允许）', () => transitionTension(db, tensionId, 'resolved', { note: '想跳步' }))
const wake = transitionTension(db, tensionId, 'investigating', { sourceIds: ['src_2'], note: '新口供' })
eq('parked→investigating version=4', [wake.status, wake.version], ['investigating', 4])
const resolved = transitionTension(db, tensionId, 'resolved', { note: '他改口说不喜欢浓的，乌龙是例外', resolution: 'qualified' })
eq('resolved 记录 resolution', [resolved.status, resolved.resolution], ['resolved', 'qualified'])
throws('resolved 不能直接 investigating', () => transitionTension(db, tensionId, 'investigating'), undefined)
const reopened = transitionTension(db, tensionId, 'open', { eventId: 'evt_new' })
eq('resolved→open 需要 eventId 并 reopened', [reopened.status, reopened.previousTensionId], ['open', tensionId])

console.log('\n[Tension Store] 终态与历史')
const withdrawn = transitionTension(db, tensionId, 'withdrawn', { note: '确认是误报：两条说的不是同一件事' })
eq('withdrawn version=7', [withdrawn.status, withdrawn.version], ['withdrawn', 7])
throws('withdrawn 是终态，不能复活', () => transitionTension(db, tensionId, 'open', { eventId: 'evt_x' }))
const second = syncTensions(db, [left, right], { actor: 'core' })
eq('终态后同 pairKey 可再登记（新记录）', second.created, 1)
const other = getTension(db, second.tensionIds[0]!)
ok('新记录 version=1 且 open', other?.version === 1 && other?.status === 'open', other)
eq('两条记录各自独立（旧记录仍在 withdrawn）', [listTensions(db).length, getTension(db, tensionId)?.version, getTension(db, tensionId)?.status], [2, 7, 'withdrawn'])

console.log('\n[Tension Store] pairKey 与版本绑定')
const leftV2: TensionCandidateItem = { ...left, revision: 2, statement: '用户喜欢乌龙茶（改口：只喝冷的）' }
const keyV2 = pairKeyOf(leftV2, right)
ok('revision 变了 pairKey 随之变', keyV2 !== pairKey)
ok('旧记录仍指向 revision 1', getTension(db, tensionId)?.left.revision === 1)

opened.db.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n[Tension Store] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
