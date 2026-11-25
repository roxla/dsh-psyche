// P4-A-3：QQ 只读管理页的数据层。
//
// 这一层只做三件事：把桥的只读快照变成可脱敏的面板载荷、把日志放进一个有界的
// 内存环形缓冲、在**写入缓冲之前**完成脱敏。它不发送、不写库、不改桥的准入或
// 限频逻辑；桥仍然只负责通道与协议。
//
// 设计冻结：`docs/design/p4-a-3-admin-page.md`。

export type QqAdminLevel = 'info' | 'warn' | 'error'

export type QqAdminConnection = 'connected' | 'degraded' | 'disconnected' | 'unknown'

/** 只留最近 200 条；FIFO 覆盖，`seq` 单调递增。 */
export const QQ_LOG_LIMIT = 200

export interface QqLogEntry {
  seq: number
  at: string
  level: QqAdminLevel
  message: string
}

/** 桥侧只读快照；仍含未脱敏的内部值，只在服务端使用。 */
export interface QqBridgeAdminSnapshot {
  running: boolean
  connection: QqAdminConnection
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
  reconnect: {
    attempts: number
    mode: 'idle' | 'fast' | 'slow'
    lastAttemptAt: string | null
    nextAttemptAt: string | null
  }
}

export interface QqAdminPayload {
  ok: true
  enabled: boolean
  /** 桥接启动失败的原因；`enabled: false` 且这里非空，说明是故障不是没开。 */
  startError?: string | null
  /** 启动失败累计次数。 */
  failedEpoch?: number
  connection: QqAdminConnection
  account: { uinMasked: string | null; nickname: string | null; online: boolean | null }
  allowFrom: {
    ownerConfigured: boolean
    ownerMasked: string | null
    extraCount: number
    extraMasked: string[]
    /** 群白名单条数；和私聊放在同一张对象列表里展示。 */
    groupsCount: number
    groupsMasked: string[]
  }
  counts: QqBridgeAdminSnapshot['counts']
  activity: {
    lastHeartbeatAt: string | null
    lastMessageAt: string | null
    lastSentAt: string | null
  }
  /**
   * 重连状态。用户问「SnowLuma 到底在不在跑」时，看这里：
   * `attempts > 0 && lastAttemptAt !== null` 就说明插件正在敲门，没连上，
   * 也就是网关没监听——不是插件坏了、也不是白名单拒了。
   */
  reconnect: {
    attempts: number
    mode: 'idle' | 'fast' | 'slow'
    lastAttemptAt: string | null
    nextAttemptAt: string | null
  }
  logs: QqLogEntry[]
}

const SECRET_PAIR =
  /((?:access[_-]?token|token|api[_-]?key|client[_-]?secret|secret|password|cookie|authorization)["']?\s*[:=]\s*["']?)(?!Bearer\b)([^\s,"'}&]+)/gi
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi
const URL_SECRET = /([?&](?:access_token|token|key|secret)=)[^&\s"'<>]+/gi
const LONG_NUMBER = /\b[1-9]\d{4,11}\b/g

/** QQ 号脱敏：保留前 3 位与末 2 位；太短的值整体打码。 */
export function maskQqId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (text === '') return null
  if (text.length <= 5) return '*'.repeat(text.length)
  return `${text.slice(0, 3)}****${text.slice(-2)}`
}

/**
 * 日志脱敏。发生在进入环形缓冲之前，而不是 UI 渲染时；因此缓冲里也不留原文。
 * 正常文本保持原样（不做宽泛的「看起来像密钥」猜测）。
 */
export function redactQqLog(message: string): string {
  let text = String(message)
  text = text.replace(BEARER, 'Bearer ***')
  text = text.replace(URL_SECRET, '$1***')
  text = text.replace(SECRET_PAIR, '$1***')
  text = text.replace(LONG_NUMBER, (digits) => maskQqId(digits) ?? digits)
  return text
}

/** 有界日志缓冲；清屏由客户端完成，服务端不提供删除接口。 */
export class QqLogBuffer {
  readonly #limit: number
  #seq = 0
  #entries: QqLogEntry[] = []

  constructor(limit: number = QQ_LOG_LIMIT) {
    this.#limit = Math.max(1, Math.floor(limit))
  }

  get size(): number {
    return this.#entries.length
  }

  push(level: QqAdminLevel, message: string, at: Date = new Date()): QqLogEntry {
    const entry: QqLogEntry = {
      seq: ++this.#seq,
      at: at.toISOString(),
      level,
      message: redactQqLog(message),
    }
    this.#entries.push(entry)
    if (this.#entries.length > this.#limit) this.#entries.splice(0, this.#entries.length - this.#limit)
    return entry
  }

  /** 返回副本；调用方不能借此改内部缓冲。 */
  snapshot(): QqLogEntry[] {
    return this.#entries.map((entry) => ({ ...entry }))
  }
}

/** 服务端把 logger 的一次调用折成一行，再进缓冲。 */
export function formatQqLogLine(message: string, detail?: Record<string, unknown>): string {
  if (detail === undefined || detail === null) return String(message)
  try {
    return `${message} ${JSON.stringify(detail)}`
  } catch {
    return String(message)
  }
}

export function buildQqAdminPayload(input: {
  enabled: boolean
  /**
   * 桥接最近一次的启动错误。
   *
   * `enabled: false` 有两种原因——配置没开（正常）和构造函数抛错（故障）。
   * 区分它们只需要这一个字段，但过去面板只有 `enabled`，
   * 于是「启动失败」被显示成「QQ 通道没有启用」，用户按「没开」去查配置，
   * 永远查不到真正的报错。
   */
  startError?: string | null
  /** 启动失败累计次数，用来判断是不是反复失败。 */
  failedEpoch?: number
  snapshot: QqBridgeAdminSnapshot | null
  logs: QqLogEntry[]
}): QqAdminPayload {
  const snapshot = input.snapshot
  if (!input.enabled || snapshot === null) {
    return {
      ok: true,
      enabled: false,
      startError: input.startError ?? null,
      failedEpoch: input.failedEpoch ?? 0,
      connection: 'unknown',
      account: { uinMasked: null, nickname: null, online: null },
      allowFrom: { ownerConfigured: false, ownerMasked: null, extraCount: 0, extraMasked: [], groupsCount: 0, groupsMasked: [] },
      counts: {
        received: 0,
        delivered: 0,
        sendErrors: 0,
        rejected: 0,
        rejectReplies: 0,
        rateLimitedDrops: 0,
        rejectSendErrors: 0,
        outOfScopeDrops: 0,
        contactSuppressed: 0,
      },
      activity: { lastHeartbeatAt: null, lastMessageAt: null, lastSentAt: null },
      reconnect: { attempts: 0, mode: 'idle', lastAttemptAt: null, nextAttemptAt: null },
      logs: input.logs.slice(),
    }
  }
  return {
    ok: true,
    enabled: true,
    connection: snapshot.connection,
    account: {
      uinMasked: maskQqId(snapshot.selfId),
      nickname: snapshot.nickname,
      online: snapshot.accountOnline,
    },
    allowFrom: {
      ownerConfigured: snapshot.allowFromOwner !== null && snapshot.allowFromOwner.trim() !== '',
      ownerMasked: maskQqId(snapshot.allowFromOwner),
      extraCount: snapshot.allowFromExtra.length,
      extraMasked: snapshot.allowFromExtra.map((id) => maskQqId(id) ?? '***'),
      groupsCount: snapshot.allowFromGroups.length,
      groupsMasked: snapshot.allowFromGroups.map((id) => maskQqId(id) ?? '***'),
    },
    counts: { ...snapshot.counts },
    activity: {
      lastHeartbeatAt: snapshot.lastHeartbeatAt,
      lastMessageAt: snapshot.lastMessageAt,
      lastSentAt: snapshot.lastSentAt,
    },
    reconnect: snapshot.reconnect,
    logs: input.logs.slice(),
  }
}
