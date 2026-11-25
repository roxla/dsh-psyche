// 存储层的坏情况（§11.6 / §11.5 / §11.10）：
// 备用驱动缺失时不许降级、损坏库不许换驱动、迁移可重复、重要事务后 synchronous 还原。
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate, runSelfCheck } from '../dist/lib/adapter.js'

let passed = 0
let failed = 0
const ok = (label, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-storage-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }

console.log('\n[1] 备用驱动：装了能打开，没装明确报错（不降级内存库）')
try {
  const opened = await openDatabase({ file: join(dir, 'x.sqlite3'), driverPreference: 'better-sqlite3', logger: log })
  ok('better-sqlite3 可用时按指定驱动打开', opened.driver === 'better-sqlite3', opened.driver)
  ok('打开的仍是文件库（五项自检通过）', opened.selfCheck.ok === true, opened.selfCheck.items)
  opened.db.close()
} catch (error) {
  ok('better-sqlite3 不可用时抛 E_DB', error.code === 'E_DB', error.code)
  ok('错误里带上尝试过的驱动', String(error.message).includes('better-sqlite3'), error.message.slice(0, 80))
  ok('没有偷偷用 node:sqlite', !String(error.detail ?? '').includes('node:sqlite(ready'), error.detail)
}

console.log('\n[2] 损坏的记忆库：先报错并保留文件，不换驱动、不重建')
const corrupt = join(dir, 'corrupt.sqlite3')
writeFileSync(corrupt, 'this is definitely not a sqlite database')
const sizeBefore = statSync(corrupt).size
try {
  await openDatabase({ file: corrupt, driverPreference: 'auto', logger: log })
  ok('损坏库应当失败', false, '竟然打开了')
} catch (error) {
  ok('抛出 E_DB_CORRUPT', error.code === 'E_DB_CORRUPT', { code: error.code, message: error.message })
  ok('文件还在（没有删库重建）', statSync(corrupt).size === sizeBefore, { sizeBefore })
}

console.log('\n[3] 迁移可重复：重复 migrate 不留副作用')
const file = join(dir, 'ok.sqlite3')
const opened = await openDatabase({ file, driverPreference: 'auto', logger: log })
const db = opened.db
const v1 = db.userVersion()
const applied = migrate(db, log)
const v2 = db.userVersion()
ok('第一次启动已迁到最新 schema（v42）', v1 === 42, v1)
ok('再跑一次不再应用任何迁移', applied.length === 0, applied)
ok('user_version 不变', v2 === 42, v2)
const tablesOnce = db.all(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'`)[0].n
const reopened = await openDatabase({ file, driverPreference: 'auto', logger: log })
ok('第二次打开不会重复建表', reopened.db.all(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'`)[0].n === tablesOnce, {
  tablesOnce,
})
reopened.db.close()

console.log('\n[4] 重要事务前后 synchronous 还原（§11.5：不在事务内切）')
const normalBefore = Number(db.pragma('synchronous'))
let seenInside = null
db.transaction(() => {
  seenInside = Number(db.pragma('synchronous'))
}, { important: true })
const normalAfter = Number(db.pragma('synchronous'))
ok('事务内是 FULL(2)', seenInside === 2, seenInside)
ok('事务后回到 NORMAL(1)', normalAfter === normalBefore && normalAfter === 1, { normalBefore, normalAfter })

console.log('\n[5] 事务中途抛错必须整笔回滚')
db.run(`INSERT INTO contacts (contact_id, persona_id, platform, stable_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [
  'ct_tx', 'main', 'qq', '1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
])
const before = db.all(`SELECT count(*) AS n FROM contacts`)[0].n
try {
  db.transaction(() => {
    db.run(`INSERT INTO contacts (contact_id, persona_id, platform, stable_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [
      'ct_tx2', 'main', 'qq', '2', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    ])
    throw new Error('模拟中途失败')
  })
} catch {
  /* 预期 */
}
ok('回滚后条数没变', db.all(`SELECT count(*) AS n FROM contacts`)[0].n === before, before)
ok('回滚后连接可用（没卡在事务里）', db.inTransaction === false)

console.log('\n[6] 外键真的在拦')
try {
  db.run(`INSERT INTO event_sources (event_id, source_id) VALUES ('evt_nope', 'src_nope')`)
  ok('外键应当拦下孤立关联', false, '竟然插进去了')
} catch (error) {
  ok('外键拦下孤立关联', /FOREIGN KEY|约束/i.test(error.message), error.message)
}

console.log('\n[7] 自检能被独立调用（升级后复验）')
const again = runSelfCheck(db)
ok('自检 5 项', again.items.length === 5, again.items.map((i) => i.name))
ok('自检通过', again.ok, again.items.filter((i) => !i.ok))

db.close()
try {
  rmSync(dir, { recursive: true, force: true })
} catch (error) {
  console.log(`  （临时目录没删掉，不影响结论：${error.code}）`)
}
console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1

