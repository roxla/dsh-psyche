// 意识海下钻：点一颗星之后，回答「她凭什么记得这件事」。
//
// 只读：不写库、不改记忆、不算派生。数据全部来自 §11 的既有表——
// artifacts / artifact_revisions / artifact_evidence / artifact_trigger_events /
// artifact_relations / artifact_lineage / event_sources / event_relations。
//
// 为什么单独一个文件：`sea.ts` 负责「一屏画什么」，这里负责「一个点背后是什么」，
// 两者生命周期不同（海可以截断，下钻必须准），混在一起会让海的构建变重。
//
// 调用方：index.ts 的只读路由 /api/psyche/node?id=。
//
// ── 披露白名单（E5.5 收尾 P0，2026-11-07）──────────────────────────
// 这里是 **Owner 路由**，不是模型注入路径；但服务端仍然没有理由把无权展示的正文
// 序列化给浏览器。规则：
//   1. 响应对象一律由本文件显式构造白名单 DTO，**不 spread 数据库行**——
//      以后表里加了 excerpt/summary/label 之类的新字段，也不会自动漏出去。
//   2. head 的 disclosure 决定整个节点：restricted/secret 只返回最小元数据
//      （id/kind/createdAt/updatedAt/disclosure/withheld），不返回正文、标签、
//      Subject、证据、触发、关系、血统。
//   3. 历史 Revision 各自按自己的 disclosure 决定：public 给正文，其余给
//      `statement: null, withheld: true`，不返回 subjectRefs/统计别名。
//   4. Evidence 只给 relation/confidence/createdAt；不返回 quote、sourceId、
//      Source 正文。
//   5. Relations / Lineage / 事件触发目标按「目标当前 head 的 disclosure」决定：
//      受限目标整条隐藏（只留 `{relation, withheld: true}`），不返回目标 ID、
//      kind、label 或任何可反查信息。
//   6. Event 详情只返回 `id/type/at`；不返回事件正文、Source 正文或 sourceId。
import type { Db } from './adapter.js'
import { PERSONA_ID } from './store.js'

/** 允许出现在详情响应里的披露等级。 */
const PUBLIC = 'public'

/** 证据条数上限：下钻是给人看的，五条足够说明「凭什么」，多了只会灌满面板。 */
const EVIDENCE_LIMIT = 5

/** 关系/触发条数上限。 */
const RELATION_LIMIT = 8

/** 一个历史版本。数组按 revision 倒序，第一项就是 head。 */
export interface NodeDetailRevision {
  revision: number
  state: string
  disclosure: string
  /** public 版本才有正文；受限/密级为 null。 */
  statement: string | null
  /** 该版本是否被撤回展示（受限/密级）。 */
  withheld: boolean
  /** 仅 public 版本携带；受限版本不返回 Subject。 */
  subjectRefs?: string[]
  confidence?: string
  basisCount?: number
  independentEvidenceCount?: number
  createdAt: string
}

/** 一条证据（绑定到 revision，不是绑定到对象）。 */
export interface NodeDetailEvidence {
  revision: number
  relation: string
  confidence: string
  createdAt: string
}

/** 触发过这条结论的事件（只给 id/type/at）。 */
export interface NodeDetailTrigger {
  eventId: string
  type: string
  at: string
}

/** 与其它结论的关系：public 目标给 id/kind/statement，受限目标整条隐藏。 */
export type NodeDetailRelation =
  | { relation: string; withheld: false; targetId: string; targetKind: string; targetStatement: string }
  | { relation: string; withheld: true }

/** 血统：同样按目标 head 的 disclosure 决定。 */
export type NodeDetailLineage =
  | { relation: string; withheld: false; fromId: string; fromStatement: string }
  | { relation: string; withheld: true }

/** 结论节点的下钻结果。 */
export interface ArtifactNodeDetail {
  ok: true
  kind: 'artifact'
  id: string
  artifactKind: string
  createdAt: string
  updatedAt: string
  disclosure: string
  /** head 是否可展示；false 时除最小元数据外全部不返回。 */
  withheld: boolean
  head: NodeDetailRevision | null
  revisions: NodeDetailRevision[]
  evidence: NodeDetailEvidence[]
  triggers: NodeDetailTrigger[]
  relations: NodeDetailRelation[]
  lineage: NodeDetailLineage[]
}

/** 事件触发的结论：public 目标给 id/statement，受限目标隐藏。 */
export type EventTriggeredArtifact =
  | { withheld: false; artifactId: string; revision: number; statement: string }
  | { withheld: true }

/** 事件与事件的关系：只给 relation 与目标 id（事件没有正文披露字段）。 */
export interface EventNodeRelation {
  relation: string
  targetId: string
}

/** 经历节点的下钻结果（不返回事件正文与 Source）。 */
export interface EventNodeDetail {
  ok: true
  kind: 'event'
  id: string
  eventKind: string
  eventType: string
  at: string
  /** 事件正文不返回（Source 派生内容，按更严格处理）。 */
  withheld: false
  sources: { withheld: true; count: number }
  triggered: EventTriggeredArtifact[]
  relations: EventNodeRelation[]
}

export type NodeDetail = ArtifactNodeDetail | EventNodeDetail

/** 解析 subject_refs；坏数据当空数组。 */
function parseSubjects(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    return []
  }
}

/** 白名单版本 DTO：public 给正文，其余只给状态与撤回标记。 */
function revisionDto(row: {
  revision: number
  state: string
  disclosure: string
  statement: string
  subject_refs: string
  confidence: string
  basis_count: number
  independent_evidence_count: number
  created_at: string
}): NodeDetailRevision {
  if (row.disclosure === PUBLIC) {
    return {
      revision: row.revision,
      state: row.state,
      disclosure: row.disclosure,
      statement: row.statement,
      withheld: false,
      subjectRefs: parseSubjects(row.subject_refs),
      confidence: row.confidence,
      basisCount: row.basis_count,
      independentEvidenceCount: row.independent_evidence_count,
      createdAt: row.created_at,
    }
  }
  return {
    revision: row.revision,
    state: row.state,
    disclosure: row.disclosure,
    statement: null,
    withheld: true,
    createdAt: row.created_at,
  }
}

/**
 * 取一个节点的完整来历。
 *
 * 参数：`db` 只读连接；`id` 节点 id（`art_` / `evt_` 前缀）。
 * 返回：`NodeDetail`；id 不存在时返回 null（路由层转 404，不抛 500）。
 * 边界：任何一张附表查不到都不影响主对象——空数组就是「没有证据」，不是错误。
 */
export function buildNodeDetail(db: Db, id: string): NodeDetail | null {
  if (!id) return null
  if (id.startsWith('evt_')) return buildEventDetail(db, id)
  if (id.startsWith('art_')) return buildArtifactDetail(db, id)
  // 前缀不认识：按两张主表各试一次，仍然没有就 null。
  return buildArtifactDetail(db, id) ?? buildEventDetail(db, id)
}

/** 结论节点：head + 全部 revision + 证据 + 触发事件 + 关系 + 血统。 */
function buildArtifactDetail(db: Db, id: string): ArtifactNodeDetail | null {
  const artifact = db.get<{ artifact_id: string; kind: string; created_at: string; updated_at: string }>(
    `SELECT artifact_id, kind, created_at, updated_at FROM artifacts WHERE artifact_id = ? AND persona_id = ?`,
    [id, PERSONA_ID],
  )
  if (!artifact) return null

  const revisions = db.all<{
    revision: number
    state: string
    disclosure: string
    statement: string
    subject_refs: string
    confidence: string
    basis_count: number
    independent_evidence_count: number
    created_at: string
  }>(
    `SELECT revision, state, disclosure, statement, subject_refs, confidence, basis_count,
            independent_evidence_count, created_at
       FROM artifact_revisions
      WHERE artifact_id = ?
      ORDER BY revision DESC`,
    [id],
  )

  const headRow = revisions[0]
  const headDisclosure = headRow?.disclosure ?? 'restricted'
  const headIsPublic = headDisclosure === PUBLIC

  // 受限/密级 head：只回答「这个节点存在、是什么类型、什么时候」，其余一律不查不返回。
  // 连 history 也不返回——某条历史 revision 的正文同样可能包含受限内容。
  if (!headIsPublic) {
    return {
      ok: true,
      kind: 'artifact',
      id,
      artifactKind: artifact.kind,
      createdAt: artifact.created_at,
      updatedAt: artifact.updated_at,
      disclosure: headDisclosure,
      withheld: true,
      head: null,
      revisions: [],
      evidence: [],
      triggers: [],
      relations: [],
      lineage: [],
    }
  }

  const evidence = db.all<{
    revision: number
    relation: string
    confidence: string
    created_at: string
  }>(
    `SELECT e.revision, e.relation, e.confidence, e.created_at
       FROM artifact_evidence e
      WHERE e.artifact_id = ?
      ORDER BY e.created_at DESC
      LIMIT ?`,
    [id, EVIDENCE_LIMIT],
  )

  const triggers = db.all<{ event_id: string; revision: number; type: string; at: string }>(
    `SELECT t.event_id, t.revision, ev.type, ev.at
       FROM artifact_trigger_events t
       JOIN events ev ON ev.event_id = t.event_id
      WHERE t.artifact_id = ?
      ORDER BY ev.at DESC
      LIMIT ?`,
    [id, RELATION_LIMIT],
  )

  const relations = db.all<{
    relation: string
    target_artifact_id: string
    target_kind: string
    statement: string | null
    target_disclosure: string | null
  }>(
    `SELECT r.relation, r.target_artifact_id, a.kind AS target_kind,
            (SELECT statement FROM artifact_revisions x
              WHERE x.artifact_id = r.target_artifact_id
              ORDER BY x.revision DESC LIMIT 1) AS statement,
            (SELECT disclosure FROM artifact_revisions x
              WHERE x.artifact_id = r.target_artifact_id
              ORDER BY x.revision DESC LIMIT 1) AS target_disclosure
       FROM artifact_relations r
       JOIN artifacts a ON a.artifact_id = r.target_artifact_id
      WHERE r.artifact_id = ?
      LIMIT ?`,
    [id, RELATION_LIMIT],
  )

  const lineage = db.all<{
    relation: string
    from_artifact_id: string
    statement: string | null
    from_disclosure: string | null
  }>(
    `SELECT l.relation, l.from_artifact_id,
            (SELECT statement FROM artifact_revisions x
              WHERE x.artifact_id = l.from_artifact_id
              ORDER BY x.revision DESC LIMIT 1) AS statement,
            (SELECT disclosure FROM artifact_revisions x
              WHERE x.artifact_id = l.from_artifact_id
              ORDER BY x.revision DESC LIMIT 1) AS from_disclosure
       FROM artifact_lineage l
      WHERE l.artifact_id = ?
      LIMIT ?`,
    [id, RELATION_LIMIT],
  )

  return {
    ok: true,
    kind: 'artifact',
    id,
    artifactKind: artifact.kind,
    createdAt: artifact.created_at,
    updatedAt: artifact.updated_at,
    disclosure: headDisclosure,
    withheld: false,
    head: revisionDto(headRow),
    revisions: revisions.map(revisionDto),
    evidence: evidence.map((row) => ({
      revision: row.revision,
      relation: row.relation,
      confidence: row.confidence,
      createdAt: row.created_at,
    })),
    triggers: triggers.map((row) => ({
      eventId: row.event_id,
      type: row.type,
      at: row.at,
    })),
    relations: relations.map((row) =>
      row.target_disclosure === PUBLIC
        ? {
            relation: row.relation,
            withheld: false as const,
            targetId: row.target_artifact_id,
            targetKind: row.target_kind,
            targetStatement: row.statement ?? '',
          }
        : { relation: row.relation, withheld: true as const },
    ),
    lineage: lineage.map((row) =>
      row.from_disclosure === PUBLIC
        ? {
            relation: row.relation,
            withheld: false as const,
            fromId: row.from_artifact_id,
            fromStatement: row.statement ?? '',
          }
        : { relation: row.relation, withheld: true as const },
    ),
  }
}

/** 经历节点：事件本身 + 来源计数 + 它触发过的结论 + 与其它事件的关系。 */
function buildEventDetail(db: Db, id: string): EventNodeDetail | null {
  const event = db.get<{ event_id: string; kind: string; type: string; at: string }>(
    `SELECT event_id, kind, type, at FROM events WHERE event_id = ? AND persona_id = ?`,
    [id, PERSONA_ID],
  )
  if (!event) return null

  const sourceCount = db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM event_sources WHERE event_id = ?`,
    [id],
  )

  const triggered = db.all<{
    artifact_id: string
    revision: number
    statement: string | null
    target_disclosure: string | null
  }>(
    `SELECT t.artifact_id, t.revision,
            (SELECT statement FROM artifact_revisions x
              WHERE x.artifact_id = t.artifact_id AND x.revision = t.revision) AS statement,
            (SELECT disclosure FROM artifact_revisions x
              WHERE x.artifact_id = t.artifact_id
              ORDER BY x.revision DESC LIMIT 1) AS target_disclosure
       FROM artifact_trigger_events t
      WHERE t.event_id = ?
      LIMIT ?`,
    [id, RELATION_LIMIT],
  )

  const relations = db.all<{ relation: string; target_event_id: string }>(
    `SELECT relation, target_event_id
       FROM event_relations
      WHERE event_id = ?
      LIMIT ?`,
    [id, RELATION_LIMIT],
  )

  return {
    ok: true,
    kind: 'event',
    id,
    eventKind: event.kind,
    eventType: event.type,
    at: event.at,
    withheld: false,
    // 事件正文与 Source 正文都不返回；只报一个计数，让面板能显示「有 N 条来源」。
    sources: { withheld: true, count: sourceCount?.count ?? 0 },
    triggered: triggered.map((row) =>
      row.target_disclosure === PUBLIC && row.statement !== null
        ? {
            withheld: false as const,
            artifactId: row.artifact_id,
            revision: row.revision,
            statement: row.statement,
          }
        : { withheld: true as const },
    ),
    relations: relations.map((row) => ({
      relation: row.relation,
      targetId: row.target_event_id,
    })),
  }
}
