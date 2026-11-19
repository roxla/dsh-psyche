/**
 * 迁移包的**结构级**校验：库文件能不能当真用。
 *
 * 为什么需要单独一个文件：
 *   只查 `integrity_check` 只能证明「文件没坏块」，证明不了「这是一个可用的心灵记忆库」。
 *   缺一张表、缺一个只追加触发器、混进别的 persona 的数据，行数一条不少，但装上去之后
 *   要么工具全报错，要么只追加不变量直接失效（触发器没了，谁来挡 UPDATE/DELETE？）。
 *   所以恢复前必须做**结构对账**，而不是只看哈希和页完整性。
 *
 * 三层判据（对应 §34.12 的 P0-2）：
 *   1. 引擎层：`integrity_check` = ok、`foreign_key_check` 无输出；
 *   2. 结构层：`user_version` 对得上、必需表齐全、**9 个只追加触发器**在、关键索引在；
 *   3. 归属层：所有带 `persona_id` 的表只能出现本机人格 id；清单声明的表计数与库内一致。
 *
 * 只读：以 `readOnly: true` 打开，查完立刻关；不建表、不迁移、不写任何页。
 * 失败不改调用方状态：所有问题都收集进 `problems` 一次性返回，便于面板一次列清。
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

/**
 * v1 的三十一张表（§11.2）。
 * 顺序按模块分组，便于人读；这里**不靠顺序**，只做集合比较。
 */
export const REQUIRED_TABLES_V1 = [
  // 身份与配置
  'schema_migrations',
  'persona_config',
  'persona_state',
  'personality_history',
  // 联系人与房间
  'contacts',
  'contact_identifiers',
  'rooms',
  'room_members',
  // 会话活动窗口（独立证据的载体）
  'session_activity_windows',
  // 来源与事件
  'sources',
  'events',
  'event_sources',
  'event_relations',
  // 结论
  'artifacts',
  'artifact_revisions',
  'artifact_evidence',
  'artifact_trigger_events',
  'artifact_lineage',
  'artifact_relations',
  // 成长
  'phase_state',
  'phase_evidence',
  // 心情与关系
  'global_mood_state',
  'global_mood_history',
  'contact_affect_state',
  'contact_affect_history',
  'relationship_signals',
  'relationship_affinity_state',
  // 事务
  'operations',
  'proposals',
  'pending_writes',
  // 资产
  'source_assets',
] as const

/** v2 在 v1 之上新增的两张表（§26）。 */
export const REQUIRED_TABLES_V2_ONLY = ['phase_milestones', 'learning_jobs'] as const

/** 当前 schema 版本要求的全部表。 */
export const REQUIRED_TABLES = [...REQUIRED_TABLES_V1, ...REQUIRED_TABLES_V2_ONLY] as const

/**
 * 只追加不变量靠这九个触发器兜底。
 * 少一个，对应的表就能被 UPDATE/DELETE——数据行照样在，但「审计链不可篡改」这条已经没了。
 */
export const REQUIRED_TRIGGERS = [
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

/** v1 就有的索引（查询性能与唯一性约束的载体）。 */
export const REQUIRED_INDEXES_V1 = [
  'idx_events_at',
  'idx_events_type',
  'idx_events_session',
  'idx_events_op',
  'idx_event_sources_source',
  'idx_sources_captured',
  'idx_sources_sender',
  'idx_sources_room',
  'idx_sources_window',
  'idx_artifacts_kind',
  'idx_artifact_evidence_source',
  'idx_artifact_relations_target',
  'idx_relationship_signals_contact',
  'idx_operations_created',
  'idx_proposals_status',
  'idx_pending_writes_status',
] as const

/** v2 新增的索引（learning_jobs 的「同源请求只能有一个在跑」唯一约束在这里）。 */
export const REQUIRED_INDEXES_V2_ONLY = [
  'idx_phase_milestones_created',
  'idx_learning_jobs_status',
  'idx_learning_jobs_active',
] as const

/**
 * 清单计数键 → 真实表名。
 *
 * 迁移包里的 `counts` 来自 `readCounters()`（`src/lib/ops.ts:259`），键为了给人看用了驼峰，
 * 而库里是下划线。对账前先过这张表，映射不到的就当它不是表名，跳过。
 */
export const TABLE_ALIASES: Record<string, string> = {
  artifactRevisions: 'artifact_revisions',
  phaseMilestones: 'phase_milestones',
}

/** 一条结构问题：`code` 给程序判分支，`detail` 给人看。 */export interface DbCheckProblem {
  code:
    | 'open-failed'
    | 'integrity'
    | 'foreign-key'
    | 'user-version'
    | 'missing-table'
    | 'missing-trigger'
    | 'missing-index'
    | 'persona-mismatch'
    | 'count-mismatch'
  detail: string
}

/** 校验时顺带采集到的事实（测试与面板诊断用）。 */
export interface DbCheckFacts {
  userVersion: number
  tables: number
  triggers: number
  indexes: number
  /** 表名 → 出现过的 persona_id 集合；只记与期望不一致时会用到的信息。 */
  personaIds: Record<string, string[]>
  counts: Record<string, number>
}

export interface DbCheckResult {
  ok: boolean
  problems: DbCheckProblem[]
  facts: DbCheckFacts | null
}

/** 读一条 PRAGMA 的第一列（node:sqlite 的 get 返回对象，列名就是 pragma 名）。 */
function pragmaValue(db: DatabaseSync, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
  return row ? Object.values(row)[0] : undefined
}

/** 从 sqlite_master 取一类对象的全部名字。 */
function objectNames(db: DatabaseSync, type: 'table' | 'trigger' | 'index'): string[] {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(type) as { name: string }[]
  return rows.map((row) => String(row.name))
}

/**
 * 校验一个库文件是否「结构完整、归属正确、计数对得上」。
 *
 * 参数：
 * - `file` 库文件（迁移包解出来的 `memory.sqlite3`，或安装后的新库）；
 * - `expectedVersion` 期望的 `user_version`（来自清单的 `schemaVersion`）；
 * - `personaId` 期望的人格 id，默认 `main`；
 * - `expectedCounts` 清单里的 `counts`（可选）：键是表名、值是行数，只有能对上的表才会比对。
 *
 * 返回：`{ ok, problems, facts }`；`facts` 为 null 表示库根本没打开。
 * 副作用：只读打开并关闭，不写库。
 */
export function checkDatabaseFile(options: {
  file: string
  expectedVersion: number
  personaId?: string
  expectedCounts?: Record<string, number>
}): DbCheckResult {
  const problems: DbCheckProblem[] = []
  if (!existsSync(options.file)) {
    return { ok: false, problems: [{ code: 'open-failed', detail: `找不到库文件：${options.file}` }], facts: null }
  }
  const personaId = options.personaId ?? 'main'
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(options.file, { readOnly: true })

    // ── 1. 引擎层 ──
    const integrity = String(pragmaValue(db, 'integrity_check') ?? '')
    if (integrity !== 'ok') problems.push({ code: 'integrity', detail: `integrity_check=${integrity || '(空)'}` })
    const fk = db.prepare('PRAGMA foreign_key_check').all() as unknown[]
    if (fk.length > 0) problems.push({ code: 'foreign-key', detail: `foreign_key_check 有 ${fk.length} 条不一致` })

    // ── 2. 结构层 ──
    const version = Number(pragmaValue(db, 'user_version') ?? 0)
    if (version !== options.expectedVersion) {
      problems.push({
        code: 'user-version',
        detail: `user_version=${version}，期望 ${options.expectedVersion}（清单声明的 schema 版本）`,
      })
    }
    const tables = objectNames(db, 'table')
    const tableSet = new Set(tables)
    const requiredTables = version >= 2 ? REQUIRED_TABLES : REQUIRED_TABLES_V1
    for (const table of requiredTables) {
      if (!tableSet.has(table)) problems.push({ code: 'missing-table', detail: `缺表 ${table}` })
    }
    const triggers = new Set(objectNames(db, 'trigger'))
    for (const trigger of REQUIRED_TRIGGERS) {
      // 触发器是只追加设计的唯一执行者：缺一个就等于允许改历史
      if (!triggers.has(trigger)) problems.push({ code: 'missing-trigger', detail: `缺触发器 ${trigger}（只追加不变量会失效）` })
    }
    const indexes = new Set(objectNames(db, 'index'))
    const requiredIndexes = version >= 2 ? [...REQUIRED_INDEXES_V1, ...REQUIRED_INDEXES_V2_ONLY] : REQUIRED_INDEXES_V1
    for (const index of requiredIndexes) {
      if (!indexes.has(index)) problems.push({ code: 'missing-index', detail: `缺索引 ${index}` })
    }

    // ── 3. 归属层：任何带 persona_id 的表都只能出现本机人格 ──
    // 动态探测列而不是写死表名：将来加表不用回来改这里（这是它比白名单强的地方）。
    const personaIds: Record<string, string[]> = {}
    for (const table of requiredTables) {
      if (!tableSet.has(table)) continue
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      if (!columns.some((column) => column.name === 'persona_id')) continue
      const rows = db.prepare(`SELECT DISTINCT persona_id FROM ${table}`).all() as { persona_id: unknown }[]
      const values = rows.map((row) => String(row.persona_id))
      personaIds[table] = values
      const foreign = values.filter((value) => value !== personaId)
      if (foreign.length > 0) {
        problems.push({
          code: 'persona-mismatch',
          detail: `${table} 里有别的 persona：${foreign.join(', ')}（本机是 ${personaId}）`,
        })
      }
    }

    // ── 3b. 计数对账：清单说有多少行，库里就得有多少行 ──
    const counts: Record<string, number> = {}
    for (const [rawKey, expected] of Object.entries(options.expectedCounts ?? {})) {
      // 清单里的键沿用 ops.ts 的驼峰命名（给人看），先映射回真实表名；
      // 映射不到、或表不存在、或值不是有限数，跳过而不是报错（清单不是 schema 契约）。
      const table = TABLE_ALIASES[rawKey] ?? rawKey
      if (!tableSet.has(table) || !Number.isFinite(expected)) continue
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined
      const actual = Number(row?.n ?? 0)
      counts[table] = actual
      if (actual !== Number(expected)) {
        problems.push({ code: 'count-mismatch', detail: `${table} 行数不符：清单 ${expected}，库里 ${actual}` })
      }
    }

    return {
      ok: problems.length === 0,
      problems,
      facts: {
        userVersion: version,
        tables: tables.length,
        triggers: triggers.size,
        indexes: indexes.size,
        personaIds,
        counts,
      },
    }
  } catch (error) {
    problems.push({ code: 'open-failed', detail: `打不开库：${(error as Error).message}` })
    return { ok: false, problems, facts: null }
  } finally {
    try {
      db?.close()
    } catch {
      // 关不掉不影响判定：这是只读探针，进程退出会回收
    }
  }
}
