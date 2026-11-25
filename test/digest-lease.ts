/**
 * P0-B2：摘要任务租约失效与可靠续排的行为锁（L1–L9 + 边界/竞争用例）。
 *
 * 零模型、临时库、可控时钟。判据来自第 49/8 轮外部评审的四点：
 *   1. 租约在写入点裁决：complete/fail 的条件 UPDATE 同时匹配 job、mode、running、
 *      本次 attempts、以及「库里 claimed_at + 租约 > now」；命中 0 行时零副作用。
 *   2. 只有本次实际提交才续排；资格（自动模式/绑定活动/项目 active）在规划写入的
 *      同一事务里复核。
 *   3. resumeDigestBacklog 本批做并接启动恢复；冻结证据是「提交成功 → 续排前中断 →
 *      重开同一库跑启动入口 → 恰好补一项；再次启动零新增」。
 *   4. 补租约边界（到期但无人重领）与同代次竞争（两个执行者持同一领取凭据）。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

import { migrate, openDatabase } from '../packages/core/dist/adapter.js'
import { resumeDigestOnStartup } from '../dist/lib/digest-resume.js'
import {
  DIGEST_LEASE_MS,
  claimDigestJob,
  completeDigestJob,
  enqueueDigestJob,
  failDigestJob,
  failDigestJobResult,
  planDigestJob,
  resumeDigestBacklog,
  successfulWatermark,
} from '../packages/core/dist/index.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}`)
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  }
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-digest-lease-'))
const file = join(dir, 'memory.sqlite3')
const opened = await openDatabase({ file, driverPreference: 'auto', logger: quiet })
const db = opened.db

const T0 = new Date('2026-11-24T00:00:00.000Z')
const LEASE = DIGEST_LEASE_MS
const at = (ms: number): Date => new Date(T0.getTime() + ms)

function iso(d: Date): string {
  return d.toISOString()
}

function countDigests(jobId?: string): number {
  const row =
    jobId === undefined
      ? db.get<{ n?: number }>(`SELECT COUNT(*) AS n FROM session_digests`)
      : db.get<{ n?: number }>(`SELECT COUNT(*) AS n FROM session_digests WHERE job_id = ?`, [jobId])
  return Number(row?.n ?? 0)
}

function countRangeJobs(bindingId: string): number {
  const row = db.get<{ n?: number }>(
    `SELECT COUNT(*) AS n FROM digest_jobs WHERE binding_id = ? AND mode = 'range'`,
    [bindingId],
  )
  return Number(row?.n ?? 0)
}

function jobRow(jobId: string): { status?: string; attempts?: number; claimed_at?: string | null } | undefined {
  return db.get<{ status?: string; attempts?: number; claimed_at?: string | null }>(
    `SELECT status, attempts, claimed_at FROM digest_jobs WHERE job_id = ?`,
    [jobId],
  )
}

function nextRangeJob(bindingId: string): { jobId: string; fromSeq: number; toSeq: number; status: string } | null {
  const row = db.get<{ job_id?: string; from_seq?: number; to_seq?: number; status?: string }>(
    `SELECT job_id, from_seq, to_seq, status FROM digest_jobs
      WHERE binding_id = ? AND mode = 'range' AND status IN ('pending','running')
      ORDER BY from_seq LIMIT 1`,
    [bindingId],
  )
  if (row === undefined || row.job_id === undefined) return null
  return {
    jobId: String(row.job_id),
    fromSeq: Number(row.from_seq ?? 0),
    toSeq: Number(row.to_seq ?? 0),
    status: String(row.status ?? ''),
  }
}

function seedTurns(sessionRef: string, fromTurn: number, count: number, tag: string): void {
  for (let i = fromTurn; i < fromTurn + count; i += 1) {
    const turnId = `turn-${i}`
    db.run(
      `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at, turn_id)
       VALUES (?, 'main', 'dsh-session', 'desktop', ?, 'user', 'message', ?, ?, ?, ?)`,
      [`src_${tag}${i}u`, sessionRef, `第 ${i} 轮说的话`, iso(T0), iso(T0), turnId],
    )
    db.run(
      `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at, turn_id)
       VALUES (?, 'main', 'dsh-session', 'desktop', ?, 'self', 'message', ?, ?, ?, ?)`,
      [`src_${tag}${i}a`, sessionRef, `第 ${i} 轮的回复`, iso(T0), iso(T0), turnId],
    )
  }
}

function seedProject(projectId: string, name: string): void {
  db.run(
    `INSERT INTO projects (project_id, persona_id, canonical_name, status, created_at, updated_at)
     VALUES (?, 'main', ?, 'active', ?, ?)`,
    [projectId, name, iso(T0), iso(T0)],
  )
}

function seedBinding(bindingId: string, projectId: string, sessionRef: string): void {
  db.run(
    `INSERT INTO project_session_bindings (
       binding_id, project_id, persona_id, platform, session_ref, grant_generation,
       committed_to_seq, bound_at
     ) VALUES (?, ?, 'main', 'desktop', ?, 'gen-1', 0, ?)`,
    [bindingId, projectId, sessionRef, iso(T0)],
  )
}

function seedAll(bindingId: string, projectId: string, sessionRef: string, turns: number, tag: string): void {
  seedProject(projectId, `${projectId} 项目`)
  seedBinding(bindingId, projectId, sessionRef)
  seedTurns(sessionRef, 1, turns, tag)
}

/**
 * 把「别的绑定」挪开，让领取/恢复只可能命中被测绑定。
 *
 * 领取与恢复都是跨绑定的，同一只库里会拿到前一条用例遗留的任务；这些用例要断言的是
 * 单条绑定上的行为，所以先把其余绑定解绑、把它们的在途任务收成终态。
 */
function isolate(bindingId: string, now: Date): void {
  db.run(`UPDATE project_session_bindings SET unbound_at = ? WHERE binding_id <> ? AND unbound_at IS NULL`, [
    iso(now),
    bindingId,
  ])
  db.run(
    `UPDATE digest_jobs SET status = 'succeeded', finished_at = ?, updated_at = ?
      WHERE binding_id <> ? AND status IN ('pending','running')`,
    [iso(now), iso(now), bindingId],
  )
}

/** 隔离后领取，并确认拿到的确实是被测绑定的任务。 */
function claimScoped(bindingId: string, now: Date): { jobId?: string; attempts?: number; bindingId?: string } | null {
  isolate(bindingId, now)
  const claimed = claimDigestJob({ db, now })
  if (claimed !== null) {
    assert.equal(claimed.bindingId, bindingId, '本次领取应命中被测绑定')
  }
  return claimed as { jobId?: string; attempts?: number; bindingId?: string } | null
}

/** 隔离后跑启动恢复，确保扫到的只有被测绑定。 */
function resumeScoped(bindingId: string, now: Date): { scanned: number; planned: number } {
  isolate(bindingId, now)
  return resumeDigestBacklog({ db, now, autoEnabled: true })
}

try {
  await migrate(db, quiet)

  // ── L1/L2：到期但无人重领时，complete 与 fail 都必须被拒 ────────────────────
  const L1B = 'bind_l1'
  const L1S = 'sess-l1'
  seedAll(L1B, 'proj_l1', L1S, 8, 'l1')

  await test('L1 到期未重领：complete 被拒，且零副作用', () => {
    enqueueDigestJob({ db, bindingId: L1B, fromSeq: 1, toSeq: 8, now: T0 })
    const claimed = claimScoped(L1B, T0)
    assert.notEqual(claimed, null, '应先领到任务')
    const jobId = String(claimed?.jobId)
    const late = completeDigestJob({
      db,
      jobId,
      attempts: claimed?.attempts ?? 0,
      bodyJson: JSON.stringify({ summary: 'late' }),
      sourceIds: [],
      now: at(LEASE + 1000),
      autoEnabled: true,
    })
    assert.equal(late.status, 'lease-lost', '过期后即使无人重领也不能提交')
    assert.equal(late.replan, 'skipped-not-committed', '没有实际提交就不该续排')
    assert.equal(countDigests(jobId), 0, '不该写入摘要')
    assert.equal(successfulWatermark(db, L1B), 0, '水位不能动')
    assert.equal(jobRow(jobId)?.status, 'running', '任务仍停在 running，等别人重领')
    assert.equal(countRangeJobs(L1B), 1, '不该新建任务')
  })

  await test('L1b 恰好到期即失效（claimed_at + lease == now）', () => {
    const jobId = String(nextRangeJob(L1B)?.jobId ?? '')
    assert.notEqual(jobId, '', '应能定位在途任务')
    const row = jobRow(jobId)
    const claimedAt = Date.parse(String(row?.claimed_at ?? ''))
    assert.ok(Number.isFinite(claimedAt), '库里应有领取时间')
    const boundary = completeDigestJob({
      db,
      jobId,
      attempts: Number(row?.attempts ?? 0),
      bodyJson: JSON.stringify({ summary: 'boundary' }),
      sourceIds: [],
      now: new Date(claimedAt + LEASE),
      autoEnabled: true,
    })
    assert.equal(boundary.status, 'lease-lost', '边界按「> now」判定，等于即失效')
    assert.equal(countDigests(jobId), 0)
  })

  const L2B = 'bind_l2'
  const L2S = 'sess-l2'
  seedAll(L2B, 'proj_l2', L2S, 8, 'l2')

  await test('L2 到期未重领：fail 被拒，任务与凭据都不变', () => {
    enqueueDigestJob({ db, bindingId: L2B, fromSeq: 1, toSeq: 8, now: T0 })
    const claimed = claimScoped(L2B, T0)
    const jobId = String(claimed?.jobId ?? '')
    const before = jobRow(jobId)
    const result = failDigestJobResult({
      db,
      jobId,
      attempts: claimed?.attempts ?? 0,
      errorCode: 'W1_LATE',
      now: at(LEASE + 1000),
    })
    assert.equal(result.status, 'lease-lost', '过期后的失败不能被记成 recorded')
    const after = jobRow(jobId)
    assert.equal(after?.status, 'running', '状态不能回 pending')
    assert.equal(after?.attempts, before?.attempts, 'attempts 不能变')
    assert.equal(after?.claimed_at, before?.claimed_at, 'claimed_at 不能变')
    assert.equal(failDigestJob({ db, jobId, attempts: claimed?.attempts ?? 0, errorCode: 'X', now: at(LEASE + 1000) }), false, '布尔包装同步为 false')
  })

  await test('L2b W2 已重领：W1 调 fail 被拒，W2 的状态、代次、领取时间与退避都不变', () => {
    const L2C = 'bind_l2c'
    seedAll(L2C, 'proj_l2c', 'sess-l2c', 8, 'l2c')
    enqueueDigestJob({ db, bindingId: L2C, fromSeq: 1, toSeq: 8, now: T0 })
    const w1 = claimScoped(L2C, T0)
    const jobId = String(w1?.jobId ?? '')
    // W1 的租约过期后 W2 重领：attempts 2、claimed_at 推到 W2 的领取时刻。
    const w2 = claimScoped(L2C, at(LEASE + 1000))
    assert.equal(w2?.attempts, 2, '应被重领成第 2 代')
    const before = jobRow(jobId)
    assert.equal(before?.attempts, 2)

    const late = failDigestJobResult({
      db,
      jobId,
      attempts: w1?.attempts ?? 0, // W1 拿的是第 1 代凭据
      errorCode: 'W1_LATE_FAIL',
      nextRetryAt: at(LEASE + 9000),
      now: at(LEASE + 2000),
    })
    assert.equal(late.status, 'lease-lost', '旧代次的失败不能记进别人的任务')

    const after = jobRow(jobId)
    assert.equal(after?.status, 'running', 'W2 仍在跑，状态不能回 pending')
    assert.equal(after?.attempts, 2, '代次不能被旧持有者改动')
    assert.equal(after?.claimed_at, before?.claimed_at, 'W2 的领取时间不能被覆盖')
    const retry = db.get<{ next_retry_at?: string | null }>(
      `SELECT next_retry_at FROM digest_jobs WHERE job_id = ?`,
      [jobId],
    )
    assert.equal(retry?.next_retry_at ?? null, null, 'W1 传的退避时间不能落到 W2 的行上')
  })

  // ── L3：被重领后，旧持有者的迟到写回全部无效 ────────────────────────────────
  const L3B = 'bind_l3'
  const L3S = 'sess-l3'
  seedAll(L3B, 'proj_l3', L3S, 24, 'l3')

  await test('L3 重领后：只有一次实际提交，一个摘要、一次水位推进、至多一个后续', () => {
    enqueueDigestJob({ db, bindingId: L3B, fromSeq: 1, toSeq: 8, now: T0 })
    const w1 = claimScoped(L3B, T0)
    assert.equal(w1?.attempts, 1)
    const w2 = claimScoped(L3B, at(LEASE + 1000))
    assert.equal(w2?.attempts, 2, '过期后应被重领')
    const jobId = String(w2?.jobId ?? '')

    const late = completeDigestJob({
      db,
      jobId,
      attempts: 1,
      bodyJson: JSON.stringify({ summary: 'w1' }),
      sourceIds: [],
      now: at(LEASE + 2000),
      autoEnabled: true,
    })
    assert.equal(late.status, 'lease-lost', '旧代次写回必须被拒')

    const done = completeDigestJob({
      db,
      jobId,
      attempts: 2,
      bodyJson: JSON.stringify({ summary: 'w2' }),
      sourceIds: [],
      now: at(LEASE + 2000),
      autoEnabled: true,
    })
    assert.equal(done.status, 'completed')
    assert.equal(done.replan, 'planned', '还有 16 轮素材，应续排下一批')
    const successor = nextRangeJob(L3B)
    assert.equal(successor?.fromSeq, 9, '下一批从水位之后开始')
    assert.equal(successor?.toSeq, 24, '区间右端 = 水位 8 + 剩余 16 轮')
    assert.equal(countDigests(jobId), 1, '一个 job 只该有一条摘要')
    assert.equal(successfulWatermark(db, L3B), 8, '水位推进到 8 且只推进一次')

    const replay = completeDigestJob({
      db,
      jobId,
      attempts: 2,
      bodyJson: JSON.stringify({ summary: 'w2-again' }),
      sourceIds: [],
      now: at(LEASE + 3000),
      autoEnabled: true,
    })
    assert.equal(replay.status, 'replayed', '同代次重复提交是重放')
    assert.equal(replay.replan, 'skipped-not-committed', '重放不续排')
    assert.equal(countDigests(jobId), 1, '重放不新增摘要')
    assert.equal(successfulWatermark(db, L3B), 8, '重放不动水位')
    assert.equal(countRangeJobs(L3B), 2, '总共只有 [1,8] 与 [9,16] 两条')
  })

  await test('L4 无新消息但库里还有积压：提交后自动补出下一批', () => {
    const next = nextRangeJob(L3B)
    assert.notEqual(next, null, '续排应留下下一批任务')
    assert.equal(next?.fromSeq, 9)
    assert.equal(next?.toSeq, 24)
    // 再规划一次不应新增（幂等）。
    const planned = planDigestJob({ db, bindingId: L3B, sessionRef: L3S, now: at(LEASE + 4000) })
    assert.equal(planned.status, 'below-threshold', '手上已有在途任务时不再开新的')
    assert.equal(countRangeJobs(L3B), 2)
  })

  // ── L5/L6：提交成功但续排前中断，重启后恰好补一项；续排异常留诊断 ────────────
  const L5B = 'bind_l5'
  const L5S = 'sess-l5'
  seedAll(L5B, 'proj_l5', L5S, 24, 'l5')

  await test('L5/L6 续排抛错：摘要保留、replan 为 failed，重启恢复恰好补一项', () => {
    enqueueDigestJob({ db, bindingId: L5B, fromSeq: 1, toSeq: 8, now: T0 })
    const claimed = claimScoped(L5B, T0)
    const jobId = String(claimed?.jobId ?? '')

    // 让提交事务照常执行、续排事务抛错：第一次 transaction 放行，之后都炸。
    let transactions = 0
    const flaky = {
      get: db.get.bind(db),
      all: db.all.bind(db),
      run: db.run.bind(db),
      transaction<T>(fn: () => T): T {
        transactions += 1
        if (transactions > 1) throw new Error('replan boom')
        return db.transaction(fn)
      },
    }

    const done = completeDigestJob({
      db: flaky,
      jobId,
      attempts: claimed?.attempts ?? 0,
      bodyJson: JSON.stringify({ summary: 'l5' }),
      sourceIds: [],
      now: at(1000),
      autoEnabled: true,
    })
    assert.equal(done.status, 'completed', '续排失败不影响本次提交')
    assert.equal(done.replan, 'failed', '续排异常必须暴露出来')
    assert.ok(String(done.replanError ?? '').includes('replan boom'), '错误文本要能定位原因')
    assert.equal(countDigests(jobId), 1, '摘要已经提交，不该回滚')
    assert.equal(successfulWatermark(db, L5B), 8, '水位已经推进')
    assert.equal(countRangeJobs(L5B), 1, '续排失败后确认没有下一批')

    // 重启恢复：同一库、同一启动入口。
    const resumed = resumeScoped(L5B, at(2000))
    assert.equal(resumed.planned, 1, '应补出恰好一项')
    const successor = nextRangeJob(L5B)
    assert.equal(successor?.fromSeq, 9, '补出的正是缺的那一批')
    assert.equal(countRangeJobs(L5B), 2)

    const again = resumeScoped(L5B, at(3000))
    assert.equal(again.planned, 0, '第二次启动零新增')
    assert.equal(countRangeJobs(L5B), 2)
  })

  // ── L7：两个执行者同时恢复，不重复建任务 ────────────────────────────────────
  const L7B = 'bind_l7'
  const L7S = 'sess-l7'
  seedAll(L7B, 'proj_l7', L7S, 16, 'l7')

  await test('L7 两条连接同时恢复：同一区间只建一条', () => {
    const second = openDatabaseSync(file)
    try {
      const a = resumeScoped(L7B, at(1000))
      const b = resumeDigestBacklog({ db: second, now: at(1000), autoEnabled: true })
      assert.equal(a.planned + b.planned, 1, '两条连接合计只该规划出一条')
      assert.equal(countRangeJobs(L7B), 1, '表里只有一条')
    } finally {
      second.close()
    }
  })

  // ── L8：关闭自动模式 / 解绑 / 项目归档，迟到回调不得新建任务 ─────────────────
  const L8A = 'bind_l8a'
  seedAll(L8A, 'proj_l8a', 'sess-l8a', 16, 'l8a')
  const L8B = 'bind_l8b'
  seedAll(L8B, 'proj_l8b', 'sess-l8b', 16, 'l8b')
  const L8C = 'bind_l8c'
  seedAll(L8C, 'proj_l8c', 'sess-l8c', 16, 'l8c')

  await test('L8 自动模式关闭 / 已解绑 / 项目归档时都不续排', () => {
    // a) 自动模式关闭
    enqueueDigestJob({ db, bindingId: L8A, fromSeq: 1, toSeq: 8, now: T0 })
    const a = claimScoped(L8A, T0)
    const doneA = completeDigestJob({
      db,
      jobId: String(a?.jobId ?? ''),
      attempts: a?.attempts ?? 0,
      bodyJson: '{}',
      sourceIds: [],
      now: at(1000),
      autoEnabled: false,
    })
    assert.equal(doneA.status, 'completed')
    assert.equal(doneA.replan, 'skipped-inactive', '自动模式关着就不该续排')
    assert.equal(countRangeJobs(L8A), 1, '没有新任务')

    // b) 已解绑
    db.run(`UPDATE project_session_bindings SET unbound_at = ? WHERE binding_id = ?`, [iso(at(500)), L8B])
    enqueueDigestJob({ db, bindingId: L8B, fromSeq: 1, toSeq: 8, now: T0 })
    const b = claimScoped(L8B, T0)
    const doneB = completeDigestJob({
      db,
      jobId: String(b?.jobId ?? ''),
      attempts: b?.attempts ?? 0,
      bodyJson: '{}',
      sourceIds: [],
      now: at(1000),
      autoEnabled: true,
    })
    assert.equal(doneB.replan, 'skipped-inactive', '解绑后不该续排')
    assert.equal(countRangeJobs(L8B), 1)

    // c) 项目归档
    db.run(`UPDATE projects SET status = 'archived' WHERE project_id = 'proj_l8c'`)
    enqueueDigestJob({ db, bindingId: L8C, fromSeq: 1, toSeq: 8, now: T0 })
    const c = claimScoped(L8C, T0)
    const doneC = completeDigestJob({
      db,
      jobId: String(c?.jobId ?? ''),
      attempts: c?.attempts ?? 0,
      bodyJson: '{}',
      sourceIds: [],
      now: at(1000),
      autoEnabled: true,
    })
    assert.equal(doneC.replan, 'skipped-inactive', '项目归档后不该续排')
    assert.equal(countRangeJobs(L8C), 1)
  })

  // ── L9：manual 任务不参与自动语义 ──────────────────────────────────────────
  const L9B = 'bind_l9'
  seedAll(L9B, 'proj_l9', 'sess-l9', 16, 'l9')

  await test('L9 manual 任务混入时，自动领取、规划与水位都不受影响', () => {
    db.run(
      `INSERT INTO digest_jobs (job_id, binding_id, from_seq, to_seq, algorithm_version, status, attempts, mode, created_at, updated_at)
       VALUES ('djob_manual_1', ?, 1, 4, 'digest-v1', 'pending', 0, 'manual', ?, ?)`,
      [L9B, iso(T0), iso(T0)],
    )
    const claimed = claimScoped(L9B, T0)
    // 领取会跳过 manual：可能拿到别的绑定遗留的 expired range 任务，但绝不能是这条 manual。
    assert.notEqual(claimed?.jobId ?? '', 'djob_manual_1', '自动领取不能碰 manual 任务')
    const manualAfterClaim = db.get<{ status?: string; attempts?: number }>(
      `SELECT status, attempts FROM digest_jobs WHERE job_id = 'djob_manual_1'`,
    )
    assert.equal(manualAfterClaim?.status, 'pending', 'manual 任务不会被自动领取改动状态')
    assert.equal(manualAfterClaim?.attempts, 0, 'manual 任务的 attempts 也不该被改')

    const planned = planDigestJob({ db, bindingId: L9B, sessionRef: 'sess-l9', now: T0 })
    assert.equal(planned.status, 'ready', '有 16 轮素材，应规划出自动任务')
    assert.equal(planned.job?.toSeq, 16)
    const auto = nextRangeJob(L9B)
    assert.notEqual(auto, null)
    const manual = db.get<{ status?: string }>(`SELECT status FROM digest_jobs WHERE job_id = 'djob_manual_1'`)
    assert.equal(manual?.status, 'pending', 'manual 任务状态不被自动路径改动')
  })

  // ── 竞争用例：两个执行者持同一领取凭据 ──────────────────────────────────────
  const CB = 'bind_compete'
  seedAll(CB, 'proj_compete', 'sess-compete', 24, 'cmp')

  await test('同代次竞争：两条连接持同一凭据，只有一次实际提交', () => {
    enqueueDigestJob({ db, bindingId: CB, fromSeq: 1, toSeq: 8, now: T0 })
    const claimed = claimScoped(CB, T0)
    const jobId = String(claimed?.jobId ?? '')
    const attempts = claimed?.attempts ?? 0
    const other = openDatabaseSync(file)
    try {
      const first = completeDigestJob({
        db,
        jobId,
        attempts,
        bodyJson: JSON.stringify({ summary: 'first' }),
        sourceIds: [],
        now: at(500),
        autoEnabled: true,
      })
      const second = completeDigestJob({
        db: other,
        jobId,
        attempts,
        bodyJson: JSON.stringify({ summary: 'second' }),
        sourceIds: [],
        now: at(600),
        autoEnabled: true,
      })
      assert.equal(first.status, 'completed')
      assert.equal(second.status, 'replayed', '第二个执行者只能看到重放')
      assert.equal(countDigests(jobId), 1, '只该有一条摘要')
      assert.equal(successfulWatermark(db, CB), 8, '水位只推进一次')
      assert.equal(countRangeJobs(CB), 2, '至多一个后续任务')
    } finally {
      other.close()
    }
  })

  await test('L11 租期没有入口参数：第 31 秒（短于 5 分钟）仍可按固定租期提交', () => {
    const L11B = 'bind_l11'
    seedAll(L11B, 'proj_l11', 'sess-l11', 8, 'l11')
    enqueueDigestJob({ db, bindingId: L11B, fromSeq: 1, toSeq: 8, now: T0 })
    const claimed = claimScoped(L11B, T0)
    const jobId = String(claimed?.jobId ?? '')
    // 领取后 30 秒就提交：仍在 5 分钟租期内，应当成功——证明租期是领取时定死的，
    // 不存在「领取用短租期、完成按长租期」这类可被调用方操纵的入口。
    const early = completeDigestJob({
      db,
      jobId,
      attempts: claimed?.attempts ?? 0,
      bodyJson: JSON.stringify({ summary: 'l11' }),
      sourceIds: [],
      now: at(30_000),
      autoEnabled: true,
    })
    assert.equal(early.status, 'completed', '租期内提交必须成功')
    assert.equal(countDigests(jobId), 1)
  })
  await test('L10 启动入口跨进程重开库：恰好补一条，再启动零新增', async () => {
    // 这条用例走的是 `src/index.ts` 启动时真正调用的那个函数
    // （`src/lib/digest-resume.ts` 的 `resumeDigestOnStartup`），而不是直接调
    // `resumeDigestBacklog()`——后者只能证明恢复函数有效，证明不了接线。
    const startupDir = mkdtempSync(join(tmpdir(), 'psyche-digest-startup-'))
    const startupFile = join(startupDir, 'memory.sqlite3')
    try {
      // ── 第一次打开：造出「摘要已提交、后继任务没建出来」的中断态 ───────────
      const first = await openDatabase({ file: startupFile, driverPreference: 'auto', logger: quiet })
      await migrate(first.db, quiet)
      const s = (
        sql: string,
        params: readonly unknown[],
      ): void => {
        first.db.run(sql, params)
      }
      s(`INSERT INTO projects (project_id, persona_id, canonical_name, status, created_at, updated_at)
         VALUES ('proj_l10', 'main', 'L10 项目', 'active', ?, ?)`, [iso(T0), iso(T0)])
      s(`INSERT INTO project_session_bindings (
           binding_id, project_id, persona_id, platform, session_ref, grant_generation,
           committed_to_seq, bound_at
         ) VALUES ('bind_l10', 'proj_l10', 'main', 'desktop', 'sess-l10', 'gen-1', 0, ?)`, [iso(T0)])
      for (let i = 1; i <= 24; i += 1) {
        const turnId = `turn-l10-${i}`
        s(`INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at, turn_id)
           VALUES (?, 'main', 'dsh-session', 'desktop', 'sess-l10', 'user', 'message', ?, ?, ?, ?)`,
          [`src_l10${i}u`, `第 ${i} 轮说的话`, iso(T0), iso(T0), turnId])
        s(`INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at, turn_id)
           VALUES (?, 'main', 'dsh-session', 'desktop', 'sess-l10', 'self', 'message', ?, ?, ?, ?)`,
          [`src_l10${i}a`, `第 ${i} 轮的回复`, iso(T0), iso(T0), turnId])
      }
      enqueueDigestJob({ db: first.db, bindingId: 'bind_l10', fromSeq: 1, toSeq: 8, now: T0 })
      const claimed = claimDigestJob({ db: first.db, now: T0 })
      assert.equal(claimed?.bindingId, 'bind_l10', '应领到 L10 的任务')

      // 续排抛错：模拟「摘要已提交、后继没建」的中断点。
      let transactions = 0
      const flaky = {
        get: first.db.get.bind(first.db),
        all: first.db.all.bind(first.db),
        run: first.db.run.bind(first.db),
        transaction<T>(fn: () => T): T {
          transactions += 1
          if (transactions > 1) throw new Error('startup boom')
          return first.db.transaction(fn)
        },
      }
      const done = completeDigestJob({
        db: flaky,
        jobId: String(claimed?.jobId ?? ''),
        attempts: claimed?.attempts ?? 0,
        bodyJson: JSON.stringify({ summary: 'l10' }),
        sourceIds: [],
        now: at(1000),
        autoEnabled: true,
      })
      assert.equal(done.status, 'completed')
      assert.equal(done.replan, 'failed', '续排被中断')
      first.db.close?.()

      // ── 第二次打开：走宿主启动入口，恰好补一条 ─────────────────────────────
      const second = await openDatabase({ file: startupFile, driverPreference: 'auto', logger: quiet })
      const resumed = resumeDigestOnStartup({ db: second.db, now: at(2000), log: null })
      assert.notEqual(resumed, null, '启动入口不该整体失败')
      assert.equal(resumed?.planned, 1, '恰好补出一条')
      const successor = second.db.get<{ from_seq?: number; status?: string }>(
        `SELECT from_seq, status FROM digest_jobs
          WHERE binding_id = 'bind_l10' AND status IN ('pending','running')
          ORDER BY from_seq LIMIT 1`,
      )
      assert.equal(Number(successor?.from_seq), 9, '补出的正是缺的那一批')
      second.db.close?.()

      // ── 第三次打开：再启动零新增 ────────────────────────────────────────────
      const third = await openDatabase({ file: startupFile, driverPreference: 'auto', logger: quiet })
      const again = resumeDigestOnStartup({ db: third.db, now: at(3000), log: null })
      assert.equal(again?.planned, 0, '第二次启动零新增')
      const total = third.db.get<{ n?: number }>(
        `SELECT COUNT(*) AS n FROM digest_jobs WHERE binding_id = 'bind_l10' AND mode = 'range'`,
      )
      assert.equal(Number(total?.n ?? 0), 2, '库里只有原始一条 + 补出的一条')
      third.db.close?.()
    } finally {
      rmSync(startupDir, { recursive: true, force: true })
    }
  })

  await test('L5b 启动入口对「无绑定/无素材」是零写入', async () => {
    // 用一只全新的库验证：没有绑定、没有素材时，启动入口不做任何写入。
    const emptyDir = mkdtempSync(join(tmpdir(), 'psyche-digest-empty-'))
    const emptyOpened = await openDatabase({
      file: join(emptyDir, 'memory.sqlite3'),
      driverPreference: 'auto',
      logger: quiet,
    })
    try {
      await migrate(emptyOpened.db, quiet)
      const empty = resumeDigestBacklog({ db: emptyOpened.db, now: at(9000), autoEnabled: true })
      assert.equal(empty.scanned, 0, '没有活动绑定就没什么可扫')
      assert.equal(empty.planned, 0, '没有素材就不该新建任务')
      const jobs = emptyOpened.db.get<{ n?: number }>(`SELECT COUNT(*) AS n FROM digest_jobs`)
      assert.equal(Number(jobs?.n ?? -1), 0, '库里不该出现任何任务')
    } finally {
      emptyOpened.db.close?.()
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  console.log(`\n[digest-lease] ${passed} 通过 / ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
} finally {
  db.close?.()
  rmSync(dir, { recursive: true, force: true })
}

/** 同步打开第二个连接（只读契约之外的最小封装，避免异步 await 打断用例结构）。 */
function openDatabaseSync(path: string): {
  get<T>(sql: string, params?: readonly unknown[]): T | undefined
  all<T>(sql: string, params?: readonly unknown[]): readonly T[]
  run(sql: string, params?: readonly unknown[]): { changes: number }
  transaction<T>(fn: () => T): T
  close(): void
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const raw = new Database(path, { timeout: 5000 })
  raw.pragma('journal_mode = WAL')
  return {
    get: (sql, params) => raw.prepare(sql).get(...(params ?? [])),
    all: (sql, params) => raw.prepare(sql).all(...(params ?? [])),
    run: (sql, params) => {
      const info = raw.prepare(sql).run(...(params ?? []))
      return { changes: Number(info.changes ?? 0) }
    },
    transaction: (fn) => raw.transaction(fn)(),
    close: () => raw.close(),
  }
}
