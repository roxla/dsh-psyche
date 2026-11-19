/**
 * 三层 API 契约（D1-1 冻结，契约版本 1.0.0）：
 * - CoreApi（10）：对话与工具都只通过它与记忆内核对话；
 * - ChannelApi（2）：通道插件接线（采集与联系人解析）；
 * - OwnerApi（5）：所有者管理动作，通道不得调用；
 * - SharedApi（2）：面板/通道共用的只读查询。
 *
 * 边界：本文件只声明接口与运行时窄接口构造器，不含实现；
 * 不 import 宿主、SQLite、文件系统（窄接口构造器只是白名单转发）。
 */
import type { CaptureResult, RuntimeInput } from './runtime.js'
import type {
  CaptureInput,
  ClashInput,
  ClashPayload,
  ContextPayload,
  FetchPayload,
  GrowthPayload,
  ProposeInput,
  ProposePayload,
  ReadResult,
  RecallPayload,
  RecallQuery,
  RelationshipPayload,
  RememberInput,
  RememberPayload,
  ResolveContactInput,
  ReviewInput,
  ReviewPayload,
  ReviseInput,
  RevisePayload,
  StancesPayload,
  StancesQuery,
  StatePayload,
  WriteResult,
} from './types.js'

/** Core 健康状态；面板与通道探活只认这一张。 */
export interface CoreHealth {
  ready: boolean
  /** 驱动名由 Core 填（node:sqlite / better-sqlite3）；契约不约束实现。 */
  driver: string
  contractVersion: string
}

/** 对话与工具面（10 个方法）。 */
export interface CoreApi {
  readonly contractVersion: string
  remember(input: RememberInput): Promise<WriteResult<RememberPayload>>
  clash(input: ClashInput): Promise<WriteResult<ClashPayload>>
  revise(input: ReviseInput): Promise<WriteResult<RevisePayload>>
  review(input: ReviewInput): Promise<WriteResult<ReviewPayload>>
  propose(input: ProposeInput): Promise<WriteResult<ProposePayload>>
  stances(query?: StancesQuery): Promise<ReadResult<StancesPayload>>
  recall(query?: RecallQuery): Promise<ReadResult<RecallPayload>>
  fetch(ids?: string | string[], budget?: number): Promise<ReadResult<FetchPayload>>
  context(): Promise<ReadResult<ContextPayload>>
  getState(options?: { audit?: boolean }): Promise<ReadResult<StatePayload>>
}

/** 通道接线面（2 个方法）：通道只做归一，不写库。 */
export interface ChannelApi {
  /**
   * 采集一条平台消息。幂等键 = platform + session_ref + captureKey（P2-CAP-1a）：
   * 同身份同内容重放返回原 sourceId 且 replayed=true，同身份不同内容抛 E_CAPTURE_CONFLICT；
   * messageId 只作平台元数据，不承担幂等职责（不同轮次可能发同样的话）。
   */
  capture(input: CaptureInput): Promise<{ ok: true } & CaptureResult>
  /** 解析/建档一个联系人。 */
  resolveContact(input: ResolveContactInput): Promise<{ ok: true; contactId: string; created: boolean }>
}

/** 所有者管理面（5 个方法）：只给本机 UI / CLI，不允许通道调用。 */
export interface OwnerApi {
  readonly kind: 'owner'
  getGrowth(options?: { audit?: boolean }): Promise<ReadResult<GrowthPayload>>
  syncGrowth(): Promise<{ advanced: unknown }>
  createGrowthProposal(input?: { statement?: string; rationale?: string }): Promise<Record<string, unknown>>
  confirmGrowthProposal(input: Record<string, unknown>): Promise<Record<string, unknown>>
  redactMilestone(milestoneId: string): Promise<{ milestoneId: string; redacted: number }>
}

/** 面板与通道共用的只读查询（2 个方法）。 */
export interface SharedApi {
  getRelationship(contactId?: string): Promise<ReadResult<RelationshipPayload>>
  /** 健康探活；`status` 是旧名，保留以便面板先接通。 */
  status(): Promise<CoreHealth>
}

/** Core 的完整公共面（19 个方法 = 10 + 2 + 5 + 2）。 */
export type PsycheCoreShape = CoreApi & ChannelApi & OwnerApi & SharedApi

/**
 * 运行时窄接口：只把白名单里的方法包出来，未列出的能力在对象上根本不存在
 * （不是 TypeScript `Pick` 那种「编译期看不见、运行时还在」的边界）。
 */
export function createChannelApi(core: PsycheCoreShape): ChannelApi {
  return {
    capture: (input: CaptureInput) => core.capture(input),
    resolveContact: (input: ResolveContactInput) => core.resolveContact(input),
  }
}

export function createOwnerApi(core: PsycheCoreShape): OwnerApi {
  return {
    kind: 'owner',
    getGrowth: (options) => core.getGrowth(options),
    syncGrowth: () => core.syncGrowth(),
    createGrowthProposal: (input) => core.createGrowthProposal(input),
    confirmGrowthProposal: (input) => core.confirmGrowthProposal(input),
    redactMilestone: (milestoneId) => core.redactMilestone(milestoneId),
  }
}

/** 运行时窄接口的会话面：只保留对话与召回。 */
export function createCoreApi(core: PsycheCoreShape): CoreApi {
  return {
    contractVersion: core.contractVersion,
    remember: (input) => core.remember(input),
    clash: (input) => core.clash(input),
    revise: (input) => core.revise(input),
    review: (input) => core.review(input),
    propose: (input) => core.propose(input),
    stances: (query) => core.stances(query),
    recall: (query) => core.recall(query),
    fetch: (ids, budget) => core.fetch(ids, budget),
    context: () => core.context(),
    getState: (options) => core.getState(options),
  }
}

/** 19 个正式方法的清单，供启动自检与文档对齐（不参与类型约束）。 */
export const PSYCHE_API_METHODS = [
  'remember',
  'clash',
  'revise',
  'review',
  'propose',
  'stances',
  'recall',
  'fetch',
  'context',
  'getState',
  'capture',
  'resolveContact',
  'getGrowth',
  'syncGrowth',
  'createGrowthProposal',
  'confirmGrowthProposal',
  'redactMilestone',
  'getRelationship',
  'status',
] as const
export type PsycheApiMethod = (typeof PSYCHE_API_METHODS)[number]

/** 恢复/迁移期的写入冻结不在 19 个正式方法内；这是 Core 的可选内部能力。 */
export interface WriteFreeze {
  freezeWrites(reason: string): void
  unfreezeWrites(): void
}
