// Mood Store 测试（P3-A B1）：初始化、读不写库、写入事务、幂等、回滚、旧快照导入。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../packages/core/dist/adapter.js'
import { MOOD_KEYS, defaultMoodValues } from '../packages/core/dist/mood-schema.js'
import {
  applyMood,
  ensureMoodInitialized,
  importLegacyMood,
  loadMood,
  readMoodMeta,
} from '../packages/core/dist/mood-store.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}
function near(actual: number, expected: number, tolerance: number, message: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}（actual=${actual} expected=${expected}）`)
  passed += 1
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-mood-store-'))
const file = join(dir, 'memory.sqlite3')
const opened = await openDatabase({ file })
const db = opened.db

function countState(): number {
  return Number((db.get<{ n: number }>('SELECT COUNT(*) AS n FROM global_mood_state') as { n: number }).n)
}
function countHistory(): number {
  return Number((db.get<{ n: number }>('SELECT COUNT(*) AS n FROM global_mood_history') as { n: number }).n)
}

// 1) 读路径不写库：没有状态时返回默认值，表保持 0 行
const beforeRead = countState()
const empty = loadMood(db, { now: '2026-01-01T00:00:00.000Z' })
check(countState() === beforeRead, 'loadMood 不写库')
check(empty.updatedAt === null, '空状态 updatedAt 为 null')
check(Object.keys(empty.values).length === 33, '空状态返回 33 维默认值')

// 2) 初始化：33 行 + 1 行 meta
const meta = ensureMoodInitialized(db, { now: '2026-01-01T00:00:00.000Z' })
check(meta.stateVersion === 1, '初始化 meta.stateVersion=1')
check(meta.configVersion === 1, '初始化 configVersion=1')
check(countState() === 33, '初始化 33 行状态')
check(readMoodMeta(db)?.updatedAt === '2026-01-01T00:00:00.000Z', 'meta updated_at 正确')
const again = ensureMoodInitialized(db, { now: '2026-01-02T00:00:00.000Z' })
check(again.updatedAt === '2026-01-01T00:00:00.000Z', '重复初始化不覆盖时间')

// 3) applyMood：只给 calm +10，33 行 history 都要写
const applied = applyMood(db, { opId: 'mood-op-1', deltas: { calm: 10 }, reason: 'test', now: '2026-01-01T01:00:00.000Z' })
check(applied.applied === true, '首次应用生效')
check(applied.replayed === false, '首次应用不是重放')
check(applied.stateVersion === 2, 'stateVersion 只 +1')
near(applied.values.calm ?? -1, 55, 1e-9, 'calm 45+10=55')
check(countHistory() === 33, '一次操作写 33 条历史')
check(countState() === 33, '状态仍是 33 行')
const calmRow = db.get<{ value: number; updated_at: string }>(
  "SELECT value, updated_at FROM global_mood_state WHERE persona_id = 'main' AND dimension = 'calm'",
) as { value: number; updated_at: string }
near(calmRow.value, 55, 1e-9, '持久化 calm=55')
check(calmRow.updated_at === '2026-01-01T01:00:00.000Z', '持久化 updated_at')
check(readMoodMeta(db)?.lastOpId === 'mood-op-1', 'meta.last_op_id 记录')

// 4) 幂等：同 opId 重放不写库
const replay = applyMood(db, { opId: 'mood-op-1', deltas: { calm: 99 }, now: '2026-01-01T02:00:00.000Z' })
check(replay.applied === false, '重放不应用')
check(replay.replayed === true, '重放标记')
check(replay.stateVersion === 2, '重放不推进版本')
check(countHistory() === 33, '重放不新增历史')
// 重放返回的是「当前有效值」：calm=55 经过 1 小时后已向 baseline 回落（6h 半衰期）
const replayedCalm = Number(replay.values.calm ?? 0)
check(replayedCalm <= 55 && replayedCalm >= 53, `重放返回衰减后的当前值（${replayedCalm}）`)

// 5) 先衰减再应用：4 小时后 happy 从 100 回落到 65
applyMood(db, { opId: 'mood-op-2', deltas: { happy: 70 }, now: '2026-01-01T02:00:00.000Z' }) // 30→100
const decayed = applyMood(db, { opId: 'mood-op-3', deltas: {}, now: '2026-01-01T06:00:00.000Z' })
near((decayed.values.happy ?? -1), 65, 1e-6, '一个半衰期后 100→65')
check(decayed.stateVersion === 4, '每次操作版本 +1')

// 6) loadMood 读时衰减，不写库
const historical = countHistory()
const loaded = loadMood(db, { now: '2026-01-01T14:00:00.000Z' }) // 再 8 小时 = 两个半衰期
near((loaded.values.happy ?? -1), 38.75, 1e-6, 'loadMood 实时衰减 100→38.75')
check(countHistory() === historical, 'loadMood 不写历史')

// 7) 非法入参：空 opId、未知维度、越界
for (const bad of [
  { opId: '', deltas: { calm: 1 } },
  { opId: 'mood-op-bad', deltas: { nope: 1 } },
  { opId: 'mood-op-bad2', deltas: { calm: 999 } },
]) {
  let threw = false
  try {
    applyMood(db, bad as { opId: string; deltas: Record<string, number> })
  } catch {
    threw = true
  }
  check(threw, `非法输入被拒绝：${JSON.stringify(bad)}`)
}
check(countHistory() === historical, '非法输入不写历史')

// 8) 事务回滚：删掉 meta 表后 apply 整体回滚，state 不出现半截更新
db.exec('DROP TABLE mood_meta')
let rollbackThrew = false
try {
  applyMood(db, { opId: 'mood-op-rollback', deltas: { calm: 50 }, now: '2026-01-02T00:00:00.000Z' })
} catch {
  rollbackThrew = true
}
check(rollbackThrew, '缺少 meta 表时抛错')
check(countHistory() === historical, '失败不写历史')

// 重建 meta 便于后续测试
db.exec(`CREATE TABLE mood_meta (
  persona_id TEXT PRIMARY KEY REFERENCES persona_config(persona_id),
  state_version INTEGER NOT NULL DEFAULT 1,
  config_version INTEGER NOT NULL DEFAULT 1,
  last_op_id TEXT,
  updated_at TEXT NOT NULL
)`)
db.run(
  "INSERT INTO mood_meta (persona_id, state_version, config_version, last_op_id, updated_at) VALUES ('main', 4, 1, 'mood-op-3', '2026-01-01T06:00:00.000Z')",
)

// 9) 旧快照导入：只导入初始状态、不写历史
const imported = importLegacyMood(db, { values: { happy: 80, calm: 20, nope: 1 } }, { now: '2026-01-03T00:00:00.000Z' })
check(imported.imported === true, '导入成功')
check(imported.applied === 2, '只应用可映射的两维')
check(imported.warnings.length === 1, '未知维度给 warning')
check(countHistory() === historical, '导入不写历史')
const importedRow = db.get<{ value: number }>(
  "SELECT value FROM global_mood_state WHERE persona_id = 'main' AND dimension = 'happy'",
) as { value: number }
near(importedRow.value, 80, 1e-9, '导入覆盖 happy=80')
check(readMoodMeta(db)?.lastOpId === 'legacy-import', '导入记录来源')

const secondImport = importLegacyMood(db, { values: { happy: 10 } }, { now: '2026-01-04T00:00:00.000Z' })
check(secondImport.imported === false, '重复导入跳过')
near(
  (db.get<{ value: number }>("SELECT value FROM global_mood_state WHERE persona_id = 'main' AND dimension = 'happy'") as { value: number }).value,
  80,
  1e-9,
  '重复导入不改值',
)

db.close()
rmSync(dir, { recursive: true, force: true })
console.log(`[P3-A B1 mood-store] ${passed} 通过 0 失败`)
