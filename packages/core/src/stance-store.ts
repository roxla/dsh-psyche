// P2 Completion Batch 阶段 3：Stance 合成的「读快照」层（只读）。
//
// 职责边界：
// - 这里只负责把合成需要的输入从库里读成纯数据（StanceBeliefInput / ExistingStanceInput）；
// - 判定在 stance-engine.ts 的纯函数里；
// - 写入由 store.ts 的私有 #applyStancePlan 负责（复用 #insertRevision 的证据/血统/披露逻辑）。
//
// 为什么读侧单独成文件：它可以脱离 Core 单测（给定库内容，断言读出来的快照形状），
// 也让 store.ts 不必再堆 200 行 SQL。
import type { SqlParam } from './adapter.js'
import type { Db } from './adapter.js'
import {
  stanceKeyOf,
  type ExistingStanceInput,
  type StanceBeliefInput,
  type StanceDirection,
} from './stance-engine.js'

const DIRECTIONS: readonly StanceDirection[] = ['for', 'against', 'neutral']

interface BeliefRow {
  artifact_id: string
  revision: number
  state: string
  statement: string
  confidence: string
  updated_at: string
  payload: string | null
}

function parsePayload(value: string | null): Record<string, unknown> {
  if (value === null || value.trim() === '') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    // 坏 payload 不是「整条 belief 无效」，只是它没有显式组/方向 → 不参与合成
    return {}
  }
}

function groupOf(payload: Record<string, unknown>): string {
  const value = payload.stanceGroup
  return typeof value === 'string' ? value.trim().slice(0, 100) : ''
}

function directionOf(payload: Record<string, unknown>): StanceDirection | null {
  const value = payload.stanceDirection
  return typeof value === 'string' && (DIRECTIONS as readonly string[]).includes(value)
    ? (value as StanceDirection)
    : null
}

/** 读某个 stanceKey 的全部候选 belief（只取每个 artifact 的当前 head）。 */
export function loadStanceBeliefs(db: Db, key: string): StanceBeliefInput[] {
  const rows = db.all<BeliefRow>(
    `SELECT a.artifact_id, r.revision, r.state, r.statement, r.confidence, r.updated_at, r.payload
       FROM artifacts a
       JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
      WHERE a.kind = 'belief'
        AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
        AND r.state = 'active'`,
    [] as SqlParam[],
  )
  const beliefs: StanceBeliefInput[] = []
  for (const row of rows) {
    const payload = parsePayload(row.payload)
    const group = groupOf(payload)
    const direction = directionOf(payload)
    if (!group || !direction) continue
    if (stanceKeyOf(group, direction) !== key) continue
    const evidenceKeys = db
      .all<{ independence_key: string }>(
        `SELECT independence_key FROM artifact_evidence WHERE artifact_id = ? AND revision = ?`,
        [row.artifact_id, row.revision],
      )
      .map((item) => item.independence_key)
    const sessionRefs = db
      .all<{ session_ref: string | null }>(
        `SELECT DISTINCT s.session_ref
           FROM artifact_evidence e
           JOIN sources s ON s.source_id = e.source_id
          WHERE e.artifact_id = ? AND e.revision = ?`,
        [row.artifact_id, row.revision],
      )
      .map((item) => item.session_ref ?? '')
      .filter(Boolean)
    beliefs.push({
      artifactId: row.artifact_id,
      revision: row.revision,
      state: 'active',
      statement: row.statement,
      confidence: (['low', 'medium', 'high'] as const).includes(row.confidence as 'low')
        ? (row.confidence as 'low' | 'medium' | 'high')
        : 'medium',
      updatedAt: row.updated_at,
      group,
      direction,
      evidenceKeys,
      sessionRefs,
    })
  }
  return beliefs
}

/** 读某个 stanceKey 已有的 stance（head）；没有返回 null。 */
export function loadExistingStance(db: Db, key: string): ExistingStanceInput | null {
  const artifact = db.get<{ artifact_id: string }>(
    `SELECT artifact_id FROM artifacts WHERE stance_key = ? LIMIT 1`,
    [key],
  )
  if (!artifact) return null
  const head = db.get<{ revision: number; state: string; statement: string }>(
    `SELECT revision, state, statement FROM artifact_revisions
      WHERE artifact_id = ? ORDER BY revision DESC LIMIT 1`,
    [artifact.artifact_id],
  )
  if (!head) return null
  const basis = db
    .all<{ from_artifact_id: string; from_revision: number | null }>(
      `SELECT from_artifact_id, from_revision FROM artifact_lineage
        WHERE artifact_id = ? AND revision = ? AND relation = 'derivedFrom'`,
      [artifact.artifact_id, head.revision],
    )
    .map((row) => ({ artifactId: row.from_artifact_id, revision: row.from_revision ?? 1 }))
  const evidenceKeys = db
    .all<{ independence_key: string }>(
      `SELECT independence_key FROM artifact_evidence WHERE artifact_id = ? AND revision = ?`,
      [artifact.artifact_id, head.revision],
    )
    .map((row) => row.independence_key)
  return {
    statement: head.statement,
    state: head.state === 'challenged' ? 'challenged' : 'active',
    basis,
    evidenceKeys,
  }
}

/** 读候选 belief 中哪些与同组其他 belief 存在 contradicts 关系。 */
export function loadStanceConflicts(db: Db, artifactIds: string[]): Set<string> {
  if (artifactIds.length === 0) return new Set()
  const placeholders = artifactIds.map(() => '?').join(',')
  const rows = db.all<{ artifact_id: string; target_artifact_id: string }>(
    `SELECT r.artifact_id, r.target_artifact_id
       FROM artifact_relations r
      WHERE r.relation = 'contradicts'
        AND r.artifact_id IN (${placeholders})
        AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = r.artifact_id)`,
    artifactIds as SqlParam[],
  )
  const result = new Set<string>()
  for (const row of rows) {
    if (artifactIds.includes(row.target_artifact_id)) {
      // 双方都标：任何一条参与都被视为内部冲突
      result.add(row.artifact_id)
      result.add(row.target_artifact_id)
    }
  }
  return result
}

/** 读候选 belief 中哪些卷入了「还没有结论」的 Tension（head 状态不在终态）。 */
export function loadUnresolvedTensionArtifacts(db: Db, artifactIds: string[]): Set<string> {
  if (artifactIds.length === 0) return new Set()
  const rows = db.all<{ pair_key: string }>(
    `SELECT DISTINCT t.pair_key
       FROM tension_versions t
      WHERE t.version = (SELECT max(version) FROM tension_versions WHERE pair_key = t.pair_key)
        AND t.status IN ('open', 'investigating', 'parked')`,
    [] as SqlParam[],
  )
  const result = new Set<string>()
  for (const row of rows) {
    // pair_key 形如 `art_a#3|art_b#1`；只关心两端都在候选集里的冲突
    const sides = row.pair_key
      .split('|')
      .map((side) => side.split('#')[0] ?? '')
      .filter(Boolean)
    if (sides.length !== 2) continue
    if (sides.every((side) => artifactIds.includes(side))) {
      for (const side of sides) result.add(side)
    }
  }
  return result
}
