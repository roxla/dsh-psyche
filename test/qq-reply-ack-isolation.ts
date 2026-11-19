// P4-B-4-2b：无 echo ACK 的时间隔离（超时后不得结算后续 pending）。
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
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

class Socket {
  static all: Socket[] = []
  listeners = new Map<string, Array<(event?: unknown) => void>>()
  sent: Array<Record<string, unknown>> = []
  constructor(_url: string) {
    Socket.all.push(this)
  }
  addEventListener(name: string, callback: (event?: unknown) => void): void {
    const list = this.listeners.get(name) ?? []
    list.push(callback)
    this.listeners.set(name, list)
  }
  emit(name: string, value?: unknown): void {
    for (const callback of this.listeners.get(name) ?? []) callback(value)
  }
  message(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) })
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>)
  }
  close(): void {
    this.emit('close')
  }
}

function harness() {
  const timers: Array<() => void> = []
  const warnings: string[] = []
  const bridge = new QqBridge(
    {
      enabled: true,
      wsUrl: 'ws://127.0.0.1:1',
      accessToken: '',
      provider: 'probe',
      model: 'probe',
      allowFrom: { owner: '10001', extra: [] },
    },
    {
      host: {
        agents: {
          get: () => undefined,
          resume: async () => {
            throw new Error('not used')
          },
          create: async () => {
            throw new Error('not used')
          },
        },
        on: () => () => {},
      },
      adapter: { announce: () => {}, forget: () => {}, size: () => 0 },
      logger: { info() {}, error() {}, warn(text: string) { warnings.push(text) } },
      webSocket: Socket,
      isSessionBound: () => true,
      setTimeout: (callback: () => void) => {
        timers.push(callback)
        return callback
      },
      clearTimeout: () => {},
    },
  )
  return { bridge, timers, warnings }
}

console.log('[B-4-2b] ack time isolation')
const h = harness()
h.bridge.start()
const socket = Socket.all.at(-1)!
socket.emit('open')

const a = h.bridge.sendOutgoingText({ kind: 'private', userId: '10001' }, 'A')
await flush()
eq('A1 首次发送已写出', socket.sent.length, 1)
const firstEcho = socket.sent[0].echo
eq('A2 首次发送带 echo', typeof firstEcho, 'string')

const timer = h.timers.at(-1)
eq('A3 发送安排了超时', typeof timer, 'function')
timer?.()
const resultA = await a
eq('A4 超时归为 unknown', resultA.ok, false)
eq('A5 超时错误码', resultA.error, 'timeout')

const settled: Array<{ ok: boolean; messageId?: string; error?: string }> = []
void h.bridge.sendOutgoingText({ kind: 'private', userId: '10001' }, 'B').then((result) => settled.push(result))
await flush()
eq('B1 第二次发送已写出', socket.sent.length, 2)
const secondEcho = socket.sent[1].echo as string

socket.message({ status: 'ok', retcode: 0 })
await flush()
eq('B2 无 echo 回执不结算后续 pending', settled.length, 0)
eq(
  'B3 记录无法归属告警',
  h.warnings.some((line) => line.includes('无法可靠归属')),
  true,
)

socket.message({ status: 'ok', retcode: 0, echo: secondEcho, data: { message_id: 456 } })
await flush()
eq('B4 显式 echo 正常结算', settled.length, 1)
eq('B5 结算结果 ok', settled[0].ok, true)
eq('B6 返回平台 message_id', settled[0].messageId, '456')

h.bridge.stop()
console.log(`qq-reply-ack-isolation: ${passed} 通过, ${failed} 失败`)
if (failed > 0) process.exitCode = 1
