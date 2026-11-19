// B3-3 宿主验收只读查询：Mood 写入回执与当前值。
// 用法：node tools/b3-3-mood-inspect.mjs [sqlite 路径]
// 默认读取 B3-3 临时 profile 的数据目录（不碰真实用户库）。
import Database from 'better-sqlite3'

const file = process.argv[2] ?? 'D:/project/psyche/.tmp-b33-data/memory.sqlite3'
const db = new Database(file, { readonly: true })
const ops = db
  .prepare('SELECT op_id, reason, at FROM global_mood_history WHERE op_id IS NOT NULL ORDER BY rowid')
  .all()
console.log('ops', ops.length)
for (const o of ops.slice(-6)) console.log(' ', o.op_id, '|', o.reason, '|', o.at)
const top = db
  .prepare('SELECT dimension, value, updated_at FROM global_mood_state ORDER BY value DESC LIMIT 8')
  .all()
console.log('top', top)
console.log('meta', db.prepare('SELECT * FROM mood_meta').all())
