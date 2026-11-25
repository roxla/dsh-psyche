/**
 * psyche-integrity 只读完整性审计（P2 阶段 0）。
 *
 * 每个用例独立建一个库：先造一份「合法最小数据」，再注入一种故障，
 * 断言三件事：能发现、能定位到表/记录、正常数据不误报。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { inspectIntegrity } from '../dist/lib/audit-integrity.js'
import { upsertFtsRow } from '../dist/lib/fts.js'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail: unknown = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

const log = { info() {}, debug() {}, warn() {}, error() {} }
const root = mkdtempSync(join(tmpdir(), 'psyche-audit-integrity-'))

interface Fixture {
  dir: string
  db: Awaited<ReturnType<typeof openDatabase>>['db']
}

async function makeFixture(name: string): Promise<Fixture> {
  const dir = join(root, name)
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
  migrate(opened.db, log)
  return { dir, db: opened.db }
}

/** 一份合法的最小数据：1 source + 1 event（带 source）+ 1 artifact/revision（带 evidence）+ FTS。 */
function seed(fx: Fixture): void {
  const at = '2026-11-09T10:00:00.000Z'
  fx.db.run(
    `INSERT OR IGNORE INTO persona_config (persona_id, type, created_at, updated_at) VALUES ('main', 'preset', ?, ?)`,
    [at, at],
  )
  fx.db.run(
    `INSERT INTO contacts (contact_id, persona_id, platform, stable_user_id, created_at, updated_at)
     VALUES ('ct_audit', 'main', 'desktop', 'desktop-user', ?, ?)`,
    [at, at],
  )
  fx.db.run(
    `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, sender_contact_id, origin, kind, text, captured_at, created_at)
     VALUES ('src_audit_1', 'main', 'desktop', 'desktop', 'session-audit', 'ct_audit', 'user', 'message', '今天喝了乌龙茶', ?, ?)`,
    [at, at],
  )
  fx.db.run(
    `INSERT INTO events (event_id, persona_id, kind, type, at, subject_refs, text, confidence, schema_version, created_at)
     VALUES ('evt_audit_1', 'main', 'interaction', 'conversation', ?, '["ct_audit"]', '用户提到乌龙茶', 'medium', '1.0', ?)`,
    [at, at],
  )
  fx.db.run(`INSERT INTO event_sources (event_id, source_id) VALUES ('evt_audit_1', 'src_audit_1')`)
  fx.db.run(
    `INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at) VALUES ('art_audit_1', 'main', 'fact', ?, ?)`,
    [at, at],
  )
  fx.db.run(
    `INSERT INTO artifact_revisions
       (artifact_id, revision, state, statement, subject_refs, payload, confidence,
        basis_count, independent_evidence_count, salience, temporal, direct_extraction,
        created_at, updated_at, schema_version, disclosure)
     VALUES ('art_audit_1', 1, 'active', '用户喜欢喝乌龙茶', '["ct_audit"]', '{}', 'medium',
             1, 1, 0, '{}', 0, ?, ?, '1.0', 'public')`,
    [at, at],
  )
  fx.db.run(
    `INSERT INTO artifact_evidence (artifact_id, revision, source_id, relation, confidence, independence_key, created_at)
     VALUES ('art_audit_1', 1, 'src_audit_1', 'supports', 'medium', 'src_audit_1|supports', ?)`,
    [at],
  )
  fx.db.run(
    `INSERT INTO artifact_trigger_events (artifact_id, revision, event_id)
     VALUES ('art_audit_1', 1, 'evt_audit_1')`,
  )
  upsertFtsRow(fx.db, { artifactId: 'art_audit_1', kind: 'fact', statement: '用户喜欢喝乌龙茶' })
}

// ── 1. 正常库 ────────────────────────────────────────────────
const normal = await makeFixture('normal')
seed(normal)
normal.db.close()
const normalReport = inspectIntegrity(normal.dir)
check('正常库 status=ok', normalReport.status === 'ok', normalReport.issues)
check('正常库零失败', normalReport.summary.failed === 0)
check('正常库 readOnly 为 true', normalReport.readOnly === true)
check('正常库 schemaVersion 是 42', normalReport.schemaVersion === 42)
check('正常库有 11 个分组', normalReport.groups.length >= 9, normalReport.groups.map((g) => g.name))

// ── 2. 外键孤儿 ─────────────────────────────────────────────
const fk = await makeFixture('fk-orphan')
seed(fk)
fk.db.exec('PRAGMA foreign_keys = OFF')
fk.db.run(
  `INSERT INTO artifact_evidence (artifact_id, revision, source_id, relation, confidence, independence_key, created_at)
   VALUES ('art_missing_999', 1, 'src_audit_1', 'supports', 'medium', 'src_audit_1|supports', '2026-11-09T10:00:00.000Z')`,
)
fk.db.close()
const fkReport = inspectIntegrity(fk.dir)
check('外键孤儿被 sqlite 组发现', fkReport.issues.some((issue) => issue.code === 'E_FOREIGN_KEY'))
check('外键孤儿能定位到记录', fkReport.issues.some((issue) => issue.code === 'E_FOREIGN_KEY' && issue.recordId !== ''))

// ── 3. Event 引用不存在的 Source ────────────────────────────
const es = await makeFixture('event-source')
seed(es)
es.db.exec('PRAGMA foreign_keys = OFF')
es.db.run(`INSERT INTO event_sources (event_id, source_id) VALUES ('evt_missing_2', 'src_missing_2')`)
es.db.close()
const esReport = inspectIntegrity(es.dir)
check('Event→Source 悬空被发现', esReport.issues.some((issue) => issue.code === 'E_EVENT_SOURCE_MISSING'))
check('Event→Source 悬空能定位', esReport.issues.some((issue) => issue.code === 'E_EVENT_SOURCE_MISSING' && issue.recordId.includes('evt_missing_2')))

// ── 4. Artifact 引用不存在的 Evidence ──────────────────────
const ae = await makeFixture('artifact-evidence')
seed(ae)
ae.db.exec('PRAGMA foreign_keys = OFF')
ae.db.run(
  `INSERT INTO artifact_evidence (artifact_id, revision, source_id, relation, confidence, independence_key, created_at)
   VALUES ('art_audit_1', 1, 'src_missing_3', 'supports', 'medium', 'src_missing_3|supports', '2026-11-09T10:00:00.000Z')`,
)
ae.db.close()
const aeReport = inspectIntegrity(ae.dir)
check('Artifact→Evidence 悬空被发现', aeReport.issues.some((issue) => issue.code === 'E_ARTIFACT_EVIDENCE_MISSING'))
check('Artifact→Evidence 悬空带 refType=source', aeReport.issues.some((issue) => issue.code === 'E_ARTIFACT_EVIDENCE_MISSING' && issue.refType === 'source'))

// ── 5. Decision Item 悬空（多态引用按 refType）──────────────
const dr = await makeFixture('decision-ref')
seed(dr)
dr.db.run(
  `INSERT INTO decision_runs (decision_id, persona_id, op_id, kind, status, actor, input_hash, created_at, schema_version)
   VALUES ('dec_audit_1', 'main', 'op-audit-1', 'revise', 'committed', 'core', 'hash-1', '2026-11-09T10:00:00.000Z', '1.0')`,
)
dr.db.run(
  `INSERT INTO decision_items (decision_id, item_id, ref_type, ref_id, ref_revision, role, created_at)
   VALUES ('dec_audit_1', 'item-1', 'artifact', 'art_missing_5', 1, 'input', '2026-11-09T10:00:00.000Z')`,
)
dr.db.close()
const drReport = inspectIntegrity(dr.dir)
check('Decision 多态引用悬空被发现', drReport.issues.some((issue) => issue.code.startsWith('E_DECISION_REF')))
check('Decision 悬空带 refType/refId', drReport.issues.some((issue) => issue.refType === 'artifact' && issue.refId === 'art_missing_5'))

// ── 6. Artifact 没有任何 revision ──────────────────────────
const hd = await makeFixture('head')
seed(hd)
hd.db.run(
  `INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at)
   VALUES ('art_empty_6', 'main', 'fact', '2026-11-09T10:00:00.000Z', '2026-11-09T10:00:00.000Z')`,
)
hd.db.close()
const hdReport = inspectIntegrity(hd.dir)
check('空聚合根被发现', hdReport.issues.some((issue) => issue.code === 'E_ARTIFACT_NO_REVISION'))
check('空聚合根能定位到 artifact', hdReport.issues.some((issue) => issue.table === 'artifacts' && issue.recordId === 'art_empty_6'))

// ── 7. Stance 来源失效（stance_key 重复）───────────────────
const st = await makeFixture('stance')
seed(st)
st.db.exec('DROP INDEX idx_artifacts_stance_key')
st.db.run(
  `INSERT INTO artifacts (artifact_id, persona_id, kind, stance_key, created_at, updated_at)
   VALUES ('art_stance_a', 'main', 'stance', 'group-x:for', '2026-11-09T10:00:00.000Z', '2026-11-09T10:00:00.000Z')`,
)
st.db.run(
  `INSERT INTO artifacts (artifact_id, persona_id, kind, stance_key, created_at, updated_at)
   VALUES ('art_stance_b', 'main', 'stance', 'group-x:for', '2026-11-09T10:00:00.000Z', '2026-11-09T10:00:00.000Z')`,
)
st.db.close()
const stReport = inspectIntegrity(st.dir)
check('Stance 重复 key 被发现', stReport.issues.some((issue) => issue.code.includes('STANCE')))

// ── 8. Diary 来源不存在 ────────────────────────────────────
const dy = await makeFixture('diary')
seed(dy)
dy.db.run(
  `INSERT INTO diaries (diary_id, persona_id, scope_key, contact_id, local_date, period_start, period_end, timezone, head_version, source_digest, created_at, updated_at)
   VALUES ('dly_audit_1', 'main', 'contact:ct_audit', 'ct_audit', '2026-11-09', 0, 86400000, 'Asia/Shanghai', 1, 'digest', '2026-11-09T10:00:00.000Z', '2026-11-09T10:00:00.000Z')`,
)
dy.db.run(
  `INSERT INTO diary_versions (diary_id, version, body, source_refs, tension_refs, algorithm_version, content_hash, created_at)
   VALUES ('dly_audit_1', 1, '正文', '[{"refType":"artifact","refId":"art_missing_8"}]', '[]', 'diary-v1', 'hash', '2026-11-09T10:00:00.000Z')`,
)
dy.db.close()
const dyReport = inspectIntegrity(dy.dir)
check('Diary 悬空来源被发现', dyReport.issues.some((issue) => issue.code === 'E_DIARY_DANGLING_SOURCE' || issue.code.includes('DANGLING')))

// ── 9. FTS 映射缺失 ────────────────────────────────────────
const ft = await makeFixture('fts')
seed(ft)
ft.db.run(`DELETE FROM fts_rowids WHERE kind = 'fact' AND ref_id = 'art_audit_1'`)
ft.db.close()
const ftReport = inspectIntegrity(ft.dir)
check('FTS 映射缺失被发现', ftReport.issues.some((issue) => issue.code.includes('FTS')))

// ── 10. 资产缺失 ───────────────────────────────────────────
const as = await makeFixture('assets')
seed(as)
as.db.run(
  `INSERT INTO source_assets (sha256, size, path, created_at) VALUES ('deadbeef', 10, 'missing.bin', '2026-11-09T10:00:00.000Z')`,
)
as.db.close()
const asReport = inspectIntegrity(as.dir)
check('资产文件缺失被发现', asReport.issues.some((issue) => issue.code === 'E_ASSET_MISSING'))

// ── 11. 备份损坏（warning）─────────────────────────────────
const bk = await makeFixture('backups')
seed(bk)
mkdirSync(join(bk.dir, 'backups'), { recursive: true })
writeFileSync(join(bk.dir, 'backups', 'broken.sqlite3'), 'not a sqlite file', 'utf8')
bk.db.close()
const bkReport = inspectIntegrity(bk.dir)
check('备份损坏被发现（warning）', bkReport.issues.some((issue) => issue.code === 'E_BACKUP_BAD' && issue.severity === 'warning'))
check('备份损坏不导致整体 failed', bkReport.status !== 'failed' || bkReport.issues.every((issue) => issue.severity === 'warning'))

try {
  rmSync(root, { recursive: true, force: true })
} catch {
  /* 清理失败不影响结论 */
}

console.log(`[audit-integrity] ${pass} 通过 ${fail} 失败`)
if (fail > 0) process.exitCode = 1
