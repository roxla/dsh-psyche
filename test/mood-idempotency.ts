// Mood 幂等测试（P3-A B1）：opId 重放、跨连接幂等、版本只推进一次、历史不重复。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../packages/core/dist/adapter.js'
import { applyMood, ensureMoodInitialized, readMoodMeta } from '../packages/core/dist/mood-store.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-mood-idem-'))
const file = join(dir, 'memory.sqlite3')
const first = await openDatabase({ file })
ensureMoodInitialized(first.db, { now: '2026-01-01T00:00:00.000Z' })

const one = applyMood(first.db, { opId: 'idem-1', deltas: { calm: 5 }, now: '2026-01-01T01:00:00.000Z' })
check(one.applied && one.stateVersion === 2, '首次应用')

// 同 opId + 不同 deltas：必须返回重放，不应用新 delta
const two = applyMood(first.db, { opId: 'idem-1', deltas: { calm: 90 }, now: '2026-01-01T02:00:00.000Z' })
check(two.applied === false && two.replayed === true, '同 opId 不同 deltas 走重放')
check(two.stateVersion === 2, '重放不推进版本')
const historyOne = first.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM global_mood_history') as { n: number }
check(Number(historyOne.n) === 33, '重放不新增历史')

// 跨连接幂等：关掉重开再重放
first.db.close()
const second = await openDatabase({ file })
const three = applyMood(second.db, { opId: 'idem-1', deltas: { calm: 1 }, now: '2026-01-01T03:00:00.000Z' })
check(three.applied === false && three.replayed === true, '跨连接仍识别为已应用')
check(readMoodMeta(second.db)?.stateVersion === 2, '跨连接版本不变')

// 换 opId：正常应用并推进
const four = applyMood(second.db, { opId: 'idem-2', deltas: { happy: 5 }, now: '2026-01-01T04:00:00.000Z' })
check(four.applied === true && four.stateVersion === 3, '新 opId 正常应用')
const historyTwo = second.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM global_mood_history') as { n: number }
check(Number(historyTwo.n) === 66, '第二次操作再加 33 行')

// 历史里每个 opId 恰好 33 行
const perOp = second.db.all<{ op_id: string; n: number }>(
  'SELECT op_id, COUNT(*) AS n FROM global_mood_history WHERE op_id IS NOT NULL GROUP BY op_id ORDER BY op_id',
) as Array<{ op_id: string; n: number }>
check(perOp.length === 2, '两个 opId')
check(perOp.every((row) => Number(row.n) === 33), '每个 opId 33 行')
check(readMoodMeta(second.db)?.lastOpId === 'idem-2', 'meta.last_op_id 指向最近一次')

second.db.close()
rmSync(dir, { recursive: true, force: true })
console.log(`[P3-A B1 mood-idempotency] ${passed} 通过 0 失败`)
