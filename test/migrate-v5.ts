// P2-FTS5 E3 第二批：真实 v5 → v6 快照迁移（V5-01~12）。
//
// 关键点：不是把 v6 库的 user_version 改成 5，而是用 schema.ts 里真实的 v1–v5 迁移 SQL
// 重建一个 v5 库，再按真实启动路径 openDatabase() 走到 v6。迁移前后做聚合比较，不保存正文。
//
// 跑法：node test/migrate-v5.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { nowIso, openDatabase } from '../dist/lib/adapter.js'
import { MIGRATIONS } from '../dist/lib/schema.js'
import { rebuildFtsIndex, searchFts, verifyFtsIndex } from '../dist/lib/fts.js'

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
const AT = '2026-11-01T00:00:00.000Z'

function run(handle, sql, params = []) {
  handle.prepare(sql).run(...params)
}

/** 用真实 v1–v5 SQL 建一个 v5 库，再插入覆盖各 kind / state / 关系的夹具数据。 */
function makeV5({ addDisclosureColumn = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-v5-'))
  const file = join(dir, 'memory.sqlite3')
  const handle = new DatabaseSync(file)
  handle.exec('PRAGMA journal_mode = WAL')
  const seedStore = { run: (sql, params) => run(handle, sql, params) }
  for (const migration of MIGRATIONS) {
    if (migration.version > 5) break
    handle.exec(migration.sql)
    migration.seed?.(seedStore, nowIso())
  }
  handle.exec('PRAGMA user_version = 5')

  // sources（activity_window_key 留空，避免再建窗口夹具）
  run(
    handle,
    `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at)
     VALUES (?, 'main', 'dsh', 'desktop', 'v5-s1', 'user', 'message', '用户每天散步记录步数。', ?, ?)`,
    ['src_v5_1', AT, AT],
  )
  run(
    handle,
    `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at)
     VALUES (?, 'main', 'dsh', 'desktop', 'v5-s2', 'user', 'message', '用户喜欢在晚上听雨。', ?, ?)`,
    ['src_v5_2', AT, AT],
  )

  // events
  run(
    handle,
    `INSERT INTO events (event_id, persona_id, kind, type, at, subject_refs, text, confidence, created_at)
     VALUES ('evt_v5_1', 'main', 'interaction', 'conversation', ?, '["main"]', '用户提到每天散步。', 'medium', ?)`,
    [AT, AT],
  )
  run(
    handle,
    `INSERT INTO events (event_id, persona_id, kind, type, at, subject_refs, text, confidence, created_at)
     VALUES ('evt_v5_2', 'main', 'interaction', 'conversation', ?, '["main"]', '用户提到喜欢听雨。', 'medium', ?)`,
    [AT, AT],
  )
  run(handle, `INSERT INTO event_sources (event_id, source_id) VALUES ('evt_v5_1', 'src_v5_1')`)
  run(handle, `INSERT INTO event_sources (event_id, source_id) VALUES ('evt_v5_2', 'src_v5_2')`)

  // artifacts + revisions（A: fact 两版 active；B: belief challenged；C: stance active）
  const insertArtifact = (id, kind) =>
    run(handle, `INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at) VALUES (?, 'main', ?, ?, ?)`, [
      id,
      kind,
      AT,
      AT,
    ])
  const insertRevision = (id, revision, state, statement) =>
    run(
      handle,
      `INSERT INTO artifact_revisions (artifact_id, revision, state, statement, subject_refs, payload, confidence,
         basis_count, independent_evidence_count, salience, temporal, direct_extraction, created_at, updated_at, schema_version)
       VALUES (?, ?, ?, ?, '["main"]', '{}', 'medium', 1, 1, 0.5, '{}', 0, ?, ?, '1.0')`,
      [id, revision, state, statement, AT, AT],
    )
  insertArtifact('art_v5_a', 'fact')
  insertRevision('art_v5_a', 1, 'superseded', '用户每天散步（旧说法）。')
  insertRevision('art_v5_a', 2, 'active', '用户每天散步记录步数。')
  insertArtifact('art_v5_b', 'belief')
  insertRevision('art_v5_b', 1, 'challenged', '用户喜欢在晚上听雨。')
  insertArtifact('art_v5_c', 'stance')
  insertRevision('art_v5_c', 1, 'active', '用户重视稳定的作息。')

  // evidence（A r2、B r1）
  run(
    handle,
    `INSERT INTO artifact_evidence (artifact_id, revision, source_id, relation, quote, confidence, independence_key, created_at)
     VALUES ('art_v5_a', 2, 'src_v5_1', 'supports', '每天散步记录步数', 'medium', 'ik_v5_1', ?)`,
    [AT],
  )
  run(
    handle,
    `INSERT INTO artifact_evidence (artifact_id, revision, source_id, relation, quote, confidence, independence_key, created_at)
     VALUES ('art_v5_b', 1, 'src_v5_2', 'supports', '喜欢在晚上听雨', 'medium', 'ik_v5_2', ?)`,
    [AT],
  )

  // operations（成功 + 失败各一条）
  run(
    handle,
    `INSERT INTO operations (op_id, persona_id, tool, args_hash, status, result, duration_ms, source, created_at, finished_at)
     VALUES ('op_v5_ok', 'main', 'psyche_remember', 'hash-ok', 'ok', '{"sourceId":"src_v5_1"}', 12, 'tool', ?, ?)`,
    [AT, AT],
  )
  run(
    handle,
    `INSERT INTO operations (op_id, persona_id, tool, args_hash, status, error, duration_ms, source, created_at, finished_at)
     VALUES ('op_v5_failed', 'main', 'psyche_remember', 'hash-failed', 'failed', '夹具失败记录', 8, 'tool', ?, ?)`,
    [AT, AT],
  )

  // v5 时代已存在的旧 FTS 索引行
  run(handle, `INSERT INTO fts_index (kind, ref_id, bigram_text, raw_text) VALUES ('artifact', 'art_v5_a', '散步', '用户每天散步记录步数。')`)
  run(handle, `INSERT INTO fts_index (kind, ref_id, bigram_text, raw_text) VALUES ('artifact', 'art_v5_b', '晚上 听雨', '用户喜欢在晚上听雨。')`)

  if (addDisclosureColumn) {
    // 让 v6 的 ALTER 撞上重复列，验证迁移失败会整笔回滚
    handle.exec(`ALTER TABLE artifact_revisions ADD COLUMN disclosure TEXT`)
  }

  handle.close()
  return { dir, file }
}

/** 聚合比较：只保存计数和 ID 级结构，不碰正文。 */
function snapshot(db, userVersion) {
  const count = (table) => db.get(`SELECT count(*) AS n FROM ${table}`).n
  return {
    userVersion: userVersion ?? (typeof db.pragma === 'function' ? Number(db.pragma('user_version') ?? 0) : 0),
    artifacts: count('artifacts'),
    revisions: count('artifact_revisions'),
    sources: count('sources'),
    events: count('events'),
    evidence: count('artifact_evidence'),
    operations: count('operations'),
    ftsRows: count('fts_index'),
    heads: db.all(
      `SELECT a.artifact_id AS id, max(r.revision) AS revision
         FROM artifacts a JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
        GROUP BY a.artifact_id ORDER BY a.artifact_id`,
    ),
    foreignKeyViolations: db.all('PRAGMA foreign_key_check').length,
  }
}

console.log('\n[P2-FTS5 E3-2] 真实 v5 → v6 迁移')

// ── 主路径：v5 → v6（按真实启动路径走 openDatabase） ───────────────────
const { dir, file } = makeV5()
const raw = new DatabaseSync(file)
const rawBefore = raw.prepare('PRAGMA user_version').get()
const before = snapshot(
  { get: (sql) => raw.prepare(sql).get(), all: (sql) => raw.prepare(sql).all() },
  Number(rawBefore.user_version),
)
raw.close()
eq('V5-01 迁移前 user_version=5', before.userVersion, 5)

const opened = await openDatabase({ file, driverPreference: 'auto', logger: log })
const db = opened.db
const after = snapshot(db)

eq('V5-02 迁移后 user_version=31', after.userVersion, 31)
eq('V5-04 Artifact 数量不变', after.artifacts, before.artifacts)
eq('V5-04 revision 数量不变', after.revisions, before.revisions)
eq(
  'V5-04 source/event/evidence 数量不变',
  [after.sources, after.events, after.evidence],
  [before.sources, before.events, before.evidence],
)
eq('V5-04 operations 数量不变', after.operations, before.operations)
eq('V5-05 外键检查无违规', after.foreignKeyViolations, 0)
eq('V5-06 head 不变化', after.heads, before.heads)

const disclosureRows = db.all(
  `SELECT artifact_id AS id, revision, disclosure FROM artifact_revisions ORDER BY artifact_id, revision`,
)
eq(
  'V5-03 历史 revision 全部默认 restricted',
  disclosureRows.map((row) => row.disclosure),
  ['restricted', 'restricted', 'restricted', 'restricted'],
)

// V5-07：迁移后旧 FTS 可校验/可重建
const drifted = verifyFtsIndex(db)
ok('V5-07 迁移后可执行 verifyFtsIndex', drifted && Array.isArray(drifted.missing))
rebuildFtsIndex(db)
const rebuilt = verifyFtsIndex(db)
eq(
  'V5-07 重建后 verify 无缺失/无重复/无内容不一致',
  [rebuilt.missing.length, rebuilt.duplicate.length, rebuilt.contentMismatch.length],
  [0, 0, 0],
)
ok('V5-07 重建后 FTS5 integrity-check 通过', rebuilt.integrityOk)

// V5-08/V5-09：显式分类可返回、restricted 不返回。
// revision 有「不可更新」触发器，所以显式 public 必须写成新 revision，不能 UPDATE 旧行。
db.run(
  `INSERT INTO artifact_revisions (artifact_id, revision, state, statement, subject_refs, payload, confidence,
     basis_count, independent_evidence_count, salience, temporal, direct_extraction, created_at, updated_at, disclosure, schema_version)
   VALUES ('art_v5_a', 3, 'active', '用户每天散步记录步数。', '["main"]', '{}', 'medium', 1, 1, 0.5, '{}', 0, ?, ?, 'public', '1.0')`,
  [AT, AT],
)
rebuildFtsIndex(db)
const publicHits = await searchFts(db, '散步', { limit: 8 })
ok('V5-08 显式 public 可被普通检索返回', publicHits.some((hit) => hit.artifactId === 'art_v5_a'))
const restrictedHits = await searchFts(db, '晚上 听雨', { limit: 8 })
ok('V5-09 restricted 历史不被普通检索返回', !restrictedHits.some((hit) => hit.artifactId === 'art_v5_b'))

// V5-11：重复 migrate 不重复执行
const migrationsBefore = db.get(`SELECT count(*) AS n FROM schema_migrations`).n
const reopened = await openDatabase({ file, driverPreference: 'auto', logger: log })
eq('V5-11 重复启动版本不变', Number(reopened.db.pragma('user_version') ?? 0), 31)
eq('V5-11 schema_migrations 不重复', reopened.db.get(`SELECT count(*) AS n FROM schema_migrations`).n, migrationsBefore)
reopened.db.close()

// V5-12：迁移后 rebuild 不改 disclosure
rebuildFtsIndex(db)
eq(
  'V5-12 rebuild 后 disclosure 不变',
  db.all(`SELECT disclosure FROM artifact_revisions ORDER BY artifact_id, revision`).map((row) => row.disclosure),
  ['restricted', 'restricted', 'public', 'restricted', 'restricted'],
)

db.close()
// Windows 上失败路径可能还没释放句柄；临时目录交给系统清理，不让清理失败盖掉结论
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  /* ignore */
}

// ── V5-10：迁移失败整笔回滚 ─────────────────────────────────────────────
const broken = makeV5({ addDisclosureColumn: true })
const rawBroken = new DatabaseSync(broken.file)
const rawBrokenVersion = rawBroken.prepare('PRAGMA user_version').get()
const brokenBefore = snapshot(
  {
    get: (sql) => rawBroken.prepare(sql).get(),
    all: (sql) => rawBroken.prepare(sql).all(),
  },
  Number(rawBrokenVersion.user_version),
)
rawBroken.close()
eq('V5-10 夹具仍是 v5 且带 disclosure 列', brokenBefore.userVersion, 5)

let migrationError = null
try {
  const attempted = await openDatabase({ file: broken.file, driverPreference: 'auto', logger: log })
  attempted.db.close()
} catch (error) {
  migrationError = error
}
ok('V5-10 迁移失败抛错', Boolean(migrationError))

const rawAfter = new DatabaseSync(broken.file)
const rawAfterVersion = rawAfter.prepare('PRAGMA user_version').get()
const brokenAfter = snapshot(
  {
    get: (sql) => rawAfter.prepare(sql).get(),
    all: (sql) => rawAfter.prepare(sql).all(),
  },
  Number(rawAfterVersion.user_version),
)
eq('V5-10 失败后 user_version 仍是 5', brokenAfter.userVersion, 5)
eq('V5-10 失败后主数据不变', brokenAfter.artifacts, brokenBefore.artifacts)
eq('V5-10 失败后外键仍完整', brokenAfter.foreignKeyViolations, 0)
rawAfter.close()
try {
  rmSync(broken.dir, { recursive: true, force: true })
} catch {
  /* ignore */
}

console.log(`\n[migrate-v5] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
