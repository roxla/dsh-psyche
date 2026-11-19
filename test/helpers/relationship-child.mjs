// 关系账本并发子进程：等屏障后写同一条 independence_key 的信号。
//
// 两个进程同时投递同一件事，预期：一个真正写入，另一个命中查重返回 duplicate。
// 不依赖数据库唯一索引（当前没有），靠 BEGIN IMMEDIATE + 事务内查重。
import { writeFileSync, existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { openDatabase } from '../../packages/core/dist/adapter.js'
import { Core } from '../../packages/core/dist/store.js'

const [file, contactId, opId, independenceKey, ready, barrier, resultFile] = process.argv.slice(2)
const evidence = process.env.REL_EVIDENCE
const log = { info() {}, debug() {}, warn() {}, error() {} }

const opened = await openDatabase({ file })
const core = new Core({ db: opened.db, config: {}, logger: log, dataDir: process.cwd() })
writeFileSync(ready, '1')
while (!existsSync(barrier)) await sleep(10)

try {
  const result = await core.recordRelationshipSignal({
    opId,
    contactId,
    signalType: 'commitment_kept',
    polarity: 'positive',
    evidenceRefs: [evidence],
    independenceKey,
    now: '2026-11-12T04:00:00.000Z',
  })
  writeFileSync(
    resultFile,
    JSON.stringify({
      ok: true,
      duplicate: result.duplicate,
      applied: result.appliedDelta,
      replayed: result.replayed,
      signalId: result.signalId,
    }),
  )
} catch (error) {
  writeFileSync(
    resultFile,
    JSON.stringify({ ok: false, code: error.code ?? 'E_INTERNAL', error: String(error.message) }),
  )
}
opened.db.close()
