#!/usr/bin/env node
// P5-6：外界来源登记/隔离 CLI（本机、无 HTTP 写口）。
//
// 用法：
//   node tools/psyche-source.mjs list     --data-dir <dir> [--kind web|file|group] [--include-deleted]
//   node tools/psyche-source.mjs delete   --data-dir <dir> --source <src_…> --owner <SID/UID> [--reason …] [--yes]
//   node tools/psyche-source.mjs purge    --data-dir <dir> --owner <SID/UID> [--yes]
//   node tools/psyche-source.mjs record   --data-dir <dir> --source <src_…> --kind … --provenance … --scope personal|contact|room [--ref …] --disclosure … --owner <SID/UID> [--content-file …] [--retention-days N] [--yes]
//
// 安全边界：
// - 来源必须已存在于 Core sources；本 CLI 不抓网页、不采集。
// - Owner 取操作系统身份（Windows SID / POSIX UID），与 --owner 不一致拒绝。
// - 未给 --yes 只预览；删除只追加逻辑删除事件，不修改 append-only 的 sources 原文。
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  beginErase,
  completeErase,
  eraseProofDigest,
  eraseSourceContent,
  eraseStatusOf,
  failErase,
  listExternalSources,
  openDatabase,
  purgeExpiredExternalSources,
  recordExternalSource,
  requestErase,
  requestExternalSourceDeletion,
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
  console.error(`[psyche-source] ${message}`)
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

function checkpoint(db) {
  let last = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    last = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    if (!last || Number(last.busy) === 0) return last
  }
  return last
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const dataDir = argOf(argv, 'data-dir')
  if (!dataDir) {
    fail('需要 --data-dir <DSH_DATA_DIR>')
    return
  }
  const commands = ['list', 'record', 'delete', 'purge', 'erase']
  if (!commands.includes(command)) {
    fail(`命令必须是 ${commands.join(' / ')}`)
    return
  }

  const opened = await openDatabase({ file: join(dataDir, 'memory.sqlite3') })
  const db = opened.db
  try {
    if (command === 'list') {
      const rows = listExternalSources(db, {
        kind: argOf(argv, 'kind') ?? undefined,
        includeDeleted: hasFlag(argv, 'include-deleted'),
      })
      if (rows.length === 0) {
        console.log('没有外界来源登记。')
        return
      }
      for (const row of rows) {
        console.log(`${row.source_id}  ${row.kind}  scope=${row.scope}${row.scope_ref ? `:${row.scope_ref}` : ''}  disclosure=${row.disclosure}  created=${new Date(row.created_at).toISOString()}`)
        console.log(`  provenance: ${row.provenance}`)
        console.log(`  sha256: ${row.content_sha256}  risk: ${row.risk_flags}  deletion: ${row.deletion_action ?? '—'}`)
      }
      return
    }

    const by = requireOwner(argv)
    if (!by) return
    const yes = hasFlag(argv, 'yes')

    if (command === 'record') {
      const sourceId = argOf(argv, 'source')
      const kind = argOf(argv, 'kind')
      const provenance = argOf(argv, 'provenance')
      const scope = argOf(argv, 'scope')
      const disclosure = argOf(argv, 'disclosure')
      if (!sourceId || !kind || !provenance || !scope || !disclosure) {
        fail('需要 --source --kind --provenance --scope --disclosure')
        return
      }
      const file = argOf(argv, 'content-file')
      const content = file ? readFileSync(file, 'utf8') : (argOf(argv, 'content') ?? '')
      const retentionDays = argOf(argv, 'retention-days')
      const input = {
        sourceId,
        kind,
        provenance,
        content,
        scope,
        scopeRef: argOf(argv, 'ref') ?? null,
        disclosure,
        createdBy: by,
        retentionDays: retentionDays === null ? undefined : Number(retentionDays),
      }
      if (!yes) {
        console.log(`预览：record source=${sourceId} kind=${kind} scope=${scope}（缺 --yes，不写库）`)
        return
      }
      const result = recordExternalSource(db, input)
      console.log(`record ${result.created ? 'created' : 'idempotent'}：${JSON.stringify(result.row)}`)
      return
    }

    if (command === 'purge') {
      const preview = db
        .prepare(
          `SELECT COUNT(*) AS n FROM external_sources e
           WHERE e.retention_until IS NOT NULL AND e.retention_until <= ?
             AND NOT EXISTS (SELECT 1 FROM external_source_deletion_events d WHERE d.source_id = e.source_id)`,
        )
        .get(Date.now())
      if (!yes) {
        console.log(`预览：purge ${preview.n} 条过期登记（缺 --yes，不写库）`)
        return
      }
      const result = purgeExpiredExternalSources(db, { by })
      console.log(`purge 完成：${JSON.stringify(result)}`)
      return
    }

    if (command === 'erase') {
      const sourceId = argOf(argv, 'source')
      if (!sourceId || argOf(argv, 'confirm') !== sourceId) {
        fail('需要 --source <src_…> --confirm <同一个 src_…>（二次确认）')
        return
      }
      let step = 'precheck'
      try {
        const initial = eraseStatusOf(db, sourceId)
        if (initial === 'erased') {
          console.log('已擦除，幂等返回。')
          return
        }
        if (initial === 'not_logically_deleted') {
          fail('必须先逻辑删除（delete），再做物理擦除。')
          return
        }
        if (initial === 'logical_deleted' || initial === 'erase_failed') {
          requestErase(db, { sourceId, by })
        }
        if (eraseStatusOf(db, sourceId) === 'erase_pending') beginErase(db, { sourceId, by })
        step = 'secure_delete'
        db.exec('PRAGMA main.secure_delete=ON')
        const pragma = db.prepare('PRAGMA main.secure_delete').get()
        if (Number(pragma.secure_delete) !== 1) throw new Error('E_SECURE_DELETE_UNAVAILABLE')
        step = 'erase'
        const proof = eraseSourceContent(db, { sourceId, by })
        step = 'checkpoint1'
        const cp1 = checkpoint(db)
        step = 'vacuum'
        db.exec('VACUUM')
        step = 'checkpoint2'
        const cp2 = checkpoint(db)
        step = 'verify'
        if (Number(cp1.busy) !== 0 || Number(cp2.busy) !== 0) throw new Error('E_WAL_BUSY')
        const digest = eraseProofDigest(proof)
        const event = completeErase(db, { sourceId, by, proofDigest: digest })
        if (hasFlag(argv, 'export-proof')) {
          const dir = join(dataDir, 'exports')
          mkdirSync(dir, { recursive: true })
          const file = join(dir, `erase-proof-${event.eraseEventId}.json`)
          const tmp = `${file}.tmp`
          writeFileSync(tmp, `${JSON.stringify({
            sourceId,
            eraseEventId: event.eraseEventId,
            at: event.at,
            proof,
            proofDigest: digest,
            wal: { beforeVacuum: cp1, afterVacuum: cp2 },
            backupNote: '主库已擦除；备份可能仍含原文',
          }, null, 2)}\n`, 'utf8')
          renameSync(tmp, file)
          console.log(`proof exported: ${file}`)
        }
        console.log(`erase 完成：event=${event.eraseEventId} digest=${digest}`)
      } catch (error) {
        try {
          failErase(db, { sourceId, by, stage: step, errorCode: error instanceof Error ? error.message : String(error) })
        } catch { /* 事件写入失败时保留原错误 */ }
        throw error
      }
      return
    }

    const sourceId = argOf(argv, 'source')
    if (!sourceId) {
      fail('需要 --source <src_…>')
      return
    }
    if (!yes) {
      console.log(`预览：delete source=${sourceId}（缺 --yes，不写库）`)
      return
    }
    const result = requestExternalSourceDeletion(db, { sourceId, by, reason: argOf(argv, 'reason') ?? undefined })
    console.log(`delete 完成：${JSON.stringify(result)}`)
  } finally {
    db.close?.()
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
