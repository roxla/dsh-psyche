/**
 * R6-3C-Offline：QQ Channel Adapter 骨架。
 *
 * 契约边界（R6-3A）：
 * - Adapter 只提交 `ChannelIdentityClaim`，不碰 RuntimeInputStore、不碰 SQLite；
 * - `resolveIdentity()` 只回答「这个 Session 在平台上是谁」，Contact/Room 由 Host+Core 解析；
 * - 群聊的 claim 只声明 group + externalRoomId，发送者 QQ 号仅作为 stableUserId 上报，
 *   绑定时不会因此获得发送者的私聊 Contact 权限（R6-3B 对 group 不解析 contactId）。
 *
 * 这里不实现网络：SnowLuma 消息到达、会话映射、Agent 创建时机由将来的桥接层驱动；
 * 本文件只冻结 Adapter 的注册形状与生命周期，供 Host 受控注册与离线测试。
 */
import type {
  ChannelAdapterDefinition,
  ChannelIdentityClaim,
  ChannelIdentityContext,
} from 'dsh-psyche-contract'

export interface QqAdapterOptions {
  /** 注册时使用的 adapterId；Host 用它决定谁可以注册、权限白名单怎么配。 */
  adapterId?: string
  /** 平台标识；必须与 Host 与该 Adapter 约定的 platform 一致。 */
  platform?: string
}

export interface QqAdapter {
  /** 交给 Host 的注册定义；Adapter 自己不能直接注册。 */
  definition: ChannelAdapterDefinition
  /**
   * 登记一个会话的身份声明。
   *
   * 由桥接层在「收到该会话第一条可信消息、确定 sessionId」后调用。
   * 没有登记就 resolveIdentity 返回 null，Host 只允许全局记忆。
   */
  announce(sessionId: string, claim: ChannelIdentityClaim): void
  /** 会话结束（例如 QQ 会话被关闭）时清理，避免旧声明被复用。 */
  forget(sessionId: string): void
  /** 当前登记的会话数（测试与审计用）。 */
  size(): number
  /** Adapter 关闭：清空所有声明；Host 仍应注销注册以让 generation 失效。 */
  dispose(): void
}

/**
 * 创建一个离线 QQ Adapter。
 *
 * 默认 adapterId=`qq-snowluma`、platform=`qq`、allowedSurfaces=`['private','group']`。
 * 不包含 personal——QQ 永远不会是桌面个人表面。
 */
export function createQqAdapter(options: QqAdapterOptions = {}): QqAdapter {
  const adapterId = options.adapterId ?? 'qq-snowluma'
  const platform = options.platform ?? 'qq'
  const pending = new Map<string, ChannelIdentityClaim>()
  let disposed = false

  const definition: ChannelAdapterDefinition = {
    adapterId,
    platform,
    allowedSurfaces: ['private', 'group'],
    resolveIdentity(context: ChannelIdentityContext): ChannelIdentityClaim | null {
      if (disposed) return null
      return pending.get(context.sessionId) ?? null
    },
  }

  return {
    definition,
    announce(sessionId: string, claim: ChannelIdentityClaim): void {
      if (disposed) return
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      // 只接受与注册平台一致的会话类型；personal 不属于 QQ。
      if (claim.kind !== 'private' && claim.kind !== 'group') return
      pending.set(sessionId, claim)
    },
    forget(sessionId: string): void {
      pending.delete(sessionId)
    },
    size(): number {
      return pending.size
    },
    dispose(): void {
      disposed = true
      pending.clear()
    },
  }
}
