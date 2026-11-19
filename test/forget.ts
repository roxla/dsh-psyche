// P2-FTS5 E3 第二批：认知遗忘（FORGET-01~08 + 恢复规则）。
//
// 验收口径（用户 m12043 第二批清单）：
// - 认知遗忘 = 不再作为有效认知使用，不删历史证据；
// - fact → forgotten，belief/impression/stance/relationship → retracted，procedure → deprecated；
// - 检索侧按 head.state 过滤，所以 rebuild 不会复活；
// - 重复 forget 幂等；已遗忘后 revise 必须显式 restore:true 才能恢复；
// - 彻底删除（Source/Event/Evidence 清理）是另一条链，不在本测试里伪造。
//
// 跑法：node test/forget.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core, forgottenStateFor } from '../dist/lib/store.js'
import { rebuildFtsIndex, searchFts, verifyFtsIndex } from '../dist/lib/fts.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-forget-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

console.log('\n[P2-FTS5 E3-2] 认知遗忘')

async function source(sessionRef, text) {
  const captured = await core.capture({
    platform: 'dsh',
    channel: 'desktop',
    sessionRef,
    origin: 'user',
    kind: 'message',
    text,
  })
  return captured.sourceId
}

// ── 造数据：一条 fact（两个独立来源）、一条 belief、一条对照 fact ─────────
const factSrcA = await source('forget-a', '用户对花生过敏，会起疹子。')
const factSrcB = await source('forget-b', '他上次吃花生酱进了医院。')
const fact = await core.remember({
  text: '用户对花生过敏，会起疹子。',
  kind: 'fact',
  statement: '用户对花生过敏。',
  sourceIds: [factSrcA, factSrcB],
  confidence: 'high',
  disclosure: 'public',
})
const factId = fact.artifactId
ok('fact 升格成功', Boolean(factId), fact)

const beliefSrc = await source('forget-c', '她喜欢晚上散步。')
const beliefSrcB = await source('forget-c2', '她每天晚饭后都去河边走一圈。')
const belief = await core.remember({
  text: '她喜欢晚上散步。',
  kind: 'belief',
  statement: '她喜欢晚上散步。',
  sourceIds: [beliefSrc, beliefSrcB],
  confidence: 'medium',
  disclosure: 'public',
})
const beliefId = belief.artifactId

const otherSrc = await source('forget-d', '她有一只叫团子的猫。')
const otherSrcB = await source('forget-d2', '那只猫是去年领养的。')
const other = await core.remember({
  text: '她有一只叫团子的猫。',
  kind: 'fact',
  statement: '她有一只叫团子的猫。',
  sourceIds: [otherSrc, otherSrcB],
  disclosure: 'public',
})
ok('belief 升格成功', Boolean(beliefId), belief)
ok('对照 fact 升格成功', Boolean(other.artifactId), other)

// ── FORGET-01：fact 标记 forgotten，普通检索不再召回 ────────────────────
const forgotten = await core.forget({ artifactId: factId })
eq('fact → forgotten', forgotten.state, 'forgotten')
eq('追加新 revision', forgotten.revision, 2)
eq('不是幂等重放', forgotten.alreadyForgotten, false)
eq('普通检索不召回', searchFts(db, '花生过敏').length, 0)

// ── FORGET-06：历史证据不删 ──────────────────────────────────────────────
const evidenceRows = db.all(
  `SELECT source_id, relation FROM artifact_evidence WHERE artifact_id = ? AND revision = 1`,
  [factId],
)
eq('历史证据仍在', evidenceRows.length, 2)
eq('证据关系仍是 supports', evidenceRows.map((row) => row.relation), ['supports', 'supports'])

// ── FORGET-02 / 03：rebuild 不复活，verify 与正式状态一致 ────────────────
rebuildFtsIndex(db)
eq('rebuild 不复活', searchFts(db, '花生过敏').length, 0)
const verified = verifyFtsIndex(db)
eq('verify 无 missing', verified.missing, [])
eq('verify 无 duplicate', verified.duplicate, [])
eq('verify 无 contentMismatch', verified.contentMismatch, [])
eq('verify integrity 通过', verified.integrityOk, true)

// ── FORGET-04：重复 forget 幂等 ─────────────────────────────────────────
const again = await core.forget({ artifactId: factId })
eq('重复 forget 幂等', again.alreadyForgotten, true)
eq('revision 不增加', again.revision, forgotten.revision)
eq(
  'revision 总数仍 2',
  db.get(`SELECT count(*) AS n FROM artifact_revisions WHERE artifact_id = ?`, [factId]).n,
  2,
)

// ── FORGET-07：forgotten 旧 revision 不影响其他 Artifact ────────────────
ok(
  '其他 Artifact 仍可召回',
  searchFts(db, '团子').some((row) => row.artifactId === other.artifactId),
)

// ── FORGET-08：遗忘期间查询不返回已失效认知 ─────────────────────────────
const recalled = await core.recall({ text: '花生过敏' })
eq('recall 不返回已遗忘结论', recalled.results.filter((item) => item.artifactId === factId).length, 0)
const fetched = await core.fetch([factId])
eq('fetch 仍能取到（遗忘不是删除）', fetched.items[0]?.type, 'artifact')
eq('fetch 的状态是 forgotten', fetched.items[0]?.state, 'forgotten')

// ── FORGET-05：休眠态 revise 必须显式 restore ───────────────────────────
let noRestoreCode = null
try {
  await core.revise({ artifactId: factId, statement: '用户现在对花生不过敏了。', refs: [factSrcA] })
} catch (error) {
  noRestoreCode = error && typeof error === 'object' ? error.code : null
}
eq('forgotten 后普通 revise 被拒', noRestoreCode, 'E_STATE')

const restored = await core.revise({
  artifactId: factId,
  statement: '用户现在对花生不过敏了（新证据）。',
  refs: [factSrcA],
  restore: true,
  disclosure: 'public',
})
eq('显式恢复回到 active', restored.state, 'active')
eq('恢复是第 3 版', restored.revision, 3)
const states = db
  .all(`SELECT revision, state FROM artifact_revisions WHERE artifact_id = ? ORDER BY revision`, [factId])
  .map((row) => row.state)
eq('历史状态全部保留', states, ['active', 'forgotten', 'active'])
ok(
  '恢复后可召回',
  searchFts(db, '不过敏').some((row) => row.artifactId === factId),
)

// ── 非 fact 的遗忘映射 ──────────────────────────────────────────────────
const forgottenBelief = await core.forget({ artifactId: beliefId })
eq('belief → retracted', forgottenBelief.state, 'retracted')
eq('belief 不召回', searchFts(db, '晚上散步').length, 0)
eq('fact 遗忘状态', forgottenStateFor('fact'), 'forgotten')
eq('belief 遗忘状态', forgottenStateFor('belief'), 'retracted')
eq('procedure 遗忘状态', forgottenStateFor('procedure'), 'deprecated')

// ── 同 opId 重复 forget：幂等重放不新增 revision ────────────────────────
const firstByOp = await core.forget({ artifactId: other.artifactId, opId: 'op-forget-idem' })
const secondByOp = await core.forget({ artifactId: other.artifactId, opId: 'op-forget-idem' })
eq('同 opId 重放标记 replayed', secondByOp.replayed, true)
eq('同 opId 重放 revision 不变', secondByOp.revision, firstByOp.revision)
eq(
  '对照 Artifact 的 revision 总数仍 2',
  db.get(`SELECT count(*) AS n FROM artifact_revisions WHERE artifact_id = ?`, [other.artifactId]).n,
  2,
)

try {
  db.close()
} catch {
  // 已关闭或驱动不支持，不影响断言结果
}
rmSync(dir, { recursive: true, force: true })
console.log(`\n[forget] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
