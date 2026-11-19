// P5-R-0 契约一致性回归（先失败、修正后通过）。
//
// 覆盖源码审计指出的四处缺口：
// 1. P5-6 删除事件必须贯通 Recall/最终检查的读取边界；
// 2. P5-3b 已确认成长投影前必须复核证据与确认哈希；
// 3. P5-2 投影预算必须按最终序列化字符串（含分隔符）计量；
// 4. P5-5 合并必须在事务内重新校验确定性重复条件。
//
// 跑法：node test/p5r-contract.ts（需要先 npm run build）
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '../packages/core/dist/adapter.js'
import {
  andHeadEvidenceSourcesActive,
  recordExternalSource,
  requestExternalSourceDeletion,
} from '../packages/core/dist/external-source.js'
import {
  decideGrowthCandidate,
  growthCandidateContentHash,
  readConfirmedGrowthChanges,
} from '../packages/core/dist/growth-confirmation.js'
import { mergeArtifacts } from '../packages/core/dist/memory-hygiene.js'
import { composeProjections } from '../dist/lib/projection-composer.js'

let passed = 0
let failed = 0
function check(label: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`ok ${label}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const log = { info() {}, debug() {}, warn() {}, error() {} }
const T0 = '2026-11-15T02:00:00.000Z'
const OWNER = 'os:S-1-5-21-1000'
const dirs: string[] = []
const opened: any[] = []
let seq = 0

async function freshDb(): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-p5r-'))
  dirs.push(dir)
  const handle = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
  opened.push(handle)
  migrate(handle.db, log)
  handle.db
    .prepare(
      "INSERT OR IGNORE INTO contacts (contact_id, persona_id, platform, stable_user_id, display_name, created_at, updated_at) VALUES ('ct_a','main','qq','u_a','A',?,?)",
    )
    .run(T0, T0)
  return handle.db
}

function addSource(db: any, channel = 'web'): string {
  seq += 1
  const id = `src_p5r_${seq}`
  db.prepare(
    `INSERT INTO sources
      (source_id, persona_id, platform, channel, origin, kind, text, independence_key, captured_at, created_at)
     VALUES (?, 'main', 'qq', ?, 'external', 'message', ?, ?, ?, ?)`,
  ).run(id, channel, `text ${id}`, `ind_${id}`, T0, T0)
  return id
}

function addArtifact(db: any, sourceId: string, statement: string, kind = 'fact'): string {
  seq += 1
  const artifactId = `art_p5r_${seq}`
  db.prepare("INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at) VALUES (?, 'main', ?, ?, ?)").run(
    artifactId,
    kind,
    T0,
    T0,
  )
  db.prepare(
    `INSERT INTO artifact_revisions
      (artifact_id, revision, state, statement, subject_refs, disclosure, confidence, salience,
       independent_evidence_count, created_at, updated_at)
     VALUES (?, 1, 'active', ?, '["user"]', 'public', 'medium', 0.1, 1, ?, ?)`,
  ).run(artifactId, statement, T0, T0)
  db.prepare(
    `INSERT INTO artifact_evidence (artifact_id, revision, source_id, relation, independence_key, created_at)
     VALUES (?, 1, ?, 'supports', ?, ?)`,
  ).run(artifactId, sourceId, `ev_${artifactId}`, T0)
  return artifactId
}

function recallable(db: any): number {
  return Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM artifacts a
             JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
              AND r.revision = (SELECT MAX(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
            WHERE ${andHeadEvidenceSourcesActive('a', 'r.revision')}`,
        )
        .get() as { n: number }
    ).n,
  )
}

async function main(): Promise<void> {
  // 1. 外部来源删除后，来源证据的 Artifact 不再可召回。
  await (async () => {
    const db = await freshDb()
    const external = addSource(db)
    const internal = addSource(db, 'desktop')
    recordExternalSource(db, {
      sourceId: external,
      kind: 'web',
      provenance: 'https://example.com/p5r',
      content: '林烬项目使用 SQLite。',
      scope: 'personal',
      disclosure: 'public',
      createdBy: OWNER,
      now: Date.parse(T0),
    })
    const externalArtifact = addArtifact(db, external, '外部来源结论。')
    const internalArtifact = addArtifact(db, internal, '内部来源结论。')
    check('deleted barrier: both recallable before delete', () => assert.equal(recallable(db), 2))
    requestExternalSourceDeletion(db, { sourceId: external, action: 'delete', by: OWNER })
    check('deleted barrier: external-source artifact hidden', () => assert.equal(recallable(db), 1))
    check('deleted barrier: internal-source artifact kept', () => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM artifacts a
             JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
              AND r.revision = (SELECT MAX(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
            WHERE a.artifact_id = ? AND ${andHeadEvidenceSourcesActive('a', 'r.revision')}`,
        )
        .get(internalArtifact) as { n: number }
      assert.equal(Number(row.n), 1)
    })
    check('deleted barrier: deleted artifact row still exists', () =>
      assert.equal(
        Number((db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE artifact_id = ?').get(externalArtifact) as { n: number }).n),
        1,
      ))
    await Promise.resolve()
  })()

  // 2. 已确认成长在投影前复核：证据删除或内容被改后不再出现。
  await (async () => {
    const db = await freshDb()
    const source = addSource(db)
    recordExternalSource(db, {
      sourceId: source,
      kind: 'web',
      provenance: 'https://example.com/growth',
      content: '用户偏好简洁回答。',
      scope: 'personal',
      disclosure: 'public',
      createdBy: OWNER,
      now: Date.parse(T0),
    })
    db.prepare(
      `INSERT INTO growth_reflections
        (reflection_id, persona_id, trigger_key, status, attempt, source_count, candidate_count,
         scope, started_at, finished_at, error_reason, next_eligible_at, created_at, updated_at)
       VALUES ('grf_p5r','main','tk_p5r','proposed',1,1,1,'personal',?,?,NULL,NULL,?,?)`,
    ).run(T0, T0, T0, T0)
    db.prepare(
      `INSERT INTO growth_candidates
        (candidate_id, persona_id, reflection_id, semantic_key, type, subject_refs, predicate,
         statement, scope, status, independent_count, created_at, updated_at)
       VALUES ('gca_p5r','main','grf_p5r','sk_p5r','new_fact','["user"]','prefers','用户偏好简洁回答。','personal','proposed',1,?,?)`,
    ).run(T0, T0)
    db.prepare(
      `INSERT INTO growth_candidate_sources (candidate_id, source_id, independence_key, created_at)
       VALUES ('gca_p5r', ?, 'ind_g', ?)`,
    ).run(source, T0)
    const { hash } = growthCandidateContentHash(db, 'gca_p5r')
    decideGrowthCandidate(db, { candidateId: 'gca_p5r', decision: 'confirm', decidedBy: OWNER, expectedHash: hash, now: new Date(T0) })
    check('confirmed growth visible with live evidence', () => assert.equal(readConfirmedGrowthChanges(db).length, 1))
    db.prepare("UPDATE growth_candidates SET statement='用户偏好长篇回答。' WHERE candidate_id='gca_p5r'").run()
    check('confirmed growth hidden after content drift', () => assert.equal(readConfirmedGrowthChanges(db).length, 0))
    db.prepare("UPDATE growth_candidates SET statement='用户偏好简洁回答。' WHERE candidate_id='gca_p5r'").run()
    requestExternalSourceDeletion(db, { sourceId: source, action: 'delete', by: OWNER })
    check('confirmed growth hidden after evidence deleted', () => assert.equal(readConfirmedGrowthChanges(db).length, 0))
    await Promise.resolve()
  })()

  // 3. 预算按最终序列化字符串计量，分隔符不能把结果推出预算。
  check('composer budget counts separators', () => {
    const discipline = 'd'.repeat(10)
    const persona = 'p'.repeat(10)
    const growth = 'g'.repeat(10)
    const mood = 'm'.repeat(10)
    const budget = { maxChars: 10 * 4 + 4, maxTokens: 10_000 }
    const result = composeProjections(
      {
        memoryDiscipline: discipline,
        persona: { text: persona, enabled: true },
        growth: { text: growth, enabled: true },
        mood: { text: mood, enabled: true },
        relationship: { text: '', enabled: false },
      },
      budget,
    )
    assert.ok(result.text.length <= budget.maxChars, `text ${result.text.length} > ${budget.maxChars}`)
    assert.equal(result.usedChars, result.text.length)
    assert.ok(result.dropped.includes('mood'), `dropped=${result.dropped.join(',')}`)
  })

  // 4. 合并必须重新校验确定性重复条件，不能只凭两个 ID。
  await (async () => {
    const db = await freshDb()
    const source = addSource(db)
    const a = addArtifact(db, source, '同一条结论。')
    const b = addArtifact(db, source, '同一条结论。')
    const c = addArtifact(db, source, '另一条结论。')
    check('merge rejects non-duplicate pair', () =>
      assert.throws(() => mergeArtifacts(db, a, c, { by: OWNER }), /E_NOT_DUPLICATE/))
    check('merge accepts duplicate pair', () => {
      const result = mergeArtifacts(db, a, b, { by: OWNER })
      assert.equal(result.merged, true)
    })
    await Promise.resolve()
  })()

  for (const handle of opened) {
    try {
      handle.close?.()
    } catch {
      /* 已关闭 */
    }
  }
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 偶发句柄未释放；临时目录留给系统清理 */
    }
  }
  console.log(`[P5-R-0 p5r-contract] ${passed} 通过 ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
