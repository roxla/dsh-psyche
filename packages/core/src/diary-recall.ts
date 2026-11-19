// Diary Recall v1（P2 Completion Batch 阶段 5）。
//
// 不建第二套检索：复用 fts_index 的 kind='diary' 行、同一套中文 bigram 查询分析与 MATCH 表达式，
// 只是把「结果集」换成 diaries / diary_versions。Scope 过滤在 SQL 内、LIMIT 之前完成。
//
// 可见性规则（与 Recall 的 Scope 语义一致）：
//   全局日记（contact_id 与 room_id 都为空）对所有范围可见；
//   Contact 日记只对该 Contact 可见；Room 日记只对该 Room 可见。
// 没有任何匹配时返回空数组（由调用方决定是否 abstain），绝不编造经历。
import { analyzeFtsQuery, buildFtsQuery } from './fts.js'
import type { Db } from './adapter.js'

export interface DiaryRecallScope {
  contactId?: string | null
  roomId?: string | null
}

export interface DiaryHit {
  diaryId: string
  version: number
  body: string
  localDate: string
  scopeKey: string
  score: number
}

const MAX_LIMIT = 20
const MAX_QUERY_CHARS = 200

function likePattern(value: string): string {
  const escaped = value.replace(/[%_\\]/g, (char) => `\\${char}`)
  return `%${escaped}%`
}

/**
 * 在日记正文上做一次检索。
 *
 * 参数：
 *   - `query`：用户问题（与 Artifact 检索共用同一份分词）；
 *   - `scope`：当前可信 Contact / Room（缺失 = 只能看到全局日记）；
 *   - `limit`：最多返回几条（默认 8，上限 20）。
 *
 * 返回：按 BM25 分数降序、同分按 diary_id 升序的日记正文片段（含 head 版本）。
 */
export function searchDiaryFts(
  db: Db,
  query: string,
  scope: DiaryRecallScope = {},
  limit = 8,
): DiaryHit[] {
  const trimmed = String(query ?? '').trim()
  if (trimmed === '') return []
  if (Array.from(trimmed).length > MAX_QUERY_CHARS) return []

  const analysis = analyzeFtsQuery(trimmed)
  const contact = typeof scope.contactId === 'string' ? scope.contactId.trim() : ''
  const room = typeof scope.roomId === 'string' ? scope.roomId.trim() : ''
  const bounded = Math.max(1, Math.min(Math.trunc(limit), MAX_LIMIT))

  // 可见性表达式：全局 OR 当前 Contact OR 当前 Room。参数恒有四项（空串当 NULL 用）。
  const visible = `
      AND (
        (d.contact_id IS NULL AND d.room_id IS NULL)
        OR (? <> '' AND d.contact_id = ?)
        OR (? <> '' AND d.room_id = ?)
      )`

  if (analysis.mode === 'like') {
    const parts = analysis.likeSegments.map((segment) => segment.trim()).filter((item) => item.length > 0)
    if (parts.length === 0) return []
    const conditions = parts.map(() => 'AND v.body LIKE ? ESCAPE \'\\\'').join('\n       ')
    const sql = `
      SELECT d.diary_id AS diaryId, d.head_version AS version, v.body AS body,
             d.local_date AS localDate, d.scope_key AS scopeKey, 0 AS score
        FROM diaries d
        JOIN diary_versions v ON v.diary_id = d.diary_id AND v.version = d.head_version
       WHERE 1 = 1
         ${conditions}
         ${visible}
       ORDER BY d.local_date DESC, d.diary_id ASC
       LIMIT ?`
    const params: Array<string | number> = [...parts.map(likePattern), contact, contact, room, room, bounded]
    return db.all<DiaryHit>(sql, params)
  }

  const expression = buildFtsQuery(analysis)
  const likeConditions = analysis.likeSegments
    .map(() => 'AND v.body LIKE ? ESCAPE \'\\\'')
    .join('\n       ')
  const sql = `
    SELECT f.ref_id AS diaryId, d.head_version AS version, v.body AS body,
           d.local_date AS localDate, d.scope_key AS scopeKey,
           -bm25(fts_index, 0.0, 0.0, 1.0) AS score
      FROM fts_index f
      JOIN diaries d ON d.diary_id = f.ref_id
      JOIN diary_versions v ON v.diary_id = d.diary_id AND v.version = d.head_version
     WHERE fts_index MATCH ? AND f.kind = 'diary'
       ${likeConditions}
       ${visible}
     ORDER BY score DESC, f.ref_id ASC
     LIMIT ?`
  const params: Array<string | number> = [expression, ...analysis.likeSegments.map(likePattern)]
  params.push(contact, contact, room, room, bounded)
  return db.all<DiaryHit>(sql, params)
}
