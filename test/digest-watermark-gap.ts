/**
 * 第 52 轮外部评审 P0-B（第 1 轮裁定：改 ② ④）：水位读数取「连续前缀」，规划不跨越已完成区间。
 *
 * 背景：`completeDigestJob` 早就按连续前缀推 `project_session_bindings.committed_to_seq`
 * （`test/session-digest.ts` 的 G2-A-10 锁的是那条写路径）。但读水位的
 * `successfulWatermark` 原来用 `SELECT MAX(to_seq) FROM digest_jobs`，于是
 * 「[17,24] 成功、[9,16] 还在退避」时，读取方看到 24，`planDigestJob` 从第 25 轮
 * 开始规划，[9,16] 那 8 轮再也不会被摘要。
 *
 * 这个夹具按评审给的 G1–G5 收紧：
 *   G1 新绑定读数是 0；
 *   G2 `[1,8]` 完成后读数是 8；
 *   G3 乱序成功的 `[17,24]` 不让读数越过空洞，规划从 9 开始、到 16 结束；
 *   G4 `[9,16]` 用 `no_change` 补完 → 三处读数都是 24；再把 `[25,40]` 跑完 → 都是 40；
 *   G5 租约过期的 manual running 不被领取；manual succeeded 与连续前缀相邻时也不推水位。
 *
 * 另外盯住「先成功后补洞」不能因空洞不足一个窗口而永久卡住（G4 的语义）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrate, openDatabase } from '../packages/core/dist/adapter.js'
import {
  claimDigestJob,
  completeDigestJob,
  enqueueDigestJob,
  pendingDigestCount,
  planDigestJob,
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

const dir = mkdtempSync(join(tmpdir(), 'psyche-digest-gap-'))
const file = join(dir, 'memory.sqlite3')
const opened = await openDatabase({ file, driverPreference: 'auto', logger: quiet })
const db = opened.db

const NOW = new Date('2026-11-23T12:00:00.000Z')
const iso = NOW.toISOString()
const BINDING = 'bind_gap_read'
const SESSION = 'sess-gap-read'
const PREFIX_BINDING = 'bind_gap_prefix'
const PREFIX_SESSION = 'sess-gap-prefix'
const SHORT_BINDING = 'bind_gap_short'
const SHORT_SESSION = 'sess-gap-short'
const THRESHOLD_BINDING = 'bind_gap_threshold'
const THRESHOLD_SESSION = 'sess-gap-threshold'

function bindingWatermark(bindingId: string): number {
  const row = db.get<{ committed_to_seq?: number }>(
    `SELECT committed_to_seq FROM project_session_bindings WHERE binding_id = ?`,
    [bindingId],
  )
  return Number(row?.committed_to_seq ?? 0)
}

function claimAndComplete(
  bindingId: string,
  jobId: string,
  outcome: 'succeeded' | 'no_change' = 'succeeded',
): void {
  const claimed = claimDigestJob({ db, jobId, now: NOW })
  assert.notEqual(claimed, null, `任务 ${jobId} 应该能领到`)
  const done = completeDigestJob({
    db,
    jobId,
    attempts: claimed?.attempts ?? 0,
    bodyJson: JSON.stringify({ summary: jobId }),
    sourceIds: [],
    outcome,
    now: NOW,
  })
  assert.equal(done.status, 'completed', `任务 ${jobId} 应该完成`)
  assert.equal(successfulWatermark(db, bindingId), bindingWatermark(bindingId), '读数必须等于绑定上的连续前缀')
}

/** 把绑定推进到指定水位：领取当前在途的 range 任务，逐段完成。 */
function drainTo(bindingId: string, target: number, outcome: 'succeeded' | 'no_change' = 'succeeded'): void {
  for (let guard = 0; guard < 20 && successfulWatermark(db, bindingId) < target; guard += 1) {
    const row = db.get<{ job_id?: string }>(
      `SELECT job_id FROM digest_jobs WHERE binding_id = ? AND mode = 'range'
         AND status IN ('pending','running') ORDER BY from_seq LIMIT 1`,
      [bindingId],
    )
    const jobId = String(row?.job_id ?? '')
    assert.notEqual(jobId, '', `水位 ${successfulWatermark(db, bindingId)} 时缺少在途任务`)
    claimAndComplete(bindingId, jobId, outcome)
  }
  assert.equal(successfulWatermark(db, bindingId), target, `水位应该推进到 ${target}`)
}

function runSql(sql: string, params: readonly unknown[] = []): void {
  db.run(sql, params)
}

function seedTurns(sessionRef: string, count: number, tag: string): void {
  for (let i = 1; i <= count; i += 1) {
    const turnId = `turn-${i}`
    runSql(
      `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at, turn_id)
       VALUES (?, 'main', 'dsh-session', 'desktop', ?, 'user', 'message', ?, ?, ?, ?)`,
      [`src_${tag}${i}u`, sessionRef, `第 ${i} 轮说的话`, iso, iso, turnId],
    )
    runSql(
      `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at, turn_id)
       VALUES (?, 'main', 'dsh-session', 'desktop', ?, 'self', 'message', ?, ?, ?, ?)`,
      [`src_${tag}${i}a`, sessionRef, `第 ${i} 轮的回复`, iso, iso, turnId],
    )
  }
}

try {
  await migrate(db, quiet)

  db.run(
    `INSERT INTO projects (project_id, persona_id, canonical_name, created_at, updated_at) VALUES (?, 'main', ?, ?, ?)`,
    ['proj_gap', '水位空洞测试项目', iso, iso],
  )
  for (const [bindingId, sessionRef] of [
    [BINDING, SESSION],
    [PREFIX_BINDING, PREFIX_SESSION],
    [SHORT_BINDING, SHORT_SESSION],
    [THRESHOLD_BINDING, THRESHOLD_SESSION],
  ] as const) {
    db.run(
      `INSERT INTO project_session_bindings (
         binding_id, project_id, persona_id, platform, session_ref, grant_generation,
         committed_to_seq, bound_at
       ) VALUES (?, 'proj_gap', 'main', 'desktop', ?, 'gen-1', 0, ?)`,
      [bindingId, sessionRef, iso],
    )
  }

  // 40 个有效轮（用户一句 + 助手一句共用一个 turn_id），给规划用。
  seedTurns(SESSION, 40, 'g')
  // 短空洞场景用 19 轮：水位 8、空洞 [9,11]、已成功 [12,19]。
  seedTurns(SHORT_SESSION, 19, 's')
  // G7 阈值场景同样 19 轮，用更高的 minTurns 把「普通触发阈值」顶到 pendingTurns 之上。
  seedTurns(THRESHOLD_SESSION, 19, 't')

  await test('G1 新绑定水位是 0', () => {
    assert.equal(successfulWatermark(db, BINDING), 0)
    assert.equal(bindingWatermark(BINDING), 0)
  })

  await test('G2 [1,8] 完成后三处读数都是 8', () => {
    const enq = enqueueDigestJob({ db, bindingId: BINDING, fromSeq: 1, toSeq: 8, now: NOW })
    assert.equal(enq.status, 'created', '[1,8] 应该能入队')
    claimAndComplete(BINDING, enq.job?.jobId ?? '')
    assert.equal(bindingWatermark(BINDING), 8)
    assert.equal(successfulWatermark(db, BINDING), 8)
  })

  await test('G3 乱序成功 [17,24]：读数仍是 8，规划从 9 开始、到 16 结束', () => {
    db.run(
      `INSERT INTO digest_jobs (job_id, binding_id, from_seq, to_seq, algorithm_version, status, attempts, finished_at, created_at, updated_at, mode)
       VALUES ('job_gap_1724', ?, 17, 24, 'digest-v1', 'succeeded', 1, ?, ?, ?, 'range')`,
      [BINDING, iso, iso, iso],
    )
    const maxRow = db.get<{ t?: number }>(
      `SELECT MAX(to_seq) AS t FROM digest_jobs WHERE binding_id = ? AND mode = 'range' AND status IN ('succeeded','no_change')`,
      [BINDING],
    )
    assert.equal(Number(maxRow?.t ?? 0), 24, '库里确实有到 24 的成功区间（MAX 口径会给 24）')
    assert.equal(successfulWatermark(db, BINDING), 8, '读数取连续前缀，不取 MAX')

    // `completeDigestJob` 完成 [1,8] 时会自动续排一条 [9,24]（第 51 轮 Q1 的行为）。
    // 那会让本次规划因为「已有在途任务」直接返回 below-threshold，看不到区间。
    db.run(
      `DELETE FROM digest_jobs WHERE binding_id = ? AND mode = 'range' AND status IN ('pending','running')`,
      [BINDING],
    )
    const planned = planDigestJob({ db, bindingId: BINDING, sessionRef: SESSION, now: NOW })
    assert.equal(planned.status, 'ready')
    assert.equal(planned.watermark, 8, '规划看到的水位也必须是 8')
    assert.equal(planned.pendingTurns, 32, '总共 40 轮，已处理 8 轮，剩 32 个有效轮')
    assert.equal(planned.job?.fromSeq, 9, '必须从第 9 轮开始补，而不是第 25 轮')
    assert.equal(planned.job?.toSeq, 16, '右端停在已成功的 [17,24] 之前，不重复摘要')
  })

  await test('G4 补完空洞 [9,16]（no_change）→ 24；再跑完 [25,40] → 40', () => {
    const holeJob = db.get<{ job_id?: string }>(
      `SELECT job_id FROM digest_jobs WHERE binding_id = ? AND mode = 'range' AND from_seq = 9 AND to_seq = 16`,
      [BINDING],
    )
    assert.notEqual(String(holeJob?.job_id ?? ''), '', 'G3 规划出的 [9,16] 任务应该在库里')
    claimAndComplete(BINDING, String(holeJob?.job_id ?? ''), 'no_change')
    assert.equal(bindingWatermark(BINDING), 24, '补完 9..16 后连续前缀是 24')
    assert.equal(successfulWatermark(db, BINDING), 24)
    assert.equal(planDigestJob({ db, bindingId: BINDING, sessionRef: SESSION, now: NOW }).watermark, 24, '规划读数同样是 24')

    // 25..40 由自动续排分两段跑完（每段 8 轮），最后一并断言 40。
    drainTo(BINDING, 40)
    assert.equal(successfulWatermark(db, BINDING), 40)
    const after = planDigestJob({ db, bindingId: BINDING, sessionRef: SESSION, now: NOW })
    assert.equal(after.watermark, 40, '规划读数也是 40')
    assert.notEqual(after.status, 'ready', '40 轮素材已经全部摘要过，不该再排新任务')
  })

  await test('G5 租约过期的 manual running 不被领取；manual succeeded 不推水位', () => {
    // A：manual 任务租约过期也不该被 worker 领走（AND/OR 优先级一旦写错就会命中）。
    db.run(
      `INSERT INTO digest_jobs (job_id, binding_id, from_seq, to_seq, algorithm_version, status, attempts, claimed_at, created_at, updated_at, mode, request_id)
       VALUES ('job_gap_manual_running', ?, 41, 48, 'digest-v1', 'running', 1, '2020-01-01T00:00:00.000Z', ?, ?, 'manual', 'req-manual-run')`,
      [BINDING, iso, iso],
    )
    const claimed = claimDigestJob({ db, now: NOW })
    assert.notEqual(claimed?.jobId, 'job_gap_manual_running', '租约过期的 manual 任务不该被领走')
    const manual = db.get<{ status?: string }>(`SELECT status FROM digest_jobs WHERE job_id = 'job_gap_manual_running'`)
    assert.equal(manual?.status, 'running', 'manual 任务状态保持 running')

    // B：manual succeeded 紧贴连续前缀时，真实 range 完成流程也不该把它算进水位。
    db.run(
      `INSERT INTO digest_jobs (job_id, binding_id, from_seq, to_seq, algorithm_version, status, attempts, finished_at, created_at, updated_at, mode, request_id)
       VALUES ('job_gap_prefix_manual', ?, 9, 16, 'digest-v1', 'succeeded', 1, ?, ?, ?, 'manual', 'req-manual-prefix')`,
      [PREFIX_BINDING, iso, iso, iso],
    )
    const enq = enqueueDigestJob({ db, bindingId: PREFIX_BINDING, fromSeq: 1, toSeq: 8, now: NOW })
    assert.equal(enq.status, 'created', '[1,8] 应该能入队')
    claimAndComplete(PREFIX_BINDING, enq.job?.jobId ?? '')
    assert.equal(successfulWatermark(db, PREFIX_BINDING), 8, 'manual 的 [9,16] 不参与连续水位')
    assert.equal(pendingDigestCount(db, PREFIX_BINDING), 0, 'manual 任务不计入自动待办')
  })

  await test('G6 不足 8 轮的短空洞仍能被规划补齐，并把后面的已成功区间纳入水位', () => {
    // 先把短空洞场景摆好：[1,8] 完成、[12,19] 已完成、9–11 空着。
    const first = enqueueDigestJob({ db, bindingId: SHORT_BINDING, fromSeq: 1, toSeq: 8, now: NOW })
    assert.equal(first.status, 'created', '[1,8] 应该能入队')
    claimAndComplete(SHORT_BINDING, first.job?.jobId ?? '')
    assert.equal(bindingWatermark(SHORT_BINDING), 8)
    db.run(
      `INSERT INTO digest_jobs (job_id, binding_id, from_seq, to_seq, algorithm_version, status, attempts, finished_at, created_at, updated_at, mode)
       VALUES ('job_gap_short_1219', ?, 12, 19, 'digest-v1', 'succeeded', 1, ?, ?, ?, 'range')`,
      [SHORT_BINDING, iso, iso, iso],
    )
    // 完成 [1,8] 时会自动续排一条 [9,16]；清掉它，让 G6 只测「短空洞规划」。
    db.run(
      `DELETE FROM digest_jobs WHERE binding_id = ? AND mode = 'range' AND status IN ('pending','running')`,
      [SHORT_BINDING],
    )

    // 水位 8、短空洞 [9,11]（3 轮）、[12,19] 已完成。阈值按「水位之后的有效轮」算，
    // 不是按空洞大小算：这里必须能排出 [9,11]，补完后再把水位推到 19。
    const planned = planDigestJob({ db, bindingId: SHORT_BINDING, sessionRef: SHORT_SESSION, now: NOW })
    assert.equal(planned.status, 'ready', '短空洞不该被阈值永久挡住')
    assert.equal(planned.watermark, 8)
    assert.equal(planned.job?.fromSeq, 9)
    assert.equal(planned.job?.toSeq, 11, '右端停在已成功的 [12,19] 之前')
    claimAndComplete(SHORT_BINDING, planned.job?.jobId ?? '', 'no_change')
    assert.equal(bindingWatermark(SHORT_BINDING), 19, '短空洞补完后，后面的已成功区间立即纳入连续水位')
    assert.equal(successfulWatermark(db, SHORT_BINDING), 19)
    assert.notEqual(
      planDigestJob({ db, bindingId: SHORT_BINDING, sessionRef: SHORT_SESSION, now: NOW }).status,
      'ready',
      '19 轮素材都已处理过，不该再排任务',
    )
  })

  await test('G7 补洞不受普通触发阈值限制：已成功后段之前的空洞仍能排任务', () => {
    // 把阈值顶到 pendingTurns 之上（11 < 20），让「普通素材够不够一批」这一层不再放行，
    // 只剩「已成功后段之前的空洞修复」这条路。
    const first = enqueueDigestJob({ db, bindingId: THRESHOLD_BINDING, fromSeq: 1, toSeq: 8, now: NOW })
    assert.equal(first.status, 'created')
    claimAndComplete(THRESHOLD_BINDING, first.job?.jobId ?? '')
    assert.equal(bindingWatermark(THRESHOLD_BINDING), 8)
    db.run(
      `INSERT INTO digest_jobs (job_id, binding_id, from_seq, to_seq, algorithm_version, status, attempts, finished_at, created_at, updated_at, mode)
       VALUES ('job_gap_threshold_1219', ?, 12, 19, 'digest-v1', 'succeeded', 1, ?, ?, ?, 'range')`,
      [THRESHOLD_BINDING, iso, iso, iso],
    )
    db.run(
      `DELETE FROM digest_jobs WHERE binding_id = ? AND mode = 'range' AND status IN ('pending','running')`,
      [THRESHOLD_BINDING],
    )

    const repair = planDigestJob({
      db,
      bindingId: THRESHOLD_BINDING,
      sessionRef: THRESHOLD_SESSION,
      now: NOW,
      minTurns: 20,
    })
    assert.equal(repair.status, 'ready', '已成功后段之前的空洞修复不该被普通阈值挡住')
    assert.equal(repair.job?.fromSeq, 9)
    assert.equal(repair.job?.toSeq, 11)

    // 对照组：没有已成功后段时，同样的 11 轮普通素材仍遵守 20 轮阈值。
    db.run(`DELETE FROM digest_jobs WHERE job_id = 'job_gap_threshold_1219'`)
    db.run(
      `DELETE FROM digest_jobs WHERE binding_id = ? AND mode = 'range' AND status IN ('pending','running')`,
      [THRESHOLD_BINDING],
    )
    const ordinary = planDigestJob({
      db,
      bindingId: THRESHOLD_BINDING,
      sessionRef: THRESHOLD_SESSION,
      now: NOW,
      minTurns: 20,
    })
    assert.equal(ordinary.status, 'below-threshold', '普通新增素材仍遵守原阈值')
    assert.equal(ordinary.job, null)
  })

  console.log(`\n[digest-watermark-gap] ${passed} 通过 / ${failed} 失败`)
} finally {
  try {
    db.close()
  } catch {
    /* 关闭失败不影响结论 */
  }
  rmSync(dir, { recursive: true, force: true })
}

if (failed > 0) process.exitCode = 1
