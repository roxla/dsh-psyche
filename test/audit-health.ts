/**
 * psyche-health 只读体检（P2 阶段 0）。
 *
 * 覆盖：正常库、文件不存在（且不初始化）、版本不匹配、缺表、只读断言、JSON 可序列化。
 * 全部用临时目录，测完即删。
 */
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase } from '../dist/lib/adapter.js'
import { inspectHealth } from '../dist/lib/audit-health.js'
import { SCHEMA_VERSION, EXPECTED_TABLE_COUNT } from '../dist/lib/schema.js'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'psyche-audit-health-'))

// ── 1. 正常库 ────────────────────────────────────────────────
const normalDir = join(root, 'normal')
const opened = await openDatabase({ file: join(normalDir, 'memory.sqlite3') })
opened.db.close()

const healthy = inspectHealth(normalDir)
check('正常库 status=ok', healthy.status === 'ok', JSON.stringify(healthy.issues))
check('正常库 schemaVersion 是当前版本', healthy.schemaVersion === SCHEMA_VERSION)
check('正常库 tableCount 是当前49', healthy.facts.tableCount === EXPECTED_TABLE_COUNT)
// v23 新增群调度证明触发器；v24 新增离线回复队列绑定/终态两条触发器。
check('正常库 triggerCount 是 44', healthy.facts.triggerCount === 44)
check('正常库零失败', healthy.summary.failed === 0)
check('正常库 readOnly 为 true', healthy.readOnly === true)
check('正常库 queryOnly 为 true', healthy.facts.queryOnly === true)
check('正常库可读 artifacts/sources/events', healthy.facts.artifacts === 0 && healthy.facts.sources === 0 && healthy.facts.events === 0)
check('正常库 persona 至多一个', Array.isArray(healthy.facts.personas) && healthy.facts.personas.length <= 1, JSON.stringify(healthy.facts.personas))

// ── 2. 文件不存在：不能创建 ──────────────────────────────────
const missingDir = join(root, 'missing')
const missing = inspectHealth(missingDir)
check('缺库 status=unavailable', missing.status === 'unavailable', JSON.stringify(missing.issues))
check('缺库给 E_DB_FILE_MISSING', missing.issues.some((issue) => issue.code === 'E_DB_FILE_MISSING'))
check('缺库不创建目录', !existsSync(missingDir))
check('缺库 readOnly 仍为 true', missing.readOnly === true)

// ── 3. 版本不匹配 ────────────────────────────────────────────
const badVersionDir = join(root, 'bad-version')
const badVersion = await openDatabase({ file: join(badVersionDir, 'memory.sqlite3') })
badVersion.db.exec('PRAGMA user_version = 3')
badVersion.db.close()
const versionReport = inspectHealth(badVersionDir)
check('版本不匹配 status=failed', versionReport.status === 'failed')
check('版本不匹配给 E_SCHEMA_VERSION', versionReport.issues.some((issue) => issue.code === 'E_SCHEMA_VERSION'))

// ── 4. 缺表 ──────────────────────────────────────────────────
const droppedDir = join(root, 'dropped')
const dropped = await openDatabase({ file: join(droppedDir, 'memory.sqlite3') })
dropped.db.exec('DROP TABLE tension_versions')
dropped.db.close()
const droppedReport = inspectHealth(droppedDir)
check('缺表 status=failed', droppedReport.status === 'failed')
check('缺表给 E_TABLE_MISSING', droppedReport.issues.some((issue) => issue.code === 'E_TABLE_MISSING' && issue.table === 'tension_versions'))

// ── 5. 打不开的文件 ─────────────────────────────────────────
const brokenDir = join(root, 'broken')
const brokenFile = join(brokenDir, 'memory.sqlite3')
const { mkdirSync } = await import('node:fs')
mkdirSync(brokenDir, { recursive: true })
writeFileSync(brokenFile, 'not a sqlite database at all', 'utf8')
const brokenReport = inspectHealth(brokenDir)
check('坏文件 status=unavailable', brokenReport.status === 'unavailable')
check('坏文件给 E_DB_OPEN_FAILED', brokenReport.issues.some((issue) => issue.code === 'E_DB_OPEN_FAILED'))
check('坏文件 readOnly 为 true', brokenReport.readOnly === true)

// ── 6. --file 直指数据库 ────────────────────────────────────
const direct = inspectHealth(dirname(join(normalDir, 'memory.sqlite3')), { file: join(normalDir, 'memory.sqlite3') })
check('--file 直指库文件可用', direct.status === 'ok')

// ── 7. JSON 可序列化且字段齐全 ──────────────────────────────
const json = JSON.parse(JSON.stringify(healthy)) as Record<string, unknown>
check('JSON 可序列化且有 tool 字段', json.tool === 'psyche-health')
check('JSON 有 status/summary/issues/readOnly', json.status !== undefined && json.summary !== undefined && json.issues !== undefined && json.readOnly === true)

try {
  rmSync(root, { recursive: true, force: true })
} catch {
  /* 临时目录清不掉不影响结论 */
}

console.log(`[audit-health] ${pass} 通过 ${fail} 失败`)
if (fail > 0) process.exitCode = 1
