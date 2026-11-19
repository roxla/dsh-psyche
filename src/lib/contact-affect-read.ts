// P5-R-4x：Contact Affect → 投影的只读同步读取。
//
// 约束（GPT 评审冻结项）：
// - 身份只来自 Host 可信 Agent/Session（调用方传入 contactId），不读文本/发送者。
// - 读不到就是 null（调用方按 0 处理），不回退到上一轮、不跨 Contact。
// - 只复用 Core 冻结的冷却规则 effectiveAffectValues，不另起评分。
import { effectiveAffectValues, type ContactAffectValues } from 'dsh-psyche-core'

export interface ContactAffectRowLike {
  dimension?: unknown
  value?: unknown
  updated_at?: unknown
}

export interface ContactAffectDbLike {
  all?: <T>(sql: string, params?: unknown[]) => T[]
}

/**
 * 读取某个 Contact 的当下五维感受（已按各自半衰期冷却到 now）。
 * 缺行/表不可用/值非法都返回 null，由调用方决定退化为「仅 Global Mood」。
 */
export function readContactAffectSync(
  db: ContactAffectDbLike | null,
  contactId: string | null | undefined,
  now: string | Date = new Date(),
): ContactAffectValues | null {
  if (db === null || typeof db.all !== 'function') return null
  if (typeof contactId !== 'string' || contactId.trim() === '') return null
  let rows: ContactAffectRowLike[]
  try {
    rows = db.all<ContactAffectRowLike>(
      'SELECT dimension, value, updated_at FROM contact_affect_state WHERE persona_id = ? AND contact_id = ?',
      ['main', contactId],
    )
  } catch {
    return null
  }
  if (!Array.isArray(rows) || rows.length === 0) return null
  const raw: Record<string, { value: number; updatedAt: string }> = {}
  for (const row of rows) {
    const dimension = typeof row?.dimension === 'string' ? row.dimension : ''
    if (dimension === '') continue
    const value = Number(row?.value)
    const updatedAt = typeof row?.updated_at === 'string' ? row.updated_at : ''
    if (!Number.isFinite(value) || updatedAt === '') continue
    raw[dimension] = { value, updatedAt }
  }
  if (Object.keys(raw).length === 0) return null
  return effectiveAffectValues(raw, now)
}
