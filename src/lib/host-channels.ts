/**
 * R6-3C-Offline：Host 受控的通道注册入口。
 *
 * 为什么要有这一层：
 * - `ChannelAdapterRegistry` 在 Core 里，任何能 import Core 的代码都能 new 一个并注册 Adapter；
 * - 如果 Host 直接把 registry（或 `RuntimeInputStore.bind()`）挂到 `ctx.psyche`/工具/HTTP，
 *   普通插件就能给自己发一个「可信身份」——这正是 R6-3A 要堵的口子。
 *
 * 所以 Host 侧只暴露两个动作，并且都不接受调用方自带的 registry：
 * - `register(id, definition)`：只接受 Host 白名单里的内建 adapterId，且 definition.adapterId 必须与之一致；
 * - `resolve(deps, request)`：由 Host 用自己的 registry 调 `resolveTrustedBinding`。
 *
 * 白名单之外的 Adapter 永远进不来；QQ 的真实接入（3C-Live）也只是把 `qq-snowluma`
 * 加进白名单，由 Host 在配置启用时注册，而不是让 QQ 包自己拿 Registry。
 */
import type { ChannelAdapterDefinition, RuntimeSurface, TrustedChannelBinding } from 'dsh-psyche-contract'
import {
  ChannelAdapterRegistry,
  resolveTrustedBinding,
  type TrustedBindingDeps,
  type TrustedBindingRequest,
} from './channel-binding.js'

/**
 * Host 允许注册的内建 Adapter，以及它们**被固定授权**的 platform 与 surface。
 *
 * 只检查 adapterId 在不在白名单里不够：一个获准的 Adapter 仍可能在定义里
 * 悄悄声明别的 platform 或多出一个 surface（比如让 QQ 也能声明 personal）。
 * 所以授权关系由 Host 这张表定死，注册时逐项核对；Adapter 只能声明它被允许声明的。
 *
 * `qq-snowluma`：platform `qq`，只允许 private / group，**personal 明确禁止**。
 */
interface HostAdapterSpec {
  platform: string
  allowedSurfaces: readonly RuntimeSurface[]
}

const HOST_ADAPTER_SPECS = {
  'host-desktop': { platform: 'desktop', allowedSurfaces: ['personal', 'private'] },
  'qq-snowluma': { platform: 'qq', allowedSurfaces: ['private', 'group'] },
} as const satisfies Record<string, HostAdapterSpec>

export type HostAdapterId = keyof typeof HOST_ADAPTER_SPECS

export const HOST_ADAPTER_ALLOWLIST = Object.keys(HOST_ADAPTER_SPECS) as HostAdapterId[]

export interface HostChannelRegistration {
  adapterId: string
  platform: string
  dispose(): void
}

/** 注册被拒绝时抛出的错误（Host 内部可见，不透给模型）。 */
export class HostChannelRegistrationError extends Error {
  readonly code = 'HOST_CHANNEL_NOT_ALLOWED'

  constructor(message: string) {
    super(message)
    this.name = 'HostChannelRegistrationError'
  }
}

export class HostChannelRegistry {
  readonly #registry = new ChannelAdapterRegistry()
  #disposed = false

  /**
   * 注册一个内建 Adapter。
   *
   * - `id` 必须在白名单里；
   * - `definition.adapterId` 必须等于 `id`（不能拿 A 的授权注册成 B）；
   * - 重复注册由 Core 的 Registry 拒绝。
   */
  register(id: HostAdapterId, definition: ChannelAdapterDefinition): HostChannelRegistration {
    if (this.#disposed) {
      throw new HostChannelRegistrationError('Host 通道注册表已关闭，不能继续注册 Adapter')
    }
    if (!(HOST_ADAPTER_ALLOWLIST as ReadonlyArray<string>).includes(id)) {
      throw new HostChannelRegistrationError(`Adapter ${id} 不在 Host 注册白名单里`)
    }
    if (definition.adapterId !== id) {
      throw new HostChannelRegistrationError(
        `Adapter 声明 ${definition.adapterId} 与注册 id ${id} 不一致，拒绝注册`,
      )
    }
    // 授权关系由 Host 固定：platform 与 allowedSurfaces 必须与规格逐项一致。
    // 只比 adapterId 不够——定义可以在不改 id 的情况下多声明一个 surface。
    const spec = HOST_ADAPTER_SPECS[id]
    if (definition.platform !== spec.platform) {
      throw new HostChannelRegistrationError(
        `Adapter ${id} 声明平台 ${definition.platform}，Host 授权平台是 ${spec.platform}，拒绝注册`,
      )
    }
    const declared = [...(definition.allowedSurfaces ?? [])].sort()
    const expected = [...spec.allowedSurfaces].sort()
    const sameSurfaces =
      declared.length === expected.length && declared.every((surface, index) => surface === expected[index])
    if (!sameSurfaces) {
      throw new HostChannelRegistrationError(
        `Adapter ${id} 声明表面 [${declared.join(',')}]，Host 授权表面是 [${expected.join(',')}]，拒绝注册`,
      )
    }
    return this.#registry.register(definition)
  }

  /** 由 Host 在 `agent/created` 等时机调用；调用方不能传入自己的 registry。 */
  async resolve(
    deps: Omit<TrustedBindingDeps, 'registry'>,
    request: TrustedBindingRequest,
  ): Promise<TrustedChannelBinding | null> {
    if (this.#disposed) return null
    return resolveTrustedBinding({ ...deps, registry: this.#registry }, request)
  }

  has(id: string): boolean {
    return this.#registry.has(id)
  }

  size(): number {
    return this.#registry.size()
  }

  /** 关闭：之后 register/resolve 都拒绝。已注册 Adapter 的注销由调用方持有 handle 自行 dispose。 */
  dispose(): void {
    this.#disposed = true
  }
}
