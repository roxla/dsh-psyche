#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 心灵迁移包命令行：在 **DSH 关闭** 的情况下做备份/校验/恢复。
//
// 为什么要有命令行：恢复需要把整个数据目录换名，而插件运行时 SQLite 连接开着，
// Windows 上打开着的文件改不了名。面板里只能「导出」，冷恢复交给这个脚本最稳。
//
// 用法（在插件仓库根目录）：
//   node tools/psyche-archive.mjs list    --data "C:\Users\你\.dsh\psyche"
//   node tools/psyche-archive.mjs backup  --data "C:\Users\你\.dsh\psyche"
//   node tools/psyche-archive.mjs verify  exports/psyche-backup-20261102-120000.tar.gz
//   node tools/psyche-archive.mjs extract <包> --out D:\tmp\restore
//   node tools/psyche-archive.mjs restore <包> --data "C:\Users\你\.dsh\psyche" --yes
//
// 前置：先 `npm run build`（脚本用 dist/ 里的编译产物，不重复实现一套打包逻辑）。
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

// 注意：Windows 上 `new URL(...).pathname` 会给出 '/D:/...'，直接 resolve 会变成 'D:\D:\...'，
// 所以必须走 fileURLToPath（它同时把 %20 这类转义还原）。
const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')
const DIST = join(ROOT, 'dist', 'lib')

function fail(message) {
  console.error(`错误：${message}`)
  process.exitCode = 1
}

function usage() {
  console.log(`心灵迁移包工具

命令：
  list    --data <数据目录>                 列出 exports/ 里的迁移包并逐个校验
  backup  --data <数据目录>                 打一个迁移包（DSH 关闭时跑）
  verify  <包>                              只读校验结构与逐文件 sha256
  extract <包> --out <空目录>               解包到指定目录（不碰数据目录）

恢复（两阶段，与插件、面板共用同一套状态机）：
  status   --data <数据目录>                看有没有待恢复任务、当前数据是空还是非空
  prepare  <包> --data <数据目录>           准备：解包 + 校验 + 写状态文件（不碰数据目录）
  confirm  --data <数据目录> [--word <包ID>] 确认：非空必须打对包 ID；导出预恢复包后等应用
  apply    --data <数据目录>                应用：换目录 + 安装后校验（务必 DSH 已关闭）
  cancel   --data <数据目录>                取消还没应用的恢复
  restore  <包> --data <数据目录> --yes     一步做完 prepare + confirm + apply

说明：恢复只改名不删数据，旧目录保留为 <目录>.old-<时间>。`)
}

/** 解析 `--key value` 形式的参数。 */
function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item.startsWith('--')) {
      const key = item.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) flags[key] = true
      else {
        flags[key] = next
        index += 1
      }
    } else {
      positional.push(item)
    }
  }
  return { positional, flags }
}

async function loadLib() {
  // Windows 上跨盘/绝对路径 import 必须转成 file:// URL，否则 Node 把 "D:" 当成协议名报错。
  const load = (name) => import(pathToFileURL(join(DIST, name)).href)
  const archive = await load('archive.js')
  const schema = await load('schema.js')
  return { ...archive, SCHEMA_VERSION: schema.SCHEMA_VERSION }
}

/** `backup` 需要真库连接：VACUUM INTO 只能从活连接发起。 */
function openDb(dataDir, dbName = 'memory.sqlite3') {
  const file = join(dataDir, dbName)
  if (!existsSync(file)) throw new Error(`找不到数据库：${file}`)
  return new DatabaseSync(file)
}

/** 恢复状态机（P0-1.6：CLI 与插件、面板共用同一份实现，不各写一套 rename/回滚）。 */
async function loadRestoreLib() {
  return import(pathToFileURL(join(DIST, 'restore.js')).href)
}

/**
 * 打开目标库并包成 restore.ts 需要的 `RestoreDb` 形状。
 * 只在 confirm 阶段用（要 VACUUM INTO 导预恢复包）；prepare 故意不开库。
 */
function openRestoreDb(dataDir, dbName = 'memory.sqlite3') {
  const db = openDb(dataDir, dbName)
  const api = {
    all: (sql, params) => (params === undefined ? db.prepare(sql).all() : db.prepare(sql).all(...params)),
    exec: (sql) => db.exec(sql),
    // adapter 的 pragma() 返回第一列标量，这里保持一致，restore.ts 会优先用它读 user_version
    pragma: (name) => {
      const row = db.prepare(`PRAGMA ${name}`).get()
      return row ? Object.values(row)[0] : null
    },
  }
  return { db, api }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const command = positional[0]
  if (!command || flags.help) {
    usage()
    return
  }
  if (!existsSync(DIST)) {
    fail(`找不到 ${DIST}，先跑 npm run build`)
    return
  }
  const lib = await loadLib()

  if (command === 'list') {
    const dataDir = flags.data
    if (typeof dataDir !== 'string') return fail('list 需要 --data <数据目录>')
    const rows = lib.listArchiveRows(resolve(dataDir))
    if (rows.length === 0) return console.log('还没有迁移包。')
    for (const row of rows) {
      console.log(
        `${row.verified ? '✔' : '✘'} ${row.name}  ${(row.bytes / 1024).toFixed(0)} KB  ${row.at}  ` +
          `${row.files ?? '?'} 个文件  schema v${row.schemaVersion ?? '?'}`,
      )
    }
    return
  }

  if (command === 'backup') {
    const dataDir = flags.data
    if (typeof dataDir !== 'string') return fail('backup 需要 --data <数据目录>')
    const dir = resolve(dataDir)
    const db = openDb(dir)
    try {
      const counts = {}
      for (const table of ['sources', 'events', 'artifacts', 'artifact_revisions']) {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
        counts[table] = Number(row ? Object.values(row)[0] : 0)
      }
      const result = lib.createArchive({
        db: { exec: (sql) => db.exec(sql) },
        dataDir: dir,
        counts,
        version: 'cli',
        schemaVersion: Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0),
        algorithmVersion: 'grow-1',
      })
      console.log(`已导出：${result.file}`)
      console.log(`  ${(result.bytes / 1024).toFixed(0)} KB · ${result.manifest.files.length} 个文件 · 用时 ${result.durationMs} ms`)
    } finally {
      db.close()
    }
    return
  }

  if (command === 'verify') {
    const file = positional[1]
    if (!file) return fail('verify 需要 <包路径>')
    const result = lib.verifyArchive(resolve(file))
    console.log(`格式：${result.manifest ? result.manifest.format + ' v' + result.manifest.formatVersion : '(读不出)'}`)
    console.log(`大小：${(result.bytes / 1024).toFixed(0)} KB`)
    console.log(`文件：${result.manifest ? result.manifest.files.length : 0} 个`)
    if (result.manifest) {
      console.log(`创建：${result.manifest.createdAt} · 人格 ${result.manifest.personaId} · schema v${result.manifest.schemaVersion}`)
      console.log(`计数：${JSON.stringify(result.manifest.counts)}`)
    }
    if (result.ok) console.log('校验：通过')
    else {
      console.log('校验：不通过')
      for (const problem of result.problems) console.log(`  - ${problem.path || '(包)'}：${problem.reason}`)
      process.exitCode = 1
    }
    return
  }

  if (command === 'extract') {
    const file = positional[1]
    const out = flags.out
    if (!file || typeof out !== 'string') return fail('extract 需要 <包路径> --out <空目录>')
    const target = resolve(out)
    mkdirSync(target, { recursive: true })
    const result = lib.extractArchive(resolve(file), target)
    console.log(`已解出 ${result.files} 个文件到 ${result.dir}`)
    return
  }

  // ── 恢复：全部走 dist/lib/restore.js 里的同一套状态机（面板的 HTTP 路由调的是同一批函数）──
  const restoreLib = await loadRestoreLib()

  if (command === 'status') {
    const dataDir = flags.data
    if (typeof dataDir !== 'string') return fail('status 需要 --data <数据目录>')
    const dir = resolve(dataDir)
    const status = restoreLib.restoreStatus({ dataDir: dir })
    const target = status.target
    console.log(`目标：${dir}`)
    console.log(`状态：${status.note}`)
    if (status.journal) {
      console.log(`任务：${status.journal.restoreId} · 包 ${status.journal.packageId} · 阶段 ${status.journal.phase}`)
      console.log(`暂存：${status.journal.stagingPath}`)
      console.log(`旧目录：${status.journal.oldPath}`)
      if (status.journal.preRestoreArchive) console.log(`预恢复包：${status.journal.preRestoreArchive}`)
    }
    if (target) {
      console.log(`当前数据：${target.state === 'empty' ? '空人格' : target.state === 'used' ? '已有内容' : '不可判定'}（${target.reasons.join('；') || '无'})`)
    }
    return
  }

  if (command === 'prepare') {
    const file = positional[1]
    const dataDir = flags.data
    if (!file || typeof dataDir !== 'string') return fail('prepare 需要 <包路径> --data <数据目录>')
    const dir = resolve(dataDir)
    // 准备阶段故意不给库连接：让 inspectTargetMemory 用只读连接逐表数，避免动到目标库
    const view = restoreLib.prepareRestorePackage({
      dataDir: dir,
      file: resolve(file),
      schemaVersion: lib.SCHEMA_VERSION,
      personaId: 'main',
    })
    console.log(`已准备：${view.restoreId} · 包 ${view.packageId}`)
    console.log(`当前数据：${view.targetState === 'empty' ? '空人格（不用确认词）' : '已有内容（覆盖不可撤销，需确认）'}`)
    console.log(`暂存目录：${view.stagedDir}`)
    for (const note of view.notes) console.log(`  · ${note}`)
    if (view.requiredConfirmation) {
      console.log(`下一步：node tools/psyche-archive.mjs confirm --data "${dir}" --word ${view.packageId}`)
    } else {
      console.log(`下一步：node tools/psyche-archive.mjs confirm --data "${dir}"`)
    }
    return
  }

  if (command === 'confirm') {
    const dataDir = flags.data
    if (typeof dataDir !== 'string') return fail('confirm 需要 --data <数据目录>')
    const dir = resolve(dataDir)
    // 空人格（没有库文件）不导预恢复包，所以可以没有连接；非空时必须有
    const opened = existsSync(join(dir, 'memory.sqlite3')) ? openRestoreDb(dir) : null
    try {
      const result = restoreLib.confirmRestore({
        dataDir: dir,
        restoreId: typeof flags.id === 'string' ? flags.id : undefined,
        confirmation: typeof flags.word === 'string' ? flags.word : undefined,
        db: opened?.api,
        version: 'cli',
        schemaVersion: opened ? Number(opened.api.pragma('user_version') ?? lib.SCHEMA_VERSION) : 0,
        algorithmVersion: 'grow-1',
      })
      console.log(`已确认：${result.restoreId} → 阶段 ${result.phase}`)
      if (result.preRestoreArchive) {
        console.log(`预恢复包：${result.preRestoreArchive}（${(result.preRestoreBytes / 1024).toFixed(0)} KB）`)
      }
      console.log(`下一步：${result.note}`)
      console.log(`        然后跑 node tools/psyche-archive.mjs apply --data "${dir}"`)
    } finally {
      opened?.db.close()
    }
    return
  }

  if (command === 'apply') {
    const dataDir = flags.data
    if (typeof dataDir !== 'string') return fail('apply 需要 --data <数据目录>')
    const dir = resolve(dataDir)
    const outcome = restoreLib.applyPendingRestore({ dataDir: dir })
    console.log(`${outcome.applied ? '已完成' : '没有应用'}：${outcome.note}`)
    if (!outcome.applied && outcome.reason !== 'no-pending' && outcome.reason !== 'completed') {
      process.exitCode = 1
    }
    return
  }

  if (command === 'cancel') {
    const dataDir = flags.data
    if (typeof dataDir !== 'string') return fail('cancel 需要 --data <数据目录>')
    const result = restoreLib.cancelRestore({ dataDir: resolve(dataDir) })
    console.log(result.note)
    if (!result.ok) process.exitCode = 1
    return
  }

  if (command === 'restore') {
    const file = positional[1]
    const dataDir = flags.data
    if (!file || typeof dataDir !== 'string') return fail('restore 需要 <包路径> --data <数据目录>')
    if (flags.yes !== true) return fail('restore 会替换数据目录，确认无误请加 --yes')
    const dir = resolve(dataDir)
    const view = restoreLib.prepareRestorePackage({
      dataDir: dir,
      file: resolve(file),
      schemaVersion: lib.SCHEMA_VERSION,
      personaId: 'main',
    })
    console.log(`已准备：包 ${view.packageId} · 当前数据 ${view.targetState}`)
    const opened = existsSync(join(dir, 'memory.sqlite3')) ? openRestoreDb(dir) : null
    try {
      const confirmed = restoreLib.confirmRestore({
        dataDir: dir,
        restoreId: view.restoreId,
        // 一步式命令里 --yes 就代表接受覆盖：用包 ID 作为确认词
        confirmation: view.packageId,
        db: opened?.api,
        version: 'cli',
        schemaVersion: opened ? Number(opened.api.pragma('user_version') ?? lib.SCHEMA_VERSION) : 0,
        algorithmVersion: 'grow-1',
      })
      console.log(
        confirmed.preRestoreArchive
          ? `已确认：预恢复包 ${confirmed.preRestoreArchive}`
          : '已确认：空人格，不需要预恢复包',
      )
    } finally {
      opened?.db.close()
    }
    const outcome = restoreLib.applyPendingRestore({ dataDir: dir })
    console.log(outcome.note)
    if (!outcome.applied) process.exitCode = 1
    return
  }

  usage()
  fail(`不认识的命令：${command}`)
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)))
