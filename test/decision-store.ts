// 决策回执（P2 Completion Batch 阶段 2，schema v16）。
//
// 验收口径：
// - 一次决策一个壳：op_id 唯一，重试幂等；
// - 依据是 pending 期追加的多态引用，终态后不许再改；
// - 需要依据的决策（clash/revise/review/stance）不许空依据提交；
// - 只读函数不写库；同状态收尾幂等，不同状态抛 E_STATE；
// - `listDecisions` 的 artifactId 同时匹配结果与依据。
//
// 跑法：node test/decision-store.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import {
  appendDecisionItems,
  createDecision,
  finalizeDecision,
  getDecision,
  listDecisions,
} from '../dist/lib/decision-store.js'

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
function throws(label: string, fn: () => unknown, code?: string): void {
  try {
    fn()
    ok(label, false, { threw: false })
  } catch (error) {
    const actual = (error as { code?: string }).code
    ok(label, code === undefined || actual === code, { actual, expected: code })
  }
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-decision-store-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)

console.log('\n[Decision Store] schema v16')

eq('schema 版本是 31', Number((db.get('PRAGMA user_version') as { user_version?: number }).user_version ?? 0), 31)
const tables = db.all<{ name: string }>(
  `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'fts_index%' AND name NOT LIKE 'sqlite_%'`,
)
eq('表数 70（含 decision_runs / decision_items / diaries / diary_versions / mood_meta / proactive_outbox / growth_confirmations / memory_merge_events / memory_archive_events / external_sources / external_source_deletion_events / external_source_erase_events）', tables.length, 70)
ok('decision_runs 存在', tables.some((t) => t.name === 'decision_runs'))
ok('decision_items 存在', tables.some((t) => t.name === 'decision_items'))

console.log('\n[Decision Store] 建壳与幂等')
const shell = createDecision(db, {
  opId: 'op-decide-1',
  kind: 'revise',
  actor: 'core',
  inputHash: 'hash-1',
  createdAt: '2026-11-09T04:00:00.000Z',
})
eq('建壳成功', shell.created, true)
eq('初始状态 pending', shell.record.status, 'pending')
ok('decision_id 有前缀 dec_', shell.record.decisionId.startsWith('dec_'))
const again = createDecision(db, {
  opId: 'op-decide-1',
  kind: 'revise',
  actor: 'core',
  inputHash: 'hash-1',
})
eq('同 opId 重试不新建', again.created, false)
eq('同 opId 返回同一条', again.record.decisionId, shell.record.decisionId)
throws('opId 为空被拒', () => createDecision(db, { opId: '  ', kind: 'revise', inputHash: 'h' }), 'E_VALIDATION')
throws('kind 非法被拒', () =>
  createDecision(db, { opId: 'op-bad-kind', kind: 'nope' as never, inputHash: 'h' }),
'E_VALIDATION',
)
throws('缺少 inputHash 被拒', () => createDecision(db, { opId: 'op-no-hash', kind: 'revise', inputHash: '' }), 'E_VALIDATION')

console.log('\n[Decision Store] 追加依据')
const items = appendDecisionItems(db, shell.record.decisionId, [
  { refType: 'artifact', refId: 'art_tea', refRevision: 1, role: 'input' },
  { refType: 'evidence', refId: 'ev_1', role: 'input' },
  { refType: 'artifact', refId: 'art_coffee', refRevision: 2, role: 'rejected' },
])
eq('追加三条依据', items.length, 3)
eq('依据读回三条', getDecision(db, shell.record.decisionId)?.items.length, 3)
throws('unknown refType 被拒', () =>
  appendDecisionItems(db, shell.record.decisionId, [{ refType: 'nope' as never, refId: 'x' }]),
'E_VALIDATION',
)
throws('缺 refId 被拒', () =>
  appendDecisionItems(db, shell.record.decisionId, [{ refType: 'artifact', refId: '' }]),
'E_VALIDATION',
)

console.log('\n[Decision Store] 收尾与状态机')
throws('revise 空依据不许提交', () => {
  const bare = createDecision(db, { opId: 'op-bare', kind: 'review', inputHash: 'h-bare' })
  finalizeDecision(db, bare.record.decisionId, { status: 'committed' })
}, 'E_VALIDATION')

const finalized = finalizeDecision(db, shell.record.decisionId, {
  status: 'committed',
  reason: '旧结论被新证据取代',
  resultArtifactId: 'art_tea',
  resultRevision: 2,
  finalizedAt: '2026-11-09T04:01:00.000Z',
})
eq('状态 committed', finalized.status, 'committed')
eq('结果 artifact 记下', finalized.resultArtifactId, 'art_tea')
eq('结果 revision 记下', finalized.resultRevision, 2)
eq('收尾时间记下', finalized.finalizedAt, '2026-11-09T04:01:00.000Z')
eq('同状态收尾幂等', finalizeDecision(db, shell.record.decisionId, { status: 'committed' }).status, 'committed')
throws('终态不能改 rejected', () => finalizeDecision(db, shell.record.decisionId, { status: 'rejected' }), 'E_STATE')
throws('终态不能追加依据', () =>
  appendDecisionItems(db, shell.record.decisionId, [{ refType: 'artifact', refId: 'art_late' }]),
'E_STATE',
)

console.log('\n[Decision Store] 拒绝与失败也是回执')
const rejected = createDecision(db, { opId: 'op-reject', kind: 'remember', inputHash: 'h-reject' })
appendDecisionItems(db, rejected.record.decisionId, [{ refType: 'source', refId: 'src_1', role: 'rejected' }])
const rejectedRun = finalizeDecision(db, rejected.record.decisionId, { status: 'rejected', reason: '来源不可信' })
eq('rejected 记原因', rejectedRun.reason, '来源不可信')
eq('rejected 状态', rejectedRun.status, 'rejected')
const failedRun = createDecision(db, { opId: 'op-fail', kind: 'diary', inputHash: 'h-fail' })
eq(
  'failed 状态',
  finalizeDecision(db, failedRun.record.decisionId, { status: 'failed', reason: '生成失败' }).status,
  'failed',
)

console.log('\n[Decision Store] 列表与过滤')
const reviseOnly = listDecisions(db, { kind: 'revise' })
eq('按 kind 过滤', reviseOnly.length, 1)
eq('按 status 过滤', listDecisions(db, { status: 'rejected' }).length, 1)
const byArtifact = listDecisions(db, { artifactId: 'art_coffee' })
eq('按依据 artifactId 命中', byArtifact.length, 1)
eq('按结果 artifactId 命中', listDecisions(db, { artifactId: 'art_tea' }).length, 1)
eq('未知 artifact 不命中', listDecisions(db, { artifactId: 'art_missing' }).length, 0)
eq('默认 limit 生效（4 条）', listDecisions(db).length, 4)
eq('limit 生效', listDecisions(db, { limit: 2 }).length, 2)

console.log('\n[Decision Store] 只读幂等')
eq('重复读同一条', getDecision(db, shell.record.decisionId)?.run.status, 'committed')
eq('空 id 返回 null', getDecision(db, ''), null)
eq('不存在的 id 返回 null', getDecision(db, 'dec_missing'), null)

console.log(`\n[P2-Decision Store] ${passed} 通过 ${failed} 失败`)
db.close()
rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exit(1)
