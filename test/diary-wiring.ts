// Diary Decision Receipt 接线（P2 Completion Batch 阶段 5）。
//
// 验收口径：
// - 生成日记后留下一条 kind='diary' 的 committed 回执；
// - 回执结果指针指向 diaryId + version，依据是 Event/Artifact/Tension；
// - 同一天重跑不新增回执（opId 幂等）；
// - 内容变化产生新版本 → 新回执；
// - Receipt 写失败只 warn：日记仍成功持久化，事实依据是写入本身。
//
// 跑法：node test/diary-wiring.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { generateDiary } from '../dist/lib/diary-generation.js'
import { getDecision, listDecisions } from '../dist/lib/decision-store.js'

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

const log = { info() {}, debug() {}, warn() {}, error() {} }
function makeDb(): { dir: string; db: Awaited<ReturnType<typeof openDatabase>>['db'] } {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-diary-wiring-'))
  return { dir, db: undefined as never }
}

const now = '2026-11-09T12:00:00.000Z'
const day = '2026-11-09'
const scope = { contactId: 'ct_dw' }

async function run(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-diary-wiring-'))
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
  const db = opened.db
  migrate(db, log)

  db.run(
    `INSERT INTO events (event_id, persona_id, kind, type, at, text, subject_refs, created_at)
     VALUES ('evt_dw_1', 'main', 'interaction', 'conversation', ?, '一起喝茶', '["ct_dw"]', ?)`,
    [now, now],
  )
  db.run(
    `INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at)
     VALUES ('art_dw_1', 'main', 'fact', ?, ?)`,
    [now, now],
  )
  db.run(
    `INSERT INTO artifact_revisions (artifact_id, revision, statement, state, disclosure, subject_refs, confidence, basis_count, independent_evidence_count, created_at, updated_at)
     VALUES ('art_dw_1', 1, '用户喜欢乌龙茶', 'active', 'public', '["ct_dw"]', 'medium', 0, 0, ?, ?)`,
    [now, now],
  )

  console.log('\n[Diary Wiring] 生成后留下回执')

  const first = await generateDiary(db, { scope, date: day, now: new Date(now) })
  eq('第一次生成 created', [first.created, first.updated], [true, false])
  const receipts = listDecisions(db, { kind: 'diary' })
  const detail = receipts[0] === undefined ? null : getDecision(db, receipts[0].decisionId)
  eq('留下一条 diary 回执', receipts.length, 1)
  eq('回执是 committed', detail?.run.status, 'committed')
  eq('回执结果指针指向日记', detail?.run.resultDiaryId, first.diaryId)
  eq('回执结果版本正确', detail?.run.resultRevision, first.version)
  ok('回执依据含事件', detail?.items.some((item) => item.refType === 'event' && item.refId === 'evt_dw_1') === true)
  ok('回执依据含结论', detail?.items.some((item) => item.refType === 'artifact' && item.refId === 'art_dw_1') === true)
  ok('回执不存正文', detail?.items.every((item) => typeof item.refId === 'string' && !item.refId.includes('一起喝茶')) === true)

  console.log('\n[Diary Wiring] 幂等与版本')

  const again = await generateDiary(db, { scope, date: day, now: new Date(now) })
  eq('同一天重跑没有新版本', [again.created, again.updated, again.version], [false, false, 1])
  eq('同一天重跑不新增回执', listDecisions(db, { kind: 'diary' }).length, 1)

  db.run(
    `INSERT INTO events (event_id, persona_id, kind, type, at, text, subject_refs, created_at)
     VALUES ('evt_dw_2', 'main', 'interaction', 'conversation', ?, '聊了茶具', '["ct_dw"]', ?)`,
    ['2026-11-09T13:00:00.000Z', '2026-11-09T13:00:00.000Z'],
  )
  const second = await generateDiary(db, { scope, date: day, now: new Date(now) })
  eq('新内容产生版本 2', [second.created, second.updated, second.version], [false, true, 2])
  eq('版本 2 也留一条新回执', listDecisions(db, { kind: 'diary' }).length, 2)
  ok('新回执指向版本 2', listDecisions(db, { kind: 'diary' }).some((run) => run.resultRevision === 2))

  console.log('\n[Diary Wiring] Receipt 失败只 warn')

  // 拆掉决策表：createDecision 会抛错，但生成必须继续，日记要落盘。
  db.run(`DROP TABLE decision_items`)
  db.run(`DROP TABLE decision_runs`)
  const third = await generateDiary(db, { scope, date: day, now: new Date(now) })
  eq('回执表不可用时日记仍写入', third.version, 2)
  eq('日记行仍存在', db.get<{ one: number }>(`SELECT 1 AS one FROM diaries WHERE diary_id = ?`, [third.diaryId])?.one, 1)
  eq('日记版本仍在', db.get<{ one: number }>(`SELECT 1 AS one FROM diary_versions WHERE diary_id = ? AND version = 2`, [third.diaryId])?.one, 1)

  db.close()
  rmSync(dir, { recursive: true, force: true })
}

await run()
console.log(`\n[Diary Wiring] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exit(1)
