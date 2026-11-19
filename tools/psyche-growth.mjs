#!/usr/bin/env node
// P5-3b：成长候选确认 CLI（本机、无 HTTP 写口）。
//
// 用法：
//   node tools/psyche-growth.mjs list --data-dir <DSH_DATA_DIR>
//   node tools/psyche-growth.mjs confirm --data-dir <dir> --candidate gca_… --owner <SID/UID> [--hash <sha256>] [--yes]
//   node tools/psyche-growth.mjs reject|withdraw --data-dir <dir> --candidate gca_… --owner <SID/UID> [--yes]
//
// 安全边界：
// - Owner 身份取操作系统账户（Windows: whoami /user 的 SID；POSIX: process.getuid()），
//   与 --owner 不一致直接拒绝；用户名只用于展示，不作为授权凭据。
// - 未给 --yes 时只打印候选内容、scope、来源数与哈希，不写库。
// - 决策写 append-only growth_confirmations，候选 status 同事务物化。
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  decideGrowthCandidate,
  decisionCandidateStatuses,
  formatConfirmedGrowthLine,
  growthCandidateContentHash,
  listGrowthCandidates,
  openDatabase,
  readConfirmedGrowthChanges,
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
  console.error(`[psyche-growth] ${message}`)
  process.exitCode = 2
}

function printCandidate(candidate, hash) {
  console.log(`候选 ${candidate.candidateId}`)
  console.log(`  类型：${candidate.type}`)
  console.log(`  内容：${candidate.statement}`)
  console.log(`  范围：${candidate.scope}`)
  console.log(`  主题：${candidate.subjectRefs.join('、') || '—'}`)
  console.log(`  独立证据：${candidate.independentCount}`)
  console.log(`  内容哈希：${hash}`)
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const dataDir = argOf(argv, 'data-dir')
  if (!dataDir) {
    fail('需要 --data-dir <DSH_DATA_DIR>')
    return
  }
  if (!['list', 'confirm', 'reject', 'withdraw'].includes(command)) {
    fail('命令必须是 list / confirm / reject / withdraw')
    return
  }

  const opened = await openDatabase({ file: join(dataDir, 'memory.sqlite3') })
  const db = opened.db
  try {
    if (command === 'list') {
      const rows = listGrowthCandidates(db, { status: 'proposed' })
      if (rows.length === 0) {
        console.log('没有待确认的成长候选。')
      } else {
        for (const row of rows) {
          const hash = growthCandidateContentHash(db, row.candidateId).hash
          printCandidate(row, hash)
        }
      }
      const confirmed = readConfirmedGrowthChanges(db, { limit: 3 })
      if (confirmed.length > 0) {
        console.log('已确认（投影只读）：')
        for (const change of confirmed) console.log(`  ${formatConfirmedGrowthLine(change)}`)
      }
      return
    }

    const candidateId = argOf(argv, 'candidate')
    const owner = argOf(argv, 'owner')
    if (!candidateId || !owner) {
      fail('需要 --candidate gca_… 和 --owner <SID/UID>')
      return
    }
    const actual = currentOsIdentity()
    if (owner !== actual) {
      fail(`Owner 身份不一致：配置 ${owner}，当前进程 ${actual}`)
      return
    }
    const decidedBy = `os:${actual}`
    const candidate = decisionCandidateStatuses(command)
      .flatMap((status) => listGrowthCandidates(db, { status }))
      .find((row) => row.candidateId === candidateId)
    if (!candidate) {
      fail(`候选不存在或不适用于 ${command}：${candidateId}`)
      return
    }
    const hash = growthCandidateContentHash(db, candidateId).hash
    printCandidate(candidate, hash)
    if (!hasFlag(argv, 'yes')) {
      console.log('未确认（缺 --yes）：只预览，不写库。')
      return
    }
    const result = decideGrowthCandidate(db, {
      candidateId,
      decision: command,
      decidedBy,
      expectedHash: argOf(argv, 'hash') ?? undefined,
    })
    console.log(`已${result.decision === 'confirm' ? '确认' : result.decision === 'reject' ? '否决' : '撤回'} ${candidateId}${result.idempotent ? '（幂等重复）' : ''}`)
  } finally {
    db.close?.()
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
