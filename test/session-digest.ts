/**
 * G2-A：会话摘要队列的语义测试。零模型、临时库、固定时钟。
 *
 * 四条判据（评审第 32/36 轮给出）：
 *   1. 8 个有效轮入队；
 *   2. 并发只领取一次；
 *   3. 失败保留上次成功水位；
 *   4. 重放不重复写。
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
  failDigestJob,
  pendingDigestCount,
  planDigestJob,
  readDigestOfJob,
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

const dir = mkdtempSync(join(tmpdir(), 'psyche-digest-'))
const file = join(dir, 'memory.sqlite3')
const opened = await openDatabase({ file, driverPreference: 'auto', logger: quiet })
const db = opened.db

try {
  await migrate(db, quiet)

  // 摘要任务对 project_session_bindings 有外键，先造一个最小项目与绑定。
  const NOW = new Date('2026-11-22T10:00:00.000Z')
  const iso = NOW.toISOString()
  db.run(
    `INSERT INTO projects (project_id, persona_id, canonical_name, created_at, updated_at) VALUES (?, 'main', ?, ?, ?)`,
    ['proj_digest', 'Digest 测试项目', iso, iso],
  )
  db.run(
    `INSERT INTO project_session_bindings (
       binding_id, project_id, persona_id, platform, session_ref, grant_generation,
       committed_to_seq, bound_at
     ) VALUES (?, ?, 'main', 'desktop', 'sess-digest', 'gen-1', 0, ?)`,
    ['bind_digest', 'proj_digest', iso],
  )

  await test('G2-A-1 同一个区间重复入队只留一条，返回既有行', () => {
    const first = enqueueDigestJob({ db, bindingId: 'bind_digest', fromSeq: 1, toSeq: 8, now: NOW })
    assert.equal(first.status, 'created')
    assert.notEqual(first.job, null)
    const again = enqueueDigestJob({ db, bindingId: 'bind_digest', fromSeq: 1, toSeq: 8, now: NOW })
    assert.equal(again.status, 'replayed', '重复入队应返回既有任务')
    assert.equal(again.job?.jobId, first.job?.jobId)
    const rows = db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM digest_jobs WHERE binding_id = 'bind_digest'`)
    assert.equal(rows[0]?.n, 1, '表里只该有一条')
  })

  await test('G2-A-2 区间不合法时拒绝，且不写库', () => {
    const bad = enqueueDigestJob({ db, bindingId: 'bind_digest', fromSeq: 0, toSeq: 3, now: NOW })
    assert.equal(bad.status, 'bad-range')
    assert.equal(bad.job, null)
    const inverted = enqueueDigestJob({ db, bindingId: 'bind_digest', fromSeq: 5, toSeq: 3, now: NOW })
    assert.equal(inverted.status, 'bad-range')
    const rows = db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM digest_jobs WHERE binding_id = 'bind_digest'`)
    assert.equal(rows[0]?.n, 1, '两次非法入队都不该留下行')
  })

  await test('G2-A-3 并发领取：同一时刻只有一次能拿到，第二次返回 null', () => {
    const a = claimDigestJob({ db, now: NOW })
    assert.notEqual(a, null, '第一次应领到')
    assert.equal(a?.status, 'running')
    assert.equal(a?.attempts, 1, '领取即计一次尝试')
    const b = claimDigestJob({ db, now: NOW })
    assert.equal(b, null, '同一时刻第二次应该领不到')
  })

  await test('G2-A-4 失败不回退水位，任务回到可领状态', () => {
    // G2-A-3 已经把这条领走了（同一时刻第二次领取返回 null 正是那台的断言），
    // 这里直接按 jobId 记失败，attempts 取库里当前值作为这一轮的凭据。
    const jobId = String(
      (db.get<{ job_id?: string }>(`SELECT job_id FROM digest_jobs LIMIT 1`) ?? {}).job_id ?? '',
    )
    assert.notEqual(jobId, '', '应能定位任务')
    const attempts = Number(
      (db.get<{ attempts?: number }>(`SELECT attempts FROM digest_jobs WHERE job_id = ?`, [jobId]) ?? {}).attempts ?? 0,
    )
    const ok = failDigestJob({
      db,
      jobId,
      attempts,
      errorCode: 'model_unavailable',
      now: NOW,
    })
    assert.equal(ok, true, '失败应被记录')
    const row = db.get<{ status?: string }>(`SELECT status FROM digest_jobs WHERE job_id = ?`, [jobId])
    assert.equal(row?.status, 'pending', '失败后回到 pending 等重试')
    assert.equal(successfulWatermark(db, 'bind_digest'), 0, '还没有成功任务时水位是 0')
  })

  await test('G2-A-5 成功提交写入摘要并把水位推到该区间', () => {
    const claimed = claimDigestJob({ db, now: NOW })
    assert.notEqual(claimed, null, '应能重新领到那条待重试的任务')
    const jobId = claimed?.jobId ?? ''
    const done = completeDigestJob({
      db,
      jobId,
      attempts: claimed?.attempts ?? 0,
      bodyJson: JSON.stringify({ summary: '前八轮的进展' }),
      sourceIds: ['src_d1', 'src_d2'],
      now: NOW,
    })
    assert.equal(done.status, 'completed')
    assert.notEqual(done.digest, null)
    assert.equal(successfulWatermark(db, 'bind_digest'), 8, '水位应推到 toSeq')
    assert.equal(pendingDigestCount(db, 'bind_digest'), 0)
    // 第 44 轮外部评审 Q3：成功摘要要在同一事务里推进项目绑定的连续水位。
    const binding = db.get<{ committed_to_seq: number }>(
      `SELECT committed_to_seq FROM project_session_bindings WHERE binding_id = ?`,
      ['bind_digest'],
    )
    assert.equal(Number(binding?.committed_to_seq ?? 0), 8, 'project_session_bindings.committed_to_seq 应同步推进到 8')
  })

  await test('G2-A-6 重放同一 job 的提交不新增摘要', () => {
    const jobId = String(
      (db.get<{ job_id?: string }>(`SELECT job_id FROM digest_jobs LIMIT 1`) ?? {}).job_id ?? '',
    )
    const again = completeDigestJob({
      db,
      jobId,
      attempts: Number((db.get<{ attempts?: number }>(`SELECT attempts FROM digest_jobs WHERE job_id = ?`, [jobId]) ?? {}).attempts ?? 0),
      bodyJson: JSON.stringify({ summary: '第二次提交的内容应该被忽略' }),
      sourceIds: ['src_d9'],
      now: NOW,
    })
    assert.equal(again.status, 'replayed', '已成功的任务重放应返回既有摘要')
    const rows = db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM session_digests`)
    assert.equal(rows[0]?.n, 1, '摘要表里只该有一条')
    const stored = readDigestOfJob(db, jobId)
    assert.equal(JSON.parse(stored?.bodyJson ?? '{}').summary, '前八轮的进展', '重放不该覆盖已有正文')
  })

  await test('G2-A-7 no_change 也算处理完并推水位', () => {
    const next = enqueueDigestJob({ db, bindingId: 'bind_digest', fromSeq: 9, toSeq: 16, now: NOW })
    assert.equal(next.status, 'created')
    const claimed = claimDigestJob({ db, now: NOW })
    assert.equal(claimed?.fromSeq, 9)
    const done = completeDigestJob({
      db,
      jobId: claimed?.jobId ?? '',
      attempts: claimed?.attempts ?? 0,
      bodyJson: JSON.stringify({ summary: '' }),
      sourceIds: [],
      outcome: 'no_change',
      now: NOW,
    })
    assert.equal(done.status, 'completed')
    assert.equal(successfulWatermark(db, 'bind_digest'), 16, '没变化也要推进水位')
    const row = db.get<{ status?: string }>(`SELECT status FROM digest_jobs WHERE to_seq = 16`)
    assert.equal(row?.status, 'no_change')
  })

  // 第 51 轮外部评审 Q1 第二条：租约失败。
  //
  // 固定时钟越过租约边界后，W1 的 complete 和 fail 都必须零写入；
  // W2 重领之后，W1 仍改不动任务、退避或水位，W2 能正常完成。
  await test('G2-A-11 租约过期被顶掉后，旧持有者的写回全部无效', () => {
    // 这一条要独立的绑定，避免被前面已经推高的水位干扰。
    db.run(
      `INSERT INTO projects (project_id, persona_id, canonical_name, status, created_at, updated_at)
       VALUES (?, 'main', ?, 'active', ?, ?)`,
      ['proj_lease', '租约项目', NOW.toISOString(), NOW.toISOString()],
    )
    db.run(
      `INSERT INTO project_session_bindings (
         binding_id, project_id, persona_id, platform, session_ref, grant_generation,
         committed_to_seq, bound_at
       ) VALUES (?, ?, 'main', 'desktop', 'sess-lease', 'gen-1', 0, ?)`,
      ['bind_lease', 'proj_lease', NOW.toISOString()],
    )
    enqueueDigestJob({ db, bindingId: 'bind_lease', fromSeq: 1, toSeq: 8, now: NOW })
    const w1 = claimDigestJob({ db, now: NOW })
    assert.equal(w1?.attempts, 1)
    // 越过租约（5 分钟）后 W2 重领，attempts 变成 2。
    const later = new Date(NOW.getTime() + 6 * 60_000)
    const w2 = claimDigestJob({ db, now: later })
    assert.equal(w2?.attempts, 2, 'W2 重领成功')

    // W1 迟到的 complete：靠 attempts 凭据拦住。
    const stale = completeDigestJob({
      db,
      jobId: String(w1?.jobId),
      attempts: 1,
      bodyJson: JSON.stringify({ summary: 'W1 的迟到结果' }),
      sourceIds: [],
      now: later,
    })
    assert.equal(stale.status, 'lease-lost', 'W1 的 complete 必须被拒')
    assert.equal(successfulWatermark(db, 'bind_lease'), 0, '水位没被 W1 推动')
    assert.equal(
      Number((db.get(`SELECT COUNT(*) AS n FROM session_digests WHERE job_id = ?`, [String(w1?.jobId)]).n as number) ?? 0),
      0,
      'W1 的正文没有落库',
    )

    // W1 迟到的 fail：靠 attempts 条件拦住。
    const staleFail = failDigestJob({ db, jobId: String(w1?.jobId), attempts: 1, errorCode: 'W1_LATE', now: later })
    assert.equal(staleFail, false, 'W1 的 fail 必须被拒')
    const row = db.get(`SELECT status, error_code FROM digest_jobs WHERE job_id = ?`, [String(w1?.jobId)])
    assert.equal(String(row.status), 'running', '状态仍是 W2 持有')
    assert.notEqual(String(row.error_code ?? ''), 'W1_LATE', '错误码没被 W1 覆盖')

    // W2 正常完成。
    const done = completeDigestJob({
      db,
      jobId: String(w2?.jobId),
      attempts: 2,
      bodyJson: JSON.stringify({ summary: 'W2 的结果' }),
      sourceIds: [],
      now: later,
    })
    assert.equal(done.status, 'completed', 'W2 能正常完成')
    assert.equal(successfulWatermark(db, 'bind_lease'), 8, '水位由 W2 推到 8')
  })

  await test('G2-A-8 租约过期的 running 任务会被重新领走', () => {    enqueueDigestJob({ db, bindingId: 'bind_digest', fromSeq: 17, toSeq: 24, now: NOW })
    const first = claimDigestJob({ db, now: NOW })
    assert.equal(first?.fromSeq, 17)
    // 模拟 worker 崩溃：任务停在 running，租约 5 分钟。
    const later = new Date(NOW.getTime() + 6 * 60_000)
    const again = claimDigestJob({ db, now: later })
    assert.equal(again?.fromSeq, 17, '租约过期后应能重新领取')
    assert.equal(again?.attempts, 2, 'attempts 应继续累加')
  })

  await test('G2-A-9 不足 8 轮不入队，攒够才建任务，重放不新增', async () => {
    // 用独立的绑定与会话，避免受前面几条已推高的水位影响。
    db.run(
      `INSERT INTO project_session_bindings (
         binding_id, project_id, persona_id, platform, session_ref, grant_generation,
         committed_to_seq, bound_at
       ) VALUES (?, ?, 'main', 'desktop', 'sess-turn', 'gen-1', 0, ?)`,
      ['bind_turn', 'proj_digest', iso],
    )
    // 第 45 轮 Q1 之后有效轮按 turn_id 数，且必须「用户正文 + 助手正文」都有，
    // 所以每一轮写两条 Source（用户一句、助手一句），共用一个 turn_id。
    for (let i = 1; i <= 7; i += 1) {
      db.run(
        `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at, turn_id)
         VALUES (?, 'main', 'dsh-session', 'desktop', 'sess-turn', 'user', 'message', ?, ?, ?, ?)`,
        [`src_t${i}u`, `第 ${i} 轮说的话`, iso, iso, `turn-${i}`],
      )
      db.run(
        `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at, turn_id)
         VALUES (?, 'main', 'dsh-session', 'desktop', 'sess-turn', 'self', 'message', ?, ?, ?, ?)`,
        [`src_t${i}a`, `第 ${i} 轮的回复`, iso, iso, `turn-${i}`],
      )
    }
    const below = planDigestJob({ db, bindingId: 'bind_turn', sessionRef: 'sess-turn', now: NOW })
    assert.equal(below.status, 'below-threshold', '7 轮不该入队')
    assert.equal(below.pendingTurns, 7)
    assert.equal(below.job, null)

    db.run(
      `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at, turn_id)
       VALUES (?, 'main', 'dsh-session', 'desktop', 'sess-turn', 'user', 'message', ?, ?, ?, 'turn-8')`,
      ['src_t8u', '第 8 轮说的话', iso, iso],
    )
    // 只有用户那边、助手还没回：这一轮还不算完整，仍然不够 8 轮。
    const halfDone = planDigestJob({ db, bindingId: 'bind_turn', sessionRef: 'sess-turn', now: NOW })
    assert.equal(halfDone.status, 'below-threshold', '只有问没有答的轮不算有效轮')
    assert.equal(halfDone.pendingTurns, 7)

    db.run(
      `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at, turn_id)
       VALUES (?, 'main', 'dsh-session', 'desktop', 'sess-turn', 'self', 'message', ?, ?, ?, 'turn-8')`,
      ['src_t8a', '第 8 轮的回复', iso, iso],
    )
    const ready = planDigestJob({ db, bindingId: 'bind_turn', sessionRef: 'sess-turn', now: NOW })
    assert.equal(ready.status, 'ready')
    assert.equal(ready.pendingTurns, 8)
    assert.equal(ready.job?.fromSeq, 1, '新绑定的水位是 0，区间从第一轮开始')
    assert.equal(ready.job?.toSeq, 8)

    const replay = planDigestJob({ db, bindingId: 'bind_turn', sessionRef: 'sess-turn', now: NOW })
    // 第一个任务还挂着（pending），这时不该再开一个覆盖同一段素材的新任务。
    assert.equal(replay.status, 'below-threshold', '首个任务没做完之前不再开新的')
    assert.equal(replay.job, null)
    const count = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM digest_jobs WHERE binding_id = 'bind_turn' AND to_seq = 8`,
    )
    assert.equal(count?.n, 1, '重放不该再加一条')

    // 同一轮里又补了一句、再来一条工具输出：轮次只算一次。
    // 这正是「数发言条数」会算错的地方，也是最容易漏掉的反例。
    db.run(
      `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at, turn_id)
       VALUES (?, 'main', 'dsh-session', 'desktop', 'sess-turn', 'user', 'message', ?, ?, ?, 'turn-8')`,
      ['src_t8u2', '再补一句', iso, iso],
    )
    db.run(
      `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at, turn_id)
       VALUES (?, 'main', 'dsh-session', 'desktop', 'sess-turn', 'self', 'tool', ?, ?, ?, 'turn-8')`,
      ['src_t8t', '工具输出', iso, iso],
    )
    const afterExtra = planDigestJob({ db, bindingId: 'bind_turn', sessionRef: 'sess-turn', now: NOW })
    const count2 = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM digest_jobs WHERE binding_id = 'bind_turn'`,
    )
    assert.equal(count2?.n, 1, '同轮的补充发言与工具输出不该产生新任务')

    // 重开库再算一次：轮次身份在库里，不靠内存。
    const reopened = await openDatabase({ file, driverPreference: 'auto', logger: quiet })
    try {
      await migrate(reopened.db, quiet)
      const afterReopen = planDigestJob({
        db: reopened.db,
        bindingId: 'bind_turn',
        sessionRef: 'sess-turn',
        now: NOW,
      })
      const count3 = reopened.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM digest_jobs WHERE binding_id = 'bind_turn'`,
      )
      assert.equal(afterReopen.pendingTurns, afterExtra.pendingTurns, '重开库后轮次计数不变')
      assert.equal(count3?.n, 1, '重开库后仍是原来那个任务')
    } finally {
      try {
        reopened.db.close()
      } catch {
        /* 关闭失败不影响结论 */
      }
    }
  })

  await test('G2-A-10 水位只取连续前缀：中间有空洞时不能跳过去', () => {
    // 外部评审第 46 轮给的固定数据：先成功的区间在后面、中间那段还在退避。
    // 用 MAX(watermark, toSeq) 会把水位直接推到 24，[9,16] 就再也不会被处理。
    db.run(
      `INSERT INTO project_session_bindings (
         binding_id, project_id, persona_id, platform, session_ref, grant_generation,
         committed_to_seq, bound_at
       ) VALUES (?, ?, 'main', 'desktop', 'sess-gap', 'gen-1', 8, ?)`,
      ['bind_gap', 'proj_digest', iso],
    )

    const complete = (fromSeq: number, toSeq: number): number => {
      const enq = enqueueDigestJob({ db, bindingId: 'bind_gap', fromSeq, toSeq, now: NOW })
      assert.equal(enq.status, 'created')
      const jobId = enq.job?.jobId ?? ''
      const claimed = claimDigestJob({ db, jobId, now: NOW })
      assert.notEqual(claimed, null)
      completeDigestJob({
        db,
        jobId,
        attempts: claimed?.attempts ?? 0,
        bodyJson: JSON.stringify({ summary: `${fromSeq}-${toSeq}` }),
        sourceIds: [],
        now: NOW,
      })
      const row = db.get<{ committed_to_seq: number }>(
        `SELECT committed_to_seq FROM project_session_bindings WHERE binding_id = ?`,
        ['bind_gap'],
      )
      return Number(row?.committed_to_seq ?? 0)
    }

    // [17,24] 先完成：跟当前水位 8 接不上，水位不许动。
    assert.equal(complete(17, 24), 8, '后面那段先成功不能把水位推过去')
    // [9,16] 补上之后，两段连通，一次推到 24。
    assert.equal(complete(9, 16), 24, '补上中间那段后应一次推到 24')
  })

  console.log(`\n[session-digest] ${passed} 通过 / ${failed} 失败`)
} finally {
  try {
    db.close()
  } catch {
    /* 关闭失败不影响结论 */
  }
  rmSync(dir, { recursive: true, force: true })
}

if (failed > 0) process.exitCode = 1
