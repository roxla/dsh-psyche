// C2-B：注入消息与 pre-step 回执的关联键（runId）、会话/轮次范围字段。
//
// 验收口径（用户 m29573）：
// - v14 只加 session_ref / turn，旧记录保持 NULL；
// - runId 唯一匹配对应 pre-step 回执；
// - 同一轮重试不产生重复的有效注入回执；
// - 两会话、相邻两轮不串；
// - pending / interrupted / 无回执都不能显示成「已注入」；
// - 有注入标记但找不到回执时不显示虚假数量。
//
// 跑法：node test/recall-link.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { PreStepInjector, type PreStepMessage } from '../dist/lib/pre-step-injection.js'
import { RuntimeInputStore, createHostBindingCapability } from '../dist/lib/runtime-input.js'
import {
  createRecallRun,
  findPreStepRun,
  listRecallRuns,
  type RecallRunInput,
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

const dir = mkdtempSync(join(tmpdir(), 'psyche-recall-link-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

console.log('\n[C2-B] 注入消息 ↔ pre-step 回执关联')

async function source(sessionRef: string, text: string): Promise<string> {
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

async function fact(refs: [string, string], text: string): Promise<string> {
  const a = await source(refs[0], text)
  const b = await source(refs[1], `${text}（补充确认）`)
  const remember = await core.remember({
    text,
    kind: 'fact',
    statement: text,
    sourceIds: [a, b],
    disclosure: 'public',
  })
  if (!remember.artifactId) throw new Error(`fact 未升格：${JSON.stringify(remember)}`)
  return remember.artifactId
}

// ── 夹具 ───────────────────────────────────────────────────────────────
await fact(['l-1', 'l-2'], '团子是我养的猫。')

const runtimeInputs = new RuntimeInputStore()
runtimeInputs.bind(createHostBindingCapability({ sessionId: 'session-A', platform: 'dsh' }), {
  platform: 'dsh',
  stableUserId: 'u-a',
  contactId: 'ct_aaaa1',
  sessionId: 'session-A',
  trustedSource: 'host',
})
const injector = new PreStepInjector({ db, runtimeInputs, receipt: { dataDir: dir } })
const agentA = { id: 'session-A' }

function userMessage(text: string): PreStepMessage[] {
  return [{ role: 'user', content: text }]
}

// ── C2L-01：v14 迁移与列 ───────────────────────────────────────────────
const version = db.get('PRAGMA user_version')
eq('user_version=31', Number(version?.user_version), 31)
const columns = db.all('PRAGMA table_info(recall_runs)').map((row) => String(row.name))
ok('recall_runs 有 session_ref', columns.includes('session_ref'))
ok('recall_runs 有 turn', columns.includes('turn'))

// ── C2L-02：runId 唯一匹配 ─────────────────────────────────────────────
const injected = injector.inject(agentA, userMessage('团子'), { turn: 1, step: 0 })
ok('注入成功', injected.injected, injected.skipped)
const sourceMeta = (injected.messages[injected.messages.length - 1] as {
  source?: { psyche?: { runId?: string; injection?: string } }
}).source
eq('注入消息带 injection 标识', sourceMeta?.psyche?.injection, 'memory-context')
const runId = sourceMeta?.psyche?.runId
ok('注入消息带 runId', typeof runId === 'string' && runId.length > 0, sourceMeta)
const matched = runId === undefined ? null : findPreStepRun(db, 'session-A', 1)
eq('runId 唯一匹配回执', matched?.runId, runId)
eq('回执 session_ref 正确', listRecallRuns(db, 1)[0]?.sessionRef, 'session-A')
eq('回执 turn 正确', listRecallRuns(db, 1)[0]?.turn, 1)
eq('回执 returned_count 是实际注入数', listRecallRuns(db, 1)[0]?.returnedCount, 1)

// ── C2L-03：同一轮重试不产生重复回执 ───────────────────────────────────
// 新注入器（模拟进程内已注入状态丢失）在同一轮再次触发。
const retryInjector = new PreStepInjector({ db, runtimeInputs, receipt: { dataDir: dir } })
const retry = retryInjector.inject(agentA, userMessage('团子'), { turn: 1, step: 1 })
ok('同轮重试仍注入（step 变化）', retry.injected, retry.skipped)
const retryRunId = (retry.messages[retry.messages.length - 1] as {
  source?: { psyche?: { runId?: string } }
}).source?.psyche?.runId
eq('同轮重试复用同一条回执', retryRunId, runId)
const runsAfterRetry = listRecallRuns(db, 10).filter((row) => row.queryMode === 'pre-step')
eq('同轮只有一条 pre-step 回执', runsAfterRetry.length, 1)

// ── C2L-04：相邻两轮不串 ───────────────────────────────────────────────
const second = injector.inject(agentA, userMessage('团子'), { turn: 2, step: 0 })
ok('第二轮注入成功', second.injected, second.skipped)
const secondRunId = (second.messages[second.messages.length - 1] as {
  source?: { psyche?: { runId?: string } }
}).source?.psyche?.runId
ok('第二轮 runId 与第一轮不同', secondRunId !== undefined && secondRunId !== runId)
eq('第二轮匹配 turn=2 的回执', findPreStepRun(db, 'session-A', 2)?.runId, secondRunId)

// ── C2L-05：两会话不串 ─────────────────────────────────────────────────
runtimeInputs.bind(createHostBindingCapability({ sessionId: 'session-B', platform: 'dsh' }), {
  platform: 'dsh',
  stableUserId: 'u-b',
  contactId: 'ct_bbbb1',
  sessionId: 'session-B',
  trustedSource: 'host',
})
const agentB = { id: 'session-B' }
const bInjected = injector.inject(agentB, userMessage('团子'), { turn: 1, step: 0 })
const bRunId = (bInjected.messages[bInjected.messages.length - 1] as {
  source?: { psyche?: { runId?: string } }
}).source?.psyche?.runId
ok('两会话各自的 runId 不同', bRunId !== undefined && bRunId !== runId)
eq('session-B turn=1 回执独立', findPreStepRun(db, 'session-B', 1)?.runId, bRunId)
eq('session-A turn=1 回执未被覆盖', findPreStepRun(db, 'session-A', 1)?.runId, runId)

// ── C2L-06：旧记录保持 NULL ────────────────────────────────────────────
const old: RecallRunInput = {
  runId: 'run_legacy',
  requestId: null,
  personaId: 'main',
  queryHash: null,
  queryMode: 'recall',
  scopeType: 'global',
  scopeHash: null,
  requestedLimit: 8,
  matchedCount: 0,
  eligibleCount: 0,
  returnedCount: 0,
  abstained: true,
  compositionStatus: 'completed',
  keyVersion: 1,
  createdAt: new Date(0).toISOString(),
}
createRecallRun(db, old)
const legacy = listRecallRuns(db, 50).find((row) => row.runId === 'run_legacy')
eq('旧记录 sessionRef 为 null', legacy?.sessionRef, null)
eq('旧记录 turn 为 null', legacy?.turn, null)

// ── C2L-07：有注入但无回执 → 不显示数量 ────────────────────────────────
const noReceipt = new PreStepInjector({ db, runtimeInputs })
const noReceiptResult = noReceipt.inject(agentA, userMessage('团子'), { turn: 9, step: 0 })
const noReceiptMeta = (noReceiptResult.messages[noReceiptResult.messages.length - 1] as {
  source?: { psyche?: { runId?: string } }
}).source?.psyche
ok('无回执时消息仍带 injection 标识', noReceiptMeta?.injection === 'memory-context')
eq('无回执时不带 runId', noReceiptMeta?.runId, undefined)

// ── C2L-08：完成状态判定（UI 只认 completed + 实际注入）───────────────
function isInjectedRun(run: { compositionStatus: string; returnedCount: number; abstained: boolean }): boolean {
  return run.compositionStatus === 'completed' && run.returnedCount > 0 && !run.abstained
}
const done = listRecallRuns(db, 50).find((row) => row.runId === runId)
ok('成功注入的回执判定为已注入', done !== undefined && isInjectedRun(done))
createRecallRun(db, {
  ...old,
  runId: 'run_pending',
  queryMode: 'pre-step',
  compositionStatus: 'pending',
  sessionRef: 'session-C',
  turn: 1,
})
createRecallRun(db, {
  ...old,
  runId: 'run_interrupted',
  queryMode: 'pre-step',
  compositionStatus: 'interrupted',
  sessionRef: 'session-C',
  turn: 2,
})
const pending = listRecallRuns(db, 50).find((row) => row.runId === 'run_pending')
const interrupted = listRecallRuns(db, 50).find((row) => row.runId === 'run_interrupted')
ok('pending 不算已注入', pending !== undefined && !isInjectedRun(pending))
ok('interrupted 不算已注入', interrupted !== undefined && !isInjectedRun(interrupted))

// ── 收尾 ───────────────────────────────────────────────────────────────
db.close?.()
rmSync(dir, { recursive: true, force: true })
console.log(`\n[C2-B] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exit(1)
