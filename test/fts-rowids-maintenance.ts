// P2-E6-C1 维护回归：VACUUM 后的映射正确性、外部破坏识别与恢复、双驱动一致。
//
// 背景（E6-C1 验收时记录的边界）：
// 1. `fts_rowids` 保存的是 FTS5 的 rowid。VACUUM / 恢复 / 迁移之后映射是否仍然正确，未验证。
// 2. 外部进程绕开 Store 改坏映射时，必须能识别，且不能继续静默使用错误映射。
//
// 冻结口径：
// - 不假设 VACUUM 一定保留 FTS5 rowid，以执行后的实际映射关系为准。
// - 外部破坏后，`upsertFtsRow` / `deleteFtsRow` 必须**明确抛 E_FTS_MAPPING**，
//   不允许按错误 rowid 删掉别人的索引行。
// - `fts_rowids` 是可重建辅助索引：`verifyFtsIndex` 能报出三类映射差异，
//   `rebuildFtsIndex` 能恢复一致性。
//
// 跑法：node test/fts-rowids-maintenance.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import {
  bigramText,
  deleteFtsRow,
  rebuildFtsIndex,
  searchFts,
  upsertFtsRow,
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

const log = { info() {}, debug() {}, warn() {}, error() {} }
const dirs = []

function makeDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function countRows(db, table) {
  return db.get(`SELECT COUNT(*) AS n FROM ${table}`).n
}

function mappingOf(db) {
  return db
    .all('SELECT kind, ref_id, row_id FROM fts_rowids ORDER BY row_id')
    .map((row) => ({ kind: row.kind, ref_id: row.ref_id, row_id: Number(row.row_id) }))
}

function ftsOf(db) {
  return db
    .all('SELECT rowid AS row_id, kind, ref_id FROM fts_index ORDER BY rowid')
    .map((row) => ({ kind: row.kind, ref_id: row.ref_id, row_id: Number(row.row_id) }))
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

async function remember(core, text, kind = 'fact') {
  const source = await core.capture({
    platform: 'dsh',
    channel: 'desktop',
    sessionRef: `rowids-maint-${Math.random().toString(36).slice(2, 8)}`,
    origin: 'user',
    kind: 'message',
    text,
  })
  return core.remember({
    text,
    kind,
    statement: text,
    sourceIds: [source.sourceId],
    confidence: 'medium',
    disclosure: 'public',
  })
}

/** 捕获一次调用是否抛指定错误码。 */
function threwCode(fn, code) {
  try {
    fn()
    return { threw: false }
  } catch (error) {
    return { threw: true, code: error?.code, message: String(error?.message ?? '') }
  }
}

console.log('\n[P2-E6-C1 维护回归]')

// ── 1. VACUUM 后映射仍正确 ───────────────────────────────────────────────
const dir1 = makeDir('psyche-rowids-maint-')
const opened1 = await openDatabase({
  file: join(dir1, 'memory.sqlite3'),
  driverPreference: 'node:sqlite',
  logger: log,
})
const db1 = opened1.db
migrate(db1, log)
const core1 = new Core({ db: db1, config: {}, logger: log, dataDir: dir1 })

const a = await remember(core1, '新家附近有家面馆。')
const b = await remember(core1, '周末去爬山看日出。')
eq('准备：FTS 两行', countRows(db1, 'fts_index'), 2)
eq('准备：映射两行', countRows(db1, 'fts_rowids'), 2)

db1.exec('VACUUM')
eq('VACUUM 后 verify 干净', cleanVerify(db1), {
  missing: [],
  orphan: [],
  duplicate: [],
  contentMismatch: [],
  mapMissing: [],
  mapOrphan: [],
  mapMismatch: [],
  integrityOk: true,
})
eq('VACUUM 后映射与 FTS 行逐条一致', mappingOf(db1), ftsOf(db1))
ok('VACUUM 后可检索到面馆', searchFts(db1, '面馆').some((hit) => hit.artifactId === a.artifactId))
ok('VACUUM 后可检索到爬山', searchFts(db1, '爬山').some((hit) => hit.artifactId === b.artifactId))

// ── 2. VACUUM 后写入不误删 ───────────────────────────────────────────────
const c = await remember(core1, '下周三搬家去青岛。')
ok('VACUUM 后 remember 可检索', searchFts(db1, '搬家').some((hit) => hit.artifactId === c.artifactId))
eq('VACUUM 后 remember 仍一一对应', mappingOf(db1), ftsOf(db1))
eq('VACUUM 后 remember verify 干净', cleanVerify(db1).mapMissing, [])

await core1.revise({
  artifactId: a.artifactId,
  statement: '她常去巷口那家小馆吃面。',
  refs: [a.artifactId],
})
ok('VACUUM 后 revise 新句可检索', searchFts(db1, '巷口').some((hit) => hit.artifactId === a.artifactId))
ok('VACUUM 后 revise 旧句不命中', !searchFts(db1, '面馆').some((hit) => hit.artifactId === a.artifactId))
eq('VACUUM 后 revise verify 干净', cleanVerify(db1).mapMissing, [])
eq('VACUUM 后 revise 后仍一一对应', mappingOf(db1), ftsOf(db1))

await core1.forget({ artifactId: c.artifactId, reason: '维护回归' })
ok('VACUUM 后 forget 不再召回', !searchFts(db1, '搬家').some((hit) => hit.artifactId === c.artifactId))
eq('VACUUM 后 forget verify 干净', cleanVerify(db1), {
  missing: [],
  orphan: [],
  duplicate: [],
  contentMismatch: [],
  mapMissing: [],
  mapOrphan: [],
  mapMismatch: [],
  integrityOk: true,
})

// ── 3. 外部破坏：识别，且不允许静默使用错误映射 ──────────────────────────
db1.run('UPDATE fts_rowids SET row_id = 999 WHERE ref_id = ?', [a.artifactId])
const broken = verifyFtsIndex(db1)
ok('外部改坏映射：verify 报 mapMissing', broken.mapMissing.includes(a.artifactId), broken.mapMissing)
ok('外部改坏映射：verify 报 mapOrphan', broken.mapOrphan.includes(a.artifactId), broken.mapOrphan)

const upsertResult = threwCode(
  () => upsertFtsRow(db1, { artifactId: a.artifactId, kind: 'fact', statement: '被改坏后再次写入。' }),
  'E_FTS_MAPPING',
)
ok('外部改坏映射：upsert 抛 E_FTS_MAPPING', upsertResult.threw && upsertResult.code === 'E_FTS_MAPPING', upsertResult)
const deleteResult = threwCode(() => deleteFtsRow(db1, a.artifactId), 'E_FTS_MAPPING')
ok('外部改坏映射：delete 抛 E_FTS_MAPPING', deleteResult.threw && deleteResult.code === 'E_FTS_MAPPING', deleteResult)
eq('失败后没有产生半截行', countRows(db1, 'fts_rowids'), 3)

// ── 4. 重建恢复 ──────────────────────────────────────────────────────────
const rebuilt = rebuildFtsIndex(db1)
eq('rebuild 覆盖三条 head', rebuilt.indexed, 3)
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
eq('rebuild 后映射与 FTS 逐条一致', mappingOf(db1), ftsOf(db1))
ok('rebuild 后 head 恢复可检索', searchFts(db1, '巷口').some((hit) => hit.artifactId === a.artifactId))

// ── 5. 映射被整行删掉后 rebuild 恢复 ─────────────────────────────────────
db1.run('DELETE FROM fts_rowids WHERE ref_id = ?', [b.artifactId])
const missingMap = verifyFtsIndex(db1)
ok('删除映射后 verify 报 mapMissing', missingMap.mapMissing.includes(b.artifactId), missingMap.mapMissing)
rebuildFtsIndex(db1)
eq('删除映射后 rebuild 恢复', cleanVerify(db1).mapMissing, [])
eq('恢复后仍一一对应', mappingOf(db1), ftsOf(db1))

// ── 6. 双驱动一致（better-sqlite3） ──────────────────────────────────────
const dir2 = makeDir('psyche-rowids-maint-better-')
const opened2 = await openDatabase({
  file: join(dir2, 'memory.sqlite3'),
  driverPreference: 'better-sqlite3',
  logger: log,
})
const db2 = opened2.db
migrate(db2, log)
const core2 = new Core({ db: db2, config: {}, logger: log, dataDir: dir2 })
const d = await remember(core2, '她喜欢在雨夜读诗。')
db2.exec('VACUUM')
eq('better：VACUUM 后 verify 干净', cleanVerify(db2), {
  missing: [],
  orphan: [],
  duplicate: [],
  contentMismatch: [],
  mapMissing: [],
  mapOrphan: [],
  mapMismatch: [],
  integrityOk: true,
})
eq('better：映射与 FTS 一致', mappingOf(db2), ftsOf(db2))
ok('better：VACUUM 后可检索', searchFts(db2, '雨夜').some((hit) => hit.artifactId === d.artifactId))
db2.run('UPDATE fts_rowids SET row_id = 999 WHERE ref_id = ?', [d.artifactId])
const betterBroken = verifyFtsIndex(db2)
ok('better：外部破坏可识别', betterBroken.mapMissing.includes(d.artifactId), betterBroken.mapMissing)
rebuildFtsIndex(db2)
eq('better：rebuild 恢复', cleanVerify(db2).mapMissing, [])
ok('better：恢复后可检索', searchFts(db2, '雨夜').some((hit) => hit.artifactId === d.artifactId))

// ── 收尾 ─────────────────────────────────────────────────────────────────
db1.close()
db2.close()
for (const dir of dirs) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows 上偶发 EPERM（句柄释放延迟），清理失败不影响断言结果
  }
}

console.log(`\n[P2-E6-C1 维护回归] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
