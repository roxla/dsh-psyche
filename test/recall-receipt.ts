// P2-Recall R4-B：Recall Receipt（RC-01~40）。
//
// 验收口径（用户 m19206 冻结）：
// - 回执只回答「这次召回问什么、谁被看见、谁被拒、为什么」，不存原文；
// - query_hash / scope_hash 是本地密钥 HMAC，密钥文件不进普通备份；
// - raw_rank 与 final_rank 分开记；
// - composition_status 四态：主动 Recall = not_applicable，自动注入 = pending（R4-C 回填）；
// - 回执不注册工具、不把受限候选复述进候选表（被 SQL 挡掉的不可见记忆没有行）；
// - 30 天保留，清理时 run 与 candidates 级联删除。
//
// 跑法：node test/recall-receipt.ts（需要先 npm run build）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { PreStepInjector } from '../dist/lib/pre-step-injection.js'
import { RuntimeInputStore, createHostBindingCapability } from '../dist/lib/runtime-input.js'
import {
  cleanupRecallRuns,
  listRecallCandidates,
  listRecallRuns,
  RECALL_HMAC_KEY_PATH,
} from '../dist/lib/recall-receipt.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-receipt-'))
const warnings: string[] = []
const log = {
  info() {},
  debug() {},
  warn(message: string) {
    warnings.push(message)
  },
  error() {},
}
const openDb = async (target: string) => {
  const opened = await openDatabase({ file: join(target, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
  migrate(opened.db, log)
  return opened
}
const opened = await openDb(dir)
const db = opened.db
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

console.log('\n[P2-Recall R4-B] Recall Receipt')

const now = new Date().toISOString()
for (const contactId of ['ct_alice', 'ct_bob']) {
  db.run(
    `INSERT INTO contacts (contact_id, persona_id, platform, stable_user_id, created_at, updated_at)
     VALUES (?, 'main', 'qq', ?, ?, ?)`,
    [contactId, contactId, now, now],
  )
}

let sourceSeq = 0

async function source(text: string, channel: 'desktop' | 'private' = 'desktop', senderContactId?: string): Promise<string> {
  sourceSeq += 1
  const captured = await core.capture({
    platform: 'dsh',
    channel,
    sessionRef: `rc-s${sourceSeq}`,
    origin: 'user',
    kind: 'message',
    ...(senderContactId === undefined ? {} : { senderContactId }),
    text,
  })
  return captured.sourceId
}

async function fact(
  text: string,
  options: { disclosure?: 'public' | 'restricted' | 'secret'; channel?: 'desktop' | 'private'; contactId?: string } = {},
): Promise<string> {
  const channel = options.channel ?? 'desktop'
  const a = await source(text, channel, options.contactId)
  const b = await source(`${text}（补充确认）`, channel, options.contactId)
  const remembered = await core.remember({
    text,
    kind: 'fact',
    statement: text,
    sourceIds: [a, b],
    disclosure: options.disclosure ?? 'public',
    ...(options.contactId === undefined ? {} : { subjectRefs: [options.contactId] }),
  })
  if (!remembered.artifactId) throw new Error(`未升格：${JSON.stringify(remembered)}`)
  return remembered.artifactId
}

// ── 1. schema v11 ────────────────────────────────────────────────────────
const version = db.get('PRAGMA user_version')
eq('RC-01 schema 版本是 42', Number(version?.user_version ?? version?.value ?? 0), 42)
const tables = db.all(
  `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('recall_runs', 'recall_candidates')`,
)
eq('RC-02 回执两表存在', tables.length, 2)
const business = db.get(
  `SELECT COUNT(*) AS n FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB 'fts_index_*' AND name <> 'fts_index'`,
)
eq('RC-03 当前业务表81', Number(business?.n ?? 0), 81)

// ── 2. 主动 Recall 生成回执 ─────────────────────────────────────────────
const SENTINEL_QUERY = '绿皮火车夜行哨兵'
const publicId = await fact(SENTINEL_QUERY)
const restrictedId = await fact(`${SENTINEL_QUERY} 受限变体`, { disclosure: 'restricted' })
const recalled = await core.recall({ text: SENTINEL_QUERY }, { surface: 'personal' })
ok('RC-04 公开结论被召回', recalled.results.some((item) => item.artifactId === publicId))
ok('RC-05 受限结论不返回', !JSON.stringify(recalled).includes(restrictedId))

const runs = listRecallRuns(db, 10)
eq('RC-06 写了一条召回回执', runs.length, 1)
const run = runs[0]!
eq('RC-07 query_mode=recall', run.queryMode, 'recall')
eq('RC-08 主动 Recall 不经过 Composer', run.compositionStatus, 'not_applicable')
eq('RC-09 abstained=0', run.abstained, false)
eq('RC-10 key_version=1', run.keyVersion, 1)
ok('RC-11 query_hash 是 64 位十六进制', /^[0-9a-f]{64}$/u.test(run.queryHash ?? ''), run.queryHash)
eq('RC-12 scope_type=personal', run.scopeType, 'personal')
ok('RC-13 scope_hash 是 64 位十六进制', /^[0-9a-f]{64}$/u.test(run.scopeHash ?? ''), run.scopeHash)
ok('RC-14 回执不含查询原文', !JSON.stringify(runs).includes(SENTINEL_QUERY), runs)
ok('RC-15 回执不含受限正文', !JSON.stringify(runs).includes('受限变体'), runs)
// searchFts 在 SQL 里就按 disclosure 过滤，受限条目不进命中——回执也不复述它。
eq('RC-16 计数：matched/eligible/returned', [run.matchedCount, run.eligibleCount, run.returnedCount], [1, 1, 1])

const candidates = listRecallCandidates(db, run.runId)
eq('RC-17 候选数=命中数（受限行没有候选行）', candidates.length, 1)
const publicRow = candidates.find((row) => row.artifactId === publicId)
ok('RC-18 公开候选 eligible', publicRow?.eligible === true)
eq('RC-19 公开候选 final_rank=1', publicRow?.finalRank, 1)
ok('RC-20 公开候选 raw_rank 是正数', (publicRow?.rawRank ?? 0) > 0, publicRow)
ok('RC-21 回执不含受限 artifact id', !JSON.stringify(candidates).includes(restrictedId), candidates)
ok('RC-22 回执不含受限正文片段', !JSON.stringify(candidates).includes('受限变体'), candidates)

// ── 3. abstention 也写回执 ──────────────────────────────────────────────
const empty = await core.recall({ text: '完全没有出现过的词 zzz' }, { surface: 'personal' })
eq('RC-25 无命中 abstained', empty.abstained, true)
const emptyRuns = listRecallRuns(db, 10)
const emptyRun = emptyRuns.find((item) => item.abstained)
ok('RC-26 abstention 写了一条回执', emptyRun !== undefined)
eq('RC-27 abstention 计数全 0', [emptyRun?.matchedCount, emptyRun?.eligibleCount, emptyRun?.returnedCount], [0, 0, 0])

// ── 4. 密钥与哈希稳定性 ─────────────────────────────────────────────────
const keyPath = join(dir, RECALL_HMAC_KEY_PATH)
ok('RC-28 密钥文件已创建', existsSync(keyPath))
eq('RC-29 密钥长度 32 字节', readFileSync(keyPath).length, 32)
const firstHash = run.queryHash
await core.recall({ text: SENTINEL_QUERY }, { surface: 'personal' })
const sameHashRuns = listRecallRuns(db, 20).filter((item) => item.queryHash === firstHash)
ok('RC-30 同一查询两次哈希一致', sameHashRuns.length >= 2, sameHashRuns.length)
eq('RC-31 密钥文件未被覆盖', readFileSync(keyPath).length, 32)
const scopeHash = run.scopeHash
await core.recall({ text: SENTINEL_QUERY }, { contactId: 'ct_alice', surface: 'private' })
const scopedRun = listRecallRuns(db, 20).find((item) => item.scopeType === 'private')
ok('RC-32 不同 Scope 产生不同 scope_hash', scopedRun?.scopeHash !== scopeHash, scopedRun?.scopeHash)
eq('RC-33 不同 Scope 的 query_hash 仍相同', scopedRun?.queryHash, firstHash)

// ── 5. 密钥损坏不退化 ───────────────────────────────────────────────────
const brokenDir = mkdtempSync(join(tmpdir(), 'psyche-receipt-broken-'))
const broken = await openDb(brokenDir)
const brokenCore = new Core({ db: broken.db, config: {}, logger: log, dataDir: brokenDir })
mkdirSync(join(brokenDir, 'secret'), { recursive: true })
writeFileSync(join(brokenDir, RECALL_HMAC_KEY_PATH), Buffer.from('abc'))
const before = warnings.length
await brokenCore.recall({ text: '密钥坏掉时的召回' }, { surface: 'personal' })
ok('RC-34 密钥损坏不阻断召回', true)
eq('RC-35 密钥损坏时回执不落库', listRecallRuns(broken.db, 10).length, 0)
ok('RC-36 密钥损坏有 warn', warnings.length > before, warnings.slice(before))
sqlClose(broken.db)

// ── 6. 清理与级联 ───────────────────────────────────────────────────────
const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
db.run(
  `INSERT INTO recall_runs (run_id, request_id, persona_id, query_hash, query_mode, scope_type, scope_hash,
     requested_limit, matched_count, eligible_count, returned_count, abstained, composition_status, key_version, created_at)
   VALUES ('run_old', NULL, 'main', 'h', 'recall', 'global', 's', 8, 1, 1, 1, 0, 'not_applicable', 1, ?)`,
  [old],
)
db.run(
  `INSERT INTO recall_candidates (run_id, artifact_id, revision, raw_rank, eligible, reject_reason, final_rank)
   VALUES ('run_old', 'art_old', 1, 1, 1, NULL, 1)`,
)
const removed = cleanupRecallRuns(db, { retentionDays: 30 })
ok('RC-37 清理删除过期 run', removed >= 1, removed)
eq('RC-38 候选随 run 级联删除', db.get(`SELECT COUNT(*) AS n FROM recall_candidates WHERE run_id = 'run_old'`)?.n, 0)

// ── 7. 自动注入写 pending 回执 ──────────────────────────────────────────
const runtimeInputs = new RuntimeInputStore()
const injector = new PreStepInjector({ db, runtimeInputs, receipt: { dataDir: dir } })
const sessionId = `rc-session-${Date.now()}`
const agent = { id: sessionId, session: { id: sessionId } }
runtimeInputs.bind(createHostBindingCapability({ sessionId, platform: 'dsh', adapterId: null }), {
  platform: 'dsh',
  stableUserId: 'owner-rc',
  contactId: null,
  sessionId,
  trustedSource: 'host',
})
const beforeCount = listRecallRuns(db, 50).length
const injected = injector.inject(agent, [{ role: 'user', content: SENTINEL_QUERY }], { turn: 1, step: 1 })
ok('RC-39 自动注入成功', injected.injected)
const afterRuns = listRecallRuns(db, 50)
eq('RC-40 多了一条 pre-step 回执', afterRuns.length, beforeCount + 1)
const preStepRun = afterRuns.find((item) => item.queryMode === 'pre-step')
eq('RC-41 自动注入回填后 composition_status=completed', preStepRun?.compositionStatus, 'completed')
eq('RC-42 自动注入 abstained=0', preStepRun?.abstained, false)
const preStepCandidates = listRecallCandidates(db, preStepRun!.runId)
ok('RC-43 自动注入候选有 final_rank', preStepCandidates.some((row) => row.finalRank !== null), preStepCandidates)

// ── 8. 收尾 ─────────────────────────────────────────────────────────────
sqlClose(db)
rmSync(dir, { recursive: true, force: true })
rmSync(brokenDir, { recursive: true, force: true })
sqlClose(broken.db)

function sqlClose(handle: { close(): void }): void {
  try {
    handle.close()
  } catch {
    // 已关闭或驱动不支持重复关闭
  }
}

console.log(`\n[P2-Recall R4-B] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
