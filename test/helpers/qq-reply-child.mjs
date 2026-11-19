// B-4-2a 并发测试子进程：两个进程同时入队同一 session_seq。
import { existsSync, writeFileSync } from 'node:fs'
import { openDatabase } from '../../packages/core/dist/adapter.js'
import { QqReplyOutboxStore } from '../../packages/core/dist/qq-reply-outbox.js'

const [file, contactId, seqArg, text, ready, barrier, out] = process.argv.slice(2)
const waitFile = async (path) => {
  while (!existsSync(path)) await new Promise((resolve) => setTimeout(resolve, 10))
}

writeFileSync(ready, 'ready')
await waitFile(barrier)

const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file, driverPreference: 'auto', logger: log })
const store = new QqReplyOutboxStore({ db: opened.db, ownerId: 'owner-local' })
let result
try {
  const enqueued = store.enqueue({
    personaId: 'main',
    contactId,
    stableUserId: '20001',
    sessionId: `qq-private-${contactId}`,
    sessionSeq: Number(seqArg),
    transportId: 'qq-onebot',
    payloadText: text,
    now: '2026-11-16T02:00:00.000Z',
  })
  result = { ok: true, duplicate: enqueued.duplicate, replyId: enqueued.row.replyId }
} catch (error) {
  result = {
    ok: false,
    reason: error?.detail?.reason,
    code: error?.code,
    message: String(error?.message ?? error),
  }
}
writeFileSync(out, JSON.stringify(result))
opened.db.close()
