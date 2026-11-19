// P2-Recall R3：统一召回内核（REC-01~12）。
//
// 验收口径（用户 m18536 冻结）：
// - 主动 Recall 与自动注入共用 searchFts 的候选与排序；
// - head → state → disclosure → Scope → Subject → LIMIT（全部在 SQL 里）；
// - challenged 带争议说明；Event 不收原文；支持证据数按 D5-B 口径；
// - 两个易漏用例：受限高相关候选超过公开时仍补满 TopK；Scope 不匹配的高分候选不挤掉合法记忆。
//
// 跑法：node test/recall.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { searchFts } from '../dist/lib/fts.js'
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

const dir = mkdtempSync(join(tmpdir(), 'psyche-recall-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

console.log('\n[P2-Recall R3] 统一召回内核')

let sourceSeq = 0

async function source(text: string, sessionRef?: string): Promise<string> {
  sourceSeq += 1
  const captured = await core.capture({
    platform: 'dsh',
    channel: 'desktop',
    sessionRef: sessionRef ?? `recall-s${sourceSeq}`,
    origin: 'user',
    kind: 'message',
    text,
  })
  return captured.sourceId
}

async function fact(
  text: string,
  options: { subjectRefs?: string[]; disclosure?: 'public' | 'restricted' | 'secret'; kind?: 'fact' | 'belief' } = {},
): Promise<string> {
  // 两条不同会话来源 → 两条独立证据（活动窗口不同），才能升格成 fact。
  const a = await source(text)
  const b = await source(`${text}（补充确认）`)
  const remembered = await core.remember({
    text,
    kind: options.kind ?? 'fact',
    statement: text,
    sourceIds: [a, b],
    disclosure: options.disclosure ?? 'public',
    ...(options.subjectRefs === undefined ? {} : { subjectRefs: options.subjectRefs }),
  })
  if (!remembered.artifactId) throw new Error(`未升格：${JSON.stringify(remembered)}`)
  return remembered.artifactId
}

// ── 1. 基础：文本召回等价于 searchFts（同 query 同 scope）────────────────
const aliceFact = await fact('周末去城西看展', { subjectRefs: ['ct_alice'] })
const bobFact = await fact('周末去城东爬山', { subjectRefs: ['ct_bob'] })
const globalFact = await fact('周末的雨下得很大', { subjectRefs: ['topic_weather'] })
// R3.1：真正「无 Evidence」的结论才是 global；有来源但属于个人域的结论需要可信身份。
const noEvidenceFact = await fact('周末没有来源的全局结论')
db.run('DELETE FROM artifact_evidence WHERE artifact_id = ?', [noEvidenceFact])

const engine = recallMemory(db, { text: '周末' }, { contactId: 'ct_alice', surface: 'personal' })
const direct = searchFts(db, '周末', { scope: { contactId: 'ct_alice', surface: 'personal' }, limit: 24 })
eq('候选顺序与 searchFts 一致', engine.items.map((item) => item.artifactId), direct.map((row) => row.artifactId))
ok('全局记忆可召回', engine.items.some((item) => item.artifactId === globalFact))
ok('Alice 私有记忆可召回', engine.items.some((item) => item.artifactId === aliceFact))
ok('Bob 私有记忆不串到 Alice', !engine.items.some((item) => item.artifactId === bobFact))

// ── 2. 无绑定：只给无 Evidence 的 global（个人域来源不降级成全局）──────────
const anonymous = recallMemory(db, { text: '周末' }, {})
ok('无绑定只召回无 Evidence 的全局结论', anonymous.items.every((item) => item.artifactId === noEvidenceFact))
ok('无绑定不召回 Alice 私有', !anonymous.items.some((item) => item.artifactId === aliceFact))
ok('无绑定不召回个人域来源的结论', !anonymous.items.some((item) => item.artifactId === globalFact))

// ── 3. Subject 精确匹配（不是子串）──────────────────────────────────────
await fact('关于 ct_a 的精确记忆', { subjectRefs: ['ct_a'] })
await fact('关于 ct_aa 的精确记忆', { subjectRefs: ['ct_aa'] })
const ctA = recallMemory(db, { subject: 'ct_a' }, { contactId: 'ct_a', surface: 'personal' })
eq('subject 精确只命中 ct_a', ctA.items.map((item) => item.statement), ['关于 ct_a 的精确记忆'])
const ctAA = recallMemory(db, { subject: 'ct_aa' }, { contactId: 'ct_aa', surface: 'personal' })
eq('subject 精确只命中 ct_aa', ctAA.items.map((item) => item.statement), ['关于 ct_aa 的精确记忆'])

// ── 4. 状态：superseded / draft 不进；challenged 进且带争议说明 ─────────
const revised = await fact('原本说喜欢咖啡')
const newSource = await source('后来改口说更喜欢茶')
await core.revise({
  artifactId: revised,
  statement: '后来改口说更喜欢茶',
  sourceIds: [newSource],
  refs: [revised],
})
const reviewer = await source('给 belief 一个争议标记')
const belief = await fact('半夜容易 emo', { kind: 'belief' })
await core.review({ artifactId: belief, verdict: 'challenged', sourceIds: [reviewer] })

const stateEngine = recallMemory(db, { text: '喜欢' }, { contactId: 'ct_alice', surface: 'personal' })
ok('revise 后只返回新 head', stateEngine.items.some((item) => item.statement.includes('更喜欢茶')))
ok('旧 revision 不返回', !stateEngine.items.some((item) => item.statement === '原本说喜欢咖啡'))
const challengedItem = recallMemory(db, { text: 'emo' }, { contactId: 'ct_alice', surface: 'personal' }).items.find((item) => item.artifactId === belief)
ok('challenged 可召回', challengedItem !== undefined)
ok('challenged 带 statusNote', typeof challengedItem?.statusNote === 'string' && challengedItem.statusNote.length > 0)

// ── 5. 披露：restricted / secret 不进（即使文本完全命中）───────────────
await fact('秘密计划去冰岛', { disclosure: 'restricted' })
await fact('绝密计划去月球', { disclosure: 'secret' })
const disclosureEngine = recallMemory(db, { text: '计划' }, { contactId: 'ct_alice', surface: 'personal' })
ok('restricted 不召回', !disclosureEngine.items.some((item) => item.statement.includes('冰岛')))
ok('secret 不召回', !disclosureEngine.items.some((item) => item.statement.includes('月球')))

// ── 6. Event 不算原文：只有 type/at，没有 eventId / text ────────────────
const withEvent = await fact('被一条事件触发的结论')
// 直接给结论挂一条触发事件（capture 只写 Source，不写 Event；这里手工插一条验证输出形状）
db.run(
  `INSERT INTO events (event_id, persona_id, kind, type, at, text, confidence, created_at)
   VALUES (?, 'main', 'interaction', 'conversation', ?, ?, 'medium', ?)`,
  ['evt_recall_1', new Date().toISOString(), '触发事件的原话', new Date().toISOString()],
)
db.run(
  `INSERT INTO artifact_trigger_events (artifact_id, revision, event_id) VALUES (?, 1, ?)`,
  [withEvent, 'evt_recall_1'],
)
const eventEngine = recallMemory(db, { text: '被一条事件触发' }, { contactId: 'ct_alice', surface: 'personal' })
const eventItem = eventEngine.items.find((item) => item.artifactId === withEvent)
ok('关联事件摘要存在', (eventItem?.relatedEvents.length ?? 0) > 0)
const eventShape = JSON.stringify(eventItem?.relatedEvents ?? [])
ok('关联事件只有 type/at', !eventShape.includes('evt_recall_1') && !eventShape.includes('触发事件的原话'))
ok('关联事件带 type', eventItem?.relatedEvents[0]?.type === 'conversation')

// ── 7. 支持证据数：只算 supports、按 independence_key 去重 ──────────────
const evidenceFact = await fact('支持证据口径测试')
const evidenceItem = recallMemory(db, { text: '支持证据口径' }, { contactId: 'ct_alice', surface: 'personal' }).items.find((item) => item.artifactId === evidenceFact)
ok('两条独立来源 → 支持证据 2', evidenceItem?.supportEvidenceCount === 2)

// 同一活动窗口里的两条来源只算一份独立证据（belief 需要 ≥2 个独立活动组，因此不升格）
const sameWindowA = await source('同一活动窗口补充', 'recall-same-window')
const sameWindowB = await source('同一活动窗口再补充', 'recall-same-window')
const dedup = await core.remember({
  text: '去重口径测试',
  kind: 'belief',
  statement: '去重口径测试',
  sourceIds: [sameWindowA, sameWindowB],
  disclosure: 'public',
})
ok('同一活动窗口只算一份独立证据（belief 不升格）', !dedup.artifactId)

// contradicts 不计入支持证据数
const contradictSource = await source('我觉得这条不对')
await core.clash({ targetId: evidenceFact, text: '我觉得这条不对', sourceIds: [contradictSource] })
const afterClash = recallMemory(db, { text: '支持证据口径' }, { contactId: 'ct_alice', surface: 'personal' }).items.find((item) => item.artifactId === evidenceFact)
eq('contradicts 不影响支持证据数', afterClash?.supportEvidenceCount, evidenceItem?.supportEvidenceCount)

// ── 8. LIMIT 前过滤：受限高相关候选不会把公开候选挤出 TopK ─────────────
for (let i = 0; i < 12; i += 1) {
  await fact(`稀有词候选 ${i}`, { disclosure: 'restricted' })
}
await fact('稀有词公开候选甲')
await fact('稀有词公开候选乙')
const limited = recallMemory(db, { text: '稀有词', limit: 2 }, { contactId: 'ct_alice', surface: 'personal' })
eq('过滤后仍补满 TopK', limited.items.length, 2)
ok('TopK 全是公开候选', limited.items.every((item) => item.disclosure === 'public'))

// ── 9. Scope 不匹配的高分候选不挤掉合法记忆 ────────────────────────────
for (let i = 0; i < 8; i += 1) {
  await fact(`挤占词 ${i}`, { subjectRefs: ['ct_bob'] })
}
await fact('挤占词 Alice 的合法记忆', { subjectRefs: ['ct_alice'] })
const scoped = recallMemory(db, { text: '挤占词', limit: 2 }, { contactId: 'ct_alice', surface: 'personal' })
eq('Scope 不匹配不挤占', scoped.items.map((item) => item.statement), ['挤占词 Alice 的合法记忆'])

// ── 10. 无 text 的结构化列表：不是子串兜底 ──────────────────────────────
const listed = recallMemory(db, { kind: 'fact' }, { contactId: 'ct_alice', surface: 'personal' })
ok('无 text 也能按 kind 翻', listed.items.length > 0)
ok('列表仍只给当前 head', listed.items.every((item) => item.revision >= 1))

console.log(`\n[P2-Recall R3] ${passed} 通过 ${failed} 失败`)
db.close?.()
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  // Windows 上句柄偶尔晚释放，不影响结论
}
if (failed > 0) process.exitCode = 1
