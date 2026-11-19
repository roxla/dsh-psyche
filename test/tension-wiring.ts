// 张力写后接线（P2 Completion Batch 阶段 1 的「自动登记」）。
//
// 验收口径：
// - clash 写成功后，从目标 head 出发只比较「共享话题锚点」的活跃 head；
// - 自动登记 open 张力，不自动解决；
// - 写失败/登记失败不影响主写（登记层 try/catch）。
//
// 跑法：node test/tension-wiring.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Core } from '../dist/lib/store.js'
import { listTensions } from '../dist/lib/tension-store.js'
import { openDatabase, migrate } from '../dist/lib/adapter.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-tension-wiring-'))
const log = { info() {}, debug() {}, warn: (m: string) => console.log('WARN', m), error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, logger: log, dataDir: dir })

console.log('\n[Tension Wiring] clash 写后自动登记')

const s1 = (await core.capture({ text: '我平时喝乌龙茶，喜欢清淡一点。', platform: 'desktop', sessionRef: 'wiring-1' })).sourceId
const s2 = (await core.capture({ text: '我其实不喜欢乌龙茶了，最近改喝普洱。', platform: 'desktop', sessionRef: 'wiring-1' })).sourceId

const first = await core.remember({
  statement: '用户喜欢喝乌龙茶。',
  kind: 'fact',
  subjectRefs: ['topic:tea'],
  sourceIds: [s1],
  disclosure: 'public',
})
const second = await core.remember({
  statement: '用户不喜欢喝乌龙茶。',
  kind: 'fact',
  subjectRefs: ['topic:tea'],
  sourceIds: [s2],
  disclosure: 'public',
})
ok('两条结论都已写入', Boolean(first.artifactId) && Boolean(second.artifactId))

const before = listTensions(db, { status: 'open' })
ok('clash 之前没有张力', before.length === 0, before.map((t) => t.pairKey))

const clash = await core.clash({
  targetId: second.artifactId,
  sourceIds: [s2],
  text: '新证据说改喝普洱，与旧结论不能同时成立',
})
ok('clash 写入成功', Boolean(clash.eventId))

const after = listTensions(db, { status: 'open' })
ok('clash 之后自动登记了张力', after.length === 1, after.map((t) => t.pairKey))
if (after.length === 1) {
  const tension = after[0]!
  ok('张力绑住两条结论', tension.pairKey.includes(first.artifactId) && tension.pairKey.includes(second.artifactId), tension.pairKey)
  ok('张力是 open 且版本为 1', tension.status === 'open' && tension.version === 1)
}

const repeated = await core.clash({
  targetId: second.artifactId,
  sourceIds: [s2],
  text: '同一条反证再说一次',
})
ok('重复 clash 不新增第二条张力', listTensions(db, { status: 'open' }).length === 1, repeated.eventId)

const unrelated = await core.capture({ text: '今天天气不错。', platform: 'desktop', sessionRef: 'wiring-1' })
const other = await core.remember({
  statement: '用户今天觉得天气不错。',
  kind: 'belief',
  subjectRefs: ['topic:weather'],
  sourceIds: [unrelated.sourceId],
  disclosure: 'public',
})
await core.clash({ targetId: other.artifactId, sourceIds: [unrelated.sourceId], text: '与天气无关的一次反驳' })
ok('不共享话题的结论不会误登记', listTensions(db, { status: 'open' }).length === 1, listTensions(db, { status: 'open' }).map((t) => t.pairKey))

console.log(`\n[tension-wiring] ${passed} 通过 ${failed} 失败`)
opened.db.close()
rmSync(dir, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
