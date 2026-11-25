

/**
 * 第 24 轮：把「生产身份读取」也抽出来，让测试经同一条路径取 Owner 号。
 *
 * 之前测试是自己读文件、自己决定 `isOwner=false` 再传给门面——那只证明门面会拒绝，没证明
 * 「工具作为坏文件后的第一次调用，能自己发现配置损坏并拒绝授权」。所以这里把 index.ts 里
 * `ownerUin()` 的核心逻辑抽成共享实现：读覆盖层 → 失败就通知调用方（桥要标不可信）并返回空串。
 *
 * 失败关闭的理由与 policy 一致：坏配置期间 QQ 侧不授予 Owner，否则名单里残留的旧号可能借宿主
 * 旧值拿到主人权限。
 */
export interface ReminderOwnerOverlay {
  effective: (
    host: { owner: string; extra?: string[]; groups?: string[] },
    runtime: { provider: string; model: string },
  ) => { access: { owner: string } }
}

export interface ReadOwnerUinInput {
  overlay: ReminderOwnerOverlay | null
  host: { owner: string; extra?: string[]; groups?: string[] } | undefined
  runtime: { provider: string; model: string }
  /** 覆盖层不可用时的通知（生产里是 `qqBridge.markConfigUntrusted`）。 */
  onCorrupt?: (reason: string) => void
  /** 桥当前已知不可信时，即使有宿主配置也不回退（第 57 轮 P1-D）。 */
  trusted?: () => boolean
}

export function readOwnerUin(input: ReadOwnerUinInput): string {
  const host = input.host
  if (input.overlay !== null && host !== undefined) {
    try {
      return input.overlay.effective(host, input.runtime).access.owner
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      input.onCorrupt?.(reason)
      return ''
    }
  }
  if (input.trusted !== undefined && !input.trusted()) return ''
  return host?.owner ?? ''
}
/**
 * P1-C（第 16 轮评审第 3 条）：谁有资格裁决「结果不确定」的提醒。
 *
 * 为什么单独拎出来：这条判断的被试主体不是「能不能看见这条提醒」——普通联系人本来就是
 * 提醒的接收人，列表里当然有它，用可见性当权限等于没有权限。真正的判据是**会话渠道身份**：
 *
 * - `desktop`：本机主人在自己的应用里，算主人；
 * - `qq`：只有该联系人自己的 `stable_user_id` 等于配置里的 Owner 号才算主人，
 *   其余联系人（哪怕正是这条提醒的接收人）一律不给入口。
 *
 * 拿不到 Owner 号（未配置/被清空）时按「不是主人」处理——失败关闭，不靠猜。
 */

/** `ReminderScope` 的最小形状，避免这里反向依赖工具层。 */
export interface ReminderActorScope {
  channel: 'qq' | 'desktop'
  contactId?: string | null
}

/** 只需要一句读 SQL 的库形状：`contacts` 查 stable_user_id。 */
export interface ReminderActorDb {
  get?: <T>(sql: string, params?: readonly (string | number | null)[]) => T | undefined
}

/**
 * @param db           用来把 contactId 解析成 stable_user_id
 * @param receiver     当前会话的接收者身份（来自 `reminderScope`）
 * @param ownerUin     配置里有效的 Owner QQ 号（`ownerUin()` 的结果）
 */
export function isOwnerReminderScope(
  db: ReminderActorDb,
  receiver: ReminderActorScope,
  ownerUin: string,
): boolean {
  if (receiver.channel === 'desktop') return true
  const owner = ownerUin.trim()
  if (owner === '' || !receiver.contactId) return false
  const row = db.get?.<{ stable_user_id: string | null }>(
    'SELECT stable_user_id FROM contacts WHERE contact_id = ?',
    [receiver.contactId],
  )
  return row?.stable_user_id === owner
}

