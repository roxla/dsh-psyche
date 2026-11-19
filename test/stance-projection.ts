// P2 Completion Batch 阶段 4：Stance Projection 与 stance_revised 派生事件。
//
// 验收口径（用户 m32066 冻结）：
// - Projection 只取每个 stance 的 head，只放行 active/challenged，输出确定性；
// - 首次创建不触发 stance_revised；只加证据不触发；真实修订触发；
// - 事件依据是成功写入的 Revision，Decision Receipt 缺失也照样识别；
// - Scope 隔离：绑了 Contact 的立场只对本人可见，没绑的是全局立场；
// - 不修改原始 revision，不产生第二套事实存储。
//
// 跑法：node test/stance-projection.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Core } from '../dist/lib/store.js'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { projectStances, stanceRevisionEvents, STANCE_CHALLENGED_NOTE } from '../dist/lib/projection.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-stance-projection-'))
const log = { info() {}, debug() {}, warn: () => {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, logger: log, dataDir: dir })

const stanceArtifact = (): string =>
  db.get<{ artifact_id: string }>(`SELECT artifact_id FROM artifacts WHERE kind = 'stance' LIMIT 1`)!.artifact_id

function insertRevision(input: {
  artifactId: string
  revision: number
  state?: string
  statement: string
  subjectRefs?: string[]
  payload?: Record<string, unknown>
  updatedAt: string
}): void {
  db.run(
    `INSERT INTO artifact_revisions
       (artifact_id, revision, state, statement, subject_refs, payload, confidence,
        basis_count, independent_evidence_count, created_at, updated_at, disclosure)
     VALUES (?, ?, ?, ?, ?, ?, 'medium', 0, 0, ?, ?, 'public')`,
    [
      input.artifactId,
      input.revision,
      input.state ?? 'active',
      input.statement,
      JSON.stringify(input.subjectRefs ?? []),
      JSON.stringify(input.payload ?? {}),
      input.updatedAt,
      input.updatedAt,
    ],
  )
}

console.log('\n[Stance Projection] 合成后视图')
eq('合成前没有立场', projectStances(db).length, 0)

const s = (await core.capture({ text: '我平时喝乌龙茶。', platform: 'desktop', sessionRef: 'sp-1a' })).sourceId
const s1b = (await core.capture({ text: '乌龙茶是我最常喝的。', platform: 'desktop', sessionRef: 'sp-1b' })).sourceId
const s2 = (await core.capture({ text: '乌龙茶挺合我口味。', platform: 'desktop', sessionRef: 'sp-2a' })).sourceId
const s2b = (await core.capture({ text: '喝乌龙舒服。', platform: 'desktop', sessionRef: 'sp-2b' })).sourceId
await core.remember({
  statement: '用户喜欢乌龙茶。',
  kind: 'belief',
  subjectRefs: ['topic:tea'],
  payload: { stanceGroup: 'topic:tea', stanceDirection: 'for' },
  sourceIds: [s, s1b],
  sessionRef: 'sp-1a',
  disclosure: 'public',
  confidence: 'high',
})
await core.remember({
  statement: '用户对乌龙茶评价正面。',
  kind: 'belief',
  subjectRefs: ['topic:tea'],
  payload: { stanceGroup: 'topic:tea', stanceDirection: 'for' },
  sourceIds: [s2, s2b],
  sessionRef: 'sp-2a',
  disclosure: 'public',
  confidence: 'medium',
})

const v1 = projectStances(db)
eq('合成后有 1 条立场', v1.length, 1)
eq('revision 是 1', v1[0]?.revision, 1)
eq('direction 是 for', v1[0]?.direction, 'for')
eq('group 是 topic:tea', v1[0]?.group, 'topic:tea')
eq('state 是 active', v1[0]?.state, 'active')
eq('challenged 无提示', v1[0]?.statusNote, null)
ok('有 statement', typeof v1[0]?.statement === 'string' && v1[0].statement.length > 0)
const again = projectStances(db)
eq('两次调用结果完全一致（确定性）', JSON.stringify(again), JSON.stringify(v1))

console.log('\n[Stance Projection] 首次创建不产生修订事件')
eq('v1 没有 stance_revised', stanceRevisionEvents(db).length, 0)

console.log('\n[Stance Projection] 新 belief 触发实质修订')
const s3 = (await core.capture({ text: '今天又喝了乌龙茶。', platform: 'desktop', sessionRef: 'sp-3a' })).sourceId
const s4 = (await core.capture({ text: '还是乌龙茶舒服。', platform: 'desktop', sessionRef: 'sp-4a' })).sourceId
await core.remember({
  statement: '用户仍然偏爱乌龙茶。',
  kind: 'belief',
  subjectRefs: ['topic:tea'],
  payload: { stanceGroup: 'topic:tea', stanceDirection: 'for' },
  sourceIds: [s3, s4],
  sessionRef: 'sp-3a',
  disclosure: 'public',
  confidence: 'high',
})
const v2 = projectStances(db)
eq('head 推进到 revision 2', v2[0]?.revision, 2)
const events = stanceRevisionEvents(db)
eq('产生 1 条修订事件', events.length, 1)
eq('from/to 正确', [events[0]?.fromRevision, events[0]?.toRevision], [1, 2])
eq('changedBecause=basis', events[0]?.changedBecause, 'basis')
ok('能关联到 Decision Receipt', typeof events[0]?.decisionRunId === 'string' && events[0].decisionRunId.length > 0)

console.log('\n[Stance Projection] Receipt 缺失不影响修订识别')
db.run(`DELETE FROM decision_runs WHERE kind = 'stance'`)
const orphan = projectStances(db)
eq('Projection 仍显示 revision 2', orphan[0]?.revision, 2)
const orphanEvents = stanceRevisionEvents(db)
eq('事件仍在', orphanEvents.length, 1)
eq('没有 Receipt 时 runId 为 null', orphanEvents[0]?.decisionRunId, null)

console.log('\n[Stance Projection] 只加证据 / 状态变化')
const artifactId = stanceArtifact()
insertRevision({
  artifactId,
  revision: 3,
  statement: '用户喜欢乌龙茶（只补充证据）。',
  payload: { stanceGroup: 'topic:tea', stanceDirection: 'for', changedBecause: 'evidence' },
  updatedAt: '2026-11-09T09:00:00.000Z',
})
eq('evidence-only 不产生事件', stanceRevisionEvents(db).length, 1)
eq('但 head 推进到 3', projectStances(db)[0]?.revision, 3)

insertRevision({
  artifactId,
  revision: 4,
  statement: '用户喜欢乌龙茶（措辞修订）。',
  payload: { stanceGroup: 'topic:tea', stanceDirection: 'for', changedBecause: 'statement' },
  updatedAt: '2026-11-09T09:10:00.000Z',
})
eq('statement 修订产生第 2 条事件', stanceRevisionEvents(db).length, 2)
const ev34 = stanceRevisionEvents(db).find((e) => e.fromRevision === 3 && e.toRevision === 4)
eq('3→4 的事件存在且 changedBecause=statement', ev34?.changedBecause, 'statement')

insertRevision({
  artifactId,
  revision: 5,
  state: 'challenged',
  statement: '用户喜欢乌龙茶（有争议）。',
  payload: { stanceGroup: 'topic:tea', stanceDirection: 'for', changedBecause: 'basis' },
  updatedAt: '2026-11-09T09:20:00.000Z',
})
const challenged = projectStances(db)[0]
eq('challenged 仍出现在视图里', challenged?.state, 'challenged')
eq('challenged 带提示语', challenged?.statusNote, STANCE_CHALLENGED_NOTE)

insertRevision({
  artifactId,
  revision: 6,
  state: 'deprecated',
  statement: '用户喜欢乌龙茶（已失效）。',
  payload: { stanceGroup: 'topic:tea', stanceDirection: 'for', changedBecause: 'basis' },
  updatedAt: '2026-11-09T09:30:00.000Z',
})
eq('失效状态不出现在视图里', projectStances(db).length, 0)

console.log('\n[Stance Projection] Scope 隔离')
db.run(`DELETE FROM artifact_revisions WHERE artifact_id = ? AND revision = 6`, [artifactId])
db.run(`INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at, op_id, stance_key)
        VALUES ('art_stance_cta', 'main', 'stance', '2026-11-09T10:00:00.000Z', '2026-11-09T10:00:00.000Z', NULL, 'group:cta')`)
insertRevision({
  artifactId: 'art_stance_cta',
  revision: 1,
  statement: '只属于 ct_a 的立场。',
  subjectRefs: ['ct_a'],
  payload: { stanceGroup: 'group:cta', stanceDirection: 'for' },
  updatedAt: '2026-11-09T10:00:00.000Z',
})
eq('ct_a 能看到自己的立场', projectStances(db, { contactId: 'ct_a' }).some((i) => i.artifactId === 'art_stance_cta'), true)
eq('ct_b 看不到 ct_a 的立场', projectStances(db, { contactId: 'ct_b' }).some((i) => i.artifactId === 'art_stance_cta'), false)
eq('无绑定看不到私有立场', projectStances(db).some((i) => i.artifactId === 'art_stance_cta'), false)
eq('ct_b 仍能看到全局立场', projectStances(db, { contactId: 'ct_b' }).some((i) => i.artifactId === artifactId), true)

console.log(`\n[Stance Projection] ${passed} 通过 ${failed} 失败`)
db.close()
rmSync(dir, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
