// G1-A 项目交接存储层（schema v32）。
//
// 定位：把「一个开发项目跨会话做到哪一步」变成可持久、可重放的记录，
// 而不是靠模型在下次对话里猜。
//   - 七张表：projects / project_session_bindings / digest_jobs / session_digests /
//     project_checkpoints / checkpoint_revisions / checkpoint_references；
//   - 本模块只写这七张表，不碰 artifacts / events / fts_index，因此天然不进 Recall；
//   - 读路径不写库。
//
// 不变量（与 schema.ts 的 V32_PROJECT_HANDOFF 注释一一对应）：
//   - 绑定与项目必须同 persona：写错由数据库复合外键拒绝；
//   - 同一 (binding, from_seq, to_seq, algorithm_version) 只对应一个 job；
//   - 同一 job 成功后最多一条 Digest，每个 Digest 最多领一个首修订；
//   - 修订只追加，活动由 project_checkpoints.head_revision 指向；
//   - head 更新用 CAS（checkpoint_id + expected head_revision），changes !== 1 抛 revisionConflict；
//   - committed_to_seq 只按「连续覆盖」推进，手动保存留下的空洞不推高它。
import { nowIso } from './adapter.js'
import type { Db } from './adapter.js'
import { CODE, PsycheError } from './errors.js'

const PERSONA_ID = 'main'
/** 通用进度（不属于任何具名分支）用预留的空串分支键，避免 NULL 唯一性语义产生多行。 */
export const GENERAL_BRANCH_KEY = ''

/** 与 store.ts 的 Confidence 同形，但不重复导出（core 的 index 里两者会撞名）。 */
type Confidence = 'low' | 'medium' | 'high'
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'no_change' | 'cancelled'

export interface ProjectRecord {
  projectId: string
  personaId: string
  canonicalName: string
  workspaceKey: string | null
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
}

export interface BindingRecord {
  bindingId: string
  projectId: string
  personaId: string
  platform: string
  sessionRef: string
  grantGeneration: string
  committedToSeq: number
  boundAt: string
  unboundAt: string | null
}

export interface CheckpointRevisionInput {
  repoRef?: string | null
  lastActiveAt?: string | null
  currentGoal?: string | null
  completed?: readonly string[]
  blockers?: readonly string[]
  nextSteps?: readonly string[]
  dependencies?: readonly string[]
  decisions?: readonly string[]
  confidence?: Confidence
  generator: string
}

export interface CheckpointReferenceInput {
  /** 这条证据支撑的是哪个事项（例如 U-017）；同一事项重复登记同一来源会被拒。 */
  itemKey: string
  sourceId?: string | null
  digestId?: string | null
}

export interface SaveCheckpointInput {
  projectId: string
  /** 分支键；不给则用通用进度分支。 */
  branchKey?: string
  bindingId: string
  /**
   * 任务类型：
   * - `range`（默认）自动摘要，有可证明的连续区间，按区间做唯一性并推进水位；
   * - `manual` 手动保存，没有可重放的区间，按 requestId 做唯一性，**不推进水位**。
   */
  mode?: 'range' | 'manual'
  /** manual 必填：一次草稿一个，双击重放靠它。 */
  requestId?: string
  /** manual 可选：内容指纹；同一 requestId 但内容不同要拒绝。 */
  payloadHash?: string
  fromSeq: number
  toSeq: number
  algorithmVersion: string
  /** 摘要正文与它自己引用的 Source 清单。 */
  digest: { bodyJson: string; sourceIds?: readonly string[] }
  revision: CheckpointRevisionInput
  references?: readonly CheckpointReferenceInput[]
  /**
   * CAS：调用方先读到的 head 修订号。
   * 首次保存给 0 或省略；给了就必须与库中当前 head 一致，否则抛 revisionConflict。
   */
  expectedRevision?: number
}

export interface SaveCheckpointResult {
  /** false 表示这次是重放/无变化，没有新增任何行。 */
  saved: boolean
  replayed: boolean
  noChange: boolean
  jobId: string
  digestId: string | null
  checkpointId: string
  revision: number
  committedToSeq: number
}

export interface CheckpointView {
  projectId: string
  branchKey: string
  checkpointId: string
  headRevision: number
  updatedAt: string
  revision: {
    revision: number
    repoRef: string | null
    lastActiveAt: string | null
    currentGoal: string | null
    completed: string[]
    blockers: string[]
    nextSteps: string[]
    dependencies: string[]
    decisions: string[]
    confidence: Confidence
    generator: string
    originDigestId: string | null
    createdAt: string
  } | null
  references: Array<{ itemKey: string; sourceId: string | null; digestId: string | null }>
}

export interface StoreDeps {
  personaId?: string
  now?: () => string
}

function clock(deps: StoreDeps): string {
  return deps.now ? deps.now() : nowIso()
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function jsonArray(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value : [])
}

function parseArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
  } catch {
    return []
  }
}

function requirePositive(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new PsycheError(CODE.validation, `${field} 必须是 >= 1 的整数`, { field, value })
  }
  return value
}

/** 建项目（幂等：同 workspace_key 已存在就返回既有行）。 */
export function ensureProject(
  db: Db,
  input: {
    projectId: string
    canonicalName: string
    workspaceKey?: string | null
    deps?: StoreDeps
  },
): ProjectRecord {
  const deps = input.deps ?? {}
  const personaId = deps.personaId ?? PERSONA_ID
  const projectId = text(input.projectId, 120)
  const name = text(input.canonicalName, 200)
  if (!projectId) throw new PsycheError(CODE.validation, 'projectId 不能为空')
  if (!name) throw new PsycheError(CODE.validation, 'canonicalName 不能为空')
  const workspaceKey = text(input.workspaceKey, 200) || null

  return db.transaction(() => {
    const existing = db.get<ProjectRecord & { status: 'active' | 'archived' }>(
      'SELECT project_id AS projectId, persona_id AS personaId, canonical_name AS canonicalName, ' +
        'workspace_key AS workspaceKey, status, created_at AS createdAt, updated_at AS updatedAt ' +
        'FROM projects WHERE persona_id = ? AND project_id = ?',
      [personaId, projectId],
    )
    if (existing) return existing

    // 同一工作区身份只能对应一个项目：撞了就报出来，不静默合并两个项目。
    if (workspaceKey) {
      const clash = db.get<{ projectId: string }>(
        'SELECT project_id AS projectId FROM projects WHERE persona_id = ? AND workspace_key = ?',
        [personaId, workspaceKey],
      )
      if (clash) {
        throw new PsycheError(CODE.idempotent, '该工作区已绑定到另一个项目', {
          workspaceKey,
          existingProjectId: clash.projectId,
        })
      }
    }

    const at = clock(deps)
    db.run(
      'INSERT INTO projects (project_id, persona_id, canonical_name, workspace_key, status, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
      [projectId, personaId, name, workspaceKey, 'active', at, at],
    )
    return {
      projectId,
      personaId,
      canonicalName: name,
      workspaceKey,
      status: 'active' as const,
      createdAt: at,
      updatedAt: at,
    }
  })
}

/**
 * 绑定会话到项目。
 *
 * 同一 (persona, platform, session_ref) 只允许一个活动绑定；已有活动绑定且指向
 * 别的项目时抛 idempotent —— 换项目要先 unbind，留出审计痕迹。
 */
export function bindSession(
  db: Db,
  input: {
    bindingId: string
    projectId: string
    platform: string
    sessionRef: string
    grantGeneration: string
    deps?: StoreDeps
  },
): BindingRecord {
  const deps = input.deps ?? {}
  const personaId = deps.personaId ?? PERSONA_ID
  const bindingId = text(input.bindingId, 120)
  const platform = text(input.platform, 40)
  const sessionRef = text(input.sessionRef, 200)
  const grantGeneration = text(input.grantGeneration, 120)
  if (!bindingId) throw new PsycheError(CODE.validation, 'bindingId 不能为空')
  if (!platform || !sessionRef) throw new PsycheError(CODE.validation, 'platform / sessionRef 不能为空')
  if (!grantGeneration) throw new PsycheError(CODE.validation, 'grantGeneration 不能为空')

  return db.transaction(() => {
    const project = db.get<{ status: string }>(
      'SELECT status FROM projects WHERE persona_id = ? AND project_id = ?',
      [personaId, input.projectId],
    )
    if (!project) throw new PsycheError(CODE.notFound, '项目不存在', { projectId: input.projectId })
    if (project.status !== 'active') {
      throw new PsycheError(CODE.state, '项目已归档，不能绑定新会话', { projectId: input.projectId })
    }

    const active = db.get<{ bindingId: string; projectId: string }>(
      'SELECT binding_id AS bindingId, project_id AS projectId FROM project_session_bindings ' +
        'WHERE persona_id = ? AND platform = ? AND session_ref = ? AND unbound_at IS NULL',
      [personaId, platform, sessionRef],
    )
    if (active) {
      if (active.projectId === input.projectId) {
        // 同一项目重复绑定：返回既有行（幂等），不新建第二条活动绑定。
        const row = db.get<BindingRecord>(
          'SELECT binding_id AS bindingId, project_id AS projectId, persona_id AS personaId, ' +
            'platform, session_ref AS sessionRef, grant_generation AS grantGeneration, ' +
            'committed_to_seq AS committedToSeq, bound_at AS boundAt, unbound_at AS unboundAt ' +
            'FROM project_session_bindings WHERE binding_id = ?',
          [active.bindingId],
        )
        if (row) return row
      }
      throw new PsycheError(CODE.idempotent, '该会话已绑定到另一个项目', {
        sessionRef,
        existingBindingId: active.bindingId,
        existingProjectId: active.projectId,
      })
    }

    const at = clock(deps)
    db.run(
      'INSERT INTO project_session_bindings ' +
        '(binding_id, project_id, persona_id, platform, session_ref, grant_generation, committed_to_seq, bound_at, unbound_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL)',
      [bindingId, input.projectId, personaId, platform, sessionRef, grantGeneration, at],
    )
    return {
      bindingId,
      projectId: input.projectId,
      personaId,
      platform,
      sessionRef,
      grantGeneration,
      committedToSeq: 0,
      boundAt: at,
      unboundAt: null,
    }
  })
}

/** 解绑（写 unbound_at，不删行）。已解绑或不存在时返回 false。 */
export function unbindSession(db: Db, input: { bindingId: string; deps?: StoreDeps }): boolean {
  const deps = input.deps ?? {}
  return db.transaction(() => {
    const result = db.run(
      'UPDATE project_session_bindings SET unbound_at = ? WHERE binding_id = ? AND unbound_at IS NULL',
      [clock(deps), input.bindingId],
    )
    return result.changes === 1
  })
}

/**
 * 归档项目 = 同一事务内改状态 + 解绑它名下所有活动绑定。
 *
 * 为什么必须解绑：活动绑定有唯一索引，一个归档项目继续占着会话名册会让那个
 * 会话再也绑不了别的项目。历史、水位、Digest、Checkpoint 全部保留。
 */
export function archiveProject(db: Db, input: { projectId: string; deps?: StoreDeps }): {
  archived: boolean
  unbound: number
} {
  const deps = input.deps ?? {}
  const personaId = deps.personaId ?? PERSONA_ID
  return db.transaction(() => {
    const at = clock(deps)
    const project = db.run(
      "UPDATE projects SET status = 'archived', updated_at = ? WHERE persona_id = ? AND project_id = ? AND status = 'active'",
      [at, personaId, input.projectId],
    )
    const bindings = db.run(
      'UPDATE project_session_bindings SET unbound_at = ? WHERE project_id = ? AND unbound_at IS NULL',
      [at, input.projectId],
    )
    return { archived: project.changes === 1, unbound: bindings.changes }
  })
}

interface JobRow {
  jobId: string
  status: JobStatus
  attempts: number
}

function findJob(
  db: Db,
  bindingId: string,
  fromSeq: number,
  toSeq: number,
  algorithmVersion: string,
): JobRow | undefined {
  return db.get<JobRow>(
    'SELECT job_id AS jobId, status, attempts FROM digest_jobs ' +
      "WHERE binding_id = ? AND from_seq = ? AND to_seq = ? AND algorithm_version = ? AND mode = 'range'",
    [bindingId, fromSeq, toSeq, algorithmVersion],
  )
}

/**
 * 手动任务按 request_id 找，不按区间找。
 *
 * 手动保存没有可重放的区间：同一草稿双击要回到原修订，靠的是请求标识；
 * 换一个草稿即使选了同样的来源，也该得到新修订。用区间做键会把这两件事混成一件。
 */
function findManualJob(db: Db, bindingId: string, requestId: string): (JobRow & { payloadHash: string | null }) | undefined {
  return db.get<JobRow & { payloadHash: string | null }>(
    'SELECT job_id AS jobId, status, attempts, payload_hash AS payloadHash FROM digest_jobs ' +
      "WHERE binding_id = ? AND request_id = ? AND mode = 'manual'",
    [bindingId, requestId],
  )
}

/** 重放查询：job → digest → 首修订。head 已经走远也能找回当时那一版。 */
function replayResult(db: Db, jobId: string): { digestId: string; checkpointId: string; revision: number } | undefined {
  return db.get<{ digestId: string; checkpointId: string; revision: number }>(
    'SELECT d.digest_id AS digestId, r.checkpoint_id AS checkpointId, r.revision AS revision ' +
      'FROM session_digests d JOIN checkpoint_revisions r ON r.origin_digest_id = d.digest_id ' +
      'WHERE d.job_id = ?',
    [jobId],
  )
}

/** 当前已核实的连续水位：只认 binding 上那个值，不由 MAX(to_seq) 推。 */
function committedToSeqOf(db: Db, bindingId: string): number {
  const row = db.get<{ committedToSeq: number }>(
    'SELECT committed_to_seq AS committedToSeq FROM project_session_bindings WHERE binding_id = ?',
    [bindingId],
  )
  return row ? Number(row.committedToSeq) : 0
}

/**
 * 保存一次项目交接（首次保存 / 重试 / 重放走同一条路径）。
 *
 * 顺序即契约：核对项目与绑定 → 查或建 job → 写 Digest → 取或建分支 Checkpoint
 * → 写新修订与引用 → CAS 推 head → 连续时推水位 → job 标 succeeded。
 * 重放（job 已 succeeded）不写任何行，直接返回当时的 digest/checkpoint/revision。
 */
export function saveCheckpoint(db: Db, input: SaveCheckpointInput): SaveCheckpointResult {
  const mode: 'range' | 'manual' = input.mode === 'manual' ? 'manual' : 'range'
  const requestId = text(input.requestId, 120) || null
  if (mode === 'manual' && requestId === null) {
    throw new PsycheError(CODE.validation, 'manual 任务必须给 requestId', { bindingId: input.bindingId })
  }
  if (mode === 'range' && requestId !== null) {
    throw new PsycheError(CODE.validation, 'range 任务不接受 requestId', { bindingId: input.bindingId })
  }
  const payloadHash = text(input.payloadHash, 120) || null
  const fromSeq = requirePositive(input.fromSeq, 'fromSeq')
  const toSeq = requirePositive(input.toSeq, 'toSeq')
  if (toSeq < fromSeq) throw new PsycheError(CODE.validation, 'toSeq 不能小于 fromSeq', { fromSeq, toSeq })
  if (mode === 'manual' && toSeq !== fromSeq) {
    // 手动任务没有区间：fromSeq/toSeq 只是保存时刻的水位位置，多一格都是在宣称
    // 「处理了几条」，而手动保存并没有可重放的区间来支撑这句话。
    throw new PsycheError(CODE.validation, 'manual 任务的 fromSeq 与 toSeq 必须相等', { fromSeq, toSeq })
  }
  const algorithmVersion = text(input.algorithmVersion, 80)
  if (!algorithmVersion) throw new PsycheError(CODE.validation, 'algorithmVersion 不能为空')
  const branchKey = typeof input.branchKey === 'string' ? input.branchKey : GENERAL_BRANCH_KEY
  const generator = text(input.revision.generator, 80)
  if (!generator) throw new PsycheError(CODE.validation, 'revision.generator 不能为空')
  const bodyJson = typeof input.digest.bodyJson === 'string' ? input.digest.bodyJson : ''
  if (!bodyJson) throw new PsycheError(CODE.validation, 'digest.bodyJson 不能为空')

  return db.transaction(() => {
    const project = db.get<{ status: string }>(
      'SELECT status FROM projects WHERE persona_id = ? AND project_id = ?',
      [PERSONA_ID, input.projectId],
    )
    if (!project) throw new PsycheError(CODE.notFound, '项目不存在', { projectId: input.projectId })
    if (project.status !== 'active') {
      throw new PsycheError(CODE.state, '项目已归档，不能写入新的交接记录', { projectId: input.projectId })
    }

    const binding = db.get<{ projectId: string; unboundAt: string | null }>(
      'SELECT project_id AS projectId, unbound_at AS unboundAt FROM project_session_bindings WHERE binding_id = ?',
      [input.bindingId],
    )
    if (!binding) throw new PsycheError(CODE.notFound, '绑定不存在', { bindingId: input.bindingId })
    if (binding.projectId !== input.projectId) {
      throw new PsycheError(CODE.validation, '绑定不属于该项目', {
        bindingId: input.bindingId,
        projectId: input.projectId,
      })
    }
    if (binding.unboundAt !== null) {
      throw new PsycheError(CODE.state, '绑定已解除，不能写入新的交接记录', { bindingId: input.bindingId })
    }

    const existingJob: (JobRow & { payloadHash?: string | null }) | undefined =
      mode === 'manual'
        ? findManualJob(db, input.bindingId, requestId as string)
        : findJob(db, input.bindingId, fromSeq, toSeq, algorithmVersion)

    // 同一请求但内容不同：这是错用，不能当重放，也不能偷偷再写一条。
    if (existingJob && mode === 'manual' && payloadHash !== null && existingJob.payloadHash !== null) {
      if (existingJob.payloadHash !== payloadHash) {
        throw new PsycheError(CODE.validation, '同一保存请求的内容与之前不一致', {
          requestId,
          expected: existingJob.payloadHash,
          actual: payloadHash,
        })
      }
    }

    // 重放：已成功或已判定无变化的任务不再写库。
    if (existingJob && (existingJob.status === 'succeeded' || existingJob.status === 'no_change')) {
      const committed = committedToSeqOf(db, input.bindingId)
      if (existingJob.status === 'no_change') {
        const checkpoint = db.get<{ checkpointId: string; headRevision: number }>(
          'SELECT checkpoint_id AS checkpointId, head_revision AS headRevision FROM project_checkpoints ' +
            'WHERE project_id = ? AND branch_key = ?',
          [input.projectId, branchKey],
        )
        return {
          saved: false,
          replayed: true,
          noChange: true,
          jobId: existingJob.jobId,
          digestId: null,
          checkpointId: checkpoint ? checkpoint.checkpointId : '',
          revision: checkpoint ? Number(checkpoint.headRevision) : 0,
          committedToSeq: committed,
        }
      }
      const prior = replayResult(db, existingJob.jobId)
      if (!prior) {
        // 成功了却没有回链：结构坏了，宁可报错也不要返回一个猜的结果。
        throw new PsycheError(CODE.db, '摘要任务已成功但找不到对应修订', { jobId: existingJob.jobId })
      }
      return {
        saved: false,
        replayed: true,
        noChange: false,
        jobId: existingJob.jobId,
        digestId: prior.digestId,
        checkpointId: prior.checkpointId,
        revision: Number(prior.revision),
        committedToSeq: committed,
      }
    }

    const at = clock({ personaId: PERSONA_ID })
    let jobId: string
    if (existingJob) {
      // 同一逻辑任务重试：复用 job_id，只递增尝试次数。
      jobId = existingJob.jobId
      db.run(
        "UPDATE digest_jobs SET attempts = attempts + 1, status = 'running', claimed_at = ?, updated_at = ? WHERE job_id = ?",
        [at, at, jobId],
      )
    } else {
      jobId =
        mode === 'manual'
          ? `job_${input.bindingId}_req_${requestId}`.slice(0, 200)
          : `job_${input.bindingId}_${fromSeq}_${toSeq}_${algorithmVersion}`.slice(0, 200)
      db.run(
        'INSERT INTO digest_jobs (job_id, binding_id, from_seq, to_seq, algorithm_version, status, attempts, ' +
          'mode, request_id, payload_hash, created_at, updated_at) ' +
          "VALUES (?, ?, ?, ?, ?, 'running', 1, ?, ?, ?, ?, ?)",
        [jobId, input.bindingId, fromSeq, toSeq, algorithmVersion, mode, requestId, payloadHash, at, at],
      )
    }

    const digestId = `dig_${jobId}_${at}`.slice(0, 200)
    db.run(
      'INSERT INTO session_digests (digest_id, job_id, body_json, source_ids_json, created_at) VALUES (?, ?, ?, ?, ?)',
      [digestId, jobId, bodyJson, jsonArray(input.digest.sourceIds), at],
    )

    const stage = db.get<{ checkpointId: string; headRevision: number }>(
      'SELECT checkpoint_id AS checkpointId, head_revision AS headRevision FROM project_checkpoints ' +
        'WHERE project_id = ? AND branch_key = ?',
      [input.projectId, branchKey],
    )
    const checkpointId = stage ? stage.checkpointId : `ckp_${input.projectId}_${branchKey}`.slice(0, 160)
    const currentHead = stage ? Number(stage.headRevision) : 0

    if (input.expectedRevision !== undefined && input.expectedRevision !== currentHead) {
      throw new PsycheError(CODE.revisionConflict, '项目进度已被其他写入者推进', {
        expectedRevision: input.expectedRevision,
        currentHead,
      })
    }

    if (stage) {
      // 已存在的分支：先用 CAS 抢 head，抢不到立刻回滚，连 Digest 都不留。
      const moved = db.run(
        'UPDATE project_checkpoints SET head_revision = ?, updated_at = ? WHERE checkpoint_id = ? AND head_revision = ?',
        [currentHead + 1, at, checkpointId, currentHead],
      )
      if (moved.changes !== 1) {
        throw new PsycheError(CODE.revisionConflict, '项目进度已被其他写入者推进', {
          checkpointId,
          expectedHead: currentHead,
        })
      }
    } else {
      // 新分支：先插 Checkpoint 再插 revision 1；复合外键是 DEFERRABLE，提交时才校验配对。
      db.run(
        'INSERT INTO project_checkpoints (checkpoint_id, project_id, branch_key, head_revision, updated_at) ' +
          'VALUES (?, ?, ?, 1, ?)',
        [checkpointId, input.projectId, branchKey, at],
      )
    }

    const revision = currentHead + 1
    const revisionRow = input.revision
    db.run(
      'INSERT INTO checkpoint_revisions (checkpoint_id, revision, repo_ref, last_active_at, current_goal, ' +
        'completed_json, blockers_json, next_steps_json, dependencies_json, decisions_json, confidence, ' +
        'generator, origin_digest_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        checkpointId,
        revision,
        text(revisionRow.repoRef, 200) || null,
        text(revisionRow.lastActiveAt, 40) || null,
        text(revisionRow.currentGoal, 2000) || null,
        jsonArray(revisionRow.completed),
        jsonArray(revisionRow.blockers),
        jsonArray(revisionRow.nextSteps),
        jsonArray(revisionRow.dependencies),
        jsonArray(revisionRow.decisions),
        revisionRow.confidence ?? 'medium',
        generator,
        digestId,
        at,
      ],
    )

    for (const reference of input.references ?? []) {
      const itemKey = text(reference.itemKey, 120)
      if (!itemKey) throw new PsycheError(CODE.validation, 'reference.itemKey 不能为空')
      const sourceId = text(reference.sourceId, 200) || null
      const digestRef = text(reference.digestId, 200) || null
      if ((sourceId === null) === (digestRef === null)) {
        throw new PsycheError(CODE.validation, 'reference 必须且只能给 sourceId 或 digestId 之一', { itemKey })
      }
      db.run(
        'INSERT INTO checkpoint_references (checkpoint_id, revision, item_key, source_id, digest_id, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
        [checkpointId, revision, itemKey, sourceId, digestRef, at],
      )
    }

    // 只有 range 任务、且区间刚好接在已核实水位后面，才算「连续覆盖」。
    // 手动保存一律不动水位：它没有可重放的区间，推进一格等于宣称处理了一条从未被覆盖的事实。
    const committed = committedToSeqOf(db, input.bindingId)
    let nextCommitted = committed
    if (mode === 'range' && fromSeq <= committed + 1 && toSeq > committed) {
      nextCommitted = toSeq
      db.run('UPDATE project_session_bindings SET committed_to_seq = ? WHERE binding_id = ?', [nextCommitted, input.bindingId])
    }

    db.run("UPDATE digest_jobs SET status = 'succeeded', finished_at = ?, updated_at = ? WHERE job_id = ?", [at, at, jobId])

    return {
      saved: true,
      replayed: false,
      noChange: false,
      jobId,
      digestId,
      checkpointId,
      revision,
      committedToSeq: nextCommitted,
    }
  })
}

/** 读某个分支当前的活动指针与最新修订（不写库）。 */
export function readCheckpoint(
  db: Db,
  input: { projectId: string; branchKey?: string },
): CheckpointView | null {
  const branchKey = typeof input.branchKey === 'string' ? input.branchKey : GENERAL_BRANCH_KEY
  const stage = db.get<{ checkpointId: string; headRevision: number; updatedAt: string }>(
    'SELECT checkpoint_id AS checkpointId, head_revision AS headRevision, updated_at AS updatedAt ' +
      'FROM project_checkpoints WHERE project_id = ? AND branch_key = ?',
    [input.projectId, branchKey],
  )
  if (!stage) return null

  const head = Number(stage.headRevision)
  const row = db.get<Record<string, unknown>>(
    'SELECT revision, repo_ref AS repoRef, last_active_at AS lastActiveAt, current_goal AS currentGoal, ' +
      'completed_json AS completedJson, blockers_json AS blockersJson, next_steps_json AS nextStepsJson, ' +
      'dependencies_json AS dependenciesJson, decisions_json AS decisionsJson, confidence, generator, ' +
      'origin_digest_id AS originDigestId, created_at AS createdAt ' +
      'FROM checkpoint_revisions WHERE checkpoint_id = ? AND revision = ?',
    [stage.checkpointId, head],
  )

  const refs = db.all<{ itemKey: string; sourceId: string | null; digestId: string | null }>(
    'SELECT item_key AS itemKey, source_id AS sourceId, digest_id AS digestId FROM checkpoint_references ' +
      'WHERE checkpoint_id = ? AND revision = ? ORDER BY ref_id',
    [stage.checkpointId, head],
  )

  return {
    projectId: input.projectId,
    branchKey,
    checkpointId: stage.checkpointId,
    headRevision: head,
    updatedAt: stage.updatedAt,
    revision: row
      ? {
          revision: Number(row.revision),
          repoRef: (row.repoRef as string | null) ?? null,
          lastActiveAt: (row.lastActiveAt as string | null) ?? null,
          currentGoal: (row.currentGoal as string | null) ?? null,
          completed: parseArray(row.completedJson),
          blockers: parseArray(row.blockersJson),
          nextSteps: parseArray(row.nextStepsJson),
          dependencies: parseArray(row.dependenciesJson),
          decisions: parseArray(row.decisionsJson),
          confidence: (row.confidence as Confidence) ?? 'medium',
          generator: String(row.generator ?? ''),
          originDigestId: (row.originDigestId as string | null) ?? null,
          createdAt: String(row.createdAt ?? ''),
        }
      : null,
    references: refs,
  }
}

/**
 * 按「Checkpoint + 指定修订」读取，不受 head 影响。
 *
 * 为什么单独给一个入口：手动交接的验收要求「重启后能按原 Checkpoint ID 和
 * revision 读回内容」。head 会随后续保存前移，`readCheckpoint` 只给最新一条，
 * 所以历史修订必须能按 id 定点取回，否则这条判据无法证明。
 */
export function readCheckpointRevision(
  db: Db,
  input: { checkpointId: string; revision: number },
): CheckpointView | null {
  const checkpointId = text(input.checkpointId, 120)
  const revision = input.revision
  if (!checkpointId) throw new PsycheError(CODE.validation, 'checkpointId 不能为空')
  requirePositive(revision, 'revision')

  const stage = db.get<{ projectId: string; branchKey: string; updatedAt: string }>(
    'SELECT project_id AS projectId, branch_key AS branchKey, updated_at AS updatedAt ' +
      'FROM project_checkpoints WHERE checkpoint_id = ?',
    [checkpointId],
  )
  if (!stage) return null

  const row = db.get<Record<string, unknown>>(
    'SELECT revision, repo_ref AS repoRef, last_active_at AS lastActiveAt, current_goal AS currentGoal, ' +
      'completed_json AS completedJson, blockers_json AS blockersJson, next_steps_json AS nextStepsJson, ' +
      'dependencies_json AS dependenciesJson, decisions_json AS decisionsJson, confidence, generator, ' +
      'origin_digest_id AS originDigestId, created_at AS createdAt ' +
      'FROM checkpoint_revisions WHERE checkpoint_id = ? AND revision = ?',
    [checkpointId, revision],
  )
  if (!row) return null

  const refs = db.all<{ itemKey: string; sourceId: string | null; digestId: string | null }>(
    'SELECT item_key AS itemKey, source_id AS sourceId, digest_id AS digestId FROM checkpoint_references ' +
      'WHERE checkpoint_id = ? AND revision = ? ORDER BY ref_id',
    [checkpointId, revision],
  )

  const head = db.get<{ headRevision: number }>(
    'SELECT head_revision AS headRevision FROM project_checkpoints WHERE checkpoint_id = ?',
    [checkpointId],
  )

  return {
    projectId: stage.projectId,
    branchKey: stage.branchKey,
    checkpointId,
    headRevision: Number(head?.headRevision ?? revision),
    updatedAt: stage.updatedAt,
    revision: {
      revision: Number(row.revision),
      repoRef: (row.repoRef as string | null) ?? null,
      lastActiveAt: (row.lastActiveAt as string | null) ?? null,
      currentGoal: (row.currentGoal as string | null) ?? null,
      completed: parseArray(row.completedJson),
      blockers: parseArray(row.blockersJson),
      nextSteps: parseArray(row.nextStepsJson),
      dependencies: parseArray(row.dependenciesJson),
      decisions: parseArray(row.decisionsJson),
      confidence: (row.confidence as Confidence) ?? 'medium',
      generator: String(row.generator ?? ''),
      originDigestId: (row.originDigestId as string | null) ?? null,
      createdAt: String(row.createdAt ?? ''),
    },
    references: refs,
  }
}
