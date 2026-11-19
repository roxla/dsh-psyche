// CRASH 强杀夹具：在写事务的指定阶段停住，等父进程用 taskkill /F 杀掉。
// 这些阶段故意用原始 SQL 复现 Core 写事务的关键边界（BEGIN / 插 revision / 动 FTS /
// 改旧版本状态 / COMMIT 之后），这样「事务未提交」和「事务已提交」的行为都能被测到，
// 而不是靠抛异常模拟。
//
// 参数：mode dbFile readyFile
// 约定：写完 readyFile 后最长等 60 秒，等父进程强杀。
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const [mode, dbFile, readyFile] = process.argv.slice(2)
const handle = new DatabaseSync(dbFile)
handle.exec('PRAGMA journal_mode = WAL')
handle.exec('PRAGMA busy_timeout = 5000')

const AT = '2026-11-02T00:00:00.000Z'

function mark() {
  writeFileSync(readyFile, JSON.stringify({ mode, at: Date.now() }))
}

function hold() {
  // 忙等：不引入定时器，保证进程停在当前调用栈里被强杀
  const buffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buffer), 0, 0, 60_000)
}

function insertRevision(artifactId, revision, state, statement, disclosure = 'restricted', opId = null) {
  handle
    .prepare(
      `INSERT INTO artifact_revisions (artifact_id, revision, state, statement, subject_refs, payload, confidence,
         basis_count, independent_evidence_count, salience, temporal, direct_extraction, created_at, updated_at,
         disclosure, op_id, schema_version)
       VALUES (?, ?, ?, ?, '["main"]', '{}', 'medium', 1, 1, 0.5, '{}', 0, ?, ?, ?, ?, '1.0')`,
    )
    .run(artifactId, revision, state, statement, AT, AT, disclosure, opId)
}

switch (mode) {
  case 'after-begin':
    handle.exec('BEGIN IMMEDIATE')
    mark()
    hold()
    break

  case 'after-revision':
    handle.exec('BEGIN IMMEDIATE')
    insertRevision('art_crash', 2, 'active', '崩溃夹具新增的版本。')
    mark()
    hold()
    break

  case 'after-fts-delete':
    handle.exec('BEGIN IMMEDIATE')
    handle.prepare(`DELETE FROM fts_index WHERE ref_id = ?`).run('art_crash')
    mark()
    hold()
    break

  case 'after-fts-insert':
    handle.exec('BEGIN IMMEDIATE')
    handle
      .prepare(`INSERT INTO fts_index (kind, ref_id, bigram_text, raw_text) VALUES ('artifact', 'art_crash_ghost', '幽灵', '幽灵行')`)
      .run()
    mark()
    hold()
    break

  case 'after-superseded':
    handle.exec('BEGIN IMMEDIATE')
    insertRevision('art_crash', 2, 'superseded', '崩溃夹具把旧版本改成 superseded。')
    mark()
    hold()
    break

  case 'after-commit':
    handle.exec('BEGIN IMMEDIATE')
    insertRevision('art_crash', 2, 'active', '崩溃夹具已提交的版本。', 'public', 'crash-op-1')
    handle
      .prepare(
        `INSERT INTO operations (op_id, persona_id, tool, args_hash, status, result, duration_ms, source, created_at, finished_at)
         VALUES ('crash-op-1', 'main', 'psyche_remember', 'crash-hash', 'ok', '{"artifactId":"art_crash"}', 1, 'tool', ?, ?)`,
      )
      .run(AT, AT)
    handle.exec('COMMIT')
    mark()
    hold()
    break

  case 'rebuild-mid':
    // 模拟 rebuild 的「先清空、再逐行写回」中途被杀：清空后只写回一行
    handle.exec('BEGIN IMMEDIATE')
    handle.prepare(`DELETE FROM fts_index`).run()
    handle
      .prepare(`INSERT INTO fts_index (kind, ref_id, bigram_text, raw_text) VALUES ('artifact', 'art_crash', '崩溃', '崩溃夹具正文')`)
      .run()
    mark()
    hold()
    break

  case 'forget-mid':
    handle.exec('BEGIN IMMEDIATE')
    insertRevision('art_crash', 2, 'forgotten', '崩溃夹具写入遗忘版本但未提交。')
    mark()
    hold()
    break

  default:
    throw new Error(`未知模式：${mode}`)
}
