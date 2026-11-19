/**
 * R6-CAP-2：Source 隔离。
 *
 * 背景：pre-step 注入块（role 仍是 user）一度被 Capture 当成用户消息采集，
 * 形成 Runtime Injection → Source → Event → Artifact 的自证环。sources 是
 * append-only 的（触发器禁止 UPDATE），所以「隔离」不能写成 sources.metadata
 * 的原地修改，而是往 `quarantined_sources` 追加一条独立审计记录：
 *   - 原始 Source 保留，来源链可追溯；
 *   - 派生层（`Core.#loadSources`）读这张表，命中就拒绝作为证据；
 *   - reason 记录为什么隔离，note 留人工说明。
 *
 * 这是「标记」不是「删除」：删除会让追溯断掉，也可能把已经写进 Event 的
 * 引用变成悬空外键；隔离只影响「还能不能当证据用」。
 */
import { nowIso, type Db } from './adapter.js'

export interface QuarantineRecord {
  sourceId: string
  reason: string
  note: string | null
  quarantinedAt: string
}

/** 当前只有一种隔离原因；写成常量是为了审计时不用猜字符串。 */
export const QUARANTINE_REASON_RUNTIME_INJECTION = 'runtime-injection'

/**
 * 标记一条 Source 为隔离。幂等：已隔离返回 false，不覆盖原记录的 reason/note。
 */
export function quarantineSource(
  db: Db,
  input: { sourceId: string; reason?: string; note?: string | null },
): boolean {
  const result = db.run(
    `INSERT OR IGNORE INTO quarantined_sources (source_id, reason, note, quarantined_at)
     VALUES (?, ?, ?, ?)`,
    [
      input.sourceId,
      input.reason ?? QUARANTINE_REASON_RUNTIME_INJECTION,
      input.note ?? null,
      nowIso(),
    ],
  )
  return result.changes === 1
}

export function isQuarantined(db: Db, sourceId: string): boolean {
  const row = db.get<{ present: number }>(
    'SELECT 1 AS present FROM quarantined_sources WHERE source_id = ?',
    [sourceId],
  )
  return row !== undefined
}

/**
 * 批量查哪些 id 被隔离。派生层在把 Source 当证据前调用；返回保持输入顺序。
 */
export function quarantinedIds(db: Db, sourceIds: readonly string[]): string[] {
  const unique = [...new Set(sourceIds.filter((id) => id.length > 0))]
  if (unique.length === 0) return []
  const placeholders = unique.map(() => '?').join(',')
  const rows = db.all<{ source_id: string }>(
    `SELECT source_id FROM quarantined_sources WHERE source_id IN (${placeholders})`,
    unique,
  )
  const found = new Set(rows.map((row) => row.source_id))
  return unique.filter((id) => found.has(id))
}

export function listQuarantined(db: Db, limit = 50): QuarantineRecord[] {
  const rows = db.all<{ source_id: string; reason: string; note: string | null; quarantined_at: string }>(
    `SELECT source_id, reason, note, quarantined_at FROM quarantined_sources
     ORDER BY quarantined_at DESC LIMIT ?`,
    [limit],
  )
  return rows.map((row) => ({
    sourceId: row.source_id,
    reason: row.reason,
    note: row.note,
    quarantinedAt: row.quarantined_at,
  }))
}
