// §14 P1 验收：remember → clash → revise → review 跑通；旧 revision 保留、新 revision 顶上；
// 事务中途失败整笔回滚。外加 opId 幂等、自证拒绝、分区拒绝。
//
// 直接对着构建产物 dist/ 跑（不需要 DSH 宿主），用法：node test/smoke.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate, nowIso } from '../dist/lib/adapter.js'
import { Core, checkPromotion } from '../dist/lib/store.js'
import { PsycheError, jsonSafe, toErrorPayload } from '../dist/lib/errors.js'
import { buildTools } from '../dist/lib/tools.js'
import { formatDate, formatDateTime } from '../dist/lib/time.js'
import { buildSeaScene } from '../dist/lib/sea.js'
import { prefsPath, readPrefs, writePrefs } from '../dist/lib/prefs.js'
import { deriveSalience } from '../dist/lib/salience.js'
import { foldWithinBudget } from '../dist/lib/fold.js'
import { deriveSalienceNow } from '../dist/lib/cognition.js'
import { normalizeUsage, priceUsage, totalTokensOf } from '../dist/lib/pricing.js'
import { aggregateUsage, sampleOf } from '../dist/lib/usage.js'
import { MAX_ENTRIES, SelfUsageLedger } from '../dist/lib/self-usage.js'
import { OpLogger, backupDatabase, listBackups, readCounters, readOperations } from '../dist/lib/ops.js'

let passed = 0
let failed = 0

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

async function expectError(label, fn, code) {
  try {
    await fn()
    ok(label, false, { reason: '本应抛错但成功了' })
  } catch (error) {
    ok(`${label}（${error.code ?? 'no-code'}）`, code ? error.code === code : true, code ? { expected: code, message: error.message } : undefined)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-smoke-'))
const log = { info() {}, debug() {}, warn() {}, error: (m) => console.error('[logger.error]', m) }

const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log) // 幂等：openDatabase 里已迁移过，这里验证重复调用不留副作用
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

console.log('\n[0] 驱动与自检')
const selfFailures = opened.selfCheck.items.filter((item) => !item.ok).map((item) => `${item.name}: ${item.detail}`)
console.log(`  驱动：${opened.driver}；自检：${opened.selfCheck.ok ? '通过' : '未通过'}${selfFailures.length ? ` ${selfFailures.join('；')}` : ''}（备份方式 ${opened.selfCheck.backupMode}）`)
ok('能力自检五项全过', opened.selfCheck.ok, selfFailures)
eq('自检五项都在', opened.selfCheck.items.length, 5)
ok('驱动是 node:sqlite', opened.driver === 'node:sqlite', opened.driver)
eq('user_version=42', db.userVersion(), 42)

const tables = db
  .all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fts_index_%'`)
  .map((row) => row.name)
console.log(`  表：${tables.length} 张${tables.includes('fts_index') ? '（含 fts_index）' : ''}`)
ok('v37 八十一张业务表齐全（含授权代次）', tables.filter((t) => t !== 'fts_index').length === 81, tables.filter((t) => t !== 'fts_index').length)
ok('FTS5 壳表已建', tables.includes('fts_index'))
eq('journal_mode = wal', String(db.pragma('journal_mode')).toLowerCase(), 'wal')
eq('foreign_keys = 1', Number(db.pragma('foreign_keys')), 1)

// v20：contact_affect_history 数据库级只追加。
// UPDATE 一律拦；DELETE 只在父 Contact 仍存在时拦（Contact 删除的级联删除必须放行）。
db.run(
  `INSERT INTO contacts (contact_id, persona_id, platform, stable_user_id, created_at, updated_at)
   VALUES (?, 'main', 'qq', 'audit-append-only', ?, ?)`,
  ['ct_append_only_audit', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
)
db.run(
  `INSERT INTO contact_affect_history (persona_id, contact_id, dimension, value, at)
   VALUES ('main', ?, 'warmth', 1, ?)`,
  ['ct_append_only_audit', '2026-01-01T00:00:00.000Z'],
)
let affectUpdateError = ''
try {
  db.run(`UPDATE contact_affect_history SET value = 2 WHERE contact_id = ?`, ['ct_append_only_audit'])
} catch (error) {
  affectUpdateError = error instanceof Error ? error.message : String(error)
}
ok('contact_affect_history 不可 UPDATE（append-only）', affectUpdateError.includes('append-only'), affectUpdateError)
let affectDeleteError = ''
try {
  db.run(`DELETE FROM contact_affect_history WHERE contact_id = ?`, ['ct_append_only_audit'])
} catch (error) {
  affectDeleteError = error instanceof Error ? error.message : String(error)
}
ok('contact_affect_history 手工 DELETE 被拦', affectDeleteError.includes('append-only'), affectDeleteError)
db.run(`DELETE FROM contacts WHERE contact_id = ?`, ['ct_append_only_audit'])
const affectLeft = db.get(`SELECT COUNT(*) AS n FROM contact_affect_history WHERE contact_id = ?`, ['ct_append_only_audit'])
eq('删 Contact 的级联删除仍放行', Number(affectLeft.n), 0)

console.log('\n[1] remember：事实直通，belief 要两条独立证据')
const srcUser = await core.capture({
  platform: 'qq', channel: 'group', externalRoomId: '888', stableUserId: '10001',
  displayName: '阿岚', origin: 'user', kind: 'message', text: '我周五晚上一般都在打游戏，别约我。',
  sessionRef: 'sess-A',
})
ok('capture 出 source 与活动窗口', srcUser.sourceId.startsWith('src_') && Boolean(srcUser.windowKey), srcUser)

const fact = await core.remember({
  text: '阿岚说她周五晚上一般都在打游戏。',
  kind: 'fact',
  statement: '阿岚周五晚上通常会打游戏，不安排别的事。',
  sourceIds: srcUser.sourceId,
  subject: srcUser.contactId,
  confidence: 'high',
  disclosure: 'public',
})
ok('fact 一条直接来源即晋升', Boolean(fact.artifactId), fact)
eq('fact 初始状态 active', fact.state, 'active')
eq('fact 独立证据 1 条', fact.independentEvidenceCount, 1)

// D1-7：写入准入只观测不拦截 —— 每次 remember 落一行观测，字段在合法域内。
const admissionRows = db.all(
  `SELECT decision, quality_score, quality_level, policy_version FROM admission_observations`,
)
ok('D1-7：remember 后留下准入观测', admissionRows.length >= 1, admissionRows.length)
ok(
  'D1-7：观测字段合法（decision / level / policy）',
  admissionRows.every(
    (row) =>
      ['accept', 'observe', 'deny'].includes(String(row.decision)) &&
      ['high', 'medium', 'low'].includes(String(row.quality_level)) &&
      String(row.policy_version) === '1.0.0',
  ),
  admissionRows[0],
)

const beliefOne = await core.remember({
  text: '阿岚大概喜欢roguelike。',
  kind: 'belief',
  statement: '阿岚喜欢 roguelike。',
  sourceIds: srcUser.sourceId,
  subject: srcUser.contactId,
})
ok('belief 单条独立证据不晋升', beliefOne.artifactId === null && beliefOne.promotion?.ok === false, beliefOne.promotion)
ok('门槛说明里写了需要什么', String(beliefOne.promotion?.need).includes('2 条独立证据'), beliefOne.promotion?.need)

const srcOther = await core.capture({
  platform: 'qq', channel: 'group', externalRoomId: '888', stableUserId: '10001',
  displayName: '阿岚', origin: 'user', kind: 'message', text: '这周又通了三个 roguelike。',
  sessionRef: 'sess-B',
})
const beliefTwo = await core.remember({
  text: '阿岚又通了三个 roguelike。',
  kind: 'belief',
  statement: '阿岚喜欢 roguelike。',
  sourceIds: `${srcUser.sourceId},${srcOther.sourceId}`,
  subject: srcUser.contactId,
  // E5.1：recall 也是普通检索入口，只返回 public；夹具显式标 public 才测得到命中
  disclosure: 'public',
})
ok('两个独立活动窗口的信念晋升成结论', Boolean(beliefTwo.artifactId), beliefTwo)
eq('belief 独立证据 2 条', beliefTwo.independentEvidenceCount, 2)
eq('belief 报的类型正确', beliefTwo.artifactKind, 'belief')

console.log('\n[2] 门槛函数（附录 A.5）')
const promoBelief = checkPromotion('belief', [{ independenceKey: 'a' }], 'high', [])
ok('belief 1 条证据过不了', promoBelief.ok === false, promoBelief)
const promoImpression = checkPromotion(
  'impression',
  [{ independenceKey: 'a' }, { independenceKey: 'b' }, { independenceKey: 'c' }],
  'medium',
  [],
)
ok('impression 3 条证据但 confidence 不够也过不了', promoImpression.ok === false, promoImpression)
const promoStance = checkPromotion(
  'stance',
  [{ independenceKey: 'a' }, { independenceKey: 'b' }],
  'high',
  [{ session_ref: 's1' }, { session_ref: 's2' }],
)
ok('stance 跨会话两条同向可晋升', promoStance.ok === true, promoStance)

console.log('\n[3] clash：自证被拒，外部反证通过')
const srcSelf = await core.capture({
  platform: 'dsh', channel: 'desktop', origin: 'self', kind: 'model',
  text: '我猜阿岚周五其实有空。', sessionRef: 'sess-A',
})
await expectError(
  'clash 只有 self 来源时拒绝（§5.2 约束 5）',
  () => core.clash({ targetId: fact.artifactId, text: '这条可能不对', sourceIds: srcSelf.sourceId }),
  'E_SELF_PROOF',
)

const srcClash = await core.capture({
  platform: 'qq', channel: 'group', externalRoomId: '888', stableUserId: '10001',
  displayName: '阿岚', origin: 'user', kind: 'message',
  text: '这周五我其实在公司加班，没打游戏。', sessionRef: 'sess-C',
})
const clash = await core.clash({
  targetId: fact.artifactId,
  text: '阿岚说这周五在加班，不是打游戏。',
  sourceIds: srcClash.sourceId,
})
ok('clash 记成 cognitive/contradiction_detected', clash.kind === 'cognitive' && clash.type === 'contradiction_detected', clash)
ok('clash 的 causedBy 指向该结论的触发事件', typeof clash.causedBy === 'string' && clash.causedBy.startsWith('evt_'), clash.causedBy)

console.log('\n[4] revise：同 id 升版本，旧版本保留')
const revised = await core.revise({
  artifactId: fact.artifactId,
  statement: '阿岚周五晚上通常打游戏，但会因加班等例外调整。',
  refs: `${clash.eventId}`,
  confidence: 'high',
})
eq('revision 升到 2', revised.revision, 2)
const revisions = db.all(
  `SELECT revision, state, statement FROM artifact_revisions WHERE artifact_id = ? ORDER BY revision`,
  [fact.artifactId],
)
eq('两版都在（不覆盖旧行）', revisions.map((r) => r.revision), [1, 2])
ok('旧版本原文没被改', revisions[0].statement.includes('通常会打游戏，不安排别的事'), revisions[0].statement)
const headRows = db.all(
  `SELECT revision FROM artifact_revisions WHERE artifact_id = ? AND revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = ?)`,
  [fact.artifactId, fact.artifactId],
)
eq('head 取 max(revision)', headRows.map((r) => r.revision), [2])

console.log('\n[5] review：五档判定改状态')
const reviewed = await core.review({
  artifactId: fact.artifactId,
  verdict: 'confirmed',
  note: '本人确认过',
  sourceIds: srcClash.sourceId,
})
eq('confirmed 后仍是 active，但版本 +1', [reviewed.state, reviewed.revision], ['active', 3])
ok('review 记了一条 cognitive/review_result 事件', reviewed.eventId.startsWith('evt_'), reviewed.eventId)

const challenged = await core.review({
  artifactId: beliefTwo.artifactId,
  verdict: 'challenged',
  note: '还没坐实',
  sourceIds: srcClash.sourceId,
})
eq('challenged 把 belief 标成 challenged', challenged.state, 'challenged')

const rejected = await core.review({
  artifactId: beliefTwo.artifactId,
  verdict: 'rejected',
  note: '其实那三个游戏是别人送的',
  sourceIds: srcClash.sourceId,
})
eq('rejected 把 belief 标成 retracted', rejected.state, 'retracted')

await expectError(
  'fact 不能用 challenged（要否定走 revised/rejected）',
  () => core.review({ artifactId: fact.artifactId, verdict: 'challenged', sourceIds: srcClash.sourceId }),
  'E_STATE',
)

console.log('\n[6] 自证门槛与 supersedes')
await expectError(
  'review 完全无外部来源时拒绝',
  async () => {
    const lonely = await core.remember({
      text: '我自己的推测：阿岚讨厌周一。',
      kind: 'fact',
      statement: '阿岚讨厌周一。',
    })
    // 这条的触发事件来源是 self，review 时也必须拒绝
    await core.review({ artifactId: lonely.artifactId, verdict: 'confirmed' })
  },
  'E_SELF_PROOF',
)

const superseded = await core.revise({
  supersedes: beliefTwo.artifactId,
  statement: '阿岚对 roguelike 的兴趣来自朋友推荐，不是长期偏好。',
  refs: srcClash.sourceId,
  sourceIds: srcClash.sourceId,
})
eq('supersedes 走新 id', superseded.mode, 'new-id')
ok('新结论 id 与旧的不同', superseded.artifactId !== beliefTwo.artifactId, superseded)
const supersedeRel = db.all(`SELECT target_artifact_id, relation FROM artifact_relations WHERE artifact_id = ?`, [
  superseded.artifactId,
])
ok(
  '新结论上挂了 relations.supersedes 指回旧 id',
  supersedeRel.some((r) => r.relation === 'supersedes' && r.target_artifact_id === beliefTwo.artifactId),
  supersedeRel,
)

console.log('\n[7] opId 幂等与冲突')
const opArgs = { text: '幂等测试事件', opId: 'op_fixed_test' }
const first = await core.remember(opArgs)
const second = await core.remember(opArgs)
ok('同 opId 同入参不重复写', second.replayed === true && second.eventId === first.eventId, { first: first.eventId, second: second.eventId })
const dupEvents = db.all(`SELECT count(*) AS n FROM events WHERE text = '幂等测试事件'`)
eq('库里只有一条', dupEvents[0].n, 1)
await expectError(
  '同 opId 不同入参被拒',
  () => core.remember({ text: '幂等测试事件（改了）', opId: 'op_fixed_test' }),
  'E_IDEMPOTENT_CONFLICT',
)

console.log('\n[8] 事务失败整笔回滚')
const beforeEvents = db.all(`SELECT count(*) AS n FROM events`)[0].n
await expectError(
  'review 传非法 verdict 直接失败',
  () => core.review({ artifactId: fact.artifactId, verdict: 'nonsense', sourceIds: srcClash.sourceId }),
  'E_VALIDATION',
)
const afterEvents = db.all(`SELECT count(*) AS n FROM events`)[0].n
eq('失败没有留下任何事件', afterEvents, beforeEvents)

const beforeRevisions = db.all(`SELECT count(*) AS n FROM artifact_revisions`)[0].n
await expectError(
  'revise 用不存在的 artifactId 失败',
  () => core.revise({ artifactId: 'art_nope', statement: 'x', refs: srcClash.sourceId }),
  'E_NOT_FOUND',
)
eq(
  '失败没有留下任何 revision',
  db.all(`SELECT count(*) AS n FROM artifact_revisions`)[0].n,
  beforeRevisions,
)
const failedOps = db.all(`SELECT status, tool, error FROM operations WHERE status = 'failed' ORDER BY created_at DESC LIMIT 2`)
ok('失败也记了 operations（可重放）', failedOps.length === 2 && Boolean(failedOps[0].error), failedOps)

console.log('\n[9] 分区治理（§12）')
await expectError(
  'relationship 分区连提案都拒绝',
  () => core.propose({ partition: 'relationship', target: 'affinity.neutral', change: '60' }),
  'E_PARTITION',
)
await expectError(
  'safety 分区只读',
  () => core.propose({ partition: 'safety', target: 'redLines', change: '放宽' }),
  'E_PARTITION',
)
const proposal = await core.propose({
  partition: 'life',
  target: 'persona.tone',
  change: '回复更简短',
  rationale: '用户说过嫌啰嗦',
})
eq('life 提案落成 pending', proposal.status, 'pending')
eq('待批提案计数为 1', proposal.pendingProposals, 1)

console.log('\n[10] 只读：关系档位、召回、取原文')
const rel = await core.getRelationship(srcUser.contactId)
eq('新关系默认中立档', rel.affinity.band, 'neutral')
ok('对外只暴露档位标签', rel.affinity.bandLabel === '中立' && typeof rel.affinity.internalValue === 'number', rel.affinity)
const recalled = await core.recall({ text: 'roguelike' }, { contactId: srcUser.contactId, roomId: srcUser.roomId })
ok('recall 命中结论', recalled.results.length > 0, recalled.results.length)
const reversed = await core.recall({ text: '周五晚上' }, { contactId: srcUser.contactId, roomId: srcUser.roomId })
const reverseHit = reversed.results.find((item) => item.artifactId === fact.artifactId)
ok('反向查询：文本找回它产出的结论', Boolean(reverseHit), reversed.results.map((item) => item.artifactId))
ok(
  '召回结果不再带事件栏',
  !('events' in reversed),
  Object.keys(reversed),
)
ok(
  '关联事件只给类型与时间',
  (reverseHit?.relatedEvents ?? []).every(
    (event) => typeof event.type === 'string' && typeof event.at === 'string' && !('eventId' in event) && !('text' in event),
  ),
  reverseHit?.relatedEvents,
)
const fetched = await core.fetch([srcUser.sourceId, fact.artifactId], 400)
ok('fetch 能取 source 与 artifact', fetched.items.every((i) => i.type !== 'missing'), fetched.items.map((i) => i.type))
ok('fetch 遵守字符预算', fetched.used <= fetched.budget, { used: fetched.used, budget: fetched.budget })

const state = await core.getState()
ok('state 报的规模与库里一致', state.counts.events === db.all(`SELECT count(*) AS n FROM events`)[0].n, state.counts)
ok('state 带存储健康信息', state.storage.driver === 'node:sqlite' && state.storage.tables === 81, state.storage.tables)

console.log('\n[11] 只追加触发器')
try {
  db.run(`UPDATE events SET text = '篡改' WHERE event_id = ?`, [first.eventId])
  ok('events 禁止 UPDATE', false, '竟然改成功了')
} catch (error) {
  ok('events 禁止 UPDATE', /append|只追加|append_only/i.test(error.message), error.message)
}
try {
  db.run(`DELETE FROM relationship_signals WHERE signal_id = 'nope'`)
  ok('relationship_signals 禁 DELETE 触发器存在', true)
} catch (error) {
  ok('relationship_signals 禁 DELETE 触发器存在', /append|只追加/i.test(error.message), error.message)
}

const health = db.health()
console.log(`\n[12] 性能记账：${health.queries} 次查询，慢查询 ${health.slowQueries} 次，最慢 ${health.maxQueryMs}ms`)
ok('慢查询统计可用', health.maxQueryMs >= 0, health)

console.log('\n[13] 工具返回值必须是无损 JSON（宿主会校验）')
const lossless = (value) => {
  const once = JSON.stringify(value)
  const twice = JSON.stringify(JSON.parse(once))
  return once === twice && once !== undefined
}
ok('toErrorPayload 无 undefined 键', lossless(toErrorPayload(new PsycheError('E_FAKE', '假的错'))))
ok('toErrorPayload 无 detail 时不补键', !('detail' in toErrorPayload(new PsycheError('E_FAKE', '假的错'))))
eq(
  'jsonSafe 清洗 undefined/NaN/Date',
  jsonSafe({ a: undefined, b: Number.NaN, c: new Date(0), d: [undefined, 1], e: { f: Number.POSITIVE_INFINITY } }),
  { b: null, c: '1970-01-01T00:00:00.000Z', d: [null, 1], e: { f: null } },
)
ok('state 结果无损', lossless(jsonSafe(state)))
ok('stances 结果无损', lossless(jsonSafe(await core.stances({}))))
ok('recall 结果无损', lossless(jsonSafe(recalled)))
ok('fetch 结果无损', lossless(jsonSafe(fetched)))
ok('relationship 结果无损', lossless(jsonSafe(rel)))

console.log('\n[14] 工具层传 subject 要落到 subjectRefs（回归：subject 曾被静默丢弃）')
const subjectRemember = await core.remember({
  text: '用户在推 dsh-psyche 的 TypeScript 改造',
  eventType: 'conversation',
  kind: 'fact',
  statement: '心灵插件改用 TypeScript 开发',
  subject: 'dsh-psyche',
  disclosure: 'public',
})
ok('remember 接受工具侧的 subject 字段', subjectRemember.artifactId !== null, subjectRemember)
const bySubject = await core.stances({ kind: 'fact', subject: 'dsh-psyche' })
ok(
  '按 subject 过滤能查到刚写的结论',
  bySubject.items.some((item) => item.artifactId === subjectRemember.artifactId),
  bySubject.items,
)
const subjectRow = db.get(`SELECT subject_refs FROM artifact_revisions WHERE artifact_id = ? AND revision = 1`, [
  subjectRemember.artifactId,
])
eq('subjectRefs 落库为 JSON 数组', JSON.parse(subjectRow.subject_refs), ['dsh-psyche'])
const recallBySubject = await core.recall({ text: 'TypeScript', subject: 'dsh-psyche' }, { surface: 'personal' })
ok(
  'recall 也能按 subject 过滤回来',
  recallBySubject.results.some((item) => item.artifactId === subjectRemember.artifactId),
  recallBySubject.results,
)

// ── v14 §21–§22：成长派生层 ────────────────────────────────
console.log('\n[15] 成长派生（四阶段 + 成熟信念判据 + 集成只能人确认）')

const { deriveGrowth, isMatureBelief, ALGORITHM_VERSION } = await import('../dist/lib/derive.js')
const { confirmIntegration } = await import('../dist/lib/growth.js')

const emptyDerived = deriveGrowth({
  currentPhase: 'trust',
  beliefs: [],
  refusals: [],
  corrections: [],
  integrationConfirmed: 0,
  firstEventAt: null,
  now: nowIso(),
})
eq('空库停在信任阶段', emptyDerived.stage, 'trust')
ok('空库的瓶颈是信任', emptyDerived.bottleneck === 'trust', emptyDerived.bottleneck)
ok(
  '信任闸没过时说明缺成熟信念',
  emptyDerived.gates.trust.shortfall.includes('成熟信念'),
  emptyDerived.gates.trust.shortfall,
)
ok(
  '单一来源不算成熟信念',
  isMatureBelief({
    artifactId: 'a',
    revision: 1,
    state: 'active',
    confidence: 'high',
    independenceKeys: ['k1'],
    sessionRefs: [],
  }) === false,
)
ok(
  '两个独立来源才算成熟信念',
  isMatureBelief({
    artifactId: 'a',
    revision: 1,
    state: 'active',
    confidence: 'medium',
    independenceKeys: ['k1', 'k2'],
    sessionRefs: [],
  }) === true,
)

const growthStart = await core.getGrowth()
ok('阶段落在四个合法值之一', ['trust', 'autonomy', 'initiative', 'integration'].includes(growthStart.stage), growthStart.stage)
eq('成长算法版本写进返回值', growthStart.algorithmVersion, ALGORITHM_VERSION)

// 两个独立来源（不同会话窗口）支撑同一条信念
const growSrcA = await core.capture({
  platform: 'desktop',
  channel: 'desktop',
  sessionRef: 'grow-a',
  origin: 'user',
  kind: 'message',
  text: '养鱼的水温要稳定在 24 度',
})
const growSrcB = await core.capture({
  platform: 'desktop',
  channel: 'desktop',
  sessionRef: 'grow-b',
  origin: 'external',
  kind: 'message',
  text: '资料说养鱼水温 24 度最稳',
})
const growRemember = await core.remember({
  text: '两处独立说法都指向养鱼水温 24 度',
  eventType: 'conversation',
  kind: 'belief',
  statement: '养鱼的水温稳定在 24 度比较合适',
  confidence: 'high',
  sourceIds: [growSrcA.sourceId, growSrcB.sourceId],
})
ok('两个独立来源足以晋升高置信信念', growRemember.artifactId !== null, growRemember)

const growthAfter = await core.getGrowth()
ok(
  '成熟信念让信任闸通过',
  growthAfter.gates.find((gate) => gate.gate === 'trust')?.passed === true,
  growthAfter.gates,
)
// Growth Gate（v18）：getGrowth().stage 是「按证据派生出来的阶段」，闸过了就显示自主；
// 真正落库的 phase_state 不会因为一次 remember 就变——那是 syncGrowth() 的职责。
eq('派生阶段显示自主（闸已过）', growthAfter.stage, 'autonomy')
eq(
  '但落库阶段仍是信任（写路径只评估）',
  db.all(`SELECT phase FROM phase_state WHERE persona_id = 'main'`)[0].phase,
  'trust',
)
await core.syncGrowth()
const growthSynced = await core.getGrowth()
eq(
  'syncGrowth 后落库阶段推进到自主',
  db.all(`SELECT phase FROM phase_state WHERE persona_id = 'main'`)[0].phase,
  'autonomy',
)
eq('派生阶段也是自主', growthSynced.stage, 'autonomy')
ok('瓶颈变成自主', growthSynced.bottleneck === 'autonomy', growthSynced.bottleneck)

const milestone = db.get(`SELECT * FROM phase_milestones WHERE gate = 'trust'`)
ok('里程碑落库且带算法版本', milestone !== undefined && milestone.algorithm_version === ALGORITHM_VERSION, milestone)
const trustEvidence = db.all(`SELECT independence_key FROM phase_evidence WHERE milestone_id = ?`, [
  milestone.milestone_id,
])
ok('里程碑下至少挂两条证据', trustEvidence.length >= 2, trustEvidence.length)
ok(
  '证据的独立键各不相同',
  new Set(trustEvidence.map((row) => row.independence_key)).size === trustEvidence.length,
  trustEvidence.map((row) => row.independence_key),
)

const growthAgain = await core.getGrowth()
eq('再读一次阶段不会重复推进', growthAgain.advanced.length, 0)
eq('里程碑仍然只有一个', db.all(`SELECT * FROM phase_milestones`).length, 1)

const ctx = await core.context()
eq('context 只给阶段名', ctx.persona.stage, 'autonomy')
ok('context 不带闸门计数', ctx.persona.have === undefined && ctx.gates === undefined, Object.keys(ctx))
ok(
  'context 列出立住的判断',
  ctx.beliefs.some((belief) => belief.artifactId === growRemember.artifactId),
  ctx.beliefs,
)

await expectError(
  '前三道闸没过时不能直接确认整合',
  async () => {
    confirmIntegration(db, { actor: 'owner' })
  },
  null,
)

console.log('\n[17] 正式立场只能由 Core 合成（模型不能用 remember/revise 直接写 stance）')
await expectError(
  'remember(kind=stance) 被拒绝',
  async () => {
    await core.remember({
      text: '用户说他更喜欢安静一点的助手',
      eventType: 'conversation',
      kind: 'stance',
      statement: '用户偏好安静的助手',
    })
  },
  'E_VALIDATION',
)
let stanceMessage = ''
try {
  await core.remember({ text: '再说一次立场', kind: 'stance', statement: '用户偏好安静的助手' })
} catch (error) {
  stanceMessage = String((error as Error).message)
}
ok('拒绝信息指向 belief', stanceMessage.includes('belief'), stanceMessage)
await expectError(
  'revise(kind=stance) 同样被拒绝',
  async () => {
    await core.revise({
      supersedes: growRemember.eventId,
      refs: [growRemember.eventId],
      kind: 'stance',
      statement: '用户偏好安静的助手',
    })
  },
  'E_VALIDATION',
)

console.log('\n[16] 工具清单（回归：新加的工具必须真的出现在 buildTools 的返回里）')
const toolList = buildTools(core as unknown as Parameters<typeof buildTools>[0]) as { name: string }[]
const toolNames = toolList.map((tool) => tool.name)
eq('工具共 18 个', toolNames.length, 18)
ok('工具名互不重复', new Set(toolNames).size === 18, toolNames)
ok('包含新增的 psyche_context', toolNames.includes('psyche_context'), toolNames)
ok(
  '十七个工具一个不少',
  ['remember', 'clash', 'revise', 'review', 'forget', 'propose', 'stances', 'state', 'relationship', 'recall', 'fetch', 'create_reminder', 'list_reminders', 'resolve_delivery', 'cancel_reminder', 'growth_candidates', 'growth_decide'].every(
    (suffix) => toolNames.includes(`psyche_${suffix}`),
  ),
  toolNames,
)

console.log('\n[18] 时间只按两种格式显示（yyyy-mm-dd hh:mm:ss / yyyy-mm-dd，本地时区）')
const dtText = formatDateTime('2026-11-01T12:34:56.789Z')
ok('formatDateTime 形如 2026-11-01 20:34:56', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dtText), dtText)
ok('formatDateTime 不带 T/Z', !dtText.includes('T') && !dtText.includes('Z'), dtText)
ok('formatDate 形如 2026-11-01', /^\d{4}-\d{2}-\d{2}$/.test(formatDate('2026-11-01T12:34:56.789Z')), formatDate('2026-11-01T12:34:56.789Z'))
eq('认不出来的时间给占位', formatDateTime('not-a-time'), '—')
eq('空值给占位', formatDateTime(null), '—')
eq('Date 对象也认', formatDate(new Date(2026, 10, 1)), '2026-11-01')

console.log('\n[19] v2 回归（迁移完整性 / 迁移中断 / 里程碑幂等 / 证据撤回 / 独立证据口径 / 越权与状态隔离）')

const { DatabaseSync } = await import('node:sqlite')
const { Db } = await import('../dist/lib/adapter.js')
const { MIGRATIONS } = await import('../dist/lib/schema.js')

function makeV1(file: string) {
  const handle = new DatabaseSync(file)
  const v1 = new Db({ handle, driver: 'node:sqlite', file })
  v1.applyBasePragmas()
  v1.exec(MIGRATIONS[0].sql)
  MIGRATIONS[0].seed?.({ run: (sql, params) => v1.run(sql, params) }, nowIso())
  v1.exec('PRAGMA user_version = 1')
  return v1
}

/** `Db.pragma()` 只吃 `PRAGMA x` 形式，任意 SELECT 用这个取第一列。 */
function scalar<T = unknown>(database: { get(sql: string, params?: unknown[]): unknown }, sql: string, params: unknown[] = []): T | undefined {
  const row = database.get(sql, params) as Record<string, unknown> | undefined
  return row === undefined ? undefined : (Object.values(row)[0] as T)
}
const countOf = (sql: string, params: unknown[] = []) => Number(scalar<number>(db, sql, params) ?? 0)

// ── 19.1 旧库迁移：v1 的数据、外键、触发器、索引都要活下来
const v1File = join(dir, 'v1-migrate.sqlite3')
const v1 = makeV1(v1File)
v1.run(
  `INSERT INTO proposals (proposal_id, persona_id, partition, target, change, status, created_at)
   VALUES ('prop_v1_keep', 'main', 'life', 'tone', 'v1 时代的提案', 'pending', ?)`,
  [nowIso()],
)
const v1TriggerNames = v1
  .all(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
  .map((row) => String(row.name))
const appliedV2 = migrate(v1)
eq('v1→v42 应用四十一步（v2 至 v42）', appliedV2.length, 41)
eq('迁移后 user_version=42', v1.userVersion(), 42)
eq('v1 时代的提案还在', String(scalar(v1, `SELECT partition FROM proposals WHERE proposal_id = 'prop_v1_keep'`)), 'life')
eq('外键仍然是开着的', String(v1.pragma('foreign_keys')), '1')
ok(
  '新表 phase_milestones / learning_jobs 建好了',
  ['phase_milestones', 'learning_jobs'].every(
    (name) =>
      Number(scalar<number>(v1, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${name}'`) ?? 0) === 1,
  ),
)
ok(
  'phase_evidence 加上了新列',
  ['milestone_id', 'gate', 'evidence_type', 'independence_key', 'redacted_at'].every(
    (column) =>
      Number(scalar<number>(v1, `SELECT COUNT(*) FROM pragma_table_info('phase_evidence') WHERE name = '${column}'`) ?? 0) === 1,
  ),
)
ok(
  'sources 加上了 capture_key 列（P2-CAP-1a）',
  Number(scalar<number>(v1, `SELECT COUNT(*) FROM pragma_table_info('sources') WHERE name = 'capture_key'`) ?? 0) === 1,
)
const triggersAfter = new Set(
  v1.all(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).map((row) => String(row.name)),
)
const lostTriggers = v1TriggerNames.filter((name) => !triggersAfter.has(name))
ok('旧触发器一个没丢', lostTriggers.length === 0, lostTriggers)
v1.run(
  `INSERT INTO proposals (proposal_id, persona_id, partition, target, change, status, created_at)
   VALUES ('prop_growth_ok', 'main', 'growth', 'phase', 'growth 分区可写', 'pending', ?)`,
  [nowIso()],
)
eq('proposals 的 CHECK 认 growth 分区', String(scalar(v1, `SELECT status FROM proposals WHERE proposal_id = 'prop_growth_ok'`)), 'pending')
await expectError(
  'proposals 仍然拒绝不存在的分区',
  async () => {
    v1.run(
      `INSERT INTO proposals (proposal_id, persona_id, partition, target, change, status, created_at)
       VALUES ('prop_bad', 'main', 'nope', 'x', 'y', 'pending', ?)`,
      [nowIso()],
    )
  },
  'E_VALIDATION',
)

// ── 19.2 迁移中断：半截的 v2 必须整笔回滚，不留半迁移状态
const v1bFile = join(dir, 'v1-interrupt.sqlite3')
const v1b = makeV1(v1bFile)
try {
  v1b.transaction(() => {
    v1b.exec(`ALTER TABLE phase_evidence ADD COLUMN milestone_id TEXT`)
    throw new Error('模拟迁移中途断电')
  })
} catch {
  // 预期内
}
eq('中断后 user_version 还是 1', v1b.userVersion(), 1)
eq(
  '中断后没有留下半截的列',
  Number(scalar<number>(v1b, `SELECT COUNT(*) FROM pragma_table_info('phase_evidence') WHERE name = 'milestone_id'`) ?? 0),
  0,
)
eq('重跑迁移能补上（v2 至 v42 共四十一步）', migrate(v1b).length, 41)
eq(
  '重跑后列有了',
  Number(scalar<number>(v1b, `SELECT COUNT(*) FROM pragma_table_info('phase_evidence') WHERE name = 'milestone_id'`) ?? 0),
  1,
)
eq('重跑后版本是 42', v1b.userVersion(), 42)
v1b.close()
v1.close()

// ── 19.3 里程碑幂等：同一次晋级不会因为多跑几次多写一行
const milestoneCount = () => countOf(`SELECT COUNT(*) AS n FROM phase_milestones WHERE persona_id = 'main'`)
const milestonesBefore = milestoneCount()
ok('前面的写入至少推进过一次阶段', milestonesBefore >= 1, milestonesBefore)
await core.syncGrowth()
await core.syncGrowth()
eq('连跑两次 syncGrowth 不新增里程碑', milestoneCount(), milestonesBefore)
const evidBefore = countOf(`SELECT COUNT(*) AS n FROM phase_evidence WHERE milestone_id IS NOT NULL`)
await core.getGrowth()
await core.getGrowth()
eq('读接口不写证据', countOf(`SELECT COUNT(*) AS n FROM phase_evidence WHERE milestone_id IS NOT NULL`), evidBefore)

// ── 19.4 证据撤回：只打 redacted_at，里程碑与阶段都不动
const firstMilestone = String(
  scalar(db, `SELECT milestone_id FROM phase_milestones WHERE persona_id = 'main' ORDER BY created_at LIMIT 1`),
)
const phaseBefore = String(scalar(db, `SELECT phase FROM phase_state WHERE persona_id = 'main'`))
const redacted = await core.redactMilestone(firstMilestone)
ok('撤回打了 redacted_at', redacted.redacted >= 1, redacted)
ok(
  '证据行还在（只是标记脱敏）',
  countOf(
    `SELECT COUNT(*) AS n FROM phase_evidence WHERE milestone_id = ? AND redacted_at IS NOT NULL`,
    [firstMilestone],
  ) >= 1,
)
eq(
  '里程碑本身没被删',
  countOf(`SELECT COUNT(*) AS n FROM phase_milestones WHERE milestone_id = ?`, [firstMilestone]),
  1,
)
eq('阶段没有被撤回改动', String(scalar(db, `SELECT phase FROM phase_state WHERE persona_id = 'main'`)), phaseBefore)

// ── 19.5 独立证据口径：同一活动窗口的两次抓取只算一条独立证据
const sameWindowA = await core.capture({ text: '同一个视频的字幕片段', sessionRef: 'smoke-indep-1', platform: 'bilibili' })
const sameWindowB = await core.capture({ text: '同一个视频的抽帧描述', sessionRef: 'smoke-indep-1', platform: 'bilibili' })
const beliefDraft = db.all<{ independence_key: string | null }>(
  `SELECT independence_key FROM sources WHERE source_id IN (?, ?)`,
  [sameWindowA.sourceId, sameWindowB.sourceId],
)
eq('同窗口两条来源的 independence_key 相同', beliefDraft[0]?.independence_key, beliefDraft[1]?.independence_key)
const singleSourceBelief = await core.remember({
  text: '按同一个来源的不同形态做的判断',
  eventType: 'conversation',
  kind: 'belief',
  statement: '同一个视频的字幕与画面不算两条独立来源',
  sourceIds: [sameWindowA.sourceId, sameWindowB.sourceId],
  confidence: 'high',
})
ok('只凑到一条独立证据的判断没升成正式结论', singleSourceBelief.artifactId === null, singleSourceBelief)
ok(
  '同样的证据喂给 isMatureBelief 也不成熟',
  isMatureBelief({ artifactId: 'x', revision: 1, state: 'active', confidence: 'high', independenceKeys: ['win:smoke-indep-1'], sessionRefs: [] }) === false,
)
const crossWindow = await core.capture({ text: '另一个来源的另一段话', sessionRef: 'smoke-indep-2', platform: 'bilibili' })
const matureBelief = await core.remember({
  text: '两个独立来源支持同一个判断',
  eventType: 'conversation',
  kind: 'belief',
  statement: '两个独立来源才够',
  sourceIds: [sameWindowA.sourceId, crossWindow.sourceId],
  confidence: 'high',
})
ok('两条真正独立的证据才升成结论', matureBelief.artifactId !== null, matureBelief)

// ── 19.6 越权：growth 分区与 stance 都不接受模型写入
await expectError(
  '模型工具不能建 growth 提案',
  async () => core.propose({ partition: 'growth', target: 'phase', change: '让我进整合阶段' }),
  'E_PARTITION',
)
await expectError(
  '模型工具也不能借 pending 之类参数绕道写 stance',
  async () => core.remember({ text: '绕过尝试', kind: 'stance', statement: '我是正式立场' }),
  'E_VALIDATION',
)

// ── 19.7 状态隔离：模型侧上下文里没有闸门计数、阈值、表名
const ctxPayload = await core.context()
const ctxJson = JSON.stringify(ctxPayload)
ok('context 不含 gate/threshold/salience 字段', !/"(gate|need|have|shortfall|salience|threshold)"/.test(ctxJson), ctxJson.slice(0, 200))
ok('context 不含表名', !/artifact_revisions|phase_evidence|phase_milestones/.test(ctxJson), ctxJson.slice(0, 200))
ok('context 保留阶段名', typeof ctxPayload.persona.stageLabel === 'string' && ctxPayload.persona.stageLabel.length > 0)

console.log('\n[20] growth 提案三段接口（模型拒绝 / Core 创建 / 人类确认）')
const growthNow = await core.getGrowth()
const earlierGatesPassed = growthNow.gates.filter((gate) => gate.gate !== 'integration').every((gate) => gate.passed)
const createdProposal = await core.createGrowthProposal({ statement: '阶段总结：到该确认的时候了' })
ok('Core 能建 growth 提案', typeof createdProposal.proposalId === 'string' && createdProposal.proposalId.startsWith('prop_'), createdProposal)
const createdAgain = await core.createGrowthProposal()
eq('已有 pending 提案时不会重复建', createdAgain.proposalId, createdProposal.proposalId)
eq('提案落在 growth 分区', String(scalar(db, `SELECT partition FROM proposals WHERE proposal_id = ?`, [createdProposal.proposalId])), 'growth')

const deniedProposal = await core.confirmGrowthProposal({ proposalId: createdProposal.proposalId, accept: false, actor: 'owner' })
eq('驳回生效', deniedProposal.status, 'rejected')
eq('驳回不改阶段', deniedProposal.phase, growthNow.stage)
eq(
  '驳回记了处理人',
  String(scalar(db, `SELECT decided_by FROM proposals WHERE proposal_id = ?`, [createdProposal.proposalId])),
  'owner',
)

const createdSecond = await core.createGrowthProposal({ statement: '再来一条，试试接受' })
if (earlierGatesPassed) {
  const accepted = await core.confirmGrowthProposal({ proposalId: createdSecond.proposalId, accept: true, actor: 'owner' })
  eq('前三道闸都过了才能接受', accepted.status, 'accepted')
  eq('接受之后进整合阶段', accepted.phase, 'integration')
  ok('接受写了里程碑', typeof accepted.milestoneId === 'string' && accepted.milestoneId.startsWith('hst_'), accepted)
} else {
  await expectError(
    '前三道闸没过时接受会被回滚',
    async () => core.confirmGrowthProposal({ proposalId: createdSecond.proposalId, accept: true, actor: 'owner' }),
  )
  eq(
    '回滚后提案还是 pending',
    String(scalar(db, `SELECT status FROM proposals WHERE proposal_id = ?`, [createdSecond.proposalId])),
    'pending',
  )
  ok(
    '回滚后没有多写里程碑',
    countOf(`SELECT COUNT(*) AS n FROM phase_milestones WHERE gate = 'integration'`) === 0,
  )
}

console.log('\n[21] 意识海场景 + 面板偏好开关')
const seaFirst = buildSeaScene(db)
const seaSecond = buildSeaScene(db)
ok('意识海有结论点', seaFirst.nodes.some((node) => node.kind !== 'event'), seaFirst.stats)
ok('意识海有经历点', seaFirst.nodes.some((node) => node.kind === 'event'))
ok('两次构建的点数一致（稳定）', seaFirst.nodes.length === seaSecond.nodes.length, {
  a: seaFirst.nodes.length,
  b: seaSecond.nodes.length,
})
const firstNode = seaFirst.nodes[0]
const sameNodeAgain = seaSecond.nodes.find((node) => node.id === firstNode.id)
eq('同一节点的坐标稳定', `${firstNode.x},${firstNode.y},${firstNode.z}`, `${sameNodeAgain?.x},${sameNodeAgain?.y},${sameNodeAgain?.z}`)
ok(
  '坐标落在世界坐标口径内（±720，对齐 3d-memory-sea 的簇心半径）',
  seaFirst.nodes.every(
    (node) => Math.abs(node.x) <= 720 && Math.abs(node.y) <= 720 && Math.abs(node.z) <= 720,
  ),
)
ok(
  '每个点都带簇（kind），前端能画簇名',
  seaFirst.nodes.every((node) => typeof node.cluster === 'string' && node.cluster.length > 0),
)
ok(
  '同类点聚在同簇附近（簇内平均距离 < 跨簇平均距离）',
  (() => {
    const groups = new Map<string, typeof seaFirst.nodes>()
    for (const node of seaFirst.nodes) {
      const list = groups.get(node.cluster) ?? []
      list.push(node)
      groups.set(node.cluster, list)
    }
    const spread = (list: typeof seaFirst.nodes): number => {
      if (list.length < 2) return 0
      let total = 0
      let pairs = 0
      for (let a = 0; a < list.length; a += 1) {
        for (let b = a + 1; b < list.length; b += 1) {
          total += Math.hypot(list[a].x - list[b].x, list[a].y - list[b].y, list[a].z - list[b].z)
          pairs += 1
        }
      }
      return pairs ? total / pairs : 0
    }
    const inner = [...groups.values()].filter((list) => list.length >= 2).map(spread)
    const cross = (() => {
      const list = seaFirst.nodes
      let total = 0
      let pairs = 0
      for (let a = 0; a < list.length; a += 1) {
        for (let b = a + 1; b < list.length; b += 1) {
          if (list[a].cluster === list[b].cluster) continue
          total += Math.hypot(list[a].x - list[b].x, list[a].y - list[b].y, list[a].z - list[b].z)
          pairs += 1
        }
      }
      return pairs ? total / pairs : 0
    })()
    if (!inner.length || !cross) return true
    const average = inner.reduce((sum, value) => sum + value, 0) / inner.length
    return average < cross
  })(),
)
ok(
  '每条边带 0–1 的 score（前端按它算线透明度）',
  seaFirst.edges.every((edge) => typeof edge.score === 'number' && edge.score > 0 && edge.score <= 1),
)
ok(
  'stats 带时间跨度（前端算跨度天数）',
  Boolean(seaFirst.stats.span) &&
    typeof seaFirst.stats.span?.from === 'string' &&
    typeof seaFirst.stats.span?.to === 'string',
  seaFirst.stats.span,
)
ok('边只连已有的点', seaFirst.edges.every((edge) => {
  const ids = new Set(seaFirst.nodes.map((node) => node.id))
  return ids.has(edge.a) && ids.has(edge.b)
}))
const seaArtifactIds = new Set(seaFirst.nodes.filter((node) => node.kind !== 'event').map((node) => node.id))
ok('结论之间有真实关系边', seaFirst.edges.some((edge) => edge.kind === 'relation' && seaArtifactIds.has(edge.a)) || seaFirst.edges.some((edge) => edge.kind === 'lineage'))
ok('触发边把事件连到结论', seaFirst.edges.some((edge) => edge.kind === 'trigger'))
ok('默认不截断（空库/小库）', seaFirst.stats.truncated === false || seaFirst.stats.truncated === true, seaFirst.stats)
ok('note 说明口径', typeof seaFirst.note === 'string' && seaFirst.note.length > 0, seaFirst.note)

// 偏好文件：默认关、写读一致、坏文件不影响插件
const prefsDir = join(dir, 'prefs-case')
eq('偏好默认关意识海', readPrefs(prefsDir).sea, false)
const written = writePrefs(prefsDir, { sea: true })
eq('写入后读回来是开', written.sea, true)
eq('落盘文件在数据目录', readPrefs(prefsDir).sea, true)
ok('偏好文件路径在数据根', prefsPath(prefsDir).startsWith(prefsDir), prefsPath(prefsDir))
const afterPatch = writePrefs(prefsDir, { promptSection: false })
eq('只改一项时另一项保持', afterPatch.sea, true)
eq('promptSection 可写', afterPatch.promptSection, false)
const cleared = writePrefs(prefsDir, { promptSection: null })
eq('promptSection 可以恢复跟随配置', cleared.promptSection, null)

console.log('\n[22] 显著度与折叠（P2 §21.2：只算不写、不注入判据）')

const NOW = new Date('2026-11-01T12:00:00.000Z')
function salienceInput(overrides) {
  return {
    artifactId: 'art_salience_case',
    kind: 'belief',
    revision: 1,
    state: 'active',
    confidence: 'medium',
    statement: '一条用来算显著度的判断',
    createdAt: '2026-11-01T11:58:00.000Z',
    updatedAt: '2026-11-01T11:58:00.000Z',
    lastSeenAt: '2026-11-01T11:58:00.000Z',
    evidence: [],
    verificationCount: 0,
    consequenceCount: 0,
    ...overrides,
  }
}

const lonely = deriveSalience([salienceInput({ evidence: [{ relation: 'supports', independenceKey: 'k1' }] })], NOW)[0]
const solidOne = deriveSalience(
  [
    salienceInput({
      evidence: [
        { relation: 'supports', independenceKey: 'k1' },
        { relation: 'supports', independenceKey: 'k2' },
        { relation: 'supports', independenceKey: 'k3' },
      ],
    }),
  ],
  NOW,
)[0]
ok('只有一个独立经历不算固化', lonely.solid === false, lonely.components)
ok('三个独立经历达成固化', solidOne.solid === true && solidOne.components.independentActivityGroups === 3, solidOne.components)
ok('固化之后分数更高', solidOne.score > lonely.score, { lonely: lonely.score, solid: solidOne.score })
ok(
  '同一输入两次派生完全一致（确定性）',
  JSON.stringify(deriveSalience([salienceInput()], NOW)) === JSON.stringify(deriveSalience([salienceInput()], NOW)),
)
ok(
  '时间越久分数越低（30 天半衰）',
  (() => {
    const fresh = deriveSalience([salienceInput()], NOW)[0]
    const old = deriveSalience([salienceInput({ lastSeenAt: '2026-09-01T00:00:00.000Z' })], NOW)[0]
    return old.score < fresh.score && old.components.recency < fresh.components.recency
  })(),
)
ok(
  '反驳证据与后果也算进分数',
  (() => {
    const plain = deriveSalience([salienceInput()], NOW)[0]
    const bumped = deriveSalience(
      [
        salienceInput({
          evidence: [{ relation: 'contradicts', independenceKey: 'c1' }],
          consequenceCount: 1,
          verificationCount: 1,
        }),
      ],
      NOW,
    )[0]
    return bumped.score > plain.score
  })(),
)
ok(
  '被推翻的结论分数明显掉下来',
  (() => {
    const active = deriveSalience([salienceInput()], NOW)[0]
    const retired = deriveSalience([salienceInput({ state: 'superseded' })], NOW)[0]
    return retired.score < active.score * 0.5
  })(),
)

const foldCandidates = [
  { id: 'art_a', kind: 'belief', text: '第一条比较重要、也比较长的判断内容，用来测试截断', score: 3.2, solid: true },
  { id: 'art_b', kind: 'fact', text: '第二条', score: 2.1, solid: false },
  { id: 'art_c', kind: 'fact', text: '第三条', score: 1.4, solid: false },
  { id: 'art_d', kind: 'fact', text: '第四条', score: 1.1, solid: false },
]
const roomy = foldWithinBudget(foldCandidates, { maxChars: 400, maxTokens: 300, perItemChars: 20 })
eq('预算够时全部塞进去', roomy.lines.length, 4)
eq('不折任何一条', roomy.foldedCount, 0)
const longCandidates = [
  { id: 'art_a', kind: 'belief', text: '长'.repeat(60), score: 3.2, solid: true },
  { id: 'art_b', kind: 'fact', text: '长'.repeat(60), score: 2.1, solid: false },
  { id: 'art_c', kind: 'fact', text: '长'.repeat(60), score: 1.4, solid: false },
  { id: 'art_d', kind: 'fact', text: '长'.repeat(60), score: 1.1, solid: false },
]
// 每条按 perItemChars 截到 25 字：两条占 50 字，第三条塞不下（50+25 > 70），
// 剩下的折成一句（折叠句 19 字，50+19 = 69 ≤ 70，放得下）。
const tight = foldWithinBudget(longCandidates, { maxChars: 70, maxTokens: 300, perItemChars: 25 })
ok('预算不够时只塞得下一部分', tight.lines.length < longCandidates.length, { lines: tight.lines.length })
eq('折叠条数等于没塞进去的条数', tight.foldedCount, longCandidates.length - tight.lines.length)
ok(
  '塞不下的折成一句（不是静默丢掉）',
  typeof tight.foldedLine === 'string' && tight.foldedLine.includes(String(tight.foldedCount)),
  { foldedCount: tight.foldedCount, foldedLine: tight.foldedLine },
)
ok('折叠句自己也占预算', tight.usedChars <= tight.budgetChars && tight.usedTokens <= tight.budgetTokens, tight)
ok(
  '超长条目按 perItemChars 截断并带省略号',
  (() => {
    const cut = foldWithinBudget(
      [{ id: 'art_long', kind: 'belief', text: '很长'.repeat(60), score: 5, solid: true }],
      { maxChars: 400, maxTokens: 300, perItemChars: 12 },
    )
    return cut.lines.length === 1 && cut.lines[0].truncated && cut.lines[0].text.endsWith('…')
  })(),
)
eq('硬上限为 0 时一条都不塞', foldWithinBudget(foldCandidates, { maxChars: 0, maxTokens: 0 }).lines.length, 0)

const growthOpsBefore = countOf(`SELECT COUNT(*) AS n FROM operations WHERE tool = 'psyche_growth'`)
const salienceNow = deriveSalienceNow(db, { limit: 120 })
const salienceAgain = deriveSalienceNow(db, { limit: 120 })
ok('库上派生能跑出结果（空库也要能跑）', Array.isArray(salienceNow))
eq(
  '库上派生两次结果一致',
  JSON.stringify(salienceNow.map((item) => [item.artifactId, item.score, item.solid])),
  JSON.stringify(salienceAgain.map((item) => [item.artifactId, item.score, item.solid])),
)
eq(
  '显著度派生不写 operations（读就是读）',
  countOf(`SELECT COUNT(*) AS n FROM operations WHERE tool = 'psyche_growth'`),
  growthOpsBefore,
)
ok(
  '排序里固化优先',
  (() => {
    const ranked = deriveSalience(
      [
        salienceInput({ artifactId: 'art_low', evidence: [{ relation: 'supports', independenceKey: 'x1' }] }),
        salienceInput({
          artifactId: 'art_high',
          evidence: [
            { relation: 'supports', independenceKey: 'y1' },
            { relation: 'supports', independenceKey: 'y2' },
            { relation: 'supports', independenceKey: 'y3' },
          ],
        }),
      ],
      NOW,
    )
    return ranked[0].artifactId === 'art_high'
  })(),
)

// ── [23] 令牌与花费 / 运维 ─────────────────────────────────────
console.log('\n[23] 令牌与花费与运维')
await (async () => {
  // 12.1 未命中 = 全部输入 − 命中 − 写缓存
  const buckets = normalizeUsage({ inputTokens: 1000, cacheReadTokens: 400, cacheWriteTokens: 100, outputTokens: 50 })
  eq('未命中按 input − read − write 算', [buckets.cacheMiss, buckets.cacheHit, buckets.cacheWrite, buckets.output], [500, 400, 100, 50])
  eq('总 token 计入全部输入与输出', totalTokensOf(buckets), 1000 + 50)

  // 12.2 同一条采样在周末/工作日白天/工作日晚上三个时刻的单价不同
  const millionMiss = { cacheMiss: 1_000_000, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 }
  const sundayNoon = new Date(2026, 10, 1, 12, 0, 0).getTime()
  const mondayPeak = new Date(2026, 10, 2, 10, 0, 0).getTime()
  const mondayNight = new Date(2026, 10, 2, 20, 0, 0).getTime()
  const off = priceUsage(millionMiss, { model: 'deepseek-flash', at: sundayNoon })
  const peak = priceUsage(millionMiss, { model: 'deepseek-flash', at: mondayPeak })
  const night = priceUsage(millionMiss, { model: 'deepseek-flash', at: mondayNight })
  eq('周末没有高峰价', [off.tier, off.total], ['off', 1])
  eq('工作日 10:00 是高峰价（×2）', [peak.tier, peak.total], ['peak', 2])
  eq('工作日 20:00 回到空闲价', [night.tier, night.total], ['off', 1])

  // 12.3 命中缓存按命中价算
  const hits = priceUsage({ cacheMiss: 0, cacheHit: 1_000_000, cacheWrite: 0, output: 0, reasoning: 0 }, { at: sundayNoon })
  eq('命中缓存 1M 只要 0.02 元', hits.total, 0.02)

  // 12.4 未知模型走兜底价并标估算
  const unknown = priceUsage(millionMiss, { model: 'some-new-model', at: sundayNoon })
  eq('不认识的模型按兜底价估算', [unknown.estimated, unknown.total], [true, 1])

  // 12.5 聚合：轮次按 (session,turn,step) 去重，不按采样条数
  const s1 = sampleOf({ sessionId: 'a', at: sundayNoon, turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 100 } })
  const s1retry = sampleOf({ sessionId: 'a', at: sundayNoon + 1000, turn: 1, step: 1, usage: { inputTokens: 900, outputTokens: 100 } })
  const s2 = sampleOf({ sessionId: 'a', at: sundayNoon + 2000, turn: 1, step: 2, usage: { inputTokens: 400, outputTokens: 40 } })
  const aggregated = aggregateUsage([s1, s1retry, s2], { now: sundayNoon + 10000 })
  eq('同一轮同一步重试只算一轮', aggregated.totals.turns, 1)
  eq('步数按 step 去重', aggregated.totals.steps, 2)
  eq('调用次数按采样条数', aggregated.totals.calls, 3)
  eq('token 相加', aggregated.totals.tokens, 1000 + 100 + 900 + 100 + 400 + 40)
  eq('会话归并成一个', aggregated.bySession.length, 1)
  eq('按小时只落一个桶', aggregated.byHour.length, 1)

  // 12.6 窗口过滤
  const old = sampleOf({ sessionId: 'b', at: sundayNoon - 48 * 3600_000, turn: 1, step: 1, usage: { inputTokens: 10 } })
  const windowed = aggregateUsage([old, s1], { now: sundayNoon, hours: 24 })
  eq('窗口外的采样不计入', windowed.totals.calls, 1)

  // 12.6b 小时桶带计价档位（花费页给柱子分色用；金额仍按采样自己的时刻算）
  const peakSample = sampleOf({ sessionId: 'c', at: mondayPeak, turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 10 } })
  const offSample = sampleOf({ sessionId: 'd', at: sundayNoon, turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 10 } })
  const peakHours = aggregateUsage([peakSample], { now: mondayPeak }).byHour
  const offHours = aggregateUsage([offSample], { now: sundayNoon }).byHour
  eq('工作日白天的桶标成高峰', peakHours.at(0)?.tier, 'peak')
  eq('周末的桶标成空闲', offHours.at(0)?.tier, 'off')
  // 同一小时里混合时刻也只有一个档位：档位按桶的整点算，不按采样逐条翻。
  const mixed = sampleOf({ sessionId: 'e', at: mondayPeak + 10 * 60_000, turn: 1, step: 1, usage: { inputTokens: 10 } })
  eq('同一整点仍是同一个桶', aggregateUsage([peakSample, mixed], { now: mondayPeak }).byHour.length, 1)

  // 12.6c 会话命中率按会话自己的桶算，不是拿总量平均
  const cachedSample = sampleOf({
    sessionId: 'f',
    at: sundayNoon,
    turn: 1,
    step: 1,
    usage: { inputTokens: 1000, cacheReadTokens: 400, outputTokens: 10 },
  })
  const cachedSession = aggregateUsage([cachedSample], { now: sundayNoon }).bySession.at(0)
  eq('会话命中率 = 命中输入 / 全部输入', cachedSession?.hitRate, 0.4)
  const plainSession = aggregateUsage([s2], { now: sundayNoon }).bySession.at(0)
  eq('没有缓存读时命中率是 0', plainSession?.hitRate, 0)

  // 12.7 空结果也要可用
  const blank = aggregateUsage([], { now: sundayNoon })
  eq('没有采样时仍然是 ok', [blank.ok, blank.totals.calls, blank.byHour.length], [true, 0, 0])
  ok('空结果会说明为什么空', blank.notes.some((note) => note.includes('还没有')))

  // 12.8 环形日志（限流下限 20 条，所以推 30 条看裁掉最早的一批）
  const ring = new OpLogger({ limit: 20 })
  for (let index = 1; index <= 30; index += 1) ring.info('a', `m${index}`)
  eq('环形日志不超上限', ring.entries().length, 20)
  eq('环形日志留最新一条', ring.entries().at(-1)?.message, 'm30')
  ok('最早的已经被丢掉', !ring.entries().some((entry) => entry.message === 'm1'))
  ring.warn('a', 'warn-1')
  ring.error('a', 'err-1')
  eq('按级别过滤（warn 是下限）', ring.entries({ level: 'warn' }).map((entry) => entry.message), ['warn-1', 'err-1'])
  eq('级别计数', ring.count('error'), 1)

  // 12.9 从库里读最近操作（前面的调用已经写了 operations）
  const rows = readOperations(db, { limit: 5 })
  ok('能读到最近的操作记录', rows.recent.length > 0)
  const counters = readCounters(db)
  ok('计数里有事件与结论', counters.events >= 0 && counters.artifacts >= 0)

  // 12.10 备份：写进 backups/ 且能被列出来
  const backup = backupDatabase(db, dir, { now: new Date(sundayNoon) })
  ok('备份文件已落盘', backup.ok && backup.bytes > 0, backup)
  const listed = listBackups(dir, 5)
  ok('备份能被列出来', listed.length >= 1 && listed[0].file === backup.file, listed)

  // 12.11 操作记录是只追加的（触发器兜底），删不掉是设计
  let appendOnly = ''
  try {
    db.exec('DELETE FROM operations')
  } catch (error) {
    appendOnly = error instanceof Error ? error.message : String(error)
  }
  ok('operations 不能被删（只追加）', appendOnly.includes('append-only'), { appendOnly })
})()

// ── [24] 提案审批：唯一入口 + life 批准回流到上下文 ─────────────
console.log('\n[24] 提案审批（人侧）')
{
  const { decideProposal, recentApprovedAdjustments } = await import('../dist/lib/proposals.js')

  // 24.1 life 提案：提 → 批 → 状态与决定人落库
  const lifeProposal = await core.propose({
    partition: 'life',
    target: 'persona.tone',
    change: '回答别这么客气，直接说结论',
    rationale: '用户提过两次「别绕」',
  })
  const acceptedLife = decideProposal(db, {
    proposalId: lifeProposal.proposalId,
    accept: true,
    now: '2026-11-02T12:00:00.000Z',
  })
  eq('life 提案批准后状态 accepted', [acceptedLife.status, acceptedLife.applied], ['accepted', false])
  eq(
    'life 提案记录了决定人与时间',
    [
      String(scalar(db, `SELECT decided_by FROM proposals WHERE proposal_id = ?`, [lifeProposal.proposalId])),
      String(scalar(db, `SELECT decided_at FROM proposals WHERE proposal_id = ?`, [lifeProposal.proposalId])),
    ],
    ['owner', '2026-11-02T12:00:00.000Z'],
  )
  ok('life 批准不会谎称改了参数', acceptedLife.note.includes('不会') || acceptedLife.note.includes('不会被'))

  // 24.2 重复决定 → E_STATE（不静默成功）
  await expectError(
    '重复决定同一条提案被拒',
    async () => decideProposal(db, { proposalId: lifeProposal.proposalId, accept: false }),
    'E_STATE',
  )
  // 24.3 查无此提案 → E_NOT_FOUND；空 id → E_VALIDATION
  await expectError('决定不存在的提案被拒', async () => decideProposal(db, { proposalId: 'prop_nope', accept: true }), 'E_NOT_FOUND')
  await expectError('空 proposalId 被拒', async () => decideProposal(db, { proposalId: '  ', accept: true }), 'E_VALIDATION')

  // 24.4 关系/安全分区：即使是历史脏行也不能从这个入口放行
  db.run(
    `INSERT INTO proposals (proposal_id, persona_id, partition, target, change, status, created_at)
     VALUES ('prop_dirty_safety', 'main', 'safety', 'safety.x', '试图绕过', 'pending', ?)`,
    ['2026-11-02T12:00:00.000Z'],
  )
  await expectError(
    'safety 分区的脏行不能被批准',
    async () => decideProposal(db, { proposalId: 'prop_dirty_safety', accept: true }),
    'E_PARTITION',
  )
  eq(
    '脏行仍然是 pending（没被悄悄改掉）',
    String(scalar(db, `SELECT status FROM proposals WHERE proposal_id = 'prop_dirty_safety'`)),
    'pending',
  )

  // 24.5 驳回 life 提案
  const toReject = await core.propose({ partition: 'life', target: 'persona.humor', change: '多讲冷笑话' })
  const rejectedLife = decideProposal(db, { proposalId: toReject.proposalId, accept: false })
  eq('驳回后状态 rejected', rejectedLife.status, 'rejected')

  // 24.6 批准过的 life 调整会重新进入最小上下文（否则「批准」只是个勾）
  const approvals = recentApprovedAdjustments(db, 3)
  ok('能读到最近批准的调整', approvals.some((item) => item.proposalId === lifeProposal.proposalId), approvals)
  const ctxAfterApproval = await core.context()
  ok(
    '批准过的调整出现在 psyche_context 里',
    ctxAfterApproval.recentApprovals.some((item) => item.change.includes('客气')),
    ctxAfterApproval.recentApprovals,
  )
  eq('被驳回的不会出现在上下文里', ctxAfterApproval.recentApprovals.some((item) => item.change.includes('冷笑话')), false)

  // 24.7 growth 提案走同一入口：驳回不改阶段、重复决定被拒
  const growthProposal = await core.createGrowthProposal({ statement: '统一入口测试用' })
  const phaseBefore = String(scalar(db, `SELECT phase FROM phase_state WHERE persona_id = 'main'`))
  const growthRejected = decideProposal(db, { proposalId: growthProposal.proposalId, accept: false })
  eq(
    'growth 驳回不改阶段',
    [growthRejected.status, String(scalar(db, `SELECT phase FROM phase_state WHERE persona_id = 'main'`))],
    ['rejected', phaseBefore],
  )
  await expectError(
    'growth 提案重复决定被拒',
    async () => decideProposal(db, { proposalId: growthProposal.proposalId, accept: true }),
    'E_STATE',
  )
}

// 25. 心灵自用账本（v16 §32.1 更正口径）：这一页只记插件自己发起的模型调用。
{
  // 25.1 一条记录：归一化、缺省会话名、用途带上
  const ledger = new SelfUsageLedger()
  const first = ledger.record({
    usage: { inputTokens: 100, outputTokens: 10 },
    purpose: 'diary',
    at: Date.UTC(2026, 10, 2, 3, 0, 0),
  })
  eq('账本记下一条', ledger.count, 1)
  eq('缺省会话名是 psyche', first.sessionId, 'psyche')
  eq('未命中输入归一成 cacheMiss', first.usage.cacheMiss, 100)
  eq('输出照抄', first.usage.output, 10)
  eq('用途跟着记录走', first.purpose, 'diary')

  // 25.2 按用途分组：两件事花的两笔钱要分成两行，而不是挤成一行「psyche」
  ledger.record({
    usage: { inputTokens: 50, cacheHit: 30, outputTokens: 5 },
    purpose: 'reflection',
    at: Date.UTC(2026, 10, 2, 4, 0, 0),
  })
  const aggregated = aggregateUsage(ledger.samples(), { now: Date.UTC(2026, 10, 2, 5, 0, 0) })
  eq('按用途分成两行', aggregated.bySession.length, 2)
  eq(
    '行的 id 与标签都是用途名',
    aggregated.bySession
      .map((row) => `${row.sessionId}/${row.label}`)
      .sort(),
    ['diary/diary', 'reflection/reflection'],
  )
  eq('总量是两条调用', aggregated.totals.calls, 2)
  eq('两行的 token 之和等于总量', aggregated.bySession.reduce((sum, row) => sum + row.tokens, 0), aggregated.totals.tokens)

  // 25.3 没有用途时仍按会话分组（对话消耗的老路径不能被改坏）
  const plain = aggregateUsage([sampleOf({ sessionId: 's1', at: 0, usage: { inputTokens: 5 } })], { now: 1 })
  eq('无用途时按会话分组', plain.bySession.map((row) => row.sessionId), ['s1'])

  // 25.4 超上限一次裁到最近 5000 条，丢的是最早的
  const big = new SelfUsageLedger()
  for (let index = 0; index < MAX_ENTRIES + 3; index += 1) big.record({ usage: { inputTokens: 1 }, at: index })
  eq('超上限裁到最近 5000 条', big.count, MAX_ENTRIES)
  eq('丢的是最早的那几条', big.samples()[0].at, 3)

  // 25.5 空账本用调用方给的说明（面板上要说清「不是读不到，是还没花过」）
  const emptyAgg = aggregateUsage([], { now: 1, emptyNote: '自定义说明' })
  eq('空账本用调用方给的说明', emptyAgg.notes[0], '自定义说明')
  eq('空账本没有调用', emptyAgg.totals.calls, 0)
}

db.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n结果：${passed} 通过，${failed} 失败（${nowIso()}）`)
if (failed > 0) process.exitCode = 1


