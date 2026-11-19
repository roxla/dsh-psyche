/**
 * P4-B-4-2b：Outbox Worker 生命周期与结果映射的单测。
 * 用假 Store/Transport 验证：启动收敛、单在途、连接门、异常→unknown、停止后不再领取。
 */
import assert from 'node:assert/strict'
import type { ChatSendResult, ChatTarget, ChatTransport } from '../packages/core/dist/chat-transport.js'
import type { QqReplyOutboxRow } from '../packages/core/dist/qq-reply-outbox.js'
import { QqReplyWorker } from '../packages/core/dist/qq-reply-worker.js'
import { qqReplyOutboxGate } from '../dist/lib/qq-bridge.js'

const row = {
  replyId: 'rep-1',
  transportId: 'qq-onebot',
  platform: 'qq',
  stableUserId: '10001',
  payloadText: '收到',
  quoteMessageId: null,
} as unknown as QqReplyOutboxRow

class FakeStore {
  recoveries = 0
  claims = 0
  applied: Array<{ id: string; result: ChatSendResult }> = []
  rows: QqReplyOutboxRow[] = [row]
  authorization: string | null = null
  recoverInflight(): number { this.recoveries += 1; return 0 }
  claim(input: { limit: number; authorization: (row: QqReplyOutboxRow) => string | null }): QqReplyOutboxRow[] {
    this.claims += 1
    const candidate = this.rows.shift()
    if (candidate === undefined) return []
    const denied = input.authorization(candidate)
    if (denied !== null) return []
    return [candidate]
  }
  applyResult(replyId: string, result: ChatSendResult): QqReplyOutboxRow | undefined {
    this.applied.push({ id: replyId, result })
    return row
  }
  expireDue(): number { return 0 }
}

class FakeTransport implements ChatTransport {
  readonly id = 'qq-onebot'
  readonly platform = 'qq'
  state: 'connected' | 'degraded' | 'disconnected' | 'unknown' = 'connected'
  sent: Array<{ target: ChatTarget; text: string }> = []
  result: ChatSendResult | Error = { outcome: 'accepted', messageId: 'm1' }
  status() { return this.state }
  async waitConnected() { return this.state === 'connected' }
  capabilities() { return { text: true, image: false, replyQuote: true, proactive: false } }
  async send(target: ChatTarget, outgoing: { text: string }): Promise<ChatSendResult> {
    if (this.result instanceof Error) throw this.result
    this.sent.push({ target, text: outgoing.text })
    return this.result
  }
  async close() {}
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 30))

{
  const store = new FakeStore()
  const transport = new FakeTransport()
  const worker = new QqReplyWorker({
    store,
    transport,
    targetOf: () => ({ kind: 'private', platform: 'qq', stableUserId: '10001' }),
    intervalMs: 60_000,
  })
  worker.start()
  await tick()
  assert.equal(store.recoveries, 1, '启动时必须先收敛遗留 dispatching')
  assert.equal(transport.sent.length, 1, '一条在途发送')
  assert.equal(transport.sent[0]?.target.kind, 'private')
  assert.deepEqual(store.applied[0]?.result, { outcome: 'accepted', messageId: 'm1' })
  worker.start()
  assert.equal(store.recoveries, 1, '重复 start 不重复收敛')
  await worker.stop()
}

{
  const store = new FakeStore()
  const transport = new FakeTransport()
  const worker = new QqReplyWorker({
    store,
    transport,
    targetOf: () => ({ kind: 'private', platform: 'qq', stableUserId: '10001' }),
    intervalMs: 60_000,
  })
  transport.state = 'disconnected'
  worker.start()
  await tick()
  assert.equal(store.claims, 0, '未连接时不得领取')
  await worker.stop()
}

{
  const store = new FakeStore()
  const transport = new FakeTransport()
  const worker = new QqReplyWorker({
    store,
    transport,
    targetOf: () => ({ kind: 'private', platform: 'qq', stableUserId: '10001' }),
    intervalMs: 60_000,
  })
  transport.result = new Error('socket lost')
  worker.start()
  await tick()
  assert.equal(store.applied[0]?.result.outcome, 'unknown', '发送抛错按 unknown，不自动重发')
  await worker.stop()
}

{
  const store = new FakeStore()
  const transport = new FakeTransport()
  store.authorization = 'transport-mismatch'
  const worker = new QqReplyWorker({
    store,
    transport,
    targetOf: () => ({ kind: 'private', platform: 'qq', stableUserId: '10001' }),
    authorization: () => 'transport-mismatch',
    intervalMs: 60_000,
  })
  worker.start()
  await tick()
  assert.equal(transport.sent.length, 0, '授权失败不发送')
  await worker.stop()
}

// P4-B-4-2b：入队门只接受模型最终回复。
{
  const base = {
    type: 'assistant/message',
    seq: 7,
    data: { message: { id: 'msg-1', source: { kind: 'model' } } },
  }
  assert.equal(qqReplyOutboxGate({ ...base, type: 'tool/result' }).ok, false, '工具结果不得入队')
  assert.equal(
    qqReplyOutboxGate({ ...base, data: { message: { id: 'm', source: { kind: 'tool' } } } }).ok,
    false,
    '非模型来源不得入队',
  )
  assert.equal(
    qqReplyOutboxGate({ ...base, data: { message: { id: 'm', interrupted: true, source: { kind: 'model' } } } }).ok,
    false,
    '被中断回复不得入队',
  )
  assert.equal(
    qqReplyOutboxGate({ ...base, data: { message: { source: { kind: 'model' } } } }).ok,
    false,
    '缺 message.id 不得入队',
  )
  assert.equal(qqReplyOutboxGate({ ...base, seq: 0 }).ok, false, '非法 seq 不得入队')
  assert.deepEqual(qqReplyOutboxGate(base), { ok: true, seq: 7, messageId: 'msg-1' })
}

console.log('qq-reply-worker: 14 通过')
