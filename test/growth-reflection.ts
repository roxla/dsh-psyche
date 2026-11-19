// P5-3a 成长反思候选测试（rule-only v1）。
//
// 验收口径（docs/design/p5-growth-reflection-contract.md）：
// - 只从本次新增、非助手的 Source 与 fact / stance revision 生成候选；
// - scope 取证据可见域交集，空交集失败关闭（no_change），不提升 global；
// - trigger_key 同一批 Source 只跑一次；proposed/no_change 去重；
// - failed/skipped_budget 复用原行重试；预算跳过不消耗执行额度；
// - evaluating 超时先置 failed；独立性按 independence_key 归并。
//
// 跑法：node test/growth-reflection.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../packages/core/dist/adapter.js'
import { countLegacyProcessedSources, recoverStaleReflections, reflectGrowthCandidates } from '../packages/core/dist/growth-reflection.js'

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

const log = { info() {}, debug() {}, warn() {}, error() {} }
const T0 = '2026-11-15T02:00:00.000Z'
const T1 = new Date(Date.parse(T0) + 60_000)
const dirs: string[] = []

async function freshDb(): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-growth-reflection-'))
  dirs.push(dir)
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
  migrate(opened.db, log)
  opened.db
    .prepare(
      "INSERT OR IGNORE INTO contacts (contact_id, persona_id, platform, stable_user_id, display_name, created_at, updated_at) VALUES ('ct_a','main','qq','u_a','A',?,?)",
    )
    .run(T0, T0)
  for (const room of ['rm_a', 'rm_b']) {
    opened.db
      .prepare(
        `INSERT OR IGNORE INTO rooms (room_id, persona_id, platform, channel, external_room_id, created_at, updated_at)
         VALUES (?, 'main', 'qq', 'group', ?, ?, ?)`,
      )
      .run(room, room, T0, T0)
  }
  return opened.db
}

let seq = 0
function addSource(
  db: any,
  input: {
    channel: string
    roomId?: string | null
    sender?: string | null
    origin?: 'user' | 'external' | 'self'
    independence?: string | null
    text?: string
    at?: string
  },
): string {
  seq += 1
  const id = `src_t${seq}`
  const at = input.at ?? T0
  db.prepare(
    `INSERT INTO sources
      (source_id, persona_id, platform, channel, room_id, sender_contact_id, origin, kind, text,
       independence_key, captured_at, created_at)
     VALUES (?, 'main', 'qq', ?, ?, ?, ?, 'message', ?, ?, ?, ?)`,
  ).run(
    id,
    input.channel,
    input.roomId ?? null,
    input.sender ?? null,
    input.origin ?? 'user',
    input.text ?? `message ${seq}`,
    input.independence === undefined ? `win_${seq}` : input.independence,
    at,
    at,
  )
  return id
}

function addFact(db: any, input: { sourceIds: string[]; statement: string; kind?: string; revision?: number; at?: string }): void {
  seq += 1
  const artifactId = `art_${seq}`
  const revision = input.revision ?? 1
  const at = input.at ?? T0
  db.prepare("INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at) VALUES (?, 'main', ?, ?, ?)").run(
    artifactId,
    input.kind ?? 'fact',
    at,
    at,
  )
  db.prepare(
    `INSERT INTO artifact_revisions
      (artifact_id, revision, state, statement, subject_refs, created_at, updated_at)
     VALUES (?, ?, 'active', ?, '["user"]', ?, ?)`,
  ).run(artifactId, revision, input.statement, at, at)
  for (const [index, sourceId] of input.sourceIds.entries()) {
    db.prepare(
      `INSERT INTO artifact_evidence
        (artifact_id, revision, source_id, relation, independence_key, created_at)
       VALUES (?, ?, ?, 'supports', ?, ?)`,
    ).run(artifactId, revision, sourceId, `ev_${artifactId}_${index}`, at)
  }
}

const count = (db: any, table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
function cleanup(): void {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言 */
    }
  }
}

// 1. 没有新 Source：不生成反思。
{
  const db = await freshDb()
  eq('no source -> no_source', reflectGrowthCandidates(db, { candidateFilter: false, now: T1 }).status, 'no_source')
}

// 2. 外部网页 Source + fact revision：生成一个 new_fact 候选。
{
  const db = await freshDb()
  const web = addSource(db, { channel: 'web', origin: 'external' })
  addFact(db, { sourceIds: [web], statement: '用户偏好清晨写作' })
  const first = reflectGrowthCandidates(db, { candidateFilter: false, now: T1, perContactDaily: 10, globalDaily: 10 })
  eq('new fact -> proposed', first.status, 'proposed')
  eq('one candidate', first.candidates, 1)
  const candidate = db.prepare('SELECT * FROM growth_candidates LIMIT 1').get() as any
  eq('candidate type', candidate.type, 'new_fact')
  eq('candidate status', candidate.status, 'proposed')
  eq('candidate independence', candidate.independent_count, 1)
  eq('candidate scope personal', candidate.scope, 'personal')

  const again = reflectGrowthCandidates(db, { candidateFilter: false, now: T1, perContactDaily: 10, globalDaily: 10 })
  eq('no new source after success -> no_source', again.status, 'no_source')
  eq('candidate count stable', count(db, 'growth_candidates'), 1)
}

// 3. 助手自己的来源不参与反思。
{
  const db = await freshDb()
  addSource(db, { channel: 'desktop', origin: 'self' })
  eq('assistant source ignored', reflectGrowthCandidates(db, { candidateFilter: false, now: T1 }).status, 'no_source')
  eq('no reflection row for self', count(db, 'growth_reflections'), 0)
}

// 4. 同室两条消息（同一 independence_key）只算一份独立证据。
{
  const db = await freshDb()
  const a1 = addSource(db, { channel: 'group', roomId: 'rm_a', independence: 'grp_win_1' })
  const a2 = addSource(db, { channel: 'group', roomId: 'rm_a', independence: 'grp_win_1' })
  addFact(db, { sourceIds: [a1, a2], statement: '群里提到周五上线' })
  const result = reflectGrowthCandidates(db, { candidateFilter: false, now: T1, perContactDaily: 10, globalDaily: 10 })
  eq('group candidate proposed', result.status, 'proposed')
  const candidate = db.prepare('SELECT scope, independent_count FROM growth_candidates LIMIT 1').get() as any
  eq('same independence key -> count 1', candidate.independent_count, 1)
  eq('group scope room', candidate.scope, 'room:rm_a')
}

// 5. 跨群两条证据：scope 冲突，失败关闭。
{
  const db = await freshDb()
  const a = addSource(db, { channel: 'group', roomId: 'rm_a', independence: 'win_a' })
  const b = addSource(db, { channel: 'group', roomId: 'rm_b', independence: 'win_b' })
  addFact(db, { sourceIds: [a, b], statement: '两个群都在聊同一件事' })
  const result = reflectGrowthCandidates(db, { candidateFilter: false, now: T1, perContactDaily: 10, globalDaily: 10 })
  eq('cross-room -> no_change', result.status, 'no_change')
  eq('scope conflict reason', result.reason, 'scope_conflict')
  eq('no candidate on conflict', count(db, 'growth_candidates'), 0)
}

// 6. 每日额度：默认每对象 1 次，第二次不同触发被跳过且不消耗额度。
{
  const db = await freshDb()
  const q1 = addSource(db, { channel: 'web', origin: 'external', independence: 'w1' })
  addFact(db, { sourceIds: [q1], statement: 'q1' })
  eq('quota first proposed', reflectGrowthCandidates(db, { candidateFilter: false, now: T1 }).status, 'proposed')

  const q2At = new Date(Date.parse(T0) + 120_000).toISOString()
  const q2 = addSource(db, { channel: 'web', origin: 'external', independence: 'w2', at: q2At })
  addFact(db, { sourceIds: [q2], statement: 'q2', at: q2At })
  const second = reflectGrowthCandidates(db, { candidateFilter: false, now: new Date(Date.parse(q2At) + 60_000) })
  eq('quota second -> skipped_budget', second.status, 'skipped_budget')
  const row = db.prepare("SELECT status, next_eligible_at FROM growth_reflections WHERE status='skipped_budget'").get() as any
  ok('skipped row has next eligible', typeof row?.next_eligible_at === 'string')
}

// 7. evaluating 超时：先置 failed。
{
  const db = await freshDb()
  db.prepare(
    `INSERT INTO growth_reflections
      (reflection_id, persona_id, trigger_key, status, attempt, source_count, candidate_count,
       started_at, created_at, updated_at)
     VALUES ('grf_stale','main','trigger_stale','evaluating',1,1,0,?,?,?)`,
  ).run('2026-11-15T00:00:00.000Z', T0, T0)
  eq('stale evaluating recovered', recoverStaleReflections(db, { now: T1, timeoutMs: 120_000 }), 1)
  eq('recovered status', (db.prepare("SELECT status FROM growth_reflections WHERE reflection_id='grf_stale'").get() as any).status, 'failed')
}

// 8. 水位改为逐条账本：created_at 更早但未处理的 Source 仍会被处理。
{
  const db = await freshDb()
  const newer = addSource(db, { channel: 'web', origin: 'external', at: '2026-11-15T02:02:00.000Z' })
  addFact(db, { sourceIds: [newer], statement: '较新的来源', at: '2026-11-15T02:02:00.000Z' })
  eq(
    'newer source proposed',
    reflectGrowthCandidates(db, { candidateFilter: false, now: new Date('2026-11-15T02:03:00.000Z'), perContactDaily: 10, globalDaily: 10 }).status,
    'proposed',
  )
  const older = addSource(db, { channel: 'web', origin: 'external', at: '2026-11-15T02:00:30.000Z' })
  addFact(db, { sourceIds: [older], statement: '更早但未处理的来源', at: '2026-11-15T02:00:30.000Z' })
  eq(
    'older unprocessed still proposed',
    reflectGrowthCandidates(db, { candidateFilter: false, now: new Date('2026-11-15T02:04:00.000Z'), perContactDaily: 10, globalDaily: 10 }).status,
    'proposed',
  )
}

// 9. 同一 Contact 同日第二次：跳过并绑定原始集合。
{
  const db = await freshDb()
  const first = addSource(db, { channel: 'private', sender: 'ct_a' })
  addFact(db, { sourceIds: [first], statement: '私聊一' })
  eq('contact quota first', reflectGrowthCandidates(db, { candidateFilter: false, now: T1 }).status, 'proposed')
  const second = addSource(db, { channel: 'private', sender: 'ct_a', at: '2026-11-15T02:02:00.000Z' })
  addFact(db, { sourceIds: [second], statement: '私聊二', at: '2026-11-15T02:02:00.000Z' })
  const skipped = reflectGrowthCandidates(db, { candidateFilter: false, now: new Date('2026-11-15T02:03:00.000Z') })
  eq('contact quota second skipped', skipped.status, 'skipped_budget')
  const row = db.prepare("SELECT source_ids FROM growth_reflections WHERE status='skipped_budget'").get() as any
  eq('skipped snapshot binds pending source', JSON.parse(row.source_ids), [second])
}

// 10. 不同 Contact 同日各一次。
{
  const db = await freshDb()
  db.prepare(
    "INSERT OR IGNORE INTO contacts (contact_id, persona_id, platform, stable_user_id, display_name, created_at, updated_at) VALUES ('ct_b','main','qq','u_b','B',?,?)",
  ).run(T0, T0)
  const a = addSource(db, { channel: 'private', sender: 'ct_a' })
  addFact(db, { sourceIds: [a], statement: 'A 的事' })
  eq('contact A proposed', reflectGrowthCandidates(db, { candidateFilter: false, now: T1 }).status, 'proposed')
  const b = addSource(db, { channel: 'private', sender: 'ct_b', at: '2026-11-15T02:02:00.000Z' })
  addFact(db, { sourceIds: [b], statement: 'B 的事', at: '2026-11-15T02:02:00.000Z' })
  eq('contact B still proposed', reflectGrowthCandidates(db, { candidateFilter: false, now: new Date('2026-11-15T02:03:00.000Z') }).status, 'proposed')
}

// 11. 全局额度 1：第二个 Contact 也跳过。
{
  const db = await freshDb()
  db.prepare(
    "INSERT OR IGNORE INTO contacts (contact_id, persona_id, platform, stable_user_id, display_name, created_at, updated_at) VALUES ('ct_b','main','qq','u_b','B',?,?)",
  ).run(T0, T0)
  const a = addSource(db, { channel: 'private', sender: 'ct_a' })
  addFact(db, { sourceIds: [a], statement: 'A' })
  eq('global first', reflectGrowthCandidates(db, { candidateFilter: false, now: T1, globalDaily: 1 }).status, 'proposed')
  const b = addSource(db, { channel: 'private', sender: 'ct_b', at: '2026-11-15T02:02:00.000Z' })
  addFact(db, { sourceIds: [b], statement: 'B', at: '2026-11-15T02:02:00.000Z' })
  eq(
    'global second skipped',
    reflectGrowthCandidates(db, { candidateFilter: false, now: new Date('2026-11-15T02:03:00.000Z'), globalDaily: 1 }).status,
    'skipped_budget',
  )
}

// 12. failed 复跑：成功后复用原行。
{
  const db = await freshDb()
  const s1 = addSource(db, { channel: 'web', origin: 'external' })
  addFact(db, { sourceIds: [s1], statement: '第一批' })
  eq('initial proposed', reflectGrowthCandidates(db, { candidateFilter: false, now: T1, perContactDaily: 1, globalDaily: 1 }).status, 'proposed')
  const s2 = addSource(db, { channel: 'web', origin: 'external', at: '2026-11-15T02:02:00.000Z' })
  addFact(db, { sourceIds: [s2], statement: '失败后重试', at: '2026-11-15T02:02:00.000Z' })
  const skipped = reflectGrowthCandidates(db, { candidateFilter: false, now: new Date('2026-11-15T02:03:00.000Z'), perContactDaily: 1, globalDaily: 1 })
  eq('second skipped before failure', skipped.status, 'skipped_budget')
  db.prepare("UPDATE growth_reflections SET status='failed', next_eligible_at=NULL WHERE reflection_id=?").run(
    skipped.reflectionId,
  )
  const retry = reflectGrowthCandidates(db, { candidateFilter: false, now: new Date('2026-11-15T02:04:00.000Z'), perContactDaily: 10, globalDaily: 10 })
  eq('failed reused', retry.reflectionId, skipped.reflectionId)
  eq('failed retry proposed', retry.status, 'proposed')
}

// 13. legacy 已处理账本不回放。
{
  const db = await freshDb()
  const s = addSource(db, { channel: 'web', origin: 'external' })
  addFact(db, { sourceIds: [s], statement: '迁移前已经处理过' })
  db.prepare(
    `INSERT INTO growth_reflection_processed_sources (persona_id, source_id, reflection_id, contact_key, processed_at)
     VALUES ('main', ?, NULL, 'personal', ?)`,
  ).run(s, T0)
  eq('legacy not replayed', reflectGrowthCandidates(db, { candidateFilter: false, now: T1 }).status, 'no_source')
  eq('legacy count', countLegacyProcessedSources(db, 'main'), 1)
}

// 14. 预算窗口内新增 Source 不并入旧任务。
{
  const db = await freshDb()
  const s1 = addSource(db, { channel: 'web', origin: 'external' })
  addFact(db, { sourceIds: [s1], statement: '第一批' })
  eq('batch 1 proposed', reflectGrowthCandidates(db, { candidateFilter: false, now: T1 }).status, 'proposed')
  const s2 = addSource(db, { channel: 'web', origin: 'external', at: '2026-11-15T02:02:00.000Z' })
  addFact(db, { sourceIds: [s2], statement: '第二批' })
  eq(
    'batch 2 skipped',
    reflectGrowthCandidates(db, { candidateFilter: false, now: new Date('2026-11-15T02:03:00.000Z') }).status,
    'skipped_budget',
  )
  const s3 = addSource(db, { channel: 'web', origin: 'external', at: '2026-11-15T02:04:00.000Z' })
  addFact(db, { sourceIds: [s3], statement: '第三批' })
  reflectGrowthCandidates(db, { candidateFilter: false, now: new Date('2026-11-16T02:03:00.000Z'), perContactDaily: 10, globalDaily: 10 })
  const processed = new Set(
    (db.prepare('SELECT source_id FROM growth_reflection_processed_sources').all() as any[]).map((row) => row.source_id),
  )
  ok('retry processed original batch only', processed.has(s2) && !processed.has(s3))
}

// 15. 部分 Source 已被其他反思处理：只处理剩余，且不覆盖原账本。
{
  const db = await freshDb()
  const s1 = addSource(db, { channel: 'web', origin: 'external' })
  addFact(db, { sourceIds: [s1], statement: '已处理' })
  const seed = reflectGrowthCandidates(db, { candidateFilter: false, now: T1 })
  eq('seed proposed', seed.status, 'proposed')
  const s2 = addSource(db, { channel: 'web', origin: 'external', at: '2026-11-15T02:02:00.000Z' })
  const s3 = addSource(db, { channel: 'web', origin: 'external', at: '2026-11-15T02:02:10.000Z' })
  addFact(db, { sourceIds: [s2, s3], statement: '部分已处理', at: '2026-11-15T02:02:10.000Z' })
  eq(
    'second skipped',
    reflectGrowthCandidates(db, { candidateFilter: false, now: new Date('2026-11-15T02:03:00.000Z') }).status,
    'skipped_budget',
  )
  db.prepare(
    `INSERT INTO growth_reflection_processed_sources (persona_id, source_id, reflection_id, contact_key, processed_at)
     VALUES ('main', ?, ?, 'personal', ?)`,
  ).run(s2, seed.reflectionId, '2026-11-15T02:03:30.000Z')
  reflectGrowthCandidates(db, { candidateFilter: false, now: new Date('2026-11-16T02:03:00.000Z'), perContactDaily: 10, globalDaily: 10 })
  const rows = db.prepare('SELECT source_id, reflection_id FROM growth_reflection_processed_sources').all() as any[]
  ok('already processed source kept', rows.find((row) => row.source_id === s2)?.reflection_id === seed.reflectionId)
  ok('remaining source processed', rows.some((row) => row.source_id === s3))
}

cleanup()
console.log(`\n[P5-3a growth-reflection] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
