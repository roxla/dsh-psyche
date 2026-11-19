// E6-B3 恢复状态机故障注入：每个中断点都必须「原库不变」或「能判定、能重放」。
//
// 验收点（用户 E6-B3）：
// 1. 解包前失败 → 原库不变、不留 journal / 暂存目录；
// 2. 解包一半失败（包被截断）→ 同上；
// 3. 写入 pending 后暂存目录丢失 → 明确报 recovery-required，不覆盖原库；
// 4. pending 后目标被外部改过 → 拒绝替换，记 recovery_required；
// 5. 恢复库自检失败 → 回滚旧目录，不良库不进入正常运行；
// 6. 完成后再 apply → no-op，不重复换目录；
// 7. journal 文件损坏 → 当作没有任务，不猜、不动库。
//
// 直接对着构建产物跑：node test/restore-faults.ts（需先 npm run build）
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { SCHEMA_VERSION } from '../dist/lib/schema.js'
import { createArchive } from '../dist/lib/archive.js'
import {
  applyPendingRestore,
  confirmRestore,
  prepareRestorePackage,
  readRestoreJournal,
  restoreJournalPath,
} from '../dist/lib/restore.js'

let passed = 0
let failed = 0

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

function grab(action) {
  try {
    action()
    return null
  } catch (error) {
    return error
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'psyche-restore-faults-'))

async function makeDataDir(name) {
  const dir = join(sandbox, name, 'data')
  mkdirSync(dir, { recursive: true })
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto' })
  return { dir, db: opened.db }
}

async function makePackage(name) {
  const { dir, db } = await makeDataDir(name)
  const core = new Core({ db, config: {}, dataDir: dir })
  await core.capture({ text: '主人喜欢深海和鲸鱼', channel: 'desktop', sessionRef: 'sess-fault-src', origin: 'user' })
  writeFileSync(join(dir, 'identity.md'), '# 心灵\n\n她是深海里的鲸。\n', 'utf8')
  const archive = createArchive({
    db,
    dataDir: dir,
    counts: { events: 0, sources: 1 },
    version: 'test',
    schemaVersion: SCHEMA_VERSION,
    algorithmVersion: 'grow-1',
    kind: 'backup',
    driver: 'node:sqlite',
  })
  db.close()
  return archive.file
}

function countSources(dir) {
  const file = join(dir, 'memory.sqlite3')
  if (!existsSync(file)) return -1
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM sources').get()
    return Number(Object.values(row ?? {})[0])
  } catch {
    return -2
  } finally {
    db.close()
  }
}

async function main() {
  const pkg = await makePackage('source')

  // 1) 坏包：准备阶段就失败，原库与现场都不动
  {
    const target = await makeDataDir('bad-package')
    writeFileSync(join(target.dir, 'identity.md'), '原样', 'utf8')
    const broken = join(sandbox, 'bad-package', 'broken.tar.gz')
    writeFileSync(broken, Buffer.from('not a gzip at all'))
    const error = grab(() => prepareRestorePackage({ dataDir: target.dir, file: broken, schemaVersion: SCHEMA_VERSION, db: target.db }))
    ok('坏包在 prepare 阶段抛错', error instanceof Error)
    ok('坏包不留 journal', !existsSync(restoreJournalPath(target.dir)))
    ok('坏包不动数据根', countSources(target.dir) === 0 && existsSync(join(target.dir, 'identity.md')))
    target.db.close()
  }

  // 2) 包被截断（解包一半）：同样在 prepare 阶段拒绝
  {
    const target = await makeDataDir('truncated')
    const truncRoot = join(sandbox, 'truncated')
    const truncated = join(truncRoot, 'truncated.tar.gz')
    const bytes = readFileSync(pkg)
    writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)))
    const error = grab(() => prepareRestorePackage({ dataDir: target.dir, file: truncated, schemaVersion: SCHEMA_VERSION, db: target.db }))
    ok('截断包在 prepare 阶段抛错', error instanceof Error)
    ok('截断包不动数据根', countSources(target.dir) === 0)
    ok('截断包不留暂存目录', !existsSync(join(truncRoot, 'truncated-staging')))
    target.db.close()
  }

  // 3) pending 后暂存目录丢失：明确 recovery-required，不覆盖原库
  {
    const target = await makeDataDir('staging-lost')
    const view = prepareRestorePackage({ dataDir: target.dir, file: pkg, schemaVersion: SCHEMA_VERSION, db: target.db })
    confirmRestore({ dataDir: target.dir, restoreId: view.restoreId, db: target.db, version: 'test', schemaVersion: SCHEMA_VERSION, algorithmVersion: 'grow-1' })
    rmSync(view.stagedDir, { recursive: true, force: true })
    const error = grab(() => applyPendingRestore({ dataDir: target.dir }))
    ok('暂存丢失后 apply 抛 recovery', error?.code === 'E_RESTORE_RECOVERY_REQUIRED', error?.message)
    ok('原库没被覆盖', countSources(target.dir) === 0)
    ok('现场记成 recovery_required', readRestoreJournal(target.dir)?.phase === 'recovery_required')
    target.db.close()
  }

  // 4) pending 后目标被外部改过：拒绝替换
  {
    const target = await makeDataDir('fingerprint-changed')
    const view = prepareRestorePackage({ dataDir: target.dir, file: pkg, schemaVersion: SCHEMA_VERSION, db: target.db })
    confirmRestore({ dataDir: target.dir, restoreId: view.restoreId, db: target.db, version: 'test', schemaVersion: SCHEMA_VERSION, algorithmVersion: 'grow-1' })
    writeFileSync(join(target.dir, 'identity.md'), '确认之后被人改过', 'utf8')
    const error = grab(() => applyPendingRestore({ dataDir: target.dir }))
    ok('指纹变化后拒绝替换', error?.code === 'E_RESTORE_RECOVERY_REQUIRED', error?.message)
    ok('拒绝后原库仍在', countSources(target.dir) === 0)
    ok('拒绝后记 recovery_required', readRestoreJournal(target.dir)?.phase === 'recovery_required')
    target.db.close()
  }

  // 5) 恢复库自检失败：回滚旧目录，坏库不进入运行
  {
    const target = await makeDataDir('bad-restored-db')
    const view = prepareRestorePackage({ dataDir: target.dir, file: pkg, schemaVersion: SCHEMA_VERSION, db: target.db })
    confirmRestore({ dataDir: target.dir, restoreId: view.restoreId, db: target.db, version: 'test', schemaVersion: SCHEMA_VERSION, algorithmVersion: 'grow-1' })
    // 真实启动门禁在 openDatabase 之前跑，连接必须已经关掉（否则 Windows 改不了目录名）
    target.db.close()
    // 把暂存目录里的库打成空文件：目录结构还在，但库不可用
    writeFileSync(join(view.stagedDir, 'memory.sqlite3'), Buffer.alloc(0))
    const error = grab(() => applyPendingRestore({ dataDir: target.dir }))
    ok('恢复库自检失败抛 recovery', error?.code === 'E_RESTORE_RECOVERY_REQUIRED', error?.message)
    ok('失败后原库被换回', countSources(target.dir) === 0)
    ok('坏的新目录保留成 .failed-*', readdirSync(join(sandbox, 'bad-restored-db')).some((name) => name.includes('.failed-')), readdirSync(join(sandbox, 'bad-restored-db')))
  }

  // 6) 完成后再 apply：no-op，不重复换目录
  {
    const target = await makeDataDir('completed-repeat')
    const view = prepareRestorePackage({ dataDir: target.dir, file: pkg, schemaVersion: SCHEMA_VERSION, db: target.db })
    confirmRestore({ dataDir: target.dir, restoreId: view.restoreId, db: target.db, version: 'test', schemaVersion: SCHEMA_VERSION, algorithmVersion: 'grow-1' })
    target.db.close()
    const first = applyPendingRestore({ dataDir: target.dir })
    ok('第一次 apply 成功', first.applied === true, first.reason)
    const second = applyPendingRestore({ dataDir: target.dir })
    ok('第二次 apply 是 no-op', second.applied === false && second.reason === 'completed', second.reason)
    ok('数据仍是包里的', countSources(target.dir) === 1)
  }

  // 7) journal 损坏：当作没有任务，不猜、不动库
  {
    const target = await makeDataDir('broken-journal')
    writeFileSync(restoreJournalPath(target.dir), '{ not json', 'utf8')
    const outcome = applyPendingRestore({ dataDir: target.dir })
    ok('损坏 journal 视为无任务', outcome.ok && outcome.applied === false && outcome.reason === 'no-pending', outcome.reason)
    ok('损坏 journal 不动库', countSources(target.dir) === 0)
    target.db.close()
  }

  console.log(`[E6-B3] ${passed} 通过 ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    failed += 1
    console.log(`  FAIL 场景抛错 — ${error?.message ?? error}`)
    process.exitCode = 1
  })
  .finally(() => {
    try {
      rmSync(sandbox, { recursive: true, force: true })
    } catch {
      // Windows 句柄未释放时忽略
    }
  })
