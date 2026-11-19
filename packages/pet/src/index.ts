/**
 * dsh-psyche-pet —— 桌宠通道包（P5 落地）。
 *
 * 只读：订阅 Core 的投影（心情、关系档位、阶段），决定动画与气泡；
 * 不写库、不注入提示词、不自己生成本轮回复。
 * P1-1 只声明入口形状。
 */
import type { PsycheCore } from 'dsh-psyche-contract'

export const name = 'dsh-psyche-pet'

export interface PetOptions {
  enabled?: boolean
}

export interface PetChannel {
  close(): Promise<void>
}

/** P1-1 骨架：不渲染、不订阅，只返回可关闭句柄。 */
export function createPetChannel(_core: PsycheCore, _options: PetOptions = {}): PetChannel {
  return {
    async close(): Promise<void> {
      // P5 起：取消订阅、停动画、回收窗口。
    },
  }
}

export default { name, create: createPetChannel }
