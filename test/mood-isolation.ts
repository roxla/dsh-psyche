// Mood 反向隔离测试（P3-A B1）：情绪写入不能产生长期记忆，也不能改变 P2 的召回/叙事结果。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../packages/core/dist/adapter.js'
import { Core } from '../packages/core/dist/store.js'
import { applyMood, ensureMoodInitialized } from '../packages/core/dist/mood-store.js'
import { readMoodMeta } from '../packages/core/dist/mood-store.js'
import { recallMemory } from '../packages/core/dist/recall.js'
import { generateDiary } from '../packages/core/dist/diary-generation.js'
import { deriveGrowthNow } from '../packages/core/dist/growth.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-mood-isolation-'))
const file = join(dir, 'memory.sqlite3')
const opened = await openDatabase({ file })
const core = new Core({ db: opened.db })
const now = '2026-01-01T00:00:00.000Z'

// contacts 外键：capture 的 senderContactId 必须先存在
opened.db.run(
  `INSERT INTO contacts (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
   VALUES ('ct_mood_a', 'main', 'desktop', 'stable-mood-a', 'Mood A', NULL, ?, ?)`,
  [now, now],
)

// 一条真实记忆（fact + public），一条私有记忆
await core.capture({
  platform: 'desktop',
  sessionRef: 'session-mood-iso',
  senderContactId: 'ct_mood_a',
  at: now,
  origin: 'user',
  kind: 'message',
  text: '我最近在学泡乌龙茶，喜欢淡一点的。',
})
const remembered = await core.remember({
  platform: 'desktop',
  stableUserId: 'stable-mood-a',
  contactId: 'ct_mood_a',
  sessionRef: 'session-mood-iso',
  at: now,
  kind: 'fact',
  statement: '用户喜欢淡泡的乌龙茶。',
  subjectRefs: ['ct_mood_a'],
  disclosure: 'public',
  evidence: [{ relation: 'supports', sourceKind: 'message' }],
  opId: 'mood-iso-remember',
})

const beforeCounts = (): { artifacts: number; events: number; fts: number; moodHistory: number } => {
  const artifacts = opened.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifacts') as { n: number }
  const events = opened.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events') as { n: number }
  const fts = opened.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM fts_index') as { n: number }
  const moodHistory = opened.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM global_mood_history') as { n: number }
  return {
    artifacts: Number(artifacts.n),
    events: Number(events.n),
    fts: Number(fts.n),
    moodHistory: Number(moodHistory.n),
  }
}

const growthBefore = deriveGrowthNow(opened.db)
const diaryBefore = await generateDiary(opened.db, { scope: {}, date: '2026-01-01', timezone: 'Asia/Shanghai', now: new Date(now) })
// baseline 与 recallBefore 都必须在 Diary 生成之后取：日记会写自己的 FTS 行并进入 Recall，
// 那属于「生成日记带来的变化」，不能算到情绪写入头上。
const baseline = beforeCounts()
const recallBefore = recallMemory(opened.db, { text: '乌龙茶' }, { contactId: 'ct_mood_a' })

// 写情绪（同一时间窗、同一 persona）
ensureMoodInitialized(opened.db, { now })
applyMood(opened.db, { opId: 'mood-iso-1', deltas: { happy: 40, calm: -10 }, reason: '测试隔离', now })
applyMood(opened.db, { opId: 'mood-iso-2', deltas: { anxious: 30 }, reason: '测试隔离', now: '2026-01-01T01:00:00.000Z' })

// 1) 不产生长期记忆
const after = beforeCounts()
check(after.artifacts === baseline.artifacts, '情绪写入不产生 Artifact')
check(after.events === baseline.events, '情绪写入不产生 Event')
check(after.fts === baseline.fts, '情绪写入不产生 FTS 行')
check(after.moodHistory === baseline.moodHistory + 66, '情绪历史只进 global_mood_history')
check(readMoodMeta(opened.db)?.stateVersion === 3, 'meta 版本推进到 3')

// 2) 不改变召回结果（同一查询同一 scope）
const recallAfter = recallMemory(opened.db, { text: '乌龙茶' }, { contactId: 'ct_mood_a' })
check(
  recallAfter.items.map((item) => item.artifactId).join(',') === recallBefore.items.map((item) => item.artifactId).join(','),
  '情绪写入不改变 Recall 候选与顺序',
)
check(recallAfter.items.length === recallBefore.items.length, 'Recall 数量不变')

// 3) 不改变 Diary 结果（同日同 scope 重生成正文一致）
const diaryAgain = await generateDiary(opened.db, { scope: {}, date: '2026-01-01', timezone: 'Asia/Shanghai', now: new Date(now) })
check(diaryAgain.diaryId === diaryBefore.diaryId, 'Diary 身份不变')
check(diaryAgain.version === diaryBefore.version, '情绪写入不产生新 Diary 版本')

// 4) 不改变 Growth 派生
const growthAfter = deriveGrowthNow(opened.db)
check(growthAfter.derived.stage === growthBefore.derived.stage, 'Growth 阶段不变')
check(
  JSON.stringify(growthAfter.inputs) === JSON.stringify(growthBefore.inputs),
  'Growth 输入不变',
)

// 5) Mood 历史与记忆表互不引用
const moodRows = opened.db.all<{ dimension: string }>('SELECT dimension FROM global_mood_history LIMIT 3') as Array<{ dimension: string }>
check(moodRows.every((row) => typeof row.dimension === 'string' && row.dimension.length > 0), 'mood history 只含维度列')
check(remembered.artifactId.length > 0, '记忆写入正常（对照组）')

opened.db.close()
rmSync(dir, { recursive: true, force: true })
console.log(`[P3-A B1 mood-isolation] ${passed} 通过 0 失败`)
