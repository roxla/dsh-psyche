// dbcheck.ts 的唯一实现已搬进 packages/core/src/dbcheck.ts（D1-2b）。
// 这里只做 re-export；结构级校验逻辑不再保留第二份实现。
export {
  REQUIRED_INDEXES_V1,
  REQUIRED_INDEXES_V2_ONLY,
  REQUIRED_TABLES,
  REQUIRED_TABLES_V1,
  REQUIRED_TABLES_V2_ONLY,
  REQUIRED_TRIGGERS,
  TABLE_ALIASES,
  checkDatabaseFile,
} from 'dsh-psyche-core'
export type { DbCheckFacts, DbCheckResult } from 'dsh-psyche-core'
