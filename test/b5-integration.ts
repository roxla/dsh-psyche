// P3-A B5-1/B5-2：Mood 的模块隔离与只读证明。
//
// 验收口径（docs/design/p3-a-b5-integration-acceptance.md）：
// - 同一剧本在「Mood 关闭」与「Mood 开启」两份独立库上各跑一遍；
// - 只比较结构化结果：非 Mood 表行数、Recall 候选 id/版本、Artifact、Growth 阶段；
// - 自然语言不在比较范围内；
// - Mood 写入只允许改 global_mood_state / global_mood_history / mood_meta；
// - 面板查询与投影不得产生任何写入。
//
// 跑法：node test/b5-integration.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { applyMoodTurn, loadMood, projectMoodTone } from '../dist/lib/mood.js'
import { buildMoodPanel } from '../dist/lib/mood-panel.js'
import { generateDiary } from '../dist/lib/diary-generation.js'
import { planStanceSynthesis } from '../dist/lib/stance-engine.js'

let passed = 0
let failed = 0

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

const log = { info() {}, debug() {}, warn() {}, error() {} }
const MOOD_TABLES = new Set(['global_mood_state', 'global_mood_history', 'mood_meta'])
const FIXED_NOW = '2026-11-12T04:00:00.000Z'

function tableCounts(db) {
  const tables = db
    .all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .map((row) => String(row.name))
    .filter((name) => !MOOD_TABLES.has(name))
    .sort()
  const counts = {}
  for (const name of tables) counts[name] = Number(db.get(`SELECT COUNT(*) AS n FROM "${name}"`)?.n ?? 0)
  return counts
}

function moodCounts(db) {
  const counts = {}
  for (const name of MOOD_TABLES) counts[name] = Number(db.get(`SELECT COUNT(*) AS n FROM ${name}`)?.n ?? 0)
  return counts
}

function recallKey(payload) {
  return payload.results.map((item) => `${item.artifactId}|${item.revision}|${item.state}|${item.supportEvidenceCount}`)
}

/** 固定剧本；Mood 分支只在固定位置多两次 applyMoodTurn。 */
async function script(core, db, withMood) {
  const ids = []
  ids.push((await core.capture({
    platform: 'dsh', channel: 'desktop', sessionRef: 'b5-session', origin: 'user', kind: 'message',
    text: '我习惯周五晚上打游戏，喜欢安静一点的环境。',
  })).sourceId)
  ids.push((await core.capture({
    platform: 'dsh', channel: 'desktop', sessionRef: 'b5-session', origin: 'user', kind: 'message',
    text: '我答应你，下周三之前把那份报告写完。',
  })).sourceId)
  ids.push((await core.capture({
    platform: 'dsh', channel: 'desktop', sessionRef: 'b5-session', origin: 'user', kind: 'message',
    text: '今天天气不错，随便聊聊。',
  })).sourceId)

  const moodTurn = (turn, text) =>
    applyMoodTurn(db, { sessionRef: 'b5-session', turn, texts: [text], initiator: 'user', now: FIXED_NOW })

  if (withMood) await moodTurn(1, '太好了，谢谢你，真的帮了我大忙，我特别开心！')

  const fact = await core.remember({
    text: '用户习惯周五晚上打游戏，喜欢安静的环境。',
    statement: '用户习惯周五晚上打游戏，喜欢安静的环境。',
    kind: 'fact',
    sourceIds: [ids[0]],
  })

  if (withMood) await moodTurn(2, '真是烦死了，怎么又错了，搞不定。')

  const commitment = await core.remember({ text: '用户承诺下周三之前写完报告。', eventType: 'commitment', sourceIds: [ids[1]] })

  const recall1 = await core.recall({ text: '打游戏', limit: 5 })
  const recall2 = await core.recall({ text: '报告 承诺', limit: 5 })

  if (withMood) await moodTurn(3, '今天天气不错，随便聊聊。')

  const growth = await core.syncGrowth()
  const state = await core.getState()

  // Diary：同一天、同一时区、同一固定 now；只比较结构化结果。
  const diary = await generateDiary(db, {
    scope: {},
    date: '2026-11-12',
    timezone: 'Asia/Shanghai',
    now: new Date(FIXED_NOW),
  })

  // Stance：纯函数计划；同输入必须同计划（active/skip、key、证据顺序）。
  const stancePlan = planStanceSynthesis({
    beliefs: [
      {
        artifactId: 'art-a', revision: 1, statement: '用户喜欢安静的环境。', state: 'active',
        group: '安静', direction: 'for', confidence: 'medium', updatedAt: FIXED_NOW,
        evidenceKeys: ['s1'], sessionRefs: ['b5-session'],
      },
      {
        artifactId: 'art-b', revision: 1, statement: '用户周五晚上打游戏。', state: 'active',
        group: '安静', direction: 'for', confidence: 'medium', updatedAt: FIXED_NOW,
        evidenceKeys: ['s2'], sessionRefs: ['b5-other'],
      },
    ],
    existing: null,
  })

  return {
    factId: fact.ok ? fact.payload?.artifactId ?? null : null,
    commitmentId: commitment.ok ? commitment.payload?.artifactId ?? null : null,
    recall1: recallKey(recall1),
    recall2: recallKey(recall2),
    growth: JSON.stringify(growth),
    phase: state.payload?.growth?.phase ?? null,
    diary: JSON.stringify({ created: diary.created, updated: diary.updated, sourceCount: diary.sourceCount, tensionCount: diary.tensionCount }),
    stance: JSON.stringify(stancePlan),
  }
}

const offDir = mkdtempSync(join(tmpdir(), 'psyche-b5-off-'))
const off = await openDatabase({ file: join(offDir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
migrate(off.db, log)
const coreOff = new Core({ db: off.db, config: {}, logger: log, dataDir: offDir })

const onDir = mkdtempSync(join(tmpdir(), 'psyche-b5-on-'))
const on = await openDatabase({ file: join(onDir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
migrate(on.db, log)
const coreOn = new Core({ db: on.db, config: {}, logger: log, dataDir: onDir })

console.log('\n[P3-A B5-1] 模块隔离回归')

const offResult = await script(coreOff, off.db, false)
const onResult = await script(coreOn, on.db, true)

eq('同一输入下 Recall#1 候选一致', onResult.recall1, offResult.recall1)
eq('同一输入下 Recall#2 候选一致', onResult.recall2, offResult.recall2)
eq('Artifact（fact）一致', onResult.factId, offResult.factId)
eq('Artifact（commitment）一致', onResult.commitmentId, offResult.commitmentId)
eq('Growth 推进结果一致', onResult.growth, offResult.growth)
eq('Growth 阶段一致', onResult.phase, offResult.phase)
eq('Diary 生成结果一致', onResult.diary, offResult.diary)
eq('Stance 合成计划一致', onResult.stance, offResult.stance)

const offCounts = tableCounts(off.db)
const onCounts = tableCounts(on.db)
eq('非 Mood 表行数完全一致', onCounts, offCounts)

console.log('\n[P3-A B5-2] 只读与写入边界')

const before = tableCounts(on.db)
const beforeMood = moodCounts(on.db)
const mood = loadMood(on.db)
const tone = projectMoodTone(mood.values)
const panel = buildMoodPanel(on.db, { limit: 10 })

ok('读 Mood 不写库', JSON.stringify(tableCounts(on.db)) === JSON.stringify(before))
ok('投影返回主语气', typeof tone.tone === 'string' && tone.tone.length > 0)
ok('面板返回 3 个历史快照', Array.isArray(panel.history) && panel.history.length === 3, panel.history?.length)
ok('面板当前值来自衰减有效值', Math.abs((panel.groups.basic.find((d) => d.key === 'calm')?.value ?? 0) - (mood.values.calm ?? 0)) < 0.02)

const beforeVersion = Number(on.db.get(`SELECT state_version FROM mood_meta WHERE persona_id = 'main'`)?.state_version ?? 0)
const beforeMoodRows = moodCounts(on.db)

const turn4 = { sessionRef: 'b5-session', turn: 4, texts: ['谢谢你，今天真的很开心。'], initiator: 'user', now: FIXED_NOW }
await applyMoodTurn(on.db, turn4)

const afterMoodRows = moodCounts(on.db)
ok('写入只增加 Mood 历史（+33）', afterMoodRows.global_mood_history - beforeMoodRows.global_mood_history === 33, {
  before: beforeMoodRows.global_mood_history,
  after: afterMoodRows.global_mood_history,
})
ok('写入不改其他 Mood 行数', afterMoodRows.global_mood_state === beforeMoodRows.global_mood_state && afterMoodRows.mood_meta === beforeMoodRows.mood_meta)
const afterVersion = Number(on.db.get(`SELECT state_version FROM mood_meta WHERE persona_id = 'main'`)?.state_version ?? 0)
ok('state_version 只加一', afterVersion === beforeVersion + 1, { beforeVersion, afterVersion })
eq('写入不触碰非 Mood 表', tableCounts(on.db), before)

const repeat = await applyMoodTurn(on.db, turn4)
ok('重复 op_id 幂等（replayed）', repeat.replayed === true)
eq('幂等重放不改变非 Mood 表', tableCounts(on.db), before)

console.log(`\n[P3-A B5] ${passed} 通过 ${failed} 失败`)
off.db.close()
on.db.close()
rmSync(offDir, { recursive: true, force: true })
rmSync(onDir, { recursive: true, force: true })
if (failed > 0) process.exit(1)
