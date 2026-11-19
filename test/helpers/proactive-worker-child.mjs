import { acquireOutboundLease } from '../../dist/lib/proactive-owner-runtime.js'
import { openDatabase } from '../../packages/core/dist/adapter.js'
import { OutboxStore } from '../../packages/core/dist/proactive-outbox.js'

const [file, outboxId] = process.argv.slice(2)
try {
  await acquireOutboundLease(file)
  const { db } = await openDatabase({ file, logger: { info() {}, debug() {}, warn() {}, error() {} } })
  const store = new OutboxStore({ db, ownerId: 'fixture-owner', now: () => '2026-11-13T02:00:00.000Z' })
  const rows = store.claimBatch({ outboxId, limit: 1, consentReader: () => ({ status: 'granted' }), allowReader: () => 'allowed', transportCheck: () => true })
  console.log(JSON.stringify({ ready: true, claimed: rows.length }))
} catch {
  console.log(JSON.stringify({ busy: true }))
  process.exitCode = 4
}
