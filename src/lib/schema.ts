// schema.ts 的唯一实现已搬进 packages/core/src/schema.ts（D1-2b）。
// 这里只做 re-export，不再保留表结构 / 迁移 SQL 的第二份实现。
export {
  SCHEMA_VERSION,
  MIGRATIONS,
  EXPECTED_TABLE_COUNT,
} from 'dsh-psyche-core'
export type { Migration, MigrationSqlStore } from 'dsh-psyche-core'
