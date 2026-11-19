/**
 * P4-B-3：QQ 私聊联系人策略（B-3-1 纯模块）。
 *
 * 这里是 `qq.contacts` 的解析、判定与运行期滚动限频，不依赖 QQ Bridge / 数据库 / 宿主。
 * 三条硬语义（B-3-0 冻结）：
 * - 配置错误不得扩大权限：重复身份明确 deny，无法归属身份或整份配置非法时全局失败关闭；
 * - 策略在既有 `qq.allowFrom` 准入之后生效，不能替代准入；
 * - 额度在准入时原子占用，内存计数、重启清零，不宣称持久化限频。
 */

export const QQ_CONTACT_MAX_ENTRIES = 200
export const QQ_CONTACT_RATE_WINDOW_MS = 60 * 60 * 1000
export const QQ_CONTACT_MAX_PER_HOUR_LIMIT = 240

export const CONTACT_POLICY_REASONS = [
  'CONTACT_DISABLED',
  'CONTACT_SILENCE',
  'CONTACT_RATE_LIMIT',
  'CONTACT_POLICY_INVALID',
  'CONTACT_POLICY_UNAVAILABLE',
] as const

export type ContactPolicyReason = (typeof CONTACT_POLICY_REASONS)[number]

export interface QqSilenceWindow {
  /** 当天分钟数，[start,end)。 */
  start: number
  end: number
}

export interface QqContactPolicy {
  platform: 'qq'
  stableUserId: string
  enabled: boolean
  silence?: {
    timezone: string
    windows: QqSilenceWindow[]
  }
  maxPerHour?: number
}

export type QqContactPolicyIndex =
  | {
      kind: 'ok'
      /** 合法且应生效的策略。 */
      entries: Map<string, QqContactPolicy>
      /** 明确拒绝的身份（重复、字段非法等），与“没有配置”不同。 */
      denied: Map<string, ContactPolicyReason>
    }
  | {
      kind: 'blocked'
      reason: string
    }

export type QqContactDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: ContactPolicyReason }

const ALLOWED_FIELDS = new Set(['platform', 'stableUserId', 'enabled', 'silence', 'maxPerHour'])
const WINDOW_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/
const ID_RE = /^[1-9]\d{0,19}$/

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 与 allowFrom 相同的身份格式；这里不走 trim，避免把两个不同字符串折叠成同一联系人。 */
export function isQqContactId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value)
}

function isValidTimezone(value: string): boolean {
  if (value.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0))
    return true
  } catch {
    return false
  }
}

function parseSilence(value: unknown): { timezone: string; windows: QqSilenceWindow[] } | null {
  const record = asRecord(value)
  if (!record) return null
  const keys = Object.keys(record)
  if (keys.some((key) => key !== 'timezone' && key !== 'windows')) return null
  const timezone = record.timezone
  if (typeof timezone !== 'string' || !isValidTimezone(timezone)) return null
  const windows = record.windows
  if (!Array.isArray(windows) || windows.length < 1 || windows.length > 6) return null
  const parsed: QqSilenceWindow[] = []
  for (const raw of windows) {
    if (typeof raw !== 'string') return null
    const match = WINDOW_RE.exec(raw)
    if (!match) return null
    const start = Number(match[1]) * 60 + Number(match[2])
    const end = Number(match[3]) * 60 + Number(match[4])
    if (start === end) return null
    parsed.push({ start, end })
  }
  return { timezone, windows: parsed }
}

function parseEntry(record: Record<string, unknown>, id: string): QqContactPolicy | ContactPolicyReason {
  if (Object.keys(record).some((key) => !ALLOWED_FIELDS.has(key))) return 'CONTACT_POLICY_INVALID'
  const platform = record.platform
  if (platform !== undefined && platform !== 'qq') return 'CONTACT_POLICY_INVALID'
  const enabled = record.enabled
  if (enabled !== undefined && typeof enabled !== 'boolean') return 'CONTACT_POLICY_INVALID'
  const maxPerHour = record.maxPerHour
  if (
    maxPerHour !== undefined &&
    (typeof maxPerHour !== 'number' ||
      !Number.isInteger(maxPerHour) ||
      maxPerHour < 1 ||
      maxPerHour > QQ_CONTACT_MAX_PER_HOUR_LIMIT)
  ) {
    return 'CONTACT_POLICY_INVALID'
  }
  let silence: QqContactPolicy['silence']
  if (record.silence !== undefined) {
    const parsed = parseSilence(record.silence)
    if (!parsed) return 'CONTACT_POLICY_INVALID'
    silence = parsed
  }
  return {
    platform: 'qq',
    stableUserId: id,
    enabled: enabled ?? true,
    ...(silence ? { silence } : {}),
    ...(maxPerHour !== undefined ? { maxPerHour } : {}),
  }
}

/**
 * 解析 `qq.contacts`。返回只读索引：
 * - `blocked`：整份配置不可归属/形状非法，调用方必须让 QQ 私聊在准入后失败关闭；
 * - `denied`：某个身份有明确拒绝结果，不能当作“没有配置”而回退默认允许。
 */
export function parseQqContactPolicies(raw: unknown): QqContactPolicyIndex {
  if (raw === undefined) return { kind: 'ok', entries: new Map(), denied: new Map() }
  if (!Array.isArray(raw)) return { kind: 'blocked', reason: 'not-array' }
  if (raw.length > QQ_CONTACT_MAX_ENTRIES) return { kind: 'blocked', reason: 'too-many' }

  const records: Array<{ id: string; record: Record<string, unknown> }> = []
  const counts = new Map<string, number>()
  for (const item of raw) {
    const record = asRecord(item)
    if (!record) return { kind: 'blocked', reason: 'invalid-entry' }
    const id = record.stableUserId
    if (!isQqContactId(id)) return { kind: 'blocked', reason: 'invalid-identity' }
    records.push({ id, record })
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  const entries = new Map<string, QqContactPolicy>()
  const denied = new Map<string, ContactPolicyReason>()
  for (const { id, record } of records) {
    if ((counts.get(id) ?? 0) > 1) {
      denied.set(id, 'CONTACT_POLICY_INVALID')
      continue
    }
    const parsed = parseEntry(record, id)
    if (typeof parsed === 'string') denied.set(id, parsed)
    else entries.set(id, parsed)
  }
  return { kind: 'ok', entries, denied }
}

/** 当前时刻在指定 IANA 时区的分钟数；DST 由 Intl 按实际本地时间计算。 */
export function localMinuteOfDay(now: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(now))
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0')
  return hour * 60 + minute
}

export function inSilenceWindow(
  windows: readonly QqSilenceWindow[],
  minute: number,
): boolean {
  return windows.some(({ start, end }) =>
    start < end ? minute >= start && minute < end : minute >= start || minute < end,
  )
}

/**
 * 每 Contact 的滚动 60 分钟额度。JS 单线程内 reserve 是原子的：
 * 并发到达的最后一条只能有一个成功。
 */
export class ContactRateLimiter {
  readonly #sent = new Map<string, number[]>()

  reserve(id: string, maxPerHour: number, now: number): boolean {
    const cutoff = now - QQ_CONTACT_RATE_WINDOW_MS
    const recent = (this.#sent.get(id) ?? []).filter((at) => at > cutoff)
    if (recent.length >= maxPerHour) {
      this.#sent.set(id, recent)
      return false
    }
    recent.push(now)
    this.#sent.set(id, recent)
    return true
  }

  count(id: string, now: number): number {
    const cutoff = now - QQ_CONTACT_RATE_WINDOW_MS
    return (this.#sent.get(id) ?? []).filter((at) => at > cutoff).length
  }

  clear(): void {
    this.#sent.clear()
  }
}

/**
 * 判定一条已通过准入的私聊消息。槽位只在真正放行时占用；
 * 调用方应在 announce/ensureAgent 之前调用一次。
 */
export function decideQqContact(
  index: QqContactPolicyIndex,
  stableUserId: string,
  now: number,
  limiter: ContactRateLimiter,
): QqContactDecision {
  if (index.kind === 'blocked') return { action: 'deny', reason: 'CONTACT_POLICY_UNAVAILABLE' }
  const denied = index.denied.get(stableUserId)
  if (denied) return { action: 'deny', reason: denied }
  const policy = index.entries.get(stableUserId)
  if (!policy) return { action: 'allow' }
  if (!policy.enabled) return { action: 'deny', reason: 'CONTACT_DISABLED' }
  if (policy.silence) {
    const minute = localMinuteOfDay(now, policy.silence.timezone)
    if (inSilenceWindow(policy.silence.windows, minute)) {
      return { action: 'deny', reason: 'CONTACT_SILENCE' }
    }
  }
  if (policy.maxPerHour !== undefined && !limiter.reserve(stableUserId, policy.maxPerHour, now)) {
    return { action: 'deny', reason: 'CONTACT_RATE_LIMIT' }
  }
  return { action: 'allow' }
}
