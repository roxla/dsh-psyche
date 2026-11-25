/**
 * Q5 渠道判定：一次调用能不能读到别处的内容，取决于「谁来问」。
 *
 * 起因（第 28 轮真实宿主测试暴露的缺陷）：
 * - 原来 `conversationRecall` 把 `platform` 写死成 `['dsh-session','dsh','desktop']`。
 *   那只说明「查不到 QQ 自己的源」，反过来 QQ 会话调用时，仍然会读到桌面会话的原文。
 * - `projectBrief` 同理：它固定按 `desktop` 查项目绑定，QQ 会话也会命中桌面绑定的项目。
 *
 * 第 29 轮补的两条边界：
 * - 「其余 sessionRef 一律 desktop」过宽——一个 UUID 可以属于 Desktop 主会话，
 *   也可以是 Desktop 派出去的子代理会话；后者不该把主人的日常原话读进自己的上下文。
 * - 只按 `qq-private-<uin>` 的形状判 Owner，拿不到可信身份。可信来源是
 *   RuntimeInput 绑定（Adapter 声明、Core 解析）里的 platform / contactId / groupId，
 *   形状判定只作为「宿主没有绑定」时的退路。
 */

export type SessionChannelKind = 'desktop' | 'owner-private' | 'other'
export interface SessionChannel {
  kind: SessionChannelKind
  /**
   * 这类接收者能读的 `sources.platform` 集合。
   * 空数组表示「这一类不给任何源」。
   */
  platforms: string[]
  /**
   * 只读某个 channel 的源（例如 QQ 私聊只读 `private`，避免把群聊内容带进来）。
   * null 表示不额外限制。
   */
  sourceChannel: string | null
}

/**
 * 宿主可信绑定：来自 `RuntimeInputStore.readForAgent(agent)`，
 * 由 Adapter 提交、Core 解析，不是从会话标识里猜出来的。
 */
export interface ChannelBinding {
  /** `qq` / `desktop` / `web` / `system` / `dsh` 等。 */
  platform: string
  contactId: string | null
  groupId?: string | null
  /** 该 contact 在该平台上的稳定标识（QQ 号）。由调用方从 contacts 表解出。 */
  stableUserId?: string | null
}

/** 桌面会话在真实库里出现过不止一个 platform 值（实测三种）。 */
export const DESKTOP_PLATFORMS = ['dsh-session', 'dsh', 'desktop'] as const

/** QQ 私聊的会话标识形如 `qq-private-<uin>`；群聊是 `qq-group-<group>`。 */
const QQ_PRIVATE = /^qq-private-(\d+)$/

const OTHER: SessionChannel = { kind: 'other', platforms: [], sourceChannel: null }
const DESKTOP: SessionChannel = {
  kind: 'desktop',
  platforms: [...DESKTOP_PLATFORMS],
  sourceChannel: null,
}

/**
 * 判定当前会话属于哪一侧。
 *
 * 优先用可信绑定（`binding` 不为 null 时）：
 * - `platform === 'qq'` 且有 `groupId` → 群聊，`other`（白名单只授予聊天资格）
 * - `platform === 'qq'` 且联系人稳定标识等于 Owner → `owner-private`
 * - `platform === 'qq'` 的其他私聊 → `other`
 * - 其余平台（desktop / web / system / dsh）→ 桌面
 *
 * 没有绑定（桌面会话本来就没有 Adapter 绑定）时退回会话标识的形状判定：
 * - 拿不到标识 → `other`（fail-closed：宁可这一次不召回，也不要在身份不明时
 *   把桌面内容端给 QQ）
 * - `qq-private-<owner>` → `owner-private`；其他 `qq-*` → `other`
 * - 其余按桌面，且**不要求该会话自己已经有源**——刚开的新会话也要能回忆起昨天
 *
 * 委派会话（`origin === 'subagent'`）由调用方另行短路，不依赖形状判断。
 */
export function resolveSessionChannel(
  sessionRef: string | null | undefined,
  ownerUin: string | null | undefined,
  binding?: ChannelBinding | null,
): SessionChannel {
  const owner = (ownerUin ?? '').trim()

  if (binding !== undefined && binding !== null) {
    const platform = binding.platform.trim().toLowerCase()
    if (platform === 'qq') {
      const groupId = (binding.groupId ?? '').trim()
      if (groupId.length > 0) return OTHER
      const stable = (binding.stableUserId ?? '').trim()
      if (owner.length > 0 && stable.length > 0 && stable === owner) {
        return { kind: 'owner-private', platforms: ['qq'], sourceChannel: 'private' }
      }
      return OTHER
    }
    // 已确认的桌面侧接收者：Desktop 三个别名都是「它是谁」的映射，不是查询条件。
    return DESKTOP
  }

  if (sessionRef == null || sessionRef.length === 0) return OTHER

  const qqPrivate = QQ_PRIVATE.exec(sessionRef)
  if (qqPrivate !== null) {
    const uin = qqPrivate[1]
    if (owner.length > 0 && uin === owner) {
      return { kind: 'owner-private', platforms: ['qq'], sourceChannel: 'private' }
    }
    return OTHER
  }
  if (sessionRef.startsWith('qq-')) return OTHER

  return DESKTOP
}

/** 项目 Brief 只在桌面渠道装配；QQ 侧还没有项目绑定的映射，先不给。 */
export function briefPlatformFor(channel: SessionChannel): string | null {
  return channel.kind === 'desktop' ? 'desktop' : null
}

/** agent.meta 里能拿到的委派信息（dsh-agent 的 CreateSessionOptions.meta）。 */
export interface AgentMetaLike {
  readonly origin?: string
  readonly delegationDepth?: number
}

/**
 * 是不是宿主派出去的子代理会话。
 *
 * 用宿主自己记的 `meta.origin` / `meta.delegationDepth`，**不看 UUID 形状**——
 * 主会话和子会话的 id 长得一样，形状判断只会把两者都误判。
 * 子代理不该把主人的日常原话读进自己的上下文；要保留的开发成果，
 * 应由主会话显式收进项目 Checkpoint。
 */
export function isDelegatedAgent(meta: unknown): boolean {
  if (meta === null || meta === undefined) return false
  const record = meta as { origin?: unknown; delegationDepth?: unknown }
  if (record.origin === 'subagent') return true
  const depth = record.delegationDepth
  return typeof depth === 'number' && depth > 0
}
