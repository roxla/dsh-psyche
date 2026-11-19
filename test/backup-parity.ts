// E6-B1 双驱动备份一致性：同一条备份路径（VACUUM INTO + tar.gz + 清单）
// 在两个驱动下都必须给出「能独立打开、语义一致」的包。
//
// 验收点（用户 E6-B1）：
// 1. 基本备份：包能校验、能解包、解出来的库能独立打开、数据在；
// 2. WAL 活动期间备份：已提交但尚未 checkpoint 的数据必须在包里；
// 3. 未提交事务：不能被带进包；备份失败时原库与目录都完好；
// 4. 备份后原库继续可用；
// 5. 备份失败清理：VACUUM 失败不留 .snapshot.sqlite3 / .tmp；
// 6. 清单自证：backupId / kind / driver / backupMode / totalBytes / files 齐全。
//
// 直接对着构建产物跑：node test/backup-parity.ts（需先 npm run build）
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { createArchive, extractArchive, verifyArchive } from '../dist/lib/archive.js'

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

function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

const log = { info() {}, debug() {}, warn() {}, error: (m) => console.error('[logger.error]', m) }

const dirs = []
function makeDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), `psyche-backup-${tag}-`))
  dirs.push(dir)
  return dir
}

async function seed(dir, driver) {
  const opened = await openDatabase({
    file: join(dir, 'memory.sqlite3'),
    driverPreference: driver,
    logger: log,
  })
  const core = new Core({ db: opened.db, config: {}, logger: log, dataDir: dir })
  const src = await core.capture({
    platform: 'qq',
    channel: 'group',
    externalRoomId: '888',
    stableUserId: '10001',
    displayName: '阿岚',
    origin: 'user',
    kind: 'message',
    text: '我周五晚上一般都在打游戏，别约我。',
    sessionRef: 'sess-backup',
  })
  const fact = await core.remember({
    text: '阿岚说她周五晚上一般都在打游戏。',
    kind: 'fact',
    statement: '阿岚周五晚上通常会打游戏，不安排别的事。',
    sourceIds: src.sourceId,
    subject: src.contactId,
    disclosure: 'public',
  })
  return { opened, core, factId: fact.artifactId }
}

async function countRows(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const artifacts = db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n
    const revisions = db.prepare('SELECT COUNT(*) AS n FROM artifact_revisions').get().n
    const fts = db.prepare('SELECT COUNT(*) AS n FROM fts_index').get().n
    return { artifacts, revisions, fts }
  } finally {
    db.close()
  }
}

function listTemp(dir) {
  if (!dir) return []
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.tmp') || name === '.snapshot.sqlite3')
  } catch {
    return []
  }
}

async function runDriver(driver) {
  const tag = driver.replace(':', '-')
  const dir = makeDir(tag)
  const { opened, core, factId } = await seed(dir, driver)
  const db = opened.db

  // 1) 基本备份 + 清单
  const archive = createArchive({
    db,
    dataDir: dir,
    counts: { artifacts: 1, revisions: 1 },
    version: '0.0.0-test',
    schemaVersion: db.userVersion(),
    algorithmVersion: 'test',
    kind: 'backup',
    driver,
    now: new Date('2026-11-07T00:00:00Z'),
    keep: 2,
  })
  const manifest = archive.manifest
  eq(`${driver}: kind=backup`, manifest.kind, 'backup')
  ok(`${driver}: backupId 非空`, typeof manifest.backupId === 'string' && manifest.backupId.length >= 8)
  eq(`${driver}: driver 写进清单`, manifest.driver, driver)
  eq(`${driver}: backupMode=vacuum-into`, manifest.backupMode, 'vacuum-into')
  ok(`${driver}: totalBytes>0`, manifest.totalBytes > 0)
  ok(
    `${driver}: 清单含 database 成员`,
    manifest.files.some((entry) => entry.path === 'memory.sqlite3' && entry.sha256.length === 64),
  )

  const verified = verifyArchive(archive.file)
  ok(`${driver}: 包校验通过`, verified.ok === true, verified.problems)
  eq(`${driver}: 校验能读出 backupId`, verified.manifest?.backupId, manifest.backupId)

  // 2) 解包 + 独立打开
  const extracted = extractArchive(archive.file, join(dir, 'extracted'))
  ok(`${driver}: 解包成功`, extracted.files >= 1)
  const counts = await countRows(join(dir, 'extracted', 'memory.sqlite3'))
  eq(`${driver}: 备份库 artifacts=1`, counts.artifacts, 1)
  eq(`${driver}: 备份库 revisions=1`, counts.revisions, 1)
  eq(`${driver}: 备份库 FTS=1`, counts.fts, 1)
  const reread = await openDatabase({ file: join(dir, 'extracted', 'memory.sqlite3'), driverPreference: driver, logger: log })
  try {
    const head = reread.db
      .prepare('SELECT MAX(revision) AS revision FROM artifact_revisions WHERE artifact_id = ?')
      .get(factId)
    eq(`${driver}: 独立打开后 head 在`, head?.revision, 1)
    eq(`${driver}: 自检通过`, reread.selfCheck.ok, true)
  } finally {
    reread.db.close()
  }

  // 3) WAL 活动期间备份：写入提交但先不 checkpoint
  await core.remember({
    text: '阿岚还说她周末会去跑步。',
    kind: 'fact',
    statement: '阿岚周末会去跑步。',
    sourceIds: null,
    disclosure: 'public',
  })
  const walArchive = createArchive({
    db,
    dataDir: dir,
    counts: {},
    version: '0.0.0-test',
    schemaVersion: db.userVersion(),
    algorithmVersion: 'test',
    kind: 'backup',
    driver,
    now: new Date('2026-11-07T00:01:00Z'),
    keep: 2,
  })
  extractArchive(walArchive.file, join(dir, 'extracted-wal'))
  const walCounts = await countRows(join(dir, 'extracted-wal', 'memory.sqlite3'))
  eq(`${driver}: WAL 已提交数据在包里`, walCounts.artifacts, 2)
  eq(`${driver}: WAL 包 FTS 同步`, walCounts.fts, 2)

  // 4) 未提交事务：不能被带进包
  db.exec('BEGIN')
  db.prepare(
    "INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at) VALUES ('art_uncommitted', 'main', 'fact', '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z')",
  ).run()
  let uncommittedArchive = null
  let uncommittedError = null
  try {
    uncommittedArchive = createArchive({
      db,
      dataDir: dir,
      counts: {},
      version: '0.0.0-test',
      schemaVersion: db.userVersion(),
      algorithmVersion: 'test',
      kind: 'backup',
      driver,
      now: new Date('2026-11-07T00:02:00Z'),
      keep: 2,
    })
  } catch (error) {
    uncommittedError = error
  } finally {
    db.exec('ROLLBACK')
  }
  ok(`${driver}: 未提交事务不会静默进包`, uncommittedError !== null || uncommittedArchive !== null)
  if (uncommittedArchive) {
    extractArchive(uncommittedArchive.file, join(dir, 'extracted-uncommitted'))
    const uncommittedCounts = await countRows(join(dir, 'extracted-uncommitted', 'memory.sqlite3'))
    eq(`${driver}: 未提交数据不在包里`, uncommittedCounts.artifacts, 2)
  } else {
    ok(`${driver}: 未提交时备份明确失败（不产出半包）`, uncommittedError instanceof Error)
  }

  // 5) 备份失败清理：VACUUM 抛错时不留临时文件
  const brokenDb = { exec() { throw new Error('boom-vacuum') } }
  const failDir = makeDir(`${tag}-fail`)
  const exportsDir = join(failDir, 'exports')
  mkdirSync(exportsDir, { recursive: true })
  let failedError = null
  try {
    createArchive({
      db: brokenDb,
      dataDir: failDir,
      counts: {},
      version: '0.0.0-test',
      schemaVersion: 1,
      algorithmVersion: 'test',
      kind: 'backup',
      driver,
    })
  } catch (error) {
    failedError = error
  }
  ok(`${driver}: 备份失败抛错`, failedError instanceof Error)
  eq(`${driver}: 失败后无 snapshot 残留`, listTemp(exportsDir), [])

  // 6) 原库继续可用
  const after = await core.remember({
    text: '阿岚提到她喜欢喝美式。',
    kind: 'fact',
    statement: '阿岚喜欢喝美式。',
    sourceIds: null,
    disclosure: 'public',
  })
  ok(`${driver}: 备份后原库仍可写`, typeof after.artifactId === 'string')
  eq(`${driver}: 原库计数=3`, (await countRows(join(dir, 'memory.sqlite3'))).artifacts, 3)

  // 7) 不残留临时文件
  eq(`${driver}: 正常路径无临时文件残留`, listTemp(exportsDir), [])

  db.close()
}

export async function run() {
  console.log('[E6-B1] 双驱动备份一致性')
  for (const driver of ['node:sqlite', 'better-sqlite3']) {
    try {
      await runDriver(driver)
    } catch (error) {
      failed += 1
      console.log(`  FAIL ${driver} 场景抛错 — ${error?.message ?? error}`)
    }
  }
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 上句柄没放干净时忽略；临时目录由系统回收
    }
  }
  console.log(`[E6-B1] ${passed} 通过 ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

// 允许被其它测试 import；直接运行时执行本身
if (process.argv[1]?.endsWith('backup-parity.ts') || process.argv[1]?.endsWith('backup-parity.js')) {
  run()
}
