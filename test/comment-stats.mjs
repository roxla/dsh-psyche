// 统计 src 的注释体量：总行数、注释行（// · 块注释内 / * · SQL 的 --）、以及与代码行的比例。
// 只读脚本，不改任何文件。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = 'src'

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

let totalLines = 0
let totalComment = 0
const rows = []

for (const file of walk(root)) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  let comment = 0
  let inBlock = false
  for (const raw of lines) {
    const line = raw.trim()
    if (inBlock) {
      comment += 1
      if (line.includes('*/')) inBlock = false
      continue
    }
    if (line.startsWith('/*')) {
      comment += 1
      if (!line.includes('*/')) inBlock = true
      continue
    }
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('--')) comment += 1
  }
  totalLines += lines.length
  totalComment += comment
  rows.push({ file: relative(root, file), lines: lines.length, comment, ratio: comment / Math.max(1, lines.length) })
}

rows.sort((a, b) => b.lines - a.lines)
for (const row of rows) {
  console.log(`${row.file.padEnd(26)} ${String(row.lines).padStart(6)} 行  注释 ${String(row.comment).padStart(4)}  ${(row.ratio * 100).toFixed(0)}%`)
}
console.log(`\n合计 ${totalLines} 行，注释 ${totalComment} 行（${((totalComment / totalLines) * 100).toFixed(1)}%），代码约 ${totalLines - totalComment} 行`)
