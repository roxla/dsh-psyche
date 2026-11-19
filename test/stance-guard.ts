// Stage 3.6：正式立场的写入口保护（P2 Completion Batch）。
//
// 结论：stance 的正文只能由 Core 的 StanceEngine 写。三个普通入口都必须封死：
// - remember(kind='stance')                 → E_VALIDATION（原本就有，这里做回归）
// - revise(supersedes, kind='stance')       → E_VALIDATION（原本就有，这里做回归）
// - revise(artifactId=stance)               → E_VALIDATION（本次补的缺口）
// - review(stance, statement=...)           → E_VALIDATION（本次补的缺口）
// 同时验证 review 仍然可以「判状态、不改字」：verdict=challenged 能把 active 打成 challenged，
// 且新 revision 的 statement 与 head 完全一致。
//
// 跑法：node test/stance-guard.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Core } from '../dist/lib/store.js'
import { openDatabase, migrate } from '../dist/lib/adapter.js'

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

async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : null
  }
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-stance-guard-'))
const log = { info() {}, debug() {}, warn: (m: string) => console.log('WARN', m), error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, logger: log, dataDir: dir })

console.log('\n[Stance Guard] 普通入口不能创建或改写正式立场')

// 一条真实来源，供 review 使用（review 需要非自身来源）
const source = (await core.capture({ text: '我还是挺喜欢乌龙茶的。', platform: 'desktop', sessionRef: 'sg-1' })).sourceId

// --- 1. remember 不能直接记 stance（回归） ---
const rememberStance = await codeOf(() =>
  core.remember({ text: '我喜欢乌龙茶。', statement: '用户喜欢乌龙茶。', kind: 'stance', sourceIds: [source] }),
)
ok('remember(kind=stance) 被拒绝', rememberStance === 'E_VALIDATION', rememberStance)

// --- 2. revise supersedes 不能新建 stance（回归） ---
const belief = await core.remember({
  statement: '用户喜欢喝乌龙茶。',
  kind: 'belief',
  subjectRefs: ['topic:tea'],
  sourceIds: [source],
  disclosure: 'public',
})
const reviseStance = await codeOf(() =>
  core.revise({
    supersedes: belief.artifactId,
    kind: 'stance',
    text: '用户偏爱轻发酵茶。',
    refs: [source],
  }),
)
ok('revise(supersedes, kind=stance) 被拒绝', reviseStance === 'E_VALIDATION', reviseStance)

// --- 3. 造一条 stance（模拟 Core 内部合成结果；这里直接落库，绕过模型入口） ---
const stanceId = 'art_stance_guard'
const now = new Date().toISOString()
db.run(
  `INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at) VALUES (?, 'main', 'stance', ?, ?)`,
  [stanceId, now, now],
)
db.run(
  `INSERT INTO artifact_revisions
     (artifact_id, revision, state, statement, subject_refs, payload, confidence,
      basis_count, independent_evidence_count, salience, temporal, direct_extraction, created_at, updated_at, schema_version)
   VALUES (?, 1, 'active', ?, '["topic:tea"]', '{}', 'high', 2, 2, 0, '{}', 0, ?, ?, '1.0')`,
  [stanceId, '用户偏爱轻发酵、清香的茶。', now, now],
)
const stanceRow = db.get(
  `SELECT statement, state FROM artifact_revisions WHERE artifact_id = ? ORDER BY revision DESC LIMIT 1`,
  [stanceId],
)
ok('stance 夹具已落库（active）', stanceRow?.state === 'active', stanceRow)

// --- 4. revise(artifactId=stance) 被拒绝，且 head 不变 ---
const reviseSameId = await codeOf(() =>
  core.revise({ artifactId: stanceId, text: '用户其实喜欢重焙火。', refs: [source] }),
)
ok('revise(artifactId=stance) 被拒绝', reviseSameId === 'E_VALIDATION', reviseSameId)
const afterRevise = db.get(
  `SELECT revision, statement FROM artifact_revisions WHERE artifact_id = ? ORDER BY revision DESC LIMIT 1`,
  [stanceId],
)
ok('被拒后仍是最初那一版', afterRevise?.revision === 1 && afterRevise?.statement === '用户偏爱轻发酵、清香的茶。', afterRevise)

// --- 5. review 不能借 statement 改写立场正文 ---
const reviewRewrite = await codeOf(() =>
  core.review({ artifactId: stanceId, verdict: 'confirmed', statement: '用户喜欢所有茶。', sourceIds: [source] }),
)
ok('review(stance, statement) 被拒绝', reviewRewrite === 'E_VALIDATION', reviewRewrite)
const afterReviewRewrite = db.get(
  `SELECT revision, statement FROM artifact_revisions WHERE artifact_id = ? ORDER BY revision DESC LIMIT 1`,
  [stanceId],
)
ok('被拒后没有多出 revision', afterReviewRewrite?.revision === 1, afterReviewRewrite)

// --- 6. review 可以「判状态、不改字」 ---
const reviewState = await core.review({
  artifactId: stanceId,
  verdict: 'challenged',
  note: '这版立场依据不足',
  sourceIds: [source],
})
ok('review(stance) 允许改状态', reviewState.revision === 2, reviewState)
const afterReviewState = db.get(
  `SELECT revision, state, statement FROM artifact_revisions WHERE artifact_id = ? ORDER BY revision DESC LIMIT 1`,
  [stanceId],
)
ok('新版本状态是 challenged', afterReviewState?.state === 'challenged', afterReviewState)
ok('新版本正文与 head 完全一致', afterReviewState?.statement === '用户偏爱轻发酵、清香的茶。', afterReviewState)

db.close()
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  // Windows 上句柄释放可能有延迟，清理失败不影响结论
}

console.log(`\n[Stance Guard] ${passed} 通过 ${failed} 失败\n`)
process.exit(failed === 0 ? 0 : 1)
