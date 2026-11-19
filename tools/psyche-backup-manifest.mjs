#!/usr/bin/env node
// P5-R-3a：备份治理清单（JSON，非数据库表）。
//
// 用法：
//   node tools/psyche-backup-manifest.mjs list  --data-dir <dir>
//   node tools/psyche-backup-manifest.mjs add   --data-dir <dir> --id <backup-id> --file <备份文件>
//         [--created-at <ISO>] [--retention-days N] [--may-contain-erased true|false|unknown]
//         [--db-identity <字符串>] [--yes]
//
// 边界：
// - 清单只是备份治理记录，不是 Source 删除状态的第二事实源；
// - 原子替换（临时文件 + rename），避免写一半；
// - 无法确认内容时标 unknown，绝不默认安全；
// - 清单缺失不阻止逻辑删除，但不能据此宣称「全部副本已清理」。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function argOf(argv, name) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null
}
function hasFlag(argv, name) {
  return argv.includes(`--${name}`)
}
function fail(message) {
  console.error(`[psyche-backup-manifest] ${message}`)
  process.exitCode = 2
}
function manifestPath(dataDir) {
  return join(dataDir, 'exports', 'backup-manifest.json')
}
function loadManifest(dataDir) {
  const file = manifestPath(dataDir)
  if (!existsSync(file)) return { version: 1, updatedAt: null, backups: [] }
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.backups)) {
    throw new Error('E_MANIFEST_INVALID')
  }
  return parsed
}
function saveManifest(dataDir, manifest) {
  const file = manifestPath(dataDir)
  mkdirSync(join(dataDir, 'exports'), { recursive: true })
  manifest.updatedAt = new Date().toISOString()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}
function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const dataDir = argOf(argv, 'data-dir')
  if (!dataDir) {
    fail('需要 --data-dir <dir>')
    return
  }
  if (command === 'list') {
    const manifest = loadManifest(dataDir)
    if (manifest.backups.length === 0) {
      console.log('备份清单为空。')
      return
    }
    for (const backup of manifest.backups) {
      console.log(`${backup.id}  ${backup.createdAt}  ${backup.sha256}  mayContainErased=${backup.mayContainErased}`)
      console.log(`  file: ${backup.file}`)
    }
    return
  }
  if (command !== 'add') {
    fail('命令必须是 list / add')
    return
  }
  const id = argOf(argv, 'id')
  const file = argOf(argv, 'file')
  if (!id || !file) {
    fail('需要 --id <backup-id> --file <备份文件>')
    return
  }
  if (!existsSync(file)) {
    fail(`备份文件不存在：${file}`)
    return
  }
  const mayContain = argOf(argv, 'may-contain-erased') ?? 'unknown'
  if (!['true', 'false', 'unknown'].includes(mayContain)) {
    fail('--may-contain-erased 必须是 true|false|unknown')
    return
  }
  const entry = {
    id,
    createdAt: argOf(argv, 'created-at') ?? new Date().toISOString(),
    sha256: sha256File(file),
    file,
    databaseIdentity: argOf(argv, 'db-identity') ?? null,
    retentionUntilMs: argOf(argv, 'retention-days') === null
      ? null
      : Date.now() + Number(argOf(argv, 'retention-days')) * 24 * 60 * 60 * 1000,
    mayContainErased: mayContain,
  }
  if (!hasFlag(argv, 'yes')) {
    console.log(`预览：add ${id} sha256=${entry.sha256} mayContainErased=${mayContain}（缺 --yes，不写清单）`)
    return
  }
  const manifest = loadManifest(dataDir)
  const existing = manifest.backups.findIndex(item => item.id === id)
  if (existing >= 0) manifest.backups[existing] = entry
  else manifest.backups.push(entry)
  saveManifest(dataDir, manifest)
  console.log(`add 完成：${id}（manifest=${manifestPath(dataDir)}）`)
}

try {
  main()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
