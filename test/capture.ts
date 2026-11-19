// P2-CAP-1a：Capture 契约与幂等底座测试。
//
// 冻结的语义（DEV.md §P2-CAP-1a）：
// 1. 首次捕获：创建 Source，replayed=false
// 2. 同身份同内容：返回原 sourceId，replayed=true，不新增行
// 3. 同身份不同内容：抛 E_CAPTURE_CONFLICT，原行不覆盖
// 4. 同 key 不同会话：不同身份，各自落一条
// 5. 重复投递不推进活动窗口计数（证据独立性不被污染）
// 6. 事务中途失败：不留半条来源（窗口/房间/联系人一起回滚）
// 7. 并发重复：数据库唯一索引兜底，只产生一条
//
// 跑法：node test/capture.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'

let passed = 0
let failed = 0

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-capture-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const sourceCount = () => Number(db.get(`SELECT COUNT(*) AS n FROM sources`).n)
const windowCount = () => Number(db.get(`SELECT COUNT(*) AS n FROM session_activity_windows`).n)
const windowSources = (key) =>
  Number(db.get(`SELECT source_count FROM session_activity_windows WHERE window_key = ?`, [key]).source_count)

console.log('\n[P2-CAP-1a] Capture 契约与幂等底座')

// 1. 不传 captureKey：每次都是新来源（手动工具路径靠 opId 幂等，不靠 captureKey）
const first = await core.capture({ text: '第一句', sessionRef: 's1', at: '2026-11-04T10:00:00.000Z' })
eq('首次落库 replayed=false', first.replayed, false)
const second = await core.capture({ text: '第一句', sessionRef: 's1', at: '2026-11-04T10:00:01.000Z' })
ok('不传 captureKey 每次新来源', first.sourceId !== second.sourceId && sourceCount() === 2, {
  count: sourceCount(),
})

// 2. 同身份同内容：重放
const original = await core.capture({
  text: '同一条',
  sessionRef: 's2',
  captureKey: 's2:1',
  at: '2026-11-04T10:01:00.000Z',
})
const replay = await core.capture({
  text: '同一条',
  sessionRef: 's2',
  captureKey: 's2:1',
  at: '2026-11-04T10:02:00.000Z',
})
eq('重复投递 replayed=true', replay.replayed, true)
eq('重复投递返回原 sourceId', replay.sourceId, original.sourceId)
eq('sources 只多一条', sourceCount(), 3)

// 3. 同身份不同内容：明确冲突，不覆盖
let conflict = null
try {
  await core.capture({ text: '改过的内容', sessionRef: 's2', captureKey: 's2:1' })
} catch (err) {
  conflict = err
}
eq('同身份不同内容抛 E_CAPTURE_CONFLICT', conflict?.code, 'E_CAPTURE_CONFLICT')
eq(
  '冲突不改原行',
  String(db.get(`SELECT text FROM sources WHERE source_id = ?`, [original.sourceId]).text),
  '同一条',
)
eq('冲突不新增来源', sourceCount(), 3)

// 4. 同 key 不同会话：不同身份
const otherSession = await core.capture({
  text: '同一条',
  sessionRef: 's3',
  captureKey: 's2:1',
  at: '2026-11-04T10:03:00.000Z',
})
ok('不同 session 同 key 是新来源', otherSession.sourceId !== original.sourceId && sourceCount() === 4, {
  count: sourceCount(),
})

// 5. 重复投递不推进活动窗口
const windowBefore = windowSources(original.windowKey)
await core.capture({ text: '同一条', sessionRef: 's2', captureKey: 's2:1' })
eq('重复投递不改活动窗口计数', windowSources(original.windowKey), windowBefore)

// 6. 事务中途失败：窗口先写、INSERT 时非法 origin 抛错，整笔回滚不留半条
const windowsBefore = windowCount()
let invalid = null
try {
  await core.capture({ text: 'x', sessionRef: 's9', origin: 'nope', at: '2026-11-04T10:04:00.000Z' })
} catch (err) {
  invalid = err
}
eq('非法 origin 抛 E_VALIDATION', invalid?.code, 'E_VALIDATION')
eq('失败后不留活动窗口', windowCount(), windowsBefore)
eq('失败后不留来源', sourceCount(), 4)

// 7. 并发同身份：数据库层只允许一条
const results = await Promise.all(
  Array.from({ length: 5 }, () =>
    core.capture({ text: '并发', sessionRef: 's4', captureKey: 's4:1', at: '2026-11-04T10:05:00.000Z' }),
  ),
)
eq('并发只产生一条', sourceCount(), 5)
eq('并发里恰好一个首次', results.filter((item) => item.replayed === false).length, 1)

db.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n[P2-CAP-1a] ${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1
