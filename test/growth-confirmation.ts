// P5-3b 成长确认测试（append-only 决策账本）。
//
// 验收口径（docs/design/p5-3b-growth-confirm-implementation.md）：
// - confirm/reject/withdraw 与候选 status 同事务，账本唯一事实源；
// - confirm 必须带内容哈希，候选内容变化后旧哈希拒绝；
// - reject 只对未确认候选；withdraw 只对已确认候选；
// - P5-3a 不再合并已确认/已决策候选；
// - 投影只读最新 confirm 且未撤回的 personal 变化；
// - decidedBy 必须是 os:<SID/UID>。
//
// 跑法：node test/growth-confirmation.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../packages/core/dist/adapter.js'
import { reflectGrowthCandidates } from '../packages/core/dist/growth-reflection.js'
import {
  decideGrowthCandidate,
  decisionCandidateStatuses,
  formatConfirmedGrowthLine,
  growthCandidateContentHash,
  listGrowthCandidates,
  readConfirmedGrowthChanges,
} from '../packages/core/dist/growth-confirmation.js'

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
function throws(label: string, fn: () => unknown, code: string): void {
  try {
    fn()
    ok(label, false, { thrown: 'none' })
  } catch (error) {
    eq(label, (error as Error).message, code)
  }
}

const log = { info() {}, debug() {}, warn() {}, error() {} }
const T0 = '2026-11-15T02:00:00.000Z'
const T1 = new Date(Date.parse(T0) + 60_000)
const T2 = new Date(Date.parse(T0) + 120_000).toISOString()
const OWNER = 'os:S-1-5-21-1000'
const dirs: string[] = []

async function freshDb(): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-growth-confirm-'))
  dirs.push(dir)
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
  migrate(opened.db, log)
  opened.db
    .prepare(
      "INSERT OR IGNORE INTO contacts (contact_id, persona_id, platform, stable_user_id, display_name, created_at, updated_at) VALUES ('ct_a','main','qq','u_a','A',?,?)",
    )
    .run(T0, T0)
  return opened.db
}

let seq = 0
function addSource(db: any, input: { channel: string; sender?: string | null; origin?: 'user' | 'external' | 'self'; independence?: string | null; at?: string }): string {
  seq += 1
  const id = `src_c${seq}`
  const at = input.at ?? T0
  db.prepare(
    `INSERT INTO sources
      (source_id, persona_id, platform, channel, room_id, sender_contact_id, origin, kind, text,
       independence_key, captured_at, created_at)
     VALUES (?, 'main', 'qq', ?, NULL, ?, ?, 'message', ?, ?, ?, ?)`,
  ).run(
    id,
    input.channel,
    input.sender ?? null,
    input.origin ?? 'user',
    `text ${id}`,
    input.independence ?? `ind_${id}`,
    at,
    at,
  )
  return id
}

function addFact(db: any, input: { sourceIds: string[]; statement: string; kind?: string; at?: string }): void {
  seq += 1
  const artifactId = `art_c${seq}`
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
     VALUES (?, 1, 'active', ?, '["user"]', ?, ?)`,
  ).run(artifactId, input.statement, at, at)
  for (const [index, sourceId] of input.sourceIds.entries()) {
    db.prepare(
      `INSERT INTO artifact_evidence
        (artifact_id, revision, source_id, relation, independence_key, created_at)
       VALUES (?, 1, ?, 'supports', ?, ?)`,
    ).run(artifactId, sourceId, `ev_${artifactId}_${index}`, at)
  }
}

/**
 * 建一个 personal 候选：外部网页 Source + fact revision，跑一次反思。
 */
async function proposed(db: any, statement = '用户偏好清晨写作'): Promise<{ candidateId: string; hash: string }> {
  const source = addSource(db, { channel: 'web', origin: 'external' })
  addFact(db, { sourceIds: [source], statement })
  const result = reflectGrowthCandidates(db, { now: T1, perContactDaily: 10, globalDaily: 10, candidateFilter: false })
  if (result.status !== 'proposed') throw new Error(`expected proposed, got ${result.status}`)
  const row = db.prepare("SELECT candidate_id FROM growth_candidates WHERE status='proposed' LIMIT 1").get() as { candidate_id: string }
  return { candidateId: row.candidate_id, hash: growthCandidateContentHash(db, row.candidate_id).hash }
}

function cleanup(): void {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言 */
    }
  }
}

// 1. confirm：status 物化 + 账本 + 幂等。
{
  const db = await freshDb()
  const { candidateId, hash } = await proposed(db)
  const first = decideGrowthCandidate(db, { candidateId, decision: 'confirm', decidedBy: OWNER, expectedHash: hash })
  eq('confirm ok', first.idempotent, false)
  const row = db.prepare('SELECT status FROM growth_candidates WHERE candidate_id=?').get(candidateId) as { status: string }
  eq('status confirmed', row.status, 'confirmed')
  eq('one decision row', Number((db.prepare('SELECT COUNT(*) AS n FROM growth_confirmations').get() as { n: number }).n), 1)
  const again = decideGrowthCandidate(db, { candidateId, decision: 'confirm', decidedBy: OWNER, expectedHash: hash })
  eq('repeat confirm idempotent', again.idempotent, true)
  eq('still one decision row', Number((db.prepare('SELECT COUNT(*) AS n FROM growth_confirmations').get() as { n: number }).n), 1)
  const changes = readConfirmedGrowthChanges(db)
  eq('projection includes confirmed personal', changes.length, 1)
  ok('projection line has date', formatConfirmedGrowthLine(changes[0]).includes(changes[0].decidedAt.slice(0, 10)))
}

// 2. 哈希绑定：内容变化后旧哈希拒绝；缺哈希拒绝。
{
  const db = await freshDb()
  const { candidateId, hash } = await proposed(db)
  db.prepare('UPDATE growth_candidates SET statement=? WHERE candidate_id=?').run('用户偏好凌晨写作', candidateId)
  throws(
    'changed content -> old hash rejected',
    () => decideGrowthCandidate(db, { candidateId, decision: 'confirm', decidedBy: OWNER, expectedHash: hash }),
    'E_CONFIRM_HASH_MISMATCH',
  )
  throws(
    'confirm without hash rejected',
    () => decideGrowthCandidate(db, { candidateId, decision: 'confirm', decidedBy: OWNER }),
    'E_CONFIRM_HASH_REQUIRED',
  )
}

// 3. reject：终态；之后 confirm 被拒。
{
  const db = await freshDb()
  const { candidateId } = await proposed(db)
  decideGrowthCandidate(db, { candidateId, decision: 'reject', decidedBy: OWNER })
  const row = db.prepare('SELECT status FROM growth_candidates WHERE candidate_id=?').get(candidateId) as { status: string }
  eq('status rejected', row.status, 'rejected')
  throws(
    'confirm rejected candidate',
    () => decideGrowthCandidate(db, { candidateId, decision: 'confirm', decidedBy: OWNER, expectedHash: 'x' }),
    'E_CANDIDATE_DECIDED',
  )
}

// 4. 已确认候选不再被 P5-3a 合并：新证据生成新候选。
{
  const db = await freshDb()
  const { candidateId, hash } = await proposed(db)
  decideGrowthCandidate(db, { candidateId, decision: 'confirm', decidedBy: OWNER, expectedHash: hash })
  const snapshot = db.prepare('SELECT statement FROM growth_candidates WHERE candidate_id=?').get(candidateId) as { statement: string }
  const source = addSource(db, { channel: 'web', origin: 'external', independence: 'ind_second', at: T2 })
  addFact(db, { sourceIds: [source], statement: '用户偏好清晨写作', at: T2 })
  const again = reflectGrowthCandidates(db, { now: new Date(Date.parse(T2) + 60_000), perContactDaily: 10, globalDaily: 10, candidateFilter: false })
  eq('new evidence -> new proposed', again.status, 'proposed')
  const confirmed = db.prepare('SELECT statement FROM growth_candidates WHERE candidate_id=?').get(candidateId) as { statement: string }
  eq('confirmed candidate untouched', confirmed.statement, snapshot.statement)
  eq('two candidates total', Number((db.prepare('SELECT COUNT(*) AS n FROM growth_candidates').get() as { n: number }).n), 2)
}

// 5. withdraw：投影移除；撤回后可再次确认被拒；重复撤回幂等。
{
  const db = await freshDb()
  const { candidateId, hash } = await proposed(db)
  decideGrowthCandidate(db, { candidateId, decision: 'confirm', decidedBy: OWNER, expectedHash: hash })
  decideGrowthCandidate(db, { candidateId, decision: 'withdraw', decidedBy: OWNER })
  eq('withdraw removes projection', readConfirmedGrowthChanges(db).length, 0)
  const row = db.prepare('SELECT status FROM growth_candidates WHERE candidate_id=?').get(candidateId) as { status: string }
  eq('status withdrawn', row.status, 'withdrawn')
  throws(
    'confirm after withdraw',
    () => decideGrowthCandidate(db, { candidateId, decision: 'confirm', decidedBy: OWNER, expectedHash: hash }),
    'E_CANDIDATE_DECIDED',
  )
}

// 6. contact scope 的已确认变化不跨域投影。
{
  const db = await freshDb()
  const source = addSource(db, { channel: 'private', sender: 'ct_a', origin: 'user' })
  addFact(db, { sourceIds: [source], statement: '用户最近在准备搬家' })
  const result = reflectGrowthCandidates(db, { now: T1, perContactDaily: 10, globalDaily: 10, candidateFilter: false })
  eq('contact candidate proposed', result.status, 'proposed')
  const row = db.prepare("SELECT candidate_id, scope FROM growth_candidates LIMIT 1").get() as { candidate_id: string; scope: string }
  eq('candidate scope contact', row.scope, 'contact:ct_a')
  const hash = growthCandidateContentHash(db, row.candidate_id).hash
  decideGrowthCandidate(db, { candidateId: row.candidate_id, decision: 'confirm', decidedBy: OWNER, expectedHash: hash })
  eq('contact scope not projected globally', readConfirmedGrowthChanges(db).length, 0)
}

// 7. Owner 标识必须是 os:。
{
  const db = await freshDb()
  const { candidateId, hash } = await proposed(db)
  throws(
    'decidedBy must be os identity',
    () => decideGrowthCandidate(db, { candidateId, decision: 'confirm', decidedBy: 'alice', expectedHash: hash }),
    'E_OWNER_UNVERIFIED',
  )
}

// 8. listGrowthCandidates 只列 proposed。
{
  const db = await freshDb()
  const { candidateId, hash } = await proposed(db)
  eq('list before confirm', listGrowthCandidates(db).length, 1)
  decideGrowthCandidate(db, { candidateId, decision: 'confirm', decidedBy: OWNER, expectedHash: hash })
  eq('list after confirm empty', listGrowthCandidates(db).length, 0)
}

// 9. 决策可作用的候选状态（CLI 撤回只查 confirmed/withdrawn）。
{
  eq('confirm targets proposed', decisionCandidateStatuses('confirm'), ['proposed'])
  eq('reject targets proposed', decisionCandidateStatuses('reject'), ['proposed'])
  eq('withdraw targets confirmed/withdrawn', decisionCandidateStatuses('withdraw'), ['confirmed', 'withdrawn'])
}

cleanup()
console.log(`[P5-3b growth-confirmation] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
