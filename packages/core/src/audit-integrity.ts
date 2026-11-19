// psyche-integrity：深度数据完整性审计（P2 统一验收前置）。
//
// 回答一个问题：**库里的业务数据是否完整、引用是否可靠？**
// 与 psyche-health 的分工：health 只查「能不能跑」，这里查「数据自洽不自洽」。
//
// 严格只读：readOnly + query_only；不修数据、不重建 FTS、不迁移、不清理孤儿、不建备份。
//   注意：FTS5 的 `INSERT INTO fts_index(fts_index) VALUES('integrity-check')` 是写操作，
//   审计工具**不执行**它；这里只做纯 SELECT 的映射/内容比对（需要修复走独立维护流程）。
//
// 复用：Diary 检查直接调 `inspectDiaryIntegrity()`；FTS 内容比对复用 `bigramText()`。
// 不新建表、不建第二份资产清单、不常驻。
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { openAuditDatabase, AuditOpenError, type AuditDb } from './audit-db.js'
import { inspectDiaryIntegrity } from './diary-integrity.js'
import { bigramText } from './fts.js'
import type { Db } from './adapter.js'
import { SCHEMA_VERSION } from './schema.js'
import { DatabaseSync } from 'node:sqlite'

export interface Issue {
  code: string
  severity: 'error' | 'warning'
  group: string
  table: string
  recordId: string
  detail: string
  refType?: string
  refId?: string
}

export interface IntegrityGroup {
  name: string
  checked: number
  issues: number
}

export interface IntegrityFacts {
  userVersion: number | null
  artifacts: number | null
  revisions: number | null
  events: number | null
  sources: number | null
  decisions: number | null
  tensions: number | null
  stances: number | null
  diaries: number | null
  ftsRows: number | null
  assets: number | null
  backups: number | null
}

export interface IntegrityReport {
  tool: 'psyche-integrity'
  schemaVersion: number | null
  expectedSchemaVersion: number
  status: 'ok' | 'warn' | 'failed' | 'unavailable'
  summary: { checked: number; passed: number; failed: number; warnings: number }
  groups: IntegrityGroup[]
  issues: Issue[]
  facts: IntegrityFacts
  readOnly: true
}

interface Counter {
  checked: number
  passed: number
  failed: number
  warnings: number
}

function newCounter(): Counter {
  return { checked: 0, passed: 0, failed: 0, warnings: 0 }
}

function emptyFacts(): IntegrityFacts {
  return {
    userVersion: null,
    artifacts: null,
    revisions: null,
    events: null,
    sources: null,
    decisions: null,
    tensions: null,
    stances: null,
    diaries: null,
    ftsRows: null,
    assets: null,
    backups: null,
  }
}

function count(db: AuditDb, sql: string, params: readonly (string | number | null)[] = []): number | null {
  try {
    const row = db.get<{ n: number }>(sql, params)
    return row === undefined ? null : Number(row.n)
  } catch {
    return null
  }
}

/** 逐类收集：每次 `record` 计一条检查，失败/警告分别累计。 */
class GroupRunner {
  readonly issues: Issue[] = []
  readonly counter = newCounter()
  readonly group: string

  constructor(group: string) {
    this.group = group
  }

  record(ok: boolean, issue: Omit<Issue, 'group' | 'severity'>, severity: 'error' | 'warning' = 'error'): void {
    this.counter.checked += 1
    if (ok) {
      this.counter.passed += 1
      return
    }
    this.issues.push({ ...issue, group: this.group, severity })
    if (severity === 'error') this.counter.failed += 1
    else this.counter.warnings += 1
  }

  /** 批量检查一组「缺失引用」：rows 每条都是一条问题。 */
  recordAll(rows: Array<Omit<Issue, 'group' | 'severity'>>, totalChecked: number): void {
    this.counter.checked += Math.max(totalChecked, rows.length)
    this.counter.failed += rows.length
    this.counter.passed += Math.max(0, totalChecked - rows.length)
    for (const row of rows) this.issues.push({ ...row, group: this.group, severity: 'error' })
  }
}

// ── 1. SQLite 引擎 ────────────────────────────────────────────

function checkSqlite(db: AuditDb, run: GroupRunner): void {
  try {
    const row = db.get<Record<string, unknown>>('PRAGMA integrity_check')
    const value = String(Object.values(row ?? {})[0] ?? '')
    run.record(value === 'ok', {
      code: 'E_SQLITE_INTEGRITY',
      table: 'database',
      recordId: 'integrity_check',
      detail: `integrity_check=${value || '(空)'}`,
    })
  } catch (error) {
    run.record(false, { code: 'E_SQLITE_INTEGRITY', table: 'database', recordId: 'integrity_check', detail: (error as Error).message })
  }
  try {
    const rows = db.all<Record<string, unknown>>('PRAGMA foreign_key_check')
    for (const row of rows) {
      run.record(false, {
        code: 'E_FOREIGN_KEY',
        table: String(row.table ?? 'unknown'),
        recordId: String(row.rowid ?? ''),
        detail: `foreign_key_check 指向父表 ${String(row.parent ?? '')}`,
      })
    }
    if (rows.length === 0) run.record(true, { code: 'E_FOREIGN_KEY', table: 'database', recordId: 'foreign_key_check', detail: 'ok' })
  } catch (error) {
    run.record(false, { code: 'E_FOREIGN_KEY', table: 'database', recordId: 'foreign_key_check', detail: (error as Error).message })
  }
}

// ── 2. 证据链 ───────────────────────────────────────────────

function checkEvidence(db: AuditDb, run: GroupRunner): void {
  const orphanEventSources = db.all<{ event_id: string; source_id: string }>(
    `SELECT es.event_id, es.source_id FROM event_sources es
     LEFT JOIN events e ON e.event_id = es.event_id
     LEFT JOIN sources s ON s.source_id = es.source_id
     WHERE e.event_id IS NULL OR s.source_id IS NULL`,
  )
  const totalEventSources = count(db, 'SELECT COUNT(*) AS n FROM event_sources') ?? 0
  run.recordAll(
    orphanEventSources.map((row) => ({
      code: 'E_EVENT_SOURCE_MISSING',
      table: 'event_sources',
      recordId: `${row.event_id}->${row.source_id}`,
      detail: 'event_sources 引用的 event 或 source 不存在',
    })),
    totalEventSources,
  )

  const orphanEvidence = db.all<{ artifact_id: string; revision: number; source_id: string }>(
    `SELECT ae.artifact_id, ae.revision, ae.source_id FROM artifact_evidence ae
     LEFT JOIN sources s ON s.source_id = ae.source_id
     LEFT JOIN artifact_revisions ar ON ar.artifact_id = ae.artifact_id AND ar.revision = ae.revision
     WHERE s.source_id IS NULL OR ar.artifact_id IS NULL`,
  )
  const totalEvidence = count(db, 'SELECT COUNT(*) AS n FROM artifact_evidence') ?? 0
  run.recordAll(
    orphanEvidence.map((row) => ({
      code: 'E_ARTIFACT_EVIDENCE_MISSING',
      table: 'artifact_evidence',
      recordId: `${row.artifact_id}@${row.revision}->${row.source_id}`,
      detail: 'artifact_evidence 引用的 source 或 revision 不存在',
      refType: 'source',
      refId: String(row.source_id),
    })),
    totalEvidence,
  )

  const orphanTriggers = db.all<{ artifact_id: string; revision: number; event_id: string }>(
    `SELECT te.artifact_id, te.revision, te.event_id FROM artifact_trigger_events te
     LEFT JOIN events e ON e.event_id = te.event_id
     LEFT JOIN artifact_revisions ar ON ar.artifact_id = te.artifact_id AND ar.revision = te.revision
     WHERE e.event_id IS NULL OR ar.artifact_id IS NULL`,
  )
  const totalTriggers = count(db, 'SELECT COUNT(*) AS n FROM artifact_trigger_events') ?? 0
  run.recordAll(
    orphanTriggers.map((row) => ({
      code: 'E_TRIGGER_EVENT_MISSING',
      table: 'artifact_trigger_events',
      recordId: `${row.artifact_id}@${row.revision}->${row.event_id}`,
      detail: 'artifact_trigger_events 引用的 event 或 revision 不存在',
      refType: 'event',
      refId: String(row.event_id),
    })),
    totalTriggers,
  )
}

// ── 3. Revision / Head ─────────────────────────────────────

function checkRevisions(db: AuditDb, run: GroupRunner): void {
  // 当前 schema 不在 artifacts 上存 head_revision：head 由 max(revision) 派生（§11.3）。
  // 所以这里检查的是「每个聚合根至少有一版」，以及每条 revision 都能回指到一个壳。
  const artifacts = db.all<{ artifact_id: string }>(`SELECT artifact_id FROM artifacts`)
  for (const artifact of artifacts) {
    const maxRow = db.get<{ max_revision: number | null }>(
      `SELECT MAX(revision) AS max_revision FROM artifact_revisions WHERE artifact_id = ?`,
      [artifact.artifact_id],
    )
    const max = maxRow?.max_revision === null || maxRow?.max_revision === undefined ? 0 : Number(maxRow.max_revision)
    run.record(max > 0, {
      code: 'E_ARTIFACT_NO_REVISION',
      table: 'artifacts',
      recordId: artifact.artifact_id,
      detail: '聚合根没有任何 revision 行（head 无法派生）',
    })
  }

  const orphanRevisions = db.all<{ artifact_id: string; revision: number }>(
    `SELECT ar.artifact_id, ar.revision FROM artifact_revisions ar
     LEFT JOIN artifacts a ON a.artifact_id = ar.artifact_id
     WHERE a.artifact_id IS NULL`,
  )
  const totalRevisions = count(db, 'SELECT COUNT(*) AS n FROM artifact_revisions') ?? 0
  run.recordAll(
    orphanRevisions.map((row) => ({
      code: 'E_REVISION_ORPHAN',
      table: 'artifact_revisions',
      recordId: `${row.artifact_id}@${row.revision}`,
      detail: 'revision 找不到对应的 artifact 壳',
    })),
    totalRevisions,
  )
}

// ── 4. Lineage ─────────────────────────────────────────────

function checkLineage(db: AuditDb, run: GroupRunner): void {
  const rows = db.all<{
    artifact_id: string
    revision: number
    from_artifact_id: string
    from_revision: number | null
  }>(`SELECT artifact_id, revision, from_artifact_id, from_revision FROM artifact_lineage`)
  let missing = 0
  for (const row of rows) {
    // from_revision 可空（只记得「从那个对象推出来」）；只要来源对象存在就算可追溯。
    const target = db.get<{ one: number }>(
      `SELECT 1 AS one FROM artifact_revisions WHERE artifact_id = ? AND (? IS NULL OR revision = ?) LIMIT 1`,
      [row.from_artifact_id, row.from_revision, row.from_revision],
    )
    if (target === undefined) {
      missing += 1
      run.record(false, {
        code: 'E_LINEAGE_MISSING',
        table: 'artifact_lineage',
        recordId: `${row.artifact_id}@${row.revision}`,
        detail: `来源 ${row.from_artifact_id}${row.from_revision === null ? '' : `@${row.from_revision}`} 不存在`,
        refType: 'artifact',
        refId: String(row.from_artifact_id),
      })
    } else {
      run.record(true, { code: 'E_LINEAGE_MISSING', table: 'artifact_lineage', recordId: `${row.artifact_id}@${row.revision}`, detail: 'ok' })
    }
  }
  if (rows.length === 0) {
    run.record(true, { code: 'E_LINEAGE_MISSING', table: 'artifact_lineage', recordId: '(空)', detail: '没有 lineage 行' })
  }
  void missing
}

// ── 5. Decision Receipt ────────────────────────────────────

function refExists(db: AuditDb, refType: string, refId: string): boolean {
  const table: Record<string, string | null> = {
    artifact: `SELECT 1 AS one FROM artifact_revisions WHERE artifact_id = ?`,
    evidence: `SELECT 1 AS one FROM artifact_evidence WHERE artifact_id = ?`,
    tension: `SELECT 1 AS one FROM tension_versions WHERE tension_id = ?`,
    source: `SELECT 1 AS one FROM sources WHERE source_id = ?`,
    event: `SELECT 1 AS one FROM events WHERE event_id = ?`,
    diary: `SELECT 1 AS one FROM diary_versions WHERE diary_id = ?`,
  }
  const sql = table[refType]
  if (sql === undefined || sql === null) return false
  return db.get<{ one: number }>(sql, [refId]) !== undefined
}

function checkDecisions(db: AuditDb, run: GroupRunner): void {
  const items = db.all<{ decision_id: string; item_id: string; ref_type: string; ref_id: string }>(
    `SELECT decision_id, item_id, ref_type, ref_id FROM decision_items`,
  )
  for (const item of items) {
    const ok = refExists(db, item.ref_type, item.ref_id)
    run.record(ok, {
      code: 'E_DECISION_REF_MISSING',
      table: 'decision_items',
      recordId: `${item.decision_id}/${item.item_id}`,
      detail: `ref_type=${item.ref_type} 的目标不存在`,
      refType: item.ref_type,
      refId: item.ref_id,
    })
  }

  const runs = db.all<{
    decision_id: string
    status: string
    result_artifact_id: string | null
    result_revision: number | null
    result_diary_id: string | null
    finalized_at: string | null
  }>(
    `SELECT decision_id, status, result_artifact_id, result_revision, result_diary_id, finalized_at FROM decision_runs`,
  )
  for (const runRow of runs) {
    if (runRow.result_artifact_id !== null) {
      const found = db.get<{ one: number }>(
        `SELECT 1 AS one FROM artifact_revisions WHERE artifact_id = ? AND revision = ?`,
        [runRow.result_artifact_id, Number(runRow.result_revision ?? 0)],
      )
      run.record(found !== undefined, {
        code: 'E_DECISION_RESULT_MISSING',
        table: 'decision_runs',
        recordId: runRow.decision_id,
        detail: `结果 ${runRow.result_artifact_id}@${runRow.result_revision} 不存在`,
        refType: 'artifact',
        refId: String(runRow.result_artifact_id),
      })
    }
    if (runRow.result_diary_id !== null) {
      const found = db.get<{ one: number }>(`SELECT 1 AS one FROM diaries WHERE diary_id = ?`, [runRow.result_diary_id])
      run.record(found !== undefined, {
        code: 'E_DECISION_RESULT_MISSING',
        table: 'decision_runs',
        recordId: runRow.decision_id,
        detail: `结果 diary ${runRow.result_diary_id} 不存在`,
        refType: 'diary',
        refId: runRow.result_diary_id,
      })
    }
    // pending 不该有 finalized_at；committed/rejected/failed 必须有
    if (runRow.status === 'pending' && runRow.finalized_at !== null) {
      run.record(false, {
        code: 'E_DECISION_STATE',
        table: 'decision_runs',
        recordId: runRow.decision_id,
        detail: 'pending 的决策却有 finalized_at',
      })
    } else if (runRow.status !== 'pending' && runRow.finalized_at === null) {
      run.record(false, {
        code: 'E_DECISION_STATE',
        table: 'decision_runs',
        recordId: runRow.decision_id,
        detail: `${runRow.status} 的决策缺 finalized_at`,
      })
    } else {
      run.record(true, { code: 'E_DECISION_STATE', table: 'decision_runs', recordId: runRow.decision_id, detail: 'ok' })
    }
  }
}

// ── 6. Tension ─────────────────────────────────────────────

function checkTensions(db: AuditDb, run: GroupRunner): void {
  const tensions = db.all<{
    tension_id: string
    version: number
    left_artifact_id: string
    left_revision: number
    right_artifact_id: string
    right_revision: number
  }>(
    `SELECT tension_id, version, left_artifact_id, left_revision, right_artifact_id, right_revision
     FROM tension_versions`,
  )
  const heads = new Map<string, number>()
  for (const row of tensions) {
    const current = heads.get(row.tension_id)
    if (current === undefined || row.version > current) heads.set(row.tension_id, row.version)
    for (const side of [
      { id: row.left_artifact_id, revision: row.left_revision },
      { id: row.right_artifact_id, revision: row.right_revision },
    ]) {
      const found = db.get<{ one: number }>(
        `SELECT 1 AS one FROM artifact_revisions WHERE artifact_id = ? AND revision = ?`,
        [side.id, side.revision],
      )
      run.record(found !== undefined, {
        code: 'E_TENSION_REF_MISSING',
        table: 'tension_versions',
        recordId: `${row.tension_id}@${row.version}`,
        detail: `一侧 ${side.id}@${side.revision} 不存在`,
        refType: 'artifact',
        refId: String(side.id),
      })
    }
  }
  // head 版本必须存在（append-only，MAX(version) 就是 head）
  for (const [tensionId, version] of heads) {
    const found = db.get<{ one: number }>(
      `SELECT 1 AS one FROM tension_versions WHERE tension_id = ? AND version = ?`,
      [tensionId, version],
    )
    run.record(found !== undefined, {
      code: 'E_TENSION_HEAD_MISSING',
      table: 'tension_versions',
      recordId: tensionId,
      detail: `head version=${version} 不存在`,
    })
  }
}

// ── 7. Stance ──────────────────────────────────────────────

function checkStances(db: AuditDb, run: GroupRunner): void {
  const duplicates = db.all<{ stance_key: string; n: number }>(
    `SELECT stance_key, COUNT(*) AS n FROM artifacts WHERE stance_key IS NOT NULL GROUP BY stance_key HAVING n > 1`,
  )
  run.recordAll(
    duplicates.map((row) => ({
      code: 'E_STANCE_KEY_DUPLICATE',
      table: 'artifacts',
      recordId: row.stance_key,
      detail: `stance_key 出现 ${row.n} 次（部分唯一索引应已阻止）`,
    })),
    count(db, 'SELECT COUNT(*) AS n FROM artifacts WHERE stance_key IS NOT NULL') ?? 0,
  )

  const stances = db.all<{ artifact_id: string; head_revision: number | null; stance_key: string | null }>(
    `SELECT a.artifact_id,
            (SELECT MAX(revision) FROM artifact_revisions r WHERE r.artifact_id = a.artifact_id) AS head_revision,
            a.stance_key
       FROM artifacts a WHERE a.kind = 'stance'`,
  )
  for (const stance of stances) {
    run.record(stance.stance_key !== null && stance.stance_key !== '', {
      code: 'E_STANCE_KEY_MISSING',
      table: 'artifacts',
      recordId: stance.artifact_id,
      detail: 'kind=stance 但没有 stance_key',
    })
    const head = stance.head_revision === null ? undefined : db.get<{ payload: string | null }>(
      `SELECT payload FROM artifact_revisions WHERE artifact_id = ? AND revision = ?`,
      [stance.artifact_id, stance.head_revision],
    )
    if (head !== undefined && stance.stance_key !== null) {
      let group = ''
      let direction = ''
      try {
        const payload = JSON.parse(String(head.payload ?? '{}')) as Record<string, unknown>
        group = typeof payload.stanceGroup === 'string' ? payload.stanceGroup : ''
        direction = typeof payload.stanceDirection === 'string' ? payload.stanceDirection : ''
      } catch {
        // 坏 payload 由 payload 结构检查负责；这里只做一致性
      }
      const expected = group !== '' && direction !== '' ? `${group}:${direction}` : ''
      run.record(expected === '' || expected === stance.stance_key, {
        code: 'E_STANCE_KEY_MISMATCH',
        table: 'artifact_revisions',
        recordId: `${stance.artifact_id}@${stance.head_revision}`,
        detail: `payload(${group}:${direction}) 与 stance_key(${stance.stance_key}) 不一致`,
      })
    }
  }
}

// ── 8. Diary（复用 inspectDiaryIntegrity） ─────────────────

function checkDiary(db: AuditDb, run: GroupRunner): void {
  const report = inspectDiaryIntegrity(db as unknown as Db)
  run.counter.checked += report.checkedDiaries + report.checkedVersions
  run.counter.passed += report.checkedDiaries + report.checkedVersions - report.issues.length
  for (const issue of report.issues) {
    run.counter.failed += 1
    run.issues.push({
      code: `E_DIARY_${issue.kind.toUpperCase().replace(/-/g, '_')}`,
      severity: 'error',
      group: run.group,
      table: issue.kind === 'orphan-version' ? 'diary_versions' : 'diaries',
      recordId: issue.diaryId,
      detail: `${issue.version === null ? '' : `v${issue.version}：`}${issue.detail}`,
      refType: 'diary',
      refId: issue.diaryId,
    })
  }
}

// ── 9. FTS 映射（只读，不执行 integrity-check） ────────────

function checkFts(db: AuditDb, run: GroupRunner): void {
  const heads = db.all<{ artifact_id: string; artifact_kind: string; statement: string }>(
    `SELECT a.artifact_id, a.kind AS artifact_kind, r.statement
     FROM artifacts a JOIN artifact_revisions r
       ON r.artifact_id = a.artifact_id
      AND r.revision = (SELECT MAX(revision) FROM artifact_revisions x WHERE x.artifact_id = a.artifact_id)`,
  )
  const rows = db.all<{ ref_id: string; kind: string; bigram_text: string; row_id: number }>(
    `SELECT ref_id, kind, bigram_text, rowid AS row_id FROM fts_index`,
  )
  const mapRows = db.all<{ kind: string; ref_id: string; row_id: number }>(
    `SELECT kind, ref_id, row_id FROM fts_rowids`,
  )

  const headMap = new Map(heads.map((row) => [row.artifact_id, row]))
  const ftsByRef = new Map<string, { kind: string; bigram: string; rowId: number }>()
  for (const row of rows) ftsByRef.set(`${row.kind}:${row.ref_id}`, { kind: row.kind, bigram: row.bigram_text, rowId: Number(row.row_id) })
  const mapByRowId = new Map(mapRows.map((row) => [Number(row.row_id), row]))

  let checked = 0
  for (const head of heads) {
    checked += 1
    // fts_index.kind 记的是 Artifact 的语义类型（fact / belief / stance …），不是字面 'artifact'
    const fts = ftsByRef.get(`${head.artifact_kind}:${head.artifact_id}`)
    if (fts === undefined) {
      run.record(false, {
        code: 'E_FTS_MISSING',
        table: 'fts_index',
        recordId: head.artifact_id,
        detail: 'head 没有对应的 FTS 行',
        refType: 'artifact',
        refId: head.artifact_id,
      })
      continue
    }
    run.record(true, { code: 'E_FTS_MISSING', table: 'fts_index', recordId: head.artifact_id, detail: 'ok' })
    checked += 1
    run.record(fts.bigram === bigramText(head.statement), {
      code: 'E_FTS_CONTENT_MISMATCH',
      table: 'fts_index',
      recordId: head.artifact_id,
      detail: 'bigram_text 与当前 head 正文不一致（派生缓存过期）',
      refType: 'artifact',
      refId: head.artifact_id,
    })
  }

  let mapChecked = 0
  for (const row of rows) {
    mapChecked += 1
    const mapped = mapByRowId.get(Number(row.row_id))
    run.record(mapped !== undefined && mapped.kind === row.kind && mapped.ref_id === row.ref_id, {
      code: 'E_FTS_MAPPING',
      table: 'fts_rowids',
      recordId: `${row.kind}:${row.ref_id}`,
      detail: 'fts_rowids 映射缺失或与主记录不一致',
      refType: row.kind,
      refId: row.ref_id,
    })
  }

  // Diary Recall 的前提：每条 diary 的 head 版本也要有 FTS 行（kind='diary'）。
  const diaryHeads = db.all<{ diary_id: string }>(`SELECT diary_id FROM diaries`)
  for (const diary of diaryHeads) {
    const fts = ftsByRef.get(`diary:${diary.diary_id}`)
    run.record(fts !== undefined, {
      code: 'E_FTS_DIARY_MISSING',
      table: 'fts_index',
      recordId: diary.diary_id,
      detail: '日记没有对应的 FTS 行（Diary Recall 会漏掉它）',
      refType: 'diary',
      refId: diary.diary_id,
    })
  }
  void checked
  void mapChecked
}

// ── 10. 资产 ───────────────────────────────────────────────

function checkAssets(dataDir: string, db: AuditDb, run: GroupRunner, maxBytes: number): void {
  const assets = db.all<{ sha256: string; size: number; path: string }>(`SELECT sha256, size, path FROM source_assets`)
  for (const asset of assets) {
    const file = join(dataDir, asset.path)
    const exists = existsSync(file)
    run.record(exists, {
      code: 'E_ASSET_MISSING',
      table: 'source_assets',
      recordId: asset.sha256,
      detail: `资产文件不存在：${asset.path}`,
      refType: 'source',
      refId: asset.sha256,
    })
    if (!exists) continue
    const size = statSync(file).size
    run.record(size === Number(asset.size), {
      code: 'E_ASSET_SIZE',
      table: 'source_assets',
      recordId: asset.sha256,
      detail: `资产大小不符：库内 ${asset.size}，文件 ${size}`,
      refType: 'source',
      refId: asset.sha256,
    })
    if (size <= maxBytes) {
      const hash = createHash('sha256').update(readFileSync(file)).digest('hex')
      run.record(hash === asset.sha256, {
        code: 'E_ASSET_HASH',
        table: 'source_assets',
        recordId: asset.sha256,
        detail: '资产内容哈希不符',
        refType: 'source',
        refId: asset.sha256,
      })
    } else {
      run.record(true, {
        code: 'E_ASSET_HASH',
        table: 'source_assets',
        recordId: asset.sha256,
        detail: `文件 ${size}B 超过 ${maxBytes}B，跳过哈希校验`,
      })
    }
  }
  if (assets.length === 0) {
    run.record(true, { code: 'E_ASSET_MISSING', table: 'source_assets', recordId: '(空)', detail: '没有资产行' })
  }
}

// ── 11. 备份（只读打开，不建、不修） ───────────────────────

function listBackups(dataDir: string): string[] {
  const dir = join(dataDir, 'backups')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sqlite3'))
    .slice(0, 5)
    .map((name) => join(dir, name))
}

function checkBackups(dataDir: string, run: GroupRunner): void {
  const files = listBackups(dataDir)
  for (const file of files) {
    try {
      const probe = new DatabaseSync(file, { readOnly: true })
      try {
        const row = probe.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined
        const value = String(Object.values(row ?? {})[0] ?? '')
        run.record(value === 'ok', {
          code: 'E_BACKUP_BAD',
          table: 'backups',
          recordId: file,
          detail: `备份 integrity_check=${value || '(空)'}`,
        }, 'warning')
      } finally {
        try {
          probe.close()
        } catch {
          // ignore
        }
      }
    } catch (error) {
      run.record(false, { code: 'E_BACKUP_BAD', table: 'backups', recordId: file, detail: `备份打不开：${(error as Error).message}` }, 'warning')
    }
  }
  if (files.length === 0) {
    run.record(true, { code: 'E_BACKUP_BAD', table: 'backups', recordId: '(无)', detail: '没有备份文件（不是错误，只是提醒）' }, 'warning')
  }
}

// ── 入口 ───────────────────────────────────────────────────

export interface IntegrityOptions {
  /** 库文件路径；默认 `<dataDir>/memory.sqlite3`。 */
  file?: string
  /** 资产哈希校验上限（字节），超过只查存在与大小；默认 8MB。 */
  maxAssetBytes?: number
}

export function inspectIntegrity(dataDir: string, options: IntegrityOptions = {}): IntegrityReport {
  const file = options.file ?? join(dataDir, 'memory.sqlite3')
  const facts = emptyFacts()
  const groups: IntegrityGroup[] = []
  const runners: GroupRunner[] = []
  const allIssues: Issue[] = []
  const totals = newCounter()

  if (!existsSync(file)) {
    allIssues.push({
      code: 'E_DB_FILE_MISSING',
      severity: 'error',
      group: 'filesystem',
      table: 'filesystem',
      recordId: file,
      detail: '库文件不存在（审计工具不会自动创建）',
    })
    return {
      tool: 'psyche-integrity',
      schemaVersion: null,
      expectedSchemaVersion: SCHEMA_VERSION,
      status: 'unavailable',
      summary: { checked: 1, passed: 0, failed: 1, warnings: 0 },
      groups: [],
      issues: allIssues,
      facts,
      readOnly: true,
    }
  }

  let handle
  try {
    handle = openAuditDatabase(file)
  } catch (error) {
    const code = error instanceof AuditOpenError ? error.code : 'open-failed'
    allIssues.push({
      code: 'E_DB_OPEN_FAILED',
      severity: 'error',
      group: 'filesystem',
      table: 'filesystem',
      recordId: file,
      detail: `打不开库（${code}）：${(error as Error).message}`,
    })
    return {
      tool: 'psyche-integrity',
      schemaVersion: null,
      expectedSchemaVersion: SCHEMA_VERSION,
      status: 'unavailable',
      summary: { checked: 1, passed: 0, failed: 1, warnings: 0 },
      groups: [],
      issues: allIssues,
      facts,
      readOnly: true,
    }
  }

  try {
    const { db, queryOnly } = handle
    if (!queryOnly) {
      allIssues.push({
        code: 'E_NOT_READ_ONLY',
        severity: 'error',
        group: 'connection',
        table: 'connection',
        recordId: file,
        detail: '连接不是只读，拒绝继续审计',
      })
      return {
        tool: 'psyche-integrity',
        schemaVersion: null,
        expectedSchemaVersion: SCHEMA_VERSION,
        status: 'failed',
        summary: { checked: 1, passed: 0, failed: 1, warnings: 0 },
        groups: [],
        issues: allIssues,
        facts,
        readOnly: true,
      }
    }
    const versionRow = db.get<Record<string, unknown>>('PRAGMA user_version')
    facts.userVersion = Number(Object.values(versionRow ?? {})[0] ?? 0)
    facts.artifacts = count(db, 'SELECT COUNT(*) AS n FROM artifacts')
    facts.revisions = count(db, 'SELECT COUNT(*) AS n FROM artifact_revisions')
    facts.events = count(db, 'SELECT COUNT(*) AS n FROM events')
    facts.sources = count(db, 'SELECT COUNT(*) AS n FROM sources')
    facts.decisions = count(db, 'SELECT COUNT(*) AS n FROM decision_runs')
    facts.tensions = count(db, 'SELECT COUNT(DISTINCT tension_id) AS n FROM tension_versions')
    facts.stances = count(db, "SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'stance'")
    facts.diaries = count(db, 'SELECT COUNT(*) AS n FROM diaries')
    facts.ftsRows = count(db, 'SELECT COUNT(*) AS n FROM fts_index')
    facts.assets = count(db, 'SELECT COUNT(*) AS n FROM source_assets')
    facts.backups = listBackups(dataDir).length

    const steps: Array<[string, (run: GroupRunner) => void]> = [
      ['sqlite', (run) => checkSqlite(db, run)],
      ['evidence', (run) => checkEvidence(db, run)],
      ['revision', (run) => checkRevisions(db, run)],
      ['lineage', (run) => checkLineage(db, run)],
      ['decision', (run) => checkDecisions(db, run)],
      ['tension', (run) => checkTensions(db, run)],
      ['stance', (run) => checkStances(db, run)],
      ['diary', (run) => checkDiary(db, run)],
      ['fts', (run) => checkFts(db, run)],
      ['assets', (run) => checkAssets(dataDir, db, run, options.maxAssetBytes ?? 8 * 1024 * 1024)],
      ['backups', (run) => checkBackups(dataDir, run)],
    ]

    for (const [name, execute] of steps) {
      const run = new GroupRunner(name)
      try {
        execute(run)
      } catch (error) {
        run.record(false, {
          code: 'E_CHECK_CRASHED',
          table: name,
          recordId: name,
          detail: `检查组异常：${(error as Error).message}`,
        })
      }
      runners.push(run)
      groups.push({ name, checked: run.counter.checked, issues: run.issues.length })
      allIssues.push(...run.issues)
      totals.checked += run.counter.checked
      totals.passed += run.counter.passed
      totals.failed += run.counter.failed
      totals.warnings += run.counter.warnings
    }

    const status: IntegrityReport['status'] = totals.failed > 0 ? 'failed' : totals.warnings > 0 ? 'warn' : 'ok'
    return {
      tool: 'psyche-integrity',
      schemaVersion: facts.userVersion,
      expectedSchemaVersion: SCHEMA_VERSION,
      status,
      summary: totals,
      groups,
      issues: allIssues,
      facts,
      readOnly: true,
    }
  } finally {
    handle.close()
  }
}
