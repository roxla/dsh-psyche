// 并发 revise 的子进程：写 ready → 等 barrier → 基于 expectedRevision 改同一结论 → 写结果。
//
// 用法：node revise-child.mjs <dbFile> <dataDir> <artifactId> <expectedRevision> <statement> <barrier> <result>
import { writeFileSync, existsSync } from 'node:fs'
import { openDatabase } from '../../dist/lib/adapter.js'
import { Core } from '../../dist/lib/store.js'

const [dbFile, dataDir, artifactId, expectedRevision, statement, barrier, result] = process.argv.slice(2)
const log = { info() {}, debug() {}, warn() {}, error() {} }

writeFileSync(`${result}.ready`, 'ready')

async function waitFor(path, timeoutMs = 15000) {
  const started = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${path}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

try {
  await waitFor(barrier)
  const opened = await openDatabase({ file: dbFile, driverPreference: 'auto', logger: log })
  const core = new Core({ db: opened.db, config: {}, logger: log, dataDir })
  try {
    const payload = await core.revise({
      artifactId,
      statement,
      refs: ['topic:concurrent'],
      expectedRevision: Number(expectedRevision),
    })
    writeFileSync(
      result,
      JSON.stringify({ ok: true, revision: payload.revision, statement: payload.statement ?? statement }),
    )
  } catch (error) {
    writeFileSync(result, JSON.stringify({ ok: false, code: error?.code ?? null, message: String(error?.message ?? error) }))
  } finally {
    opened.db.close()
  }
} catch (error) {
  writeFileSync(result, JSON.stringify({ ok: false, code: error?.code ?? null, message: String(error?.message ?? error) }))
}
