/**
 * P5-6 外界来源登记与隔离（Schema v28）。
 *
 * 边界（P5-6 冻结方案）：
 * - 登记行不可变；删除/过期清理走 append-only 事件账本，当前态由最新 event_id 决定；
 * - 只引用已有 Core Source，不复制正文；content_sha256 由调用方原始字节计算；
 * - Scope 来自现有授权与来源归属，缺失或冲突失败关闭，不默认 global；
 * - 风险检测只是 best-effort 提示，不作为准入依据；
 * - 删除事件生效后逻辑下线（列表/召回过滤），不修改 append-only 的 sources 原文；
 *   物理擦除需库重建/冷备份流程，不在本模块内宣称已完成。
 */
import { createHash } from 'node:crypto'
import type { Db } from './adapter.js'

export type ExternalSourceKind = 'web' | 'file' | 'group'
export type ExternalSourceScope = 'personal' | 'contact' | 'room'
export type ExternalDeletionAction = 'delete' | 'purge'

export interface ExternalSourceInput {
  sourceId: string
  kind: ExternalSourceKind
  provenance: string
  content: string
  scope: ExternalSourceScope
  scopeRef?: string | null
  disclosure: string
  createdBy: string
  retentionDays?: number | null
  now?: number
}

export interface ExternalSourceRow {
  source_id: string
  kind: ExternalSourceKind
  provenance: string
  content_sha256: string
  risk_flags: string
  scope: ExternalSourceScope
  scope_ref: string | null
  disclosure: string
  retention_until: number | null
  created_by: string
  created_at: number
  deletion_action: ExternalDeletionAction | null
}

const OWNER_RE = /^os:[A-Za-z0-9_.:-]+$/
const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const RISK_PATTERNS: ReadonlyArray<{ reason: string; re: RegExp }> = Object.freeze([
  { reason: 'role_override', re: /忽略(?:之前|以上|前面|所有|此前).{0,8}(?:指令|设定|规则)/ },
  { reason: 'role_override', re: /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/i },
  { reason: 'role_override', re: /你现在是|从现在开始你(?:是|扮演)|你的新身份/ },
  { reason: 'system_prompt_probe', re: /system\s*prompt|<\|im_start\|>|<\/?system>/i },
  { reason: 'tool_call_request', re: /调用.{0,6}工具|use\s+the\s+tool|run\s+the\s+command/i },
  { reason: 'secret_request', re: /(?:输出|告诉我|提供).{0,8}(?:api\s*key|密钥|密码|口令)/i },
])

/** best-effort 风险提示：命中只记录原因，不改变准入结论。 */
export function detectExternalInstructionRisk(text: string): string[] {
  const reasons = new Set<string>()
  for (const pattern of RISK_PATTERNS) {
    if (pattern.re.test(text)) reasons.add(pattern.reason)
  }
  return [...reasons].sort()
}

export function sha256OfExternalContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function requireOwner(by: string, code = 'E_OWNER_UNVERIFIED'): void {
  if (!OWNER_RE.test(by)) throw new Error(code)
}

function requireNonEmpty(value: string | undefined | null, code: string): string {
  const text = (value ?? '').trim()
  if (text.length === 0) throw new Error(code)
  return text
}

function assertScope(input: ExternalSourceInput, source: { room_id: string | null; sender_contact_id: string | null }): string | null {
  const scopeRef = input.scopeRef?.trim() || null
  if (input.kind === 'group' && input.scope !== 'room') throw new Error('E_SCOPE_UNDECIDABLE')
  if (input.scope === 'personal') {
    if (scopeRef !== null) throw new Error('E_SCOPE_CONFLICT')
    return null
  }
  if (scopeRef === null) throw new Error('E_SCOPE_UNDECIDABLE')
  if (input.scope === 'room') {
    if (input.kind === 'group') {
      if (source.room_id === null) throw new Error('E_SCOPE_UNDECIDABLE')
      if (scopeRef !== source.room_id) throw new Error('E_SCOPE_CONFLICT')
    }
    return scopeRef
  }
  // contact
  if (source.sender_contact_id !== null && scopeRef !== source.sender_contact_id) {
    throw new Error('E_SCOPE_CONFLICT')
  }
  return scopeRef
}

export interface RecordResult {
  row: ExternalSourceRow
  created: boolean
}

export function recordExternalSource(db: Db, input: ExternalSourceInput): RecordResult {
  requireOwner(input.createdBy)
  const provenance = requireNonEmpty(input.provenance, 'E_PROVENANCE_REQUIRED')
  const disclosure = requireNonEmpty(input.disclosure, 'E_DISCLOSURE_REQUIRED')
  if (input.kind !== 'web' && input.kind !== 'file' && input.kind !== 'group') {
    throw new Error('E_KIND_INVALID')
  }
  const source = db
    .prepare('SELECT source_id, room_id, sender_contact_id FROM sources WHERE source_id = ?')
    .get(input.sourceId) as { source_id: string; room_id: string | null; sender_contact_id: string | null } | undefined
  if (!source) throw new Error('E_SOURCE_NOT_FOUND')
  const scopeRef = assertScope(input, source)
  const contentSha = sha256OfExternalContent(input.content)
  const riskFlags = JSON.stringify(detectExternalInstructionRisk(input.content))
  const now = input.now ?? Date.now()
  const retentionDays = input.retentionDays === undefined ? 30 : input.retentionDays
  const retentionUntil = retentionDays === null ? null : now + Math.max(0, retentionDays) * 86_400_000

  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM external_sources WHERE source_id = ?').get(input.sourceId) as
      | ExternalSourceRow
      | undefined
    if (existing) {
      const same =
        existing.kind === input.kind &&
        existing.provenance === provenance &&
        existing.content_sha256 === contentSha &&
        existing.scope === input.scope &&
        (existing.scope_ref ?? null) === scopeRef
      if (!same) throw new Error('E_SOURCE_IMMUTABLE')
      return { row: { ...existing, deletion_action: deletionActionOf(db, input.sourceId) }, created: false }
    }
    db.prepare(
      `INSERT INTO external_sources (
         source_id, kind, provenance, content_sha256, risk_flags,
         scope, scope_ref, disclosure, retention_until, created_by, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.sourceId,
      input.kind,
      provenance,
      contentSha,
      riskFlags,
      input.scope,
      scopeRef,
      disclosure,
      retentionUntil,
      input.createdBy,
      now,
    )
    const row = db.prepare('SELECT * FROM external_sources WHERE source_id = ?').get(input.sourceId) as ExternalSourceRow
    return { row: { ...row, deletion_action: null }, created: true }
  })
}

function deletionActionOf(db: Db, sourceId: string): ExternalDeletionAction | null {
  const latest = db
    .prepare('SELECT action FROM external_source_deletion_events WHERE source_id = ? ORDER BY event_id DESC LIMIT 1')
    .get(sourceId) as { action: ExternalDeletionAction } | undefined
  return latest?.action ?? null
}

/** 统一过滤谓词：接在 `external_sources alias` 上，删除事件生效后不再返回该来源。 */
export function andExternalSourceActive(alias = 'e'): string {
  if (!ALIAS_RE.test(alias)) throw new Error('E_ALIAS_INVALID')
  return `NOT EXISTS (SELECT 1 FROM external_source_deletion_events d WHERE d.source_id = ${alias}.source_id)`
}

/**
 * Recall 侧统一谓词：头版本证据里含已删除外部来源的 Artifact 不参与召回。
 * 只检查当前头版本（与 FTS/LIKE/listHeads/final-check 的读取口径一致），
 * 历史 revision 的删除不必让整条记忆永久消失。
 */
export function andHeadEvidenceSourcesActive(artifactAlias = 'a', revisionExpr = 'r.revision'): string {
  if (!ALIAS_RE.test(artifactAlias)) throw new Error('E_ALIAS_INVALID')
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(revisionExpr)) throw new Error('E_ALIAS_INVALID')
  return `NOT EXISTS (
    SELECT 1 FROM artifact_evidence ae
    JOIN external_source_deletion_events d
      ON d.source_id = ae.source_id
     AND d.event_id = (SELECT MAX(x.event_id) FROM external_source_deletion_events x WHERE x.source_id = ae.source_id)
    WHERE ae.artifact_id = ${artifactAlias}.artifact_id
      AND ae.revision = ${revisionExpr}
  )`
}

/** 单条 Artifact 头版本是否引用了已删除的外部来源（final-check 用）。 */
export function revisionHasDeletedExternalSource(db: Db, artifactId: string, revision: number): boolean {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM artifact_evidence ae
       WHERE ae.artifact_id = ? AND ae.revision = ?
         AND EXISTS (SELECT 1 FROM external_source_deletion_events d WHERE d.source_id = ae.source_id)`,
    [artifactId, revision],
  ) as { n: number } | undefined
  return Number(row?.n ?? 0) > 0
}

export function listExternalSources(
  db: Db,
  options: { kind?: ExternalSourceKind; includeDeleted?: boolean } = {},
): ExternalSourceRow[] {
  const where: string[] = []
  const params: string[] = []
  if (options.kind) {
    where.push('e.kind = ?')
    params.push(options.kind)
  }
  if (!options.includeDeleted) where.push(andExternalSourceActive('e'))
  const sql = `SELECT e.*, (
      SELECT d.action FROM external_source_deletion_events d
      WHERE d.source_id = e.source_id ORDER BY d.event_id DESC LIMIT 1
    ) AS deletion_action
    FROM external_sources e
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY e.created_at DESC, e.source_id`
  return db.prepare(sql).all(...params) as ExternalSourceRow[]
}

export interface DeletionResult {
  sourceId: string
  action: ExternalDeletionAction
  eventId: number | null
  redacted: boolean
  logicalOnly: boolean
  idempotent: boolean
}

export function requestExternalSourceDeletion(
  db: Db,
  input: { sourceId: string; action?: ExternalDeletionAction; by: string; reason?: string; now?: number },
): DeletionResult {
  requireOwner(input.by)
  const action = input.action ?? 'delete'
  if (action !== 'delete' && action !== 'purge') throw new Error('E_ACTION_INVALID')
  return db.transaction(() => {
    const exists = db.prepare('SELECT source_id FROM external_sources WHERE source_id = ?').get(input.sourceId)
    if (!exists) throw new Error('E_EXTERNAL_SOURCE_NOT_FOUND')
    const latest = db
      .prepare('SELECT action FROM external_source_deletion_events WHERE source_id = ? ORDER BY event_id DESC LIMIT 1')
      .get(input.sourceId) as { action: ExternalDeletionAction } | undefined
    if (latest?.action === action) {
      return { sourceId: input.sourceId, action, eventId: null, redacted: false, logicalOnly: true, idempotent: true }
    }
    if (latest?.action === 'purge') throw new Error('E_ALREADY_PURGED')
    const now = input.now ?? Date.now()
    const info = db
      .prepare(
        `INSERT INTO external_source_deletion_events (source_id, action, at, by, reason)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.sourceId, action, now, input.by, input.reason ?? null)
    // sources 是 append-only（UPDATE 触发器拒绝），因此这里只能做逻辑删除：
    // 记录删除事件，所有外部来源读取路径用 andExternalSourceActive 过滤；
    // 物理擦除需要独立的库重建/冷备份流程，不在本模块内宣称已完成。
    return {
      sourceId: input.sourceId,
      action,
      eventId: Number(info.lastInsertRowid),
      redacted: false,
      logicalOnly: true,
      idempotent: false,
    }
  })
}

/** 过期清理：只处理 retention_until <= now 且尚无删除事件的登记。 */
export function purgeExpiredExternalSources(
  db: Db,
  input: { by: string; now?: number; reason?: string },
): { purged: number; events: number[] } {
  requireOwner(input.by)
  const now = input.now ?? Date.now()
  return db.transaction(() => {
    const due = db
      .prepare(
        `SELECT e.source_id FROM external_sources e
         WHERE e.retention_until IS NOT NULL AND e.retention_until <= ?
           AND ${andExternalSourceActive('e')}
         ORDER BY e.retention_until, e.source_id`,
      )
      .all(now) as Array<{ source_id: string }>
    const events: number[] = []
    for (const row of due) {
      const info = db
        .prepare(
          `INSERT INTO external_source_deletion_events (source_id, action, at, by, reason)
           VALUES (?, 'purge', ?, ?, ?)`,
        )
        .run(row.source_id, now, input.by, input.reason ?? 'retention_expired')
      events.push(Number(info.lastInsertRowid))
    }
    return { purged: due.length, events }
  })
}
