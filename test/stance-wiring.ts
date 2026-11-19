// 阶段 3：StanceEngine 的写后接线（belief → stance 合成/修订）。
//
// 验收口径（docs/design/p2-stance-engine.md §3/§5）：
// - 同一个 stanceGroup + stanceDirection 下，active belief 攒够门槛后自动合成 stance；
// - 新增依据触发 revision +1，旧版本保留；
// - lineage 指向每条 belief 的精确 revision；
// - 证据跨 belief 去重；
// - 合成失败只 warn，不影响 belief 主写；
// - 没有显式 group/direction 的 belief 不参与合成。
//
// 跑法：node test/stance-wiring.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Core } from '../dist/lib/store.js'
import { getDecision, listDecisions } from '../dist/lib/decision-store.js'
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

const dir = mkdtempSync(join(tmpdir(), 'psyche-stance-wiring-'))
const log = { info() {}, debug() {}, warn: (m: string) => console.log('WARN', m), error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, logger: log, dataDir: dir })

const stanceRow = (): { artifact_id: string; stance_key: string } | undefined =>
  db.get<{ artifact_id: string; stance_key: string }>(
    `SELECT artifact_id, stance_key FROM artifacts WHERE kind = 'stance' LIMIT 1`,
  )

const headOf = (artifactId: string): { revision: number; state: string; statement: string; payload: string; disclosure: string } =>
  db.get<{ revision: number; state: string; statement: string; payload: string; disclosure: string }>(
    `SELECT revision, state, statement, payload, disclosure FROM artifact_revisions
      WHERE artifact_id = ? ORDER BY revision DESC LIMIT 1`,
    [artifactId],
  )!

console.log('\n[Stance Wiring] 两条同向 belief → 合成 stance')

const s1 = (await core.capture({ text: '我平时喝乌龙茶，喜欢清淡一点。', platform: 'desktop', sessionRef: 'sw-1a' })).sourceId
const s1b = (await core.capture({ text: '乌龙茶是我最常喝的。', platform: 'desktop', sessionRef: 'sw-1b' })).sourceId
const s2 = (await core.capture({ text: '乌龙茶挺合我口味。', platform: 'desktop', sessionRef: 'sw-2a' })).sourceId
const s2b = (await core.capture({ text: '喝乌龙舒服。', platform: 'desktop', sessionRef: 'sw-2b' })).sourceId
const s3 = (await core.capture({ text: '普洱我也能接受。', platform: 'desktop', sessionRef: 'sw-3a' })).sourceId
const s3b = (await core.capture({ text: '普洱偶尔喝。', platform: 'desktop', sessionRef: 'sw-3b' })).sourceId

const b1 = await core.remember({
  statement: '用户喜欢乌龙茶。',
  kind: 'belief',
  subjectRefs: ['topic:tea'],
  payload: { stanceGroup: 'topic:tea', stanceDirection: 'for' },
  sourceIds: [s1, s1b],
  sessionRef: 'sw-1a',
  disclosure: 'public',
  confidence: 'high',
})
ok('第一条 belief 落成', b1.artifactId !== null, b1.promotion)

const b2 = await core.remember({
  statement: '用户对乌龙茶口味评价正面。',
  kind: 'belief',
  subjectRefs: ['topic:tea'],
  payload: { stanceGroup: 'topic:tea', stanceDirection: 'for' },
  sourceIds: [s1, s2b],
  sessionRef: 'sw-2a',
  disclosure: 'public',
  confidence: 'medium',
})
ok('第二条 belief 落成', b2.artifactId !== null, b2.promotion)

const stance = stanceRow()
ok('合成出一条 stance', stance !== undefined && stance.stance_key === 'topic:tea:for', stance)
const stanceId = stance?.artifact_id ?? ''

const first = stanceId ? headOf(stanceId) : null
ok('stance 首版 revision 1', first?.revision === 1, first?.revision)
ok('stance 状态 active', first?.state === 'active', first?.state)
ok('正文来自模板（含「倾向肯定」）', (first?.statement ?? '').includes('倾向肯定'), first?.statement)
ok('payload 记住 group/direction', (first?.payload ?? '').includes('topic:tea') && (first?.payload ?? '').includes('for'), first?.payload)
ok('披露继承 public', first?.disclosure === 'public', first?.disclosure)

const lineage = db.all<{ from_artifact_id: string; from_revision: number; relation: string }>(
  `SELECT from_artifact_id, from_revision, relation FROM artifact_lineage WHERE artifact_id = ? AND revision = 1`,
  [stanceId],
)
ok('lineage 指向两条 belief', lineage.length === 2, lineage)
ok(
  'lineage 指向精确 revision',
  lineage.every((row) => (row.from_artifact_id === b1.artifactId && row.from_revision === b1.revision) || (row.from_artifact_id === b2.artifactId && row.from_revision === b2.revision)),
  lineage,
)

const stanceRuns = listDecisions(db, { kind: 'stance' })
ok('留下一条 stance 决策回执', stanceRuns.length === 1, stanceRuns.map((run) => run.decisionId))
const stanceDecision = stanceRuns[0] ? getDecision(db, stanceRuns[0].decisionId) : null
ok('回执 committed', stanceDecision?.run.status === 'committed', stanceDecision?.run.status)
ok('回执结果指向 stance', stanceDecision?.run.resultArtifactId === stanceId, stanceDecision?.run.resultArtifactId)
const refs = (stanceDecision?.items ?? []).map((item) => `${item.refType}:${item.refId}@${item.refRevision}`)
ok('回执记了 belief 精确版本', refs.includes(`artifact:${b1.artifactId}@${b1.revision}`), refs)

console.log('\n[Stance Wiring] 新增依据 → 追加 revision')

const b3 = await core.remember({
  statement: '用户说普洱也喝，但更常喝乌龙。',
  kind: 'belief',
  subjectRefs: ['topic:tea'],
  payload: { stanceGroup: 'topic:tea', stanceDirection: 'for' },
  sourceIds: [s3, s3b],
  sessionRef: 'sw-3a',
  disclosure: 'public',
  confidence: 'low',
})
ok('第三条 belief 落成', b3.artifactId !== null, b3.promotion)

const second = stanceId ? headOf(stanceId) : null
ok('stance 追加到 revision 2', second?.revision === 2, second?.revision)
ok('revision 2 仍 active', second?.state === 'active', second?.state)
const payload2 = JSON.parse(second?.payload ?? '{}') as { changedBecause?: string }
ok('changedBecause 标成 basis（多了第三条 belief）', payload2.changedBecause === 'basis', payload2)
ok('正文仍含「倾向肯定」', (second?.statement ?? '').includes('倾向肯定'), second?.statement)

const evidenceRows = db.all<{ source_id: string; relation: string }>(
  `SELECT source_id, relation FROM artifact_evidence WHERE artifact_id = ? AND revision = 2`,
  [stanceId],
)
const evidenceKeys = evidenceRows.map((row) => `${row.source_id}|${row.relation}`)
ok('证据跨 belief 去重（s1 被两条 belief 共用，只留一条）', new Set(evidenceKeys).size === evidenceRows.length && evidenceRows.length === 5, evidenceRows)

const stanceRuns2 = listDecisions(db, { kind: 'stance' })
ok('修订再留一条回执', stanceRuns2.length === 2, stanceRuns2.map((run) => run.decisionId))

console.log('\n[Stance Wiring] 没有显式 group/direction 不合成')

const plain = await core.remember({
  statement: '用户周末喜欢散步。',
  kind: 'belief',
  subjectRefs: ['topic:walk'],
  sourceIds: [s1, s1b],
  sessionRef: 'sw-1a',
  disclosure: 'public',
})
ok('普通 belief 落成但不触发 stance', plain.artifactId !== null && stanceRow() !== undefined, plain.promotion)
const stanceCount = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM artifacts WHERE kind = 'stance'`)?.count
ok('stance 数量仍是 1', stanceCount === 1, stanceCount)

console.log(`\n[Stance Wiring] ${passed} 通过 ${failed} 失败`)

db.close()
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  // Windows 上句柄释放偶尔慢半拍，测试结论不受影响
}
process.exitCode = failed === 0 ? 0 : 1
