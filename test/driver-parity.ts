// E6-A 双驱动一致性：node:sqlite 与 better-sqlite3 在同一套操作下结果一致。
//
// 验收点（用户 E6-A）：
// 1. 两种驱动都能打开、五项自检全过、迁移到当前版本；
// 2. 同一套业务操作（capture / remember / revise / FTS 检索 / 事务回滚 / 重新打开）
//    在两个驱动下得到相同的结构性结果；
// 3. 同一个库文件能被两个驱动互相打开读取（真实回退/诊断场景）；
// 4. 损坏库在两个驱动下都报 E_DB_CORRUPT，不静默重建。
//
// 直接对着构建产物跑：node test/driver-parity.ts（需先 npm run build）
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { bigramText, searchFts, verifyFtsIndex } from '../dist/lib/fts.js'

let passed = 0
let failed = 0

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

const log = { info() {}, debug() {}, warn() {}, error: (m) => console.error('[logger.error]', m) }

const dirs = []
function makeDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), `psyche-parity-${tag}-`))
  dirs.push(dir)
  return dir
}

// 同一套操作；只返回可比较的结构性快照，不把时间/路径带进比较。
async function runScenario(driver) {
  const dir = makeDir(driver.replace(':', '-'))
  const opened = await openDatabase({
    file: join(dir, 'memory.sqlite3'),
    driverPreference: driver,
    logger: log,
  })
  const db = opened.db
  migrate(db, log) // 幂等：openDatabase 已迁过，这里验证重复调用不留副作用
  const core = new Core({ db, config: {}, logger: log, dataDir: dir })

  const src = await core.capture({
    platform: 'qq',
    channel: 'group',
    externalRoomId: '888',
    stableUserId: '10001',
    displayName: '阿岚',
    origin: 'user',
    kind: 'message',
    text: '我周五晚上一般都在打游戏，别约我。',
    sessionRef: 'sess-parity',
  })
  const fact = await core.remember({
    text: '阿岚说她周五晚上一般都在打游戏。',
    kind: 'fact',
    statement: '阿岚周五晚上通常会打游戏，不安排别的事。',
    sourceIds: src.sourceId,
    subject: src.contactId,
    confidence: 'high',
    disclosure: 'public',
  })
  // R3.1 起来源域在召回 SQL 里判定：群消息来源属于 room 域，scope 必须带上解析后的 roomId。
  const scope = { contactId: src.contactId, roomId: src.roomId ?? undefined }
  const hits = searchFts(db, '周五 游戏', { limit: 8, scope })
  const revised = await core.revise({
    artifactId: fact.artifactId,
    statement: '阿岚周五晚上通常打游戏，不安排别的事；周末也常打。',
    refs: [fact.artifactId],
  })
  const hitsAfter = searchFts(db, '周末 打游戏', { limit: 8, scope })

  // 事务回滚：临时表插一行后抛错，整笔撤销。
  db.exec('CREATE TABLE IF NOT EXISTS rollback_probe (a INTEGER)')
  let thrown = false
  try {
    db.transaction(() => {
      db.run('INSERT INTO rollback_probe (a) VALUES (1)')
      throw new Error('parity-rollback')
    })
  } catch {
    thrown = true
  }
  const probeRows = Number(db.get('SELECT COUNT(*) AS n FROM rollback_probe').n)
  const verify = verifyFtsIndex(db)

  // 重新打开同一文件：迁移幂等、数据仍在。
  const beforeClose = Number(db.get('SELECT COUNT(*) AS n FROM artifacts').n)
  const journalMode = String(db.pragma('journal_mode')).toLowerCase()
  const foreignKeys = Number(db.pragma('foreign_keys'))
  db.close()
  const reopened = await openDatabase({
    file: join(dir, 'memory.sqlite3'),
    driverPreference: driver,
    logger: log,
  })
  const afterOpen = Number(reopened.db.get('SELECT COUNT(*) AS n FROM artifacts').n)
  const userVersion = reopened.db.userVersion()
  const tables = reopened.db
    .all(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fts_index_%'`,
    )
    .map((row) => row.name)
  reopened.db.close()

  return {
    driver: opened.driver,
    selfCheckOk: opened.selfCheck.ok,
    selfCheckItems: opened.selfCheck.items.map((item) => item.name).sort(),
    backupMode: opened.selfCheck.backupMode,
    journalMode,
    foreignKeys,
    userVersion,
    tableCount: tables.filter((name) => name !== 'fts_index').length,
    factState: fact.state,
    independentEvidenceCount: fact.independentEvidenceCount,
    firstHit: hits[0]?.artifactId ?? null,
    firstHitIsFact: hits[0]?.artifactId === fact.artifactId,
    revisedRevision: revised.revision ?? null,
    afterHit: hitsAfter[0]?.artifactId ?? null,
    afterHitIsRevised: hitsAfter[0]?.artifactId === fact.artifactId,
    rollbackThrown: thrown,
    probeRows,
    verifyMissing: verify.missing.length,
    verifyOrphan: verify.orphan.length,
    verifyDuplicate: verify.duplicate.length,
    verifyMismatch: verify.contentMismatch.length,
    verifyIntegrity: verify.integrityOk,
    headCount: verify.headCount,
    beforeClose,
    afterOpen,
    bigramSample: bigramText('周五 游戏'),
  }
}

console.log('\n[1] 两个驱动各跑同一套场景')
const nodeScenario = await runScenario('node:sqlite')
const betterScenario = await runScenario('better-sqlite3')

ok('node:sqlite 打开的是 node:sqlite', nodeScenario.driver === 'node:sqlite', nodeScenario.driver)
ok('better-sqlite3 打开的是 better-sqlite3', betterScenario.driver === 'better-sqlite3', betterScenario.driver)
ok('node:sqlite 五项自检全过', nodeScenario.selfCheckOk, nodeScenario)
ok('better-sqlite3 五项自检全过', betterScenario.selfCheckOk, betterScenario)
eq('两边自检项一致', nodeScenario.selfCheckItems, betterScenario.selfCheckItems)
eq('两边日志模式一致（wal）', nodeScenario.journalMode, betterScenario.journalMode)
eq('两边 foreign_keys 一致', nodeScenario.foreignKeys, betterScenario.foreignKeys)
eq('两边 schema 版本一致', nodeScenario.userVersion, betterScenario.userVersion)
eq('两边业务表数一致', nodeScenario.tableCount, betterScenario.tableCount)
console.log(
  `  备份方式：node:sqlite=${nodeScenario.backupMode} / better-sqlite3=${betterScenario.backupMode}`,
)

console.log('\n[2] 业务行为一致性')
eq('fact 状态一致', nodeScenario.factState, betterScenario.factState)
eq('独立证据数一致', nodeScenario.independentEvidenceCount, betterScenario.independentEvidenceCount)
eq('首次 FTS 命中一致（同一 artifactId 是否排第一）', nodeScenario.firstHitIsFact, betterScenario.firstHitIsFact)
ok('node:sqlite 首次检索命中新事实', nodeScenario.firstHitIsFact)
ok('better-sqlite3 首次检索命中新事实', betterScenario.firstHitIsFact)
eq('修订后 revision 编号一致', nodeScenario.revisedRevision, betterScenario.revisedRevision)
eq('修订后检索命中一致', nodeScenario.afterHitIsRevised, betterScenario.afterHitIsRevised)
eq('两边分词样本一致', nodeScenario.bigramSample, betterScenario.bigramSample)

console.log('\n[3] 事务与索引自检一致性')
eq('事务抛错两边都抛出', nodeScenario.rollbackThrown, betterScenario.rollbackThrown)
eq('回滚后临时表行数一致（0）', nodeScenario.probeRows, betterScenario.probeRows)
eq('rollback 后行数为 0（node:sqlite）', nodeScenario.probeRows, 0)
eq('rollback 后行数为 0（better-sqlite3）', betterScenario.probeRows, 0)
eq('两边 verify missing 一致', nodeScenario.verifyMissing, betterScenario.verifyMissing)
eq('两边 verify orphan 一致', nodeScenario.verifyOrphan, betterScenario.verifyOrphan)
eq('两边 verify duplicate 一致', nodeScenario.verifyDuplicate, betterScenario.verifyDuplicate)
eq('两边 verify contentMismatch 一致', nodeScenario.verifyMismatch, betterScenario.verifyMismatch)
eq('两边 verify integrity 一致', nodeScenario.verifyIntegrity, betterScenario.verifyIntegrity)
eq('两边 head 数一致', nodeScenario.headCount, betterScenario.headCount)
eq('verify 全部干净（missing=0）', nodeScenario.verifyMissing, 0)
eq('verify 全部干净（orphan=0）', nodeScenario.verifyOrphan, 0)
eq('verify 全部干净（duplicate=0）', nodeScenario.verifyDuplicate, 0)
eq('verify 全部干净（contentMismatch=0）', nodeScenario.verifyMismatch, 0)
eq('verify integrity 通过', nodeScenario.verifyIntegrity, true)

console.log('\n[4] 重新打开：数据仍在、迁移幂等')
eq('node:sqlite 重开后 artifact 数不变', nodeScenario.beforeClose, nodeScenario.afterOpen)
eq('better-sqlite3 重开后 artifact 数不变', beforeCount(betterScenario), betterScenario.afterOpen)
function beforeCount(scenario) {
  return scenario.beforeClose
}
eq('重开后版本仍是 31', nodeScenario.userVersion, 31)

console.log('\n[5] 同一库文件跨驱动互操作')
{
  const dir = makeDir('cross')
  const file = join(dir, 'memory.sqlite3')
  const first = await openDatabase({ file, driverPreference: 'node:sqlite', logger: log })
  first.db.exec('CREATE TABLE cross_probe (v TEXT NOT NULL)')
  first.db.run("INSERT INTO cross_probe (v) VALUES ('from-node-sqlite')")
  first.db.close()

  const second = await openDatabase({ file, driverPreference: 'better-sqlite3', logger: log })
  const row = second.db.get('SELECT v FROM cross_probe LIMIT 1')
  eq('better-sqlite3 能读 node:sqlite 写的库', row.v, 'from-node-sqlite')
  second.db.run("INSERT INTO cross_probe (v) VALUES ('from-better-sqlite3')")
  second.db.close()

  const third = await openDatabase({ file, driverPreference: 'node:sqlite', logger: log })
  const count = Number(third.db.get('SELECT COUNT(*) AS n FROM cross_probe').n)
  eq('node:sqlite 能读回 better-sqlite3 追加的行', count, 2)
  third.db.close()
}

console.log('\n[6] 损坏库：两个驱动都报 E_DB_CORRUPT 且保留文件')
for (const driver of ['node:sqlite', 'better-sqlite3']) {
  const dir = makeDir(`corrupt-${driver.replace(':', '-')}`)
  const file = join(dir, 'memory.sqlite3')
  writeFileSync(file, Buffer.from('this is definitely not a sqlite database'.repeat(8), 'utf8'))
  let code = null
  try {
    await openDatabase({ file, driverPreference: driver, logger: log })
  } catch (error) {
    code = error.code ?? null
  }
  eq(`${driver} 报 E_DB_CORRUPT`, code, 'E_DB_CORRUPT')
  const bytes = readFileSync(file).byteLength
  ok(`${driver} 损坏文件仍保留（未被改写/清空）`, bytes > 0, { bytes })
}

console.log('\n[7] auto 驱动优先 node:sqlite')
{
  const dir = makeDir('auto')
  const opened = await openDatabase({
    file: join(dir, 'memory.sqlite3'),
    driverPreference: 'auto',
    logger: log,
  })
  eq('auto 选择 node:sqlite', opened.driver, 'node:sqlite')
  opened.db.close()
}

for (const dir of dirs) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows 上句柄未释放会 EPERM；清理失败不能盖掉测试结论
  }
}

console.log(`\n[driver-parity] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
