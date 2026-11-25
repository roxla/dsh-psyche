/**
 * QQ 页「待投递提醒」只读视图（第 12 轮评审要求）。
 *
 * 展示的「预计最早发送时间」有两个来源，选错就会给用户看旧时间：
 *   - 还没入队 → 提醒行的 `next_attempt_at`（`dispatchDueReminders` 算出来的下一次可试时刻）；
 *   - 已经入队 → **关联队列行的 `retry_at`**（规则变化后由 `refreshDeferredReplies` 改的就是它）。
 * 所以这里先看队列行，队列行没挂上才退回提醒行。暂停期间两个来源都是远未来占位，
 * 对外只说「暂无可用发送时段」，不把占位时刻当预计时间显示。
 *
 * 只读：不写库、不改任何状态；上限与列表工具一致（最近 20 条里最多 8 条）。
 *
 * `delivery_state` 只认 `unsupported`（还没入队）与 `pending`（已入队）。第 13 轮评审点名的坑：
 * 发送结果不确定的行是 `pending/unknown/unknown`，`status` 仍是 `pending`，如果不过滤
 * `delivery_state`，这种「不知道发没发出去」的提醒会被算进「待投递」并显示「下一轮就发」——
 * 对未发生的投递做承诺。它既不展示也不计数，等人工裁决。
 */

/** 「暂无可用发送时段」用的远未来占位（与 `reminder-delivery.ts` 同值，避免跨包依赖）。 */
const NO_REPLY_WINDOW_AT = '9999-12-31T23:59:59.999Z'

/** 会被这张卡片展示的投递状态：等待入队 / 已入队等待发送。`unknown` 与 `sent` 都不在此列。 */
const VISIBLE_DELIVERY_STATES = "('unsupported', 'pending')"

export type PendingReminderState = 'due' | 'queued' | 'waiting' | 'paused'

export interface PendingReminderItem {
  reminderId: string
  /** 用户原定的时间。任何分支都不改写它。 */
  dueAt: string
  /** 预计最早发送时间；`null` 表示「现在就能发」或「暂无可用发送时段」，看 `state`。 */
  scheduledAt: string | null
  state: PendingReminderState
}

export interface PendingRemindersView {
  items: PendingReminderItem[]
  /** 库里还在等待投递的提醒总数（不受 `limit` 影响）。 */
  total: number
  /**
   * P1-C：结果不确定、等 Owner 裁决的提醒条数。
   * 它们不进 `items`/`total`（不能对未发生的投递做承诺），但也不能凭空消失——
   * 计数让用户知道「有 N 条要我自己确认」，再用 `psyche_resolve_delivery` 裁决。
   */
  awaitingVerdict: number
}

interface ReminderRowShape {
  reminder_id: string
  due_at: string
  next_attempt_at: string | null
}

interface OutboxRowShape {
  reminder_id: string
  retry_at: string | null
  status: string
}

export interface BuildPendingRemindersInput {
  db: {
    all<T>(sql: string, params?: readonly (string | number | null)[]): T[]
  }
  personaId: string
  limit?: number
}

function stateOf(row: ReminderRowShape, queued: OutboxRowShape | undefined): PendingReminderItem {
  const base = { reminderId: row.reminder_id, dueAt: row.due_at }
  if (queued !== undefined) {
    if (queued.retry_at === null) {
      // 已入队且在窗口内：下一轮扫描就会发，没有「预计时间」可给。
      return { ...base, scheduledAt: null, state: 'queued' }
    }
    if (queued.retry_at === NO_REPLY_WINDOW_AT) {
      return { ...base, scheduledAt: null, state: 'paused' }
    }
    return { ...base, scheduledAt: queued.retry_at, state: 'waiting' }
  }
  if (row.next_attempt_at === null) return { ...base, scheduledAt: null, state: 'due' }
  if (row.next_attempt_at === NO_REPLY_WINDOW_AT) {
    return { ...base, scheduledAt: null, state: 'paused' }
  }
  return { ...base, scheduledAt: row.next_attempt_at, state: 'waiting' }
}

export function buildPendingReminders(input: BuildPendingRemindersInput): PendingRemindersView {
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 20)
  // 第 57 轮 P1-E：只统计 QQ 渠道。桌面提醒没有自动投递通道（派发只取 channels: ['qq']），
  // 放进 items/total 会占额度、还会被渲染成「下一轮就发」——先限定渠道，再排序与 LIMIT。
  const rows = input.db.all<ReminderRowShape>(
    `SELECT reminder_id, due_at, next_attempt_at FROM reminders
      WHERE persona_id = ? AND channel = 'qq' AND status = 'pending'
        AND COALESCE(delivery_state, 'unsupported') IN ${VISIBLE_DELIVERY_STATES}
      ORDER BY due_at ASC, reminder_id ASC
      LIMIT ?`,
    [input.personaId, limit],
  )
  const total = input.db.all<{ n: number }>(
    `SELECT count(*) AS n FROM reminders
      WHERE persona_id = ? AND channel = 'qq' AND status = 'pending'
        AND COALESCE(delivery_state, 'unsupported') IN ${VISIBLE_DELIVERY_STATES}`,
    [input.personaId],
  )[0]?.n ?? 0
  const awaiting = input.db.all<{ n: number }>(
    `SELECT count(*) AS n FROM reminders
      WHERE persona_id = ? AND status = 'pending' AND delivery_state = 'unknown'`,
    [input.personaId],
  )
  const queued = new Map<string, OutboxRowShape>()
  if (rows.length > 0) {
    const ids = rows.map((row) => row.reminder_id)
    const placeholders = ids.map(() => '?').join(', ')
    const linked = input.db.all<OutboxRowShape>(
      `SELECT reminder_id, retry_at, status FROM qq_reply_outbox
        WHERE reminder_id IN (${placeholders}) AND status IN ('pending', 'dispatching')`,
      ids,
    )
    for (const row of linked) queued.set(row.reminder_id, row)
  }
  return {
    items: rows.map((row) => stateOf(row, queued.get(row.reminder_id))),
    total: Number(total),
    awaitingVerdict: Number(awaiting[0]?.n ?? 0),
  }
}
