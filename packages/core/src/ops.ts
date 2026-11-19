// 运维数据面：日志环形缓冲、操作审计、备份、计数（少数会碰文件与数据库的 lib 模块）。
//
// 三条约定的来源：
//   1. **日志**是内存里最近 N 条，不落盘——它是「刚才发生了什么」的窗口，不是审计。
//      要查更早的，看库里的 `operations`。
//   2. **备份**用 `VACUUM INTO` 写临时文件再原子改名；中途失败不会留下半个可用文件。
//   3. 所有会动文件或数据库的动作，都返回一条人能读的结果（bytes / 路径 / 影响行数），
//      不返回「OK」这种不可验证的东西。调用方：index.ts 的运维快照接口。

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, DbHealth, Row, SqlParam } from './adapter.js';
import { nowIso } from './adapter.js';

/** 日志级别（从低到高：debug < info < warn < error）。数值权重见 `LEVEL_WEIGHT`。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 一条运行日志。`at` 是 ISO 时间串（本地显示时才转格式），`scope` 是模块名。 */
export interface LogEntry {
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
}

/** 级别到权重的映射，用来做「下限过滤」；不要改成字符串比较（'debug' < 'info' 只是巧合）。 */
const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * `OpLogger` 的构造参数。
 *
 * `limit` 会夹到 20–5000（默认 300）：太小会丢现场，太大等于没上限；
 * `minLevel` 低于它的日志直接丢弃（默认 debug = 全收）；`now` 供测试注入时钟。
 */
export interface OpLoggerOptions {
  /** 最多保留多少条；超出丢最早的。 */
  limit?: number;
  /** 低于这个级别的不收（默认 debug，全收）。 */
  minLevel?: LogLevel;
  /** 便于测试注入。 */
  now?: () => string;
}

/**
 * 内存环形缓冲。
 *
 * 用数组 + `shift()` 而不是真环，是因为 N 只有几百，读的时候还要按级别过滤；
 * 真环会让过滤变复杂而没有任何收益。超过 limit 时一次丢 1/4，摊掉 shift 的成本。
 *
 * 不变量：`#items.length <= limit` 永远成立；`clear()` 是唯一会清空它的入口。
 */
export class OpLogger {
  readonly limit: number;
  readonly minLevel: LogLevel;
  readonly #now: () => string;
  #items: LogEntry[] = [];

  constructor(options: OpLoggerOptions = {}) {
    this.limit = Math.max(20, Math.min(5000, Math.round(options.limit ?? 300)));
    this.minLevel = options.minLevel ?? 'debug';
    this.#now = options.now ?? nowIso;
  }

  /**
   * 记一条日志。
   *
   * 参数：`level` 级别（低于 `minLevel` 直接丢弃）；`scope` 模块名，截断到 40 字符；
   * `message` 正文，截断到 600 字符（防止一条巨大对象把缓冲撑爆）；`at` 可注入时间。
   * 副作用：入队；超限时一次丢掉最早的 1/4（至少 1 条）。
   */
  push(level: LogLevel, scope: string, message: string, at?: string): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return;
    this.#items.push({
      at: at ?? this.#now(),
      level,
      scope: String(scope ?? 'psyche').slice(0, 40),
      message: String(message ?? '').slice(0, 600)
    });
    if (this.#items.length > this.limit) {
      // 一次丢 1/4 而不是每条 shift：批量丢弃把 O(n) 的搬移摊薄，代价是峰值多出 25% 条。
      this.#items.splice(0, Math.max(1, Math.floor(this.limit / 4)));
    }
  }

  /** debug 级快捷入口。 */
  debug(scope: string, message: string): void {
    this.push('debug', scope, message);
  }

  /** info 级快捷入口。 */
  info(scope: string, message: string): void {
    this.push('info', scope, message);
  }

  /** warn 级快捷入口。 */
  warn(scope: string, message: string): void {
    this.push('warn', scope, message);
  }

  /** error 级快捷入口。 */
  error(scope: string, message: string): void {
    this.push('error', scope, message);
  }

  /**
   * 最新在后；`level` 是下限（'warn' 表示只看 warn + error）。
   *
   * 参数：`limit` 取最后几条（缺省 = 过滤后全部，至少 1）；返回新数组，调用方改动不影响缓冲。
   */
  entries(options: { limit?: number; level?: LogLevel } = {}): LogEntry[] {
    const floor = LEVEL_WEIGHT[options.level ?? 'debug'];
    const picked = this.#items.filter((item) => LEVEL_WEIGHT[item.level] >= floor);
    const limit = Math.max(1, Math.round(options.limit ?? picked.length));
    return picked.slice(Math.max(0, picked.length - limit));
  }

  /**
   * 计数。不给 `level` 时是总条数；给了就是「不低于该级别」的条数（与 `entries` 同口径）。
   */
  count(level?: LogLevel): number {
    if (!level) return this.#items.length;
    const floor = LEVEL_WEIGHT[level];
    return this.#items.filter((item) => LEVEL_WEIGHT[item.level] >= floor).length;
  }

  /** 清空缓冲，返回清掉的条数（这个返回值界面上要显示，不能只返回 void）。 */
  clear(): number {
    const removed = this.#items.length;
    this.#items = [];
    return removed;
  }
}

/** 审计表 `operations` 的一行（只追加，见文件末尾的说明）。`error` 成功时为 null。 */
export interface OperationRow {
  opId: string;
  tool: string;
  status: string;
  durationMs: number;
  error: string | null;
  createdAt: string;
}

/** 备份目录里的一个文件。`at` 优先取文件名里的时间戳（比 mtime 可靠），`bytes` 是落的实际大小。 */
export interface BackupFile {
  file: string;
  bytes: number;
  at: string;
}

/** 六张核心表的行数快照（运维页的「记忆规模」）。缺表会让 `scalar` 抛错，由 `buildOps` 兜住。 */
export interface OpsCounters {
  sources: number;
  events: number;
  artifacts: number;
  artifactRevisions: number;
  operations: number;
  phaseMilestones: number;
}

/**
 * 运维页一次渲染要的全部数据。
 *
 * `ok:false` 也保证结构完整（空数组 / null），所以前端可以直接渲染，不需要先判空；
 * `note` 是给人看的一句话原因。
 */
export interface OpsPayload {
  ok: boolean;
  at: string;
  health: DbHealth | null;
  counters: OpsCounters | null;
  operations: {
    recent: OperationRow[];
    failures: OperationRow[];
    slow: OperationRow[];
    total: number;
    failed: number;
    slowCount: number;
  };
  logs: LogEntry[];
  logCounts: { total: number; warn: number; error: number };
  backups: BackupFile[];
  note: string;
}

/**
 * 取一个标量计数（`SELECT COUNT(*)` 之类）。
 *
 * 参数：`db` 连接、`sql` 语句、`params` 绑定参数（不拼串）。
 * 返回：第一列转成数字；查不到行 / 转不出数就给 0（计数场景里 0 比 NaN 安全）。
 */
function scalar(db: Db, sql: string, params?: readonly SqlParam[]): number {
  const row = db.get<Row>(sql, params);
  if (!row) return 0;
  const first = Object.values(row)[0];
  return Number(first) || 0;
}

/** 把数据库行规范成 `OperationRow`：字段缺失给空串 / 0，`error` 的 null 与 undefined 都归成 null。 */
function operationRows(rows: Row[]): OperationRow[] {
  return rows.map((row) => ({
    opId: String(row.op_id ?? ''),
    tool: String(row.tool ?? ''),
    status: String(row.status ?? ''),
    durationMs: Number(row.duration_ms) || 0,
    error: row.error === null || row.error === undefined ? null : String(row.error),
    createdAt: String(row.created_at ?? '')
  }));
}

/** 三处查询共用的列清单，避免 `SELECT *` 把新加的列带到界面层。 */
const OPERATION_COLUMNS = 'op_id, tool, status, duration_ms, error, created_at';

/**
 * 读操作审计：最近 N 条、失败 N 条、慢查询 N 条 + 三个总数。
 *
 * 参数：`limit` 会夹到 1–200（默认 30）；`slowQueryMs` 是慢查询阈值（默认 50ms，至少 1）。
 * 返回：`OpsPayload['operations']`；同一个 `limit` 用于三个列表，界面上三栏高度一致。
 * 边界：`slow` 按耗时降序（最先看到最慢的），另两个按时间降序。
 */
export function readOperations(
  db: Db,
  options: { limit?: number; slowQueryMs?: number } = {}
): OpsPayload['operations'] {
  const limit = Math.max(1, Math.min(200, Math.round(options.limit ?? 30)));
  const slowMs = Math.max(1, Math.round(options.slowQueryMs ?? 50));
  const recent = operationRows(
    db.all<Row>(`SELECT ${OPERATION_COLUMNS} FROM operations ORDER BY created_at DESC, rowid DESC LIMIT ?`, [limit])
  );
  // 失败 = status <> 'ok'：将来加新状态（如 'partial'）时也自动算进失败侧，不会漏。
  const failures = operationRows(
    db.all<Row>(
      `SELECT ${OPERATION_COLUMNS} FROM operations WHERE status <> 'ok' ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      [limit]
    )
  );
  const slow = operationRows(
    db.all<Row>(
      `SELECT ${OPERATION_COLUMNS} FROM operations WHERE duration_ms >= ? ORDER BY duration_ms DESC, created_at DESC LIMIT ?`,
      [slowMs, limit]
    )
  );
  return {
    recent,
    failures,
    slow,
    total: scalar(db, 'SELECT COUNT(*) AS n FROM operations'),
    failed: scalar(db, `SELECT COUNT(*) AS n FROM operations WHERE status <> 'ok'`),
    slowCount: scalar(db, 'SELECT COUNT(*) AS n FROM operations WHERE duration_ms >= ?', [slowMs])
  };
}

/**
 * 六张表的行数。
 *
 * 参数 `db`：连接。返回：`OpsCounters`。任何一张表不存在会抛错——由 `buildOps` 的统一 catch 兜成
 * `ok:false`，这里不吞异常，否则界面上只是「全部 0」，看起来像库空了。
 */
export function readCounters(db: Db): OpsCounters {
  return {
    sources: scalar(db, 'SELECT COUNT(*) AS n FROM sources'),
    events: scalar(db, 'SELECT COUNT(*) AS n FROM events'),
    artifacts: scalar(db, 'SELECT COUNT(*) AS n FROM artifacts'),
    artifactRevisions: scalar(db, 'SELECT COUNT(*) AS n FROM artifact_revisions'),
    operations: scalar(db, 'SELECT COUNT(*) AS n FROM operations'),
    phaseMilestones: scalar(db, 'SELECT COUNT(*) AS n FROM phase_milestones')
  };
}

/**
 * 备份目录里已有的文件，最新在前。
 *
 * 参数：`dataDir` 数据根目录（下面固定找 `backups/`）；`limit` 最多返回几个（默认 10）。
 * 返回：`BackupFile[]`，按 `at` 降序。边界：
 * - 只认 `.sqlite3` 结尾（`.tmp` 半成品不会被列出来）；
 * - 单个文件 stat 失败就跳过，不让整个列表失败；
 * - 目录不存在返回空数组，不抛。
 */
export function listBackups(dataDir: string, limit = 10): BackupFile[] {
  const dir = join(dataDir, 'backups');
  if (!existsSync(dir)) return [];
  const out: BackupFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.sqlite3')) continue;
    const file = join(dir, name);
    try {
      const stat = statSync(file);
      // 文件名里的时间戳（memory-20261101-221530.sqlite3）比 mtime 更可靠
      const matched = /memory-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
      const at = matched
        ? `${matched[1]}-${matched[2]}-${matched[3]} ${matched[4]}:${matched[5]}:${matched[6]}`
        : new Date(stat.mtimeMs).toISOString();
      out.push({ file, bytes: stat.size, at });
    } catch {
      // 正在被删/被占用：跳过，不让备份列表整个失败
    }
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out.slice(0, limit);
}

/** 一次备份的结果。`bytes` 是改名后文件的真实大小，人可以拿它判断「是不是空的」。 */
export interface BackupResult {
  ok: boolean;
  file: string;
  bytes: number;
  at: string;
  durationMs: number;
}

/**
 * `VACUUM INTO` 备份。
 *
 * 为什么不是 `db.backup()`：本机 node:sqlite 的 DatabaseSync 没有 backup；
 * 为什么先写 `.tmp` 再改名：中途失败时目录里不会出现一个「看起来能用」的半个库。
 *
 * 参数：`db` 连接；`dataDir` 数据根目录；`options.now` 注入时间（决定文件名，测试用）。
 * 返回：`BackupResult`。失败会抛（磁盘满 / 无权限），由调用方转成人能读的错误。
 */
export function backupDatabase(db: Db, dataDir: string, options: { now?: Date } = {}): BackupResult {
  const startedAt = Date.now();
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  // 文件名模板：memory-20261101-221530.sqlite3。先去掉 ISO 里的 '-' 与 ':'，把 'T' 换成 '-',
  // 再截到第 15 位——正好留下 YYYYMMDD-HHMMSS，既人能读又能按字典序排序。
  const stamp = (options.now ?? new Date())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  const file = join(dir, `memory-${stamp}.sqlite3`);
  const temp = `${file}.tmp`;
  rmSync(temp, { force: true });
  // VACUUM INTO 的目标路径是 SQL 字符串字面量，单引号要转义成两个单引号（路径里可能有撇号）。
  db.exec(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
  // 同一分区内的 rename 是原子的：要么看到完整备份，要么根本看不到这个文件。
  renameSync(temp, file);
  const bytes = statSync(file).size;
  return { ok: true, file, bytes, at: nowIso(), durationMs: Date.now() - startedAt };
}

// 注意：operations 表是**只追加**的（schema 里有 trg_operations_no_delete 触发器），
// 故意不提供「清空操作记录」——审计留痕就是它的用途，删不掉是设计而不是缺陷。
// 运行日志（OpLogger 的环形缓冲）是内存里的，可以清，两者别混为一谈。

/**
 * `buildOps` 的入参。
 *
 * `db` 允许为 null（插件没初始化好时也要能打开运维页）；`logLimit` 夹 1–500，默认 80；
 * `note` 会原样带到结果里，用于解释「为什么这次数据不全」。
 */
export interface BuildOpsInput {
  db: Db | null;
  logger: OpLogger;
  dataDir: string;
  slowQueryMs?: number;
  logLimit?: number;
  note?: string;
}

/**
 * 组装一次运维快照。数据库不可用时也返回可渲染的结果，而不是抛错。
 *
 * 参数：见 `BuildOpsInput`。返回：`OpsPayload`（三条失败路径都保证结构完整）：
 * - `db` 为 null → `ok:false`、`note` 说明未就绪，日志与备份照常给；
 * - 查询抛错 → `ok:false`、`note` 带错误原文，其余字段同上；
 * - 正常 → `ok:true`，附健康度、计数、操作列表。
 */
export function buildOps(input: BuildOpsInput): OpsPayload {
  const at = nowIso();
  const logLimit = Math.max(1, Math.min(500, Math.round(input.logLimit ?? 80)));
  // 日志与备份先算：它们不依赖数据库，库挂了这两块也照常能显示。
  const base = {
    ok: true,
    at,
    logs: input.logger.entries({ limit: logLimit }),
    logCounts: {
      total: input.logger.count(),
      warn: input.logger.count('warn'),
      error: input.logger.count('error')
    },
    backups: listBackups(input.dataDir),
    note: input.note ?? ''
  };
  const { db } = input;
  if (!db) {
    return {
      ...base,
      ok: false,
      health: null,
      counters: null,
      operations: { recent: [], failures: [], slow: [], total: 0, failed: 0, slowCount: 0 },
      note: input.note ? `${input.note}（数据库未就绪）` : '数据库未就绪'
    };
  }
  try {
    return {
      ...base,
      health: db.health(),
      counters: readCounters(db),
      operations: readOperations(db, { limit: 30, slowQueryMs: input.slowQueryMs })
    };
  } catch (error) {
    // 任何查询失败都退回空结构 + 原因：运维页自己不能因为读库失败而白屏。
    return {
      ...base,
      ok: false,
      health: null,
      counters: null,
      operations: { recent: [], failures: [], slow: [], total: 0, failed: 0, slowCount: 0 },
      note: `读取运维数据失败：${error instanceof Error ? error.message : String(error)}`
    };
  }
}
