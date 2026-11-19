/**
 * R6-3C-Offline：SnowLuma OneBot 事件 → ChannelIdentityClaim。
 *
 * 这一层只做一件事：把平台事件翻译成「平台说这个人是谁」。
 * 它不解析 Contact、不解析 Room、不接触 RuntimeInputStore、
 * 更不能自己授予可信身份——那些是 Host 与 Core 的职责（见 R6-3A 契约）。
 *
 * 安全口径：
 * - 只认 OneBot 11 的 message 事件（post_type === 'message'）；
 * - 私聊与群聊都必须带**纯数字**的稳定 QQ 号（拒绝昵称、空串、带前缀的显示名）；
 * - **私聊必须区分 `sub_type`**：只有 `friend` 才是好友私聊；`group` 是从群聊发起的
 *   临时会话、`other` 是其他私聊——它们不生成 Claim（群临时会话缺少标准 Room 身份，
 *   宁可不给记忆，也不能退化成普通私聊权限）；
 * - 群聊虽然带发送者 QQ 号，但 claim 只声明 group + externalRoomId，
 *   绑定时 `resolveTrustedBinding` 对 group 不解析 contactId（R6-3B 语义），
 *   所以「群成员身份」不会被转换成「私聊 Contact 权限」；
 * - 任何字段缺失或不可信 → 返回 null（fail closed，不做猜测）。
 */
import type { ChannelIdentityClaim } from 'dsh-psyche-contract'

/** OneBot 11 message 事件的最小字段集（SnowLuma 桥接会透传这些）。 */
export interface SnowLumaMessageEvent {
  post_type?: string
  message_type?: string
  /** private 的细分：friend / group（群临时会话）/ other；group 消息为 normal 等。 */
  sub_type?: string
  /** 发送者 QQ 号（私聊对端 / 群成员）。 */
  user_id?: number | string
  /** 群号（仅群聊）。 */
  group_id?: number | string
  /** 机器人自身 QQ 号（仅审计用，不进入 claim）。 */
  self_id?: number | string
  message_id?: number | string
  raw_message?: string
}

/** 纯数字 QQ 号：1–20 位，不允许前导零、不允许小数、不允许空。 */
const QQ_ID = /^[1-9][0-9]{0,19}$/

function stableId(value: number | string | undefined): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return null
    return String(value)
  }
  const text = value.trim()
  return QQ_ID.test(text) ? text : null
}

/**
 * 把一条 SnowLuma 事件转成身份声明。
 *
 * 返回 null 表示「这条事件不能建立可信身份」——调用方必须按未绑定处理，
 * 只允许全局记忆，不得回退成「按名字猜一个人」。
 */
export function toIdentityClaim(event: SnowLumaMessageEvent | null | undefined): ChannelIdentityClaim | null {
  if (event === null || event === undefined) return null
  if (event.post_type !== 'message') return null

  const sender = stableId(event.user_id)
  if (sender === null) return null

  if (event.message_type === 'private') {
    // OneBot 11：private 的 sub_type 有 friend / group / other 三种。
    // group 是「群临时会话」——它仍带 message_type=private，但身份来自某个群，
    // 不是好友私聊；当前没有把它映射成 Room Scope 的契约，因此一律拒绝。
    if (event.sub_type !== 'friend') return null
    return { kind: 'private', stableUserId: sender, channelId: null }
  }

  if (event.message_type === 'group') {
    const room = stableId(event.group_id)
    if (room === null) return null
    return { kind: 'group', stableUserId: sender, externalRoomId: room, channelId: null }
  }

  return null
}

/** 事件是否携带可采集的正文（只用于将来接桥时效验，不代表已采集）。 */
export function hasTextBody(event: SnowLumaMessageEvent | null | undefined): boolean {
  if (event === null || event === undefined) return false
  if (typeof event.raw_message !== 'string') return false
  return event.raw_message.trim().length > 0
}
