/**
 * P2 Recall · R3：统一召回内核。
 *
 * 目标（用户 m18536 冻结）：
 * - 主动 Recall（模型工具 / Owner API）与自动注入（PreStepInjector）共用同一套
 *   候选生成、状态/披露/Scope/Subject 准入与排序；
 * - 二者只保留不同的输出形状与预算，不各自维护一套可见性规则；
 * - 不再保留 `instr` 隐式子串兜底。
 *
 * 边界：
 * - Scope 只能来自可信 RuntimeInput / Owner 授权上下文（本模块只接受参数，不判断来源）；
 * - 状态只放行 active / challenged（后者带 statusNote）；
 * - 只返回当前 head、当前 Revision 为 public 的结论；
 * - Event 不返回原始正文与 Source id，只给非敏感的关联摘要；
 * - `supportEvidenceCount` 按 D5-B 口径：只算 supports、按 independence_key 去重、
 *   只算当前 Revision，不计 contradicts / 旧 Revision / 重复采集。
 */
import type { Db, SqlParam } from './adapter.js'
import {
  FTS_DEFAULT_STATES,
  searchFts,
  subjectScopeConditions,
  visibilityConditions,
  type FtsHit,
  type FtsScope,
} from './fts.js'
import { searchDiaryFts } from './diary-recall.js'
import { andMemoryActive } from './memory-hygiene.js'
import { andHeadEvidenceSourcesActive } from './external-source.js'

/** 可信 Scope；字段都由宿主注入，模型参数不可能出现在这里。 */
export interface RecallScope extends FtsScope {
  channel?: string | null
  groupId?: string | null
  /** 用于把外部群号解析成 rooms.room_id（platform + groupId）。 */
  platform?: string | null
}

/**
 * R3.1：把「外部群号」解析成稳定的 rooms.room_id。
 *
 * 只认 platform + channel='group' + external_room_id 精确匹配；
 * 解析不到返回 null（调用方只放行 global/personal，不猜、不按群名匹配）。
 */
export function resolveRoomId(db: Db, platform: string | null | undefined, groupId: string | null | undefined): string | null {
  const p = typeof platform === 'string' ? platform.trim() : ''
  const g = typeof groupId === 'string' ? groupId.trim() : ''
  if (p.length === 0 || g.length === 0) return null
  const row = db.get<{ room_id: string }>(
    `SELECT room_id FROM rooms
      WHERE platform = ? AND channel = 'group' AND external_room_id = ?
      LIMIT 1`,
    [p, g],
  )
  return row?.room_id ?? null
}

/** 把 RecallScope 收敛成 FTS 层认识的可见性参数。
 *
 * 关键：允许域由「运行表面」决定，不是由「有没有身份」决定。
 * - personal（桌面/Web/System）：personal + 当前 Contact 的 private；
 * - private（QQ 私聊等）：只有当前 Contact 的 private；
 * - group（群聊）：只有当前 Room 的 group——发送者的 contactId 不代表其私聊记忆可进群。
 * 没有 surface 且没有身份时返回严格空 scope（只给 global）。
 */
function ftsScopeOf(scope: RecallScope, roomId: string | null): FtsScope {
  const contactId = typeof scope.contactId === 'string' && scope.contactId.trim().length > 0 ? scope.contactId.trim() : null
  const platform = typeof scope.platform === 'string' ? scope.platform.trim().toLowerCase() : ''
  const surface = scope.surface
    ?? (platform === 'desktop' || platform === 'web' || platform === 'system' || platform === 'dsh'
      ? 'personal'
      : roomId !== null
        ? 'group'
        : contactId !== null
          ? 'private'
          : undefined)
  return {
    contactId,
    roomId,
    ...(surface === undefined
      ? { allowPersonal: false, allowContact: false, allowRoom: false }
      : { surface, ...(scope.allowPersonal === undefined ? {} : { allowPersonal: scope.allowPersonal }) }),
  }
}

export interface RecallItem {
  artifactId: string
  kind: string
  revision: number
  state: 'active' | 'challenged'
  /** challenged 才有：明确的争议说明，禁止只在自动注入时处理争议。 */
  statusNote?: string
  statement: string
  disclosure: 'public'
  confidence: string
  /** D5-B：只算 supports、按 independence_key 去重、只算当前 Revision。 */
  supportEvidenceCount: number
  updatedAt: string
  /** 非敏感关联摘要：只给事件类型与时间，不给 eventId / 正文 / Source id。 */
  relatedEvents: { type: string; at: string }[]
  /** v18：diary 条目的稳定 id（`kind === 'diary'` 时存在）；artifactId 也等于它，便于统一消费。 */
  diaryId?: string
}

export interface RecallEngineQuery {
  text?: string
  query?: string
  kind?: string
  subject?: string
  limit?: number
  /** 默认 true；显式 false 时只召回结构化记忆（自动注入路径用）。 */
  includeDiaries?: boolean
}

/** 内部拒绝计数：只进审计/调试，不得进入模型可见结果（R2 §6）。 */
export interface RecallRejections {
  missing: number
  stale: number
  state: number
  disclosure: number
  scope: number
}

/** 回库复核阶段被拒的单条候选（R4-B 回执用；不含正文，不含被 SQL 过滤掉的行）。 */
export interface RecallRejectedItem {
  artifactId: string
  revision: number
  reason: 'missing' | 'stale' | 'state' | 'disclosure'
}

/** 回执用的候选轨迹：rawRank = 检索原始序，finalRank = 准入后最终序。 */
export interface RecallCandidateTrace {
  artifactId: string
  revision: number
  rawRank: number | null
  eligible: boolean
  rejectReason: 'missing' | 'stale' | 'state' | 'disclosure' | null
  finalRank: number | null
}

export interface RecallEngineResult {
  items: RecallItem[]
  rejected: RecallRejections
  /** 回库复核被拒的明细；SQL 层被 scope/state/disclosure 过滤掉的候选不在里面（不该被回执复述）。 */
  rejectedItems: RecallRejectedItem[]
  /** R4-B 回执用：检索原始序与最终序分开记，回答「高相关为什么没进上下文」。 */
  candidates: RecallCandidateTrace[]
  searched: number
  /** R4-A：召回阶段是否没有任何合格候选（对外统一语义，见 RecallResult）。 */
  abstained: boolean
  abstainReason: RecallAbstainReason | null
}

/**
 * R4-A 对外召回结果（用户 m19725 冻结）。
 *
 * 只有「没有合格记忆」才是 abstention；数据库/查询异常继续抛错，
 * 不能被包装成正常的空召回。`results.length === 0` 不作为判断依据，
 * 调用方读 `abstained` 字段。
 */
export interface RecallResult<T = RecallItem> {
  results: T[]
  abstained: boolean
  abstainReason: RecallAbstainReason | null
  /** 只在 abstained 时给；Core 层唯一常量，工具层与 UI 只消费不复制。 */
  guidance?: string
  /** R4-A 不生成；R4-B 的 recall_runs 落地后再由真实 Run 填。 */
  runId?: string
}

export type RecallAbstainReason = 'no_eligible_results'

/** 空召回时给模型/用户的固定提示；Core 唯一副本。 */
export const RECALL_ABSTAIN_GUIDANCE =
  '这次没有找到可用的记忆。不要根据上下文猜测成「我记得」，也不要把空白补成一段关于对方的描述。'

export interface RecallEngineOptions {
  /** 默认 8；调用方（工具/面板）各自再做自己的上限 */
  limit?: number
  /** 多取多少倍候选再复核；默认 3，保证过滤后仍能补满 */
  overFetch?: number
}

export const RECALL_STATUS_NOTE = '该观点存在争议，不能作为确定事实'

const MAX_LIMIT = 20
const DEFAULT_LIMIT = 8

function clampLimit(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(Math.trunc(number), MAX_LIMIT))
}

interface HeadRow {
  artifact_id: string
  kind: string
  revision: number
  state: string
  statement: string
  disclosure: string
  confidence: string
  updated_at: string
}

interface LinkedEventRow {
  artifact_id: string
  type: string
  at: string
}

function readHead(db: Db, artifactId: string): HeadRow | null {
  return (
    db.get<HeadRow>(
      `SELECT a.artifact_id, a.kind, r.revision, r.state, r.statement, r.disclosure,
              r.confidence, r.updated_at
         FROM artifacts a
         JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
        WHERE a.artifact_id = ?
          AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)`,
      [artifactId],
    ) ?? null
  )
}

/** 批量取支持证据数（避免每条 Artifact 各查一次）。 */
function supportEvidenceCounts(db: Db, artifactIds: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  if (artifactIds.length === 0) return counts
  const marks = artifactIds.map(() => '?').join(', ')
  const rows = db.all<{ artifact_id: string; n: number }>(
    `SELECT e.artifact_id AS artifact_id, COUNT(DISTINCT e.independence_key) AS n
       FROM artifact_evidence e
       JOIN artifact_revisions r ON r.artifact_id = e.artifact_id AND r.revision = e.revision
      WHERE e.relation = 'supports'
        AND e.artifact_id IN (${marks})
        AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = e.artifact_id)
      GROUP BY e.artifact_id`,
    artifactIds,
  )
  for (const row of rows) counts.set(row.artifact_id, Number(row.n) || 0)
  return counts
}

/** 批量取关联事件摘要（只 type/at，最多 2 条/条记忆，按时间倒序）。 */
function relatedEvents(db: Db, artifactIds: string[]): Map<string, { type: string; at: string }[]> {
  const map = new Map<string, { type: string; at: string }[]>()
  if (artifactIds.length === 0) return map
  const marks = artifactIds.map(() => '?').join(', ')
  const rows = db.all<LinkedEventRow>(
    `SELECT DISTINCT t.artifact_id AS artifact_id, e.type AS type, e.at AS at
       FROM artifact_trigger_events t
       JOIN events e ON e.event_id = t.event_id
      WHERE t.artifact_id IN (${marks})
      ORDER BY e.at DESC`,
    artifactIds,
  )
  for (const row of rows) {
    const list = map.get(row.artifact_id) ?? []
    if (list.length < 2) list.push({ type: row.type, at: row.at })
    map.set(row.artifact_id, list)
  }
  return map
}

/** 无文本时的结构化列表：只按 head/准入/时间排序，不做任何子串匹配。 */
function listHeads(db: Db, query: RecallEngineQuery, scope: FtsScope, limit: number): FtsHit[] {
  const states = FTS_DEFAULT_STATES
  const placeholders = states.map(() => '?').join(', ')
  const params: SqlParam[] = [...states]
  const conditions: string[] = []
  if (query.kind) {
    conditions.push('a.kind = ?')
    params.push(query.kind)
  }
  const subjectFilter = subjectScopeConditions(scope)
  conditions.push(subjectFilter.sql.replace(/^AND\s+/, ''))
  params.push(...subjectFilter.params)
  const subject = typeof query.subject === 'string' ? query.subject.trim() : ''
  if (subject.length > 0) {
    conditions.push('json_valid(r.subject_refs) = 1 AND EXISTS (SELECT 1 FROM json_each(r.subject_refs) WHERE value = ?)')
    params.push(subject)
  }
  const visible = visibilityConditions({ scope })
  conditions.push(visible.sql.replace(/^AND\s+/, ''))
  params.push(...visible.params)
  params.push(limit)
  return db.all<FtsHit>(
    `SELECT a.artifact_id AS artifactId, a.kind AS kind, r.statement AS statement,
            r.state AS state, r.revision AS revision, r.disclosure AS disclosure, 0 AS score
       FROM artifacts a
       JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
        AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
      WHERE r.disclosure = 'public'
        AND r.state IN (${placeholders})
        AND ${conditions.join('\n        AND ')}
        ${andMemoryActive('a')}
        AND ${andHeadEvidenceSourcesActive('a', 'r.revision')}
      ORDER BY r.updated_at DESC, a.artifact_id ASC
      LIMIT ?`,
    params,
  )
}

/**
 * 统一召回入口。只读，不写库、不写审计表（Receipt 属 R4）。
 *
 * @param scope - 只能来自可信 RuntimeInput / Owner 授权；缺省 = 仅全局记忆。
 * @throws E_QUERY_TOO_LONG / E_QUERY_TOO_COMPLEX（来自 searchFts，调用方决定怎么转述）
 */
export function recallMemory(
  db: Db,
  query: RecallEngineQuery,
  scope: RecallScope = {},
  options: RecallEngineOptions = {},
): RecallEngineResult {
  const limit = clampLimit(query.limit ?? options.limit)
  const text = String(query.text ?? query.query ?? '').trim()
  const overFetch = Math.max(1, options.overFetch ?? 3)
  const roomId = scope.roomId ?? resolveRoomId(db, scope.platform, scope.groupId)
  const ftsScope = ftsScopeOf(scope, roomId)
  const onlyDiaries = query.kind === 'diary'
  const wantDiaries = query.includeDiaries !== false

  // 1) 候选：有线索走 FTS5 + BM25；没有线索走结构化列表（不是子串兜底）。
  const searched = onlyDiaries
    ? []
    : text.length > 0
      ? searchFts(db, text, {
          limit: limit * overFetch,
          states: FTS_DEFAULT_STATES,
          scope: ftsScope,
          ...(query.kind === undefined ? {} : { kind: query.kind }),
          ...(query.subject === undefined ? {} : { subject: query.subject }),
        })
      : listHeads(db, query, ftsScope, limit * overFetch)

  const rejected: RecallRejections = { missing: 0, stale: 0, state: 0, disclosure: 0, scope: 0 }
  const rejectedItems: RecallRejectedItem[] = []
  const survivors: HeadRow[] = []
  const candidates: RecallCandidateTrace[] = []
  const seen = new Set<string>()
  for (const [index, hit] of searched.entries()) {
    const rawRank = index + 1
    // 同一个 artifact 可能因多个 FTS 行/口令重复出现；回执主键也按 artifact 去重。
    if (seen.has(hit.artifactId)) continue
    // 2) 回库重读 head：检索之后可能被 revise，候选字段不能当判定依据。
    const head = readHead(db, hit.artifactId)
    if (head === null) {
      rejected.missing += 1
      rejectedItems.push({ artifactId: hit.artifactId, revision: hit.revision, reason: 'missing' })
      candidates.push({ artifactId: hit.artifactId, revision: hit.revision, rawRank, eligible: false, rejectReason: 'missing', finalRank: null })
      continue
    }
    if (head.revision !== hit.revision) {
      rejected.stale += 1
      rejectedItems.push({ artifactId: hit.artifactId, revision: hit.revision, reason: 'stale' })
      candidates.push({ artifactId: hit.artifactId, revision: hit.revision, rawRank, eligible: false, rejectReason: 'stale', finalRank: null })
      continue
    }
    if (!FTS_DEFAULT_STATES.includes(head.state)) {
      rejected.state += 1
      rejectedItems.push({ artifactId: hit.artifactId, revision: hit.revision, reason: 'state' })
      candidates.push({ artifactId: hit.artifactId, revision: hit.revision, rawRank, eligible: false, rejectReason: 'state', finalRank: null })
      continue
    }
    if (head.disclosure !== 'public') {
      rejected.disclosure += 1
      rejectedItems.push({ artifactId: hit.artifactId, revision: hit.revision, reason: 'disclosure' })
      candidates.push({ artifactId: hit.artifactId, revision: hit.revision, rawRank, eligible: false, rejectReason: 'disclosure', finalRank: null })
      continue
    }
    seen.add(head.artifact_id)
    survivors.push(head)
    candidates.push({ artifactId: head.artifact_id, revision: head.revision, rawRank, eligible: true, rejectReason: null, finalRank: survivors.length })
    if (survivors.length >= limit) break
  }

  // 3) 批量补充：支持证据数 + 关联事件摘要（都是非敏感字段）。
  const ids = survivors.map((row) => row.artifact_id)
  const counts = supportEvidenceCounts(db, ids)
  const events = relatedEvents(db, ids)

  const items: RecallItem[] = survivors.map((row) => ({
    artifactId: row.artifact_id,
    kind: row.kind,
    revision: row.revision,
    state: row.state === 'challenged' ? 'challenged' : 'active',
    ...(row.state === 'challenged' ? { statusNote: RECALL_STATUS_NOTE } : {}),
    statement: row.statement,
    disclosure: 'public',
    confidence: row.confidence,
    supportEvidenceCount: counts.get(row.artifact_id) ?? 0,
    updatedAt: row.updated_at,
    relatedEvents: events.get(row.artifact_id) ?? [],
  }))

  // 4) Diary：同一份查询分析、同一套 Scope 规则；不占 Receipt 候选（它是叙事，不是事实候选），
  //    也不参与证据计数——所以在 artifact 之后追加、总数仍受 limit 约束。
  if (wantDiaries && text.length > 0) {
    const remaining = onlyDiaries ? limit : Math.max(0, limit - items.length)
    if (remaining > 0) {
      try {
        const diaryHits = searchDiaryFts(
          db,
          text,
          { contactId: scope.contactId ?? null, roomId },
          remaining,
        )
        for (const hit of diaryHits) {
          items.push({
            artifactId: hit.diaryId,
            diaryId: hit.diaryId,
            kind: 'diary',
            revision: hit.version,
            state: 'active',
            statusNote: '叙事记录，不是事实依据',
            statement: hit.body.replace(/\s+/gu, ' ').trim().slice(0, 160),
            disclosure: 'public',
            confidence: 'medium',
            supportEvidenceCount: 0,
            updatedAt: `${hit.localDate}T00:00:00.000Z`,
            relatedEvents: [],
          })
        }
      } catch {
        // 日记检索异常不影响结构化记忆的召回；空结果由调用方按 abstain 处理。
      }
    }
  }

  const eligibleCount = items.length
  return {
    items,
    rejected,
    rejectedItems,
    candidates,
    searched: searched.length,
    // 四种「全被排除」（无候选/限制/来源域/证据异常）在这里统一收敛为同一个外部原因；
    // 数据库/查询异常不经过这里，继续抛出。
    abstained: eligibleCount === 0,
    abstainReason: eligibleCount === 0 ? 'no_eligible_results' : null,
  }
}
