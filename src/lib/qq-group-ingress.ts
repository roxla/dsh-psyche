// D-1：只校验群采集白名单与协议字段；不唤醒 Agent，不做参与调度。
import { groupPartsText, type GroupPart, type RoomPolicy, type GroupCaptureMode, type GroupMessageInput } from 'dsh-psyche-core'
export { groupRoomPolicies } from 'dsh-psyche-core'
import { toIdentityClaim } from 'dsh-psyche-qq'

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const id = (value: unknown): string | null => {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null
  return (typeof value === 'string' || typeof value === 'number') && /^[1-9][0-9]{0,19}$/.test(String(value)) ? String(value) : null
}
const messageId = (value: unknown): string | null => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null
  return (typeof value === 'string' || typeof value === 'number') && /^[A-Za-z0-9_:-]{1,120}$/.test(String(value)) ? String(value) : null
}

export function groupCapturePolicies(value: unknown): ReadonlyMap<string, GroupCaptureMode> {
  const config = object(value)
  const result = new Map<string, GroupCaptureMode>()
  if (!config || config.enabled !== true || !Array.isArray(config.allowed) || Object.keys(config).some((key) => !['enabled','allowed'].includes(key))) return result
  const duplicates = new Set<string>()
  const seen = new Set<string>()
  for (const raw of config.allowed) {
    const entry = object(raw)
    const room = typeof entry?.externalRoomId === 'string' ? id(entry.externalRoomId) : null
    if (!entry || !room) continue
    if (seen.has(room)) { duplicates.add(room); result.delete(room); continue }
    seen.add(room)
    if (Object.keys(entry).some((key) => !['externalRoomId','captureMode','silence'].includes(key))) continue
    const mode = entry.captureMode ?? 'mentioned_only'
    if (mode !== 'mentioned_only' && mode !== 'all_visible_messages') continue
    const silence = object(entry.silence)
    if (!silence || Object.keys(silence).some((key) => !['timezone','mode','windows'].includes(key))) continue
    const zone = silence.timezone
    if (typeof zone !== 'string' || !/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(zone)) continue
    try { new Intl.DateTimeFormat('en-US', {timeZone:zone}).format(0) } catch { continue }
    if (silence.mode !== undefined && silence.mode !== 'all' && silence.mode !== 'direct-only') continue
    if (silence.windows !== undefined && (!Array.isArray(silence.windows) || silence.windows.some((s) => typeof s !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/.test(s)))) continue
    result.set(room, mode)
  }
  for (const room of duplicates) result.delete(room)
  return result
}

export function groupMessageForCapture(event: unknown, policies: ReadonlyMap<string, GroupCaptureMode | RoomPolicy>, text: string, at: string): GroupMessageInput | null {
  const value = object(event)
  if (!value || value.post_type !== 'message' || value.message_type !== 'group' || value.sub_type !== 'normal') return null
  const claim = toIdentityClaim(value)
  if (claim?.kind !== 'group' || !policies.has(claim.externalRoomId)) return null
  const mid = messageId(value.message_id)
  if (!mid) return null
  const sender = object(value.sender)
  if (sender?.user_id !== undefined && id(sender.user_id) !== claim.stableUserId) return null
  const mentions: string[] = []
  const parts: GroupPart[] = []
  let replyToMessageId: string | null = null
  if (Array.isArray(value.message)) for (const raw of value.message) {
    const segment = object(raw)
    const data = object(segment?.data)
    if (segment?.type === 'at') { const who = id(data?.qq); if (who && !mentions.includes(who)) mentions.push(who) }
    if (segment?.type === 'reply' && replyToMessageId === null) replyToMessageId = messageId(data?.id)
    if (segment?.type === 'text' && typeof data?.text === 'string') parts.push({type:'text',text:data.text})
    else if (segment?.type === 'at' && id(data?.qq)) parts.push({type:'at',qq:id(data?.qq)!})
    else if (segment?.type === 'reply' && messageId(data?.id)) parts.push({type:'reply',id:messageId(data?.id)!})
    else parts.push({type:'other'})
  }
  const policy = policies.get(claim.externalRoomId)!
  const full = typeof policy === 'object'
  // String-format OneBot can supply plain current text; CQ strings cannot prove nested/reply structure.
  if(full&&!Array.isArray(value.message)&&typeof value.message==='string'&&!value.message.includes('[CQ:'))parts.push({type:'text',text:value.message})
  if (full && (Array.isArray(value.message)||parts.length)) {
    try { text=groupPartsText(parts) } catch { return null }
  }
  return { externalRoomId:claim.externalRoomId,stableUserId:claim.stableUserId,messageId:mid,selfId:id(value.self_id),
    mentions,replyToMessageId,text,captureMode:full?policy.captureMode:policy,at,
    ...(full?{policy,...(Array.isArray(value.message)||parts.length?{parts}:{})}:{}), }
}
