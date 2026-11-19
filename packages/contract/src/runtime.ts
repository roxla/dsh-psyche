/**
 * 运行时输入：任何通道送进 Core 的东西都先归一成这个形状。
 * 通道只负责「平台字段 → RuntimeInput」，不在这里做归因、更不写库。
 */
export const PSYCHE_SURFACES = ['desktop', 'qq', 'pet', 'web', 'ops'] as const
export type PsycheSurface = (typeof PSYCHE_SURFACES)[number]

export interface RuntimeInput {
  surface: PsycheSurface
  /** 宿主会话 id；同一会话内多轮共享。 */
  sessionId: string
  /** 真正说话的人。群聊里是发言者，不是房间。 */
  speakerId: string
  /** 这一轮对方说的话（已去掉平台标记）。 */
  text: string
  /** 私聊 true；群聊 false。归因规则依赖它，通道必须如实填。 */
  privateChat: boolean
  /** 收到时间（ISO）。Core 用它算活动窗口，不接受通道自造时钟。 */
  receivedAt: string
  messageId?: string
  channelId?: string
  roomId?: string
  replyToMessageId?: string
  mentions?: string[]
}

/** 采集结果：sourceId 是后续所有引用的锚。 */
export interface CaptureResult {
  sourceId: string
  /** 同一条消息重放时为 true（幂等命中，没有重复落库）。 */
  replayed: boolean
  /** 这条消息所属的 10 分钟活动窗口键；P1-2 起由 Core 规则生成。 */
  activityKey?: string
}
