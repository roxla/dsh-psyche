/**
 * 提醒派发器的组装点。
 *
 * 第 53 轮外部评审的顺序：先接真实 outbox 与撤权检查，再谈定时器。
 * 这个文件就是那一接——把 Core 的三个纯函数（`dispatchDueReminders` /
 * `enqueueReminderReply` / `accessEpochOf`）拼成「扫描到期提醒并塞进 QQ 回复队列」。
 *
 * 为什么单独一个文件而不是直接写进 `src/index.ts`：
 * `src/index.ts` 是三千行的插件入口，任何一段逻辑写进去都不好测；
 * 这里只依赖四个窄接口（db、桥接的两个取值器、ownerId），可以在没有宿主的情况下测。
 */

import type { ReminderRow } from '../lib/store.js'
import { dispatchDueReminders, refreshDeferredReminders } from '../lib/store.js'
import { refreshDeferredReplies } from '../lib/store.js'

/**
 * 第 9 轮评审第 2 条：规则暂停（或八天内没有窗口）时用这个时刻占位。
 *
 * 它不是「预计发送时间」，只是一个**远未来**的等待标记：让提醒行与队列行都停在
 * 等待态、跨过原来的 10 分钟 TTL 也不会被判失败，同时每轮扫描都不会反复重算它。
 * 规则恢复后由 `refreshDeferredReminders` / `refreshDeferredRetry` 在下一轮把它改回来。
 */
export const NO_REPLY_WINDOW_AT = '9999-12-31T23:59:59.999Z'

/** 桥接给出的「这个人现在能不能发」。 */
export type PrivateSendPlan = { kind: 'open' } | { kind: 'paused' } | { kind: 'next'; at: string }

/** 派发需要从桥接拿到的两样东西。桥接没连上时 `transportId` 为空串。 */
export interface ReminderDeliveryBridge {
  readonly transportId: string
  accessEpochOf(target: { kind: 'private'; userId: string }): number
  /**
   * 第 56 轮 P1-B：这个人下一次允许发送的时刻。
   * `null` = 现在就能发（或没有规则）；`'paused'` = 无可用窗口（保持等待）；桥接实现可以不给。
   */
  nextPrivateSendAt?(userId: string, at: Date): Date | null | 'paused'
}

export interface ReminderDeliveryOptions {
  db: Parameters<typeof dispatchDueReminders>[0]['db']
  personaId: string
  ownerId: string
  bridge: () => ReminderDeliveryBridge | null
  enqueue: (input: {
    db: ReminderDeliveryOptions['db']
    ownerId: string
    personaId: string
    reminder: ReminderRow
    transportId: string
    now: string
    /** 登记那一刻的代次；`null` 表示没有快照（迁移前的行），按「没有凭据」处理。 */
    accessEpoch: number | null
  }) => { replyId: string }
  now?: () => Date
}

export interface ReminderDeliveryResult {
  queued: number
  /** 桥接没连上等原因导致的跳过数——调用方据此决定要不要告警。 */
  skipped: number
}

/** 上一轮的完整派发结果：调用方拿它显示「已延后到几点」。 */
export interface ReminderDeliveryReport {
  queued: Array<{ reminderId: string; outboxId: string }>
  skipped: Array<{ reminderId: string; reason: string }>
  deferred: Array<{ reminderId: string; until: string }>
}

/**
 * 扫一轮到期提醒并把它们塞进回复队列。
 *
 * 三个拒绝条件（任一成立就整体跳过，不写任何行）：
 * 1. 桥接不存在（插件还没建桥接）
 * 2. `transportId` 为空（桥接没连上——写进去也没 worker 会处理）
 * 3. 该联系人的授权代次拿不到（`accessEpochOf` 抛错）
 */
export function createReminderDelivery(options: ReminderDeliveryOptions) {
  const now = options.now ?? (() => new Date())
  let lastReport: ReminderDeliveryReport = { queued: [], skipped: [], deferred: [] }

  function tick(): Promise<number> {
    const at = now()
    const nowIso = at.toISOString()
    const bridge = options.bridge()
    if (!bridge || bridge.transportId.length === 0) {
      return Promise.resolve(0)
    }
    // 收窄后的别名：下面的闭包在定义之后才执行，直接用 `bridge` 会丢掉 null 收窄。
    const ready: ReminderDeliveryBridge = bridge

    /** 这个稳定 QQ 号现在能不能发（三种结果）。 */
    function planFor(stableUserId: string): PrivateSendPlan {
      if (ready.nextPrivateSendAt === undefined) return { kind: 'open' }
      const next = ready.nextPrivateSendAt(stableUserId, at)
      if (next === null) return { kind: 'open' }
      if (next === 'paused') return { kind: 'paused' }
      return next.getTime() > at.getTime() ? { kind: 'next', at: next.toISOString() } : { kind: 'open' }
    }

    function windowPlan(plan: PrivateSendPlan): { kind: 'open' } | { kind: 'wait'; until: string } {
      if (plan.kind === 'open') return { kind: 'open' }
      // 「暂无可用时段」也记成等待：哨兵时刻让行跨过 TTL 也不会被判死。
      return { kind: 'wait', until: plan.kind === 'paused' ? NO_REPLY_WINDOW_AT : plan.at }
    }

    function stableOf(contactId: string | null): string {
      if (typeof contactId !== 'string' || contactId.length === 0) return ''
      const row = options.db.get<{ stable_user_id: string | null }>(
        'SELECT stable_user_id FROM contacts WHERE contact_id = ?', [contactId],
      )
      return typeof row?.stable_user_id === 'string' ? row.stable_user_id : ''
    }

    // 第 9 轮评审第 4 条：规则可能在两轮扫描之间改早了/改晚了。
    // 先把「还在等」的行按**当前**规则重算一遍，否则上一轮记下的时刻会挡住新窗口。
    refreshDeferredReminders({
      db: options.db,
      personaId: options.personaId,
      now: nowIso,
      plan: (row: ReminderRow) => {
        if (row.channel !== 'qq') return { kind: 'open' as const }
        const stable = stableOf(row.contact_id)
        if (stable.length === 0) return { kind: 'open' as const }
        return windowPlan(planFor(stable))
      },
    })
    refreshDeferredReplies({
      db: options.db,
      now: nowIso,
      plan: (row) => {
        const stable = typeof row.stableUserId === 'string' ? row.stableUserId : ''
        if (stable.length === 0) return { kind: 'open' as const }
        return windowPlan(planFor(stable))
      },
    })

    const result = dispatchDueReminders({
      db: options.db,
      personaId: options.personaId,
      now: at,
      // 只要 QQ 提醒：桌面提醒没有 QQ 队列可进，标成 pending 只会永久停在那儿。
      channels: ['qq'],
      // P1-B：到点但撞上安静时段 → 延后到下一个窗口，不判死、也不入队。
      deferUntil: (row: ReminderRow) => {
        if (row.channel !== 'qq') return null
        const stable = stableOf(row.contact_id)
        if (stable.length === 0) return null
        const plan = windowPlan(planFor(stable))
        return plan.kind === 'open' ? null : plan.until
      },
      enqueueOutbox: (row: ReminderRow, nowIso: string) => {
        // 第 53 轮 P1-A：永久跳过要**显式说出来**，不能靠静默 return 让调用方
        // 误以为已经排进队列（以前正是这条路径造成假排队、并挤占扫描额度）。
        if (row.channel !== 'qq') return { kind: 'skipped' as const, reason: 'desktop-channel' as const }
        if (typeof row.contact_id !== 'string' || row.contact_id.length === 0) {
          return { kind: 'skipped' as const, reason: 'missing-contact' as const }
        }
        // `accessEpochOf` 要的是稳定 QQ 号，不是 contactId——两者不能混用
        // （`private:90001` 才是授权代次的键，`private:ct_owner` 永远查不到东西）。
        const stable = options.db.get<{ stable_user_id: string | null }>(
          'SELECT stable_user_id FROM contacts WHERE contact_id = ?', [row.contact_id],
        )
        const stableUserId = typeof stable?.stable_user_id === 'string' ? stable.stable_user_id : ''
        if (stableUserId.length === 0) return { kind: 'skipped' as const, reason: 'missing-stable-id' as const }
        const enqueued = options.enqueue({
          db: options.db,
          ownerId: options.ownerId,
          personaId: options.personaId,
          reminder: row,
          transportId: bridge.transportId,
          now: nowIso,
          // 撤销前登记的提醒要能被拦：这里取的是**当下**的代次，
          // 用**登记那一刻**的代次，不是现在现查的。
          //
          // 现查会漏掉「登记 → 撤权 → 重新授权 → 到期」这条链：旧提醒拿到的是
          // 撤销后重发的新代次，于是它带着合法凭据发出去，撤权等于白做。
          // 行里是 null 时保持 null——那是迁移前没有快照的行，按「没有凭据」停发，
          // 不能拿当前值补。
          accessEpoch: row.access_epoch,
        })
        return { kind: 'queued' as const, outboxId: enqueued.replyId }
      },
    })
    lastReport = { queued: result.queued, skipped: result.skipped, deferred: result.deferred }
    return Promise.resolve(result.queued.length)
  }

  return {
    tick,
    /** 上一轮的派发明细（含「已延后到几点」）。 */
    lastReport: () => lastReport,
  }
}
