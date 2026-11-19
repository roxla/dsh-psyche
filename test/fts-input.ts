// E3 INPUT + QSEG：查询输入的边界、安全与混合片段语义。
//
// 验收（测试计划 INPUT + QSEG 组）：
// 1. 空串 / 全空白 → 空结果，不扫全库；
// 2. LIKE 通配符 % _ 被当字面量（只有含该字符的记忆命中）；
// 3. 双引号、括号、冒号、星号不会让 MATCH 表达式报错；
// 4. 超长查询抛 E_QUERY_TOO_LONG（不静默截断），长度按 Unicode 码点算；
// 5. 单字片段不丢语义：与其余片段 AND 组合为 LIKE 条件（`不 喜欢` 不得退化成 `喜欢`）；
// 6. 不把用户输入拼进 SQL（参数绑定由 adapter 保证，这里只验证行为）。
//
// 跑法：node test/fts-input.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { analyzeFtsQuery, MAX_QUERY_CHARS, searchFts } from '../dist/lib/fts.js'

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

const eq = (label, actual, expected) =>
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })

const dir = mkdtempSync(join(tmpdir(), 'psyche-fts-input-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

console.log('\n[P2-FTS5 E3] 查询输入边界与混合片段')

const source = async (text) =>
  (
    await core.capture({
      platform: 'dsh',
      channel: 'desktop',
      sessionRef: 'fts-input',
      origin: 'user',
      kind: 'message',
      text,
    })
  ).sourceId

async function rememberFact(statement) {
  const sourceId = await source(`关于「${statement}」的原始消息。`)
  const result = await core.remember({
    text: statement,
    kind: 'fact',
    statement,
    sourceIds: [sourceId],
    confidence: 'high',
    disclosure: 'public',
  })
  if (!result.artifactId) throw new Error('remember 没有升成结论')
  return result.artifactId
}

const withPercent = await rememberFact('活动规则是满 100 减 20%。')
const plain = await rememberFact('她喜欢在下午散步。')
const negA = await rememberFact('她不喜欢在下午散步。')
const negB = await rememberFact('她喜欢在上午散步。')
const onlyJia = await rememberFact('甲级项目记录。')
const catName = await rememberFact('猫咪的名字叫团子。')
const nameOnly = await rememberFact('名字列表需要更新。')
const apiDoc = await rememberFact('猫 api 的调用记录。')

// ── 1. 空 / 空白 ─────────────────────────────────────────────────────
eq('空串返回空', searchFts(db, ''), [])
eq('全空白返回空', searchFts(db, '   \t\n '), [])
eq('只有一个空格返回空', searchFts(db, ' '), [])

// ── 2. LIKE 通配符按字面量处理 ───────────────────────────────────────
const percentHits = searchFts(db, '%')
eq('查询 % 只命中真的带 % 的记忆', percentHits.map((row) => row.artifactId), [withPercent])
ok('查询 % 没有返回全部记忆', percentHits.length < 2, percentHits.length)
eq('查询 _ 不命中无关记忆', searchFts(db, '_'), [])
ok('查询反斜杠不抛错', Array.isArray(searchFts(db, '\\')), true)

// ── 3. 特殊字符不炸表达式 ────────────────────────────────────────────
for (const nasty of ['"', '""', '她说"散步"', 'a OR b', 'foo*', 'bar: baz', '(paren)', '-neg', 'NEAR(a b)']) {
  let threw = false
  try {
    searchFts(db, nasty)
  } catch {
    threw = true
  }
  ok(`特殊输入不抛错：${JSON.stringify(nasty)}`, !threw)
}

// ── 4. 超长查询报错（不静默截断）─────────────────────────────────────
ok('上限是 200 字符', MAX_QUERY_CHARS === 200, MAX_QUERY_CHARS)
const tooLong = '散步'.repeat(101) // 202 个码点
let tooLongCode = null
try {
  searchFts(db, tooLong)
} catch (error) {
  tooLongCode = error && typeof error === 'object' ? error.code : null
}
eq('超长查询抛 E_QUERY_TOO_LONG', tooLongCode, 'E_QUERY_TOO_LONG')

const emojiBoundary = '🐟'.repeat(200) // 200 码点 / 400 UTF-16 单元：按码点算不超限
let boundaryThrew = false
try {
  searchFts(db, emojiBoundary)
} catch {
  boundaryThrew = true
}
ok('长度按 Unicode 码点算（200 个 emoji 不超限）', !boundaryThrew)

const emojiTooLong = '🐟'.repeat(201)
let emojiCode = null
try {
  searchFts(db, emojiTooLong)
} catch (error) {
  emojiCode = error && typeof error === 'object' ? error.code : null
}
eq('201 个 emoji 超限并抛错', emojiCode, 'E_QUERY_TOO_LONG')

// ── 5. 混合片段：单字条件不丢 ────────────────────────────────────────
const mixed = analyzeFtsQuery('满 100 减 20%')
eq('含单字片段的查询仍是 and', mixed.mode, 'and')
eq('进 MATCH 的片段只有 100 与 20', mixed.ftsSegments, ['100', '20%'])
eq('单字片段转为 LIKE 条件', mixed.likeSegments, ['满', '减'])
eq('四个条件全部保留', searchFts(db, '满 100 减 20%').map((row) => row.artifactId), [withPercent])

// QSEG-01：`不 喜欢` 不得匹配只有「喜欢」的文档
eq('QSEG-01 不 喜欢 只命中同时含两者的记忆', searchFts(db, '不 喜欢').map((row) => row.artifactId), [negA])
ok('QSEG-01 不退回只看喜欢', !searchFts(db, '不 喜欢').some((row) => row.artifactId === negB))

// QSEG-02：`没 去` 不得匹配只有「去」的文档
const onlyQu = await rememberFact('她去了公园。')
const meiQu = await rememberFact('她没去公园。')
eq('QSEG-02 没 去 只命中同时含两者的记忆', searchFts(db, '没 去').map((row) => row.artifactId), [meiQu])
ok('QSEG-02 不命中只有去的记忆', !searchFts(db, '没 去').some((row) => row.artifactId === onlyQu))

// QSEG-03：满 100 减 20% 的所有片段都进入条件（两个 MATCH + 两个 LIKE）
eq('QSEG-03 片段全部分析出来', [mixed.ftsSegments.length, mixed.likeSegments.length], [2, 2])

// QSEG-04：甲 乙 不得退化成只检查甲
const jiaYi = analyzeFtsQuery('甲 乙')
eq('QSEG-04 全单字查询走 like', jiaYi.mode, 'like')
eq('QSEG-04 两个单字条件都在', jiaYi.likeSegments, ['甲', '乙'])
eq('QSEG-04 甲 乙 不命中只有甲的记忆', searchFts(db, '甲 乙'), [])

// QSEG-05：猫 的 名字
const catNameAnalysis = analyzeFtsQuery('猫 的 名字')
eq('QSEG-05 名字进 MATCH', catNameAnalysis.ftsSegments, ['名字'])
eq('QSEG-05 猫和的是 LIKE 条件', catNameAnalysis.likeSegments, ['猫', '的'])
eq('QSEG-05 命中同时含三者的记忆', searchFts(db, '猫 的 名字').map((row) => row.artifactId), [catName])
ok('QSEG-05 不命中只有名字的记忆', !searchFts(db, '猫 的 名字').some((row) => row.artifactId === nameOnly))

// QSEG-06：全单字查询
const singles = analyzeFtsQuery('不 未 没')
eq('QSEG-06 全单字走 like', singles.mode, 'like')
eq('QSEG-06 三个条件都保留', singles.likeSegments, ['不', '未', '没'])
eq('QSEG-06 不 未 没 无命中', searchFts(db, '不 未 没'), [])

// QSEG-07：中文 + 英文 + 单字
const mixedLatin = analyzeFtsQuery('猫 api 的')
eq('QSEG-07 api 进 MATCH', mixedLatin.ftsSegments, ['api'])
eq('QSEG-07 中文单字进 LIKE', mixedLatin.likeSegments, ['猫', '的'])
eq('QSEG-07 命中同时含三者的记忆', searchFts(db, '猫 api 的').map((row) => row.artifactId), [apiDoc])

// ── 小测 B：AND 多 LIKE 条件的复杂度上限与参数绑定 ──────────────────────
const tooManyLikes = '不 未 没 是 吗 的 了 在 有 和' // 10 个单字片段 > MAX_LIKE_SEGMENTS(8)
let complexCode = null
try {
  searchFts(db, tooManyLikes)
} catch (error) {
  complexCode = error && typeof error === 'object' ? error.code : null
}
eq('B-01 单字片段超上限抛 E_QUERY_TOO_COMPLEX', complexCode, 'E_QUERY_TOO_COMPLEX')

const tooManySegments = Array.from({ length: 17 }, (_, index) => `词${index}`).join(' ') // 17 段 > MAX_QUERY_SEGMENTS(16)
let segmentCode = null
try {
  searchFts(db, tooManySegments)
} catch (error) {
  segmentCode = error && typeof error === 'object' ? error.code : null
}
eq('B-02 片段总数超上限抛 E_QUERY_TOO_COMPLEX', segmentCode, 'E_QUERY_TOO_COMPLEX')

const eightLikes = '不 未 没 是 吗 的 了 在' // 恰好 8 个，允许
let boundaryOk = true
try {
  searchFts(db, eightLikes)
} catch {
  boundaryOk = false
}
ok('B-03 8 个单字片段仍在允许范围内', boundaryOk)

// 参数绑定 / 转义：% 是字面量，且不会因为 LIKE 条件把 SQL 拼坏
const percentFact = await rememberFact('任务完成度是 100% 了。')
ok('B-04 % 作为字面量命中含 % 的记忆', searchFts(db, '100%').some((row) => row.artifactId === percentFact))
eq('B-05 不存在的 1_0 不误伤', searchFts(db, '1_0'), [])

// 查询计划：带 LIKE 的混合查询仍然走 FTS 虚拟表索引，不是全表扫描
const plan = db.all(
  `EXPLAIN QUERY PLAN
     SELECT fts_index.ref_id
       FROM fts_index
       JOIN artifacts a ON a.artifact_id = fts_index.ref_id
       JOIN artifact_revisions r ON r.artifact_id = fts_index.ref_id
      WHERE fts_index.bigram_text MATCH '"散步"' AND r.statement LIKE '%不%'`,
)
ok(
  'B-06 混合查询查询计划使用 FTS 虚拟表索引',
  plan.some((row) => String(row.detail ?? '').includes('VIRTUAL TABLE')),
  plan,
)

// ── 6. 正常查询仍然工作 ──────────────────────────────────────────────
const sanbuHits = searchFts(db, '散步').map((row) => row.artifactId).sort()
eq('正常中文可命中', sanbuHits, [negA, negB, plain].sort())
eq('带标点的 phrase 可命中', searchFts(db, '满 100 减 20%').map((row) => row.artifactId), [withPercent])

console.log(`\n[P2-FTS5 E3] 查询输入边界与混合片段：${passed} 通过 ${failed} 失败`)
db.close()
rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
