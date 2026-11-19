// D1-4：Revision / Evidence 六条不变量测试。
//
// 六条：
// 1. Head 取最大 Revision（不先过滤 state）
// 2. Supersedes 创建新 Artifact（新 ID + relation 指回旧）
// 3. Evidence 绑定 Revision（不是只绑 Artifact）
// 4. 历史 Revision 可读取（art_x@N）
// 5. Retracted 仍然是当前 Head（不回退旧 active）
// 6. Event 反向查询完整（Event → Artifact + Revision）
//
// 跑法：node test/revision.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-revision-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const lastEventId = () => db.all(`SELECT event_id FROM events ORDER BY rowid DESC LIMIT 1`)[0].event_id

console.log('\n[D1-4] Revision / Evidence 六条不变量')

// 两条独立来源（不同 session → 不同 independenceKey）
const s1 = await core.capture({
  platform: 'qq', channel: 'private', externalRoomId: 'd1-4-a', stableUserId: '20001',
  displayName: '阿岚', origin: 'user', kind: 'message', text: '阿岚喜欢喝乌龙茶。', sessionRef: 'rev-1',
})
const s2 = await core.capture({
  platform: 'qq', channel: 'private', externalRoomId: 'd1-4-b', stableUserId: '20001',
  displayName: '阿岚', origin: 'user', kind: 'message', text: '阿岚不爱吃甜食，奶茶也只喝无糖。', sessionRef: 'rev-2',
})

// ── 1. 同 id 追加 revision，head 取最大 ──────────────────────────────────────
const fact = await core.remember({
  text: '阿岚喜欢喝乌龙茶。',
  kind: 'fact',
  statement: '阿岚喜欢喝乌龙茶。',
  sourceIds: s1.sourceId,
  confidence: 'high',
  disclosure: 'public',
})
const factId = fact.artifactId
ok('fact 晋升出结论', Boolean(factId), fact)

await core.revise({
  artifactId: factId,
  statement: '阿岚喜欢喝乌龙茶，不加糖。',
  refs: lastEventId(),
})
const head = await core.fetch(factId)
eq('head 取最大 revision', head.items[0].revision, 2)
eq('head 文本是最新版', head.items[0].text, '阿岚喜欢喝乌龙茶，不加糖。')

// ── 2. 历史 revision 可读取 ─────────────────────────────────────────────────
const old = await core.fetch(`${factId}@1`)
eq('art@1 能读到旧版', old.items[0].revision, 1)
eq('旧版文本没有被覆盖', old.items[0].text, '阿岚喜欢喝乌龙茶。')

// ── 3. Evidence 绑定 revision ───────────────────────────────────────────────
const evRows = db.all(
  `SELECT revision, count(*) AS n FROM artifact_evidence WHERE artifact_id = ? GROUP BY revision ORDER BY revision`,
  [factId],
)
eq('证据按 revision 分组', evRows.map((row) => Number(row.revision)), [1, 2])

// ── 4. Retracted 仍是当前 head，不回退旧 active ─────────────────────────────
const belief = await core.remember({
  text: '阿岚讨厌所有甜食。',
  kind: 'belief',
  statement: '阿岚讨厌所有甜食。',
  sourceIds: [s1.sourceId, s2.sourceId],
  confidence: 'high',
  disclosure: 'public',
})
const beliefId = belief.artifactId
ok('belief 两条独立证据晋升', Boolean(beliefId), belief)
const beforeReject = await core.fetch(beliefId)
eq('撤回前 head revision=1', beforeReject.items[0].revision, 1)

await core.review({ artifactId: beliefId, verdict: 'rejected', refs: [lastEventId()] })
const afterReject = await core.fetch(beliefId)
eq('撤回后 head 是新 revision', afterReject.items[0].revision, 2)
eq('head state = retracted', afterReject.items[0].state, 'retracted')
const beliefOld = await core.fetch(`${beliefId}@1`)
eq('旧 revision 仍是 active', beliefOld.items[0].state, 'active')

// ── 5. Supersedes 创建新 Artifact，relation 指回旧 ──────────────────────────
const sup = await core.revise({
  supersedes: factId,
  statement: '阿岚其实更喜欢绿茶。',
  refs: [lastEventId()],
})
ok('supersedes 返回新 id', Boolean(sup.artifactId) && sup.artifactId !== factId, sup)
const rel = db.all(
  `SELECT relation FROM artifact_relations WHERE artifact_id = ? AND target_artifact_id = ?`,
  [sup.artifactId, factId],
)
eq('新结论用 supersedes 指回旧结论', rel[0]?.relation, 'supersedes')

// ── 6. Event 反向查询完整 ──────────────────────────────────────────────────
const trigger = db.all(
  `SELECT revision, event_id FROM artifact_trigger_events WHERE artifact_id = ? ORDER BY revision`,
  [factId],
)
ok('Event 能反查到关联结论的 revision', trigger.length >= 1, trigger)
ok('反向查询带 revision 而不是只有 artifactId', trigger.every((row) => Number(row.revision) >= 1), trigger)

// 用 recall 再验一次（对外接口而不是直接读表）：被取代的旧结论不再召回，新结论可召回
const recall = await core.recall({ text: '绿茶' }, { contactId: s1.contactId })
const linked = recall.results.find((item) => item.artifactId === sup.artifactId)
ok('recall 命中取代后的新结论', Boolean(linked), recall.results.map((item) => item.artifactId))
ok(
  '被取代的旧结论不再召回',
  !recall.results.some((item) => item.artifactId === factId),
  recall.results.map((item) => item.artifactId),
)
ok(
  '关联事件摘要不带 eventId 与原文',
  (linked?.relatedEvents ?? []).every((event) => !('eventId' in event) && !('text' in event)),
  linked?.relatedEvents,
)

// ── 7. 乐观并发：expectedRevision 过期必须拒绝，正确版本才放行 ──────────────
const headNow = await core.fetch(factId)
const currentRevision = headNow.items[0].revision
let conflictCode = null
try {
  await core.revise({
    artifactId: factId,
    statement: '基于旧版本改的一句话。',
    refs: [lastEventId()],
    expectedRevision: currentRevision - 1,
  })
} catch (error) {
  conflictCode = error?.code ?? null
}
eq('过期 expectedRevision 被拒绝', conflictCode, 'E_REVISION_CONFLICT')
const stillHead = await core.fetch(factId)
eq('被拒绝的改口没有落盘', stillHead.items[0].revision, currentRevision)

const accepted = await core.revise({
  artifactId: factId,
  statement: '基于当前版本改的一句话。',
  refs: [lastEventId()],
  expectedRevision: currentRevision,
  // 这条结论在第 7 步之前已被 supersedes 置为 superseded；按新规则，dormant 状态
  // 不能无痕改写，必须显式 restore（并说明新依据）。
  restore: true,
})
eq('正确 expectedRevision 放行', accepted.revision, currentRevision + 1)

const noCheck = await core.revise({
  artifactId: factId,
  statement: '不传 expectedRevision 也能改（兼容旧调用）。',
  refs: [lastEventId()],
})
eq('不传 expectedRevision 保持旧行为', noCheck.revision, currentRevision + 2)

console.log(`\nRevision / Evidence 自检：${passed} 通过 ${failed} 失败`)
db.close()
rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
