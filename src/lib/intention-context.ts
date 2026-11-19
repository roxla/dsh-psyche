/**
 * P6-1/P6-2：把「当前 internal 意愿」读成投影里的一行。
 *
 * 边界（P6-1 GPT 冻结 + P6-2 补充）：
 * - 只读，不写库、不推进状态、不产生行动。
 * - 只有可信绑定 Agent 才允许调用；调用方负责 persona 门控。
 * - 表不存在（P6-2 迁移前）或行非法时返回 null，由投影层整块省略。
 * - 证据撤销/失效时立即停止投影：任一证据 ID 在 sources/artifacts 均不存在则不返回。
 * - 同一时刻只取一条：score 最高、created_at 最新。
 */

export const INTENTION_LINE_MAX_CHARS = 120

export interface IntentionContextRow {
  intention_id: string
  type: string
  statement: string
  evidence_json: string
  expires_at: number
}

export interface IntentionContextDb {
  get?: <T>(sql: string, params?: unknown[]) => T | undefined
}

const SYSTEM_VOICE = /检测到|内部触发|系统播报|已生成/g

/**
 * 只保留「此刻想做什么」的自然表达，去掉系统播报腔与多余空白。
 * 不改变原句事实，只做长度与语气收缩。
 */
export function normalizeIntentionStatement(statement: string): string {
  const collapsed = statement
    .replace(SYSTEM_VOICE, '')
    .replace(/[：:，,\s]*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (collapsed.length <= INTENTION_LINE_MAX_CHARS) return collapsed
  return `${collapsed.slice(0, INTENTION_LINE_MAX_CHARS - 1)}…`
}

function parseEvidenceIds(json: string): string[] {
  try {
    const value = JSON.parse(json)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
  } catch {
    return []
  }
}

function evidenceStillExists(db: IntentionContextDb, evidenceIds: readonly string[]): boolean {
  if (typeof db.get !== 'function') return false
  for (const id of evidenceIds) {
    if (id.startsWith('moodhist:')) {
      const rowId = Number.parseInt(id.slice('moodhist:'.length), 10)
      if (!Number.isFinite(rowId)) return false
      const mood = db.get<{ ok: number }>(`SELECT 1 AS ok FROM global_mood_history WHERE history_id=? LIMIT 1`, [rowId])
      if (!mood) return false
      continue
    }
    if (id.startsWith('affecthist:')) {
      const rowId = Number.parseInt(id.slice('affecthist:'.length), 10)
      if (!Number.isFinite(rowId)) return false
      const affect = db.get<{ ok: number }>(
        `SELECT 1 AS ok FROM contact_affect_history WHERE history_id=? LIMIT 1`,
        [rowId],
      )
      if (!affect) return false
      continue
    }
    const source = db.get<{ ok: number }>(`SELECT 1 AS ok FROM sources WHERE source_id=? LIMIT 1`, [id])
    if (source) continue
    const artifact = db.get<{ ok: number }>(`SELECT 1 AS ok FROM artifacts WHERE artifact_id=? LIMIT 1`, [id])
    if (!artifact) return false
  }
  return true
}

/**
 * 读取最新 internal 意愿并渲染为一行；没有可信行时返回 null。
 * 异常一律当作「无」，不阻塞对话。
 */
export function readLatestIntentionLine(
  db: IntentionContextDb | null,
  options: { now: number; personaId: string },
): string | null {
  if (db === null || typeof db.get !== 'function') return null
  try {
    const row = db.get<IntentionContextRow>(
      `SELECT intention_id, type, statement, evidence_json, expires_at
         FROM intentions
        WHERE persona_id = ? AND status = 'internal' AND expires_at > ?
        ORDER BY score DESC, created_at DESC
        LIMIT 1`,
      [options.personaId, options.now],
    )
    if (!row || typeof row.statement !== 'string') return null
    const evidenceIds = parseEvidenceIds(row.evidence_json)
    if (evidenceIds.length === 0) return null
    if (!evidenceStillExists(db, evidenceIds)) return null
    const statement = normalizeIntentionStatement(row.statement)
    if (statement.length === 0) return null
    return `此刻的念头：${statement}`
  } catch {
    return null
  }
}
