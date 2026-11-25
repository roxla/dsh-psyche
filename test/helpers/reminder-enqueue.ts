// 到期扫描的入队回调夹具。
//
// 这个文件刻意和 `src/lib/reminder-delivery.ts` 里的 `enqueueOutbox` 同构：
// P1-A 之后「回调返回什么」是契约的一部分，测试夹具要是自己造一个宽松版本，
// 就等于用假回调掩盖真问题（第 54 轮评审明确不许这么干）。
// 所以这里的每一步判断都与生产路径一一对应，只把 `accessEpochOf` 换成一个
// 可以按行给值的钩子——测试要覆盖 5/5、5/7、NULL/5 这些代次组合。

import { enqueueReminderReply } from '../../packages/core/dist/reminder-outbox.js'

type DbLike = {
  get<T>(sql: string, params?: readonly (string | number | null)[]): T | undefined
}

export interface ReminderEnqueueOptions {
  db: DbLike
  personaId: string
  ownerId?: string
  transportId?: string
  /** 代次来源；默认按提醒行上的快照原样传（`src/lib/reminder-delivery.ts` 的语义）。 */
  accessEpochOf?: (row: { access_epoch?: number | null }) => number | null
  /** 想自己数调用时传进来。 */
  calls?: string[]
}

/**
 * 造一个合法的 `enqueueOutbox` 回调。
 *
 * 返回值只可能是三种：`{kind:'skipped',reason}`（桌面色道 / 没联系人 / 没稳定号）
 * 或 `{kind:'queued',outboxId}`。别在这里 return undefined——那是契约违反。
 */
export function reminderEnqueue(options: ReminderEnqueueOptions) {
  const calls = options.calls ?? []
  const transportId = options.transportId ?? 'probe-transport'
  const ownerId = options.ownerId ?? 'owner'
  const epochOf = options.accessEpochOf ?? ((row: { access_epoch?: number | null }) =>
    (typeof row.access_epoch === 'number' ? row.access_epoch : null))

  function callback(row: Record<string, unknown>, nowIso: string) {
    calls.push(String(row.reminder_id))
    if (row.channel !== 'qq') return { kind: 'skipped' as const, reason: 'desktop-channel' as const }
    if (typeof row.contact_id !== 'string' || row.contact_id.length === 0) {
      return { kind: 'skipped' as const, reason: 'missing-contact' as const }
    }
    const stable = options.db.get<{ stable_user_id: string | null }>(
      'SELECT stable_user_id FROM contacts WHERE contact_id = ?', [row.contact_id],
    )
    const stableUserId = typeof stable?.stable_user_id === 'string' ? stable.stable_user_id : ''
    if (stableUserId.length === 0) return { kind: 'skipped' as const, reason: 'missing-stable-id' as const }
    const enqueued = enqueueReminderReply({
      db: options.db as never,
      ownerId,
      personaId: options.personaId,
      reminder: row as never,
      transportId,
      now: nowIso,
      accessEpoch: epochOf(row as { access_epoch?: number | null }),
    })
    return { kind: 'queued' as const, outboxId: enqueued.replyId }
  }

  return { callback, calls }
}
