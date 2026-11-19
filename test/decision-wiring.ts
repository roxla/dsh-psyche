// 决策回执写后接线（P2 Completion Batch 阶段 2 的「可追溯」）。
//
// 验收口径：
// - clash / revise / review 写成功后，各自留下一条 committed 回执；
// - 回执记住「依据」（artifact / event / source）和「结果」（artifact + revision）；
// - 同一次写入重放（同 opId）不会重复记回执；
// - 回执层失败只 warn，不影响主写（try/catch 在 #recordDecision 里）。
//
// 跑法：node test/decision-wiring.ts（需要先 npm run build）
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

const dir = mkdtempSync(join(tmpdir(), 'psyche-decision-wiring-'))
const log = { info() {}, debug() {}, warn: (m: string) => console.log('WARN', m), error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, logger: log, dataDir: dir })

console.log('\n[Decision Wiring] clash / revise / review 写后各留一条回执')

const s1 = (await core.capture({ text: '我平时喝乌龙茶，喜欢清淡一点。', platform: 'desktop', sessionRef: 'dw-1' })).sourceId
const s2 = (await core.capture({ text: '我其实不喜欢乌龙茶了，最近改喝普洱。', platform: 'desktop', sessionRef: 'dw-1' })).sourceId
const first = await core.remember({
  statement: '用户喜欢喝乌龙茶。',
  kind: 'fact',
  subjectRefs: ['topic:tea'],
  sourceIds: [s1],
  disclosure: 'public',
})

// --- clash ---
const clash = await core.clash({
  opId: 'op-clash-wiring',
  targetId: first.artifactId,
  sourceIds: [s2],
  text: '新证据说改喝普洱，与旧结论不能同时成立',
})
const clashRuns = listDecisions(db, { kind: 'clash' })
ok('clash 后留下一条回执', clashRuns.length === 1, clashRuns.map((r) => r.decisionId))
const clashDecision = clashRuns[0] ? getDecision(db, clashRuns[0].decisionId) : null
ok('回执状态是 committed', clashDecision?.run.status === 'committed', clashDecision?.run.status)
ok('回执结果指向被撞的结论', clashDecision?.run.resultArtifactId === first.artifactId, clashDecision?.run.resultArtifactId)
const clashRefs = (clashDecision?.items ?? []).map((item) => `${item.refType}:${item.refId}`)
ok('回执记了目标结论依据', clashRefs.includes(`artifact:${first.artifactId}`), clashRefs)
ok('回执记了冲突事件依据', clashRefs.includes(`event:${clash.eventId}`), clashRefs)
ok('回执记了来源依据', clashRefs.includes(`source:${s2}`), clashRefs)

// 同 opId 重放：同入参才算重放，返回同一结果，不重复记回执
const replay = await core.clash({
  opId: 'op-clash-wiring',
  targetId: first.artifactId,
  sourceIds: [s2],
  text: '新证据说改喝普洱，与旧结论不能同时成立',
})
ok('重放返回同一个事件', replay.eventId === clash.eventId, { replay: replay.eventId, first: clash.eventId })
ok('重放被标记为 replayed', replay.replayed === true)
ok('重放不重复记回执', listDecisions(db, { kind: 'clash' }).length === 1)

// --- revise ---
const revised = await core.revise({
  artifactId: first.artifactId,
  statement: '用户曾经喜欢喝乌龙茶，正改喝普洱。',
  refs: [clash.eventId],
  sourceIds: [s2],
})
const reviseRuns = listDecisions(db, { kind: 'revise' })
ok('revise 后留下一条回执', reviseRuns.length === 1, reviseRuns.map((r) => r.decisionId))
const reviseDecision = reviseRuns[0] ? getDecision(db, reviseRuns[0].decisionId) : null
ok('revise 回执结果指向新版本', reviseDecision?.run.resultRevision === revised.revision, {
  got: reviseDecision?.run.resultRevision,
  want: revised.revision,
})
const reviseRefs = (reviseDecision?.items ?? []).map((item) => `${item.refType}:${item.refId}`)
ok('revise 回执记了改口依据事件', reviseRefs.includes(`event:${clash.eventId}`), reviseRefs)
ok('revise 回执记了被改的那一版', reviseRefs.includes(`artifact:${first.artifactId}`), reviseRefs)

// --- review ---
const reviewed = await core.review({
  artifactId: first.artifactId,
  verdict: 'confirmed',
  sourceIds: [s2],
  note: '确认改成普洱这件事站得住',
})
const reviewRuns = listDecisions(db, { kind: 'review' })
ok('review 后留下一条回执', reviewRuns.length === 1, reviewRuns.map((r) => r.decisionId))
const reviewDecision = reviewRuns[0] ? getDecision(db, reviewRuns[0].decisionId) : null
ok('review 回执结果是 committed', reviewDecision?.run.status === 'committed', reviewDecision?.run.status)
ok('review 回执结果指向复核后的版本', reviewDecision?.run.resultRevision === reviewed.revision, {
  got: reviewDecision?.run.resultRevision,
  want: reviewed.revision,
})
const reviewRefs = (reviewDecision?.items ?? []).map((item) => `${item.refType}:${item.refId}`)
ok('review 回执记了复核事件', reviewRefs.includes(`event:${reviewed.eventId}`), reviewRefs)
ok('review 回执记了被复核的那一版', reviewRefs.includes(`artifact:${first.artifactId}`), reviewRefs)

// 回执不存正文：条目里只有引用，没有 statement
const payloadText = JSON.stringify(
  listDecisions(db, {}).map((run) => getDecision(db, run.decisionId)),
)
ok('回执里没有正文泄漏', !payloadText.includes('乌龙茶'), payloadText.slice(0, 120))

console.log(`\n[decision-wiring] ${passed} 通过 ${failed} 失败`)
opened.db.close()
rmSync(dir, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
