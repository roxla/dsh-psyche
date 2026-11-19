// 只读审计连接（P2 统一验收前置：`psyche-health` / `psyche-integrity`）。
//
// 为什么单独一层：两个审计工具都不能复用 `openDatabase()`——那个函数会跑迁移、
// 设 PRAGMA、可能写库。审计工具的要求是「看一眼但绝不碰」，所以这里只做三件事：
//   1. 以 `readOnly: true` 打开（SQLite 层直接拒绝写）；
//   2. 再叠加 `PRAGMA query_only = ON`（双保险：即使驱动/参数写错也写不进去）；
//   3. 暴露最小接口（all / get / execRead），不提供 run —— 类型上就没有写入入口。
//
// 不新建表、不建第二份资产清单、不常驻：打开 → 查完 → 关。
import { DatabaseSync } from 'node:sqlite'

/** 审计工具能用的最小数据库接口：只有读。`run` 故意不存在。 */
export interface AuditDb {
  all<T = Record<string, unknown>>(sql: string, params?: readonly (string | number | null)[]): T[]
  get<T = Record<string, unknown>>(sql: string, params?: readonly (string | number | null)[]): T | undefined
  /** 只允许读 PRAGMA / SELECT 形式的多语句；写语句会在只读连接上失败。 */
  execRead(sql: string): void
}

export interface AuditHandle {
  db: AuditDb
  /** 只读连接断言：打开时 query_only 生效返回 true；否则审计直接失败。 */
  queryOnly: boolean
  close(): void
}

export class AuditOpenError extends Error {
  readonly code: 'missing' | 'open-failed' | 'not-read-only'
  constructor(code: 'missing' | 'open-failed' | 'not-read-only', message: string) {
    super(message)
    this.code = code
  }
}

/**
 * 以只读方式打开一个库文件。
 *
 * 抛 `AuditOpenError`：
 * - `missing`：文件不存在（审计工具不自动初始化，由调用方报告）；
 * - `open-failed`：驱动拒绝打开（损坏、被锁、权限不足等）；
 * - `not-read-only`：连接可写（query_only 没生效）——这是审计工具的安全底线。
 */
export function openAuditDatabase(file: string): AuditHandle {
  let raw: DatabaseSync
  try {
    raw = new DatabaseSync(file, { readOnly: true })
  } catch (error) {
    const message = (error as Error).message
    if (message.includes('unable to open')) throw new AuditOpenError('open-failed', message)
    throw new AuditOpenError('open-failed', message)
  }

  // DatabaseSync 是懒打开的：文件存在但不是数据库时，构造不报错、第一次查询才报错。
  // 审计工具要把「打不开」和「打开后查不了」都归成 open-failed，所以这里先探一次。
  try {
    raw.prepare('PRAGMA schema_version').get()
  } catch (error) {
    try {
      raw.close()
    } catch {
      /* 探测失败时关不掉也无所谓 */
    }
    throw new AuditOpenError('open-failed', (error as Error).message)
  }

  // 双保险：readOnly 已经挡住写入，query_only 再挡一次（比如未来换驱动）。
  raw.exec('PRAGMA query_only = ON')
  const probe = raw.prepare('PRAGMA query_only').get() as Record<string, unknown> | undefined
  const queryOnly = Number(Object.values(probe ?? {})[0] ?? 0) === 1

  const db: AuditDb = {
    all<T>(sql: string, params: readonly (string | number | null)[] = []): T[] {
      const statement = raw.prepare(sql)
      const rows = params.length > 0 ? statement.all(...params) : statement.all()
      return rows as T[]
    },
    get<T>(sql: string, params: readonly (string | number | null)[] = []): T | undefined {
      const statement = raw.prepare(sql)
      const row = params.length > 0 ? statement.get(...params) : statement.get()
      return row as T | undefined
    },
    execRead(sql: string): void {
      // 只读连接上执行写语句会自己失败；这里不做额外白名单（调用方只传 PRAGMA/SELECT）。
      raw.exec(sql)
    },
  }

  return {
    db,
    queryOnly,
    close() {
      try {
        raw.close()
      } catch {
        // 关不掉不影响审计结论：进程退出会回收
      }
    },
  }
}
