// Mood 并发子进程：两个独立连接同时 applyMood，验证 BEGIN IMMEDIATE 串行化不丢更新。
// 用法：node mood-child.mjs <dbFile> <opId> <calmDelta> <readyFile> <barrierFile> <resultFile>
import { writeFileSync, existsSync } from 'node:fs'
import { openDatabase } from '../../packages/core/dist/adapter.js'
import { applyMood } from '../../packages/core/dist/mood-store.js'

const [file, opId, deltaText, readyFile, barrierFile, resultFile] = process.argv.slice(2)
if (!file || !opId || !deltaText || !readyFile || !barrierFile || !resultFile) {
  console.error('usage: mood-child.mjs <dbFile> <opId> <calmDelta> <readyFile> <barrierFile> <resultFile>')
  process.exit(2)
}

writeFileSync(readyFile, 'ready')
const deadline = Date.now() + 15000
while (!existsSync(barrierFile)) {
  if (Date.now() > deadline) {
    console.error('barrier timeout')
    process.exit(3)
  }
  const until = Date.now() + 20
  while (Date.now() < until) {
    /* spin */
  }
}

const opened = await openDatabase({ file })
try {
  const result = applyMood(opened.db, {
    opId,
    deltas: { calm: Number(deltaText) },
    reason: 'concurrency-test',
    now: '2026-01-05T00:00:00.000Z',
  })
  writeFileSync(resultFile, JSON.stringify({ ok: true, applied: result.applied, replayed: result.replayed, stateVersion: result.stateVersion }))
} catch (error) {
  writeFileSync(resultFile, JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }))
} finally {
  opened.db.close()
}
