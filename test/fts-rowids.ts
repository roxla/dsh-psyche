// P2-E6-C1：FTS 行定位旁路表（fts_rowids）测试。
//
// 背景：fts_index 的 kind/ref_id 是 UNINDEXED 列，按它们 DELETE 会全表扫描；
// 单条 upsert O(N)、逐行 rebuild O(N²)（E6-C 实测 S3 rebuild 295 秒）。
// 改用 fts_rowids(kind, ref_id, row_id) 做 B-tree 定位后，删除旧行 O(log N)。
//
// 冻结不变量：每一条 fts_index 行恰好对应一条 fts_rowids 行，反之亦然。
//
// 覆盖（E6-C1 验收矩阵）：
// 1. 新库初始化      2. 旧库迁移回填      3. 写入同事务
// 4. 事务回滚        5. 重复 upsert 不重复  6. rebuild 一一对应
// 7. verify 三态     8. 进程强杀无孤儿     9. 双驱动一致
//
// 跑法：node test/fts-rowids.ts（需要先 npm run build）
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { migrate, nowIso, openDatabase } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { MIGRATIONS } from '../dist/lib/schema.js'
import { rebuildFtsIndex, bigramText, verifyFtsIndex } from '../dist/lib/fts.js'

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

const log = { info() {}, debug() {}, warn() {}, error() {} }
const AT = '2026-11-01T00:00:00.000Z'
const dirs = []

function makeDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 用真实 v1–v9 迁移 SQL 建一个 v9 库（映射表还不存在），供迁移回填用。 */
function makeV9() {
  const dir = makeDir('psyche-rowids-v9-')
  const file = join(dir, 'memory.sqlite3')
  const handle = new DatabaseSync(file)
  handle.exec('PRAGMA journal_mode = WAL')
  const seedStore = { run: (sql, params) => handle.prepare(sql).run(...(params ?? [])) }
  for (const migration of MIGRATIONS) {
    if (migration.version > 9) break
    handle.exec(migration.sql)
    migration.seed?.(seedStore, AT)
  }
  handle.exec('PRAGMA user_version = 9')

  const run = (sql, params = []) => handle.prepare(sql).run(...params)
  for (const [id, kind, statement] of [
    ['art_v9_a', 'fact', '用户每天散步记录步数。'],
    ['art_v9_b', 'belief', '用户喜欢在晚上听雨。'],
  ]) {
    run('INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      'main',
      kind,
      AT,
      AT,
    ])
    run(
      `INSERT INTO artifact_revisions (artifact_id, revision, state, statement, subject_refs, payload, confidence,
         basis_count, independent_evidence_count, salience, temporal, direct_extraction, created_at, updated_at, schema_version)
       VALUES (?, 1, 'active', ?, '["main"]', '{}', 'medium', 1, 1, 0.5, '{}', 0, ?, ?, '1.0')`,
      [id, statement, AT, AT],
    )
    run('INSERT INTO fts_index (kind, ref_id, bigram_text, raw_text) VALUES (?, ?, ?, ?)', [
      kind,
      id,
      bigramText(statement),
      statement,
    ])
  }
  handle.close()
  return { dir, file }
}

function countRows(db, table) {
  return Number(db.get(`SELECT COUNT(*) AS n FROM ${table}`).n)
}

function rowsOf(db) {
  return {
    fts: db.all('SELECT rowid AS row_id, kind, ref_id FROM fts_index ORDER BY rowid'),
    mapping: db.all('SELECT kind, ref_id, row_id FROM fts_rowids ORDER BY row_id'),
  }
}

function cleanVerify(db) {
  const report = verifyFtsIndex(db)
  return {
    missing: report.missing,
    orphan: report.orphan,
    duplicate: report.duplicate,
    contentMismatch: report.contentMismatch,
    mapMissing: report.mapMissing,
    mapOrphan: report.mapOrphan,
    mapMismatch: report.mapMismatch,
    integrityOk: report.integrityOk,
  }
}

console.log('\n[P2-E6-C1] FTS 行定位旁路表')

// ── 1. 新库初始化 ─────────────────────────────────────────────────────────
const dir1 = makeDir('psyche-rowids-')
const opened1 = await openDatabase({ file: join(dir1, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db1 = opened1.db
migrate(db1, log)
const core1 = new Core({ db: db1, config: {}, logger: log, dataDir: dir1 })

ok('新库迁移到 v31', Number(db1.get('PRAGMA user_version').user_version ?? 0) === 31, db1.get('PRAGMA user_version'))
ok('fts_rowids 表存在', Boolean(db1.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fts_rowids'`)))
eq('新库映射表为空', countRows(db1, 'fts_rowids'), 0)
eq('新库 verify 干净', cleanVerify(db1), {
  missing: [],
  orphan: [],
  duplicate: [],
  contentMismatch: [],
  mapMissing: [],
  mapOrphan: [],
  mapMismatch: [],
  integrityOk: true,
})

// ── 2. 旧库迁移回填 ───────────────────────────────────────────────────────
const v9 = makeV9()
const openedV9 = await openDatabase({ file: v9.file, driverPreference: 'auto', logger: log })
const dbV9 = openedV9.db
migrate(dbV9, log)
ok('v9 库升级到 v31', Number(dbV9.get('PRAGMA user_version').user_version ?? 0) === 31)
eq('回填后映射行数等于 FTS 行数', countRows(dbV9, 'fts_rowids'), countRows(dbV9, 'fts_index'))
const backfilled = rowsOf(dbV9)
eq(
  '回填的 (kind, ref_id, rowid) 与 FTS 行一致',
  backfilled.mapping,
  backfilled.fts.map((row) => ({ kind: row.kind, ref_id: row.ref_id, row_id: row.row_id })),
)
eq('回填后 verify 干净', cleanVerify(dbV9), {
  missing: [],
  orphan: [],
  duplicate: [],
  contentMismatch: [],
  mapMissing: [],
  mapOrphan: [],
  mapMismatch: [],
  integrityOk: true,
})
dbV9.close()

// ── 3. 写入同事务：remember / revise / forget ──────────────────────────────
const src = await core1.capture({
  platform: 'dsh',
  channel: 'desktop',
  sessionRef: 'rowids-1',
  origin: 'user',
  kind: 'message',
  text: '她说新家附近有家面馆。',
})
const first = await core1.remember({
  text: '新家附近有家面馆。',
  kind: 'fact',
  statement: '新家附近有家面馆。',
  sourceIds: [src.sourceId],
  confidence: 'medium',
  disclosure: 'public',
})
const artifactId = first.artifactId
eq('remember 后 FTS 一行', countRows(db1, 'fts_index'), 1)
eq('remember 后映射一行', countRows(db1, 'fts_rowids'), 1)
const afterRemember = rowsOf(db1)
eq('两表 rowid 相同', afterRemember.mapping[0].row_id, afterRemember.fts[0].row_id)

await core1.revise({
  artifactId,
  statement: '新家附近有家面馆，老板记得她的口味。',
  refs: [artifactId],
})
eq('revise 后 FTS 仍一行', countRows(db1, 'fts_index'), 1)
eq('revise 后映射仍一行', countRows(db1, 'fts_rowids'), 1)
eq('revise 后 verify 干净', cleanVerify(db1).mapMissing, [])

await core1.forget({ artifactId, reason: '测试遗忘' })
const afterForget = rowsOf(db1)
eq('forget 后两表行数一致', afterForget.mapping.length, afterForget.fts.length)
eq('forget 后映射仍与 FTS 一一对应', afterForget.mapping, afterForget.fts.map((row) => ({ kind: row.kind, ref_id: row.ref_id, row_id: row.row_id })))
eq('forget 后 verify 干净', cleanVerify(db1), {
  missing: [],
  orphan: [],
  duplicate: [],
  contentMismatch: [],
  mapMissing: [],
  mapOrphan: [],
  mapMismatch: [],
  integrityOk: true,
})

// ── 4. 事务回滚：FTS 插入失败 → 两边都不留半截 ────────────────────────────
const src2 = await core1.capture({
  platform: 'dsh',
  channel: 'desktop',
  sessionRef: 'rowids-2',
  origin: 'user',
  kind: 'message',
  text: '她周末去爬山。',
})
const beforeFts = countRows(db1, 'fts_index')
const beforeMap = countRows(db1, 'fts_rowids')
const originalRun = db1.run.bind(db1)
db1.run = (sql, params) => {
  if (String(sql).startsWith('INSERT INTO fts_index')) throw new Error('rowids-boom')
  return originalRun(sql, params)
}
let rollbackError = null
try {
  await core1.remember({
    text: '她周末去爬山。',
    kind: 'fact',
    statement: '她周末去爬山。',
    sourceIds: [src2.sourceId],
  })
} catch (error) {
  rollbackError = error
}
db1.run = originalRun
ok('FTS 失败时 remember 抛错', rollbackError instanceof Error, rollbackError?.message)
eq('回滚后 FTS 行数不变', countRows(db1, 'fts_index'), beforeFts)
eq('回滚后映射行数不变', countRows(db1, 'fts_rowids'), beforeMap)

// ── 5. 重复 upsert：同 artifact 连续修订不产生重复行 ──────────────────────
const src3 = await core1.capture({
  platform: 'dsh',
  channel: 'desktop',
  sessionRef: 'rowids-3',
  origin: 'user',
  kind: 'message',
  text: '她开始学游泳。',
})
const beforeSwim = countRows(db1, 'fts_index')
const swim = await core1.remember({
  text: '她开始学游泳。',
  kind: 'fact',
  statement: '她开始学游泳。',
  sourceIds: [src3.sourceId],
  confidence: 'medium',
  disclosure: 'public',
})
for (let round = 1; round <= 3; round += 1) {
  await core1.revise({
    artifactId: swim.artifactId,
    statement: `她开始学游泳，第 ${round} 次修订。`,
    refs: [swim.artifactId],
  })
}
eq('三次修订后只多一行（原 forget 行保留）', countRows(db1, 'fts_index'), beforeSwim + 1)
eq('三次修订后映射同步', countRows(db1, 'fts_rowids'), beforeSwim + 1)
const rowsAfterRevisions = rowsOf(db1)
eq(
  '映射与 FTS 的 rowid 集合一致',
  rowsAfterRevisions.mapping.map((row) => row.row_id).join(','),
  rowsAfterRevisions.fts.map((row) => row.row_id).join(','),
)

// ── 6. rebuild：清两表后一一对应 ─────────────────────────────────────────
const rebuilt = rebuildFtsIndex(db1)
eq('rebuild 计数等于 head 数', rebuilt.indexed, countRows(db1, 'fts_index'))
eq('rebuild 后两表行数一致', countRows(db1, 'fts_rowids'), countRows(db1, 'fts_index'))
const rebuiltRows = rowsOf(db1)
eq('rebuild 后 rowid 一一对应', rebuiltRows.mapping, rebuiltRows.fts.map((row) => ({ kind: row.kind, ref_id: row.ref_id, row_id: row.row_id })))
eq('rebuild 后 verify 干净', cleanVerify(db1), {
  missing: [],
  orphan: [],
  duplicate: [],
  contentMismatch: [],
  mapMissing: [],
  mapOrphan: [],
  mapMismatch: [],
  integrityOk: true,
})

// ── 7. verify 三态：映射缺失 / 孤儿 / 错配 ────────────────────────────────
db1.run('INSERT INTO fts_index (kind, ref_id, bigram_text, raw_text) VALUES (?, ?, ?, ?)', [
  'fact',
  'art_manual_fts',
  '手工 工插 插入',
  '手工插入的行',
])
let report = verifyFtsIndex(db1)
ok('FTS 行没有映射 → mapMissing', report.mapMissing.includes('art_manual_fts'), report.mapMissing)
db1.run("DELETE FROM fts_index WHERE ref_id = 'art_manual_fts'")

db1.run('INSERT INTO fts_rowids (kind, ref_id, row_id) VALUES (?, ?, ?)', ['fact', 'art_manual_map', 999999])
report = verifyFtsIndex(db1)
ok('映射没有 FTS 行 → mapOrphan', report.mapOrphan.includes('art_manual_map'), report.mapOrphan)
db1.run('DELETE FROM fts_rowids WHERE ref_id = ?', ['art_manual_map'])

db1.run('UPDATE fts_rowids SET ref_id = ? WHERE ref_id = ?', ['art_wrong_ref', rebuiltRows.fts[0].ref_id])
report = verifyFtsIndex(db1)
ok('映射 ref_id 与 FTS 行不一致 → mapMismatch', report.mapMismatch.includes(rebuiltRows.fts[0].ref_id), report.mapMismatch)
db1.run('UPDATE fts_rowids SET ref_id = ? WHERE ref_id = ?', [rebuiltRows.fts[0].ref_id, 'art_wrong_ref'])
eq('修回后 verify 干净', cleanVerify(db1).mapMismatch, [])

// ── 8. 进程强杀：事务中途被杀不留映射孤儿 ────────────────────────────────
const crashReady = join(dir1, 'crash-ready.txt')
const child = spawn(
  process.execPath,
  [
    join(process.cwd(), 'test', 'helpers', 'rowids-crash-child.mjs'),
    JSON.stringify({
      file: join(dir1, 'memory.sqlite3'),
      artifactId: 'art_crash',
      kind: 'fact',
      statement: '强杀夹具行。',
      ready: crashReady,
    }),
  ],
  { stdio: 'ignore' },
)
const readyDeadline = Date.now() + 20000
while (!existsSync(crashReady) && Date.now() < readyDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 50))
}
ok('子进程进入未提交事务', existsSync(crashReady))
if (existsSync(crashReady)) {
  spawnSync('taskkill', ['/F', '/PID', String(child.pid)])
  await new Promise((resolve) => child.once('exit', resolve))
  try {
    unlinkSync(crashReady)
  } catch {
    // 已删
  }
  db1.close()
  const reopened = await openDatabase({ file: join(dir1, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
  const dbAfterCrash = reopened.db
  const crashReport = verifyFtsIndex(dbAfterCrash)
  eq('强杀后 mapMissing 为空', crashReport.mapMissing, [])
  eq('强杀后 mapOrphan 为空', crashReport.mapOrphan, [])
  ok('强杀后两表行数一致', countRows(dbAfterCrash, 'fts_rowids') === countRows(dbAfterCrash, 'fts_index'))
  dbAfterCrash.close()
} else {
  child.kill()
  db1.close()
  ok('强杀测试跳过（子进程未就绪）', false)
  ok('强杀测试跳过（子进程未就绪）', false)
  ok('强杀测试跳过（子进程未就绪）', false)
}

// ── 9. 双驱动一致 ─────────────────────────────────────────────────────────
const dir2 = makeDir('psyche-rowids-better-')
const opened2 = await openDatabase({ file: join(dir2, 'memory.sqlite3'), driverPreference: 'better-sqlite3', logger: log })
const db2 = opened2.db
migrate(db2, log)
const core2 = new Core({ db: db2, config: {}, logger: log, dataDir: dir2 })
const src4 = await core2.capture({
  platform: 'dsh',
  channel: 'desktop',
  sessionRef: 'rowids-better',
  origin: 'user',
  kind: 'message',
  text: '她把闹钟调早了。',
})
await core2.remember({
  text: '她把闹钟调早了。',
  kind: 'fact',
  statement: '她把闹钟调早了。',
  sourceIds: [src4.sourceId],
  confidence: 'medium',
  disclosure: 'public',
})
eq('better 驱动写入后 FTS 一行', countRows(db2, 'fts_index'), 1)
eq('better 驱动写入后映射一行', countRows(db2, 'fts_rowids'), 1)
eq(
  'better 驱动两表 rowid 一致',
  rowsOf(db2).mapping[0].row_id,
  rowsOf(db2).fts[0].row_id,
)
eq('better 驱动 verify 干净', cleanVerify(db2).mapMissing.length + cleanVerify(db2).mapOrphan.length, 0)
db2.close()

console.log(`\n[P2-E6-C1] ${passed} 通过 ${failed} 失败`)
process.exitCode = failed > 0 ? 1 : 0
for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
