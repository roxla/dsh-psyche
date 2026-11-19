#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 心灵人格命令行（I-8）：Owner 本机操作，六个命令全部走 Core 的同一套规则。
//
// 为什么要有命令行：首启面板适合一次点选；「收尾半成品、接受原文漂移、带归档地重置」
// 这些低频但高风险的动作留在终端更稳——能看到完整的哈希、包路径和确认词。
//
// 用法（仓库根目录，先 `npm run build`）：
//   node tools/psyche-persona.mjs status --data "C:\Users\你\.dsh\psyche"
//   node tools/psyche-persona.mjs init   --data <目录> --preset gentle-firm
//   node tools/psyche-persona.mjs finish --data <目录>
//   node tools/psyche-persona.mjs abort  --data <目录>
//   node tools/psyche-persona.mjs edit   --data <目录> [--accept --yes]
//   node tools/psyche-persona.mjs reset  --data <目录>
//   node tools/psyche-persona.mjs reset  --data <目录> --archive <包> --word <包ID> --yes
//
// 安全边界：
//   - 所有命令都必须显式 --data，不默默操作另一份默认数据根。
//   - finish / abort 沿用 I-4 的 claim 所有权：活着的初始化进程不能被抢。
//   - reset 先归档并校验，再要求输入完整包 ID；记忆库一条不删。
//   - 输出不打印 identity.md 原文，也不打印 claim token。
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')
const CORE_DIST = join(ROOT, 'packages', 'core', 'dist')
const REQUIRED_TABLES = ['sources', 'events', 'artifacts', 'artifact_revisions']

function fail(message) {
  console.error(`错误：${message}`)
  process.exitCode = 1
}

function usage() {
  console.log(`心灵人格命令行（Owner 本机）

命令：
  status  --data <数据目录>                         查看初始化状态（只读，不输出人格原文）
  init    --data <数据目录> --preset <预设 id>       用指定预设初始化人格（必须显式指定）
  finish  --data <数据目录>                         收尾一次没走完的初始化
  abort   --data <数据目录>                         取消一次没走完的初始化
  edit    --data <数据目录>                         显示 identity.md 的路径与哈希
  edit    --data <数据目录> --accept --yes          接受人工修改后的新哈希
  reset   --data <数据目录>                         第一步：归档并校验，打印包路径与包 ID
  reset   --data <数据目录> --archive <包> --word <包ID> --yes
                                                    第二步：确认后重置人格（记忆库保留）

说明：所有命令都必须给 --data；不提供任何跳过归档、直接清库的隐藏参数。`)
}

/** 解析 `--key value` 形式的参数（与 psyche-archive.mjs 保持同一种写法）。 */
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

async function load(name) {
  // 跨盘/绝对路径 import 必须转 file:// URL（Windows 上 `D:` 会被当成协议名）。
  return import(pathToFileURL(join(CORE_DIST, name)).href)
}

function dataDirOf(flags) {
  if (typeof flags.data !== 'string' || !flags.data) {
    fail('这个命令需要 --data <数据目录>')
    return null
  }
  const dir = resolve(flags.data)
  if (!existsSync(dir)) {
    fail(`数据目录不存在：${dir}`)
    return null
  }
  return dir
}

/** 打开真实库并包成 init/reset 要的 `InitDb` 形状；没有库文件返回 null。 */
function openInitDb(dataDir) {
  const file = join(dataDir, 'memory.sqlite3')
  if (!existsSync(file)) return null
  const db = new DatabaseSync(file)
  const api = {
    run: (sql, params) => db.prepare(sql).run(...(params ?? [])),
    get: (sql, params) => db.prepare(sql).get(...(params ?? [])),
    transaction: (fn) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  return { db, api }
}

function schemaVersionOf(db) {
  const row = db.prepare('PRAGMA user_version').get()
  return Number(row ? Object.values(row)[0] : 0)
}

function countsOf(db) {
  const counts = {}
  for (const table of REQUIRED_TABLES) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
      counts[table] = Number(row ? Object.values(row)[0] : 0)
    } catch {
      counts[table] = 0
    }
  }
  return counts
}

function printPresets(presets) {
  if (!presets.length) {
    console.log('预设：一套都没读到（检查 packages/core/presets/）')
    return
  }
  console.log('预设：')
  for (const preset of presets) {
    const tags = [preset.recommended ? '推荐' : null, preset.draft ? '草稿' : null].filter(Boolean)
    console.log(`  - ${preset.presetId}  ${preset.presetName} ${preset.presetVersion}${tags.length ? `（${tags.join(' / ')}）` : ''}`)
  }
}

function describeError(error) {
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : null
  const message = error instanceof Error ? error.message : String(error)
  return code ? `${code}：${message}` : message
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const command = positional[0]
  if (!command || flags.help) {
    usage()
    return
  }
  if (!existsSync(CORE_DIST)) {
    fail(`找不到 ${CORE_DIST}，先跑 npm run build`)
    return
  }

  const serviceLib = await load('persona-init-service.js')
  const resetLib = await load('persona-reset.js')
  const presetsLib = await load('presets.js')
  const archiveLib = await load('archive.js')
  const { createPersonaInitService } = serviceLib
  const { resetPersona } = resetLib
  const { loadPresets } = presetsLib
  const { createArchive, verifyArchive } = archiveLib

  const dataDir = dataDirOf(flags)
  if (!dataDir) return
  const opened = openInitDb(dataDir)
  const db = opened?.api ?? null

  try {
    // ── status ──────────────────────────────────────────────────────────────
    if (command === 'status') {
      const service = createPersonaInitService({ dataDir, db })
      const { snapshot } = service.status()
      console.log(`数据根：${dataDir}`)
      console.log(`状态：${snapshot.state}（${snapshot.detail}）`)
      if (snapshot.presetId) {
        console.log(`预设：${snapshot.presetName} ${snapshot.presetVersion}${snapshot.draft ? '（草稿）' : ''}`)
      }
      if (snapshot.identityHash) {
        console.log(`原文：${snapshot.identityBytes} 字节 · sha256 ${snapshot.identityHash.slice(0, 16)}…`)
      }
      if (snapshot.claim) {
        console.log(
          `初始化：pid ${snapshot.claim.pid} · 开始于 ${snapshot.claim.startedAt} · ` +
            `${snapshot.claim.ownerAlive ? '持有者仍在运行' : '持有者已退出'}`,
        )
      }
      console.log(`可做：${snapshot.actions.length ? snapshot.actions.join(' / ') : '无'}`)
      const loaded = loadPresets()
      printPresets(loaded.presets)
      if (!loaded.ok) {
        for (const problem of loaded.problems) console.log(`  ! 预设问题：${problem.presetId || '(目录)'} ${problem.kind}：${problem.detail}`)
      }
      return
    }

    // ── init ────────────────────────────────────────────────────────────────
    if (command === 'init') {
      if (typeof flags.preset !== 'string' || !flags.preset) {
        return fail('init 需要 --preset <预设 id>：不替调用方偷偷套默认人格')
      }
      const service = createPersonaInitService({ dataDir, db })
      const result = service.start(flags.preset)
      console.log(`已初始化：${result.preset.presetName} ${result.preset.presetVersion}`)
      console.log(`原文：${result.identityBytes} 字节 · sha256 ${result.identityHash.slice(0, 16)}…`)
      console.log(`库快照：${result.dbSynced ? '已同步' : '未同步（之后 finish 会补）'}`)
      console.log('人格已锁定。')
      return
    }

    // ── finish ──────────────────────────────────────────────────────────────
    if (command === 'finish') {
      const service = createPersonaInitService({ dataDir, db })
      const result = service.finish()
      console.log(result.alreadyLocked ? '人格已经锁定，无需收尾。' : '收尾完成。')
      console.log(`库快照：${result.dbSync === 'synced' ? '已同步' : result.dbSync === 'skipped' ? '跳过（没有数据库）' : '同步失败（现场保留，可稍后重试）'}`)
      return
    }

    // ── abort ───────────────────────────────────────────────────────────────
    if (command === 'abort') {
      const service = createPersonaInitService({ dataDir, db })
      const result = service.abort()
      if (result.aborted) console.log(`已取消初始化，清理：${result.removed.length ? result.removed.join(' / ') : '（没有文件）'}`)
      else console.log(`没有可取消的初始化（${result.snapshot.detail}）`)
      return
    }

    // ── edit ────────────────────────────────────────────────────────────────
    if (command === 'edit') {
      const service = createPersonaInitService({ dataDir, db })
      const { snapshot } = service.status()
      if (flags.accept !== true) {
        console.log(`人格原文：${join(dataDir, 'identity.md')}`)
        if (snapshot.identityHash) console.log(`当前哈希：sha256 ${snapshot.identityHash.slice(0, 16)}… · ${snapshot.identityBytes} 字节`)
        console.log(`状态：${snapshot.state}（${snapshot.detail}）`)
        console.log('用任意编辑器改完后，运行：edit --data <目录> --accept --yes')
        return
      }
      if (flags.yes !== true) return fail('edit --accept 会接受新的原文哈希，确认无误请加 --yes')
      const result = service.acceptDrift()
      console.log(`已接受新哈希：sha256 ${result.identityHash.slice(0, 16)}…`)
      console.log('原文没有改动（只更新了记录）。')
      return
    }

    // ── reset ───────────────────────────────────────────────────────────────
    if (command === 'reset') {
      const service = createPersonaInitService({ dataDir, db })
      const { snapshot } = service.status()

      // 第一步：没有 --archive 时只做「归档 + 校验 + 打印包 ID」。
      if (typeof flags.archive !== 'string') {
        if (snapshot.state === 'uninitialized') return fail('人格还没有初始化，没有可重置的内容')
        if (!opened) return fail('找不到 memory.sqlite3，无法归档')
        const result = createArchive({
          db: { exec: (sql) => opened.db.exec(sql) },
          dataDir,
          counts: countsOf(opened.db),
          version: 'cli',
          schemaVersion: schemaVersionOf(opened.db),
          algorithmVersion: 'grow-1',
        })
        const verified = verifyArchive(result.file)
        if (!verified.ok) {
          for (const problem of verified.problems) console.error(`  - ${problem.path || '(包)'}：${problem.reason}`)
          return fail('归档校验失败，重置已中止')
        }
        const id = basename(result.file)
        console.log(`已归档并校验：${result.file}`)
        console.log(`包 ID：${id}`)
        console.log(`下一步：node tools/psyche-persona.mjs reset --data "${dataDir}" --archive "${result.file}" --word ${id} --yes`)
        return
      }

      // 第二步：包 ID 确认后真重置。
      if (flags.yes !== true) return fail('reset 会清空人格文件（记忆库保留），确认无误请加 --yes')
      const file = resolve(flags.archive)
      if (!existsSync(file)) return fail(`找不到归档：${file}`)
      const verified = verifyArchive(file)
      if (!verified.ok) {
        for (const problem of verified.problems) console.error(`  - ${problem.path || '(包)'}：${problem.reason}`)
        return fail('归档校验失败，重置已中止')
      }
      const id = basename(file)
      if (flags.word !== id) return fail(`确认词不对：请输入完整包 ID「${id}」`)
      const result = resetPersona({ dataDir, db, reason: 'cli-reset' })
      if (!result.reset) return fail(`没有重置：${result.snapshot.detail}`)
      console.log(`已重置，清理：${result.removed.length ? result.removed.join(' / ') : '（没有文件）'}`)
      console.log(`当前状态：${result.snapshot.state}（${result.snapshot.detail}）`)
      console.log('记忆库没有动；人格历史里已留一条重置记录。')
      return
    }

    usage()
    fail(`不认识的命令：${command}`)
  } catch (error) {
    fail(describeError(error))
  } finally {
    opened?.db.close()
  }
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)))
