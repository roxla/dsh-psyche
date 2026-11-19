/**
 * dsh-psyche-qq —— QQ 通道包。
 *
 * 三层职责（不要把人格/记忆写进这里）：
 * 1. event.ts：SnowLuma OneBot 事件 → ChannelIdentityClaim（只在平台事实上翻译，不建绑定）；
 * 2. adapter.ts：交给 Host 注册的 ChannelAdapterDefinition + 会话声明表（不碰 RuntimeInputStore）；
 * 3. index.ts（本文件）：包入口与 P1-1 遗留的空通道外壳。
 *
 * R6-3C-Offline 只交付契约与骨架：不连 SnowLuma、不监听 WS、不写 SQLite。
 * 真实私聊/群聊链路（3C-Live）等 SnowLuma 网关可达后再验收。
 */
import type { PsycheCore } from 'dsh-psyche-contract'

export const name = 'dsh-psyche-qq'

export interface QqOptions {
  /** 是否启用；默认 false，显式打开才连。R6-3C-Offline 不连。 */
  enabled?: boolean
}

export interface QqChannel {
  /** 通道生命周期由宿主/用户控制；P1-4 起接 SnowLuma OneBot。 */
  close(): Promise<void>
}

/** P1-1 遗留的空通道：只返回可关闭句柄，不连接、不监听。 */
export function createQqChannel(_core: PsycheCore, _options: QqOptions = {}): QqChannel {
  return {
    async close(): Promise<void> {
      // 3C-Live 起：断开 WS、flush pending、清理定时器。
    },
  }
}

export { toIdentityClaim, hasTextBody } from './event.js'
export type { SnowLumaMessageEvent } from './event.js'
export { createQqAdapter } from './adapter.js'
export type { QqAdapter, QqAdapterOptions } from './adapter.js'

export default { name, create: createQqChannel }
