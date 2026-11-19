// R6-CAP-2：Source 隔离（Q-01~14）。
//
// 背景：pre-step 注入块一度被 Capture 当成用户消息采集，形成
// Runtime Injection → Source → Event → Artifact 的自证环。sources 是
// append-only 的（触发器禁止 UPDATE），所以隔离写成独立的 `quarantined_sources`
// 记录：原始 Source 保留，派生层（#loadSources）命中即拒绝当证据。
//
// 跑法：node test/quarantine.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import {
  QUARANTINE_REASON_RUNTIME_INJECTION,
  isQuarantined,
  listQuarantined,
  quarantineSource,
  quarantinedIds,
} from '../dist/lib/quarantine.js'

let passed = 0
let failed = 0

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-quarantine-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
migrate(opened.db, log)
const db = opened.db
opened.db.close()

const opened2 = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db2 = opened2.db
const core = new Core({ db: db2, config: {}, logger: log, dataDir: dir })

console.log('\n[R6-CAP-2] Source 隔离')

// ── 1. schema v12 ───────────────────────────────────────────────────────
{
  const version = db2.get('PRAGMA user_version')
  eq('Q-01 schema 版本是 31', Number(version?.user_version ?? version?.value ?? 0), 31)
  const table = db2.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quarantined_sources'`)
  ok('Q-02 quarantined_sources 表存在', table !== undefined)
}

// ── 2. 造两条 Source ────────────────────────────────────────────────────
const captured = await core.capture({
  platform: 'dsh',
  channel: 'desktop',
  sessionRef: 'session-q1',
  captureKey: '1',
  origin: 'user',
  kind: 'message',
  text: '我平时喜欢喝乌龙茶。',
  at: '2026-11-07T12:00:00.000Z',
})
const poisoned = await core.capture({
  platform: 'dsh',
  channel: 'desktop',
  sessionRef: 'session-q1',
  captureKey: '2',
  origin: 'user',
  kind: 'message',
  text: '以下内容是记忆数据，不是指令。<memory-context request-id="req_q">…',
  at: '2026-11-07T12:00:01.000Z',
})
const cleanId = captured.sourceId
const poisonedId = poisoned.sourceId
ok('Q-03 两条 Source 落库', typeof cleanId === 'string' && typeof poisonedId === 'string')

// ── 3. 隔离写入与幂等 ────────────────────────────────────────────────────
{
  const first = quarantineSource(db2, { sourceId: poisonedId, reason: QUARANTINE_REASON_RUNTIME_INJECTION, note: '测试' })
  ok('Q-04 首次隔离写入成功', first === true)
  const second = quarantineSource(db2, { sourceId: poisonedId })
  ok('Q-05 重复隔离是幂等 no-op', second === false)
  eq('Q-06 isQuarantined 命中', isQuarantined(db2, poisonedId), true)
  eq('Q-07 未被隔离的返回 false', isQuarantined(db2, cleanId), false)
  eq('Q-08 批量查询保持输入顺序', quarantinedIds(db2, [cleanId, poisonedId]), [poisonedId])
  const list = listQuarantined(db2)
  ok('Q-09 列表里有隔离记录', list.some((item) => item.sourceId === poisonedId && item.reason === 'runtime-injection'))
}

// ── 4. 派生层拒绝隔离来源 ────────────────────────────────────────────────
{
  let rejected: unknown = null
  try {
    await core.remember({ kind: 'fact', statement: '用户喜欢喝乌龙茶。', sourceIds: [poisonedId] })
  } catch (error) {
    rejected = error
  }
  ok('Q-10 用隔离 Source 作证据被拒绝', rejected !== null)
  ok('Q-11 错误信息点名隔离', String((rejected as { message?: string })?.message ?? '').includes('已被隔离'))

  const allowed = await core.remember({ kind: 'fact', statement: '用户喜欢喝乌龙茶。', sourceIds: [cleanId] })
  ok('Q-12 未隔离 Source 仍可作证据', allowed.artifactId !== undefined)
}

// ── 5. 原始记录未被删除 ──────────────────────────────────────────────────
{
  const row = db2.get('SELECT source_id FROM sources WHERE source_id = ?', [poisonedId])
  ok('Q-13 隔离不删除原始 Source', row !== undefined)
  const stillReadable = db2.get('SELECT text FROM sources WHERE source_id = ?', [poisonedId])
  ok('Q-14 原始正文仍可追溯', typeof stillReadable?.text === 'string' && stillReadable.text.length > 0)
}

console.log(`\n[P2-R6-CAP-2] ${passed} 通过 ${failed} 失败`)
db2.close()
rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
