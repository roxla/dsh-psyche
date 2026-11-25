/**
 * G2-A：会话摘要队列。
 *
 * 这一层只做「排队、领取、提交、失败重试、水位」——**不调用模型**。摘要正文由调用方
 * 生成后交给 `completeDigestJob()`；把模型调用留在外面，测试就能用临时库 + 固定时钟
 * 验证队列语义，不必为它准备一个可用的模型。
 *
 * 四条纪律：
 *   1. 入队幂等。同一个 (binding, 区间, 算法版本) 只该有一条 range 任务，重复入队返回
 *      既有那一行，不新增。
 *   2. 一次只被一个 worker 领走。领取用「条件 UPDATE + 检查变化行数」，在事务里做，
 *      两个 worker 同时领取只有一个能改到。
 *   3. 失败不回退水位。水位取的是「已成功任务里最大的 to_seq」，失败任务保留在表里
 *      供重试，但它不参与水位。
 *   4. 成功不重复写。一个 job 最多一条 `session_digests`（`idx_digests_job` 唯一），
 *      重放同一 job 的提交直接返回既有摘要。
 */

const RANGE_VERSION_DEFAULT = 'digest-v1'

/**
 * 领取后多久算租约过期。过期的 running 任务会被下一次领取重新视为可领；同时，
 * 过期之后即使没人重领，原来那次领取也不再有权提交（P0-B2「过期即失效」）。
 */
export const DIGEST_LEASE_MS = 5 * 60_000

/**
 * 这次领取是否还在租约内。
 *
 * 读的是**库里**的 `claimed_at`，不是调用方记的时间：调用方可以声称自己刚领到，
 * 但只有库里的领取时刻才作数，否则「完成时顺手延长租约」永远无法被拒绝。
 * `claimed_at` 缺失或不可解析一律视为已过期——拿不到领取凭据就没有提交权。
 */
function leaseExpired(claimedAt: string | null, now: Date, leaseMs: number): boolean {
  if (claimedAt === null || claimedAt === '') return true
  const claimedMs = Date.parse(claimedAt)
  if (!Number.isFinite(claimedMs)) return true
  return claimedMs + leaseMs <= now.getTime()
}

/**
 * 续排结果。`planned` 表示真的建了新任务；`none` 表示查过了、不需要（含后一区间已存在）；
 * `skipped-not-committed` 表示本次没有实际提交，压根不该续排；`skipped-inactive` 表示
 * 绑定已解绑或项目已归档；`failed` 表示检查/写入过程抛错。
 */
export type DigestReplanOutcome =
  | 'planned'
  | 'none'
  | 'skipped-not-committed'
  | 'skipped-inactive'
  | 'failed'


export interface DigestJobRow {
  readonly jobId: string
  readonly bindingId: string
  readonly fromSeq: number
  readonly toSeq: number
  readonly algorithmVersion: string
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed' | 'no_change' | 'cancelled'
  readonly attempts: number
  readonly errorCode: string | null
  readonly nextRetryAt: string | null
  readonly claimedAt: string | null
  readonly finishedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SessionDigestRow {
  readonly digestId: string
  readonly jobId: string
  readonly bodyJson: string
  readonly sourceIdsJson: string
  readonly createdAt: string
}

/** 只要求用到的那几个方法，便于测试注入替身。 */
export interface DigestDb {
  get<T>(sql: string, params?: readonly unknown[]): T | undefined
  all<T>(sql: string, params?: readonly unknown[]): readonly T[]
  run(sql: string, params?: readonly unknown[]): { changes: number }
  transaction<T>(fn: () => T): T
}

interface RawJobRow {
  job_id?: string
  binding_id?: string
  from_seq?: number
  to_seq?: number
  algorithm_version?: string
  status?: string
  attempts?: number
  error_code?: string | null
  next_retry_at?: string | null
  claimed_at?: string | null
  finished_at?: string | null
  created_at?: string
  updated_at?: string
}

interface RawDigestRow {
  digest_id?: string
  job_id?: string
  body_json?: string
  source_ids_json?: string
  created_at?: string
}

function toJobRow(row: RawJobRow): DigestJobRow {
  return {
    jobId: String(row.job_id ?? ''),
    bindingId: String(row.binding_id ?? ''),
    fromSeq: Number(row.from_seq ?? 0),
    toSeq: Number(row.to_seq ?? 0),
    algorithmVersion: String(row.algorithm_version ?? ''),
    status: (row.status ?? 'pending') as DigestJobRow['status'],
    attempts: Number(row.attempts ?? 0),
    errorCode: row.error_code ?? null,
    nextRetryAt: row.next_retry_at ?? null,
    claimedAt: row.claimed_at ?? null,
    finishedAt: row.finished_at ?? null,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  }
}

function toDigestRow(row: RawDigestRow): SessionDigestRow {
  return {
    digestId: String(row.digest_id ?? ''),
    jobId: String(row.job_id ?? ''),
    bodyJson: String(row.body_json ?? '{}'),
    sourceIdsJson: String(row.source_ids_json ?? '[]'),
    createdAt: String(row.created_at ?? ''),
  }
}

export interface EnqueueDigestInput {
  readonly db: DigestDb
  readonly bindingId: string
  readonly fromSeq: number
  readonly toSeq: number
  readonly algorithmVersion?: string
  readonly now: Date
}

export type EnqueueDigestStatus = 'created' | 'replayed' | 'bad-range'

export interface EnqueueDigestResult {
  readonly status: EnqueueDigestStatus
  readonly job: DigestJobRow | null
}

/**
 * 入队一个区间任务。
 *
 * 区间不合法（`fromSeq < 1` 或 `toSeq < fromSeq`）直接拒绝，不写库——空区间与倒置区间
 * 都不是「没内容」，而是调用方算错了，静默吞掉会让水位永远推不动。
 */
export function enqueueDigestJob(input: EnqueueDigestInput): EnqueueDigestResult {
  const { db, bindingId, fromSeq, toSeq } = input
  const version = input.algorithmVersion ?? RANGE_VERSION_DEFAULT
  if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || fromSeq < 1 || toSeq < fromSeq) {
    return { status: 'bad-range', job: null }
  }
  const nowIso = input.now.toISOString()

  const existing = db.get<RawJobRow>(
    `SELECT * FROM digest_jobs
      WHERE binding_id = ? AND from_seq = ? AND to_seq = ? AND algorithm_version = ? AND mode = 'range'`,
    [bindingId, fromSeq, toSeq, version],
  )
  if (existing !== undefined) return { status: 'replayed', job: toJobRow(existing) }

  const jobId = `djob_${bindingId}_${fromSeq}_${toSeq}_${version}`.replace(/[^A-Za-z0-9_.:-]/g, '_')
  db.run(
    `INSERT INTO digest_jobs (
       job_id, binding_id, from_seq, to_seq, algorithm_version, status, attempts,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    [jobId, bindingId, fromSeq, toSeq, version, nowIso, nowIso],
  )
  const inserted = db.get<RawJobRow>(`SELECT * FROM digest_jobs WHERE job_id = ?`, [jobId])
  return { status: 'created', job: inserted === undefined ? null : toJobRow(inserted) }
}

export interface ClaimDigestInput {
  readonly db: DigestDb
  readonly now: Date
}

/**
 * 领取一条可跑的任务。
 *
 * 候选是「pending 且到期」或者「running 但租约过期」——后者是为了进程崩溃后任务不会
 * 永久卡在 running。领取动作是条件 UPDATE，返回变化行数，只有真正改到的那次才算领到。
 *
 * 租期固定为 {@link DIGEST_LEASE_MS}：领取、完成、失败共用同一个常量，调用方不能改写。
 * （P0-B2 第 51/8 轮：早期版本允许调用方传 `leaseMs`，于是「领取时用短租期、
 * 完成时省略参数」就能让写入守卫按长租期放行——租期必须唯一，不能按入口变。）
 */
export function claimDigestJob(input: ClaimDigestInput): DigestJobRow | null {
  const { db } = input
  const nowIso = input.now.toISOString()
  const staleBefore = new Date(input.now.getTime() - DIGEST_LEASE_MS).toISOString()

  return db.transaction(() => {
    const candidate = db.get<RawJobRow>(
      `SELECT * FROM digest_jobs
        WHERE mode = 'range'
          AND ((status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?))
            OR (status = 'running' AND claimed_at IS NOT NULL AND claimed_at <= ?))
        ORDER BY created_at, job_id
        LIMIT 1`,
      [nowIso, staleBefore],
    )
    if (candidate === undefined) return null
    const jobId = String(candidate.job_id ?? '')
    const changed = db.run(
      `UPDATE digest_jobs
          SET status = 'running', claimed_at = ?, attempts = attempts + 1, updated_at = ?
        WHERE job_id = ?
          AND mode = 'range'
          AND (status = 'pending'
               OR (status = 'running' AND claimed_at IS NOT NULL AND claimed_at <= ?))`,
      [nowIso, nowIso, jobId, staleBefore],
    )
    if (changed.changes === 0) return null
    const claimed = db.get<RawJobRow>(`SELECT * FROM digest_jobs WHERE job_id = ?`, [jobId])
    return claimed === undefined ? null : toJobRow(claimed)
  })
}

export interface CompleteDigestInput {
  readonly db: DigestDb
  readonly jobId: string
  /**
   * 领取时拿到的尝试次数。写回时用它做条件，防止「租约过期后被别人重领、
   * 自己迟到写回」把别人的结果覆盖掉。第 45 轮外部评审 Q2。
   */
  readonly attempts: number
  readonly bodyJson: string
  readonly sourceIds: readonly string[]
  readonly now: Date
  /** 跑完但没有值得记的变化时用 `no_change`，它同样算处理完、也推水位。 */
  readonly outcome?: 'succeeded' | 'no_change'
  /**
   * 自动摘要总开关（P0-B2）。只有开启时才允许在提交后续排下一批；
   * 这个值在规划写入的同一事务里被复核，不是提交前读一次就算了。
   */
  readonly autoEnabled?: boolean
}

export interface CompleteDigestResult {
  readonly status: 'completed' | 'replayed' | 'not-running' | 'lease-lost'
  readonly digest: SessionDigestRow | null
  /** 本次提交之后的续排结果，供调用方记诊断；不写库。 */
  readonly replan: DigestReplanOutcome
  /** `replan === 'failed'` 时的错误文本，其余情况为 null。 */
  readonly replanError: string | null
}


/**
 * 提交一条任务的产物。
 *
 * 同一个 job 最多一条摘要：已存在就直接返回（重放不重复写）。写入与状态变更在同一个
 * 事务里，避免「摘要写了、任务还是 running」这种半成品。
 *
 * P0-B2：提交权在**写入点**裁决，而不是只在进入函数时比一下 `attempts`。
 * 条件 UPDATE 同时匹配 job、`mode='range'`、`running`、本次 `attempts`、以及
 * 「库里 `claimed_at` + 租约 > now」。命中 0 行时什么都不写——没有摘要、没有水位推进、
 * 也不续排。过期但无人重领同样按失效处理：与领取侧的可重领边界正好互补。
 */
export function completeDigestJob(input: CompleteDigestInput): CompleteDigestResult {
  const { db, jobId } = input
  const outcome = input.outcome ?? 'succeeded'
  const nowIso = input.now.toISOString()
  // P0-B2：租期固定，三个入口共用 `DIGEST_LEASE_MS`。没有任何调用方能改写它，
  // 所以不存在「领取用短租期、完成按长租期放行」的窗口。
  const staleBefore = new Date(input.now.getTime() - DIGEST_LEASE_MS).toISOString()

  /** 事务里读到的 binding_id，续排时要用（`job` 是闭包局部变量，外面看不到）。 */
  let completedBindingId = ''
  const completed = db.transaction(() => {
    const job = db.get<RawJobRow>(`SELECT * FROM digest_jobs WHERE job_id = ?`, [jobId])
    completedBindingId = String(job?.binding_id ?? '')
    if (job === undefined) return { status: 'not-running', digest: null } as const
    const status = String(job.status ?? '')
    if (status === 'succeeded' || status === 'no_change') {
      const existing = db.get<RawDigestRow>(`SELECT * FROM session_digests WHERE job_id = ?`, [jobId])
      return { status: 'replayed', digest: existing === undefined ? null : toDigestRow(existing) } as const
    }
    if (status !== 'running') return { status: 'not-running', digest: null } as const
    // 租约凭据校验：`attempts` 在领取时 +1，所以它唯一标识「第几次领取」。
    // 被顶掉的那次写回时 attempts 已经不是当前值，这里直接失败返回，不覆盖别人的结果。
    if (Number(job.attempts ?? 0) !== input.attempts) {
      return { status: 'lease-lost', digest: null } as const
    }
    // P0-B2：过期即失效。`claimed_at` 取自库里的那一行，调用方无法在完成时补租约。
    if (leaseExpired(job.claimed_at ?? null, input.now, DIGEST_LEASE_MS)) {
      return { status: 'lease-lost', digest: null } as const
    }

    const existing = db.get<RawDigestRow>(`SELECT * FROM session_digests WHERE job_id = ?`, [jobId])
    if (existing !== undefined) {
      const settled = db.run(
        `UPDATE digest_jobs
            SET status = ?, finished_at = ?, next_retry_at = NULL, updated_at = ?
          WHERE job_id = ?
            AND mode = 'range'
            AND status = 'running'
            AND attempts = ?
            AND claimed_at IS NOT NULL
            AND claimed_at > ?`,
        [outcome, nowIso, nowIso, jobId, input.attempts, staleBefore],
      )
      if (settled.changes !== 1) return { status: 'lease-lost', digest: null } as const
      return { status: 'replayed', digest: toDigestRow(existing) } as const
    }

    // 先把 job 从 running 收口：这一步就是「提交权」的裁决。命中 0 行说明租约在用
    // 户看不到的地方失效了（被重领、或刚好跨过边界），此时下面的摘要与水位都不能写。
    const settled = db.run(
      `UPDATE digest_jobs
          SET status = ?, finished_at = ?, next_retry_at = NULL, error_code = NULL, updated_at = ?
        WHERE job_id = ?
          AND mode = 'range'
          AND status = 'running'
          AND attempts = ?
          AND claimed_at IS NOT NULL
          AND claimed_at > ?`,
      [outcome, nowIso, nowIso, jobId, input.attempts, staleBefore],
    )
    if (settled.changes !== 1) return { status: 'lease-lost', digest: null } as const

    const digestId = `dgst_${jobId}`
    db.run(
      `INSERT INTO session_digests (digest_id, job_id, body_json, source_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [digestId, jobId, input.bodyJson, JSON.stringify([...input.sourceIds]), nowIso],
    )
    // 第 44/46 轮外部评审 Q3：项目绑定的连续水位要跟着推进。
    // `committed_to_seq` 的语义是「这个固定绑定内自动摘要已经处理完的**连续前缀**」。
    //
    // 这里不能用 MAX(committed_to_seq, to_seq)：如果 [17,24] 先成功而 [9,16] 还在退避，
    // MAX 会把水位直接推到 24，中间那段就再也不会被处理了。必须从当前水位出发，
    // 反复找「接得上的成功区间」（含 no_change），一直推到第一个空隙为止。
    const bindingId = String(job.binding_id ?? '')
    const current = db.get<{ committed_to_seq?: number }>(
      `SELECT committed_to_seq FROM project_session_bindings WHERE binding_id = ?`,
      [bindingId],
    )
    let watermark = Number(current?.committed_to_seq ?? 0)
    for (;;) {
      const next = db.get<{ t?: number }>(
        `SELECT MAX(to_seq) AS t FROM digest_jobs
          WHERE binding_id = ?
            AND mode = 'range'
            AND status IN ('succeeded', 'no_change')
            AND from_seq <= ?
            AND to_seq > ?`,
        [bindingId, watermark + 1, watermark],
      )
      const reached = Number(next?.t ?? 0)
      if (!Number.isFinite(reached) || reached <= watermark) break
      watermark = reached
    }
    db.run(`UPDATE project_session_bindings SET committed_to_seq = ? WHERE binding_id = ?`, [
      watermark,
      bindingId,
    ])
    const inserted = db.get<RawDigestRow>(`SELECT * FROM session_digests WHERE digest_id = ?`, [digestId])
    return { status: 'completed', digest: inserted === undefined ? null : toDigestRow(inserted) } as const
  })

  // P0-B2：只有「本次真的提交了」才进入续排。replayed / lease-lost / not-running 都
  // 不新建任务——那些情况要么别人已经处理过，要么本来就没轮到我们。
  if (completed.status !== 'completed') {
    return {
      status: completed.status,
      digest: completed.digest,
      replan: 'skipped-not-committed',
      replanError: null,
    }
  }
  const replanned = replanAfterCommit({
    db,
    bindingId: completedBindingId,
    now: input.now,
    leaseMs: DIGEST_LEASE_MS,
    autoEnabled: input.autoEnabled,
  })
  return {
    status: 'completed',
    digest: completed.digest,
    replan: replanned.replan,
    replanError: replanned.error,
  }
}


export interface FailDigestInput {
  readonly db: DigestDb
  readonly jobId: string
  /** 领取时拿到的尝试次数，用作「这次领取」的凭据；被顶掉的写回会失败。 */
  readonly attempts: number
  readonly errorCode: string
  readonly now: Date
  /** 下次可重试的时间；不传就退回 pending 立即可领。 */
  readonly nextRetryAt?: Date | null
}

/**
 * 失败侧的裁决结果。
 *
 * 布尔返回值分不出「已记录失败」和「租约早就失效」——前者可以重试，后者说明这条
 * 任务已经属于别人。诊断与重试策略需要这个区别，所以保留布尔包装的同时给出原因。
 */
export type FailDigestOutcome = 'recorded' | 'lease-lost' | 'not-running'

export interface FailDigestResult {
  readonly status: FailDigestOutcome
}

/**
 * 记一次失败。任务回到 pending 等下一次领取，`attempts` 已在领取时加过。
 *
 * 失败**不动水位**：`successfulWatermark()` 只看已成功的任务，所以一批任务里前面成功、
 * 后面失败时，水位停在上一条成功处，重试不会丢内容也不重复计入。
 *
 * P0-B2：与完成同一套写入点裁决——条件 UPDATE 同时匹配 job、`mode='range'`、
 * `running`、本次 `attempts`、以及库中 `claimed_at + 租约 > now`。
 */
export function failDigestJobResult(input: FailDigestInput): FailDigestResult {
  const nowIso = input.now.toISOString()
  // 同 complete：租期固定，失败方同样不能自己定租期。
  const staleBefore = new Date(input.now.getTime() - DIGEST_LEASE_MS).toISOString()
  const changed = input.db.run(
    `UPDATE digest_jobs
        SET status = 'pending', error_code = ?, next_retry_at = ?, claimed_at = NULL, updated_at = ?
      WHERE job_id = ?
        AND mode = 'range'
        AND status = 'running'
        AND attempts = ?
        AND claimed_at IS NOT NULL
        AND claimed_at > ?`,
    [
      input.errorCode,
      input.nextRetryAt === null || input.nextRetryAt === undefined ? null : input.nextRetryAt.toISOString(),
      nowIso,
      input.jobId,
      input.attempts,
      staleBefore,
    ],
  )
  if (changed.changes === 1) return { status: 'recorded' }
  // 没改到：要么任务已经不在 running（别人收口了），要么这次领取已经过期/被顶掉。
  const job = input.db.get<RawJobRow>(`SELECT * FROM digest_jobs WHERE job_id = ?`, [input.jobId])
  if (job === undefined || String(job.status ?? '') !== 'running') return { status: 'not-running' }
  if (Number(job.attempts ?? 0) !== input.attempts) return { status: 'lease-lost' }
  if (leaseExpired(job.claimed_at ?? null, input.now, DIGEST_LEASE_MS)) return { status: 'lease-lost' }
  return { status: 'lease-lost' }
}

/** 兼容包装：只回答「这次失败有没有被记下」。需要区分原因时用 {@link failDigestJobResult}。 */
export function failDigestJob(input: FailDigestInput): boolean {
  return failDigestJobResult(input).status === 'recorded'
}


/**
 * 该绑定上「已处理到第几轮」。没有成功任务时返回 0，不是 null。
 *
 * 第 52 轮外部评审 P0-B：这里必须读 `project_session_bindings.committed_to_seq`，
 * 不能 `SELECT MAX(to_seq)`。MAX 只回答「成功过的最大右端」，回答不了「中间有没有空洞」：
 * [17,24] 先成功、[9,16] 还在退避时，MAX 会把读取方带到 24，规划就从 25 开始，
 * 中间那 8 轮再也不会被摘要。连续前缀这个语义只由完成路径维护，读数就只认它。
 */
export function successfulWatermark(db: DigestDb, bindingId: string): number {
  const row = db.get<{ committed_to_seq?: number | null }>(
    `SELECT committed_to_seq FROM project_session_bindings WHERE binding_id = ?`,
    [bindingId],
  )
  const value = row?.committed_to_seq
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 该绑定上还有多少条待处理任务（含待重试）。用于「够不够一批」的判断与诊断。 */
export function pendingDigestCount(db: DigestDb, bindingId: string): number {
  const row = db.get<{ n?: number | null }>(
    `SELECT COUNT(*) AS n FROM digest_jobs
      WHERE binding_id = ? AND mode = 'range' AND status IN ('pending', 'running')`,
    [bindingId],
  )
  const value = row?.n
  return typeof value === 'number' ? value : 0
}

/** 读取某条任务关联的摘要（没有就返回 null）。 */
export function readDigestOfJob(db: DigestDb, jobId: string): SessionDigestRow | null {
  const row = db.get<RawDigestRow>(`SELECT * FROM session_digests WHERE job_id = ?`, [jobId])
  return row === undefined ? null : toDigestRow(row)
}

/** 一批至少要攒够多少个有效轮才值得摘要。 */
export const DIGEST_MIN_TURNS = 8

export interface PlanDigestInput {
  readonly db: DigestDb
  readonly bindingId: string
  readonly sessionRef: string
  readonly now: Date
  readonly minTurns?: number
}

export interface PlanDigestResult {
  readonly status: 'ready' | 'below-threshold'
  /** 已处理到第几轮（来自已成功任务）。 */
  readonly watermark: number
  /** 水位之后还有几个有效轮。 */
  readonly pendingTurns: number
  readonly job: DigestJobRow | null
}

/**
 * 判断一个绑定是否够一批了，够就入队。
 *
 * 「有效轮」按**用户发言条数**算：一条用户消息加上它引出的回复是一轮，而回复可能缺失
 * （模型失败、被撤权拦下），所以只数用户的。这个口径比「数模型回复」稳——回复缺一条
 * 不该让整批永远凑不齐。
 *
 * 区间从「上次成功处理到的下一轮」开始，避免同一段被反复摘要。
 *
 * 这是**纯规划核心**：调用方必须已经处在事务里。`planDigestJob()` 与
 * `planEligibleDigestJob()` 各自开事务后再调它，资格复核与写入因此在同一个事务里。
 */
function planDigestJobInner(input: PlanDigestInput): PlanDigestResult {
  const { db, bindingId, sessionRef } = input
  const minTurns = input.minTurns ?? DIGEST_MIN_TURNS

  {
    const watermark = successfulWatermark(db, bindingId)

    // 第 45 轮外部评审 Q1：轮次身份改按 turn_id 数，不再数发言条数。
    //
    // 一轮里合法地可能有多条用户消息（补一句、再补一句），也可能一条回复都没有
    // （模型失败、被撤权拦下）。数条数会让「一次生成失败」变成「以后永远凑不齐」，
    // 也会让「8 条消息」被当成「8 轮」。
    //
    // 只数**既有用户正文、又有助手正文**的轮；没有 turn_id 的历史行不算——
    // 拿不到轮次身份时宁可少算，也不拿别的字段猜。
    const row = db.get<{ n?: number | null }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT turn_id
           FROM sources
          WHERE session_ref = ? AND turn_id IS NOT NULL
          GROUP BY turn_id
         HAVING SUM(CASE WHEN origin = 'user' AND text IS NOT NULL AND length(trim(text)) > 0 THEN 1 ELSE 0 END) > 0
            AND SUM(CASE WHEN origin = 'self' AND text IS NOT NULL AND length(trim(text)) > 0 THEN 1 ELSE 0 END) > 0
       )`,
      [sessionRef],
    )
    const totalTurns = typeof row?.n === 'number' ? row.n : 0
    const pendingTurns = Math.max(0, totalTurns - watermark)

    // 第 52 轮 P0-B（第 3 轮评审 G7）：先找「已经成功过的后段」。
    //
    // 若水位之后还有已成功的区间，说明那段素材已经处理过、只是被当前水位之后的空洞
    // 挡住了，无法纳入连续水位。这种「补洞」不该受最低轮数阈值限制——否则空洞不足 8 轮
    // 时永远排不出任务，水位永久卡住（第 3 轮评审点名的最大剩余风险）。
    // 没有已成功后段的普通新增素材仍遵守原阈值。
    const nextSucceeded = db.get<{ s?: number | null }>(
      `SELECT MIN(from_seq) AS s FROM digest_jobs
        WHERE binding_id = ?
          AND mode = 'range'
          AND status IN ('succeeded', 'no_change')
          AND from_seq > ?`,
      [bindingId, watermark + 1],
    )
    const nextFrom = Number(nextSucceeded?.s ?? 0)
    const repairingHole = Number.isFinite(nextFrom) && nextFrom > 0

    if (pendingTurns < minTurns && !repairingHole) {
      return { status: 'below-threshold', watermark, pendingTurns, job: null }
    }

    // 手上还有没做完的任务时不再开新的：否则第 9 轮进来会建出 [1,9]，
    // 和第 8 轮那个 [1,8] 覆盖同一段素材，同一批内容被摘要两次。
    // 等 [1,8] 完成、水位推到 8，下一次检查才会建 [9,16]。
    if (pendingDigestCount(db, bindingId) > 0) {
      return { status: 'below-threshold', watermark, pendingTurns, job: null }
    }

    const fromSeq = watermark + 1
    // 第 52 轮 P0-B：区间不能跨过「已经成功过的后段」。
    //
    // 若 [17,24] 先成功、水位还停在 8，按 `watermark + pendingTurns` 规划会得到
    // [9,24]，把 17..24 再摘要一遍——这正是本函数注释里「同一段内容被摘要两次」
    // 那种情况。区间右端取「下一段已成功的开始之前」。
    const plannedTo = watermark + pendingTurns
    const toSeq = repairingHole
      ? Math.min(plannedTo, nextFrom - 1)
      : plannedTo
    if (toSeq <= watermark) {
      return { status: 'below-threshold', watermark, pendingTurns, job: null }
    }
    const enqueued = enqueueDigestJob({ db, bindingId, fromSeq, toSeq, now: input.now })
    return { status: 'ready', watermark, pendingTurns, job: enqueued.job }
  }
}

/**
 * 规划一条任务（不带资格复核）。
 *
 * 第 49 轮外部评审：检查与插入必须在同一个事务里。分成「先读 pendingDigestCount、
 * 再 enqueue」两步的话，两个并发规划者会同时看到「没活」而各插一条 [1,8]——
 * 单进程靠 JS 单线程碰不到，两个 worker 或两次并发检查就会漏。
 */
export function planDigestJob(input: PlanDigestInput): PlanDigestResult {
  return input.db.transaction((): PlanDigestResult => planDigestJobInner(input))
}

/** 规划前的资格判定结果。`ok` 之外都表示「查过、不该排」。 */
export type DigestEligibility = 'ok' | 'auto-off' | 'unbound' | 'project-inactive'

export interface PlanEligibleInput extends PlanDigestInput {
  /**
   * 自动摘要总开关。默认 `true`（沿用既有行为），AM-1 接上配置后再由调用方传真实值。
   * 这个值在**规划写入的同一事务里**被复核，正常续排与启动恢复都走这条路径。
   */
  readonly autoEnabled?: boolean
}

export interface PlanEligibleResult extends PlanDigestResult {
  readonly eligibility: DigestEligibility
}

interface BindingFactsRow {
  session_ref?: string | null
  unbound_at?: string | null
  project_id?: string | null
}

/**
 * 带资格复核的规划：自动模式开启、绑定仍活动、项目仍 active，三项都在事务内判。
 *
 * P0-B2 要求「资格要在规划写入的同一事务内复核」——否则关掉自动模式/解绑/归档的
 * 瞬间正好有一个规划者在跑，就会留下一条谁都不该再处理的任务。
 */
export function planEligibleDigestJob(input: PlanEligibleInput): PlanEligibleResult {
  const { db, bindingId } = input
  return db.transaction((): PlanEligibleResult => {
    const binding = db.get<BindingFactsRow>(
      `SELECT session_ref, unbound_at, project_id FROM project_session_bindings WHERE binding_id = ?`,
      [bindingId],
    )
    if (binding === undefined || (binding.unbound_at ?? null) !== null) {
      return { eligibility: 'unbound', status: 'below-threshold', watermark: 0, pendingTurns: 0, job: null }
    }
    const projectId = String(binding.project_id ?? '')
    const project =
      projectId === ''
        ? undefined
        : db.get<{ status?: string | null }>(`SELECT status FROM projects WHERE project_id = ?`, [projectId])
    if (project === undefined || String(project.status ?? '') !== 'active') {
      return { eligibility: 'project-inactive', status: 'below-threshold', watermark: 0, pendingTurns: 0, job: null }
    }
    if (input.autoEnabled === false) {
      return { eligibility: 'auto-off', status: 'below-threshold', watermark: 0, pendingTurns: 0, job: null }
    }
    const sessionRef = input.sessionRef !== '' ? input.sessionRef : String(binding.session_ref ?? '')
    if (sessionRef === '') {
      return { eligibility: 'unbound', status: 'below-threshold', watermark: 0, pendingTurns: 0, job: null }
    }
    const planned = planDigestJobInner({ ...input, sessionRef })
    return { eligibility: 'ok', ...planned }
  })
}

export interface ReplanAfterCommitInput {
  readonly db: DigestDb
  readonly bindingId: string
  readonly now: Date
  readonly leaseMs: number
  readonly autoEnabled?: boolean
}

/**
 * 提交之后的续排。只在本次**实际提交**之后调用。
 *
 * 异常不再静默吞掉：返回 `failed` 与错误文本，让调用方记一条能定位到 job 的诊断。
 * 已提交的摘要不会因为续排失败而回滚——两者本就分属不同事务。
 */
export function replanAfterCommit(input: ReplanAfterCommitInput): {
  readonly replan: DigestReplanOutcome
  readonly error: string | null
} {
  if (input.bindingId === '') return { replan: 'skipped-inactive', error: null }
  try {
    const row = input.db.get<BindingFactsRow>(
      `SELECT session_ref, unbound_at FROM project_session_bindings WHERE binding_id = ?`,
      [input.bindingId],
    )
    const sessionRef = typeof row?.session_ref === 'string' ? row.session_ref : ''
    if (row === undefined || (row.unbound_at ?? null) !== null || sessionRef === '') {
      return { replan: 'skipped-inactive', error: null }
    }
    const planned = planEligibleDigestJob({
      db: input.db,
      bindingId: input.bindingId,
      sessionRef,
      now: input.now,
      autoEnabled: input.autoEnabled,
    })
    if (planned.eligibility !== 'ok') return { replan: 'skipped-inactive', error: null }
    if (planned.status === 'ready' && planned.job !== null) return { replan: 'planned', error: null }
    return { replan: 'none', error: null }
  } catch (error) {
    return { replan: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

export interface ResumeDigestInput {
  readonly db: DigestDb
  readonly now: Date
  readonly autoEnabled?: boolean
  readonly minTurns?: number
}

export interface ResumedDigestBinding {
  readonly bindingId: string
  readonly eligibility: DigestEligibility
  readonly status: PlanDigestResult['status']
  readonly job: DigestJobRow | null
}

export interface ResumeDigestResult {
  readonly scanned: number
  readonly planned: number
  readonly results: readonly ResumedDigestBinding[]
}

/**
 * 启动恢复：把「已提交但没来得及续排」的积压补出来。
 *
 * 只扫「绑定仍活动且项目 active」的行，规划逻辑与续排完全共用
 * `planEligibleDigestJob`——两条路径的资格判定必须一模一样，否则重启会绕过运行时规则。
 * 幂等：已有后续区间时 `planEligibleDigestJob` 返回 `below-threshold`，不会新建；
 * 反复调用只会补出真正缺的那一条。本函数不建定时器、不发消息、不调用模型。
 */
export function resumeDigestBacklog(input: ResumeDigestInput): ResumeDigestResult {
  const rows = input.db.all<{ binding_id?: string | null; session_ref?: string | null }>(
    `SELECT b.binding_id AS binding_id, b.session_ref AS session_ref
       FROM project_session_bindings b
       JOIN projects p ON p.project_id = b.project_id
      WHERE b.unbound_at IS NULL AND p.status = 'active'
      ORDER BY b.binding_id`,
  )
  const results: ResumedDigestBinding[] = []
  let planned = 0
  for (const row of rows) {
    const bindingId = String(row.binding_id ?? '')
    const sessionRef = typeof row.session_ref === 'string' ? row.session_ref : ''
    if (bindingId === '' || sessionRef === '') continue
    const plannedOne = planEligibleDigestJob({
      db: input.db,
      bindingId,
      sessionRef,
      now: input.now,
      autoEnabled: input.autoEnabled,
      minTurns: input.minTurns,
    })
    if (plannedOne.status === 'ready' && plannedOne.job !== null) planned += 1
    results.push({
      bindingId,
      eligibility: plannedOne.eligibility,
      status: plannedOne.status,
      job: plannedOne.job,
    })
  }
  return { scanned: results.length, planned, results }
}

