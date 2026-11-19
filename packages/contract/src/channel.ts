/**
 * 可信通道绑定契约（R6-3A）。
 *
 * 这里冻结的是「谁有权声明身份」与「谁有权建立可信绑定」的分界：
 * - Adapter 只能提交 ChannelIdentityClaim（平台稳定身份 + 会话类型），
 *   不能填写 contactId / roomId / surface / trustedSource；
 * - Host 负责把声明转换成 TrustedChannelBinding，
 *   Contact 与 Room 一律由 Core 按 platform + 稳定身份解析。
 *
 * 这两个对象不是同一个东西：
 * - 声明是「平台说这个人是谁」，可能不完整、可能解析失败；
 * - 绑定是「本机确认这个 Session 现在能以什么身份访问什么」，
 *   缺任何一项都只能收紧（fail closed），不能放宽。
 */

/** 运行表面：决定这一轮允许访问哪个域。 */
export type RuntimeSurface = 'personal' | 'private' | 'group'

/**
 * Adapter 提供的身份声明。
 * 特意不包含 contactId / roomId / surface / trustedSource —— 那些是 Host 与 Core 的职责。
 */
export type ChannelIdentityClaim =
  | {
      kind: 'personal'
      stableUserId: string
      channelId?: string | null
    }
  | {
      kind: 'private'
      stableUserId: string
      channelId?: string | null
    }
  | {
      kind: 'group'
      stableUserId: string
      /** 平台外部群 ID（例如 QQ 群号）；必须由平台稳定提供，不能用群名称。 */
      externalRoomId: string
      channelId?: string | null
    }

/** Adapter 被 Host 调用时拿到的上下文；sessionId 由 Host 提供，Adapter 不能自行指定。 */
export interface ChannelIdentityContext {
  agentId: string
  sessionId: string
  platform: string
}

/**
 * 一个 Adapter 的注册定义。
 * allowedSurfaces 是注册时登记的能力白名单；声明了白名单之外的 surface 直接拒绝绑定。
 */
export interface ChannelAdapterDefinition {
  adapterId: string
  platform: string
  allowedSurfaces?: ReadonlyArray<RuntimeSurface>
  resolveIdentity(
    context: ChannelIdentityContext,
  ): Promise<ChannelIdentityClaim | null> | ChannelIdentityClaim | null
}

/** Host 内部构造的可信绑定；Adapter 不能直接构造它。 */
export interface TrustedChannelBinding {
  sessionId: string
  platform: string
  stableUserId: string
  contactId: string | null
  groupId: string | null
  roomId: string | null
  channelId: string | null
  surface: RuntimeSurface
  trustedSource: 'channel-adapter' | 'host'
}

/** 身份声明被拒绝的原因（内部审计用，不直接透给模型）。 */
export type ChannelBindingRejection =
  | 'no-adapter'
  | 'surface-not-allowed'
  | 'invalid-claim'
  | 'group-missing-room'
  | 'private-with-room-context'
  | 'adapter-inactive'

export interface ChannelBindingResolution {
  ok: true
  binding: TrustedChannelBinding
}
