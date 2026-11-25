// 第二批 replySchedules：两个运行时检查点（GPT 第 1/2 轮）。
//
// 锁的是行为，不是实现：
// - 入站：时段外必须走独立采集（Source/Event 落库），但不 announce、不建会话、不 followup；
//   没有独立采集入口时日志必须承认「只记录未采集」，不能假装已采集。
// - 出站：时段内正常发；暂停/越界时返回终态 `outside-reply-window`，socket 上一条都不出。
// - 私聊与群是两个对象：群的规则不影响私聊。
import { QqBridge } from '../dist/lib/qq-bridge.js'

let passed = 0
let failed = 0
function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (same) {
    passed += 1
    console.log('  ok ' + label)
  } else {
    failed += 1
    console.error('  FAIL ' + label, { actual, expected })
  }
}
function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  ok ' + label)
  } else {
    failed += 1
    console.error('  FAIL ' + label, detail)
  }
}
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

class FakeSocket {
  static last = null
  constructor(url) {
    FakeSocket.last = this
    this.url = url
    this.listeners = new Map()
    this.sent = []
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }
  send(data) {
    const parsed = JSON.parse(data)
    this.sent.push(parsed)
    const echo = parsed.echo
    queueMicrotask(() => this.emit({ status: 'ok', retcode: 0, data: { message_id: `ack-${this.sent.length}` }, echo }))
  }
  close() {}
  emit(event) {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(event) })
  }
}

function harness(options = {}) {
  const calls = { get: 0, resume: 0, create: 0, followup: 0, announce: 0 }
  const captured = []
  const logs = []
  const sinkResults = []
  const bridge = new QqBridge(
    {
      enabled: true,
      wsUrl: 'ws://127.0.0.1:1',
      accessToken: '',
      provider: 'probe',
      model: 'probe',
      allowFrom: { owner: '10001', extra: ['10002'] },
    },
    {
      host: {
        agents: {
          get() {
            calls.get += 1
            return undefined
          },
          async resume() {
            calls.resume += 1
            throw new Error('session not found: qq-private-10001')
          },
          async create() {
            calls.create += 1
            return { agent: { followup() { calls.followup += 1 } } }
          },
        },
        on() {
          return () => {}
        },
      },
      adapter: { announce() { calls.announce += 1 }, forget() {}, size() { return calls.announce } },
      logger: {
        info(message, detail) { logs.push({ level: 'info', message, detail }) },
        warn(message, detail) { logs.push({ level: 'warn', message, detail }) },
        error(message, detail) { logs.push({ level: 'error', message, detail }) },
      },
      webSocket: FakeSocket,
      allowLegacyAgentCreate: true,
      isSessionBound: () => true,
      // 采集开关默认按「开」构造，才能验证时段外确实走了采集；
      // 关掉开关的场景由 options.captureEnabled === false 单独覆盖。
      captureEnabled: options.captureEnabled !== false,
      ingestPrivateMessage: async (input) => {
        captured.push(input)
        if (options.sinkThrows === true) throw new Error('sink crashed')
        return sinkResults.shift() ?? { sourceId: 'src-x', eventId: 'evt-x', replayed: false }
      },
    },
  )
  return { bridge, calls, captured, logs, sinkResults }
}

let seq = 0
function privateEvent(userId = '10001') {
  seq += 1
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: '99999',
    user_id: String(userId),
    message_id: `m-${seq}`,
    raw_message: '你好',
    sender: { user_id: String(userId) },
  }
}

async function boot(h) {
  h.bridge.start()
  const socket = FakeSocket.last
  socket.emit('open')
  return socket
}

// A. 时段外：采集发生，回复不发生。
{
  const h = harness()
  const socket = await boot(h)
  h.bridge.applyReplySchedules({ 'private:10001': { mode: 'paused' } })
  const event = privateEvent()
  socket.emit(event)
  await flush()
  eq('A1 时段外调用独立采集一次', [h.captured.length, h.captured[0]?.stableUserId, h.captured[0]?.messageId], [1, '10001', event.message_id])
  eq('A2 时段外不 announce', h.calls.announce, 0)
  eq('A3 时段外不建会话', [h.calls.create, h.calls.resume], [0, 0])
  eq('A4 时段外不 followup', h.calls.followup, 0)
  eq('A5 时段外 socket 一条都不发', socket.sent.length, 0)
  ok('A6 日志承认已采集', h.logs.some((row) => row.message.includes('已采集但不生成回复') && row.detail?.captured === true))
  await h.bridge.stop()
}

// B. 没有独立采集入口：只能记「未采集」，但仍不发。
{
  const h = harness()
  const socket = await boot(h)
  const stripped = new QqBridge(
    { enabled: true, wsUrl: 'ws://127.0.0.1:1', accessToken: '', provider: 'probe', model: 'probe', allowFrom: { owner: '10001', extra: [] } },
    {
      host: h.bridge === null ? {} : {
        agents: { get: () => undefined, resume: async () => { throw new Error('session not found') }, create: async () => ({ agent: { followup() {} } }) },
        on: () => () => {},
      },
      adapter: { announce() {}, forget() {}, size() { return 0 } },
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      webSocket: FakeSocket,
      allowLegacyAgentCreate: true,
      isSessionBound: () => true,
    },
  )
  stripped.start()
  const socket2 = FakeSocket.last
  socket2.emit('open')
  stripped.applyReplySchedules({ 'private:10001': { mode: 'paused' } })
  socket2.emit(privateEvent())
  await flush()
  eq('B1 没有采集入口时不发消息', socket2.sent.length, 0)
  await stripped.stop()
  await h.bridge.stop()
}

// C. 时段内：正常投递。
{
  const h = harness()
  const socket = await boot(h)
  h.bridge.applyReplySchedules({ 'private:10001': { mode: 'windows', timeZone: 'Asia/Shanghai', windows: [{ days: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 1439 }] } })
  socket.emit(privateEvent())
  await flush()
  eq('C1 时段内正常建会话并投递', [h.calls.create, h.calls.followup], [1, 1])
  eq('C2 时段内不调独立采集', h.captured.length, 0)
  await h.bridge.stop()
}

// D. 私聊与群分开存：群规则不影响私聊。
{
  const h = harness()
  const socket = await boot(h)
  h.bridge.applyReplySchedules({ 'group:10001': { mode: 'paused' } })
  socket.emit(privateEvent('10001'))
  await flush()
  eq('D1 群规则不影响同号私聊', [h.calls.followup, h.captured.length], [1, 0])
  await h.bridge.stop()
}

// E. 发送侧：暂停后 socket 不出数据，结果带终态原因。
{
  const h = harness()
  const socket = await boot(h)
  const okResult = await h.bridge.sendOutgoingText({ kind: 'private', userId: '10001' }, '时段内')
  await flush()
  eq('E1 时段内照常发送', [okResult.ok, socket.sent.length], [true, 1])
  h.bridge.applyReplySchedules({ 'private:10001': { mode: 'paused' } })
  const before = socket.sent.length
  const blocked = await h.bridge.sendOutgoingText({ kind: 'private', userId: '10001' }, '时段外')
  await flush()
  eq('E2 时段外返回终态原因', [blocked.ok, blocked.error], [false, 'outside-reply-window'])
  eq('E3 时段外 socket 不增加', socket.sent.length, before)
  await h.bridge.stop()
}

// F. 群消息同样受规则约束（群回复单独一条路径）。
{
  const h = harness()
  const socket = await boot(h)
  h.bridge.applyReplySchedules({ 'group:41001': { mode: 'paused' } })
  const blocked = await h.bridge.sendOutgoingText({ kind: 'group', groupId: '41001' }, '群时段外')
  await flush()
  eq('F1 群时段外也拦在 socket 之前', [blocked.ok, blocked.error, socket.sent.length], [false, 'outside-reply-window', 0])
  await h.bridge.stop()
}

// G. 采集开关边界（GPT 第 3 轮 ③ 锁二）：
// 采不成（sink 抛错 / 没有消息身份）时，不得宣称已采集，也不得借采集绕出回复轮与发送。
{
  const h = harness({ sinkThrows: true })
  const socket = await boot(h)
  h.bridge.applyReplySchedules({ 'private:10001': { mode: 'paused' } })
  socket.emit(privateEvent())
  await flush()
  eq('G1 采集失败只尝试一次、不重试', h.captured.length, 1)
  eq('G2 采集失败不 announce、不建会话、不 followup', [h.calls.announce, h.calls.create, h.calls.followup], [0, 0, 0])
  eq('G3 采集失败也不发消息', socket.sent.length, 0)
  ok('G4 采集失败记「未确认持久化」而不是「已采集」', h.logs.some((row) => row.level === 'warn' && row.message.includes('未确认持久化')))
  await h.bridge.stop()
}

{
  const h = harness()
  const socket = await boot(h)
  h.bridge.applyReplySchedules({ 'private:10001': { mode: 'paused' } })
  const anonymous = privateEvent()
  delete anonymous.message_id
  socket.emit(anonymous)
  await flush()
  eq('G5 没有消息身份时不采集', h.captured.length, 0)
  eq('G6 没有消息身份时不回复', [h.calls.followup, socket.sent.length], [0, 0])
  await h.bridge.stop()
}

// G7–G8：宿主关掉自动采集时，时段外这条独立路径连 sink 都不该碰。
{
  const h = harness({ captureEnabled: false })
  const socket = await boot(h)
  h.bridge.applyReplySchedules({ 'private:10001': { mode: 'paused' } })
  socket.emit(privateEvent())
  await flush()
  eq('G7 采集关闭时不调用独立采集入口', h.captured.length, 0)
  eq('G8 采集关闭时仍然不回复、不发送', [h.calls.announce, h.calls.create, h.calls.followup, socket.sent.length], [0, 0, 0, 0])
  await h.bridge.stop()
}

console.log(`[v29.53 reply-window-gates] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
