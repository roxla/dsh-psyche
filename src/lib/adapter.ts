// adapter.ts 的唯一实现已搬进 packages/core/src/adapter.ts（D1-2b）。
// 这里只做 re-export，不再保留 SQLite 驱动适配的第二份实现。
export {
  Db,
  migrate,
  nowIso,
  openDatabase,
  runSelfCheck,
} from 'dsh-psyche-core'
export type {
  AppliedMigration,
  DatabaseDriver,
  DbHealth,
  DbLogger,
  DbStats,
  OpenAttempt,
  OpenOptions,
  OpenResult,
  Row,
  SelfCheck,
  SelfCheckItem,
  SlowQuerySample,
  SqlParam,
  SqlParams,
} from 'dsh-psyche-core'
