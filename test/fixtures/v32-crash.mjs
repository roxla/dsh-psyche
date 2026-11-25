// 故障注入夹具：模拟「迁移 32 建了第一批表、还没提交就被强杀」。
//
// 直接走 better-sqlite3，绕开 adapter 的自动迁移（openDatabase 一打开就会把库补到最新，
// 那样根本造不出「中途崩溃」的状态）。由 test/project-handoff.ts 用子进程调用。
import Database from 'better-sqlite3'

const file = process.argv[2]
const db = new Database(file)
db.pragma('journal_mode = WAL')
db.exec('BEGIN IMMEDIATE')
db.exec(`
CREATE TABLE projects (
  project_id    TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL
);
CREATE TABLE project_session_bindings (
  binding_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL
);
`)
// 提交前强杀：让 SQLite 在下次打开时回滚这笔半成品。
process.kill(process.pid, 'SIGKILL')
