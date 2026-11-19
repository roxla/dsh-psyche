// Diary v1 生成层（P2 Completion Batch 阶段 5）。
//
// 输入只读：当天的 events / artifact head revisions / 未解决 Tension。
// 输出是「确定性模板拼出的派生叙事」，不调用模型——v1 先保证可测、可复现、可追溯。
//
// 七种输入的处理（设计 §3）：
//   有内容 → 生成；无内容 → skipped 'no-content'；
//   未解决 Tension → 保留「还没落定」段并记 tension_refs；
//   新增证据但叙事无实质变化 → upsert 的 content_hash 相同，不新增版本；
//   历史证据修订 → source_digest 变化，追加新版本；
//   重复执行 → 幂等；中途失败 → 事务回滚（upsertDiary 内部已经把壳/版本/FTS 包在一起）。
import { createHash } from 'node:crypto'
import { CODE, PsycheError } from './errors.js'
import type { Db } from './adapter.js'
import { resolveDiaryDate, upsertDiary, type DiaryScope, type DiarySourceRef } from './diary-store.js'
import {
  ACTOR_CORE,
  appendDecisionItems,
  createDecision,
  finalizeDecision,
  getDecision,
} from './decision-store.js'

export const DIARY_ALGORITHM_VERSION = 'diary-v1'

export interface GenerateDiaryInput {
  scope: DiaryScope
  /** 生成哪一天；默认取 now 在该时区下的当天。 */
  date?: string | null
  timezone?: string
  now?: Date
}

export interface DiaryGenerationResult {
  diaryId: string | null
  version: number | null
  created: boolean
  updated: boolean
  skipped?: 'no-content'
  sourceCount: number
  tensionCount: number
}

interface DayEvent {
  eventId: string
  type: string
  at: string
  text: string
  roomId: string | null
}

interface DayArtifact {
  artifactId: string
  revision: number
  statement: string
  state: string
}

interface OpenTension {
  tensionId: string
  kind: string
  left: string
  right: string
  status: string
}

const MAX_EVENTS = 12
const MAX_ARTIFACTS = 8
const MAX_TENSIONS = 3

function clip(text: string, max: number): string {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function scopeLabel(scope: DiaryScope): string {
  if (scope.contactId) return `你和 ${scope.contactId}`
  if (scope.roomId) return `群里（${scope.roomId}）`
  return '全局'
}

function clockOf(at: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(at))
  } catch {
    return at.slice(11, 16)
  }
}

function digestOf(body: string, refs: DiarySourceRef[], tensions: string[]): string {
  return createHash('sha256')
    .update(body)
    .update('|')
    .update(JSON.stringify(refs))
    .update('|')
    .update(JSON.stringify(tensions))
    .digest('hex')
}

/**
 * 生成（或更新）某一天的日记。
 *
 * 参数：
 *   - `scope`：归属范围（Contact / Room / 全局）；
 *   - `date`：YYYY-MM-DD；省略时按 `timezone` 取 now 的当天；
 *   - `timezone`：IANA 名，默认 `Asia/Shanghai`（不读机器本地时区）。
 *
 * 返回：`skipped:'no-content'` 表示当天没有任何可记内容（不生成虚假日记）。
 */
export async function generateDiary(db: Db, input: GenerateDiaryInput): Promise<DiaryGenerationResult> {
  const now = input.now ?? new Date()
  const timezone = (input.timezone ?? 'Asia/Shanghai').trim() || 'Asia/Shanghai'
  const resolved = resolveDiaryDate(now, timezone)
  const localDate = input.date?.trim() || resolved.localDate
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(localDate)) {
    throw new PsycheError(CODE.validation, '日记日期必须是 YYYY-MM-DD', { localDate })
  }
  const { periodStart, periodEnd } =
    input.date == null ? resolved : resolveDiaryDate(new Date(`${localDate}T12:00:00Z`), timezone)

  const scopeKeyContact = input.scope.contactId?.trim() || null
  const scopeKeyRoom = input.scope.roomId?.trim() || null

  const events = loadDayEvents(db, periodStart, periodEnd, scopeKeyContact, scopeKeyRoom)
  const artifacts = loadDayArtifacts(db, periodStart, periodEnd, scopeKeyContact, scopeKeyRoom)
  const tensions = loadOpenTensions(db, periodStart, periodEnd, scopeKeyContact, scopeKeyRoom)

  if (events.length === 0 && artifacts.length === 0) {
    return {
      diaryId: null,
      version: null,
      created: false,
      updated: false,
      skipped: 'no-content',
      sourceCount: 0,
      tensionCount: tensions.length,
    }
  }

  const refs: DiarySourceRef[] = [
    ...artifacts.map((item) => ({
      refType: 'artifact' as const,
      refId: item.artifactId,
      refRevision: item.revision,
    })),
    ...events.map((item) => ({ refType: 'event' as const, refId: item.eventId, refRevision: null })),
    ...tensions.map((item) => ({ refType: 'tension' as const, refId: item.tensionId, refRevision: null })),
  ]
  const tensionRefs = tensions.map((item) => item.tensionId)

  const sections: string[] = []
  sections.push(`${localDate} · ${scopeLabel(input.scope)}`, '')
  if (events.length > 0) {
    sections.push('【这一天】')
    for (const event of events) {
      sections.push(`- ${clockOf(event.at, timezone)} 你说：「${clip(event.text, 60)}」 [${event.eventId}]`)
    }
    sections.push('')
  }
  if (artifacts.length > 0) {
    sections.push('【记下的事】')
    for (const item of artifacts) {
      sections.push(`- ${clip(item.statement, 120)} [${item.artifactId}@${item.revision}]`)
    }
    sections.push('')
  }
  if (tensions.length > 0) {
    sections.push('【还没落定】')
    for (const item of tensions) {
      sections.push(
        `- ${clip(item.left, 60)} 与 ${clip(item.right, 60)} 还没有对上（${item.kind}，状态 ${item.status}） [${item.tensionId}]`,
      )
    }
    sections.push('')
  }
  const body = sections.join('\n').trim()
  const contentHash = digestOf(body, refs, tensionRefs)
  const sourceDigest = createHash('sha256').update(JSON.stringify(refs)).digest('hex').slice(0, 32)

  const written = upsertDiary(db, {
    scope: input.scope,
    localDate,
    periodStart,
    periodEnd,
    timezone,
    body,
    sourceRefs: refs,
    tensionRefs,
    algorithmVersion: DIARY_ALGORITHM_VERSION,
    contentHash,
    sourceDigest,
    now: now.toISOString(),
  })

  // 只有真正新增了版本才记决策回执；同 hash 重跑不产生第二条回执。
  if (written.created || written.updated) {
    await recordDiaryDecision(db, {
      diaryId: written.diaryId,
      version: written.version,
      refs: refs.map((item) => ({ refType: item.refType, refId: item.refId, refRevision: item.refRevision ?? null })),
      tensionRefs,
      sourceDigest,
      now: now.toISOString(),
    })
  }

  return {
    diaryId: written.diaryId,
    version: written.version,
    created: written.created,
    updated: written.updated,
    sourceCount: refs.length,
    tensionCount: tensions.length,
  }
}

function loadDayEvents(
  db: Db,
  start: number,
  end: number,
  contactId: string | null,
  roomId: string | null,
): DayEvent[] {
  const startIso = new Date(start).toISOString()
  const endIso = new Date(end).toISOString()
  const rows = db.all<Record<string, unknown>>(
    `SELECT event_id, type, at, text, room_id, subject_refs
       FROM events
      WHERE kind = 'interaction' AND at >= ? AND at < ?
        AND NOT EXISTS (SELECT 1 FROM room_message_seq m WHERE m.event_id=events.event_id)
      ORDER BY at ASC, event_id ASC
      LIMIT 400`,
    [startIso, endIso],
  )
  const filtered = rows.filter((row) => {
    if (contactId) {
      const subjects = String(row.subject_refs ?? '')
      return subjects.includes(contactId) || !subjects.includes('ct_')
    }
    if (roomId) {
      return row.room_id === roomId || row.room_id == null
    }
    return true
  })
  return filtered.slice(0, MAX_EVENTS).map((row) => ({
    eventId: String(row.event_id),
    type: String(row.type),
    at: String(row.at),
    text: String(row.text ?? ''),
    roomId: row.room_id == null ? null : String(row.room_id),
  }))
}

function loadDayArtifacts(
  db: Db,
  start: number,
  end: number,
  contactId: string | null,
  roomId: string | null,
): DayArtifact[] {
  const startIso = new Date(start).toISOString()
  const endIso = new Date(end).toISOString()
  const rows = db.all<Record<string, unknown>>(
    `SELECT r.artifact_id, r.revision, r.statement, r.state, r.subject_refs
       FROM artifact_revisions r
       JOIN artifacts a ON a.artifact_id = r.artifact_id
      WHERE r.created_at >= ? AND r.created_at < ?
        AND a.kind <> 'relationship'
        AND r.revision = (SELECT MAX(x.revision) FROM artifact_revisions x WHERE x.artifact_id = r.artifact_id)
        AND r.state IN ('active', 'challenged')
      ORDER BY r.created_at ASC, r.artifact_id ASC
      LIMIT 200`,
    [startIso, endIso],
  )
  const filtered = rows.filter((row) => {
    const subjects = String(row.subject_refs ?? '')
    if (contactId) return subjects.includes(contactId) || !subjects.includes('ct_')
    if (roomId) return true
    return true
  })
  return filtered.slice(0, MAX_ARTIFACTS).map((row) => ({
    artifactId: String(row.artifact_id),
    revision: Number(row.revision),
    statement: String(row.statement ?? ''),
    state: String(row.state),
  }))
}

function loadOpenTensions(
  db: Db,
  start: number,
  end: number,
  contactId: string | null,
  roomId: string | null,
): OpenTension[] {
  const startIso = new Date(start).toISOString()
  const endIso = new Date(end).toISOString()
  const rows = db.all<Record<string, unknown>>(
    `SELECT t.tension_id, t.kind, t.status, t.left_statement, t.right_statement, t.left_subjects, t.right_subjects
       FROM tension_versions t
      WHERE t.version = (SELECT MAX(x.version) FROM tension_versions x WHERE x.tension_id = t.tension_id)
        AND t.status IN ('open', 'investigating', 'parked')
        AND t.changed_at >= ? AND t.changed_at < ?
      ORDER BY t.changed_at ASC
      LIMIT 100`,
    [startIso, endIso],
  )
  const filtered = rows.filter((row) => {
    const subjects = `${String(row.left_subjects ?? '')}${String(row.right_subjects ?? '')}`
    if (contactId) return subjects.includes(contactId) || !subjects.includes('ct_')
    if (roomId) return true
    return true
  })
  return filtered.slice(0, MAX_TENSIONS).map((row) => ({
    tensionId: String(row.tension_id),
    kind: String(row.kind),
    left: String(row.left_statement ?? ''),
    right: String(row.right_statement ?? ''),
    status: String(row.status),
  }))
}

/**
 * Diary 生成 = 一次决策（kind='diary'）：来源是 Artifact/Event/Tension，结果是 diaryId + version。
 * 失败只 warn，不撤销已经成功持久化的 Diary——事实依据是写入本身，回执只是过程记录。
 */
async function recordDiaryDecision(
  db: Db,
  input: {
    diaryId: string
    version: number
    refs: Array<{ refType: string; refId: string; refRevision: number | null }>
    tensionRefs: string[]
    sourceDigest: string
    now: string
  },
): Promise<void> {
  try {
    const opId = `diary:${input.diaryId}:${input.version}`
    const shell = createDecision(db, {
      opId,
      kind: 'diary',
      actor: ACTOR_CORE,
      inputHash: input.sourceDigest,
      createdAt: input.now,
    })
    if (shell.created) {
      appendDecisionItems(
        db,
        shell.record.decisionId,
        input.refs.map((ref) => ({
          refType: ref.refType as 'artifact' | 'event' | 'tension' | 'source' | 'evidence' | 'diary',
          refId: ref.refId,
          refRevision: ref.refRevision,
        })),
        { now: () => input.now },
      )
    }
    const current = getDecision(db, shell.record.decisionId)
    if (current && current.run.status === 'pending') {
      finalizeDecision(
        db,
        shell.record.decisionId,
        {
          status: 'committed',
          reason: 'diary generated',
          resultDiaryId: input.diaryId,
          resultRevision: input.version,
        },
        { now: () => input.now },
      )
    }
  } catch (error) {
    process.stderr.write(`[psyche][diary] 决策回执写入失败（不影响日记）：${String(error)}\n`)
  }
}
