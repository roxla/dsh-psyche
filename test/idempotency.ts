// P2-FTS5 E3 第二批：操作幂等（IDEM-01~10 中当前模型可验证的部分）。
//
// 验收口径（用户 m12043 第二批清单）：
// - 同 opId + 同 payload → 重放（replayed=true），不产生第二个结果；
// - 同 opId + 不同 payload → E_IDEMPOTENT_CONFLICT，不能静默返回旧结果；
// - 失败操作整笔回滚，另开事务记 failed；重试只能同 payload（同 opId），
//   换 payload 的成功重试必须换 opId；
// - FTS upsert 是替换不是追加；
// - 双进程同 opId 竞争：一个真正提交，另一个读到 operations 重放。
//
// 跑法：node test/idempotency.ts（需要先 npm run build）
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { upsertFtsRow } from '../dist/lib/fts.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-idem-'))
const dbFile = join(dir, 'memory.sqlite3')
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: dbFile, driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

console.log('\n[P2-FTS5 E3-2] 操作幂等')

async function source(sessionRef, text) {
  const captured = await core.capture({
    platform: 'dsh',
    channel: 'desktop',
    sessionRef,
    origin: 'user',
    kind: 'message',
    text,
  })
  return captured.sourceId
}

const srcA = await source('idem-src-a', '幂等测试来源 A。')
const srcB = await source('idem-src-b', '幂等测试来源 B。')
const sourceIds = [srcA, srcB]

// ── IDEM-01：capture 重放 ───────────────────────────────────────────────
const capInput = {
  platform: 'dsh',
  channel: 'desktop',
  sessionRef: 'idem-cap',
  origin: 'user',
  kind: 'message',
  text: '这是一次可重放的采集。',
  opId: 'op-cap-1',
}
const cap1 = await core.capture(capInput)
const cap2 = await core.capture(capInput)
eq('capture 第二次是重放', cap2.replayed, true)
eq('capture 两次同一 sourceId', cap2.sourceId, cap1.sourceId)
eq(
  'sources 只落一条',
  db.get(`SELECT count(*) AS n FROM sources WHERE session_ref = 'idem-cap'`).n,
  1,
)

// ── IDEM-02：remember 重放 ─────────────────────────────────────────────
const remInput = {
  text: '幂等测试用的结论。',
  kind: 'fact',
  statement: '用户在做幂等测试。',
  sourceIds,
  confidence: 'high',
  disclosure: 'public',
  opId: 'op-rem-1',
}
const rem1 = await core.remember(remInput)
const rem2 = await core.remember(remInput)
eq('remember 第二次是重放', rem2.replayed, true)
eq('remember 两次同一 artifactId', rem2.artifactId, rem1.artifactId)
eq(
  'artifacts 只多一条',
  db.get(`SELECT count(*) AS n FROM artifacts WHERE artifact_id = ?`, [rem1.artifactId]).n,
  1,
)

// ── IDEM-03：revise 重放 ────────────────────────────────────────────────
const revInput = {
  artifactId: rem1.artifactId,
  statement: '用户已经完成幂等测试。',
  refs: [srcA],
  sourceIds: [srcA],
  opId: 'op-rev-1',
}
const rev1 = await core.revise(revInput)
const rev2 = await core.revise(revInput)
eq('revise 第二次是重放', rev2.replayed, true)
eq('revise 两次同一 revision', rev2.revision, rev1.revision)
eq(
  '该 Artifact 只有 2 个 revision',
  db.get(`SELECT count(*) AS n FROM artifact_revisions WHERE artifact_id = ?`, [rem1.artifactId]).n,
  2,
)

// ── IDEM-04：同 opId、不同 payload → 冲突 ───────────────────────────────
let conflictCode = null
try {
  await core.remember({ ...remInput, statement: '换了内容的同一 opId。' })
} catch (error) {
  conflictCode = error && typeof error === 'object' ? error.code : null
}
eq('同 opId 不同 payload 抛冲突', conflictCode, 'E_IDEMPOTENT_CONFLICT')

// ── IDEM-07：失败整笔回滚，不留半成品 ───────────────────────────────────
const beforeArtifacts = db.get(`SELECT count(*) AS n FROM artifacts`).n
let failureCode = null
try {
  await core.remember({
    text: '失败示例。',
    kind: 'fact',
    statement: '',
    sourceIds: [srcA],
    opId: 'op-fail-1',
  })
} catch (error) {
  failureCode = error && typeof error === 'object' ? error.code : null
}
eq('失败码是 E_VALIDATION', failureCode, 'E_VALIDATION')
eq('失败后 artifacts 数量不变', db.get(`SELECT count(*) AS n FROM artifacts`).n, beforeArtifacts)
const failedRow = db.get(`SELECT status, error FROM operations WHERE op_id = 'op-fail-1'`)
eq('failed 记录保留', failedRow?.status, 'failed')
ok('failed 记录带错误信息', Boolean(failedRow?.error))

// ── IDEM-10：操作历史可追溯（failed 与后续成功都留痕） ─────────────────
const retried = await core.remember({
  text: '修正后的结论。',
  kind: 'fact',
  statement: '用户在重试。',
  sourceIds: [srcA],
  opId: 'op-fail-2',
})
ok('换 opId 后成功', retried.ok === true && retried.replayed === false)
eq(
  'failed 与 ok 都留在 operations',
  db
    .all(`SELECT op_id, status FROM operations WHERE op_id IN ('op-fail-1', 'op-fail-2') ORDER BY op_id`)
    .map((row) => `${row.op_id}:${row.status}`),
  ['op-fail-1:failed', 'op-fail-2:ok'],
)

// ── IDEM-06：FTS upsert 重复执行不产生重复行 ─────────────────────────────
upsertFtsRow(db, { artifactId: rem1.artifactId, kind: 'fact', statement: '幂等测试用的结论。' })
upsertFtsRow(db, { artifactId: rem1.artifactId, kind: 'fact', statement: '幂等测试用的结论。' })
eq(
  'fts 只有一行',
  db.get(`SELECT count(*) AS n FROM fts_index WHERE ref_id = ?`, [rem1.artifactId]).n,
  1,
)

// ── IDEM-09：forget 重复提交幂等（同 opId） ─────────────────────────────
const forgetTarget = await core.remember({
  text: '稍后要遗忘的结论。',
  kind: 'fact',
  statement: '这是一条待遗忘的结论。',
  sourceIds,
  disclosure: 'public',
  opId: 'op-forget-target',
})
const forgotten1 = await core.forget({ artifactId: forgetTarget.artifactId, opId: 'op-forget-1' })
const forgotten2 = await core.forget({ artifactId: forgetTarget.artifactId, opId: 'op-forget-1' })
eq('forget 第二次重放', forgotten2.replayed, true)
eq('forget 两次同一 revision', forgotten2.revision, forgotten1.revision)
eq(
  '待遗忘 Artifact revision 只加一版',
  db.get(`SELECT count(*) AS n FROM artifact_revisions WHERE artifact_id = ?`, [forgetTarget.artifactId]).n,
  2,
)

// ── IDEM-05：双进程同 opId 竞争 ─────────────────────────────────────────
const childPath = join(process.cwd(), 'test', 'helpers', 'idem-child.mjs')
const barrier = join(dir, 'idem-barrier')
const resultA = join(dir, 'idem-a')
const resultB = join(dir, 'idem-b')
const opId = 'op-idem-cas'

function waitFor(predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error('等待子进程超时'))
      }
    }, 20)
  })
}

function waitExit(child) {
  return new Promise((resolve) => child.on('exit', resolve))
}

const childA = spawn(process.execPath, [childPath, dbFile, opId, barrier, resultA, JSON.stringify(sourceIds)], {
  stdio: ['ignore', 'ignore', 'pipe'],
})
const childB = spawn(process.execPath, [childPath, dbFile, opId, barrier, resultB, JSON.stringify(sourceIds)], {
  stdio: ['ignore', 'ignore', 'pipe'],
})
await waitFor(() => existsSync(`${resultA}.ready`) && existsSync(`${resultB}.ready`))
writeFileSync(barrier, 'go')
await Promise.all([waitExit(childA), waitExit(childB)])
const outcomeA = JSON.parse(readFileSync(`${resultA}.json`, 'utf8'))
const outcomeB = JSON.parse(readFileSync(`${resultB}.json`, 'utf8'))
const outcomes = [outcomeA, outcomeB]
eq('两个子进程都返回 ok', outcomes.map((item) => item.ok), [true, true])
eq(
  '恰好一个真正提交、一个重放',
  outcomes.filter((item) => item.replayed === false).length,
  1,
)
eq(
  '另一个是重放',
  outcomes.filter((item) => item.replayed === true).length,
  1,
)
eq('两个进程拿到同一 artifactId', outcomeA.artifactId, outcomeB.artifactId)
eq(
  '库里只有一条 Artifact',
  db.get(`SELECT count(*) AS n FROM artifacts WHERE artifact_id = ?`, [outcomeA.artifactId]).n,
  1,
)

try {
  db.close()
} catch {
  // ignore
}
rmSync(dir, { recursive: true, force: true })
console.log(`\n[idempotency] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
