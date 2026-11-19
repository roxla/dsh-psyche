// Diary Recall（P2 Completion Batch 阶段 5，schema v18）。
//
// 验收口径：
// - 日记召回不是第二套检索：复用 fts_index(kind='diary') 与同一套 Scope 规则，
//   先过滤再排序，返回带 diaryId / version / 来源引用；
// - Contact 只看自己的私有日记 + 全局，Room 只看该 Room + 全局；
// - 无匹配时正常空（abstain 由上层按 items.length 判断），不编造；
// - recallMemory 里 diary 作为新增来源，limit 与 artifact 共享预算。
//
// 跑法：node test/diary-recall.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { diaryScopeKey, upsertDiary } from '../dist/lib/diary-store.js'
import { searchDiaryFts } from '../dist/lib/diary-recall.js'
import { recallMemory } from '../dist/lib/recall.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-diary-recall-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)

function seedDiary(scope: Record<string, string>, localDate: string, body: string): string {
  const result = upsertDiary(db, {
    scope,
    localDate,
    periodStart: Date.parse(`${localDate}T00:00:00.000Z`),
    periodEnd: Date.parse(`${localDate}T00:00:00.000Z`) + 86_400_000,
    timezone: 'Asia/Shanghai',
    body,
    sourceRefs: [{ refType: 'event', refId: `evt_${localDate}_${body.slice(0, 2)}` }],
    algorithmVersion: 'diary-v1-test',
    contentHash: `hash-${localDate}-${body.length}`,
    sourceDigest: `digest-${localDate}`,
    now: `${localDate}T12:00:00.000Z`,
  })
  return result.diaryId
}

const diaryA = seedDiary({ contactId: 'ct_dr_a' }, '2026-11-09', '今天和 A 聊了乌龙茶与茶具')
const diaryB = seedDiary({ contactId: 'ct_dr_b' }, '2026-11-09', '今天和 B 聊了乌龙茶与茶具')
const diaryGlobal = seedDiary({}, '2026-11-09', '今天整理了茶柜，把乌龙茶放在最上层')
const diaryRoom = seedDiary({ roomId: 'rm_dr_1' }, '2026-11-09', '群里聊了乌龙茶的水温')
seedDiary({ contactId: 'ct_dr_a' }, '2026-11-10', '今天下雨，没有出门')

console.log('\n[Diary Recall] Scope 过滤')

const aHits = searchDiaryFts(db, '乌龙茶', { contactId: 'ct_dr_a' })
eq('Contact A 看到自己的日记 + 全局', aHits.map((hit) => hit.diaryId).sort(), [diaryA, diaryGlobal].sort())
ok('A 看不到 B 的日记', !aHits.some((hit) => hit.diaryId === diaryB))
ok('A 看不到 Room 日记', !aHits.some((hit) => hit.diaryId === diaryRoom))

const bHits = searchDiaryFts(db, '乌龙茶', { contactId: 'ct_dr_b' })
eq('Contact B 看到自己的日记 + 全局', bHits.map((hit) => hit.diaryId).sort(), [diaryB, diaryGlobal].sort())
ok('B 看不到 A 的日记', !bHits.some((hit) => hit.diaryId === diaryA))

const roomHits = searchDiaryFts(db, '乌龙茶', { roomId: 'rm_dr_1' })
eq('Room 看到该 Room 日记 + 全局', roomHits.map((hit) => hit.diaryId).sort(), [diaryRoom, diaryGlobal].sort())

const noScopeHits = searchDiaryFts(db, '乌龙茶', {})
eq('无 Scope 只看全局', noScopeHits.map((hit) => hit.diaryId), [diaryGlobal])

console.log('\n[Diary Recall] 命中与评分')

ok('命中带 diaryId / version / body / localDate', aHits.every((hit) => typeof hit.diaryId === 'string' && hit.version >= 1 && hit.body.length > 0 && hit.localDate === '2026-11-09'))
ok('评分是数字', aHits.every((hit) => typeof hit.score === 'number' && Number.isFinite(hit.score)))
ok('按 score 降序', aHits.every((hit, index) => index === 0 || aHits[index - 1]!.score >= hit.score))

const noneHits = searchDiaryFts(db, '咖啡豆', { contactId: 'ct_dr_a' })
eq('没有匹配返回空', noneHits.length, 0)

const longQuery = searchDiaryFts(db, '茶'.repeat(220), { contactId: 'ct_dr_a' })
eq('超长查询返回空', longQuery.length, 0)

console.log('\n[Diary Recall] 接入统一 Recall')

const merged = recallMemory(db, { text: '乌龙茶' }, { contactId: 'ct_dr_a' }, {})
const diaryItems = merged.items.filter((item) => item.kind === 'diary')
eq('统一 Recall 里能看到日记候选（自己的 + 全局）', diaryItems.length, 2)
ok('日记候选带 diaryId', diaryItems.every((item) => typeof item.diaryId === 'string'))
ok('日记候选有「叙事不是事实」说明', diaryItems.every((item) => item.statusNote === '叙事记录，不是事实依据'))
ok('日记候选的 supportEvidenceCount 是 0', diaryItems.every((item) => item.supportEvidenceCount === 0))

const onlyDiary = recallMemory(db, { text: '乌龙茶', kind: 'diary' }, { contactId: 'ct_dr_a' }, {})
ok('kind=diary 时只返回日记', onlyDiary.items.every((item) => item.kind === 'diary'))
eq('kind=diary 时数量正确（私有 + 全局）', onlyDiary.items.length, 2)

const withoutDiaries = recallMemory(db, { text: '乌龙茶', includeDiaries: false }, { contactId: 'ct_dr_a' }, {})
eq('includeDiaries=false 时不返回日记', withoutDiaries.items.filter((item) => item.kind === 'diary').length, 0)

const limited = recallMemory(db, { text: '乌龙茶' }, { contactId: 'ct_dr_a' }, { limit: 1 })
ok('limit 与 artifact 共享预算', limited.items.length <= 1)

const abstained = merged.items.length === 0
eq('有日记候选时不算 abstain', abstained, false)

db.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n[Diary Recall] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exit(1)
