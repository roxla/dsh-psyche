// psyche-health：快速健康检查（P2 统一验收前置）。
//
// 回答一个问题：**当前这个库能不能正常跑起来？**
// 它不做深度对账（那是 psyche-integrity），只查「打开 / 版本 / 结构 / 关键数据可读」。
// 全程只读：readOnly + query_only，不迁移、不建表、不修复、不重建 FTS。
//
// 与 dbcheck.ts 的分工：dbcheck 是「迁移包恢复前」的结构对账（v1/v2 清单硬编码），
// 这里是「当前运行库」的体检（按 SCHEMA_VERSION 与 EXPECTED_TABLE_COUNT 判定）。
import { existsSync } from 'node:fs'
import { SCHEMA_VERSION, EXPECTED_TABLE_COUNT } from './schema.js'
import { AuditOpenError, openAuditDatabase, type AuditDb } from './audit-db.js'

export interface AuditIssue {
  code: string
  severity: 'error' | 'warning'
  table: string
  recordId: string
  detail: string
  refType?: string
  refId?: string
}

export interface AuditSummary {
  checked: number
  passed: number
  failed: number
  warnings: number
}

export type AuditStatus = 'ok' | 'warn' | 'failed' | 'unavailable'

export interface HealthFacts {
  userVersion: number | null
  schemaVersion: number | null
  tableCount: number | null
  triggerCount: number | null
  indexCount: number | null
  artifacts: number | null
  sources: number | null
  events: number | null
  personas: string[]
  queryOnly: boolean
}

export interface HealthReport {
  tool: 'psyche-health'
  schemaVersion: number | null
  expectedSchemaVersion: number
  status: AuditStatus
  summary: AuditSummary
  issues: AuditIssue[]
  facts: HealthFacts
  readOnly: true
}

/** 当前 schema 下必须存在的一批表（不是全部 45 张，是本体检真正会依赖的）。 */
const CORE_TABLES = [
  'schema_migrations',
  'persona_config',
  'persona_state',
  'personality_history',
  'sources',
  'events',
  'artifacts',
  'artifact_revisions',
  'artifact_evidence',
  'artifact_lineage',
  'artifact_trigger_events',
  'operations',
  'fts_rowids',
  'capture_cursors',
  'recall_runs',
  'recall_candidates',
  'disclosure_grants',
  'quarantined_sources',
  'tension_versions',
  'decision_runs',
  'decision_items',
  'diaries',
  'diary_versions',
] as const

/** 只追加不变量靠这些触发器兜底（与 dbcheck 的清单保持一致）。 */
const APPEND_ONLY_TRIGGERS = [
  'trg_events_no_update',
  'trg_events_no_delete',
  'trg_sources_no_update',
  'trg_artifact_revisions_no_update',
  'trg_artifact_evidence_no_update',
  'trg_relationship_signals_no_update',
  'trg_relationship_signals_no_delete',
  'trg_operations_no_update',
  'trg_operations_no_delete',
] as const

/** 关键唯一/部分索引：少了不会立刻报错，但对应不变量会在并发下失效。 */
const CRITICAL_INDEXES = ['idx_artifacts_stance_key', 'idx_diaries_key', 'idx_recall_runs_pre_step_turn'] as const

function pragmaValue(db: AuditDb, name: string): unknown {
  const row = db.get<Record<string, unknown>>(`PRAGMA ${name}`)
  return row ? Object.values(row)[0] : undefined
}

function countOf(db: AuditDb, table: string): number | null {
  try {
    const row = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
    return row === undefined ? null : Number(row.n)
  } catch {
    return null
  }
}

function emptySummary(): AuditSummary {
  return { checked: 0, passed: 0, failed: 0, warnings: 0 }
}

function finish(tool: 'psyche-health', issues: AuditIssue[], summary: AuditSummary): AuditStatus {
  if (issues.some((issue) => issue.severity === 'error')) return 'failed'
  if (summary.warnings > 0) return 'warn'
  return 'ok'
}

function emptyFacts(): HealthFacts {
  return {
    userVersion: null,
    schemaVersion: null,
    tableCount: null,
    triggerCount: null,
    indexCount: null,
    artifacts: null,
    sources: null,
    events: null,
    personas: [],
    queryOnly: false,
  }
}

/**
 * 对一个数据根做健康检查。
 *
 * 文件不存在时返回 `unavailable`，**不自动初始化**——审计工具没有创建数据的权力。
 * 任何检查失败都只收集进 issues，不抛（除了打开阶段的 AuditOpenError，它被转成 unavailable）。
 */
export function inspectHealth(dataDir: string, options: { file?: string } = {}): HealthReport {
  const file = options.file ?? `${dataDir.replace(/[\\/]+$/, '')}/memory.sqlite3`
  const summary = emptySummary()
  const issues: AuditIssue[] = []
  const facts = emptyFacts()

  const check = (ok: boolean, issue: AuditIssue, weight = 1): void => {
    summary.checked += weight
    if (ok) summary.passed += weight
    else {
      issues.push(issue)
      if (issue.severity === 'error') summary.failed += weight
      else summary.warnings += weight
    }
  }

  if (!existsSync(file)) {
    summary.checked += 1
    summary.failed += 1
    issues.push({
      code: 'E_DB_FILE_MISSING',
      severity: 'error',
      table: 'filesystem',
      recordId: file,
      detail: '库文件不存在（审计工具不会自动创建，请先启动一次 DSH 或从备份恢复）',
    })
    return { tool: 'psyche-health', schemaVersion: null, expectedSchemaVersion: SCHEMA_VERSION, status: 'unavailable', summary, issues, facts, readOnly: true }
  }

  let handle
  try {
    handle = openAuditDatabase(file)
  } catch (error) {
    summary.checked += 1
    summary.failed += 1
    const code = error instanceof AuditOpenError ? error.code : 'open-failed'
    issues.push({
      code: 'E_DB_OPEN_FAILED',
      severity: 'error',
      table: 'filesystem',
      recordId: file,
      detail: `打不开库（${code}）：${(error as Error).message}`,
    })
    return { tool: 'psyche-health', schemaVersion: null, expectedSchemaVersion: SCHEMA_VERSION, status: 'unavailable', summary, issues, facts, readOnly: true }
  }

  try {
    const { db, queryOnly } = handle
    facts.queryOnly = queryOnly
    check(queryOnly, {
      code: 'E_NOT_READ_ONLY',
      severity: 'error',
      table: 'connection',
      recordId: file,
      detail: '连接不是只读（query_only 未生效），拒绝继续审计',
    })
    if (!queryOnly) {
      return { tool: 'psyche-health', schemaVersion: null, expectedSchemaVersion: SCHEMA_VERSION, status: 'failed', summary, issues, facts, readOnly: true }
    }

    // 引擎层
    const integrity = String(pragmaValue(db, 'integrity_check') ?? '')
    check(integrity === 'ok', {
      code: 'E_SQLITE_INTEGRITY',
      severity: 'error',
      table: 'database',
      recordId: 'integrity_check',
      detail: `integrity_check=${integrity || '(空)'}`,
    })

    // 版本
    const version = Number(pragmaValue(db, 'user_version') ?? 0)
    facts.userVersion = version
    facts.schemaVersion = version
    check(version === SCHEMA_VERSION, {
      code: 'E_SCHEMA_VERSION',
      severity: 'error',
      table: 'sqlite_master',
      recordId: 'user_version',
      detail: `user_version=${version}，期望 ${SCHEMA_VERSION}`,
    })

    // 表（排除 fts_index 虚拟表本身 + fts shadow + sqlite 内部表，与 EXPECTED_TABLE_COUNT 同口径）
    const tables = db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB 'fts_index_*' AND name <> 'fts_index'`,
    )
    const tableSet = new Set(tables.map((row) => String(row.name)))
    facts.tableCount = tableSet.size
    check(tableSet.size === EXPECTED_TABLE_COUNT, {
      code: 'E_TABLE_COUNT',
      severity: 'error',
      table: 'sqlite_master',
      recordId: 'tables',
      detail: `业务表 ${tableSet.size} 张，期望 ${EXPECTED_TABLE_COUNT} 张`,
    })
    // FTS5 虚拟表单独查（它不进业务表计数，但必须存在，否则检索全废）
    const ftsRow = db.get<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fts_index'`)
    check(ftsRow !== undefined, {
      code: 'E_TABLE_MISSING',
      severity: 'error',
      table: 'fts_index',
      recordId: 'fts_index',
      detail: '缺 FTS5 虚拟表 fts_index',
    })
    for (const table of CORE_TABLES) {
      check(tableSet.has(table), {
        code: 'E_TABLE_MISSING',
        severity: 'error',
        table,
        recordId: table,
        detail: `缺表 ${table}`,
      })
    }

    // 触发器：只追加不变量
    const triggers = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
    const triggerSet = new Set(triggers.map((row) => String(row.name)))
    facts.triggerCount = triggerSet.size
    for (const trigger of APPEND_ONLY_TRIGGERS) {
      check(triggerSet.has(trigger), {
        code: 'E_TRIGGER_MISSING',
        severity: 'error',
        table: 'trigger',
        recordId: trigger,
        detail: `缺触发器 ${trigger}（只追加不变量会失效）`,
      })
    }

    // 关键索引
    const indexes = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index'`)
    const indexSet = new Set(indexes.map((row) => String(row.name)))
    facts.indexCount = indexSet.size
    for (const index of CRITICAL_INDEXES) {
      check(indexSet.has(index), {
        code: 'E_INDEX_MISSING',
        severity: 'warning',
        table: 'index',
        recordId: index,
        detail: `缺关键索引 ${index}（并发下唯一性/受限轮次查询可能失效）`,
      })
    }

    // 核心数据可读
    for (const table of ['artifacts', 'sources', 'events'] as const) {
      const count = countOf(db, table)
      facts[table === 'artifacts' ? 'artifacts' : table === 'sources' ? 'sources' : 'events'] = count
      check(count !== null, {
        code: 'E_READ_FAILED',
        severity: 'error',
        table,
        recordId: table,
        detail: `读不了 ${table}（表存在但查询失败）`,
      })
    }

    // 人格归属：库里只该有本机人格（审计工具不硬编码 main，只报出现过的值）
    try {
      const rows = db.all<{ persona_id: string }>(`SELECT DISTINCT persona_id FROM persona_config`)
      facts.personas = rows.map((row) => String(row.persona_id))
      check(facts.personas.length <= 1, {
        code: 'E_PERSONA_MULTIPLE',
        severity: 'warning',
        table: 'persona_config',
        recordId: 'persona_id',
        detail: `出现多个 persona：${facts.personas.join(', ')}（单人格部署应为 1 个）`,
      })
    } catch {
      // persona_config 缺失已在表清单里报过，这里不重复
    }

    return {
      tool: 'psyche-health',
      schemaVersion: version,
      expectedSchemaVersion: SCHEMA_VERSION,
      status: finish('psyche-health', issues, summary),
      summary,
      issues,
      facts,
      readOnly: true,
    }
  } finally {
    handle.close()
  }
}
