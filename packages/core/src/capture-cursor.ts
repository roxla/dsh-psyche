// P2-CAP-1c3-B：Capture Cursor Store —— 历史补采的扫描租约与水位。
//
// 这一层只回答「谁在扫、扫到哪、还能不能写」，不读会话、不写 Source、不做过滤。
// 扫描器（1c3-C）每轮做三件事：认领 → 按 seq 补采 → 推进或释放；
// 三者全部经这里的 CAS，任何一步失败都返回 null，由调用方停止，不靠它自觉。
//
// 为什么 CAS 必须落在 SQL 的 WHERE 里，而不是「先 SELECT 再判断」：
// 两个 Worker 可以同时读到 cursor_version=3。若各自拿 3 去写，后写的会覆盖先写的进度，
// 而且两边都不会知道自己被覆盖了。BEGIN IMMEDIATE 让事务串行之后，后到的 UPDATE
// 看到的是 version=4，WHERE 不匹配 → changes=0 → 返回 null。进度只有一个赢家。
//
// 为什么 owner 是每次扫描的 UUID 而不是 PID：PID 会复用、也不跨机器唯一。
// 拿 PID 当锁归属，等于把「这条进度是谁写的」交给操作系统去猜。
//
// 为什么不在这里判断「该不该扫」：那是扫描器的策略（预算、Fork、headless），
// 存储层只负责让「同一个水位不会被两个人同时推进」这件事成立。

import type { Db, Row } from './adapter.js'
import { invalid } from './errors.js'

/** 默认租约：一分钟。短到进程被强杀后别人能较快接管，长到一次扫描不会自己过期。 */
export const DEFAULT_CURSOR_LEASE_MS = 60_000

/** 认领时调用方要说明的：谁在扫、扫到哪个水位、用哪版规则。 */
export interface ClaimCursorOptions {
  /** 本次扫描的唯一标识（UUID）。同一个 Worker 的续租/推进必须沿用同一个 owner。 */
  owner: string
  /** 本轮目标水位：调用方从「与扫描同一份快照」里读到的最大 seq。 */
  scanTargetSeq: number
  /** 本轮固定的过滤规则版本；不填沿用行里的值（默认 v1）。 */
  ruleVersion?: string
  /** 租约毫秒数；不填用默认一分钟。 */
  leaseMs?: number
}

/** 推进水位时要一起提交的东西：水位 + 翻页下标 + 忽略统计。三者必须同一次 CAS。 */
export interface AdvanceCursorOptions {
  /** 最近一个「处理完成」的实际事件 seq。允许重复提交同一个值（幂等），但不许倒退。 */
  lastScannedSeq: number
  /** 同一快照内的翻页下标；不填沿用当前值。 */
  scanIndex?: number
  /** 忽略统计 JSON（按 ruleVersion 分组）；不填沿用当前值。 */
  ignoredSummary?: string
  /** 本轮规则版本；不填沿用当前值。 */
  ruleVersion?: string
  /** 推进同时续租的毫秒数；不填用默认一分钟。 */
  leaseMs?: number
}

/** 一次成功认领/续租/推进后的凭据。拿去写库的只是它，不是「我记得我持有」这句话。 */
export interface CaptureCursorClaim {
  identity: Required<CaptureCursorIdentity>
  owner: string
  /** 本次写成功后拿到的版本号；下一次 CAS 必须带它。 */
  cursorVersion: number
  scanTargetSeq: number
  scanLeaseUntil: string
  ruleVersion: string
}

/** 游标身份。personaId 默认 main —— 与全库单一人格的约定一致。 */
export interface CaptureCursorIdentity {
  personaId?: string
  platform: string
  sessionRef: string
}

/** 库里读到的一行（已把 bigint 转成 number）。 */
export interface CaptureCursorRow {
  personaId: string
  platform: string
  sessionRef: string
  scanOwner: string | null
  scanLeaseUntil: string | null
  scanTargetSeq: number
  scanIndex: number
  lastScannedSeq: number
  inheritedEventCount: number
  recoveryState: 'idle' | 'scanning' | 'gap' | 'unsupported'
  ruleVersion: string
  ignoredSummary: string
  cursorVersion: number
  createdAt: string
  updatedAt: string
}

export interface CaptureCursorStoreOptions {
  db: Db
  /** 测试用固定时钟；不填走真实 UTC 时间。 */
  now?: () => string
  /** 默认租约毫秒数；claim/renew/advance 各自的 leaseMs 可以覆盖它。 */
  leaseMs?: number
}

/** 一行 SELECT 的列顺序，和 #toRow 一一对应；集中在这里避免 SQL 与映射漂移。 */
const ROW_COLUMNS = `persona_id, platform, session_ref, scan_owner, scan_lease_until,
  scan_target_seq, scan_index, last_scanned_seq, inherited_event_count,
  recovery_state, rule_version, ignored_summary, cursor_version, created_at, updated_at`

/**
 * 扫描游标的唯一写入口。所有方法都是同步的：它和调用方共用同一个 SQLite 连接，
 * 异步化只会把「事务里 await」这种错误变得容易写出来。
 */
export class CaptureCursorStore {
  readonly db: Db
  readonly logger?: { warn?(message: string): void }
  #now: () => string
  #leaseMs: number

  constructor({ db, now, leaseMs }: CaptureCursorStoreOptions) {
    if (!db) throw invalid('CaptureCursorStore 需要 db')
    this.db = db
    this.logger = db.logger
    this.#now = now ?? (() => new Date().toISOString())
    this.#leaseMs = positiveInt(leaseMs ?? DEFAULT_CURSOR_LEASE_MS, 'leaseMs')
  }

  /**
   * 确保这一行存在并返回它；已存在则原样返回（不重置水位）。
   * 幂等：重复调用不会把 last_scanned_seq 打回 -1 —— 那等于让历史重扫一遍。
   */
  initialize(identity: CaptureCursorIdentity): CaptureCursorRow {
    const key = normaliseIdentity(identity)
    return this.db.transaction(() => {
      this.#insertIfMissing(key)
      return this.#requireRow(key)
    })
  }

  /** 只读一行；不存在返回 null（不建行，查询不该有副作用）。 */
  read(identity: CaptureCursorIdentity): CaptureCursorRow | null {
    const key = normaliseIdentity(identity)
    const raw = this.db.get(
      `SELECT ${ROW_COLUMNS} FROM capture_cursors WHERE persona_id = ? AND platform = ? AND session_ref = ?`,
      [key.personaId, key.platform, key.sessionRef],
    ) as Row | undefined
    return raw === undefined ? null : toRow(raw)
  }

  /**
   * 认领：同一份快照的扫描权 + 目标水位。成功返回新 claim（cursor_version+1），
   * 失败返回 null（有人在扫且租约未过期，或版本刚刚被别人推进）。
   *
   * 行不存在时会在同一事务里补建：调用方不需要先 initialize 再 claim，
   * 那两步之间正好是「两个 Worker 同时创建」的窗口。
   */
  claim(identity: CaptureCursorIdentity, options: ClaimCursorOptions): CaptureCursorClaim | null {
    const key = normaliseIdentity(identity)
    const owner = requireText(options?.owner, 'owner', 80)
    const scanTargetSeq = requireSeq(options?.scanTargetSeq, 'scanTargetSeq')
    const leaseMs = positiveInt(options?.leaseMs ?? this.#leaseMs, 'leaseMs')
    const ruleVersion = optionalText(options?.ruleVersion, 'ruleVersion', 40) ?? 'v1'

    return this.db.transaction(() => {
      this.#insertIfMissing(key)
      const now = this.#now()
      const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString()
      const current = this.#requireRow(key)
      const nextVersion = current.cursorVersion + 1
      const changed = this.db.run(
        `UPDATE capture_cursors
            SET scan_owner = ?, scan_lease_until = ?, scan_target_seq = ?,
                recovery_state = 'scanning', rule_version = ?,
                cursor_version = cursor_version + 1, updated_at = ?
          WHERE persona_id = ? AND platform = ? AND session_ref = ?
            AND cursor_version = ?
            AND (scan_owner IS NULL OR scan_lease_until IS NULL OR scan_lease_until <= ?)`,
        [
          owner,
          leaseUntil,
          scanTargetSeq,
          ruleVersion,
          now,
          key.personaId,
          key.platform,
          key.sessionRef,
          current.cursorVersion,
          now,
        ],
      )
      if (changed.changes !== 1) return null
      return {
        identity: key,
        owner,
        cursorVersion: nextVersion,
        scanTargetSeq,
        scanLeaseUntil: leaseUntil,
        ruleVersion,
      }
    })
  }

  /**
   * 续租：把租约往后推，版本 +1。只在自己仍持有、租约未过期、版本未被别人推进时成功。
   * 失败返回 null —— 调用方必须停止推进（它已经不是当前持有者了）。
   */
  renew(claim: CaptureCursorClaim, leaseMs?: number): CaptureCursorClaim | null {
    const current = requireClaim(claim)
    const ms = positiveInt(leaseMs ?? this.#leaseMs, 'leaseMs')
    const now = this.#now()
    const leaseUntil = new Date(Date.parse(now) + ms).toISOString()
    const nextVersion = current.cursorVersion + 1
    const changed = this.db.run(
      `UPDATE capture_cursors
          SET scan_lease_until = ?, cursor_version = cursor_version + 1, updated_at = ?
        WHERE persona_id = ? AND platform = ? AND session_ref = ?
          AND scan_owner = ? AND cursor_version = ? AND scan_lease_until > ?`,
      [
        leaseUntil,
        now,
        current.identity.personaId,
        current.identity.platform,
        current.identity.sessionRef,
        current.owner,
        current.cursorVersion,
        now,
      ],
    )
    if (changed.changes !== 1) return null
    return { ...current, cursorVersion: nextVersion, scanLeaseUntil: leaseUntil }
  }

  /**
   * 推进水位：last_scanned_seq / scan_index / ignored_summary 一次提交，同时续租。
   * 这是「一批事件处理完了」的唯一记录点：先写 Source 再调它，顺序反了就会漏采。
   *
   * 水位允许重复（重试同一批），但不许倒退——倒退等于把已经处理过的事件当没处理，
   * 下一轮会重复扫。那是调用方 bug，直接抛 E_VALIDATION，不静默接受。
   */
  advance(claim: CaptureCursorClaim, options: AdvanceCursorOptions): CaptureCursorClaim | null {
    const current = requireClaim(claim)
    const lastScannedSeq = requireSeq(options?.lastScannedSeq, 'lastScannedSeq')
    const scanIndex = options?.scanIndex === undefined
      ? null
      : nonNegativeInt(options.scanIndex, 'scanIndex')
    const ignoredSummary = options?.ignoredSummary === undefined
      ? null
      : requireJsonObject(options.ignoredSummary, 'ignoredSummary')
    const ruleVersion = optionalText(options?.ruleVersion, 'ruleVersion', 40)
    const leaseMs = positiveInt(options?.leaseMs ?? this.#leaseMs, 'leaseMs')
    const now = this.#now()
    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString()

    return this.db.transaction(() => {
      const row = this.#requireRow(current.identity)
      if (row.scanOwner !== current.owner || row.cursorVersion !== current.cursorVersion) return null
      if (row.scanLeaseUntil === null || row.scanLeaseUntil <= now) return null
      if (lastScannedSeq < row.lastScannedSeq) {
        throw invalid('lastScannedSeq 不能倒退', {
          current: row.lastScannedSeq,
          next: lastScannedSeq,
        })
      }
      const nextVersion = row.cursorVersion + 1
      const changed = this.db.run(
        `UPDATE capture_cursors
            SET last_scanned_seq = ?, scan_index = ?, ignored_summary = ?,
                rule_version = ?, scan_lease_until = ?,
                cursor_version = cursor_version + 1, updated_at = ?
          WHERE persona_id = ? AND platform = ? AND session_ref = ?
            AND scan_owner = ? AND cursor_version = ? AND scan_lease_until > ?`,
        [
          lastScannedSeq,
          scanIndex ?? row.scanIndex,
          ignoredSummary ?? row.ignoredSummary,
          ruleVersion ?? row.ruleVersion,
          leaseUntil,
          now,
          current.identity.personaId,
          current.identity.platform,
          current.identity.sessionRef,
          current.owner,
          current.cursorVersion,
          now,
        ],
      )
      if (changed.changes !== 1) return null
      return {
        ...current,
        cursorVersion: nextVersion,
        scanLeaseUntil: leaseUntil,
        ruleVersion: ruleVersion ?? row.ruleVersion,
      }
    })
  }

  /**
   * 释放扫描权：清 owner/租约、回到 idle，版本 +1（让别人知道状态变了）。
   * 不校验租约是否过期——「把自己放下」永远该被允许，哪怕已经晚了几秒。
   * 已不是当前持有者时返回 false（旧 claim 不能用 release 抢回控制权）。
   */
  release(claim: CaptureCursorClaim): boolean {
    const current = requireClaim(claim)
    const now = this.#now()
    const changed = this.db.run(
      `UPDATE capture_cursors
          SET scan_owner = NULL, scan_lease_until = NULL, recovery_state = 'idle',
              cursor_version = cursor_version + 1, updated_at = ?
        WHERE persona_id = ? AND platform = ? AND session_ref = ?
          AND scan_owner = ? AND cursor_version = ?`,
      [
        now,
        current.identity.personaId,
        current.identity.platform,
        current.identity.sessionRef,
        current.owner,
        current.cursorVersion,
      ],
    )
    return changed.changes === 1
  }

  /** 补建行。INSERT OR IGNORE 是并发安全的：两个事务同时到这里，只有一个真正插入。 */
  #insertIfMissing(key: Required<CaptureCursorIdentity>): void {
    const now = this.#now()
    this.db.run(
      `INSERT OR IGNORE INTO capture_cursors
         (persona_id, platform, session_ref, scan_owner, scan_lease_until,
          scan_target_seq, scan_index, last_scanned_seq, recovery_state,
          rule_version, ignored_summary, cursor_version, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, -1, 0, -1, 'idle', 'v1', '{}', 0, ?, ?)`,
      [key.personaId, key.platform, key.sessionRef, now, now],
    )
  }

  #requireRow(key: Required<CaptureCursorIdentity>): CaptureCursorRow {
    const row = this.read(key)
    if (row === null) throw invalid('capture_cursors 行不存在', key)
    return row
  }
}

/** 建一个游标存储；入口函数形式，和 Core 里其他模块保持一致。 */
export function createCaptureCursorStore(options: CaptureCursorStoreOptions): CaptureCursorStore {
  return new CaptureCursorStore(options)
}

// ── 归一与校验 ────────────────────────────────────────────────

function normaliseIdentity(identity: CaptureCursorIdentity): Required<CaptureCursorIdentity> {
  return {
    personaId: optionalText(identity?.personaId, 'personaId', 40) ?? 'main',
    platform: requireText(identity?.platform, 'platform', 40),
    sessionRef: requireText(identity?.sessionRef, 'sessionRef', 200),
  }
}

function requireClaim(claim: CaptureCursorClaim): CaptureCursorClaim {
  if (!claim || typeof claim !== 'object') throw invalid('claim 不能为空')
  normaliseIdentity(claim.identity)
  requireText(claim.owner, 'owner', 80)
  nonNegativeInt(claim.cursorVersion, 'cursorVersion')
  return claim
}

function requireSeq(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -1) {
    throw invalid(`${field} 必须是 >= -1 的整数`)
  }
  return value
}

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalid(`${field} 必须是 >= 0 的整数`)
  }
  return value
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw invalid(`${field} 必须是正整数`)
  }
  return value
}

function requireText(value: unknown, field: string, max: number): string {
  const text = optionalText(value, field, max)
  if (text === null) throw invalid(`${field} 不能为空`)
  return text
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw invalid(`${field} 必须是字符串`)
  const text = value.trim()
  if (text.length === 0) return null
  if (text.length > max) throw invalid(`${field} 太长（最多 ${max} 字符）`)
  return text
}

function requireJsonObject(value: unknown, field: string): string {
  const text = requireText(value, field, 20_000)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw invalid(`${field} 必须是合法 JSON`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid(`${field} 必须是 JSON 对象`)
  }
  return text
}

function toRow(raw: Row): CaptureCursorRow {
  return {
    personaId: String(raw.persona_id),
    platform: String(raw.platform),
    sessionRef: String(raw.session_ref),
    scanOwner: raw.scan_owner === null ? null : String(raw.scan_owner),
    scanLeaseUntil: raw.scan_lease_until === null ? null : String(raw.scan_lease_until),
    scanTargetSeq: Number(raw.scan_target_seq),
    scanIndex: Number(raw.scan_index),
    lastScannedSeq: Number(raw.last_scanned_seq),
    inheritedEventCount: Number(raw.inherited_event_count),
    recoveryState: String(raw.recovery_state) as 'idle' | 'scanning' | 'gap' | 'unsupported',
    ruleVersion: String(raw.rule_version),
    ignoredSummary: String(raw.ignored_summary),
    cursorVersion: Number(raw.cursor_version),
    createdAt: String(raw.created_at),
    updatedAt: String(raw.updated_at),
  }
}
