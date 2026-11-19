// 每轮编排测试（P3-A B2）：op_id/reason 格式、unknown 不写、user 写入、重放不二次写、失败降级。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../packages/core/dist/adapter.js'
import { applyMoodTurn, moodTurnKey, moodTurnOpId } from '../packages/core/dist/mood-turn.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-mood-turn-'))
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3') })
const db = opened.db

function countHistory(): number {
  return Number((db.get<{ n: number }>('SELECT COUNT(*) AS n FROM global_mood_history') as { n: number }).n)
}
function historyReason(opId: string): string | null {
  const row = db.get<{ reason: string | null }>(
    'SELECT reason FROM global_mood_history WHERE op_id = ? LIMIT 1',
    [opId],
  ) as { reason: string | null } | undefined
  return row?.reason ?? null
}

// 1) user 轮：写入，op_id / reason 格式正确
const applied = applyMoodTurn(db, {
  sessionRef: 'session-1',
  turn: 1,
  texts: ['今天好累，真的撑不住了', '谢谢你'],
  now: '2026-01-01T00:00:00.000Z',
})
check(applied.initiator === 'user', 'user 判定')
check(applied.applied === true && applied.replayed === false, '首次写入')
check(applied.opId === 'mood:main:session-1:1', 'op_id 格式')
check(applied.reason === 'applied', 'reason=applied')
check(historyReason(applied.opId) === 'turn:session-1:1', 'history.reason 格式')
check(countHistory() === 33, '一次写入 33 条历史')
check(applied.stateVersion === 2, 'state_version +1')
check(applied.distress === true, 'distress 透传')
check(applied.values?.sympathy === 18, 'sympathy 13+5')
check(moodTurnKey('s', 3) === 's:3', 'turnKey 格式')
check(moodTurnOpId('s', 3) === 'mood:main:s:3', 'opId 函数')

// 2) 同轮重放：不二次写，值不再变
const replayed = applyMoodTurn(db, {
  sessionRef: 'session-1',
  turn: 1,
  texts: ['完全不同的文本：摆烂、内耗、破防'],
  now: '2026-01-02T00:00:00.000Z',
})
check(replayed.applied === false && replayed.replayed === true, '重放不写')
check(replayed.reason === 'replayed', 'reason=replayed')
check(countHistory() === 33, '重放不新增历史')
check(replayed.stateVersion === 2, '重放不推进版本')
check((replayed.values?.sympathy ?? 0) < 18 && (replayed.values?.sympathy ?? 0) > 13, '重放返回值是读时衰减后的值')

// 3) unknown：没有真实用户消息，不写
const before = countHistory()
const unknown = applyMoodTurn(db, { sessionRef: 'session-2', turn: 1, texts: [] })
check(unknown.initiator === 'unknown', 'unknown 判定')
check(unknown.reason === 'untrusted-initiator', 'unknown 跳过')
check(unknown.applied === false, 'unknown 不写')
check(countHistory() === before, 'unknown 不新增历史')

// 4) persona / scheduled 在 v1 只识别不评估
const persona = applyMoodTurn(db, {
  sessionRef: 'session-3',
  turn: 1,
  texts: ['谢谢你'],
  tokens: { persona: { trigger: 'reflection' } },
})
check(persona.initiator === 'persona' && persona.reason === 'initiator-not-user', 'persona 跳过')
check(persona.applied === false, 'persona 不写')

// 5) 无信号：空转不写历史
const noSignal = applyMoodTurn(db, { sessionRef: 'session-4', turn: 1, texts: ['abcxyz 123 456'] })
check(noSignal.reason === 'no-signal', '无命中跳过')
check(countHistory() === before, '无命中不写历史')

// 6) 非法 turn / 超长 op_id
check(applyMoodTurn(db, { sessionRef: 's', turn: 0, texts: ['谢谢'] }).reason === 'invalid-turn', 'turn=0 跳过')
check(applyMoodTurn(db, { sessionRef: 's', turn: Number.NaN, texts: ['谢谢'] }).reason === 'invalid-turn', 'NaN turn 跳过')
const tooLong = applyMoodTurn(db, { sessionRef: 'x'.repeat(200), turn: 1, texts: ['谢谢'] })
check(tooLong.reason === 'invalid-turn-key', 'op_id 超长跳过')

// 7) 未初始化：没有 persona_config 时不写、不建行
const fakeDb = { get: () => undefined } as unknown as typeof db
const orphan = applyMoodTurn(fakeDb, { sessionRef: 'session-5', turn: 1, texts: ['谢谢你'] })
check(orphan.reason === 'persona-not-initialized', '未初始化跳过')

// 8) maxDelta 生效
const tight = applyMoodTurn(db, {
  sessionRef: 'session-6',
  turn: 1,
  texts: ['失败失败失败失败，又错了又错了又错了，搞不定搞不定'],
  maxDelta: 2,
  now: '2026-01-03T00:00:00.000Z',
})
check(tight.applied === true, '自定义 maxDelta 写入')
const decayedCalm = 45 + (42 - 45) * Math.pow(2, -48 / 6)
check((tight.values?.calm ?? 0) >= decayedCalm - 2 - 1e-6, 'calm 下调不超过 maxDelta')
check((tight.values?.calm ?? 0) <= decayedCalm + 1e-6, 'calm 只下调不超过 maxDelta')

// 9) 轮首固化的 initiator 优先于消息重算
const frozen = applyMoodTurn(db, {
  sessionRef: 'session-7',
  turn: 1,
  texts: ['谢谢你'],
  initiator: 'persona',
})
check(frozen.initiator === 'persona' && frozen.reason === 'initiator-not-user', '轮首固化值不被消息覆盖')

// 10) 证据 id 透传：带本轮消息 id 正常写入
const withEvidence = applyMoodTurn(db, {
  sessionRef: 'session-8',
  turn: 1,
  texts: ['谢谢你', '今天很开心'],
  evidenceIds: ['msg-a', 'msg-b'],
  now: '2026-01-04T00:00:00.000Z',
})
check(withEvidence.applied === true, '带证据 id 写入')
check(withEvidence.opId === 'mood:main:session-8:1', '证据轮 op_id 不变')

// 11) 配置版本漂移：整批拒绝，不写
const driftBefore = countHistory()
const drift = applyMoodTurn(db, {
  sessionRef: 'session-9',
  turn: 1,
  texts: ['谢谢你'],
  configVersion: 2,
})
check(drift.reason === 'candidate-rejected', '配置漂移拒绝')
check((drift.violations ?? '').includes('config-version-mismatch'), '拒绝原因可读')
check(drift.applied === false && countHistory() === driftBefore, '拒绝不写历史')

// 12) 低置信度：整批拒绝
const low = applyMoodTurn(db, {
  sessionRef: 'session-10',
  turn: 1,
  texts: ['谢谢你'],
  confidence: 0.2,
})
check(low.reason === 'candidate-rejected', '低置信拒绝')
check((low.violations ?? '').includes('confidence-too-low'), '低置信原因')

// 13) 事件类型不允许：unknown 事件不产生变化
const wrongEvent = applyMoodTurn(db, {
  sessionRef: 'session-11',
  turn: 1,
  texts: ['谢谢你'],
  eventType: 'unknown',
})
check(wrongEvent.reason === 'candidate-rejected', '事件类型不允许时拒绝')
check((wrongEvent.violations ?? '').includes('dimension-not-allowed'), '维度不允许原因')

// 14) 无可信来源：turn 里没有真实用户消息，模型文本不能补出 user
const trustedBefore = countHistory()
const untrusted = applyMoodTurn(db, {
  sessionRef: 'session-12',
  turn: 1,
  texts: ['谢谢你'],
  userMessageCount: 0,
  initiator: undefined,
})
check(untrusted.reason === 'untrusted-initiator', '无可信来源不写')
check(untrusted.applied === false && countHistory() === trustedBefore, '无可信来源不落历史')

// 15) 已完成轮次：配置版本变化不得产生新的情绪变化
const done = applyMoodTurn(db, {
  sessionRef: 'session-13',
  turn: 1,
  texts: ['谢谢你'],
  configVersion: 1,
  now: '2026-01-05T00:00:00.000Z',
})
check(done.applied === true, '完成一轮')
function stateVersion(): number {
  const row = db.get<{ v: number }>('SELECT state_version AS v FROM mood_meta WHERE persona_id = ?', ['main']) as {
    v: number
  }
  return Number(row.v)
}
const versionBefore = stateVersion()
const historyBefore = countHistory()
const replay = applyMoodTurn(db, {
  sessionRef: 'session-13',
  turn: 1,
  texts: ['谢谢你'],
  configVersion: 2,
  now: '2026-01-05T00:00:00.000Z',
})
check(replay.reason === 'candidate-rejected', '完成轮次不接受新配置版本')
check(stateVersion() === versionBefore && countHistory() === historyBefore, '版本不变、历史不增')

// 16) 隔离：B2 写入不动 Source / Artifact / Event
function countOf(table: 'sources' | 'artifacts' | 'events'): number {
  return Number((db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`) as { n: number }).n)
}
const sourcesBefore = countOf('sources')
const artifactsBefore = countOf('artifacts')
const eventsBefore = countOf('events')
const isolated = applyMoodTurn(db, {
  sessionRef: 'session-14',
  turn: 1,
  texts: ['谢谢你'],
  now: '2026-01-06T00:00:00.000Z',
})
check(isolated.applied === true, '隔离轮写入')
check(
  countOf('sources') === sourcesBefore &&
    countOf('artifacts') === artifactsBefore &&
    countOf('events') === eventsBefore,
  'B2 写入不动 Source/Artifact/Event',
)

console.log(`[P3-A B2 mood-turn] ${passed} 通过 0 失败`)
