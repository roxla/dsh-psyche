// 恢复状态机（§34.14 两阶段架构：在线准备 Prepare / 离线应用 Apply）。
//
// 职责：把「导入一次人格」拆成两个语义不同的阶段，并让它们在崩溃时也能续做。
//   1) prepareRestorePackage：只看包，解到数据根**同级**暂存目录，判定当前数据是空/已用/不可判，
//      写一份状态文件（phase=prepared）。**这一步一个字节都不碰数据根。**
//   2) confirmRestore：非空要手打包 ID；确认后先冻结写入、排空在途事务、导出一份
//      「替换前最后状态」的预恢复包（放数据根**之外**），校验通过才把 phase 推到 pending。
//   3) applyPendingRestore：只在下一次插件启动、`openDatabase()` **之前**（或 CLI 在 DSH 退出后）
//      调用；按现场判定推进 phase，两次 rename 之间崩溃也能续做。
//
// 关键不变量：
//   - 状态文件与预恢复包都不在数据根里——数据根会被改名，放里面会在换名后丢路径含义。
//   - 任何一步失败都不删「最后一份可用数据」；现场不明确时只报 E_RESTORE_RECOVERY_REQUIRED。
//   - 面板与 CLI 共用本文件里的同一套函数，不许各写一份 rename/回滚。
// 被谁调用：index.ts（启动门禁 + 三条路由）、tools/psyche-archive.mjs（CLI）。

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { createArchive, prepareRestore, sha256Of, verifyArchive } from './archive.js'
import type { ArchiveManifest, ArchiveProblem } from './archive.js'
import type { Row, SqlParams } from './adapter.js'
import { CODE, PsycheError } from './errors.js'
import { checkDatabaseFile } from './dbcheck.js'

/** 判定 `empty` 时要逐张检查的「用户数据表」。schema 元数据与纯引擎表不在此列。 */
export const USER_DATA_TABLES = [
  'contacts',
  'contact_identifiers',
  'rooms',
  'room_members',
  'sources',
  'events',
  'event_sources',
  'event_relations',
  'artifacts',
  'artifact_revisions',
  'artifact_evidence',
  'artifact_trigger_events',
  'artifact_lineage',
  'artifact_relations',
  'relationship_signals',
  'relationship_affinity_state',
  'phase_milestones',
  'phase_evidence',
  'global_mood_history',
  'contact_affect_history',
  'proposals',
  'pending_writes',
  'personality_history',
  'source_assets',
  'learning_jobs',
] as const

/** 状态文件固定名，放在数据根的**父目录**。 */
export const RESTORE_STATE_FILE = '.psyche-restore-state.json'
/** 预恢复包的固定目录名（同样在数据根之外）。 */
export const PRE_RESTORE_DIR = 'psyche-prerestore'

/** 当前数据的三态判定结果。 */
export type TargetMemoryState = 'empty' | 'used' | 'unknown'

/** `inspectTargetMemory` 的详细结果：既能判三态，也能给人看「会覆盖什么」。 */
export interface TargetMemoryInspection {
  state: TargetMemoryState
  dataDir: string
  /** 库文件在不在。 */
  dbPresent: boolean
  /** 读不出来时为 null（例如库损坏/被外部进程锁住）。 */
  userVersion: number | null
  /** 每张用户表的行数；读不出库时为空对象。 */
  tableCounts: Record<string, number>
  totalRows: number
  files: {
    identity: boolean
    persona: boolean
    config: boolean
    prefs: boolean
    /** 面板偏好是否非默认（非默认也算「有内容」，不能无声覆盖）。 */
    prefsCustom: boolean
    assets: number
    narrative: number
  }
  /** 判定依据（给人看的短句）。 */
  reasons: string[]
}

/** 恢复日志（`RestoreJournal`）：跨进程、跨崩溃的唯一事实。 */
export interface RestoreJournal {
  restoreId: string
  /** = 迁移包文件名（不含扩展名），同时是 Used 状态下要手打的确认词。 */
  packageId: string
  packageSha256: string
  /** 包里库的 schema 版本：安装后校验要拿它比 `PRAGMA user_version`。 */
  packageSchemaVersion: number
  targetPath: string
  stagingPath: string
  oldPath: string
  failedPath: string | null
  preRestoreArchive: string
  preRestoreSha256: string
  previousRootFingerprint: string
  mode: 'adopt' | 'overwrite'
  requestedByPid: number
  requestedAt: string
  phase: RestorePhase
}

/** 恢复阶段。`prepared` 还没确认；`pending` 才允许启动时动手。 */
export type RestorePhase =
  | 'prepared'
  | 'pending'
  | 'old_moved'
  | 'new_installed'
  | 'validated'
  | 'completed'
  | 'recovery_required'

/** 准备阶段的对外视图（面板渲染用）。 */
export interface RestorePlanView {
  ok: boolean
  restoreId: string
  packageId: string
  packageSha256: string
  mode: 'adopt' | 'overwrite'
  /** Used 时等于 `packageId`；Adopt 时为 null（不用打确认词）。 */
  requiredConfirmation: string | null
  stagedDir: string
  targetState: TargetMemoryState
  willReplace: TargetMemoryInspection
  phase: RestorePhase
  problems: ArchiveProblem[]
  notes: string[]
}

/** 恢复状态查询结果。 */
export interface RestoreStatus {
  ok: boolean
  pending: boolean
  journal: RestoreJournal | null
  target: TargetMemoryInspection | null
  note: string
}

/** 应用恢复的结果。`applied=false` 表示这次没有动手，原因在 `reason`。 */
export interface RestoreApplyOutcome {
  ok: boolean
  applied: boolean
  reason:
    | 'no-pending'
    | 'not-confirmed'
    | 'completed'
    | 'restored-old'
    | 'recovery-required'
  phase: RestorePhase | null
  dataDir: string
  keptDir: string | null
  files: number
  note: string
}

/** 本模块需要的最小数据库能力（`Db` 满足；测试也容易造假）。 */
export interface RestoreDb {
  all: <T = Row>(sql: string, params?: SqlParams) => T[]
  exec: (sql: string) => unknown
  /** 可选：adapter 的 `pragma()` 直接返回第一列标量，读 `user_version` 更省事。 */
  pragma?: (statement: string) => unknown
}

// ── 状态文件的读写 ────────────────────────────────────────────

/** 状态文件路径：`<数据根父目录>/.psyche-restore-state.json`。 */
export function restoreJournalPath(dataDir: string): string {
  return join(dirname(resolve(dataDir)), RESTORE_STATE_FILE)
}

/** 预恢复包目录：`<数据根父目录>/psyche-prerestore`。 */
export function preRestoreDir(dataDir: string): string {
  return join(dirname(resolve(dataDir)), PRE_RESTORE_DIR)
}

/** 读状态文件；不存在或内容坏掉都返回 null（坏掉时不要猜，交给人在日志里看）。 */
export function readRestoreJournal(dataDir: string): RestoreJournal | null {
  const file = restoreJournalPath(dataDir)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as RestoreJournal
    if (!parsed || typeof parsed.restoreId !== 'string' || typeof parsed.phase !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/** 原子写状态文件：先写 `.tmp` 再改名，避免断电留下半截 JSON。 */
export function writeRestoreJournal(dataDir: string, journal: RestoreJournal): void {
  const file = restoreJournalPath(dataDir)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(journal, null, 2), 'utf8')
  renameSync(temp, file)
}

/** 清掉状态文件（只在恢复完成或明确取消后调用）。 */
export function clearRestoreJournal(dataDir: string): void {
  rmSync(restoreJournalPath(dataDir), { force: true })
}

// ── 目录指纹 ─────────────────────────────────────────────────

/**
 * 数据根指纹：用户文件（名字 + 大小 + mtime）+ 库的行数指纹。
 *
 * 用途：准备恢复之后、真正替换之前再比一次，防止「确认完又被别的程序改过」。
 * 传给 `db` 就用调用方的连接数行数；不传（启动门禁/CLI）会只读打开库自己数。
 */
export function rootFingerprint(dataDir: string, options: { db?: RestoreDb } = {}): string {
  const root = resolve(dataDir)
  const lines: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (!existsSync(dir)) return
    let names: string[]
    try {
      names = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const name of names) {
      // 跳过三类「本来就会变」的东西，否则指纹永远对不上：
      //   1) SQLite 瞬时文件（-wal/-shm/-journal）：读写、关连接都会改；
      //   2) 数据库本体：关连接时 WAL checkpoint 会合法地改写它；
      //   3) 备份/导出/只读投影目录：运维动作会往里写，但它们不是人格数据。
      // 数据库是否被换过由「行数指纹」看（见下面 dbFingerprintOf），比 mtime 靠谱。
      if (name.endsWith('-wal') || name.endsWith('-shm') || name.endsWith('-journal')) continue
      if (name === 'memory.sqlite3') continue
      if (depth === 0 && FINGERPRINT_SKIP_DIRS.has(name)) continue
      const full = join(dir, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (depth <= 1) walk(full, depth + 1)
        continue
      }
      const rel = (full.startsWith(root + sep) ? full.slice(root.length + 1) : name).split(sep).join('/')
      lines.push(`${rel}|${stat.size}|${Math.round(stat.mtimeMs)}`)
    }
  }
  walk(root, 0)
  lines.push(dbFingerprintOf(root, options.db))
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')
}

/** 指纹不看的目录：备份/导出/只读投影都是派生品，变化不代表人格被改。 */
const FINGERPRINT_SKIP_DIRS = new Set(['exports', 'backups', 'memory-view'])

/**
 * 库指纹：`user_version` + 25 张用户表的行数。
 *
 * 为什么不用 mtime/文件哈希：WAL checkpoint 会在正常关闭时改写主库文件，
 * 用它们做指纹会把「刚确认完就重启」误判成「目标被改过」。
 * 行数变化只能来自真实写入——这正是我们想发现的东西。
 */
function dbFingerprintOf(dataDir: string, db?: RestoreDb): string {
  const file = join(dataDir, 'memory.sqlite3')
  if (!existsSync(file)) return 'db:none'
  try {
    if (db) {
      const version = readUserVersionWith(db) ?? '?'
      const counts = USER_DATA_TABLES.map((table) => {
        try {
          const row = db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]
          return `${table}=${Number(row?.n ?? 0)}`
        } catch {
          return `${table}=?`
        }
      })
      return `db:${version}|${counts.join(',')}`
    }
    const local = new DatabaseSync(file, { readOnly: true })
    try {
      const versionRow = local.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
      const version = versionRow ? Number(Object.values(versionRow)[0]) : '?'
      const counts = USER_DATA_TABLES.map((table) => {
        try {
          const row = local.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Record<string, unknown> | undefined
          return `${table}=${row ? Number(Object.values(row)[0]) : 0}`
        } catch {
          return `${table}=?`
        }
      })
      return `db:${version}|${counts.join(',')}`
    } finally {
      local.close()
    }
  } catch {
    return 'db:unreadable'
  }
}


// ── 三态判定 ─────────────────────────────────────────────────

/** 数一个目录里的文件数（目录本身不算）。 */
function countFilesIn(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    try {
      const stat = statSync(full)
      if (stat.isDirectory()) total += countFilesIn(full)
      else total += 1
    } catch {
      // 单个 stat 失败不影响判定
    }
  }
  return total
}

/** 面板偏好的默认内容：只有等于它才算「没有自定义」。 */
const DEFAULT_PREFS_JSON = '{\n  "sea": false,\n  "promptSection": null\n}'

/** 看一眼目标数据根：`empty` / `used` / `unknown`（§34.14）。 */
export function inspectTargetMemory(options: {
  dataDir: string
  /** 插件自己的连接（面板调用时一定在）；CLI 离线时不给，会只读打开库自己数。 */
  db?: RestoreDb
  now?: Date
}): TargetMemoryInspection {
  const dataDir = resolve(options.dataDir)
  const reasons: string[] = []
  const dbFile = join(dataDir, 'memory.sqlite3')
  const dbPresent = existsSync(dbFile)

  let identity = false
  let persona = false
  let config = false
  let prefs = false
  let prefsCustom = false
  const flags = (name: string): boolean => {
    const full = join(dataDir, name)
    if (!existsSync(full)) return false
    try {
      return statSync(full).size > 0
    } catch {
      return false
    }
  }
  identity = flags('identity.md')
  persona = flags('persona.json')
  config = flags('config.json')
  prefs = flags('panel-prefs.json')
  if (prefs) {
    try {
      prefsCustom = readFileSync(join(dataDir, 'panel-prefs.json'), 'utf8').trim() !== DEFAULT_PREFS_JSON.trim()
    } catch {
      prefsCustom = true
    }
  }
  const assets = countFilesIn(join(dataDir, 'assets'))
  const narrative = countFilesIn(join(dataDir, 'narrative'))

  let userVersion: number | null = null
  const tableCounts: Record<string, number> = {}
  let readable = true
  if (dbPresent) {
    try {
      if (options.db) {
        userVersion = readUserVersionWith(options.db)
        for (const table of USER_DATA_TABLES) {
          const row = options.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]
          tableCounts[table] = Number(row?.n ?? 0)
        }
      } else {
        userVersion = readUserVersionFromFile(dbFile)
        for (const table of USER_DATA_TABLES) tableCounts[table] = countFromFile(dbFile, table)
      }
    } catch (error) {
      readable = false
      reasons.push(`库读不出来：${(error as Error).message}`)
    }
  }

  const totalRows = Object.values(tableCounts).reduce((sum, n) => sum + n, 0)
  if (identity) reasons.push('有 identity.md')
  if (persona) reasons.push('有 persona.json')
  if (config) reasons.push('有 config.json')
  if (prefsCustom) reasons.push('面板偏好改过')
  if (assets > 0) reasons.push(`assets 里有 ${assets} 个文件`)
  if (narrative > 0) reasons.push(`narrative 里有 ${narrative} 个文件`)
  if (totalRows > 0) reasons.push(`用户表共 ${totalRows} 行`)

  let state: TargetMemoryState
  if (dbPresent && !readable) state = 'unknown'
  else if (totalRows > 0 || identity || persona || config || prefsCustom || assets > 0) state = 'used'
  else state = 'empty'
  if (state === 'empty') reasons.push('这是空人格：没有用户表数据，也没有人格文件')

  return {
    state,
    dataDir,
    dbPresent,
    userVersion,
    tableCounts,
    totalRows,
    files: { identity, persona, config, prefs, prefsCustom, assets, narrative },
    reasons,
  }
}

/** 从插件连接读 `PRAGMA user_version`（只读语义，不改库）。 */
function readUserVersionWith(db: RestoreDb): number | null {
  try {
    if (db.pragma) {
      const value = db.pragma('user_version')
      return value === undefined || value === null ? null : Number(value)
    }
    const rows = db.all<Row>('PRAGMA user_version')
    const first = rows[0]
    if (!first) return null
    const value = Object.values(first)[0]
    return value === undefined || value === null ? null : Number(value)
  } catch {
    return null
  }
}

/** 离线读 `user_version`（CLI / 启动门禁用）。 */
function readUserVersionFromFile(dbFile: string): number | null {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    const row = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
    return row ? Number(Object.values(row)[0]) : null
  } finally {
    db.close()
  }
}

/** 离线数一张表的行数。 */
function countFromFile(dbFile: string, table: string): number {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Record<string, unknown> | undefined
    return row ? Number(Object.values(row)[0]) : 0
  } catch {
    return 0
  } finally {
    db.close()
  }
}

// ── 包校验与准备 ─────────────────────────────────────────────

/** 校验通过后的包信息。 */
export interface VerifiedPackage {
  ok: boolean
  file: string
  packageId: string
  sha256: string
  bytes: number
  manifest: ArchiveManifest
}

/** 校验一个迁移包：哈希/清单/集合不符合就抛错（错误信息里带第一条问题）。 */
export function verifyPackage(file: string): VerifiedPackage {
  const target = resolve(file)
  if (!existsSync(target)) {
    throw new PsycheError(CODE.notFound, `迁移包不存在：${target}`)
  }
  const result = verifyArchive(target)
  if (!result.ok || !result.manifest) {
    const first = result.problems[0]
    throw new PsycheError(
      CODE.validation,
      `迁移包校验不通过：${first ? `${first.path || '整包'}：${first.reason}` : '未给出原因'}`,
      result.problems,
    )
  }
  return {
    ok: true,
    file: target,
    packageId: basename(target).replace(/\.tar\.gz$/i, ''),
    sha256: sha256Of(target),
    bytes: statSync(target).size,
    manifest: result.manifest,
  }
}

/**
 * 阶段 A 第一步：准备导入（不碰数据根）。
 *
 * 参数：`dataDir` 目标数据根；`file` 迁移包；`schemaVersion` 当前插件最大 schema；
 *      `db` 插件自己的连接（用来判三态与取计数）；`now` 注入时间。
 * 返回：`RestorePlanView`；成功后状态文件已写到 `prepared`，等 `confirmRestore`。
 * 失败：包不合规 / 三态 `unknown` / 已有未完成的恢复 → 抛错，暂存目录被清掉。
 */
export function prepareRestorePackage(options: {
  dataDir: string
  file: string
  schemaVersion: number
  personaId?: string
  db?: RestoreDb
  now?: Date
}): RestorePlanView {
  const dataDir = resolve(options.dataDir)
  const now = options.now ?? new Date()
  const existing = readRestoreJournal(dataDir)
  if (existing && existing.phase !== 'completed') {
    throw new PsycheError(
      CODE.restoreBusy,
      `已经有一次恢复排在路上（${existing.restoreId}，阶段 ${existing.phase}）：先取消它或关掉 DSH 应用它`,
    )
  }

  const verified = verifyPackage(options.file)
  // 校验通过后再看目标状态：判定失败就不解包，省得留垃圾
  const inspection = inspectTargetMemory({ dataDir, db: options.db, now })
  if (inspection.state === 'unknown') {
    throw new PsycheError(
      CODE.restoreBusy,
      `当前数据判定不出来，不做任何操作：${inspection.reasons.join('；')}`,
    )
  }

  const plan = prepareRestore({
    dataDir,
    file: verified.file,
    schemaVersion: options.schemaVersion,
    personaId: options.personaId,
    now,
  })
  if (!plan.ok) {
    const first = plan.problems[0]
    throw new PsycheError(
      CODE.validation,
      `恢复前检查没通过：${first ? `${first.path || '整包'}：${first.reason}` : '未给出原因'}`,
      plan.problems,
    )
  }

  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const restoreId = `restore-${stamp}`
  const journal: RestoreJournal = {
    restoreId,
    packageId: verified.packageId,
    packageSha256: verified.sha256,
    packageSchemaVersion: verified.manifest.schemaVersion,
    targetPath: dataDir,
    stagingPath: plan.stagedDir,
    oldPath: `${dataDir}.old-${stamp}`,
    failedPath: null,
    preRestoreArchive: '',
    preRestoreSha256: '',
    previousRootFingerprint: rootFingerprint(dataDir, { db: options.db }),
    mode: inspection.state === 'used' ? 'overwrite' : 'adopt',
    requestedByPid: process.pid,
    requestedAt: now.toISOString(),
    phase: 'prepared',
  }
  writeRestoreJournal(dataDir, journal)

  return {
    ok: true,
    restoreId,
    packageId: verified.packageId,
    packageSha256: verified.sha256,
    mode: journal.mode,
    requiredConfirmation: journal.mode === 'overwrite' ? verified.packageId : null,
    stagedDir: plan.stagedDir,
    targetState: inspection.state,
    willReplace: inspection,
    phase: journal.phase,
    problems: [],
    notes: [
      journal.mode === 'overwrite'
        ? '当前数据非空：导入会整体替换，且不能与现有记忆合并。'
        : '当前是空人格：可以直接导入，不需要确认词。',
      '这一步没有改动数据目录；确认后要关掉 DSH 再重新打开才会真正替换。',
    ],
  }
}

// ── 确认（冻结写入 + 预恢复包） ───────────────────────────────

/** `confirmRestore` 的结果。 */
export interface RestoreConfirmResult {
  ok: boolean
  restoreId: string
  phase: RestorePhase
  preRestoreArchive: string
  preRestoreBytes: number
  note: string
}

/**
 * 阶段 A 第二步：确认替换。
 *
 * 顺序不可调换（§34.9）：冻结写入 → 导出预恢复包 → 校验它 → 状态推到 pending。
 * 任何一步失败都解冻并抛错，**不留下有效的待恢复任务**。
 *
 * 参数：`confirmation` Used 时必须等于 `packageId`；`freeze`/`unfreeze` 由调用方注入
 *      （Core 的 freezeWrites / unfreezeWrites），这样本模块不必反向依赖 store.ts。
 */
export function confirmRestore(options: {
  dataDir: string
  restoreId?: string
  confirmation?: string
  db?: RestoreDb
  version: string
  schemaVersion: number
  algorithmVersion: string
  freeze?: (reason: string) => void
  unfreeze?: () => void
  now?: Date
}): RestoreConfirmResult {
  const dataDir = resolve(options.dataDir)
  const now = options.now ?? new Date()
  const journal = readRestoreJournal(dataDir)
  if (!journal) {
    throw new PsycheError(CODE.notFound, '没有待确认的恢复：先调用 prepare 准备导入')
  }
  if (options.restoreId && options.restoreId !== journal.restoreId) {
    throw new PsycheError(
      CODE.validation,
      `恢复编号不符：当前待确认的是 ${journal.restoreId}`,
    )
  }
  if (journal.phase === 'pending') {
    throw new PsycheError(CODE.restoreBusy, '这次恢复已经确认过了：关掉 DSH 再打开就会应用')
  }
  if (journal.phase !== 'prepared') {
    throw new PsycheError(CODE.state, `恢复状态是 ${journal.phase}，不能在这里再确认`)
  }
  if (journal.mode === 'overwrite' && (options.confirmation ?? '').trim() !== journal.packageId) {
    throw new PsycheError(
      CODE.validation,
      `确认词不对：当前数据非空，导入会整体覆盖。请输入完整包 ID ${journal.packageId}`,
    )
  }

  const freeze = options.freeze
  const unfreeze = options.unfreeze
  let produced: string | null = null
  freeze?.('正在等待重启应用恢复，这期间不接受新的记忆写入')
  try {
    // 预恢复包：就是「替换前最后状态」的证据，必须落在数据根之外。
    // 空人格（adopt）没有需要保护的内容，跳过——否则还得为一个空库先建库，反而多一步风险。
    if (journal.mode === 'overwrite') {
      if (!options.db) {
        throw new PsycheError(
          CODE.validation,
          '当前数据非空，覆盖前必须导出一份预恢复包，但这次没有可用的数据库连接',
        )
      }
      const counts: Record<string, number> = {}
      for (const table of USER_DATA_TABLES) {
        const row = options.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]
        counts[table] = Number(row?.n ?? 0)
      }
      const archive = createArchive({
        db: options.db,
        dataDir,
        counts,
        version: options.version,
        schemaVersion: options.schemaVersion,
        algorithmVersion: options.algorithmVersion,
        outDir: preRestoreDir(dataDir),
        namePrefix: 'psyche-prerestore',
        now,
        keep: 5,
      })
      produced = archive.file
      const check = verifyArchive(archive.file)
      if (!check.ok) {
        const first = check.problems[0]
        throw new PsycheError(
          CODE.validation,
          `预恢复包校验不通过，已取消这次导入：${first ? first.reason : '未给出原因'}`,
        )
      }
      journal.preRestoreArchive = archive.file
      journal.preRestoreSha256 = sha256Of(archive.file)
    }
    // 指纹在**确认完成后**重算：VACUUM INTO 期间库文件自身也会被写过，
    // 用 prepare 时刻的指纹会立刻对不上。这份指纹代表「关机前的最后状态」，
    // 下次启动替换前再比一次，能发现「确认之后又被别的程序改过」。
    journal.previousRootFingerprint = rootFingerprint(dataDir, { db: options.db })
    journal.phase = 'pending'
    writeRestoreJournal(dataDir, journal)
  } catch (error) {
    // 失败即取消：解冻 + 删掉半成品，状态回到 prepared（不是 pending，启动时不会动手）
    unfreeze?.()
    if (produced) {
      try {
        rmSync(produced, { force: true })
      } catch {
        // 删不掉也不影响正确性：状态没到 pending
      }
    }
    throw error
  }

  return {
    ok: true,
    restoreId: journal.restoreId,
    phase: journal.phase,
    preRestoreArchive: journal.preRestoreArchive,
    // 空人格（adopt）不导预恢复包，这里如实给 0 而不是去 stat 一个空路径
    preRestoreBytes: journal.preRestoreArchive ? statSync(journal.preRestoreArchive).size : 0,
    note:
      journal.mode === 'adopt'
        ? '已锁定（空人格不需要预恢复包）。请完全关闭 DSH，再重新打开；当前数据目录尚未被替换。'
        : '已锁定当前状态。请完全关闭 DSH，再重新打开；当前数据目录尚未被替换。',
  }
}

/** 取消一次还没应用的恢复：删暂存目录、清状态文件、解冻。 */
export function cancelRestore(options: { dataDir: string; unfreeze?: () => void }): { ok: boolean; note: string } {
  const dataDir = resolve(options.dataDir)
  const journal = readRestoreJournal(dataDir)
  if (!journal) return { ok: true, note: '没有待恢复的任务' }
  if (journal.phase !== 'prepared' && journal.phase !== 'pending') {
    return {
      ok: false,
      note: `恢复已经到 ${journal.phase}，不能再取消；请按状态文件里的路径人工处理`,
    }
  }
  rmSync(journal.stagingPath, { recursive: true, force: true })
  clearRestoreJournal(dataDir)
  options.unfreeze?.()
  return { ok: true, note: '已取消，数据目录没有被改动' }
}

// ── 阶段 B：应用（启动门禁 / CLI） ───────────────────────────

/** 现场判定：三个目录谁在，决定从哪个 phase 续做（§34.8 表）。 */
export type RestoreScene =
  | 'pending-both'
  | 'old-moved'
  | 'new-installed'
  | 'installed-only'
  | 'orphan-old'
  | 'ambiguous'

/** 只看目录存在性，不看状态文件怎么说——状态文件可能落后于现场。 */
export function detectRestoreScene(journal: RestoreJournal): RestoreScene {
  const target = existsSync(journal.targetPath)
  const staging = existsSync(journal.stagingPath)
  const old = existsSync(journal.oldPath)
  if (target && staging && !old) return 'pending-both'
  if (!target && old && staging) return 'old-moved'
  if (target && old && !staging) return 'new-installed'
  if (target && !old && !staging) return 'installed-only'
  if (!target && old && !staging) return 'orphan-old'
  return 'ambiguous'
}

/**
 * 安装后校验：库能开、完整、外键干净、结构齐全、归属正确。
 *
 * 与阶段 A 的 `checkDatabaseFile` 用同一套判据——安装后再查一遍不是冗余：
 * 目录替换本身可能出问题（拿到的是旧目录的残留、或被拦截了一半），
 * 而这一步是**回滚前的最后一道闸**：不过就换回旧目录。
 *
 * 计数对账不在这里重做（清单计数已在阶段 A 验过），这里只证明「装上去的这份结构可用」。
 */
function verifyInstalled(dataDir: string, schemaVersion: number): { ok: boolean; problems: string[] } {
  const dbFile = join(dataDir, 'memory.sqlite3')
  if (!existsSync(dbFile)) return { ok: false, problems: ['新目录里没有 memory.sqlite3'] }
  const check = checkDatabaseFile({ file: dbFile, expectedVersion: schemaVersion, personaId: 'main' })
  return { ok: check.ok, problems: check.problems.map((problem) => problem.detail) }
}

/**
 * 阶段 B：应用待恢复任务。**只允许在 `openDatabase()` 之前调用**（插件启动或 CLI）。
 *
 * 行为：读状态文件 → 现场判定 → 按 phase 续做 → 安装后校验 → 标记 completed。
 * 失败：能回滚就回滚（旧目录复原），不能就把现场留给人工并抛
 *      `E_RESTORE_RECOVERY_REQUIRED`；**任何分支都不删旧目录**。
 */
export function applyPendingRestore(options: { dataDir: string; now?: Date }): RestoreApplyOutcome {
  const dataDir = resolve(options.dataDir)
  const now = options.now ?? new Date()
  const journal = readRestoreJournal(dataDir)
  const idle: RestoreApplyOutcome = {
    ok: true,
    applied: false,
    reason: 'no-pending',
    phase: journal?.phase ?? null,
    dataDir,
    keptDir: null,
    files: 0,
    note: '没有待恢复的任务',
  }
  if (!journal) return idle
  if (journal.phase === 'prepared') {
    return {
      ...idle,
      reason: 'not-confirmed',
      note: '恢复只是准备好了，还没确认；确认后才会在下一次启动替换',
    }
  }
  if (journal.phase === 'completed') {
    return { ...idle, reason: 'completed', note: '这次恢复已经完成' }
  }
  if (journal.phase === 'recovery_required') {
    return {
      ...idle,
      ok: false,
      reason: 'recovery-required',
      note: `上次恢复中断在现场不明确的状态，未做任何自动处理。现场：${journal.targetPath} / ${journal.oldPath}`,
    }
  }

  const scene = detectRestoreScene(journal)
  // pending 阶段的「target 在、staging 缺、old 缺」不是「新目录已装好」（installed-only），
  // 而是暂存目录在切换前就丢了：目标里仍是旧库，把它当新库收尾会误报成功、还丢掉这次恢复。
  if (journal.phase === 'pending' && scene === 'installed-only') {
    journal.phase = 'recovery_required'
    writeRestoreJournal(dataDir, journal)
    throw new PsycheError(
      CODE.restoreRecovery,
      '恢复已排队但暂存目录不见了：目标目录仍是旧数据，没有把它当成新库收尾。请重新 prepare 一次',
    )
  }
  if (scene === 'ambiguous') {
    journal.phase = 'recovery_required'
    writeRestoreJournal(dataDir, journal)
    throw new PsycheError(
      CODE.restoreRecovery,
      `恢复现场不明确（目标 ${existsSync(journal.targetPath) ? '在' : '缺'}、暂存 ${existsSync(journal.stagingPath) ? '在' : '缺'}、旧目录 ${existsSync(journal.oldPath) ? '在' : '缺'}）：不删不覆盖，请人工核对`,
    )
  }
  if (scene === 'pending-both') {
    // 准备之后目标被别的程序改过 → 不能照旧替换
    const fingerprint = rootFingerprint(dataDir)
    if (journal.previousRootFingerprint && fingerprint !== journal.previousRootFingerprint) {
      journal.phase = 'recovery_required'
      writeRestoreJournal(dataDir, journal)
      throw new PsycheError(
        CODE.restoreRecovery,
        '目标数据根在准备恢复之后被改动过：已停止替换，请确认是否仍要恢复（重新 prepare 一次即可）',
      )
    }
  }

  const moveOld = (): void => {
    if (existsSync(journal.targetPath)) {
      renameSync(journal.targetPath, journal.oldPath)
    }
    journal.phase = 'old_moved'
    writeRestoreJournal(dataDir, journal)
  }
  const installNew = (): void => {
    renameSync(journal.stagingPath, journal.targetPath)
    journal.phase = 'new_installed'
    writeRestoreJournal(dataDir, journal)
  }
  const rollbackOld = (): void => {
    // 新目录留着（改名成 failed），旧目录换回来；换不回来就交给人工
    if (existsSync(journal.targetPath)) {
      const failed = `${journal.targetPath}.failed-${journal.restoreId}`
      try {
        renameSync(journal.targetPath, failed)
        journal.failedPath = failed
      } catch {
        // 连移走都失败：保持原样，下面抛错让人看现场
      }
    }
    if (existsSync(journal.oldPath) && !existsSync(journal.targetPath)) {
      renameSync(journal.oldPath, journal.targetPath)
    }
    journal.phase = 'recovery_required'
    writeRestoreJournal(dataDir, journal)
  }

  try {
    if (scene === 'pending-both' || scene === 'old-moved') {
      if (scene === 'pending-both') moveOld()
      installNew()
    } else if (scene === 'new-installed' || scene === 'installed-only') {
      // 目录已经换过：只重跑校验，成功就收尾
      journal.phase = 'new_installed'
      writeRestoreJournal(dataDir, journal)
    } else if (scene === 'orphan-old') {
      // 没有新目录可装：把旧目录换回来，报告中断
      renameSync(journal.oldPath, journal.targetPath)
      journal.phase = 'recovery_required'
      writeRestoreJournal(dataDir, journal)
      return {
        ok: false,
        applied: false,
        reason: 'restored-old',
        phase: journal.phase,
        dataDir,
        keptDir: journal.oldPath,
        files: 0,
        note: '没有可安装的新目录，已把旧数据换回原位；请检查迁移包后重试',
      }
    }

    const verified = verifyInstalled(dataDir, journal.packageSchemaVersion)
    if (!verified.ok) {
      rollbackOld()
      throw new PsycheError(
        CODE.restoreRecovery,
        `新数据目录校验没通过（${verified.problems.join('；')}）：已尝试把旧目录换回来，请核对 ${journal.targetPath} 与 ${journal.oldPath}`,
      )
    }
    journal.phase = 'validated'
    writeRestoreJournal(dataDir, journal)
    journal.phase = 'completed'
    journal.requestedAt = journal.requestedAt || now.toISOString()
    writeRestoreJournal(dataDir, journal)
    return {
      ok: true,
      applied: true,
      reason: 'completed',
      phase: 'completed',
      dataDir,
      keptDir: existsSync(journal.oldPath) ? journal.oldPath : null,
      files: countFilesIn(dataDir),
      note: `已从 ${journal.packageId} 恢复；旧目录保留在 ${journal.oldPath}`,
    }
  } catch (error) {
    if (error instanceof PsycheError) throw error
    rollbackOld()
    throw new PsycheError(
      CODE.restoreRecovery,
      `恢复过程中断：${(error as Error).message}。已尽量换回旧目录，现场见 ${journal.targetPath} / ${journal.oldPath}`,
    )
  }
}

/** `applyPendingRestore` 的别名：语义上就是「把中断的恢复续做完」。 */
export function recoverInterruptedRestore(options: { dataDir: string; now?: Date }): RestoreApplyOutcome {
  return applyPendingRestore(options)
}

/** 查询恢复状态（面板 `GET /restore/status`）。 */
export function restoreStatus(options: { dataDir: string; db?: RestoreDb }): RestoreStatus {
  const dataDir = resolve(options.dataDir)
  const journal = readRestoreJournal(dataDir)
  let target: TargetMemoryInspection | null = null
  try {
    target = inspectTargetMemory({ dataDir, db: options.db })
  } catch {
    target = null
  }
  const pending = journal?.phase === 'pending'
  let note = '没有待恢复的任务'
  if (journal) {
    note =
      journal.phase === 'pending'
        ? '已确认，等 DSH 完全退出后重新打开就会应用'
        : journal.phase === 'prepared'
          ? '已准备，但还没确认（确认后才会在下次启动替换）'
          : journal.phase === 'completed'
            ? '这次恢复已完成'
            : `恢复停在 ${journal.phase}：请查看状态文件与目录现场`
  }
  return { ok: true, pending, journal, target, note }
}
