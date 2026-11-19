/**
 * dsh-psyche-web —— 浏览能力包（P2/P4 落地）。
 *
 * 边界：只读浏览（网页、视频字幕、页面正文），结果作为 Source 交给 Core；
 * 不自动刷、不点赞不三连、不代发内容。
 * P1-1 只声明入口形状。
 */
import type { PsycheCore } from 'dsh-psyche-contract'

export const name = 'dsh-psyche-web'

export interface WebOptions {
  enabled?: boolean
}

export interface WebCapability {
  close(): Promise<void>
}

/** P1-1 骨架：不抓取、不联网，只返回可关闭句柄。 */
export function createWebCapability(_core: PsycheCore, _options: WebOptions = {}): WebCapability {
  return {
    async close(): Promise<void> {
      // P2/P4 起：关闭浏览器通道、取消未完成的抓取。
    },
  }
}

export default { name, create: createWebCapability }
