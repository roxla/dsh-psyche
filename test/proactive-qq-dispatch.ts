import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../packages/core/dist/adapter.js'
import { Core } from '../packages/core/dist/store.js'
import { OutboxStore } from '../packages/core/dist/proactive-outbox.js'
import { OutboundService } from '../packages/core/dist/proactive-outbound-service.js'
import { OutboxWorker } from '../packages/core/dist/proactive-outbox-worker.js'
import { createOwnerQqConnection } from '../dist/lib/proactive-qq-runtime.js'
import { mapQqProactiveSendResult } from '../dist/lib/qq-transport.js'
import { oneBotFixture } from './helpers/proactive-onebot.mjs'

let passed = 0
let failed = 0
function eq(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.error(`  FAIL ${label} ${JSON.stringify({ actual, expected })}`) }
}
const log = { info() {}, debug() {}, warn() {}, error() {} }
const T0 = '2026-11-13T02:00:00.000Z'
const granted = { status: 'granted', sourceId: 'fixture-consent' }
async function setup(transportId) {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-qq-dispatch-'))
  const { db } = await openDatabase({ file: join(dir, 'memory.sqlite3'), logger: log })
  const core = new Core({ db, config: {}, logger: log, dataDir: dir })
  const contact = await core.resolveContact({ platform: 'qq', stableUserId: '10001' })
  const other = await core.resolveContact({ platform: 'qq', stableUserId: '10002' })
  const store = new OutboxStore({ db, ownerId: 'fixture-owner', now: () => T0 })
  const enqueue = (id, target = contact) => store.enqueue({ approvalId: id,
    draft: { draftId: `draft-${id}`, revision: 1, draftHash: `hash-${id}`, contactId: target.contactId, text: '已审批测试正文' },
    contact: target, transportId, consent: granted, decision: 'approved', decidedBy: 'fixture-owner', decidedAt: T0 })
  return { db, store, contact, other, enqueue }
}

console.log('[C3b] real QQ Transport / local OneBot wire faults')
for (const [mode, expected] of [['accepted', 'sent'], ['no-echo', 'sent'], ['wrong-then-right', 'sent'],
  ['rejected', 'failed'], ['429', 'pending'], ['ack-lost', 'unknown'], ['late-ack', 'unknown'],
  ['disconnect', 'unknown'], ['wrong-echo', 'unknown'], ['malformed', 'unknown']]) {
  const wire = await oneBotFixture(mode)
  const connection = createOwnerQqConnection({ ...wire, sendTimeoutMs: 200 })
  const h = await setup(connection.transport.id)
  try {
    await connection.connect(2000)
    eq(`${mode}: 出站连接不处理入站/不发拒绝回复`, wire.actions.length, 0)
    const enqueued = h.enqueue(`approval-${mode}`)
    const service = new OutboundService({ store: h.store, transport: connection.transport,
      ownerId: 'fixture-owner', consentReader: () => granted, allowReader: () => 'allowed' })
    const worker = new OutboxWorker({ service, outboxId: enqueued.row.outboxId, limit: 1 })
    await worker.tickOnce()
    eq(`${mode}: 结果分类`, h.store.get(enqueued.row.outboxId)?.status, expected)
    eq(`${mode}: 实际协议动作仅一次`, wire.actions.length, 1)
    const segments = wire.actions[0]?.params.message as Array<{ type: string; data?: { text?: string } }>
    eq(`${mode}: 正文为审批快照`, segments?.filter((s) => s.type === 'text').map((s) => s.data?.text ?? '').join(''), '已审批测试正文')
    eq(`${mode}: 出站为结构化文本且不带引用`, segments?.[0]?.type, 'text')
    if (mode === 'wrong-then-right') eq('显式不匹配 echo 不可结算当前任务', h.store.get(enqueued.row.outboxId)?.receipt, 'wire-1')
    if (mode === '429') eq('真实 429 走安全默认 30s', h.store.get(enqueued.row.outboxId)?.retryAt, '2026-11-13T02:00:30.000Z')
    await worker.tickOnce()
    eq(`${mode}: 同一连接不重发`, wire.actions.length, 1)
    worker.stop()
  } finally { await connection.transport.close(); h.db.close(); await wire.close() }
}

{
  const wire = await oneBotFixture('accepted', '39998')
  const connection = createOwnerQqConnection({ ...wire, senderAccount: '39999' })
  let refused = false
  try { await connection.connect(1000) } catch { refused = true }
  eq('发送账号不匹配拒绝连接', refused, true)
  eq('账号不匹配零发送', wire.actions.length, 0)
  await connection.transport.close()
  await wire.close()
}
{
  const wire = await oneBotFixture()
  const connection = createOwnerQqConnection(wire)
  const different = createOwnerQqConnection({ ...wire, senderAccount: '39998' })
  eq('transportId 绑定发送账号', connection.transport.id !== different.transport.id, true)
  await different.transport.close()
  const h = await setup(connection.transport.id)
  try {
    await connection.connect(1000)
    h.enqueue('older-unselected', h.other)
    const selected = h.enqueue('selected')
    const service = new OutboundService({ store: h.store, transport: connection.transport,
      ownerId: 'fixture-owner', consentReader: () => granted, allowReader: () => 'allowed' })
    await service.runOnce({ outboxId: selected.row.outboxId, limit: 1 })
    eq('仅领取指定审批，不发送较早旧任务', wire.actions[0]?.params.user_id, 10001)
    eq('旧审批仍 pending', h.store.getByApproval('older-unselected')?.status, 'pending')
    eq('指定审批 sent', h.store.get(selected.row.outboxId)?.status, 'sent')
  } finally { await connection.transport.close(); h.db.close(); await wire.close() }
}
{
  const result = mapQqProactiveSendResult({ ok: false, error: 'send-failed' })
  eq('send 异常不归永久失败', result.outcome, 'unknown')
  const h = await setup('qq-test')
  const row = h.enqueue('generic-retry').row
  h.store.claimBatch({ limit: 1, consentReader: () => granted, allowReader: () => 'allowed', transportCheck: () => true })
  h.store.applyResult(row.outboxId, { outcome: 'retryable', errorCode: 'not-connected' })
  eq('非 429 retryable 不能授权重发', h.store.get(row.outboxId)?.status, 'unknown')
  h.store.resolveUnknown(row.outboxId, 'not-received', 'fixture-owner')
  eq('人工确认未收到只落 failed', h.store.get(row.outboxId)?.status, 'failed')
  eq('同审批重放仍为 failed', h.enqueue('generic-retry').row.status, 'failed')
  h.db.close()
}
{
  const h = await setup('qq-test')
  const row = h.enqueue('offline-after-claim').row
  let calls = 0
  let sends = 0
  const transport = { id: 'qq-test', platform: 'qq', status: () => ++calls === 1 ? 'connected' : 'disconnected',
    capabilities: () => ({ text: true, proactive: true }), send: async () => { sends++; return { outcome: 'accepted' } } }
  await new OutboundService({ store: h.store, transport, ownerId: 'fixture-owner', consentReader: () => granted, allowReader: () => 'allowed' }).runOnce()
  eq('领取后、发送前离线零动作', sends, 0)
  eq('已知未发送终止并重新审批', h.store.get(row.outboxId)?.status, 'failed')
  h.db.close()
}
{
  const h = await setup('qq-test')
  let rejected = false
  try {
    h.store.enqueue({ approvalId: 'group', draft: { draftId: 'd', revision: 1, draftHash: 'h', contactId: h.contact.contactId, text: 'no group' },
      contact: h.contact, transportId: 'qq-test', targetKind: 'group', consent: granted,
      decision: 'approved', decidedBy: 'fixture-owner', decidedAt: T0 })
  } catch { rejected = true }
  eq('主动 v1 入队拒绝 group', rejected, true)
  const first = h.enqueue('manual-sent').row
  const claim = () => h.store.claimBatch({ limit: 1, consentReader: () => granted, allowReader: () => 'allowed', transportCheck: () => true })
  claim()
  h.store.applyResult(first.outboxId, { outcome: 'unknown' })
  h.store.resolveUnknown(first.outboxId, 'received', 'fixture-owner')
  eq('人工核验不伪造平台 sent_at', h.store.get(first.outboxId)?.sentAt, null)
  const next = h.enqueue('after-manual-sent').row
  eq('人工核验 sent 仍预留频率额度', claim().length, 0)
  h.db.run("UPDATE proactive_outbox SET target_kind='group' WHERE outbox_id=?", [next.outboxId])
  claim()
  eq('库内遗留 group 在领取前取消', h.store.get(next.outboxId)?.status, 'cancelled')
  eq('group 取消原因明确', h.store.get(next.outboxId)?.lastErrorCode, 'unsupported_target')
  h.db.close()
}
console.log(`[C3b proactive-qq-dispatch] ${passed} 通过 ${failed} 失败`)
if (failed) process.exitCode = 1
