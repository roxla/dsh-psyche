import { maskQqId } from './qq-admin.js'

/**
 * P4-B-5-1：QQ 运行诊断事件。
 *
 * 这是一条**有界内存诊断流**，不是业务消息记录：
 * - 不落库、不读 Source/Event、不回填历史；
 * - 只保留字段白名单里的内容，正文/CQ/媒体 URL/路径/完整身份在写入前就被丢弃；
 * - 进程重启即清空。
 */

export const QQ_DIAGNOSTIC_LIMIT = 200
export const QQ_DIAGNOSTIC_DEFAULT_PAGE = 50
export const QQ_DIAGNOSTIC_MAX_PAGE = 100

/**
 * P4-B-5-2：导出鉴权开关。
 *
 * 当前 Host 对 `/api/psyche/*` 没有可验证的管理员身份（P4-A-5 的 Host 级 PARTIAL），
 * 因此导出固定关闭：直接请求也必须返回 403 且不含任何事件/计数。
 * 这里不是配置项，也不接受前端携带的令牌；只有 Host 提供可信鉴权后才改成检测函数。
 */
export function canExportDiagnostics(): boolean {
  return false
}

export type QqDiagnosticResult =
  | 'accepted'
  | 'delivered'
  | 'rejected'
  | 'rate_limited'
  | 'out_of_scope'
  | 'deduplicated'
  | 'failed'
  | 'unknown'

export const QQ_DIAGNOSTIC_RESULTS: readonly QqDiagnosticResult[] = [
  'accepted', 'delivered', 'rejected', 'rate_limited', 'out_of_scope', 'deduplicated', 'failed', 'unknown',
]

export type QqDiagnosticQuote = 'applied' | 'omitted-unbound' | 'omitted-unsupported'

export type QqDiagnosticMediaType =
  | 'image' | 'mface' | 'face' | 'record' | 'video' | 'file' | 'forward'
  | 'json' | 'xml' | 'dice' | 'rps' | 'shake' | 'poke'

const MEDIA_TYPES: readonly QqDiagnosticMediaType[] = [
  'image', 'mface', 'face', 'record', 'video', 'file', 'forward', 'json', 'xml', 'dice', 'rps', 'shake', 'poke',
]

/** 只保留稳定原因码；未知值折叠为 other，绝不把自由文本带出。 */
const ERROR_CODES = new Set([
  'not-connected', 'timeout', 'bridge-stopped', 'empty-text', 'inactive-before-send',
  'send-exception', 'send-timeout', 'transport_offline_before_send', 'rate_limited',
  'unclassified_retryable',
  // 放行决策点引入的原因码。之前它们全被折叠成 other，面板上看不出「是被撤销了、
  // 撞了安静时段、配置坏了，还是这条回复根本找不到归属」——审计想要分辨的正是这些。
  'access-superseded', 'access-revoked', 'access-pending',
  'outside-reply-window', 'unresolved-inbound', 'config-corrupt',
  'other',
])

export interface QqDiagnosticEvent {
  seq: number
  at: string
  direction: 'in' | 'out'
  platform: 'qq'
  target: 'private' | 'group'
  contactRef: string | null
  roomRef: string | null
  result: QqDiagnosticResult
  errorCode: string | null
  quote: QqDiagnosticQuote | null
  media: Array<{ type: QqDiagnosticMediaType; count: number }>
  textLength: number
}

export interface QqDiagnosticInput {
  direction: 'in' | 'out'
  target: { kind: 'private'; userId: string } | { kind: 'group'; groupId: string }
  result: QqDiagnosticResult
  errorCode?: string | null
  quote?: QqDiagnosticQuote | null
  media?: Array<{ type: string; count: number }>
  textLength: number
  at?: Date
}

export interface QqDiagnosticFilter {
  limit: number
  before: number | null
  direction: 'in' | 'out' | null
  target: 'private' | 'group' | null
  results: QqDiagnosticResult[]
  contactRef: string | null
  roomRef: string | null
  from: number | null
  to: number | null
}

export interface QqDiagnosticPage {
  generatedAt: string
  items: QqDiagnosticEvent[]
  nextBefore: number | null
  matched: number
}

export type QqDiagnosticFilterParse =
  | { ok: true; filter: QqDiagnosticFilter }
  | { ok: false; message: string }

const ALLOWED_PARAMS = new Set(['limit', 'before', 'direction', 'target', 'result', 'contactRef', 'roomRef', 'from', 'to'])

function parseTime(value: string): number | null {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function single(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key)
  if (values.length === 0) return null
  if (values.length > 1) return null
  return values[0] ?? null
}

export function parseQqDiagnosticFilter(params: URLSearchParams): QqDiagnosticFilterParse {
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) return { ok: false, message: `不支持的筛选参数：${key}` }
  }
  for (const key of ALLOWED_PARAMS) {
    if (params.getAll(key).length > 1) return { ok: false, message: `${key} 不能重复` }
  }

  const limitRaw = single(params, 'limit')
  let limit = QQ_DIAGNOSTIC_DEFAULT_PAGE
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw)) return { ok: false, message: 'limit 必须是 1..100 的整数' }
    limit = Number(limitRaw)
    if (limit < 1 || limit > QQ_DIAGNOSTIC_MAX_PAGE) return { ok: false, message: 'limit 必须是 1..100 的整数' }
  }

  const beforeRaw = single(params, 'before')
  let before: number | null = null
  if (beforeRaw !== null) {
    if (!/^\d+$/.test(beforeRaw)) return { ok: false, message: 'before 必须是正整数' }
    before = Number(beforeRaw)
    if (before < 1) return { ok: false, message: 'before 必须是正整数' }
  }

  const directionRaw = single(params, 'direction')
  if (directionRaw !== null && directionRaw !== 'in' && directionRaw !== 'out') {
    return { ok: false, message: 'direction 只能是 in 或 out' }
  }
  const targetRaw = single(params, 'target')
  if (targetRaw !== null && targetRaw !== 'private' && targetRaw !== 'group') {
    return { ok: false, message: 'target 只能是 private 或 group' }
  }

  const results: QqDiagnosticResult[] = []
  const resultRaw = single(params, 'result')
  if (resultRaw !== null) {
    for (const part of resultRaw.split(',')) {
      const value = part.trim() as QqDiagnosticResult
      if (!QQ_DIAGNOSTIC_RESULTS.includes(value)) return { ok: false, message: 'result 含有未知结果' }
      if (!results.includes(value)) results.push(value)
    }
  }

  const refOf = (key: 'contactRef' | 'roomRef'): string | null => {
    const value = single(params, key)
    if (value === null) return null
    return value.length <= 32 ? value : null
  }
  const contactRef = refOf('contactRef')
  if (single(params, 'contactRef') !== null && contactRef === null) return { ok: false, message: 'contactRef 过长' }
  const roomRef = refOf('roomRef')
  if (single(params, 'roomRef') !== null && roomRef === null) return { ok: false, message: 'roomRef 过长' }

  const fromRaw = single(params, 'from')
  const toRaw = single(params, 'to')
  const from = fromRaw === null ? null : parseTime(fromRaw)
  if (fromRaw !== null && from === null) return { ok: false, message: 'from 不是合法时间' }
  const to = toRaw === null ? null : parseTime(toRaw)
  if (toRaw !== null && to === null) return { ok: false, message: 'to 不是合法时间' }
  if (from !== null && to !== null && from >= to) return { ok: false, message: 'from 必须早于 to' }

  return {
    ok: true,
    filter: {
      limit,
      before,
      direction: directionRaw === null ? null : (directionRaw as 'in' | 'out'),
      target: targetRaw === null ? null : (targetRaw as 'private' | 'group'),
      results,
      contactRef,
      roomRef,
      from,
      to,
    },
  }
}

function mediaOf(input: QqDiagnosticInput['media']): QqDiagnosticEvent['media'] {
  if (!Array.isArray(input)) return []
  const out: QqDiagnosticEvent['media'] = []
  for (const item of input.slice(0, 8)) {
    const type = typeof item?.type === 'string' ? item.type : ''
    const count = typeof item?.count === 'number' ? Math.floor(item.count) : 0
    if (!(MEDIA_TYPES as readonly string[]).includes(type) || count < 1 || count > 99) continue
    const found = out.find((entry) => entry.type === type)
    if (found) found.count = Math.min(99, found.count + count)
    else out.push({ type: type as QqDiagnosticMediaType, count })
  }
  return out
}

function refOf(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  return maskQqId(value)
}

export class QqDiagnostics {
  readonly #events: QqDiagnosticEvent[] = []
  #seq = 0

  record(input: QqDiagnosticInput): QqDiagnosticEvent {
    this.#seq += 1
    const target = input.target.kind === 'private'
      ? { target: 'private' as const, contactRef: refOf(input.target.userId), roomRef: null }
      : { target: 'group' as const, contactRef: null, roomRef: refOf(input.target.groupId) }
    const errorCode = typeof input.errorCode === 'string' && input.errorCode.length > 0
      ? (ERROR_CODES.has(input.errorCode) ? input.errorCode : 'other')
      : null
    const event: QqDiagnosticEvent = {
      seq: this.#seq,
      at: (input.at ?? new Date()).toISOString(),
      direction: input.direction,
      platform: 'qq',
      ...target,
      result: input.result,
      errorCode,
      quote: input.quote ?? null,
      media: mediaOf(input.media),
      textLength: Math.max(0, Math.min(10_000, Math.floor(input.textLength))),
    }
    this.#events.push(event)
    if (this.#events.length > QQ_DIAGNOSTIC_LIMIT) this.#events.shift()
    return event
  }

  query(filter: QqDiagnosticFilter): QqDiagnosticPage {
    const matched = this.#events.filter((event) => {
      if (filter.direction !== null && event.direction !== filter.direction) return false
      if (filter.target !== null && event.target !== filter.target) return false
      if (filter.results.length > 0 && !filter.results.includes(event.result)) return false
      if (filter.contactRef !== null && event.contactRef !== filter.contactRef) return false
      if (filter.roomRef !== null && event.roomRef !== filter.roomRef) return false
      const at = Date.parse(event.at)
      if (filter.from !== null && at < filter.from) return false
      if (filter.to !== null && at >= filter.to) return false
      return true
    })
    // matched 是过滤后的总数，不含分页游标；游标只影响 items/nextBefore。
    const ordered = matched
      .filter((event) => filter.before === null || event.seq < filter.before)
      .sort((left, right) => right.seq - left.seq)
    const items = ordered.slice(0, filter.limit)
    return {
      generatedAt: new Date().toISOString(),
      items,
      nextBefore: items.length > 0 ? items[items.length - 1]!.seq : null,
      matched: matched.length,
    }
  }

  get size(): number {
    return this.#events.length
  }
}
