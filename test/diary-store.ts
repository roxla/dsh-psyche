// Diary v1 存储层（P2 Completion Batch 阶段 5，schema v18）。
//
// 验收口径：
// - 一条日记一个稳定身份：(persona, scope_key, local_date) 唯一；
// - 版本 append-only：同 content_hash 重跑不新增，变更才追加 version+1；
// - 时区换算不依赖机器本地时区；
// - head 正文写进 fts_index（kind='diary'），且与 fts_rowids 一一对应；
// - 壳/版本/FTS 同事务：失败一起回滚。
//
// 跑法：node test/diary-store.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import {
  deleteDiary,
  diaryScopeKey,
  listDiaries,
  loadDiaryByKey,
  readDiary,
  resolveDiaryDate,
  upsertDiary,
} from '../dist/lib/diary-store.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-diary-store-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)

console.log('\n[Diary Store] schema v18')

eq('schema 版本是 31', Number((db.get('PRAGMA user_version') as { user_version?: number }).user_version ?? 0), 31)
const tables = db.all<{ name: string }>(
  `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'fts_index%' AND name NOT LIKE 'sqlite_%'`,
)
eq('表数 70（含 diaries / diary_versions / mood_meta / proactive_outbox / growth_reflections / growth_confirmations / memory_merge_events / memory_archive_events / external_sources / external_source_deletion_events / growth_reflection_processed_sources / external_source_erase_events）', tables.length, 70)

const now = '2026-11-09T12:00:00.000Z'
const scope = { contactId: 'ct_diary_a' }

const first = upsertDiary(db, {
  scope,
  localDate: '2026-11-09',
  periodStart: Date.parse('2026-11-08T16:00:00.000Z'),
  periodEnd: Date.parse('2026-11-09T16:00:00.000Z'),
  timezone: 'Asia/Shanghai',
  body: '2026-11-09 · 你和 ct_diary_a\n\n【这一天】\n- 09:12 你说：「今天喝了乌龙茶」 [evt_a]',
  sourceRefs: [{ refType: 'event', refId: 'evt_a', refRevision: null }],
  algorithmVersion: 'diary-v1',
  contentHash: 'hash-1',
  sourceDigest: 'digest-1',
  now,
})
ok('首次写入 created=true', first.created === true && first.updated === false)
eq('首次版本是 1', first.version, 1)

const head = readDiary(db, first.diaryId)
ok('读回 head 有正文', head?.version?.body.includes('乌龙茶') === true)
eq('head_version 是 1', head?.diary.headVersion, 1)
eq('来源引用被保存', head?.version?.sourceRefs[0]?.refId, 'evt_a')

const again = upsertDiary(db, {
  scope,
  localDate: '2026-11-09',
  periodStart: Date.parse('2026-11-08T16:00:00.000Z'),
  periodEnd: Date.parse('2026-11-09T16:00:00.000Z'),
  timezone: 'Asia/Shanghai',
  body: '正文变了但 hash 没变不该新增',
  sourceRefs: [{ refType: 'event', refId: 'evt_a', refRevision: null }],
  algorithmVersion: 'diary-v1',
  contentHash: 'hash-1',
  sourceDigest: 'digest-1',
  now,
})
ok('同 hash 重跑不新增版本', again.updated === false && again.version === 1)
eq('同 hash 重跑仍只有一条壳', listDiaries(db, { contactId: 'ct_diary_a' }).length, 1)

const second = upsertDiary(db, {
  scope,
  localDate: '2026-11-09',
  periodStart: Date.parse('2026-11-08T16:00:00.000Z'),
  periodEnd: Date.parse('2026-11-09T16:00:00.000Z'),
  timezone: 'Asia/Shanghai',
  body: '2026-11-09 · 你和 ct_diary_a\n\n【这一天】\n- 09:12 你说：「今天喝了乌龙茶」 [evt_a]\n\n【还没落定】\n- 一件事没对上 [ten_a]',
  sourceRefs: [{ refType: 'event', refId: 'evt_a', refRevision: null }, { refType: 'tension', refId: 'ten_a', refRevision: null }],
  tensionRefs: ['ten_a'],
  algorithmVersion: 'diary-v1',
  contentHash: 'hash-2',
  sourceDigest: 'digest-2',
  now,
})
ok('内容变化追加版本 2', second.updated === true && second.version === 2)
eq('head 指向版本 2', readDiary(db, first.diaryId)?.diary.headVersion, 2)
eq('旧版本正文仍可读', readDiary(db, first.diaryId, 1)?.version?.contentHash, 'hash-1')
eq('tension_refs 被保存', readDiary(db, first.diaryId)?.version?.tensionRefs, ['ten_a'])

console.log('\n[Diary Store] Scope 与唯一键')

eq('Contact scope key', diaryScopeKey({ contactId: 'ct_a' }), 'contact:ct_a')
eq('Room scope key', diaryScopeKey({ roomId: 'rm_a' }), 'room:rm_a')
eq('Global scope key', diaryScopeKey({}), 'global')
throws('Contact 与 Room 同时给 → 拒绝', () => diaryScopeKey({ contactId: 'ct_a', roomId: 'rm_a' }), 'E_VALIDATION')

const globalFirst = upsertDiary(db, {
  scope: {},
  localDate: '2026-11-09',
  periodStart: 0,
  periodEnd: 1,
  timezone: 'Asia/Shanghai',
  body: '全局日记',
  sourceRefs: [],
  algorithmVersion: 'diary-v1',
  contentHash: 'g-1',
  sourceDigest: 'g-1',
  now,
})
const globalAgain = upsertDiary(db, {
  scope: {},
  localDate: '2026-11-09',
  periodStart: 0,
  periodEnd: 1,
  timezone: 'Asia/Shanghai',
  body: '全局日记（改了）',
  sourceRefs: [],
  algorithmVersion: 'diary-v1',
  contentHash: 'g-2',
  sourceDigest: 'g-2',
  now,
})
ok('同日期同 scope 复用同一条壳', globalFirst.diaryId === globalAgain.diaryId)
eq('不同 scope 各自独立', loadDiaryByKey(db, 'global', '2026-11-09')?.diaryId, globalFirst.diaryId)

console.log('\n[Diary Store] 时区换算')

const shanghai = resolveDiaryDate(new Date('2026-11-09T15:59:59.000Z'), 'Asia/Shanghai')
eq('15:59Z 仍是 11-09（东八区 23:59）', shanghai.localDate, '2026-11-09')
const shanghaiLate = resolveDiaryDate(new Date('2026-11-09T16:00:00.000Z'), 'Asia/Shanghai')
eq('16:00Z 变成 11-10（东八区 00:00）', shanghaiLate.localDate, '2026-11-10')
eq('11-09 的区间起点是 11-08T16:00Z', shanghai.periodStart, Date.parse('2026-11-08T16:00:00.000Z'))
eq('11-09 的区间长度约 24 小时', Math.round((shanghai.periodEnd - shanghai.periodStart) / 3_600_000), 24)
const utc = resolveDiaryDate(new Date('2026-11-09T23:30:00.000Z'), 'UTC')
eq('UTC 时区仍是 11-09', utc.localDate, '2026-11-09')

console.log('\n[Diary Store] FTS 映射与删除')

const ftsRows = db.all<{ kind: string; ref_id: string }>(
  `SELECT kind, ref_id FROM fts_index WHERE kind = 'diary'`,
)
ok('diary 正文进了 fts_index', ftsRows.some((row) => row.ref_id === first.diaryId))
const mapRows = db.all<{ kind: string; ref_id: string }>(
  `SELECT kind, ref_id FROM fts_rowids WHERE kind = 'diary'`,
)
ok('fts_rowids 有对应映射', mapRows.some((row) => row.ref_id === first.diaryId))

ok('删除日记返回 true', deleteDiary(db, first.diaryId) === true)
ok('删除后读不回', readDiary(db, first.diaryId) === null)
eq('删除后 FTS 行也没了', db.all(`SELECT rowid FROM fts_index WHERE kind = 'diary' AND ref_id = ?`, [first.diaryId]).length, 0)

db.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n[Diary Store] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exit(1)
