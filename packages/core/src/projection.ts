// P2 Completion Batch 阶段 4：Stance Projection 与 stance_revised 派生事件。
//
// 设计原则（用户 m32066 冻结）：
// - 不新增 schema：立场视图与修订事件都能从 artifact / artifact_revisions 完全派生；
// - 事实依据是成功写入的 Stance Revision，Decision Receipt 只用于补充依据，
//   因此 Receipt 写失败不影响「真实发生了修订」这件事；
// - 首次创建不算修订；只加证据（changedBecause='evidence'）不算；
// - 输出确定性：同样的库状态必须给同样的顺序；
// - Scope 隔离：subject_refs 里绑了 Contact 的立场只对本人可见，没绑的是全局立场。
import type { SqlParam } from './adapter.js'
import type { Db } from './adapter.js'
import type { StanceDirection } from './stance-engine.js'

/** challenged 立场的提示语：可以展示，但不能当成确定结论。 */
export const STANCE_CHALLENGED_NOTE = '该立场存在争议，不能作为确定事实'

export interface StanceProjectionScope {
  /** 当前可信 Contact；为空时只能看到全局立场。 */
  contactId?: string | null
}

export interface StanceProjectionItem {
  artifactId: string
  revision: number
  statement: string
  state: 'active' | 'challenged'
  group: string
  direction: StanceDirection
  confidence: string
  disclosure: string
  statusNote: string | null
  evidenceCount: number
  subjects: string[]
  updatedAt: string
}

export interface StanceRevisionEvent {
  stanceArtifactId: string
  fromRevision: number
  toRevision: number
  changedBecause: string
  decisionRunId: string | null
  occurredAt: string
}

interface HeadRow {
  artifact_id: string
  revision: number
  state: string
  statement: string
  subject_refs: string
  payload: string | null
  confidence: string
  disclosure: string
  updated_at: string
}

const DIRECTIONS: readonly StanceDirection[] = ['for', 'against', 'neutral']

function parsePayload(value: string | null): Record<string, unknown> {
  if (value === null || value.trim() === '') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function parseSubjects(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** 与 Composer 的 firstContactRef 同规则：subject_refs 里第一个 ct_ 引用。 */
function contactRefOf(subjects: readonly string[]): string | null {
  for (const subject of subjects) {
    if (subject.startsWith('ct_')) return subject
  }
  return null
}

function visibleInScope(subjects: readonly string[], scope: StanceProjectionScope): boolean {
  const bound = contactRefOf(subjects)
  if (bound === null) return true
  const current = scope.contactId ?? null
  return current !== null && bound === current
}

function directionOf(payload: Record<string, unknown>): StanceDirection {
  const value = payload.stanceDirection
  return typeof value === 'string' && (DIRECTIONS as readonly string[]).includes(value)
    ? (value as StanceDirection)
    : 'neutral'
}

function groupOf(payload: Record<string, unknown>): string {
  const value = payload.stanceGroup
  return typeof value === 'string' ? value.trim().slice(0, 100) : ''
}

function orderKey(item: StanceProjectionItem): string {
  return `${item.updatedAt}|${item.artifactId}|${String(item.revision).padStart(6, '0')}`
}

/**
 * 当前立场视图：每个 stance 只取 head（max revision），只放行 active/challenged。
 * 排序固定为 updatedAt DESC → artifactId ASC，保证同样的库状态得到同样的数组。
 */
export function projectStances(db: Db, scope: StanceProjectionScope = {}): StanceProjectionItem[] {
  const rows = db.all<HeadRow>(
    `SELECT a.artifact_id, r.revision, r.state, r.statement, r.subject_refs, r.payload,
            r.confidence, r.disclosure, r.updated_at
       FROM artifacts a
       JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
      WHERE a.kind = 'stance'
        AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)`,
    [] as SqlParam[],
  )
  const items: StanceProjectionItem[] = []
  for (const row of rows) {
    if (row.state !== 'active' && row.state !== 'challenged') continue
    const subjects = parseSubjects(row.subject_refs)
    if (!visibleInScope(subjects, scope)) continue
    const payload = parsePayload(row.payload)
    const evidence = db.get<{ n: number }>(
      `SELECT count(DISTINCT independence_key) AS n FROM artifact_evidence WHERE artifact_id = ? AND revision = ?`,
      [row.artifact_id, row.revision],
    )
    items.push({
      artifactId: row.artifact_id,
      revision: row.revision,
      statement: row.statement,
      state: row.state === 'challenged' ? 'challenged' : 'active',
      group: groupOf(payload),
      direction: directionOf(payload),
      confidence: row.confidence,
      disclosure: row.disclosure,
      statusNote: row.state === 'challenged' ? STANCE_CHALLENGED_NOTE : null,
      evidenceCount: Number(evidence?.n ?? 0),
      subjects,
      updatedAt: row.updated_at,
    })
  }
  items.sort((a, b) => (orderKey(a) < orderKey(b) ? 1 : orderKey(a) > orderKey(b) ? -1 : 0))
  return items
}

interface RevisionRow {
  artifact_id: string
  revision: number
  payload: string | null
  updated_at: string
}

/**
 * 派生 stance_revised 事件：相邻两个 revision 之间，只有「非 evidence-only」才算修订。
 * 首次创建（revision 1）不产生事件；只加证据不改正文的版本也不算。
 * Decision Receipt 只是补充：有就带上 runId，没有也照样返回事件。
 */
export function stanceRevisionEvents(
  db: Db,
  scope: StanceProjectionScope = {},
): StanceRevisionEvent[] {
  const rows = db.all<RevisionRow>(
    `SELECT a.artifact_id, r.revision, r.payload, r.updated_at
       FROM artifacts a
       JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
      WHERE a.kind = 'stance'
      ORDER BY a.artifact_id ASC, r.revision ASC`,
    [] as SqlParam[],
  )

  // 一次性拿 scope 判定需要的 subject_refs（head 上）
  const headSubjects = new Map<string, string[]>()
  const headRows = db.all<{ artifact_id: string; subject_refs: string }>(
    `SELECT a.artifact_id, r.subject_refs
       FROM artifacts a
       JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
      WHERE a.kind = 'stance'
        AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)`,
    [] as SqlParam[],
  )
  for (const row of headRows) headSubjects.set(row.artifact_id, parseSubjects(row.subject_refs))

  const byArtifact = new Map<string, RevisionRow[]>()
  for (const row of rows) {
    const list = byArtifact.get(row.artifact_id) ?? []
    list.push(row)
    byArtifact.set(row.artifact_id, list)
  }

  const events: StanceRevisionEvent[] = []
  for (const [artifactId, revisions] of byArtifact) {
    const subjects = headSubjects.get(artifactId) ?? []
    if (!visibleInScope(subjects, scope)) continue
    for (let i = 1; i < revisions.length; i += 1) {
      const previous = revisions[i - 1]
      const current = revisions[i]
      const changedBecause = parsePayload(current.payload).changedBecause
      const reason = typeof changedBecause === 'string' ? changedBecause : 'unknown'
      if (reason === 'evidence') continue
      const run = db.get<{ decision_id: string }>(
        `SELECT decision_id FROM decision_runs
          WHERE kind = 'stance' AND status = 'committed'
            AND result_artifact_id = ? AND result_revision = ?
          ORDER BY finalized_at DESC, decision_id ASC LIMIT 1`,
        [artifactId, current.revision],
      )
      events.push({
        stanceArtifactId: artifactId,
        fromRevision: previous.revision,
        toRevision: current.revision,
        changedBecause: reason,
        decisionRunId: run?.decision_id ?? null,
        occurredAt: current.updated_at,
      })
    }
  }
  events.sort((a, b) =>
    a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : a.stanceArtifactId < b.stanceArtifactId ? -1 : 1,
  )
  return events
}
