// C-3b：从当前 Contact 的真实 QQ/private 控制 Source 派生同意；只读，不另建真值。
import type { Db } from './adapter.js'
import type { OutboundConsent } from './proactive-outbox.js'

export const CONSENT_GRANT_PREFIX = '同意心灵主动测试至 '
export const CONSENT_REVOKE_TEXT = '撤回心灵主动测试'
export const CONSENT_MAX_VALIDITY_MS = 24 * 60 * 60 * 1000

export interface ProactiveConsentReadResult {
  readonly consent: OutboundConsent | null
  readonly timezone: string | null
  readonly reason: 'granted' | 'revoked' | 'expired' | 'missing' | 'invalid-source' | 'invalid-command' | 'contact-not-found'
}

interface ConsentSource {
  source_id: string
  text: string
  captured_at: string
  session_ref: string | null
  quoted_source_refs: string
  metadata: string
  quarantined: number
}

/** 严格带时区的 ISO 时刻；拒绝 Date.parse 对非法日历日期的自动归一化。 */
function strictTime(value: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{3})?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!m) return null
  const local = Date.parse(`${m[1]}T${m[2]}Z`)
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 19) !== `${m[1]}T${m[2]}`) return null
  if (m[3] !== 'Z') {
    const hour = Number(m[3].slice(1, 3))
    const minute = Number(m[3].slice(4, 6))
    if (hour > 14 || minute > 59 || (hour === 14 && minute !== 0)) return null
  }
  const result = Date.parse(value)
  return Number.isFinite(result) ? result : null
}

export function isTrustedIanaTimezone(value: string): boolean {
  if (!/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(value)) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true } catch { return false }
}

export function parseConsentCommand(text: string, capturedAt: string):
  | { kind: 'grant'; expiresAt: string; timezone: string }
  | { kind: 'revoke' }
  | null {
  const value = text.trim()
  if (value === CONSENT_REVOKE_TEXT) return { kind: 'revoke' }
  const m = /^同意心灵主动测试至 (\S+)；时区 (\S+)$/.exec(value)
  if (!m || !isTrustedIanaTimezone(m[2])) return null
  const at = strictTime(capturedAt)
  const until = strictTime(m[1])
  if (at === null || until === null || until <= at || until - at > CONSENT_MAX_VALIDITY_MS) return null
  return { kind: 'grant', expiresAt: new Date(until).toISOString(), timezone: m[2] }
}

/**
 * 最新控制 Source 无效/隔离/过期也不回退旧授权。查询只定位当前 Contact，
 * 再核 Host Capture 的角色、Session、seq 与引用；无绑定和非本人来源不构成同意。
 * DB 异常向调用者返回明确失败，由发送侧按 reader_error 关闭权限。
 */
export function readProactiveConsent(db: Pick<Db, 'get'>, contactId: string, now: string): ProactiveConsentReadResult {
  const nowMs = strictTime(now)
  if (nowMs === null) throw new Error('Invalid consent clock')
  const contact = db.get<{ stable_user_id: string }>(
    `SELECT stable_user_id FROM contacts WHERE contact_id = ? AND persona_id = 'main' AND platform = 'qq'`, [contactId],
  )
  if (!contact) return { consent: null, timezone: null, reason: 'contact-not-found' }
  const source = db.get<ConsentSource>(
    `SELECT s.source_id, s.text, s.captured_at, s.session_ref, s.quoted_source_refs, s.metadata,
            CASE WHEN q.source_id IS NULL THEN 0 ELSE 1 END AS quarantined
       FROM sources s LEFT JOIN quarantined_sources q ON q.source_id = s.source_id
      WHERE s.persona_id = 'main' AND s.sender_contact_id = ?
        AND s.platform = 'qq' AND s.channel = 'private' AND s.origin = 'user' AND s.kind = 'message'
        AND (trim(s.text) LIKE '同意心灵主动测试%' OR trim(s.text) LIKE '撤回心灵主动测试%')
      ORDER BY s.captured_at DESC, s.rowid DESC LIMIT 1`, [contactId],
  )
  if (!source) return { consent: null, timezone: null, reason: 'missing' }
  let metadata: { dsh?: { sessionId?: unknown; seq?: unknown; role?: unknown } }
  let quoted: unknown
  try { metadata = JSON.parse(source.metadata); quoted = JSON.parse(source.quoted_source_refs) } catch {
    return { consent: null, timezone: null, reason: 'invalid-source' }
  }
  const expectedSession = `qq-private-${contact.stable_user_id}`
  const capturedMs = strictTime(source.captured_at)
  if (source.quarantined || source.session_ref !== expectedSession || metadata?.dsh?.sessionId !== expectedSession ||
      metadata.dsh.role !== 'user' || !Number.isSafeInteger(metadata.dsh.seq) || Number(metadata.dsh.seq) < 0 ||
      !Array.isArray(quoted) || quoted.length !== 0 || capturedMs === null || capturedMs > nowMs) {
    return { consent: null, timezone: null, reason: 'invalid-source' }
  }
  const command = parseConsentCommand(source.text, source.captured_at)
  if (!command) return { consent: null, timezone: null, reason: 'invalid-command' }
  if (command.kind === 'revoke') return {
    consent: { contactId, status: 'revoked', sourceId: source.source_id, revokedAt: source.captured_at }, timezone: null, reason: 'revoked',
  }
  const expired = Date.parse(command.expiresAt) <= nowMs
  return {
    consent: { contactId, status: expired ? 'expired' : 'granted', sourceId: source.source_id,
      grantedAt: source.captured_at, expiresAt: command.expiresAt },
    timezone: command.timezone,
    reason: expired ? 'expired' : 'granted',
  }
}
