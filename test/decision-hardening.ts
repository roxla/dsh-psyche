// 决策回执定向补强（阶段 2 收尾，不重跑历史专项）。
//
// 三条针对性验收：
// - actor 在 Store 层固定为 core，调用方不能伪造决策主体；
// - 依据批量追加在一个事务里：部分失败整批回滚，同 opId 重试不产生重复依据；
// - 收尾检查 UPDATE 的 changes：同状态重放幂等，不同终态（含并发抢先）抛 E_STATE。
//
// 跑法：node test/decision-hardening.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import {
  appendDecisionItems,
  createDecision,
  finalizeDecision,
  getDecision,
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

const dir = mkdtempSync(join(tmpdir(), 'psyche-decision-hardening-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)

console.log('\n[Decision Hardening] actor 固定为 core')
throws(
  '调用方传 actor=model 被拒',
  () => createDecision(db, { opId: 'op-hard-actor', kind: 'revise', actor: 'model', inputHash: 'h' }),
  'E_VALIDATION',
)
throws(
  '调用方传 actor=adapter 被拒',
  () => createDecision(db, { opId: 'op-hard-actor2', kind: 'revise', actor: 'adapter', inputHash: 'h' }),
  'E_VALIDATION',
)
const shell = createDecision(db, { opId: 'op-hard-1', kind: 'revise', inputHash: 'hash-hard' })
eq('不传 actor 时记为 core', shell.record.actor, 'core')
eq('壳初始 pending', shell.record.status, 'pending')

console.log('\n[Decision Hardening] 依据批量追加的原子性与重试')
throws(
  '批量里有一条非法 refType → 整批被拒',
  () =>
    appendDecisionItems(db, shell.record.decisionId, [
      { refType: 'artifact', refId: 'art_a', refRevision: 1, role: 'input' },
      { refType: 'nope' as never, refId: 'art_b' },
    ]),
  'E_VALIDATION',
)
eq('失败后一条依据都没写', getDecision(db, shell.record.decisionId)?.items.length, 0)
eq('壳仍是 pending', getDecision(db, shell.record.decisionId)?.run.status, 'pending')

const firstTry = appendDecisionItems(db, shell.record.decisionId, [
  { refType: 'artifact', refId: 'art_a', refRevision: 1, role: 'input' },
])
eq('重试只写一条合法依据', firstTry.length, 1)
eq('库里也只有一条', getDecision(db, shell.record.decisionId)?.items.length, 1)
const retry = appendDecisionItems(db, shell.record.decisionId, [
  { refType: 'artifact', refId: 'art_a', refRevision: 1, role: 'input' },
])
eq('同一条依据再追加会新增（调用方负责幂等键，不在批量层去重）', retry.length, 1)

console.log('\n[Decision Hardening] 收尾 changes 与并发')
const finalized = finalizeDecision(db, shell.record.decisionId, { status: 'committed', reason: 'hardening' })
eq('正常收尾为 committed', finalized.status, 'committed')
eq('同状态重放幂等', finalizeDecision(db, shell.record.decisionId, { status: 'committed' }).status, 'committed')
throws(
  '不同终态抛 E_STATE',
  () => finalizeDecision(db, shell.record.decisionId, { status: 'rejected' }),
  'E_STATE',
)

const raced = createDecision(db, { opId: 'op-hard-race', kind: 'clash', inputHash: 'hash-race' })
appendDecisionItems(db, raced.record.decisionId, [
  { refType: 'artifact', refId: 'art_r1', refRevision: 1 },
  { refType: 'artifact', refId: 'art_r2', refRevision: 1 },
])
// 模拟另一个进程在「读到 pending 之后」抢先收尾：直接改库，再走 normal finalize
db.run(`UPDATE decision_runs SET status = 'committed', finalized_at = '2026-11-09T05:00:00.000Z' WHERE decision_id = ?`, [
  raced.record.decisionId,
])
eq('被抢先收尾后同状态仍幂等', finalizeDecision(db, raced.record.decisionId, { status: 'committed' }).status, 'committed')
throws(
  '被抢先收尾后改另一终态抛 E_STATE',
  () => finalizeDecision(db, raced.record.decisionId, { status: 'rejected' }),
  'E_STATE',
)
throws(
  '终态后追加依据抛 E_STATE',
  () => appendDecisionItems(db, raced.record.decisionId, [{ refType: 'artifact', refId: 'art_r3' }]),
  'E_STATE',
)

console.log(`\n[Decision Hardening] ${passed} 通过 ${failed} 失败`)
db.close()
rmSync(dir, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
