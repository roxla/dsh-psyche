/**
 * P4-C-0：ChatTransport 契约。
 *
 * 只定义「把一条消息送到某个通道」的最小能力；不判断 Consent、Affinity、Trust、
 * Owner Approval 等业务概念，不做重试、不持久化、不做跨通道切换。
 *
 * 发送结果的四态是契约的一部分：
 * - accepted：通道接受了消息（只代表「平台接受」，不代表对方已读）
 * - retryable：本次失败但可重试（如通道暂时离线）
 * - permanent：本次失败且重试无意义（如参数非法、被平台拒绝）
 * - unknown：结果未知（如等待回执超时），调用方必须核验，绝不能自动重发
 */
export interface ChatTransportCapabilities {
  readonly text: boolean
  readonly image: boolean
  readonly replyQuote: boolean
  readonly proactive: boolean
}

export type ChatTransportState = 'connected' | 'degraded' | 'disconnected' | 'unknown'

export type ChatTarget =
  | { readonly kind: 'private'; readonly platform: string; readonly stableUserId: string }
  | { readonly kind: 'group'; readonly platform: string; readonly groupId: string }

export interface ChatOutgoing {
  readonly text: string
  /** 要引用回复的原消息 id；普通回复可不填。 */
  readonly replyToMessageId?: string | null
}

export type ChatSendOutcome = 'accepted' | 'retryable' | 'permanent' | 'unknown'

export interface ChatSendResult {
  readonly outcome: ChatSendOutcome
  readonly messageId?: string
  readonly errorCode?: string
  /** 仅 retryable 有意义：平台建议的重试间隔；Worker 会 clamp 到 30s–10min。 */
  readonly retryAfterMs?: number
}

export interface ChatTransport {
  /** 稳定标识；审批绑定与 outbox 使用。 */
  readonly id: string
  /** 平台标识，如 qq / telegram；用于校验「不跨平台」。 */
  readonly platform: string

  status(): ChatTransportState
  /** 等到可用或超时；返回是否已连接。不得内部重试发送。 */
  waitConnected(timeoutMs: number): Promise<boolean>
  capabilities(): ChatTransportCapabilities

  /** 发送一条文本；只表达一次请求与结果，不重试、不持久化。 */
  send(target: ChatTarget, outgoing: ChatOutgoing): Promise<ChatSendResult>

  /** 释放连接/监听；重复调用幂等。 */
  close(): Promise<void>
}

export function chatTargetKey(target: ChatTarget): string {
  return target.kind === 'private'
    ? `${target.platform}:private:${target.stableUserId}`
    : `${target.platform}:group:${target.groupId}`
}

/**
 * 测试与本地编排用的内存 Transport。
 * - 默认 accepted 并回显序号；
 * - `outcomes` 队列可指定接下来几次的结果；
 * - `delayMs` 模拟慢通道；
 * - `sends` 记录每次调用，便于断言「发送前六项复核」之类的外部顺序。
 */
export interface MockTransportOptions {
  readonly id?: string
  readonly platform?: string
  readonly state?: ChatTransportState
  readonly capabilities?: Partial<ChatTransportCapabilities>
  readonly outcomes?: readonly ChatSendResult[]
  readonly delayMs?: number
}

export interface MockSendRecord {
  readonly target: ChatTarget
  readonly outgoing: ChatOutgoing
}

export class MockChatTransport implements ChatTransport {
  readonly id: string
  readonly platform: string
  readonly sends: MockSendRecord[] = []
  #state: ChatTransportState
  #capabilities: ChatTransportCapabilities
  #outcomes: ChatSendResult[]
  #delayMs: number
  #closed = false

  constructor(options: MockTransportOptions = {}) {
    this.id = options.id ?? 'mock'
    this.platform = options.platform ?? 'mock'
    this.#state = options.state ?? 'connected'
    this.#capabilities = {
      text: options.capabilities?.text ?? true,
      image: options.capabilities?.image ?? false,
      replyQuote: options.capabilities?.replyQuote ?? true,
      proactive: options.capabilities?.proactive ?? false,
    }
    this.#outcomes = [...(options.outcomes ?? [])]
    this.#delayMs = options.delayMs ?? 0
  }

  status(): ChatTransportState {
    return this.#closed ? 'disconnected' : this.#state
  }

  setState(state: ChatTransportState): void {
    this.#state = state
  }

  capabilities(): ChatTransportCapabilities {
    return { ...this.#capabilities }
  }

  async waitConnected(timeoutMs: number): Promise<boolean> {
    if (this.status() === 'connected' || this.status() === 'degraded') return true
    if (timeoutMs <= 0) return false
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      // 不 unref：测试里能稳定等到超时；生产实现由宿主定时器管理。
      void timer
    })
    return this.status() === 'connected' || this.status() === 'degraded'
  }

  async send(target: ChatTarget, outgoing: ChatOutgoing): Promise<ChatSendResult> {
    if (this.#closed) return { outcome: 'permanent', errorCode: 'transport-closed' }
    this.sends.push({ target, outgoing })
    if (this.#delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.#delayMs)
      })
    }
    const preset = this.#outcomes.shift()
    if (preset !== undefined) return preset
    return { outcome: 'accepted', messageId: `mock-${this.sends.length}` }
  }

  async close(): Promise<void> {
    this.#closed = true
  }
}
