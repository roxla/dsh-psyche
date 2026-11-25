/**
 * dsh-psyche-ops —— 桌面操作能力包（P5 落地）。
 *
 * 边界：只执行，不替人判断。每一步把 sent（已发出）与 observed（已确认）
 * 分开返回；执行结果只作为 Source 交给 Core，不直接改记忆。
 * P1-1 只声明入口形状。
 */
import type { PsycheCore } from 'dsh-psyche-contract'

export const name = 'roxla-dsh-psyche-ops'

export interface OpsOptions {
  enabled?: boolean
}

export interface OpsCapability {
  close(): Promise<void>
}

/** P1-1 骨架：不接管键鼠、不开窗口，只返回可关闭句柄。 */
export function createOpsCapability(_core: PsycheCore, _options: OpsOptions = {}): OpsCapability {
  return {
    async close(): Promise<void> {
      // P5 起：释放接管、恢复前台窗口、清理提示条。
    },
  }
}

export default { name, create: createOpsCapability }
