/**
 * P5-3a 成长反思候选（rule-only v1），P5-R-2 升级为逐条 Source 账本 + 每 Contact 配额。
 *
 * 边界（冻结契约，docs/design/p5-growth-reflection-contract.md；
 * Schema v29 细节 docs/design/p5-r2-schema-v29-freeze.md）：
 * - 只生成候选：不确认、不生效、不改 identity.md、不投影 Prompt；
 * - 只从「本次未处理、非助手」的 Source 与 fact / stance revision 生成；
 * - scope 取全部证据可见域的交集，空交集失败关闭（no_change），不提升 global；
 * - 独立性按等价类（independence_key）归并，不凭不同 source_id 冒充独立；
 * - 水位是逐条 Source 的已处理账本，不再比较时间；只有 proposed/no_change 写 processed；
 * - 配额按 contact_key 每天 1 个成功 reflection、全局 3 个，整轮在 BEGIN IMMEDIATE 内；
 * - skipped_budget 绑定原始 Source 集合（source_ids），到期只重试原集合，不并入新 Source；
 * - 崩溃恢复：evaluating 超过 timeout 先置 failed。
 *
 * v29.07 增加批次门槛：同一会话（platform + person+room 绑定 + session_ref）攒够
 * `minBatch`（默认 3）条才进入复盘；不足时返回 `below_batch` 且不写任何表。
 * 依据是实测：58 次复盘各自只读了 1 条消息，产出为 0——单条消息没有上下文，提炼不出结论，
 * 那两条碎片候选就是这么来的。不同会话/不同联系人绝不混批，否则会把甲说的话提炼成关于乙的结论。
 * 冷会话兜底：不足门槛但最老一条已等够 `maxWaitHours`（默认 24）时仍放行，避免永远等不到。
 */
import { createHash } from 'node:crypto'
import type { Db } from './adapter.js'
import { PREFIX, newId } from './ids.js'
import { isGrowthCandidateWorthy } from './growth-candidate-filter.js'

export type GrowthReflectionStatus =
  | 'evaluating'
  | 'proposed'
  | 'no_change'
  | 'failed'
  | 'skipped_budget'

export type GrowthCandidateType = 'new_fact' | 'revise_stance' | 'new_habit' | 'identity_growth'

export interface ReflectGrowthOptions {
  personaId?: string
  now?: Date
  /** evaluating 超过该时长视为崩溃遗留；契约是 60 秒预算的 2 倍。 */
  timeoutMs?: number
  perContactDaily?: number
  globalDaily?: number
  /**
   * 一批复盘至少要有几条 Source。
   *
   * 实测里 58 次复盘各自只读了 1 条消息，产出为 0——单条消息没有上下文，提炼不出结论，
   * 那两条碎片候选就是这么来的。低于门槛先不跑，等同一会话攒够。
   */
  minBatch?: number
  /** 不足 `minBatch` 时最多等多久；超过就按现有条数跑一次，避免冷会话永远等不到。 */
  maxWaitHours?: number
  /** 生产默认开启；测试夹具可用 false 跳过内容闸，只验证投影/去重。 */
  candidateFilter?: boolean
}

export interface ReflectGrowthResult {
  status: 'no_source' | 'deduplicated' | 'skipped_budget' | 'no_change' | 'proposed' | 'failed' | 'below_batch'
  reflectionId: string | null
  candidates: number
  reason?: string
  /** 仅 `below_batch` 时给出：这个会话最早何时够条件再跑。 */
  nextEligibleAt?: string
}

interface SourceRow {
  source_id: string
  channel: string
  room_id: string | null
  sender_contact_id: string | null
  independence_key: string | null
  activity_window_key: string | null
  session_ref: string | null
  created_at: string
}

interface PendingSource extends SourceRow {
  contact_key: string
}

interface RevisionRow {
  artifact_id: string
  revision: number
  statement: string
  subject_refs: string
  kind: string
}

interface ReflectionRow {
  reflection_id: string
  trigger_key: string
  status: GrowthReflectionStatus
  source_ids: string | null
  next_eligible_at: string | null
}

const DAY_MS = 86_400_000
const DEFAULT_TIMEOUT_MS = 120_000
const PERSONA = 'main'

/** scope 计算：与 fts.ts 的可见性口径一致（private→contact，group→room，其余→personal）。 */
function scopeOf(source: SourceRow): string | null {
  if (source.channel === 'private') {
    return source.sender_contact_id ? `contact:${source.sender_contact_id}` : null
  }
  if (source.channel === 'group') {
    return source.room_id ? `room:${source.room_id}` : null
  }
  return 'personal'
}

/** 配额与账本使用的联系人键；缺绑定返回 unbound，不猜身份。 */
export function contactKeyOf(source: SourceRow): string {
  if (source.channel === 'private') {
    return source.sender_contact_id ? `contact:${source.sender_contact_id}` : 'unbound'
  }
  if (source.channel === 'group') {
    return source.room_id ? `room:${source.room_id}` : 'unbound'
  }
  return 'personal'
}

/** 交集：personal 不约束；contact 与 room 不同即冲突；任一侧无法判定返回 null。 */
function intersectScope(left: string | null, right: string | null): string | null | undefined {
  if (left === null || right === null) return null
  if (left === right) return left
  if (left === 'personal') return right
  if (right === 'personal') return left
  return undefined
}

function mergeScopes(scopes: Array<string | null>): { scope: string | null; conflict: boolean; undecidable: boolean } {
  let scope: string | null = 'personal'
  for (const next of scopes) {
    if (next === null) return { scope: null, conflict: false, undecidable: true }
    const merged = intersectScope(scope, next)
    if (merged === undefined) return { scope: null, conflict: true, undecidable: false }
    scope = merged
  }
  return { scope, conflict: false, undecidable: false }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function triggerKeyOf(personaId: string, sourceIds: string[]): string {
  return sha256(`${personaId}\n${[...sourceIds].sort().join('\n')}`)
}

function independenceOf(source: SourceRow): string | null {
  if (source.independence_key) return source.independence_key
  if (source.activity_window_key) return source.activity_window_key
  // 没有可靠来源身份时不冒充独立：单独成一个等价类，但调用方不能据此增加计数。
  return `source:${source.source_id}`
}

function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
}

function parseSourceIds(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function recoverStaleReflections(db: Db, options: ReflectGrowthOptions = {}): number {
  const now = options.now ?? new Date()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cutoff = new Date(now.getTime() - timeoutMs).toISOString()
  const nowText = now.toISOString()
  const info = db
    .prepare(
      `UPDATE growth_reflections
          SET status='failed', error_reason='evaluation_timeout', finished_at=?, updated_at=?
        WHERE status='evaluating' AND started_at < ?`,
    )
    .run(nowText, nowText, cutoff)
  return Number(info.changes)
}

/** 迁移回填的 legacy 已处理 Source 数量；它们不参与配额，也不回放。 */
export function countLegacyProcessedSources(db: Db, personaId: string = PERSONA): number {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM growth_reflection_processed_sources
      WHERE persona_id=? AND reflection_id IS NULL`,
    [personaId],
  )
  return Number(row?.n ?? 0)
}

/**
 * 对「尚未处理」的 Source 跑一次规则反思。
 *
 * 全部读写在同一 BEGIN IMMEDIATE 事务内：选源、配额、任务领取、候选写入、processed 写入。
 */
export function reflectGrowthCandidates(db: Db, options: ReflectGrowthOptions = {}): ReflectGrowthResult {
  const personaId = options.personaId ?? PERSONA
  const now = options.now ?? new Date()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const perContactDaily = options.perContactDaily ?? 1
  const globalDaily = options.globalDaily ?? 3
  const nowText = now.toISOString()
  const dayStart = utcDayStart(now)

  recoverStaleReflections(db, { now, timeoutMs, personaId })

  return db.transaction((): ReflectGrowthResult => {
    const pending = db
      .all<SourceRow>(
        `SELECT s.source_id, s.channel, s.room_id, s.sender_contact_id,
                s.independence_key, s.activity_window_key, s.session_ref, s.created_at
           FROM sources s
          WHERE s.persona_id=? AND s.origin IN ('user','external')
            AND NOT EXISTS (
              SELECT 1 FROM growth_reflection_processed_sources p
               WHERE p.persona_id=? AND p.source_id=s.source_id
            )
          ORDER BY s.created_at ASC, s.rowid ASC`,
        [personaId, personaId],
      )
      .map((row) => ({ ...row, contact_key: contactKeyOf(row) }) as PendingSource)

    if (pending.length === 0) return { status: 'no_source', reflectionId: null, candidates: 0 }

    const bound = pending.filter((source) => source.contact_key !== 'unbound')
    if (bound.length === 0) {
      return { status: 'no_source', reflectionId: null, candidates: 0, reason: 'unbound_identity' }
    }

    // 已有未完成的另一个反思：避免同一轮重叠写，下一轮再处理。
    const inFlight = db.get<{ reflection_id: string }>(
      `SELECT reflection_id FROM growth_reflections
        WHERE persona_id=? AND status='evaluating' LIMIT 1`,
      [personaId],
    )
    if (inFlight) {
      return { status: 'deduplicated', reflectionId: inFlight.reflection_id, candidates: 0, reason: 'in_flight' }
    }

    const skipped = db.get<ReflectionRow>(
      `SELECT reflection_id, trigger_key, status, source_ids, next_eligible_at
         FROM growth_reflections
        WHERE persona_id=? AND status='skipped_budget'
          AND (next_eligible_at IS NULL OR next_eligible_at <= ?)
        ORDER BY created_at ASC LIMIT 1`,
      [personaId, nowText],
    )

    let effective: PendingSource[]
    let reflectionId: string
    let triggerKey: string
    let existing: ReflectionRow | null

    if (skipped) {
      // 只重试原始集合；预算窗口内新增的 Source 不并入旧任务。
      const original = new Set(parseSourceIds(skipped.source_ids))
      effective = bound.filter((source) => original.has(source.source_id))
      reflectionId = skipped.reflection_id
      triggerKey = skipped.trigger_key
      existing = skipped
      if (effective.length === 0) {
        db.prepare(
          `UPDATE growth_reflections
              SET status='no_change', finished_at=?, error_reason='sources_consumed', updated_at=?
            WHERE reflection_id=?`,
        ).run(nowText, nowText, reflectionId)
        return { status: 'no_change', reflectionId, candidates: 0, reason: 'sources_consumed' }
      }
    } else {
      // 新任务先分组：不同会话、不同联系人的消息不能凑成同一批，否则会把甲说的话
      // 提炼成关于乙的结论。分组键复用已有绑定字段，不引入新的批组引擎。
      const groups = new Map<string, PendingSource[]>()
      for (const source of bound) {
        const key = `${source.channel}|${source.contact_key}|${source.session_ref ?? ''}`
        const list = groups.get(key)
        if (list === undefined) groups.set(key, [source])
        else list.push(source)
      }
      const minBatch = options.minBatch ?? 3
      const maxWaitMs = (options.maxWaitHours ?? 24) * 3_600_000
      const nowMs = now.getTime()
      let chosen: PendingSource[] | null = null
      let chosenOldest = Number.POSITIVE_INFINITY
      // 先找已攒够门槛的组；都达标时取等待最久的那组。
      for (const list of groups.values()) {
        if (list.length < minBatch) continue
        const oldest = Date.parse(list[0]?.created_at ?? '')
        if (Number.isFinite(oldest) && oldest < chosenOldest) {
          chosen = list
          chosenOldest = oldest
        }
      }
      // 都不够：只有最老一条已经等够 maxWaitHours 才放行，避免冷会话被饿死。
      if (chosen === null) {
        for (const list of groups.values()) {
          const oldest = Date.parse(list[0]?.created_at ?? '')
          if (Number.isFinite(oldest) && nowMs - oldest >= maxWaitMs && oldest < chosenOldest) {
            chosen = list
            chosenOldest = oldest
          }
        }
      }
      if (chosen === null) {
        const oldestAll = bound.reduce((min, source) => {
          const at = Date.parse(source.created_at)
          return Number.isFinite(at) && at < min ? at : min
        }, Number.POSITIVE_INFINITY)
        return {
          status: 'below_batch',
          reflectionId: null,
          candidates: 0,
          reason: 'below_batch',
          ...(Number.isFinite(oldestAll)
            ? { nextEligibleAt: new Date(oldestAll + maxWaitMs).toISOString() }
            : {}),
        }
      }

      const globalUsed = Number(
        (
          db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM growth_reflections
              WHERE persona_id=? AND created_at >= ? AND status IN ('proposed','no_change')`,
            [personaId, dayStart],
          ) as { n: number }
        ).n,
      )
      if (globalUsed >= globalDaily) {
        const ids = chosen.map((source) => source.source_id)
        return insertSkipped(db, personaId, triggerKeyOf(personaId, ids), ids, now, dayStart, 'global_budget')
      }

      const keyUsed = new Map<string, number>()
      for (const source of chosen) {
        if (keyUsed.has(source.contact_key)) continue
        const used = Number(
          (
            db.get<{ n: number }>(
              `SELECT COUNT(DISTINCT reflection_id) AS n FROM growth_reflection_processed_sources
                WHERE persona_id=? AND contact_key=? AND processed_at >= ? AND reflection_id IS NOT NULL`,
              [personaId, source.contact_key, dayStart],
            ) as { n: number }
          ).n,
        )
        keyUsed.set(source.contact_key, used)
      }
      effective = chosen.filter((source) => (keyUsed.get(source.contact_key) ?? 0) < perContactDaily)
      if (effective.length === 0) {
        const ids = chosen.map((source) => source.source_id)
        return insertSkipped(db, personaId, triggerKeyOf(personaId, ids), ids, now, dayStart, 'daily_budget')
      }

      triggerKey = triggerKeyOf(
        personaId,
        effective.map((source) => source.source_id),
      )
      const found = db.get<ReflectionRow>(
        `SELECT reflection_id, trigger_key, status, source_ids, next_eligible_at
           FROM growth_reflections WHERE persona_id=? AND trigger_key=?`,
        [personaId, triggerKey],
      )
      if (found && (found.status === 'proposed' || found.status === 'no_change')) {
        const count = Number(
          (
            db.get<{ n: number }>('SELECT COUNT(*) AS n FROM growth_candidates WHERE reflection_id=?', [
              found.reflection_id,
            ]) as { n: number }
          ).n,
        )
        return { status: 'deduplicated', reflectionId: found.reflection_id, candidates: count }
      }
      if (found && found.status === 'evaluating') {
        return { status: 'deduplicated', reflectionId: found.reflection_id, candidates: 0, reason: 'in_flight' }
      }
      if (found && found.status === 'failed' && found.next_eligible_at && found.next_eligible_at > nowText) {
        return {
          status: 'skipped_budget',
          reflectionId: found.reflection_id,
          candidates: 0,
          reason: 'budget_window',
        }
      }
      existing = found ?? null
      reflectionId = found?.reflection_id ?? newId(PREFIX.reflection)
    }

    const originalIds = effective.map((source) => source.source_id)
    const snapshot = JSON.stringify([...originalIds].sort())
    let proposed = 0

    if (existing) {
      db.prepare(
        `UPDATE growth_reflections
            SET status='evaluating', attempt=attempt+1, source_count=?, started_at=?, finished_at=NULL,
                error_reason=NULL, next_eligible_at=NULL, source_ids=COALESCE(source_ids, ?), updated_at=?
          WHERE reflection_id=?`,
      ).run(effective.length, nowText, snapshot, nowText, reflectionId)
    } else {
      db.prepare(
        `INSERT INTO growth_reflections
          (reflection_id, persona_id, trigger_key, status, attempt, source_count, candidate_count,
           scope, source_ids, started_at, finished_at, error_reason, next_eligible_at, created_at, updated_at)
         VALUES (?,?,?,'evaluating',1,?,0,NULL,?,?,NULL,NULL,NULL,?,?)`,
      ).run(reflectionId, personaId, triggerKey, effective.length, snapshot, nowText, nowText, nowText)
    }

    const placeholders = effective.map(() => '?').join(',')
    const revisions = db.all<RevisionRow>(
      `SELECT r.artifact_id, r.revision, r.statement, r.subject_refs, a.kind
         FROM artifact_revisions r
         JOIN artifacts a ON a.artifact_id = r.artifact_id
        WHERE a.persona_id=? AND a.kind IN ('fact','stance')
          AND EXISTS (
            SELECT 1 FROM artifact_evidence e
             WHERE e.artifact_id=r.artifact_id AND e.revision=r.revision
               AND e.source_id IN (${placeholders})
          )
        ORDER BY r.created_at ASC, r.artifact_id ASC, r.revision ASC`,
      [personaId, ...originalIds],
    )

    let scopeConflict = false
    let undecidable = false
    let rejected = 0

    for (const revision of revisions) {
      const type: GrowthCandidateType | null =
        revision.kind === 'fact' ? 'new_fact' : revision.revision > 1 ? 'revise_stance' : null
      if (!type) continue

      // P2：只收有独立命题的 statement；碎片/纯话语/临时指令不进入候选账本。
      if (options.candidateFilter !== false && !isGrowthCandidateWorthy(revision.statement, type)) {
        rejected += 1
        continue
      }

      const evidenceSources = db.all<SourceRow>(
        `SELECT s.source_id, s.channel, s.room_id, s.sender_contact_id,
                s.independence_key, s.activity_window_key
           FROM artifact_evidence e
           JOIN sources s ON s.source_id = e.source_id
          WHERE e.artifact_id=? AND e.revision=?
            AND s.source_id IN (${placeholders})`,
        [revision.artifact_id, revision.revision, ...originalIds],
      )
      const merged = mergeScopes(evidenceSources.map(scopeOf))
      if (merged.conflict) {
        scopeConflict = true
        continue
      }
      if (merged.undecidable || merged.scope === null) {
        undecidable = true
        continue
      }

      const keys = new Set(evidenceSources.map(independenceOf).filter((key): key is string => Boolean(key)))
      const semanticKey = sha256(`${type}\n${revision.artifact_id}\n${merged.scope}`)
      const existingCandidate = db.get<{ candidate_id: string; independent_count: number }>(
        `SELECT candidate_id, independent_count FROM growth_candidates
          WHERE persona_id=? AND semantic_key=? AND status='proposed'
            AND NOT EXISTS (
              SELECT 1 FROM growth_confirmations c WHERE c.candidate_id = growth_candidates.candidate_id
            )`,
        [personaId, semanticKey],
      )

      if (existingCandidate) {
        for (const source of evidenceSources) {
          const independence = independenceOf(source)
          if (!independence) continue
          db.prepare(
            `INSERT OR IGNORE INTO growth_candidate_sources
              (candidate_id, source_id, independence_key, created_at) VALUES (?,?,?,?)`,
          ).run(existingCandidate.candidate_id, source.source_id, independence, nowText)
        }
        const total = Number(
          (
            db.get<{ n: number }>(
              `SELECT COUNT(DISTINCT independence_key) AS n FROM growth_candidate_sources WHERE candidate_id=?`,
              [existingCandidate.candidate_id],
            ) as { n: number }
          ).n,
        )
        db.prepare('UPDATE growth_candidates SET independent_count=?, updated_at=? WHERE candidate_id=?').run(
          total,
          nowText,
          existingCandidate.candidate_id,
        )
      } else {
        const candidateId = newId(PREFIX.candidate)
        db.prepare(
          `INSERT INTO growth_candidates
            (candidate_id, persona_id, reflection_id, semantic_key, type, subject_refs, predicate,
             statement, scope, status, independent_count, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,'proposed',?,?,?)`,
        ).run(
          candidateId,
          personaId,
          reflectionId,
          semanticKey,
          type,
          revision.subject_refs || '[]',
          revision.kind === 'fact' ? 'fact' : 'stance',
          revision.statement,
          merged.scope,
          keys.size,
          nowText,
          nowText,
        )
        for (const source of evidenceSources) {
          const independence = independenceOf(source)
          if (!independence) continue
          db.prepare(
            `INSERT OR IGNORE INTO growth_candidate_sources
              (candidate_id, source_id, independence_key, created_at) VALUES (?,?,?,?)`,
          ).run(candidateId, source.source_id, independence, nowText)
        }
      }
      proposed += 1
    }

    const status: GrowthReflectionStatus = proposed > 0 ? 'proposed' : 'no_change'
    const reasonText =
      proposed > 0
        ? null
        : scopeConflict
          ? 'scope_conflict'
          : undecidable
            ? 'scope_undecidable'
            : rejected > 0
              ? 'candidate_rejected'
              : 'no_candidate'
    db.prepare(
      `UPDATE growth_reflections
          SET status=?, candidate_count=?, scope=?, finished_at=?, error_reason=?, updated_at=?
        WHERE reflection_id=?`,
    ).run(status, proposed, null, nowText, reasonText, nowText, reflectionId)

    // 只有成功终态写 processed；failed/skipped 保持未处理，下一轮可重试。
    for (const source of effective) {
      db.prepare(
        `INSERT OR IGNORE INTO growth_reflection_processed_sources
          (persona_id, source_id, reflection_id, contact_key, processed_at) VALUES (?,?,?,?,?)`,
      ).run(personaId, source.source_id, reflectionId, source.contact_key, nowText)
    }

    return { status, reflectionId, candidates: proposed, reason: reasonText ?? undefined }
  }, { important: true })
}

function insertSkipped(
  db: Db,
  personaId: string,
  triggerKey: string,
  sourceIds: string[],
  now: Date,
  dayStart: string,
  reason: string,
): ReflectGrowthResult {
  const reflectionId = newId(PREFIX.reflection)
  const nowText = now.toISOString()
  const nextEligible = new Date(new Date(dayStart).getTime() + DAY_MS).toISOString()
  db.prepare(
    `INSERT INTO growth_reflections
      (reflection_id, persona_id, trigger_key, status, attempt, source_count, candidate_count,
       scope, source_ids, started_at, finished_at, error_reason, next_eligible_at, created_at, updated_at)
     VALUES (?,?,?,'skipped_budget',1,?,0,NULL,?,?,?,?,?,?,?)`,
  ).run(
    reflectionId,
    personaId,
    triggerKey,
    sourceIds.length,
    JSON.stringify([...sourceIds].sort()),
    nowText,
    nowText,
    reason,
    nextEligible,
    nowText,
    nowText,
  )
  return { status: 'skipped_budget', reflectionId, candidates: 0, reason }
}
