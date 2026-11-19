// P2-Recall R4-C：Composer 批量事务回填（RCMP-01~23）。
//
// 验收口径（用户 m19206 冻结）：
// - 一次 Composer 决策后一次性回填 selected/composed/truncated/final_rank 与 run 状态，
//   不逐条 UPDATE；
// - 四态：pending → completed（Composer 结束，无论是否注入）/ not_applicable（主动 Recall）
//   / interrupted（进程中断的 pending）；
// - composed=true 只表示进入 Composer 输出，不代表 Provider 收到；
// - truncated=true 只表示「通过准入但被预算截断」，不能与 state/disclosure/scope 拒绝混用。
//
// 跑法：node test/recall-composition.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { PreStepInjector } from '../dist/lib/pre-step-injection.js'
import { RuntimeInputStore, createHostBindingCapability } from '../dist/lib/runtime-input.js'
import {
  backfillRecallComposition,
  markInterruptedRecallRuns,
  listRecallCandidates,
  listRecallRuns,
} from '../dist/lib/recall-receipt.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-composition-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
migrate(opened.db, log)
const db = opened.db
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

console.log('\n[P2-Recall R4-C] Composer 批量回填')

let sourceSeq = 0

async function source(text: string): Promise<string> {
  sourceSeq += 1
  const captured = await core.capture({
    platform: 'dsh',
    channel: 'desktop',
    sessionRef: `rcmp-s${sourceSeq}`,
    origin: 'user',
    kind: 'message',
    text,
  })
  return captured.sourceId
}

async function fact(text: string): Promise<string> {
  const a = await source(text)
  const b = await source(`${text}（补充确认）`)
  const remembered = await core.remember({
    text,
    kind: 'fact',
    statement: text,
    sourceIds: [a, b],
    disclosure: 'public',
  })
  if (!remembered.artifactId) throw new Error(`未升格：${JSON.stringify(remembered)}`)
  return remembered.artifactId
}

function makeAgent(runtimeInputs: RuntimeInputStore): { id: string; session: { id: string } } {
  const sessionId = `rcmp-session-${sourceSeq}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  runtimeInputs.bind(createHostBindingCapability({ sessionId, platform: 'dsh', adapterId: null }), {
    platform: 'dsh',
    stableUserId: 'owner-rcmp',
    contactId: null,
    sessionId,
    trustedSource: 'host',
  })
  return { id: sessionId, session: { id: sessionId } }
}

const firstText = '信号塔北移三步'
const secondText = '信号塔北移三步补记'
const query = '信号塔北移三步'
const firstId = await fact(firstText)
const secondId = await fact(secondText)

// ── 1. 自动注入成功 → completed ─────────────────────────────────────────
const runtimeInputs = new RuntimeInputStore()
const injector = new PreStepInjector({ db, runtimeInputs, receipt: { dataDir: dir } })
const agentA = makeAgent(runtimeInputs)
const injected = injector.inject(agentA, [{ role: 'user', content: query }], { turn: 1, step: 1 })
ok('RCMP-01 自动注入成功', injected.injected, injected.skipped)

const runA = listRecallRuns(db, 5).find((run) => run.queryMode === 'pre-step' && run.compositionStatus === 'completed')
ok('RCMP-02 回填后 run 状态是 completed', runA !== undefined, listRecallRuns(db, 5))
const rowA = listRecallCandidates(db, runA!.runId)
eq('RCMP-03 两条候选都入选', rowA.filter((row) => row.composed).length, 2)
ok('RCMP-04 入选候选 final_rank 有值', rowA.every((row) => row.selected && row.finalRank !== null), rowA)
eq('RCMP-05 入选候选没有拒绝原因', rowA.filter((row) => row.rejectReason !== null).length, 0)
eq('RCMP-06 入选候选没有 truncated', rowA.filter((row) => row.truncated).length, 0)

// ── 2. 预算截断 → truncated 与拒绝原因不混用 ────────────────────────────
const runtimeInputs2 = new RuntimeInputStore()
const narrow = new PreStepInjector({ db, runtimeInputs: runtimeInputs2, maxItems: 1, receipt: { dataDir: dir } })
const agentB = makeAgent(runtimeInputs2)
const narrowResult = narrow.inject(agentB, [{ role: 'user', content: query }], { turn: 1, step: 1 })
ok('RCMP-07 预算 1 时仍注入 1 条', narrowResult.injected && narrowResult.composed?.items.length === 1)

const runB = listRecallRuns(db, 5).find((run) => run.runId !== runA!.runId && run.compositionStatus === 'completed')
const rowB = listRecallCandidates(db, runB!.runId)
eq('RCMP-08 一条 composed、一条 truncated', [rowB.filter((row) => row.composed).length, rowB.filter((row) => row.truncated).length], [1, 1])
const truncatedRow = rowB.find((row) => row.truncated)
eq('RCMP-09 被截断行没有 final_rank', truncatedRow?.finalRank, null)
eq('RCMP-10 被截断行没有拒绝原因', truncatedRow?.rejectReason, null)
ok('RCMP-11 truncated 不等于未入选候选', rowB.every((row) => row.eligible), rowB)

// ── 3. 主动 Recall 仍是 not_applicable ──────────────────────────────────
await core.recall({ text: query }, { surface: 'personal' })
const recallRun = listRecallRuns(db, 10).find((run) => run.queryMode === 'recall')
eq('RCMP-12 主动 Recall 的 composition_status=not_applicable', recallRun?.compositionStatus, 'not_applicable')

// ── 4. 重复回填幂等 ─────────────────────────────────────────────────────
const beforeRows = listRecallCandidates(db, runA!.runId)
const beforeRun = listRecallRuns(db, 10).find((run) => run.runId === runA!.runId)
backfillRecallComposition(
  db,
  runA!.runId,
  rowA.map((row) => ({
    artifactId: row.artifactId,
    revision: row.revision,
    finalRank: row.finalRank,
    selected: row.selected,
    composed: row.composed,
    truncated: row.truncated,
    rejectReason: row.rejectReason,
  })),
  'completed',
)
const afterRows = listRecallCandidates(db, runA!.runId)
eq('RCMP-13 重复回填不产生新行', afterRows.length, beforeRows.length)
eq('RCMP-14 重复回填不改候选值', JSON.stringify(afterRows), JSON.stringify(beforeRows))
eq(
  'RCMP-15 回填不改 run 计数',
  [listRecallRuns(db, 10).find((run) => run.runId === runA!.runId)?.matchedCount, listRecallRuns(db, 10).find((run) => run.runId === runA!.runId)?.eligibleCount],
  [beforeRun?.matchedCount, beforeRun?.eligibleCount],
)

// ── 5. 未知候选回填不新增行 ─────────────────────────────────────────────
const countBefore = listRecallCandidates(db, runA!.runId).length
backfillRecallComposition(
  db,
  runA!.runId,
  [{ artifactId: 'art_absent', revision: 1, finalRank: null, selected: false, composed: false, truncated: false, rejectReason: 'missing' }],
  'completed',
)
eq('RCMP-16 未知候选不新增行', listRecallCandidates(db, runA!.runId).length, countBefore)
eq('RCMP-17 未知候选不改 run 状态', listRecallRuns(db, 10).find((run) => run.runId === runA!.runId)?.compositionStatus, 'completed')

// ── 6. 启动时把旧 pending 标 interrupted ────────────────────────────────
const old = new Date(Date.now() - 30 * 60 * 1000).toISOString()
const fresh = new Date().toISOString()
const insertRun = (runId: string, status: string, createdAt: string): void => {
  db.run(
    `INSERT INTO recall_runs (run_id, request_id, persona_id, query_hash, query_mode, scope_type, scope_hash,
       requested_limit, matched_count, eligible_count, returned_count, abstained, composition_status, key_version, created_at)
     VALUES (?, NULL, 'main', NULL, 'pre-step', 'global', NULL, 8, 0, 0, 0, 0, ?, 1, ?)`,
    [runId, status, createdAt],
  )
}
insertRun('run_stale_pending', 'pending', old)
insertRun('run_fresh_pending', 'pending', fresh)
insertRun('run_done', 'completed', old)
const marked = markInterruptedRecallRuns(db, { before: new Date(Date.now() - 5 * 60 * 1000).toISOString() })
eq('RCMP-18 只标记旧 pending', marked, 1)
const statusOf = (runId: string): string | undefined =>
  listRecallRuns(db, 50).find((run) => run.runId === runId)?.compositionStatus
eq('RCMP-19 旧 pending → interrupted', statusOf('run_stale_pending'), 'interrupted')
eq('RCMP-20 新 pending 不动', statusOf('run_fresh_pending'), 'pending')
eq('RCMP-21 completed 不回退', statusOf('run_done'), 'completed')

// ── 7. 空召回 run 也是 completed ───────────────────────────────────────
const runtimeInputs3 = new RuntimeInputStore()
const emptyInjector = new PreStepInjector({ db, runtimeInputs: runtimeInputs3, receipt: { dataDir: dir } })
const agentC = makeAgent(runtimeInputs3)
const emptyResult = emptyInjector.inject(agentC, [{ role: 'user', content: '完全不存在的词藻组合' }], { turn: 1, step: 1 })
ok('RCMP-22 空召回 abstained', emptyResult.abstained && !emptyResult.injected)
const emptyRun = listRecallRuns(db, 5).find((run) => run.abstained && run.queryMode === 'pre-step' && run.compositionStatus === 'completed')
ok('RCMP-23 空召回回执也是 completed', emptyRun !== undefined, listRecallRuns(db, 5))

// ── 8. R6-2.1：pending 必须在 Composer 之前落库 ─────────────────────────
// 让「回填候选」那条 UPDATE 抛错（不是让整个事务系统坏掉）：pending 与候选写入照常，
// 只有回填失败。如果 pending 仍是「回填时才创建」，这条 run 根本不会存在；
// 现在它存在且是 pending，证明写入发生在 Composer 之前。
const brokenDb = new Proxy(db, {
  get(target, property) {
    const value = Reflect.get(target, property, target) as unknown
    if (property === 'run') {
      return (...args: unknown[]) => {
        const sql = String(args[0] ?? '')
        if (sql.includes('UPDATE recall_candidates')) throw new Error('RCMP backfill boom')
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    }
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
  },
})
const runtimeInputs4 = new RuntimeInputStore()
const brokenInjector = new PreStepInjector({
  db: brokenDb as never,
  runtimeInputs: runtimeInputs4,
  receipt: { dataDir: dir },
})
const agentD = makeAgent(runtimeInputs4)
const brokenResult = brokenInjector.inject(agentD, [{ role: 'user', content: query }], { turn: 1, step: 1 })
ok('RCMP-24 回填失败时注入仍成功', brokenResult.injected === true, brokenResult.skipped)
const pendingRun = listRecallRuns(db, 5).find(
  (run) => run.queryMode === 'pre-step' && run.compositionStatus === 'pending',
)
ok('RCMP-25 回执保持 pending（证明 pending 先于 Composer）', pendingRun !== undefined, listRecallRuns(db, 5))
ok(
  'RCMP-26 pending 阶段已写候选行',
  pendingRun !== undefined && listRecallCandidates(db, pendingRun.runId).length > 0,
  pendingRun === undefined ? undefined : listRecallCandidates(db, pendingRun.runId),
)

console.log(`\n[P2-Recall R4-C] ${passed} 通过 ${failed} 失败`)

try {
  opened.db.close()
} catch {
  // 已关闭
}
rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
