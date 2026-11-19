// E3 REC：索引恢复与损坏检测。
//
// 验收（测试计划 REC-05/07/08/09 的库函数层）：
// 1. 索引被清空后 rebuild 能恢复，且连续两次结果一致；
// 2. 索引缺行时 verify 报 Missing，不自动修复；
// 3. 索引有孤儿时 verify 报 Orphan；
// 4. 重复行时 verify 报 Duplicate；
// 5. 内容被改坏时 verify 报 ContentMismatch；
// 6. 事务内清空后抛错 → 回滚，原索引仍在（rebuild 的中断语义）。
//
// 跑法：node test/fts-recovery.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { rebuildFtsIndex, verifyFtsIndex, searchFts } from '../dist/lib/fts.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-fts-recovery-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

console.log('\n[P2-FTS5 E3] 索引恢复')

const source = async (text) =>
  (
    await core.capture({
      platform: 'dsh',
      channel: 'desktop',
      sessionRef: 'fts-recovery',
      origin: 'user',
      kind: 'message',
      text,
    })
  ).sourceId

async function rememberFact(statement, disclosure = 'public') {
  const sourceId = await source(`关于「${statement}」的原始消息。`)
  const result = await core.remember({
    text: statement,
    kind: 'fact',
    statement,
    sourceIds: [sourceId],
    confidence: 'high',
    disclosure,
  })
  if (!result.artifactId) throw new Error('remember 没有升成结论')
  return result.artifactId
}

const a = await rememberFact('索引恢复测试：猫粮放在厨房柜子里。')
const b = await rememberFact('索引恢复测试：她在周三晚上练琴。')
const c = await rememberFact('索引恢复测试：周末通常去公园走路。')

// ── 1. 清空后 rebuild 恢复，连续两次一致 ─────────────────────────────
db.run('DELETE FROM fts_index')
eq('清空后 verify 报 missing', verifyFtsIndex(db).missing.length, 3)
eq('清空后检索为空', searchFts(db, '猫粮').length, 0)

const first = rebuildFtsIndex(db)
eq('rebuild 恢复三条', first.indexed, 3)
eq('恢复后可检索', searchFts(db, '猫粮').map((row) => row.artifactId), [a])
const second = rebuildFtsIndex(db)
eq('再 rebuild 一次结果一致', second.indexed, first.indexed)
eq('两次 rebuild 后 verify 干净', verifyFtsIndex(db).missing.length, 0)
eq('两次 rebuild 后无重复', verifyFtsIndex(db).duplicate.length, 0)

// ── 2. 缺行 / 孤儿 / 重复 / 内容不一致 ──────────────────────────────
db.run(`DELETE FROM fts_index WHERE ref_id = ?`, [b])
const missing = verifyFtsIndex(db)
eq('缺行报 missing', missing.missing, [b])
ok('不自动修复缺行', missing.missing.length === 1)

db.run(
  `INSERT INTO fts_index (kind, ref_id, bigram_text, raw_text) VALUES ('fact', 'art_ghost', '幽灵 灵测 测试', '幽灵测试')`,
)
const orphan = verifyFtsIndex(db)
ok('孤儿行报 orphan', orphan.orphan.includes('art_ghost'), orphan.orphan)

db.run(
  `INSERT INTO fts_index (kind, ref_id, bigram_text, raw_text) SELECT kind, ref_id, bigram_text, raw_text FROM fts_index WHERE ref_id = ?`,
  [c],
)
const duplicate = verifyFtsIndex(db)
ok('重复行报 duplicate', duplicate.duplicate.includes(c), duplicate.duplicate)

// 清掉人为脏行后把正文改坏，看 contentMismatch
db.run(`DELETE FROM fts_index WHERE ref_id IN ('art_ghost', ?) AND rowid NOT IN (SELECT min(rowid) FROM fts_index GROUP BY kind, ref_id)`, [c])
db.run(`UPDATE fts_index SET bigram_text = '被 改 坏 的 词' WHERE ref_id = ?`, [a])
const mismatch = verifyFtsIndex(db)
ok('内容不一致报 contentMismatch', mismatch.contentMismatch.includes(a), mismatch.contentMismatch)

// ── 3. 事务内清空后抛错 → 回滚，原索引仍在（rebuild 的中断语义）────────
// 先恢复干净状态：前面的缺行/改坏是故意造的，不能拿来当中断前的基准。
rebuildFtsIndex(db)
const beforeRows = db.get('SELECT COUNT(*) AS n FROM fts_index').n
let threw = false
try {
  db.transaction(() => {
    db.run('DELETE FROM fts_index')
    throw new Error('模拟 rebuild 中途失败')
  })
} catch {
  threw = true
}
ok('模拟中断确实抛错', threw)
eq('中断后索引行数恢复', db.get('SELECT COUNT(*) AS n FROM fts_index').n, beforeRows)
eq('中断后仍可检索琴', searchFts(db, '练琴').map((row) => row.artifactId), [b])

// 收尾：重建回干净状态
rebuildFtsIndex(db)
eq('最终 rebuild 后 verify 无 missing', verifyFtsIndex(db).missing.length, 0)
eq('最终 rebuild 后无 orphan', verifyFtsIndex(db).orphan.length, 0)
eq('最终 rebuild 后无 duplicate', verifyFtsIndex(db).duplicate.length, 0)
eq('最终 rebuild 后无 contentMismatch', verifyFtsIndex(db).contentMismatch.length, 0)

console.log(`\n[P2-FTS5 E3] 索引恢复：${passed} 通过 ${failed} 失败`)
db.close()
rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
