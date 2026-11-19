/**
 * RuntimeInput：一次会话/请求的可信身份输入。
 *
 * 语义边界（E5.5-B）：
 * - 身份由**可信 Channel Adapter / Host** 在创建或恢复 Agent 时绑定，
 *   不来自模型工具参数、用户自我介绍、显示名或候选记忆字段；
 * - 绑定以 sessionId 为键，会话生命周期内不可换人；
 * - `agent/pre-step` 只能读取，不能改写；
 * - 没有绑定时视为「无 Contact 私有范围」，只允许全局记忆。
 *
 * 注意：DSH 当前没有请求级 carrier（`agent/pre-step` payload 不含 Contact，
 * Session header 也不接受自定义字段）。因此本模块实现的是**会话级绑定**，
 * 请求级切换如实标记为接线阻塞，不用全局变量或 agent-scoped 状态补洞。
 */
import { CODE, PsycheError } from './errors.js'
import type { RuntimeSurface } from 'dsh-psyche-contract'

export type { RuntimeSurface } from 'dsh-psyche-contract'

/** 允许写入绑定的来源；模型工具参数不可能出现在这里。 */
export const TRUSTED_SOURCES = ['channel-adapter', 'host'] as const
export type TrustedSource = (typeof TRUSTED_SOURCES)[number]

/** 绑定所需的身份字段（由可信适配器提供）。 */
export interface RuntimeInputFields {
  /** 渠道平台：qq / desktop / web / pet 等。 */
  platform: string
  /** 平台内稳定用户 ID（不得用显示名代替）。 */
  stableUserId: string
  /** Core.resolveContact() 返回的 Contact id；空表示无法可信识别。 */
  contactId: string | null
  /** DSH Session id；Agent id 与它一致。 */
  sessionId: string
  /** 渠道会话 id（QQ 私聊/群聊等），可选。 */
  channelId?: string
  /** 群组 id，可选。 */
  groupId?: string
  /** 绑定来源，必填。 */
  trustedSource: TrustedSource
}

/** 冻结后的会话身份。 */
export interface RuntimeInput extends Readonly<RuntimeInputFields> {
  readonly boundAt: string
}

/** 单次请求的快照（身份字段 + 请求定位）。 */
export interface RuntimeRequestInput extends RuntimeInput {
  readonly requestId: string
  readonly turn: number
  readonly step: number
  /** 调用用途，默认 chat；compaction/session-title/subagent 由调用方显式传入。 */
  readonly purpose: string
}

/** Agent 对象的最小结构（避免依赖 DSH 类型）。 */
export interface AgentLike {
  id?: string
  session?: { id?: string }
}

const MAX_FIELD = 200
const CONTACT_PATTERN = /^ct_[A-Za-z0-9]+$/
/** 会话生命周期内不可变的身份维度；任一变化都必须换 Session。 */
const IMMUTABLE_FIELDS = [
  'platform',
  'stableUserId',
  'contactId',
  'groupId',
  'channelId',
  'trustedSource',
] as const satisfies ReadonlyArray<keyof RuntimeInput>

function requireString(value: unknown, field: string, max = MAX_FIELD): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) throw new PsycheError(CODE.validation, `${field} 不能为空`)
  if (text.length > max) throw new PsycheError(CODE.validation, `${field} 过长（最多 ${max} 字符）`)
  return text
}

function optionalString(value: unknown, field: string, max = MAX_FIELD): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireString(value, field, max)
}

function requireTrustedSource(value: unknown): TrustedSource {
  if (value !== 'channel-adapter' && value !== 'host') {
    throw new PsycheError(CODE.validation, `trustedSource 只能是 ${TRUSTED_SOURCES.join(' / ')}`)
  }
  return value
}

function requireContactId(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const text = requireString(value, 'contactId', 120)
  if (!CONTACT_PATTERN.test(text)) {
    throw new PsycheError(CODE.validation, 'contactId 必须形如 ct_xxx')
  }
  return text
}

/** 可信运行表面：由平台类型 + 是否带群身份推导，模型参数不能影响它。 */

/**
 * 由平台与群身份推导运行表面。
 *
 * 这个规则必须只有一份：注入时（PreStep）、最终检查时（FinalCheck）、主动 Recall
 * 的 Scope 推导都调它。各写一份的结果是某天一处改了、另一处没改——那次漂移就是越权。
 */
export function surfaceOfPlatform(platform: string, groupId?: string | null): RuntimeSurface {
  if (platform === 'desktop' || platform === 'web' || platform === 'system' || platform === 'dsh') {
    return 'personal'
  }
  if (groupId !== null && groupId !== undefined && groupId !== '') return 'group'
  return 'private'
}

/** 校验并冻结一份 RuntimeInput；供可信 Adapter 与测试共用。 */
export function createRuntimeInput(fields: RuntimeInputFields, now: () => string = () => new Date().toISOString()): RuntimeInput {
  const input: RuntimeInput = {
    platform: requireString(fields.platform, 'platform'),
    stableUserId: requireString(fields.stableUserId, 'stableUserId'),
    contactId: requireContactId(fields.contactId),
    sessionId: requireString(fields.sessionId, 'sessionId'),
    channelId: optionalString(fields.channelId, 'channelId'),
    groupId: optionalString(fields.groupId, 'groupId'),
    trustedSource: requireTrustedSource(fields.trustedSource),
    boundAt: now(),
  }
  return Object.freeze(input)
}

const BINDING_CAPABILITY = Symbol('psyche.host-binding-capability')

/**
 * Host 内部的一次性绑定能力（R6-3A）。
 *
 * 只有 Host 在确认「这个 Agent Session 已由某个可信 Adapter 认领」之后才创建它，
 * 并且只在当前 sessionId / platform 上有效、用完即焚。Adapter 拿不到这个类的
 * 构造入口（token 是模块私有 Symbol），普通插件即使知道 `RuntimeInputStore.bind()`
 * 的签名，也无法凭空造出一份「可信身份」——伪造的对象在 `isHostBindingCapability()`
 * 处就被拒绝。
 */
export class HostBindingCapability {
  readonly [BINDING_CAPABILITY]: true = true
  readonly sessionId: string
  readonly platform: string
  readonly adapterId: string | null
  #used = false

  constructor(token: symbol, fields: { sessionId: string; platform: string; adapterId: string | null }) {
    if (token !== BINDING_CAPABILITY) {
      throw new PsycheError(CODE.validation, '可信绑定能力只能由 Host 创建')
    }
    this.sessionId = requireString(fields.sessionId, 'capability.sessionId')
    this.platform = requireString(fields.platform, 'capability.platform')
    this.adapterId = fields.adapterId == null ? null : requireString(fields.adapterId, 'capability.adapterId', 120)
  }

  get used(): boolean {
    return this.#used
  }

  /** 核销能力；重复核销直接拒绝，绑定失败也必须重新申请。 */
  consume(): void {
    if (this.#used) {
      throw new PsycheError(CODE.state, '可信绑定能力已经被使用过，不能重复核销')
    }
    this.#used = true
  }
}

/** 仅 Host 内部调用：为一次具体的 Agent 生命周期创建绑定能力。 */
export function createHostBindingCapability(fields: {
  sessionId: string
  platform: string
  adapterId: string | null
}): HostBindingCapability {
  return new HostBindingCapability(BINDING_CAPABILITY, fields)
}

export function isHostBindingCapability(value: unknown): value is HostBindingCapability {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[BINDING_CAPABILITY] === true
  )
}

/** 会话级绑定表：sessionId -> RuntimeInput。仅进程内，重启后由 Adapter 重新绑定。 */
export class RuntimeInputStore {
  readonly #bySession = new Map<string, RuntimeInput>()
  readonly #now: () => string

  constructor(options: { now?: () => string } = {}) {
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  /**
   * 绑定一个会话的可信身份。
   *
   * 只接受 Host 通过 `createHostBindingCapability()` 发放的一次性能力（R6-3A）：
   * - 普通插件、模型工具参数、普通 HTTP 请求体都拿不到能力对象，直接绑定会被拒绝；
   * - 能力与 Session / platform 绑定，不能拿去绑别的 Session；
   * - 同一会话重复绑定**完全一致**的身份：幂等返回旧对象（不消耗能力）；
   * - 同一会话任一身份维度（platform/stableUserId/contactId/groupId/channelId/
   *   trustedSource）变化：拒绝。会话身份在生命周期内不可变，换群/换 Contact
   *   必须使用新的 Agent Session，不能沿用旧绑定继续召回。
   */
  bind(capability: HostBindingCapability, fields: RuntimeInputFields): RuntimeInput {
    const next = createRuntimeInput(fields, this.#now)
    const existing = this.#bySession.get(next.sessionId)
    if (existing !== undefined) {
      const changed = IMMUTABLE_FIELDS.filter((field) => existing[field] !== next[field])
      if (changed.length > 0) {
        throw new PsycheError(
          CODE.state,
          `会话 ${next.sessionId} 已绑定其他身份，不能中途更换（变更字段：${changed.join(', ')}）；请使用新的 Agent Session`,
        )
      }
      return existing
    }
    if (!isHostBindingCapability(capability)) {
      throw new PsycheError(
        CODE.validation,
        '可信绑定只能由 Host 通过内部绑定能力建立；普通插件、模型参数与请求体不能直接绑定身份',
      )
    }
    if (capability.used) {
      throw new PsycheError(CODE.state, '可信绑定能力已被使用；绑定失败后需要 Host 重新申请')
    }
    if (capability.sessionId !== next.sessionId) {
      throw new PsycheError(
        CODE.state,
        `绑定能力属于会话 ${capability.sessionId}，不能用于会话 ${next.sessionId}`,
      )
    }
    if (capability.platform !== next.platform) {
      throw new PsycheError(
        CODE.state,
        `绑定能力属于平台 ${capability.platform}，不能绑定平台 ${next.platform}`,
      )
    }
    if (capability.adapterId !== null && next.trustedSource !== 'channel-adapter') {
      throw new PsycheError(CODE.state, '通道 Adapter 签发的绑定只能以 channel-adapter 作为 trustedSource')
    }
    capability.consume()
    this.#bySession.set(next.sessionId, next)
    return next
  }

  read(sessionId: string): RuntimeInput | null {
    return this.#bySession.get(sessionId) ?? null
  }

  /** 读取 Agent 对应会话的绑定；拿不到 sessionId 返回 null。 */
  readForAgent(agent: AgentLike | undefined | null): RuntimeInput | null {
    if (agent === undefined || agent === null) return null
    const sessionId = typeof agent.id === 'string' && agent.id.length > 0 ? agent.id : agent.session?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    return this.read(sessionId)
  }

  /**
   * 生成一次请求的快照。身份字段来自会话绑定；turn/step/purpose 来自本次请求。
   * 没有绑定返回 null（调用方必须降级为「无 Contact 私有记忆」）。
   */
  requestFor(
    agent: AgentLike | undefined | null,
    request: { turn: number; step: number; purpose?: string },
    requestId: () => string = () => `req_${Math.random().toString(36).slice(2, 10)}`,
  ): RuntimeRequestInput | null {
    const input = this.readForAgent(agent)
    if (input === null) return null
    const turn = Number.isSafeInteger(request.turn) && request.turn >= 0 ? request.turn : 0
    const step = Number.isSafeInteger(request.step) && request.step >= 0 ? request.step : 0
    const purpose = optionalString(request.purpose, 'purpose', 60) ?? 'chat'
    return Object.freeze({
      ...input,
      requestId: requireString(requestId(), 'requestId', 120),
      turn,
      step,
      purpose,
    })
  }

  clear(sessionId: string): boolean {
    return this.#bySession.delete(sessionId)
  }

  size(): number {
    return this.#bySession.size
  }
}

/** 按 sessionId 校验 agent 与绑定一致；不一致返回 false（调用方降级）。 */
export function sessionMatches(input: RuntimeInput, agent: AgentLike | undefined | null): boolean {
  if (agent === undefined || agent === null) return false
  const sessionId = typeof agent.id === 'string' && agent.id.length > 0 ? agent.id : agent.session?.id
  return sessionId === input.sessionId
}
