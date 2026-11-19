/**
 * R6-3C-Live：SnowLuma OneBot 桥（Host 层，只做通道，不碰人格/记忆）。
 *
 * 职责链：
 *   OneBot message 事件 → `toIdentityClaim` → Host 受控注册的 `qq-snowluma` Adapter 登记
 *   → 按会话创建/恢复 Agent Session → `agent.followup(用户消息)`
 *   → `session/event` 的 assistant/message → OneBot send_private_msg / send_group_msg 发回。
 *
 * 四条边界：
 * 1. 身份只来自 Adapter 声明；这里不写 `RuntimeInputStore.bind()`、不碰 SQLite；
 * 2. 群聊会话 id 用群号（`qq-group-<gid>`），私聊用 QQ 号（`qq-private-<uid>`），
 *    群聊的发送者 QQ 号只作为 claim 的 stableUserId 上报，不转成私聊 Contact 权限；
 * 3. 会话创建、恢复与投递的失败只记日志并回一条简短错误提示，不改任何绑定；
 * 4. 「WS 已连接」不等于「QQ 侧能收到消息」：接收健康取自心跳 `status.good`，
 *    账号在线状态取自 `bot_status`；两个信号都不可用时保持保守（照常投递、只记日志）。
 *
 * 参考实现（dsh-qq-main/interface-platform、Derpyu520/qq-bridge）的取舍：
 * - 学它「心跳 good 才是接收健康」「bot_status 账号边沿」「echo 回执 + 超时 unknown」
 *   「按 message_id 去重」「指数退避重连」「SnowLuma 配置按账号分文件、只读发现 token」；
 * - 不学它的公共 HTTP/SSE 契约、会话策略路由、多提供方抽象——这里只有一个平台、一个后端。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelIdentityClaim } from 'dsh-psyche-contract'
import type { ChatTarget, ChatTransport } from 'dsh-psyche-core'
import { toIdentityClaim } from 'dsh-psyche-qq'
import type { GroupMessageInput, QqReplyOutboxStore } from 'dsh-psyche-core'
import { QqReplyWorker } from 'dsh-psyche-core'
import { groupRoomPolicies, groupMessageForCapture } from './qq-group-ingress.js'
import { isPurePsycheToolMarkup } from './qq-reply-text.js'
import { maskQqId } from './qq-admin.js'
import { QqDiagnostics, type QqDiagnosticFilter, type QqDiagnosticPage } from './qq-diagnostics.js'
import { ContactRateLimiter, decideQqContact, parseQqContactPolicies, type QqContactPolicyIndex } from './qq-contact-policy.js'

export interface QqBridgeConfig {
  enabled: boolean
  /** OneBot WS 服务端，例如 `ws://127.0.0.1:3001`。 */
  wsUrl: string
  /** OneBot access token（Bearer）。留空时从 SnowLuma 配置只读发现。 */
  accessToken: string
  /** SnowLuma 安装目录（含 `config/onebot_<QQ>.json`）；留空则不做 token 发现。 */
  snowlumaHome?: string
  /** 创建 Agent 时使用的 provider（宿主已配置的模型路由）。 */
  provider: string
  /** 创建 Agent 时使用的 model。 */
  model: string
  /**
   * QQ 会话所属的工作区目录（DSH 用 session header 的 `cwd` 归属工作区）。
   * 留空时由 Host 传默认值（`<dataDir 同级>/QQ 聊天`）。
   */
  cwd?: string
  /** 断线重连的初始间隔（毫秒，指数退避到 30 秒）。 */
  reconnectMs?: number
  /** 单条消息正文上限（字符）。 */
  maxText?: number
  /** 发送回执超时（毫秒）。 */
  sendTimeoutMs?: number
  /** CLI 专用发送连接不消费入站消息；宿主普通桥默认继续消费。无配置面板入口。 */
  receiveMessages?: boolean
  /** Host internal one-RPC lane; never reconnect or reuse an uncertain send connection. */
  singleConnection?: boolean
  /** D-1 只采集；默认关闭。非法白名单条目逐条拒绝，不创建群 Agent。 */
  groups?: unknown
  /**
   * P4-A：私聊准入白名单。`owner` 必填、`extra` 可选，都是纯数字 QQ 号字符串。
   * 缺失、空值、含通配符或非法条目时整份白名单视为无效（fail-closed，全部拒绝）。
   */
  allowFrom?: { owner: string; extra: string[] }
  /** P4-B-4-2b：私聊回复 Outbox（默认关；start-only，切换需重载）。 */
  replyOutbox?: { enabled?: boolean; intervalMs?: number }
  /** P4-B-4-2c：把 QQ 号解析成 Core contacts.contact_id；返回 null 时 Outbox 入队失败关闭。 */
  resolveContactId?: (stableUserId: string) => Promise<string | null> | string | null
  /** 未授权来源的处理策略；P4-A 只允许 `reject`，其他值按 `reject` 处理。 */
  unknownPolicy?: 'reject'
  /** P4-B-3：`qq.contacts` 原始配置；由纯模块解析，非法时私聊在准入后失败关闭。 */
  contacts?: unknown
  /** 同一陌生人两次拒绝回复的最小间隔（毫秒，默认 24 小时）。 */
  rejectCooldownMs?: number
  /** 进程内滚动窗口里最多发送的拒绝回复条数（默认 20）。 */
  rejectGlobalLimit?: number
  /** 拒绝回复的滚动窗口（毫秒，默认 1 小时）。 */
  rejectGlobalWindowMs?: number
}

export interface QqBridgeLogger {
  info(message: string, detail?: Record<string, unknown>): void
  warn(message: string, detail?: Record<string, unknown>): void
  error(message: string, detail?: Record<string, unknown>): void
}

/** 桥只依赖宿主 ctx 上真正用到的两件事：agents 服务与事件订阅。 */
export interface QqBridgeHost {
  agents?: {
    get(id: string): { followup(message: unknown): void; status?: string } | undefined
    create(options: Record<string, unknown>): Promise<{ agent: { followup(message: unknown): void } }>
    resume(options: Record<string, unknown>): Promise<{ agent: { followup(message: unknown): void } }>
  }
  on(name: string, listener: (...args: any[]) => void): (() => void) | undefined
}

export interface QqBridgeDeps {
  host: QqBridgeHost
  adapter: {
    announce(sessionId: string, claim: ChannelIdentityClaim): void
    forget(sessionId: string): void
    size(): number
  }
  logger: QqBridgeLogger
  /** WebSocket 构造器（测试可注入假实现）。 */
  webSocket?: new (url: string, protocols?: string | string[]) => unknown
  /** 定时器（测试可注入）。 */
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  /** 只读 token 发现（测试可注入）；默认读 SnowLuma 的 `config/onebot_<QQ>.json`。 */
  discoverToken?: (snowlumaHome: string) => { wsUrl: string; token: string } | null
  /** 会话是否已在 Host 侧完成可信绑定（`RuntimeInputStore` 里有记录）。 */
  isSessionBound?: (sessionId: string) => boolean
  ingestGroupMessage?: (input: GroupMessageInput, isActive: () => boolean) => Promise<{ retained: boolean; replayed: boolean } | null>
  onGroupConnectionGap?:()=>void
}

export type QqBridgeTarget =
  | { kind: 'private'; userId: string }
  | { kind: 'group'; groupId: string }

const SESSION_PREFIX_PRIVATE = 'qq-private-'
const SESSION_PREFIX_GROUP = 'qq-group-'

/** 会话 id 约定：Host 的 `agent/created` 用前缀判断 platformHint。 */
export function qqSessionIdFor(target: QqBridgeTarget): string {
  return target.kind === 'private'
    ? `${SESSION_PREFIX_PRIVATE}${target.userId}`
    : `${SESSION_PREFIX_GROUP}${target.groupId}`
}

/** 从会话 id 还原投递目标；不认识的前缀返回 null。 */
export function qqTargetOf(sessionId: string): QqBridgeTarget | null {
  if (sessionId.startsWith(SESSION_PREFIX_PRIVATE)) {
    const userId = sessionId.slice(SESSION_PREFIX_PRIVATE.length)
    return userId === '' ? null : { kind: 'private', userId }
  }
  if (sessionId.startsWith(SESSION_PREFIX_GROUP)) {
    const groupId = sessionId.slice(SESSION_PREFIX_GROUP.length)
    return groupId === '' ? null : { kind: 'group', groupId }
  }
  return null
}

/** P4-A 固定拒绝文案；不做任务分发，也不引用会话内容。 */
export const QQ_REJECT_TEXT = '当前暂不接受未授权的私聊消息。'

const DEFAULT_REJECT_COOLDOWN_MS = 24 * 60 * 60_000
const DEFAULT_REJECT_GLOBAL_LIMIT = 20
const DEFAULT_REJECT_GLOBAL_WINDOW_MS = 60 * 60_000
/** 与 `packages/qq` 的 stableId 同一口径：纯数字、无前导零、长度 1–20。 */
const QQ_ADMISSION_ID = /^[1-9][0-9]{0,19}$/

export interface QqAllowList {
  ids: Set<string>
  /** 白名单整份是否有效；无效时 `ids` 为空且一律拒绝。 */
  valid: boolean
}

/**
 * 解析 `qq.allowFrom`。任何一条非法（空串、通配符、非数字、超长）都让整份白名单失效，
 * 不做「跳过坏条目继续放行」——P4-A 的默认必须是拒绝。
 */
export function parseQqAllowFrom(
  allowFrom: { owner?: string; extra?: string[] } | undefined,
): QqAllowList {
  const owner = typeof allowFrom?.owner === 'string' ? allowFrom.owner.trim() : ''
  const extra = Array.isArray(allowFrom?.extra) ? allowFrom.extra : []
  const ids = new Set<string>()
  let valid = owner !== '' && QQ_ADMISSION_ID.test(owner)
  if (valid) ids.add(owner)
  for (const raw of extra) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!QQ_ADMISSION_ID.test(id)) {
      valid = false
      continue
    }
    ids.add(id)
  }
  if (!valid) ids.clear()
  return { ids, valid }
}

/**
 * 从 SnowLuma 安装目录只读发现 OneBot WS 端点。
 * 每个账号一个 `config/onebot_<QQ>.json`，取 `networks.wsServers[0]`；
 * `0.0.0.0` / `::` 是监听地址，连接改回环。只读，不改 SnowLuma 任何文件。
 */
export function discoverSnowLumaWs(snowlumaHome: string): { wsUrl: string; token: string } | null {
  const dir = join(snowlumaHome, 'config')
  if (!existsSync(dir)) return null
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  const candidates = entries.filter((name) => /^onebot_\d+\.json$/i.test(name)).sort()
  for (const name of candidates) {
    try {
      const raw = readFileSync(join(dir, name), 'utf8').replace(/^\uFEFF/, '')
      const parsed = JSON.parse(raw) as {
        networks?: { wsServers?: Array<{ host?: string; port?: number; accessToken?: string }> }
      }
      const ws = parsed.networks?.wsServers?.[0]
      if (ws === undefined) continue
      const host = ws.host === undefined || ws.host === '' || ws.host === '0.0.0.0' || ws.host === '::'
        ? '127.0.0.1'
        : String(ws.host)
      return {
        wsUrl: `ws://${host}:${Number(ws.port) || 3001}`,
        token: String(ws.accessToken ?? ''),
      }
    } catch {
      // 单个账号配置坏了不影响其他账号。
    }
  }
  return null
}

/** OneBot WS 客户端的最小形状；只声明桥实际调用的成员。 */
export interface QqSocketLike {
  readyState?: number
  send(data: string): void
  close(): void
  addEventListener?(type: string, listener: (...args: any[]) => void): void
  on?(type: string, listener: (...args: any[]) => void): void
}

interface MessageEventLike {
  post_type?: string
  message_type?: string
  sub_type?: string
  meta_event_type?: string
  notice_type?: string
  user_id?: number | string
  group_id?: number | string
  self_id?: number | string
  message_id?: number | string
  raw_message?: string
  message?: unknown
  sender?: { user_id?: number | string }
  echo?: string | number
  status?: { good?: boolean; online?: boolean }
}

/** 一条入站消息的规范化结果：模型只应看到 text，原始 CQ/URL/路径不再外泄。 */
export interface OneBotInbound {
  text: string
  /** 媒体段只留类型与数量；不保留文件名、URL、本地路径。 */
  media: Array<{ type: string; count: number }>
  replyToMessageId: string | null
  mentions: number
}

const MEDIA_LABELS: Readonly<Record<string, string>> = {
  image: '[图片]',
  mface: '[表情]',
  face: '[表情]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  forward: '[转发消息]',
  json: '[消息]',
  xml: '[消息]',
  dice: '[骰子]',
  rps: '[猜拳]',
  shake: '[戳一戳]',
  poke: '[戳一戳]',
}

const CQ_PATTERN = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g

function mediaLabel(type: string): string {
  return MEDIA_LABELS[type] ?? '[消息]'
}

function addMedia(media: Array<{ type: string; count: number }>, type: string): void {
  const found = media.find((item) => item.type === type)
  if (found) found.count += 1
  else media.push({ type, count: 1 })
}

/** 结构化消息段是首选；raw_message 只在没有结构化消息时作为受限兜底。 */
export function oneBotMessage(event: MessageEventLike, maxText = 8000): OneBotInbound {
  const media: Array<{ type: string; count: number }> = []
  let replyToMessageId: string | null = null
  let mentions = 0
  const parts: string[] = []

  if (Array.isArray(event.message)) {
    for (const segment of event.message) {
      if (segment === null || typeof segment !== 'object') continue
      const typed = segment as { type?: unknown; data?: Record<string, unknown> }
      const type = typeof typed.type === 'string' ? typed.type : ''
      if (type === 'text') {
        if (typeof typed.data?.text === 'string') parts.push(typed.data.text)
        continue
      }
      if (type === 'reply') {
        const id = typed.data?.id
        if (replyToMessageId === null && (typeof id === 'string' || typeof id === 'number')) {
          replyToMessageId = String(id)
        }
        continue
      }
      if (type === 'at') {
        mentions += 1
        const name = typed.data?.name
        parts.push(typeof name === 'string' && name.trim() ? `@${name.trim()}` : '@某人')
        continue
      }
      if (type === 'image' || type === 'mface' || type === 'face' || type === 'record' || type === 'video' ||
          type === 'file' || type === 'forward' || type === 'json' || type === 'xml' || type === 'dice' ||
          type === 'rps' || type === 'shake' || type === 'poke') {
        addMedia(media, type)
        parts.push(mediaLabel(type))
        continue
      }
      // 未知段不猜内容，也不把原始 data 带进模型。
      parts.push('[消息]')
    }
  } else if (typeof event.message === 'string' && event.message.length > 0) {
    parts.push(event.message)
  } else if (typeof event.raw_message === 'string' && event.raw_message.length > 0) {
    const raw = event.raw_message
    let cursor = 0
    CQ_PATTERN.lastIndex = 0
    for (let match = CQ_PATTERN.exec(raw); match !== null; match = CQ_PATTERN.exec(raw)) {
      if (match.index > cursor) parts.push(raw.slice(cursor, match.index))
      cursor = match.index + match[0].length
      const type = match[1]
      if (type === 'reply') {
        const id = /(?:^|,)id=([^,]+)/.exec(match[2] ?? '')?.[1]
        if (replyToMessageId === null && id) replyToMessageId = id
        continue
      }
      if (type === 'at') {
        mentions += 1
        const name = /(?:^|,)name=([^,]+)/.exec(match[2] ?? '')?.[1]
        parts.push(name ? `@${decodeURIComponent(name)}` : '@某人')
        continue
      }
      if (type === 'text') {
        const text = /(?:^|,)text=([^,]+)/.exec(match[2] ?? '')?.[1]
        if (text) parts.push(decodeURIComponent(text))
        continue
      }
      if (type in MEDIA_LABELS) {
        addMedia(media, type)
        parts.push(mediaLabel(type))
        continue
      }
      // 未知 CQ 标签只留占位；file/url/路径等参数一律丢弃。
      parts.push('[消息]')
    }
    if (cursor < raw.length) parts.push(raw.slice(cursor))
  }

  let text = parts.join('')
  if (text.trim().length === 0 && (media.length > 0 || mentions > 0)) {
    text = media.length > 0 ? mediaLabel(media[0].type) : '@某人'
  }
  return { text: text.slice(0, maxText), media, replyToMessageId, mentions }
}

/** 兼容旧调用：只取文本。 */
export function oneBotText(event: MessageEventLike, maxText = 8000): string {
  return oneBotMessage(event, maxText).text
}

/** 用户消息的最小 DSH 形状（与 PreStep 注入消息同一套字段）。 */
export function qqUserMessage(
  text: string,
  messageId?: string | null,
  media: Array<{ type: string; count: number }> = [],
): Record<string, unknown> {
  return {
    id: `msg_qq_${messageId ?? Math.random().toString(36).slice(2, 12)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'user',
      ...(media.length > 0 ? { psyche: { media } } : {}),
    },
  }
}

/** P4-B-2：出站多行只规范化换行，不裁剪空白、不重新折行。 */
export function normalizeOutgoingText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

export interface OneBotOutgoingSegment {
  type: 'reply' | 'text'
  data: { id?: string; text?: string }
}

/**
 * P4-B-2：OneBot 出站消息一律用结构化段。
 * - 文本段不会被 OneBot 当作 CQ 码解析，模型/用户内容里的 `[CQ:...]` 只是普通字符；
 * - 引用段只接受调用方已绑定的平台消息 id，使用结构化 `reply` 段。
 */
export function buildOutgoingMessage(text: string, replyToMessageId?: string | null): OneBotOutgoingSegment[] {
  const segments: OneBotOutgoingSegment[] = []
  if (replyToMessageId !== undefined && replyToMessageId !== null && replyToMessageId !== '') {
    segments.push({ type: 'reply', data: { id: replyToMessageId } })
  }
  segments.push({ type: 'text', data: { text: normalizeOutgoingText(text) } })
  return segments
}

export type QqReplyOutboxGate =
  | { readonly ok: true; readonly seq: number; readonly messageId: string }
  | { readonly ok: false; readonly reason: string }

/**
 * P4-B-4-2b：只有「模型最终回复」才能进 Outbox。
 * 工具结果、中间态、被中断的回复、缺 message.id 或会话 seq 的事件一律不允许入队。
 */
export function qqReplyOutboxGate(event: { type?: string; seq?: unknown; data?: unknown }): QqReplyOutboxGate {
  if (event.type !== 'assistant/message') return { ok: false, reason: 'event-type' }
  const data = event.data as { message?: { id?: unknown; interrupted?: unknown; source?: { kind?: unknown } } } | undefined
  const message = data?.message
  if (message === undefined) return { ok: false, reason: 'missing-message' }
  if (message.source?.kind !== 'model') return { ok: false, reason: 'not-model-final' }
  if (message.interrupted === true) return { ok: false, reason: 'interrupted' }
  if (typeof message.id !== 'string' || message.id === '') return { ok: false, reason: 'missing-message-id' }
  if (typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq <= 0) {
    return { ok: false, reason: 'invalid-seq' }
  }
  return { ok: true, seq: event.seq, messageId: message.id }
}

interface PendingSend {
  resolve: (value: { ok: boolean; messageId?: string; error?: string; quote?: 'applied' | 'omitted-unbound' | 'omitted-unsupported' }) => void
  timer: unknown
  strictAck: boolean
  quote?: 'applied' | 'omitted-unbound' | 'omitted-unsupported'
}

/** P1：单次 WS 握手超时；超时按一次失败进入退避，不无限等待。 */
const CONNECT_TIMEOUT_MS = 10_000
/** P1：连接存活满该窗口才清零退避；抖动式“刚连上就断”不得重置。 */
const STABLE_WINDOW_MS = 30_000

export class QqBridge {
  readonly #config: QqBridgeConfig
  readonly #deps: QqBridgeDeps
  readonly #sessions = new Map<string, QqBridgeTarget>()
  /** P4-B-2：每个会话最近收到、可用于引用回复的平台消息 id（有上限，内存态）。 */
  readonly #boundInbound = new Map<string, Set<string>>()
  readonly #lastInbound = new Map<string, string>()
  readonly #pending = new Map<string, PendingSend>()
  /** 已处理的 message_id → 处理时间；防重放/重复投递（10 分钟、1000 条上限）。 */
  readonly #seen = new Map<string, number>()
  #socket: QqSocketLike | null = null
  #endpoint: {wsUrl:string;token:string}|null=null
  #stopped = true
  /** 每次启动/停止都使上代队列和 socket 回调失效。已交给 Host 的工作不能撤回。 */
  #generation = 0
  #reconnectTimer: unknown = null
  #connectTimer: unknown = null
  #stableTimer: unknown = null
  #attempts = 0
  #echo = 0
  /** 最近一次发送超时后，无 echo 回执已无法可靠归属；新连接前忽略无 echo 结算。 */
  #ackAmbiguous = false
  /** P4-B-4-2b：仅在 enabled 时挂载；关闭时保持原直发路径。 */
  #replyOutboxStore: QqReplyOutboxStore | null = null
  #replyOutboxWorker: QqReplyWorker | null = null
  #replyOutboxEnabled = false
  readonly #replyOutboxIntervalMs: number
  #resolveContactId: ((stableUserId: string) => Promise<string | null> | string | null) | null = null
  #listeners: Array<() => void> = []
  /** 心跳自评的接收链路健康度；null = 还没收到心跳（保守放行）。 */
  #receiveHealthy: boolean | null = null
  /** 账号会话在线；null = 未知（老运行时没有 bot_status）。 */
  #accountOnline: boolean | null = null
  #lastHealthWarnAt = 0
  /** P4-A：解析后的私聊白名单；无效时 `valid=false`，全部拒绝。 */
  readonly #allow: QqAllowList
  readonly #rejectCooldownMs: number
  readonly #rejectGlobalLimit: number
  readonly #rejectGlobalWindowMs: number
  /** 陌生人 → 上次发送拒绝回复的时间（单用户 24 小时冷却）。 */
  readonly #rejectReplies = new Map<string, number>()
  /** 滚动窗口内的拒绝回复发送时间；只在内存，重启清零。 */
  #rejectGlobalAt: number[] = []
  #admission = {
    /** 未授权私聊事件数。 */
    rejected: 0,
    /** 实际尝试发送的拒绝回复数。 */
    rejectReplies: 0,
    /** 因冷却/全局额度被静默丢弃的拒绝回复数。 */
    rateLimitedDrops: 0,
    /** 拒绝回复发送失败数（不重试）。 */
    rejectSendErrors: 0,
    /** 群聊/临时群聊/未知类型等超出 P4-A 范围的入口数。 */
    outOfScopeDrops: 0,
  }
  /** P4-A-3：只读统计；全部为进程内计数，重启清零。 */
  #stats = {
    received: 0,
    delivered: 0,
    sendErrors: 0,
    /** P4-C-0：同会话队列已满而被拒绝的投递数（可观测，不静默丢弃）。 */
    queueRejects: 0,
    lastMessageAt: null as string | null,
    lastHeartbeatAt: null as string | null,
    lastSentAt: null as string | null,
  }
  #selfId: string | null = null
  #nickname: string | null = null
  #connection: 'connected' | 'degraded' | 'disconnected' | 'unknown' = 'disconnected'
  /** P4-C-0：可选的传输层；设置后「助手回复」经它发送（准入拒绝仍走原始发送）。 */
  #transport: ChatTransport | null = null
  /** 每个 QQ 会话的串行投递队列（同会话按序，跨会话并行）。 */
  readonly #queues = new Map<string, { tail: Promise<void>; depth: number }>()
  readonly #maxQueuePerSession = 8
  /** P4-B-5-1：有界内存诊断事件；与业务消息库完全分离，重启清空。 */
  readonly #diagnostics = new QqDiagnostics()
  /** P4-B-3：解析后的联系人策略；blocked 时私聊在准入后失败关闭。 */
  readonly #contacts: QqContactPolicyIndex
  /** 联系人滚动 60 分钟额度；内存态，重启清零。 */
  readonly #contactLimiter = new ContactRateLimiter()
  #contactSuppressed = 0
  readonly #contactLogAt = new Map<string, number>()

  constructor(config: QqBridgeConfig, deps: QqBridgeDeps) {
    this.#config = config
    this.#deps = deps
    this.#allow = parseQqAllowFrom(config.allowFrom)
    this.#contacts = parseQqContactPolicies(config.contacts)
    if (this.#contacts.kind === 'blocked') {
      deps.logger.warn('[psyche][qq] 联系人策略配置非法，QQ 私聊将在准入后失败关闭', {
        reason: this.#contacts.reason,
      })
    }
    this.#rejectCooldownMs = Math.max(0, config.rejectCooldownMs ?? DEFAULT_REJECT_COOLDOWN_MS)
    this.#rejectGlobalLimit = Math.max(0, config.rejectGlobalLimit ?? DEFAULT_REJECT_GLOBAL_LIMIT)
    this.#rejectGlobalWindowMs = Math.max(1, config.rejectGlobalWindowMs ?? DEFAULT_REJECT_GLOBAL_WINDOW_MS)
    this.#replyOutboxIntervalMs = Math.max(250, config.replyOutbox?.intervalMs ?? 2000)
    // 启动即按配置决定路径，避免 attach 完成前的窗口走直发。
    this.#replyOutboxEnabled = config.replyOutbox?.enabled === true
    this.#resolveContactId = config.resolveContactId ?? null
    if (config.unknownPolicy !== undefined && config.unknownPolicy !== 'reject') {
      deps.logger.error('[psyche][qq] unknownPolicy 只支持 reject，已按 reject 处理', {
        unknownPolicy: String(config.unknownPolicy),
      })
    }
    if (!this.#allow.valid) {
      deps.logger.warn('[psyche][qq] 私聊白名单缺失或非法，所有私聊都会先经过未授权拒绝', {
        owner: config.allowFrom === undefined ? '' : String(config.allowFrom.owner ?? ''),
        extraCount: Array.isArray(config.allowFrom?.extra) ? config.allowFrom.extra.length : 0,
      })
    }
  }

  /** 已登记的会话数（审计/测试）。 */
  get sessionCount(): number {
    return this.#sessions.size
  }

  /** P4-A 准入计数（只在内存，进程重启清零；管理页标注「本次进程启动以来」）。 */
  get admissionStats(): {
    rejected: number
    rejectReplies: number
    rateLimitedDrops: number
    rejectSendErrors: number
    outOfScopeDrops: number
  } {
    return { ...this.#admission }
  }

  /**
   * P4-A-3 只读快照。连接态由 WS/心跳/账号信号合成；含未脱敏的内部值，
   * 只允许服务端把它交给 `buildQqAdminPayload()` 脱敏后再出接口。
   */
  adminSnapshot(): {
    running: boolean
    connection: 'connected' | 'degraded' | 'disconnected' | 'unknown'
    accountOnline: boolean | null
    selfId: string | null
    nickname: string | null
    allowFromValid: boolean
    allowFromOwner: string | null
    allowFromExtra: string[]
    counts: {
      received: number
      delivered: number
      sendErrors: number
      rejected: number
      rejectReplies: number
      rateLimitedDrops: number
      rejectSendErrors: number
      outOfScopeDrops: number
      contactSuppressed: number
    }
    lastHeartbeatAt: string | null
    lastMessageAt: string | null
    lastSentAt: string | null
  } {
    let connection: 'connected' | 'degraded' | 'disconnected' | 'unknown' = this.#connection
    if (connection === 'connected') {
      if (this.#receiveHealthy === false || this.#accountOnline === false) connection = 'degraded'
      // 老运行时既没有心跳也没有 bot_status：WS 在线但健康不可证，按 unknown 展示，不伪造 healthy。
      else if (this.#receiveHealthy === null && this.#accountOnline === null) connection = 'unknown'
    }
    return {
      running: this.#socket !== null && !this.#stopped,
      connection,
      accountOnline: this.#accountOnline,
      selfId: this.#selfId,
      nickname: this.#nickname,
      allowFromValid: this.#allow.valid,
      allowFromOwner: this.#config.allowFrom?.owner ?? null,
      allowFromExtra: Array.isArray(this.#config.allowFrom?.extra) ? [...this.#config.allowFrom.extra] : [],
      counts: {
        received: this.#stats.received,
        delivered: this.#stats.delivered,
        sendErrors: this.#stats.sendErrors,
        ...this.#admission,
        contactSuppressed: this.#contactSuppressed,
      },
      lastHeartbeatAt: this.#stats.lastHeartbeatAt,
      lastMessageAt: this.#stats.lastMessageAt,
      lastSentAt: this.#stats.lastSentAt,
    }
  }

  /**
   * P4-C-0：挂上传输层。之后「助手回复」走 `transport.send()`；
   * 准入拒绝等业务动作仍走桥自己的发送（Transport 不接管准入）。
   */
  attachTransport(transport: ChatTransport | null): void {
    this.#transport = transport
  }

  /**
   * P4-B-4-2b：挂载私聊回复 Outbox（可选）。
   * `enabled=true` 时助手回复只入队、由 Worker 独占发送；`false` 时保持原直发。
   * 只允许在 `start()` 前调用；运行中切换需要重载插件。
   */
  attachReplyOutbox(store: QqReplyOutboxStore, options: { enabled: boolean }): void {
    this.#replyOutboxStore = store
    this.#replyOutboxEnabled = options.enabled === true
    if (!this.#replyOutboxEnabled) return
    if (this.#transport === null) {
      this.#deps.logger.warn('[psyche][qq] replyOutbox 已开启但未挂载 Transport，助手回复将失败关闭')
      return
    }
    this.#replyOutboxWorker = new QqReplyWorker({
      store,
      transport: this.#transport,
      targetOf: (row) => ({ kind: 'private', platform: 'qq', stableUserId: row.stableUserId }),
      authorization: (row) => (row.transportId === this.#transport?.id ? null : 'transport-mismatch'),
      intervalMs: this.#replyOutboxIntervalMs,
      logger: this.#deps.logger,
    })
    if (!this.#stopped) this.#replyOutboxWorker.start()
  }

  /**
   * 供 Transport 使用；主动入口逐条指定 strictAck，普通来源回复兼容省略 status 的回执。
   * P4-B-2：可带 `replyToMessageId`（必须属于当前私聊会话），否则安全退化为纯文本。
   */
  sendOutgoingText(
    target: { kind: 'private'; userId: string } | { kind: 'group'; groupId: string },
    text: string,
    options: { strictAck?: boolean; isActive?:()=>boolean; replyToMessageId?: string | null } = {},
  ): Promise<{ ok: boolean; messageId?: string; error?: string; quote?: 'applied' | 'omitted-unbound' | 'omitted-unsupported' }> {
    return this.#sendText(target, text, options.strictAck === true, options.isActive, options.replyToMessageId)
  }

  /** Trusted Host use only; never included in adminSnapshot, logs or model tools. */
  replyEndpoint():{wsUrl:string;token:string}|null {return this.#endpoint&&!this.#stopped?{...this.#endpoint}:null}

  /** 供 Transport 适配器读取连接态。 */
  transportStatus(): 'connected' | 'degraded' | 'disconnected' | 'unknown' {
    return this.adminSnapshot().connection
  }

  /** 供 Transport 适配器等待连接（轮询；超时返回 false，不做发送重试）。 */
  async transportWaitConnected(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    for (;;) {
      const state = this.transportStatus()
      if (state === 'connected' || state === 'degraded') return true
      if (Date.now() >= deadline) return false
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50)
      })
    }
  }

  /** P4-B-5-1：只读诊断分页；过滤与字段白名单在 `qq-diagnostics.ts` 内完成。 */
  diagnosticPage(filter: QqDiagnosticFilter): QqDiagnosticPage {
    return this.#diagnostics.query(filter)
  }

  #isActive(generation: number): boolean {
    return !this.#stopped && generation === this.#generation
  }

  /** 同会话串行投递；队列已满时计数并拒绝（可观测，不静默吞掉）。 */
  async #runSerial(sessionId: string, task: () => Promise<void>, generation: number): Promise<void> {
    if (!this.#isActive(generation)) return
    const state = this.#queues.get(sessionId) ?? { tail: Promise.resolve(), depth: 0 }
    if (state.depth >= this.#maxQueuePerSession) {
      this.#stats.queueRejects += 1
      this.#deps.logger.warn('[psyche][qq] 会话投递队列已满，拒绝本次投递', {
        sessionId,
        depth: state.depth,
      })
      return
    }
    state.depth += 1
    this.#queues.set(sessionId, state)
    const run = state.tail.then(() => {
      if (this.#isActive(generation)) return task()
    }).catch((error: unknown) => {
      if (!this.#isActive(generation)) return
      this.#deps.logger.error('[psyche][qq] 会话串行投递失败', { sessionId, error: String(error) })
    })
    state.tail = run
    try {
      await run
    } finally {
      state.depth -= 1
      if (state.depth === 0 && this.#queues.get(sessionId) === state) this.#queues.delete(sessionId)
    }
  }

  #transportTarget(target: QqBridgeTarget): ChatTarget {
    return target.kind === 'private'
      ? { kind: 'private', platform: 'qq', stableUserId: target.userId }
      : { kind: 'group', platform: 'qq', groupId: target.groupId }
  }

  /**
   * P4-B-2：只把「本桥实际收到、且已交给 Host 的私聊消息 id」记为可引用。
   * 群消息的出站走独立单连接（D-2），不在这里登记。
   */
  #bindInbound(sessionId: string, target: QqBridgeTarget, messageId: string | null): void {
    if (messageId === null || messageId === '' || target.kind !== 'private') return
    const key = `${target.userId}`
    const ids = this.#boundInbound.get(key) ?? new Set<string>()
    ids.add(messageId)
    while (ids.size > 64) {
      const oldest = ids.values().next().value
      if (oldest === undefined) break
      ids.delete(oldest)
    }
    this.#boundInbound.set(key, ids)
    this.#lastInbound.set(sessionId, messageId)
  }

  #hasBoundInbound(target: QqBridgeTarget, messageId: string): boolean {
    if (target.kind !== 'private') return false
    return this.#boundInbound.get(target.userId)?.has(messageId) === true
  }

  #consumeBoundInbound(target: QqBridgeTarget, messageId: string): void {
    if (target.kind !== 'private') return
    this.#boundInbound.get(target.userId)?.delete(messageId)
  }

  /** 未显式给出引用时，沿用本会话最近一条仍可引用的消息；没有则不引用。 */
  #replyToFor(target: QqBridgeTarget, sessionId: string | null, explicit: string | null | undefined): string | null {
    if (explicit !== undefined && explicit !== null && explicit !== '') return explicit
    if (sessionId === null) return null
    const id = this.#lastInbound.get(sessionId) ?? null
    return id !== null && this.#hasBoundInbound(target, id) ? id : null
  }

  /** 连接 OneBot WS 并开始收事件；失败按指数退避重试。 */
  start(): void {
    if (!this.#stopped) return
    this.#generation += 1
    this.#stopped = false
    this.#listenAgentReplies()
    this.#replyOutboxWorker?.start()
    this.#connect()
  }

  /**
   * P8-3：手动重连。只用于 Owner 本机控制中心；不改变端点/令牌。
   * 先失效当前 generation，旧 socket 的 close 不会再排一次重连。
   */
  reconnectNow(): void {
    if (this.#stopped) {
      this.start()
      return
    }
    this.#generation += 1
    if (this.#reconnectTimer !== null) {
      this.#deps.clearTimeout?.(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    if (this.#connectTimer !== null) {
      this.#deps.clearTimeout?.(this.#connectTimer)
      this.#connectTimer = null
    }
    if (this.#stableTimer !== null) {
      this.#deps.clearTimeout?.(this.#stableTimer)
      this.#stableTimer = null
    }
    const socket = this.#socket
    this.#socket = null
    this.#endpoint = null
    this.#attempts = 0
    this.#connection = 'disconnected'
    try {
      socket?.close()
    } catch {
      /* 关闭失败不影响新连接 */
    }
    this.#deps.logger.info('[psyche][qq] 控制中心要求手动重连')
    this.#connect()
  }

  /** 断开并清理：注销监听、忘掉会话声明、关 socket。 */
  async stop(): Promise<void> {
    if (this.#stopped) return
    this.#stopped = true
    this.#generation += 1
    await this.#replyOutboxWorker?.stop()
    this.#queues.clear()
    this.#connection = 'disconnected'
    if (this.#reconnectTimer !== null) {
      this.#deps.clearTimeout?.(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    if (this.#connectTimer !== null) {
      this.#deps.clearTimeout?.(this.#connectTimer)
      this.#connectTimer = null
    }
    if (this.#stableTimer !== null) {
      this.#deps.clearTimeout?.(this.#stableTimer)
      this.#stableTimer = null
    }
    for (const off of this.#listeners) off()
    this.#listeners = []
    for (const pending of this.#pending.values()) {
      this.#deps.clearTimeout?.(pending.timer)
      pending.resolve({ ok: false, error: 'bridge-stopped' })
    }
    this.#pending.clear()
    for (const sessionId of this.#sessions.keys()) this.#deps.adapter.forget(sessionId)
    this.#sessions.clear()
    try {
      this.#socket?.close()
    } catch {
      // 关闭失败不影响状态清理。
    }
    this.#socket = null
    this.#endpoint = null
  }

  #connect(): void {
    if (this.#stopped) return
    const Ctor = this.#deps.webSocket ?? (globalThis as any).WebSocket
    if (typeof Ctor !== 'function') {
      this.#deps.logger.error('[psyche][qq] 当前运行环境没有 WebSocket，无法连接 OneBot')
      return
    }
    const endpoint = this.#resolveEndpoint()
    if (endpoint === null) {
      this.#deps.logger.error('[psyche][qq] 没有可用的 OneBot WS 端点（配置为空且未发现 SnowLuma）')
      return
    }
    let socket: QqSocketLike
    try {
      // Node 内置 WebSocket（undici）只接受 protocols，不接受 headers；OneBot 11 的 WS
      // 鉴权走 `access_token` 查询参数，因此统一用 URL 带 token，不传第二参数。
      const created = new Ctor(withAccessToken(endpoint.wsUrl, endpoint.token))
      socket = created as QqSocketLike
    } catch (error) {
      this.#deps.logger.error('[psyche][qq] WebSocket 构造失败', { error: String(error) })
      this.#scheduleReconnect()
      return
    }
    this.#socket = socket
    this.#endpoint = endpoint
    const generation = this.#generation
    const current = () => this.#isActive(generation) && this.#socket === socket
    const onOpen = () => {
      if (!current()) return
      if (this.#connectTimer !== null) {
        this.#deps.clearTimeout?.(this.#connectTimer)
        this.#connectTimer = null
      }
      if (this.#stableTimer !== null) {
        this.#deps.clearTimeout?.(this.#stableTimer)
        this.#stableTimer = null
      }
      // P1：连接存活满稳定窗口才清零退避；避免“刚连上就断”反复重置。
      const stable = (this.#deps.setTimeout ?? setTimeout)(() => {
        this.#stableTimer = null
        if (current() && this.#connection === 'connected') this.#attempts = 0
      }, STABLE_WINDOW_MS)
      this.#stableTimer = stable
      this.#selfId = null
      this.#receiveHealthy = null
      this.#accountOnline = null
      this.#connection = 'connected'
      this.#ackAmbiguous = false
      this.#deps.logger.info('[psyche][qq] OneBot WS 已连接', { url: endpoint.wsUrl })
    }
    const onMessage = (payload: unknown) => {
      if (current()) this.#onSocketMessage(payload, generation)
    }
    const onClose = (event?: { code?: number; reason?: string }) => {
      if (!current()) return
      if (this.#connectTimer !== null) {
        this.#deps.clearTimeout?.(this.#connectTimer)
        this.#connectTimer = null
      }
      if (this.#stableTimer !== null) {
        this.#deps.clearTimeout?.(this.#stableTimer)
        this.#stableTimer = null
      }
      if(this.#connection==='connected')try{this.#deps.onGroupConnectionGap?.()}catch{ /* counters cannot break transport teardown */ }
      this.#connection = 'disconnected'
      const attempts = this.#attempts + 1
      const detail = {
        attempts,
        code: typeof event?.code === 'number' ? event.code : null,
        reason: typeof event?.reason === 'string' ? event.reason.slice(0, 120) : '',
      }
      // 连续失败后降噪：前 5 次 warn，其后 info；手动重连会把 attempts 清零。
      if (attempts <= 5) this.#deps.logger.warn('[psyche][qq] OneBot WS 断开，准备重连', detail)
      else this.#deps.logger.info('[psyche][qq] OneBot WS 仍断开，继续退避重连', detail)
      this.#socket = null
      this.#scheduleReconnect()
    }
    const onError = (error: unknown) => {
      if (current()) this.#deps.logger.warn('[psyche][qq] OneBot WS 错误', { error: String(error) })
    }
    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('open', onOpen)
      socket.addEventListener('message', onMessage)
      socket.addEventListener('close', onClose)
      socket.addEventListener('error', onError)
    } else if (typeof socket.on === 'function') {
      socket.on('open', onOpen)
      socket.on('message', onMessage)
      socket.on('close', onClose)
      socket.on('error', onError)
    }
    // P1：握手超时按一次失败处理；关闭会走 onClose 的同一退避路径。
    this.#connectTimer = (this.#deps.setTimeout ?? setTimeout)(() => {
      this.#connectTimer = null
      if (!current() || this.#connection === 'connected') return
      this.#deps.logger.warn('[psyche][qq] OneBot WS 握手超时', { ms: CONNECT_TIMEOUT_MS })
      try {
        socket.close()
      } catch {
        this.#scheduleReconnect()
      }
    }, CONNECT_TIMEOUT_MS)
  }

  /** 配置给的端点优先；token 为空时从 SnowLuma 配置只读发现。 */
  #resolveEndpoint(): { wsUrl: string; token: string } | null {
    let wsUrl = this.#config.wsUrl
    let token = this.#config.accessToken
    const home = this.#config.snowlumaHome
    if (home !== undefined && home !== '' && (token === '' || wsUrl === '')) {
      const discover = this.#deps.discoverToken ?? discoverSnowLumaWs
      const found = discover(home)
      if (found !== null) {
        if (wsUrl === '') wsUrl = found.wsUrl
        if (token === '') token = found.token
      }
    }
    if (wsUrl === '') return null
    return { wsUrl, token }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#config.singleConnection) return
    // 同一时刻只允许一个重连 timer；否则 close/reconnect 交错会产生并行连接。
    if (this.#reconnectTimer !== null) {
      this.#deps.clearTimeout?.(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    this.#attempts += 1
    if (this.#attempts > 20) {
      this.#deps.logger.warn('[psyche][qq] 自动重连已熔断，等待手动重连', { attempts: this.#attempts })
      return
    }
    const generation = this.#generation
    const min = this.#config.reconnectMs ?? 1000
    const max = 30_000
    const base = Math.min(max, min * 2 ** Math.min(10, Math.max(0, this.#attempts - 1)))
    const delay = base + Math.floor(base * 0.2 * Math.random())
    const timer = (this.#deps.setTimeout ?? setTimeout)(() => {
      if (!this.#isActive(generation)) return
      this.#reconnectTimer = null
      this.#connect()
    }, delay)
    this.#reconnectTimer = timer
  }

  #onSocketMessage(payload: unknown, generation: number): void {
    if (!this.#isActive(generation)) return
    const text = extractPayloadText(payload)
    if (text === null) return
    let event: MessageEventLike
    try {
      event = JSON.parse(text) as MessageEventLike
    } catch {
      return
    }
    // 发送回执：`{ echo, status, retcode, data }`，不带 post_type。
    // 注意：SnowLuma 的 okResponse() 只回 `{status, retcode, data}`，**不回显 echo**，
    // 所以不能只按 echo 匹配。桥内发送是串行的，没有 echo 时按 FIFO 结算最早的请求。
    if (event.post_type === undefined) {
      const echo = event.echo === undefined ? null : String(event.echo)
      this.#settleSend(echo, event)
      return
    }
    if (event.post_type === 'meta_event') {
      if (event.meta_event_type === 'heartbeat') {
        this.#stats.lastHeartbeatAt = new Date().toISOString()
        if (event.self_id !== undefined) this.#selfId = String(event.self_id)
        const good = event.status?.good
        if (typeof good === 'boolean' && good !== this.#receiveHealthy) {
          this.#receiveHealthy = good
          this.#deps.logger[good ? 'info' : 'warn']('[psyche][qq] SnowLuma 接收链路健康状态变化', { good })
        }
        if (typeof event.status?.online === 'boolean') this.#accountOnline = event.status.online
      }
      return
    }
    if (event.post_type === 'notice') {
      if (event.notice_type === 'bot_status') {
        if (event.self_id !== undefined) this.#selfId = String(event.self_id)
        this.#accountOnline = event.sub_type === 'online'
        this.#deps.logger[this.#accountOnline ? 'info' : 'warn']('[psyche][qq] QQ 账号会话状态变化', {
          online: this.#accountOnline,
        })
      }
      return
    }
    if (event.post_type !== 'message') return
    if (this.#config.receiveMessages === false) return
    // P4-A-3：received/lastMessageAt 计的是「进来的 message 事件」，含被拒绝、超范围与重复投递；
    // 与 delivered（真正交给 Host）分开统计，管理页不把两者混成一个「消息数」。
    this.#stats.received += 1
    this.#stats.lastMessageAt = new Date().toISOString()
    if (event.self_id !== undefined) this.#selfId = String(event.self_id)
    // 自己的消息不投递：私聊看 user_id，群聊还要看 sender.user_id（都是自己）。
    const selfId = event.self_id === undefined ? '' : String(event.self_id)
    const senderId = event.sender?.user_id === undefined ? '' : String(event.sender.user_id)
    const userId = event.user_id === undefined ? '' : String(event.user_id)
    if (selfId !== '' && (userId === selfId || senderId === selfId)) return
    // 心跳 good=false 只表示「最近一段时间没收到消息」（SnowLuma 的 receive path stale），
    // 不代表这条事件不可信——安静几分钟后第一条消息到达时心跳可能还是 false。
    // 因此这里只告警、不丢弃；是否该处理由消息本身与账号在线状态决定。
    if (this.#receiveHealthy === false) {
      this.#warnHealth('SnowLuma 报告接收链路不健康（heartbeat status.good=false），仍按消息处理')
    }
    if (this.#accountOnline === false) {
      this.#warnHealth('QQ 账号会话离线（bot_status=offline），仍按消息处理')
    }
    // 同一 message_id 只处理一次：HTTP 上报 + WS 推送并存、或重连重放都会重复。
    const messageKey = event.message_id === undefined ? '' : String(event.message_id)
    if (event.message_type !== 'group' && messageKey !== '') {
      if (this.#seen.has(messageKey)) {
        if (userId !== '') {
          this.#diagnostics.record({ direction: 'in', target: { kind: 'private', userId }, result: 'deduplicated', textLength: 0 })
        }
        return
      }
      this.#markSeen(messageKey)
    }
    // 兜底：任何未预期的异常都不能变成 unhandled rejection 把宿主带崩
    // （真实宿主里 `ctx.agents` 无 inject 访问曾直接触发 fatal load failure）。
    void this.#handleMessage(event, generation).catch((error) => {
      if (!this.#isActive(generation)) return
      this.#deps.logger.warn('[psyche][qq] 处理消息失败（已忽略）', { error: String(error) })
    })
  }

  #warnHealth(message: string): void {
    const now = Date.now()
    if (now - this.#lastHealthWarnAt < 60_000) return
    this.#lastHealthWarnAt = now
    this.#deps.logger.warn(`[psyche][qq] ${message}`)
  }

  #markSeen(messageId: string): void {
    const now = Date.now()
    this.#seen.set(messageId, now)
    if (this.#seen.size <= 1000) return
    const ttl = 10 * 60_000
    for (const [key, at] of this.#seen) {
      if (now - at > ttl) this.#seen.delete(key)
    }
    // 极端情况下仍然超限：丢最老的（Map 保持插入顺序）。
    while (this.#seen.size > 1000) {
      const first = this.#seen.keys().next()
      if (first.done === true) break
      this.#seen.delete(first.value)
    }
  }

  /** 联系人策略抑制日志：同一联系人同一原因每分钟最多一条，避免高频消息日志洪泛。 */
  #logContactSuppressed(userId: string, reason: string): void {
    const key = `${userId}:${reason}`
    const now = Date.now()
    const last = this.#contactLogAt.get(key) ?? 0
    if (now - last < 60_000) return
    this.#contactLogAt.set(key, now)
    this.#deps.logger.info('[psyche][qq] 联系人策略抑制', { contactRef: maskQqId(userId), reason })
  }

  #isAllowed(userId: string): boolean {
    return this.#allow.valid && this.#allow.ids.has(userId)
  }

  /** 群聊/临时群聊/未知类型：在 Claim、announce、ensureAgent 之前静默结束。 */
  #rejectOutOfScope(
    messageType: string,
    subType: string | undefined,
    ref?: { kind: 'private'; userId: string } | { kind: 'group'; groupId: string },
  ): void {
    this.#admission.outOfScopeDrops += 1
    if (ref !== undefined) {
      this.#diagnostics.record({ direction: 'in', target: ref, result: 'out_of_scope', textLength: 0 })
    }
    this.#deps.logger.warn('[psyche][qq] 超出 P4-A 范围的入口已拒绝（不投递、不回复）', {
      messageType,
      subType: subType ?? '',
    })
  }

  /**
   * 未授权私聊：固定文案 + 单用户冷却 + 全局滚动额度。
   * 先记账再发送，并发事件不会同时通过额度检查；发送失败也不重试、不退还额度。
   */
  async #rejectUnauthorized(userId: string): Promise<void> {
    this.#admission.rejected += 1
    this.#diagnostics.record({ direction: 'in', target: { kind: 'private', userId }, result: 'rejected', textLength: 0 })
    const now = Date.now()
    const last = this.#rejectReplies.get(userId)
    if (last !== undefined && now - last < this.#rejectCooldownMs) {
      this.#admission.rateLimitedDrops += 1
      this.#diagnostics.record({ direction: 'in', target: { kind: 'private', userId }, result: 'rate_limited', textLength: 0 })
      this.#deps.logger.info('[psyche][qq] 拒绝回复处于单用户冷却期，已静默丢弃', { userId })
      return
    }
    const windowStart = now - this.#rejectGlobalWindowMs
    this.#rejectGlobalAt = this.#rejectGlobalAt.filter((at) => at > windowStart)
    if (this.#rejectGlobalAt.length >= this.#rejectGlobalLimit) {
      this.#admission.rateLimitedDrops += 1
      this.#diagnostics.record({ direction: 'in', target: { kind: 'private', userId }, result: 'rate_limited', textLength: 0 })
      this.#deps.logger.warn('[psyche][qq] 全局拒绝回复额度已满，已静默丢弃', { userId })
      return
    }
    this.#rejectReplies.set(userId, now)
    this.#rejectGlobalAt.push(now)
    this.#admission.rejectReplies += 1
    const result = await this.#sendText({ kind: 'private', userId }, QQ_REJECT_TEXT)
    if (!result.ok) {
      this.#admission.rejectSendErrors += 1
      this.#deps.logger.warn('[psyche][qq] 拒绝回复发送失败（不重试）', {
        userId,
        error: result.error ?? 'unknown',
      })
      return
    }
    this.#deps.logger.info('[psyche][qq] 已拒绝未授权私聊', { userId })
  }

  async #handleMessage(event: MessageEventLike, generation: number): Promise<void> {
    if (!this.#isActive(generation)) return
    const kind = event.message_type
    if (kind === 'group') {
      const input = groupMessageForCapture(event, groupRoomPolicies(this.#config.groups), oneBotText(event, 20001), new Date().toISOString())
      const sink = this.#deps.ingestGroupMessage
      if (!input || !sink) {
        const groupId = event.group_id === undefined ? '' : String(event.group_id)
        this.#rejectOutOfScope('group', event.sub_type, groupId === '' ? undefined : { kind: 'group', groupId })
        return
      }
      await this.#runSerial(`group-intake:${input.externalRoomId}`, async () => {
        try {
          const result = await sink(input, () => this.#isActive(generation))
          if (result && this.#isActive(generation)) this.#deps.logger.info('[psyche][qq] 群消息采集完成', { retained:result.retained,replayed:result.replayed })
        } catch (error) {
          if (this.#isActive(generation)) this.#deps.logger.warn('[psyche][qq] 群采集失败（未确认持久化）', { code:typeof (error as { code?: unknown })?.code === 'string' ? (error as {code:string}).code : 'GROUP_INTAKE_FAILED' })
        }
      }, generation)
      return
    }
    // P4-A 范围闸：只开放「已授权 QQ 好友私聊」。群聊、临时群聊（private+group）、
    // 未知类型都在 Claim/announce/ensureAgent 之前结束，且不发任何回复。
    if (kind !== 'private') {
      const eventUserId = event.user_id === undefined ? '' : String(event.user_id)
      const privateRef = eventUserId === '' ? undefined : { kind: 'private' as const, userId: eventUserId }
      this.#rejectOutOfScope(kind ?? 'unknown', event.sub_type, privateRef)
      return
    }
    // 身份声明统一走 `toIdentityClaim`：它会检查 private 的 sub_type——
    // 群临时会话（private + group）和 other 不生成 Claim，宁可不给记忆，
    // 也不能把「从群里发起」的临时会话退化成好友私聊权限。
    const claim = toIdentityClaim(event)
    if (claim === null) {
      const eventUserId = event.user_id === undefined ? '' : String(event.user_id)
      const privateRef = eventUserId === '' ? undefined : { kind: 'private' as const, userId: eventUserId }
      this.#rejectOutOfScope('private', event.sub_type, privateRef)
      return
    }
    if (claim.kind === 'personal') return
    // 准入闸：不在白名单（或白名单整份无效）时，只回固定拒绝文案，绝不建会话。
    if (!this.#isAllowed(claim.stableUserId)) {
      await this.#rejectUnauthorized(claim.stableUserId)
      return
    }
    // P4-B-3：准入之后的联系人策略。抑制只计数 + 限频日志，不 announce、不建会话、不回复。
    const contactDecision = decideQqContact(this.#contacts, claim.stableUserId, Date.now(), this.#contactLimiter)
    if (contactDecision.action === 'deny') {
      this.#contactSuppressed += 1
      this.#logContactSuppressed(claim.stableUserId, contactDecision.reason)
      return
    }
    const inbound = oneBotMessage(event, this.#config.maxText ?? 8000)
    const text = inbound.text
    if (text.trim().length === 0) return
    const target: QqBridgeTarget =
      claim.kind === 'private'
        ? { kind: 'private', userId: claim.stableUserId }
        : { kind: 'group', groupId: claim.externalRoomId }
    const sessionId = qqSessionIdFor(target)
    this.#sessions.set(sessionId, target)
    try {
      this.#deps.adapter.announce(sessionId, claim)
    } catch (error) {
      this.#deps.logger.warn('[psyche][qq] 会话声明登记失败', { sessionId, error: String(error) })
      return
    }
    const host = this.#deps.host
    if (host.agents === undefined) {
      this.#deps.logger.error('[psyche][qq] 宿主没有 agents 服务，无法投递 QQ 消息')
      return
    }
    // 同一会话按接收顺序串行投递；不同会话并行。队列满时计数并拒绝（P4-C-0）。
    await this.#runSerial(sessionId, async () => {
      try {
        const agent = await this.#ensureAgent(sessionId, target, generation)
        if (!this.#isActive(generation)) return
        // 等 Host 的 `agent/created` 绑定落定再投递：capture 发生在 DSH 处理消息时，
        // 如果绑定还没写入，Source 的 sender_contact_id 会是 null，私聊记忆变成
        // 「private → unknown」永远召不回（R6-3C 的 bug B）。
        await this.#waitBinding(sessionId, generation)
        if (!this.#isActive(generation)) return
        // followup 接收单条消息：AgentLoop 的 send() 内部会把它包成一批
        // （`inbox.splice(target, Infinity, 0, [message])`）。若这里再传数组，
        // inbox 里会变成 `[[msg]]`，后续 `decision.messages` 的每一项不是消息
        // （`message.source` undefined），pre-step/step 会抛 `reading 'kind'`。
        agent.followup(qqUserMessage(text, event.message_id === undefined ? null : String(event.message_id), inbound.media))
        this.#bindInbound(sessionId, target, event.message_id === undefined ? null : String(event.message_id))
        this.#stats.delivered += 1
        this.#diagnostics.record({
          direction: 'in',
          target,
          result: 'delivered',
          textLength: text.length,
          media: inbound.media,
        })
        this.#deps.logger.info('[psyche][qq] 已投递 QQ 消息', { sessionId, kind, textLength: text.length })
      } catch (error) {
        if (!this.#isActive(generation)) return
        this.#deps.logger.error('[psyche][qq] 投递失败', { sessionId, error: String(error) })
        void this.#sendText(target, '这边暂时没能接上，稍后再发一次试试。')
      }
    }, generation)
  }

  async #ensureAgent(sessionId: string, target: QqBridgeTarget, generation: number): Promise<{ followup(message: unknown): void }> {
    const existing = this.#deps.host.agents?.get(sessionId)
    if (existing !== undefined) return existing
    const agentOptions = { provider: this.#config.provider, model: this.#config.model }
    // 顺序很重要：resume 优先。磁盘上已有这个会话（上次宿主退出前创建过）时，
    // create 会抛 SessionAlreadyExistsError，而 resume 只是「恢复已有会话」。
    let resumeError: unknown
    try {
      const resumed = await this.#deps.host.agents!.resume({
        resumeSessionId: sessionId,
        agentOptions,
      })
      if (!this.#isActive(generation)) throw new Error('QQ bridge lifecycle ended')
      this.#deps.logger.info('[psyche][qq] 已恢复会话', { sessionId })
      return resumed.agent
    } catch (error) {
      if (!this.#isActive(generation)) throw error
      resumeError = error
    }
    // 会话不存在才新建。群聊的 target 只影响 id，不参与身份解析。
    // 注意：`meta.origin` 在 DSH session header 里只允许 "subagent"（或省略），
    // 传 `origin:'qq'` 会让 create 直接抛 `session header origin must be "subagent"`。
    // 来源标记由会话 id 前缀（qq-private-/qq-group-）表达，不写进 header。
    try {
      const created = await this.#deps.host.agents!.create({
        sessionId,
        agentOptions,
        // 让 QQ 会话落在独立工作区（DSH 按 session header 的 cwd 分组）：
        // 不传 cwd 会落到 sessions/_no-cwd，在「QQ 聊天」工作区里看不到。
        ...(this.#config.cwd === undefined || this.#config.cwd === ''
          ? {}
          : { meta: { cwd: this.#config.cwd } }),
      })
      if (!this.#isActive(generation)) throw new Error('QQ bridge lifecycle ended')
      this.#deps.logger.info('[psyche][qq] 已创建会话', { sessionId, target: target.kind })
      return created.agent
    } catch (createError) {
      if (!this.#isActive(generation)) throw createError
      // resume 失败但 create 报「已存在」：多半是 resume 需要的会话头/选项暂时不可用，
      // 再 resume 一次比把用户消息丢掉更合理；仍失败则把两个错误都带出去。
      this.#deps.logger.warn('[psyche][qq] 创建会话失败，回退 resume 重试', {
        sessionId,
        resumeError: String(resumeError),
        createError: String(createError),
      })
      const retried = await this.#deps.host.agents!.resume({
        resumeSessionId: sessionId,
        agentOptions,
      })
      if (!this.#isActive(generation)) throw new Error('QQ bridge lifecycle ended')
      this.#deps.logger.info('[psyche][qq] 已恢复会话（重试）', { sessionId })
      return retried.agent
    }
  }

  /**
   * 等 Host 的 `agent/created` 绑定落定（最多约 1 秒）。
   *
   * DSH 的 agent 创建与 `agent/created` 监听器之间是异步派发；如果消息在绑定写入
   * `RuntimeInputStore` 之前就进入 Capture，Source 的 `sender_contact_id` 会是 null，
   * 私聊来源域就变成 unknown、记忆永远召不回。这里只等待、不代替 Host 绑定。
   */
  async #waitBinding(sessionId: string, generation: number): Promise<void> {
    const check = this.#deps.isSessionBound
    if (check === undefined) return
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!this.#isActive(generation)) return
      if (check(sessionId)) return
      await new Promise((resolve) => {
        setTimeout(resolve, 25)
      })
    }
    if (this.#isActive(generation)) this.#deps.logger.warn('[psyche][qq] 会话绑定等待超时，按未绑定继续', { sessionId })
  }

  #listenAgentReplies(): void {
    const generation = this.#generation
    const host = this.#deps.host
    if (typeof host.on !== 'function') return
    const off = host.on('session/event', (session: { id?: string }, event: { type?: string; data?: unknown; seq?: unknown }) => {
      if (!this.#isActive(generation)) return
      if (event.type !== 'assistant/message') return
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      const target = this.#sessions.get(sessionId)
      if (target === undefined) return
      const data = event.data as {
        message?: { id?: unknown; content?: unknown; interrupted?: unknown; source?: { kind?: unknown } }
      } | undefined
      const text = messageText(data?.message)
      if (text === null || text.trim().length === 0) return
      if (isPurePsycheToolMarkup(text)) {
        // R8：模型偶发把工具调用写成正文；纯标记不能当回复发出去，也不能静默改写。
        this.#deps.logger.warn('[psyche][qq] 助手回复只有工具标记，已丢弃', { sessionId })
        return
      }
      // P4-B-4-2b：开启 Outbox 时私聊回复只入队；群回复保持原路径（群回复本身默认关闭）。
      if (this.#replyOutboxEnabled && target.kind === 'private') {
        const gate = qqReplyOutboxGate(event)
        if (!gate.ok) {
          this.#deps.logger.warn('[psyche][qq] 助手回复不满足 Outbox 入队条件，已丢弃', {
            sessionId,
            reason: gate.reason,
          })
          return
        }
        const store = this.#replyOutboxStore
        if (store === null) {
          this.#deps.logger.error('[psyche][qq] replyOutbox 已开启但 Store 未挂载，助手回复失败关闭')
          return
        }
        void (async () => {
          const contactId = this.#resolveContactId === null ? null : await this.#resolveContactId(target.userId)
          if (contactId === null) {
            this.#deps.logger.warn('[psyche][qq] 助手回复入队失败：联系人未解析（不退回直发）', { sessionId })
            return
          }
          store.enqueue({
            personaId: 'main',
            contactId,
            stableUserId: target.userId,
            sessionId,
            sessionSeq: gate.seq,
            transportId: this.#transport?.id ?? '',
            payloadText: text,
            quoteMessageId: this.#replyToFor(target, sessionId, undefined) ?? null,
          })
        })().catch((error: unknown) => {
          this.#deps.logger.warn('[psyche][qq] 助手回复入队失败（不退回直发）', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        return
      }
      // P4-C-0：助手回复优先走已挂载的 Transport（与准入解耦）；未挂载时保持原路径。
      if (this.#transport !== null) {
        void this.#transport.send(this.#transportTarget(target), {
          text,
          replyToMessageId: this.#replyToFor(target, sessionId, undefined),
        }).then((result) => {
          if (!this.#isActive(generation)) return
          if (result.outcome === 'accepted') return
          this.#deps.logger.warn('[psyche][qq] 助手回复经 Transport 发送未成功', {
            outcome: result.outcome,
            errorCode: result.errorCode ?? '',
          })
        })
        return
      }
      void this.#sendText(target, text)
    })
    if (typeof off === 'function') this.#listeners.push(off)
  }

  #recordOutbound(
    target: QqBridgeTarget,
    text: string,
    result: { ok: boolean; error?: string; quote?: 'applied' | 'omitted-unbound' | 'omitted-unsupported' },
  ): void {
    const unknown = result.error === 'timeout' || result.error === 'disconnected' || result.error === 'send-timeout'
    this.#diagnostics.record({
      direction: 'out',
      target,
      result: result.ok ? 'accepted' : unknown ? 'unknown' : 'failed',
      ...(result.ok ? {} : { errorCode: result.error ?? 'other' }),
      ...(result.quote === undefined ? {} : { quote: result.quote }),
      textLength: text.length,
    })
  }

  /** 发一条文本；等待后端回执（超时标 unknown，不自动重发）。 */
  #sendText(
    target: QqBridgeTarget,
    text: string,
    strictAck = false,
    active?: () => boolean,
    replyToMessageId?: string | null,
  ): Promise<{ ok: boolean; messageId?: string; error?: string; quote?: 'applied' | 'omitted-unbound' | 'omitted-unsupported' }> {
    if (this.#stopped) {
      const result = { ok: false, error: 'bridge-stopped' }
      this.#recordOutbound(target, text, result)
      return Promise.resolve(result)
    }
    const socket = this.#socket
    if (socket === null) {
      this.#stats.sendErrors += 1
      const result = { ok: false, error: 'not-connected' }
      this.#recordOutbound(target, text, result)
      return Promise.resolve(result)
    }
    let quote: 'applied' | 'omitted-unbound' | 'omitted-unsupported' | undefined
    let replyTo: string | null = null
    if (replyToMessageId !== undefined && replyToMessageId !== null && replyToMessageId !== '') {
      if (target.kind !== 'private') quote = 'omitted-unsupported'
      else if (this.#hasBoundInbound(target, replyToMessageId)) {
        quote = 'applied'
        replyTo = replyToMessageId
        this.#consumeBoundInbound(target, replyToMessageId)
      } else quote = 'omitted-unbound'
    }
    const echo = `qq-bridge-${++this.#echo}`
    const action = target.kind === 'private' ? 'send_private_msg' : 'send_group_msg'
    const message = buildOutgoingMessage(text, replyTo)
    const params =
      target.kind === 'private'
        ? { user_id: oneBotNumericId(target.userId), message }
        : { group_id: oneBotNumericId(target.groupId), message }
    return new Promise((resolve) => {
      const finish = (result: { ok: boolean; messageId?: string; error?: string; quote?: 'applied' | 'omitted-unbound' | 'omitted-unsupported' }): void => {
        this.#recordOutbound(target, text, result)
        resolve(result)
      }
      const timeoutMs = this.#config.sendTimeoutMs ?? 10_000
      const timer = (this.#deps.setTimeout ?? setTimeout)(() => {
        this.#pending.delete(echo)
        // 超时后不再有可靠关联标识；同连接后续无 echo 回执不能归属任何 pending。
        this.#ackAmbiguous = true
        this.#stats.sendErrors += 1
        this.#deps.logger.warn('[psyche][qq] 回复发送超时，结果未知（不重发）', { action, echo })
        finish({ ok: false, error: 'timeout', ...(quote === undefined ? {} : { quote }) })
      }, timeoutMs)
      this.#pending.set(echo, { resolve: finish, timer, strictAck, ...(quote === undefined ? {} : { quote }) })
      try {
        if(active&&!active()) {
          this.#deps.clearTimeout?.(timer);this.#pending.delete(echo)
          finish({ok:false,error:'inactive-before-send', ...(quote === undefined ? {} : { quote })});return
        }
        socket.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        this.#deps.clearTimeout?.(timer)
        this.#pending.delete(echo)
        this.#stats.sendErrors += 1
        this.#deps.logger.warn('[psyche][qq] 回复发送失败', { action, error: String(error) })
        finish({ ok: false, error: 'send-failed', ...(quote === undefined ? {} : { quote }) })
      }
    })
  }

  /**
   * 结算一次发送。`echo` 可为 null（SnowLuma 不回显）：此时按 FIFO 取最早的 pending。
   * 回执本身没有「消息已送达 QQ」的强证明，`status:'ok'`/`retcode:0` 只表示后端接受了请求，
   * 桥不自动重发；主动任务要求数字 retcode 和明确 status，结果分类由 Transport 负责。
   */
  #settleSend(echo: string | null, event: MessageEventLike): void {
    const retcode = (event as { retcode?: unknown }).retcode
    const status = (event as { status?: unknown }).status
    let key = echo
    // 显式 echo 不匹配是迟到/其他请求的回执，不能结算当前审批。
    if (key !== null && !this.#pending.has(key)) return
    if (key === null) {
      // 有发送超时后，无 echo 回执无法可靠归属；只记录告警，不结算任何 pending。
      if (this.#ackAmbiguous) {
        this.#deps.logger.warn('[psyche][qq] 无 echo 回执在超时后到达，无法可靠归属，已忽略')
        return
      }
      const oldest = this.#pending.keys().next()
      if (oldest.done === true) {
        return
      }
      key = oldest.value
    }
    const pending = this.#pending.get(key)
    if (pending === undefined) return
    // 普通回复兼容仅带数字 retcode 的后端；主动任务逐条保持完整回执要求。
    // 不接受缺 retcode、字符串 retcode 或显式非法 status，不能把任意包当成功。
    const retcodeOnly = !pending.strictAck && status === undefined
    if (typeof retcode !== 'number' || (!retcodeOnly && status !== 'ok' && status !== 'failed')) return
    this.#pending.delete(key)
    this.#deps.clearTimeout?.(pending.timer)
    const ok = retcode === 0 && (status === 'ok' || retcodeOnly)
    if (ok) this.#stats.lastSentAt = new Date().toISOString()
    else {
      this.#stats.sendErrors += 1
      this.#deps.logger.warn('[psyche][qq] 后端拒绝发送', { echo: key, retcode })
    }
    pending.resolve({
      ok,
      messageId: extractSentMessageId(event),
      ...(ok ? {} : { error: retcode !== 0 && (status === 'failed' || retcodeOnly) ? `retcode:${retcode}` : 'protocol-result-unknown' }),
      ...(pending.quote === undefined ? {} : { quote: pending.quote }),
    })
  }
}

/** OneBot 动作参数里的 ID：安全整数用 number（后端期望数字），否则保留字符串。 */
function oneBotNumericId(id: string): number | string {
  const asNumber = Number(id)
  return Number.isSafeInteger(asNumber) ? asNumber : id
}

function extractSentMessageId(event: MessageEventLike): string | undefined {
  const data = (event as { data?: { message_id?: unknown } }).data
  if (data !== null && data !== undefined && data.message_id !== undefined) return String(data.message_id)
  return undefined
}

function withAccessToken(wsUrl: string, token: string): string {
  if (token === '') return wsUrl
  const joined = wsUrl.includes('?') ? '&' : '?'
  return `${wsUrl}${joined}access_token=${encodeURIComponent(token)}`
}

function extractPayloadText(payload: unknown): string | null {
  if (typeof payload === 'string') return payload
  if (payload !== null && typeof payload === 'object') {
    const data = (payload as { data?: unknown }).data
    if (typeof data === 'string') return data
  }
  return null
}

/** 从 assistant message 的 content 数组取文本。 */
export function messageText(message: { content?: unknown } | undefined): string | null {
  if (message === undefined || message === null) return null
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (block !== null && typeof block === 'object') {
      const typed = block as { type?: string; text?: unknown }
      if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
    }
  }
  return parts.length === 0 ? null : parts.join('')
}
