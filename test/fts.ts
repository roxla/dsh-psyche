// P2-FTS5 E1/E2：生产检索底座测试。
//
// 冻结语义（p2-fts5-a2b-freeze.md v1.4 / D3.5 / D4-B）：
// 1. 中文 bigram、英文/数字整词小写，**按原文顺序交织**（Q011 回归：不能先扫完全部中文再扫英文）
// 2. 只索引当前 head；同一 Artifact 只留一行（修订 = 替换，不是追加）
// 3. 查询模式：单字 like、有空白 and、无空白 phrase；双引号必须转义
// 4. 评分 = 原生 BM25（列权重 0,0,1,0），证据加成 0，同分 ref_id ASC
// 5. head/state 过滤在 SQL 里硬过滤，不依赖评分器
// 6. 写入失败 = 业务事务整笔回滚，operations 另开事务记 failed
// 7. rebuild 原子重建；verify 报 Missing/Orphan/Duplicate/ContentMismatch + integrity-check
//
// 跑法：node test/fts.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import {
  analyzeFtsQuery,
  bigramText,
  buildFtsQuery,
  rebuildFtsIndex,
  searchFts,
  verifyFtsIndex,
} from '../dist/lib/fts.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-fts-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

console.log('\n[P2-FTS5 E1/E2] 生产检索底座')

// ── 1. bigramText：按原文顺序交织（Q011 回归） ───────────────────────────
eq('中文 bigram', bigramText('记忆检索'), '记忆 忆检 检索')
eq('英文整词小写', bigramText('Python SQLite'), 'python sqlite')
eq('中英混合保持原文顺序', bigramText('用临时profile测试'), '用临 临时 profile 测试')
eq('空格分隔的混合文本', bigramText('临时 profile'), '临时 profile')
eq('日期连字符是分隔符', bigramText('2026-11-06'), '2026 11 06')
eq('标点只作分隔', bigramText('你好，世界'), '你好 世界')
eq('空串', bigramText(''), '')

// ── 2. 查询分析：模式判据只看空白与长度 ────────────────────────────────
eq('单字走 like', analyzeFtsQuery('猫').mode, 'like')
eq('无空白多字走 phrase', analyzeFtsQuery('你好世界').mode, 'phrase')
eq('有空白走 and', analyzeFtsQuery('你好 世界').mode, 'and')
eq('混合查询也走 and', analyzeFtsQuery('sqlite 记忆').mode, 'and')
eq('日期无空白走 phrase', analyzeFtsQuery('2026-11-06').mode, 'phrase')
eq('tokens 去重且保序', analyzeFtsQuery('大雁塔 大雁塔').tokens, ['大雁', '雁塔'])

// ── 3. 查询表达式：phrase / and / 转义 ─────────────────────────────────
eq('phrase 表达式', buildFtsQuery(analyzeFtsQuery('你好世界')), '"你好 好世 世界"')
eq('and 表达式', buildFtsQuery(analyzeFtsQuery('你好 世界')), '"你好" AND "世界"')
eq('引号被转义成双引号', buildFtsQuery(analyzeFtsQuery('a"b')), '"a b"')
let likeThrows = false
try {
  buildFtsQuery(analyzeFtsQuery('猫'))
} catch {
  likeThrows = true
}
ok('like 模式不构造 MATCH 表达式', likeThrows)

// ── 4. 写入与查询 ──────────────────────────────────────────────────────
const srcA = await core.capture({
  platform: 'dsh',
  channel: 'desktop',
  sessionRef: 'fts-1',
  origin: 'user',
  kind: 'message',
  text: '她说她最近在学习记忆检索。',
})
const srcB = await core.capture({
  platform: 'dsh',
  channel: 'desktop',
  sessionRef: 'fts-1b',
  origin: 'user',
  kind: 'message',
  text: '她每天都会看一会儿资料。',
})
const belief = await core.remember({
  text: '她在学习记忆检索。',
  kind: 'belief',
  statement: '她在学习记忆检索。',
  sourceIds: [srcA.sourceId, srcB.sourceId],
  confidence: 'high',
  disclosure: 'public',
})
const beliefId = belief.artifactId
ok('remember 成功', Boolean(beliefId), belief)

const ftsRows = () => db.all(`SELECT ref_id, bigram_text FROM fts_index WHERE ref_id = ?`, [beliefId])
eq('head 索引只有一行', ftsRows().length, 1)
eq(
  '索引内容是 bigram',
  ftsRows()[0]?.bigram_text,
  '她在 在学 学习 习记 记忆 忆检 检索',
)

const hit = searchFts(db, '记忆检索')
eq('phrase 查询命中 head', hit.map((row) => row.artifactId), [beliefId])
eq('命中带 state 与 kind', { state: hit[0]?.state, kind: hit[0]?.kind }, { state: 'active', kind: 'belief' })

const andHit = searchFts(db, '学习 资料')
eq('AND 要求每个片段都出现', andHit.length, 0)
const andHit2 = searchFts(db, '学习 记忆')
eq('AND 两片段都在正文里才命中', andHit2.map((row) => row.artifactId), [beliefId])

// 单字 LIKE
const catSrc = await core.capture({
  platform: 'dsh',
  channel: 'desktop',
  sessionRef: 'fts-2',
  origin: 'user',
  kind: 'message',
  text: '她说猫喜欢晒太阳。',
})
const cat = await core.remember({
  text: '猫喜欢晒太阳。',
  kind: 'fact',
  statement: '猫喜欢晒太阳。',
  sourceIds: [catSrc.sourceId],
  confidence: 'medium',
  disclosure: 'public',
})
const catHit = searchFts(db, '猫')
eq('单字查询走 LIKE 命中', catHit.map((row) => row.artifactId), [cat.artifactId])

// ── 5. 修订：只保留新 head 的索引 ──────────────────────────────────────
const revised = await core.revise({
  artifactId: beliefId,
  statement: '她现在改学检索质量评估。',
  refs: [srcA.sourceId],
  sourceIds: [srcA.sourceId],
})
eq('修订后 revision=2', revised.revision, 2)
eq('FTS 仍只有一行', ftsRows().length, 1)
eq(
  '旧 head 文本只可能命中新 revision（不返回旧 revision）',
  searchFts(db, '她在学习记忆检索').every((row) => row.revision === 2),
  true,
)
eq('新 head 文本查得到', searchFts(db, '检索质量评估').map((row) => row.artifactId), [beliefId])

// challenged 可召回（带争议标记）
const reviewed = await core.revise({
  artifactId: beliefId,
  statement: '她最近在准备检索评测（存在争议）。',
  refs: [srcA.sourceId],
  sourceIds: [srcA.sourceId],
  state: 'challenged',
})
eq('revise 到 challenged', reviewed.state, 'challenged')
const challengedHit = searchFts(db, '检索评测')
eq('challenged 仍可召回', challengedHit.map((row) => row.artifactId), [beliefId])
eq('召回结果带 challenged 状态', challengedHit[0]?.state, 'challenged')

// superseded：revise(supersedes) 新 id 模式把旧对象置 superseded，检索侧过滤
const superseded = await core.revise({
  supersedes: cat.artifactId,
  statement: '猫已经改名叫团子了。',
  refs: [catSrc.sourceId],
  sourceIds: [catSrc.sourceId],
  kind: 'fact',
})
eq('旧对象被追加 superseded revision', superseded.supersededRevision, 2)
const oldHeadState = db.get(
  `SELECT state FROM artifact_revisions WHERE artifact_id = ? ORDER BY revision DESC LIMIT 1`,
  [cat.artifactId],
)
eq('旧对象 head 状态变 superseded', oldHeadState?.state, 'superseded')
eq('superseded 不再召回', searchFts(db, '猫喜欢晒太阳').length, 0)
eq('替代它的新结论可召回', searchFts(db, '改名叫团子').map((row) => row.artifactId), [superseded.artifactId])

// ── 6. verify / rebuild ────────────────────────────────────────────────
const clean = verifyFtsIndex(db)
eq('干净库 verify 无 missing', clean.missing, [])
eq('干净库 verify 无 orphan', clean.orphan, [])
eq('干净库 verify 无 duplicate', clean.duplicate, [])
eq('干净库 verify 无 contentMismatch', clean.contentMismatch, [])
eq('干净库 integrity 通过', clean.integrityOk, true)
eq('head 数与索引行数一致', clean.headCount, clean.rowCount)

db.run('DELETE FROM fts_index')
const afterClear = verifyFtsIndex(db)
ok('清空后 verify 报 missing', afterClear.missing.length === afterClear.headCount && afterClear.rowCount === 0, afterClear)
const rebuilt = rebuildFtsIndex(db)
eq('rebuild 数量 = head 数', rebuilt.indexed, afterClear.headCount)
const afterRebuild = verifyFtsIndex(db)
eq('rebuild 后 missing 为空', afterRebuild.missing, [])
eq('rebuild 后 contentMismatch 为空', afterRebuild.contentMismatch, [])

// 手工制造三类差异
db.run(`INSERT INTO fts_index (kind, ref_id, bigram_text, raw_text) VALUES ('fact', 'art_missing', '', '')`)
db.run(
  `INSERT INTO fts_index (kind, ref_id, bigram_text, raw_text) SELECT kind, ref_id, bigram_text, raw_text FROM fts_index WHERE ref_id = ?`,
  [cat.artifactId],
)
const dirty = verifyFtsIndex(db)
ok('orphan 被报出', dirty.orphan.includes('art_missing'), dirty.orphan)
ok('duplicate 被报出', dirty.duplicate.includes(cat.artifactId), dirty.duplicate)

// 内容不一致：直接改 bigram_text
db.run(`UPDATE fts_index SET bigram_text = '被改坏' WHERE ref_id = ?`, [beliefId])
const mismatched = verifyFtsIndex(db)
ok('contentMismatch 被报出', mismatched.contentMismatch.includes(beliefId), mismatched.contentMismatch)

// 清理脏行，恢复干净状态供后面失败注入用
rebuildFtsIndex(db)
db.run(`DELETE FROM fts_index WHERE ref_id = 'art_missing'`)
const restored = verifyFtsIndex(db)
eq('清理后 verify 干净', { ...restored, headCount: 0, rowCount: 0 }, {
  missing: [],
  orphan: [],
  duplicate: [],
  contentMismatch: [],
  mapMissing: [],
  mapOrphan: [],
  mapMismatch: [],
  integrityOk: true,
  headCount: 0,
  rowCount: 0,
})

// ── 7. 失败回滚：FTS 写入失败 → 业务事务整笔回滚 + operations 记 failed ──
const beforeArtifacts = Number(db.get('SELECT COUNT(*) AS n FROM artifacts').n)
const beforeRevisions = Number(db.get('SELECT COUNT(*) AS n FROM artifact_revisions').n)
const originalRun = db.run.bind(db)
db.run = (sql, params) => {
  if (String(sql).startsWith('INSERT INTO fts_index')) throw new Error('fts-boom')
  return originalRun(sql, params)
}
let writeError = null
try {
  await core.remember({
    text: '这条不该落库。',
    kind: 'fact',
    statement: '这条不该落库。',
    sourceIds: [catSrc.sourceId],
  })
} catch (error) {
  writeError = error
}
db.run = originalRun
ok('FTS 失败时 remember 抛错', writeError instanceof Error, writeError?.message)
eq('artifacts 没多一行', Number(db.get('SELECT COUNT(*) AS n FROM artifacts').n), beforeArtifacts)
eq('revisions 没多一行', Number(db.get('SELECT COUNT(*) AS n FROM artifact_revisions').n), beforeRevisions)
const failedOp = db.get(`SELECT status, error FROM operations ORDER BY rowid DESC LIMIT 1`)
eq('失败另开事务记进 operations', failedOp?.status, 'failed')
ok('失败记录里带原因', String(failedOp?.error ?? '').includes('fts-boom'), failedOp)

console.log(`\n[P2-FTS5 E1/E2] ${passed} 通过 ${failed} 失败`)
process.exitCode = failed > 0 ? 1 : 0
db.close()
rmSync(dir, { recursive: true, force: true })
