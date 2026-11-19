// Diary 完整性检查（P2 Completion Batch 阶段 5）。
//
// 只读：不修数据、不重写版本、不触发重新生成。阶段 0 的 `psyche-integrity`
// 可以直接复用这里的检查结果，不必再写一套 Diary 规则。
//
// 检查四类问题：
//   1. head-version-missing：diaries.head_version 找不到对应版本行（壳与版本脱节）；
//   2. dangling-source：diary_versions.source_refs 引用的 Artifact / Event / Tension 不存在；
//   3. duplicate-ref：同一版本里同一引用重复出现（会让「来源数」虚高）；
//   4. orphan-version：diary_versions 里的行找不到对应的 diaries 壳。
//
// 注意：来源被「遗忘」但仍在库里（state=forgotten/retracted）不算 dangling——
// 物理删除才是失效。语义失效属于 Recall/Projection 的过滤职责。
import type { Db } from './adapter.js'

export type DiaryIntegrityIssueKind =
  | 'head-version-missing'
  | 'dangling-source'
  | 'duplicate-ref'
  | 'orphan-version'

export interface DiaryIntegrityIssue {
  kind: DiaryIntegrityIssueKind
  diaryId: string
  version: number | null
  detail: string
}

export interface DiaryIntegrityReport {
  checkedDiaries: number
  checkedVersions: number
  issues: DiaryIntegrityIssue[]
}

interface SourceRefRow {
  refType?: unknown
  refId?: unknown
  refRevision?: unknown
}

function parseRefs(raw: unknown): SourceRefRow[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as SourceRefRow[]) : []
  } catch {
    return []
  }
}

export function inspectDiaryIntegrity(db: Db): DiaryIntegrityReport {
  const issues: DiaryIntegrityIssue[] = []

  const diaries = db.all<Record<string, unknown>>(
    `SELECT diary_id, head_version FROM diaries ORDER BY diary_id ASC`,
  )
  const heads = new Map<string, number>()
  for (const row of diaries) {
    const diaryId = String(row.diary_id)
    const head = Number(row.head_version)
    heads.set(diaryId, head)
    const headRow = db.get<{ one: number }>(
      `SELECT 1 AS one FROM diary_versions WHERE diary_id = ? AND version = ?`,
      [diaryId, head],
    )
    if (headRow === undefined) {
      issues.push({
        kind: 'head-version-missing',
        diaryId,
        version: head,
        detail: `head_version=${head} 没有对应版本行`,
      })
    }
  }

  const versions = db.all<Record<string, unknown>>(
    `SELECT diary_id, version, source_refs FROM diary_versions ORDER BY diary_id ASC, version ASC`,
  )
  for (const row of versions) {
    const diaryId = String(row.diary_id)
    const version = Number(row.version)
    if (!heads.has(diaryId)) {
      issues.push({
        kind: 'orphan-version',
        diaryId,
        version,
        detail: '版本行没有对应的 diaries 壳',
      })
    }

    const refs = parseRefs(row.source_refs)
    const seen = new Set<string>()
    for (const ref of refs) {
      const refType = typeof ref.refType === 'string' ? ref.refType : ''
      const refId = typeof ref.refId === 'string' ? ref.refId : ''
      if (refId === '') continue
      const key = `${refType}:${refId}`
      if (seen.has(key)) {
        issues.push({
          kind: 'duplicate-ref',
          diaryId,
          version,
          detail: `重复引用 ${key}`,
        })
      }
      seen.add(key)

      if (refType === 'artifact') {
        const found = db.get<{ one: number }>(
          `SELECT 1 AS one FROM artifact_revisions WHERE artifact_id = ?`,
          [refId],
        )
        if (found === undefined) {
          issues.push({
            kind: 'dangling-source',
            diaryId,
            version,
            detail: `Artifact ${refId} 不存在`,
          })
        }
      } else if (refType === 'event') {
        const found = db.get<{ one: number }>(`SELECT 1 AS one FROM events WHERE event_id = ?`, [refId])
        if (found === undefined) {
          issues.push({
            kind: 'dangling-source',
            diaryId,
            version,
            detail: `Event ${refId} 不存在`,
          })
        }
      } else if (refType === 'tension') {
        const found = db.get<{ one: number }>(
          `SELECT 1 AS one FROM tension_versions WHERE tension_id = ?`,
          [refId],
        )
        if (found === undefined) {
          issues.push({
            kind: 'dangling-source',
            diaryId,
            version,
            detail: `Tension ${refId} 不存在`,
          })
        }
      }
    }
  }

  return { checkedDiaries: diaries.length, checkedVersions: versions.length, issues }
}
