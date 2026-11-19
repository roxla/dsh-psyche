/**
 * P3-A B4-1：只读情绪面板数据（GET /api/psyche/mood）。
 *
 * 设计（`docs/design/p3-a-b4-mood-panel.md` §1/§2）：
 * - 当前值 = `loadMood()` 的衰减后有效值；历史值 = `global_mood_history` 的原始快照。
 * - 历史必须按 `op_id` 还原成一次写入的 33 行快照，禁止把 33 行当成 33 个时间点。
 * - 纯读：只执行 SELECT（`loadMood` 本身也只读），不写任何表、不改 `last_seen`/Meta。
 * - `op_id` / `reason` 只用于服务端分组，不出现在响应体里。
 */
import {
  MOOD_DIMENSIONS,
  MOOD_PERSONA_ID,
  loadMood,
  projectMoodTone,
  type MoodProjection,
  type MoodValues,
} from './mood.js'
import type { Db } from './adapter.js'

/** 历史窗口默认快照数。 */
export const MOOD_PANEL_DEFAULT_LIMIT = 30
/** 历史窗口上限：再多就分页，不一次返回全部历史。 */
export const MOOD_PANEL_MAX_LIMIT = 120

export interface MoodPanelDimension {
  key: string
  label: string
  layer: 'basic' | 'compound' | 'contemporary'
  /** 衰减后的有效值（当前值）。 */
  value: number
  baseline: number
  halfLifeHours: number
}

export interface MoodPanelSnapshot {
  at: string
  /** 原始持久化值（写入当时的快照，不做衰减）。 */
  values: MoodValues
}

export interface MoodPanelPayload {
  ok: true
  personaId: string
  stateVersion: number | null
  updatedAt: string | null
  configVersion: number
  tone: MoodProjection
  groups: {
    basic: MoodPanelDimension[]
    compound: MoodPanelDimension[]
    contemporary: MoodPanelDimension[]
  }
  history: MoodPanelSnapshot[]
  historyLimit: number
  historyTotal: number
}

export interface MoodPanelOptions {
  /** 历史窗口（快照数），默认 30，夹到 1..120。 */
  limit?: unknown
}

/** 把外部传入的 limit 收成整数，缺省回默认；越界夹紧而不是报错。 */
export function clampMoodPanelLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return MOOD_PANEL_DEFAULT_LIMIT
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return MOOD_PANEL_DEFAULT_LIMIT
  const integer = Math.trunc(parsed)
  if (integer < 1) return 1
  if (integer > MOOD_PANEL_MAX_LIMIT) return MOOD_PANEL_MAX_LIMIT
  return integer
}

interface HistoryRow {
  op_id: string | null
  at: string | null
  dimension: string | null
  value: number | null
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 从历史行还原「每次写入一个快照」。
 *
 * 一次 `applyMood` 固定写 33 行、同一 `op_id`、同一 `at`。只有满 33 行的组才算完整；
 * 不完整的组（例如被窗口截断）直接丢弃，不拼接、不补 0。
 */
function foldHistory(rows: HistoryRow[], limit: number): MoodPanelSnapshot[] {
  const groups = new Map<string, { at: string; values: MoodValues }>()
  for (const row of rows) {
    const opId = typeof row.op_id === 'string' ? row.op_id : ''
    const at = typeof row.at === 'string' ? row.at : ''
    const dimension = typeof row.dimension === 'string' ? row.dimension : ''
    if (!opId || !at || !dimension) continue
    if (typeof row.value !== 'number' || !Number.isFinite(row.value)) continue
    let group = groups.get(opId)
    if (!group) {
      group = { at, values: {} }
      groups.set(opId, group)
    }
    // 同一 op_id 的 33 行必须共享 at；不一致说明数据异常，丢弃该组而不是硬拼。
    if (group.at !== at) {
      groups.delete(opId)
      continue
    }
    group.values[dimension] = row.value
  }

  const snapshots: MoodPanelSnapshot[] = []
  for (const group of groups.values()) {
    if (Object.keys(group.values).length !== MOOD_DIMENSIONS.length) continue
    snapshots.push({ at: group.at, values: group.values })
  }
  snapshots.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  return snapshots.slice(-limit)
}

/**
 * 组装面板返回体。
 *
 * 只读约束：本函数不调用 `applyMood`/`ensureMoodInitialized`，也不写偏好文件；
 * 库里还没有 33 行时 `loadMood` 返回默认值、历史为空，面板显示空态。
 */
export function buildMoodPanel(db: Db, options: MoodPanelOptions = {}): MoodPanelPayload {
  const limit = clampMoodPanelLimit(options.limit)
  const state = loadMood(db)
  const tone = projectMoodTone(state.values)

  const groups: MoodPanelPayload['groups'] = { basic: [], compound: [], contemporary: [] }
  for (const dimension of MOOD_DIMENSIONS) {
    const value = state.values[dimension.key]
    groups[dimension.layer].push({
      key: dimension.key,
      label: dimension.label,
      layer: dimension.layer,
      value: round2(value),
      baseline: dimension.baseline,
      halfLifeHours: round2(dimension.halfLifeMs / 3_600_000),
    })
  }

  // 只统计完整快照：不足 33 行的组是异常数据，面板不展示也不计入总数。
  const totalRow = db.get(
    `SELECT COUNT(*) AS n FROM (
       SELECT op_id FROM global_mood_history
        WHERE persona_id = ? AND op_id IS NOT NULL
        GROUP BY op_id HAVING COUNT(*) = ?
     )`,
    [MOOD_PERSONA_ID, MOOD_DIMENSIONS.length],
  ) as { n?: number } | undefined
  const historyTotal = typeof totalRow?.n === 'number' ? totalRow.n : 0

  // 多取 1 个快照的余量：窗口可能从中间截断一个 33 行组，foldHistory 会把它丢掉。
  const rows = db.all(
    `SELECT op_id, at, dimension, value
       FROM global_mood_history
      WHERE persona_id = ?
      ORDER BY at DESC, op_id DESC
      LIMIT ?`,
    [MOOD_PERSONA_ID, limit * MOOD_DIMENSIONS.length + MOOD_DIMENSIONS.length],
  ) as HistoryRow[]
  const history = foldHistory(rows, limit)

  return {
    ok: true,
    personaId: state.personaId,
    stateVersion: state.meta?.stateVersion ?? null,
    updatedAt: state.updatedAt,
    configVersion: state.meta?.configVersion ?? 1,
    tone,
    groups,
    history,
    historyLimit: limit,
    historyTotal,
  }
}
