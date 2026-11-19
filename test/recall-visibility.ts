// P2-Recall R3.1：Channel / Group Scope（来源域交集）测试。
//
// 验收口径（用户冻结 R3.1-01～06）：
// - 一个 Artifact 的可见范围由它全部有效 Evidence 的来源域共同决定，多来源取最严交集；
// - desktop/web/system → personal；private → 该 Contact；group → 该 Room；
// - 只有真正无 Evidence 才归 global；Evidence 存在但 Source 丢失 → 拒绝；
// - 多来源不同域 → mixed，普通 Recall 不可见；
// - Channel/Group 在共享 SQL 的 LIMIT 前完成，Composer 不再独立判定。
//
// 跑法：node test/recall-visibility.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { recallMemory, resolveRoomId } from '../dist/lib/recall.js'
import { searchFts } from '../dist/lib/fts.js'
import { composeInjection } from '../dist/lib/composer.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-visibility-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

console.log('\n[P2-Recall R3.1] Channel / Group Scope（来源域交集）')

const ROOM = 'rr_qq_8888'
const now = new Date().toISOString()
db.run(
  `INSERT INTO rooms (room_id, persona_id, platform, channel, external_room_id, title, capture_mode, active, created_at, updated_at)
   VALUES (?, 'main', 'qq', 'group', '8888', '测试群', 'mentioned_only', 1, ?, ?)`,
  [ROOM, now, now],
)
for (const contactId of ['ct_alice', 'ct_bob']) {
  db.run(
    `INSERT INTO contacts (contact_id, persona_id, platform, stable_user_id, created_at, updated_at)
     VALUES (?, 'main', 'qq', ?, ?, ?)`,
    [contactId, contactId, now, now],
  )
}

let seq = 0
async function capture(text: string, channel: string, extra: Record<string, unknown> = {}): Promise<string> {
  seq += 1
  const captured = await core.capture({
    platform: 'qq',
    channel,
    sessionRef: `vis-s${seq}`,
    origin: 'user',
    kind: 'message',
    text,
    ...extra,
  })
  return captured.sourceId
}

async function remember(text: string, sourceIds: string[], subjectRefs?: string[]): Promise<string> {
  const result = await core.remember({
    text,
    kind: 'fact',
    statement: text,
    sourceIds,
    disclosure: 'public',
    ...(subjectRefs === undefined ? {} : { subjectRefs }),
  })
  if (!result.artifactId) throw new Error(`未升格：${JSON.stringify(result)}`)
  return result.artifactId
}

// ── 夹具 ────────────────────────────────────────────────────────────────
const personalId = await remember('桌上的蓝色杯子', [
  await capture('桌上的蓝色杯子', 'desktop'),
  await capture('桌上的蓝色杯子（补充）', 'desktop'),
])

const alicePrivId = await remember('周五和 Alice 去看了展', [
  await capture('周五和 Alice 去看了展', 'private', { senderContactId: 'ct_alice' }),
  await capture('周五和 Alice 去看了展（补充）', 'private', { senderContactId: 'ct_alice' }),
], ['ct_alice'])

const bobPrivId = await remember('Bob 喜欢城东的山', [
  await capture('Bob 喜欢城东的山', 'private', { senderContactId: 'ct_bob' }),
  await capture('Bob 喜欢城东的山（补充）', 'private', { senderContactId: 'ct_bob' }),
], ['ct_bob'])

const groupId = await remember('群里约了周六露营', [
  await capture('群里约了周六露营', 'group', { roomId: ROOM }),
  await capture('群里约了周六露营（补充）', 'group', { roomId: ROOM }),
])

const mixedId = await remember('跨渠道整理的旅行清单', [
  await capture('跨渠道整理的旅行清单', 'private', { senderContactId: 'ct_alice' }),
  await capture('跨渠道整理的旅行清单（群里补充）', 'group', { roomId: ROOM }),
], ['ct_alice'])

const noEvidenceId = await remember('没有任何来源的种子结论', [
  await capture('没有任何来源的种子结论', 'desktop'),
  await capture('没有任何来源的种子结论（补充）', 'desktop'),
])
db.run('DELETE FROM artifact_evidence WHERE artifact_id = ?', [noEvidenceId])

const lostSourceId = await remember('来源已经丢失的结论', [
  await capture('来源已经丢失的结论', 'desktop'),
  await capture('来源已经丢失的结论（补充）', 'desktop'),
])
// evidence 行不可变（触发器拦 UPDATE），只能关外键插一条指向不存在 source 的坏行，
// 模拟「数据关联异常」：这条结论必须被拒绝，不能因为坏行解析失败就退回 global。
db.run('PRAGMA foreign_keys = OFF')
db.run(
  `INSERT INTO artifact_evidence (artifact_id, revision, source_id, relation, independence_key, created_at)
   VALUES (?, 1, 'src_missing', 'supports', 'ik_lost_source', ?)`,
  [lostSourceId, now],
)
db.run('PRAGMA foreign_keys = ON')

const ids = (rows: { artifactId: string }[]): string[] => rows.map((row) => row.artifactId)

// ── 1. 群号解析 ─────────────────────────────────────────────────────────
eq('群号解析到稳定 room_id', resolveRoomId(db, 'qq', '8888'), ROOM)
eq('未知群号解析为空', resolveRoomId(db, 'qq', '9999'), null)
eq('缺平台不解析', resolveRoomId(db, null, '8888'), null)

// ── 2. personal 域 ──────────────────────────────────────────────────────
const personalWithIdentity = recallMemory(db, { text: '蓝色杯子' }, { contactId: 'ct_alice', surface: 'personal' })
ok('personal 记忆在个人表面可见', ids(personalWithIdentity.items).includes(personalId))

const personalWithoutIdentity = recallMemory(db, { text: '蓝色杯子' }, {})
ok('personal 记忆在无身份时不可见', !ids(personalWithoutIdentity.items).includes(personalId))

const personalExplicitlyOff = recallMemory(db, { text: '蓝色杯子' }, { contactId: 'ct_alice', surface: 'personal', allowPersonal: false })
ok('显式关闭 personal 后不可见', !ids(personalExplicitlyOff.items).includes(personalId))

const personalInPrivate = recallMemory(db, { text: '蓝色杯子' }, { contactId: 'ct_alice', surface: 'private' })
ok('QQ 私聊看不到个人域记忆', !ids(personalInPrivate.items).includes(personalId))

// ── 3. private 域 ───────────────────────────────────────────────────────
const aliceSeesOwn = recallMemory(db, { text: '周五' }, { contactId: 'ct_alice' })
ok('Alice 能看到自己的私聊记忆', ids(aliceSeesOwn.items).includes(alicePrivId))

const bobCannotSeeAlice = recallMemory(db, { text: '周五' }, { contactId: 'ct_bob' })
ok('Bob 看不到 Alice 的私聊记忆', !ids(bobCannotSeeAlice.items).includes(alicePrivId))

const aliceCannotSeeBob = recallMemory(db, { text: '城东 山' }, { contactId: 'ct_alice' })
ok('Alice 看不到 Bob 的私聊记忆', !ids(aliceCannotSeeBob.items).includes(bobPrivId))

const noIdentityPrivate = recallMemory(db, { text: '周五' }, {})
ok('无身份看不到私聊记忆', !ids(noIdentityPrivate.items).includes(alicePrivId))

// ── 4. group 域 ─────────────────────────────────────────────────────────
const inRoom = recallMemory(db, { text: '周六 露营' }, { contactId: 'ct_alice', platform: 'qq', groupId: '8888' })
ok('群记忆在解析出的 Room 内可见', ids(inRoom.items).includes(groupId))

const otherRoom = recallMemory(db, { text: '周六 露营' }, { contactId: 'ct_alice', platform: 'qq', groupId: '9999' })
ok('群记忆在别的群不可见', !ids(otherRoom.items).includes(groupId))

const noGroupId = recallMemory(db, { text: '周六 露营' }, { contactId: 'ct_alice' })
ok('没有群身份时群记忆不可见', !ids(noGroupId.items).includes(groupId))

// 群聊里发送者也有 contactId，但这只说明「谁在说话」，不代表他的私聊记忆可以进群。
const alicePrivateInGroup = recallMemory(db, { text: '周五' }, {
  contactId: 'ct_alice',
  platform: 'qq',
  groupId: '8888',
})
ok('群聊不因发送者 contactId 召回其私聊记忆', !ids(alicePrivateInGroup.items).includes(alicePrivId))
ok('群聊中 personal 记忆也不可见', !ids(alicePrivateInGroup.items).includes(personalId))

const personalSeesOwnPrivate = recallMemory(db, { text: '周五' }, { contactId: 'ct_alice', surface: 'personal' })
ok('个人表面可看到自己的私聊记忆', ids(personalSeesOwnPrivate.items).includes(alicePrivId))

// ── 5. 混合来源取交集 ───────────────────────────────────────────────────
const mixedInPrivate = recallMemory(db, { text: '旅行清单' }, { contactId: 'ct_alice' })
ok('混合来源在私聊不可见', !ids(mixedInPrivate.items).includes(mixedId))

const mixedInRoom = recallMemory(db, { text: '旅行清单' }, { contactId: 'ct_alice', platform: 'qq', groupId: '8888' })
ok('混合来源在群里也不可见', !ids(mixedInRoom.items).includes(mixedId))

// ── 6. 无 Evidence 才是 global ──────────────────────────────────────────
const globalNoIdentity = recallMemory(db, { text: '种子结论' }, {})
ok('无 Evidence 的结论在无身份时可见（global）', ids(globalNoIdentity.items).includes(noEvidenceId))

const globalWithIdentity = recallMemory(db, { text: '种子结论' }, { contactId: 'ct_alice' })
ok('无 Evidence 的结论在有身份时也可见', ids(globalWithIdentity.items).includes(noEvidenceId))

const lost = recallMemory(db, { text: '来源已经丢失' }, { contactId: 'ct_alice' })
ok('Source 丢失的结论被拒绝，不扩大为 global', !ids(lost.items).includes(lostSourceId))

// ── 7. 主动 Recall 与自动注入同源 ───────────────────────────────────────
const active = recallMemory(db, { text: '周末 露营' }, { contactId: 'ct_alice', platform: 'qq', groupId: '8888' })
const direct = searchFts(db, '周末 露营', {
  limit: 24,
  scope: { contactId: 'ct_alice', roomId: ROOM, surface: 'group' },
})
eq('主动 Recall 与 searchFts 的可见集合一致', ids(active.items).sort(), ids(direct).sort())

// ── 8. Composer 不再独立判定 Channel ───────────────────────────────────
const composed = composeInjection(
  db,
  [{ artifactId: personalId, revision: 1 }],
  { contactId: 'ct_alice', channel: 'qq' },
  {},
)
ok('Composer 不再因为 channel 不同拒绝（可见性由 Recall Engine 负责）', composed.items.length === 1)
eq('Composer 不泄露 channel', composed.stats.disclosureLeaked, 0)

// ── H21：Subject 不是来源域；提问者与结论 Subject 不同 ────────────────────
for (const contactId of ['ct_a', 'ct_aa']) {
  db.run(`INSERT INTO contacts(contact_id,persona_id,platform,stable_user_id,created_at,updated_at)
    VALUES(?,'main','qq',?,?,?)`, [contactId, contactId, now, now])
}
const memberSource = (text: string, domain: string) => capture(text, domain === 'private' ? 'private' : 'group', {
  senderContactId: 'ct_a', ...(domain === 'private' || domain === 'missing-room' ? {} : { externalRoomId: domain }),
})
const cases: Array<{ label: string; id: string; a: boolean; b: boolean; private: boolean }> = []
async function memberFact(label: string, domains: string[], allowed: [boolean, boolean, boolean], subject = 'ct_a') {
  const text = `H21VIS 槿 ${label}`, sources: string[] = []
  for (const domain of domains) sources.push(await memberSource(text + ' 独立来源' + sources.length, domain))
  const id = await remember(text, sources, [subject])
  cases.push({ label, id, a: allowed[0], b: allowed[1], private: allowed[2] })
  return id
}
const memberA = await memberFact('room-a', ['8888', '8888'], [true, false, false])
await memberFact('room-b', ['9999', '9999'], [false, true, false])
await memberFact('private-a', ['private', 'private'], [false, false, true])
await memberFact('mixed-ab', ['8888', '9999'], [false, false, false])
await memberFact('mixed-ap', ['8888', 'private'], [false, false, false])
const memberNoEvidence = await memberFact('no-evidence', ['8888', '8888'], [false, false, true])
db.run('DELETE FROM artifact_evidence WHERE artifact_id=?', [memberNoEvidence])
const memberMissing = await memberFact('lost-source', ['8888', '8888'], [false, false, false])
db.run('PRAGMA foreign_keys=OFF')
db.run(`INSERT INTO artifact_evidence(artifact_id,revision,source_id,relation,independence_key,created_at)
  VALUES(?,1,'h21_missing','supports','h21_missing',?)`, [memberMissing, now])
db.run('PRAGMA foreign_keys=ON')
await memberFact('null-room', ['missing-room', 'missing-room'], [false, false, false])
const malformed = await memberFact('malformed-json', ['8888', '8888'], [false, false, false])
// Corrupt imported head fixture: append it, keeping the immutable original revision intact.
db.run(`INSERT INTO artifact_revisions(artifact_id,revision,state,statement,subject_refs,disclosure,created_at,updated_at)
  SELECT artifact_id,2,state,statement,'{broken',disclosure,created_at,updated_at FROM artifact_revisions WHERE artifact_id=? AND revision=1`, [malformed])
db.run(`INSERT INTO artifact_evidence(artifact_id,revision,source_id,relation,independence_key,created_at)
  SELECT artifact_id,2,source_id,relation,independence_key,created_at FROM artifact_evidence WHERE artifact_id=? AND revision=1`, [malformed])
const memberAA = await memberFact('exact-aa', ['8888', '8888'], [true, false, false], 'ct_aa')
const roomA = resolveRoomId(db, 'qq', '8888'), roomB = resolveRoomId(db, 'qq', '9999')
ok('H21 capture(externalRoomId) 所有群来源都绑定真实 Room', db.all<{ room_id: string }>(`SELECT s.room_id FROM artifact_evidence e JOIN sources s ON s.source_id=e.source_id WHERE e.artifact_id=?`, [memberA]).every(row => row.room_id === roomA))
for (const [label, scope, key] of [
  ['A群另一位成员', { contactId: 'ct_bob', surface: 'group', roomId: roomA }, 'a'],
  ['B群另一位成员', { contactId: 'ct_bob', surface: 'group', roomId: roomB }, 'b'],
  ['甲私聊', { contactId: 'ct_a', surface: 'private' }, 'private'],
] as const) {
  const textIds = ids(searchFts(db, 'H21VIS', { scope, limit: 50 }))
  const listIds = ids(recallMemory(db, { kind: 'fact', limit: 50 }, scope).items)
  eq(`H21 ${label} 单字 LIKE 与同一矩阵一致`, ids(searchFts(db, '槿', { scope, limit: 50 })).sort(), cases.filter(item => item[key]).map(item => item.id).sort())
  for (const item of cases) {
    eq(`H21 ${label} FTS ${item.label}`, textIds.includes(item.id), item[key])
    eq(`H21 ${label} listHeads ${item.label}`, listIds.includes(item.id), item[key])
  }
}
const roomOnly = { contactId: null, surface: 'group' as const, roomId: roomA }
ok('H21 Room 可信而 Contact 为空仍可读取同群证据', ids(searchFts(db, 'H21VIS', { scope: roomOnly, limit: 50 })).includes(memberA))
ok('H21 同 Subject 的群发送者也不能借无 Evidence 结论放行', !ids(searchFts(db, 'H21VIS', { scope: { ...roomOnly, contactId: 'ct_a' }, limit: 50 })).includes(memberNoEvidence))
eq('H21 显式 Subject ct_a 不匹配 ct_aa', ids(searchFts(db, 'H21VIS', { scope: roomOnly, subject: 'ct_a', limit: 50 })).includes(memberAA), false)
eq('H21 listHeads 显式 Subject ct_a 不匹配 ct_aa', ids(recallMemory(db, { kind: 'fact', subject: 'ct_a', limit: 50 }, roomOnly).items).includes(memberAA), false)
const literalPrefix = await remember('H21LITERAL 字面前缀', [await memberSource('字面前缀1', '8888'), await memberSource('字面前缀2', '8888')], ['ctXa'])
db.run('DELETE FROM artifact_evidence WHERE artifact_id=?', [literalPrefix])
ok('H21 ct_ 的下划线不是 LIKE 通配符', ids(searchFts(db, 'H21LITERAL', { scope: {} })).includes(literalPrefix))

// ── 收尾 ────────────────────────────────────────────────────────────────
db.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n[P2-Recall R3.1] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exit(1)
