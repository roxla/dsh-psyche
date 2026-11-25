/**
 * 启动恢复：摘要积压。
 *
 * 进程可能在「摘要已提交、续排还没落库」之间退出，留下的积压不会再有人补。
 * 启动时按同一套资格判定（绑定仍活动 + 项目 active + 自动模式开）补出真正缺的那一条：
 * 幂等，不建定时器、不调用模型、不发消息。
 *
 * 抽成独立模块而不是写在 `index.ts` 里，是为了让「宿主真实启动走的这一段」可以被
 * 测试直接调用——否则只能测 `resumeDigestBacklog()`，证明不了接线。
 *
 * 「自动模式」开关属于 AM-1，本批尚未落到配置上；调用方显式传入，默认按开启处理，
 * 开关落地时只改调用点。
 */
import { resumeDigestBacklog, type DigestDb, type ResumeDigestResult } from './store.js'

export interface StartupDigestResumeInput {
  /** 已打开且已迁移完成的主库。 */
  readonly db: DigestDb
  /** 时钟，默认当前时间。 */
  readonly now?: Date
  /** 自动记忆（含自动摘要）是否开启；AM-1 之前恒为 true。 */
  readonly autoEnabled?: boolean
  /** 诊断输出；传 null 表示不记录。 */
  readonly log?: ((line: string) => void) | null
}

/**
 * 启动时恢复摘要积压。返回 `null` 表示这一步整体失败（已被吞掉并记录），
 * 启动流程不应因此中止。
 */
export function resumeDigestOnStartup(input: StartupDigestResumeInput): ResumeDigestResult | null {
  const log = input.log ?? null
  try {
    const resumed = resumeDigestBacklog({
      db: input.db,
      now: input.now ?? new Date(),
      autoEnabled: input.autoEnabled ?? true,
    })
    if (resumed.planned > 0 && log !== null) {
      log(`[psyche] 摘要积压恢复：补出 ${resumed.planned} 条（扫描 ${resumed.scanned} 个活动绑定）`)
    }
    return resumed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (log !== null) log(`[psyche] 摘要积压恢复失败（不影响启动）：${message}`)
    return null
  }
}
