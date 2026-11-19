#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 心灵完整性审计命令行（P2 Health / Integrity 阶段 0）。
//
// 回答一个问题：**库里的业务数据是否完整、引用是否可靠？**
// 与 psyche-health 的分工：health 查「能不能跑」，这里查「数据自洽不自洽」。
//
// 只读：不修数据、不迁移、不重建 FTS、不清理孤儿、不建备份。
// 注意：FTS5 的 `integrity-check` 是写操作，本工具不执行；只做纯 SELECT 比对。
//
// 用法（仓库根目录，先 `npm run build`）：
//   node tools/psyche-integrity.mjs --data "C:\Users\你\.dsh\psyche"
//   node tools/psyche-integrity.mjs --data <目录> --json
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
  console.log(`心灵完整性审计（只读，不修复）

用法：
  node tools/psyche-integrity.mjs --data <数据目录> [--file <库文件>] [--json] [--quiet]

检查范围：
  1. SQLite：integrity_check / foreign_key_check
  2. 证据链：event_sources / artifact_evidence / artifact_trigger_events
  3. Revision：head 是否存在、是否最大、是否有孤儿版本
  4. Lineage：来源 Artifact 与 Revision 是否存在
  5. Decision：decision_items 多态引用、结果指针、状态与 finalized_at
  6. Tension：两侧 Artifact+Revision、head 版本
  7. Stance：stance_key 唯一性、kind=stance 是否有 key、payload 与 key 一致
  8. Diary：复用 inspectDiaryIntegrity（head 脱节/悬空来源/重复引用/孤儿版本）
  9. FTS：fts_index 与 head 的内容比对、fts_rowids 映射（不执行 FTS integrity-check）
 10. 资产：source_assets 文件存在/大小/哈希
 11. 备份：backups/*.sqlite3 只读打开并 integrity_check（最多 5 个）

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
  lines.push('心灵完整性审计（只读）')
  lines.push(`  状态        ${report.status}`)
  lines.push(`  schema 版本 ${report.schemaVersion ?? '(未知)'} / 期望 ${report.expectedSchemaVersion}`)
  lines.push(`  检查        ${report.summary.checked} 项：通过 ${report.summary.passed}、失败 ${report.summary.failed}、警告 ${report.summary.warnings}`)
  if (report.groups.length > 0) {
    lines.push('  分组：')
    for (const group of report.groups) {
      lines.push(`    ${group.name.padEnd(10)} 检查 ${group.checked}、问题 ${group.issues}`)
    }
  }
  if (report.issues.length > 0) {
    lines.push('  问题：')
    for (const issue of report.issues) {
      const ref = issue.refType === undefined ? '' : `（${issue.refType}:${issue.refId ?? ''}）`
      lines.push(`    [${issue.severity}] ${issue.code}  ${issue.table} / ${issue.recordId}${ref}`)
      lines.push(`      ${issue.detail}`)
    }
  }
  lines.push('  只读：未修复、未迁移、未重建索引、未清理孤儿。')
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

const { inspectIntegrity } = await import(pathToFileURL(join(CORE_DIST, 'audit-integrity.js')).href)
const report = inspectIntegrity(file === '' ? dataDir : dirname(file), file === '' ? {} : { file })

if (flags.json === true) {
  console.log(JSON.stringify(report, null, 2))
} else if (flags.quiet === true) {
  console.log(`${report.status} checked=${report.summary.checked} failed=${report.summary.failed} warnings=${report.summary.warnings}`)
} else {
  console.log(printHuman(report))
}

process.exitCode = report.status === 'ok' || report.status === 'warn' ? 0 : report.status === 'failed' ? 1 : 2
