// C-3b：每个显式人工任务独占一个真实 QQ 连接，一条动作结算后立即关闭。
import type { ChatTransport } from 'dsh-psyche-core'
import { createHash } from 'node:crypto'
import { QqBridge } from './qq-bridge.js'
import { createQqTransport } from './qq-transport.js'

export interface OwnerQqConnectionOptions {
  readonly wsUrl: string
  readonly token: string
  readonly senderAccount: string
  readonly sendTimeoutMs?: number
}

export function createOwnerQqConnection(options: OwnerQqConnectionOptions): {
  transport: ChatTransport
  connect(timeoutMs?: number): Promise<void>
} {
  let used = false
  let closed = false
  let verified = false
  const bridge = new QqBridge({
    enabled: true, wsUrl: options.wsUrl, accessToken: options.token,
    provider: '', model: '', receiveMessages: false, sendTimeoutMs: options.sendTimeoutMs,
    allowFrom: { owner: options.senderAccount, extra: [] },
  }, {
    host: { on: () => () => {} },
    adapter: { announce: () => { throw new Error('Outbound connection cannot announce identities') }, forget() {}, size: () => 0 },
    logger: { info() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  })
  const transport = createQqTransport({
    sendText: (target, text) => bridge.sendOutgoingText(target, text, { strictAck: true }),
    status: () => bridge.transportStatus(),
    waitConnected: (ms) => bridge.transportWaitConnected(ms),
  }, { purpose: 'proactive', id: `qq-onebot-owner:${createHash('sha256').update(options.senderAccount).digest('hex').slice(0, 16)}` })
  const close = async () => {
    if (closed) return
    closed = true
    verified = false
    await bridge.stop()
  }
  return {
    transport: {
      ...transport,
      status: () => !closed && verified && bridge.adminSnapshot().selfId === options.senderAccount ? transport.status() : 'disconnected',
      async waitConnected(timeoutMs) {
        return !closed && verified && await transport.waitConnected(timeoutMs) && bridge.adminSnapshot().selfId === options.senderAccount
      },
      async send(target, outgoing) {
        if (closed || !verified || used) return { outcome: 'permanent', errorCode: 'connection-not-available' }
        if (bridge.adminSnapshot().selfId !== options.senderAccount) {
          await close()
          return { outcome: 'permanent', errorCode: 'sender-account-mismatch' }
        }
        used = true
        try { return await transport.send(target, outgoing) } finally { await close() }
      },
      close,
    },
    async connect(timeoutMs = 15_000) {
      if (closed || used) throw new Error('发送连接已关闭')
      bridge.start()
      if (!(await bridge.transportWaitConnected(timeoutMs)) || bridge.adminSnapshot().selfId !== options.senderAccount) {
        await close()
        throw new Error('QQ 连接不可用或发送账号不匹配')
      }
      verified = true
    },
  }
}
