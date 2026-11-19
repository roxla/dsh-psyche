/**
 * P4-C-0：把现有 QQ 通道包装成 `ChatTransport`。
 *
 * 这里只做「消息投递」：不判断 Consent / Affinity / Trust / Owner Approval，
 * 不重试、不持久化、不跨平台。发送结果按四态映射：
 * - ok → accepted
 * - timeout → unknown（结果未知，调用方必须核验）
 * - not-connected → retryable
 * - 其他 → permanent
 */
import type {
  ChatOutgoing,
  ChatSendResult,
  ChatTarget,
  ChatTransport,
  ChatTransportCapabilities,
  ChatTransportState,
} from 'dsh-psyche-core'

export type QqTransportTarget =
  | { readonly kind: 'private'; readonly userId: string }
  | { readonly kind: 'group'; readonly groupId: string }

export interface QqTransportSendResult {
  readonly ok: boolean
  readonly messageId?: string
  readonly error?: string
  /** P4-B-2：引用是否真正写入；仅用于诊断，不改变四态映射。 */
  readonly quote?: 'applied' | 'omitted-unbound' | 'omitted-unsupported'
}

export interface QqTransportDeps {
  sendText(target: QqTransportTarget, text: string, replyToMessageId?: string | null): Promise<QqTransportSendResult>
  status(): ChatTransportState
  waitConnected(timeoutMs: number): Promise<boolean>
}

export interface QqTransportOptions {
  readonly id?: string
  /** 主动消息严格分类；普通来源回复保留已验收的通用映射。 */
  readonly purpose?: 'reply' | 'proactive'
}

export const QQ_TRANSPORT_ID = 'qq-onebot'
export const QQ_TRANSPORT_PLATFORM = 'qq'

const CAPABILITIES: ChatTransportCapabilities = Object.freeze({
  text: true,
  image: false,
  replyQuote: true,
  proactive: true,
})

function toBridgeTarget(target: ChatTarget): QqTransportTarget | null {
  if (target.kind === 'private') {
    if (target.platform !== QQ_TRANSPORT_PLATFORM) return null
    if (target.stableUserId.trim() === '') return null
    return { kind: 'private', userId: target.stableUserId }
  }
  if (target.platform !== QQ_TRANSPORT_PLATFORM) return null
  if (target.groupId.trim() === '') return null
  return { kind: 'group', groupId: target.groupId }
}

export function mapQqSendResult(result: QqTransportSendResult): ChatSendResult {
  if (result.ok) {
    return result.messageId === undefined
      ? { outcome: 'accepted' }
      : { outcome: 'accepted', messageId: result.messageId }
  }
  if (result.error === 'timeout') {
    return { outcome: 'unknown', errorCode: 'send-timeout' }
  }
  if (result.error === 'retcode:429') {
    return { outcome: 'retryable', errorCode: 'rate_limited' }
  }
  if (result.error === 'not-connected') {
    return { outcome: 'retryable', errorCode: 'not-connected' }
  }
  return { outcome: 'permanent', errorCode: result.error ?? 'send-failed' }
}

export function mapQqProactiveSendResult(result: QqTransportSendResult): ChatSendResult {
  if (result.ok) return result.messageId === undefined ? { outcome: 'accepted' } : { outcome: 'accepted', messageId: result.messageId }
  if (result.error === 'retcode:429') return { outcome: 'retryable', errorCode: 'rate_limited' }
  if (result.error === 'not-connected') return { outcome: 'permanent', errorCode: 'transport_offline_before_send' }
  if (typeof result.error === 'string' && /^retcode:-?\d+$/.test(result.error)) {
    return { outcome: 'permanent', errorCode: result.error }
  }
  return { outcome: 'unknown', errorCode: result.error ?? 'unknown_send_result' }
}

export function createQqTransport(deps: QqTransportDeps, options: QqTransportOptions = {}): ChatTransport {
  const id = options.id ?? QQ_TRANSPORT_ID
  return {
    id,
    platform: QQ_TRANSPORT_PLATFORM,
    status: () => deps.status(),
    capabilities: () => CAPABILITIES,
    async waitConnected(timeoutMs: number): Promise<boolean> {
      if (deps.status() === 'connected' || deps.status() === 'degraded') return true
      try {
        return await deps.waitConnected(timeoutMs)
      } catch {
        return false
      }
    },
    async send(target: ChatTarget, outgoing: ChatOutgoing): Promise<ChatSendResult> {
      if (outgoing.text.trim() === '') {
        return { outcome: 'permanent', errorCode: 'empty-text' }
      }
      const bridgeTarget = toBridgeTarget(target)
      if (bridgeTarget === null) {
        return { outcome: 'permanent', errorCode: 'unsupported-target' }
      }
      if (options.purpose === 'proactive' && bridgeTarget.kind !== 'private') {
        return { outcome: 'permanent', errorCode: 'unsupported-target' }
      }
      try {
        const replyTo = options.purpose === 'proactive' ? null : outgoing.replyToMessageId ?? null
        const result = await deps.sendText(bridgeTarget, outgoing.text, replyTo)
        return options.purpose === 'proactive' ? mapQqProactiveSendResult(result) : mapQqSendResult(result)
      } catch {
        return { outcome: 'unknown', errorCode: 'send-exception' }
      }
    },
    async close(): Promise<void> {
      // 连接归 QqBridge 所有；Transport 只释放自己的引用，不关闭共享 socket。
    },
  }
}
