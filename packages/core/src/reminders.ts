import { randomUUID } from 'node:crypto'
import { PsycheError, CODE } from './errors.js'

/**
 * G5 提醒登记：用户明确让他「到点提醒我」这件事。
 *
 * 只做登记、查询、取消。到期派发不在本批——表里有 `delivery_state`，
 * 但登记时一律写 `unsupported`，界面据此显示「已登记，自动发送尚未启用」，
 * 不假装已经能送到手机上。
 *
 * 三条纪律，和关系入账同一套：
 * 1. **归属先确认**——接收者没有可归属身份时不写（`no-receiver`）；
 * 2. **重放不新增**——`(persona_id, request_id)` 唯一，重复请求返回原 ID；
 * 3. **取消可重放**——重复取消返回同一行，不报错、不改别人。
 */

export interface ReminderRow {
  reminder_id: string
  persona_id: string
  channel: 'desktop' | 'qq'
  contact_id: string | null
  session_ref: string | null
  due_at: string
  timezone: string
  text: string
  request_id: string
  status: 'pending' | 'cancelled' | 'fired' | 'failed'
  created_at: string
  updated_at: string
  cancelled_at: string | null
  fired_at: string | null
  delivery_state: 'unsupported' | 'pending' | 'sent' | 'unknown'
  last_attempt_at: string | null
  /**
   * 登记那一刻的授权代次；null 表示没有快照（迁移前的行）。
   *
   * 到期扫描时必须用这个值而不是现查——现查会让「登记→撤权→重授权→到期」
   * 的旧提醒拿到新代次合法发出。
   */
  access_epoch: number | null
  /**
   * 下一次可以尝试投递的时刻；null 表示没有被延后过。
   *
   * 第 56 轮 P1-B：撞上「允许回复时段」时不能判死，改记这一列等窗口开。
   * 它与 `due_at` 分开：`due_at` 是用户设的原定时间，不允许被改写。
   */
  next_attempt_at: string | null
}

/** 只用到 get / run 两个方法，测试里可以拿假实现替。 */
export interface ReminderDb {
  get<T>(sql: string, params?: readonly (string | number | null)[]): T | undefined
  all<T>(sql: string, params?: readonly (string | number | null)[]): T[]
  run(sql: string, params?: readonly (string | number | null)[]): unknown
  transaction<T>(fn: () => T): T
}

export interface ReminderReceiver {
  channel: 'desktop' | 'qq'
  contactId?: string | null
  sessionRef?: string | null
}

export interface CreateReminderInput {
  db: ReminderDb
  personaId: string
  receiver: ReminderReceiver
  dueAt: string
  timezone: string
  text: string
  /** 幂等键：同一次用户请求重放必须沿用同一个值。 */
  requestId: string
  /**
   * 登记那一刻的授权代次。
   *
   * 不给就写 null：迁移前的提醒没有快照，按「没有凭据」处理而不是补当前值。
   * 从别处推断（比如到期扫描时现查）都是错的——那会让「登记→撤权→重授权→到期」
   * 的旧提醒拿到新代次合法发出。
   */
  accessEpoch?: number | null
  now: string
}

export type ReminderStatus =
  | 'created'
  | 'replayed'
  | 'no-receiver'
  | 'bad-due'
  | 'empty-text'
  /**
   * 第 57 轮 P1-E：桌面提醒没有投递通道。
   *
   * 以前会照常落库，然后永远停在 `pending/unsupported`（派发只取 `channels: ['qq']`），
   * 卡片却按「没入队」渲染成「下一轮就发」——登记成功但永远不会发生。
   * 现在在入口就拒：零写入，工具如实说「本次未登记」。
   */
  | 'unsupported-channel'

export interface ReminderResult {
  status: ReminderStatus
  reminder?: ReminderRow
  reason?: string
}

const DUE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

/** 接收者的可归属身份：桌面要 sessionRef，QQ 要 contactId。 */
function receiverKey(receiver: ReminderReceiver): string | null {
  if (receiver.channel === 'qq') {
    const id = (receiver.contactId ?? '').trim()
    return id.length > 0 ? id : null
  }
  const ref = (receiver.sessionRef ?? '').trim()
  return ref.length > 0 ? ref : null
}

export function createReminder(input: CreateReminderInput): ReminderResult {
  const text = input.text.trim()
  if (text.length === 0) return { status: 'empty-text', reason: '提醒内容不能为空' }
  if (!DUE.test(input.dueAt)) {
    return { status: 'bad-due', reason: `到期时间必须是 UTC ISO 文本，收到 ${input.dueAt}` }
  }
  if (receiverKey(input.receiver) === null) {
    // 不写「都记到 Owner 名下」这种兜底：没有归属的提醒到了点不知道该发给谁。
    return { status: 'no-receiver', reason: '这个会话没有可归属的接收者' }
  }
  const requestId = input.requestId.trim()
  if (requestId.length === 0) {
    return { status: 'no-receiver', reason: '缺少请求标识，无法防重' }
  }
  if (input.receiver.channel === 'desktop') {
    // 零写入：没有渠道的提醒不该以「登记成功」的样子躺在列表里。
    return { status: 'unsupported-channel', reason: '当前不支持桌面自动提醒，本次未登记' }
  }

  return input.db.transaction(() => {
    const existing = input.db.get<ReminderRow>(
      'SELECT * FROM reminders WHERE persona_id = ? AND request_id = ?',
      [input.personaId, requestId],
    )
    if (existing) return { status: 'replayed', reminder: existing }

    const reminder: ReminderRow = {
      reminder_id: `rem_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      persona_id: input.personaId,
      channel: input.receiver.channel,
      contact_id: input.receiver.contactId ?? null,
      session_ref: input.receiver.sessionRef ?? null,
      due_at: input.dueAt,
      timezone: input.timezone,
      text,
      request_id: requestId,
      status: 'pending',
      created_at: input.now,
      updated_at: input.now,
      cancelled_at: null,
      fired_at: null,
      // 派发链路还没接：如实记 unsupported，而不是记 pending 假装快到了。
      delivery_state: 'unsupported',
      last_attempt_at: null,
      access_epoch: typeof input.accessEpoch === 'number' ? input.accessEpoch : null,
      next_attempt_at: null,
    }
    input.db.run(
      `INSERT INTO reminders (
         reminder_id, persona_id, channel, contact_id, session_ref, due_at, timezone,
         text, request_id, status, created_at, updated_at, cancelled_at, fired_at,
         delivery_state, last_attempt_at, access_epoch
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reminder.reminder_id,
        reminder.persona_id,
        reminder.channel,
        reminder.contact_id,
        reminder.session_ref,
        reminder.due_at,
        reminder.timezone,
        reminder.text,
        reminder.request_id,
        reminder.status,
        reminder.created_at,
        reminder.updated_at,
        reminder.cancelled_at,
        reminder.fired_at,
        reminder.delivery_state,
        reminder.last_attempt_at,
        reminder.access_epoch,
      ],
    )
    return { status: 'created', reminder }
  })
}

export interface CancelReminderInput {
  db: ReminderDb
  personaId: string
  reminderId: string
  /** 取消时也要校验归属：别人拿不到这个 ID，也不该能取消。 */
  receiver: ReminderReceiver
  now: string
}

/**
 * `in-flight` / `unknown` 是第 55 轮加的两个「取消不了」的结果：
 * - `in-flight`：Worker 已经领走这一条（队列行 `dispatching`），消息可能已经在路上。
 * - `unknown`：上一次投递结果不确定，只有 `resolveUnknown` 能裁定，普通取消不许改写。
 * 两者都是**零写入**：宁可回一句「没法确认」，也不能报成功而消息照发。
 */
export type CancelStatus =
  | 'cancelled'
  | 'replayed'
  | 'not-found'
  | 'no-permission'
  | 'in-flight'
  | 'unknown'

export function cancelReminder(input: CancelReminderInput): {
  status: CancelStatus
  reminder?: ReminderRow
} {
  const key = receiverKey(input.receiver)
  if (key === null) return { status: 'no-permission' }
  return input.db.transaction(() => {
    const row = input.db.get<ReminderRow>(
      'SELECT * FROM reminders WHERE persona_id = ? AND reminder_id = ?',
      [input.personaId, input.reminderId],
    )
    if (!row) return { status: 'not-found' as const }
    const mine =
      row.channel === input.receiver.channel &&
      ((row.channel === 'qq' && row.contact_id === input.receiver.contactId) ||
        (row.channel === 'desktop' && row.session_ref === input.receiver.sessionRef))
    if (!mine) return { status: 'no-permission' as const }
    if (row.status === 'cancelled') return { status: 'replayed' as const, reminder: row }
    if (row.status !== 'pending') {
      // 已经发出去或失败的提醒不能取消——重放也返回原状态，不假装撤销成功。
      return { status: 'replayed' as const, reminder: row }
    }
    // 结果不确定的提醒只能由 resolveUnknown 裁定（第 55 轮 A15）。
    if (row.delivery_state === 'unknown') return { status: 'unknown' as const, reminder: row }
    // 第 55 轮 A14：Worker 已经领走这一条时，写 cancelled 就是撒谎——消息可能已上路。
    // 零写入返回 in-flight，由调用方如实说「无法确认取消」。
    const inFlight = input.db.get<{ reply_id?: string | null }>(
      `SELECT reply_id FROM qq_reply_outbox
        WHERE persona_id = ? AND reminder_id = ? AND status = 'dispatching'
        LIMIT 1`,
      [input.personaId, input.reminderId],
    )
    if (inFlight !== undefined && inFlight !== null) {
      return { status: 'in-flight' as const, reminder: row }
    }
    // 取消是终态：`delivery_state` 必须从 pending 退回 unsupported、`delivery_result`
    // 清空，否则界面上还挂着「已排队」，而 dueReminders 也不会再扫到它。
    writeReminderOutcome({
      db: input.db,
      personaId: input.personaId,
      reminderId: input.reminderId,
      now: input.now,
      outcome: 'cancelled',
    })
    // 第 53 轮 P1-A：取消要连带撤掉还没发出去的队列行，否则 worker 仍会发。
    // 只在「取消确实生效」之后做，且只碰 pending —— 已 dispatching/unknown 的行
    // 交给 worker 的提醒复核去拦（取消那一刻它可能已经在发送路上）。
    input.db.run(
      `UPDATE qq_reply_outbox
          SET status = 'cancelled', last_error_code = 'reminder_cancelled',
              terminal_at = ?, updated_at = ?
        WHERE persona_id = ? AND reminder_id = ? AND status = 'pending'`,
      [input.now, input.now, input.personaId, input.reminderId],
    )
    const updated = input.db.get<ReminderRow>(
      'SELECT * FROM reminders WHERE persona_id = ? AND reminder_id = ?',
      [input.personaId, input.reminderId],
    )
    return { status: 'cancelled' as const, reminder: updated }
  })
}

export function listReminders(input: {
  db: ReminderDb
  personaId: string
  receiver: ReminderReceiver
  limit?: number
}): ReminderRow[] {
  const key = receiverKey(input.receiver)
  if (key === null) return []
  const limit = Math.max(1, Math.min(50, input.limit ?? 20))
  if (input.receiver.channel === 'qq') {
    return input.db.all<ReminderRow>(
      `SELECT * FROM reminders
        WHERE persona_id = ? AND channel = 'qq' AND contact_id = ?
        ORDER BY created_at DESC LIMIT ?`,
      [input.personaId, input.receiver.contactId ?? '', limit],
    )
  }
  return input.db.all<ReminderRow>(
    `SELECT * FROM reminders
      WHERE persona_id = ? AND channel = 'desktop' AND session_ref = ?
      ORDER BY created_at DESC LIMIT ?`,
    [input.personaId, input.receiver.sessionRef ?? '', limit],
  )
}

export function getReminder(input: {
  db: ReminderDb
  personaId: string
  reminderId: string
}): ReminderRow | undefined {
  return input.db.get<ReminderRow>(
    'SELECT * FROM reminders WHERE persona_id = ? AND reminder_id = ?',
    [input.personaId, input.reminderId],
  )
}

/**
 * 到点该发的提醒。只取 `status = 'pending'` 且 `due_at <= now` 的。
 *
 * 与 `listReminders` 分开是有意的：那个是「我登记过什么」，这个是「现在该发什么」。
 * 派发方拿到的必须是到期集合，否则会重复唤醒已经发过的行。
 */
export function dueReminders(input: {
  db: ReminderDb
  personaId: string
  now: Date
  limit?: number
  /**
   * 只要这些渠道的提醒——不传表示都要。
   *
   * 这个过滤是必要的：`dispatchDueReminders` 会把扫到的行标成 `delivery_state='pending'`，
   * 而桌面提醒没有 QQ 队列可进。不过滤的话它们会被标成「该发了」然后永远停在那儿，
   * 界面上看着像「已排队」其实永远不会发。
   */
  channels?: ReadonlyArray<'desktop' | 'qq'>
}): ReminderRow[] {
  const limit = Math.max(1, Math.min(200, input.limit ?? 20))
  const channels = input.channels
  const channelFilter = channels && channels.length > 0
    ? ` AND channel IN (${channels.map(() => '?').join(', ')})`
    : ''
  const params: (string | number)[] = [input.personaId, input.now.toISOString(), input.now.toISOString()]
  if (channels && channels.length > 0) params.push(...channels)
  params.push(limit)
  // 第 55 轮 A16：先扫「还没试过的」，再按到期时间。排序里带 `last_attempt_at`
  // 是为了让持续失败的行轮转出去，否则最早 N 条一直回滚、后面的永远轮不到。
  // 它只参与排序，不参与任何排除条件——失败的行下一轮仍然在候选里。
  //
  // 第 56 轮 P1-B：`next_attempt_at` 是**唯一**会排除候选的条件（还没到可试时刻），
  // 并且要在 `LIMIT` 之前过滤——否则延后的行会占满单轮额度，后面的提醒饿死。
  return input.db.all<ReminderRow>(
    `SELECT * FROM reminders
      WHERE persona_id = ? AND status = 'pending' AND delivery_state = 'unsupported'
        AND due_at <= ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)${channelFilter}
      ORDER BY COALESCE(last_attempt_at, '') ASC, due_at ASC, reminder_id ASC
      LIMIT ?`,
    params,
  )
}

/**
 * 到期扫描：把该发的提醒**原子地**标成「已入队」。
 *
 * 第 52 轮外部评审：`markReminderFired()` 单独调用保证不了「状态变更 + 入队」同时成功。
 * 这个函数把「选到期行 → 逐条条件更新」整段放进一个事务里，`delivery_state`
 * 从 `unsupported` 改成 `pending` 就是「已经交给了投递层」的凭据。
 *
 * 用 `delivery_state` 而不是新增 `status` 值：`status` 的 CHECK 只有
 * pending/cancelled/fired/failed 四个值，加一个就要迁移；而 `delivery_state`
 * 本来就是表达投递进展的，语义正好对上。
 *
 * 两条并发扫描同时跑时，条件更新会让第二个拿到 0 行——所以「双扫描只生成一行」
 * 是这个函数的结构性质，不靠调用方加锁。
 */
export type ReminderSkipReason =
  | 'desktop-channel'
  | 'missing-contact'
  | 'missing-stable-id'
  | 'bridge-unavailable'

export type ReminderEnqueueOutcome =
  | { kind: 'queued'; outboxId: string }
  | { kind: 'skipped'; reason: ReminderSkipReason }

export interface ReminderDispatchResult {
  queued: Array<{ reminderId: string; outboxId: string }>
  skipped: Array<{ reminderId: string; reason: ReminderSkipReason }>
  /** 撞上「允许回复时段」被延后的行；`until` 是下一次可以试的时刻。 */
  deferred: Array<{ reminderId: string; until: string }>
  /** 没拿到派发权的行数（并发扫描/已不是待发状态）。 */
  released: number
}

export function dispatchDueReminders(input: {
  db: ReminderDb
  personaId: string
  now: Date
  limit?: number
  /** 只派发这些渠道的提醒——不传表示全部。见 `dueReminders` 的 channels 注释。 */
  channels?: ReadonlyArray<'desktop' | 'qq'>
  /**
   * 在**同一事务里**为到期提醒写一条 outbox 行。
   *
   * 第 53 轮外部评审 P1-A：返回值必须区分「真的建了持久任务」与「永久跳过」——
   * 以前回调是 `void`，静默返回也会被算成已排队（假排队）。
   * 回调抛错 → 整笔事务回滚；不传这个回调时**完全不改状态**，只把这几条记成
   * `skipped('bridge-unavailable')`——桥接没连上是暂时的，不能借机把它们记成终态。
   */
  enqueueOutbox?: (row: ReminderRow, nowIso: string) => ReminderEnqueueOutcome
  /**
   * 该行此刻不在允许回复的时段里时，返回下一次可以试的时刻（ISO）。
   *
   * 第 56 轮 P1-B：撞上安静时段**不是失败**，只是「晚点发」。这里不写状态、
   * 不占扫描额度已用掉的那一条也不再反复重算——延后时刻记到 `next_attempt_at`，
   * 下一轮 `dueReminders` 会先按它过滤。
   */
  deferUntil?: (row: ReminderRow, nowIso: string) => string | null
}): ReminderDispatchResult {
  const due = dueReminders(input)
  const nowIso = input.now.toISOString()
  const queued: Array<{ reminderId: string; outboxId: string }> = []
  const skipped: Array<{ reminderId: string; reason: ReminderSkipReason }> = []
  const deferred: Array<{ reminderId: string; until: string }> = []
  let released = 0
  const enqueueOutbox = input.enqueueOutbox
  const deferUntil = input.deferUntil
  for (const row of due) {
    // A1：没有投递入口时**一个字都不写**。桥接没连上是暂时的，把它记成 failed
    // 就等于把「晚点能发」的提醒永久弄丢（第 54 轮评审第 2 条）。
    if (enqueueOutbox === undefined) {
      skipped.push({ reminderId: row.reminder_id, reason: 'bridge-unavailable' })
      continue
    }
    // P1-B：窗外延后。必须在下面那个事务之前判断——延后不该留下任何投递痕迹。
    const until = deferUntil === undefined ? null : deferUntil(row, nowIso)
    if (until !== null) {
      deferReminder({
        db: input.db,
        personaId: input.personaId,
        reminderId: row.reminder_id,
        until,
        now: nowIso,
      })
      deferred.push({ reminderId: row.reminder_id, until })
      continue
    }
    // 每条一行一个事务：一条契约违约只回滚它自己，不连累同批其它提醒。
    let outcome: 'queued' | 'skipped' | 'released'
    let skipReason: ReminderSkipReason | null = null
    try {
      outcome = input.db.transaction((): 'queued' | 'skipped' | 'released' => {
        const result = input.db.run(
          `UPDATE reminders
              SET delivery_state = 'pending', last_attempt_at = ?, updated_at = ?
            WHERE persona_id = ? AND reminder_id = ? AND status = 'pending' AND delivery_state = 'unsupported'`,
          [nowIso, nowIso, input.personaId, row.reminder_id],
        ) as { changes?: number } | number | null
        const changed = typeof result === 'number' ? result : Number(result?.changes ?? 0)
        // 先更新状态：拿到 0 行说明这一条已经被别人领走，不该再往 outbox 里塞一条。
        if (changed === 0) return 'released'
        const raw: unknown = enqueueOutbox(row, nowIso)
        // 契约违约（返回 undefined / 形状不对）不是「业务跳过」，必须回滚这条并记录。
        if (!isEnqueueOutcome(raw)) {
          throw new PsycheError(CODE.validation,
            `提醒入队回调返回了非法结果：${row.reminder_id}（期望 { kind: 'queued', outboxId } 或 { kind: 'skipped', reason }）`)
        }
        if (raw.kind === 'queued') {
          // 稳定身份来自同 Persona 下的 Contact，不是提醒行（提醒行只存 contact_id）。
          const contact = input.db.get<{ stable_user_id?: string | null }>(
            'SELECT stable_user_id FROM contacts WHERE persona_id = ? AND contact_id = ?',
            [input.personaId, row.contact_id],
          )
          // 代次按登记时的快照比较；NULL 就是 NULL，不拿当前代次补。
          const linked = input.db.get<{
            persona_id?: string | null
            contact_id?: string | null
            stable_user_id?: string | null
            access_epoch?: number | null
            session_id?: string | null
            reminder_id?: string | null
          }>(
            `SELECT persona_id, contact_id, stable_user_id, access_epoch, session_id, reminder_id
               FROM qq_reply_outbox WHERE reply_id = ?`, [raw.outboxId],
          )
          const expectedSession = contact?.stable_user_id ? `qq-private-${contact.stable_user_id}` : null
          const foreign = linked === null || linked === undefined
            || (linked.reminder_id ?? null) !== row.reminder_id
            || (linked.persona_id ?? null) !== input.personaId
            || (linked.contact_id ?? null) !== (row.contact_id ?? null)
            || (linked.stable_user_id ?? null) !== (contact?.stable_user_id ?? null)
            || (linked.session_id ?? null) !== expectedSession
            || (linked.access_epoch ?? null) !== (row.access_epoch ?? null)
          if (foreign) {
            throw new PsycheError(CODE.validation,
              `提醒入队回调返回了归属不符的任务：${row.reminder_id} → ${raw.outboxId}`)
          }
          queued.push({ reminderId: row.reminder_id, outboxId: raw.outboxId })
          return 'queued'
        }
        // 永久跳过：状态置 failed（不再被 dueReminders 扫到），原因留在 delivery_result。
        input.db.run(
          `UPDATE reminders
              SET status = 'failed', delivery_result = 'failed', delivery_state = 'unsupported',
                  next_attempt_at = NULL, updated_at = ?
            WHERE persona_id = ? AND reminder_id = ?`,
          [nowIso, input.personaId, row.reminder_id],
        )
        skipReason = raw.reason
        return 'skipped'
      })
    } catch (error) {
      // 契约违约或入队抛错：这条回滚，同批其他提醒继续。
      console.warn('[psyche][reminders] 派发失败，已回滚该条', {
        reminderId: row.reminder_id,
        error: error instanceof Error ? error.message : String(error),
      })
      // 第 55 轮 A16：回滚之后单独记一次「试过了」，让下一轮排序把它排到后面去。
      // 只动 `last_attempt_at`（表示尝试时间），不改 status/delivery_state——
      // 它仍然是候选，只是不再永远霸占最早的 N 个位置。
      try {
        input.db.run(
          `UPDATE reminders
              SET last_attempt_at = ?, updated_at = ?
            WHERE persona_id = ? AND reminder_id = ? AND status = 'pending'`,
          [nowIso, nowIso, input.personaId, row.reminder_id],
        )
      } catch {
        // 记不上就算了：宁可下一轮重复尝试，也不能因为轮转失败把提醒弄丢。
      }
      released += 1
      continue
    }
    if (outcome === 'released') released += 1
    else if (outcome === 'skipped' && skipReason !== null) skipped.push({ reminderId: row.reminder_id, reason: skipReason })
  }
  return { queued, skipped, deferred, released }
}

/**
 * 记下「下一次可以试」的时刻。
 *
 * 只动 `next_attempt_at`：`status` 仍是 `pending`、`delivery_state` 仍是
 * `unsupported`（冻结表里「窗外等待入队」就是这一组合）。`due_at` 是用户设的
 * 原定时间，绝不改写。
 */
export function deferReminder(input: {
  db: ReminderDb
  personaId: string
  reminderId: string
  until: string
  now: string
}): boolean {
  const result = input.db.run(
    `UPDATE reminders SET next_attempt_at = ?, updated_at = ?
      WHERE persona_id = ? AND reminder_id = ? AND status = 'pending'`,
    [input.until, input.now, input.personaId, input.reminderId],
  ) as { changes?: number } | number | null
  const changed = typeof result === 'number' ? result : Number(result?.changes ?? 0)
  return changed === 1
}

/** 窗口规划结果：`open` = 现在就能发，`wait` = 等到 `until` 再试。 */
export type ReminderWindowPlan = { kind: 'open' } | { kind: 'wait'; until: string }

/**
 * 按**当前**规则重算「还在等」的提醒（第 9 轮评审第 4 条）。
 *
 * 只碰 `next_attempt_at IS NOT NULL` 的等待行：
 * - 规则改早了（窗口现在开着）→ 清空 `next_attempt_at`，这一轮立刻进入候选；
 * - 规则改晚了，或从暂停恢复成有窗口 → 把 `next_attempt_at` 改成新时刻。
 *
 * 为什么需要它：`next_attempt_at` 是上一轮规则算出来的，如果只靠它过滤，规则提前开窗
 * 之后提醒会一直等到**旧的**那个时刻才重算，白等一整天。
 */
export function refreshDeferredReminders(input: {
  db: ReminderDb
  personaId: string
  now: string
  plan: (row: ReminderRow) => ReminderWindowPlan
}): number {
  const rows = input.db.all<ReminderRow>(
    `SELECT * FROM reminders
      WHERE persona_id = ? AND status = 'pending' AND delivery_state = 'unsupported'
        AND next_attempt_at IS NOT NULL
      ORDER BY due_at ASC, reminder_id ASC`,
    [input.personaId],
  )
  let changed = 0
  for (const row of rows) {
    const plan = input.plan(row)
    if (plan.kind === 'open') {
      const result = input.db.run(
        `UPDATE reminders SET next_attempt_at = NULL, updated_at = ?
          WHERE persona_id = ? AND reminder_id = ? AND status = 'pending'`,
        [input.now, input.personaId, row.reminder_id],
      ) as { changes?: number } | number | null
      changed += typeof result === 'number' ? result : Number(result?.changes ?? 0)
      continue
    }
    if (plan.until === row.next_attempt_at) continue
    const result = input.db.run(
      `UPDATE reminders SET next_attempt_at = ?, updated_at = ?
        WHERE persona_id = ? AND reminder_id = ? AND status = 'pending'`,
      [plan.until, input.now, input.personaId, row.reminder_id],
    ) as { changes?: number } | number | null
    changed += typeof result === 'number' ? result : Number(result?.changes ?? 0)
  }
  return changed
}

function isEnqueueOutcome(value: unknown): value is ReminderEnqueueOutcome {  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  if (kind === 'queued') {
    const outboxId = (value as { outboxId?: unknown }).outboxId
    return typeof outboxId === 'string' && outboxId.length > 0
  }
  if (kind === 'skipped') {
    const reason = (value as { reason?: unknown }).reason
    return reason === 'desktop-channel' || reason === 'missing-contact'
      || reason === 'missing-stable-id' || reason === 'bridge-unavailable'
  }
  return false
}

/**
 * 把一条提醒标记成已发出。
 *
 * 条件里带 `status = 'pending'`：两个派发实例同时扫到同一行时，只有一个能改成
 * `fired`，另一个拿到 0 行，据此跳过——不需要额外的锁。返回 false 表示「没轮到你」。
 */
export function markReminderFired(input: {
  db: ReminderDb
  personaId: string
  reminderId: string
  now: Date
  deliveryState: 'unsupported' | 'pending' | 'sent' | 'unknown'
}): boolean {
  const nowIso = input.now.toISOString()
  // adapter 的 `run()` 返回 `{ changes, lastInsertRowid }`，不是数字。
  const result = input.db.run(
    `UPDATE reminders
        SET status = 'fired', fired_at = ?, delivery_state = ?, last_attempt_at = ?, updated_at = ?
      WHERE persona_id = ? AND reminder_id = ? AND status = 'pending'`,
    [nowIso, input.deliveryState, nowIso, nowIso, input.personaId, input.reminderId],
  ) as { changes?: number } | number | null
  const changed = typeof result === 'number' ? result : Number(result?.changes ?? 0)
  return changed > 0
}

/**
 * 一条提醒的投递终态 —— 全仓唯一的口径。
 *
 * | status    | delivery_state | delivery_result | 含义                       |
 * |-----------|----------------|-----------------|----------------------------|
 * | pending   | unsupported    | NULL            | 等着入队                   |
 * | pending   | pending        | NULL            | 已经交给队列               |
 * | fired     | sent           | sent            | 确实发出去了               |
 * | failed    | unsupported    | failed          | 确定没发出去               |
 * | pending   | unknown        | unknown         | 发没发不知道，不许自动重投 |
 * | cancelled | unsupported    | NULL            | 发送前成功取消             |
 *
 * 只写 `WHERE status = 'pending'`：迟到的队列结果不许把已取消/已终态的提醒翻回来。
 * 另外（第 55 轮 A15）：一旦进了 `delivery_state = 'unknown'`，迟到结果和普通取消
 * 都改不动它——只有 `resolveUnknown` 显式传 `allowFromUnknown` 才能裁定。
 * 也不开事务——调用方（outbox 的 `applyResult` / `#expireDue`）必须和自己的状态
 * 变更在同一个事务里，所以这里只做纯 SQL。
 */
export function writeReminderOutcome(input: {
  db: ReminderDb
  personaId: string
  reminderId: string
  /** ISO 文本：调用方已经规范化过时间，不要再传 Date。 */
  now: string
  outcome: 'sent' | 'failed' | 'unknown' | 'cancelled'
  /**
   * 只有 Owner 的人工裁决（`resolveUnknown`）能传 true：把提醒从 unknown 里解出来。
   * 其余调用方一律不许越过 unknown 这道闸。
   */
  allowFromUnknown?: boolean
}): boolean {
  const now = input.now
  // unknown 是不可自动改写的终态；`outcome: 'unknown'` 自己不受这条限制（重复写无害）。
  const unknownGuard = input.allowFromUnknown ? '' : " AND COALESCE(delivery_state, '') <> 'unknown'"
  let result: { changes?: number } | number | null
  if (input.outcome === 'sent') {
    result = input.db.run(
      `UPDATE reminders
          SET status = 'fired', fired_at = ?, delivery_state = 'sent', delivery_result = 'sent',
              next_attempt_at = NULL, last_attempt_at = ?, updated_at = ?
        WHERE persona_id = ? AND reminder_id = ? AND status = 'pending'${unknownGuard}`,
      [now, now, now, input.personaId, input.reminderId],
    ) as { changes?: number } | number | null
  } else if (input.outcome === 'failed') {
    result = input.db.run(
      `UPDATE reminders
          SET status = 'failed', delivery_state = 'unsupported', delivery_result = 'failed',
              next_attempt_at = NULL, last_attempt_at = ?, updated_at = ?
        WHERE persona_id = ? AND reminder_id = ? AND status = 'pending'${unknownGuard}`,
      [now, now, input.personaId, input.reminderId],
    ) as { changes?: number } | number | null
  } else if (input.outcome === 'unknown') {
    // 发没发出去不确定：`status` 仍是 pending（不能算失败），但 `delivery_state`
    // 必须离开 'unsupported'，否则下一轮扫描会把它当成「还没入队」再投一次。
    result = input.db.run(
      `UPDATE reminders
          SET delivery_state = 'unknown', delivery_result = 'unknown',
              next_attempt_at = NULL, last_attempt_at = ?, updated_at = ?
        WHERE persona_id = ? AND reminder_id = ? AND status = 'pending'`,
      [now, now, input.personaId, input.reminderId],
    ) as { changes?: number } | number | null
  } else {
    result = input.db.run(
      `UPDATE reminders
          SET status = 'cancelled', cancelled_at = ?, delivery_state = 'unsupported',
              delivery_result = NULL, next_attempt_at = NULL, updated_at = ?
        WHERE persona_id = ? AND reminder_id = ? AND status = 'pending'${unknownGuard}`,
      [now, now, input.personaId, input.reminderId],
    ) as { changes?: number } | number | null
  }
  const changed = typeof result === 'number' ? result : Number(result?.changes ?? 0)
  return changed > 0
}

/**
 * 第 53 轮 P1-A：把队列行的终态回写提醒。
 *
 * 语义已经统一到 `writeReminderOutcome`：`failed` 是真的失败（status='failed'），
 * 不是以前那个「failed 也写 unknown」的错口径。
 */
export function completeReminderDelivery(input: {
  db: ReminderDb
  personaId: string
  reminderId: string
  now: Date
  outcome: 'sent' | 'failed' | 'unknown'
}): boolean {
  return writeReminderOutcome({
    db: input.db,
    personaId: input.personaId,
    reminderId: input.reminderId,
    now: input.now.toISOString(),
    outcome: input.outcome,
  })
}

