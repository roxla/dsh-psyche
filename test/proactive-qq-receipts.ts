// C-3b 复核：普通 QQ 回复兼容省略 status，主动任务仍使用严格回执。
// 单元路径使用受控时钟；Owner runtime 另外连接真实本地 WebSocket 故障端。
import { QqBridge } from '../dist/lib/qq-bridge.js'
import { createOwnerQqConnection } from '../dist/lib/proactive-qq-runtime.js'
import { oneBotFixture } from './helpers/proactive-onebot.mjs'

let passed = 0
let failed = 0
function eq(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.error(`  FAIL ${label} ${JSON.stringify({ actual, expected })}`) }
}

class FakeSocket {
  static last
  listeners = new Map()
  sent = []
  constructor() { FakeSocket.last = this }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  send(data) { this.sent.push(JSON.parse(data)) }
  close() {}
  open() { for (const listener of this.listeners.get('open') ?? []) listener({}) }
  emit(event) {
    for (const listener of this.listeners.get('message') ?? []) listener({ data: JSON.stringify(event) })
  }
}

function bridgeFixture() {
  const timers = new Set()
  const bridge = new QqBridge({
    enabled: true, wsUrl: 'ws://127.0.0.1:1', accessToken: '', provider: '', model: '',
    allowFrom: { owner: '10001', extra: [] },
  }, {
    host: { on: () => () => {} }, adapter: { announce() {}, forget() {}, size: () => 0 },
    logger: { info() {}, warn() {}, error() {} }, webSocket: FakeSocket,
    setTimeout: (fn) => { const timer = { fn }; timers.add(timer); return timer },
    clearTimeout: (timer) => timers.delete(timer),
  })
  bridge.start()
  const socket = FakeSocket.last
  socket.open()
  return {
    bridge, socket,
    send: (strictAck = false) => bridge.sendOutgoingText({ kind: 'private', userId: '10001' }, 'receipt fixture', { strictAck }),
    expire: () => { for (const timer of [...timers]) { timers.delete(timer); timer.fn() } },
  }
}

for (const [label, strict, response, withEcho] of [
  ['普通缺 status 成功', false, { retcode: 0 }, true],
  ['普通缺 status 且无 echo 成功', false, { retcode: 0 }, false],
  ['普通标准成功', false, { retcode: 0, status: 'ok' }, true],
  ['主动标准成功', true, { retcode: 0, status: 'ok' }, true],
  ['主动标准无 echo 成功', true, { retcode: 0, status: 'ok' }, false],
]) {
  const h = bridgeFixture()
  try {
    const pending = h.send(strict)
    h.socket.emit({ ...response, data: { message_id: 'accepted-id' }, ...(withEcho ? { echo: h.socket.sent[0].echo } : {}) })
    h.expire()
    eq(`${label}：回执`, await pending, { ok: true, messageId: 'accepted-id' })
    eq(`${label}：不产生额外发送`, h.socket.sent.length, 1)
    eq(`${label}：无发送错误`, h.bridge.adminSnapshot().counts.sendErrors, 0)
  } finally { await h.bridge.stop() }
}

for (const [label, strict, response] of [
  ['普通缺 status 明确拒绝', false, { retcode: 100 }],
  ['普通标准明确拒绝', false, { retcode: 100, status: 'failed' }],
  ['主动标准明确拒绝', true, { retcode: 100, status: 'failed' }],
]) {
  const h = bridgeFixture()
  try {
    const pending = h.send(strict)
    h.socket.emit({ ...response, echo: h.socket.sent[0].echo })
    h.expire()
    const result = await pending
    eq(`${label}：拒绝码`, [result.ok, result.error], [false, 'retcode:100'])
    eq(`${label}：错误计数一次`, h.bridge.adminSnapshot().counts.sendErrors, 1)
  } finally { await h.bridge.stop() }
}

for (const strict of [false, true]) {
  const purpose = strict ? '主动' : '普通'
  for (const [label, response] of [
    ['缺 retcode', { status: 'ok' }],
    ['字符串 retcode', { retcode: '0', status: 'ok' }],
    ['null status', { retcode: 0, status: null }],
    ['非法 status', { retcode: 0, status: 'accepted' }],
  ]) {
    const h = bridgeFixture()
    try {
      const pending = h.send(strict)
      let settled = false
      void pending.then(() => { settled = true })
      h.socket.emit({ ...response, echo: h.socket.sent[0].echo })
      await Promise.resolve()
      eq(`${purpose}${label}：不能结算`, settled, false)
      h.expire()
      const result = await pending
      eq(`${purpose}${label}：超时保留未知`, [result.ok, result.error], [false, 'timeout'])
    } finally { await h.bridge.stop() }
  }

  for (const [label, response] of [
    ['失败状态配成功码', { retcode: 0, status: 'failed' }],
    ['成功状态配失败码', { retcode: 100, status: 'ok' }],
  ]) {
    const h = bridgeFixture()
    try {
      const pending = h.send(strict)
      h.socket.emit({ ...response, echo: h.socket.sent[0].echo })
      h.expire()
      const result = await pending
      eq(`${purpose}${label}：明确矛盾不能成功/拒绝`, [result.ok, result.error], [false, 'protocol-result-unknown'])
    } finally { await h.bridge.stop() }
  }

  const h = bridgeFixture()
  try {
    const pending = h.send(strict)
    let settled = false
    void pending.then(() => { settled = true })
    const response = { retcode: 0, ...(strict ? { status: 'ok' } : {}) }
    h.socket.emit({ ...response, echo: 'unrelated-request', data: { message_id: 'wrong' } })
    await Promise.resolve()
    eq(`${purpose}显式错 echo 不得 FIFO`, settled, false)
    h.socket.emit({ ...response, echo: h.socket.sent[0].echo, data: { message_id: 'right' } })
    h.expire()
    eq(`${purpose}正确 echo 后才结算`, (await pending).messageId, 'right')
  } finally { await h.bridge.stop() }
}

for (const retcode of [0, 100]) {
  const h = bridgeFixture()
  try {
    const pending = h.send(true)
    h.socket.emit({ retcode, echo: h.socket.sent[0].echo })
    h.expire()
    const result = await pending
    eq(`主动缺 status / retcode=${retcode} 不放宽`, [result.ok, result.error], [false, 'timeout'])
  } finally { await h.bridge.stop() }
}

// 策略属于单条 pending；同一桥里的普通发送不能改变在途主动任务的规则。
{
  const h = bridgeFixture()
  try {
    const strict = h.send(true)
    const ordinary = h.send()
    let strictSettled = false
    void strict.then(() => { strictSettled = true })
    h.socket.emit({ retcode: 0, data: { message_id: 'ambiguous-no-echo' } })
    await Promise.resolve()
    eq('混合在途：无 echo 缺 status 不越过严格任务', strictSettled, false)
    h.socket.emit({ retcode: 0, echo: h.socket.sent[1].echo, data: { message_id: 'ordinary' } })
    eq('混合在途：普通任务仍可兼容结算', (await ordinary).messageId, 'ordinary')
    h.socket.emit({ retcode: 0, status: 'ok', echo: h.socket.sent[0].echo, data: { message_id: 'strict' } })
    eq('混合在途：主动任务需完整回执', (await strict).messageId, 'strict')
  } finally { await h.bridge.stop() }
}

// 真实 Node WebSocket 客户端连接本地 OneBot 故障端；不是 FakeSocket/真实 QQ。
for (const [label, mode, expected] of [
  ['Owner 完整回执', 'accepted', 'accepted'],
  ['Owner 缺 status 成功码', 'no-status', 'unknown'],
  ['Owner 缺 status 拒绝码', 'no-status-rejected', 'unknown'],
]) {
  const wire = await oneBotFixture(mode)
  const connection = createOwnerQqConnection({ ...wire, sendTimeoutMs: 100 })
  try {
    await connection.connect(2000)
    const target = { kind: 'private', platform: 'qq', stableUserId: '10001' }
    const first = await connection.transport.send(target, { text: 'APPROVED-RECEIPT-FIXTURE' })
    eq(`${label}：真实 WS 分类`, first.outcome, expected)
    eq(`${label}：协议动作一次`, wire.actions.length, 1)
    const again = await connection.transport.send(target, { text: 'MUST-NOT-SEND' })
    eq(`${label}：关闭后拒绝再次发送`, again.outcome, 'permanent')
    eq(`${label}：没有重发未知结果`, wire.actions.length, 1)
  } finally { await connection.transport.close(); await wire.close() }
}

console.log(`[C3b proactive-qq-receipts] ${passed} 通过 ${failed} 失败`)
if (failed) process.exitCode = 1
