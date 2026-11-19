// P2-Recall R4-B：召回回执（Recall Receipt）。
//
// 这一层只回答两件事：这次召回「问的是什么、谁被看见、谁被拒、为什么」。
// 它不生成候选、不排序、不改变注入——召回本身在 recall.ts / fts.ts 里已经完成，
// 回执只是把那次召回的结果落成可审计的行。
//
// 为什么不在回执里存 query 原文：回执是长期留存的审计数据，而查询目标往往是
// 「手机号」「住址」这类敏感词。存原文等于给敏感查询建第二份档案。这里统一存
// 本地密钥 HMAC：能比对「同一查询」，不能从哈希反推内容。
//
// 为什么 raw_rank 与 final_rank 分开：召回链里有两次排序——检索原始序（BM25）
// 和准入+稳定化后的最终序。只留一个 rank 就回答不了「这条高相关记忆为什么没进
// 上下文」——它可能是 raw_rank 很高、在 disclosure/scope 环节被拒的。
//
// 为什么密钥读取失败要抛错而不是退化成普通 SHA256：退化会让同一查询在两次
// 召回里得到不同哈希，回执之间的比对会静默失效。明确失败比悄悄降级安全。

import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Db, Row } from './adapter.js'
import { invalid } from './errors.js'

/** 密钥长度：32 字节（CSPRNG）。短于这个长度的文件视为损坏，不截断使用。 */
export const RECALL_HMAC_KEY_BYTES = 32

/** 密钥文件相对 dataDir 的路径；权限 0600（Windows 上由 ACL 决定，mode 只是尽力而为）。 */
export const RECALL_HMAC_KEY_PATH = join('secret', 'recall-hmac.key')

/** 两个 HMAC 域前缀：同一密钥、不同用途，哈希不能互相冒充。 */
export const QUERY_HASH_DOMAIN = 'recall-query:v1:'
export const SCOPE_HASH_DOMAIN = 'recall-scope:v1:'

/** 回执保留天数；清理时 run 与 candidates 必须一起删（级联）。 */
export const RECALL_RETENTION_DAYS = 30

/** 一次召回的查询形态：主动 Recall 是 recall，自动注入是 pre-step，诊断类是 diagnostics。 */
export type RecallQueryMode = 'recall' | 'pre-step' | 'diagnostics'

/** 允许域类型：与 FtsScope.surface 对齐，另加 global（没有身份、只允许全局记忆）。 */
export type RecallScopeType = 'personal' | 'private' | 'group' | 'global'

/** Composer 对账四态；pending 时 selected/composed/truncated 都还没有结论。 */
export type RecallCompositionStatus = 'pending' | 'completed' | 'not_applicable' | 'interrupted'

/** 读出来的密钥与它对应的版本号。版本号固定落在每条 run 上，便于将来轮换比对。 */
export interface RecallKey {
  key: Buffer
  keyVersion: number
}

/** 一条候选的落库形态；reject_reason 只记原因码，不记命中的原句。 */
export interface RecallCandidateRecord {
  artifactId: string
  revision: number
  rawRank: number | null
  eligible: boolean
  rejectReason: string | null
  finalRank: number | null
  selected?: boolean
  composed?: boolean
  truncated?: boolean
}

/** 开一次 run 需要的字段；所有计数由调用方从同一次召回结果里传进来。 */
export interface RecallRunInput {
  runId: string
  requestId: string | null
  personaId: string
  queryHash: string | null
  queryMode: RecallQueryMode
  scopeType: RecallScopeType
  scopeHash: string | null
  requestedLimit: number
  matchedCount: number
  eligibleCount: number
  returnedCount: number
  abstained: boolean
  compositionStatus: RecallCompositionStatus
  keyVersion: number
  createdAt: string
  /** C2：回执所属会话（canonical session_ref）；旧记录/无会话时为 null。 */
  sessionRef?: string | null
  /** C2：回执所属轮次；旧记录/无法确定时为 null。 */
  turn?: number | null
}

/** 库里读到的一行 run（保留字段名与表一致，便于审计时直接对照）。 */
export interface RecallRunRow {
  runId: string
  requestId: string | null
  personaId: string
  queryHash: string | null
  queryMode: string
  scopeType: string
  scopeHash: string | null
  requestedLimit: number
  matchedCount: number
  eligibleCount: number
  returnedCount: number
  abstained: boolean
  compositionStatus: string
  keyVersion: number
  createdAt: string
  sessionRef: string | null
  turn: number | null
}

/** 规范化查询文本：NFKC + 折叠空白 + trim。哈希只认这个形态，避免空格差异造出两个哈希。 */
export function normalizeQueryText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

/** 查询哈希：HMAC-SHA256，十六进制。前缀写死在常量里，域分离靠它。 */
export function hashQueryText(key: Buffer, text: string): string {
  return createHmac('sha256', key)
    .update(QUERY_HASH_DOMAIN + normalizeQueryText(text), 'utf8')
    .digest('hex')
}

/** Scope 哈希：只把允许域与身份标识放进规范化 JSON，字段顺序固定。 */
export function hashRecallScope(
  key: Buffer,
  scope: { scopeType: RecallScopeType; contactId?: string | null; roomId?: string | null },
): string {
  const canonical = JSON.stringify({
    scopeType: scope.scopeType,
    contactId: scope.contactId ?? null,
    roomId: scope.roomId ?? null,
  })
  return createHmac('sha256', key).update(SCOPE_HASH_DOMAIN + canonical, 'utf8').digest('hex')
}

/**
 * 读取或创建本地 HMAC 密钥。
 *
 * 创建用 `flag:'wx'`：并发启动的两个进程只有一个能写成功，另一个读到它写的密钥；
 * 不会出现「后启动的把前一个的密钥覆盖掉、已有回执全部对不上」。
 * 读取失败（ENOENT 除外）与长度不对都抛错——回执宁可没有，也不要一半哈希正确一半错。
 */
export function loadOrCreateRecallKey(dataDir: string): RecallKey {
  const path = join(dataDir, RECALL_HMAC_KEY_PATH)
  const read = (): Buffer | null => {
    try {
      return readFileSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw invalid(`回执密钥读取失败：${(error as Error).message}`)
    }
  }

  let bytes = read()
  if (bytes === null) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const fresh = randomBytes(RECALL_HMAC_KEY_BYTES)
    try {
      writeFileSync(path, fresh, { flag: 'wx', mode: 0o600 })
      bytes = fresh
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw invalid(`回执密钥创建失败：${(error as Error).message}`)
      }
      bytes = read()
    }
  }

  if (bytes === null || bytes.length !== RECALL_HMAC_KEY_BYTES) {
    throw invalid('回执密钥损坏：长度不是 32 字节（不截断、不退化，请人工确认后再删）')
  }

  // 版本号从 `<key>.version` 读，缺省 1；轮换尚未实现，但每条回执都记录版本，
  // 将来换密钥时旧回执仍能指出「这是哪一版算出来的哈希」。
  let keyVersion = 1
  try {
    const raw = readFileSync(`${path}.version`, 'utf8').trim()
    const parsed = Number.parseInt(raw, 10)
    if (Number.isInteger(parsed) && parsed > 0) keyVersion = parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw invalid(`回执密钥版本读取失败：${(error as Error).message}`)
    }
  }

  return { key: bytes, keyVersion }
}

/** 开一条 run。计数由调用方传入，这里不重新数——回执不能和召回结果各自计算。 */
export function createRecallRun(db: Db, input: RecallRunInput): void {
  db.run(
    `INSERT INTO recall_runs (
       run_id, request_id, persona_id, query_hash, query_mode, scope_type, scope_hash,
       requested_limit, matched_count, eligible_count, returned_count, abstained,
       composition_status, key_version, created_at, session_ref, turn
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.runId,
      input.requestId,
      input.personaId,
      input.queryHash,
      input.queryMode,
      input.scopeType,
      input.scopeHash,
      input.requestedLimit,
      input.matchedCount,
      input.eligibleCount,
      input.returnedCount,
      input.abstained ? 1 : 0,
      input.compositionStatus,
      input.keyVersion,
      input.createdAt,
      input.sessionRef ?? null,
      input.turn ?? null,
    ],
  )
}

/** 批量写候选行：同一次召回只开一个事务，任何一行失败整批回滚。 */
export function recordRecallCandidates(
  db: Db,
  runId: string,
  candidates: readonly RecallCandidateRecord[],
): void {
  if (candidates.length === 0) return
  db.transaction(() => {
    for (const candidate of candidates) {
      db.run(
        `INSERT INTO recall_candidates (
           run_id, artifact_id, revision, raw_rank, eligible, reject_reason,
           final_rank, selected, composed, truncated
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          runId,
          candidate.artifactId,
          candidate.revision,
          candidate.rawRank,
          candidate.eligible ? 1 : 0,
          candidate.rejectReason,
          candidate.finalRank,
          candidate.selected ? 1 : 0,
          candidate.composed ? 1 : 0,
          candidate.truncated ? 1 : 0,
        ],
      )
    }
  })
}

/** 收尾：只改 run 的计数与状态，不动候选行（候选的 composed/truncated 由 R4-C 回填）。 */
export function finalizeRecallRun(
  db: Db,
  runId: string,
  input: {
    matchedCount: number
    eligibleCount: number
    returnedCount: number
    abstained: boolean
    compositionStatus: RecallCompositionStatus
  },
): void {
  db.run(
    `UPDATE recall_runs
        SET matched_count = ?, eligible_count = ?, returned_count = ?, abstained = ?, composition_status = ?
      WHERE run_id = ?`,
    [
      input.matchedCount,
      input.eligibleCount,
      input.returnedCount,
      input.abstained ? 1 : 0,
      input.compositionStatus,
      runId,
    ],
  )
}

/** 读最近 N 条 run（诊断用；不注册成模型工具，不进普通面板）。 */
export function listRecallRuns(db: Db, limit = 20): RecallRunRow[] {
  const rows = db.all(
    `SELECT run_id, request_id, persona_id, query_hash, query_mode, scope_type, scope_hash,
            requested_limit, matched_count, eligible_count, returned_count, abstained,
            composition_status, key_version, created_at, session_ref, turn
       FROM recall_runs
      ORDER BY created_at DESC, run_id DESC
      LIMIT ?`,
    [limit],
  )
  return rows.map((row) => ({
    runId: String(row.run_id),
    requestId: row.request_id === null ? null : String(row.request_id),
    personaId: String(row.persona_id),
    queryHash: row.query_hash === null ? null : String(row.query_hash),
    queryMode: String(row.query_mode),
    scopeType: String(row.scope_type),
    scopeHash: row.scope_hash === null ? null : String(row.scope_hash),
    requestedLimit: Number(row.requested_limit),
    matchedCount: Number(row.matched_count),
    eligibleCount: Number(row.eligible_count),
    returnedCount: Number(row.returned_count),
    abstained: Number(row.abstained) === 1,
    compositionStatus: String(row.composition_status),
    keyVersion: Number(row.key_version),
    createdAt: String(row.created_at),
    sessionRef: row.session_ref === null ? null : String(row.session_ref),
    turn: row.turn === null ? null : Number(row.turn),
  }))
}

/**
 * C2：按「会话 + 轮次」找回本轮已有的 pre-step 回执。
 *
 * 为什么需要它：同一轮可能被 PreStep 触发多次（重试、工具续轮后退回）。
 * 如果每次都新开一条 run，同一轮就会有多条回执，UI 无法判断哪条是真的。
 * 这里先查再决定复用，插入侧还有部分唯一索引兜底（并发情况下第二次插入
 * 会撞索引，调用方捕获后重查）。
 */
export function findPreStepRun(
  db: Db,
  sessionRef: string,
  turn: number,
): { runId: string; returnedCount: number; abstained: boolean; compositionStatus: string } | null {
  const row = db.get(
    `SELECT run_id, returned_count, abstained, composition_status
       FROM recall_runs
      WHERE session_ref = ? AND turn = ? AND query_mode = 'pre-step'
      LIMIT 1`,
    [sessionRef, turn],
  )
  if (row === undefined) return null
  return {
    runId: String(row.run_id),
    returnedCount: Number(row.returned_count),
    abstained: Number(row.abstained) === 1,
    compositionStatus: String(row.composition_status),
  }
}

/** 读某次 run 的候选行（诊断用；同样不注册工具）。 */
export function listRecallCandidates(db: Db, runId: string): RecallCandidateRecord[] {
  const rows = db.all(
    `SELECT artifact_id, revision, raw_rank, eligible, reject_reason, final_rank, selected, composed, truncated
       FROM recall_candidates
      WHERE run_id = ?
      ORDER BY COALESCE(final_rank, 999999), COALESCE(raw_rank, 999999), artifact_id`,
    [runId],
  )
  return rows.map((row: Row) => ({
    artifactId: String(row.artifact_id),
    revision: Number(row.revision),
    rawRank: row.raw_rank === null ? null : Number(row.raw_rank),
    eligible: Number(row.eligible) === 1,
    rejectReason: row.reject_reason === null ? null : String(row.reject_reason),
    finalRank: row.final_rank === null ? null : Number(row.final_rank),
    selected: Number(row.selected) === 1,
    composed: Number(row.composed) === 1,
    truncated: Number(row.truncated) === 1,
  }))
}

/**
 * 清理过期回执：按 created_at 截止线删除 run，candidates 走外键级联。
 * 返回删掉的 run 数；清理失败由调用方决定重试，这里不吞异常。
 */
export function cleanupRecallRuns(
  db: Db,
  options: { now?: Date; retentionDays?: number } = {},
): number {
  const now = options.now ?? new Date()
  const retentionDays = options.retentionDays ?? RECALL_RETENTION_DAYS
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const before = db.get('SELECT COUNT(*) AS n FROM recall_runs WHERE created_at < ?', [cutoff])
  const removed = Number(before?.n ?? 0)
  db.run('DELETE FROM recall_runs WHERE created_at < ?', [cutoff])
  return removed
}

/** R4-C：Composer 决策后的一次性回填行。只写结构化决策，不写记忆正文。 */
export interface RecallCompositionRow {
  artifactId: string
  revision: number
  finalRank: number | null
  selected: boolean
  composed: boolean
  truncated: boolean
  rejectReason: string | null
}

/** R4-C：回填时可选更新的 run 计数（pending 阶段只知道候选数，完成时才知道选出几条）。 */
export interface RecallCompositionCounts {
  matchedCount?: number
  eligibleCount?: number
  returnedCount?: number
  abstained?: boolean
}

/**
 * R4-C：把 Composer 的最终决策一次性写回候选行与 run 状态。
 *
 * 为什么批量而不是逐条 UPDATE：一次 Composer 决策是一个整体，半截回执比没有回执更糟——
 * 读的人会以为「这条被拒了」，其实只是进程在回填途中退出。整段放一个事务里，
 * 失败就一起回滚，pending 保持原样，下次启动标 interrupted。
 */
export function backfillRecallComposition(
  db: Db,
  runId: string,
  rows: ReadonlyArray<RecallCompositionRow>,
  compositionStatus: RecallCompositionStatus = 'completed',
  counts: RecallCompositionCounts = {},
): void {
  db.transaction(() => {
    for (const row of rows) {
      db.run(
        `UPDATE recall_candidates
            SET final_rank = ?, selected = ?, composed = ?, truncated = ?, reject_reason = ?
          WHERE run_id = ? AND artifact_id = ? AND revision = ?`,
        [
          row.finalRank,
          row.selected ? 1 : 0,
          row.composed ? 1 : 0,
          row.truncated ? 1 : 0,
          row.rejectReason,
          runId,
          row.artifactId,
          row.revision,
        ],
      )
    }
    // COALESCE(?, 原值)：没传的计数保持 pending 阶段写下的值，避免回填把已知信息清零。
    db.run(
      `UPDATE recall_runs
          SET composition_status = ?,
              matched_count = COALESCE(?, matched_count),
              eligible_count = COALESCE(?, eligible_count),
              returned_count = COALESCE(?, returned_count),
              abstained = COALESCE(?, abstained)
        WHERE run_id = ?`,
      [
        compositionStatus,
        counts.matchedCount ?? null,
        counts.eligibleCount ?? null,
        counts.returnedCount ?? null,
        counts.abstained === undefined ? null : counts.abstained ? 1 : 0,
        runId,
      ],
    )
  })
}

/**
 * R4-C：启动时把上次进程留下的 pending 标成 interrupted。
 *
 * 只动 pending：completed / not_applicable 是已经定论的状态，不能因为「重启了」被回退。
 * 返回被标记的条数；调用方只记日志，不因清理失败阻断启动。
 */
export function markInterruptedRecallRuns(db: Db, options: { before?: string } = {}): number {
  const before = options.before ?? new Date().toISOString()
  const result = db.run(
    `UPDATE recall_runs
        SET composition_status = 'interrupted'
      WHERE composition_status = 'pending' AND created_at < ?`,
    [before],
  )
  return Number(result.changes ?? 0)
}
