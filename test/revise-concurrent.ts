// 双进程并发 revise：两个写入者基于同一 expectedRevision 同时改同一条结论。
//
// 验收（E3 CON-02）：
// 1. 恰好一个成功，另一个拿到 E_REVISION_CONFLICT；
// 2. head 只前进一版（不产生两个 head、不互相覆盖）；
// 3. 失败的一方没有落任何 revision。
//
// 跑法：node test/revise-concurrent.ts（需要先 npm run build）
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

const dir = mkdtempSync(join(tmpdir(), 'psyche-revise-concurrent-'))
const file = join(dir, 'memory.sqlite3')
const log = { info() {}, debug() {}, warn() {}, error() {} }

console.log('\n[P2-FTS5 E3] 并发 revise')

// ── 父进程建库、造一条 fact ───────────────────────────────────────────
const opened = await openDatabase({ file, driverPreference: 'auto', logger: log })
migrate(opened.db, log)
const core = new Core({ db: opened.db, config: {}, logger: log, dataDir: dir })
const source = async (text) =>
  (
    await core.capture({
      platform: 'dsh',
      channel: 'desktop',
      sessionRef: 'revise-concurrent',
      origin: 'user',
      kind: 'message',
      text,
    })
  ).sourceId
const s1 = await source('并发测试来源一')
const s2 = await source('并发测试来源二')
const fact = await core.remember({
  text: '这条结论会被两个写入者同时改。',
  kind: 'fact',
  statement: '这条结论会被两个写入者同时改。',
  sourceIds: [s1],
  confidence: 'high',
})
if (!fact.artifactId) throw new Error('fact 没有升格，无法测并发 revise')
const artifactId = fact.artifactId
const before = opened.db.get(`SELECT revision FROM artifact_revisions WHERE artifact_id = ? ORDER BY revision DESC LIMIT 1`, [
  artifactId,
])
eq('起点 revision', before.revision, 1)
opened.db.close()

// ── 两个子进程同时基于 r1 revise ─────────────────────────────────────
const child = resolve('test/helpers/revise-child.mjs')
const barrier = join(dir, 'barrier')
const resultA = join(dir, 'result-a.json')
const resultB = join(dir, 'result-b.json')
const readyA = `${resultA}.ready`
const readyB = `${resultB}.ready`

const runChild = (result, statement) =>
  spawn(process.execPath, [child, file, String(dir), artifactId, '1', statement, barrier, result], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
const childA = runChild(resultA, '并发改法 A：改成阿岚喜欢白茶。')
const childB = runChild(resultB, '并发改法 B：改成阿岚喜欢黑茶。')

async function waitFor(path, timeoutMs = 15000) {
  const started = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${path}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
await waitFor(readyA)
await waitFor(readyB)

const { readFileSync } = await import('node:fs')
writeFileSync(barrier, 'go')
await Promise.all([childA, childB].map((proc) => new Promise((resolve) => proc.on('exit', resolve))))

const readResult = (path) => JSON.parse(readFileSync(path, 'utf8'))
const a = readResult(resultA)
const b = readResult(resultB)

const succeeded = [a, b].filter((item) => item.ok)
const failedOnes = [a, b].filter((item) => !item.ok)
eq('恰好一个成功', succeeded.length, 1)
eq('另一个是版本冲突', failedOnes[0]?.code, 'E_REVISION_CONFLICT')

// ── 库里只有一版新 revision，没有双 head ─────────────────────────────
const reopened = await openDatabase({ file, driverPreference: 'auto', logger: log })
const revisions = reopened.db.all(
  `SELECT revision, state FROM artifact_revisions WHERE artifact_id = ? ORDER BY revision`,
  [artifactId],
)
eq('revision 只前进一版', revisions.map((row) => row.revision), [1, 2])
const winner = succeeded[0]
eq('成功者的 revision 是 2', winner.revision, 2)
eq(
  '失败者没有留下半条 revision',
  reopened.db.get(`SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id = ? AND revision > 2`, [artifactId]).n,
  0,
)
// 文本等于赢家的说法（后到的没有覆盖先到的）
const head = reopened.db.get(
  `SELECT statement FROM artifact_revisions WHERE artifact_id = ? ORDER BY revision DESC LIMIT 1`,
  [artifactId],
)
const expectedText = winner.statement
eq('head 文本是赢家那句', head.statement, expectedText)

console.log(`\n[P2-FTS5 E3] 并发 revise：${passed} 通过 ${failed} 失败`)
reopened.db.close()
rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
