/**
 * P1-C（第 16 轮评审第 3 条）：`psyche_resolve_delivery` 的门面逻辑。
 *
 * 这里只做三件「入口」的事，裁决本身仍然在 `QqReplyOutboxStore.resolveUnknownByReminder()`：
 * 1. **身份**：由 `isOwnerReminderScope()` 判定当前会话是不是主人本人（普通联系人即使正是
 *    这条提醒的接收人也不算），不满足直接 `no-permission`，一个字节都不写；
 * 2. **归属**：这条提醒必须挂在当前接收者名下（`listReminders` 里能找到），否则同样拒绝；
 * 3. **可用性**：回复队列没启用时返回 `unavailable`，而不是假装裁决成功。
 *
 * 单独拆出来的理由：这两道闸如果只写在插件装配代码里，测试就只能靠「看源码」证明，
 * 而评审要的是「用真实库和真实 store 跑一遍，非主人被拒且零写入」。
 */

export interface ResolveDeliveryResultView {
  ok: boolean
  status: 'resolved' | 'not-found' | 'conflict' | 'no-permission' | 'unavailable'
  replyId?: string
  reason?: string
}

/** 裁决的真正实现（`QqReplyOutboxStore.resolveUnknownByReminder` 的形状）。 */
export interface ResolveDeliveryStore {
  resolveUnknownByReminder(input: {
    reminderId: string
    verdict: 'received' | 'not-received'
    by: string
    now?: string
  }): {
    status: 'resolved' | 'not-found' | 'conflict'
    replyId?: string
    reason?: string
  }
}

export interface ResolveDeliveryDeps {
  /** 当前会话是不是主人本人（`lib/reminder-owner.ts`，插件侧把 `ownerUin()` 绑进去）。 */
  isOwner: boolean
  /** 这条提醒是否挂在当前接收者名下（调用方用 `listReminders` 判）。 */
  owned: boolean
  /** 回复队列没启用时为 null。 */
  store: ResolveDeliveryStore | null
  /** 写入口固定用的 Owner 身份（与 store 的 `ownerId` 一致）。 */
  ownerId: string
}

export function resolveReminderDelivery(input: {
  reminderId: string
  verdict: 'received' | 'not-received'
  now: string
  deps: ResolveDeliveryDeps
}): ResolveDeliveryResultView {
  const { deps } = input
  if (!deps.isOwner || !deps.owned) return { ok: false, status: 'no-permission' }
  if (deps.store === null) return { ok: false, status: 'unavailable', reason: 'reply-outbox-off' }
  try {
    const result = deps.store.resolveUnknownByReminder({
      reminderId: input.reminderId,
      verdict: input.verdict,
      by: deps.ownerId,
      now: input.now,
    })
    return { ok: result.status === 'resolved', ...result }
  } catch (error) {
    return { ok: false, status: 'conflict', reason: error instanceof Error ? error.message : String(error) }
  }
}
