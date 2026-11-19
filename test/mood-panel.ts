// B4-1 只读情绪面板数据测试：33 维分组、当前语气、历史按 op_id 还原、窗口、只读、空态。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../packages/core/dist/adapter.js'
import { MOOD_KEYS, MOOD_PERSONA_ID } from '../packages/core/dist/mood-schema.js'
import { applyMood, ensureMoodInitialized } from '../packages/core/dist/mood-store.js'
import { buildMoodPanel, clampMoodPanelLimit } from '../dist/lib/mood-panel.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}
function near(actual: number, expected: number, tolerance: number, message: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}（actual=${actual} expected=${expected}）`)
  passed += 1
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-mood-panel-'))
const file = join(dir, 'memory.sqlite3')
const opened = await openDatabase({ file })
const db = opened.db

function count(table: string): number {
  return Number((db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`) as { n: number }).n)
}

// 1) 空库：33 维默认值、三组 11/18/4、空历史、中性语气；不写任何表
const before = { state: count('global_mood_state'), history: count('global_mood_history'), meta: count('mood_meta') }
const empty = buildMoodPanel(db)
check(empty.ok === true, '空库也返回 ok')
check(empty.groups.basic.length === 11, '基础维度 11')
check(empty.groups.compound.length === 18, '复合维度 18')
check(empty.groups.contemporary.length === 4, '当代维度 4')
check(empty.groups.basic.length + empty.groups.compound.length + empty.groups.contemporary.length === 33, '合计 33 维')
check(empty.tone.tone === '平稳' && empty.tone.neutral === true, '空库语气为平稳')
check(empty.history.length === 0 && empty.historyTotal === 0, '空历史')
check(empty.historyLimit === 30, '默认窗口 30')
check(count('global_mood_state') === before.state, '空库读取不写 state')
check(count('global_mood_history') === before.history, '空库读取不写 history')
check(count('mood_meta') === before.meta, '空库读取不写 meta')

// 2) 一次写入 = 一个快照（33 行不拆成 33 个时间点）
ensureMoodInitialized(db, { now: '2026-01-01T00:00:00.000Z' })
applyMood(db, { opId: 'panel-op-1', deltas: { happy: 6 }, reason: 'test', now: '2026-01-01T01:00:00.000Z' })
const one = buildMoodPanel(db)
check(one.history.length === 1, '一次写入还原为一个快照')
check(one.historyTotal === 1, 'historyTotal=1')
check(one.history[0]?.at === '2026-01-01T01:00:00.000Z', '快照 at 保留 UTC 原文')
near(one.history[0]?.values.happy ?? -1, 36, 1e-9, '历史值是原始持久化值（30+6）')
near(one.history[0]?.values.calm ?? -1, 45, 1e-9, '未变维度也在快照里')
check(Object.keys(one.history[0]?.values ?? {}).length === MOOD_KEYS.length, '快照含全部 33 维')

// 3) 第二次写入 → 两个快照，按时间升序
applyMood(db, { opId: 'panel-op-2', deltas: { happy: 6 }, reason: 'test', now: '2026-01-01T02:00:00.000Z' })
const secondWrite = applyMood(db, { opId: 'panel-op-3', deltas: { happy: 6 }, reason: 'test', now: '2026-01-01T03:00:00.000Z' })
const two = buildMoodPanel(db)
check(two.history.length === 3, '三次写入三个快照')
check(two.history[0]?.at === '2026-01-01T01:00:00.000Z' && two.history[2]?.at === '2026-01-01T03:00:00.000Z', '快照按时间升序')
check(two.historyTotal === 3, 'historyTotal 随写入增长')

// 4) 窗口：只取最近 limit 个；总数不受窗口影响
const limited = buildMoodPanel(db, { limit: 1 })
check(limited.history.length === 1, 'limit=1 只返回一个快照')
check(limited.history[0]?.at === '2026-01-01T03:00:00.000Z', 'limit 取最近一个')
check(limited.historyTotal === 3 && limited.historyLimit === 1, '窗口与总数分离')

// 5) limit 收口
check(clampMoodPanelLimit(undefined) === 30, 'undefined → 30')
check(clampMoodPanelLimit('') === 30, '空串 → 30')
check(clampMoodPanelLimit('abc') === 30, '非数字 → 30')
check(clampMoodPanelLimit(0) === 1, '0 夹到 1')
check(clampMoodPanelLimit(999) === 120, '超上限夹到 120')
check(clampMoodPanelLimit('7') === 7, '数字串可用')

// 6) 只读：读取前后状态/历史/meta 不变
const beforeRead = { state: count('global_mood_state'), history: count('global_mood_history'), meta: count('mood_meta') }
const versionBefore = Number((db.get<{ n: number }>('SELECT state_version AS n FROM mood_meta WHERE persona_id = ?', [MOOD_PERSONA_ID]) as { n: number }).n)
buildMoodPanel(db, { limit: 5 })
check(count('global_mood_state') === beforeRead.state, '读取不写 state')
check(count('global_mood_history') === beforeRead.history, '读取不写 history')
check(count('mood_meta') === beforeRead.meta, '读取不写 meta')
const versionAfter = Number((db.get<{ n: number }>('SELECT state_version AS n FROM mood_meta WHERE persona_id = ?', [MOOD_PERSONA_ID]) as { n: number }).n)
check(versionAfter === versionBefore, 'state_version 不变')

// 7) 不完整快照（不足 33 行）被丢弃，也不计入总数
const at = '2026-01-01T03:00:00.000Z'
for (const key of MOOD_KEYS.slice(0, 5)) {
  db.run(
    'INSERT INTO global_mood_history (persona_id, dimension, value, op_id, reason, at) VALUES (?, ?, ?, ?, ?, ?)',
    [MOOD_PERSONA_ID, key, 30, 'panel-op-partial', 'test', at],
  )
}
const partial = buildMoodPanel(db)
check(partial.history.length === 3, '不完整快照被丢弃')
check(partial.historyTotal === 3, '不完整快照不计入总数')

// 8) 响应裁剪：不含内部标识/规则细节
const json = JSON.stringify(two)
check(!json.includes('op_id'), '响应不含 op_id')
check(!json.includes('"reason"'), '响应不含 reason')
check(!json.includes('strength'), '响应不含 strength')
check(two.tone.projectionVersion === 1, '投影版本只在 tone 里')

// 9) 当前值按真实时间衰减（示例库的写入在 2026-01，距现在已超过半衰期），历史仍保留原始值
const now = buildMoodPanel(db)
near(now.groups.basic.find((item) => item.key === 'happy')?.value ?? -1, 30, 0.01, '当前值按半衰期衰减回基线')
near(now.history[2]?.values.happy ?? -1, secondWrite.values.happy ?? -1, 1e-9, '历史保留最后一次写入的原始值')
check(now.updatedAt === '2026-01-01T03:00:00.000Z', '当前值时间取最后一次写入')

db.close()
rmSync(dir, { recursive: true, force: true })
console.log(`[P3-A B4 mood-panel] ${passed} 通过 0 失败`)
