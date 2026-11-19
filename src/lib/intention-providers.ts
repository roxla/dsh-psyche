/**
 * P6-3：把五类内部关注源接到已有账本上。
 *
 * GPT 冻结口径（P6-3 第 6 轮）：
 * - 只读：不写 Source/Event/Artifact/Growth，不调模型，不发送。
 * - 承诺三态：open（未完成且无闭环证据）、closed（成功 action_result / refusal / correction）、
 *   unknown（失败 action_result 或证据不完整）；只有 open 生成候选。
 * - 情绪 episode：以连续同方向偏离的 run 起点 history_id 为锚点；证据只记该锚点，窗口滑动不换证据；
 *   回到基线或方向反转即结束，新 run 才开新 episode。
 * - 主题：artifact 最新 active revision，≥3 个独立 independence_key 的 Source（14 天），
 *   逐条复核 Source 有效性与 Disclosure。
 * - 空闲：lastActivity=max(Source.captured_at, Event.at)，要求 ≥12h；没有 Source 证据就跳过。
 * - open-plan：本阶段没有可靠数据源，保持 PARTIAL（本文件不产出）。
 */
import type { Db } from 'dsh-psyche-core'
import {
  MOOD_DIMENSIONS,
  type ActivitySignal,
  type AffectSignal,
  type MoodSignal,
  type OpenItemSignal,
  type ThemeSignal,
} from 'dsh-psyche-core'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const MIN_MOOD_DEVIATION = 10
const MIN_MOOD_SUSTAINED_TURNS = 3
const MIN_AFFECT_INTENSITY = 40
const MIN_QUIET_MS = 12 * HOUR_MS
const MIN_OPEN_ITEM_AGE_MS = 24 * HOUR_MS
const MIN_THEME_INDEPENDENT = 3
const THEME_LOOKBACK_MS = 14 * DAY_MS

const NEGATIVE_AFFECT = new Set(['tension', 'hurt', 'irritation'])
const AFFECT_DIMS = ['warmth', 'tension', 'hurt', 'missing', 'irritation'] as const

export interface AttentionSignals {
  commitments: OpenItemSignal[]
  themes: ThemeSignal[]
  activity?: ActivitySignal
  mood: MoodSignal[]
  affect: AffectSignal[]
}

const BASELINE = new Map(MOOD_DIMENSIONS.map((dim) => [dim.key, dim]))
const DIM_LABEL = new Map(MOOD_DIMENSIONS.map((dim) => [dim.key, dim.label]))

interface MoodRow {
  id: number
  dim: string
  value: number
  reason: string | null
  at: string
}

interface AffectRow {
  id: number
  contact_id: string
  dim: string
  value: number
  at: string
}

interface CommitmentRow {
  id: string
  statement: string
  at: string
  sources: string | null
}

interface ClosureRow {
  type: string
  text: string
}

interface ThemeRow {
  artifact_id: string
  statement: string
  payload: string
  independent: number
  sources: string | null
  last_seen: string
}

interface LastSourceRow {
  source_id: string
  captured_at: string
}

function parseTurn(reason: string | null): { session: string; turn: number } | null {
  if (typeof reason !== 'string') return null
  const match = /^turn:(.+):(\d+)$/.exec(reason.trim())
  if (!match) return null
  const turn = Number.parseInt(match[2] ?? '', 10)
  if (!Number.isFinite(turn)) return null
  return { session: match[1] ?? '', turn }
}

function evidenceIdsOf(raw: string | null, limit = 10): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, limit)
}

/**
 * 承诺三态判定。只返回明确 open 的项；closed/unknown 一律跳过。
 */
export function openCommitments(
  db: Db,
  personaId: string,
  nowIso: string,
  onSkip?: () => void,
): OpenItemSignal[] {
  const nowMs = Date.parse(nowIso)
  if (!Number.isFinite(nowMs)) return []
  const cutoff = new Date(nowMs - MIN_OPEN_ITEM_AGE_MS).toISOString()
  const rows = db.all<CommitmentRow>(
    `SELECT e.event_id AS id,
            e.text AS statement,
            e.at AS at,
            (SELECT GROUP_CONCAT(es.source_id, ',')
               FROM event_sources es
              WHERE es.event_id = e.event_id) AS sources
       FROM events e
      WHERE e.persona_id = ?
        AND e.kind = 'interaction'
        AND e.type = 'commitment'
        AND e.at <= ?
      ORDER BY e.at ASC
      LIMIT 20`,
    [personaId, cutoff],
  )

  const result: OpenItemSignal[] = []
  for (const row of rows) {
    const evidenceIds = evidenceIdsOf(row.sources)
    if (evidenceIds.length === 0) {
      onSkip?.()
      continue
    }
    const closures = db.all<ClosureRow>(
      `SELECT e.type AS type, e.text AS text
         FROM events e
        WHERE e.persona_id = ?
          AND e.at > ?
          AND e.type IN ('action_result', 'refusal', 'correction')
          AND (e.caused_by = ?
               OR EXISTS (SELECT 1 FROM event_relations r
                           WHERE r.event_id = e.event_id AND r.target_event_id = ?))
        ORDER BY e.at ASC
        LIMIT 5`,
      [personaId, row.at, row.id, row.id],
    )
    if (closures.length > 0) {
      const failed = closures.some((item) => item.type === 'action_result' && /失败|failed|error/i.test(item.text))
      if (failed) continue
      continue
    }
    result.push({
      id: row.id,
      statement: row.statement,
      status: 'open',
      updatedAt: row.at,
      evidenceIds,
    })
  }
  return result
}

/**
 * 当前连续同方向偏离的 run 起点。只返回 run 内不同 turn 数 ≥ 3 的情绪信号。
 */
export function moodEpisodes(db: Db, personaId: string, nowIso: string): MoodSignal[] {
  const nowMs = Date.parse(nowIso)
  if (!Number.isFinite(nowMs)) return []
  const since = new Date(nowMs - 14 * DAY_MS).toISOString()
  const rows = db.all<MoodRow>(
    `SELECT history_id AS id, dimension AS dim, value, reason, at
       FROM global_mood_history
      WHERE persona_id = ? AND at >= ?
      ORDER BY at ASC`,
    [personaId, since],
  )
  if (rows.length === 0) return []

  const byDim = new Map<string, MoodRow[]>()
  for (const row of rows) {
    const list = byDim.get(row.dim) ?? []
    list.push(row)
    byDim.set(row.dim, list)
  }

  const signals: MoodSignal[] = []
  for (const [dim, list] of byDim) {
    const meta = BASELINE.get(dim)
    if (!meta) continue
    const latest = list[list.length - 1]
    if (!latest) continue
    let sign = 0
    let start: MoodRow | null = null
    const turns = new Set<string>()
    let session = ''
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const row = list[index]
      if (!row) break
      const deviation = row.value - meta.baseline
      const nextSign = Math.abs(deviation) >= MIN_MOOD_DEVIATION ? Math.sign(deviation) : 0
      if (nextSign === 0) break
      if (sign === 0) sign = nextSign
      if (nextSign !== sign) break
      const parsed = parseTurn(row.reason)
      if (parsed === null) break
      if (session === '') session = parsed.session
      if (parsed.session !== session) break
      turns.add(`${parsed.session}:${parsed.turn}`)
      start = row
    }
    if (start === null || sign === 0) continue
    if (turns.size < MIN_MOOD_SUSTAINED_TURNS) continue
    const label = DIM_LABEL.get(dim) ?? dim
    signals.push({
      dim: label,
      value: latest.value,
      baseline: meta.baseline,
      sustainedTurns: turns.size,
      evidenceIds: [`moodhist:${start.id}`],
    })
  }
  return signals
}

/**
 * 当前连续同方向 |值|≥40 的 Affect episode；证据只记 run 起点 history_id。
 */
export function affectEpisodes(db: Db, personaId: string, nowIso: string): AffectSignal[] {
  const nowMs = Date.parse(nowIso)
  if (!Number.isFinite(nowMs)) return []
  const since = new Date(nowMs - 14 * DAY_MS).toISOString()
  const rows = db.all<AffectRow>(
    `SELECT history_id AS id, contact_id, dimension AS dim, value, at
       FROM contact_affect_history
      WHERE persona_id = ? AND at >= ?
      ORDER BY at ASC`,
    [personaId, since],
  )
  const groups = new Map<string, AffectRow[]>()
  for (const row of rows) {
    const key = `${row.contact_id}|${row.dim}`
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }

  const signals: AffectSignal[] = []
  for (const [key, list] of groups) {
    const latest = list[list.length - 1]
    if (!latest) continue
    const dim = AFFECT_DIMS.find((item) => item === latest.dim)
    if (!dim) continue
    let sign = 0
    let start: AffectRow | null = null
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const row = list[index]
      if (!row) break
      const strength = Math.abs(row.value)
      const nextSign = strength >= MIN_AFFECT_INTENSITY ? Math.sign(row.value) : 0
      if (nextSign === 0) break
      if (sign === 0) sign = nextSign
      if (nextSign !== sign) break
      start = row
    }
    if (start === null || sign === 0) continue
    const contactId = key.slice(0, key.indexOf('|'))
    signals.push({
      contactId,
      dim,
      value: Math.abs(latest.value),
      evidenceIds: [`affecthist:${start.id}`],
    })
  }
  return signals
}

/**
 * 主题：最新 active revision 且 ≥3 个独立 Source；逐条 Source 复核存在与 secret Disclosure。
 */
export function recurringThemes(db: Db, personaId: string, nowIso: string): ThemeSignal[] {
  const nowMs = Date.parse(nowIso)
  if (!Number.isFinite(nowMs)) return []
  const since = new Date(nowMs - THEME_LOOKBACK_MS).toISOString()
  const rows = db.all<ThemeRow>(
    `SELECT ar.artifact_id, ar.statement, ar.payload,
            COUNT(DISTINCT ae.independence_key) AS independent,
            GROUP_CONCAT(DISTINCT ae.source_id) AS sources,
            MAX(s.captured_at) AS last_seen
       FROM artifact_revisions ar
       JOIN artifacts a ON a.artifact_id = ar.artifact_id
       JOIN artifact_evidence ae ON ae.artifact_id = ar.artifact_id AND ae.revision = ar.revision
       JOIN sources s ON s.source_id = ae.source_id
      WHERE a.persona_id = ?
        AND ar.revision = (SELECT MAX(r.revision) FROM artifact_revisions r WHERE r.artifact_id = ar.artifact_id)
        AND ar.state = 'active'
        AND s.captured_at >= ?
      GROUP BY ar.artifact_id, ar.revision
     HAVING COUNT(DISTINCT ae.independence_key) >= ?
      ORDER BY last_seen DESC
      LIMIT 20`,
    [personaId, since, MIN_THEME_INDEPENDENT],
  )

  const themes: ThemeSignal[] = []
  for (const row of rows) {
    if (row.statement.trim().length === 0) continue
    let payload: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(row.payload)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (payload.disclosure === 'secret') continue
    const scope = payload.scope
    if (scope !== undefined) {
      const kind = typeof scope === 'object' && scope !== null ? (scope as Record<string, unknown>).kind : undefined
      if (kind !== 'personal') continue
    }
    const evidenceIds = evidenceIdsOf(row.sources, 6)
    if (evidenceIds.length < MIN_THEME_INDEPENDENT) continue
    let valid = true
    for (const sourceId of evidenceIds) {
      const source = db.get<{ metadata: string }>(`SELECT metadata FROM sources WHERE source_id=?`, [sourceId])
      if (!source) {
        valid = false
        break
      }
      let metadata: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(source.metadata)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>
      } catch {
        metadata = {}
      }
      if (metadata.disclosure === 'secret') {
        valid = false
        break
      }
    }
    if (!valid) continue
    themes.push({
      key: row.artifact_id,
      statement: row.statement,
      count: row.independent,
      lastSeenAt: row.last_seen,
      evidenceIds,
    })
  }
  return themes
}

interface EventTimeRow {
  at: string
}

/**
 * 空闲：只有存在 Source 证据时才计算；lastActivity=max(Source, Event)，安静 ≥12h。
 */
export function idleWindow(db: Db, personaId: string, nowIso: string): ActivitySignal | undefined {
  const nowMs = Date.parse(nowIso)
  if (!Number.isFinite(nowMs)) return undefined
  const latestSource = db.get<LastSourceRow>(
    `SELECT source_id, captured_at FROM sources
      WHERE persona_id = ? AND origin IN ('user', 'external')
      ORDER BY captured_at DESC LIMIT 1`,
    [personaId],
  )
  if (!latestSource) return undefined
  const latestEvent = db.get<EventTimeRow>(
    `SELECT at FROM events WHERE persona_id = ? ORDER BY at DESC LIMIT 1`,
    [personaId],
  )
  const sourceMs = Date.parse(latestSource.captured_at)
  const eventMs = latestEvent ? Date.parse(latestEvent.at) : NaN
  const lastMs = Math.max(Number.isFinite(sourceMs) ? sourceMs : 0, Number.isFinite(eventMs) ? eventMs : 0)
  if (lastMs <= 0 || nowMs - lastMs < MIN_QUIET_MS) return undefined
  const evidence = db.all<LastSourceRow>(
    `SELECT source_id, captured_at FROM sources
      WHERE persona_id = ? AND captured_at <= ?
      ORDER BY captured_at DESC LIMIT 3`,
    [personaId, new Date(lastMs + 1000).toISOString()],
  )
  const evidenceIds = evidence.map((item) => item.source_id)
  if (evidenceIds.length === 0) return undefined
  return {
    lastInteractionAt: new Date(lastMs).toISOString(),
    quietSince: new Date(lastMs).toISOString(),
    evidenceIds,
  }
}

export function collectAttentionSignals(
  db: Db,
  personaId: string,
  nowIso: string,
  onSkipCommitment?: () => void,
): AttentionSignals {
  return {
    commitments: openCommitments(db, personaId, nowIso, onSkipCommitment),
    themes: recurringThemes(db, personaId, nowIso),
    activity: idleWindow(db, personaId, nowIso),
    mood: moodEpisodes(db, personaId, nowIso),
    affect: affectEpisodes(db, personaId, nowIso),
  }
}
