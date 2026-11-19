// P4-D-2：配置、触发及投影的确定性规则；不读时钟、不写库。
import { createHash } from 'node:crypto'
import { invalid } from './errors.js'
export type GroupPart = { type: 'text'; text: string } | { type: 'at'; qq: string } | { type: 'reply'; id: string } | { type: 'other' }
export interface RoomPolicy {
  readonly externalRoomId: string
  readonly captureMode: 'mentioned_only' | 'all_visible_messages'
  readonly names: readonly string[]
  readonly triggers: Readonly<{ at: boolean; reply: boolean; name: boolean }>
  readonly reply: Readonly<{ enabled: boolean }>
  readonly merge: Readonly<{ quietMs: number; maxWaitMs: number; maxMessages: number; maxChars: number }>
  readonly silence: Readonly<{ timezone: string; mode: 'all' | 'direct-only'; windows: readonly string[] }>
  readonly maxTurnsPerHour: number
  readonly policyHash: string
}
export const groupHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
export function groupCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'number' && !Number.isFinite(value)) throw invalid('GROUP_CANONICAL_INVALID')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(groupCanonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${groupCanonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('GROUP_POLICY_INVALID')
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw invalid('GROUP_POLICY_FIELD')
}
function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw invalid('GROUP_POLICY_BOOLEAN')
  return value
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : value
  if (!Number.isInteger(n) || (n as number) < min || (n as number) > max) throw invalid('GROUP_POLICY_INTEGER')
  return n as number
}
export function roomPolicy(value: unknown): RoomPolicy {
  const raw = object(value)
  fields(raw, ['externalRoomId','captureMode','names','triggers','reply','merge','silence','maxTurnsPerHour','policyHash'])
  if (typeof raw.externalRoomId !== 'string' || !/^[1-9]\d{0,19}$/.test(raw.externalRoomId)) throw invalid('GROUP_POLICY_ROOM')
  const captureMode = raw.captureMode === undefined ? 'mentioned_only' : raw.captureMode
  if (captureMode !== 'mentioned_only' && captureMode !== 'all_visible_messages') throw invalid('GROUP_POLICY_CAPTURE')
  const namesRaw = raw.names === undefined ? [] : raw.names
  if (!Array.isArray(namesRaw) || namesRaw.length > 16) throw invalid('GROUP_POLICY_NAMES')
  const names = namesRaw.map((name: unknown) => {
    if (typeof name !== 'string') throw invalid('GROUP_POLICY_NAME')
    const normalized = name.normalize('NFC')
    if (!/^[\p{L}\p{N}_]+$/u.test(normalized) || [...normalized].length > 32) throw invalid('GROUP_POLICY_NAME')
    return normalized
  })
  if (new Set(names).size !== names.length) throw invalid('GROUP_POLICY_NAMES_DUPLICATE')
  const triggers = raw.triggers === undefined ? {} : object(raw.triggers); fields(triggers, ['at','reply','name'])
  const reply = raw.reply === undefined ? {} : object(raw.reply); fields(reply, ['enabled'])
  const merge = raw.merge === undefined ? {} : object(raw.merge); fields(merge, ['quietMs','maxWaitMs','maxMessages','maxChars'])
  const quietMs = integer(merge.quietMs,2000,1,2000)
  const silence = object(raw.silence); fields(silence,['timezone','mode','windows'])
  if (typeof silence.timezone !== 'string' || !/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(silence.timezone)) throw invalid('GROUP_POLICY_TIMEZONE')
  try { new Intl.DateTimeFormat('en-US',{timeZone:silence.timezone}).format(0) } catch { throw invalid('GROUP_POLICY_TIMEZONE') }
  const mode = silence.mode === undefined ? 'all' : silence.mode
  if (mode !== 'all' && mode !== 'direct-only') throw invalid('GROUP_POLICY_SILENCE')
  const windows = silence.windows === undefined ? [] : silence.windows
  if (!Array.isArray(windows) || windows.some(w => typeof w !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/.test(w) || w.slice(0,5) === w.slice(6))) throw invalid('GROUP_POLICY_WINDOWS')
  const policy = {
    externalRoomId:raw.externalRoomId, captureMode, names:Object.freeze(names),
    triggers:Object.freeze({at:bool(triggers.at,true),reply:bool(triggers.reply,true),name:bool(triggers.name,true)}),
    reply:Object.freeze({enabled:bool(reply.enabled,false)}),
    merge:Object.freeze({quietMs,maxWaitMs:integer(merge.maxWaitMs,8000,quietMs,8000),maxMessages:integer(merge.maxMessages,20,1,20),maxChars:integer(merge.maxChars,4000,1,4000)}),
    silence:Object.freeze({timezone:silence.timezone,mode,windows:Object.freeze([...windows] as string[])}),
    maxTurnsPerHour:integer(raw.maxTurnsPerHour,6,1,6),
  } as const
  const policyHash = groupHash(groupCanonical(policy))
  if (raw.policyHash !== undefined && raw.policyHash !== policyHash) throw invalid('GROUP_POLICY_HASH')
  return Object.freeze({...policy,policyHash})
}
export function groupRoomPolicies(value: unknown): ReadonlyMap<string,RoomPolicy> {
  const result = new Map<string,RoomPolicy>(), seen = new Set<string>(), duplicates = new Set<string>()
  try {
    const config=object(value); fields(config,['enabled','allowed'])
    if (config.enabled !== true || !Array.isArray(config.allowed)) return result
    for (const raw of config.allowed) {
      if (raw && typeof raw === 'object' && typeof raw.externalRoomId === 'string') {
        if (seen.has(raw.externalRoomId)) duplicates.add(raw.externalRoomId)
        seen.add(raw.externalRoomId)
      }
      try {
        if(raw&&typeof raw==='object'&&Object.hasOwn(raw,'policyHash'))throw invalid('GROUP_POLICY_FIELD')
        const policy=roomPolicy(raw); result.set(policy.externalRoomId,policy)
      } catch { /* fail closed per entry */ }
    }
  } catch { return new Map() }
  for (const id of duplicates) result.delete(id)
  return result
}
export function groupSilenced(policy: RoomPolicy, now: number): boolean {
  if (!Number.isFinite(now)) throw invalid('GROUP_TIME_INVALID')
  if (policy.silence.mode === 'direct-only') return false // every v1 trigger is direct
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:policy.silence.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now)
  const local=Number(parts.find(p=>p.type==='hour')!.value)*60+Number(parts.find(p=>p.type==='minute')!.value)
  return policy.silence.windows.some(w => {
    const [a,b]=w.split('-').map(t=>Number(t.slice(0,2))*60+Number(t.slice(3)))
    return a < b ? local>=a && local<b : local>=a || local<b
  })
}
function rawGroupPartsText(parts: readonly GroupPart[]): string {
  if (!Array.isArray(parts) || parts.length > 2000) throw invalid('GROUP_PARTS_INVALID')
  return parts.map(part => {
    if (!part || typeof part !== 'object') throw invalid('GROUP_PARTS_INVALID')
    if (part.type === 'text' && typeof part.text === 'string') return part.text
    if (part.type === 'at' && /^[1-9]\d{0,19}$/.test(part.qq)) return '\n[提及成员]\n'
    if (part.type === 'reply' && /^[A-Za-z0-9_:-]{1,120}$/.test(part.id)) return '\n[引用消息]\n'
    if (part.type === 'other') return '\n[非文本内容]\n'
    throw invalid('GROUP_PARTS_INVALID')
  }).join('')
}
export function groupPartsText(parts: readonly GroupPart[]): string { return rawGroupPartsText(parts).trim() }
export function groupNameMatches(parts: readonly GroupPart[], names: readonly string[]): ReadonlyArray<{name:string;start:number;end:number}> {
  groupPartsText(parts)
  const runs: Array<{text:string;offset:number}>=[]
  let text='',offset=0
  for (const part of parts) {
    if (part.type==='text') {text+=part.text;continue}
    if(text) runs.push({text,offset}); offset+=text.length; text=''
    offset+=groupPartsText([part]).length+2
  }
  if(text)runs.push({text,offset})
  const raw=rawGroupPartsText(parts),leading=raw.length-raw.trimStart().length
  const hits: Array<{name:string;start:number;end:number}>=[]
  for (const run of runs) for (const match of run.text.matchAll(/[\p{L}\p{N}\p{M}_]+/gu)) {
    const name=match[0].normalize('NFC')
    if(names.includes(name)) hits.push({name,start:run.offset+match.index!-leading,end:run.offset+match.index!+match[0].length-leading})
  }
  return hits
}
