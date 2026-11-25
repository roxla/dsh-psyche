/**
 * 关系信号的归属判定——只判「该记给谁」，不碰数据库。
 *
 * 拆出来的原因：这条路径上出过一次「看起来在工作、实际一句没记」的缺陷
 * （桌面会话没有 Adapter 绑定 → 取不到 contactId → 整段写入被静默跳过）。
 * 判断分散在闭包里时，测试摸不到它，只能靠真机碰运气。
 *
 * 三条纪律：
 * 1. 委派会话（子代理）说的话不算主人的。判不出也当委派处理——这条路径
 *    本来就是猜的，猜错的方向是「记到主人名下」，比不记更糟。
 * 2. 只有真人用户消息才算互动。`agent-message`（别的 agent 转来的）与
 *    `subagent-settled`（子代理完成通知）即使正文写着「谢谢」，也不是用户说的。
 * 3. 有绑定但绑定里没有 contactId（群聊、身份缺失），一律跳过，不退回桌面主人。
 */
export type AffectContactPlan =
  | { kind: 'bound'; contactId: string }
  | { kind: 'desktop-owner' }
  | { kind: 'skip'; reason: 'delegated' | 'not-user' | 'no-contact' }

export interface AffectContactInput {
  /** 委派判定结果：true 委派、false 顶层、null 判不出。 */
  delegated: boolean | null
  /** 是否拿到了 Adapter 绑定。 */
  hasBinding: boolean
  /** 绑定里的私聊 contactId；群聊或身份缺失时为 null。 */
  boundContactId?: string | null
  /** `sourceKindOf()` 的结果：user / agent-message / subagent-settled … */
  messageKind?: string | null
}

export function planAffectContact(input: AffectContactInput): AffectContactPlan {
  if (input.delegated !== false) return { kind: 'skip', reason: 'delegated' }
  if (input.messageKind !== 'user') return { kind: 'skip', reason: 'not-user' }
  if (input.hasBinding) {
    const contactId = typeof input.boundContactId === 'string' ? input.boundContactId : ''
    if (contactId.length > 0) return { kind: 'bound', contactId }
    return { kind: 'skip', reason: 'no-contact' }
  }
  return { kind: 'desktop-owner' }
}
