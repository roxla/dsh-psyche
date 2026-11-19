/**
 * 可信通道绑定（R6-3A）。
 *
 * 冻结的核心原则：
 *   **Adapter 可以提供身份声明，但只有 Host 能把身份声明转换成可信 RuntimeInput。**
 *
 * 分层：
 *   1. Adapter 只提交 `ChannelIdentityClaim`（平台稳定身份 + 会话类型）；
 *   2. Host 的 `ChannelAdapterRegistry` 在 Agent 创建时询问已注册 Adapter「是不是你」；
 *   3. Host 校验声明、由 Core 解析 Contact / Room，再申请一次性绑定能力；
 *   4. `RuntimeInputStore.bind()` 只接受这份能力。
 *
 * Adapter 因此不需要、也不能接触 SQLite 主键（contactId / roomId）——
 * 它们由 Core 按 platform + 稳定身份解析，解析不到就收紧到全局，绝不退回更宽的域。
 */
import type {
  ChannelAdapterDefinition,
  ChannelIdentityClaim,
  TrustedChannelBinding,
} from 'dsh-psyche-contract'
import type { Db } from './adapter.js'
import { CODE, PsycheError } from './errors.js'
import { resolveRoomId } from './recall.js'
import {
  createHostBindingCapability,
  surfaceOfPlatform,
  type RuntimeInputStore,
  type RuntimeSurface,
} from './runtime-input.js'

/** 注册后的句柄：只暴露注销能力，不暴露绑定能力。 */
export interface RegisteredChannelAdapter {
  readonly adapterId: string
  readonly platform: string
  dispose(): void
}

interface Registration {
  definition: ChannelAdapterDefinition
  allowedSurfaces: ReadonlySet<RuntimeSurface>
  active: boolean
  /** 每次注册递增；注销后旧 claim 的 generation 不再匹配。 */
  generation: number
}

/**
 * Agent 生命周期的代际计数（R6-4A）。
 *
 * `clear()` 只能清掉「已经写进去的绑定」，清不掉「还在路上的异步解析」。
 * 所以每个 Session 维护一个递增的 generation：创建时 begin、销毁时 end，
 * 迟到的异步结果在最终写入前必须重新确认自己仍是当前代际，
 * 否则旧任务会把刚清掉的权限重新写回来。
 */
export class AgentBindingLifecycle {
  readonly #generations = new Map<string, number>()

  begin(sessionId: string): number {
    const next = (this.#generations.get(sessionId) ?? 0) + 1
    this.#generations.set(sessionId, next)
    return next
  }

  end(sessionId: string): void {
    this.#generations.set(sessionId, (this.#generations.get(sessionId) ?? 0) + 1)
  }

  isCurrent(sessionId: string, generation: number): boolean {
    return this.#generations.get(sessionId) === generation
  }

  size(): number {
    return this.#generations.size
  }
}

const ALL_SURFACES: ReadonlyArray<RuntimeSurface> = ['personal', 'private', 'group']

/**
 * Host 私有的 Adapter 注册表。
 *
 * 注册时登记 adapterId / platform / allowedSurfaces；注销后立即失效，
 * 正在使用的绑定由 Host 在 `agent/disposed` 时清理（见 `clearBindingsFor`）。
 */
export class ChannelAdapterRegistry {
  readonly #registrations = new Map<string, Registration>()
  #nextGeneration = 1

  register(definition: ChannelAdapterDefinition): RegisteredChannelAdapter {
    const adapterId = requireString(definition.adapterId, 'adapterId', 120)
    const platform = requireString(definition.platform, 'platform', 60)
    if (this.#registrations.has(adapterId)) {
      throw new PsycheError(CODE.state, `Adapter ${adapterId} 已经注册，不能重复注册`)
    }
    const allowed = new Set<RuntimeSurface>(definition.allowedSurfaces ?? ALL_SURFACES)
    if (allowed.size === 0) {
      throw new PsycheError(CODE.validation, 'Adapter 的 allowedSurfaces 不能为空')
    }
    const registration: Registration = {
      definition: { ...definition, adapterId, platform },
      allowedSurfaces: allowed,
      active: true,
      generation: this.#nextGeneration,
    }
    this.#nextGeneration += 1
    this.#registrations.set(adapterId, registration)
    return {
      adapterId,
      platform,
      dispose: () => {
        registration.active = false
        // 注销后同 ID 可以重新注册，旧 claim 的 generation 不再匹配。
        if (this.#registrations.get(adapterId) === registration) {
          this.#registrations.delete(adapterId)
        }
      },
    }
  }

  /** 按平台过滤后依次询问；第一个返回非空声明的 Adapter 认领这个会话。 */
  async claim(
    context: { agentId: string; sessionId: string; platformHint?: string },
  ): Promise<{
    definition: ChannelAdapterDefinition
    allowedSurfaces: ReadonlySet<RuntimeSurface>
    claim: ChannelIdentityClaim
    generation: number
  } | null> {
    for (const registration of [...this.#registrations.values()]) {
      if (!registration.active) continue
      if (context.platformHint !== undefined && registration.definition.platform !== context.platformHint) {
        continue
      }
      const claimed = await registration.definition.resolveIdentity({
        agentId: context.agentId,
        sessionId: context.sessionId,
        platform: registration.definition.platform,
      })
      if (claimed === null || claimed === undefined) continue
      return {
        definition: registration.definition,
        allowedSurfaces: registration.allowedSurfaces,
        claim: claimed,
        generation: registration.generation,
      }
    }
    return null
  }

  /**
   * 这次认领是否仍然有效。
   *
   * 不能在调用 `resolveIdentity()` 之前只检查一次 `active`——解析可能很慢，
   * 期间 Adapter 可能被注销，或者同 ID 被重新注册（新授权能力）。
   */
  isActive(adapterId: string, generation: number): boolean {
    const registration = this.#registrations.get(adapterId)
    return registration !== undefined && registration.active && registration.generation === generation
  }

  has(adapterId: string): boolean {
    return this.#registrations.has(adapterId)
  }

  size(): number {
    return this.#registrations.size
  }
}

export interface ResolveContactBinding {
  platform: string
  stableUserId: string
  displayName?: string | null
}

export interface TrustedBindingDeps {
  db: Db
  store: RuntimeInputStore
  registry: ChannelAdapterRegistry
  /** 由 Core 解析 Contact；解析失败返回 null（只允许全局记忆）。 */
  resolveContact(input: ResolveContactBinding): Promise<{ contactId: string } | null>
  /** Host 的 Agent 生命周期；异步解析结束前必须重新确认代际仍然有效。 */
  lifecycle?: AgentBindingLifecycle
}

export interface TrustedBindingRequest {
  agentId: string
  sessionId: string
  /** 已知平台时只问该平台的 Adapter，避免多个通道互相认领。 */
  platformHint?: string
  /** `AgentBindingLifecycle.begin()` 返回的代际；迟到的结果必须拿它复核。 */
  generation?: number
}

/** 内部审计用的拒绝原因；调用方只会收到收窄后的结果（null / 抛错），不把它透给模型。 */
export type ChannelBindingRejection =
  | 'no-adapter'
  | 'surface-not-allowed'
  | 'invalid-claim'
  | 'group-missing-room'
  | 'private-with-room-context'
  | 'adapter-inactive'
  | 'agent-disposed'

/**
 * 每个异步步骤结束后、最终写入前复核：Agent 代际与 Adapter 注册代际都仍然有效。
 *
 * 少了这一步，`disposed → clear()` 之后迟到的解析会把旧权限重新写回去；
 * 同理，Adapter 注销后同 ID 重新注册，旧 Promise 不能用新授权能力绑定。
 */
function assertStillValid(
  deps: TrustedBindingDeps,
  request: TrustedBindingRequest,
  adapterId: string,
  adapterGeneration: number,
): void {
  if (deps.lifecycle !== undefined && request.generation !== undefined) {
    if (!deps.lifecycle.isCurrent(request.sessionId, request.generation)) {
      throw new PsycheError(CODE.state, 'Agent 已销毁或已重建，迟到的身份解析被丢弃')
    }
  }
  if (!deps.registry.isActive(adapterId, adapterGeneration)) {
    throw new PsycheError(CODE.state, 'Adapter 已注销或已重新注册，迟到的身份解析被丢弃')
  }
}

interface ValidatedClaim {
  claim: ChannelIdentityClaim
  surface: RuntimeSurface
  groupId: string | null
  channelId: string | null
  externalRoomId: string | null
}

function validateClaim(
  claim: ChannelIdentityClaim,
  allowedSurfaces: ReadonlySet<RuntimeSurface>,
): ValidatedClaim {
  if (typeof claim !== 'object' || claim === null) {
    throw new PsycheError(CODE.validation, '身份声明必须是对象')
  }
  const stableUserId = requireString((claim as { stableUserId?: unknown }).stableUserId, 'stableUserId')
  const kind = (claim as { kind?: unknown }).kind
  const channelId = optionalString((claim as { channelId?: unknown }).channelId, 'channelId')

  if (kind === 'group') {
    const externalRoomId = requireString((claim as { externalRoomId?: unknown }).externalRoomId, 'externalRoomId', 120)
    const surface: RuntimeSurface = 'group'
    if (!allowedSurfaces.has(surface)) {
      throw new PsycheError(CODE.state, `Adapter 未获授权运行在 ${surface} 表面`)
    }
    return { claim, surface, groupId: externalRoomId, channelId: channelId ?? null, externalRoomId }
  }

  if (kind === 'personal' || kind === 'private') {
    if ('externalRoomId' in claim && (claim as { externalRoomId?: unknown }).externalRoomId !== undefined) {
      throw new PsycheError(CODE.validation, '私聊/个人声明不能携带群上下文（externalRoomId）')
    }
    const surface: RuntimeSurface = kind
    if (!allowedSurfaces.has(surface)) {
      throw new PsycheError(CODE.state, `Adapter 未获授权运行在 ${surface} 表面`)
    }
    return { claim, surface, groupId: null, channelId: channelId ?? null, externalRoomId: null }
  }

  throw new PsycheError(CODE.validation, `未知的身份声明类型：${String(kind)}`)
}

/**
 * 把一次身份声明解析成可信绑定并写入 store。
 *
 * 返回 null 表示「没有任何已注册 Adapter 认领这个会话」——调用方必须当作无绑定，
 * 只允许全局记忆；不要用 desktop 默认值之类的兜底。
 */
export async function resolveTrustedBinding(
  deps: TrustedBindingDeps,
  request: TrustedBindingRequest,
): Promise<TrustedChannelBinding | null> {
  const sessionId = requireString(request.sessionId, 'sessionId')
  const agentId = requireString(request.agentId, 'agentId')
  const claimed = await deps.registry.claim({ agentId, sessionId, platformHint: request.platformHint })
  if (claimed === null) return null

  const { definition, allowedSurfaces, generation: adapterGeneration } = claimed
  // 第一个检查点：Adapter 认领可能很慢，返回时它可能已经被注销/重注册。
  assertStillValid(deps, request, definition.adapterId, adapterGeneration)
  const validated = validateClaim(claimed.claim, allowedSurfaces)
  const { surface, groupId, channelId, externalRoomId } = validated

  // 群聊的接触者身份不进入授权域：群聊只能凭当前 Room 访问记忆，
  // 发送者的私聊记忆不能被「他也在这个群里」带出来。
  // personal 表面允许本人 private：所以 personal 也要解析出本人的 Contact。
  let contactId: string | null = null
  if (surface === 'personal' || surface === 'private') {
    const resolved = await deps.resolveContact({
      platform: definition.platform,
      stableUserId: claimed.claim.stableUserId,
    })
    contactId = resolved?.contactId ?? null
  }

  // 第二个检查点：Contact 解析同样可能跨过一个 disposed。
  assertStillValid(deps, request, definition.adapterId, adapterGeneration)

  const roomId = externalRoomId === null ? null : resolveRoomId(deps.db, definition.platform, externalRoomId)
  const fields = {
    platform: definition.platform,
    stableUserId: claimed.claim.stableUserId,
    contactId,
    sessionId,
    channelId: channelId ?? undefined,
    groupId: groupId ?? undefined,
    trustedSource: 'channel-adapter' as const,
  }

  // 第三个检查点：写库前最后确认——这是「迟到的旧结果不得复活权限」的最后一道门。
  assertStillValid(deps, request, definition.adapterId, adapterGeneration)

  const capability = createHostBindingCapability({
    sessionId,
    platform: definition.platform,
    adapterId: definition.adapterId,
  })
  const bound = deps.store.bind(capability, fields)

  return {
    sessionId: bound.sessionId,
    platform: bound.platform,
    stableUserId: bound.stableUserId,
    contactId: bound.contactId,
    groupId: bound.groupId ?? null,
    roomId,
    channelId: bound.channelId ?? null,
    surface: surfaceOfPlatform(bound.platform, bound.groupId ?? null),
    trustedSource: bound.trustedSource,
  }
}

/** 注销 Adapter 后清理它认领过的会话绑定（Host 的 agent/disposed 也复用这条路径）。 */
export function clearBindingsFor(store: RuntimeInputStore, platform: string, sessionIds: ReadonlyArray<string>): number {
  let removed = 0
  for (const sessionId of sessionIds) {
    const bound = store.read(sessionId)
    if (bound !== null && bound.platform === platform) {
      if (store.clear(sessionId)) removed += 1
    }
  }
  return removed
}

function requireString(value: unknown, field: string, max = 200): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) throw new PsycheError(CODE.validation, `${field} 不能为空`)
  if (text.length > max) throw new PsycheError(CODE.validation, `${field} 过长（最多 ${max} 字符）`)
  return text
}

function optionalString(value: unknown, field: string, max = 200): string | null {
  if (value === undefined || value === null) return null
  return requireString(value, field, max)
}
