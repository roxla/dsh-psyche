// P4-A-3：QQ 只读管理页的数据层（模块级）。
//
// 覆盖：
// 1. 脱敏：账号/授权 ID 遮蔽、日志里的 token/密钥/长数字；
// 2. ring buffer：200 条、FIFO、seq 单调、入环前脱敏、快照副本；
// 3. payload：未启用空态、计数透传、日志透传；
// 4. 桥快照：连接态合成、心跳/账号/消息/发送时间与计数。
//
// 跑法：npm run build && node test/qq-admin.ts
import { QqBridge } from '../dist/lib/qq-bridge.js'
import {
  QQ_LOG_LIMIT,
  QqLogBuffer,
  buildQqAdminPayload,
  formatQqLogLine,
  maskQqId,
  redactQqLog,
} from '../dist/lib/qq-admin.js'

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

// ── A. ID 脱敏 ─────────────────────────────────────────────────────────────
{
  ok('A1 null → null', maskQqId(null) === null)
  ok('A2 空串 → null', maskQqId('  ') === null)
  ok('A3 短号全打码', maskQqId('12345') === '*****', maskQqId('12345'))
  eq('A4 长号前 3 后 2', maskQqId('123456789'), '123****89')
  eq('A5 十一位号', maskQqId('10001234567'), '100****67')
}

// ── B. 日志脱敏 ─────────────────────────────────────────────────────────────
{
  const bearer = redactQqLog('连接失败 Authorization: Bearer abcdef123456')
  ok('B1 Bearer 被替换', !bearer.includes('abcdef123456') && bearer.includes('Bearer ***'), bearer)
  const url = redactQqLog('ws://127.0.0.1:61980/?token=secret-token-xyz')
  ok('B2 URL token 被替换', !url.includes('secret-token-xyz'), url)
  const key = redactQqLog('配置 access_token=abc123 api_key=sk-live-1')
  ok('B3 键值密钥被替换', !key.includes('abc123') && !key.includes('sk-live-1'), key)
  const digits = redactQqLog('拒绝未授权私聊 123456789')
  ok('B4 长数字按 ID 脱敏', !digits.includes('123456789'), digits)
  const plain = redactQqLog('[psyche][qq] OneBot WS 已连接')
  eq('B5 普通文本不变', plain, '[psyche][qq] OneBot WS 已连接')
}

// ── C. Ring buffer ──────────────────────────────────────────────────────────
{
  const buf = new QqLogBuffer()
  buf.push('info', '第一条')
  buf.push('warn', '第二条')
  const snap1 = buf.snapshot()
  eq('C1 seq 从 1 单调递增', snap1.map((item) => item.seq), [1, 2])
  eq('C2 级别保留', snap1.map((item) => item.level), ['info', 'warn'])
  snap1[0].message = '被外部改了'
  eq('C3 snapshot 是副本', buf.snapshot()[0].message, '第一条')

  for (let index = 0; index < QQ_LOG_LIMIT + 20; index += 1) buf.push('info', `第 ${index} 条`)
  const capped = buf.snapshot()
  ok('C4 只保留 200 条', capped.length === QQ_LOG_LIMIT, capped.length)
  ok('C5 FIFO 丢最旧', capped[0].message === '第 20 条', capped[0].message)
  ok('C6 seq 连续到 222', capped[capped.length - 1].seq === QQ_LOG_LIMIT + 22, capped[capped.length - 1].seq)

  const secret = new QqLogBuffer()
  secret.push('info', 'token=abc123456，账号 123456789')
  const stored = secret.snapshot()[0].message
  ok('C7 入环前已脱敏', !stored.includes('abc123456') && !stored.includes('123456789'), stored)
}

// ── D. 行格式 ───────────────────────────────────────────────────────────────
{
  eq('D1 无 detail 原样', formatQqLogLine('hello'), 'hello')
  const withDetail = formatQqLogLine('投递失败', { sessionId: 'qq-private-1', error: 'boom' })
  ok('D2 detail 被 JSON 化', withDetail.includes('qq-private-1') && withDetail.includes('boom'), withDetail)
}

// ── E. payload 组装 ─────────────────────────────────────────────────────────
{
  const disabled = buildQqAdminPayload({ enabled: false, snapshot: null, logs: [] })
  eq('E1 未启用空态', [disabled.enabled, disabled.connection, disabled.counts.received], [false, 'unknown', 0])

  const snapshot = {
    running: true,
    connection: 'connected' as const,
    accountOnline: true,
    selfId: '10001234567',
    nickname: '小鲸鱼',
    allowFromValid: true,
    allowFromOwner: '10001',
    allowFromExtra: ['10002', '10003'],
    allowFromGroups: ['30001'],
    counts: {
      received: 9,
      delivered: 4,
      sendErrors: 1,
      rejected: 3,
      rejectReplies: 2,
      rateLimitedDrops: 1,
      rejectSendErrors: 1,
      outOfScopeDrops: 5,
    },
    lastHeartbeatAt: '2026-11-13T00:00:00.000Z',
    lastMessageAt: '2026-11-13T00:00:01.000Z',
    lastSentAt: '2026-11-13T00:00:02.000Z',
  }
  const payload = buildQqAdminPayload({
    enabled: true,
    snapshot,
    logs: [{ seq: 1, at: '2026-11-13T00:00:00.000Z', level: 'info', message: 'ok' }],
  })
  eq('E2 账号脱敏', payload.account.uinMasked, '100****67')
  eq('E3 owner 脱敏', payload.allowFrom.ownerMasked, '*****')
  eq('E4 extra 脱敏', payload.allowFrom.extraMasked, ['*****', '*****'])
  eq('E4b 群白名单脱敏', [payload.allowFrom.groupsCount, payload.allowFrom.groupsMasked], [1, ['*****']])
  ok('E5 昵称保留', payload.account.nickname === '小鲸鱼')
  eq('E6 计数原样', payload.counts.rejected, 3)
  eq('E7 日志透传', payload.logs.length, 1)
  eq('E8 活动时间', payload.activity.lastSentAt, '2026-11-13T00:00:02.000Z')
}

// ── F. 桥快照 ───────────────────────────────────────────────────────────────
class FakeSocket {
  static last = null
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
  open() {
    for (const fn of this.listeners.get('open') ?? []) fn({})
  }
  emit(event) {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(event) })
  }
}

function makeBridge() {
  const calls = { followup: 0 }
  const logger = { info() {}, warn() {}, error() {} }
  const host = {
    agents: {
      get() {
        return undefined
      },
      async resume() {
        throw new Error('session not found: qq-private-10001')
      },
      async create() {
        return { agent: { followup() { calls.followup += 1 } } }
      },
    },
    on() {
      return () => {}
    },
  }
  const adapter = { announce() {}, forget() {}, size() { return 1 } }
  const bridge = new QqBridge(
    {
      enabled: true,
      wsUrl: 'ws://127.0.0.1:1',
      accessToken: '',
      provider: 'p',
      model: 'm',
      allowFrom: { owner: '10001', extra: ['10002'] },
      unknownPolicy: 'reject',
      sendTimeoutMs: 2_000,
    },
    { host, adapter, logger, webSocket: FakeSocket, allowLegacyAgentCreate: true, isSessionBound: () => true },
  )
  bridge.start()
  return { bridge, socket: FakeSocket.last }
}

let eventSeq = 0
function event(extra = {}) {
  eventSeq += 1
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: '99999',
    user_id: '10001',
    message_id: `x-${eventSeq}`,
    raw_message: '你好',
    sender: { user_id: '10001' },
    ...extra,
  }
}

{
  const { bridge, socket } = makeBridge()
  const before = bridge.adminSnapshot()
  eq('F1 未 open 时 disconnected', before.connection, 'disconnected')
  ok('F2 初始计数全零', before.counts.received === 0 && before.counts.delivered === 0)

  socket.open()
  // 刚 open 时还没有心跳/bot_status：WS 在线但健康不可证，按 unknown 展示。
  eq('F3 open 后尚未有健康信号 → unknown', bridge.adminSnapshot().connection, 'unknown')

  socket.emit({
    post_type: 'meta_event',
    meta_event_type: 'heartbeat',
    self_id: '99999',
    status: { good: true, online: true },
    time: 1,
  })
  const afterHeartbeat = bridge.adminSnapshot()
  ok('F4 心跳刷新 lastHeartbeatAt', typeof afterHeartbeat.lastHeartbeatAt === 'string')
  eq('F5 心跳记录 selfId', afterHeartbeat.selfId, '99999')

  socket.emit({
    post_type: 'notice',
    notice_type: 'bot_status',
    sub_type: 'online',
    self_id: '99999',
  })
  eq('F6 bot_status 置在线', bridge.adminSnapshot().accountOnline, true)
  eq('F6b 心跳与账号信号齐了 → connected', bridge.adminSnapshot().connection, 'connected')

  socket.emit(event())
  await flush()
  const afterMessage = bridge.adminSnapshot()
  eq('F7 收到消息 +1', afterMessage.counts.received, 1)
  eq('F8 已投递 +1', afterMessage.counts.delivered, 1)
  ok('F9 最近消息时间已填', typeof afterMessage.lastMessageAt === 'string')

  socket.emit(event({ user_id: '20002', sender: { user_id: '20002' }, message_id: 'unauth-1' }))
  await flush()
  const afterReject = bridge.adminSnapshot()
  eq('F10 未授权私聊计入 rejected', afterReject.counts.rejected, 1)
  eq('F11 拒绝回复计入 rejectReplies', afterReject.counts.rejectReplies, 1)
  ok('F12 拒绝回复成功后 lastSentAt 已填', typeof afterReject.lastSentAt === 'string')

  socket.emit({
    post_type: 'notice',
    notice_type: 'bot_status',
    sub_type: 'offline',
    self_id: '99999',
  })
  eq('F13 账号离线后降级 degraded', bridge.adminSnapshot().connection, 'degraded')

  await bridge.stop()
  const stopped = bridge.adminSnapshot()
  eq('F14 stop 后 disconnected', stopped.connection, 'disconnected')
  eq('F15 stop 后 running=false', stopped.running, false)
}

console.log(`\n[P4-A-3 qq-admin] ${passed} 通过 ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
