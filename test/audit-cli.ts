/**
 * psyche-health / psyche-integrity 命令行（P2 阶段 0）。
 *
 * 覆盖：参数、退出码、JSON 输出、只读库不存在时的行为。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDatabase } from '../dist/lib/adapter.js'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail: unknown = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'psyche-audit-cli-'))
const dataDir = join(root, 'data')
const opened = await openDatabase({ file: join(dataDir, 'memory.sqlite3') })
opened.db.close()

const HEALTH = resolve('tools/psyche-health.mjs')
const INTEGRITY = resolve('tools/psyche-integrity.mjs')

function run(cli: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

// ── health ──────────────────────────────────────────────────
const healthJson = run(HEALTH, ['--data', dataDir, '--json'])
check('health --json 退出码 0', healthJson.status === 0, healthJson.stderr)
let parsed: Record<string, unknown> = {}
try {
  parsed = JSON.parse(healthJson.stdout) as Record<string, unknown>
} catch {
  parsed = {}
}
check('health --json 可解析', Object.keys(parsed).length > 0, healthJson.stdout.slice(0, 200))
check('health JSON tool 是 psyche-health', parsed.tool === 'psyche-health')
check('health JSON readOnly 为 true', parsed.readOnly === true)

const healthQuiet = run(HEALTH, ['--data', dataDir, '--quiet'])
check('health --quiet 输出单行', healthQuiet.stdout.trim().split('\n').length === 1 && healthQuiet.stdout.includes('checked='))

const healthNoArgs = run(HEALTH, [])
check('health 缺参数退出码 3', healthNoArgs.status === 3, String(healthNoArgs.status))

const healthMissing = run(HEALTH, ['--data', join(root, 'no-such-dir'), '--json'])
check('health 缺库退出码 2', healthMissing.status === 2, String(healthMissing.status))

const healthHelp = run(HEALTH, ['--help'])
check('health --help 含用法', healthHelp.stdout.includes('用法') && healthHelp.status === 0)

// ── integrity ───────────────────────────────────────────────
const integrityJson = run(INTEGRITY, ['--data', dataDir, '--json'])
check('integrity --json 退出码 0', integrityJson.status === 0, integrityJson.stderr)
let integrityParsed: Record<string, unknown> = {}
try {
  integrityParsed = JSON.parse(integrityJson.stdout) as Record<string, unknown>
} catch {
  integrityParsed = {}
}
check('integrity JSON tool 是 psyche-integrity', integrityParsed.tool === 'psyche-integrity')
check('integrity JSON 有 groups 数组', Array.isArray(integrityParsed.groups))
check('integrity JSON readOnly 为 true', integrityParsed.readOnly === true)

const integrityQuiet = run(INTEGRITY, ['--data', dataDir, '--quiet'])
check('integrity --quiet 输出单行', integrityQuiet.stdout.trim().split('\n').length === 1 && integrityQuiet.stdout.includes('checked='))

const integrityNoArgs = run(INTEGRITY, [])
check('integrity 缺参数退出码 3', integrityNoArgs.status === 3, String(integrityNoArgs.status))

// 跑完之后仍能打开，且保持本次初始化的最新版本。
const after = await openDatabase({ file: join(dataDir, 'memory.sqlite3') })
const version = after.db.get<{ user_version: number }>('PRAGMA user_version')?.user_version
after.db.close()
check('跑完审计后库仍是 v31（未被迁移或改写）', Number(version) === 31, version)

try {
  rmSync(root, { recursive: true, force: true })
} catch {
  /* 清理失败不影响结论 */
}

console.log(`[audit-cli] ${pass} 通过 ${fail} 失败`)
if (fail > 0) process.exitCode = 1
