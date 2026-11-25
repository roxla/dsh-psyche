// P4-A-1：QQ 私聊准入闸（模块级）。
//
// 覆盖冻结稿的四项最小不变量：
// 1. 只放行白名单内的 QQ 好友私聊；
// 2. 未授权私聊只回固定文案，受「单用户 24 小时冷却 + 全局滚动额度」限制；
// 3. 任何拒绝分支都在 `ensureAgent` 之前结束（不建 Session、不 announce）；
// 4. 群聊 / 临时群聊 / 未知类型 Fail-closed，静默丢弃且不回复。
//
// 跑法：npm run build && node test/qq-admission.ts
import { QqBridge, QQ_REJECT_TEXT, parseQqAllowFrom } from '../dist/lib/qq-bridge.js'

let passed = 0
let failed = 0

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const flush = async () => {
  await sleep(0)
  await sleep(0)
}

class FakeSocket {
  constructor(url) {
    FakeSocket.last = this
    this.url = url
    this.listeners = new Map()
    this.sent = []
    this.replies = 0
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
    queueMicrotask(() => {
      this.replies += 1
      this.emit({ status: 'ok', retcode: 0, data: { message_id: `reply-${this.replies}` }, echo })
    })
  }
  close() {}
  emit(event) {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(event) })
  }
  actions() {
    return this.sent.map((item) => item.action)
  }
}

class ThrowingSocket {
  constructor(url) {
    ThrowingSocket.last = this
    this.url = url
    this.listeners = new Map()
    this.attempts = 0
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }
  send() {
    this.attempts += 1
    throw new Error('socket send boom')
  }
  close() {}
  emit(event) {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(event) })
  }
}

function makeContext(overrides = {}) {
  const calls = { get: 0, resume: 0, create: 0, followup: 0, announce: 0, forget: 0 }
  const logs = []
  const socketRef = { current: null }
  const host = {
    agents: {
      get() {
        calls.get += 1
        return undefined
      },
      async resume() {
        calls.resume += 1
        // 宿主对「没有这个会话」的 reject 带 `session/not-found`，文案里有 not found；
        // 这里用同样的文案，别用含糊的 'no session'（5cda146 收紧闸门后不再匹配）。
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
  }
  const adapter = {
    announce() { calls.announce += 1 },
    forget() { calls.forget += 1 },
    size() { return calls.announce - calls.forget },
  }
  const logger = {
    info(message, detail) { logs.push({ level: 'info', message, detail }) },
    warn(message, detail) { logs.push({ level: 'warn', message, detail }) },
    error(message, detail) { logs.push({ level: 'error', message, detail }) },
  }
  const config = {
    enabled: true,
    wsUrl: 'ws://127.0.0.1:1',
    accessToken: '',
    provider: 'test-provider',
    model: 'test-model',
    allowFrom: { owner: '10001', extra: ['10002'] },
    unknownPolicy: 'reject',
    rejectCooldownMs: 24 * 60 * 60_000,
    rejectGlobalLimit: 20,
    rejectGlobalWindowMs: 60 * 60_000,
    sendTimeoutMs: 5_000,
    ...overrides,
  }
  const WebSocketCtor = overrides.webSocket ?? FakeSocket
  const bridge = new QqBridge(config, {
    host,
    adapter,
    logger,
    webSocket: WebSocketCtor,
    // 旧版 agents.create 只在测试里显式打开；生产装配不再回退到它。
    allowLegacyAgentCreate: true,
    isSessionBound: () => true,
  })
  bridge.start()
  socketRef.current = WebSocketCtor.last ?? null
  return { bridge, calls, logs, socket: socketRef, WebSocketCtor }
}

let seq = 0
function privateEvent(userId, extra = {}) {
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
    ...extra,
  }
}

// ── A. 白名单解析 ──────────────────────────────────────────────────────────
{
  const parsed = parseQqAllowFrom({ owner: '10001', extra: ['10002', ' 10003 '] })
  eq('A1 owner + extra（去空白）→ 三个 ID', [...parsed.ids], ['10001', '10002', '10003'])
  ok('A2 合法白名单 valid=true', parsed.valid === true)

  const wildcard = parseQqAllowFrom({ owner: '10001', extra: ['*'] })
  ok('A3 通配符让整份白名单失效', wildcard.valid === false && wildcard.ids.size === 0)

  const emptyOwner = parseQqAllowFrom({ owner: '', extra: ['10002'] })
  ok('A4 缺 owner → 整份失效', emptyOwner.valid === false && emptyOwner.ids.size === 0)

  const bad = parseQqAllowFrom({ owner: '10001', extra: ['abc'] })
  ok('A5 非数字条目 → 整份失效（不跳过坏条目继续放行）', bad.valid === false && bad.ids.size === 0)

  const missing = parseQqAllowFrom(undefined)
  ok('A6 未配置 → 整份失效', missing.valid === false && missing.ids.size === 0)
}

// ── B. 已授权私聊正常进入 Agent ─────────────────────────────────────────────
{
  const { bridge, calls, socket } = makeContext()
  socket.current.emit(privateEvent('10001'))
  await flush()
  eq('B1 已授权私聊先 resume 再 create，并 followup', [calls.resume, calls.create, calls.followup], [1, 1, 1])
  eq('B2 已授权私聊 announce 一次', calls.announce, 1)
  eq('B3 已授权私聊不回拒绝文案', socket.current.actions(), [])
  eq('B4 计数保持零', bridge.admissionStats, {
    rejected: 0, rejectReplies: 0, rateLimitedDrops: 0, rejectSendErrors: 0, outOfScopeDrops: 0,
  })
  await bridge.stop()
}

// ── C. 未授权私聊：固定拒绝 + 零会话 ────────────────────────────────────────
{
  const { bridge, calls, socket } = makeContext()
  socket.current.emit(privateEvent('20001'))
  await flush()
  const sent = socket.current.sent
  eq('C1 未授权只发 send_private_msg', socket.current.actions(), ['send_private_msg'])
  const rejectSegments = sent[0].params.message as Array<{ type: string; data?: { text?: string } }>
  eq('C2 拒绝文案固定且不携带正文', [sent[0].params.user_id, rejectSegments.map((s) => s.data?.text ?? '')], [20001, [QQ_REJECT_TEXT]])
  eq('C2b 拒绝文案为结构化纯文本段', rejectSegments.map((s) => s.type), ['text'])
  eq('C3 零 Agent 调用（resume/create/get 之外）', [calls.resume, calls.create, calls.followup, calls.announce], [0, 0, 0, 0])
  eq('C4 桥内不登记会话', bridge.sessionCount, 0)
  eq('C5 rejected/rejectReplies 各 1', [bridge.admissionStats.rejected, bridge.admissionStats.rejectReplies], [1, 1])

  socket.current.emit(privateEvent('20001'))
  await flush()
  eq('C6 同用户 24 小时冷却内静默丢弃', [socket.current.sent.length, bridge.admissionStats.rateLimitedDrops], [1, 1])
  await bridge.stop()
}

// ── D. 全局滚动额度 ────────────────────────────────────────────────────────
{
  const { bridge, socket } = makeContext({ rejectCooldownMs: 0, rejectGlobalLimit: 2, rejectGlobalWindowMs: 60_000 })
  for (const id of ['30001', '30002', '30003']) {
    socket.current.emit(privateEvent(id))
    await flush()
  }
  eq('D1 前两条发送、第三条静默丢弃', [socket.current.sent.length, bridge.admissionStats.rejected, bridge.admissionStats.rateLimitedDrops], [2, 3, 1])
  await bridge.stop()
}

// ── E. 滚动窗口过期后恢复额度 ──────────────────────────────────────────────
{
  const tight = makeContext({ rejectCooldownMs: 0, rejectGlobalLimit: 1, rejectGlobalWindowMs: 60_000 })
  tight.socket.current.emit(privateEvent('31001'))
  await flush()
  tight.socket.current.emit(privateEvent('31002'))
  await flush()
  eq('E1 额度用尽时第二条被丢', [tight.socket.current.sent.length, tight.bridge.admissionStats.rateLimitedDrops], [1, 1])
  await tight.bridge.stop()
}
{
  const win = makeContext({ rejectCooldownMs: 0, rejectGlobalLimit: 1, rejectGlobalWindowMs: 40 })
  win.socket.current.emit(privateEvent('31003'))
  await flush()
  await sleep(120)
  win.socket.current.emit(privateEvent('31004'))
  await flush()
  eq('E2 窗口滑过后恢复一条额度', [win.socket.current.sent.length, win.bridge.admissionStats.rejectReplies], [2, 2])
  await win.bridge.stop()
}

// ── F. 重复 message_id 在限频之前去重 ──────────────────────────────────────
{
  const { bridge, socket } = makeContext()
  const event = privateEvent('32001')
  socket.current.emit(event)
  socket.current.emit(event)
  await flush()
  eq('F1 同一 message_id 只触发一次', [bridge.admissionStats.rejected, socket.current.sent.length], [1, 1])
  await bridge.stop()
}

// ── G. 群聊 / 临时群聊 / 未知类型 Fail-closed ──────────────────────────────
{
  const { bridge, calls, socket } = makeContext()
  socket.current.emit({
    post_type: 'message', message_type: 'group', self_id: '99999', user_id: '10001',
    group_id: '40001', message_id: 'g-1', raw_message: '群里说话', sender: { user_id: '10001' },
  })
  await flush()
  eq('G1 群聊静默丢弃且不回复', [socket.current.sent.length, calls.announce, calls.followup], [0, 0, 0])
  eq('G2 群聊计入 outOfScopeDrops', bridge.admissionStats.outOfScopeDrops, 1)

  socket.current.emit(privateEvent('10001', { sub_type: 'group', group_id: '40001' }))
  await flush()
  eq('G3 临时群聊静默丢弃', [socket.current.sent.length, bridge.admissionStats.outOfScopeDrops], [0, 2])

  socket.current.emit({
    post_type: 'message', message_type: 'guild', self_id: '99999', user_id: '10001',
    message_id: 'x-1', raw_message: '未知类型',
  })
  await flush()
  eq('G4 未知消息类型静默丢弃', [socket.current.sent.length, bridge.admissionStats.outOfScopeDrops], [0, 3])
  eq('G5 群聊/未知类型零会话', [calls.resume, calls.create, calls.announce], [0, 0, 0])
  await bridge.stop()
}

// ── H. 自己的消息不计入任何计数 ────────────────────────────────────────────
{
  const { bridge, socket } = makeContext()
  socket.current.emit({
    post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: '99999',
    user_id: '99999', message_id: 'self-1', raw_message: '我自己', sender: { user_id: '99999' },
  })
  await flush()
  eq('H1 自发消息不触发拒绝计数', bridge.admissionStats, {
    rejected: 0, rejectReplies: 0, rateLimitedDrops: 0, rejectSendErrors: 0, outOfScopeDrops: 0,
  })
  await bridge.stop()
}

// ── I. 拒绝回复发送失败：计数 + 不重试 + 零会话 ────────────────────────────
{
  const { bridge, socket, calls } = makeContext({ webSocket: ThrowingSocket })
  socket.current.emit(privateEvent('41001'))
  await flush()
  eq('I1 发送失败计入 rejectSendErrors', bridge.admissionStats.rejectSendErrors, 1)
  eq('I2 只尝试一次（不自动重试）', socket.current.attempts, 1)
  eq('I3 发送失败仍零会话', [calls.create, calls.followup, calls.announce], [0, 0, 0])
  await bridge.stop()
}

// ── J. 白名单缺失/非法：所有私聊都被拒绝 ───────────────────────────────────
{
  const { bridge, calls, socket, logs } = makeContext({ allowFrom: { owner: '10001', extra: ['*'] } })
  socket.current.emit(privateEvent('10001'))
  await flush()
  eq('J1 白名单非法时连 owner 也拒绝', [socket.current.sent.length, calls.create, calls.followup], [1, 0, 0])
  ok('J2 记录一次白名单告警', logs.some((item) => item.level === 'warn' && item.message.includes('白名单')))
  await bridge.stop()
}

// ── K. unknownPolicy 非 reject：仍按 reject 处理 ───────────────────────────
{
  const { bridge, socket, logs } = makeContext({ unknownPolicy: 'allow' })
  socket.current.emit(privateEvent('42001'))
  await flush()
  eq('K1 非法 unknownPolicy 仍拒绝', [socket.current.sent.length, bridge.admissionStats.rejected], [1, 1])
  ok('K2 记录 unknownPolicy 错误日志', logs.some((item) => item.level === 'error' && item.message.includes('unknownPolicy')))
  await bridge.stop()
}

console.log(`\n[P4-A qq-admission] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
