/**
 * G1-B：同一项目的只读 Brief。
 *
 * 口径（第 19 轮外部评审 Q4–Q6 冻结）：
 * - 只做读取与拼接，**零模型调用、不写库**。
 * - 解析顺序：当前会话的活动绑定 → Checkpoint（指定分支或 head）→ 生成文本。
 * - 保留顺序（空间不足时从后往前删）：当前任务 → 阻塞/下一步 →
 *   已确认的冻结决策 → 最近摘要 → 背景。本函数只产出前四段的正文，
 *   背景不进入 Brief（由调用方的 Recall 负责）。
 * - 软预算 300–500 中文字是**本函数自己**的裁剪目标；整个投影还要服从
 *   composer 的 8000 字符 / 6000 token 上限，所以这里先裁到软预算，
 *   再由 composer 统一计量。
 * - 按完整事项裁剪：一条「下一步」如果被压到无法执行，就整条省略并把
 *   原因写进 warnings，不产出半截句子。
 */
import { readCheckpoint, type CheckpointView, type Db } from 'dsh-psyche-core'

export const PROJECT_BRIEF_SOFT_CHARS = 500
export const PROJECT_BRIEF_MIN_CHARS = 300

export type ProjectBriefSkipReason =
  | 'no-db'
  | 'no-session'
  | 'no-binding'
  | 'no-checkpoint'
  | 'empty'

export interface ProjectBriefResult {
  /** 可直接拼进投影的正文；skip 时为 null。 */
  text: string | null
  /** 跳过原因；生成成功时为 null。 */
  skipped: ProjectBriefSkipReason | null
  projectId: string | null
  branchKey: string | null
  checkpointId: string | null
  revision: number | null
  /** 被裁掉的条目，供审计看到「为什么这一轮没看到某条下一步」。 */
  dropped: string[]
  /** 选中了但来源不可读的引用数（披露检查结果）。 */
  hiddenReferences: number
}

interface BindingRow {
  projectId: string
  branchKey: string | null
}

/** Brief 只读，不持有连接；这里只要 get/all 两个方法。 */
type BriefDatabase = Pick<Db, 'get' | 'all'>

function skipped(reason: ProjectBriefSkipReason): ProjectBriefResult {
  return {
    text: null,
    skipped: reason,
    projectId: null,
    branchKey: null,
    checkpointId: null,
    revision: null,
    dropped: [],
    hiddenReferences: 0,
  }
}

/**
 * 找出这个会话当前绑定的项目。同一 (persona, platform, session_ref) 只会
 * 有一条 `unbound_at IS NULL` 的行（库里有唯一索引兜着）。
 */
function activeBinding(
  db: BriefDatabase,
  sessionId: string,
  personaId: string,
  platform: string,
): BindingRow | null {
  const row = db.get<{ projectId: string }>(
    'SELECT project_id AS projectId FROM project_session_bindings ' +
      'WHERE persona_id = ? AND platform = ? AND session_ref = ? AND unbound_at IS NULL',
    [personaId, platform, sessionId],
  )
  if (row === undefined || typeof row.projectId !== 'string') return null
  return { projectId: row.projectId, branchKey: null }
}

/**
 * 来源披露检查：Brief 里点到的每个 Source 都必须仍然可读。
 * 这里只做「行是否存在、是否被 hard delete」这一层；更细的可见性由
 * Recall 自己的披露链路负责，本函数不重复实现。
 */
function countHiddenReferences(db: BriefDatabase, references: CheckpointView['references']): number {
  const sourceIds = references
    .map((item) => item.sourceId)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  if (sourceIds.length === 0) return 0
  // 占位符按数量拼，避免把 id 拼进 SQL 字符串。
  const placeholders = sourceIds.map(() => '?').join(', ')
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sources WHERE source_id IN (${placeholders})`,
    sourceIds,
  )
  const visible = Number(row?.n ?? 0)
  return sourceIds.length - visible
}

interface Section {
  label: string
  lines: string[]
  /** 裁剪优先级：数字越小越晚被删。 */
  weight: number
}

function renderSections(sections: Section[], limit: number): { text: string; dropped: string[] } {
  const dropped: string[] = []
  const active = sections.filter((section) => section.lines.length > 0)
  for (;;) {
    const body = active
      .map((section) => [`${section.label}：`, ...section.lines.map((line) => `- ${line}`)].join('\n'))
      .join('\n')
    if (body.length <= limit) return { text: body, dropped }
    // 每次砍掉权重最大（最不重要）那一段的最后一条；段落空了就整段省略。
    let target: Section | undefined
    for (const section of active) {
      if (section.lines.length === 0) continue
      if (target === undefined || section.weight > target.weight) target = section
    }
    if (target === undefined) return { text: body.slice(0, limit), dropped }
    const removed = target.lines.pop()
    if (removed !== undefined) dropped.push(`${target.label}/${removed}`)
  }
}

/**
 * 生成 Brief。任何一步缺失都返回 `skipped`，调用方据此保持沉默而不是抛出。
 */
export function buildProjectBrief(options: {
  db: Db | null
  sessionId: string | null
  projectId?: string | null
  branchKey?: string | null
  personaId?: string
  platform?: string
  softLimit?: number
}): ProjectBriefResult {
  const { db, sessionId } = options
  if (db === null) return skipped('no-db')
  const personaId = options.personaId ?? 'main'
  const platform = options.platform ?? 'desktop'

  // 1) 绑定优先级最高：显式传了 projectId 就用它，否则按会话查绑定。
  let projectId = options.projectId ?? null
  let branchKey = options.branchKey ?? null
  if (projectId === null) {
    if (sessionId === null || sessionId.length === 0) return skipped('no-session')
    const binding = activeBinding(db, sessionId, personaId, platform)
    if (binding === null) return skipped('no-binding')
    projectId = binding.projectId
  }

  // 2) 读 Checkpoint（head 或指定分支）。
  let view: CheckpointView | null = null
  try {
    view = readCheckpoint(db, branchKey === null ? { projectId } : { projectId, branchKey })
  } catch {
    return skipped('no-checkpoint')
  }
  if (view === null || view.revision === null) return skipped('no-checkpoint')
  if (branchKey === null) branchKey = view.branchKey

  const revision = view.revision
  const hiddenReferences = countHiddenReferences(db, view.references)

  // 3) 组装。顺序即保留顺序。
  const sections: Section[] = [
    {
      label: '当前任务',
      weight: 0,
      lines: revision.currentGoal === null || revision.currentGoal.trim().length === 0
        ? []
        : [revision.currentGoal.trim()],
    },
    {
      label: '还卡在哪',
      weight: 1,
      lines: revision.blockers.map((item) => item.trim()).filter((item) => item.length > 0),
    },
    {
      label: '接下来',
      weight: 1,
      lines: revision.nextSteps.map((item, index) => `${index + 1}. ${item.trim()}`).filter((item) => item.length > 3),
    },
    {
      label: '已经完成',
      weight: 2,
      lines: revision.completed.map((item) => item.trim()).filter((item) => item.length > 0),
    },
    {
      label: '已冻结的决策',
      weight: 3,
      lines: revision.decisions.map((item) => item.trim()).filter((item) => item.length > 0),
    },
  ]

  const limit = options.softLimit ?? PROJECT_BRIEF_SOFT_CHARS
  const header = `项目 ${projectId}${branchKey === null || branchKey.length === 0 ? '' : ` / 分支 ${branchKey}`}` +
    `（Checkpoint ${view.checkpointId} r${view.headRevision}）`
  const { text: body, dropped } = renderSections(sections, Math.max(limit - header.length - 1, 80))
  if (body.length === 0) return skipped('empty')

  const footer = hiddenReferences > 0
    ? `\n（有 ${hiddenReferences} 条引用的来源当前不可读，相关结论按未核实处理）`
    : ''

  return {
    text: `${header}\n${body}${footer}`,
    skipped: null,
    projectId,
    branchKey,
    checkpointId: view.checkpointId,
    revision: view.headRevision,
    dropped,
    hiddenReferences,
  }
}
