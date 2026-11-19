// P3-C-1：主动联系的 Eligibility——纯函数，不读库、不读系统时钟、不调模型、不发送。
//
// 契约（docs/design/p3-c-proactive-contact.md §4）：
//   - 八项检查，每一项都有独立原因码；「等待」不等于「淘汰」。
//   - 通道离线只是等待，不是联系人不同意；冷却未到也不是身份无效。
//   - 时区按收件联系人 IANA 计算；没有可信时区返回 timezone-unknown，保守等待。
//   - Affinity / Trust / Mood 不参与资格判定，不能绕过同意或审批。
//   - 所有时间由调用方传入 now；C-1 只保证同输入同输出，不承诺跨重启 exactly-once。

import { invalid } from './errors.js'
import type { ProactiveTrigger } from './proactive-trigger.js'

export const PROACTIVE_ELIGIBILITY_VERSION = 1

export const DEFAULT_PER_CONTACT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_GLOBAL_DAILY_LIMIT = 3
export const DEFAULT_GLOBAL_WEEKLY_LIMIT = 10
export const DEFAULT_QUIET_START_HOUR = 9
export const DEFAULT_QUIET_END_HOUR = 22

export type ProactiveReasonCode =
  | 'contact-not-found'
  | 'channel-unavailable'
  | 'no-consent'
  | 'proactive-disabled'
  | 'cooldown'
  | 'contact-quota'
  | 'quota'
  | 'timezone-unknown'
  | 'quiet-hours'
  | 'duplicate-candidate'

export type ProactiveEligibilityStatus = 'eligible' | 'waiting' | 'rejected'

export interface ProactiveContactSnapshot {
  contactId: string
  personaId: string
  platform: string
  stableUserId: string
  timezone?: string
}

export interface ProactiveChannelSnapshot {
  platform: string
  kind: 'private'
  status: 'connected' | 'degraded' | 'disconnected' | 'unknown'
}

export interface ProactiveConsentSnapshot {
  status: 'granted' | 'revoked' | 'expired' | 'missing'
  expiresAt?: string
  source?: string
}

export interface ProactiveRelationshipSnapshot {
  affinity: number
  trust: 'unassessed' | 'low' | 'medium' | 'high'
}

export interface ProactiveUsageSnapshot {
  lastContactedAt?: string
  contactToday?: number
  globalToday?: number
  globalWeek?: number
}

export interface ProactivePolicySnapshot {
  proactiveEnabled: boolean
}

export interface ProactiveLimits {
  perContactCooldownMs?: number
  contactDailyLimit?: number
  globalDailyLimit?: number
  globalWeeklyLimit?: number
  quietStartHour?: number
  quietEndHour?: number
}

export interface EligibilityInput {
  contact: ProactiveContactSnapshot | null
  channel: ProactiveChannelSnapshot
  consent: ProactiveConsentSnapshot
  policy: ProactivePolicySnapshot
  trigger: ProactiveTrigger
  now: string
  usage: ProactiveUsageSnapshot
  limits?: ProactiveLimits
  relationship?: ProactiveRelationshipSnapshot
  duplicateCandidate?: boolean
}

export interface EligibilityResult {
  eligible: boolean
  status: ProactiveEligibilityStatus
  reasonCodes: ProactiveReasonCode[]
  retryAt?: string
}

const CHANNEL_STATUSES = new Set(['connected', 'degraded', 'disconnected', 'unknown'])
const CONSENT_STATUSES = new Set(['granted', 'revoked', 'expired', 'missing'])

function timeOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} 必须是非空 ISO 时间字符串`)
  const text = value.trim()
  if (!Number.isFinite(Date.parse(text))) throw invalid(`${field} 不是合法时间：${text}`)
  return text
}

function maybeTime(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return timeOf(value, field)
}

function countOf(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalid(`${field} 必须是非负有限数`)
  return Math.floor(value)
}

function limitOf(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalid('limits 必须是非负有限数')
  return Math.floor(value)
}

function hourOf(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 23) {
    throw invalid('安静时段小时必须是 0–23 的整数')
  }
  return Math.floor(value)
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} 必须是非空字符串`)
  return value.trim()
}

/** 取某个 IANA 时区下的本地小时/分钟；时区不可信返回 null（不猜、不退回 Owner 时区）。 */
export function localClockOf(iso: string, timeZone: string | undefined): { hour: number; minute: number } | null {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return null
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone.trim(),
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(iso))
    const hour = Number(parts.find((part) => part.type === 'hour')?.value)
    const minute = Number(parts.find((part) => part.type === 'minute')?.value)
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
    return { hour: hour % 24, minute }
  } catch {
    return null
  }
}

function nextWindowStart(iso: string, hour: number, minute: number, startHour: number): string {
  const delta = (((startHour - hour) * 60 - minute) % 1440 + 1440) % 1440 || 1440
  return new Date(Date.parse(iso) + delta * 60_000).toISOString()
}

/**
 * 判定一次主动联系是否具备资格。检查顺序固定，原因码按固定顺序累积，保证多原因时集合稳定。
 * 「等待」原因（通道、时区、冷却、额度、静默）不淘汰资格；「拒绝」原因（身份、同意、策略、重复）淘汰。
 */
export function evaluateProactiveEligibility(input: EligibilityInput): EligibilityResult {
  if (typeof input !== 'object' || input === null) throw invalid('eligibility 输入必须是对象')
  const now = timeOf(input.now, 'now')
  const reasons: ProactiveReasonCode[] = []
  let retryAt: string | undefined

  const contact = input.contact
  if (!contact) {
    reasons.push('contact-not-found')
  } else {
    requireText(contact.contactId, 'contact.contactId')
    requireText(contact.personaId, 'contact.personaId')
    requireText(contact.platform, 'contact.platform')
    requireText(contact.stableUserId, 'contact.stableUserId')
  }

  const channel = input.channel ?? invalid('channel 不能为空')
  if (!CHANNEL_STATUSES.has(channel.status)) throw invalid(`未知的通道状态：${String(channel.status)}`)
  if (channel.status !== 'connected') reasons.push('channel-unavailable')

  const consent = input.consent ?? invalid('consent 不能为空')
  if (!CONSENT_STATUSES.has(consent.status)) throw invalid(`未知的同意状态：${String(consent.status)}`)
  const consentExpiry = maybeTime(consent.expiresAt, 'consent.expiresAt')
  const consentValid =
    consent.status === 'granted' && (consentExpiry === undefined || Date.parse(consentExpiry) > Date.parse(now))
  if (!consentValid) reasons.push('no-consent')

  const policy = input.policy ?? invalid('policy 不能为空')
  if (policy.proactiveEnabled !== true) reasons.push('proactive-disabled')

  const limits = input.limits ?? {}
  const usage = input.usage ?? {}
  const cooldownMs = limitOf(limits.perContactCooldownMs, DEFAULT_PER_CONTACT_COOLDOWN_MS)
  const lastContacted = maybeTime(usage.lastContactedAt, 'usage.lastContactedAt')
  if (lastContacted !== undefined && Date.parse(now) < Date.parse(lastContacted) + cooldownMs) {
    reasons.push('cooldown')
    retryAt = new Date(Date.parse(lastContacted) + cooldownMs).toISOString()
  }

  const contactDailyLimit = limitOf(limits.contactDailyLimit, Number.POSITIVE_INFINITY)
  if (Number.isFinite(contactDailyLimit) && countOf(usage.contactToday, 'usage.contactToday') >= contactDailyLimit) {
    reasons.push('contact-quota')
  }

  const dailyLimit = limitOf(limits.globalDailyLimit, DEFAULT_GLOBAL_DAILY_LIMIT)
  const weeklyLimit = limitOf(limits.globalWeeklyLimit, DEFAULT_GLOBAL_WEEKLY_LIMIT)
  if (
    countOf(usage.globalToday, 'usage.globalToday') >= dailyLimit ||
    countOf(usage.globalWeek, 'usage.globalWeek') >= weeklyLimit
  ) {
    reasons.push('quota')
  }

  const quietStart = hourOf(limits.quietStartHour, DEFAULT_QUIET_START_HOUR)
  const quietEnd = hourOf(limits.quietEndHour, DEFAULT_QUIET_END_HOUR)
  const clock = contact ? localClockOf(now, contact.timezone) : null
  if (contact && clock === null) {
    reasons.push('timezone-unknown')
  } else if (contact && clock !== null) {
    const outside = clock.hour < quietStart || clock.hour >= quietEnd
    if (outside) {
      reasons.push('quiet-hours')
      if (retryAt === undefined) retryAt = nextWindowStart(now, clock.hour, clock.minute, quietStart)
    }
  }

  if (input.duplicateCandidate === true) reasons.push('duplicate-candidate')

  // Affinity / Trust 只用于候选排序，显式读取后再丢弃，避免被误当资格输入。
  if (input.relationship !== undefined) {
    if (typeof input.relationship.affinity !== 'number' || !Number.isFinite(input.relationship.affinity)) {
      throw invalid('relationship.affinity 必须是有限数')
    }
  }

  const rejected = reasons.some((code) =>
    code === 'contact-not-found' || code === 'no-consent' || code === 'proactive-disabled' || code === 'duplicate-candidate',
  )
  const status: ProactiveEligibilityStatus = rejected ? 'rejected' : reasons.length > 0 ? 'waiting' : 'eligible'
  const result: EligibilityResult = { eligible: reasons.length === 0, status, reasonCodes: reasons }
  if (retryAt !== undefined) result.retryAt = retryAt
  return result
}
