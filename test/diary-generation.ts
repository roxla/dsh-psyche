// Diary v1 生成层（P2 Completion Batch 阶段 5，schema v18）。
//
// 验收口径：
// - 有内容才生成；没有有效内容不生成虚假日记；
// - 正文带来源引用（[evt_x] / [art_x@rev]），未解决 Tension 进「还没落定」段；
// - 同一天同 scope 重跑幂等（同 hash 不新增版本），新增内容才追加版本；
// - 生成后写一条 kind='diary' 的 Decision Receipt（result_diary_id 指向日记）；
// - Contact A 的日记不会把 Contact B 的内容写进来。
//
// 跑法：node test/diary-generation.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { generateDiary } from '../dist/lib/diary-generation.js'
import { listDiaries, readDiary } from '../dist/lib/diary-store.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-diary-generation-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)

const now = new Date('2026-11-09T12:00:00.000Z')

function insertEvent(id: string, text: string, at: string, subjects: string[]): void {
  db.run(
    `INSERT INTO events (event_id, persona_id, kind, type, at, subject_refs, text, confidence, schema_version, created_at)
     VALUES (?, 'main', 'interaction', 'conversation', ?, ?, ?, 'medium', '1.0', ?)`,
    [id, at, JSON.stringify(subjects), text, at],
  )
}

function insertArtifact(id: string, statement: string, createdAt: string, subjects: string[]): void {
  db.run(
    `INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at) VALUES (?, 'main', 'fact', ?, ?)`,
    [id, createdAt, createdAt],
  )
  db.run(
    `INSERT INTO artifact_revisions
       (artifact_id, revision, state, statement, subject_refs, payload, confidence,
        basis_count, independent_evidence_count, salience, temporal, direct_extraction,
        created_at, updated_at, schema_version, disclosure)
     VALUES (?, 1, 'active', ?, ?, '{}', 'medium', 1, 1, 0, '{}', 0, ?, ?, '1.0', 'public')`,
    [id, statement, JSON.stringify(subjects), createdAt, createdAt],
  )
}

function insertTension(id: string, left: string, right: string, changedAt: string): void {
  db.run(
    `INSERT INTO tension_versions
       (tension_id, version, pair_key, left_artifact_id, left_revision, left_kind, left_state, left_statement,
        left_subjects, right_artifact_id, right_revision, right_kind, right_state, right_statement, right_subjects,
        kind, origin, status, severity, basis, opened_at, opened_by, changed_at, changed_by, algorithm_version)
     VALUES (?, 1, 'a#1|b#1', 'art_gen_1', 1, 'fact', 'active', ?, '["ct_diary_a"]',
             'art_gen_2', 1, 'fact', 'active', ?, '["ct_diary_a"]',
             'normative', 'clash', 'open', 'medium', '{}', ?, 'core', ?, 'core', 'tension-v1')`,
    [id, left, right, changedAt, changedAt],
  )
}

console.log('\n[Diary Generation] 基础')

insertEvent('evt_diary_1', '今天喝到一款很好的乌龙茶，下次想再买', '2026-11-09T10:00:00.000Z', ['ct_diary_a'])
insertArtifact('art_gen_1', '用户喜欢喝乌龙茶', '2026-11-09T11:00:00.000Z', ['ct_diary_a'])
insertTension('ten_diary_1', '用户喜欢喝乌龙茶', '用户说最近改喝咖啡', '2026-11-09T11:30:00.000Z')

const first = await generateDiary(db, { scope: { contactId: 'ct_diary_a' }, date: '2026-11-09', now })
ok('生成成功且有 diaryId', typeof first.diaryId === 'string' && first.diaryId.length > 0)
eq('首次版本是 1', first.version, 1)
ok('created=true', first.created === true && first.updated === false)
eq('来源数与预期一致（artifact + event + tension）', first.sourceCount, 3)
eq('Tension 数 1', first.tensionCount, 1)

const head = readDiary(db, first.diaryId as string)
const body = head?.version?.body ?? ''
ok('正文含当天事件', body.includes('乌龙茶'))
ok('正文含「这一天」段', body.includes('【这一天】'))
ok('正文含「记下的事」段', body.includes('【记下的事】'))
ok('正文含「还没落定」段', body.includes('【还没落定】'))
ok('事件带 [evt_diary_1] 引用', body.includes('[evt_diary_1]'))
ok('结论带 [art_gen_1@1] 引用', body.includes('[art_gen_1@1]'))
ok('Tension 带 [ten_diary_1] 引用', body.includes('[ten_diary_1]'))

console.log('\n[Diary Generation] 幂等与版本')

const again = await generateDiary(db, { scope: { contactId: 'ct_diary_a' }, date: '2026-11-09', now })
eq('同一天重跑仍是版本 1', again.version, 1)
eq('同一天重跑不新增版本', again.updated, false)
eq('同一天重跑仍只有一条日记', listDiaries(db, { contactId: 'ct_diary_a' }).length, 1)

insertEvent('evt_diary_2', '下午又聊到茶具', '2026-11-09T14:00:00.000Z', ['ct_diary_a'])
const third = await generateDiary(db, { scope: { contactId: 'ct_diary_a' }, date: '2026-11-09', now: new Date('2026-11-09T15:00:00.000Z') })
eq('新增内容后版本 2', third.version, 2)
eq('版本 2 updated=true', third.updated, true)
ok('版本 2 含新事件', (readDiary(db, first.diaryId as string)?.version?.body ?? '').includes('茶具'))
eq('旧版本 1 仍可读', readDiary(db, first.diaryId as string, 1)?.version?.version, 1)

console.log('\n[Diary Generation] 无内容与 Scope 隔离')

const empty = await generateDiary(db, { scope: { contactId: 'ct_diary_a' }, date: '2026-11-01', now })
eq('没有内容的日期 skipped', empty.skipped, 'no-content')
ok('skipped 时不生成 diaryId', empty.diaryId === null)

const otherScope = await generateDiary(db, {
  scope: { contactId: 'ct_diary_b' },
  date: '2026-11-09',
  now,
})
eq('Contact B 看不到 Contact A 的内容', otherScope.skipped, 'no-content')

const roomDiary = await generateDiary(db, { scope: { roomId: 'rm_diary_1' }, date: '2026-11-09', now })
ok('Room 日记不看 Contact 私有内容', roomDiary.skipped === 'no-content' || roomDiary.diaryId !== first.diaryId)

console.log('\n[Diary Generation] Decision Receipt')

const receipts = db.all<Record<string, unknown>>(
  `SELECT kind, status, result_diary_id, result_revision FROM decision_runs WHERE kind = 'diary' ORDER BY created_at ASC`,
)
ok('生成后留下 diary 决策回执', receipts.length >= 1)
ok('回执已完成', receipts.every((row) => row.status === 'committed'))
ok('回执结果指针指向日记', receipts.some((row) => row.result_diary_id === first.diaryId))
const items = db.all<Record<string, unknown>>(
  `SELECT ref_type, ref_id FROM decision_items di
     JOIN decision_runs dr ON dr.decision_id = di.decision_id
    WHERE dr.kind = 'diary'`,
)
ok('回执依据含事件', items.some((row) => row.ref_type === 'event' && row.ref_id === 'evt_diary_1'))
ok('回执依据含结论', items.some((row) => row.ref_type === 'artifact' && row.ref_id === 'art_gen_1'))
ok('回执依据含张力', items.some((row) => row.ref_type === 'tension' && row.ref_id === 'ten_diary_1'))

db.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n[Diary Generation] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exit(1)
