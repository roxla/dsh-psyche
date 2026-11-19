// 阶段 3：StanceEngine 的读侧（stance-store）。
//
// 验收口径：
// - loadStanceBeliefs 只取同 group/direction 的 active belief，并带上证据键与会话；
// - 方向不同的 belief 不进入；
// - loadExistingStance 在合成前为 null，合成后返回当前 head 与依据键；
// - loadStanceConflicts / loadUnresolvedTensionArtifacts 在没有冲突/张力时为空。
//
// 跑法：node test/stance-store.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Core } from '../dist/lib/store.js'
import {
  loadExistingStance,
  loadStanceBeliefs,
  loadStanceConflicts,
  loadUnresolvedTensionArtifacts,
} from '../dist/lib/stance-store.js'
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

const dir = mkdtempSync(join(tmpdir(), 'psyche-stance-store-'))
const log = { info() {}, debug() {}, warn: (m: string) => console.log('WARN', m), error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, logger: log, dataDir: dir })

const s1 = (await core.capture({ text: '乌龙茶好喝。', platform: 'desktop', sessionRef: 'ss-1a' })).sourceId
const s1b = (await core.capture({ text: '我常喝乌龙茶。', platform: 'desktop', sessionRef: 'ss-1b' })).sourceId
const s2 = (await core.capture({ text: '普洱也不错。', platform: 'desktop', sessionRef: 'ss-2a' })).sourceId
const s2b = (await core.capture({ text: '普洱偶尔喝。', platform: 'desktop', sessionRef: 'ss-2b' })).sourceId

console.log('\n[Stance Store] 读侧只取同组同向的 active belief')

const forBelief = await core.remember({
  statement: '用户喜欢乌龙茶。',
  kind: 'belief',
  payload: { stanceGroup: 'topic:tea', stanceDirection: 'for' },
  sourceIds: [s1, s1b],
  sessionRef: 'ss-1a',
  disclosure: 'public',
})
const againstBelief = await core.remember({
  statement: '用户不喜欢乌龙茶。',
  kind: 'belief',
  payload: { stanceGroup: 'topic:tea', stanceDirection: 'against' },
  sourceIds: [s2, s2b],
  sessionRef: 'ss-2a',
  disclosure: 'public',
})
ok('两条方向相反的 belief 都落成', forBelief.artifactId !== null && againstBelief.artifactId !== null, {
  for: forBelief.promotion,
  against: againstBelief.promotion,
})

const beliefs = loadStanceBeliefs(db, 'topic:tea:for')
ok('同向 belief 只读到一条', beliefs.length === 1, beliefs.map((item) => item.artifactId))
ok('读到的就是 for 那条', beliefs[0]?.artifactId === forBelief.artifactId, beliefs[0]?.artifactId)
ok('带上证据键', (beliefs[0]?.evidenceKeys ?? []).length === 2, beliefs[0]?.evidenceKeys)
ok('带上会话', (beliefs[0]?.sessionRefs ?? []).length === 2, beliefs[0]?.sessionRefs)

const noExisting = loadExistingStance(db, 'topic:tea:for')
ok('合成前没有既有立场', noExisting === null, noExisting)

// 两条同向 belief 才够门槛：再补一条同向
const third = await core.remember({
  statement: '乌龙茶是我的首选。',
  kind: 'belief',
  payload: { stanceGroup: 'topic:tea', stanceDirection: 'for' },
  sourceIds: [s1, s1b],
  sessionRef: 'ss-1a',
  disclosure: 'public',
})
ok('第三条同向 belief 落成', third.artifactId !== null, third.promotion)

const existing = loadExistingStance(db, 'topic:tea:for')
ok('合成后能读到既有立场', existing !== null && existing.statement.length > 0, existing?.statement)
ok('既有立场带依据', (existing?.basis ?? []).length >= 2, existing?.basis)

const conflicts = loadStanceConflicts(db, [forBelief.artifactId ?? '', againstBelief.artifactId ?? ''])
ok('没有 contradicts 关系时冲突为空', conflicts.size === 0, [...conflicts])

const tensions = loadUnresolvedTensionArtifacts(db, [forBelief.artifactId ?? '', third.artifactId ?? ''])
ok('没有未解决张力时为空', tensions.size === 0, [...tensions])

console.log(`\n[Stance Store] ${passed} 通过 ${failed} 失败`)

db.close()
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  // Windows 句柄释放偶尔慢半拍
}
process.exitCode = failed === 0 ? 0 : 1
