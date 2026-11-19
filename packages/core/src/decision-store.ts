// 决策回执（Decision Receipt，P2 Completion Batch 阶段 2，schema v16）。
//
// 职责边界：
// - 只记「这次为什么这么判」：谁、依据什么、做了什么决定、结果如何；
// - 不存事实正文——事实仍在 Source → Event → Artifact/Evidence 链路里；
// - 依据是多态引用（artifact / evidence / tension / source / event / diary），
//   引用有效性交给 `psyche-integrity` 检查，这里不建跨表外键（SQLite 表达不了多态外键）；
// - 一次决策一个壳：`op_id` 唯一，重试天然幂等；终态之后不再追加依据。
import { CODE, PsycheError, invalid } from './errors.js'
import { PREFIX, newId } from './ids.js'
import { nowIso } from './adapter.js'
import type { Db, SqlParam } from './adapter.js'

/** 决策种类：先覆盖真实会写回执的路径，后续按业务增加。 */
export const DECISION_KINDS = [
  'clash',
  'revise',
  'review',
  'remember',
  'recall',
  'stance',
  'diary',
] as const
export type DecisionKind = (typeof DECISION_KINDS)[number]

/** 一次决策的生命周期：pending 是壳，finalize 之后不可再改。 */
export const DECISION_STATUSES = ['pending', 'committed', 'rejected', 'failed'] as const
export type DecisionStatus = (typeof DECISION_STATUSES)[number]

/** 依据类型：只放真实会被引用的对象，不把字符串哈希当依据。 */
export const DECISION_REF_TYPES = ['artifact', 'evidence', 'tension', 'source', 'event', 'diary'] as const
export type DecisionRefType = (typeof DECISION_REF_TYPES)[number]

/** 参与方式：input=决策依据，result=决策产出的结论，rejected=被排除的依据（保留理由）。 */
export const DECISION_ROLES = ['input', 'result', 'rejected'] as const
export type DecisionRole = (typeof DECISION_ROLES)[number]

export interface DecisionRunRecord {
  decisionId: string
  kind: DecisionKind
  status: DecisionStatus
  actor: string
  inputHash: string
  reason: string | null
  resultArtifactId: string | null
  /** v18 起：diary 作为结果时不塞进 result_artifact_id，用独立指针。 */
  resultDiaryId: string | null
  resultRevision: number | null
  createdAt: string
  finalizedAt: string | null
}

export interface DecisionItemRecord {
  decisionId: string
  itemId: string
  refType: DecisionRefType
  refId: string
  refRevision: number | null
  role: DecisionRole
  createdAt: string
}

export interface DecisionRunInput {
  /** 幂等键：同一次决策重试必须复用同一个 opId。 */
  opId: string
  kind: DecisionKind
  actor?: string
  /** 输入摘要（由调用方算，如参数 hash）；不存原文。 */
  inputHash: string
  createdAt?: string
}

export interface DecisionItemInput {
  refType: DecisionRefType
  refId: string
  refRevision?: number | null
  role?: DecisionRole
}

export interface DecisionFinalizeInput {
  status: Exclude<DecisionStatus, 'pending'>
  reason?: string | null
  resultArtifactId?: string | null
  /** v18 起：diary 回执的结果指针（与 resultArtifactId 互斥语义，不强制）。 */
  resultDiaryId?: string | null
  resultRevision?: number | null
  finalizedAt?: string
}

export interface DecisionFilter {
  kind?: DecisionKind
  status?: DecisionStatus
  artifactId?: string
  limit?: number
}

export interface DecisionStoreDeps {
  now?: () => string
  newId?: typeof newId
}

/** 需要依据的决策：这几类不许出现「空依据」的回执，否则就是拍脑袋。 */
export const DECISION_KINDS_REQUIRING_BASIS: readonly DecisionKind[] = ['clash', 'revise', 'review', 'stance']

/** 决策主体固定为 core：模型/插件不能通过参数伪造「谁做的决定」。 */
export const ACTOR_CORE = 'core'

const MAX_LIMIT = 200
const MAX_TEXT = 500

function clean(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const text = clean(value, 40)
  if (!(allowed as readonly string[]).includes(text)) {
    throw new PsycheError(CODE.validation, `${label} 必须是 ${allowed.join(' / ')} 之一`)
  }
  return text as T
}

interface RunRow {
  decision_id: string
  kind: string
  status: string
  actor: string
  input_hash: string
  reason: string | null
  result_artifact_id: string | null
  result_diary_id: string | null
  result_revision: number | null
  created_at: string
  finalized_at: string | null
}

interface ItemRow {
  decision_id: string
  item_id: string
  ref_type: string
  ref_id: string
  ref_revision: number | null
  role: string
  created_at: string
}

function rowToRun(row: RunRow): DecisionRunRecord {
  return {
    decisionId: row.decision_id,
    kind: row.kind as DecisionKind,
    status: row.status as DecisionStatus,
    actor: row.actor,
    inputHash: row.input_hash,
    reason: row.reason,
    resultArtifactId: row.result_artifact_id,
    resultDiaryId: row.result_diary_id,
    resultRevision: row.result_revision,
    createdAt: row.created_at,
    finalizedAt: row.finalized_at,
  }
}

function rowToItem(row: ItemRow): DecisionItemRecord {
  return {
    decisionId: row.decision_id,
    itemId: row.item_id,
    refType: row.ref_type as DecisionRefType,
    refId: row.ref_id,
    refRevision: row.ref_revision,
    role: row.role as DecisionRole,
    createdAt: row.created_at,
  }
}

/** 建壳：同 opId 重试返回已有记录（created=false），不重复建。 */
export function createDecision(
  db: Db,
  input: DecisionRunInput,
  deps: DecisionStoreDeps = {},
): { record: DecisionRunRecord; created: boolean } {
  const opId = clean(input.opId, 120)
  if (opId === '') throw invalid('createDecision 需要 opId（幂等键）')
  const kind = oneOf(input.kind, DECISION_KINDS, 'kind')
  const inputHash = clean(input.inputHash, 120)
  if (inputHash === '') throw invalid('createDecision 需要 inputHash（输入摘要）')
  const now = deps.now ?? nowIso

  const existing = db.get<{ decision_id: string }>(`SELECT decision_id FROM decision_runs WHERE op_id = ?`, [
    opId,
  ])
  if (existing) {
    const record = getDecision(db, existing.decision_id)
    if (!record) throw new PsycheError(CODE.notFound, `决策记录读不回来：${existing.decision_id}`)
    return { record: record.run, created: false }
  }

  const actor = clean(input.actor, 40) || ACTOR_CORE
  if (actor !== ACTOR_CORE) {
    throw invalid('决策主体固定为 core，调用方不能伪造')
  }
  const decisionId = (deps.newId ?? newId)(PREFIX.decision)
  const createdAt = input.createdAt ?? now()
  db.run(
    `INSERT INTO decision_runs
       (decision_id, persona_id, op_id, kind, status, actor, input_hash, created_at)
     VALUES (?, 'main', ?, ?, 'pending', ?, ?, ?)`,
    [decisionId, opId, kind, actor, inputHash, createdAt],
  )
  return {
    record: {
      decisionId,
      kind,
      status: 'pending',
      actor,
      inputHash,
      reason: null,
      resultArtifactId: null,
      resultDiaryId: null,
      resultRevision: null,
      createdAt,
      finalizedAt: null,
    },
    created: true,
  }
}

/**
 * 追加依据：只在 pending 期允许；终态后追加抛 E_STATE（决策已结束，不能再改依据）。
 * 整批在一个事务里：任何一条校验/写入失败都回滚，不会留下「只写了一半」的依据，
 * 这样同 opId 重试时不会重复追加。
 */
export function appendDecisionItems(
  db: Db,
  decisionId: string,
  items: readonly DecisionItemInput[],
  deps: DecisionStoreDeps = {},
): DecisionItemRecord[] {
  return db.transaction(() => {
    const run = requirePending(db, decisionId)
    const now = (deps.now ?? nowIso)()
    const written: DecisionItemRecord[] = []
    for (const item of items) {
      const refType = oneOf(item.refType, DECISION_REF_TYPES, 'refType')
      const refId = clean(item.refId, 120)
      if (refId === '') throw invalid('依据必须有 refId')
      const role = item.role === undefined ? 'input' : oneOf(item.role, DECISION_ROLES, 'role')
      const refRevision =
        item.refRevision === undefined || item.refRevision === null
          ? null
          : Math.max(1, Math.trunc(item.refRevision))
      const record: DecisionItemRecord = {
        decisionId: run.decisionId,
        itemId: (deps.newId ?? newId)(PREFIX.decision),
        refType,
        refId,
        refRevision,
        role,
        createdAt: now,
      }
      db.run(
        `INSERT INTO decision_items
           (decision_id, item_id, ref_type, ref_id, ref_revision, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [record.decisionId, record.itemId, record.refType, record.refId, record.refRevision, record.role, record.createdAt],
      )
      written.push(record)
    }
    return written
  }, { important: true })
}

/** 收尾：pending → committed / rejected / failed；同状态重复调用幂等，不同状态抛 E_STATE。 */
export function finalizeDecision(
  db: Db,
  decisionId: string,
  input: DecisionFinalizeInput,
  deps: DecisionStoreDeps = {},
): DecisionRunRecord {
  const run = getDecision(db, decisionId)
  if (!run) throw new PsycheError(CODE.notFound, `找不到决策记录：${decisionId}`)
  const status = oneOf(input.status, ['committed', 'rejected', 'failed'] as const, 'status')
  if (run.run.status === status) return run.run
  if (run.run.status !== 'pending') {
    throw new PsycheError(CODE.state, `决策已是 ${run.run.status}，不能再改成 ${status}`)
  }
  // 需要依据的决策不许空着收尾——空依据的「决定」等于拍脑袋
  if (
    status === 'committed' &&
    DECISION_KINDS_REQUIRING_BASIS.includes(run.run.kind) &&
    !run.items.some((item) => item.role === 'input')
  ) {
    throw new PsycheError(CODE.validation, `${run.run.kind} 决策至少要有一条 input 依据，不能空着提交`)
  }
  const finalizedAt = input.finalizedAt ?? (deps.now ?? nowIso)()
  const result = db.run(
    `UPDATE decision_runs
        SET status = ?, reason = ?, result_artifact_id = ?, result_diary_id = ?, result_revision = ?, finalized_at = ?
      WHERE decision_id = ? AND status = 'pending'`,
    [
      status,
      input.reason === undefined || input.reason === null ? null : clean(input.reason),
      input.resultArtifactId === undefined ? null : clean(input.resultArtifactId, 120) || null,
      input.resultDiaryId === undefined ? null : clean(input.resultDiaryId, 120) || null,
      input.resultRevision === undefined || input.resultRevision === null
        ? null
        : Math.trunc(input.resultRevision),
      finalizedAt,
      decisionId,
    ],
  )
  if (result.changes === 0) {
    // 没改到行 = 读到 pending 之后被别人收尾了（并发）。同状态视为重放，其他状态是冲突。
    const raced = getDecision(db, decisionId)
    if (!raced) throw new PsycheError(CODE.notFound, `决策收尾后读不回来：${decisionId}`)
    if (raced.run.status === status) return raced.run
    throw new PsycheError(
      CODE.state,
      `决策已被并发收尾为 ${raced.run.status}，不能再改成 ${status}`,
    )
  }
  const updated = getDecision(db, decisionId)
  if (!updated) throw new PsycheError(CODE.notFound, `决策收尾后读不回来：${decisionId}`)
  return updated.run
}

/** 读一条决策（壳 + 依据）；没有就返回 null，不抛。 */
export function getDecision(
  db: Db,
  decisionId: string,
): { run: DecisionRunRecord; items: DecisionItemRecord[] } | null {
  const id = clean(decisionId, 120)
  if (id === '') return null
  const row = db.get<RunRow>(`SELECT * FROM decision_runs WHERE decision_id = ?`, [id])
  if (!row) return null
  const items = db.all<ItemRow>(
    `SELECT * FROM decision_items WHERE decision_id = ? ORDER BY created_at ASC, item_id ASC`,
    [id],
  )
  return { run: rowToRun(row), items: items.map(rowToItem) }
}

/** 列决策：按 kind/status 过滤；`artifactId` 会同时匹配壳的结果与依据引用。 */
export function listDecisions(db: Db, filter: DecisionFilter = {}): DecisionRunRecord[] {
  const conditions: string[] = []
  const params: SqlParam[] = []
  if (filter.kind !== undefined) {
    conditions.push('kind = ?')
    params.push(oneOf(filter.kind, DECISION_KINDS, 'kind'))
  }
  if (filter.status !== undefined) {
    conditions.push('status = ?')
    params.push(oneOf(filter.status, DECISION_STATUSES, 'status'))
  }
  if (filter.artifactId !== undefined) {
    const artifactId = clean(filter.artifactId, 120)
    if (artifactId === '') throw invalid('artifactId 不能为空')
    conditions.push(
      `(result_artifact_id = ? OR decision_id IN (
         SELECT decision_id FROM decision_items WHERE ref_type = 'artifact' AND ref_id = ?
       ))`,
    )
    params.push(artifactId, artifactId)
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(filter.limit ?? 50)))
  const sql = `SELECT * FROM decision_runs${conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at DESC, decision_id ASC LIMIT ?`
  return db.all<RunRow>(sql, [...params, limit]).map(rowToRun)
}

function requirePending(db: Db, decisionId: string): { decisionId: string } {
  const run = getDecision(db, decisionId)
  if (!run) throw new PsycheError(CODE.notFound, `找不到决策记录：${decisionId}`)
  if (run.run.status !== 'pending') {
    throw new PsycheError(CODE.state, `决策已是 ${run.run.status}，不能再追加依据`)
  }
  return { decisionId: run.run.decisionId }
}
