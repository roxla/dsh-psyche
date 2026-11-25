// P2-FTS5 E3：披露等级（disclosure）落库、继承与检索过滤测试。
//
// 冻结规则（用户 m11355 拍板）：
// 1. 披露属于 revision，不属于 Artifact；默认值 `restricted`（没有标记 ≠ 已确认可披露）。
// 2. 新建未指定 → restricted；revise 未指定 → 继承当前 head；变更必须显式、必须新 revision。
// 3. restricted / secret 的当前 head 仍进 FTS 索引，靠查询侧过滤（否则测的是索引准入）。
// 4. 普通检索只返回 public，过滤在 SQL 内、LIMIT 之前；没有 includeRestricted 开关。
//
// 跑法：node test/disclosure.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
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

const dir = mkdtempSync(join(tmpdir(), 'psyche-disclosure-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

console.log('\n[P2-FTS5 E3] 披露等级')

const source = async (text) =>
  (
    await core.capture({
      platform: 'dsh',
      channel: 'desktop',
      sessionRef: 'disclosure',
      origin: 'user',
      kind: 'message',
      text,
    })
  ).sourceId

async function rememberFact(statement, disclosure) {
  const sourceId = await source(`关于「${statement}」的原始消息。`)
  const result = await core.remember({
    text: statement,
    kind: 'fact',
    statement,
    sourceIds: [sourceId],
    confidence: 'high',
    ...(disclosure === undefined ? {} : { disclosure }),
  })
  if (!result.artifactId) throw new Error(`remember 没有升成结论：${JSON.stringify(result.promotion)}`)
  return result.artifactId
}

const ftsRow = (artifactId) =>
  db.get(`SELECT ref_id, bigram_text FROM fts_index WHERE ref_id = ?`, [artifactId])

// ── 1. 默认值：未指定 = restricted，但索引照常写入 ─────────────────────
const hidden = await rememberFact('猫的疫苗本放在书房抽屉里。')
const hiddenHead = db.get(`SELECT disclosure FROM artifact_revisions WHERE artifact_id = ? AND revision = 1`, [hidden])
eq('未指定披露时落 restricted', hiddenHead.disclosure, 'restricted')
ok('受限 head 仍进入 FTS 索引', Boolean(ftsRow(hidden)))
eq('普通检索不返回受限记忆', searchFts(db, '疫苗本').length, 0)
eq('单字 LIKE 也不返回受限记忆', searchFts(db, '猫').length, 0)

// ── 2. 显式 public / secret ───────────────────────────────────────────
const open = await rememberFact('她喜欢喝乌龙茶。', 'public')
const secret = await rememberFact('她的银行卡密码是四位数。', 'secret')
eq(
  '显式 public 落库',
  db.get(`SELECT disclosure FROM artifact_revisions WHERE artifact_id = ? AND revision = 1`, [open]).disclosure,
  'public',
)
eq(
  '显式 secret 落库',
  db.get(`SELECT disclosure FROM artifact_revisions WHERE artifact_id = ? AND revision = 1`, [secret]).disclosure,
  'secret',
)
eq('public 记忆可召回', searchFts(db, '乌龙茶').map((row) => row.artifactId), [open])
eq('secret 记忆不可召回', searchFts(db, '银行卡密码').length, 0)
ok('secret 仍进入索引', Boolean(ftsRow(secret)))
eq('召回结果带 disclosure 字段', searchFts(db, '乌龙茶')[0]?.disclosure, 'public')

// ── 3. revise 继承 ───────────────────────────────────────────────────
const revised = await core.revise({
  artifactId: open,
  statement: '她最近改喝白茶了。',
  refs: ['topic:tea'],
})
eq('revise 不传披露时继承 head', searchFts(db, '白茶')[0]?.disclosure, 'public')
eq('修订后仍可召回', searchFts(db, '白茶').map((row) => row.artifactId), [open])

// 显式收紧：public → restricted，旧 head 不得因历史 public 被重新召回
const tightened = await core.revise({
  artifactId: open,
  statement: '她喝的茶品牌不方便说。',
  refs: ['topic:tea'],
  disclosure: 'restricted',
})
eq('显式收紧产生新 revision', revised.revision + 1, tightened.revision)
eq('收紧后普通检索不再返回', searchFts(db, '茶品牌').length, 0)
eq(
  '新 head 是 restricted',
  db.get(`SELECT disclosure FROM artifact_revisions WHERE artifact_id = ? AND revision = ?`, [open, tightened.revision])
    .disclosure,
  'restricted',
)
eq(
  '旧 head 的披露等级保持历史值',
  db.get(`SELECT disclosure FROM artifact_revisions WHERE artifact_id = ? AND revision = 1`, [open]).disclosure,
  'public',
)

// 显式放宽：restricted → public 必须显式
const loosened = await core.revise({
  artifactId: hidden,
  statement: '猫的疫苗本放在书房抽屉里（可以说了）。',
  refs: ['topic:cat'],
  disclosure: 'public',
})
eq('显式放宽后可召回', searchFts(db, '疫苗本').map((row) => row.artifactId), [hidden])
eq('放宽产生新 revision', loosened.revision, 2)

// ── 4. 非法值：归一成 restricted，直接 SQL 写入被 CHECK 拒绝 ─────────
const bogus = await rememberFact('这条披露值是乱写的。', 'top-secret')
eq(
  '非法披露值归一成 restricted',
  db.get(`SELECT disclosure FROM artifact_revisions WHERE artifact_id = ? AND revision = 1`, [bogus]).disclosure,
  'restricted',
)
let checkRejected = false
try {
  db.run(
    `INSERT INTO artifact_revisions (
       artifact_id, revision, state, statement, subject_refs, payload, confidence,
       basis_count, independent_evidence_count, salience, temporal, direct_extraction,
       disclosure, created_at, updated_at, op_id, schema_version
     ) VALUES (?, ?, 'active', 'x', '[]', '{}', 'medium', 0, 0, 0, '{}', 0, 'nope', ?, ?, NULL, ?)`,
    [bogus, 9, '2026-11-06T00:00:00.000Z', '2026-11-06T00:00:00.000Z', '6'],
  )
} catch {
  checkRejected = true
}
ok('直接写入非法披露被 CHECK 拒绝', checkRejected)

// ── 5. 过滤在 LIMIT 之前：受限候选不占名额 ────────────────────────────
// 造 10 条同分候选（ref_id 升序稳定），其中 2 条 restricted、8 条 public；
// 若先 LIMIT 8 再过滤，只会剩 6 条——正确行为是返回 8 条 public。
const many = []
for (let i = 0; i < 10; i += 1) {
  many.push({
    id: await rememberFact(`同分候选第 ${i} 条，主题词是检索。`, i < 2 ? 'restricted' : 'public'),
    disclosure: i < 2 ? 'restricted' : 'public',
  })
}
const limited = searchFts(db, '检索', { limit: 8 })
eq('LIMIT 前过滤后仍返回 8 条', limited.length, 8)
eq(
  '返回的全部是 public',
  limited.every((row) => row.disclosure === 'public'),
  true,
)
ok(
  '受限候选没有占名额',
  limited.every((row) => !many.filter((item) => item.disclosure === 'restricted').some((item) => item.id === row.artifactId)),
)

// ── 6. rebuild 不改变披露分类；verify 不受影响 ────────────────────────
const before = db.get(`SELECT disclosure FROM artifact_revisions WHERE artifact_id = ? AND revision = 1`, [hidden])
const rebuilt = rebuildFtsIndex(db)
ok('rebuild 成功', rebuilt.indexed > 0, rebuilt)
eq(
  'rebuild 后披露分类不变',
  db.get(`SELECT disclosure FROM artifact_revisions WHERE artifact_id = ? AND revision = 1`, [hidden]).disclosure,
  before.disclosure,
)
eq('rebuild 后受限仍可索引', Boolean(ftsRow(secret)), true)
eq('rebuild 后受限仍不可召回', searchFts(db, '银行卡密码').length, 0)
const verified = verifyFtsIndex(db)
eq('rebuild 后 verify 无 missing', verified.missing.length, 0)
eq('rebuild 后 verify 无 duplicate', verified.duplicate.length, 0)
ok('rebuild 后 integrity 通过', verified.integrityOk)

// ── 7. 新库 schema ───────────────────────────────────────────────────
const columns = db.all(`PRAGMA table_info(artifact_revisions)`).map((row) => row.name)
ok('artifact_revisions 有 disclosure 列', columns.includes('disclosure'))
eq('user_version 是 42', db.get(`PRAGMA user_version`).user_version, 42)

console.log(`\n[P2-FTS5 E3] ${passed} 通过 ${failed} 失败`)
db.close()
rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
