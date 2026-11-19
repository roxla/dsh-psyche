// Diary Integrity（P2 Completion Batch 阶段 5）。
//
// 验收口径：
// - 来源有效性：diary_versions.source_refs 指向的 Artifact / Event / Tension 必须存在；
// - 版本关系：head_version 必须能找到对应版本行；
// - 重复引用：同一版本里同一引用只能出现一次；
// - 来源失效可发现：引用一个不存在的来源时，检查必须报出来；
// - 只读：检查不改数据、不重写版本、不触发重新生成。
//
// 说明：events / sources 是 append-only（触发器禁止 DELETE/UPDATE），所以「来源失效」
// 用「引用一个从未存在过的 id」构造，而不是删掉真实行——两者在检查器的可见结果一致。
//
// 跑法：node test/diary-integrity.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { upsertDiary } from '../dist/lib/diary-store.js'
import { inspectDiaryIntegrity } from '../dist/lib/diary-integrity.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-diary-integrity-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)

const now = '2026-11-09T12:00:00.000Z'
const day = '2026-11-09'

function seedEvent(eventId: string): void {
  db.run(
    `INSERT INTO events (event_id, persona_id, kind, type, at, text, subject_refs, created_at)
     VALUES (?, 'main', 'interaction', 'conversation', ?, '喝茶', '["ct_int"]', ?)`,
    [eventId, now, now],
  )
}

function seedArtifact(artifactId: string): void {
  db.run(
    `INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at)
     VALUES (?, 'main', 'fact', ?, ?)`,
    [artifactId, now, now],
  )
  db.run(
    `INSERT INTO artifact_revisions (artifact_id, revision, statement, state, disclosure, subject_refs, confidence, basis_count, independent_evidence_count, created_at, updated_at)
     VALUES (?, 1, '用户喜欢乌龙茶', 'active', 'public', '["ct_int"]', 'medium', 0, 0, ?, ?)`,
    [artifactId, now, now],
  )
}

function seedTension(tensionId: string): void {
  db.run(
    `INSERT INTO tension_versions (tension_id, version, pair_key, left_artifact_id, left_revision, left_kind, left_state, left_statement, left_subjects, right_artifact_id, right_revision, right_kind, right_state, right_statement, right_subjects, kind, origin, status, severity, basis, opened_at, opened_by, changed_at, changed_by, algorithm_version)
     VALUES (?, 1, 'pair-int', 'art_int_l', 1, 'fact', 'active', '左', '["ct_int"]', 'art_int_r', 1, 'fact', 'active', '右', '["ct_int"]', 'contradiction', 'clash', 'open', 'medium', '{}', ?, 'core', ?, 'core', 'test')`,
    [tensionId, now, now],
  )
}

seedEvent('evt_int_1')
seedArtifact('art_int_1')
seedTension('ten_int_1')

function seedDiary(body: string, refs: unknown[]): string {
  const result = upsertDiary(db, {
    scope: { contactId: 'ct_int' },
    localDate: day,
    periodStart: Date.parse(`${day}T00:00:00.000Z`),
    periodEnd: Date.parse(`${day}T00:00:00.000Z`) + 86_400_000,
    timezone: 'Asia/Shanghai',
    body,
    sourceRefs: refs as never,
    algorithmVersion: 'diary-v1-test',
    contentHash: `hash-${body.length}`,
    sourceDigest: 'digest-test',
    now,
  })
  return result.diaryId
}

console.log('\n[Diary Integrity] 正常日记没有报告')

const goodDiary = seedDiary('今天喝茶，聊得很细。', [
  { refType: 'event', refId: 'evt_int_1' },
  { refType: 'artifact', refId: 'art_int_1', refRevision: 1 },
  { refType: 'tension', refId: 'ten_int_1' },
])
const clean = inspectDiaryIntegrity(db)
eq('正常日记没有 problem', clean.issues.length, 0)
eq('统计了 1 条日记', clean.checkedDiaries, 1)
eq('统计了 1 个版本', clean.checkedVersions, 1)
ok('检查是只读的（日记仍在）', db.get(`SELECT 1 AS one FROM diaries WHERE diary_id = ?`, [goodDiary]) !== undefined)

console.log('\n[Diary Integrity] 来源失效可发现')

const danglingDiary = seedDiary('引用了一个不存在的来源。', [
  { refType: 'event', refId: 'evt_missing' },
  { refType: 'artifact', refId: 'art_missing', refRevision: 1 },
  { refType: 'tension', refId: 'ten_missing' },
])
const dangling = inspectDiaryIntegrity(db)
const danglingDetails = dangling.issues.filter((issue) => issue.kind === 'dangling-source')
eq('三条失效来源都能报出来', danglingDetails.length, 3)
ok('报告带具体缺失 id', ['evt_missing', 'art_missing', 'ten_missing'].every((id) => danglingDetails.some((issue) => issue.detail.includes(id))), danglingDetails)
ok('报告带 diaryId', danglingDetails.every((issue) => issue.diaryId === danglingDiary))

console.log('\n[Diary Integrity] 版本关系与重复引用')

// 手工造一个 head 脱节：把 head_version 改成一个不存在的版本。
db.run(`UPDATE diaries SET head_version = 9 WHERE diary_id = ?`, [goodDiary])
const missingHead = inspectDiaryIntegrity(db)
ok('head 脱节能报 head-version-missing', missingHead.issues.some((issue) => issue.kind === 'head-version-missing'))
db.run(`UPDATE diaries SET head_version = 1 WHERE diary_id = ?`, [goodDiary])

// 同一版本里重复引用同一张力：upsertDiary 会去重，这里直接改存库的 JSON 验证检查能发现。
db.run(
  `UPDATE diary_versions SET source_refs = ? WHERE diary_id = ? AND version = 1`,
  [JSON.stringify([{ refType: 'tension', refId: 'ten_int_1' }, { refType: 'tension', refId: 'ten_int_1' }]), goodDiary],
)
const duplicate = inspectDiaryIntegrity(db)
ok('重复引用能报 duplicate-ref', duplicate.issues.some((issue) => issue.kind === 'duplicate-ref'), duplicate.issues)

console.log('\n[Diary Integrity] 坏 JSON 不崩')

db.run(
  `UPDATE diary_versions SET source_refs = 'not-json' WHERE diary_id = ? AND version = 1`,
  [goodDiary],
)
const broken = inspectDiaryIntegrity(db)
ok('坏 source_refs 不抛错', Array.isArray(broken.issues))
ok('坏 JSON 当成空引用', broken.issues.filter((issue) => issue.kind === 'dangling-source').every((issue) => !issue.detail.includes('not-json')))

db.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n[Diary Integrity] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exit(1)
