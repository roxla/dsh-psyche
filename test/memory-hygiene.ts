// P5-5 记忆整理测试（append-only 事件账本）。
//
// 验收口径（docs/design/p5-5-memory-hygiene.md）：
// - 同 kind/statement/subjectRefs 还必须同可见域与 disclosure 才能合并；
// - 合并只写事件、不搬 evidence，一个 duplicate 只能一个 canonical，禁自合并/链式；
// - archive 从默认召回排除、restore 恢复；canonical 归档不自动恢复 duplicate；
// - 当前态按最大事件 id 判定，操作幂等；
// - stale 只给候选，受保护类型（stance/relationship）不进入；
// - 写操作要求 os:<SID/UID>。
//
// 跑法：node test/memory-hygiene.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../packages/core/dist/adapter.js'
import {
  andMemoryActive,
  archiveArtifact,
  findDuplicateClusters,
  findStaleCandidates,
  listArchived,
  listMergedDuplicates,
  mergeArtifacts,
  restoreArtifact,
  unmergeArtifacts,
} from '../packages/core/dist/memory-hygiene.js'

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
const OWNER = 'os:S-1-5-21-1000'
const dirs: string[] = []

async function freshDb(): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-memory-hygiene-'))
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
function addSource(
  db: any,
  input: { channel: string; sender?: string | null; room?: string | null; origin?: 'user' | 'external' | 'self'; at?: string },
): string {
  seq += 1
  const id = `src_m${seq}`
  const at = input.at ?? T0
  db.prepare(
    `INSERT INTO sources
      (source_id, persona_id, platform, channel, room_id, sender_contact_id, origin, kind, text,
       independence_key, captured_at, created_at)
     VALUES (?, 'main', 'qq', ?, ?, ?, ?, 'message', ?, ?, ?, ?)`,
  ).run(id, input.channel, input.room ?? null, input.sender ?? null, input.origin ?? 'user', `text ${id}`, `ind_${id}`, at, at)
  return id
}

function addArtifact(
  db: any,
  input: { kind?: string; statement: string; sourceId: string; disclosure?: string; at?: string },
): string {
  seq += 1
  const artifactId = `art_m${seq}`
  const at = input.at ?? T0
  db.prepare('INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at) VALUES (?, \'main\', ?, ?, ?)').run(
    artifactId,
    input.kind ?? 'fact',
    at,
    at,
  )
  db.prepare(
    `INSERT INTO artifact_revisions
      (artifact_id, revision, state, statement, subject_refs, disclosure, confidence, salience,
       independent_evidence_count, created_at, updated_at)
     VALUES (?, 1, 'active', ?, '["user"]', ?, 'medium', 0.1, 1, ?, ?)`,
  ).run(artifactId, input.statement, input.disclosure ?? 'public', at, at)
  db.prepare(
    `INSERT INTO artifact_evidence (artifact_id, revision, source_id, relation, independence_key, created_at)
     VALUES (?, 1, ?, 'supports', ?, ?)`,
  ).run(artifactId, input.sourceId, `ev_${artifactId}`, at)
  return artifactId
}

function activeCount(db: any): number {
  return Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM artifacts a WHERE 1=1 ${andMemoryActive('a')}`).get() as { n: number }).n,
  )
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

// 1. 同可见域/同披露 → 发现重复簇；合并后 duplicate 移出默认召回。
{
  const db = await freshDb()
  const src = addSource(db, { channel: 'web' })
  const canonical = addArtifact(db, { statement: '用户偏好清晨写作', sourceId: src })
  const duplicate = addArtifact(db, { statement: '用户偏好清晨写作', sourceId: src })
  const clusters = findDuplicateClusters(db)
  eq('one duplicate cluster', clusters.length, 1)
  eq('canonical is first by evidence/time/id', clusters[0].canonicalId, canonical)
  eq('duplicate listed', clusters[0].duplicates, [duplicate])
  eq('before merge both active', activeCount(db), 2)
  const merged = mergeArtifacts(db, canonical, duplicate, { by: OWNER })
  eq('merged ok', merged.merged, true)
  eq('after merge one active', activeCount(db), 1)
  eq('duplicate listed as merged', listMergedDuplicates(db), [duplicate])
  eq('merge idempotent', mergeArtifacts(db, canonical, duplicate, { by: OWNER }).already, true)
  throws('self merge rejected', () => mergeArtifacts(db, canonical, canonical, { by: OWNER }), 'E_MERGE_SELF')
  throws(
    'chain rejected',
    () => {
      seq += 1
      const third = addArtifact(db, { statement: '用户偏好清晨写作', sourceId: src })
      mergeArtifacts(db, duplicate, third, { by: OWNER })
    },
    'E_MERGE_CHAIN',
  )
}

// 2. 跨可见域 / 不同披露 → 不合并、不出簇。
{
  const db = await freshDb()
  const personal = addSource(db, { channel: 'web' })
  const contact = addSource(db, { channel: 'private', sender: 'ct_a', origin: 'user' })
  addArtifact(db, { statement: '用户喜欢雨天', sourceId: personal })
  addArtifact(db, { statement: '用户喜欢雨天', sourceId: contact })
  eq('cross-scope not clustered', findDuplicateClusters(db).length, 0)
  const a = addArtifact(db, { statement: '用户讨厌噪音', sourceId: personal })
  const b = addArtifact(db, { statement: '用户讨厌噪音', sourceId: personal, disclosure: 'restricted' })
  eq('different disclosure not clustered', findDuplicateClusters(db).length, 0)
  throws('cross disclosure merge rejected', () => mergeArtifacts(db, a, b, { by: OWNER }), 'E_SCOPE_MISMATCH')
}

// 3. archive/restore 与 canonical 归档语义。
{
  const db = await freshDb()
  const src = addSource(db, { channel: 'web' })
  const canonical = addArtifact(db, { statement: '用户作息偏晚', sourceId: src })
  const duplicate = addArtifact(db, { statement: '用户作息偏晚', sourceId: src })
  mergeArtifacts(db, canonical, duplicate, { by: OWNER })
  eq('archived none', listArchived(db), [])
  archiveArtifact(db, canonical, { by: OWNER })
  eq('canonical archived listed', listArchived(db), [canonical])
  eq('canonical archive does not restore duplicate', activeCount(db), 0)
  eq('duplicate still merged', listMergedDuplicates(db), [duplicate])
  restoreArtifact(db, canonical, { by: OWNER })
  eq('restore keeps merged duplicate excluded', activeCount(db), 1)
  eq('archived empty after restore', listArchived(db), [])
}

// 4. unmerge 恢复 duplicate；Owner 校验。
{
  const db = await freshDb()
  const src = addSource(db, { channel: 'web' })
  const canonical = addArtifact(db, { statement: '用户爱喝乌龙茶', sourceId: src })
  const duplicate = addArtifact(db, { statement: '用户爱喝乌龙茶', sourceId: src })
  mergeArtifacts(db, canonical, duplicate, { by: OWNER })
  eq('unmerge ok', unmergeArtifacts(db, canonical, duplicate, { by: OWNER }).unmerged, true)
  eq('after unmerge both active', activeCount(db), 2)
  eq('unmerge again idempotent', unmergeArtifacts(db, canonical, duplicate, { by: OWNER }).already, true)
  throws('owner required', () => mergeArtifacts(db, canonical, duplicate, { by: 'windows' }), 'E_OWNER_UNVERIFIED')
}

// 5. stale 只给候选、保护类型排除。
{
  const db = await freshDb()
  const src = addSource(db, { channel: 'web', at: '2026-01-01T00:00:00.000Z' })
  const old = addArtifact(db, { statement: '用户在旧项目里用 Python', sourceId: src, at: '2026-01-01T00:00:00.000Z' })
  addArtifact(db, { kind: 'stance', statement: '用户反对远程办公', sourceId: src, at: '2026-01-01T00:00:00.000Z' })
  addArtifact(db, { statement: '用户最近提到的新事', sourceId: src, at: '2026-11-01T00:00:00.000Z' })
  const stale = findStaleCandidates(db, { now: new Date('2026-11-15T00:00:00.000Z'), days: 180 })
  eq('stale finds old fact', stale.map((row) => row.artifactId), [old])
  ok('stale does not include stance', stale.every((row) => row.kind !== 'stance'))
}

cleanup()
console.log(`[P5-5 memory-hygiene] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
