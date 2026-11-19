// E6-C1 强杀辅助：在事务中途挂起，等待父进程 taskkill /F。
// 参数：argv[2] = JSON { file, artifactId, kind, statement, ready }
// 用法：父进程 spawn 后等 ready 文件出现，再 taskkill /F。
import { existsSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const cfg = JSON.parse(process.argv[2])
const handle = new DatabaseSync(cfg.file)
handle.exec('PRAGMA journal_mode = WAL')
handle.exec('PRAGMA busy_timeout = 5000')

const next = handle
  .prepare(
    `SELECT COALESCE(MAX(value), 0) + 1 AS next FROM (
       SELECT MAX(row_id) AS value FROM fts_rowids
       UNION ALL
       SELECT MAX(rowid) AS value FROM fts_index
     )`,
  )
  .get()
const rowId = Number(next.next)

handle.exec('BEGIN IMMEDIATE')
handle
  .prepare('INSERT INTO fts_index (rowid, kind, ref_id, bigram_text, raw_text) VALUES (?, ?, ?, ?, ?)')
  .run(rowId, cfg.kind, cfg.artifactId, '崩溃 溃测 测试', cfg.statement)
handle
  .prepare('INSERT INTO fts_rowids (kind, ref_id, row_id) VALUES (?, ?, ?)')
  .run(cfg.kind, cfg.artifactId, rowId)

writeFileSync(cfg.ready, String(rowId), 'utf8')

// 停住：等父进程强杀；不提交、不回滚。
const deadline = Date.now() + 60000
while (Date.now() < deadline && existsSync(cfg.ready)) {
  await new Promise((resolve) => setTimeout(resolve, 50))
}
handle.exec('ROLLBACK')
handle.close()
