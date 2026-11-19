// R6 记忆按钮前置：schema v13（派生统计可刷新）+ Core.appendEvidence。
//
// 跑法：node test/append-evidence.ts（需要先 npm run build）
//
// 覆盖：
// 1. v13 触发器：语义字段 UPDATE 仍被拒，派生统计列可刷新；
// 2. appendEvidence 正常追加、计数刷新；
// 3. 重复来源幂等、计数不重复；
// 4. 同活动窗口两条来源只算一份独立证据；不同窗口算两份；
// 5. 归属/披露/状态/来源域/隔离来源的拒绝；
// 6. opId 幂等与冲突；
// 7. 失败回滚（不落半截证据）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'

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

async function rejects(label, promise, matcher) {
  try {
    await promise
    ok(label, false, { reason: '没有抛错' })
  } catch (error) {
    const text = `${error?.code ?? error?.name ?? ''}: ${error?.message ?? String(error)}`
    ok(label, matcher.test(text), { text })
  }
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-append-evidence-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const capture = (text, sessionRef, extra = {}) =>
  core.capture({
    platform: 'desktop',
    channel: 'desktop',
    stableUserId: 'owner-append-evidence',
    origin: 'user',
    kind: 'message',
    text,
    sessionRef,
    ...extra,
  })

console.log('\n[R6-append-evidence] schema v13 + Core.appendEvidence')

// ── 1. v13 触发器：语义字段仍不可变、派生列可刷新 ─────────────────────────
const first = await capture('用户喜欢喝乌龙茶。', 'ae-1')
const contactId = db.all(`SELECT contact_id FROM contacts WHERE platform = 'desktop' LIMIT 1`)[0].contact_id
const fact = await core.remember({
  text: '用户喜欢喝乌龙茶。',
  kind: 'fact',
  statement: '用户喜欢喝乌龙茶。',
  sourceIds: first.sourceId,
  // 按钮服务层必须显式把结论绑到当前 Contact；否则结论是全局的，appendEvidence 会拒绝。
  subjectRefs: [contactId],
  confidence: 'medium',
})
const artifactId = fact.artifactId
ok('fact 落出结论', Boolean(artifactId), fact)
eq('结论归属到桌面联系人', db.all(`SELECT subject_refs FROM artifact_revisions WHERE artifact_id = ?`, [artifactId])[0].subject_refs, JSON.stringify([contactId]))

eq('v31 user_version', db.all('PRAGMA user_version')[0].user_version, 31)
await rejects(
  '语义字段 UPDATE 仍被拒绝（statement）',
  Promise.resolve().then(() => db.run(`UPDATE artifact_revisions SET statement = '改掉' WHERE artifact_id = ?`, [artifactId])),
  /immutable/,
)
await rejects(
  '披露字段 UPDATE 仍被拒绝',
  Promise.resolve().then(() =>
    db.run(`UPDATE artifact_revisions SET disclosure = 'public' WHERE artifact_id = ?`, [artifactId]),
  ),
  /immutable/,
)
await rejects(
  '状态字段 UPDATE 仍被拒绝',
  Promise.resolve().then(() =>
    db.run(`UPDATE artifact_revisions SET state = 'superseded' WHERE artifact_id = ?`, [artifactId]),
  ),
  /immutable/,
)
db.run(`UPDATE artifact_revisions SET basis_count = 9, independent_evidence_count = 4 WHERE artifact_id = ?`, [artifactId])
eq(
  '派生统计列可以刷新（v13 放开）',
  db.all(`SELECT basis_count, independent_evidence_count FROM artifact_revisions WHERE artifact_id = ?`, [artifactId])[0],
  { basis_count: 9, independent_evidence_count: 4 },
)
// 还原，避免影响后续断言
db.run(`UPDATE artifact_revisions SET basis_count = 1, independent_evidence_count = 1 WHERE artifact_id = ?`, [artifactId])

// ── 2. 正常追加：一条新来源 + 计数刷新 ────────────────────────────────────
const second = await capture('用户喜欢喝乌龙茶。', 'ae-2')
const appended = await core.appendEvidence(artifactId, { sourceIds: second.sourceId }, { contactId })
eq('追加返回 revision=1', appended.revision, 1)
eq('新增一条证据', appended.added, 1)
eq('basis_count 变为 2', appended.basisCount, 2)
eq('独立证据数变为 2（不同活动窗口）', appended.independentEvidenceCount, 2)
eq(
  '库里的派生列同步刷新',
  db.all(`SELECT basis_count, independent_evidence_count FROM artifact_revisions WHERE artifact_id = ?`, [artifactId])[0],
  { basis_count: 2, independent_evidence_count: 2 },
)
eq(
  '证据明细两条',
  db.all(`SELECT COUNT(*) AS n FROM artifact_evidence WHERE artifact_id = ?`, [artifactId])[0].n,
  2,
)

// ── 3. 重复来源：幂等，计数不变 ──────────────────────────────────────────
const again = await core.appendEvidence(artifactId, { sourceIds: second.sourceId }, { contactId })
eq('重复追加 added=0', again.added, 0)
eq('重复追加计数不变', [again.basisCount, again.independentEvidenceCount], [2, 2])

// ── 4. 同活动窗口：两条来源只算一份独立证据 ──────────────────────────────
const windowFact = await core.remember({
  text: '用户周二下午在图书馆。',
  kind: 'fact',
  statement: '用户周二下午在图书馆。',
  sourceIds: (await capture('用户周二下午在图书馆。', 'ae-3')).sourceId,
  subjectRefs: [contactId],
  confidence: 'medium',
})
const sameWindowA = await capture('第一句话。', 'ae-same-window')
const sameWindowB = await capture('第二句话。', 'ae-same-window')
const afterSameWindow = await core.appendEvidence(
  windowFact.artifactId,
  { sourceIds: [sameWindowA.sourceId, sameWindowB.sourceId] },
  { contactId },
)
eq('同窗口两条来源只算一份独立证据', afterSameWindow.independentEvidenceCount, 2)
eq('basis 仍按行数累加', afterSameWindow.basisCount, 3)

// ── 5. 拒绝：归属 / 披露 / 状态 / 来源域 / 隔离 / 缺失 ───────────────────
await rejects(
  '无 Contact 时不允许追加',
  core.appendEvidence(artifactId, { sourceIds: second.sourceId }, {}),
  /当前联系人/,
)
await rejects(
  '别的 Contact 不允许追加',
  core.appendEvidence(artifactId, { sourceIds: second.sourceId }, { contactId: 'ct_other' }),
  /当前联系人/,
)

const publicFact = await core.remember({
  text: '公开的结论。',
  kind: 'fact',
  statement: '公开的结论。',
  sourceIds: (await capture('公开的结论。', 'ae-public')).sourceId,
  disclosure: 'public',
})
await rejects(
  '公开记忆不允许追加证据',
  core.appendEvidence(publicFact.artifactId, { sourceIds: second.sourceId }, { contactId }),
  /restricted/,
)

const retracted = await core.revise({
  artifactId: windowFact.artifactId,
  state: 'forgotten',
  statement: '用户周二下午在图书馆。',
  reason: '测试忘记',
  refs: ['append-evidence 测试'],
})
await rejects(
  'retracted 状态不允许追加',
  core.appendEvidence(windowFact.artifactId, { sourceIds: second.sourceId }, { contactId }),
  /不能追加证据/,
)

const groupSource = await core.capture({
  platform: 'qq',
  channel: 'group',
  externalRoomId: 'ae-room',
  stableUserId: '30001',
  origin: 'user',
  kind: 'message',
  text: '群里说的话。',
  sessionRef: 'ae-group',
})
await rejects(
  '群来源不能作为私聊结论证据',
  core.appendEvidence(artifactId, { sourceIds: groupSource.sourceId }, { contactId }),
  /群来源/,
)

// 来源必须属于当前 Contact 的私有来源域：光查「存在、未隔离、非群来源」不够，
// 否则 A 的结论可以被 B 的私人 Source 追加证据，B 的内容就进了 A 的记忆。
db.run(
  `INSERT OR IGNORE INTO contacts (contact_id, persona_id, platform, stable_user_id, display_name, created_at, updated_at)
   VALUES ('ct_other_person', 'main', 'qq', 'password-other', NULL, ?, ?)`,
  [new Date().toISOString(), new Date().toISOString()],
)
const otherPersonSource = await core.capture({
  platform: 'qq',
  channel: 'private',
  stableUserId: 'password-other',
  senderContactId: 'ct_other_person',
  origin: 'user',
  kind: 'message',
  text: '这是别人的私聊内容。',
  sessionRef: 'ae-other-private',
})
await rejects(
  '别的 Contact 的私人来源不能当证据',
  core.appendEvidence(artifactId, { sourceIds: otherPersonSource.sourceId }, { contactId }),
  /不属于当前联系人/,
)

const unownedSource = await core.capture({
  platform: 'desktop',
  channel: 'desktop',
  stableUserId: 'owner-append-evidence',
  origin: 'user',
  kind: 'message',
  text: '没有归属的桌面来源。',
  sessionRef: 'ae-unowned',
})
// capture 会给桌面来源解析出 Contact，这里手工造一条 sender_contact_id 为空的
// 历史 Source（R6-CAP-2 之前的库、或外部导入的旧行），验证 unknown 域会被拒绝。
db.run(
  `INSERT OR IGNORE INTO sources
     (source_id, persona_id, platform, channel, session_ref, sender_contact_id, mentions,
      quoted_source_refs, origin, kind, text, metadata, captured_at, created_at)
   VALUES ('src_ae_unowned', 'main', 'desktop', 'desktop', 'ae-unowned-null', NULL, '[]',
           '[]', 'user', 'message', '没有归属的桌面来源。', '{}', ?, ?)`,
  [new Date().toISOString(), new Date().toISOString()],
)
await rejects(
  '没有归属（unknown）的来源不能当证据',
  core.appendEvidence(artifactId, { sourceIds: 'src_ae_unowned' }, { contactId }),
  /不属于当前联系人/,
)
void unownedSource

// 共享结论（subject_refs 同时含当前 Contact 和别的 Contact）不通过按钮追加。
const shared = await core.remember({
  text: '共享归属的结论。',
  kind: 'fact',
  statement: '共享归属的结论。',
  sourceIds: (await capture('共享归属的结论。', 'ae-shared')).sourceId,
  subjectRefs: [contactId, 'ct_other_person'],
})
await rejects(
  '共享归属的结论不能通过按钮追加证据',
  core.appendEvidence(shared.artifactId, { sourceIds: second.sourceId }, { contactId }),
  /共享归属/,
)

const quarantinedSource = await capture('会被隔离的来源。', 'ae-quarantine')
db.run(`INSERT OR IGNORE INTO quarantined_sources (source_id, reason, quarantined_at) VALUES (?, 'runtime-injection', ?)`, [
  quarantinedSource.sourceId,
  new Date().toISOString(),
])
await rejects(
  '被隔离来源不能作为证据',
  core.appendEvidence(artifactId, { sourceIds: quarantinedSource.sourceId }, { contactId }),
  /已被隔离/,
)
await rejects(
  '缺失来源不能作为证据',
  core.appendEvidence(artifactId, { sourceIds: 'src_missing_ae' }, { contactId }),
  /E_NO_SOURCE|E_NOT_FOUND|找不到|不存在/,
)

// ── 6. opId 幂等与冲突 ───────────────────────────────────────────────────
const idemSource = await capture('幂等来源。', 'ae-idem')
const idemArgs = { sourceIds: idemSource.sourceId, opId: 'btn:ae:1' }
const idemFirst = await core.appendEvidence(artifactId, idemArgs, { contactId })
const idemSecond = await core.appendEvidence(artifactId, idemArgs, { contactId })
eq('同 opId 重放 replayed=true', idemSecond.replayed, true)
// 重放返回的是首次结果（added=1），关键是库里不会再多一行。
eq('重放返回首次结果', idemSecond.added, idemFirst.added)
eq(
  '重放没有新增证据行',
  Number((db.all<{ n: number }>('SELECT COUNT(*) AS n FROM artifact_evidence WHERE artifact_id = ?', artifactId)[0] ?? { n: -1 }).n),
  3,
)
eq('重放与首次结果一致', idemSecond.basisCount, idemFirst.basisCount)
await rejects(
  '同 opId 换内容报冲突',
  core.appendEvidence(artifactId, { sourceIds: idemSource.sourceId, opId: 'btn:ae:1', relation: 'contextualizes' }, { contactId }),
  /E_IDEMPOTENT_CONFLICT/,
)

// ── 7. 失败回滚：UPDATE 派生列抛错时证据不落库 ───────────────────────────
const rollbackSource = await capture('回滚来源。', 'ae-rollback')
const beforeRows = db.all(`SELECT COUNT(*) AS n FROM artifact_evidence WHERE artifact_id = ?`, [artifactId])[0].n
// 直接制造失败：appendEvidence 刷新派生统计时撞上触发器
db.exec(`CREATE TRIGGER trg_ae_force_boom BEFORE UPDATE OF basis_count ON artifact_revisions
         BEGIN SELECT RAISE(ABORT, 'ae boom'); END;`)
await rejects(
  '派生列刷新失败时整笔回滚',
  core.appendEvidence(artifactId, { sourceIds: rollbackSource.sourceId }, { contactId }),
  /ae boom/,
)
eq(
  '失败后证据行没有半截写入',
  db.all(`SELECT COUNT(*) AS n FROM artifact_evidence WHERE artifact_id = ?`, [artifactId])[0].n,
  beforeRows,
)
db.exec(`DROP TRIGGER IF EXISTS trg_ae_force_boom`)

console.log(`\n[R6-append-evidence] ${passed} 通过 ${failed} 失败`)
opened.db.close()
rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
