// IDEM-05 的双进程 helper：两个子进程用同一个 opId + 同一个 payload 抢 remember。
// 期望：恰好一个真正提交（replayed=false），另一个读 operations 重放（replayed=true），
// 两个拿到的 artifactId 相同，库里只有一条 Artifact。
//
// 参数：dbFile opId barrierPath resultPath
// 约定：先写 resultPath.ready，等 barrierPath 出现后起跑（与 capture-child.mjs 同模式）。
import { writeFileSync, existsSync } from 'node:fs'
import { openDatabase } from '../../dist/lib/adapter.js'
import { Core } from '../../dist/lib/store.js'

const [dbFile, opId, barrierPath, resultPath, sourceIdsJson] = process.argv.slice(2)
const resultFile = `${resultPath}.json`

const log = { info() {}, debug() {}, warn() {}, error() {} }
const sourceIds = JSON.parse(sourceIdsJson ?? '[]')

async function main() {
  writeFileSync(`${resultPath}.ready`, 'ready')
  const started = Date.now()
  while (!existsSync(barrierPath)) {
    if (Date.now() - started > 15000) throw new Error('等 barrier 超时')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  const opened = await openDatabase({ file: dbFile, driverPreference: 'auto', logger: log })
  const core = new Core({ db: opened.db, config: {}, logger: log, dataDir: '' })
  try {
    const result = await core.remember({
      text: '两个进程同时提交的同一条幂等测试。',
      kind: 'fact',
      statement: '用户测试过双进程幂等提交。',
      sourceIds,
      confidence: 'high',
      disclosure: 'public',
      opId,
    })
    writeFileSync(resultFile, JSON.stringify({ ok: true, artifactId: result.artifactId, replayed: result.replayed }))
  } catch (error) {
    writeFileSync(
      resultFile,
      JSON.stringify({ ok: false, code: error?.code ?? null, message: error?.message ?? String(error) }),
    )
  } finally {
    try {
      opened.db.close()
    } catch {
      // ignore
    }
  }
}

main().catch((error) => {
  writeFileSync(resultFile, JSON.stringify({ ok: false, code: null, message: String(error) }))
  process.exitCode = 1
})
