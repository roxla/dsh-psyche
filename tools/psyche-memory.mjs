#!/usr/bin/env node
// P5-5：记忆整理 CLI（本机、无 HTTP 写口）。
//
// 用法：
//   node tools/psyche-memory.mjs duplicates --data-dir <DSH_DATA_DIR>
//   node tools/psyche-memory.mjs stale      --data-dir <dir> [--days 180]
//   node tools/psyche-memory.mjs archived   --data-dir <dir>
//   node tools/psyche-memory.mjs merge      --data-dir <dir> --canonical <art_…> --duplicate <art_…> --owner <SID/UID> [--yes]
//   node tools/psyche-memory.mjs unmerge    --data-dir <dir> --canonical <art_…> --duplicate <art_…> --owner <SID/UID> [--yes]
//   node tools/psyche-memory.mjs archive    --data-dir <dir> --artifact <art_…> --owner <SID/UID> [--yes]
//   node tools/psyche-memory.mjs restore    --data-dir <dir> --artifact <art_…> --owner <SID/UID> [--yes]
//
// 安全边界：
// - Owner 身份取操作系统账户（Windows: whoami /user 的 SID；POSIX: process.getuid()），
//   与 --owner 不一致直接拒绝；用户名只用于展示，不作为授权凭据。
// - 未给 --yes 时只预览，不写库。
// - 写操作只追加 memory_merge_events / memory_archive_events，不删除任何历史。
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  archiveArtifact,
  findDuplicateClusters,
  findStaleCandidates,
  listArchived,
  mergeArtifacts,
  openDatabase,
  restoreArtifact,
  unmergeArtifacts,
} from 'dsh-psyche-core'

function argOf(argv, name) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`)
}

/** 当前进程的操作系统身份；无法确定时抛错（宁可拒绝）。 */
function currentOsIdentity() {
  if (process.platform === 'win32') {
    const out = execFileSync('whoami', ['/user'], { encoding: 'utf8' })
    const match = /(S-1-5-[\d-]+)/.exec(out)
    if (!match) throw new Error('E_OWNER_UNVERIFIED')
    return match[1]
  }
  const uid = process.getuid?.()
  if (typeof uid !== 'number') throw new Error('E_OWNER_UNVERIFIED')
  return String(uid)
}

function fail(message) {
  console.error(`[psyche-memory] ${message}`)
  process.exitCode = 2
}

function requireOwner(argv) {
  const owner = argOf(argv, 'owner')
  if (!owner) {
    fail('需要 --owner <SID/UID>')
    return null
  }
  const actual = currentOsIdentity()
  if (owner !== actual) {
    fail(`Owner 身份不一致：配置 ${owner}，当前进程 ${actual}`)
    return null
  }
  return `os:${actual}`
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const dataDir = argOf(argv, 'data-dir')
  if (!dataDir) {
    fail('需要 --data-dir <DSH_DATA_DIR>')
    return
  }
  const commands = ['duplicates', 'stale', 'archived', 'merge', 'unmerge', 'archive', 'restore']
  if (!commands.includes(command)) {
    fail(`命令必须是 ${commands.join(' / ')}`)
    return
  }

  const opened = await openDatabase({ file: join(dataDir, 'memory.sqlite3') })
  const db = opened.db
  try {
    if (command === 'duplicates') {
      const clusters = findDuplicateClusters(db)
      if (clusters.length === 0) {
        console.log('没有发现确定性重复簇。')
        return
      }
      for (const cluster of clusters) {
        console.log(`重复簇（${cluster.kind}）：${cluster.statement}`)
        console.log(`  建议 canonical：${cluster.canonicalId}`)
        for (const id of cluster.duplicates) console.log(`  duplicate：${id}`)
      }
      return
    }

    if (command === 'stale') {
      const days = Number(argOf(argv, 'days') ?? 180)
      const rows = findStaleCandidates(db, { days: Number.isFinite(days) ? days : 180 })
      if (rows.length === 0) {
        console.log('没有符合淡忘候选条件的记忆。')
        return
      }
      for (const row of rows) {
        console.log(`${row.artifactId}（${row.kind}，更新 ${row.updatedAt}，salience ${row.salience}，独立证据 ${row.independentEvidenceCount}）`)
        console.log(`  ${row.statement}`)
      }
      console.log('以上只是候选；归档需要 Owner 显式执行 archive。')
      return
    }

    if (command === 'archived') {
      const rows = listArchived(db)
      if (rows.length === 0) console.log('没有已归档记忆。')
      for (const id of rows) console.log(id)
      return
    }

    const decidedBy = requireOwner(argv)
    if (!decidedBy) return
    const yes = hasFlag(argv, 'yes')
    const now = new Date()

    if (command === 'merge' || command === 'unmerge') {
      const canonicalId = argOf(argv, 'canonical')
      const duplicateId = argOf(argv, 'duplicate')
      if (!canonicalId || !duplicateId) {
        fail('需要 --canonical <art_…> 和 --duplicate <art_…>')
        return
      }
      if (!yes) {
        console.log(`预览：${command} canonical=${canonicalId} duplicate=${duplicateId}（缺 --yes，不写库）`)
        return
      }
      const runner = command === 'merge' ? mergeArtifacts : unmergeArtifacts
      const result = runner(db, canonicalId, duplicateId, { by: decidedBy, now })
      console.log(`${command} 完成：${JSON.stringify(result)}`)
      return
    }

    const artifactId = argOf(argv, 'artifact')
    if (!artifactId) {
      fail('需要 --artifact <art_…>')
      return
    }
    if (!yes) {
      console.log(`预览：${command} artifact=${artifactId}（缺 --yes，不写库）`)
      return
    }
    const runner = command === 'archive' ? archiveArtifact : restoreArtifact
    const result = runner(db, artifactId, { by: decidedBy, now })
    console.log(`${command} 完成：${JSON.stringify(result)}`)
  } finally {
    db.close?.()
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
