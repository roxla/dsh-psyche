// ─────────────────────────────────────────────────────────────────────────────
// 恢复状态机（restore）的自检：三态判定 + P0-1 冻结验收（§34.14）。
//
// 跑法：node test/restore.ts（Node 24 直接执行 TS，不需要额外构建）
// 全部用临时目录；每个用例自己造「源人格 → 迁移包 → 目标数据根」，不碰真实数据根。
// 关键：替换目录前必须把库关掉——Windows 上打开着的库文件改不了名，这也正是
// 真实插件把 Apply 放到「下次启动、openDatabase 之前」的原因。
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { openDatabase } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { SCHEMA_VERSION } from '../dist/lib/schema.js'
import { createArchive, verifyArchive } from '../dist/lib/archive.js'
import {
  applyPendingRestore,
  confirmRestore,
  inspectTargetMemory,
  prepareRestorePackage,
  readRestoreJournal,
  restoreJournalPath,
  restoreStatus,
  writeRestoreJournal,
} from '../dist/lib/restore.js'
import type { RestoreDb } from '../dist/lib/restore.js'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
}

/** 期待某个同步调用抛错，返回错误（用来断言 code / message）。 */
function grab(action: () => unknown): Error | null {
  try {
    action()
    return null
  } catch (error) {
    return error as Error
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'psyche-restore-'))

/** 造一个真库（走生产同一条 openDatabase，migrate 自动建表）。 */
async function makeDataDir(name: string): Promise<{ dir: string; db: any }> {
  // 每个用例独占一个父目录：恢复状态文件与暂存目录都放在数据根的**同级**，
  // 共用父目录会让两个用例抢同一份状态文件（真实部署里一个父目录只有一个数据根）。
  const dir = join(sandbox, name, 'data')
  mkdirSync(dir, { recursive: true })
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto' })
  return { dir, db: opened.db }
}

/** 造一个有内容的人格（一条事件 + 人格原文），再打成迁移包。 */
async function makePackage(name: string): Promise<string> {
  const { dir, db } = await makeDataDir(name)
  const core = new Core({ db, config: {}, dataDir: dir })
  await core.capture({
    text: '主人喜欢深海和鲸鱼',
    channel: 'desktop',
    sessionRef: 'sess-restore-src',
    origin: 'user',
  })
  writeFileSync(join(dir, 'identity.md'), '# 心灵\n\n她是深海里的鲸。\n', 'utf8')
  const archive = createArchive({
    db,
    dataDir: dir,
    // 计数必须与库里真数一致：这轮起恢复前置检查会和库对账
    counts: { events: 0, sources: 1 },
    version: 'test',
    schemaVersion: SCHEMA_VERSION,
    algorithmVersion: 'grow-1',
  })
  db.close()
  return archive.file
}

/** 准备 + 确认（Used 时把包 ID 传进来）。 */
function prepareAndConfirm(
  dataDir: string,
  pkg: string,
  db: any,
  confirmation?: string,
): { phase: string; preRestore: string } {
  const view = prepareRestorePackage({ dataDir, file: pkg, schemaVersion: SCHEMA_VERSION, db })
  const result = confirmRestore({
    dataDir,
    restoreId: view.restoreId,
    confirmation,
    db,
    version: 'test',
    schemaVersion: SCHEMA_VERSION,
    algorithmVersion: 'grow-1',
  })
  return { phase: result.phase, preRestore: result.preRestoreArchive }
}

/** 只读数一个库里的 sources 行数（capture 落的是 Source；恢复后用它对账）。 */
function countSources(dir: string): number {
  const file = join(dir, 'memory.sqlite3')
  if (!existsSync(file)) return -1
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM sources').get() as Record<string, unknown> | undefined
    return Number(row ? Object.values(row)[0] : -1)
  } catch {
    return -2
  } finally {
    db.close()
  }
}

async function main(): Promise<void> {
  const pkg = await makePackage('source')

  // ── 1. 三态判定 ─────────────────────────────────────────────────────────
  {
    const empty = await makeDataDir('state-empty')
    const emptyView = inspectTargetMemory({ dataDir: empty.dir, db: empty.db })
    check('空库判成 empty', emptyView.state === 'empty', emptyView.state)
    check('空库没有用户表行', emptyView.totalRows === 0, emptyView.totalRows)
    check('空库 dbPresent=true', emptyView.dbPresent)
    empty.db.close()

    const used = await makeDataDir('state-used')
    await new Core({ db: used.db, config: {}, dataDir: used.dir }).capture({
      text: '一句会写进库的话',
      channel: 'desktop',
      sessionRef: 'sess-state-used',
      origin: 'user',
    })
    const usedView = inspectTargetMemory({ dataDir: used.dir, db: used.db })
    check('有事件判成 used', usedView.state === 'used', usedView.state)
    check('used 给出总行数', usedView.totalRows > 0, usedView.totalRows)
    check('used 的 reasons 非空', usedView.reasons.length > 0)
    used.db.close()

    // 库坏掉 → unknown（不猜，直接拒绝导入）
    const broken = join(sandbox, 'state-unknown')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'memory.sqlite3'), 'not a database', 'utf8')
    const brokenView = inspectTargetMemory({ dataDir: broken })
    check('坏库判成 unknown', brokenView.state === 'unknown', brokenView.reasons)
  }

  // ── 2. 验收 1：Empty 直接导入，不要确认词；准备阶段不碰数据根 ────────────
  {
    const target = await makeDataDir('adopt')
    const view = prepareRestorePackage({ dataDir: target.dir, file: pkg, schemaVersion: SCHEMA_VERSION, db: target.db })
    check('空库准备：mode=adopt', view.mode === 'adopt', view.mode)
    check('空库准备：不用确认词', view.requiredConfirmation === null)
    check('空库准备：目标状态 empty', view.targetState === 'empty')
    check('准备阶段已解到暂存目录', existsSync(view.stagedDir))
    check('准备阶段不动数据根（事件仍是 0）', countSources(target.dir) === 0, countSources(target.dir))
    check('状态文件在数据根之外', !restoreJournalPath(target.dir).startsWith(target.dir))
    check('状态文件 phase=prepared', readRestoreJournal(target.dir)?.phase === 'prepared')

    const confirmed = confirmRestore({
      dataDir: target.dir,
      restoreId: view.restoreId,
      db: target.db,
      version: 'test',
      schemaVersion: SCHEMA_VERSION,
      algorithmVersion: 'grow-1',
    })
    check('空库确认后 phase=pending', confirmed.phase === 'pending', confirmed.phase)
    // 空人格（adopt）没有需要保护的内容，按设计不导预恢复包；非空覆盖才导（第 3 段验证）
    check('空库不导预恢复包（省一步风险）', confirmed.preRestoreArchive === '' && confirmed.preRestoreBytes === 0)

    target.db.close()
    const applied = applyPendingRestore({ dataDir: target.dir })
    check('应用成功且完成', applied.applied && applied.phase === 'completed', applied.reason)
    check('恢复后事件数为 1', countSources(target.dir) === 1, countSources(target.dir))
    check('恢复后人格原文换成包里的', readFileSync(join(target.dir, 'identity.md'), 'utf8').includes('深海里的鲸'))
    check('旧目录被保留', applied.keptDir !== null && existsSync(applied.keptDir))
  }

  // ── 3. 验收 2/3：Used 必须打对包 ID，覆盖后旧数据还在 .old ────────────────
  {
    const target = await makeDataDir('overwrite')
    await new Core({ db: target.db, config: {}, dataDir: target.dir }).capture({
      text: '这条是目标机上已有的记忆',
      channel: 'desktop',
      sessionRef: 'sess-overwrite',
      origin: 'user',
    })
    const view = prepareRestorePackage({
      dataDir: target.dir,
      file: pkg,
      schemaVersion: SCHEMA_VERSION,
      db: target.db,
    })
    check('非空准备：mode=overwrite', view.mode === 'overwrite', view.mode)
    check('非空准备：要求打完整包 ID', view.requiredConfirmation === view.packageId)

    const wrong = grab(() =>
      confirmRestore({
        dataDir: target.dir,
        restoreId: view.restoreId,
        confirmation: '不是这个包的编号',
        db: target.db,
        version: 'test',
        schemaVersion: SCHEMA_VERSION,
        algorithmVersion: 'grow-1',
      }),
    )
    check('确认词错误被拒（E_VALIDATION）', !!wrong && (wrong as any).code === 'E_VALIDATION', wrong?.message)
    check('拒绝后仍停在 prepared', readRestoreJournal(target.dir)?.phase === 'prepared')

    // 打错确认词之后是原地重试（真实交互也是这样：不重新准备，只再确认一次）
    const ok = confirmRestore({
      dataDir: target.dir,
      restoreId: view.restoreId,
      confirmation: view.packageId,
      db: target.db,
      version: 'test',
      schemaVersion: SCHEMA_VERSION,
      algorithmVersion: 'grow-1',
    })
    check('确认词正确 → pending', ok.phase === 'pending', ok.phase)

    target.db.close()
    const applied = applyPendingRestore({ dataDir: target.dir })
    check('覆盖式恢复完成', applied.applied, applied.reason)
    check('覆盖后事件数为 1（包里的）', countSources(target.dir) === 1, countSources(target.dir))
    check('旧数据目录仍保留', applied.keptDir !== null && existsSync(applied.keptDir), applied.keptDir)
  }

  // ── 4. 验收 4：预恢复包生成失败 → 不留有效待恢复任务 ─────────────────────
  {
    const target = await makeDataDir('prefail')
    await new Core({ db: target.db, config: {}, dataDir: target.dir }).capture({
      text: '失败用例里的一条记忆',
      channel: 'desktop',
      sessionRef: 'sess-prefail',
      origin: 'user',
    })
    const view = prepareRestorePackage({
      dataDir: target.dir,
      file: pkg,
      schemaVersion: SCHEMA_VERSION,
      db: target.db,
    })
    // 「能数表、但 VACUUM INTO 会炸」的假连接：模拟磁盘满/权限不足
    const brokenDb: RestoreDb = {
      all: () => [{ n: 1 }],
      exec: () => {
        throw new Error('disk full')
      },
    }
    const error = grab(() =>
      confirmRestore({
        dataDir: target.dir,
        restoreId: view.restoreId,
        confirmation: view.packageId,
        db: brokenDb,
        version: 'test',
        schemaVersion: SCHEMA_VERSION,
        algorithmVersion: 'grow-1',
      }),
    )
    check('预恢复包失败时 confirm 抛错', !!error)
    const journal = readRestoreJournal(target.dir)
    check('失败后仍是 prepared（不是 pending）', journal?.phase === 'prepared', journal?.phase)
    check('失败后没记预恢复包路径', (journal?.preRestoreArchive ?? '') === '')
    target.db.close()
  }

  // ── 5. 验收 6：旧目录已改名后崩溃 → 下次启动继续 ─────────────────────────
  {
    const target = await makeDataDir('crash-oldmoved')
    prepareAndConfirm(target.dir, pkg, target.db, undefined)
    target.db.close()
    const journal = readRestoreJournal(target.dir)
    if (!journal) throw new Error('拿不到 journal')
    renameSync(target.dir, journal.oldPath)
    const resumed = applyPendingRestore({ dataDir: target.dir })
    check('旧目录已移走的崩溃能续做', resumed.applied && resumed.phase === 'completed', resumed.reason)
    check('续做后数据是包里的', countSources(target.dir) === 1, countSources(target.dir))
  }

  // ── 6. 验收 7：新目录已装上后崩溃 → 启动时补校验并收尾 ───────────────────
  {
    const target = await makeDataDir('crash-newinstalled')
    prepareAndConfirm(target.dir, pkg, target.db, undefined)
    target.db.close()
    const journal = readRestoreJournal(target.dir)
    if (!journal) throw new Error('拿不到 journal')
    renameSync(target.dir, journal.oldPath)
    renameSync(journal.stagingPath, target.dir)
    writeRestoreJournal(target.dir, { ...journal, phase: 'new_installed' })
    const resumed = applyPendingRestore({ dataDir: target.dir })
    check('新目录已装上的崩溃能收尾', resumed.applied && resumed.phase === 'completed', resumed.reason)
    check('收尾后事件数为 1', countSources(target.dir) === 1, countSources(target.dir))
  }

  // ── 6b. 安装后校验失败 → 安全回退，旧目录仍然完整 ────────────────────────
  {
    const target = await makeDataDir('crash-badinstall')
    prepareAndConfirm(target.dir, pkg, target.db, undefined)
    target.db.close()
    const journal = readRestoreJournal(target.dir)
    if (!journal) throw new Error('拿不到 journal')
    // 模拟「新目录换成了一份坏库」：把暂存里的库换成垃圾字节，再按 new_installed 现场装上去
    renameSync(target.dir, journal.oldPath)
    renameSync(journal.stagingPath, target.dir)
    writeFileSync(join(target.dir, 'memory.sqlite3'), '不是数据库')
    writeRestoreJournal(target.dir, { ...journal, phase: 'new_installed' })
    const error = grab(() => applyPendingRestore({ dataDir: target.dir }))
    check('坏库触发 E_RESTORE_RECOVERY_REQUIRED', !!error && (error as any).code === 'E_RESTORE_RECOVERY_REQUIRED', error?.message)
    check('旧目录被换回原位', existsSync(join(target.dir, 'memory.sqlite3')), readdirSync(target.dir))
    check('换回来的库还是原来的（能数出原来的行）', countSources(target.dir) === 0, countSources(target.dir))
    check('坏掉的新目录被保留成 .failed-*，没被删掉', readdirSync(dirname(target.dir)).some((name) => name.includes('.failed-')), readdirSync(dirname(target.dir)))
    check('现场被记成 recovery_required', readRestoreJournal(target.dir)?.phase === 'recovery_required')
  }

  // ── 7. 验收 8：现场模糊 → E_RESTORE_RECOVERY_REQUIRED 且不动目录 ─────────
  {
    const target = await makeDataDir('ambiguous')
    prepareAndConfirm(target.dir, pkg, target.db, undefined)
    target.db.close()
    const journal = readRestoreJournal(target.dir)
    if (!journal) throw new Error('拿不到 journal')
    rmSync(target.dir, { recursive: true, force: true })
    rmSync(journal.stagingPath, { recursive: true, force: true })
    const error = grab(() => applyPendingRestore({ dataDir: target.dir }))
    check('现场模糊抛 E_RESTORE_RECOVERY_REQUIRED', !!error && (error as any).code === 'E_RESTORE_RECOVERY_REQUIRED', error?.message)
    check('模糊现场被记进状态文件', readRestoreJournal(target.dir)?.phase === 'recovery_required')
    check('不做任何清理（old 仍不存在）', !existsSync(journal.oldPath))
  }

  // ── 8. 目标在确认之后被改过 → 拒绝替换（指纹变了） ───────────────────────
  {
    const target = await makeDataDir('fingerprint')
    await new Core({ db: target.db, config: {}, dataDir: target.dir }).capture({
      text: '指纹用例里的一条记忆',
      channel: 'desktop',
      sessionRef: 'sess-fingerprint',
      origin: 'user',
    })
    const view = prepareRestorePackage({
      dataDir: target.dir,
      file: pkg,
      schemaVersion: SCHEMA_VERSION,
      db: target.db,
    })
    confirmRestore({
      dataDir: target.dir,
      restoreId: view.restoreId,
      confirmation: view.packageId,
      db: target.db,
      version: 'test',
      schemaVersion: SCHEMA_VERSION,
      algorithmVersion: 'grow-1',
    })
    target.db.close()
    writeFileSync(join(target.dir, 'identity.md'), '# 被人改过\n', 'utf8')
    const error = grab(() => applyPendingRestore({ dataDir: target.dir }))
    check('指纹变化 → 拒绝替换', !!error && (error as any).code === 'E_RESTORE_RECOVERY_REQUIRED', error?.message)
    check('拒绝后目标目录还在', existsSync(target.dir))
    check('拒绝后数据没被换（事件仍是 1）', countSources(target.dir) === 1, countSources(target.dir))
  }

  // ── 9. 验收 9：原始包被删掉，暂存的那份照样能用 ─────────────────────────
  {
    const target = await makeDataDir('pkg-gone')
    const copy = join(sandbox, 'copy-of-package.tar.gz')
    writeFileSync(copy, readFileSync(pkg))
    prepareAndConfirm(target.dir, copy, target.db, undefined)
    target.db.close()
    rmSync(copy, { force: true })
    const applied = applyPendingRestore({ dataDir: target.dir })
    check('原始包删掉后仍能应用', applied.applied, applied.reason)
    check('应用后数据正确', countSources(target.dir) === 1, countSources(target.dir))
  }

  // ── 10. status 视图：pending 标志 + 完成后说法 ───────────────────────────
  {
    const target = await makeDataDir('status')
    prepareAndConfirm(target.dir, pkg, target.db, undefined)
    const status = restoreStatus({ dataDir: target.dir, db: target.db })
    check('status.pending=true', status.pending)
    check('status 带 journal', status.journal !== null)
    check('status 给出可读说明', status.note.length > 0)
    target.db.close()
    applyPendingRestore({ dataDir: target.dir })
    const after = restoreStatus({ dataDir: target.dir })
    check('完成后再查 pending=false', after.pending === false)
    check('完成后再查说已完成', after.note.includes('已完成'), after.note)
  }

  // ── 11. 没有任务时 apply 是空操作 ────────────────────────────────────────
  {
    const target = await makeDataDir('noop')
    target.db.close()
    const before = statSync(join(target.dir, 'memory.sqlite3')).size
    const outcome = applyPendingRestore({ dataDir: target.dir })
    check('没有任务时 applied=false', outcome.applied === false && outcome.reason === 'no-pending', outcome.reason)
    check('没有任务时不动库文件', statSync(join(target.dir, 'memory.sqlite3')).size === before)
    check('没有任务时不写状态文件', !existsSync(restoreJournalPath(target.dir)))
  }

  rmSync(sandbox, { recursive: true, force: true })
  console.log(`\nrestore：${passed} 通过 ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('restore 自检崩了：', error)
  process.exitCode = 1
})
