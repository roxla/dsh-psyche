// Diary v1 存储层（P2 Completion Batch 阶段 5，schema v18）。
//
// 定位：Diary 是**派生叙事**，不是事实源。这里只负责：
//   1) 按 (persona, scope_key, local_date) 维护稳定身份；
//   2) 版本 append-only（重生成只追加，不 UPDATE 历史正文）；
//   3) 把 head 正文写进现有 fts_index（kind='diary'），供 Diary Recall 复用同一套 FTS。
//
// 不变量：
//   - 一条 diary 的 head_version = diary_versions 里最大的 version；
//   - 同一 (persona, scope_key, local_date) 只有一条 diary；
//   - 版本行一旦写入不可修改；「无实质变化不新增版本」由 content_hash 判断；
//   - 壳、版本、FTS 三处写入必须在同一事务里，失败一起回滚。
import { newId, PREFIX, stableStringify } from './ids.js'
import { CODE, PsycheError } from './errors.js'
import type { Db } from './adapter.js'
import { upsertFtsRow, deleteFtsRow } from './fts.js'

/** 日记的归属范围：全局 / 某个 Contact / 某个 Room（至多一个非空）。 */
export interface DiaryScope {
  contactId?: string | null
  roomId?: string | null
}

/** 日记正文引用的来源。`refRevision` 只对 artifact 有意义。 */
export interface DiarySourceRef {
  refType: 'artifact' | 'event' | 'tension' | 'source'
  refId: string
  refRevision?: number | null
}

export interface DiaryRecord {
  diaryId: string
  personaId: string
  scopeKey: string
  contactId: string | null
  roomId: string | null
  localDate: string
  periodStart: number
  periodEnd: number
  timezone: string
  headVersion: number
  sourceDigest: string
  createdAt: string
  updatedAt: string
}

export interface DiaryVersionRecord {
  diaryId: string
  version: number
  body: string
  sourceRefs: DiarySourceRef[]
  tensionRefs: string[]
  algorithmVersion: string
  contentHash: string
  createdAt: string
}

export interface DiaryHead {
  diary: DiaryRecord
  version: DiaryVersionRecord | null
}

export interface UpsertDiaryInput {
  scope: DiaryScope
  localDate: string
  periodStart: number
  periodEnd: number
  timezone: string
  body: string
  sourceRefs: DiarySourceRef[]
  tensionRefs?: string[]
  algorithmVersion: string
  contentHash: string
  sourceDigest: string
  now: string
}

export interface DiaryUpsertResult {
  diaryId: string
  version: number
  created: boolean
  updated: boolean
}

export interface DiaryFilter {
  contactId?: string | null
  localDate?: string
  limit?: number
}

const MAX_BODY = 200_000
const MAX_REFS = 200

function clean(value: string | null | undefined, max: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
    .trim()
    .slice(0, max)
}

/** scope → 稳定字符串键。只允许一个非空，避免「既属于 Contact 又属于 Room」的歧义。 */
export function diaryScopeKey(scope: DiaryScope): string {
  const contact = clean(scope.contactId, 64)
  const room = clean(scope.roomId, 64)
  if (contact !== '' && room !== '') {
    throw new PsycheError(CODE.validation, '日记范围只能属于 Contact 或 Room 之一', { contact, room })
  }
  if (contact !== '') return `contact:${contact}`
  if (room !== '') return `room:${room}`
  return 'global'
}

function scopeColumns(key: string): { contactId: string | null; roomId: string | null } {
  if (key.startsWith('contact:')) return { contactId: key.slice('contact:'.length), roomId: null }
  if (key.startsWith('room:')) return { contactId: null, roomId: key.slice('room:'.length) }
  return { contactId: null, roomId: null }
}

function rowToDiary(row: Record<string, unknown>): DiaryRecord {
  return {
    diaryId: String(row.diary_id),
    personaId: String(row.persona_id),
    scopeKey: String(row.scope_key),
    contactId: row.contact_id == null ? null : String(row.contact_id),
    roomId: row.room_id == null ? null : String(row.room_id),
    localDate: String(row.local_date),
    periodStart: Number(row.period_start),
    periodEnd: Number(row.period_end),
    timezone: String(row.timezone),
    headVersion: Number(row.head_version),
    sourceDigest: String(row.source_digest),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function parseRefs(raw: unknown): DiarySourceRef[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item) => ({
        refType: String(item.refType) as DiarySourceRef['refType'],
        refId: String(item.refId),
        refRevision: item.refRevision == null ? null : Number(item.refRevision),
      }))
      .filter((item) => item.refId !== '')
  } catch {
    return []
  }
}

function parseIds(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function rowToVersion(row: Record<string, unknown>): DiaryVersionRecord {
  return {
    diaryId: String(row.diary_id),
    version: Number(row.version),
    body: String(row.body),
    sourceRefs: parseRefs(row.source_refs),
    tensionRefs: parseIds(row.tension_refs),
    algorithmVersion: String(row.algorithm_version),
    contentHash: String(row.content_hash),
    createdAt: String(row.created_at),
  }
}

/** 按 (persona, scope, date) 找 shell；找不到返回 null。 */
export function loadDiaryByKey(
  db: Db,
  scopeKey: string,
  localDate: string,
  personaId = 'main',
): DiaryRecord | null {
  const row = db.get<Record<string, unknown>>(
    'SELECT * FROM diaries WHERE persona_id = ? AND scope_key = ? AND local_date = ?',
    [personaId, scopeKey, localDate],
  )
  return row ? rowToDiary(row) : null
}

/** 读一条 diary 的 head（壳 + head 版本）；不存在返回 null。 */
export function readDiary(db: Db, diaryId: string, version?: number | null): DiaryHead | null {
  const id = clean(diaryId, 80)
  if (id === '') return null
  const shell = db.get<Record<string, unknown>>('SELECT * FROM diaries WHERE diary_id = ?', [id])
  if (!shell) return null
  const diary = rowToDiary(shell)
  const target = version == null ? diary.headVersion : Number(version)
  const row = db.get<Record<string, unknown>>(
    'SELECT * FROM diary_versions WHERE diary_id = ? AND version = ?',
    [id, target],
  )
  return { diary, version: row ? rowToVersion(row) : null }
}

export function listDiaries(db: Db, filter: DiaryFilter = {}): DiaryRecord[] {
  const where: string[] = []
  const params: Array<string | number> = []
  if (filter.localDate) {
    where.push('local_date = ?')
    params.push(clean(filter.localDate, 10))
  }
  if (filter.contactId !== undefined) {
    if (filter.contactId === null) {
      where.push("scope_key = 'global'")
    } else {
      where.push('scope_key = ?')
      params.push(`contact:${clean(filter.contactId, 64)}`)
    }
  }
  const limit = Math.max(1, Math.min(200, Number(filter.limit ?? 50)))
  const sql =
    `SELECT * FROM diaries ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}` +
    ' ORDER BY local_date DESC, diary_id ASC LIMIT ?'
  return db.all<Record<string, unknown>>(sql, [...params, limit]).map(rowToDiary)
}

/**
 * 写入（或追加）一个 diary 版本。
 *
 * 行为：
 *   - 没有壳 → 新建壳，version 1；
 *   - 有壳且 content_hash 相同 → 不新增版本（`updated:false`），返回现有 head；
 *   - 有壳且 hash 不同 → 追加 version+1，更新 head_version / source_digest / updated_at；
 *   - 壳、版本、FTS 在同一事务，失败整体回滚。
 */
export function upsertDiary(db: Db, input: UpsertDiaryInput): DiaryUpsertResult {
  const scopeKey = diaryScopeKey(input.scope)
  const { contactId, roomId } = scopeColumns(scopeKey)
  const localDate = clean(input.localDate, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(localDate)) {
    throw new PsycheError(CODE.validation, '日记日期必须是 YYYY-MM-DD', { localDate })
  }
  const body = clean(input.body, MAX_BODY)
  if (body === '') throw new PsycheError(CODE.validation, '日记正文不能为空')
  const sourceRefs = input.sourceRefs.slice(0, MAX_REFS)
  const tensionRefs = (input.tensionRefs ?? []).slice(0, MAX_REFS)
  const timezone = clean(input.timezone, 60) || 'Asia/Shanghai'

  return db.transaction((): DiaryUpsertResult => {
    const existing = loadDiaryByKey(db, scopeKey, localDate)
    if (existing && existing.headVersion > 0) {
      const head = readDiary(db, existing.diaryId)
      if (head?.version && head.version.contentHash === input.contentHash) {
        return { diaryId: existing.diaryId, version: head.version.version, created: false, updated: false }
      }
    }

    const diaryId = existing?.diaryId ?? newId(PREFIX.diary)
    const version = (existing?.headVersion ?? 0) + 1

    if (!existing) {
      db.run(
        `INSERT INTO diaries
           (diary_id, persona_id, scope_key, contact_id, room_id, local_date, period_start, period_end,
            timezone, head_version, source_digest, created_at, updated_at)
         VALUES (?, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          diaryId,
          scopeKey,
          contactId,
          roomId,
          localDate,
          Math.trunc(input.periodStart),
          Math.trunc(input.periodEnd),
          timezone,
          version,
          input.sourceDigest,
          input.now,
          input.now,
        ],
      )
    } else {
      db.run(
        `UPDATE diaries
            SET head_version = ?, source_digest = ?, updated_at = ?
          WHERE diary_id = ?`,
        [version, input.sourceDigest, input.now, diaryId],
      )
    }

    db.run(
      `INSERT INTO diary_versions
         (diary_id, version, body, source_refs, tension_refs, algorithm_version, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        diaryId,
        version,
        body,
        stableStringify(sourceRefs),
        stableStringify(tensionRefs),
        clean(input.algorithmVersion, 40) || 'diary-v1',
        clean(input.contentHash, 80),
        input.now,
      ],
    )

    // head 正文写进现有 FTS（kind='diary'）——复用 upsert/delete 的映射表，不建第二套索引。
    upsertFtsRow(db, { artifactId: diaryId, kind: 'diary', statement: body })

    return { diaryId, version, created: !existing, updated: Boolean(existing) }
  }, { important: true })
}

/** 删除一条日记（仅供测试与一次性清理；生产不提供物理删除入口）。 */
export function deleteDiary(db: Db, diaryId: string): boolean {
  const id = clean(diaryId, 80)
  if (id === '') return false
  return db.transaction(() => {
    const exists = db.get<{ diary_id: string }>('SELECT diary_id FROM diaries WHERE diary_id = ?', [id])
    if (!exists) return false
    deleteFtsRow(db, id)
    db.run('DELETE FROM diaries WHERE diary_id = ?', [id])
    return true
  }, { important: true })
}

/**
 * 计算某个 IANA 时区下「某一天」的日期与 UTC 毫秒区间。
 *
 * 不使用运行机器的本地时区：`Intl.DateTimeFormat` 只按传入的 timeZone 换算。
 * 区间算法：取该时区下 YYYY-MM-DD 的 00:00，再用「该时刻的时区偏移」换回 UTC；
 * 偏移在 DST 切换日会变，所以迭代两次收敛。
 */
export function resolveDiaryDate(
  now: Date,
  timezone: string,
): { localDate: string; periodStart: number; periodEnd: number } {
  const tz = timezone.trim() || 'Asia/Shanghai'
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const localDate = fmt.format(now)
  const [year, month, day] = localDate.split('-').map((part) => Number(part))

  // 把「某时区下这一天的 00:00」换算成 UTC ms：
  // 先用朴素 UTC 猜测，再用该猜测时刻的时区偏移校正；DST 切换日迭代两次足够收敛。
  const zonedMidnight = (y: number, m: number, d: number): number => {
    const naive = Date.UTC(y, m - 1, d)
    let guess = naive
    for (let i = 0; i < 2; i += 1) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(new Date(guess))
      const value = (type: string): number => {
        const part = parts.find((item) => item.type === type)
        return part ? Number(part.value) : 0
      }
      const hour = value('hour') === 24 ? 0 : value('hour')
      const wallClock = Date.UTC(value('year'), value('month') - 1, value('day'), hour, value('minute'), value('second'))
      // offset = 本地钟面 - UTC（东八区是 +8h）；用 naive - offset 把本地零点的钟面换回 UTC。
      const offset = wallClock - guess
      guess = naive - offset
    }
    return guess
  }

  const next = new Date(Date.UTC(year, month - 1, day + 1))
  const periodStart = zonedMidnight(year, month, day)
  const periodEnd = zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())
  return { localDate, periodStart, periodEnd: periodEnd > periodStart ? periodEnd : periodStart + 86_400_000 }
}
