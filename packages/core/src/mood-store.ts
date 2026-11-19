// Mood v1 存储层（P3-A B1，schema v19）。
//
// 定位：情绪是**可持久化的运行状态**，不是长期记忆。
//   - 只写 global_mood_state（33 行投影）+ global_mood_history（不可变流水）+ mood_meta（单行聚合根）；
//   - 不写 artifacts / events / fts_index，所以天然不进 Recall、Diary、Stance、Growth Gate；
//   - 读路径只做衰减计算，绝不写库（打开面板不会产生写入）。
//
// 不变量：
//   - 每个 persona 在 global_mood_state 恰好 33 行（MOOD_DIMENSIONS 全集）；
//   - mood_meta 每个 persona 恰好一行，state_version 一次完整更新只 +1；
//   - 一次 applyMood 在同一个事务里写 33 行 state + 33 行 history + 1 行 meta；
//   - 同一 (persona, op_id) 重放不重复写 state，也不新增历史行；
//   - 衰减双向向 baseline 趋近（高于回落、低于回升，单调不过冲）。
import { nowIso } from './adapter.js'
import type { Db } from './adapter.js'
import { CODE, PsycheError } from './errors.js'
import { MOOD_KEYS, MOOD_PERSONA_ID, defaultMoodValues, moodDimensionOf } from './mood-schema.js'
import { clampMood, decayMoodValue } from './mood-decay.js'
import type { MoodValues } from './mood-decay.js'

/** 聚合根级元数据：每 persona 一行，承载版本与幂等键，不重复写进 33 个维度行。 */
export interface MoodMetaRecord {
  personaId: string
  stateVersion: number
  configVersion: number
  lastOpId: string | null
  updatedAt: string
}

export interface MoodState {
  personaId: string
  values: MoodValues
  /** 最近一次实际持久化的时间（UTC ISO）；没有状态时返回 null。 */
  updatedAt: string | null
  meta: MoodMetaRecord | null
}

export interface MoodTransitionInput {
  /** 幂等键；同一 persona 下同一 op_id 只应用一次。 */
  opId: string
  /** 只给要变化的维度；未给的维度保持不变（但仍会被衰减）。 */
  deltas: MoodValues
  /** 为什么变（事件 id 或一句说明），写进历史。 */
  reason?: string
  /** 本次应用的时间；默认 nowIso()。 */
  now?: string
}

export interface MoodTransitionResult {
  applied: boolean
  replayed: boolean
  stateVersion: number
  values: MoodValues
  updatedAt: string
}

export interface MoodStoreOptions {
  personaId?: string
  now?: string
}

export interface LegacyMoodSnapshot {
  values: Record<string, number>
  updatedAt?: string
}

export interface LegacyMoodImportResult {
  imported: boolean
  applied: number
  warnings: string[]
}

export interface MoodTransitionDeps {
  now?: () => string
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function personaOf(options: MoodStoreOptions = {}): string {
  return clean(options.personaId, 64) || MOOD_PERSONA_ID
}

function nowText(options: MoodStoreOptions, deps: MoodTransitionDeps = {}): string {
  const explicit = clean(options.now, 40)
  if (explicit !== '') return explicit
  return deps.now ? deps.now() : nowIso()
}

function rowToMeta(row: Record<string, unknown>): MoodMetaRecord {
  return {
    personaId: String(row.persona_id ?? ''),
    stateVersion: Number(row.state_version ?? 0),
    configVersion: Number(row.config_version ?? 0),
    lastOpId: row.last_op_id === null || row.last_op_id === undefined ? null : String(row.last_op_id),
    updatedAt: String(row.updated_at ?? ''),
  }
}

/** 读聚合根元数据；不存在返回 null（不自动写库）。 */
export function readMoodMeta(db: Db, personaId: string = MOOD_PERSONA_ID): MoodMetaRecord | null {
  const row = db.get<Record<string, unknown>>(
    'SELECT persona_id, state_version, config_version, last_op_id, updated_at FROM mood_meta WHERE persona_id = ?',
    [personaId],
  )
  return row ? rowToMeta(row) : null
}

/**
 * 确保 33 行状态与 1 行元数据存在（幂等）。
 *
 * 前置条件：`persona_config` 里已有该 persona——global_mood_state 对它有外键。
 * 已存在的行不会被覆盖（INSERT OR IGNORE），所以不会把用户当前情绪重置成默认值。
 */
export function ensureMoodInitialized(db: Db, options: MoodStoreOptions = {}): MoodMetaRecord {
  const personaId = personaOf(options)
  const now = nowText(options)
  const persona = db.get<Record<string, unknown>>('SELECT persona_id FROM persona_config WHERE persona_id = ?', [personaId])
  if (!persona) {
    throw new PsycheError(CODE.validation, '情绪状态初始化需要先有 persona_config 记录', { personaId })
  }
  const defaults = defaultMoodValues()
  return db.transaction((): MoodMetaRecord => {
    for (const key of MOOD_KEYS) {
      db.run(
        `INSERT OR IGNORE INTO global_mood_state (persona_id, dimension, value, updated_at)
         VALUES (?, ?, ?, ?)`,
        [personaId, key, defaults[key] ?? 0, now],
      )
    }
    db.run(
      `INSERT OR IGNORE INTO mood_meta (persona_id, state_version, config_version, last_op_id, updated_at)
       VALUES (?, 1, 1, NULL, ?)`,
      [personaId, now],
    )
    const meta = readMoodMeta(db, personaId)
    if (!meta) {
      throw new PsycheError(CODE.internal, '情绪元数据初始化失败', { personaId })
    }
    return meta
  })
}

/**
 * 读当前有效情绪（只读，绝不写库）。
 *
 * - 没有状态行时返回冻结默认值（不自动初始化——初始化是显式动作）；
 * - 每行按自己的 updated_at 做指数衰减，逐维计算，没有全局时间戳假设。
 */
export function loadMood(db: Db, options: MoodStoreOptions = {}): MoodState {
  const personaId = personaOf(options)
  const nowMs = Date.parse(nowText(options))
  const rows = db.all<Record<string, unknown>>(
    'SELECT dimension, value, updated_at FROM global_mood_state WHERE persona_id = ? ORDER BY dimension ASC',
    [personaId],
  )
  const meta = readMoodMeta(db, personaId)
  if (rows.length === 0) {
    return { personaId, values: defaultMoodValues(), updatedAt: null, meta }
  }
  const values: MoodValues = defaultMoodValues()
  let latest = 0
  for (const row of rows) {
    const dimension = String(row.dimension ?? '')
    const dimensionDef = moodDimensionOf(dimension)
    if (!dimensionDef) continue
    const value = Number(row.value ?? dimensionDef.baseline)
    const updatedAt = String(row.updated_at ?? '')
    const updatedMs = Date.parse(updatedAt)
    if (Number.isFinite(updatedMs)) latest = Math.max(latest, updatedMs)
    values[dimension] = decayMoodValue(dimension, value, Number.isFinite(updatedMs) ? nowMs - updatedMs : 0)
  }
  return {
    personaId,
    values,
    updatedAt: latest > 0 ? new Date(latest).toISOString() : null,
    meta,
  }
}

/**
 * 应用一轮情绪变化（写路径）。
 *
 * 事务语义：
 *   1) 确保初始化；
 *   2) 查 history 的 op_id 做幂等——已应用则原样返回 `replayed:true`，不写任何行；
 *   3) 读当前值 → 衰减到本次 now → 应用 deltas → clamp；
 *   4) 写 33 行 state（UPDATE 检查 changes=1）、33 行 history、1 行 meta（state_version+1）。
 */
export function applyMood(
  db: Db,
  input: MoodTransitionInput,
  deps: MoodTransitionDeps = {},
): MoodTransitionResult {
  const opId = clean(input.opId, 120)
  if (opId === '') {
    throw new PsycheError(CODE.validation, '情绪变更必须带 opId', { opId: input.opId })
  }
  // deltas 是变化量（可负），不能套用 0–100 的绝对值校验；只校验维度已知、数值有限、单次幅度不跨满量程。
  for (const [dimension, delta] of Object.entries(input.deltas)) {
    if (!moodDimensionOf(dimension)) {
      throw new PsycheError(CODE.validation, '情绪变更包含未知维度', { dimension })
    }
    if (typeof delta !== 'number' || !Number.isFinite(delta)) {
      throw new PsycheError(CODE.validation, '情绪变更值必须是有限数字', { dimension, delta })
    }
    if (Math.abs(delta) > 100) {
      throw new PsycheError(CODE.validation, '单次情绪变化幅度不能超过满量程', { dimension, delta })
    }
  }
  const personaId = MOOD_PERSONA_ID
  const now = nowText({ now: input.now }, deps)
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) {
    throw new PsycheError(CODE.validation, '情绪变更时间不合法', { now })
  }
  const reason = clean(input.reason, 200) || null

  return db.transaction((): MoodTransitionResult => {
    ensureMoodInitialized(db, { personaId, now })
    const replayed = db.get<Record<string, unknown>>(
      'SELECT history_id FROM global_mood_history WHERE persona_id = ? AND op_id = ? LIMIT 1',
      [personaId, opId],
    )
    if (replayed) {
      const meta = readMoodMeta(db, personaId)
      const state = loadMood(db, { personaId, now })
      return {
        applied: false,
        replayed: true,
        stateVersion: meta?.stateVersion ?? 0,
        values: state.values,
        updatedAt: state.updatedAt ?? now,
      }
    }

    const rows = db.all<Record<string, unknown>>(
      'SELECT dimension, value, updated_at FROM global_mood_state WHERE persona_id = ?',
      [personaId],
    )
    const values: MoodValues = defaultMoodValues()
    for (const row of rows) {
      const dimension = String(row.dimension ?? '')
      const dimensionDef = moodDimensionOf(dimension)
      if (!dimensionDef) continue
      const updatedMs = Date.parse(String(row.updated_at ?? ''))
      const elapsed = Number.isFinite(updatedMs) ? nowMs - updatedMs : 0
      values[dimension] = decayMoodValue(dimension, Number(row.value ?? dimensionDef.baseline), elapsed)
    }

    for (const [dimension, delta] of Object.entries(input.deltas)) {
      const dimensionDef = moodDimensionOf(dimension)
      if (!dimensionDef) continue
      values[dimension] = clampMood((values[dimension] ?? dimensionDef.baseline) + delta, dimensionDef.min, dimensionDef.max)
    }

    for (const key of MOOD_KEYS) {
      const value = values[key] ?? 0
      const updated = db.run(
        'UPDATE global_mood_state SET value = ?, updated_at = ? WHERE persona_id = ? AND dimension = ?',
        [value, now, personaId, key],
      )
      if (updated.changes !== 1) {
        throw new PsycheError(CODE.internal, '情绪状态行更新失败（可能被并发删除）', { personaId, dimension: key })
      }
      db.run(
        `INSERT INTO global_mood_history (persona_id, dimension, value, reason, at, op_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [personaId, key, value, reason, now, opId],
      )
    }

    const meta = readMoodMeta(db, personaId)
    const nextVersion = (meta?.stateVersion ?? 0) + 1
    const updatedMeta = db.run(
      'UPDATE mood_meta SET state_version = ?, last_op_id = ?, updated_at = ? WHERE persona_id = ?',
      [nextVersion, opId, now, personaId],
    )
    if (updatedMeta.changes !== 1) {
      throw new PsycheError(CODE.internal, '情绪元数据更新失败（可能被并发删除）', { personaId })
    }

    return { applied: true, replayed: false, stateVersion: nextVersion, values, updatedAt: now }
  }, { important: true })
}

/**
 * 导入旧 dsh-mood 的初始快照（可选）。
 *
 * 语义：只导入一次初始状态，不伪造历史变化记录。
 *   - 只处理能映射到 33 维的字段，其余记 warning；
 *   - 值按维度 min/max clamp；
 *   - 幂等：meta.last_op_id = 'legacy-import' 时直接跳过；
 *   - 不写 global_mood_history（旧日志不是本系统的事件流）。
 */
export function importLegacyMood(
  db: Db,
  snapshot: LegacyMoodSnapshot,
  options: MoodStoreOptions = {},
): LegacyMoodImportResult {
  const personaId = personaOf(options)
  const now = nowText(options)
  const warnings: string[] = []
  const values = defaultMoodValues()
  let applied = 0
  for (const [key, raw] of Object.entries(snapshot.values ?? {})) {
    const dimensionDef = moodDimensionOf(key)
    if (!dimensionDef) {
      warnings.push(`未知情绪维度已忽略：${key}`)
      continue
    }
    const numeric = Number(raw)
    if (!Number.isFinite(numeric)) {
      warnings.push(`维度 ${key} 的值不是有限数，已用默认值`)
      continue
    }
    values[key] = clampMood(numeric, dimensionDef.min, dimensionDef.max)
    applied += 1
  }

  return db.transaction((): LegacyMoodImportResult => {
    ensureMoodInitialized(db, { personaId, now })
    const meta = readMoodMeta(db, personaId)
    if (meta?.lastOpId === 'legacy-import') {
      return { imported: false, applied: 0, warnings: ['已导入过旧情绪快照，跳过'] }
    }
    for (const key of MOOD_KEYS) {
      db.run('UPDATE global_mood_state SET value = ?, updated_at = ? WHERE persona_id = ? AND dimension = ?', [
        values[key] ?? 0,
        now,
        personaId,
        key,
      ])
    }
    const updatedMeta = db.run(
      'UPDATE mood_meta SET state_version = state_version + 1, last_op_id = ?, updated_at = ? WHERE persona_id = ?',
      ['legacy-import', now, personaId],
    )
    if (updatedMeta.changes !== 1) {
      throw new PsycheError(CODE.internal, '旧情绪快照导入失败（元数据行不存在）', { personaId })
    }
    return { imported: applied > 0, applied, warnings }
  }, { important: true })
}
