// P0-A：准入快照按「入站消息」存，出站按「轮次」取回；取不到就失败关闭。
//
// 这一层防的是两件事：
// 1. 同一对象后来的入站覆盖前一跳的代次——M2 生成完时读到的是 M3 的代次，撤销复核形同虚设；
// 2. 迟到的回复引用到「本会话最近一条消息」（也就是 M3），让对话看起来答错了人。
//
// 绑定必须同时满足：该会话恰有一个仍开放的 turn，且 `user/message` 的 id 精确命中准入表里
// 那条入站的键（`msg_qq_<平台 id>`）。`runtime-context` 这类注入不占绑定名额；多个 turn
// 同时开放时不按「最近」推断归属，整轮失败关闭。
import { QqBridge } from '../dist/lib/qq-bridge.js'

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
  seq += 1
  return { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: '99999', user_id: userId,
    sender: { user_id: userId }, message_id: `p0a-${seq}`, raw_message: `message-${seq}` }
}
/** 指定平台消息 id（两个会话可以各自收到同一个 id）。 */
function messageWith(userId: string, messageId: string) {
  return { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: '99999', user_id: userId,
    sender: { user_id: userId }, message_id: messageId, raw_message: `message-${messageId}` }
}
function harness() {
  const creating = deferred<{ agent: { followup: (message: unknown) => void } }>()
  const calls = { followup: [] as unknown[] }
  const agents = new Map()
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
    logger: { info() {}, error() {}, warn() {} },
    webSocket: Socket,
    allowLegacyAgentCreate: true,
    isSessionBound: () => true,
  })
  const agent = { followup: (m: unknown) => { calls.followup.push(m) } }
  return { bridge, calls, agents, creating, agent, listeners }
}

/** 把一条 QQ 入站投进桥并等它落地。 */
async function deliver(h: ReturnType<typeof harness>, socket: InstanceType<typeof Socket>, msg: { message_id: string }) {
  socket.message(msg)
  await flush()
  h.creating.resolve({ agent: h.agent })
  await flush()
}
const emitHost = (h: ReturnType<typeof harness>, sessionId: string, event: unknown) => {
  for (const listener of h.listeners) listener({ id: sessionId }, event)
}
const userMessage = (inboundId: string, kind = 'user') => ({
  type: 'user/message',
  data: { id: inboundId, role: 'user', content: [{ type: 'text', text: '在吗' }], source: { kind } },
})
const assistantMessage = (turn: number) => ({
  type: 'assistant/message',
  data: { turn, step: 1, message: { id: `a-${turn}`, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '收到' }] } },
})
async function ack(socket: InstanceType<typeof Socket>, id: string) {
  socket.message({ status: 'ok', retcode: 0, data: { message_id: `ack-${id}` } })
  await flush()
}

console.log('[P0-A] admission snapshot per inbound message')

const SESSION = 'qq-private-10001'

// A. M2 准入后撤权再加回，M3 以新代次准入；M2 的迟到回复必须带旧代次、被复核拦下。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  await flush()

  const m1 = message()
  await deliver(h, socket, m1)
  const epochAtM1 = h.bridge.accessEpochOf({ kind: 'private', userId: '10001' })

  // 撤权 → 再授权：两次都可能涨代次；M1 的快照必须停在 epochAtM1。
  h.bridge.applyAccess({ owner: '', extra: ['10002'] })
  h.bridge.applyAccess({ owner: '10001', extra: ['10002'] })
  const epochNow = h.bridge.accessEpochOf({ kind: 'private', userId: '10001' })
  eq('A0 撤权再加回后代次已涨过', epochNow > epochAtM1, true)

  const m3 = message()
  await deliver(h, socket, m3)

  // 第二轮（M3）先跑完，证明新代次本身能发。
  const beforeNew = socket.sent.length
  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 2 } })
  emitHost(h, SESSION, userMessage(`msg_qq_${m3.message_id}`))
  emitHost(h, SESSION, assistantMessage(2))
  await flush()
  await ack(socket, 'new')
  eq('A1 新代次的回复照常发出', socket.sent.length - beforeNew, 1)
  eq('A2 新代次的回复引用它自己的入站', socket.sent.at(-1)?.params.message?.[0], { type: 'reply', data: { id: m3.message_id } })

  // 再把 M1 那一轮跑起来：快照是旧代次，应被 access-superseded 拦下且零发送。
  const before = socket.sent.length
  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 1 } })
  emitHost(h, SESSION, userMessage(`msg_qq_${m1.message_id}`))
  emitHost(h, SESSION, assistantMessage(1))
  await flush()
  await ack(socket, 'old')
  eq('A3 旧代次的迟到回复零发送', socket.sent.length - before, 0)

  await h.bridge.stop()
}

// B. 同一轮里出现两条不同的已准入 id → 归属不明，整轮零发送。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  await flush()
  const m1 = message()
  await deliver(h, socket, m1)
  const m3 = message()
  await deliver(h, socket, m3)

  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 3 } })
  emitHost(h, SESSION, userMessage(`msg_qq_${m1.message_id}`))
  emitHost(h, SESSION, userMessage(`msg_qq_${m3.message_id}`))
  emitHost(h, SESSION, assistantMessage(3))
  await flush()
  await ack(socket, 'amb')
  eq('B1 同轮两条入站 → 零发送', socket.sent.length, 0)

  await h.bridge.stop()
}

// C. runtime-context 注入不占绑定名额，也不影响唯一绑定。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  await flush()
  const m1 = message()
  await deliver(h, socket, m1)

  const beforeCtx = socket.sent.length
  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 4 } })
  emitHost(h, SESSION, userMessage('a7900e87-5f09-43c1-bd6c-49deb5ee7642', 'runtime-context'))
  emitHost(h, SESSION, userMessage(`msg_qq_${m1.message_id}`))
  emitHost(h, SESSION, assistantMessage(4))
  await flush()
  await ack(socket, 'ctx')
  eq('C1 插入 runtime-context 仍能发出', socket.sent.length - beforeCtx, 1)
  eq('C2 引用仍是那条 QQ 入站', socket.sent.at(-1)?.params.message?.[0], { type: 'reply', data: { id: m1.message_id } })

  await h.bridge.stop()
}

// D. 同一轮重复出现同一条已准入 id 按幂等处理。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  await flush()
  const m1 = message()
  await deliver(h, socket, m1)

  const beforeIdem = socket.sent.length
  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 5 } })
  emitHost(h, SESSION, userMessage(`msg_qq_${m1.message_id}`))
  emitHost(h, SESSION, userMessage(`msg_qq_${m1.message_id}`))
  emitHost(h, SESSION, assistantMessage(5))
  await flush()
  await ack(socket, 'idem')
  eq('D1 重复同一条不算归属不明', socket.sent.length - beforeIdem, 1)

  await h.bridge.stop()
}

// E. 多个 turn 同时开放：不按「最近」推断归属，零发送。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  await flush()
  const m1 = message()
  await deliver(h, socket, m1)

  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 6 } })
  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 7 } })
  emitHost(h, SESSION, userMessage(`msg_qq_${m1.message_id}`))
  emitHost(h, SESSION, assistantMessage(6))
  await flush()
  socket.sent.length = 0
  await ack(socket, 'multi')
  eq('E1 两个 turn 同时开放 → 零发送', socket.sent.length, 0)

  await h.bridge.stop()
}

// F. 没有 turn 字段的 assistant/message：严格路径无法归属，零发送。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  await flush()
  const m1 = message()
  await deliver(h, socket, m1)

  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 8 } })
  emitHost(h, SESSION, userMessage(`msg_qq_${m1.message_id}`))
  emitHost(h, SESSION, { type: 'assistant/message', data: { step: 1, message: { content: [{ type: 'text', text: '收到' }] } } })
  await flush()
  socket.sent.length = 0
  await ack(socket, 'noturn')
  eq('F1 没有 turn 的回复零发送', socket.sent.length, 0)

  await h.bridge.stop()
}

// G. turn/end 之后同一轮再来一次回复：绑定已清理，零发送。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  await flush()
  const m1 = message()
  await deliver(h, socket, m1)

  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 9 } })
  emitHost(h, SESSION, userMessage(`msg_qq_${m1.message_id}`))
  emitHost(h, SESSION, { type: 'turn/end', data: { turn: 9, reason: 'done' } })
  emitHost(h, SESSION, assistantMessage(9))
  await flush()
  socket.sent.length = 0
  await ack(socket, 'ended')
  eq('G1 turn 结束后再回复零发送', socket.sent.length, 0)

  await h.bridge.stop()
}

// H. 同一个平台消息 id 出现在第二个会话：入口的重复投递去重会拦掉它，
//    所以它既不会生成第二份准入快照，也不会覆盖第一个会话那一份。
//    （会话维度的键仍是必要的防御层：`#seen` 只覆盖私聊，将来放开群回复或换去重口径时它会生效。）
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  await flush()
  const sharedId = 'p0a-shared-1'
  const first = messageWith('10001', sharedId)
  await deliver(h, socket, first)

  // 同一 id 换个联系人再投一次：应当被去重表拦下，不产生第二份准入。
  const second = messageWith('10002', sharedId)
  await deliver(h, socket, second)

  const OTHER = 'qq-private-10002'
  emitHost(h, OTHER, { type: 'turn/start', data: { turn: 21 } })
  emitHost(h, OTHER, userMessage(`msg_qq_${sharedId}`))
  const beforeOther = socket.sent.length
  emitHost(h, OTHER, assistantMessage(21))
  await flush()
  await ack(socket, 'cross-other')
  eq('H1 重复投递的会话没有准入快照，零发送', socket.sent.length - beforeOther, 0)

  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 20 } })
  emitHost(h, SESSION, userMessage(`msg_qq_${sharedId}`))
  const beforeOwn = socket.sent.length
  emitHost(h, SESSION, assistantMessage(20))
  await flush()
  await ack(socket, 'cross-own')
  eq('H2 原会话仍用自己的快照正常回复', socket.sent.length - beforeOwn, 1)
  eq('H3 引用仍是自己那条入站', socket.sent.at(-1)?.params.message?.[0], { type: 'reply', data: { id: sharedId } })

  await h.bridge.stop()
}

// I. runtime-context 即使携带一条已准入的 id，也不能绑定、也不能制造归属不明。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  await flush()
  const m1 = messageWith('10001', 'p0a-ctx-carrier')
  await deliver(h, socket, m1)

  const beforeCtx = socket.sent.length
  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 22 } })
  emitHost(h, SESSION, userMessage(`msg_qq_${m1.message_id}`, 'runtime-context'))
  emitHost(h, SESSION, userMessage(`msg_qq_${m1.message_id}`, 'user'))
  emitHost(h, SESSION, assistantMessage(22))
  await flush()
  await ack(socket, 'ctxcarrier')
  eq('I1 注入消息不占绑定名额', socket.sent.length - beforeCtx, 1)
  eq('I2 引用仍是那条 QQ 入站', socket.sent.at(-1)?.params.message?.[0], { type: 'reply', data: { id: m1.message_id } })

  await h.bridge.stop()
}

// J. T1 已绑定 M2，T2 开窗后又来了 M3：旧轮不能凭旧绑定继续发。
//    只看「M3 无法归属」就丢掉 M3 是不够的——T1 仍会带着 M2 的快照发出去。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  await flush()
  const m2 = messageWith('10001', 'p0a-dual-2')
  await deliver(h, socket, m2)
  const m3 = messageWith('10001', 'p0a-dual-3')
  await deliver(h, socket, m3)

  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 30 } })
  emitHost(h, SESSION, userMessage(`msg_qq_${m2.message_id}`))
  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 31 } })
  emitHost(h, SESSION, userMessage(`msg_qq_${m3.message_id}`))

  const beforeDual = socket.sent.length
  emitHost(h, SESSION, assistantMessage(30))
  emitHost(h, SESSION, assistantMessage(31))
  await flush()
  await ack(socket, 'dual')
  eq('J1 已绑定的旧轮也被标成归属不明', socket.sent.length - beforeDual, 0)

  await h.bridge.stop()
}

// K. 绑定之后代次又变了：出站必须用「绑定那一刻固定下来的快照」，不是此刻的当前代次。
//    这一条挡的是「turn 只存消息键、出站再回准入表查」的写法——同键被重新写入后，
//    旧回复会拿到新代次，复核等于没做。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  await flush()
  const m2 = messageWith('10001', 'p0a-frozen-1')
  await deliver(h, socket, m2)

  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 40 } })
  emitHost(h, SESSION, userMessage(`msg_qq_${m2.message_id}`))

  // 绑定发生在准入之后：这里再撤权加回，当前代次涨过一轮。
  h.bridge.applyAccess({ owner: '', extra: ['10002'] })
  h.bridge.applyAccess({ owner: '10001', extra: ['10002'] })

  const beforeFrozen = socket.sent.length
  emitHost(h, SESSION, assistantMessage(40))
  await flush()
  await ack(socket, 'frozen')
  eq('K1 绑定后换代，旧轮零发送', socket.sent.length - beforeFrozen, 0)
  const page = h.bridge.diagnosticPage({
    limit: 50, before: null, direction: 'out', target: 'private', results: [], contactRef: null, roomRef: null, from: null, to: null,
  })
  eq('K2 记录的是 access-superseded', page.items.some((item) => item.errorCode === 'access-superseded'), true)

  await h.bridge.stop()
}

// L. Outbox 配置下的同一序列：两轮都归属不明时，既不入队也没有 Transport 调用，
//    即没有留下任何「可供后续 Worker 发送」的行。
{
  const enqueued: unknown[] = []
  const transportSent: unknown[] = []
  const store = {
    recoverInflight: () => 0,
    expireDue: () => {},
    claim: () => [],
    enqueue: (row: unknown) => { enqueued.push(row); return { row, created: true } },
  }
  const transport = {
    id: 'probe-transport',
    platform: 'qq',
    sent: transportSent,
    status: () => 'connected',
    waitConnected: async () => true,
    capabilities: () => ({ text: true, image: false, replyQuote: true, proactive: true }),
    send: async (_target: unknown, _outgoing: unknown) => { transportSent.push(_outgoing); return { outcome: 'accepted', messageId: 'x' } },
    close: async () => {},
  }
  const h = harness()
  h.bridge.attachTransport(transport)
  h.bridge.attachReplyOutbox(store, { enabled: true })
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  await flush()
  const m2 = messageWith('10001', 'p0a-outbox-2')
  await deliver(h, socket, m2)
  const m3 = messageWith('10001', 'p0a-outbox-3')
  await deliver(h, socket, m3)

  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 50 } })
  emitHost(h, SESSION, userMessage(`msg_qq_${m2.message_id}`))
  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 51 } })
  emitHost(h, SESSION, userMessage(`msg_qq_${m3.message_id}`))
  emitHost(h, SESSION, assistantMessage(50))
  emitHost(h, SESSION, assistantMessage(51))
  await flush()

  eq('L1 Outbox 配置下两轮都不入队', enqueued.length, 0)
  eq('L2 Transport 调用数为 0', transportSent.length, 0)
  const page = h.bridge.diagnosticPage({
    limit: 50, before: null, direction: 'out', target: 'private', results: [], contactRef: null, roomRef: null, from: null, to: null,
  })
  eq('L3 两轮各记一条 unresolved-inbound',
    page.items.filter((item) => item.errorCode === 'unresolved-inbound').length, 2)

  await h.bridge.stop()
}

// M. L 组的同一序列，但**关闭 Outbox 与 Transport**（直发模式、授权仍然有效）：
//    同一歧义不能只在 Outbox 路径上被挡住，直发路径也必须零发送并各记一条。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  await flush()
  const m2 = messageWith('10001', 'p0a-direct-2')
  await deliver(h, socket, m2)
  const m3 = messageWith('10001', 'p0a-direct-3')
  await deliver(h, socket, m3)

  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 60 } })
  emitHost(h, SESSION, userMessage(`msg_qq_${m2.message_id}`))
  emitHost(h, SESSION, { type: 'turn/start', data: { turn: 61 } })
  emitHost(h, SESSION, userMessage(`msg_qq_${m3.message_id}`))

  const beforeDirect = socket.sent.length
  emitHost(h, SESSION, assistantMessage(60))
  emitHost(h, SESSION, assistantMessage(61))
  await flush()
  await ack(socket, 'direct')
  eq('M1 直发模式下双轮歧义零发送', socket.sent.length - beforeDirect, 0)
  const page = h.bridge.diagnosticPage({
    limit: 50, before: null, direction: 'out', target: 'private', results: [], contactRef: null, roomRef: null, from: null, to: null,
  })
  eq('M2 两轮各记一条 unresolved-inbound',
    page.items.filter((item) => item.errorCode === 'unresolved-inbound').length, 2)

  await h.bridge.stop()
}

console.log(`\n[P0-A admission-inbound] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
