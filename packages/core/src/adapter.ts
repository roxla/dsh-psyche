// 心灵数据库适配层（设计 §11.5 / §11.6）
//
// 职责：把「两种 SQLite 驱动」收敛成同一个同步句柄面（prepare / exec / close），
// 再在上面包一层统一的门面 Db（prepare 缓存、慢查询记账、事务、健康检查、错误翻译），
// 外加 migrate()：按 PRAGMA user_version 把 schema.ts 里的迁移跑到最新。
//
// 关键约束（改这个文件前先读这几条）：
// - 默认驱动 node:sqlite（宿主自带、零安装），不可用时回退 better-sqlite3。
// - 启动必跑五项能力自检，全过才 ready；两个驱动都失败就报错，**不降级内存库**
//   （内存库会让「记忆」在重启后静默消失，比启动失败更糟）。
// - 损坏库不切驱动：先报错、保留文件（由人决定怎么恢复），绝不自动重建。
// - 所有对外接口都是 async（§11.6.1 的第一天约定），内部事务仍是同步的；
//   事务里不要 await —— 事务期间让出事件循环会把写锁白占着。
// - PRAGMA 一律走 prepare/get：两种驱动的 pragma 辅助方法签名不一致，绕不过。
//
// 被谁调用：插件的 store / 各业务模块（持有一个 Db 实例）、测试与诊断脚本、
// 宿主面板的健康检查（读 health() / stats）。
import { createRequire } from 'node:module'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'
import { CODE, PsycheError } from './errors.js'

const BUSY_TIMEOUT_MS = 5000
const DRIVER_ORDER = Object.freeze(['node:sqlite', 'better-sqlite3'] as const)
const CORRUPT_PATTERN =
  /file is not a database|database disk image is malformed|not a database|is encrypted|malformed database/i

/** 能直接绑给 SQLite 的值。undefined / boolean / Date 在 bind() 里转换，不直接下放。 */
export type SqlParam = string | number | bigint | null | Uint8Array
/** 单个参数、参数数组或省略；两种写法都走 bind() 归一化。 */
export type SqlParams = SqlParam | readonly SqlParam[] | undefined
/** 一行查询结果（列名 → 标量）；get/all 用泛型描述具体形状。 */
export type Row = Record<string, SqlParam>
/** 实际生效的驱动名；写进 health()，出问题时第一眼要能看出用的是哪个。 */
export type DatabaseDriver = 'node:sqlite' | 'better-sqlite3'

/**
 * 日志口：全部可选，宿主没接日志时也不报错。
 * 慢查询走 warn（人应该看到），普通偏慢走 debug（只给排查用）。
 */
export interface DbLogger {
  debug?(message: string): void
  info?(message: string): void
  warn?(message: string): void
  error?(message: string): void
}

/** 两种驱动共用的最小语句面：只用到这三个方法，多的一点都不依赖。 */
interface RawStatement {
  run(...params: SqlParam[]): { changes?: number | bigint; lastInsertRowid?: number | bigint }
  all(...params: SqlParam[]): unknown[]
  get(...params: SqlParam[]): unknown
}

/**
 * 两种驱动共用的最小句柄面。
 * backup 是可选的：node:sqlite 不一定有，没有时自检改用 VACUUM INTO（见 runSelfCheck 第 5 项）。
 */
interface RawHandle {
  prepare(sql: string): RawStatement
  exec(sql: string): void
  close(): void
  backup?: (...args: unknown[]) => unknown
}

/** 自检里的一项：name 是固定标识（open / foreign_keys / journal_mode / fts5 / backup）。 */
export interface SelfCheckItem {
  name: string
  ok: boolean
  detail: string
}

/**
 * 五项能力自检的结果。
 *
 * ok 是「全部通过」的合取，不单独维护状态：只要有一项 false，整库就不 ready。
 * backupMode 记录备份能力是怎么验出来的（native / vacuum-into / null），
 * journalMode 回读实际生效值 —— 两个都留成字段，是因为它们在别的机器上可能不同，
 * 出问题时需要的是证据而不是结论。
 */
export interface SelfCheck {
  ok: boolean
  items: SelfCheckItem[]
  backupMode: string | null
  journalMode: string | null
}

/** 一条慢查询样本：sql 已压平空白并截断到 160 字，够定位又不撑爆面板。 */
export interface SlowQuerySample {
  sql: string
  ms: number
}

/**
 * 运行期查询统计（内存态，不落库）。
 *
 * calls 是总调用数；slow 是超过 slowQueryMs 的次数；warn 是超过 slowWarnMs 的次数
 * （warn 是 slow 的子集）；recent 只保留最近 20 条慢查询，环形丢弃最旧的。
 * 这些数字只用于观察，不影响任何业务判断。
 */
export interface DbStats {
  calls: number
  slow: number
  warn: number
  maxMs: number
  recent: SlowQuerySample[]
}

/**
 * 健康快照：给面板与诊断用。
 *
 * userVersion 是库的实际 schema 版本（可能落后于插件，说明迁移没跑成功）；
 * tables 是 sqlite_master 里的业务表数（应与 schema.ts 的 EXPECTED_TABLE_COUNT 一致）；
 * journalMode / synchronous / foreignKeys 是 PRAGMA 回读值 —— 只信回读，不信「我设过」；
 * bytes 取不到文件时是 null（例如路径被移走），不抛错。
 * 本方法只读，不写库，也不改变连接状态。
 */
export interface DbHealth {
  driver: string
  file: string
  userVersion: number
  tables: number
  journalMode: SqlParam | undefined
  synchronous: SqlParam | undefined
  foreignKeys: SqlParam | undefined
  bytes: number | null
  queries: number
  slowQueries: number
  slowWarnings: number
  maxQueryMs: number
}

/**
 * openDatabase 的入参。
 *
 * driverPreference：'auto' 走 DRIVER_ORDER（node:sqlite → better-sqlite3）；
 * 指定具体驱动时只试那一个，失败就直接抛 E_DB（不再回退）—— 人既然点名了，
 * 就按他点的来，别偷偷换成另一个。
 * slowQueryMs 默认 50（记一笔），slowWarnMs 默认 200（打 warn 日志）；
 * 两者是阈值不是开关，调大等于关掉对应记账。
 */
export interface OpenOptions {
  file: string
  driverPreference?: string
  logger?: DbLogger
  slowQueryMs?: number
  slowWarnMs?: number
}

/** 一次开库尝试的结果：stage 标出失败发生在哪一步（open / self-check），便于报错时归因。 */
export interface OpenAttempt {
  driver: string
  ok: boolean
  stage: string
  reason: string
}

/**
 * 开库成功的返回值。
 *
 * db 已 applyBasePragmas、已通过五项自检、已迁移到 SCHEMA_VERSION；
 * attempts 保留「之前试过谁、为什么没成」的完整过程，
 * applied 是本次真正跑了的迁移（空数组表示库已是最新）。
 * 调用方拿到的 Db 是「ready」状态，不需要再自己 PRAGMA 或 migrate。
 */
export interface OpenResult {
  db: Db
  driver: string
  selfCheck: SelfCheck
  attempts: OpenAttempt[]
  applied: AppliedMigration[]
}

/** 本次成功应用的迁移；version + name 与 schema_migrations 里那一行一致。 */
export interface AppliedMigration {
  version: number
  name: string
}

/**
 * 统一的「现在」：全库时间戳都从这一处取，格式是 ISO 8601（UTC）。
 *
 * 为什么统一用 UTC：跨时区/跨夏令时比较字符串才有意义（SQLite 里时间是 TEXT，
 * 按字典序比较），本地时区字符串会在夏令时切换那天排错序。
 * 副作用：无。被测代码需要固定时间时，各函数都开了 now 参数覆盖，不靠改时钟。
 */
export function nowIso(): string {
  return new Date().toISOString()
}

/** 把任意 thrown 值压成可读消息：驱动抛的不一定是 Error（字符串/对象都见过）。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 判断这个错误是不是「库文件坏了」。
 *
 * 单独拎出来的原因：损坏和「驱动不支持」的处理完全不同 ——
 * 损坏要立刻停手（保留文件、报 E_DB_CORRUPT），绝不能换个驱动再试一次，
 * 因为换驱动的「成功」往往意味着在损坏的文件旁边建了个新的空库。
 */
function isCorruption(error: unknown): boolean {
  return CORRUPT_PATTERN.test(errorMessage(error))
}

/**
 * 把调用方给的参数拍平成驱动认识的数组，并做三种转换：
 * undefined → null（SQLite 没有 undefined，不转会直接报绑定错）、
 * boolean → 0/1（SQLite 无布尔类型）、Date → ISO 字符串（与全库时间格式一致）。
 * 单个值也当成单元素数组：`run(sql, 'x')` 和 `run(sql, ['x'])` 等价。
 */
function bind(params: SqlParams): SqlParam[] {
  if (params === undefined) return []
  const list = Array.isArray(params) ? (params as readonly unknown[]) : [params]
  return list.map((value) => {
    if (value === undefined) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    if (value instanceof Date) return value.toISOString()
    return value as SqlParam
  })
}

/**
 * 按名字打开一个驱动，返回两者共有的最小句柄面。
 *
 * 为什么是 async：node:sqlite 只能动态 import（老宿主里这个模块可能不存在，
 * 静态 import 会让整个插件加载失败）；better-sqlite3 是 CJS，用 createRequire 拿到。
 * 两个分支都在这里做「形状校验」：缺 DatabaseSync 就当场抛，把问题留在 openRaw，
 * 而不是等第一次 prepare 时报一个莫名其妙的错。
 * 副作用：打开文件句柄（失败时由调用方负责 close / 丢弃）；不跑任何 PRAGMA。
 * 抛：Error（未知驱动 / 模块缺失 / 驱动内部错误），由 openDatabase 决定是重试换驱动还是停。
 */
async function openRaw(driver: string, file: string): Promise<RawHandle> {
  if (driver === 'node:sqlite') {
    // 动态 import：模块不存在时只会在这里失败，不会拖垮插件加载
    const mod = await import('node:sqlite')
    // 旧版本只导出部分 API，形状不对就当场抛，让 openDatabase 记一次 open 失败并换驱动
    if (typeof mod.DatabaseSync !== 'function') throw new Error('node:sqlite 未导出 DatabaseSync')
    return new mod.DatabaseSync(file) as unknown as RawHandle
  }
  if (driver === 'better-sqlite3') {
    // 它是 CJS 包（且带原生扩展），用 require 而不是 import；失败信息更贴近「没装依赖」
    const require = createRequire(import.meta.url)
    const Better = require('better-sqlite3') as new (file: string) => RawHandle
    return new Better(file)
  }
  throw new Error(`未知驱动：${driver}`)
}

/**
 * 记忆库门面：包住一个原始驱动句柄，提供统一的同步读写 + 事务 + 统计。
 *
 * 职责
 * - prepare 缓存：同一条 SQL 只 prepare 一次（SQL 是常量模板，重复 prepare 是纯浪费）；
 * - 慢查询记账：每次 run/all/get 都计时，超阈值记样本 / 打日志，但不影响结果；
 * - 事务：transaction() 用 BEGIN IMMEDIATE，可嵌套（内层直接并入外层）；
 * - 错误翻译：把驱动原始错误转成带 E_* 码的 PsycheError（见 wrapSqliteError）；
 * - 只读探针：tableCount / userVersion / health。
 *
 * 事务边界
 * - 这类方法自己不开事务，由调用方用 transaction() 显式包；
 * - 单条语句本身就是原子的（SQLite 隐式事务），不必为一行包装事务。
 *
 * 并发/失败语义
 * - 所有方法同步执行；#inTx 只在本实例内生效，跨实例的写竞争交给 busy_timeout（5s）；
 * - 抛的错：E_VALIDATION（约束拒绝，可拦住的重放不必重试）、E_DB（锁超时）、
 *   其余原样抛出（程序 bug 不该被包装成业务错误）。
 */
export class Db {
  readonly driver: string
  readonly file: string
  readonly logger?: DbLogger
  readonly slowQueryMs: number
  readonly slowWarnMs: number
  /** 原始句柄；自检要探测 backup 能力时直接用它。 */
  #handle: RawHandle
  /** SQL → 已 prepare 的语句。键就是 SQL 原文，所以要复用常量、别拼串。 */
  #cache = new Map<string, RawStatement>()
  /** 当前是否在本实例开的事务里；嵌套调用靠它降级成「直接执行」。 */
  #inTx = false
  /** 内存统计，不持久化；重开库后归零。 */
  #stats: DbStats = { calls: 0, slow: 0, warn: 0, maxMs: 0, recent: [] }

  /**
   * 构造只做字段赋值：PRAGMA、自检、迁移都由 openDatabase 负责，
   * 让 Db 在构造后就可用（不在这里偷偷改连接状态，方便测试注入临时库）。
   * 阈值默认 50ms / 200ms；传 0 或负数等于「全部算慢」，通常只在排查时用。
   */
  constructor({ handle, driver, file, logger, slowQueryMs = 50, slowWarnMs = 200 }: {
    handle: RawHandle
    driver: string
    file: string
    logger?: DbLogger
    slowQueryMs?: number
    slowWarnMs?: number
  }) {
    this.#handle = handle
    this.driver = driver
    this.file = file
    this.logger = logger
    this.slowQueryMs = slowQueryMs
    this.slowWarnMs = slowWarnMs
  }

  /** 原始句柄的逃生口：自检探测 backup、或确有必要时直接 exec 多语句脚本。 */
  get handle(): RawHandle {
    return this.#handle
  }

  /** 统计快照（深拷一份）：外部拿到的数组不会反过来改内部状态。 */
  get stats(): DbStats {
    return { ...this.#stats, recent: [...this.#stats.recent] }
  }

  /**
   * 取一条已 prepare 的语句，没有就现编并缓存。
   * 缓存不设上限是有意的：SQL 全部来自代码里的常量模板，种类有限；
   * 如果哪天开始拼 SQL，这里的 Map 会无限增长 —— 那说明拼串本身就是 bug。
   */
  prepare(sql: string): RawStatement {
    // 命中缓存就不碰驱动：prepare 是编译期开销，同一模板在热路径上会被调上千次
    let statement = this.#cache.get(sql)
    if (!statement) {
      statement = this.#handle.prepare(sql)
      this.#cache.set(sql, statement)
    }
    return statement
  }

  /**
   * 直接执行 SQL 脚本（可含多条语句）。
   *
   * 只给两类调用方：迁移脚本（schema.ts 的整段 SQL）和控制类 PRAGMA。
   * 它不走 prepare 缓存、不记账、不做错误翻译 —— 迁移失败时保留驱动原始错误更好排查；
   * 业务读写一律用 run/all/get，别用 exec 绕开统计与约束翻译。
   */
  exec(sql: string): void {
    this.#handle.exec(sql)
  }

  /**
   * 计时包装：work 的返回值/异常原样透传，只在 finally 里记一笔账。
   *
   * 为什么在 finally 里记账：慢查询往往是「最后抛错的那条」（锁等待超时），
   * 只在成功路径计时会把最该看的那一条漏掉。
   * 记账本身不抛错：日志失败不该改变业务结果。
   */
  #timed<T>(sql: string, work: () => T): T {
    const started = performance.now()
    try {
      return work()
    } finally {
      const ms = performance.now() - started
      const stats = this.#stats
      stats.calls += 1
      if (ms > stats.maxMs) stats.maxMs = ms
      // 慢样本只留最近 20 条：诊断时看的是「刚刚发生了什么」，不是历史总和
      if (ms > this.slowQueryMs) {
        stats.slow += 1
        // SQL 压成一行再截断：样本是给人看日志的，多行 SQL 会把日志拆散
        stats.recent.push({ sql: sql.replace(/\s+/g, ' ').trim().slice(0, 160), ms: Math.round(ms) })
        if (stats.recent.length > 20) stats.recent.shift()
      }
      // 两条阈值：超 warn 记 warn 级（该查了），只是偏慢记 debug（平时不刷屏）
      if (ms > this.slowWarnMs) {
        stats.warn += 1
        this.logger?.warn?.(`[psyche] 慢查询 ${ms.toFixed(0)}ms：${sql.replace(/\s+/g, ' ').trim().slice(0, 160)}`)
      } else if (ms > this.slowQueryMs) {
        this.logger?.debug?.(`[psyche] 查询 ${ms.toFixed(0)}ms：${sql.replace(/\s+/g, ' ').trim().slice(0, 120)}`)
      }
    }
  }

  /**
   * 执行一条写语句。
   *
   * 返回 changes / lastInsertRowid，都转成 number：驱动可能给 bigint，
   * 直接外泄到「无损 JSON」校验那一层会失败。
   * 抛：E_VALIDATION（约束拒绝）/ E_DB（锁超时），其余原样抛。
   * 副作用：写库；不自动开事务 —— 多条写要一起成功时用 transaction() 包起来。
   */
  run(sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number } {
    return this.#timed(sql, () => {
      try {
        const result = this.prepare(sql).run(...bind(params))
        return {
          changes: Number(result.changes ?? 0),
          lastInsertRowid: Number(result.lastInsertRowid ?? 0),
        }
      } catch (error) {
        throw wrapSqliteError(sql, error)
      }
    })
  }

  /** 取多行。泛型 T 由调用方给出具体形状；不给就是 Row。只读，不开事务。 */
  all<T = Row>(sql: string, params?: SqlParams): T[] {
    return this.#timed(sql, () => {
      try {
        return this.prepare(sql).all(...bind(params)) as T[]
      } catch (error) {
        throw wrapSqliteError(sql, error)
      }
    })
  }

  /** 取一行；没有则 undefined（不抛错）。调用方用 `?.` 或显式判断，别假设一定有行。 */
  get<T = Row>(sql: string, params?: SqlParams): T | undefined {
    return this.#timed(sql, () => {
      try {
        return this.prepare(sql).get(...bind(params)) as T | undefined
      } catch (error) {
        throw wrapSqliteError(sql, error)
      }
    })
  }

  /** PRAGMA 一律走 prepare/get，避开两种驱动各自的 pragma 辅助方法差异。 */
  pragma(statement: string): SqlParam | undefined {
    // 走 get 就顺带享受了缓存与慢查询记账；返回首列值（PRAGMA 的结果都是单列）
    const row = this.get(`PRAGMA ${statement}`)
    return row === undefined ? undefined : Object.values(row)[0]
  }

  /**
   * 打开库后必跑的基础 PRAGMA（不做能力判定，判定在 runSelfCheck）。
   *
   * 逐条的理由：
   * - foreign_keys：SQLite 默认是 OFF，不显式打开则所有 REFERENCES 都只是文档；
   *   它是连接级设置，每开一个新连接都得重设，不是库级持久属性。
   * - busy_timeout：WAL 下写写仍然互斥，5s 是「够等到通常的短写完成，又不至于让人卡住」的折中。
   * - temp_store = MEMORY：排序/临时表走内存，本库的读都是小结果集，落盘反而更慢。
   * - synchronous = NORMAL：节点级默认；重要事务会临时提到 FULL（见 transaction）。
   * 副作用：改连接状态；不写库数据。失败直接抛，由 openDatabase 计入 self-check。
   */
  applyBasePragmas(): void {
    // 外键必须显式开：这是「身份/证据链不会指空」的最后一道结构保证
    this.exec('PRAGMA foreign_keys = ON')
    this.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    this.exec('PRAGMA temp_store = MEMORY')
    this.setSynchronous('NORMAL')
  }

  /**
   * 设置连接级 synchronous。
   *
   * 参数校验是白名单而不是直接拼串：这个值只能来自代码常量，
   * 一旦哪天由外部传入，拼串就成了注入点。
   * 抛：E_INTERNAL（非法模式）—— 这是编程错误，不是用户输入问题。
   * 必须在事务外调用（见 transaction 的说明），否则 PRAGMA 会被当前事务吞掉或报错。
   */
  setSynchronous(mode: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA'): void {
    const allowed = new Set(['OFF', 'NORMAL', 'FULL', 'EXTRA'])
    if (!allowed.has(mode)) throw new PsycheError(CODE.internal, `非法 synchronous 模式：${mode}`)
    this.exec(`PRAGMA synchronous = ${mode}`)
  }

  /**
   * 同步事务。重要事务（人格 / 关系账本）在**事务开始前**把连接级 synchronous 提到 FULL，
   * 结束后还原（§11.5 明确不在事务内部切 PRAGMA）。
   *
   * 参数：fn 里不许 await —— 事务期间让出事件循环会白占写锁；
   * options.important = true 时提同步级别（每次 commit 多一次 fsync，代价换来「掉电不丢这笔」）。
   * 返回：fn 的返回值原样透传。
   * 事务边界：BEGIN IMMEDIATE → fn() → COMMIT；fn 抛错则 ROLLBACK 并原样抛出。
   * 嵌套：已在事务里时直接执行 fn（并入外层），不新建保存点 ——
   * 所有回滚都发生在最外层，内层失败会连同外层一起回滚，这正是想要的语义。
   * 为什么用 IMMEDIATE 而不是 DEFERRED：DEFERRED 会先拿读锁、写的时候再升级，
   * 并发下可能升级失败并抛 SQLITE_BUSY；IMMEDIATE 一开始就拿写锁，早失败早重试。
   */
  transaction<T>(fn: () => T, options: { important?: boolean } = {}): T {
    // 已在外层事务里：直接并入，不建保存点（内层报错会让整笔一起回滚）
    if (this.#inTx) return fn()

    const important = options.important === true
    // 必须在 BEGIN 之前切：事务内改 PRAGMA 没有效果，SQLite 会直接忽略或报错
    if (important) this.setSynchronous('FULL')

    // IMMEDIATE 一开始就拿写锁：并发写在这里排队（最长 busy_timeout），而不是写到一半才失败
    this.#handle.exec('BEGIN IMMEDIATE')
    this.#inTx = true
    try {
      const result = fn()
      this.#handle.exec('COMMIT')
      return result
    } catch (error) {
      // 回滚失败也不掩盖原始错误：原始错误才是有用的那个；连接已坏的情况由上层重开库
      try {
        this.#handle.exec('ROLLBACK')
      } catch {
        /* 已经回滚或连接异常，交给下面的原错误 */
      }
      throw error
    } finally {
      // 无论提交还是回滚，标志都要复位，否则后续所有事务都会被误判成「嵌套」而静默不 BEGIN
      this.#inTx = false
      // 还原成节点级默认；放在 finally 里保证异常路径也不会让连接一直停在 FULL
      if (important) this.setSynchronous('NORMAL')
    }
  }

  /** 是否处在本实例开启的事务里（健康检查 / 调试用）。注意它看不见别的连接的事务。 */
  get inTransaction(): boolean {
    return this.#inTx
  }

  /**
   * 数用户表数量，用来做「建库结果是否符合预期」的断言（对照 schema.ts 的 EXPECTED_TABLE_COUNT）。
   *
   * 排除三类：sqlite_% 是引擎内部表（sqlite_sequence 由 AUTOINCREMENT 生成）、
   * fts_index% 是 FTS5 的影子表（一排 fts_index_* 不是业务表）、
   * sqlite_sequence 单独再排一次是因为 % 通配只匹配 sqlite_ 前缀后仍有名字，
   * 这里宁可多写一个条件也不想让计数随引擎版本漂。
   */
  tableCount(): number {
    const row = this.get<{ n: number }>(
      `SELECT count(*) AS n FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE 'fts_index%' AND name NOT LIKE 'sqlite_sequence'`,
    )
    // 驱动可能回 bigint，统一转 number
    return Number(row?.n ?? 0)
  }

  /** 读 PRAGMA user_version：迁移的「把门人」，是整个升级流程里唯一可信的版本来源。 */
  userVersion(): number {
    return Number(this.pragma('user_version') ?? 0)
  }

  /**
   * 一次性读出面板要展示的健康信息。
   *
   * 只信 PRAGMA 回读值：设置 PRAGMA 成功不代表生效（journal_mode 在某些文件系统上会静默降级），
   * 所以这里全部重新读一遍。
   * bytes 用 statSync 取文件大小，失败给 null —— 内存库/权限问题不该让健康检查整个失败。
   * 副作用：只读；不写库。
   */
  health(): DbHealth {
    let bytes: number | null = null
    try {
      bytes = statSync(this.file).size
    } catch {
      bytes = null
    }
    return {
      driver: this.driver,
      file: this.file,
      userVersion: this.userVersion(),
      tables: this.tableCount(),
      journalMode: this.pragma('journal_mode'),
      synchronous: this.pragma('synchronous'),
      foreignKeys: this.pragma('foreign_keys'),
      bytes,
      queries: this.stats.calls,
      slowQueries: this.stats.slow,
      slowWarnings: this.stats.warn,
      // 保留两位小数，避免面板上出现 0.30000000000000004 这种浮点尾
      maxQueryMs: Math.round(this.stats.maxMs * 100) / 100,
    }
  }

  /**
   * 关闭连接。
   *
   * 先清缓存：语句对象持有连接资源，连接关了再被复用会报「语句已过期」。
   * 吞掉 close 的异常：重复关闭是调用方的正常路径（自检失败 → close → 换驱动），
   * 这里再抛会让「换驱动重试」变成「换驱动也失败」。
   */
  close(): void {
    this.#cache.clear()
    try {
      this.#handle.close()
    } catch {
      /* 已关闭 */
    }
  }
}

/**
 * 把驱动错误翻译成本库的错误码；不认识的原样返回（绝不吞掉）。
 *
 * 为什么只翻译两类：
 * - 约束拒绝 → E_VALIDATION：业务层要能区分「输入不合法」和「数据库挂了」，
 *   前者不该重试，后者应该重试/重开；附带截断到 200 字符的 SQL 便于定位。
 * - 锁超时 → E_DB：等满 busy_timeout 仍然拿不到锁，属于可重试的资源问题。
 * 其余错误（语法错、表不存在）是代码 bug，包一层只会让栈更难读。
 */
function wrapSqliteError(sql: string, error: unknown): unknown {
  const message = errorMessage(error)
  if (/constraint failed|constraint violation|datatype mismatch|NOT NULL/i.test(message)) {
    return new PsycheError(CODE.validation, `数据库约束拒绝：${message}`, { sql: sql.slice(0, 200) })
  }
  if (/database is locked|SQLITE_BUSY/i.test(message)) {
    return new PsycheError(CODE.db, `数据库被占用（等锁超过 ${BUSY_TIMEOUT_MS}ms）：${message}`)
  }
  return error
}

/**
 * 把 library 里的迁移跑到最新版本（幂等：已应用过的按 version 跳过）。
 *
 * 参数：db 已 open 且基础 PRAGMA 已生效；logger 只用于打进度，可为空。
 * 返回：本次实际应用的迁移列表（空数组 = 已是最新）；调用方把它写进打开结果便于上报。
 * 副作用：建表/建索引/建触发器、写 schema_migrations、改 PRAGMA user_version。
 * 事务边界：**每条迁移一个独立事务** —— 一条迁移失败只回滚它自己，
 * 前面的版本保持已提交，重跑时从失败那条继续（历史迁移不许改，所以可安全重跑）。
 * 抛：
 * - E_UNSUPPORTED：库版本比插件新（降级会丢数据，宁可让用户升插件）；
 * - E_VALIDATION / E_DB：迁移 SQL 撞约束或被锁；其余驱动错误原样抛。
 */
export function migrate(db: Db, logger?: DbLogger): AppliedMigration[] {
  const current = db.userVersion()
  // 只前进不后退：能跑旧版插件的代码读不懂新表结构，硬跑只会写坏数据
  if (current > SCHEMA_VERSION) {
    throw new PsycheError(
      CODE.unsupported,
      `记忆库 schema v${current} 比本插件支持的 v${SCHEMA_VERSION} 新，请升级插件而不是降级数据`,
    )
  }
  const applied: AppliedMigration[] = []
  // schema 里的 seed 只声明了它用到的 run，这里做一次窄化桥接（绑定值都是合法标量）
  const seedStore = { run: (sql: string, params?: readonly unknown[]) => db.run(sql, params as readonly SqlParam[]) }
  for (const migration of MIGRATIONS) {
    // 幂等靠版本号比较，不靠「表是否已存在」：后者在半途失败的库上会误判
    if (migration.version <= current) continue
    db.transaction(() => {
      // 整段 SQL 用 exec：迁移里有多个语句，不能走单语句的 run。
      // 顺序固定为 建表 → seed → user_version → 迁移记录，最后一步失败则整笔回滚，不会留下「版本涨了但表没建」的库。
      db.exec(migration.sql)
      migration.seed?.(seedStore, nowIso())
      db.exec(`PRAGMA user_version = ${Number(migration.version)}`)
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        nowIso(),
      ])
    })
    applied.push({ version: migration.version, name: migration.name })
    logger?.info?.(`[psyche] 已应用迁移 v${migration.version} ${migration.name}`)
  }
  return applied
}

/**
 * 五项能力自检：打开 / 外键 / WAL / FTS5 / 备份。
 *
 * 做这件事的动机：驱动有两种（node:sqlite 与 better-sqlite3），
 * 编译选项和版本差异会静默关掉 FTS5 或 WAL。与其等到用户搜索报错，不如开库时验一遍。
 *
 * 返回：{ ok, items, backupMode, journalMode }；ok 是全项合取，
 * items 保留每项 detail（回读到的真实值）作为证据，backupMode/journalMode 直接给 health/上报用。
 * 副作用：会写 connection 设置、在 temp 里建/删探针表、在临时目录写一个探针文件（随后删除）；
 * 不在业务库留下任何数据。
 * 抛：本函数自身不抛（每项各自 try/catch 记成 false）；
 * 但如果连接已经损坏，PRAGMA 会抛到调用方，由 openDatabase 识别成 E_DB_CORRUPT。
 */
export function runSelfCheck(db: Db): SelfCheck {
  const items: SelfCheckItem[] = []
  // 统一出口：detail 一律字符串化，避免非 JSON-safe 的值流到上报里
  const push = (name: string, ok: unknown, detail: unknown): void => {
    items.push({ name, ok: Boolean(ok), detail: String(detail ?? '') })
  }

  // 1 打开 / 基本查询：最新一级的连通性，函数都执行不了就别谈能力了
  try {
    const row = db.get<{ ok: number }>('SELECT 1 AS ok')
    push('open', row?.ok === 1, 'SELECT 1')
  } catch (error) {
    push('open', false, errorMessage(error))
  }

  // 2 外键：不是「设置成功」就算过，必须回读确认 = 1。
  // 某些构建会把 foreign_keys 编成 no-op，那时所有 REFERENCES 都只是装饰。
  try {
    db.exec('PRAGMA foreign_keys = ON')
    const value = Number(db.pragma('foreign_keys'))
    push('foreign_keys', value === 1, `回读 foreign_keys=${value}`)
  } catch (error) {
    push('foreign_keys', false, errorMessage(error))
  }

  // 3 WAL：同样回读；网络盘/某些只读挂载会让 WAL 静默退回 delete 模式，
  // 那种情况下并发读写会互相阻塞，必须让上层知道。
  let journalMode: string | null = null
  try {
    db.exec('PRAGMA journal_mode = WAL')
    journalMode = String(db.pragma('journal_mode') ?? '').toLowerCase()
    push('journal_mode', journalMode === 'wal', `回读 journal_mode=${journalMode}`)
  } catch (error) {
    push('journal_mode', false, errorMessage(error))
  }

  // 4 FTS5（bigram 方案不依赖 unicode61，但必须能建虚拟表并 MATCH）
  // 探针建在 temp 库：业务库一行都不碰，自检失败也不会留下半个索引。
  // 用英文串测是因为它同时覆盖「分词」和「MATCH 语法」两条路径；中文由 bigram 方案在词条层处理。
  try {
    db.exec('CREATE VIRTUAL TABLE temp.psyche_fts_probe USING fts5(bigram_text, raw_text)')
    db.run('INSERT INTO temp.psyche_fts_probe (bigram_text, raw_text) VALUES (?, ?)', ['nihao shijie', '你好世界'])
    const hit = db.get<{ n: number }>(
      'SELECT count(*) AS n FROM temp.psyche_fts_probe WHERE psyche_fts_probe MATCH ?',
      ['nihao'],
    )
    db.exec('DROP TABLE temp.psyche_fts_probe')
    push('fts5', Number(hit?.n) === 1, `MATCH 命中 ${hit?.n ?? 0} 行`)
  } catch (error) {
    push('fts5', false, errorMessage(error))
  }

  // 5 备份能力：原生 backup，否则 VACUUM INTO 兜底（§11.9）
  // 优先原生 backup：它能在一个连接上拍一致性快照，不需要额外事务；
  // 没有就用 VACUUM INTO 往临时目录写一份探针文件，能写出非空文件才算这项能力可用。
  let backupMode: string | null = null
  try {
    if (typeof db.handle.backup === 'function') {
      backupMode = 'native'
      push('backup', true, 'Database#backup')
    } else {
      // 探针名带 pid + 时间戳：并发自检（多进程同开一个库）不会互相覆盖
      const probe = join(tmpdir(), `psyche-backup-probe-${process.pid}-${Date.now()}.sqlite3`)
      try {
        // VACUUM INTO 的路径是字面量，不能绑参；单引号转义是这里唯一的注入防线
        db.exec(`VACUUM INTO '${probe.replace(/'/g, "''")}'`)
        const bytes = statSync(probe).size
        backupMode = 'vacuum-into'
        push('backup', bytes > 0, `VACUUM INTO 产出 ${bytes} 字节`)
      } finally {
        // 探针文件必须删：临时目录不该被健康检查漏下几百 KB 的副本
        try {
          rmSync(probe, { force: true })
        } catch {
          /* 探针文件删不掉不影响结论 */
        }
      }
    }
  } catch (error) {
    push('backup', false, errorMessage(error))
  }

  // ok 是全项合取：任何一项不过都算环境不合格，openDatabase 会因此换驱动或直接失败
  return { ok: items.every((item) => item.ok), items, backupMode, journalMode }
}

/**
 * 打开记忆库：按驱动顺序尝试 → 能力自检 → 迁移。
 * 两个驱动都起不来就直接报错（§11.6：不降级内存库）；损坏库更早一步停下、保留文件。
 *
 * 参数：file 是库文件路径（相对路径由调用方负责解析成绝对路径）；
 * driverPreference='auto' 走 DRIVER_ORDER，指定具体驱动则只用它、失败也不回退。
 * 返回：{ db, driver, selfCheck, attempts, applied } —— db 出来就是「已 PRAGMA + 已迁移」的可用状态，
 * attempts 记录每个候选驱动的失败阶段（open / self-check），便于上报与排查。
 * 副作用：建目录、开文件句柄、改连接 PRAGMA、跑迁移（可能建表）、写 schema_migrations。
 * 抛：
 * - E_DB_CORRUPT：库损坏 —— 立刻停手并保留文件，不换驱动重试（换驱动等于在坏库旁边建个新空库，用户会以为数据丢了）；
 * - E_UNSUPPORTED：库版本比插件新（来自 migrate）；
 * - E_DB：所有候选驱动都失败，detail.attempts 带每轮原因。
 */
export async function openDatabase(options: OpenOptions): Promise<OpenResult> {
  const { file, driverPreference = 'auto', logger, slowQueryMs, slowWarnMs } = options
  // 先建父目录：驱动自己不会递归创建，路径不存在时报的错离真正原因很远
  mkdirSync(dirname(file), { recursive: true })

  const candidates: readonly string[] = driverPreference === 'auto' ? DRIVER_ORDER : [driverPreference]
  const attempts: OpenAttempt[] = []

  for (const driver of candidates) {
    let handle: RawHandle
    try {
      handle = await openRaw(driver, file)
    } catch (error) {
      // 损坏优先级最高：立刻抛，不进 attempts、不试下一个驱动
      if (isCorruption(error)) {
        throw new PsycheError(CODE.dbCorrupt, `记忆库疑似损坏，已停止（文件保留）：${errorMessage(error)}`, {
          file,
        })
      }
      // 普通「这个驱动装不上/不支持」：记一笔，试下一个
      attempts.push({ driver, ok: false, stage: 'open', reason: errorMessage(error) })
      continue
    }

    const db = new Db({ handle, driver, file, logger, slowQueryMs, slowWarnMs })
    let selfCheck: SelfCheck
    try {
      db.applyBasePragmas()
      selfCheck = runSelfCheck(db)
    } catch (error) {
      // 自检阶段才发现损坏也要停：此时句柄已开，先关掉再抛，别泄漏文件锁
      if (isCorruption(error)) {
        db.close()
        throw new PsycheError(CODE.dbCorrupt, `记忆库疑似损坏，已停止（文件保留）：${errorMessage(error)}`, {
          file,
        })
      }
      // 非损坏异常（如某条 PRAGMA 不被支持）当成「这项自检不过」，交给下面统一的失败分支
      selfCheck = {
        ok: false,
        items: [{ name: 'self-check', ok: false, detail: errorMessage(error) }],
        backupMode: null,
        journalMode: null,
      }
    }

    if (!selfCheck.ok) {
      db.close()
      // 把失败项拼成一行：换驱动后如果也失败，最终错误里能同时看到两条原因
      attempts.push({
        driver,
        ok: false,
        stage: 'self-check',
        reason: selfCheck.items
          .filter((item) => !item.ok)
          .map((item) => `${item.name}: ${item.detail}`)
          .join('; '),
      })
      continue
    }

    // 迁移放在自检之后：能力不全的驱动不该有机会动库结构
    const applied = migrate(db, logger)
    attempts.push({ driver, ok: true, stage: 'ready', reason: '' })
    return { db, driver, selfCheck, attempts, applied }
  }

  // 全部候选失败：把每轮原因带上，否则用户只能看到「打不开」
  throw new PsycheError(
    CODE.db,
    `没有可用的 SQLite 驱动：${attempts.map((item) => `${item.driver}(${item.reason})`).join(' / ')}`,
    { attempts, file },
  )
}
