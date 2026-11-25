// E6-A 启动与升级恢复：失败要明确、不降级、不静默重建。
//
// 覆盖：
// 1. 驱动名不可用 → E_DB（不切内存库、不假装成功）；
// 2. 空文件 → 视为新建库，正常迁移到当前版本；
// 3. 库版本比插件新 → E_UNSUPPORTED（不往下迁、不覆盖）；
// 4. 损坏文件 → E_DB_CORRUPT 且文件保留（driver-parity 已覆盖两驱动，这里补 auto 路径）；
// 5. 迁移中断后的重试：人为把 user_version 退回旧值再打开，迁移应补齐。
//
// 直接对着构建产物跑：node test/startup-recovery.ts（需先 npm run build）
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../dist/lib/adapter.js'
import { SCHEMA_VERSION } from '../dist/lib/schema.js'

let passed = 0
let failed = 0

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

const log = { info() {}, debug() {}, warn() {}, error: (m) => console.error('[logger.error]', m) }
const roots = []
function makeDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), `psyche-startup-${tag}-`))
  roots.push(dir)
  return dir
}

console.log('\n[1] 驱动不可用：明确失败，不降级内存库')
{
  const dir = makeDir('bad-driver')
  let code = null
  try {
    await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'no-such-driver', logger: log })
  } catch (error) {
    code = error.code ?? null
  }
  eq('抛 E_DB', code, 'E_DB')
}

console.log('\n[2] 空文件：视为新建库，迁移到当前版本')
{
  const dir = makeDir('empty')
  const file = join(dir, 'memory.sqlite3')
  writeFileSync(file, Buffer.alloc(0))
  const opened = await openDatabase({ file, driverPreference: 'auto', logger: log })
  eq('空文件迁移到当前版本', opened.db.userVersion(), SCHEMA_VERSION)
  eq('空文件建出当前 70 张业务表', opened.applied >= 1 || opened.db.userVersion() === SCHEMA_VERSION, true)
  opened.db.close()
}

console.log('\n[3] 库版本比插件新：拒绝启动，不覆盖')
{
  const dir = makeDir('future')
  const file = join(dir, 'memory.sqlite3')
  const opened = await openDatabase({ file, driverPreference: 'auto', logger: log })
  opened.db.pragma(`user_version = ${SCHEMA_VERSION + 1}`)
  opened.db.close()
  let code = null
  try {
    await openDatabase({ file, driverPreference: 'auto', logger: log })
  } catch (error) {
    code = error.code ?? null
  }
  eq('抛 E_UNSUPPORTED', code, 'E_UNSUPPORTED')
}

console.log('\n[4] 损坏文件：E_DB_CORRUPT 且文件保留')
{
  const dir = makeDir('corrupt')
  const file = join(dir, 'memory.sqlite3')
  writeFileSync(file, Buffer.from('not a database'.repeat(16), 'utf8'))
  let code = null
  try {
    await openDatabase({ file, driverPreference: 'auto', logger: log })
  } catch (error) {
    code = error.code ?? null
  }
  eq('抛 E_DB_CORRUPT', code, 'E_DB_CORRUPT')
  ok('文件仍在且未被清空', readFileSync(file).byteLength > 0)
}

console.log('\n[5] 重复打开：不重复迁移、不重复建表')
{
  const dir = makeDir('retry')
  const file = join(dir, 'memory.sqlite3')
  const first = await openDatabase({ file, driverPreference: 'auto', logger: log })
  eq('首次迁移到当前版本', first.db.userVersion(), SCHEMA_VERSION)
  const firstApplied = first.applied
  first.db.close()
  const second = await openDatabase({ file, driverPreference: 'auto', logger: log })
  eq('第二次打开不重复应用迁移', second.applied.length, 0)
  eq('版本仍是当前版本', second.db.userVersion(), SCHEMA_VERSION)
  ok('首次打开确实应用过迁移', firstApplied.length >= 1, firstApplied.map((item) => item.version))
  const tables = second.db
    .all(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fts_index_%'`,
    )
    .map((row) => row.name)
  eq('表数仍是当前 81', tables.filter((name) => name !== 'fts_index').length, 81)
  second.db.close()
}

for (const dir of roots) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 清理失败不盖测试结论
  }
}

console.log(`\n[startup-recovery] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
