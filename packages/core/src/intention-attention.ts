// P6-0：Attention——把「值得想一想的事」从已有数据里确定性派生出来。
//
// 契约（docs/design/p6-0-autonomous-intention.md）：
//   - 纯函数：不读库、不读系统时钟、不调模型、不写任何账本、不发送。
//   - 只有五类来源：情绪与关系变化、空闲时段、未完成承诺、未完成计划、反复出现的主题。
//   - 空闲只由可信的活动/时间证据判断，不推测「无聊」这类主观状态。
//   - 每一项必须带 scope、证据引用、可信度；证据不足直接跳过，不产生候选。
//   - 同一输入稳定排序：类型顺序 → 可信度降序 → attentionId 字典序。

import { createHash } from 'node:crypto'

export const INTENTION_ATTENTION_VERSION = 1

/** 单次扫描最多保留多少条关注项。 */
export const MAX_ATTENTION_ITEMS = 20

/** 情绪偏离基线的绝对值达到多少才值得注意。 */
export const MIN_MOOD_DEVIATION = 10

/** 情绪偏离至少持续多少个可信 Turn。 */
export const MIN_MOOD_SUSTAINED_TURNS = 3

/** Contact Affect 单维强度达到多少才值得注意。 */
export const MIN_AFFECT_INTENSITY = 40

/** 判定「近期空闲」所需的最短安静时长。 */
export const MIN_QUIET_MS = 2 * 60 * 60 * 1000

/** 判定「近期空闲」所需的距上次互动的最短时长。 */
export const MIN_LAST_INTERACTION_MS = 12 * 60 * 60 * 1000

/** 未完成承诺/计划至少搁置多久才重新进入视野。 */
export const MIN_OPEN_ITEM_AGE_MS = 24 * 60 * 60 * 1000

/** 主题至少出现多少次才算「反复出现」。 */
export const MIN_THEME_COUNT = 3

/** 主题的最后出现时间必须在这个窗口内。 */
export const THEME_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000

export type AttentionKind =
  | 'mood-affect'
  | 'idle-window'
  | 'open-commitment'
  | 'open-plan'
  | 'recurring-theme'

export const ATTENTION_KIND_ORDER: readonly AttentionKind[] = Object.freeze([
  'open-commitment',
  'open-plan',
  'mood-affect',
  'recurring-theme',
  'idle-window',
])

export type AttentionScopeKind = 'personal' | 'contact' | 'room'

export interface AttentionScope {
  kind: AttentionScopeKind
  /** contact/room 作用域必填；personal 不得填写。 */
  id?: string
}

export interface AttentionItem {
  attentionId: string
  kind: AttentionKind
  scope: AttentionScope
  title: string
  evidenceIds: string[]
  /** 0–1；只用于排序，不是权限。 */
  confidence: number
  detectedAt: string
}

export interface MoodSignal {
  dim: string
  value: number
  baseline: number
  sustainedTurns: number
  evidenceIds: readonly string[]
}

export interface AffectSignal {
  contactId: string
  dim: 'warmth' | 'tension' | 'hurt' | 'missing' | 'irritation'
  value: number
  evidenceIds: readonly string[]
}

export interface ActivitySignal {
  lastInteractionAt?: string
  /** 安静时段开始时间；必须与 lastInteractionAt 同为可信时间。 */
  quietSince?: string
  /** 只在契约里保留，不参与「无聊」推断。 */
  timeZone?: string
  evidenceIds: readonly string[]
}

export interface OpenItemSignal {
  id: string
  statement: string
  status: 'open' | 'done' | 'dropped'
  updatedAt: string
  dueAt?: string
  evidenceIds: readonly string[]
}

export interface ThemeSignal {
  key: string
  statement?: string
  count: number
  lastSeenAt: string
  evidenceIds: readonly string[]
}

export interface AttentionInput {
  now: string
  mood?: readonly MoodSignal[]
  affect?: readonly AffectSignal[]
  activity?: ActivitySignal
  commitments?: readonly OpenItemSignal[]
  plans?: readonly OpenItemSignal[]
  themes?: readonly ThemeSignal[]
}

export type AttentionSkipReason =
  | 'invalid-now'
  | 'invalid-scope'
  | 'missing-evidence'
  | 'invalid-time'
  | 'threshold-not-met'
  | 'duplicate'

export interface AttentionSkip {
  kind: AttentionKind
  key: string
  reason: AttentionSkipReason
}

export interface AttentionScanResult {
  items: AttentionItem[]
  skipped: AttentionSkip[]
  truncated: number
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function stableId(prefix: string, kind: AttentionKind, scope: AttentionScope, ref: string): string {
  const scopeKey = scope.kind === 'personal' ? 'personal' : `${scope.kind}:${scope.id ?? ''}`
  const digest = createHash('sha256').update(`${prefix}|${kind}|${scopeKey}|${ref}`).digest('hex').slice(0, 16)
  return `att:${kind}:${digest}`
}

function cleanText(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function validEvidence(ids: readonly string[] | undefined): string[] {
  if (!ids) return []
  const seen = new Set<string>()
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id.length === 0 || id.length > 200) continue
    seen.add(id)
  }
  return [...seen].sort()
}

function validScope(scope: AttentionScope): boolean {
  if (scope.kind === 'personal') return scope.id === undefined
  if (scope.kind === 'contact' || scope.kind === 'room') {
    return typeof scope.id === 'string' && scope.id.trim().length > 0
  }
  return false
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * 从已有信号派生关注项。任何一项证据不足都会被跳过并记录原因，不会静默伪造。
 */
export function scanAttention(input: AttentionInput): AttentionScanResult {
  const nowMs = parseTime(input.now)
  if (nowMs === null) {
    return { items: [], skipped: [{ kind: 'mood-affect', key: 'now', reason: 'invalid-now' }], truncated: 0 }
  }

  const skipped: AttentionSkip[] = []
  const byId = new Map<string, AttentionItem>()

  const push = (item: AttentionItem): void => {
    if (!validScope(item.scope)) {
      skipped.push({ kind: item.kind, key: item.attentionId, reason: 'invalid-scope' })
      return
    }
    if (item.evidenceIds.length === 0) {
      skipped.push({ kind: item.kind, key: item.attentionId, reason: 'missing-evidence' })
      return
    }
    const previous = byId.get(item.attentionId)
    if (previous) {
      skipped.push({ kind: item.kind, key: item.attentionId, reason: 'duplicate' })
      if (item.confidence > previous.confidence) byId.set(item.attentionId, item)
      return
    }
    byId.set(item.attentionId, item)
  }

  for (const mood of input.mood ?? []) {
    const dim = typeof mood.dim === 'string' ? mood.dim.trim() : ''
    const evidenceIds = validEvidence(mood.evidenceIds)
    if (dim.length === 0) continue
    if (!Number.isFinite(mood.value) || !Number.isFinite(mood.baseline)) continue
    if (!Number.isFinite(mood.sustainedTurns) || mood.sustainedTurns < MIN_MOOD_SUSTAINED_TURNS) continue
    const deviation = Math.abs(mood.value - mood.baseline)
    if (deviation < MIN_MOOD_DEVIATION) continue
    const attentionId = stableId('mood', 'mood-affect', { kind: 'personal' }, dim)
    push({
      attentionId,
      kind: 'mood-affect',
      scope: { kind: 'personal' },
      title: `${cleanText(dim, 24)}持续偏离基线`,
      evidenceIds,
      confidence: clamp01(0.5 + Math.min(0.5, deviation / 40)),
      detectedAt: input.now,
    })
  }

  for (const affect of input.affect ?? []) {
    const contactId = typeof affect.contactId === 'string' ? affect.contactId.trim() : ''
    const evidenceIds = validEvidence(affect.evidenceIds)
    if (contactId.length === 0) continue
    if (!Number.isFinite(affect.value) || affect.value < MIN_AFFECT_INTENSITY) continue
    const attentionId = stableId('affect', 'mood-affect', { kind: 'contact', id: contactId }, affect.dim)
    push({
      attentionId,
      kind: 'mood-affect',
      scope: { kind: 'contact', id: contactId },
      title: `和${cleanText(contactId, 24)}之间还有没消化的感受`,
      evidenceIds,
      confidence: clamp01(affect.value / 100),
      detectedAt: input.now,
    })
  }

  const activity = input.activity
  if (activity) {
    const lastMs = parseTime(activity.lastInteractionAt)
    const quietMs = parseTime(activity.quietSince)
    const evidenceIds = validEvidence(activity.evidenceIds)
    if (lastMs !== null && quietMs !== null && quietMs >= lastMs) {
      const quietFor = nowMs - quietMs
      const sinceLast = nowMs - lastMs
      if (quietFor >= MIN_QUIET_MS && sinceLast >= MIN_LAST_INTERACTION_MS && evidenceIds.length > 0) {
        const key = `${activity.lastInteractionAt}|${activity.quietSince}`
        push({
          attentionId: stableId('idle', 'idle-window', { kind: 'personal' }, key),
          kind: 'idle-window',
          scope: { kind: 'personal' },
          title: '近期有一段安静的空闲时段',
          evidenceIds,
          confidence: 0.5,
          detectedAt: input.now,
        })
      }
    } else if (activity.lastInteractionAt !== undefined || activity.quietSince !== undefined) {
      skipped.push({ kind: 'idle-window', key: 'activity', reason: 'invalid-time' })
    }
  }

  const openItem = (item: OpenItemSignal, kind: 'open-commitment' | 'open-plan'): void => {
    if (item.status !== 'open') return
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (id.length === 0) return
    const updatedMs = parseTime(item.updatedAt)
    if (updatedMs === null) {
      skipped.push({ kind, key: id, reason: 'invalid-time' })
      return
    }
    if (nowMs - updatedMs < MIN_OPEN_ITEM_AGE_MS) return
    const evidenceIds = validEvidence(item.evidenceIds)
    const statement = typeof item.statement === 'string' && item.statement.trim().length > 0 ? item.statement : id
    push({
      attentionId: stableId(kind, kind, { kind: 'personal' }, id),
      kind,
      scope: { kind: 'personal' },
      title: cleanText(statement, 80),
      evidenceIds,
      confidence: kind === 'open-commitment' ? 0.8 : 0.65,
      detectedAt: input.now,
    })
  }

  for (const item of input.commitments ?? []) openItem(item, 'open-commitment')
  for (const item of input.plans ?? []) openItem(item, 'open-plan')

  for (const theme of input.themes ?? []) {
    const key = typeof theme.key === 'string' ? theme.key.trim() : ''
    if (key.length === 0) continue
    if (!Number.isFinite(theme.count) || theme.count < MIN_THEME_COUNT) continue
    const lastMs = parseTime(theme.lastSeenAt)
    if (lastMs === null) {
      skipped.push({ kind: 'recurring-theme', key, reason: 'invalid-time' })
      continue
    }
    if (nowMs - lastMs > THEME_LOOKBACK_MS) continue
    const evidenceIds = validEvidence(theme.evidenceIds)
    const label = theme.statement && theme.statement.trim().length > 0 ? theme.statement : key
    push({
      attentionId: stableId('theme', 'recurring-theme', { kind: 'personal' }, key),
      kind: 'recurring-theme',
      scope: { kind: 'personal' },
      title: cleanText(label, 80),
      evidenceIds,
      confidence: clamp01(0.4 + theme.count * 0.1),
      detectedAt: input.now,
    })
  }

  const items = [...byId.values()].sort((left, right) => {
    const kindDelta = ATTENTION_KIND_ORDER.indexOf(left.kind) - ATTENTION_KIND_ORDER.indexOf(right.kind)
    if (kindDelta !== 0) return kindDelta
    if (right.confidence !== left.confidence) return right.confidence - left.confidence
    return left.attentionId < right.attentionId ? -1 : left.attentionId > right.attentionId ? 1 : 0
  })

  const truncated = Math.max(0, items.length - MAX_ATTENTION_ITEMS)
  return { items: items.slice(0, MAX_ATTENTION_ITEMS), skipped, truncated }
}
