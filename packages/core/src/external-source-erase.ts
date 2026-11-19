/**
 * P5-R-3a 外部来源物理擦除（append-only 事件账本 + 受控维护）。
 *
 * 边界（P5-R-3 冻结设计）：
 * - 逻辑删除默认；物理擦除必须 Owner 显式请求，且 Source 已逻辑下线；
 * - 正文擦除只覆盖 sources.content；Source 身份、Evidence、审计事件全部保留；
 * - 绕过 sources append-only 触发器时必须在同一事务内 DROP → UPDATE → 重建，并校验 DDL 哈希；
 * - 任何一步失败都保持逻辑下线，写 erase_failed，绝不记录 erased；
 * - erased 只能由读回验证全部通过后写入，证明摘要只进事件账本。
 */
import { createHash } from 'node:crypto'
import type { Db } from './adapter.js'

export type EraseAction = 'erase_request' | 'erase_started' | 'erase_failed' | 'erased'
export type EraseStatus = 'not_logically_deleted' | 'logical_deleted' | 'erase_pending' | 'erase_failed' | 'erased'

export interface EraseEvent {
  eraseEventId: number
  sourceId: string
  action: EraseAction
  stage: string | null
  errorCode: string | null
  at: string
  by: string
  proofDigest: string | null
}

export interface EraseWriteOptions {
  sourceId: string
  by: string
  now?: Date
}

export interface EraseProof {
  sourceId: string
  contentSha256: string
  triggerDdlHash: string
  placeholder: string
  ftsSamples: number
  ftsHits: number
  ftsIntegrity: boolean
  at: string
}

const ERASED_PLACEHOLDER = '[erased]'
const OWNER_RE = /^os:[A-Za-z0-9_.:-]+$/

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString()
}

function assertOwner(by: string): void {
  if (!OWNER_RE.test(by)) throw new Error('E_OWNER_UNVERIFIED')
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function rowToEvent(row: Record<string, unknown>): EraseEvent {
  return {
    eraseEventId: Number(row.erase_event_id),
    sourceId: String(row.source_id),
    action: String(row.action) as EraseAction,
    stage: row.stage === null || row.stage === undefined ? null : String(row.stage),
    errorCode: row.error_code === null || row.error_code === undefined ? null : String(row.error_code),
    at: String(row.at),
    by: String(row.by),
    proofDigest: row.proof_digest === null || row.proof_digest === undefined ? null : String(row.proof_digest),
  }
}

export function latestEraseEvent(db: Db, sourceId: string): EraseEvent | null {
  const row = db.prepare(
    `SELECT erase_event_id, source_id, action, stage, error_code, at, by, proof_digest
       FROM external_source_erase_events
      WHERE source_id = ?
      ORDER BY erase_event_id DESC
      LIMIT 1`,
  ).get(sourceId) as Record<string, unknown> | undefined
  return row ? rowToEvent(row) : null
}

export function eraseStatusOf(db: Db, sourceId: string): EraseStatus {
  const deletion = db.prepare(
    `SELECT action FROM external_source_deletion_events
      WHERE source_id = ? ORDER BY event_id DESC LIMIT 1`,
  ).get(sourceId) as { action?: string } | undefined
  if (!deletion || (deletion.action !== 'delete' && deletion.action !== 'purge')) return 'not_logically_deleted'
  const latest = latestEraseEvent(db, sourceId)
  if (!latest) return 'logical_deleted'
  if (latest.action === 'erase_request' || latest.action === 'erase_started') return 'erase_pending'
  if (latest.action === 'erase_failed') return 'erase_failed'
  return 'erased'
}

function insertEvent(db: Db, event: Omit<EraseEvent, 'eraseEventId'>): EraseEvent {
  const result = db.prepare(
    `INSERT INTO external_source_erase_events
       (source_id, action, stage, error_code, at, by, proof_digest)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(event.sourceId, event.action, event.stage, event.errorCode, event.at, event.by, event.proofDigest)
  const id = Number(result.lastInsertRowid ?? 0)
  return { ...event, eraseEventId: id }
}

export function requestErase(db: Db, options: EraseWriteOptions): EraseEvent {
  assertOwner(options.by)
  const status = eraseStatusOf(db, options.sourceId)
  if (status === 'not_logically_deleted') throw new Error('E_ERASE_REQUIRES_LOGICAL_DELETE')
  if (status === 'erased') throw new Error('E_ALREADY_ERASED')
  if (status === 'erase_pending') return latestEraseEvent(db, options.sourceId)!
  // 首次 request 时固化原文哈希：中途失败重试时原文可能已是占位，不能再取到。
  const prior = db.prepare(
    `SELECT proof_digest FROM external_source_erase_events
      WHERE source_id = ? AND action = 'erase_request' AND proof_digest IS NOT NULL
      ORDER BY erase_event_id ASC LIMIT 1`,
  ).get(options.sourceId) as { proof_digest?: string } | undefined
  const proofDigest = /^[0-9a-f]{64}$/.test(prior?.proof_digest ?? '')
    ? prior!.proof_digest!
    : sha256(sourceContent(db, options.sourceId))
  return insertEvent(db, {
    sourceId: options.sourceId,
    action: 'erase_request',
    stage: 'requested',
    errorCode: null,
    at: nowIso(options.now),
    by: options.by,
    proofDigest,
  })
}

export function beginErase(db: Db, options: EraseWriteOptions): EraseEvent {
  assertOwner(options.by)
  const status = eraseStatusOf(db, options.sourceId)
  if (status !== 'erase_pending' && status !== 'erase_failed') throw new Error('E_ERASE_NOT_PENDING')
  return insertEvent(db, {
    sourceId: options.sourceId,
    action: 'erase_started',
    stage: 'started',
    errorCode: null,
    at: nowIso(options.now),
    by: options.by,
    proofDigest: null,
  })
}

export function failErase(
  db: Db,
  options: EraseWriteOptions & { stage: string; errorCode: string },
): EraseEvent {
  assertOwner(options.by)
  return insertEvent(db, {
    sourceId: options.sourceId,
    action: 'erase_failed',
    stage: options.stage,
    errorCode: options.errorCode,
    at: nowIso(options.now),
    by: options.by,
    proofDigest: null,
  })
}

export function completeErase(
  db: Db,
  options: EraseWriteOptions & { proofDigest: string },
): EraseEvent {
  assertOwner(options.by)
  if (eraseStatusOf(db, options.sourceId) !== 'erase_pending') throw new Error('E_ERASE_NOT_PENDING')
  return insertEvent(db, {
    sourceId: options.sourceId,
    action: 'erased',
    stage: 'verified',
    errorCode: null,
    at: nowIso(options.now),
    by: options.by,
    proofDigest: options.proofDigest,
  })
}

interface TriggerDdl {
  name: string
  sql: string
}

export function eraseTriggerDdl(db: Db): TriggerDdl[] {
  return (db.prepare(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = 'sources'
      ORDER BY name`,
  ).all() as Array<{ name: string; sql: string }>).map(row => ({ name: row.name, sql: row.sql }))
}

export function triggerDdlHash(ddl: TriggerDdl[]): string {
  return sha256(JSON.stringify(ddl.map(item => [item.name, item.sql])))
}

function sourceContent(db: Db, sourceId: string): string {
  const row = db.prepare('SELECT text FROM sources WHERE source_id = ?').get(sourceId) as { text?: string } | undefined
  if (!row || typeof row.text !== 'string') throw new Error('E_SOURCE_NOT_FOUND')
  return row.text
}

function ftsSamplesOf(text: string): string[] {
  const samples: string[] = []
  const compact = text.replace(/\s+/g, ' ').trim()
  const step = Math.max(1, Math.floor(compact.length / 8))
  for (let i = 0; i < compact.length && samples.length < 8; i += step) {
    const sample = compact.slice(i, i + 6)
    if (sample.length >= 2) samples.push(sample)
  }
  return [...new Set(samples)]
}

export function ftsIntegrityOk(db: Db): boolean {
  try {
    db.exec("INSERT INTO fts_index(fts_index) VALUES('integrity-check')")
    return true
  } catch {
    return false
  }
}

export function countFtsSamples(db: Db, text: string): { samples: number; hits: number } {
  const samples = ftsSamplesOf(text)
  let hits = 0
  for (const sample of samples) {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM fts_index
        WHERE raw_text LIKE '%' || ? || '%' OR bigram_text LIKE '%' || ? || '%'`,
    ).get(sample, sample) as { n: number }
    hits += Number(row.n)
  }
  return { samples: samples.length, hits }
}

export function eraseSourceContent(
  db: Db,
  options: EraseWriteOptions & { placeholder?: string },
): EraseProof {
  assertOwner(options.by)
  if (eraseStatusOf(db, options.sourceId) !== 'erase_pending') throw new Error('E_ERASE_NOT_PENDING')
  const before = sourceContent(db, options.sourceId)
  const placeholder = options.placeholder ?? ERASED_PLACEHOLDER
  const alreadyPlaceholder = before === placeholder
  let contentSha256: string
  if (alreadyPlaceholder) {
    // 中途失败重试：原文已不可用，沿用 request 时固化的哈希；缺哈希则失败关闭。
    const requested = db.prepare(
      `SELECT proof_digest FROM external_source_erase_events
        WHERE source_id = ? AND action = 'erase_request' AND proof_digest IS NOT NULL
        ORDER BY erase_event_id ASC LIMIT 1`,
    ).get(options.sourceId) as { proof_digest?: string } | undefined
    const stored = requested?.proof_digest ?? ''
    if (!/^[0-9a-f]{64}$/.test(stored)) throw new Error('E_ORIGINAL_HASH_MISSING')
    contentSha256 = stored
  } else {
    contentSha256 = sha256(before)
  }
  const ddl = eraseTriggerDdl(db)
  if (ddl.length === 0) throw new Error('E_TRIGGER_MISSING')
  const ddlHash = triggerDdlHash(ddl)

  db.transaction(() => {
    for (const trigger of ddl) db.exec(`DROP TRIGGER ${JSON.stringify(trigger.name)}`)
    db.prepare('UPDATE sources SET text = ? WHERE source_id = ?').run(placeholder, options.sourceId)
    for (const trigger of ddl) db.exec(trigger.sql)
    if (triggerDdlHash(eraseTriggerDdl(db)) !== ddlHash) throw new Error('E_TRIGGER_RESTORE_MISMATCH')
  }, { important: true })

  const back = sourceContent(db, options.sourceId)
  if (back !== placeholder) throw new Error('E_ERASE_READBACK_MISMATCH')
  const fts = alreadyPlaceholder ? { samples: 0, hits: 0 } : countFtsSamples(db, before)
  const integrity = ftsIntegrityOk(db)
  if (fts.hits > 0) throw new Error('E_FTS_RESIDUE')
  if (!integrity) throw new Error('E_FTS_INTEGRITY')

  return {
    sourceId: options.sourceId,
    contentSha256,
    triggerDdlHash: ddlHash,
    placeholder,
    ftsSamples: fts.samples,
    ftsHits: fts.hits,
    ftsIntegrity: integrity,
    at: nowIso(options.now),
  }
}

export function eraseProofDigest(proof: EraseProof): string {
  return sha256(JSON.stringify([
    proof.sourceId,
    proof.contentSha256,
    proof.triggerDdlHash,
    proof.placeholder,
    proof.ftsSamples,
    proof.ftsHits,
    proof.ftsIntegrity,
    proof.at,
  ]))
}
