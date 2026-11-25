/**
 * 把一条到期的提醒写进 QQ 私聊回复队列。
 *
 * 为什么复用 `qq_reply_outbox` 而不是另建一张表（第 53 轮外部评审同意的方向）：
 * 那张表已经有 `access_epoch` 那一整套撤权检查（迁移 35），提醒走同一条路就天然复用——
 * 撤销前登记的提醒、撤销后一条都发不出去，不需要为提醒再写一份判据。
 *
 * 两个必须在这里解决、不能留给调用方的点：
 *
 * 1. **`sessionSeq`**：`qq_reply_outbox` 要求它是 1..1000000 的整数（0 直接被拒）。
 *    提醒没有轮次序号，所以取「该会话当前最大 seq + 1」。这一步必须在写队列自己的
 *    事务里算，否则两个到期提醒并发会拿到同一个 seq。
 * 2. **`stableUserId`**：队列按它对授权代次（`row.stableUserId` 取 epoch），
 *    所以必须从 `contacts` 现查，不能用调用方传进来的显示名或 contactId。
 */
import type { Db } from './adapter.js'
import { PsycheError, CODE } from './errors.js'
import { QqReplyOutboxStore } from './qq-reply-outbox.js'
import type { ReminderRow } from './reminders.js'

export interface EnqueueReminderReplyInput {
  readonly db: Db
  /** 队列的 owner 标识（`QqReplyOutboxStore` 的构造参数之一）。 */
  readonly ownerId: string
  readonly personaId: string
  readonly reminder: ReminderRow
  readonly transportId: string
  readonly now: string
  /** 提醒正文；不给就用 `reminder.text`。 */
  readonly payloadText?: string
  /** 队列 TTL，默认 10 分钟——提醒过期就不该再发。 */
  readonly ttlMs?: number
  /**
   * 入队时刻的授权代次；不给就写 `null`。
   *
   * `null` 不是「跳过检查」而是「没有凭据」——worker 会按 `epoch-missing` 停发。
   * 真正的值必须由桥接在入队那一刻给出（`accessEpochOf()`），从别处推断就是错的。
   */
  readonly accessEpoch?: number | null
}

export const REMINDER_OUTBOX_TTL_MS = 10 * 60_000

export interface EnqueueReminderReplyResult {
  readonly replyId: string
  readonly duplicate: boolean
}

export function enqueueReminderReply(input: EnqueueReminderReplyInput): EnqueueReminderReplyResult {
  const { reminder } = input
  if (reminder.channel !== 'qq') {
    throw new PsycheError(CODE.validation, '只有 QQ 提醒能进 QQ 回复队列')
  }
  const contactId = reminder.contact_id
  if (typeof contactId !== 'string' || contactId.length === 0) {
    throw new PsycheError(CODE.validation, '提醒没有登记联系人，不能发 QQ 私聊')
  }
  const { stableUserId, sessionSeq } = input.db.transaction(() => {
    const contact = input.db.get<{ stable_user_id?: string | null }>(
      'SELECT stable_user_id FROM contacts WHERE contact_id = ? AND persona_id = ?',
      [contactId, input.personaId],
    )
    const stable = typeof contact?.stable_user_id === 'string' ? contact.stable_user_id : ''
    if (stable.length === 0) {
      throw new PsycheError(CODE.validation, '联系人没有稳定 QQ 号，不能发 QQ 私聊')
    }
    // 顺序号必须和写入同一个事务：两个到期提醒并发时，各自算出的 seq 才不会被对方挤掉。
    const sessionId = `qq-private-${stable}`
    const max = input.db.get<{ max_seq?: number | null }>(
      'SELECT MAX(session_seq) AS max_seq FROM qq_reply_outbox WHERE session_id = ?',
      [sessionId],
    )
    const next = Number(max?.max_seq ?? 0) + 1
    return { stableUserId: stable, sessionSeq: next }
  })

  const contactStable = stableUserId
  const store = new QqReplyOutboxStore({ db: input.db, ownerId: input.ownerId })
  const result = store.enqueue({
    personaId: input.personaId,
    contactId,
    stableUserId: contactStable,
    sessionId: `qq-private-${contactStable}`,
    sessionSeq,
    transportId: input.transportId,
    payloadText: input.payloadText ?? reminder.text,
    ttlMs: input.ttlMs ?? REMINDER_OUTBOX_TTL_MS,
    // 授权代次由调用方从桥接取；这里不再猜。空值会让 worker 按 `epoch-missing` 停下。
    accessEpoch: typeof input.accessEpoch === 'number' ? input.accessEpoch : null,
    // 第 53 轮 P1-A：把提醒身份带进队列，worker 才能复核「已取消」并回写终态。
    reminderId: reminder.reminder_id,
    now: input.now,
  })
  return { replyId: result.row.replyId, duplicate: result.duplicate }
}
