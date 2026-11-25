/**
 * P4-B-3-2：联系人策略接入 QQ 私聊准入后的行为。
 * 只测模块级：禁用/重复/全局失败关闭/额度/隔离/未授权优先；不含真实 Host。
 */
import { strict as assert } from 'node:assert'
import { QqBridge } from '../dist/lib/qq-bridge.js'

let passed = 0
function eq(label: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, label)
  passed += 1
}
function ok(label: string, value: unknown): void {
  assert.ok(value, label)
  passed += 1
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

class FakeSocket {
  static last: FakeSocket | null = null
  readonly url: string
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>()
  readonly sent: Array<Record<string, unknown>> = []
  #replies = 0
  constructor(url: string) {
    this.url = url
    FakeSocket.last = this
  }
  addEventListener(type: string, fn: (event: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }
  send(data: string): void {
    const parsed = JSON.parse(data) as Record<string, unknown>
    this.sent.push(parsed)
    const echo = parsed.echo
    queueMicrotask(() => {
      this.#replies += 1
      this.emit({ status: 'ok', retcode: 0, data: { message_id: `reply-${this.#replies}` }, echo })
    })
  }
  close(): void {}
  emit(event: unknown): void {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(event) })
  }
  actions(): string[] {
    return this.sent.map((item) => String(item.action))
  }
}

interface Calls { get: number; resume: number; create: number; followup: number; announce: number }

function makeBridge(overrides: Record<string, unknown> = {}) {
  const calls: Calls = { get: 0, resume: 0, create: 0, followup: 0, announce: 0 }
  const logs: Array<{ level: string; message: string; detail?: unknown }> = []
  const host = {
    agents: {
      get(): undefined {
        calls.get += 1
        return undefined
      },
      async resume(): Promise<never> {
        calls.resume += 1
        throw new Error('session not found: qq-private-10001')
      },
      async create(): Promise<{ agent: { followup(): void } }> {
        calls.create += 1
        return { agent: { followup(): void { calls.followup += 1 } } }
      },
    },
    on(): () => void {
      return () => {}
    },
  }
  const adapter = {
    announce(): void { calls.announce += 1 },
    forget(): void {},
    size(): number { return calls.announce },
  }
  const logger = {
    info(message: string, detail?: unknown): void { logs.push({ level: 'info', message, detail }) },
    warn(message: string, detail?: unknown): void { logs.push({ level: 'warn', message, detail }) },
    error(message: string, detail?: unknown): void { logs.push({ level: 'error', message, detail }) },
  }
  const config = {
    enabled: true,
    wsUrl: 'ws://127.0.0.1:1',
    accessToken: '',
    provider: 'test-provider',
    model: 'test-model',
    allowFrom: { owner: '10001', extra: ['10002', '10003'] },
    unknownPolicy: 'reject',
    rejectCooldownMs: 24 * 60 * 60_000,
    rejectGlobalLimit: 20,
    rejectGlobalWindowMs: 60 * 60_000,
    sendTimeoutMs: 5_000,
    ...overrides,
  }
  const bridge = new QqBridge(config, {
    host,
    adapter,
    logger,
    webSocket: FakeSocket as unknown as new (url: string) => unknown,
    allowLegacyAgentCreate: true,
    isSessionBound: () => true,
  })
  bridge.start()
  return { bridge, calls, logs, socket: FakeSocket.last as FakeSocket }
}

let seq = 0
function privateEvent(userId: string): Record<string, unknown> {
  seq += 1
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: '99999',
    user_id: userId,
    message_id: `m-${seq}`,
    raw_message: '你好',
    sender: { user_id: userId },
  }
}

// A. 无配置保持 B-2 行为
{
  const { bridge, calls, socket } = makeBridge()
  socket.emit(privateEvent('10001'))
  await flush()
  eq('A1 无配置仍投递', [calls.announce, calls.followup], [1, 1])
  eq('A2 无抑制计数', bridge.adminSnapshot().counts.contactSuppressed, 0)
  await bridge.stop()
}

// B. enabled:false → 零 announce/会话/回复，只计数
{
  const { bridge, calls, socket, logs } = makeBridge({ contacts: [{ stableUserId: '10001', enabled: false }] })
  socket.emit(privateEvent('10001'))
  await flush()
  eq('B1 禁用后不 announce/不 followup', [calls.announce, calls.followup, calls.create], [0, 0, 0])
  eq('B2 不发送任何消息', socket.actions(), [])
  eq('B3 抑制计数', bridge.adminSnapshot().counts.contactSuppressed, 1)
  const logged = logs.filter((item) => item.message.includes('联系人策略抑制'))
  eq('B4 记一条脱敏日志', logged.length, 1)
  eq('B5 日志原因', (logged[0]?.detail as { reason?: string } | undefined)?.reason, 'CONTACT_DISABLED')
  ok('B6 日志含脱敏引用不含完整 QQ 号', JSON.stringify(logged[0]?.detail).includes('10001') === false)
  await bridge.stop()
}

// C. 重复身份 → 明确拒绝，不回退默认允许
{
  const { bridge, calls, socket } = makeBridge({
    contacts: [{ stableUserId: '10001' }, { stableUserId: '10001', enabled: false }],
  })
  socket.emit(privateEvent('10001'))
  await flush()
  eq('C1 重复身份不投递', [calls.announce, calls.followup], [0, 0])
  eq('C2 重复身份计入抑制', bridge.adminSnapshot().counts.contactSuppressed, 1)
  await bridge.stop()
}

// D. 整份配置无法归属 → 全局失败关闭
{
  const { bridge, calls, socket } = makeBridge({ contacts: [{ stableUserId: 'bad' }] })
  socket.emit(privateEvent('10001'))
  await flush()
  eq('D1 全局失败关闭不投递', [calls.announce, calls.followup], [0, 0])
  eq('D2 全局失败关闭计数', bridge.adminSnapshot().counts.contactSuppressed, 1)
  await bridge.stop()
}

// E. 未授权联系人即使有策略仍先被准入拒绝
{
  const { bridge, calls, socket } = makeBridge({ contacts: [{ stableUserId: '88888', enabled: false }] })
  socket.emit(privateEvent('88888'))
  await flush()
  eq('E1 未授权仍不建会话', [calls.announce, calls.create, calls.followup], [0, 0, 0])
  eq('E2 未授权走拒绝回复而非策略抑制', bridge.adminSnapshot().counts.rejected, 1)
  eq('E3 策略抑制计数为 0', bridge.adminSnapshot().counts.contactSuppressed, 0)
  await bridge.stop()
}

// F. 额度：第一条投递，第二条抑制；A/B 隔离
{
  const { bridge, calls, socket } = makeBridge({
    contacts: [
      { stableUserId: '10001', maxPerHour: 1 },
      { stableUserId: '10002', maxPerHour: 1 },
    ],
  })
  socket.emit(privateEvent('10001'))
  await flush()
  socket.emit(privateEvent('10001'))
  await flush()
  socket.emit(privateEvent('10002'))
  await flush()
  eq('F1 每条联系人只投递一次', [calls.announce, calls.followup], [2, 2])
  eq('F2 超限与 A/B 隔离计数', bridge.adminSnapshot().counts.contactSuppressed, 1)
  await bridge.stop()
}

// G. 配置错误日志存在但不阻断桥启动
{
  const { bridge, logs } = makeBridge({ contacts: 'nope' })
  ok('G1 非法配置仍可构造/启动', bridge.adminSnapshot().running === true)
  ok('G2 记录脱敏告警', logs.some((item) => item.message.includes('联系人策略配置非法')))
  await bridge.stop()
}

process.stdout.write(`[P4-B-3-2 qq-contact-policy integration] ${passed} 通过 0 失败\n`)
