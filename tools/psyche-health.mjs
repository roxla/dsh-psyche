#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 心灵健康检查命令行（P2 Health / Integrity 阶段 0）。
//
// 回答一个问题：**当前这个库能不能跑起来？**
// 它只读（readOnly + query_only），不迁移、不建表、不修复、不重建 FTS、不建备份。
//
// 用法（仓库根目录，先 `npm run build`）：
//   node tools/psyche-health.mjs --data "C:\Users\你\.dsh\psyche"
//   node tools/psyche-health.mjs --data <目录> --json
//
// 退出码：0 = ok/warn、1 = failed、2 = unavailable、3 = 用法错误。
// ─────────────────────────────────────────────────────────────────────────────

import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')
const CORE_DIST = join(ROOT, 'packages', 'core', 'dist')

function usage() {
  console.log(`心灵健康检查（只读，不修复）

用法：
  node tools/psyche-health.mjs --data <数据目录> [--file <库文件>] [--json] [--quiet]

说明：
  --data   数据根目录（默认库文件是 <data>/memory.sqlite3）
  --file   直接指定库文件（优先于 --data）
  --json   输出机器可读 JSON
  --quiet  只输出一行结论

退出码：0 = ok/warn、1 = failed、2 = unavailable、3 = 用法错误。`)
}

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    if (key === 'json' || key === 'quiet' || key === 'help') {
      flags[key] = true
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      flags[key] = ''
      continue
    }
    flags[key] = value
    i += 1
  }
  return flags
}

function printHuman(report) {
  const lines = []
  lines.push(`心灵健康检查（只读）`)
  lines.push(`  状态        ${report.status}`)
  lines.push(`  schema 版本 ${report.schemaVersion ?? '(未知)'} / 期望 ${report.expectedSchemaVersion}`)
  lines.push(`  库文件      ${report.facts?.tableCount ?? '?'} 张业务表、${report.facts?.triggerCount ?? '?'} 个触发器`)
  lines.push(`  数据        artifacts=${report.facts?.artifacts ?? '?'} sources=${report.facts?.sources ?? '?'} events=${report.facts?.events ?? '?'}`)
  lines.push(`  检查        ${report.summary.checked} 项：通过 ${report.summary.passed}、失败 ${report.summary.failed}、警告 ${report.summary.warnings}`)
  if (report.issues.length > 0) {
    lines.push('  问题：')
    for (const issue of report.issues) {
      lines.push(`    [${issue.severity}] ${issue.code}  ${issue.table} / ${issue.recordId}`)
      lines.push(`      ${issue.detail}`)
    }
  }
  lines.push('  只读：未迁移、未修复、未重建索引。')
  return lines.join('\n')
}

const flags = parseArgs(process.argv.slice(2))
if (flags.help === true) {
  usage()
  process.exit(0)
}

const dataDir = typeof flags.data === 'string' && flags.data !== '' ? resolve(flags.data) : ''
const file = typeof flags.file === 'string' && flags.file !== '' ? resolve(flags.file) : ''
if (dataDir === '' && file === '') {
  console.error('错误：必须给 --data <数据目录> 或 --file <库文件>。')
  usage()
  process.exit(3)
}
if (!existsSync(CORE_DIST)) {
  console.error(`错误：找不到构建产物 ${CORE_DIST}，请先运行 npm run build。`)
  process.exit(3)
}

const { inspectHealth } = await import(pathToFileURL(join(CORE_DIST, 'audit-health.js')).href)
const report = inspectHealth(file === '' ? dataDir : dirname(file), file === '' ? {} : { file })

if (flags.json === true) {
  console.log(JSON.stringify(report, null, 2))
} else if (flags.quiet === true) {
  console.log(`${report.status} checked=${report.summary.checked} failed=${report.summary.failed} warnings=${report.summary.warnings}`)
} else {
  console.log(printHuman(report))
}

process.exitCode = report.status === 'ok' || report.status === 'warn' ? 0 : report.status === 'failed' ? 1 : 2
