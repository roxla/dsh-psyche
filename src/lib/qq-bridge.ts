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
import type { GroupMessageInput, QqReplyOutboxRow, QqReplyOutboxStore } from 'dsh-psyche-core'
import { QqReplyWorker } from 'dsh-psyche-core'
import { groupRoomPolicies, groupMessageForCapture, resolveGroupCaptureMode } from './qq-group-ingress.js'
import type { GroupCaptureMode, RoomPolicy } from 'dsh-psyche-core'
import { isPurePsycheToolMarkup } from './qq-reply-text.js'
import { maskQqId } from './qq-admin.js'
import { QqDiagnostics, type QqDiagnosticFilter, type QqDiagnosticPage } from './qq-diagnostics.js'
import { ContactRateLimiter, decideQqContact, parseQqContactPolicies, type QqContactPolicyIndex } from './qq-contact-policy.js'
import type { QqReplySchedules } from './qq-settings-overlay.js'
import { inReplyWindow, nextAllowedReplyAt } from './qq-reply-window.js'

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
   * 留空时由 Host 决定默认值（先用磁盘上已有 QQ 会话的目录，没有才用
   * `<宿主工作目录>/QQ 聊天`，相对值也按宿主工作目录补全）。
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
  allowFrom?: { owner: string; extra: string[]; groups?: string[] }
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

/**
 * 桥只依赖宿主 ctx 上真正用到的两件事：agents 服务与事件订阅。
 *
 * `model` 只在「按指定 id 走宿主正式创建路径」时用到：`session/create` 只接受 preset、
 * 不接受 agentOptions，覆盖层里的 provider/model 只能建好之后补写。它是会话级选择
 * （`AgentModel.select` 往会话里追加 `model/selection`），不会改宿主默认模型。
 */
export interface QqBridgeHost {
  agents?: {
    get(id: string): {
      followup(message: unknown): void
      status?: string
      model?: {
        current?(): { provider: string; model: string; reasoningEffort?: string } | undefined
        select?(selection: { provider: string; model: string; reasoningEffort?: string }): void
      }
    } | undefined
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
  /**
   * 把会话从宿主的归档名单里恢复出来。
   *
   * 归档是 Workspace 级的状态：被归档的会话在 `agent/pre-step` 就被
   * `ArchivedSessionGate` reject 掉，从而**零模型调用、没有 assistant/message、
   * 没有 Source**。桥接把消息 `followup` 进去之后收不到任何回应，自己却以为
   * 投递成功（`delivered` 计的是「交给了 Host」），用户看到的是「发了没反应」。
   *
   * QQ 会话由桥接独占管理，用户归档它没有意义（下一条消息又会把它恢复使用），
   * 所以每次投递前都先确保它不在归档名单里。缺省不注入——测试与一次性脚本用。
   */
  unarchiveSession?: (sessionId: string) => Promise<void>
  /**
   * 把会话挂进「QQ 聊天」工作区。
   *
   * 只给 `agents.create` 传 `meta.cwd` 不够：宿主只在 `workspace/create`
   * 时登记工作区条目，光有 cwd 的会话会掉进侧栏的「未分组」。dsh-qq 也是
   * 先 `workspace.create` + `rename`，再把会话挂进去。缺省不注入——测试用。
   */
  ensureSessionWorkspace?: (sessionId: string) => Promise<void>
  /**
   * 按固定会话 id 走宿主正式创建路径（`workspace/create` + `session/create`）。
   *
   * 为什么不用 `agents.create`：它造出来的会话不在宿主账目里——`insertSessionBefore`
   * 直接回 `workspace/move-invalid: the session is not accounted`，侧栏只能落到
   * 「未分组」，事后补登又多一个失败点。宿主自己的 `session/create` 会同时建会话、
   * 建 Agent 并登记进工作区（真机实测：返回后 `session/state` 就是 `active: true`、
   * `queue: []`，走的是「有活 Agent」分支而不是冷态分支）。
   *
   * @param sessionId 期望的会话 id（QQ 侧约定 `qq-private-<uid>` / `qq-group-<gid>`）。
   * @returns 宿主实际建出来的会话 id。正常等于传入值；不等说明宿主没复用这个 id
   *          （只有「命名的空会话可复用」时才沿用），那种情况下投递等于投进另一个
   *          会话，调用方必须停下核对而不是接着用。
   */
  createSessionThroughControllers?: (sessionId: string) => Promise<string>
  /**
   * 显式允许旧版 `agents.create` 建会话（默认关闭）。
   *
   * GPT 第 1 轮第 1 条：生产路径不能「悄悄回退」到账外创建。这里把它做成独立开关，
   * 只有测试夹具与一次性脚本会开；产品装配不注入，缺了 `createSessionThroughControllers`
   * 就直接报错而不是换个方式建会话。
   */
  allowLegacyAgentCreate?: boolean
  ingestGroupMessage?: (input: GroupMessageInput, isActive: () => boolean) => Promise<{ retained: boolean; replayed: boolean } | null>
  /**
   * 时段外的独立私聊采集入口（replySchedules 第二批，GPT 第 2 轮裁定 (a)）。
   *
   * 只写 Core 的 Source + 一条 conversation 事件；不建回复轮、不排队、不发送。
   * 不注入时退回「只记诊断」，并且日志会明确写未采集——不能拿诊断冒充记忆。
   */
  ingestPrivateMessage?: (input: {
    stableUserId: string
    messageId: string
    text: string
    at: string
  }) => Promise<{ sourceId: string; eventId: string | null; replayed: boolean } | null>
  /**
   * 宿主的自动采集开关（`capture.enabled`）。false 时时段外那条路径也不调 sink，
   * 保证「采集关闭 → Source 0」是桥接层能证明的行为，而不是靠 sink 内部兜底。
   */
  captureEnabled?: boolean
  onGroupConnectionGap?:()=>void
  /**
   * 授权代次的持久化（迁移 36，策略侧）。
   *
   * 缺省不持久化——测试与一次性脚本用。生产必须注入：不注入则重启后 `#accessEpochs`
   * 从 0 起，而任务行上的 `access_epoch` 可能是 2 或 3，所有在途回复都会被判
   * `access-superseded`（比误发安全，但会让重启后的回复静默失败）。
   */
  accessEpochStore?: {
    load(): Map<string, number>
    save(epochs: ReadonlyMap<string, number>): void
    /**
     * 两阶段提交（迁移 37）。缺省时退化成「只有 save」——也就是 v36 的行为：
     * 崩溃点落在「覆盖文件已写、代次没落库」时会放行旧的在途任务。
     * 生产必须注入这两个动作。
     */
    begin?(targets: ReadonlyMap<string, number>): void
    commit?(epochs: ReadonlyMap<string, number>): void
    /** 读出「上次没走完的授权变更」；这些 peer 在确认前不得派遣。 */
    loadPending?(): Map<string, number>
  }
}

export type QqBridgeTarget =
  | { kind: 'private'; userId: string }
  | { kind: 'group'; groupId: string }

const SESSION_PREFIX_PRIVATE = 'qq-private-'
const SESSION_PREFIX_GROUP = 'qq-group-'

/**
 * `resume` 的失败原因是不是「这个会话不存在」。
 *
 * 宿主对「没有这个会话」和「有会话但这个选项现在用不了」都走同一个 reject，
 * 而两者的正确反应相反：前者该新建，后者新建会在磁盘上多出一个半成品会话，
 * 且它不在宿主账目里（后续任何 workspace 操作都认不到）。所以这里只认明确的
 * 不存在信号，其余一律当失败上抛，由调用方决定要不要人工核对。
 *
 * 判定顺序（GPT 第 1 轮第 1 条）：
 * 1. 有结构化 `code` 就只信 code——`session/not-found` 之类才算「不存在」，
 *    其它 code 一律不信文本，避免把「依赖缺失 / 存储没起来」误判成会话不存在；
 * 2. 没有 code 时才看文本，而且必须同时带上「session/会话」这个主语，
 *    不再接受裸的 `not found` / `ENOENT` / `does not exist`（这些太容易误伤）。
 */
const MISSING_SESSION_CODES = new Set(['session/not-found', 'SESSION_QUERY_SESSION_NOT_FOUND', 'session/not_found'])

/** 从错误对象上取结构化 code；宿主错误可能是 `{code}` 或 `{details:{code}}`。 */
function errorCodeOf(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null
  const record = error as { code?: unknown; details?: unknown }
  if (typeof record.code === 'string' && record.code !== '') return record.code
  const details = record.details
  if (details !== null && typeof details === 'object') {
    const inner = (details as { code?: unknown }).code
    if (typeof inner === 'string' && inner !== '') return inner
  }
  return null
}

/** 文本兜底：主语必须是 session/会话，动作必须是「不存在」。 */
const MISSING_SESSION_TEXT = /(?:session|会话)[^\n]{0,48}(?:not\s*found|does\s+not\s+exist|不存在|未找到)|no\s+such\s+session/i

export function looksLikeMissingSession(error: unknown): boolean {
  const code = errorCodeOf(error)
  if (code !== null) return MISSING_SESSION_CODES.has(code)
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return MISSING_SESSION_TEXT.test(text)
}

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
/**
 * 第 57 轮 P1-D：配置不可信期间的重读节流。
 *
 * 暂停期间每次收发都会试着重读覆盖层——读盘很便宜，但入站可能成批到达，
 * 一秒一次足够让「还原文件」几乎立刻生效，又不会把磁盘打满。
 */
const CONFIG_RECHECK_MS = 1_000

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
  allowFrom: { owner?: string; extra?: string[]; groups?: string[] } | undefined,
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

/** P4-B-2：出站统一换行并去除开头的完整空白行；保留首行缩进和段落。 */
export function normalizeOutgoingText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/^(?:[^\S\n]*\n)+/u, '')
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

/**
 * P0-A：一条入站消息在准入那一刻定死的快照。
 *
 * 回复要等模型生成完才发，这段空档正是撤权窗口。快照必须跟着**这条消息**走，
 * 不能跟着 peer 走——否则同一对象的后续入站会覆盖前一跳的代次与引用目标。
 */
interface QqAdmission {
  /** 准入那一刻该对象的授权代次。 */
  readonly accessEpoch: number
  /** 这条入站对应的平台消息 id，出站引用只能引它。 */
  readonly quoteMessageId: string | null
  /** 授权对象键，仅用于日志与诊断。 */
  readonly peerKey: string
}

/** P1：单次 WS 握手超时；超时按一次失败进入退避，不无限等待。 */
const CONNECT_TIMEOUT_MS = 10_000
/** P1：连接存活满该窗口才清零退避；抖动式“刚连上就断”不得重置。 */
const STABLE_WINDOW_MS = 30_000
/** 前多少次失败按指数退避；超过之后转慢速探测（见 `#scheduleReconnect`）。 */
const RECONNECT_FAST_LIMIT = 20
/** 指数退避阶段单次间隔的上限。 */
const RECONNECT_FAST_CEILING_MS = 30_000
/**
 * 慢速阶段的固定间隔。
 *
 * 原先定 5 分钟，实测代价太大：SnowLuma 起来后如果正好落在慢速档，用户发来的消息要等
 * 最多 5 分钟才会被接收，他只会看到「发了没反应」。60 秒既压住空转频率，又把恢复延迟
 * 控制在一分钟内。
 */
const RECONNECT_SLOW_CEILING_MS = 60_000

export class QqBridge {
  readonly #config: QqBridgeConfig
  readonly #deps: QqBridgeDeps
  readonly #sessions = new Map<string, QqBridgeTarget>()
  /**
   * 旧会话被归档且恢复不了时，改用的新会话 id。
   *
   * 归档的会话在 `agent/pre-step` 就被 Host 拒掉，消息投进去也没有任何回应；宿主把归档
   * 集合缓存在内存里，改 `workspace.json` 不生效，只能走 `workspace/unarchiveSession`。
   * 那个接口调用失败（权限、宿主版本、会话已被删除）时不能就此放弃——按用户的要求，
   * 归档了就换一个新会话，让对话继续，而不是原地等一个永远不来的回复。
   */
  readonly #sessionOverrides = new Map<string, string>()
  #sessionGeneration = 0
  /** P4-B-2：每个会话最近收到、可用于引用回复的平台消息 id（有上限，内存态）。 */
  readonly #boundInbound = new Map<string, Set<string>>()
  /**
   * P0-A：准入那一刻定死的授权快照，按 **(会话 id, 入站消息 id)** 存。
   *
   * 之前按 peer 键（`private:<uid>`）存，一条迟到的回复会读到「同一 peer 最近一次准入」的代次：
   * M2 生成期间 M3 又准入一次（撤销后又加回、代次涨过一轮），M2 的回复就带着 M3 的代次出门，
   * 复核等于没做。快照必须跟消息绑，不跟人绑。
   *
   * 键里必须带会话：平台消息 id 只在单个会话内唯一，两个会话出现同一个 id 时不能互相覆盖。
   */
  readonly #admissions = new Map<string, QqAdmission>()
  /** 某会话里已由 `turn/start` 打开、还没 `turn/end` 的轮次。 */
  readonly #openTurns = new Map<string, Set<number>>()
  /** `${sessionId}#${turn}` → 这一轮绑定到的入站消息 id（正常情况下恰好一条）。 */
  readonly #turnInbounds = new Map<string, Set<string>>()
  /**
   * `${sessionId}#${turn}` → 绑定成功那一刻固定的准入快照。
   *
   * 只存消息 id、出站时再回 `#admissions` 查是不够的：同一个键（同会话同 id）后来又被
   * 重新写入（重复投递、重放、超时重试），旧回复就会拿到新快照里的新代次。绑定时把
   * `accessEpoch`/`quoteMessageId`/`peerKey` 一起扣下来，这条回复此后只认这一份。
   */
  readonly #turnAdmissions = new Map<string, QqAdmission>()
  /**
   * `${sessionId}#${turn}` → 这一轮的入站归属已经无法确定。
   *
   * 两个 turn 同时开放时又来了一条已准入入站：既可能是新轮的，也可能是补发给旧轮的，
   * 宿主不给线索，我们也不猜。受影响的开放轮次全部标进来，出站时一律失败关闭。
   */
  readonly #ambiguousTurns = new Set<string>()
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
  /**
   * 重连的可观测状态：给管理页回答「网关到底在不在」。
   * 之前面板只有 `connection: disconnected`，用户分不清是插件坏了、
   * 白名单拒了，还是 SnowLuma 根本没开——这三种在界面上长得一样。
   */
  #lastAttemptAt: string | null = null
  #nextAttemptAt: string | null = null
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
  /**
   * Q1：控制中心写入的覆盖值；`null` 表示跟随宿主配置。
   *
   * 保留 `#allow` 作为「宿主配置基线」而不是就地改写它，是为了让「恢复宿主配置」
   * 能真的退回宿主值，而不是退回到某个被改过的中间态。
   */
  #accessOverride: { owner: string; extra: string[]; groups?: string[] } | null = null
  /**
   * 第二批：目标级允许回复时段。
   *
   * 键是 `private:<QQ号>` / `group:<群号>`；没有键表示继承「随时可回复」。
   * 规则不授予任何权力——准入与代次检查先过，这里只决定「现在这个时刻允许回复吗」。
   */
  #replySchedules: QqReplySchedules = {}
  /**
   * 第 57 轮 P1-D：覆盖层是否可信。
   *
   * `null` 表示可信；非空是「不可信的原因」。覆盖文件整份校验失败时置位，
   * 之后所有依赖它的收发路径都暂停——不能退回宿主旧名单继续发，
   * 那会让主人设的暂停与时段在坏配置下悄悄失效。
   */
  #configUntrusted: string | null = null
  /** 暂停期间的重读节流时间戳（见 `#ensureConfigTrust`）。 */
  #configCheckAt = 0
  /** 重读覆盖层的回调，由 `src/index.ts` 注入。 */
  #configRecheck: (() => boolean) | null = null
  /**
   * 12a：每个授权对象（私聊对端 / 群）的授权代次。
   *
   * 存在的理由是「撤销之后再重新授权」这一种很具体的情况：B 被撤销时，旧任务在
   * 发送那一刻会因为不在名单里被拦下；但如果 B 撤销后又被重新加回来，只查名单
   * 就会把旧任务放出去——而那条回复是对「上一段授权」的回答。代次解决的是这个：
   * 任务在开工时记下当时的代次，发送前比对，不一致就丢。
   *
   * 只在**该对象的可发送性真的变了**时递增：重复保存同一份配置、或者只改了 C，
   * 不应该让 B 手里还没发出去的东西失效。
   */
  readonly #accessEpochs = new Map<string, number>()
  /**
   * 迁移 37：授权变更「已开始、未确认」的对象。
   *
   * 两处会写：启动时从库里读到 pending（上一个进程崩在中间）、以及本次提交失败。
   * 在集合里的对象一律不发——因为此时「名单」和「代次」可能来自两个不同的时刻，
   * 无法判断手里这条旧回复到底还算不算合法。宁可停下来等人重新授权一次。
   */
  readonly #pendingPeers = new Set<string>()
  /** Q1：控制中心写入的默认模型覆盖；`null` 表示跟随宿主配置。 */
  #modelOverride: { provider: string; model: string; reasoningEffort?: string } | null = null
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
    // 迁移 36：把上一进程落库的代次读回来。读失败时保持空表并告警——空表等价于
    // 「大家都是第 0 代」，任务行上的非零代次会被判 superseded，比误发安全。
    if (deps.accessEpochStore !== undefined) {
      try {
        for (const [key, epoch] of deps.accessEpochStore.load()) {
          if (typeof epoch === 'number' && Number.isFinite(epoch) && epoch >= 0) this.#accessEpochs.set(key, epoch)
        }
      } catch (error) {
        deps.logger.warn('[psyche][qq] 授权代次读取失败，本进程按初始代次处理', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
      // 迁移 37：上次授权变更没走完的对象一律暂停。这里**不猜**它该是第几代——
      // pending 里记的只是「当时打算涨到几」，用它补值等于替崩溃那一刻做了决定。
      try {
        const pending = deps.accessEpochStore.loadPending?.() ?? new Map<string, number>()
        for (const key of pending.keys()) this.#pendingPeers.add(key)
        if (pending.size > 0) {
          deps.logger.warn('[psyche][qq] 授权变更未确认完成，相关对象暂停派遣', {
            peers: [...pending.keys()],
          })
        }
      } catch (error) {
        // 读不出来就不能假定「没有未完成变更」——那正是放行组合最容易出现的姿态。
        // 保守做法：把当前已知的每个授权对象都标成暂停，等人重新应用一次名单。
        for (const key of [...this.#allow.ids].map((userId) => `private:${userId}`)) this.#pendingPeers.add(key)
        deps.logger.warn('[psyche][qq] 未完成变更读取失败，所有授权对象暂停派遣', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
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
    /** 当前生效的群白名单；空数组表示一个群都不采集。 */
    allowFromGroups: string[]
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
    /**
     * 重连的可观测状态。`mode === 'slow'` 表示已经连不上很久、每 5 分钟一次；
     * `lastAttemptAt === null` 且 `attempts === 0` 表示从启动到现在还没试过。
     */
    reconnect: {
      attempts: number
      mode: 'idle' | 'fast' | 'slow'
      lastAttemptAt: string | null
      nextAttemptAt: string | null
    }
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
      allowFromValid: this.#effectiveAllow().valid,
      // 快照如实反映「当前生效」的名单，而不是宿主配置里的原始值：
      // 控制中心改过之后，管理页和诊断导出看到的应该是同一份有效值。
      allowFromOwner: this.#currentOwner() === '' ? null : this.#currentOwner(),
      allowFromExtra: this.#currentExtra(),
      allowFromGroups: this.#currentGroups(),
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
      reconnect: {
        attempts: this.#attempts,
        mode: this.#attempts === 0 ? 'idle' : this.#attempts <= RECONNECT_FAST_LIMIT ? 'fast' : 'slow',
        lastAttemptAt: this.#lastAttemptAt,
        nextAttemptAt: this.#nextAttemptAt,
      },
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
      authorization: (row) => this.authorizeOutboxRow(row),
      intervalMs: this.#replyOutboxIntervalMs,
      logger: this.#deps.logger,
    })
    if (!this.#stopped) this.#replyOutboxWorker.start()
  }

  /**
   * 队列行此刻能不能发：返回 null 表示放行，否则是给队列行记下的原因。
   *
   * 第 20/21 轮：这是「要不要放行」的决策点，必须**强制**读一次盘——不能复用上一次的结论，
   * 否则文件刚被改坏的那一秒里，Worker 仍会按缓存的「可信」把消息发出去。
   */
  authorizeOutboxRow(row: QqReplyOutboxRow): string | null {
    if (row.transportId !== this.#transport?.id) return 'transport-mismatch'
    // 覆盖层不可信时一律暂停（不是失败关闭成 failed）——坏配置迟早会被还原，
    // 队列行要留着重发，见 claim 里对 config-corrupt 的延后处理。
    if (!this.#ensureConfigTrust(true)) return 'config-corrupt'
    // 12a：迁移 35 之前的行没有代次快照。补上当前代次等于默认授权，
    // 正是要防的那件事，所以一律按缺失处理并停止自动发送。
    if (row.accessEpoch === null) return 'epoch-missing'
    // 撤权也可能不改代次（例如从未被观察过的对端），所以名单要单独再查一次。
    if (!this.#isAllowed(row.stableUserId)) return 'access-revoked'
    if (row.accessEpoch !== this.accessEpochOf({ kind: 'private', userId: row.stableUserId })) {
      return 'access-superseded'
    }
    // 第二批：排队期间可能已跨出允许时段；紧靠发送前用当前时刻与最新规则再判一次。
    if (!this.#inReplyWindowFor({ kind: 'private', userId: row.stableUserId })) {
      return 'outside-reply-window'
    }
    return null
  }

  /**
   * 供 Transport 使用；主动入口逐条指定 strictAck，普通来源回复兼容省略 status 的回执。
   * P4-B-2：可带 `replyToMessageId`（必须属于当前私聊会话），否则安全退化为纯文本。
   */
  sendOutgoingText(
    target: { kind: 'private'; userId: string } | { kind: 'group'; groupId: string },
    text: string,
    options: { strictAck?: boolean; isActive?:()=>boolean; replyToMessageId?: string | null; accessEpoch?: number } = {},
  ): Promise<{ ok: boolean; messageId?: string; error?: string; quote?: 'applied' | 'omitted-unbound' | 'omitted-unsupported' }> {
    return this.#sendText(target, text, options.strictAck === true, options.isActive, options.replyToMessageId, options.accessEpoch)
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
  #bindInbound(target: QqBridgeTarget, messageId: string | null): void {
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
  }

  #hasBoundInbound(target: QqBridgeTarget, messageId: string): boolean {
    if (target.kind !== 'private') return false
    return this.#boundInbound.get(target.userId)?.has(messageId) === true
  }

  #consumeBoundInbound(target: QqBridgeTarget, messageId: string): void {
    if (target.kind !== 'private') return
    this.#boundInbound.get(target.userId)?.delete(messageId)
  }

  /**
   * 准入快照的键：**会话 + 平台消息 id**。
   *
   * 平台消息 id 只在单个会话内唯一（两个会话各自收到的第 7004 条不是同一条消息），
   * 所以键里必须带会话，否则后写的会覆盖先写的，出站就会拿错代次。
   */
  #inboundKeyOf(sessionId: string, messageId: string | null): string | null {
    if (sessionId === '' || messageId === null || messageId === '') return null
    return `${sessionId}\u0000msg_qq_${messageId}`
  }

  /** 授权代次与准入名单用的对象键：私聊按人、群聊按群。 */
  #peerKeyOf(target: QqBridgeTarget): string {
    return target.kind === 'private' ? `private:${target.userId}` : `group:${target.groupId}`
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
    // H1a：暂停即结束这一轮重连压力。不重置的话，用户手动暂停再连接会从上次
    // 退避到的 15 秒甚至熔断状态开始，看起来像「点了连接没反应」。
    this.#attempts = 0
    this.#ackAmbiguous = false
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
    // 永不熔断，只降频。
    // 原来的写法是 `if (attempts > 20) return`——彻底停止。SnowLuma 不是常开服务，
    // 于是「凌晨没开 → 熔断 → 下午起来了也不会自己连」成了必然复现的死局，
    // 用户看到的是「发消息没回」，日志里却只有一条 01:27 的熔断记录。
    // 现在：前 20 次按指数退避（上限 30s），之后固定 5 分钟探测一次，直到连上或停用。
    if (this.#attempts === RECONNECT_FAST_LIMIT + 1) {
      this.#deps.logger.warn('[psyche][qq] 连续失败达到上限，转入慢速重连（每 5 分钟一次）', {
        attempts: this.#attempts,
      })
    }
    const generation = this.#generation
    const fast = this.#attempts <= RECONNECT_FAST_LIMIT
    const min = this.#config.reconnectMs ?? 1000
    const base = fast
      ? Math.min(RECONNECT_FAST_CEILING_MS, min * 2 ** Math.min(10, Math.max(0, this.#attempts - 1)))
      : RECONNECT_SLOW_CEILING_MS
    const delay = base + Math.floor(base * 0.2 * Math.random())
    const timer = (this.#deps.setTimeout ?? setTimeout)(() => {
      if (!this.#isActive(generation)) return
      this.#reconnectTimer = null
      this.#lastAttemptAt = new Date().toISOString()
      this.#nextAttemptAt = null
      this.#connect()
    }, delay)
    this.#reconnectTimer = timer
    this.#nextAttemptAt = new Date(Date.now() + delay).toISOString()
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
    const allow = this.#effectiveAllow()
    return allow.valid && allow.ids.has(userId)
  }

  /**
   * Q1：控制中心改完访问控制后调用这里，让下一条消息就用新名单。
   *
   * 为什么不在调用点直接改 `#allow`：`#allow` 是启动时按宿主配置解析出来的基线，
   * 保留它才能在「恢复宿主配置」时退回去。覆盖值单独放，读的时候按优先级取。
   *
   * @param access 覆盖值；传 null 表示撤销覆盖、回到宿主配置。
   */
  applyAccess(access: { owner: string; extra: string[]; groups?: string[] } | null): void {
    // 迁移 37 第一阶段：先记「打算涨到几代」。失败就抛，本轮变更不生效。
    const planned = this.#planAccessChange(access)
    if (planned.size > 0 && this.#deps.accessEpochStore?.begin !== undefined) {
      try {
        this.#deps.accessEpochStore.begin(planned)
      } catch (error) {
        this.#deps.logger.error('[psyche][qq] 授权变更未能先落盘，本次配置不生效', {
          message: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }
    this.#applyAccessAfterBegin(access, planned)
  }

  /**
   * 第二批：控制中心保存「允许回复时段」后调用这里。
   *
   * 只换内存里的规则表，不写文件——文件由覆盖层自己按 revision 原子替换。
   * 传空对象表示所有对象都回到「继承」。
   */
  applyReplySchedules(schedules: QqReplySchedules): void {
    this.#replySchedules = { ...schedules }
    this.#deps.logger.info('[psyche][qq] 允许回复时段已更新', {
      objects: Object.keys(schedules).length,
    })
  }

  /** 第二批：某个对象此刻是否落在允许回复的时段里。没有规则即继承（放行）。 */
  #inReplyWindowFor(target: { kind: 'private'; userId: string } | { kind: 'group'; groupId: string }, at: Date = new Date()): boolean {
    const key = target.kind === 'private' ? `private:${target.userId}` : `group:${target.groupId}`
    return inReplyWindow(this.#replySchedules[key], at)
  }

  /**
   * 第 56 轮 P1-B：私聊下一次允许发送的时刻。
   *
   * 三种结果，调用方必须分开处理（第 9 轮评审第 2 条）：
   * - `null`：现在就在窗内（没有规则也算在窗内）——可以直接发。
   * - `Date`：窗外，但八天内算得出下一个窗口——延后到那一刻。
   * - `'paused'`：规则暂停，或八天内都没有窗口——**保持等待**，显示「暂无」，
   *   既不能发也不能判死。
   */
  nextPrivateSendAt(userId: string, at: Date = new Date()): Date | null | 'paused' {
    // 第 57 轮 P1-D：覆盖层不可信时，私聊计划一律按「暂停」处理——配置坏了不能当成
    // 「没设过时段」而放行，那等于让主人设的暂停悄悄失效。
    if (this.#configUntrusted !== null) return 'paused'
    const rule = this.#replySchedules[`private:${userId}`]
    if (rule === undefined) return null
    if (inReplyWindow(rule, at)) return null
    const next = nextAllowedReplyAt(rule, at)
    return next === null ? 'paused' : next
  }

  /**
   * 第 57 轮 P1-D：标记「覆盖层不可信」。
   *
   * 覆盖文件整份校验失败时，我们无法可靠知道哪些对象原本允许回复、哪些被暂停，
   * 所以全部依赖它的 QQ 收发路径都要暂停（入站不回复、出站返回 `config-corrupt`、
   * 队列保持等待），而不是退回宿主旧名单继续发。
   */
  markConfigUntrusted(reason: string): void {
    const changed = this.#configUntrusted !== reason
    this.#configUntrusted = reason
    if (changed) this.#deps.logger.warn('[psyche][qq] 覆盖配置不可信，QQ 收发已暂停', { reason })
  }

  /** 覆盖层重新完整生效后解除暂停。 */
  markConfigTrusted(): void {
    if (this.#configUntrusted === null) return
    this.#configUntrusted = null
    this.#deps.logger.info('[psyche][qq] 覆盖配置已恢复，QQ 收发解除暂停')
  }

  /**
   * 第 20 轮：同步路径在「决定允不允许发」之前强制查一次配置。
   *
   * 队列发送前的复核是同步的，来不及走异步重读；这里给一个同步入口，正常走 1 秒节流，
   * `force` 供测试或恢复路径要求「立刻读」。返回当前是否可信。
   */
  recheckConfigNow(force = false): boolean {
    return this.#ensureConfigTrust(force)
  }

  /** 供页面/诊断读取当前的信任状态。 */
  configTrust(): { trusted: boolean; reason: string | null } {
    return { trusted: this.#configUntrusted === null, reason: this.#configUntrusted }
  }

  /** 注入「重读覆盖层」的回调：暂停期间每次收发都会尝试恢复（带节流）。 */
  setConfigRecheck(recheck: (() => boolean) | null): void {
    this.#configRecheck = recheck
  }

  /**
   * 配置可信检查：**无论当前是否可信**都按节流重读一次。
   *
   * 第 19 轮评审：文件可能在我们「认为是好的」这段时间里被改坏，而桥还缓存着旧的
   * 允许决定。所以不能只在不可信时才查——每次入站/出站都查（1 秒一次），
   * 坏了立刻暂停，好着就什么都不做（不重新应用配置，避免无谓的授权代次抖动）。
   */
  #ensureConfigTrust(force = false): boolean {
    const recheck = this.#configRecheck
    if (recheck === null) return this.#configUntrusted === null
    const now = Date.now()
    if (!force && now - this.#configCheckAt < CONFIG_RECHECK_MS) return this.#configUntrusted === null
    this.#configCheckAt = now
    try {
      recheck()
    } catch {
      this.#configUntrusted = this.#configUntrusted ?? 'config-check-failed'
    }
    return this.#configUntrusted === null
  }

  /**
   * 第二批：时段外仍然采集。
   *
   * 没有独立入口（或消息没有可用 id）时返回 false，调用方据此如实记「只记录未采集」——
   * 不拿诊断记录冒充记忆。采集失败也只 warn：宁可少一条记忆，也不要因为采集炸掉整条入站。
   */
  async #captureOutsideWindow(userId: string, messageId: string | null, text: string): Promise<boolean> {
    // 宿主自己关掉自动采集时，时段外这条路径也不能偷偷写记忆：
    // 「采集关闭时不写 Source」是这批的冻结条件，不是靠 sink 内部兜底的。
    if (this.#deps.captureEnabled !== true) return false
    const sink = this.#deps.ingestPrivateMessage
    if (sink === undefined || messageId === null || messageId === '') return false
    try {
      const result = await sink({ stableUserId: userId, messageId, text, at: new Date().toISOString() })
      return result !== null
    } catch (error) {
      this.#deps.logger.warn('[psyche][qq] 时段外采集失败（未确认持久化）', {
        code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'PRIVATE_INTAKE_FAILED',
      })
      return false
    }
  }

  /**
   * 迁移 37：只做第一阶段（把「打算涨到几代」落盘），不动内存名单。
   *
   * 控制中心要用它把顺序排成「先记意图 → 写覆盖文件 → 再真正生效」：
   * 记意图失败时覆盖文件必须还是旧的，否则文件改了却没人记得这次变更没走完。
   * 返回受影响的 peer 列表，供失败时提示。
   */
  beginAccessChange(access: { owner: string; extra: string[] } | null): string[] {
    const planned = this.#planAccessChange(access)
    if (planned.size > 0 && this.#deps.accessEpochStore?.begin !== undefined) {
      this.#deps.accessEpochStore.begin(planned)
    }
    return [...planned.keys()]
  }

  /**
   * 迁移 37 恢复入口：把「名单内容没变、但变更没走完」的对象重新走一遍完整流程。
   *
   * 为什么不能只清 pending：覆盖文件可能已经重新允许了 B、库里还停在第 7 代，
   * 这时单清标记会让持有第 7 代的旧任务重新获得发送资格。所以这里一定换代，
   * 而且新代次必须同时大于「已提交值」和「当初打算涨到的值」——后者可能比前者高，
   * 因为它正是崩溃那一刻的目标。
   */
  reapplyAccess(): { ok: boolean; peers: string[] } {
    const peers = [...this.#pendingPeers]
    if (peers.length === 0) return { ok: true, peers: [] }
    let targets: Map<string, number>
    try {
      const stored = this.#deps.accessEpochStore?.loadPending?.() ?? new Map<string, number>()
      targets = new Map<string, number>()
      for (const key of peers) {
        const current = this.#accessEpochOf(key)
        const wanted = stored.get(key) ?? current
        targets.set(key, Math.max(current, wanted) + 1)
      }
    } catch (error) {
      this.#deps.logger.error('[psyche][qq] 恢复授权失败：读不到未完成的变更', {
        message: error instanceof Error ? error.message : String(error),
      })
      return { ok: false, peers }
    }
    try {
      this.#deps.accessEpochStore?.begin?.(targets)
    } catch (error) {
      this.#deps.logger.error('[psyche][qq] 恢复授权失败：第一阶段落盘失败', {
        message: error instanceof Error ? error.message : String(error),
      })
      return { ok: false, peers }
    }
    // 评审第 42 轮：解除暂停必须落在 commit 成功之后。begin 到 commit 返回之间，
    // 受影响对象一律保持暂停——否则「落库还没成功」的那一段就成了可发送的窗口。
    for (const [key, epoch] of targets) this.#accessEpochs.set(key, epoch)
    try {
      this.#deps.accessEpochStore?.commit?.(targets)
    } catch (error) {
      // 提交失败：内存虽然已经换代，但这次恢复不算完成，继续暂停。
      this.#deps.logger.error('[psyche][qq] 恢复授权失败：代次提交失败', {
        message: error instanceof Error ? error.message : String(error),
      })
      return { ok: false, peers: [...targets.keys()] }
    }
    for (const key of targets.keys()) this.#pendingPeers.delete(key)
    this.#deps.logger.info('[psyche][qq] 授权已恢复，暂停解除', { peers: [...targets.keys()] })
    return { ok: true, peers: [...targets.keys()] }
  }

  /** 迁移 37：算出这次变更会让哪些 peer 的「能不能发」翻转，以及它们该涨到几代。 */
  #planAccessChange(access: { owner: string; extra: string[] } | null): Map<string, number> {
    const before = this.#allowedPeers()
    const probe = access === null ? null : { owner: access.owner, extra: [...access.extra] }
    const savedOverride = this.#accessOverride
    this.#accessOverride = probe
    const after = this.#allowedPeers()
    this.#accessOverride = savedOverride
    const planned = new Map<string, number>()
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      if ((before.get(key) ?? false) === (after.get(key) ?? false)) continue
      planned.set(key, this.#accessEpochOf(key) + 1)
    }
    return planned
  }

  /** 迁移 37：第一阶段之后真正生效（改内存 + 提交代次 + 解除暂停）。 */
  #applyAccessAfterBegin(
    access: { owner: string; extra: string[]; groups?: string[] } | null,
    planned: ReadonlyMap<string, number>,
  ): void {
    const before = this.#allowedPeers()
    this.#accessOverride = access === null ? null : { owner: access.owner, extra: [...access.extra], groups: [...(access.groups ?? [])] } as { owner: string; extra: string[]; groups?: string[] }
    const after = this.#allowedPeers()
    let bumped = 0
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      if ((before.get(key) ?? false) === (after.get(key) ?? false)) continue
      this.#accessEpochs.set(key, this.#accessEpochOf(key) + 1)
      // 变更已走完完整流程，这个对象不再处于「未确认」状态。
      this.#pendingPeers.delete(key)
      bumped += 1
    }
    const effective = this.#effectiveAllow()
    this.#deps.logger.info('[psyche][qq] 私聊白名单已更新', {
      source: access === null ? 'host' : 'overlay',
      valid: effective.valid,
      extraCount: access?.extra.length ?? 0,
      bumpedPeers: bumped,
    })
    // 迁移 36/37 第三阶段：提交代次并清 pending。两者必须在同一事务里——
    // 「代次写了、pending 没删」会误伤（下次重启继续暂停），
    // 「pending 删了、代次没写」直接回到放行组合。
    // 失败不阻断本次配置生效（内存已换过），但要把这些对象标成暂停：
    // 库与内存不一致时，宁可停下来等人重新授权。
    if (bumped > 0 && this.#deps.accessEpochStore !== undefined) {
      const store = this.#deps.accessEpochStore
      try {
        if (store.commit !== undefined) store.commit(this.#accessEpochs)
        else store.save(this.#accessEpochs)
      } catch (error) {
        for (const key of planned.keys()) this.#pendingPeers.add(key)
        this.#deps.logger.warn('[psyche][qq] 授权代次落库失败，相关对象暂停派遣', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  /**
   * 12a：取某个授权对象的当前代次。任务在开工时记下它，发送前再取一次比对。
   *
   * 群聊这里暂时也返回代次，哪怕现在群回复是关的——关闭是在准入处拦的，
   * 代次记账不该因为一个开关而缺一条路径。
   */
  /**
   * 当前传输层的标识。提醒入队要用它——worker 只处理 transportId 对得上的行
   * （`transport-mismatch` 那条判据），桥接没连上时返回空串，入队方应当据此拒绝。
   */
  get transportId(): string {
    return this.#transport?.id ?? ''
  }

  accessEpochOf(target: { kind: 'private'; userId: string } | { kind: 'group'; groupId: string }): number {
    return this.#accessEpochOf(target.kind === 'private' ? `private:${target.userId}` : `group:${target.groupId}`)
  }

  #accessEpochOf(key: string): number {
    return this.#accessEpochs.get(key) ?? 0
  }

  /** 当前「可发送」的对象集合；只看私聊对端，群聊的准入在别处。 */
  #allowedPeers(): Map<string, boolean> {
    const map = new Map<string, boolean>()
    const owner = this.#currentOwner()
    if (owner !== '') map.set(`private:${owner}`, true)
    for (const id of this.#currentExtra()) map.set(`private:${id}`, true)
    return map
  }

  /**
   * Q1：控制中心改完默认模型后调用这里。
   *
   * 已经建出来的 Agent 不会因此换模型（`agents.get` 命中就直接返回），
   * 新会话从下一次 `#ensureAgent` 开始使用新值——这与控制台页面的提示保持一致。
   */
  applyModelSelection(selection: { provider: string; model: string; reasoningEffort?: string } | null): void {
    this.#modelOverride = selection
    this.#deps.logger.info('[psyche][qq] 默认模型已更新', {
      source: selection === null ? 'host' : 'overlay',
      provider: selection?.provider ?? this.#config.provider,
      model: selection?.model ?? this.#config.model,
      reasoningEffort: selection?.reasoningEffort ?? '',
    })
  }

  /** 覆盖优先、否则回到宿主配置。 */
  #effectiveAllow(): QqAllowList {
    return this.#accessOverride === null ? this.#allow : parseQqAllowFrom(this.#accessOverride)
  }

  /** 当前生效的 owner（覆盖层优先）。 */
  #currentOwner(): string {
    return this.#accessOverride === null ? (this.#config.allowFrom?.owner ?? '') : this.#accessOverride.owner
  }

  /** 当前生效的 extra（覆盖层优先）。 */
  #currentExtra(): string[] {
    if (this.#accessOverride !== null) return [...this.#accessOverride.extra]
    return Array.isArray(this.#config.allowFrom?.extra) ? [...this.#config.allowFrom.extra] : []
  }

  /**
   * 当前生效的群白名单（覆盖层优先）。
   *
   * 第 50 轮外部评审 Q1 选 (a)：覆盖层只存群号，精细 RoomPolicy 仍归 `config.groups`。
   * 白名单管的是「这个群允许采集」，回复开关是另一件事——白名单群的默认策略
   * 一律 `reply.enabled = false`，所以放它进来只意味着能读，不意味着会说话。
   */
  #currentGroups(): string[] {
    if (this.#accessOverride !== null) return [...(this.#accessOverride.groups ?? [])]
    return Array.isArray(this.#config.allowFrom?.groups) ? [...this.#config.allowFrom.groups] : []
  }

  #effectiveModel(): { provider: string; model: string; reasoningEffort: string } {
    const override = this.#modelOverride
    if (override !== null && override.provider !== '' && override.model !== '') {
      return { provider: override.provider, model: override.model, reasoningEffort: override.reasoningEffort ?? '' }
    }
    return { provider: this.#config.provider, model: this.#config.model, reasoningEffort: '' }
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
    // 拒绝文案发给的本就是名单外的人，必须绕过 12a 的授权闸，否则这条回复永远发不出去。
    const result = await this.#sendText({ kind: 'private', userId }, QQ_REJECT_TEXT, false, undefined, undefined, undefined, true)
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
    // 第 57 轮 P1-D：覆盖层不可信时不进入任何一条入站路径（不回复、不建会话、不采集）。
    // 第 20/21 轮：这是放行决策点，强制校验一次（不等 1 秒节流），文件刚被改坏也要当场拦。
    if (!this.#ensureConfigTrust(true)) return
    const kind = event.message_type
    if (kind === 'group') {
      // 第 50 轮外部评审 Q1（选 a）：白名单群没有精细 policy 时用 `all_visible_messages`
      // 这个 GroupCaptureMode 字符串走 `groupMessageForCapture` 的简化分支——
      // 它只决定「采集哪些消息」，不产生 reply 概念，所以这里放进来 ≠ 会回复。
      // 精细 policy（`config.groups` 里已配好的）优先，两套不叠加。
      const groupId = event.group_id === undefined ? '' : String(event.group_id)
      const configured = groupRoomPolicies(this.#config.groups)
      const mode = resolveGroupCaptureMode(configured, groupId, this.#currentGroups(), this.#accessOverride !== null)
      const input = mode === null
        ? null
        : groupMessageForCapture(event, new Map([[groupId, mode]]), oneBotText(event, 20001), new Date().toISOString())
      const sink = this.#deps.ingestGroupMessage
      if (!input || !sink) {
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
    const sessionId = await this.#resolveSessionId(qqSessionIdFor(target))
    this.#sessions.set(sessionId, target)
    // 12a：在准入这一刻固定授权代次，供这条消息的回复在发送前比对。
    // P0-A：快照跟着**这条入站消息**走（键是「会话 + `msg_qq_<平台 id>`」），不再按 peer 键存——
    // 同一对象后来的入站不能覆盖前一跳的代次与引用目标；不同会话出现同一 id 也不互相覆盖。
    const platformMessageId = event.message_id === undefined ? null : String(event.message_id)
    const inboundKey = this.#inboundKeyOf(sessionId, platformMessageId)
    if (inboundKey !== null) {
      this.#admissions.delete(inboundKey)
      this.#admissions.set(inboundKey, {
        accessEpoch: this.accessEpochOf(target),
        quoteMessageId: platformMessageId,
        peerKey: this.#peerKeyOf(target),
      })
      while (this.#admissions.size > 256) {
        const oldest = this.#admissions.keys().next().value
        if (oldest === undefined) break
        this.#admissions.delete(oldest)
      }
    }
    // 第二批：时段外不生成回复，但采集决定照旧——这条消息必须真的进记忆。
    // 位置刻意放在名单/联系人/代次检查之后、announce 与排队之前：规则不授予任何权力，
    // 也不该让被名单拒绝的对象因为规则而多出痕迹。
    if (!this.#inReplyWindowFor(target)) {
      const messageId = event.message_id === undefined ? null : String(event.message_id)
      const captured = await this.#captureOutsideWindow(
        target.kind === 'private' ? target.userId : '',
        messageId,
        text,
      )
      this.#diagnostics.record({
        direction: 'in',
        target,
        result: 'accepted',
        errorCode: 'outside-reply-window',
        textLength: text.length,
        media: inbound.media,
      })
      this.#deps.logger.info(
        captured ? '[psyche][qq] 不在允许回复时段，已采集但不生成回复' : '[psyche][qq] 不在允许回复时段，只记录不生成回复',
        { sessionId, captured },
      )
      return
    }
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
        this.#bindInbound(target, event.message_id === undefined ? null : String(event.message_id))
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

  /**
   * 决定这条消息投给哪个会话。
   *
   * 正常情况就是 `qq-private-<uid>` / `qq-group-<gid>`。但那个会话可能被归档过——归档的
   * 会话在 `agent/pre-step` 直接被 Host 拒，桥接只会看到投递成功然后永远等不到回复，
   * 表现就是「消息发了没反应」。宿主把归档集合缓存在内存里，改 `workspace.json` 不生效，
   * 只能调 `workspace/unarchiveSession`。恢复失败时按用户要求换新会话，而不是原地等待。
   *
   * 换过的映射按进程记住，后续消息复用同一个新会话，不会每条都新开一个。
   */
  async #resolveSessionId(base: string): Promise<string> {
    const forced = this.#sessionOverrides.get(base)
    if (forced !== undefined) return forced
    if (this.#deps.unarchiveSession === undefined) return base
    try {
      await this.#deps.unarchiveSession(base)
      return base
    } catch (error) {
      this.#sessionGeneration += 1
      const fresh = `${base}-n${this.#sessionGeneration}`
      this.#sessionOverrides.set(base, fresh)
      this.#deps.logger.warn('[psyche][qq] 旧会话恢复失败，改用新会话', {
        base,
        fresh,
        error: String(error),
      })
      return fresh
    }
  }

  /**
   * 把会话挂进「QQ 聊天」工作区（失败只记日志，不影响投递）。
   *
   * 对已经存在、但早期创建时没有工作区归属的会话也走这一遍——这是历史会话
   * 从「未分组」搬回去的唯一入口。
   */
  async #attachWorkspace(sessionId: string, generation: number): Promise<void> {
    const attach = this.#deps.ensureSessionWorkspace
    if (attach === undefined) return
    try {
      await attach(sessionId)
    } catch (error) {
      this.#deps.logger.warn('[psyche][qq] 挂进工作区失败', { sessionId, error: String(error) })
    }
    if (!this.#isActive(generation)) return
  }

  async #ensureAgent(sessionId: string, target: QqBridgeTarget, generation: number): Promise<{ followup(message: unknown): void }> {
    const existing = this.#deps.host.agents?.get(sessionId)
    if (existing !== undefined) {
      await this.#attachWorkspace(sessionId, generation)
      return existing
    }
    const selection = this.#effectiveModel()
    // reasoningEffort 目前进不了 AgentOptions（宿主类型里没有这个字段），
    // 所以这里只透传 provider/model；effort 存在覆盖层里，由控制中心标注「已请求未验证」。
    const agentOptions = { provider: selection.provider, model: selection.model }
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
      await this.#attachWorkspace(sessionId, generation)
      return resumed.agent
    } catch (error) {
      if (!this.#isActive(generation)) throw error
      // 只有「宿主明确说这个会话不存在」才允许新建。resume 的忙、权限、
      // 选项不兼容这类错误如果也滑到 create，会在磁盘上多出一个半成品会话——
      // 它不在宿主的账目里，之后任何工作区操作都认不到它。
      if (!looksLikeMissingSession(error)) {
        this.#deps.logger.warn('[psyche][qq] 恢复会话失败且原因不是「不存在」，不新建会话', {
          sessionId,
          error: String(error),
        })
        throw error
      }
      resumeError = error
    }
    // 会话确实不存在。生产路径：按固定 id 走宿主正式创建路径（`workspace/create` +
    // `session/create`），会话从出生起就在宿主账目里，侧栏直接挂在「QQ 聊天」下。
    if (this.#deps.createSessionThroughControllers !== undefined) {
      return await this.#createThroughHost(sessionId, target, selection, resumeError, generation)
    }
    // GPT 第 1 轮第 1 条：生产路径不允许「悄悄回退 agents.create」——它造出来的会话
    // 不在宿主账目里。所以旧路径必须由调用方显式开一个独立入口（只有测试/一次性脚本会开）。
    if (this.#deps.allowLegacyAgentCreate !== true) {
      throw new Error(
        `不在宿主账目内创建会话 ${sessionId}：未注入 createSessionThroughControllers，`
        + '且没有显式允许旧版 agents.create 入口（测试/一次性脚本才该打开它）',
      )
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
      await this.#attachWorkspace(sessionId, generation)
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
      await this.#attachWorkspace(sessionId, generation)
      return retried.agent
    }
  }

  /**
   * 按固定 id 走宿主正式创建路径，再从 agents 服务取回刚建好的 Agent。
   *
   * 分支表（GPT 第 48–50 轮冻结）：新建报错、结果未知时**先按同一个 id 核对**有没有
   * 建出来；核对不到就停下报错，**不回退** `agents.create`——那会在宿主账目外留一个
   * 半成品会话，之后每条消息都投进「没有归属」的会话里，侧栏也永远显示未分组。
   */
  async #createThroughHost(
    sessionId: string,
    target: QqBridgeTarget,
    selection: { provider: string; model: string; reasoningEffort: string },
    resumeError: unknown,
    generation: number,
  ): Promise<{ followup(message: unknown): void }> {
    const create = this.#deps.createSessionThroughControllers!
    let createdId: string
    try {
      createdId = await create(sessionId)
    } catch (createError) {
      if (!this.#isActive(generation)) throw createError
      const raced = this.#deps.host.agents?.get(sessionId)
      if (raced !== undefined) {
        // 新建超时但会话其实已经落地：直接接着用，不重复创建。
        this.#deps.logger.warn('[psyche][qq] 新建会话报错但会话已经存在，直接继续', {
          sessionId,
          error: String(createError),
        })
        return raced
      }
      this.#deps.logger.error('[psyche][qq] 按指定 id 新建会话失败，需要人工核对', {
        sessionId,
        target: target.kind,
        resumeError: String(resumeError),
        createError: String(createError),
      })
      throw createError
    }
    if (!this.#isActive(generation)) throw new Error('QQ bridge lifecycle ended')
    if (createdId !== sessionId) {
      // `session/create` 只复用「没开始过回合」的命名空会话；否则它会另铸一个 id。
      // 那个会话不是 QQ 该投的地方，接着投等于把消息发丢，所以这里必须停。
      throw new Error(`宿主没有按指定 id 建会话（请求 ${sessionId}，返回 ${createdId}）`)
    }
    const agent = this.#deps.host.agents?.get(sessionId)
    if (agent === undefined) {
      throw new Error(`会话 ${sessionId} 已创建但 agents 服务里拿不到 Agent，暂不投递`)
    }
    this.#deps.logger.info('[psyche][qq] 已按指定 id 新建会话', { sessionId, target: target.kind })
    this.#applyModelSelection(sessionId, agent, selection)
    return agent
  }

  /**
   * 把 QQ 覆盖层里的 provider/model 补写进新建的 Agent。
   *
   * `session/create` 只接受 preset，不接受 agentOptions，走正式创建路径就丢了覆盖层
   * 指定的模型。`AgentModel.select` 往**这个会话**追加一条 `model/selection`，不会像
   * `session/selectModel` 那样把选择保存成宿主默认模型——后者会污染其他地方新建的会话。
   */
  #applyModelSelection(
    sessionId: string,
    agent: {
      model?: {
        current?(): { provider: string; model: string; reasoningEffort?: string } | undefined
        select?(selection: { provider: string; model: string; reasoningEffort?: string }): void
      }
    },
    selection: { provider: string; model: string; reasoningEffort: string },
  ): void {
    const model = agent.model
    if (model?.select === undefined) return
    const provider = selection.provider
    const name = selection.model
    // 没有覆盖层（或配置为空）时保持 preset 给的模型，不额外写选择事件。
    if (provider === '' || name === '') return
    try {
      const current = model.current?.()
      if (current !== undefined && current.provider === provider && current.model === name) return
      model.select({ provider, model: name })
      this.#deps.logger.info('[psyche][qq] 已把覆盖层模型写入新会话', { sessionId, provider, model: name })
    } catch (error) {
      // 写不进去只影响模型选择，不该把已经建好的会话和这条消息一起丢掉。
      this.#deps.logger.warn('[psyche][qq] 写入覆盖层模型失败，按预设模型继续', {
        sessionId,
        error: String(error),
      })
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

  /**
   * 一轮的执行边界：`turn/start` 开窗，`turn/end` 关窗；`user/message` 把入站绑进窗；
   * `assistant/message` 带着 `turn`，用 `(sessionId, turn)` 取回该轮的准入快照。
   *
   * 实测（`docs/audit/v2963-p0a-host-probe.md`）：`user/message` 的 `data` 就是 UserMessage
   * 本身，**没有 `turn`**；`turn` 只在 `turn/start`、`assistant/message`、`turn/end` 上。
   * 同一轮里还会出现 `source.kind === 'runtime-context'` 的第二条 `user/message`（宿主注入），
   * 所以只认「id 命中准入表」的那条，别按「窗内第一条 user/message」配对。
   */
  #onTurnStart(sessionId: string, turn: number): void {
    const open = this.#openTurns.get(sessionId) ?? new Set<number>()
    open.add(turn)
    this.#openTurns.set(sessionId, open)
  }

  #onTurnEnd(sessionId: string, turn: number): void {
    const open = this.#openTurns.get(sessionId)
    if (open !== undefined) {
      open.delete(turn)
      if (open.size === 0) this.#openTurns.delete(sessionId)
    }
    this.#turnInbounds.delete(`${sessionId}#${turn}`)
    // 轮次结束就丢掉绑定时扣下的那份快照：它只对这一轮有效。
    this.#turnAdmissions.delete(`${sessionId}#${turn}`)
    this.#ambiguousTurns.delete(`${sessionId}#${turn}`)
  }

  /**
   * 把该会话当前所有开放轮次标成「归属不明」。
   *
   * 用在两种情形：多个 turn 同时开放时来了已准入入站（不知道属于哪一轮），
   * 以及同一轮里挤进两条不同的已准入入站。标记后这些轮次的回复一律零发送——
   * 宁可少发一条，也不能让旧轮凭旧绑定带错代次发出去。
   */
  #markOpenTurnsAmbiguous(sessionId: string): void {
    const open = this.#openTurns.get(sessionId)
    if (open === undefined) return
    for (const turn of open) {
      const key = `${sessionId}#${turn}`
      this.#ambiguousTurns.add(key)
      // 已作废的轮次不再保留快照：即使后续判定路径被改动，也拿不到这份证据。
      this.#turnAdmissions.delete(key)
    }
  }

  #onUserMessage(sessionId: string, inboundId: string | null, sourceKind: string | null): void {
    // 只认 QQ 入站本身（`source.kind === 'user'`）。宿主注入的 runtime-context 即使带着
    // 一条已准入的 id，也不能当作绑定对象，更不能制造「归属不明」。
    if (sourceKind !== 'user') return
    if (inboundId === null) return
    const admission = this.#admissions.get(`${sessionId}\u0000${inboundId}`)
    if (admission === undefined) return
    // 绑定时核对 peer：准入快照必须属于这个会话对应的那个对象。绑定必须**同时**满足
    // 「目标还在」和「peerKey 一致」；缺一样都说明快照表与会话已经错位（键冲突、会话被
    // 复用、重连后 #sessions 被清空），这时绑定谁都是猜，整个会话的开放轮次一律作废。
    const target = this.#sessions.get(sessionId)
    if (target === undefined || admission.peerKey !== this.#peerKeyOf(target)) {
      this.#deps.logger.warn('[psyche][qq] 准入快照找不到对应会话或 peer 对不上，失败关闭', {
        sessionId,
        expected: target === undefined ? null : this.#peerKeyOf(target),
        actual: admission.peerKey,
      })
      this.#markOpenTurnsAmbiguous(sessionId)
      return
    }
    const open = this.#openTurns.get(sessionId)
    if (open === undefined || open.size === 0) return
    // 同时开着多个轮次：不按「最近」推断归属（第 40 轮裁定）。这些轮次都可能被误配，
    // 全部标为归属不明，而不是只丢掉这一条消息、让旧轮凭旧绑定继续发。
    if (open.size !== 1) {
      this.#markOpenTurnsAmbiguous(sessionId)
      return
    }
    const turn = open.values().next().value
    if (turn === undefined) return
    const key = `${sessionId}#${turn}`
    const bound = this.#turnInbounds.get(key)
    if (bound === undefined) {
      this.#turnInbounds.set(key, new Set([inboundId]))
      // 绑定成功时**把快照固定在这一轮**，不是出站时再回表查。
      // 否则同一个键（同会话同 id）后来被重新写入新快照，旧回复就会拿到新代次。
      this.#turnAdmissions.set(key, admission)
      return
    }
    // 同一条重复出现按幂等处理；两条不同的已准入 id 挤进同一轮 = 归属不明。
    if (bound.has(inboundId)) return
    bound.add(inboundId)
    this.#turnAdmissions.delete(key)
    this.#ambiguousTurns.add(key)
  }

  /** 取该轮绑定时固定的准入快照；未绑定、多条绑定（归属不明）、被标成归属不明都返回 null。 */
  #admissionForTurn(sessionId: string, turn: number): QqAdmission | null {
    const key = `${sessionId}#${turn}`
    if (this.#ambiguousTurns.has(key)) return null
    const bound = this.#turnInbounds.get(key)
    if (bound === undefined || bound.size !== 1) return null
    return this.#turnAdmissions.get(key) ?? null
  }

  #listenAgentReplies(): void {
    const generation = this.#generation
    const host = this.#deps.host
    if (typeof host.on !== 'function') return
    const off = host.on('session/event', (session: { id?: string }, event: { type?: string; data?: unknown; seq?: unknown }) => {
      if (!this.#isActive(generation)) return
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      const data = event.data as
        | {
            turn?: unknown
            message?: { id?: unknown; content?: unknown; interrupted?: unknown; source?: { kind?: unknown } }
            id?: unknown
            source?: { kind?: unknown }
          }
        | undefined
      const turn = typeof data?.turn === 'number' ? data.turn : null
      if (event.type === 'turn/start') {
        if (sessionId !== '' && turn !== null) this.#onTurnStart(sessionId, turn)
        return
      }
      if (event.type === 'user/message') {
        const id = typeof data?.id === 'string' ? data.id : typeof data?.message?.id === 'string' ? data.message.id : null
        const kind = typeof data?.source?.kind === 'string'
          ? data.source.kind
          : typeof data?.message?.source?.kind === 'string'
            ? data.message.source.kind
            : null
        if (sessionId !== '') this.#onUserMessage(sessionId, id, kind)
        return
      }
      if (event.type === 'turn/end') {
        if (sessionId !== '' && turn !== null) this.#onTurnEnd(sessionId, turn)
        return
      }
      if (event.type !== 'assistant/message') return
      const target = this.#sessions.get(sessionId)
      if (target === undefined) return
      const text = messageText(data?.message)
      if (text === null || text.trim().length === 0) return
      if (isPurePsycheToolMarkup(text)) {
        // R8：模型偶发把工具调用写成正文；纯标记不能当回复发出去，也不能静默改写。
        this.#deps.logger.warn('[psyche][qq] 助手回复只有工具标记，已丢弃', { sessionId })
        return
      }
      // P0-A：拿不到这一轮的准入快照就不发。宁可少发一条，也不把「旧生成的回复」
      // 配上「新准入的代次」送出门——那正是这条缺陷要挡的东西。
      const admission = turn === null ? null : this.#admissionForTurn(sessionId, turn)
      if (admission === null) {
        this.#deps.logger.warn('[psyche][qq] 回复找不到对应入站的准入快照，失败关闭', {
          sessionId,
          turn,
        })
        this.#diagnostics.record({
          direction: 'out',
          target,
          result: 'failed',
          errorCode: 'unresolved-inbound',
          textLength: text.length,
        })
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
        // 第二批：入队前先按当前时段筛一遍，别让一条注定发不出去的回复占着队列。
        // 真正发送前 worker 还会用同一函数再查一次（配置可能在排队期间变化）。
        if (!this.#inReplyWindowFor(target)) {
          this.#deps.logger.info('[psyche][qq] 回复生成后已超出允许时段，不入队', { sessionId })
          this.#diagnostics.record({
            direction: 'out',
            target,
            result: 'failed',
            errorCode: 'outside-reply-window',
            textLength: text.length,
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
            quoteMessageId: admission.quoteMessageId,
            // 12a：代次必须取「这条消息被准入时」的快照，不是现在这一刻的值。
            // 生成期间被撤销又重加之后，当前代次已经涨过一轮；此刻再取会把旧回复
            // 认成新代次的产物，检查形同虚设。
            accessEpoch: admission.accessEpoch,
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
      // 第二批：Transport 这条路不经过 `#sendText`，投递前同样要按当前时段复核一次。
      if (this.#transport !== null) {
        if (!this.#inReplyWindowFor(target)) {
          this.#deps.logger.info('[psyche][qq] 回复生成后已超出允许时段，不再发送', { sessionId })
          this.#diagnostics.record({
            direction: 'out',
            target,
            result: 'failed',
            errorCode: 'outside-reply-window',
            textLength: text.length,
          })
          return
        }
        void this.#transport.send(this.#transportTarget(target), {
          text,
          replyToMessageId: admission.quoteMessageId,
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
      void this.#sendText(target, text, false, undefined, admission.quoteMessageId, admission.accessEpoch)
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

  /**
   * 发一条文本；等待后端回执（超时标 unknown，不自动重发）。
   *
   * 12a：真正发出去之前**再查一次授权**。准入时查过，但一条回复可能等模型生成
   * 几十秒，这段时间里对端可能已被撤销。`accessEpoch` 是调用方在开工时记下的
   * 代次；给了就必须与当前一致，否则整条丢弃——这一条挡的是「撤销后又加回来」。
   */
  #sendText(
    target: QqBridgeTarget,
    text: string,
    strictAck = false,
    active?: () => boolean,
    replyToMessageId?: string | null,
    accessEpoch?: number,
    skipAccessGuard = false,
  ): Promise<{ ok: boolean; messageId?: string; error?: string; quote?: 'applied' | 'omitted-unbound' | 'omitted-unsupported' }> {
    if (this.#stopped) {
      const result = { ok: false, error: 'bridge-stopped' }
      this.#recordOutbound(target, text, result)
      return Promise.resolve(result)
    }
    // 第 57 轮 P1-D：覆盖层不可信时不发任何 QQ 消息（含群、含拒绝文案以外的所有出站）。
    // 第 20/21 轮：发送是最后一道放行决策，强制校验一次——文件在这一秒内被改坏也要拦住。
    if (!this.#ensureConfigTrust(true)) {
      this.#stats.sendErrors += 1
      const result = { ok: false as const, error: 'config-corrupt' }
      this.#recordOutbound(target, text, result)
      return Promise.resolve(result)
    }
    const peerKey = target.kind === 'private' ? `private:${target.userId}` : `group:${target.groupId}`
    // 迁移 37：这个对象上一次授权变更没走完，名单与代次可能来自两个时刻——
    // 无法判断手里这条回复还算不算合法，直接停下（等人重新授权一次）。
    if (!skipAccessGuard && this.#pendingPeers.has(peerKey)) {
      this.#stats.sendErrors += 1
      const result = { ok: false as const, error: 'access-pending' }
      this.#recordOutbound(target, text, result)
      return Promise.resolve(result)
    }
    // 只对「从入站消息长出来的回复」和「显式带代次的主动任务」做授权复核。
    // 审批通过后的主动派发走它自己的授权链路，不在这一层二次拦——否则会把
    // 一条已经审批过的消息永久卡死在这里。
    // P0-A：这里不再读「peer 最近一次准入」——代次必须由调用方从那条入站的快照里带进来。
    if (!skipAccessGuard && accessEpoch !== undefined) {
      if (target.kind === 'private' && !this.#isAllowed(target.userId)) {
        this.#stats.sendErrors += 1
        const result = { ok: false as const, error: 'access-revoked' }
        this.#recordOutbound(target, text, result)
        return Promise.resolve(result)
      }
      if (accessEpoch !== this.accessEpochOf(target)) {
        this.#stats.sendErrors += 1
        const result = { ok: false as const, error: 'access-superseded' }
        this.#recordOutbound(target, text, result)
        return Promise.resolve(result)
      }
    }
    // 第二批：贴近底层发送前用「当前时刻 + 最新配置」再判一次时段。
    // 一条回复可能等模型生成几十秒，期间可能已跨出允许时段；这里拦的是这个。
    if (!skipAccessGuard && !this.#inReplyWindowFor(target)) {
      this.#stats.sendErrors += 1
      const result = { ok: false as const, error: 'outside-reply-window' }
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
