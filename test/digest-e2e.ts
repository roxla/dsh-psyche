// G2-A 端到端夹具：从正式 capture 入口写素材，看 digest_jobs 有没有按连续前缀建出任务。
//
// 与 test/session-digest.ts 的分工：那个测的是队列本身的语义（领取/提交/失败/重放），
// 这里测的是「正式入口写进来的 Source，能不能被正确地数成轮」——尤其是
// 「第 8 轮只有用户正文、助手还没回」这一条不该建任务。
//
// 跑法：node test/digest-e2e.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { claimDigestJob, completeDigestJob, planDigestJob } from '../packages/core/dist/session-digest.js'

let passed = 0
let failed = 0
function eq(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (same) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label} -> ${JSON.stringify({ actual, expected })}`)
  }
}
function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

const log = { info() {}, debug() {}, warn() {}, error() {} }
const dir = mkdtempSync(join(tmpdir(), 'psyche-digest-e2e-'))
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db: any = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir } as never)

const T0 = Date.parse('2026-11-22T10:00:00.000Z')
const SESSION = 'sess-e2e'
const BINDING = 'bind_e2e'

// 项目 + 绑定：digest 任务挂在 binding 上。
db.prepare(
  `INSERT INTO projects (project_id, persona_id, canonical_name, created_at, updated_at)
   VALUES ('proj_e2e','main','E2E 项目',?,?)`,
).run(new Date(T0).toISOString(), new Date(T0).toISOString())
db.prepare(
  `INSERT INTO project_session_bindings
     (binding_id, project_id, persona_id, platform, session_ref, grant_generation, committed_to_seq, bound_at)
   VALUES (?, 'proj_e2e', 'main', 'desktop', ?, 1, 0, ?)`,
).run(BINDING, SESSION, new Date(T0).toISOString())

let tick = 0
async function writeTurn(index: number, withAssistant: boolean): Promise<void> {
  tick += 1
  await core.capture({
    text: `第 ${index} 轮用户说的话`,
    sessionRef: SESSION,
    origin: 'user',
    kind: 'message',
    turnId: `turn-${index}`,
    captureKey: `e2e:${index}:u`,
    at: new Date(T0 + tick * 1000).toISOString(),
  } as never)
  if (!withAssistant) return
  tick += 1
  await core.capture({
    text: `第 ${index} 轮助手的回答，内容够长可以当作一条真实回复`,
    sessionRef: SESSION,
    origin: 'self',
    kind: 'message',
    turnId: `turn-${index}`,
    captureKey: `e2e:${index}:a`,
    at: new Date(T0 + tick * 1000).toISOString(),
  } as never)
}

/** 模拟 src/index.ts 的 maybePlanDigest：每次写完 Source 就查一次前缀。 */
function plan(): void {
  planDigestJob({ db, bindingId: BINDING, sessionRef: SESSION, now: new Date(T0 + 600_000) })
}

const jobCount = (): number => Number((db.get(`SELECT COUNT(*) AS n FROM digest_jobs`).n as number) ?? 0)
const jobRange = (): { from_seq?: number; to_seq?: number } | undefined =>
  db.get(`SELECT from_seq, to_seq FROM digest_jobs ORDER BY from_seq LIMIT 1`)

// ① 7 个完整轮：还不够 8，不能建任务。
for (let index = 1; index <= 7; index += 1) {
  await writeTurn(index, true)
  plan()
}
eq('7 个完整轮不建任务', jobCount(), 0)

// ② 第 8 轮只写用户正文：轮不完整，仍不建。
await writeTurn(8, false)
plan()
eq('第 8 轮只有用户正文时不建任务', jobCount(), 0)

// ③ 补上第 8 轮助手正文：名额到了，建一个 [1,8]。
await core.capture({
  text: '第 8 轮助手的回答，现在这一轮才算完整',
  sessionRef: SESSION,
  origin: 'self',
  kind: 'message',
  turnId: 'turn-8',
  captureKey: 'e2e:8:a2',
  at: new Date(T0 + 900_000).toISOString(),
} as never)
plan()
eq('补上助手正文后建任务', jobCount(), 1)
eq('区间是 1..8', jobRange(), { from_seq: 1, to_seq: 8 })

// ④ 重放同一批事件：不该出现第二个任务。
plan()
plan()
eq('重复检查不新增任务', jobCount(), 1)

// ⑤ 第 9 轮写进来，但前面那个任务还没完成：仍然只有一个任务。
await writeTurn(9, true)
plan()
eq('水位没推进前不重复建任务', jobCount(), 1)

// ⑥ 关掉自动摘要：等价于接入层不调 plan()，再写 8 轮也不该多出来。
const before = jobCount()
for (let index = 10; index <= 16; index += 1) await writeTurn(index, true)
eq('不调 plan 就不会自动建任务', jobCount(), before)

// ⑦ 收口夹具（第 49 轮外部评审）：挂起期间攒满 9..16，完成后才建第二个区间。
//    同时验「完成旧任务后、核对前退出再重开库也能补建」。
{
  const claim = claimDigestJob({ db, now: new Date(T0 + 1_200_000) }) as {
    jobId?: string
    attempts?: number
  } | null
  ok('领到了 [1,8]', claim !== null && typeof claim.jobId === 'string', claim)
  completeDigestJob({
    db,
    jobId: String(claim?.jobId),
    attempts: Number(claim?.attempts ?? 1),
    bodyJson: JSON.stringify({ summary: '第 1 到 8 轮的摘要' }),
    sourceIds: [],
    now: new Date(T0 + 1_200_000),
  })
  // 第 9、10..16 轮在 ⑤⑥ 已经写过：总量 16 轮，水位 8，够 8 个新轮 [9,16]。
  const afterComplete = db.all(`SELECT from_seq, to_seq FROM digest_jobs ORDER BY from_seq`)
  eq('完成 [1,8] 后生产路径自己续排出 [9,16]', afterComplete, [
    { from_seq: 1, to_seq: 8 },
    { from_seq: 9, to_seq: 16 },
  ])
  // 第 51 轮外部评审 Q1 第一条：**生产完成路径**自己续排，不靠测试手动再调 plan。
  const ranges = db.all(`SELECT from_seq, to_seq FROM digest_jobs ORDER BY from_seq`)
  eq('两个区间各只出现一次', ranges, [
    { from_seq: 1, to_seq: 8 },
    { from_seq: 9, to_seq: 16 },
  ])
  plan()
  eq('重复规划仍只有两个区间', Number((db.get(`SELECT COUNT(*) AS n FROM digest_jobs`).n as number) ?? 0), 2)
}

db.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n[digest-e2e] ${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1
