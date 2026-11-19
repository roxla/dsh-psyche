// 只读看一眼宿主真实库：确认启动是否成功、失败操作里记了什么错误。
// 只开 readOnly，绝不写宿主的真实数据。
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'psyche', 'memory.sqlite3')
console.log('db file =', file, 'exists =', existsSync(file))
if (!existsSync(file)) process.exit(0)

const db = new DatabaseSync(file, { readOnly: true })
const q = (sql, ...args) => db.prepare(sql).all(...args)

console.log('user_version =', db.prepare('PRAGMA user_version').get())
console.log('journal_mode =', db.prepare('PRAGMA journal_mode').get())
console.log(
  'tables =',
  q("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'fts_index_%'"),
  '(含 FTS5 影子表共',
  q("SELECT count(*) AS n FROM sqlite_master WHERE type='table'"),
  ')',
)

console.log('migrations =', JSON.stringify(q('SELECT * FROM schema_migrations')))
console.log('persona_config =', JSON.stringify(q('SELECT persona_id, type, identity_path FROM persona_config')))
console.log('phase_state =', JSON.stringify(q('SELECT persona_id, phase FROM phase_state')))

const ops = q(
  `SELECT op_id, tool, status, error, duration_ms, created_at
     FROM operations ORDER BY created_at DESC LIMIT 20`,
)
console.log('operations =', JSON.stringify(ops, null, 2))
db.close()
