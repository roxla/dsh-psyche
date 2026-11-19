// 可信桥接输入；只供宿主集成，不注册模型工具或 HTTP。
import type { GroupPart, RoomPolicy } from './group-policy.js'
export type GroupCaptureMode = 'mentioned_only' | 'all_visible_messages'
export interface GroupMessageInput {
  opId?: string
  externalRoomId: string
  stableUserId: string
  messageId: string
  selfId?: string | null
  mentions?: string[]
  replyToMessageId?: string | null
  text: string
  captureMode: GroupCaptureMode
  at?: string
  policy?: RoomPolicy
  parts?: GroupPart[]
  /** Host 内部能力准备就绪；默认 false，不因打开采集而开始调度。 */
  schedulingReady?: boolean
}
export interface GroupMessageResult {
  roomId: string
  roomSeq: number
  sourceId: string | null
  eventId: string | null
  retained: boolean
  replayed: boolean
}
