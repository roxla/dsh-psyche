#!/usr/bin/env node
// P6-3：内部意愿 CLI（本机、无 HTTP 写口）。
//
// 用法：
//   node tools/psyche-intention.mjs list --data-dir <DSH_DATA_DIR>
//   node tools/psyche-intention.mjs defer --data-dir <dir> --intention int_… --owner <SID/UID>
//     --reason <code> --revisit-at <ISO> --condition <code> [--yes]
//   node tools/psyche-intention.mjs abandon --data-dir <dir> --intention int_… --owner <SID/UID>
//     --reason <code> [--yes]
//
// 安全边界：
// - Owner 身份取操作系统账户（Windows: whoami /user 的 SID；POSIX: process.getuid()）。
// - 未给 --yes 只打印将要执行的变更，不写库。
// - 只改内部意愿状态；不发送、不建 Draft/Approval/Outbox。
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  abandonIntention,
  deferIntention,
  getIntention,
  listIntentions,
  openDatabase,
} from 'dsh-psyche-core'

function argOf(argv, name) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`)
}

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
  console.error(`[psyche-intention] ${message}`)
  process.exitCode = 2
}

function printIntention(row) {
  console.log(`意愿 ${row.intentionId}`)
  console.log(`  状态：${row.status}`)
  console.log(`  语义键：${row.semanticKey}`)
  console.log(`  范围：${row.scope}`)
  console.log(`  原因：${row.reasonCode ?? '—'}`)
  console.log(`  过期：${new Date(row.expiresAt).toISOString()}`)
  if (row.reevaluateAt !== null) {
    console.log(`  下次评估：${new Date(row.reevaluateAt).toISOString()}（${row.reevaluateCondition ?? '—'}）`)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const dataDir = argOf(argv, 'data-dir')
  if (!dataDir) {
    fail('需要 --data-dir <DSH_DATA_DIR>')
    return
  }
  if (!['list', 'defer', 'abandon'].includes(command)) {
    fail('命令必须是 list / defer / abandon')
    return
  }

  const opened = await openDatabase({ file: join(dataDir, 'memory.sqlite3') })
  const db = opened.db
  try {
    if (command === 'list') {
      const rows = listIntentions(db, { personaId: 'main' }).filter(
        (row) => row.status === 'internal' || row.status === 'deferred',
      )
      if (rows.length === 0) {
        console.log('当前没有内部意愿。')
        return
      }
      for (const row of rows) printIntention(row)
      return
    }

    const intentionId = argOf(argv, 'intention')
    const owner = argOf(argv, 'owner')
    const reason = argOf(argv, 'reason')
    if (!intentionId || !owner || !reason) {
      fail('需要 --intention int_…、--owner <SID/UID>、--reason <code>')
      return
    }
    const actual = currentOsIdentity()
    if (owner !== actual) {
      fail(`Owner 身份不一致：配置 ${owner}，当前进程 ${actual}`)
      return
    }
    const row = getIntention(db, intentionId)
    if (!row) {
      fail(`意愿不存在：${intentionId}`)
      return
    }
    printIntention(row)
    if (command === 'abandon') {
      if (!hasFlag(argv, 'yes')) {
        console.log('未确认（缺 --yes）：只预览，不写库。')
        return
      }
      const ok = abandonIntention(db, { now: new Date().toISOString(), intentionId, reason })
      console.log(ok ? '已放弃。' : '放弃被拒绝（状态或参数不允许）。')
      return
    }

    const revisitAt = argOf(argv, 'revisit-at')
    const condition = argOf(argv, 'condition')
    if (!revisitAt || !condition) {
      fail('defer 需要 --revisit-at <ISO> 和 --condition <code>')
      return
    }
    if (!hasFlag(argv, 'yes')) {
      console.log(`未确认（缺 --yes）：将延后到 ${revisitAt}，条件 ${condition}；只预览，不写库。`)
      return
    }
    const ok = deferIntention(db, {
      now: new Date().toISOString(),
      intentionId,
      reason,
      revisitAt,
      condition,
    })
    console.log(ok ? '已延后。' : '延后被拒绝（状态、TTL 或参数不允许）。')
  } finally {
    db.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
