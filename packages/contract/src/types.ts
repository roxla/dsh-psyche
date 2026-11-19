/**
 * 请求 / 响应类型：契约冻结版（D1-1）。
 *
 * 冻结规则：
 * - 已列出的字段不允许删除、改名或改变语义；
 * - 允许追加可选字段（向后兼容）；
 * - Payload 用 `readonly [key: string]: unknown` 兜底，新增字段不必再改契约；
 * - 本文件不 import Core 内部模块，也不出现 SQLite / 文件路径。
 */
import type { CaptureResult } from './runtime.js'

/** 所有写工具的公共来源引用（事件 id / 来源 id / 活动窗口）。 */
export interface SourceRefsInput {
  refs?: string | string[]
  sourceIds?: string | string[]
  source_ids?: string | string[]
}

/** 采集入参：落一条 Source，不做结论提炼。全空时按本地会话兜底。 */
export interface CaptureInput extends SourceRefsInput {
  at?: string
  session_ref?: string
  roomId?: string | null
  room_id?: string | null
  externalRoomId?: string | null
  roomTitle?: string | null
  senderContactId?: string | null
  sender_contact_id?: string | null
  displayName?: string | null
  messageId?: string | null
  replyToMessageId?: string | null
  mentions?: string | string[]
  quotedSourceRefs?: string | string[]
  quoted_source_refs?: string | string[]
  /** user | external | self；缺省 external。 */
  origin?: string
  kind?: string
  text?: string | null
  assetSha256?: string | null
  /**
   * 外部稳定身份键（P2-CAP-1a 追加）：platform + session_ref + captureKey 唯一确定一条 Source。
   * 通道插件按自己的平台规则生成（DSH 用 `${sessionId}:${seq}`）；不传则不启用投递幂等。
   */
  captureKey?: string | null
  metadata?: Record<string, unknown>
}

/** resolveContact 入参：platform + stableUserId 即可建档。 */
export interface ResolveContactInput {
  platform?: string
  channel?: string
  stableUserId?: string
  stable_user_id?: string
  displayName?: string | null
  externalRoomId?: string | null
  roomTitle?: string | null
}

/** remember：写一条互动事件，门槛够时顺手沉淀一条结论。 */
export interface RememberInput extends SourceRefsInput {
  text?: string
  statement?: string
  eventType?: string
  event_type?: string
  /** fact | belief | impression | relationship | procedure；stance 会被拒。 */
  kind?: string
  confidence?: string
  at?: string
  roomId?: string | null
  causedBy?: string | null
  relationTo?: string | null
  payload?: Record<string, unknown>
  salience?: number
  temporal?: Record<string, unknown>
  directExtraction?: boolean
}

/** clash：撞上一个跟已有结论对不上的事实。 */
export interface ClashInput extends SourceRefsInput {
  targetId?: string
  target_id?: string
  text?: string
  statement?: string
  confidence?: string
  at?: string
}

/** revise：同 id 升版本，或新结论 supersedes 旧结论。 */
export interface ReviseInput extends SourceRefsInput {
  statement?: string
  refs?: string | string[]
  artifactId?: string
  artifact_id?: string
  supersedes?: string
  kind?: string
  state?: string
  confidence?: string
  payload?: Record<string, unknown>
  salience?: number
  temporal?: Record<string, unknown>
}

/** review：对一条结论表态（五档 verdict）。 */
export interface ReviewInput extends SourceRefsInput {
  artifactId?: string
  artifact_id?: string
  verdict?: string
  note?: string
  statement?: string
  confidence?: string
}

/** propose：只能提案改 life 分区。 */
export interface ProposeInput {
  partition?: string
  part?: string
  target?: string
  change?: string
  rationale?: string
  opId?: string
}

export interface StancesQuery {
  kind?: string
  subject?: string
  state?: string | string[]
  limit?: number
}

export interface RecallQuery {
  text?: string
  query?: string
  kind?: string
  subject?: string
  limit?: number
  eventLimit?: number
  includeEvents?: boolean
}

/** 读结果：`ok` + 本次操作 id + 业务字段。 */
export type ReadResult<T> = { ok: true; opId: string } & T
/** 写结果：额外带 `replayed`（同 opId 命中幂等）。 */
export type WriteResult<T> = { ok: true; opId: string; replayed: boolean } & T

/** Payload 统一允许扩展字段；已列出的字段是通道可以依赖的。 */
export interface RememberPayload {
  eventId?: string
  artifactId?: string
  revision?: number
  kind?: string
  readonly [key: string]: unknown
}
export interface ClashPayload {
  eventId?: string
  contradiction?: boolean
  readonly [key: string]: unknown
}
export interface RevisePayload {
  artifactId?: string
  revision?: number
  superseded?: string
  readonly [key: string]: unknown
}
export interface ReviewPayload {
  artifactId?: string
  verdict?: string
  state?: string
  readonly [key: string]: unknown
}
export interface ProposePayload {
  proposalId?: string
  status?: string
  readonly [key: string]: unknown
}
export interface StancesPayload {
  items?: readonly unknown[]
  readonly [key: string]: unknown
}
export interface StatePayload {
  persona?: unknown
  self?: unknown
  phase?: unknown
  counts?: unknown
  readonly [key: string]: unknown
}
export interface GrowthPayload {
  stage?: string
  stageLabel?: string
  gates?: readonly unknown[]
  readonly [key: string]: unknown
}
export interface ContextPayload {
  block?: string
  readonly [key: string]: unknown
}
export interface RelationshipPayload {
  contactId?: string
  affinity?: number
  band?: string
  trust?: unknown
  readonly [key: string]: unknown
}
/**
 * 召回结果（R4-A 契约）：只有这五项。
 * `abstained=true` 表示「没有合格记忆」，不是普通成功空列表；
 * `runId` 当前不生成，等 Recall Run 落地后再由真实 Run 填。
 */
export interface RecallPayload {
  results?: readonly unknown[]
  abstained?: boolean
  abstainReason?: 'no_eligible_results' | null
  guidance?: string
  runId?: string
  readonly [key: string]: unknown
}
export interface FetchPayload {
  items?: readonly unknown[]
  chars?: number
  readonly [key: string]: unknown
}

export type { CaptureResult }

// ============================================================================
// P2 记忆治理预留类型（v27.9 追加，2026-11-06）
//
// 来源：§31「外部方案吸收路线」。这里只声明形状，不代表已实现：
// - 不加进 19 项核心方法，不改契约版本；
// - 不 import 宿主 / SQLite / 文件系统；
// - 实现时由 Core 的 operations 审计与 Artifact 状态机承载。
// ============================================================================

/** 记忆提议状态：提炼结果先成为候选，不直接成为认知。 */
export type MemoryProposalStatus = 'pending' | 'accepted' | 'rejected' | 'expired'

/**
 * 记忆提议入参。`proposalId` 与 Artifact id 一一对应——
 * 候选不是新对象，而是 Artifact 的 `proposed` 状态。
 */
export interface MemoryProposalInput extends SourceRefsInput {
  statement: string
  kind?: string
  /** 支撑这条候选的 Source/Event；实现时强制非空。 */
  evidenceIds?: string | string[]
  confidence?: string
  /** 0–1；只用于排序，不参与事实判断。 */
  importance?: number
  /** 去重依据（同 dedupKey 只保留一条候选）。 */
  dedupKey?: string
  /** 候选有效期；过期只标 expired，不产生正文。 */
  expiresAt?: string
}

export interface MemoryProposalView {
  proposalId: string
  statement: string
  kind: string
  status: MemoryProposalStatus
  evidenceIds: readonly string[]
  confidence: string
  importance: number
  dedupKey: string | null
  expiresAt: string | null
  createdAt: string
  decidedAt: string | null
  decidedBy: string | null
}

export interface MemoryProposalPayload extends MemoryProposalView {
  readonly [key: string]: unknown
}

/**
 * 遗忘的两种模式，不可混为一谈：
 * - cognitive：不再当作当前认知，保留证据与修订历史；
 * - erase：删除原始内容及所有可恢复的派生副本。
 */
export type ForgetMode = 'cognitive' | 'erase'

export type ForgetStatus =
  | 'requested'
  | 'resolving'
  | 'canonical-done'
  | 'derived-done'
  | 'verified'
  | 'failed'

export interface ForgetRequestInput {
  targetKind: 'source' | 'event' | 'artifact' | 'narrative'
  targetId: string
  mode: ForgetMode
  reason?: string
}

export interface ForgetView {
  requestId: string
  targetKind: string
  targetId: string
  mode: ForgetMode
  status: ForgetStatus
  /** 仍未清理干净的派生面（fts / narrative / cache / vector），验证通过时为空。 */
  residual: readonly string[]
  requestedAt: string
  completedAt: string | null
}

export interface ForgetPayload extends ForgetView {
  readonly [key: string]: unknown
}

/**
 * 检索提取度（FSRS 式）：只决定「是否自动注入 / 回忆优先级」，
 * 不决定事实真伪，也不替代 Artifact 的 superseded / forgotten。
 */
export interface RetrievalStateView {
  artifactId: string
  stability: number
  difficulty: number
  retrievability: number
  lastRecallAt: string | null
  recallCount: number
  frozen: boolean
  exemption: 'none' | 'core' | 'open-commitment' | 'manual'
}

/** 人格判读模式：shadow 只记录不生效；live 必须显式开启。 */
export type AppraisalMode = 'off' | 'shadow' | 'live'

export type AppraisalEngine = 'memory' | 'relationship' | 'mood' | 'growth'

export interface AppraisalView {
  appraisalId: string
  engine: AppraisalEngine
  mode: AppraisalMode
  sourceIds: readonly string[]
  /** 模型判读结果（结构化，由各 Engine 定义；契约不约束具体字段）。 */
  judgement: Record<string, unknown>
  confidence: number
  applied: boolean
  /** 规则门槛拦下的原因；applied=true 时为空。 */
  reason: string | null
  createdAt: string
}

export interface AppraisalPayload extends AppraisalView {
  readonly [key: string]: unknown
}
