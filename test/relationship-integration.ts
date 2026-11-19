// P3-B-4：关系账本的集成验收（模块级 B4-1..B4-4）。
//
// 口径（沿用 docs/design/p3-b-c-test-matrix.md 与 B3 报告）：
// - 同一剧本在「关系关闭」与「关系开启」两份独立库上各跑一遍，只比较结构化结果；
// - 关系写入只属于 P3-B 的表（signals / affinity / affect / affect history）；
//   关系 Artifact 不参与「原模块表」计数，但必须可追溯到 evidence 与 revision；
// - readRelationshipBrief / 投影 / Context Provider 全部只读；
// - 联系人 A/B 的关系事实、Trust、Affect 不得互相串用。
//
// 跑法：node test/relationship-integration.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { applyMoodTurn } from '../dist/lib/mood.js'
import { generateDiary } from '../dist/lib/diary-generation.js'
import { planStanceSynthesis } from '../dist/lib/stance-engine.js'
import { projectRelationshipBrief } from '../packages/core/dist/relationship-projection.js'
import { createRelationshipContextProvider } from '../packages/core/dist/relationship-context.js'

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

const log = { info() {}, debug() {}, warn() {}, error() {} }
const FIXED_NOW = '2026-11-12T04:00:00.000Z'
const HOUR = 60 * 60 * 1000

const RELATIONSHIP_TABLES = new Set([
  'relationship_signals',
  'relationship_affinity_state',
  'contact_affect_state',
  'contact_affect_history',
])

function coreTableCounts(db) {
  const tables = ['sources', 'events', 'recall_runs', 'diaries', 'phase_milestones']
  const counts = {}
  for (const name of tables) counts[name] = Number(db.get(`SELECT COUNT(*) AS n FROM ${name}`)?.n ?? 0)
  counts.artifacts = Number(
    db.get(`SELECT COUNT(*) AS n FROM artifacts WHERE kind <> 'relationship'`)?.n ?? 0,
  )
  return counts
}

function relationshipCounts(db) {
  const counts = {}
  for (const name of RELATIONSHIP_TABLES) counts[name] = Number(db.get(`SELECT COUNT(*) AS n FROM ${name}`)?.n ?? 0)
  return counts
}

function recallKey(payload) {
  return payload.results.map((item) => `${item.artifactId}|${item.revision}|${item.state}|${item.supportEvidenceCount}`)
}

function rowOf(db, sql, params = []) {
  return db.get(sql, params)
}

/** 同一剧本；关系分支只在固定位置多写关系事实。 */
async function script(core, db, withRelationship) {
  const ids = []
  ids.push((await core.capture({
    platform: 'dsh', channel: 'desktop', sessionRef: 'b4-session', origin: 'user', kind: 'message',
    text: '我习惯周五晚上打游戏，喜欢安静一点的环境。',
    at: '2026-11-11T02:00:00.000Z',
  })).sourceId)
  ids.push((await core.capture({
    platform: 'dsh', channel: 'desktop', sessionRef: 'b4-session', origin: 'user', kind: 'message',
    text: '我答应你，下周三之前把那份报告写完。',
    at: '2026-11-12T02:00:00.000Z',
  })).sourceId)
  ids.push((await core.capture({
    platform: 'dsh', channel: 'desktop', sessionRef: 'b4-session', origin: 'user', kind: 'message',
    text: '今天天气不错，随便聊聊。',
  })).sourceId)

  const moodTurn = (turn, text) =>
    applyMoodTurn(db, { sessionRef: 'b4-session', turn, texts: [text], initiator: 'user', now: FIXED_NOW })

  let alice = null
  let bob = null
  if (withRelationship) {
    alice = await core.resolveContact({ platform: 'qq', stableUserId: '10001', displayName: 'Alice' })
    bob = await core.resolveContact({ platform: 'qq', stableUserId: '10002', displayName: 'Bob' })
    await core.recordRelationshipSignal({
      contactId: alice.contactId, signalType: 'commitment_kept', polarity: 'positive',
      evidenceRefs: [ids[1]], independenceKey: 'b4-rel-1', now: FIXED_NOW,
    })
    for (let i = 0; i < 5; i += 1) {
      await core.recordContactAffect({
        contactId: alice.contactId,
        updates: [{ dimension: 'warmth', delta: 10, evidenceRefs: [ids[0]] }],
        now: FIXED_NOW,
      })
    }
    await core.reviewContactTrust({
      contactId: alice.contactId, proposedValue: 55, evidenceRefs: [ids[0], ids[1]],
      decidedBy: 'owner', now: FIXED_NOW,
    })
  }

  await moodTurn(1, '太好了，谢谢你，真的帮了我大忙，我特别开心！')

  const fact = await core.remember({
    text: '用户习惯周五晚上打游戏，喜欢安静的环境。',
    statement: '用户习惯周五晚上打游戏，喜欢安静的环境。',
    kind: 'fact',
    sourceIds: [ids[0]],
  })

  await moodTurn(2, '真是烦死了，怎么又错了，搞不定。')

  const commitment = await core.remember({ text: '用户承诺下周三之前写完报告。', eventType: 'commitment', sourceIds: [ids[1]] })
  const recall1 = await core.recall({ text: '打游戏', limit: 5 })
  const recall2 = await core.recall({ text: '报告 承诺', limit: 5 })
  await moodTurn(3, '今天天气不错，随便聊聊。')

  const growth = await core.syncGrowth()
  const state = await core.getState()
  const diary = await generateDiary(db, {
    scope: {}, date: '2026-11-12', timezone: 'Asia/Shanghai', now: new Date(FIXED_NOW),
  })
  const stancePlan = planStanceSynthesis({
    beliefs: [
      {
        artifactId: 'art-a', revision: 1, statement: '用户喜欢安静的环境。', state: 'active',
        group: '安静', direction: 'for', confidence: 'medium', updatedAt: FIXED_NOW,
        evidenceKeys: ['s1'], sessionRefs: ['b4-session'],
      },
    ],
    existing: null,
  })

  const moodRow = rowOf(db, "SELECT state_version FROM mood_meta WHERE persona_id = 'main'")
  return {
    alice: alice?.contactId ?? null,
    bob: bob?.contactId ?? null,
    ids,
    factId: fact.ok ? fact.payload?.artifactId ?? null : null,
    commitmentId: commitment.ok ? commitment.payload?.artifactId ?? null : null,
    recall1: recallKey(recall1),
    recall2: recallKey(recall2),
    growth: JSON.stringify(growth),
    phase: state.payload?.growth?.phase ?? null,
    diary: JSON.stringify({ created: diary.created, updated: diary.updated, sourceCount: diary.sourceCount, tensionCount: diary.tensionCount }),
    stance: JSON.stringify(stancePlan),
    moodVersion: Number(moodRow?.state_version ?? 0),
    coreCounts: coreTableCounts(db),
    relationshipCounts: relationshipCounts(db),
  }
}

const offDir = mkdtempSync(join(tmpdir(), 'psyche-b4-off-'))
const off = await openDatabase({ file: join(offDir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
migrate(off.db, log)
const coreOff = new Core({ db: off.db, config: {}, logger: log, dataDir: offDir })

const onDir = mkdtempSync(join(tmpdir(), 'psyche-b4-on-'))
const on = await openDatabase({ file: join(onDir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
migrate(on.db, log)
const coreOn = new Core({ db: on.db, config: {}, logger: log, dataDir: onDir })

console.log('\n[P3-B-4-1] 跨模块隔离（Recall / Diary / Stance / Growth / Mood）')
const offResult = await script(coreOff, off.db, false)
const onResult = await script(coreOn, on.db, true)

eq('Recall#1 候选一致', onResult.recall1, offResult.recall1)
eq('Recall#2 候选一致', onResult.recall2, offResult.recall2)
eq('fact Artifact 一致', onResult.factId, offResult.factId)
eq('commitment Artifact 一致', onResult.commitmentId, offResult.commitmentId)
eq('Growth 推进结果一致', onResult.growth, offResult.growth)
eq('Growth 阶段一致', onResult.phase, offResult.phase)
eq('Diary 结构化结果一致', onResult.diary, offResult.diary)
eq('Stance 合成计划一致', onResult.stance, offResult.stance)
eq('Mood state_version 一致', onResult.moodVersion, offResult.moodVersion)
eq('原模块表行数一致', onResult.coreCounts, offResult.coreCounts)
ok('关系开启后才出现关系记录', onResult.relationshipCounts.relationship_signals === 1 && offResult.relationshipCounts.relationship_signals === 0, {
  on: onResult.relationshipCounts,
  off: offResult.relationshipCounts,
})

console.log('\n[P3-B-4-2] 联系人隔离（Trust / Affect / Evidence）')
const aliceId = onResult.alice
const bobId = onResult.bob

const briefA = coreOn.readRelationshipBrief(aliceId, { now: FIXED_NOW })
const briefB = coreOn.readRelationshipBrief(bobId, { now: FIXED_NOW })
eq('A 的 Trust 档位为 medium', briefA.trustBand, 'medium')
const warmthOfA = briefA.affect.find((item) => item.dimension === 'warmth')
ok('A 的 warmth 为 50', warmthOfA?.value === 50, warmthOfA)
ok('B 的 Trust 未评估', briefB.trustBand === null, briefB.trustBand)
ok('B 的所有 Affect 为 0', briefB.affect.every((item) => item.value === 0), briefB.affect)

const textA = projectRelationshipBrief(briefA).text
const textB = projectRelationshipBrief(briefB).text
ok('A 投影包含信任与感受', textA.includes('信任：') && textA.includes('此刻'), textA)
ok('B 投影不包含 A 的信任/感受', !textB.includes('信任') && !textB.includes('亲近'), textB)

const trustA = rowOf(on.db,
  `SELECT a.artifact_id, r.subject_refs, r.payload FROM artifacts a
     JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
    WHERE a.kind = 'relationship'
    ORDER BY r.revision DESC LIMIT 1`)
ok('Trust Artifact 只挂在 A', String(trustA?.subject_refs ?? '').includes(aliceId) && !String(trustA?.subject_refs ?? '').includes(bobId), trustA?.subject_refs)

const affectA = rowOf(on.db, 'SELECT COUNT(*) AS n FROM contact_affect_state WHERE contact_id = ?', [aliceId])
const affectB = rowOf(on.db, 'SELECT COUNT(*) AS n FROM contact_affect_state WHERE contact_id = ?', [bobId])
ok('Affect 状态只属于 A', Number(affectA?.n) === 1 && Number(affectB?.n) === 0, { a: affectA, b: affectB })

const relA = await coreOn.getRelationship(aliceId)
const relB = await coreOn.getRelationship(bobId)
ok('A 的关系投影有信任', relA?.trust?.band === 'medium', relA?.trust)
ok('B 的关系投影无信任', relB?.trust === null, relB?.trust)

console.log('\n[P3-B-4-3] 投影一致性（写入状态 → 只读投影）')
const affinityA = rowOf(on.db, 'SELECT affinity, band FROM relationship_affinity_state WHERE contact_id = ?', [aliceId])
eq('投影档位与存储一致', briefA.affinityBand, affinityA?.band)
const warmthA = rowOf(on.db, 'SELECT value FROM contact_affect_state WHERE contact_id = ? AND dimension = ?', [aliceId, 'warmth'])
ok('投影感受与存储一致', Math.abs(Number(warmthOfA?.value) - Number(warmthA?.value ?? -1)) < 1e-6, { brief: warmthOfA, stored: warmthA?.value })

const later = new Date(Date.parse(FIXED_NOW) + 8 * HOUR).toISOString()
const briefLater = coreOn.readRelationshipBrief(aliceId, { now: later })
ok('8 小时后 warmth 冷却到 25、全部低于感受阈值', briefLater.affect.every((item) => item.value < 40), briefLater.affect)

for (const text of [textA, textB]) {
  ok(`投影不含内部标识/数值：${text}`, !/ct_|src_|art_|\d/.test(text), text)
}

console.log('\n[P3-B-4-4] 数据完整性（只读与可追溯）')
const before = relationshipCounts(on.db)
const beforeArtifacts = Number(rowOf(on.db, 'SELECT COUNT(*) AS n FROM artifacts')?.n ?? 0)
const beforeRevisions = Number(rowOf(on.db, 'SELECT COUNT(*) AS n FROM artifact_revisions')?.n ?? 0)
const beforeEvidence = Number(rowOf(on.db, 'SELECT COUNT(*) AS n FROM artifact_evidence')?.n ?? 0)
const beforeOps = Number(rowOf(on.db, 'SELECT COUNT(*) AS n FROM operations')?.n ?? 0)

const provider = createRelationshipContextProvider({
  resolve: (agent) => (agent?.id === 'agent-a' ? { contactId: aliceId, platform: 'qq' } : null),
  readBrief: (contactId, at) => coreOn.readRelationshipBrief(contactId, { now: at }),
  now: () => FIXED_NOW,
})
const injected = provider.text({ agent: { id: 'agent-a' } })
ok('Context Provider 输出一行关系投影', injected.includes('关系：') && injected.split('\n').length === 2, injected)
ok('Context Provider 对无绑定 Agent 输出空串', provider.text({ agent: { id: 'agent-x' } }) === '')

coreOn.readRelationshipBrief(aliceId, { now: FIXED_NOW })
projectRelationshipBrief(briefA)
// 注意：`getRelationship()` 是带审计的只读工具（§9.2 会在 operations 记一行），
// 不属于本组「投影/Context 零写入」的证明对象；这里只证明 readRelationshipBrief /
// projectRelationshipBrief / Context Provider 不写任何表。

const after = relationshipCounts(on.db)
eq('只读操作不改变关系表行数', after, before)
ok('只读操作不新增 Artifact', Number(rowOf(on.db, 'SELECT COUNT(*) AS n FROM artifacts')?.n ?? 0) === beforeArtifacts)
ok('只读操作不新增 Revision', Number(rowOf(on.db, 'SELECT COUNT(*) AS n FROM artifact_revisions')?.n ?? 0) === beforeRevisions)
ok('只读操作不新增 Evidence', Number(rowOf(on.db, 'SELECT COUNT(*) AS n FROM artifact_evidence')?.n ?? 0) === beforeEvidence)
ok('只读操作不新增 operations', Number(rowOf(on.db, 'SELECT COUNT(*) AS n FROM operations')?.n ?? 0) === beforeOps)

const trustRevision = rowOf(on.db,
  "SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id = ?", [trustA?.artifact_id])
const trustEvidence = rowOf(on.db,
  'SELECT COUNT(*) AS n FROM artifact_evidence WHERE artifact_id = ?', [trustA?.artifact_id])
ok('Trust 首次评估生成 1 个 revision', Number(trustRevision?.n) === 1, trustRevision?.n)
ok('Trust 记录两条证据引用', Number(trustEvidence?.n) === 2, trustEvidence?.n)

const second = await coreOn.reviewContactTrust({
  contactId: aliceId, proposedValue: 66, evidenceRefs: [onResult.ids[0], onResult.ids[1]],
  decidedBy: 'owner', now: FIXED_NOW,
})
ok('第二次复核追加 revision=2', second.revision === 2, second.revision)
const revisions2 = rowOf(on.db,
  "SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id = ?", [trustA?.artifact_id])
ok('Revision 历史保留两条', Number(revisions2?.n) === 2, revisions2?.n)

console.log(`\n[P3-B-4] ${passed} 通过 ${failed} 失败`)
off.db.close()
on.db.close()
rmSync(offDir, { recursive: true, force: true })
rmSync(onDir, { recursive: true, force: true })
if (failed > 0) process.exit(1)
