// P4-B-2：出站引用、多行文本、CQ 纯文本与降级边界（模块级）。
import { QqBridge, buildOutgoingMessage, normalizeOutgoingText } from '../dist/lib/qq-bridge.js'
import { createQqTransport, mapQqSendResult } from '../dist/lib/qq-transport.js'

let passed = 0
let failed = 0
function eq(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label} ${JSON.stringify({ actual, expected })}`)
  }
}
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)) }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
class Socket {
  static all: Socket[] = []
  listeners = new Map<string, Array<(event?: unknown) => void>>()
  sent: any[] = []
  constructor(_url: string) { Socket.all.push(this) }
  addEventListener(name: string, callback: (event?: unknown) => void) {
    const list = this.listeners.get(name) ?? []
    list.push(callback)
    this.listeners.set(name, list)
  }
  emit(name: string, value?: unknown) { for (const callback of this.listeners.get(name) ?? []) callback(value) }
  message(value: unknown) { this.emit('message', { data: JSON.stringify(value) }) }
  send(text: string) { this.sent.push(JSON.parse(text)) }
  close() { this.emit('close') }
}
let seq = 0
function message(userId = '10001') {
  return { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: '99999', user_id: userId,
    sender: { user_id: userId }, message_id: `out-${++seq}`, raw_message: `message-${seq}` }
}
function harness() {
  const creating = deferred<{ agent: { followup: (message: unknown) => void } }>()
  const calls = { followup: [] as unknown[] }
  const agents = new Map()
  const warnings: string[] = []
  const listeners = new Set<(session: unknown, event: unknown) => void>()
  const bridge = new QqBridge({ enabled: true, wsUrl: 'ws://127.0.0.1:1', accessToken: '', provider: 'probe', model: 'probe',
    allowFrom: { owner: '10001', extra: ['10002'] } }, {
    host: {
      agents: {
        get: (id) => agents.get(id),
        resume: async () => { throw new Error('session not found: qq-private-10001') },
        create: async () => creating.promise,
      },
      on: (_name: string, callback: (session: unknown, event: unknown) => void) => {
        listeners.add(callback)
        return () => { listeners.delete(callback) }
      },
    },
    adapter: { announce: () => {}, forget: () => {}, size: () => 0 },
    logger: { info() {}, error() {}, warn(text) { warnings.push(text) } },
    webSocket: Socket,
    allowLegacyAgentCreate: true,
    isSessionBound: () => true,
  })
  const agent = { followup: (message: unknown) => { calls.followup.push(message) } }
  return { bridge, calls, agents, creating, warnings, agent, listeners }
}

async function sendAndAck(
  bridge: QqBridge,
  socket: Socket,
  target: { kind: 'private'; userId: string } | { kind: 'group'; groupId: string },
  text: string,
  replyToMessageId?: string,
) {
  let n = 0
  const promise = bridge.sendOutgoingText(target, text, { replyToMessageId })
  await new Promise((resolve) => setTimeout(resolve, 1))
  socket.message({ status: 'ok', retcode: 0, data: { message_id: `ack-${++n}` } })
  return promise
}

console.log('[P4-B-2] QQ outbound quote and multiline')
// A. 纯序列化：多行/CRLF/CQ 文本/引用段顺序。
{
  eq('A1 多行文本只保留一个 text 段', buildOutgoingMessage('第一行\n\n第二行'), [
    { type: 'text', data: { text: '第一行\n\n第二行' } },
  ])
  eq('A2 CRLF 规范化为 LF', normalizeOutgoingText('a\r\nb\rc'), 'a\nb\nc')
  eq('A2a leading blank lines including CRLF', normalizeOutgoingText('\r\n \t\r\n  code\n\nnext\n'), '  code\n\nnext\n')
  eq('A2b first-line indentation', normalizeOutgoingText('    code'), '    code')
  eq('A2c ideographic space on blank line', normalizeOutgoingText('\u3000\n回答'), '回答')
  eq('A3 CQ 文本不产生额外段', buildOutgoingMessage('看这个 [CQ:image,file=x] 好'), [
    { type: 'text', data: { text: '看这个 [CQ:image,file=x] 好' } },
  ])
  eq('A4 引用段在文本段之前', buildOutgoingMessage('回复', '123'), [
    { type: 'reply', data: { id: '123' } },
    { type: 'text', data: { text: '回复' } },
  ])
  eq('A5 空引用 id 不生成引用段', buildOutgoingMessage('回复', ''), [{ type: 'text', data: { text: '回复' } }])
}

// B. Transport 透传引用；主动消息不带引用；结果四态不变。
{
  const calls: Array<{ target: unknown; text: string; replyTo?: string | null }> = []
  const transport = createQqTransport({
    sendText: async (target, text, replyTo) => { calls.push({ target, text, replyTo }); return { ok: true, messageId: '9' } },
    status: () => 'connected',
    waitConnected: async () => true,
  })
  const reply = await transport.send({ kind: 'private', platform: 'qq', stableUserId: '10001' }, { text: '嗯', replyToMessageId: '7' })
  eq('B1 普通回复透传引用 id', calls[0]?.replyTo, '7')
  eq('B2 结果仍为 accepted+messageId', reply, { outcome: 'accepted', messageId: '9' })
  const proactive = createQqTransport({
    sendText: async (target, text, replyTo) => { calls.push({ target, text, replyTo }); return { ok: true } },
    status: () => 'connected',
    waitConnected: async () => true,
  }, { purpose: 'proactive' })
  await proactive.send({ kind: 'private', platform: 'qq', stableUserId: '10001' }, { text: '在吗', replyToMessageId: '7' })
  eq('B3 主动消息不带引用', calls[1]?.replyTo, null)
  eq('B4 timeout 仍映射 unknown', mapQqSendResult({ ok: false, error: 'timeout' }), { outcome: 'unknown', errorCode: 'send-timeout' })
  eq('B5 not-connected 仍映射 retryable', mapQqSendResult({ ok: false, error: 'not-connected' }), { outcome: 'retryable', errorCode: 'not-connected' })
}

// C. 桥接绑定：只引用本私聊实际收到并已投递的消息；跨联系人拒绝；只发一次。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  const first = message('10001')
  socket.message(first)
  await flush()
  h.creating.resolve({ agent: h.agent })
  await flush()
  eq('C0 入站已投递', h.calls.followup.length, 1)

  const before = socket.sent.length
  const r1 = await sendAndAck(h.bridge, socket, { kind: 'private', userId: '10001' }, '\n\n第一行\n第二行', first.message_id)
  eq('C1 可引用本次入站消息', r1.quote, 'applied')
  eq('C2 多行只发一条', socket.sent.length - before, 1)
  const action = socket.sent.at(-1)
  eq('C3 使用结构化 reply+text 段', action.params.message, [
    { type: 'reply', data: { id: first.message_id } },
    { type: 'text', data: { text: '第一行\n第二行' } },
  ])
  eq('C4 发送动作仍是 send_private_msg', action.action, 'send_private_msg')

  const r2 = await sendAndAck(h.bridge, socket, { kind: 'private', userId: '10001' }, '再来一条', first.message_id)
  eq('C5 同一引用 id 不能复用', r2.quote, 'omitted-unbound')
  eq('C6 降级后仍只发纯文本', socket.sent.at(-1).params.message, [{ type: 'text', data: { text: '再来一条' } }])

  const other = message('10002')
  h.agents.set('qq-private-10002', h.agent)
  socket.message(other)
  await flush()
  const r3 = await sendAndAck(h.bridge, socket, { kind: 'private', userId: '10001' }, '跨人引用', other.message_id)
  eq('C7 跨联系人引用被拒绝', r3.quote, 'omitted-unbound')
  eq('C8 跨联系人降级为纯文本', socket.sent.at(-1).params.message, [{ type: 'text', data: { text: '跨人引用' } }])

  const r4 = await sendAndAck(h.bridge, socket, { kind: 'group', groupId: '7000' }, '群引用', 'whatever')
  eq('C9 群目标不支持引用', r4.quote, 'omitted-unsupported')
  eq('C10 群消息也不进私聊绑定表', socket.sent.at(-1).params.message, [{ type: 'text', data: { text: '群引用' } }])

  const beforeCq = socket.sent.length
  await sendAndAck(h.bridge, socket, { kind: 'private', userId: '10001' }, '[CQ:reply,id=1] 纯文本')
  eq('C11 CQ 文本按纯文本单次发送', socket.sent.length - beforeCq, 1)
  eq('C12 CQ 不产生引用段', socket.sent.at(-1).params.message, [{ type: 'text', data: { text: '[CQ:reply,id=1] 纯文本' } }])
  await h.bridge.stop()
}

// D. 助手回复经 Transport 时自动引用触发它的消息；引用段与文本段同批，只发一次。
{
  const h = harness()
  h.bridge.attachTransport(createQqTransport({
    sendText: (target, text, replyTo) => h.bridge.sendOutgoingText(target, text, { replyToMessageId: replyTo }),
    status: () => h.bridge.transportStatus(),
    waitConnected: async () => true,
  }))
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  const inbound = message('10001')
  socket.message(inbound)
  await flush()
  h.creating.resolve({ agent: h.agent })
  await flush()
  const before = socket.sent.length
  // P0-A：出站只认「这一轮的准入快照」，所以要按宿主真实顺序把一轮跑全：
  // turn/start 开窗 → 带平台消息 id 的 user/message 绑定 → assistant/message 带 turn。
  const emitHost = (event: unknown) => { for (const listener of h.listeners) listener({ id: 'qq-private-10001' }, event) }
  emitHost({ type: 'turn/start', data: { turn: 1 } })
  emitHost({
    type: 'user/message',
    data: { id: `msg_qq_${inbound.message_id}`, role: 'user', content: [{ type: 'text', text: '在吗' }], source: { kind: 'user' } },
  })
  emitHost({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '收到' }] } } })
  await new Promise((resolve) => setTimeout(resolve, 1))
  socket.message({ status: 'ok', retcode: 0, data: { message_id: 'ack-auto' } })
  await flush()
  eq('D1 助手回复自动引用触发消息', socket.sent.length - before, 1)
  eq('D2 回复同样使用结构化段', socket.sent.at(-1).params.message, [
    { type: 'reply', data: { id: inbound.message_id } },
    { type: 'text', data: { text: '收到' } },
  ])
  await h.bridge.stop()
}

console.log(`\n[P4-B-2] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
