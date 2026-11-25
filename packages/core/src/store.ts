// 心灵核心存储逻辑（设计 §5 / §9 / §11.3 / §11.4）
//
// 职责边界：
// - 本文件只管「怎么写进 SQLite 才符合设计」，不碰 DSH 的工具/服务形态。
// - 所有写操作走一条事务：BEGIN IMMEDIATE → opId 幂等 → 校验 → 生成 id → 写事件 → 写版本/证据/触发
//   → 写 operations（§11.4 八步；P1 不写 relationship 信号与投影，那是 P3）。
// - 对外方法全部 async（§11.6.1），内部事务是同步的。
//
// 数据模型速览：
// - events / sources 只追加，写过不改；修正靠新增事件，不回头改旧行。
// - artifact 只是壳，内容是 artifact_revisions：按 id 取 max(revision) 当 head，旧 revision 永久保留。
// - 证据独立性看 independenceKey（活动窗口 key），不看 source_id：同一人连说十句也只算 1 条。
// - 状态机按 kind 分，KIND_STATES 是唯一合法状态表，写 revision 前必须过校验。
//
// 写事务八步（见 #write）：查 opId → 比对 argsHash → 校验 → 生成 id → 写 events →
// 写 revision/证据/触发/血统 → 写 operations → 提交。任一步抛错整笔回滚，
// 失败记录另开事务补写（否则连失败记录都一起没了）。
// 幂等：同 opId 同 argsHash 重放（replayed=true）；同 opId 换内容抛 E_IDEMPOTENT_CONFLICT。
// 只读：stances / getState / getGrowth / context / getRelationship / recall / fetch，
// 只经 #read，不写业务表，最多补一条 operations 审计行。
import { createHash, randomUUID } from 'node:crypto'
import { CODE, PsycheError, invalid } from './errors.js'
import { PREFIX, newId, newWindowKey, stableStringify } from './ids.js'
import { nowIso } from './adapter.js'
import type { Db, DbLogger, Row, SqlParams } from './adapter.js'
import type { GroupMessageInput, GroupMessageResult } from './room-intake.js'
import { groupHash, groupNameMatches, groupPartsText, roomPolicy } from './group-policy.js'
import { applyGroupCommand, readGroupBatch, readGroupSchedule, type GroupCommand } from './group-scheduling.js'
import { groupProofData } from './group-proof.js'
import { PHASE_LABELS, PHASE_ORDER, type Gate, type GateResult } from './derive.js'
import { advancePhase, deriveGrowthNow } from './growth.js'
import {
  createGrowthProposal as insertGrowthProposal,
  decideGrowthProposal as applyGrowthDecision,
  redactPhaseEvidence as markEvidenceRedacted,
} from './growth.js'
import { recentApprovedAdjustments } from './proposals.js'
import { assessQuality, type QualityAssessment } from './quality/index.js'
import { decideAdmission, type AdmissionResult } from './admission/index.js'
import { upsertFtsRow } from './fts.js'
import {
  clampAffinity,
  clampDailyDelta,
  deriveRelationshipDelta,
} from './relationship.js'
import {
  AFFECT_KEYS,
  AFFECT_PER_SIGNAL_CAP,
  AFFECT_RULE_VERSION,
  affectDimensionOf,
  clampAffectValue,
  effectiveAffectValues,
  type AffectDimensionKey,
  type ContactAffectInput,
  type ContactAffectPayload,
  type ContactAffectValues,
} from './contact-affect.js'
import {
  MAX_TRUST_DELTA,
  MIN_TRUST_EVIDENCE,
  TRUST_RULE_VERSION,
  clampTrustValue,
  isContactTrustPayload,
  trustBandOf,
  type ContactTrustReviewInput,
  type ContactTrustReviewPayload,
} from './contact-trust.js'
import type { RelationshipBrief } from './relationship-projection.js'
import { RECALL_ABSTAIN_GUIDANCE, recallMemory, type RecallEngineResult, type RecallItem, type RecallResult, type RecallScope } from './recall.js'
import {
  createRecallRun,
  hashQueryText,
  hashRecallScope,
  loadOrCreateRecallKey,
  recordRecallCandidates,
  type RecallKey,
  type RecallScopeType,
} from './recall-receipt.js'
import { requiresDisclosureGrant } from './sensitive.js'
import { quarantinedIds } from './quarantine.js'
import { syncTensions } from './tension-store.js'
import { appendDecisionItems, createDecision, finalizeDecision, getDecision } from './decision-store.js'
import type { DecisionItemInput, DecisionKind } from './decision-store.js'
import { normalizeSubjects } from './tensions.js'
import { planStanceSynthesis, stanceKeyOf, type StanceBeliefInput, type StanceDirection, type StancePlan } from './stance-engine.js'
import {
  loadExistingStance,
  loadStanceBeliefs,
  loadStanceConflicts,
  loadUnresolvedTensionArtifacts,
} from './stance-store.js'

/** P1 是单人格：所有业务表都带 persona_id 列，这里写死 'main'，多租户将来才改。 */
export const PERSONA_ID = 'main'
/** 写进各表 schema_version 列的设计版本号，用来判断老行该按哪版语义读。 */
const SCHEMA_VERSION = '1.0'
/** 活动窗口默认空闲分钟数：同一会话两条来源间隔超过它就算两次独立活动（影响证据独立性）。 */
const DEFAULT_ACTIVITY_WINDOW_MINUTES = 10

// ── 领域枚举（与 schema.ts 的 CHECK 约束一一对应）─────────────
// 这些字面量同时出现在 schema 的 CHECK 里，改一个词要同步改两边，否则写入会被 SQLite 拒掉。

/** 事件大类：interaction=互动里发生了什么；cognitive=她自己的认知变化（只由 Core 写）。 */
export type EventKind = 'interaction' | 'cognitive'
/** 互动子类型，schema 中 events.type 的 CHECK 覆盖这些值（§5.2）。 */
export type InteractionType =
  | 'conversation'
  | 'agreement'
  | 'commitment'
  | 'conflict'
  | 'correction'
  | 'refusal'
  | 'action_result'
/** 认知事件类型：撞上矛盾、立场修订、复核结论、学到事实。 */
export type CognitiveType = 'contradiction_detected' | 'stance_revised' | 'review_result' | 'fact_learned'
/** 事件类型全集（互动 ∪ 认知）；落库时 events.kind 另存一列区分大类。 */
export type EventType = InteractionType | CognitiveType
/** 结论类型：六类，决定可用状态机（KIND_STATES）和晋升门槛（checkPromotion）。 */
export type ArtifactKind = 'fact' | 'belief' | 'impression' | 'stance' | 'relationship' | 'procedure'
/** 结论状态；某个 kind 允许哪些状态由 KIND_STATES 决定，不存在全局合法状态。 */
export type ArtifactState =
  | 'active'
  | 'challenged'
  | 'superseded'
  | 'retracted'
  | 'forgotten'
  | 'draft'
  | 'testing'
  | 'deprecated'
/** 置信度三档；晋升门槛会读它（impression 要求 high），review 可用入参覆盖。 */
export type Confidence = 'low' | 'medium' | 'high'
/** review 的五档判定（§9.1）；nextStateFor 按它决定新 revision 的状态。 */
export type Verdict = 'confirmed' | 'refined' | 'challenged' | 'revised' | 'rejected'
/** 参数分区：life 允许模型提案，relationship / safety 连提案都拒（§12.1）。 */
export type Partition = 'life' | 'relationship' | 'safety'
/** 好感七档；只用于表达（注入措辞），绝不向用户报分数（§6.2）。 */
export type AffinityBand = 'very_close' | 'high' | 'friendly' | 'neutral' | 'cautious' | 'distant' | 'hostile'
/** 来源归属：user=用户自己说的，external=外部内容，self=模型自述（不能拿来自证，§5.2 约束 5）。 */
export type Origin = 'user' | 'external' | 'self'
/** 证据与结论的关系：支持 / 反驳 / 限定 / 仅作背景说明。 */
export type EvidenceRelation = 'supports' | 'contradicts' | 'qualifies' | 'contextualizes'
/** 血统关系：从哪条派生、从哪条修订、从哪条拆出。 */
export type LineageRelation = 'derivedFrom' | 'revisedFrom' | 'splitFrom'
/** 结论之间的关系；supersedes 表示新命题取代旧命题，旧的随之置 superseded。 */
export type ArtifactRelation = 'supersedes' | 'contradicts' | 'tensionWith' | 'relatedTo'
/** 来源载体类型，对应 sources.kind 的 CHECK 约束。 */
export type SourceKind = 'message' | 'image' | 'voice' | 'video' | 'web' | 'action' | 'model'

/** 互动类型白名单；normaliseEventType 用它做枚举校验，并给「没写 eventType」兜底成 conversation。 */
export const INTERACTION_TYPES: readonly InteractionType[] = Object.freeze([
  'conversation',
  'agreement',
  'commitment',
  'conflict',
  'correction',
  'refusal',
  'action_result',
])
/** 认知类型白名单；给 #insertEvent 的调用方做对照（认知事件只由 Core 内部的 recall/clash 路径产生）。 */
export const COGNITIVE_TYPES: readonly CognitiveType[] = Object.freeze([
  'contradiction_detected',
  'stance_revised',
  'review_result',
  'fact_learned',
])

// §5.3 六类 + 附录 A.3 三套状态机
// 这是唯一的状态合法性判据：#insertRevision 落库前查一次，nextStateFor 推迁移时也查它。
/** kind → 合法状态集；注意 fact 没有 challenged（事实不需要「被质疑」这个中间态）。 */
export const KIND_STATES: Readonly<Record<ArtifactKind, readonly ArtifactState[]>> = Object.freeze({
  fact: ['active', 'superseded', 'forgotten'],
  belief: ['active', 'challenged', 'superseded', 'retracted', 'forgotten'],
  impression: ['active', 'challenged', 'superseded', 'retracted', 'forgotten'],
  stance: ['active', 'challenged', 'superseded', 'retracted', 'forgotten'],
  relationship: ['active', 'challenged', 'superseded', 'retracted', 'forgotten'],
  procedure: ['draft', 'testing', 'active', 'deprecated'],
})
/** 新建结论的初始状态：procedure 从 draft 起步（要先试跑），其余直接 active。 */
const INITIAL_STATE: Readonly<Record<ArtifactKind, ArtifactState>> = Object.freeze({
  fact: 'active',
  belief: 'active',
  impression: 'active',
  stance: 'active',
  relationship: 'active',
  procedure: 'draft',
})

// §6.2 七档（只用于注入表达，不向用户报分）
/** 档位规则：min 是下界；BANDS 按 min 降序，bandFor 取第一条命中的就是答案。 */
export interface AffinityBandRule {
  min: number
  band: AffinityBand
  label: string
}
/** 七档边界表；顺序即优先级，bandFor 用 find 拿到第一条命中项。 */
export const BANDS: readonly AffinityBandRule[] = Object.freeze([
  { min: 90, band: 'very_close', label: '非常亲近' },
  { min: 75, band: 'high', label: '较高' },
  { min: 60, band: 'friendly', label: '友好' },
  { min: 45, band: 'neutral', label: '中立' },
  { min: 30, band: 'cautious', label: '谨慎' },
  { min: 15, band: 'distant', label: '疏远' },
  { min: -Infinity, band: 'hostile', label: '强烈反感' },
])

/** verdict 运行时白名单；normaliseVerdict 用它把非法输入变成 E_VALIDATION。 */
const VERDICTS: readonly Verdict[] = Object.freeze(['confirmed', 'refined', 'challenged', 'revised', 'rejected'])
/** partition 运行时白名单；propose 先单独拦 growth/relationship/safety，再走到这里的枚举校验。 */
const PARTITIONS: readonly Partition[] = Object.freeze(['life', 'relationship', 'safety'])
/** 关系查询里「最近信号」的展示条数上限（P1 只给最近一段，不做完整账本翻页）。 */
export const RELATION_QUERY_LIMIT = 20

/** 按亲和度取档位：BANDS 已按 min 降序排好，第一条命中的就是答案，末档兜底负无穷。 */
function bandFor(affinity: number): AffinityBandRule {
  return BANDS.find((item) => affinity >= item.min) ?? BANDS[BANDS.length - 1]!
}

/**
 * 把「数组或分隔字符串」统一成去重后的字符串数组。
 * 入参来自工具调用（可能是 'a,b' / ['a',' b '] / undefined），所以先判类型再切分；
 * 分隔符同时认中英文逗号、分号和空白，避免模型用错标点就丢半个列表。
 * @param value 任意入参；既不是数组也不是字符串时返回空数组。
 * @returns 去空、trim、去重后的数组（保持首次出现顺序）。
 */
export function parseList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]
  }
  if (typeof value !== 'string') return []
  return [...new Set(value.split(/[,，;；\s]+/).map((item) => item.trim()).filter(Boolean))]
}

/** 文本归一：非字符串当空串，超长按字符数截断并补省略号（截断不会切出半个字）。 */
function cleanText(value: unknown, max = 2000): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/** JSON 兜底解析：库里存的是 TEXT，坏了或 NULL 都退回 fallback，不让读取路径因脏数据崩掉。 */
function parseJson<T>(text: unknown, fallback: T): T {
  try {
    const value: unknown = JSON.parse(String(text))
    return value === null || value === undefined ? fallback : (value as T)
  } catch {
    return fallback
  }
}

/** 把任意入参当记录用：非对象一律 {}，避免对 undefined 做展开或取键时抛错。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/**
 * 幂等判据：对入参做稳定序列化后取 sha256 前 32 位。
 * 刻意剔除 opId —— opId 标识「这是哪一次提交」，不能参与「内容有没有变」的比较；
 * 用 stableStringify 而不是 JSON.stringify，是为了让键顺序不同的同内容入参算出同一个 hash。
 */
function hashArgs(args: unknown): string {
  const source: Record<string, unknown> = { ...asRecord(args) }
  delete source.opId
  return createHash('sha256').update(stableStringify(source)).digest('hex').slice(0, 32)
}

/**
 * 披露授权的内容绑定：sha256(statement) 全 64 位。
 * 用全量 hash 而不是 hashArgs 的 32 位前缀，是因为授权凭据要逐字节绑定内容——
 * 前缀碰撞在小概率下会放过「换了内容但前缀相同」的凭据。
 */
function hashText(text: string): string {
  return createHash('sha256').update(String(text)).digest('hex')
}

/**
 * 枚举归一：空值走 fallback（没给 fallback 就是必填，抛 E_VALIDATION）；
 * 非法值同样抛 E_VALIDATION，并在 message 里回显收到的原文，方便调用方自己纠正。
 * @returns 合法值本身（已 trim）。
 */
function normaliseEnum<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback?: T): T {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback
    throw invalid(`${field} 必填，取值：${allowed.join(' / ')}`)
  }
  const text = String(value).trim()
  if ((allowed as readonly string[]).includes(text)) return text as T
  throw invalid(`${field} 只能是 ${allowed.join(' / ')}，收到「${text}」`)
}

/** kind 归一；合法集合直接取自 KIND_STATES 的键，保证「有状态表的类型」才可写。 */
function normaliseKind(value: unknown): ArtifactKind {
  return normaliseEnum(value, Object.keys(KIND_STATES) as ArtifactKind[], 'kind')
}

/** 互动类型归一；缺省按 conversation 处理，因为大多数写入就是一次普通对话。 */
function normaliseEventType(value: unknown): InteractionType {
  return normaliseEnum(value, INTERACTION_TYPES, 'eventType', 'conversation')
}

/** verdict 归一；没有默认值——复核必须明确表态，不能靠缺省蒙混。 */
function normaliseVerdict(value: unknown): Verdict {
  return normaliseEnum(value, VERDICTS, 'verdict')
}

/** partition 归一；没有默认值——提案必须说清改的是哪个分区。 */
function normalisePartition(value: unknown): Partition {
  return normaliseEnum(value, PARTITIONS, 'partition')
}

/** 必填文本：trim + 截断到 max；空串抛 E_VALIDATION（message 里带字段名）。 */
function requireText(value: unknown, field: string, max = 2000): string {
  const text = cleanText(value, max)
  if (!text) throw invalid(`${field} 不能为空`)
  return text
}

// ── 入参 / 出行 形状 ──────────────────────────────────────────

// 入参一律「全可选 + 宽松类型」：值来自工具调用（模型可能传错类型、用蛇形键），
// 所以校验不放在类型层，而是各方法里用 normalise* / requireText 在运行时做，失败抛 E_VALIDATION。

/**
 * 带来源引用的入参公共底座（capture / remember / clash / revise / review 都继承它）。
 * 同一语义给两个键名：snake 形式是工具侧写法，camel 形式是服务侧写法；
 * 消费处一律 `a ?? b` 兜住两种（如 #sourcesForWrite 里的 sourceIds ?? source_ids）。
 */
interface SourceRefsInput {
  /** 支撑这件事的 Source id（数组或逗号分隔字符串）。 */
  sourceIds?: string | string[]
  source_ids?: string | string[]
  /** 这条结论关于谁/什么（§5.3 subjectRefs）。工具侧叫 subject，服务侧叫 subjectRefs。 */
  subjectRefs?: string | string[]
  subject?: string | string[]
  platform?: string
  channel?: string
  sessionRef?: string
  stableUserId?: string | null
  opId?: string
}

/**
 * capture / perceive 的入参：落一条 Source（原始素材），不做任何结论提炼。
 * 全部字段可省，全空时按 dsh/desktop/psyche:default 的本地会话兜底。
 */
export interface CaptureInput extends SourceRefsInput {
  /** 采集时间（ISO 串）；缺省 nowIso()，也是活动窗口切分的比较基准。 */
  at?: string
  session_ref?: string
  /** 已解析的 room 主键；没有就按 externalRoomId 现建，#ensureRoom 对空值返 null。 */
  roomId?: string | null
  room_id?: string | null
  /** 平台侧房间号（群号/频道 id），用于把同一个外部房间复用成同一 room。 */
  externalRoomId?: string | null
  roomTitle?: string | null
  /** 发送者 contact；不给但有 stableUserId 时，在这一步现场解析/建档。 */
  senderContactId?: string | null
  sender_contact_id?: string | null
  displayName?: string | null
  messageId?: string | null
  replyToMessageId?: string | null
  /** 提及/引用的 id 列表，落库前 JSON.stringify 成文本（parseList 统一切分）。 */
  mentions?: string | string[]
  quotedSourceRefs?: string | string[]
  quoted_source_refs?: string | string[]
  /** 'user' | 'external' | 'self'，缺省 external —— 外部内容默认不能证明自己。 */
  origin?: string
  /** 来源载体类型，缺省 message。 */
  kind?: string
  /** 正文；空串会被 cleanText 变成 ''，落库时再转成 NULL（不存空串）。 */
  text?: string | null
  /** 原始素材的哈希，用于同一素材去重/追溯。 */
  assetSha256?: string | null
  /**
   * 外部稳定身份键（P2-CAP-1a）：同一平台 + 同一会话 + 同一 key 只允许一条 Source。
   * DSH 用 `${sessionId}:${seq}` 生成；不传就退化为「每次都是新来源」（手动工具路径靠 opId 幂等）。
   */
  captureKey?: string | null
  metadata?: Record<string, unknown>
}

/** resolveContact 的入参：只要 platform + stableUserId 就能建档，其余用于补显示名/房间。 */
export interface ResolveContactInput {
  platform?: string
  channel?: string
  stableUserId?: string
  stable_user_id?: string
  displayName?: string | null
  externalRoomId?: string | null
  roomTitle?: string | null
}

/**
 * recordRelationshipSignal 的入参（P3-B-1）。
 *
 * 调用方只描述「发生了什么」：哪类信号、什么方向、依据哪些证据、独立键是什么。
 * **不提交 baseDelta / confidence**——分值由 `relationship.ts` 按规则表推导，
 * 防止模型通过参数直接给好感定价。`independenceKey` 是去重键：同一件事重复投递只算一次。
 */
export interface RelationshipSignalInput {
  opId?: string
  contactId?: string
  contact_id?: string
  signalType?: string
  signal_type?: string
  polarity?: string
  /** 证据引用（Source / Event id）；至少一条，B-2 起再收紧归属校验。 */
  evidenceRefs?: string[]
  independenceKey?: string
  independence_key?: string
  sourceId?: string | null
  eventId?: string | null
  /** 记录时间，缺省 now；用于测试固定时钟。 */
  now?: string
}

/** recordRelationshipSignal 的返回：账本行 + 当前好感投影（不对外报分数的上层自行处理）。 */
export interface RelationshipSignalPayload {
  ok: true
  contactId: string
  signalId: string
  duplicate: boolean
  signalType: string
  polarity: string
  baseDelta: number
  appliedDelta: number
  ruleVersion: string
  affinity: number
  band: string
  manualOverride: boolean
  /** 该联系人在本条写入后 24 小时窗口内的净变化。 */
  windowDelta: number
}

/**
 * remember 的入参：写一条互动事件，并（门槛够时）顺手沉淀成一条结论。
 * kind 不给就只落事件；给了就必须同时给 statement（结论本身）。
 */
export interface RememberInput extends SourceRefsInput {
  text?: string
  /** 结论陈述；与 text 二选一即可，text 缺省时用它当事件正文。 */
  statement?: string
  eventType?: string
  event_type?: string
  /** 要沉淀的结论类型（fact / belief / impression / relationship / procedure）；stance 会被拒。 */
  kind?: string
  confidence?: string
  at?: string
  roomId?: string | null
  /** 这条事件由哪条事件引发（落 event_relations.respondsTo）。 */
  causedBy?: string | null
  relationTo?: string | null
  payload?: Record<string, unknown>
  salience?: number
  temporal?: Record<string, unknown>
  directExtraction?: boolean
  /** 披露等级；缺省 `restricted`。public 只表示可进普通检索候选，不等于可向任意渠道公开。 */
  disclosure?: string
  /**
   * 宿主侧签发的披露授权凭据（`grn_…`）。只有当内容被判定为敏感、
   * 且调用方想把披露提到 public 时才需要；模型不能自己伪造，凭据由宿主侧可信流程产生。
   */
  disclosureGrant?: string
}

/**
 * clash 的入参：撞上一个跟已有结论对不上的事实。
 * targetId 指向被撞的结论时记「认知/矛盾」事件，否则记一次普通冲突。
 */
export interface ClashInput extends SourceRefsInput {
  targetId?: string
  target_id?: string
  text?: string
  statement?: string
  confidence?: string
  at?: string
}

/**
 * revise 的入参，两种改法共用：
 * - 给 artifactId：同一结论升一版 revision（旧版保留）；
 * - 给 supersedes：新开一条结论取代旧的（supersedes 关系指回去）。
 */
export interface ReviseInput extends SourceRefsInput {
  statement?: string
  /** 修订依据：命中的 event id 会记为触发事件，并把该事件的来源当「背景证据」带上。 */
  refs?: string | string[]
  artifactId?: string
  artifact_id?: string
  supersedes?: string
  kind?: string
  /** 仅同 id 模式可用：覆盖新 revision 的状态（默认沿用旧状态）。 */
  state?: string
  confidence?: string
  payload?: Record<string, unknown>
  salience?: number
  temporal?: Record<string, unknown>
  /** 披露等级；不传则继承当前 head（new-id 模式继承被取代者），绝不因修订意外放宽。 */
  disclosure?: string
  /**
   * 可选乐观并发检查：调用方认为当前 head 是第几版。
   * 给了就和事务内读到的 head 比对，不一致抛 `E_REVISION_CONFLICT`——
   * 防止两个写入者基于同一版各写一条，后到的悄悄盖掉先到的。
   */
  expectedRevision?: number
  /**
   * 显式恢复已遗忘 / 撤回 / 被取代 / 废弃的结论。
   * 不带它时，改写这些状态会抛 E_STATE——不能无痕把「已经不再使用」的结论改回 active。
   */
  restore?: boolean
  /** 宿主侧签发的披露授权凭据，语义同 `remember`。 */
  disclosureGrant?: string
}

/** review 的入参：对一条已有结论表态（五档 verdict），并附上非自身来源。 */
export interface ReviewInput extends SourceRefsInput {
  artifactId?: string
  artifact_id?: string
  verdict?: string
  note?: string
  statement?: string
  confidence?: string
}

/**
 * `forget` 的入参：认知遗忘——不再把这条结论当作有效认知使用，但不删历史证据。
 * 彻底数据删除是另一条链（Source / Event / Evidence 清理），不在 forget 里做。
 */
export interface ForgetInput {
  artifactId?: string
  artifact_id?: string
  /** 为什么不再用它：只进 operations 审计，不写进结论正文。 */
  reason?: string
  opId?: string
}

/** `forget` 的回执：追加的新 revision 与前后状态；已遗忘时 alreadyForgotten=true。 */
export interface ForgetPayload {
  artifactId: string
  kind: ArtifactKind
  state: ArtifactState
  revision: number
  previousRevision: number
  previousState: ArtifactState
  /** 已经处于遗忘状态：幂等返回，不追加 revision。 */
  alreadyForgotten: boolean
}

/** propose 的入参：只能提案改 life 分区；relationship / safety 连提案都会被拒。 */
export interface ProposeInput {
  partition?: string
  part?: string
  target?: string
  change?: string
  rationale?: string
  opId?: string
}

/** stances 查询入参：kind 默认只看 stance，state 默认含 challenged（见方法内注释）。 */
export interface StancesQuery {
  kind?: string
  subject?: string
  state?: string | string[]
  limit?: number
}

/**
 * recall 查询入参：R3 起与自动注入共用 `searchFts`（FTS5 + BM25）。
 * 有 text 走文本匹配；没有 text 时按 kind/subject 做结构化整理（不是子串兜底）。
 * `eventLimit` / `includeEvents` 仅为兼容旧调用方保留，R3 起不再产生事件栏。
 */
export interface RecallQuery {
  text?: string
  query?: string
  kind?: string
  subject?: string
  limit?: number
  /** @deprecated R3 起事件收窄为 relatedEvents 摘要，不再单独返回事件栏。 */
  eventLimit?: number
  /** @deprecated R3 起事件收窄为 relatedEvents 摘要，不再单独返回事件栏。 */
  includeEvents?: boolean
}

/** Core 的构造配置：只调活动窗口长度和中性好感基准，其余走默认值。 */
export interface CoreConfig {
  /** 独立证据窗口：同一会话内间隔不超过这么多分钟，算同一次活动（同一份证据）。 */
  independence?: { activityWindowMinutes?: number }
  /** 没有好感投影时的中性基准分，bandFor 再把它映射成档位。 */
  affinity?: { neutral?: number }
}

// 行形状：只列本文件读的列，其余列由 Row 索引签名兜住。
/**
 * sources 表一行的投影（原始素材）。
 * 关键列是 activity_window_key：证据独立性判的是「这是哪一次活动」，不是「这是哪个来源 id」，
 * 所以同一次活动里落的多条来源共用同一个 key（见 #evidenceFromSources）。
 */
export interface SourceRow extends Row {
  source_id: string
  session_ref: string | null
  origin: Origin
  kind: SourceKind
  activity_window_key: string | null
  text: string | null
  captured_at: string
  platform: string
  room_id: string | null
  sender_contact_id: string | null
  capture_key: string | null
}

/**
 * 结论某个 revision 的 head 行（#head 的返回）。
 * revision 是当前最大版本号，state 是「那个版本」的状态快照；
 * head 查询刻意不按 state 过滤，否则 challenged 的结论会在列表里凭空消失。
 */
/**
 * 披露等级：记忆本身的敏感度，不是「谁能看」。
 *
 * - `public`：允许进入普通检索候选（仍不等于允许公开到任意渠道，受众权限另行判断）；
 * - `restricted`：普通检索不返回，留给未来显式授权的场景；
 * - `secret`：普通检索与注入都不允许。
 *
 * 默认值刻意是 `restricted`：没有标记 ≠ 已确认可披露（E3 用户拍板）。
 */
export type Disclosure = 'public' | 'restricted' | 'secret'

/**
 * 一条 Revision 的 public 是「怎么来的」：
 * - `default`：普通非敏感记忆的默认策略（可被后续修订继续继承）；
 * - `grant`：用户通过宿主一次性凭据明确提升（**不在后续修订里静默继承**）；
 * - `explicit`：写入时显式指定（同样不承诺继承给未来内容）。
 *
 * 区分它的目的只有一个：一次性授权不能因为「head 现在是 public」就蔓延到以后每一版。
 */
export type DisclosureSource = 'default' | 'grant' | 'explicit'

const DISCLOSURE_SOURCE_VALUES: readonly DisclosureSource[] = ['default', 'grant', 'explicit']

function normaliseDisclosureSource(value: unknown, fallback: DisclosureSource = 'default'): DisclosureSource {
  const text = String(value ?? '').trim()
  return (DISCLOSURE_SOURCE_VALUES as readonly string[]).includes(text)
    ? (text as DisclosureSource)
    : fallback
}

const DISCLOSURE_VALUES: readonly Disclosure[] = ['public', 'restricted', 'secret']

/** 把入参归一成合法披露值；缺省/非法值一律落到 `restricted`，绝不默认放行。 */
function normaliseDisclosure(value: unknown, fallback: Disclosure = 'restricted'): Disclosure {
  const text = String(value ?? '').trim()
  return (DISCLOSURE_VALUES as readonly string[]).includes(text) ? (text as Disclosure) : fallback
}

/**
 * 关系信号证据列表：去空、去重、单条 ≤200、最多 32 条。
 * 空列表交给调用方判断（B-1 要求至少一条），这里只做形状与上限校验。
 */
function normaliseRelationshipEvidence(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalid('evidenceRefs 必须是字符串数组')
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw invalid('evidenceRefs 只能包含字符串')
    const ref = item.trim()
    if (!ref) throw invalid('evidenceRefs 不能含空字符串')
    if (ref.length > 200) throw invalid('evidenceRefs 单条不能超过 200 字符', { ref })
    if (!out.includes(ref)) out.push(ref)
    if (out.length > 32) throw invalid('evidenceRefs 最多 32 条')
  }
  return out
}

export interface ArtifactHeadRow extends Row {
  artifact_id: string
  kind: ArtifactKind
  revision: number
  state: ArtifactState
  statement: string
  subject_refs: string | null
  payload: string
  confidence: Confidence
  basis_count: number
  independent_evidence_count: number
  salience: number
  temporal: string
  direct_extraction: number
  disclosure: Disclosure
  disclosure_source: DisclosureSource
  updated_at: string
  schema_version: string
}

/** 待插入的一条证据草稿；independenceKey 决定「独立性计数」时它算几份。 */
export interface EvidenceDraft {
  sourceId: string
  relation: EvidenceRelation
  quote: string | null
  confidence: Confidence
  /** 独立渠道标识（活动窗口 key 或 source:id）；去重时按它算，不按 sourceId。 */
  independenceKey: string
  sessionRef?: string
}

/** 待插入的一条血统边：这条结论从哪条（哪个 revision）派生。 */
export interface LineageDraft {
  fromArtifactId: string
  fromRevision?: number | null
  relation?: LineageRelation
}

/** 待插入的一条结论间关系；targetRevision 为空表示指向对方的 head。 */
export interface RelationDraft {
  targetArtifactId: string
  targetRevision?: number | null
  relation: ArtifactRelation
}

/** #insertRevision 的返回：新版本号 + 状态 + 新旧证据数量。 */
export interface RevisionResult {
  artifactId: string
  revision: number
  state: ArtifactState
  basisCount: number
  independentEvidenceCount: number
}

/** checkPromotion 的结论：够不够晋升；need 是门槛的人话描述，have 是当时实测值。 */
export interface PromotionResult {
  ok: boolean
  kind?: ArtifactKind
  need: string
  have: { evidence: number; independent: number; sessions: number; confidence: string }
}

/** 事务上下文：#write 传给内部 work() 的三个值，用于落 operations 表。 */
export interface WriteMeta {
  opId: string
  argsHash: string
  tool: string
}

/** 写结果：ok/opId/replayed + 业务载荷（按载荷类型分配，union 也能正确窄化）。 */
export type WriteResult<T> = T extends unknown ? { ok: true; opId: string; replayed: boolean } & T : never

/**
 * 私聊采集输入（replySchedules 第二批）。
 *
 * 只用于「目标不在允许回复时段，但原本允许采集」的场景：写 Source + 一条 Event，
 * **不建回复轮、不排队、不发送**。幂等键 = platform + sessionRef + captureKey。
 */
export interface PrivateMessageInput {
  /** 稳定 QQ 号（不是昵称）。 */
  stableUserId: string
  /** OneBot 消息 id；`captureKey` 由它构造，重复消息据此幂等。 */
  messageId: string
  /** 消息正文；与既有 capture_key 不一致时拒写（E_CAPTURE_CONFLICT）。 */
  text: string
  /** 采集时间，缺省当前时间。 */
  at?: string
  /** 会话引用，缺省 `qq-private-<stableUserId>`。 */
  sessionRef?: string
  /** 发送者展示名，可选，仅用于建档时补名字。 */
  displayName?: string
}

/** 私聊采集结果：identity 落在哪条会话、命中了哪条 Source/Event、是否重放。 */
export interface PrivateMessageResult {
  sessionRef: string
  sourceId: string
  eventId: string | null
  replayed: boolean
}
/** 只读结果：只有 ok/opId + 载荷；opId 为审计用，读路径不要求调用方传。 */
export type ReadResult<T> = T extends unknown ? { ok: true; opId: string } & T : never

/** #insertSource 的返回：来源 id（新落或重放的原 id）+ 活动窗口 + 是否命中幂等。 */
export interface CaptureResult {
  sourceId: string
  windowKey: string
  roomId: string | null
  contactId: string | null
  at: string
  sessionRef: string
  /** true = 这条外部身份之前已经落过，本次没有新写（replayed 时 sourceId 是原行 id）。 */
  replayed: boolean
}

/** remember 的载荷：没晋升时 promotion.ok 为 false 并说明缺什么，调用方不用自己算门槛。 */
export interface RememberPayload {
  eventId: string
  eventType: InteractionType
  sourceIds: string[]
  artifactId: string | null
  revision: number | null
  state: ArtifactState | null
  artifactKind: ArtifactKind | null
  independentEvidenceCount: number | null
  promotion: PromotionResult | null
  /** 最终落库的披露等级（授权不足时被强制降回 restricted）。 */
  disclosure: Disclosure
  /** 本次内容敏感、显式要求 public 但缺少可信授权。 */
  grantRequired: boolean
}

/** 「记住这条」：给当前 head 追加证据（不改结论内容/披露/主体）。 */
export interface AppendEvidenceInput {
  sourceIds?: string | string[]
  source_ids?: string | string[]
  relation?: EvidenceRelation
  confidence?: Confidence
  opId?: string
}

export interface AppendEvidencePayload {
  artifactId: string
  revision: number
  /** 本次实际新增的证据行数（重复关系被 OR IGNORE 跳过时可能是 0）。 */
  added: number
  basisCount: number
  independentEvidenceCount: number
}

/** clash 的载荷：kind/type 反映这条事件记成了「认知矛盾」还是普通「冲突」。 */
export interface ClashPayload {
  eventId: string
  kind: EventKind
  type: EventType
  targetArtifactId: string | null
  targetRevision: number | null
  sourceIds: string[]
  /** 非 self 来源数；认知事件要求 ≥1，否则以 E_SELF_PROOF 拒绝。 */
  nonSelfSourceCount: number
  causedBy: string | null
}

/** revise 同 id 模式：artifactId 不变，只把 revision 加一（旧版本仍留在库里）。 */
export interface ReviseSameId {
  mode: 'same-id'
  artifactId: string
  revision: number
  previousRevision: number
  previousState: ArtifactState
  state: ArtifactState
  basisCount: number
  independentEvidenceCount: number
  refs: string[]
  /** 最终落库的披露等级（授权不足时被强制降回 restricted）。 */
  disclosure: Disclosure
  grantRequired: boolean
}

/** revise 新 id 模式：开一条新结论，用 supersedes 指回被取代的结论或事件。 */
export interface ReviseNewId {
  mode: 'new-id'
  artifactId: string
  revision: number
  kind: ArtifactKind
  state: ArtifactState
  supersedes: string | null
  supersedesEvent: string | null
  basisCount: number
  independentEvidenceCount: number
  refs: string[]
  /** 旧对象被置 superseded 的那条 revision（旧对象本就失效时为 null）。 */
  supersededRevision: number | null
  /** 最终落库的披露等级（授权不足时被强制降回 restricted）。 */
  disclosure: Disclosure
  grantRequired: boolean
}

/** 两种修订模式的联合；调用方按 mode 窄化。 */
export type RevisePayload = ReviseSameId | ReviseNewId

/**
 * 签发披露授权的入参：要么指向一条已有结论的当前 head，要么给一段准备新建的内容。
 * `grantedBy` 是人类可读的授权人标识（由宿主保证可信，不在这里校验真伪）。
 */
export interface GrantDisclosureInput {
  artifactId?: string
  artifact_id?: string
  /** 可选：要求被授权对象正好是第几版；与当前 head 不符抛 E_VALIDATION。 */
  revision?: number
  /** 新建内容时使用；与 artifactId 二选一。 */
  statement?: string
  grantedBy?: string
  granted_by?: string
  reason?: string
  /** 可选有效期（毫秒）；不传则不过期，但仍是一次性。 */
  ttlMs?: number
  opId?: string
}

/** 签发结果：把 grantId 传给 remember/revise 的 disclosureGrant 即可消费这一次授权。 */
export interface GrantDisclosurePayload {
  grantId: string
  contentHash: string
  artifactId: string | null
  revision: number | null
  beforeDisclosure: Disclosure
  afterDisclosure: Disclosure
  expiresAt: string | null
  /** 同 opId 重放时为 true：返回的是上次签发的那张 grant，没有新签一张。 */
  replayed?: boolean
}

/** 撤销授权入参：只撤销「已签发、未消费」的 grant。 */
export interface RevokeDisclosureGrantInput {
  grantId?: string
  grant_id?: string
  revokedBy?: string
  revoked_by?: string
}

export interface RevokeDisclosureGrantPayload {
  grantId: string
  revokedAt: string
  alreadyRevoked: boolean
}

/** 授权列表入参：可按 artifactId 过滤；只读审计，不含正文。 */
export interface ListDisclosureGrantsInput {
  artifactId?: string
  artifact_id?: string
  limit?: number
}

export interface DisclosureGrantRow {
  grantId: string
  artifactId: string | null
  revision: number | null
  contentHash: string
  grantedBy: string
  beforeDisclosure: Disclosure
  afterDisclosure: Disclosure
  createdAt: string
  expiresAt: string | null
  usedAt: string | null
  revokedAt: string | null
}

export interface ListDisclosureGrantsPayload {
  rows: DisclosureGrantRow[]
}

/** review 载荷：previous* 是复核前的快照，state 是复核后新版本的状态。 */
export interface ReviewPayload {
  artifactId: string
  revision: number
  previousRevision: number
  previousState: ArtifactState
  state: ArtifactState
  verdict: Verdict
  eventId: string
  note: string
}

/** propose 载荷：新提案永远是 pending（等人工批准），pendingProposals 是当前积压数。 */
export interface ProposePayload {
  proposalId: string
  partition: Partition
  target: string
  change: string
  rationale: string | null
  status: 'pending'
  pendingProposals: number
}

/** stances 列表中的一项：只给一句话 + 计数，细节要再用 fetch / recall 取。 */
export interface StanceItem {
  artifactId: string
  kind: ArtifactKind
  revision: number
  state: ArtifactState
  statement: string
  subjectRefs: string[]
  confidence: Confidence
  basisCount: number
  independentEvidenceCount: number
  updatedAt: string
}

/** stances 的返回：scope 是实际查询的 kind 集合，total 是**本次返回**条数（已受 limit 截断）。 */
export interface StancesPayload {
  scope: ArtifactKind[]
  subject: string | null
  total: number
  items: StanceItem[]
}

/** getState 的返回：人格 / 自我 / 阶段 + 各表行数 + 存储健康 + 数据目录。 */
export interface StatePayload {
  persona: { id: string; type: string; identityPath: string | null; personaJson: unknown }
  self: { view: string; revision: number; updatedAt: string | null }
  phase: { phase: string; since: string | null; stalledAt: string | null }
  counts: {
    sources: number
    events: number
    artifacts: number
    revisions: number
    operations: number
    proposals: number
    pendingWrites: number
    activityWindows: number
  }
  storage: import('./adapter.js').DbHealth
  dataDir: string
}

/** 成长状态快照：阶段 + 各闸门实测/门槛 + 瓶颈说明 + 若干计数。 */
export interface GrowthPayload {
  stage: Gate
  stageLabel: string
  since: string | null
  elapsedDays: number
  algorithmVersion: string
  gates: {
    gate: Gate
    label: string
    passed: boolean
    have: number
    need: number
    shortfall: string
  }[]
  bottleneck: Gate | null
  bottleneckReason: string
  counts: { beliefs: number; matureBeliefs: number; refusals: number; corrections: number; independentKeys: number }
  /**
   * 只读接口永远是空的：阶段推进只发生在写入之后（`syncGrowth()`）或人确认整合时。
   * 面板刷新多少次都不会改变成长历史。
   */
  advanced: { gate: Gate; fromPhase: Gate; fromPhaseLabel: string; toPhase: Gate; milestoneId: string }[]
}

/** context 的返回：喂给模型的最小上下文——人格/阶段、自我认识、几条已立住的判断、最近认知变化。 */
export interface ContextPayload {
  persona: { id: string; stage: string; stageLabel: string }
  self: string
  /** 已成立的结论（只给 id + 一句话，细节用 psyche_fetch / psyche_recall）。 */
  beliefs: { artifactId: string; kind: ArtifactKind; statement: string }[]
  /** 最近的几次认知变化（修订/复核/发现矛盾），只说发生了什么，不给计数和阈值。 */
  recentCognitiveChanges: { type: string; statement: string; at: string }[]
  /**
   * 最近被批准的自我调整（life 分区）。批准不改配置，靠这段重新回到她读到的上下文里，
   * 所以这里是 approval → 行为 的唯一通路；顺序是新→旧，最多 3 条。
   */
  recentApprovals: { target: string; change: string; at: string }[]
  note: string
}

/** getRelationship 的返回：联系人档案 + 好感档位 + 信任结论 + 最近信号 + 情绪维度。 */
export interface RelationshipPayload {
  contact: {
    contactId: string
    platform: string
    stableUserId: string
    displayName: string | null
    relationLabel: string | null
  }
  affinity: {
    /** 对外表达只用品档；bandLabel 是给人看的措辞。 */
    band: AffinityBand
    bandLabel: string
    /** 是否有人工覆盖（覆盖后投影值不再自动改档）。 */
    manualOverride: boolean
    updatedAt: string | null
    /** 分数值：只作为内部载荷参与计算，不作为对外话术报告。 */
    internalValue: number
  }
  trust: {
    artifactId: string
    revision: number
    state: ArtifactState
    statement: string
    value: number
    band: 'low' | 'medium' | 'high'
    updatedAt: string
  } | null
  signals: {
    total: number
    recent: {
      signalId: string
      signalType: string
      polarity: string
      appliedDelta: number
      confidence: string
      createdAt: string
    }[]
  }
  affect: { dimension: string; value: number; updatedAt: string }[]
  ledgerComplete: boolean
}

/** recall 命中一条结论：与自动注入同构（字段见 `recall.ts` 的 RecallItem）。 */
export type RecallArtifact = RecallItem

/**
 * recall 的返回（R4-A）：只给 results / abstained / abstainReason / guidance / runId。
 * rejected/searched 属内部诊断，不再对调用方暴露（R4-B 的 Receipt 会按同一来源记录）。
 * runId 当前不生成——留到 Recall Run 落地后再由真实 Run 填，避免出现两套 ID。
 */
export type RecallPayload = RecallResult<RecallItem>

/**
 * fetch 的一项：source / event / artifact 各一种形状，找不到的 id 落成 missing。
 * missing 不抛错——批量取时部分缺失不该让整批失败，缺哪些由调用方按 type 判断。
 */
export type FetchItem =
  | { id: string; type: 'source'; origin: Origin; kind: SourceKind; at: string; text: string; platform: string }
  | { id: string; type: 'event'; kind: EventKind; eventType: EventType; at: string; text: string }
  | {
      id: string
      type: 'artifact'
      kind: ArtifactKind
      revision: number
      state: ArtifactState
      at: string
      text: string
    }
  | { id: string; type: 'missing'; error: string }

/** fetch 的返回：按顺序取的条目 + 预算/用量 + 是否被预算截断过。 */
export interface FetchPayload {
  items: FetchItem[]
  budget: number
  used: number
  truncated: boolean
}

/**
 * 心灵的存储核心：所有落库/查询都从这里走，工具层只调这些 public 方法，不直接碰 db。
 * 约定：public 写方法一律经 #write（事务 + opId 幂等 + 失败记账）；读方法经 #read 或 #rows/#row；
 * 带 # 的私有方法都假定调用方已在事务里，自己不开事务（除了 #write 专门另开一笔记失败）。
 */
/** R4-B：把可信 Scope 归成回执里的「允许域」类型；没有身份就是全局。 */
function recallScopeTypeOf(scope: RecallScope): RecallScopeType {
  if (scope.surface === 'personal' || scope.surface === 'private' || scope.surface === 'group') {
    return scope.surface
  }
  if (scope.roomId || scope.groupId) return 'group'
  if (scope.contactId) return 'private'
  return 'global'
}

export class Core {
  /** 已打开的库句柄；open/close 由 adapter 负责，Core 只借来用。 */
  readonly db: Db
  readonly config: CoreConfig
  readonly logger?: DbLogger
  /** 数据目录（getState 里回显，便于排查「库到底在哪」）。 */
  readonly dataDir: string
  /** 活动窗口长度（分钟）：同一会话内来源间隔不超过它，就并进同一份「独立证据」。 */
  readonly activityWindowMinutes: number
  /** 中性好感基准分；新建联系人时投影初值取它，bandFor 再映射成档位。 */
  readonly defaultAffinity: number
  /** 底层驱动名（sqlite 等），只用于展示和诊断。 */
  readonly driver: string

  /**
   * 写入冻结位（§34.14 提交前冻结）。
   *
   * 为什么存在：确认覆盖导入后，要先导出一份「替换前最后状态」的预恢复包，
   * 再等下次启动换目录。这中间如果还有新记忆写进来，预恢复包与 `.old-*`
   * 就指向两个不同时刻，两道回退不再是同一个点——所以那一刻之后必须拒写。
   *
   * 只冻结**写**：读接口（recall / context / state）照常，否则面板会瞎。
   */
  #writesFrozen = false
  /** 冻结原因（回执里原样告诉模型，为什么这次写不进去）。 */
  #freezeReason = ''
  /** R4-B 回执密钥缓存：首次写回执时读盘，之后复用；进程内不重复读。 */
  #recallKey: RecallKey | null = null

  /** 绑定依赖，不碰库：不在构造函数里建表/写库，方便单测注入内存库。 */
  constructor({ db, config = {}, logger, dataDir = '' }: {
    db: Db
    config?: CoreConfig
    logger?: DbLogger
    dataDir?: string
  }) {
    this.db = db
    this.config = config
    this.logger = logger
    this.dataDir = dataDir
    // `Number(...) || 默认`：0 和 NaN 都回落默认，避免配成 0 分钟让每条来源都算独立证据
    this.activityWindowMinutes =
      Number(config?.independence?.activityWindowMinutes) || DEFAULT_ACTIVITY_WINDOW_MINUTES
    // 用 ?? 而不是 ||：显式配 0 分是合法值（好感下限），不能被当成「没配」
    this.defaultAffinity = Number(config?.affinity?.neutral ?? 50)
    this.driver = db.driver
  }

  /** 当前是否处于「等重启应用恢复」的冻结期。 */
  get writesFrozen(): boolean {
    return this.#writesFrozen
  }

  /** 进入冻结：之后所有写工具抛 {@link CODE.restorePending}，直到 {@link unfreezeWrites}。 */
  freezeWrites(reason: string): void {
    this.#writesFrozen = true
    this.#freezeReason = reason
  }

  /** 解除冻结（预恢复包失败、或恢复被取消时调用）。 */
  unfreezeWrites(): void {
    this.#writesFrozen = false
    this.#freezeReason = ''
  }

  // ── 内部小工具 ──────────────────────────────────────────────

  /** 查多行：部分驱动的 all() 可能返回 undefined，这里统一成 []，调用方不必再判空。 */
  #rows<T = Row>(sql: string, params?: SqlParams): T[] {
    return this.db.all<T>(sql, params) ?? []
  }

  /** 查单行：查不到返回 undefined（不抛错，是否算错误由调用方决定）。 */
  #row<T = Row>(sql: string, params?: SqlParams): T | undefined {
    return this.db.get<T>(sql, params)
  }

  /**
   * 取/建当前活动窗口的 key。**写库**（UPDATE 或 INSERT），且只在 #insertSource 的事务里调用。
   * 判定规则：读同会话最近一个窗口，若本次 at 与 ended_at 的距离在 idleMs 内就复用它并推进 ended_at，
   * 否则新开一个窗口。两侧都留容差，是为了容忍调用方传进来的时间戳轻微乱序。
   * @param sessionRef 会话标识；空值兜底 psyche:default，长度截到 200。
   * @param atIso 本次来源时间（ISO）；解析失败的 Date.parse 结果会被 isFinite 挡掉，直接新开窗口。
   * @returns session_activity_windows.window_key（证据独立性用的就是它）。
   */
  #windowFor(sessionRef: string, atIso: string): string {
    const session = String(sessionRef || 'psyche:default').slice(0, 200)
    const at = Date.parse(atIso)
    const idleMs = this.activityWindowMinutes * 60_000
    // 只看「同会话最近一次活动」：更早的窗口不参与比较，避免久远窗口被错误续上
    const open = this.#row<{ window_key: string; ended_at: string }>(
      `SELECT window_key, ended_at FROM session_activity_windows
        WHERE session_id = ? ORDER BY ended_at DESC LIMIT 1`,
      [session],
    )
    if (open) {
      const ended = Date.parse(open.ended_at)
      // 双向容差：at 在 [ended-idle, ended+idle] 内都算同一次活动（时间戳可能倒挂）
      if (Number.isFinite(at) && Number.isFinite(ended) && at - ended <= idleMs && at >= ended - idleMs) {
        this.db.run(
          `UPDATE session_activity_windows SET ended_at = ?, source_count = source_count + 1 WHERE window_key = ?`,
          [atIso, open.window_key],
        )
        return open.window_key
      }
    }
    // 开新窗口：key 由 newWindowKey 生成（含会话+时间，保证可读且不撞）
    const key = newWindowKey(session, atIso)
    this.db.run(
      `INSERT INTO session_activity_windows (window_key, persona_id, session_id, started_at, ended_at, source_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [key, PERSONA_ID, session, atIso, atIso, 1],
    )
    return key
  }

  /**
   * 取/建外部房间。写库、不开事务（挂在调用方事务里）。
   * 没有 externalRoomId 就直接返 null —— 本地会话不该凭空造 room。
   * @returns rooms.room_id 或 null。
   */
  #ensureRoom({ platform, channel, externalRoomId, title }: {
    platform: string
    channel: string
    externalRoomId?: string | null
    title?: string | null
  }): string | null {
    if (!externalRoomId) return null
    // 复用键是 (platform, channel, external_room_id)：同名群在不同平台是不同房间
    const existing = this.#row<{ room_id: string }>(
      `SELECT room_id FROM rooms WHERE platform = ? AND channel = ? AND external_room_id = ?`,
      [platform, channel, externalRoomId],
    )
    if (existing) return existing.room_id
    const roomId = newId(PREFIX.room)
    const now = nowIso()
    this.db.run(
      `INSERT INTO rooms (room_id, persona_id, platform, channel, external_room_id, title, capture_mode, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [roomId, PERSONA_ID, platform, channel, externalRoomId, title ?? null, 'replied_or_mentioned', now, now],
    )
    return roomId
  }

  /**
   * 按 (platform, stableUserId) 解析联系人：有就返回其 id（顺手补显示名、刷新成员 seen 时间），
   * 没有就建档（contact + identifiers + 好感初值）。写库、不开事务，调用方必须已在事务里。
   * @returns contacts.contact_id。
   * @throws 理论上不抛 E_*；唯一性冲突会冒泡成驱动错误（由 #write 兜底记失败）。
   */
  #resolveContactSync({ platform, stableUserId, displayName, roomId }: {
    platform: string
    stableUserId: string
    displayName?: string | null
    roomId?: string | null
  }): string {
    const found = this.#row<{ contact_id: string; display_name: string | null }>(
      `SELECT contact_id, display_name FROM contacts WHERE platform = ? AND stable_user_id = ?`,
      [platform, stableUserId],
    )
    const now = nowIso()
    if (found) {
      // 显示名变了才写库：避免每次采集都产生一次无意义的 UPDATE
      if (displayName && displayName !== found.display_name) {
        this.db.run(`UPDATE contacts SET display_name = ?, updated_at = ? WHERE contact_id = ?`, [
          displayName,
          now,
          found.contact_id,
        ])
      }
      this.#touchRoomMember(roomId, found.contact_id, now)
      return found.contact_id
    }
    const contactId = newId(PREFIX.contact)
    this.db.run(
      `INSERT INTO contacts (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      [contactId, PERSONA_ID, platform, stableUserId, displayName ?? null, now, now],
    )
    // OR IGNORE：identifiers 有唯一约束，并发/重复解析时不该让整笔写失败
    this.db.run(
      `INSERT OR IGNORE INTO contact_identifiers (contact_id, platform, stable_user_id, handle, merged_by_user, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
      [contactId, platform, stableUserId, displayName ?? null, now, now],
    )
    // 好感档位在建档时就落初值（manual_override=0 表示还没被人工改过）
    this.db.run(
      `INSERT OR IGNORE INTO relationship_affinity_state (persona_id, contact_id, affinity, band, manual_override, updated_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [PERSONA_ID, contactId, this.defaultAffinity, bandFor(this.defaultAffinity).band, now],
    )
    this.#touchRoomMember(roomId, contactId, now)
    return contactId
  }

  /** 维护 room_members 的 last_seen_at：有就更新，没有就插；roomId/contactId 任一为空直接跳过。 */
  #touchRoomMember(roomId: string | null | undefined, contactId: string | null | undefined, now: string): void {
    if (!roomId || !contactId) return
    const existing = this.#row(`SELECT 1 AS hit FROM room_members WHERE room_id = ? AND contact_id = ?`, [
      roomId,
      contactId,
    ])
    if (existing) {
      this.db.run(`UPDATE room_members SET last_seen_at = ? WHERE room_id = ? AND contact_id = ?`, [
        now,
        roomId,
        contactId,
      ])
      return
    }
    this.db.run(
      `INSERT INTO room_members (room_id, contact_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)`,
      [roomId, contactId, now, now],
    )
  }

  /**
   * 落一条 Source（原始素材），顺带把活动窗口、房间、联系人解析出来。**写库、不开事务**。
   * 它内部会调 #windowFor / #ensureRoom / #resolveContactSync，所以必须在事务里被调用
   * （capture / perceive / #sourcesForWrite 都在 #write 或显式事务里调它）。
   * 缺省全兜底：platform=dsh、channel=desktop、sessionRef=psyche:default、origin=external、kind=message。
   * @returns CaptureResult：新 sourceId + 它所属 windowKey + roomId/contactId/at/sessionRef。
   * @throws E_VALIDATION（origin / kind 不在枚举内）。
   */
  #insertSource(input: CaptureInput): CaptureResult {
    const at = input.at ?? nowIso()
    const platform = input.platform ?? 'dsh'
    const channel = input.channel ?? 'desktop'
    const sessionRef = input.sessionRef ?? input.session_ref ?? 'psyche:default'
    const captureKey = cleanText(input.captureKey, 200) || null
    // 第 45 轮外部评审 Q1：轮次身份由调用方给（DSH 侧就是 payload.turn）。
    // 拿不到就存 NULL —— 摘要侧按「没有轮次身份的历史行」处理，不拿别的字段猜。
    const turnId = cleanText((input as { turnId?: unknown }).turnId, 120) || null
    // 幂等第一道：写窗口/房间之前就返回，避免重复投递污染活动窗口计数
    if (captureKey) {
      const prior = this.#row<SourceRow>(
        `SELECT * FROM sources WHERE platform = ? AND session_ref = ? AND capture_key = ? LIMIT 1`,
        [platform, sessionRef, captureKey],
      )
      if (prior) return this.#replaySource(prior, input)
    }
    // 幂等第二道（第二批跨路径反向：独立私聊采集 → Host capture）：
    // 同一会话里 message_id 就是平台侧的消息身份，captureKey 不同也不该写第二份。
    // 只对 QQ 生效：别的平台的 messageId 未必是稳定身份（测试夹具里也可能复用），
    // 扩大范围会把「同 key 不同文本要冲突」这类既有语义冲掉。
    const messageId = platform === 'qq' ? cleanText(input.messageId, 200) || null : null
    if (messageId) {
      const prior = this.#row<SourceRow>(
        `SELECT * FROM sources WHERE platform = ? AND session_ref = ? AND message_id = ? LIMIT 1`,
        [platform, sessionRef, messageId],
      )
      if (prior) {
        // 两条路径都各自声明了 captureKey 时，captureKey 才是权威身份：
        // 这里退回严格重放（正文不一致就按冲突拒绝），否则并发冲突测试会变成「两次都成功」。
        // 只有「调用方没给 captureKey」时才按 message_id 宽松重放（Host 后写、正文编排不同）。
        if (captureKey !== null) return this.#replaySource(prior, input)
        return {
          sourceId: prior.source_id,
          windowKey: prior.activity_window_key ?? '',
          roomId: prior.room_id ?? null,
          contactId: prior.sender_contact_id ?? null,
          at: prior.captured_at,
          sessionRef: prior.session_ref ?? 'psyche:default',
          replayed: true,
        }
      }
    }
    // 先算窗口 key：后面 sources.activity_window_key 直接用它，证据独立性就锚在这里
    const windowKey = this.#windowFor(sessionRef, at)
    const roomId =
      input.roomId ??
      input.room_id ??
      this.#ensureRoom({
        platform,
        channel,
        externalRoomId: input.externalRoomId ?? null,
        title: input.roomTitle ?? null,
      })
    let contactId = input.senderContactId ?? input.sender_contact_id ?? null
    // 没给 contact 但有稳定用户 id 时现场解析/建档：采集路径要能自愈，不要求调用方先 resolve
    if (!contactId && input.stableUserId) {
      contactId = this.#resolveContactSync({
        platform,
        stableUserId: String(input.stableUserId),
        displayName: input.displayName ?? null,
        roomId,
      })
    }
    const sourceId = newId(PREFIX.source)
    try {
      this.db.run(
        `INSERT INTO sources (
           source_id, persona_id, platform, channel, room_id, session_ref, sender_contact_id,
           message_id, reply_to_message_id, mentions, quoted_source_refs, origin, kind, text,
           asset_sha256, activity_window_key, metadata, captured_at, created_at, capture_key, turn_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sourceId,
          PERSONA_ID,
          platform,
          channel,
          roomId,
          sessionRef,
          contactId,
          input.messageId ?? null,
          input.replyToMessageId ?? null,
          JSON.stringify(parseList(input.mentions)),
          JSON.stringify(parseList(input.quotedSourceRefs ?? input.quoted_source_refs)),
          normaliseEnum(input.origin, ['user', 'external', 'self'] as const, 'origin', 'external'),
          normaliseEnum(
            input.kind,
            ['message', 'image', 'voice', 'video', 'web', 'action', 'model'] as const,
            'kind',
            'message',
          ),
          // `|| null`：空正文存 NULL 而不是空串，读侧只用判空一种写法
          cleanText(input.text, 20_000) || null,
          input.assetSha256 ?? null,
          windowKey,
          JSON.stringify(input.metadata ?? {}),
          at,
          nowIso(),
          captureKey,
          turnId,
        ],
      )
    } catch (err) {
      // 幂等第二道：并发写入者刚插了同身份行，唯一索引把这次 INSERT 拦下；
      // 重查命中就按重放返回，否则原样抛（不能把真错误吞成「已重放」）。
      if (captureKey) {
        const raced = this.#row<SourceRow>(
          `SELECT * FROM sources WHERE platform = ? AND session_ref = ? AND capture_key = ? LIMIT 1`,
          [platform, sessionRef, captureKey],
        )
        if (raced) return this.#replaySource(raced, input)
      }
      throw err
    }
    return { sourceId, windowKey, roomId, contactId, at, sessionRef, replayed: false }
  }

  /**
   * 幂等命中：内容一致就重放原行，不一致抛 E_CAPTURE_CONFLICT（原 Source 一行不动）。
   * 只比 text / origin / kind 三项：它们是外部身份之外真正决定「这条来源是什么」的字段；
   * messageId 属于平台元数据，重放时缺失或格式不同不应被判成内容冲突。
   */
  #replaySource(prior: SourceRow, input: CaptureInput): CaptureResult {
    const nextText = cleanText(input.text, 20_000) || ''
    const nextOrigin = normaliseEnum(input.origin, ['user', 'external', 'self'] as const, 'origin', 'external')
    const nextKind = normaliseEnum(
      input.kind,
      ['message', 'image', 'voice', 'video', 'web', 'action', 'model'] as const,
      'kind',
      'message',
    )
    const same = (prior.text ?? '') === nextText && prior.origin === nextOrigin && prior.kind === nextKind
    if (!same) {
      throw new PsycheError(
        CODE.captureConflict,
        `同一 capture_key 的内容与原来源不一致：${prior.source_id}`,
        { sourceId: prior.source_id, captureKey: prior.capture_key ?? null },
      )
    }
    return {
      sourceId: prior.source_id,
      windowKey: prior.activity_window_key ?? '',
      roomId: prior.room_id ?? null,
      contactId: prior.sender_contact_id ?? null,
      at: prior.captured_at,
      sessionRef: prior.session_ref ?? 'psyche:default',
      replayed: true,
    }
  }

  /**
   * 按 id 批量取 Source，并按**入参顺序**重排（SQL IN 不保证顺序，而证据顺序影响可读性）。
   * 只读、不开事务。缺任一 id 抛 E_NOT_FOUND —— 写路径上「来源不存在」是硬错误，
   * 静默丢掉会让证据链悄悄变短。
   * @returns SourceRow[]，元素与 ids 一一对应。
   */
  #loadSources(sourceIds: string | string[] | undefined): SourceRow[] {
    const ids = parseList(sourceIds)
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.#rows<SourceRow>(`SELECT * FROM sources WHERE source_id IN (${placeholders})`, ids)
    const missing = ids.filter((id) => !rows.some((row) => row.source_id === id))
    if (missing.length > 0) {
      throw new PsycheError(CODE.notFound, `找不到这些 Source：${missing.join(', ')}`)
    }
    // R6-CAP-2：被隔离的 Source 不能再当证据。原始记录保留（审计与追溯），
    // 但任何「用它支撑一条结论」的写入都必须在入口被挡下，否则隔离只是摆设。
    const quarantined = quarantinedIds(this.db, ids)
    if (quarantined.length > 0) {
      throw invalid(
        `这些来源已被隔离，不能作为证据：${quarantined.join(', ')}（R6-CAP-2 Runtime Injection Exclusion）`,
      )
    }
    return ids.map((id) => rows.find((row) => row.source_id === id) as SourceRow)
  }

  // 写工具没给 sourceIds 时，只能落一条 self 来源（模型自己的话，不能拿来证明自己）
  /**
   * 为写操作准备证据来源：给了 sourceIds 就照单取（缺 id 抛 E_NOT_FOUND）；
   * 没给时落一条 origin=self / kind=model 的「模型自述」来源兜底。
   * 之所以必须兜底：事件不能没有来源（#insertEvent 抛 E_NO_SOURCE），但模型自述来源
   * 在自证校验（review / clash 的 E_SELF_PROOF）里不算独立证据。
   * allowEmpty=true 时允许返回空数组（当前无调用方传 true，属预留开关）。
   * @returns SourceRow[]；写库（可能插一条 source），不开事务。
   */
  #sourcesForWrite(
    input: SourceRefsInput,
    { fallbackText, allowEmpty = false }: { fallbackText?: string; allowEmpty?: boolean } = {},
  ): SourceRow[] {
    const provided = this.#loadSources(input.sourceIds ?? input.source_ids)
    if (provided.length > 0) return provided
    if (allowEmpty) return []
    const created = this.#insertSource({
      platform: input.platform ?? 'dsh',
      channel: input.channel ?? 'desktop',
      sessionRef: input.sessionRef ?? 'psyche:tool',
      origin: 'self',
      kind: 'model',
      text: fallbackText || '（模型自述，无外部来源）',
      stableUserId: input.stableUserId ?? null,
    })
    return this.#loadSources([created.sourceId])
  }

  /** 工具层用 subject、服务层用 subjectRefs，两者都认（§5.3 subjectRefs）。纯函数。 */
  #subjectRefsOf(input: SourceRefsInput): string[] {
    return parseList(input.subjectRefs ?? input.subject)
  }

  /**
   * 写一条事件（events）+ 来源关联（event_sources）+ 可选 respondsTo 关系。写库、不开事务。
   * 无来源抛 E_NO_SOURCE（§5.2 约束 2：事件必须可追溯）；causedBy 指向不存在的事件抛 E_NOT_FOUND；
   * confidence 非法抛 E_VALIDATION；text 只存 500 字符（全文留在 source 上，事件是小记录）。
   * @returns 新 event_id。
   */
  /**
   * 写一条写入准入观测（D1-7）。
   *
   * 只记不改：本行不参与任何业务读取，不阻塞写入，也不产生事件/结论。
   * 为什么是独立表而不是塞进 operations：观测是「每次尝试的判定快照」，
   * 量级远大于 operations，生命周期也不同（允许将来抽样/清理）。
   */
  #insertAdmissionObservation({
    opId,
    sourceId,
    quality,
    admission,
  }: {
    opId: string
    sourceId: string | null
    quality: QualityAssessment
    admission: AdmissionResult
  }): void {
    this.db.run(
      `INSERT INTO admission_observations (
         observation_id, op_id, source_id, contact_id, decision, quality_score,
         quality_level, signals, reason, policy_version, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(PREFIX.observation),
        opId,
        sourceId,
        null,
        admission.decision,
        quality.score,
        quality.level,
        JSON.stringify(quality.signals),
        admission.reason,
        admission.policyVersion,
        nowIso(),
      ],
    )
  }

  #insertEvent({
    kind,
    type,
    text,
    at = nowIso(),
    sessionRef,
    roomId,
    subjectRefs = [],
    sourceRows = [],
    confidence = 'medium',
    causedBy = null,
    relationTo = null,
    opId = null,
  }: {
    kind: EventKind
    type: EventType
    text: string
    at?: string
    sessionRef?: string
    roomId?: string | null
    subjectRefs?: string | string[]
    sourceRows?: SourceRow[]
    confidence?: string
    causedBy?: string | null
    relationTo?: string | null
    opId?: string | null
  }): string {
    // 先把「无来源」挡掉：宁可失败，也不落一条不可追溯的事件
    if (sourceRows.length === 0) {
      throw new PsycheError(CODE.noSource, '事件至少需要一条 Source（§5.2 约束 2）')
    }
    if (causedBy) {
      // 先验存在性：events 是只追加的，悬空引用会污染 respondsTo 图且无法回滚修正
      const exists = this.#row(`SELECT 1 AS hit FROM events WHERE event_id = ?`, [causedBy])
      if (!exists) throw new PsycheError(CODE.notFound, `causedBy 指向的事件不存在：${causedBy}`)
    }
    const eventId = newId(PREFIX.event)
    this.db.run(
      `INSERT INTO events (
         event_id, persona_id, kind, type, at, session_id, room_id, subject_refs, text,
         caused_by, relation_to, confidence, op_id, schema_version, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        PERSONA_ID,
        kind,
        type,
        at,
        sessionRef ?? 'psyche:tool',
        roomId ?? null,
        JSON.stringify(parseList(subjectRefs)),
        cleanText(text, 500),
        causedBy,
        relationTo,
        normaliseEnum(confidence, ['low', 'medium', 'high'] as const, 'confidence', 'medium'),
        opId,
        SCHEMA_VERSION,
        nowIso(),
      ],
    )
    // 来源关联用 OR IGNORE：同一来源重复挂到同一事件上不该报错
    for (const row of sourceRows) {
      this.db.run(`INSERT OR IGNORE INTO event_sources (event_id, source_id) VALUES (?, ?)`, [
        eventId,
        row.source_id,
      ])
    }
    // causedBy 另落一行关系：事件表只存指针，反向「谁由我引发」靠 event_relations 查
    if (causedBy) {
      this.db.run(
        `INSERT OR IGNORE INTO event_relations (event_id, target_event_id, relation, created_at) VALUES (?, ?, ?, ?)`,
        [eventId, causedBy, 'respondsTo', nowIso()],
      )
    }
    return eventId
  }

  /**
   * 把来源行映射成证据草稿。**纯函数，不写库**。
   * 关键在 independenceKey：取 activity_window_key，即「同一次活动里的多条来源只算一份证据」；
   * 没有窗口 key 时才退回 source:<id>。否则同一个群里连说三句话就会被算成三份独立证据。
   */
  #evidenceFromSources(
    sourceRows: SourceRow[],
    relation: EvidenceRelation = 'supports',
    confidence: Confidence = 'medium',
  ): EvidenceDraft[] {
    return sourceRows.map((row) => ({
      sourceId: row.source_id,
      relation,
      quote: null,
      confidence,
      independenceKey: row.activity_window_key || `source:${row.source_id}`,
      sessionRef: row.session_ref || '',
    }))
  }

  /**
   * 写一条 Revision，并一并落证据、触发事件、血统、关系。**写库、不开事务**。
   * 旧 revision 永远不动（§5.3「任何情况不覆盖旧行」）——所谓「更新」只是再插一行更大的 revision。
   * basisCount = 证据条数；independentEvidenceCount = 去重后的 independenceKey 个数：
   * 两者分开存，是因为「被提了几次」和「几个独立来源」在晋升门槛里含义不同。
   * @throws E_STATE（state 不属于该 kind 的状态机）、E_VALIDATION（kind 未知 / confidence 非法）。
   * @returns RevisionResult：新 revision + 状态 + 两个计数。
   */
  #insertRevision({
    artifactId,
    kind,
    revision,
    state,
    statement,
    subjectRefs = [],
    payload = {},
    confidence = 'medium',
    evidence = [],
    triggerEvents = [],
    lineage = [],
    relations = [],
    salience = 0,
    temporal = {},
    directExtraction = false,
    disclosure = 'restricted',
    disclosureSource = 'default',
    opId = null,
  }: {
    artifactId: string
    kind: ArtifactKind
    revision: number
    state: ArtifactState
    statement: string
    subjectRefs?: string | string[]
    payload?: Record<string, unknown>
    confidence?: string
    evidence?: EvidenceDraft[]
    triggerEvents?: string | string[]
    lineage?: LineageDraft[]
    relations?: RelationDraft[]
    salience?: number
    temporal?: Record<string, unknown>
    directExtraction?: boolean
    disclosure?: Disclosure
    disclosureSource?: DisclosureSource
    opId?: string | null
  }): RevisionResult {
    // 状态合法性必须在插库前校验：KIND_STATES 是唯一判据，先拦下才能保证库里没有非法状态
    const allowed = KIND_STATES[kind]
    if (!allowed) throw invalid(`未知 Artifact 类型：${kind}`)
    if (!allowed.includes(state)) {
      throw new PsycheError(CODE.state, `${kind} 的状态只能是 ${allowed.join(' / ')}，收到「${state}」`)
    }
    const now = nowIso()
    const basisCount = evidence.length
    // 独立性按 independenceKey 去重，不按 sourceId：同一活动窗口里的多条来源只算一份证据
    const independent = new Set(evidence.map((item) => item.independenceKey)).size
    this.db.run(
      `INSERT INTO artifact_revisions (
         artifact_id, revision, state, statement, subject_refs, payload, confidence,
         basis_count, independent_evidence_count, salience, temporal, direct_extraction,
         disclosure, disclosure_source, created_at, updated_at, op_id, schema_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        artifactId,
        revision,
        state,
        cleanText(statement, 2000),
        JSON.stringify(parseList(subjectRefs)),
        JSON.stringify(payload ?? {}),
        normaliseEnum(confidence, ['low', 'medium', 'high'] as const, 'confidence', 'medium'),
        basisCount,
        independent,
        Number(salience) || 0,
        JSON.stringify(temporal ?? {}),
        directExtraction ? 1 : 0,
        normaliseDisclosure(disclosure),
        normaliseDisclosureSource(disclosureSource),
        now,
        now,
        opId,
        SCHEMA_VERSION,
      ],
    )
    // 证据用 OR IGNORE：同一来源重复挂到同一 revision 上不算错误
    for (const item of evidence) {
      this.db.run(
        `INSERT OR IGNORE INTO artifact_evidence
           (artifact_id, revision, source_id, relation, quote, confidence, independence_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          artifactId,
          revision,
          item.sourceId,
          item.relation,
          item.quote ?? null,
          normaliseEnum(item.confidence, ['low', 'medium', 'high'] as const, 'evidence.confidence', 'medium'),
          item.independenceKey,
          now,
        ],
      )
    }
    // 触发事件同样 OR IGNORE：同一事件触发同一条结论多次时只留一条
    for (const eventId of parseList(triggerEvents)) {
      this.db.run(
        `INSERT OR IGNORE INTO artifact_trigger_events (artifact_id, revision, event_id) VALUES (?, ?, ?)`,
        [artifactId, revision, eventId],
      )
    }
    // 血统用普通 INSERT：重复的血统边说明调用方有 bug，让唯一约束直接报出来
    for (const item of lineage) {
      this.db.run(
        `INSERT INTO artifact_lineage (artifact_id, revision, from_artifact_id, from_revision, relation, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [artifactId, revision, item.fromArtifactId, item.fromRevision ?? null, item.relation ?? 'derivedFrom', now],
      )
    }
    for (const item of relations) {
      this.db.run(
        `INSERT OR IGNORE INTO artifact_relations
           (artifact_id, revision, target_artifact_id, target_revision, relation, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [artifactId, revision, item.targetArtifactId, item.targetRevision ?? null, item.relation, now],
      )
    }
    // 最后推进 artifacts.updated_at：列表按「最近变动」排序要用它，不必再扫 revision
    this.db.run(`UPDATE artifacts SET updated_at = ? WHERE artifact_id = ?`, [now, artifactId])
    // FTS5 双写：同一写事务内替换 head 索引（旧 revision 不进索引）。
    // 这里抛错 = 整笔业务事务回滚（#write 的 catch 另开事务记 failed），保证索引与库不会单边成功。
    upsertFtsRow(this.db, { artifactId, kind, statement })
    return {
      artifactId,
      revision,
      state,
      basisCount,
      independentEvidenceCount: independent,
    }
  }

  /**
   * 新建一条结论：先插 artifacts 壳（身份表，只存 id/kind），再插 revision 1（内容）。
   * 分两表是因为身份不变、内容只追版本；没给 state 时用 INITIAL_STATE[kind]（procedure 从 draft 起）。
   * 写库、不开事务。
   * @returns RevisionResult + kind。
   */
  #createArtifact({
    kind,
    statement,
    evidence,
    triggerEvents,
    lineage = [],
    relations = [],
    subjectRefs = [],
    payload = {},
    confidence = 'medium',
    salience = 0,
    temporal = {},
    directExtraction = false,
    state,
    disclosure = 'restricted',
    disclosureSource = 'default',
    opId = null,
  }: {
    kind: ArtifactKind
    statement: string
    evidence: EvidenceDraft[]
    triggerEvents: string | string[]
    lineage?: LineageDraft[]
    relations?: RelationDraft[]
    subjectRefs?: string | string[]
    payload?: Record<string, unknown>
    confidence?: string
    salience?: number
    temporal?: Record<string, unknown>
    directExtraction?: boolean
    state?: ArtifactState
    disclosure?: Disclosure
    disclosureSource?: DisclosureSource
    opId?: string | null
  }): RevisionResult & { kind: ArtifactKind } {
    const artifactId = newId(PREFIX.artifact)
    const now = nowIso()
    this.db.run(
      `INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at, op_id) VALUES (?, ?, ?, ?, ?, ?)`,
      [artifactId, PERSONA_ID, kind, now, now, opId],
    )
    const revision = this.#insertRevision({
      artifactId,
      kind,
      revision: 1,
      state: state ?? INITIAL_STATE[kind],
      statement,
      subjectRefs,
      payload,
      confidence,
      evidence,
      triggerEvents,
      lineage,
      relations,
      salience,
      temporal,
      directExtraction,
      disclosure,
      disclosureSource,
      opId,
    })
    // revision 里已经带回 artifactId，这里只补 kind
    return { kind, ...revision }
  }

  /**
   * 取某条结论的 head：同一 id 的 max(revision)。**只读、不开事务**。
   * 刻意不先按 state 过滤——否则 challenged / superseded 的结论会从列表里凭空消失，
   * 而「它曾经存在过、现在处于什么状态」本身就是要展示的信息。
   * @throws E_NOT_FOUND（id 不存在或根本没有 revision）。
   */
  #head(artifactId: string): ArtifactHeadRow {
    const row = this.#row<ArtifactHeadRow>(
      `SELECT a.artifact_id, a.kind, r.*
         FROM artifacts a
         JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
        WHERE a.artifact_id = ?
          AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)`,
      [artifactId],
    )
    if (!row) throw new PsycheError(CODE.notFound, `找不到 Artifact：${artifactId}`)
    return row
  }

  /**
   * 写后张力登记：只比较「与目标共享话题锚点」的活跃 head，不做全库两两比较。
   *
   * 只报不裁决：登记新 pair（open），不自动关闭已有张力——解除要人/规则裁决。
   * 失败只 warn，绝不影响主写：张力是派生观察，不能反过来把记忆写坏。
   */
  #syncTensionsOf(artifactId: string): void {
    try {
      const target = this.#head(artifactId)
      const subjects = normalizeSubjects(parseJson<string[]>(target.subject_refs, []))
      if (subjects.length === 0) return
      const rows = this.db.all<ArtifactHeadRow>(
        `SELECT a.artifact_id, a.kind, r.*
           FROM artifacts a
           JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
          WHERE r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
            AND r.state IN ('active', 'challenged')
          ORDER BY r.updated_at DESC
          LIMIT 200`,
      )
      const wanted = new Set(subjects)
      const items = rows
        .filter((row) => {
          if (row.artifact_id === artifactId) return true
          const refs = normalizeSubjects(parseJson<string[]>(row.subject_refs, []))
          return refs.some((ref) => wanted.has(ref))
        })
        .map((row) => ({
          artifactId: row.artifact_id,
          revision: row.revision,
          kind: row.kind,
          state: row.state,
          statement: row.statement,
          subjectRefs: normalizeSubjects(parseJson<string[]>(row.subject_refs, [])),
        }))
      if (items.length < 2) return
      const { created, tensionIds } = syncTensions(this.db, items, { maxPairs: 10, actor: 'core' })
      if (created > 0) this.logger?.info?.(`[psyche] 登记 ${created} 条张力：${tensionIds.join(',')}`)
    } catch (error) {
      this.logger?.warn?.(`[psyche] 张力登记失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 写后登记决策回执：只报不裁决，失败只 warn，不影响主写。
   * 幂等键用「决策种类:业务 opId」——重放同一次写入不会重复记回执。
   */
  #recordDecision(input: {
    kind: DecisionKind
    opId: string
    items: DecisionItemInput[]
    resultArtifactId?: string | null
    resultRevision?: number | null
    reason?: string | null
  }): void {
    try {
      const decisionOpId = `${input.kind}:${input.opId}`
      const shell = createDecision(this.db, {
        opId: decisionOpId,
        kind: input.kind,
        actor: 'core',
        inputHash: input.opId,
      })
      const existing = getDecision(this.db, shell.record.decisionId)
      // 已经收过尾：说明上一次写入已经记过，重放不重复
      if (!existing || existing.run.status !== 'pending') return
      // 上次 append 成功但 finalize 失败时，重试会读到 pending 且已有依据；
      // 此时不要再追加一遍，否则同一条依据会重复写入。
      const hasBasis = existing.items.some((item) => item.role === 'input')
      if (input.items.length > 0 && !hasBasis) {
        appendDecisionItems(this.db, shell.record.decisionId, input.items)
      }
      finalizeDecision(this.db, shell.record.decisionId, {
        status: 'committed',
        reason: input.reason ?? null,
        resultArtifactId: input.resultArtifactId ?? null,
        resultRevision: input.resultRevision ?? null,
      })
    } catch (error) {
      this.logger?.warn?.(
        `[psyche] 决策回执登记失败（${input.kind}）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 写后局部重算：只看这条结论自己声明的 stanceGroup/stanceDirection，不做全库扫描。 */
  #reconcileStancesOf(artifactId: string | null | undefined): void {
    if (!artifactId) return
    try {
      const head = this.#head(artifactId)
      if (head.kind !== 'belief') return
      const payload = parseJson<Record<string, unknown>>(head.payload, {})
      const group = typeof payload.stanceGroup === 'string' ? payload.stanceGroup.trim() : ''
      const direction = payload.stanceDirection
      if (group === '') return
      if (direction !== 'for' && direction !== 'against' && direction !== 'neutral') return
      this.#reconcileStance(group, direction)
    } catch (error) {
      this.logger?.warn?.(
        `[psyche] 立场重算失败（${artifactId}）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * 阶段 3：从一组同组同向的 belief 合成正式立场。
   *
   * 只做局部求值：调用方给出刚变化的 group/direction，这里读快照 → 纯函数判定 → 落库。
   * 失败只 warn：立场是派生观察，不能反过来把触发它的 belief 写入搞坏。
   */
  #reconcileStance(group: string, direction: StanceDirection): void {
    try {
      const key = stanceKeyOf(group, direction)
      const beliefs = loadStanceBeliefs(this.db, key)
      if (beliefs.length === 0) return
      const ids = beliefs.map((belief) => belief.artifactId)
      const plan = planStanceSynthesis({
        beliefs,
        existing: loadExistingStance(this.db, key),
        conflicts: loadStanceConflicts(this.db, ids),
        unresolvedTensionArtifacts: loadUnresolvedTensionArtifacts(this.db, ids),
      })
      if (plan.action === 'skip') return
      this.#applyStancePlan(plan, beliefs)
    } catch (error) {
      this.logger?.warn?.(
        `[psyche] 立场合成失败（${group}:${direction}）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * 把合成计划落库：artifacts + revision + lineage + 证据 + Decision Receipt。
   * **只在 Core 内部调用**，调用方必须已经在写事务里（不自己开事务）。
   */
  #applyStancePlan(plan: StancePlan & ({ action: 'create' } | { action: 'revise' }), beliefs: StanceBeliefInput[]): void {
    const now = nowIso()
    // 证据跨 belief 去重：同一 source+relation 在两条 belief 上都出现时只留一份
    const evidence: EvidenceDraft[] = []
    const seen = new Set<string>()
    for (const belief of beliefs) {
      for (const item of this.#evidenceOf(belief.artifactId, belief.revision)) {
        const dedupeKey = `${item.sourceId}|${item.relation}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        evidence.push(item)
      }
    }
    const confidence: Confidence = beliefs.some((belief) => belief.confidence === 'high')
      ? 'high'
      : beliefs.every((belief) => belief.confidence === 'low')
        ? 'low'
        : 'medium'
    // 披露取最严：任一条依据不是 public，立场就不能 public（不能借合成把受限内容洗成公开）
    const disclosures = beliefs.map((belief) => normaliseDisclosure(this.#head(belief.artifactId).disclosure))
    const disclosure: Disclosure = disclosures.includes('secret')
      ? 'secret'
      : disclosures.includes('restricted')
        ? 'restricted'
        : 'public'
    const lineage = plan.basis.map((item) => ({
      fromArtifactId: item.artifactId,
      fromRevision: item.revision,
      relation: 'derivedFrom' as const,
    }))
    const basisItems: DecisionItemInput[] = plan.basis.map((item) => ({
      refType: 'artifact',
      refId: item.artifactId,
      refRevision: item.revision,
      role: 'input',
    }))

    if (plan.action === 'create') {
      const artifactId = newId(PREFIX.artifact)
      this.db.run(
        `INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at, op_id, stance_key)
         VALUES (?, ?, 'stance', ?, ?, NULL, ?)`,
        [artifactId, PERSONA_ID, now, now, plan.key],
      )
      const revision = this.#insertRevision({
        artifactId,
        kind: 'stance',
        revision: 1,
        state: 'active',
        statement: plan.statement,
        subjectRefs: [],
        payload: {
          stanceKey: plan.key,
          stanceGroup: plan.group,
          stanceDirection: plan.direction,
          changedBecause: 'initial',
        },
        confidence,
        evidence,
        lineage,
        disclosure,
        disclosureSource: 'default',
      })
      this.#recordDecision({
        kind: 'stance',
        opId: `stance:${plan.key}:${revision.revision}`,
        items: basisItems,
        resultArtifactId: artifactId,
        resultRevision: revision.revision,
        reason: `stanceKey=${plan.key}`,
      })
      return
    }

    const artifact = this.db.get<{ artifact_id: string }>(
      `SELECT artifact_id FROM artifacts WHERE stance_key = ? LIMIT 1`,
      [plan.key],
    )
    if (!artifact) return
    const head = this.#head(artifact.artifact_id)
    const revision = this.#insertRevision({
      artifactId: head.artifact_id,
      kind: 'stance',
      revision: head.revision + 1,
      // challenged 不因「又合成了一次」被洗白：状态只由 review 改
      state: head.state === 'challenged' ? 'challenged' : 'active',
      statement: plan.statement,
      subjectRefs: parseJson<string[]>(head.subject_refs, []),
      payload: {
        stanceKey: plan.key,
        stanceGroup: plan.group,
        stanceDirection: plan.direction,
        changedBecause: plan.changedBecause,
      },
      confidence,
      evidence: dedupeEvidence([...this.#evidenceOf(head.artifact_id, head.revision), ...evidence]),
      triggerEvents: this.#triggerEventsOf(head.artifact_id, head.revision),
      lineage,
      disclosure,
      disclosureSource: normaliseDisclosureSource(head.disclosure_source),
    })
    this.#recordDecision({
      kind: 'stance',
      opId: `stance:${plan.key}:${revision.revision}`,
      items: basisItems,
      resultArtifactId: head.artifact_id,
      resultRevision: revision.revision,
      reason: `stanceKey=${plan.key}; changedBecause=${plan.changedBecause}`,
    })
  }

  /**
   * 消费一条披露授权凭据：一次性、可过期、绑定内容与（可选）目标。
   * 返回 true 表示凭据有效且已标记用掉；任何一项不满足都返回 false，
   * 调用方据此把 public 降回 restricted——「授权不足」是安全结果，不是异常。
   */
  #consumeDisclosureGrant(
    grantId: string | undefined,
    target: { contentHash: string; artifactId?: string | null; revision?: number | null },
  ): boolean {
    if (!grantId) return false
    const row = this.#row<{
      grant_id: string
      artifact_id: string | null
      revision: number | null
      content_hash: string
      used_at: string | null
      expires_at: string | null
      revoked_at: string | null
    }>(
      `SELECT grant_id, artifact_id, revision, content_hash, used_at, expires_at, revoked_at
         FROM disclosure_grants
        WHERE grant_id = ?`,
      [grantId],
    )
    if (!row || row.used_at || row.revoked_at) return false
    if (row.expires_at && row.expires_at <= nowIso()) return false
    if (row.content_hash !== target.contentHash) return false
    if (row.artifact_id && row.artifact_id !== (target.artifactId ?? null)) return false
    if (row.revision !== null && row.revision !== (target.revision ?? null)) return false
    const result = this.db.run(
      `UPDATE disclosure_grants SET used_at = ?
        WHERE grant_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      [nowIso(), grantId],
    )
    return result.changes === 1
  }

  /** 取某 revision 的全部证据（只读）；修订时用它把旧证据原样搬到新版本。 */
  #evidenceOf(artifactId: string, revision: number): EvidenceDraft[] {
    return this.#rows<{
      source_id: string
      relation: EvidenceRelation
      quote: string | null
      confidence: Confidence
      independence_key: string
    }>(
      `SELECT source_id, relation, quote, confidence, independence_key
         FROM artifact_evidence WHERE artifact_id = ? AND revision = ?`,
      [artifactId, revision],
    ).map((row) => ({
      sourceId: row.source_id,
      relation: row.relation,
      quote: row.quote,
      confidence: row.confidence,
      independenceKey: row.independence_key,
    }))
  }

  /** 取某 revision 的触发事件 id（ORDER BY 保证输出稳定；只读）。 */
  #triggerEventsOf(artifactId: string, revision: number): string[] {
    return this.#rows<{ event_id: string }>(
      `SELECT event_id FROM artifact_trigger_events WHERE artifact_id = ? AND revision = ? ORDER BY event_id`,
      [artifactId, revision],
    ).map((row) => row.event_id)
  }

  /** 取某 revision 的血统边（只读）。 */
  #lineageOf(artifactId: string, revision: number): LineageDraft[] {
    return this.#rows<{ from_artifact_id: string; from_revision: number | null; relation: LineageRelation }>(
      `SELECT from_artifact_id, from_revision, relation FROM artifact_lineage WHERE artifact_id = ? AND revision = ?`,
      [artifactId, revision],
    ).map((row) => ({
      fromArtifactId: row.from_artifact_id,
      fromRevision: row.from_revision,
      relation: row.relation,
    }))
  }

  /** 取某 revision 与其它结论的关系（只读）。 */
  #relationsOf(artifactId: string, revision: number): RelationDraft[] {
    return this.#rows<{
      target_artifact_id: string
      target_revision: number | null
      relation: ArtifactRelation
    }>(
      `SELECT target_artifact_id, target_revision, relation FROM artifact_relations
        WHERE artifact_id = ? AND revision = ?`,
      [artifactId, revision],
    ).map((row) => ({
      targetArtifactId: row.target_artifact_id,
      targetRevision: row.target_revision,
      relation: row.relation,
    }))
  }

  /** 取某结论**所有版本**的证据来源（DISTINCT；只读）——用于「这条结论的依据是什么」的完整追溯。 */
  #sourcesOfWork(artifactId: string): SourceRow[] {
    return this.#rows<SourceRow>(
      `SELECT DISTINCT s.* FROM sources s
         JOIN artifact_evidence e ON e.source_id = s.source_id
        WHERE e.artifact_id = ?`,
      [artifactId],
    )
  }

  // ── 事务壳：opId 幂等 + 计时 + 失败回滚后可重放（§11.4 / §9.2 第 6 条）──────

  /**
   * 写事务壳：opId 幂等 + 计时 + 失败记账。**唯一写入口**，所有 public 写方法都经它。
   * 事务内顺序：① 查同 opId 的旧 operations 行 → ② 先比 argsHash（不同就 E_IDEMPOTENT_CONFLICT）
   * → ③ status==='ok' 直接重放旧结果 → ④ 否则执行 work() 再落 operations 行。
   * important=true 时底层事务用 FULL synchronous 落盘（重要写入崩溃也不丢），只读路径不受影响。
   * @param args 原始入参：opId 从里面取，argsHash 去掉 opId 后算。
   * @throws 透传 work() 抛的任何 E_*；opId 冲突抛 E_IDEMPOTENT_CONFLICT。
   */
  async #write<T extends object>(
    tool: string,
    args: unknown,
    work: (meta: WriteMeta) => T,
    { important = true, source = 'tool' }: { important?: boolean; source?: string } = {},
  ): Promise<WriteResult<T>> {
    // 冻结期一刀切：恢复已经排好队，新记忆不能再进来（否则预恢复包不等于替换前状态）
    if (this.#writesFrozen) {
      throw new PsycheError(
        CODE.restorePending,
        this.#freezeReason || '正在等待重启应用恢复，这期间不接受新的记忆写入',
      )
    }
    // 入参没带 opId 就现生成一个：每次调用都该有一条 operations 记录，会话级追踪才有据可查
    const opId = cleanText(asRecord(args).opId, 120) || newId(PREFIX.operation)
    const argsHash = hashArgs(args ?? {})
    const startedAt = nowIso()
    const started = performance.now()

    const run = (): { replayed: boolean; payload: T } =>
      this.db.transaction(
        () => {
          const prior = this.#row<{ op_id: string; status: string; result: string | null; args_hash: string }>(
            `SELECT op_id, status, result, args_hash FROM operations WHERE op_id = ?`,
            [opId],
          )
          // 先验入参：同一个 opId 换了内容，既不能重放也不能重写（§11.4 幂等只认同一次提交）
          // 顺序不能反：若先判 status==='ok' 就重放，同 opId 换内容会被当成「重放」静默返回旧结果
          if (prior && prior.args_hash !== argsHash) {
            throw new PsycheError(
              CODE.idempotent,
              `opId ${opId} 已经用过，但这次入参不同；幂等要求同 opId 同入参`,
            )
          }
          if (prior && prior.status === 'ok') {
            // 重放：直接回上次结果，**不再执行 work**——副作用绝不能发生第二次
            return { replayed: true, payload: parseJson<T>(prior.result, {} as T) }
          }
          const payload = work({ opId, argsHash, tool })
          const duration = Math.round((performance.now() - started) * 100) / 100
          // 先前的 failed 行要原地改成 ok；没有旧行才 INSERT（同一 opId 只能有一行）
          if (prior) {
            this.db.run(
              `UPDATE operations SET status = 'ok', result = ?, error = NULL, duration_ms = ?, finished_at = ?
                WHERE op_id = ?`,
              [JSON.stringify(payload), duration, nowIso(), opId],
            )
          } else {
            this.db.run(
              `INSERT INTO operations (op_id, persona_id, tool, args_hash, status, result, error, duration_ms, source, created_at, finished_at)
               VALUES (?, ?, ?, ?, 'ok', ?, NULL, ?, ?, ?, ?)`,
              [opId, PERSONA_ID, tool, argsHash, JSON.stringify(payload), duration, source, startedAt, nowIso()],
            )
          }
          return { replayed: false, payload }
        },
        { important },
      )

    let outcome: { replayed: boolean; payload: T }
    try {
      outcome = run()
    } catch (error) {
      const duration = Math.round((performance.now() - started) * 100) / 100
      // 失败必须**另开一个事务**记账：原事务已经整笔回滚，若在同一个事务里记账，
      // failed 行会跟着回滚，等于什么都没留下（「失败了但查不到为什么失败」）。
      try {
        this.db.transaction(() => {
          const existing = this.#row(`SELECT status FROM operations WHERE op_id = ?`, [opId])
          const message = error instanceof Error ? error.message : String(error)
          if (existing) {
            this.db.run(
              `UPDATE operations SET status = 'failed', error = ?, duration_ms = ?, finished_at = ? WHERE op_id = ?`,
              [cleanText(message, 500), duration, nowIso(), opId],
            )
          } else {
            this.db.run(
              `INSERT INTO operations (op_id, persona_id, tool, args_hash, status, result, error, duration_ms, source, created_at, finished_at)
               VALUES (?, ?, ?, ?, 'failed', NULL, ?, ?, ?, ?, ?)`,
              [opId, PERSONA_ID, tool, argsHash, cleanText(message, 500), duration, source, startedAt, nowIso()],
            )
          }
        })
      } catch (logError) {
        // 记账本身失败只 warn：绝不能用一个记账异常盖掉真正的业务错误
        this.logger?.warn?.(
          `[psyche] 失败记录写不进去：${logError instanceof Error ? logError.message : String(logError)}`,
        )
      }
      throw error
    }

    const payload = outcome.payload ?? ({} as T)
    // 闸门只在「写完认知之后」评估，读路径一律不写库（v14 §22）。
    // Growth Gate（v18）：阶段推进的唯一自动入口是 syncGrowth()。
    // Growth 输入性能（v27.52）：写路径**不再**做全量成长派生。
    // `loadGrowthInputs` 要扫 artifact_evidence / events / artifact_revisions 全表，
    // 每次写入都跑一遍会让单次记忆写入随历史线性变慢；而这里的结果只用于一条 info 提示，
    // 不影响阶段判定。真正的判定仍由 syncGrowth()（启动 / 面板 / 提案确认）全量完成。
    // WriteResult<T> 是分配式条件类型，泛型里无法被 TS 直接验证，这里只做形状断言
    const merged = { ok: true as const, opId, replayed: outcome.replayed, ...payload } as WriteResult<T>
    // payload 自带 replayed 时（CaptureResult 的 captureKey 重放），以「opId 重放或来源重放」任一命中为准
    merged.replayed = outcome.replayed || (payload as { replayed?: boolean }).replayed === true
    return merged
  }

  /**
   * 只读调用统一在这里记一条 operations（§9.2）。
   * `audit: false` 用于面板轮询这类高频读——审计行不是成长历史，但一天几千行会把表撑肿，
   * 所以后台轮询不记账，模型工具调用照样记。
   * @param options.audit 传 false 时直接返回，连 operations 都不写。
   * @returns { ok, opId, ...payload }；审计写入失败只 debug，不影响读取结果。
   */
  async #read<T extends object>(
    tool: string,
    args: unknown,
    work: () => T,
    options: { audit?: boolean } = {},
  ): Promise<ReadResult<T>> {
    const opId = newId(PREFIX.operation)
    const started = performance.now()
    // 先跑查询再记账：查询自己抛错就让它抛，不必先留一条审计行
    const payload = work()
    const duration = Math.round((performance.now() - started) * 100) / 100
    if (options.audit === false) return { ok: true, opId, ...payload } as ReadResult<T>
    try {
      this.db.run(
        `INSERT INTO operations (op_id, persona_id, tool, args_hash, status, result, error, duration_ms, source, created_at, finished_at)
         VALUES (?, ?, ?, ?, 'ok', ?, NULL, ?, 'tool', ?, ?)`,
        [
          opId,
          PERSONA_ID,
          tool,
          hashArgs(args ?? {}),
          JSON.stringify({ read: tool }),
          duration,
          nowIso(),
          nowIso(),
        ],
      )
    } catch (error) {
      // 审计失败只 debug：读路径不能因为「记账没记上」就整体报错
      this.logger?.debug?.(
        `[psyche] 只读调用没记上 operations：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return { ok: true, opId, ...payload } as ReadResult<T>
  }

  // ── 对外能力（§13.2 ctx.psyche 的实现面）────────────────────

  /**
   * 收一条来源进 sources（捕获原始素材）。**写库**，事务由 #insertSource 自己开。
   * 与 perceive 是同一条落库路径，差别只在打了 debug 日志：capture 走会话流水的正常采集，
   * perceive 是「我看到/听到了」的感知型入口，两者语义一致，不做区分。
   * @throws E_VALIDATION（channel/origin/kind 等枚举不合法）
   */
  async capture(input: CaptureInput = {}): Promise<{ ok: true } & CaptureResult> {
    // 显式 opId 才走写壳（幂等 + 审计行）。内部实时采集（CaptureHost）不传 opId，
    // 否则每条消息都往 operations 里写一行审计，表会被会话流水撑大。
    if (!cleanText(input.opId, 120)) {
      // 一笔事务盖住「幂等查重 → 窗口 → 房间 → 联系人 → sources 行」：中途失败不留半条来源
      const source = this.db.transaction(() => this.#insertSource(input))
      const suffix = source.replayed ? ' (replayed)' : ''
      this.logger?.debug?.(`[psyche] captured ${source.sourceId}${suffix}`)
      return { ok: true, ...source }
    }
    // 同 opId 同内容重放、同 opId 换内容抛 E_IDEMPOTENT_CONFLICT；captureKey 幂等仍在 #insertSource 内
    const result = await this.#write<CaptureResult>('psyche_capture', input, () => this.#insertSource(input))
    const suffix = result.replayed ? ' (replayed)' : ''
    this.logger?.debug?.(`[psyche] captured ${result.sourceId}${suffix}`)
    return { ...result, ok: true }
  }

  /** 与 capture 走同一个 #insertSource，只有「不打 debug 日志」这一点不同。写库、开事务。 */
  async perceive(input: CaptureInput = {}): Promise<{ ok: true } & CaptureResult> {
    const source = this.db.transaction(() => this.#insertSource(input))
    return { ok: true, ...source }
  }

  /** D-1 可信桥接专用；不挂模型工具。Source/Event/序号同事务，普通消息不存正文。 */
  async ingestGroupMessage(input: GroupMessageInput): Promise<WriteResult<GroupMessageResult>> {
    return this.#write('psyche_group_intake', input, ({ opId }) => {
      const qqId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
      if (!qqId(input.externalRoomId) || !qqId(input.stableUserId)) throw invalid('群或发送者身份非法')
      if (typeof input.messageId !== 'string' || !/^[A-Za-z0-9_:-]{1,120}$/.test(input.messageId)) throw invalid('群消息身份缺失或非法')
      if (!['mentioned_only', 'all_visible_messages'].includes(input.captureMode)) throw invalid('群采集模式非法')
      if (typeof input.text !== 'string' || input.text.length > 20000) throw invalid('群消息正文长度非法')
      const policy=input.policy===undefined?null:roomPolicy(input.policy)
      if(policy&&(policy.externalRoomId!==input.externalRoomId||policy.captureMode!==input.captureMode))throw invalid('GROUP_POLICY_BINDING')
      if(input.parts&&groupPartsText(input.parts)!==input.text)throw invalid('GROUP_PARTS_TEXT_MISMATCH')
      if(input.schedulingReady!==undefined&&typeof input.schedulingReady!=='boolean')throw invalid('GROUP_READY_INVALID')
      const nameMatches=policy&&input.parts?groupNameMatches(input.parts,policy.names):[]
      const at = input.at ?? nowIso()
      if (!Number.isFinite(Date.parse(at))) throw invalid('群消息采集时间非法')
      const mentions = input.mentions ?? []
      if (!Array.isArray(mentions) || mentions.some((id) => !qqId(id))) throw invalid('群消息提及身份非法')
      if(policy&&input.parts) {
        const atIds=[...new Set(input.parts.filter(part=>part.type==='at').map(part=>(part as {qq:string}).qq))].sort()
        const replyId=input.parts.find(part=>part.type==='reply') as {type:'reply';id:string}|undefined
        if(JSON.stringify(atIds)!==JSON.stringify([...new Set(mentions)].sort())||(replyId?.id??null)!==(input.replyToMessageId??null))throw invalid('GROUP_PARTS_ID_MISMATCH')
      }
      const roomId = this.#ensureRoom({ platform: 'qq', channel: 'group', externalRoomId: input.externalRoomId })!
      const room = this.#row<{ active: number; capture_mode: string }>('SELECT active,capture_mode FROM rooms WHERE room_id=? AND persona_id=?', [roomId, PERSONA_ID])
      if (!room || room.active !== 1) throw invalid('群 Room 已停用')
      const prior = this.#row<{ room_seq: number; source_id: string | null; event_id: string | null }>(
        'SELECT room_seq,source_id,event_id FROM room_message_seq WHERE platform=? AND room_id=? AND message_id=?',
        ['qq', roomId, input.messageId],
      )
      if (prior) {
        if (prior.source_id) {
          const source = this.#row<SourceRow>('SELECT * FROM sources WHERE source_id=?', [prior.source_id])
          if (!source) throw invalid('群消息来源引用损坏')
          this.#replaySource(source, { text: input.text, origin: 'user', kind: 'message' })
          const sender = this.#row<{ stable_user_id: string }>('SELECT stable_user_id FROM contacts WHERE contact_id=?', [source.sender_contact_id])
          if (sender?.stable_user_id !== input.stableUserId) throw invalid('同一群消息的发送者身份冲突')
        }
        return { roomId, roomSeq: prior.room_seq, sourceId: prior.source_id, eventId: prior.event_id, retained: prior.source_id !== null, replayed: true }
      }
      if (room.capture_mode !== input.captureMode) this.db.run('UPDATE rooms SET capture_mode=?,updated_at=? WHERE room_id=?', [input.captureMode, at, roomId])
      this.db.run('INSERT OR IGNORE INTO room_participation_state(room_id,updated_at) VALUES (?,?)', [roomId, at])
      const last = this.#row<{ last_seq: number }>('SELECT last_seq FROM room_participation_state WHERE room_id=?', [roomId])!.last_seq
      if (!Number.isSafeInteger(last) || last >= Number.MAX_SAFE_INTEGER) throw invalid('群序号容量已耗尽')
      const roomSeq = last + 1
      const contactId = this.#resolveContactSync({ platform: 'qq', stableUserId: input.stableUserId, roomId })
      const reply = input.replyToMessageId ? this.#row<{ source_id: string; origin: string }>(
        "SELECT source_id,origin FROM sources WHERE persona_id=? AND platform='qq' AND channel='group' AND room_id=? AND message_id=? ORDER BY rowid DESC LIMIT 1",
        [PERSONA_ID, roomId, input.replyToMessageId],
      ) : undefined
      const accountKey=qqId(input.selfId)?groupHash(input.selfId):null
      const delivered=accountKey&&input.replyToMessageId?this.#row<{source_id:string}>(
        "SELECT b.source_id FROM room_reply_bindings b JOIN sources s ON s.source_id=b.source_id WHERE b.platform='qq' AND b.account_key=? AND b.room_id=? AND b.platform_message_id=? AND s.origin='self' AND s.room_id=b.room_id",
        [accountKey,roomId,input.replyToMessageId]):undefined
      const atMatch=qqId(input.selfId)&&mentions.includes(input.selfId)
      const retained = input.captureMode === 'all_visible_messages' || atMatch || reply?.origin === 'self' || !!delivered || nameMatches.length>0
      const reasons=policy?[
        ...(atMatch&&policy.triggers.at?['at']:[]),...(delivered&&policy.triggers.reply?['reply']:[]),
        ...(nameMatches.length&&policy.triggers.name?['name']:[]),
      ]:[]
      let sourceId: string | null = null
      let eventId: string | null = null
      if (retained) {
        const source = this.#insertSource({
          platform: 'qq', channel: 'group', roomId, sessionRef: `qq-group-${input.externalRoomId}`,
          senderContactId: contactId, messageId: input.messageId, replyToMessageId: input.replyToMessageId,
          mentions, quotedSourceRefs: delivered?[delivered.source_id]:reply?[reply.source_id]:[], origin: 'user', kind: 'message', text: input.text,
          captureKey: `qq-group:${input.externalRoomId}:message:${input.messageId}`, at,
          ...(policy?{metadata:{groupIntakeVersion:2,policyHash:policy.policyHash,reasons,nameMatches,accountKey,legacySelfReference:reply?.origin==='self'&&!delivered}}:{}),
        })
        sourceId = source.sourceId
        eventId = this.#insertEvent({ kind: 'interaction', type: 'conversation', text: '群内消息已采集', at,
          sessionRef: `qq-group-${input.externalRoomId}`, roomId, subjectRefs: [contactId], opId,
          sourceRows: [this.#row<SourceRow>('SELECT * FROM sources WHERE source_id=?', [sourceId])!],
        })
      }
      this.db.run('INSERT INTO room_message_seq(room_id,platform,message_id,room_seq,source_id,event_id,received_at) VALUES (?,?,?,?,?,?,?)',
        [roomId, 'qq', input.messageId, roomSeq, sourceId, eventId, at])
      this.db.run('UPDATE room_participation_state SET last_seq=?,updated_at=? WHERE room_id=?', [roomSeq, at, roomId])
      const ms=Date.parse(at)
      this.db.run("UPDATE room_triggers SET last_arrival_ms=MAX(last_arrival_ms,?) WHERE room_id=? AND state='armed'",[ms,roomId])
      if(sourceId&&policy&&reasons.length&&accountKey) this.db.run(`INSERT INTO room_triggers(room_id,room_seq,source_id,policy_hash,account_key,transport_id,state,reason,created_ms,last_arrival_ms)
        VALUES(?,?,?,?,?,'qq-onebot',?,?,?,?)`,[roomId,roomSeq,sourceId,policy.policyHash,accountKey,input.schedulingReady===true&&policy.reply.enabled?'armed':'suppressed',input.schedulingReady===true&&policy.reply.enabled?null:'reply_or_proof_disabled',ms,ms])
      return { roomId, roomSeq, sourceId, eventId, retained, replayed: false }
    }, { source: 'host' })
  }

  /**
   * 私聊采集入口（replySchedules 第二批，GPT 第 2 轮裁定 (a)）。
   *
   * 与 `ingestGroupMessage` 的区别：不碰 room / 水位 / 触发行，只写一条 Source 与一条
   * `conversation` 事件。调用方的用法是「时段外仍然采集，但不建回复轮、不排队、不发送」。
   * 幂等：同一 `platform + sessionRef + captureKey` 再进来，返回既有 Source/Event（不新增
   * Event）；正文变了解释为「同一条消息内容冲突」，由 `#replaySource` 抛 E_CAPTURE_CONFLICT。
   */
  async ingestPrivateMessage(input: PrivateMessageInput): Promise<WriteResult<PrivateMessageResult>> {
    return this.#write('psyche_private_intake', input, ({ opId }) => {
      const qqId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
      if (!qqId(input.stableUserId)) throw invalid('私聊对象身份非法')
      if (typeof input.messageId !== 'string' || !/^[A-Za-z0-9_:-]{1,120}$/.test(input.messageId)) {
        throw invalid('私聊消息身份缺失或非法')
      }
      if (typeof input.text !== 'string' || input.text.length > 20000) throw invalid('私聊消息正文长度非法')
      const at = input.at ?? nowIso()
      if (!Number.isFinite(Date.parse(at))) throw invalid('私聊消息采集时间非法')
      const sessionRef = input.sessionRef ?? `qq-private-${input.stableUserId}`
      if (typeof sessionRef !== 'string' || sessionRef.length === 0 || sessionRef.length > 200) {
        throw invalid('私聊会话引用非法')
      }
      const captureKey = `qq-private:${input.stableUserId}:message:${input.messageId}`
      // 跨路径去重（GPT 第 3 轮 ③ 锁一）：Host capture 与独立采集可能对同一条 QQ 消息各写
      // 一份 Source，captureKey 只在独立路径内部唯一。身份统一按
      // (platform, session_ref, message_id) 认定：命中既有行就重放，不再写第二条。
      const byMessageId = this.#row<SourceRow>(
        `SELECT * FROM sources WHERE persona_id = ? AND platform = 'qq' AND session_ref = ? AND message_id = ? ORDER BY rowid LIMIT 1`,
        [PERSONA_ID, sessionRef, input.messageId],
      )
      const prior = byMessageId ?? this.#row<SourceRow>(
        `SELECT * FROM sources WHERE persona_id = ? AND platform = 'qq' AND session_ref = ? AND capture_key = ? LIMIT 1`,
        [PERSONA_ID, sessionRef, captureKey],
      )
      if (prior) {
        // 同一条消息只记一次：重放不新增事件。
        // 只有「同一 captureKey 再进来」才校验正文一致性（同身份不同内容是错误）；
        // 按 message_id 命中 Host capture 的行时，正文由 Host 侧编排，不做逐字比对。
        if (prior.capture_key === captureKey) {
          this.#replaySource(prior, { text: input.text, origin: 'user', kind: 'message' })
        }
        const link = this.#row<{ event_id: string }>(
          'SELECT event_id FROM event_sources WHERE source_id = ? ORDER BY rowid LIMIT 1',
          [prior.source_id],
        )
        return { sessionRef, sourceId: prior.source_id, eventId: link?.event_id ?? null, replayed: true }
      }
      const contactId = this.#resolveContactSync({
        platform: 'qq',
        stableUserId: input.stableUserId,
        displayName: input.displayName ?? null,
      })
      const source = this.#insertSource({
        platform: 'qq',
        channel: 'private',
        sessionRef,
        senderContactId: contactId,
        messageId: input.messageId,
        origin: 'user',
        kind: 'message',
        text: input.text,
        captureKey,
        at,
      })
      const eventId = this.#insertEvent({
        kind: 'interaction',
        type: 'conversation',
        text: '私聊消息已采集',
        at,
        sessionRef,
        subjectRefs: [contactId],
        opId,
        sourceRows: [this.#row<SourceRow>('SELECT * FROM sources WHERE source_id = ?', [source.sourceId])!],
      })
      return { sessionRef, sourceId: source.sourceId, eventId, replayed: false }
    }, { source: 'host' })
  }

  /** D-1 内部只读快照；不推进水位、不向模型暴露写句柄。 */
  readGroupIntake(roomId: string) {
    const room = this.#row('SELECT 1 FROM rooms WHERE room_id=? AND persona_id=? AND channel=?', [roomId, PERSONA_ID, 'group'])
    if (!room) throw invalid('未知群 Room')
    return { state: this.#row('SELECT last_seq,read_through_seq,participation_state FROM room_participation_state WHERE room_id=?', [roomId]),
      messages: this.#rows('SELECT room_seq,message_id,source_id,event_id FROM room_message_seq WHERE room_id=? ORDER BY room_seq LIMIT 200', [roomId]) }
  }

  /** D-2 trusted Host surface only; never exported through ctx.psyche/tools/HTTP. */
  async groupSchedule(input: GroupCommand) {
    let proof:ReturnType<typeof groupProofData>|undefined
    let untrusted=false
    if(input.proof)try{proof=groupProofData(input.proof)}catch{untrusted=true}
    // Audit hashes bind proof data rather than the opaque capability identity. No body in result.
    const args={...input,...(proof?{proof}:untrusted?{proof:{untrusted:true}}:{})}
    return this.#write('psyche_group_schedule',args,()=>{
      if(untrusted)throw invalid('GROUP_PROOF_UNTRUSTED')
      return applyGroupCommand(this.db,input,proof,(source)=>this.#insertSource({platform:'qq',channel:'group',roomId:source.roomId,origin:'self',kind:'message',text:source.text,captureKey:source.captureKey,metadata:source.metadata,at:new Date(input.now).toISOString()}).sourceId)
    },{source:'host'})
  }

  readGroupSchedule() { return readGroupSchedule(this.db) }
  readGroupBatch(batchId: string) { return readGroupBatch(this.db,batchId) }

  /**
   * 解析/创建联系人，顺带确保房间存在，返回对外身份。**写库**，内部 db.transaction 包住
   * #ensureRoom + #resolveContactSync + 回查 contacts：房间与联系人必须落在同一笔里。
   * @throws E_VALIDATION（platform / stableUserId 缺失或超长）
   */
  async resolveContact(input: ResolveContactInput = {}): Promise<{
    ok: true
    contactId: string
    platform: string
    stableUserId: string
    displayName: string | null
    relationLabel: string | null
  }> {
    // platform + stableUserId 才是身份主键：同一个账号换个平台算另一个人，不能靠显示名去认人
    const platform = requireText(input.platform, 'platform', 40)
    const stableUserId = requireText(input.stableUserId ?? input.stable_user_id, 'stableUserId', 200)
    // 没有 externalRoomId 时 #ensureRoom 直接返 null：私聊/单机场景不需要房间
    const roomId = this.#ensureRoom({
      platform,
      channel: input.channel ?? 'private',
      externalRoomId: input.externalRoomId ?? null,
      title: input.roomTitle ?? null,
    })
    return this.db.transaction(() => {
      const contactId = this.#resolveContactSync({
        platform,
        stableUserId,
        displayName: input.displayName ?? null,
        roomId,
      })
      // 回查而不是直接用入参拼：显示名和关系标签以库里那行为准（可能是早先记下的）
      const row = this.#row<{
        platform: string
        stable_user_id: string
        display_name: string | null
        relation_label: string | null
      }>(`SELECT * FROM contacts WHERE contact_id = ?`, [contactId])
      return {
        ok: true as const,
        contactId,
        platform: row?.platform ?? platform,
        stableUserId: row?.stable_user_id ?? stableUserId,
        displayName: row?.display_name ?? null,
        relationLabel: row?.relation_label ?? null,
      }
    })
  }

  /**
   * 写一条关系信号并重算好感（P3-B-1）。**写库**，走 #write（opId 幂等 + 失败整笔回滚）。
   *
   * 事务内顺序：校验 Contact → 推导规则 → 校验证据/独立键 → 查 independence_key →
   * 算 24h 窗口净变化 → 写账本 → 重算好感（manual_override=1 时跳过）→ 写 operations。
   * 同一 `(contact_id, independence_key)` 重复投递返回已有行（duplicate=true），不二次加分。
   * 当前没有 `independence_key` 唯一索引，所以查重必须在 BEGIN IMMEDIATE 事务内完成；
   * 跨进程并发由事务串行 + 查重兜底，不依赖数据库约束（D-1 冻结）。
   * @throws E_VALIDATION（Contact/类型/方向/证据/独立键非法）、E_NOT_FOUND（Contact 不存在）
   */
  async recordRelationshipSignal(
    input: RelationshipSignalInput = {},
  ): Promise<WriteResult<RelationshipSignalPayload>> {
    return this.#write('psyche_relationship_signal', input, ({ opId }) => {
      const contactId = requireText(input.contactId ?? input.contact_id, 'contactId', 120)
      const contact = this.#row<{ contact_id: string }>(
        `SELECT contact_id FROM contacts WHERE contact_id = ? AND persona_id = ?`,
        [contactId, PERSONA_ID],
      )
      if (!contact) throw new PsycheError(CODE.notFound, `找不到 Contact：${contactId}`)

      const signalType = cleanText(input.signalType ?? input.signal_type, 40)
      const polarity = cleanText(input.polarity, 20)
      const derived = deriveRelationshipDelta(signalType, polarity)
      if (!derived) {
        throw invalid('关系信号类型或方向不合法', { signalType, polarity })
      }
      const independenceKey = requireText(input.independenceKey ?? input.independence_key, 'independenceKey', 200)
      const evidenceRefs = normaliseRelationshipEvidence(input.evidenceRefs)
      if (evidenceRefs.length === 0) throw invalid('关系信号至少需要一条证据')
      for (const ref of evidenceRefs) {
        const hit = this.#row(
          `SELECT 1 AS hit FROM sources WHERE source_id = ?
           UNION ALL SELECT 1 AS hit FROM events WHERE event_id = ? LIMIT 1`,
          [ref, ref],
        )
        if (!hit) throw invalid(`关系信号证据不存在：${ref}`, { evidenceRefs })
      }
      const sourceId = cleanText(input.sourceId, 120) || null
      const eventId = cleanText(input.eventId, 120) || null
      const at = cleanText(input.now, 40) || nowIso()
      if (!Number.isFinite(Date.parse(at))) throw invalid('now 不是合法时间', { now: at })

      const projection = this.#row<{ affinity: number; manual_override: number }>(
        `SELECT affinity, manual_override FROM relationship_affinity_state WHERE persona_id = ? AND contact_id = ?`,
        [PERSONA_ID, contactId],
      )
      const currentAffinity = Number(projection?.affinity ?? this.defaultAffinity)
      const manualOverride = projection?.manual_override === 1

      // 同一独立键只算一次：查到旧行就直接把它返回（重放语义，不写新账）
      const existing = this.#row<{
        signal_id: string
        signal_type: string
        polarity: string
        base_delta: number
        applied_delta: number
        rule_version: string
      }>(
        `SELECT signal_id, signal_type, polarity, base_delta, applied_delta, rule_version
           FROM relationship_signals WHERE persona_id = ? AND contact_id = ? AND independence_key = ?`,
        [PERSONA_ID, contactId, independenceKey],
      )
      if (existing) {
        const band = bandFor(currentAffinity)
        return {
          ok: true as const,
          contactId,
          signalId: existing.signal_id,
          duplicate: true,
          signalType: existing.signal_type,
          polarity: existing.polarity,
          baseDelta: existing.base_delta,
          appliedDelta: existing.applied_delta,
          ruleVersion: existing.rule_version,
          affinity: currentAffinity,
          band: band.band,
          manualOverride,
          windowDelta: 0,
        }
      }

      // 24 小时窗口净变化：只按 created_at 落在 [at-24h, at] 的行算，跨窗口不累计
      const cutoff = new Date(Date.parse(at) - 24 * 60 * 60 * 1000).toISOString()
      const windowBefore = Number(
        this.#row<{ d: number }>(
          `SELECT COALESCE(SUM(applied_delta), 0) AS d FROM relationship_signals
            WHERE contact_id = ? AND created_at >= ? AND created_at <= ?`,
          [contactId, cutoff, at],
        )?.d ?? 0,
      )
      const appliedDelta = clampDailyDelta(windowBefore, derived.appliedDelta)
      const signalId = newId(PREFIX.signal)
      this.db.run(
        `INSERT INTO relationship_signals
           (signal_id, persona_id, contact_id, source_id, event_id, independence_key, signal_type,
            polarity, base_delta, confidence, applied_delta, rule_version, created_at, op_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          signalId,
          PERSONA_ID,
          contactId,
          sourceId,
          eventId,
          independenceKey,
          derived.signalType,
          derived.polarity,
          derived.baseDelta,
          derived.rule.confidence,
          appliedDelta,
          derived.ruleVersion,
          at,
          opId,
        ],
      )

      // manual_override 是「人定过」的标记：重算必须跳过，否则人的调整会被下一次信号静默抹掉
      let affinity = currentAffinity
      if (!manualOverride && appliedDelta !== 0) {
        affinity = clampAffinity(currentAffinity + appliedDelta)
        this.db.run(
          `UPDATE relationship_affinity_state SET affinity = ?, band = ?, updated_at = ?
            WHERE persona_id = ? AND contact_id = ?`,
          [affinity, bandFor(affinity).band, at, PERSONA_ID, contactId],
        )
      }
      const band = bandFor(affinity)
      return {
        ok: true as const,
        contactId,
        signalId,
        duplicate: false,
        signalType: derived.signalType,
        polarity: derived.polarity,
        baseDelta: derived.baseDelta,
        appliedDelta,
        ruleVersion: derived.ruleVersion,
        affinity,
        band: band.band,
        manualOverride,
        windowDelta: Math.round((windowBefore + appliedDelta) * 100) / 100,
      }
    })
  }

  /**
   * 读某人的 Affect 有效值（P3-B-2）。**只读**：按各维 updated_at 冷却到 now，不写回。
   * Affect 与好感、Trust 是三种刻度：这里只回答「当下对这个人是什么感受」。
   * @throws E_VALIDATION（contactId 空 / now 非法）、E_NOT_FOUND（Contact 不存在）
   */
  async loadContactAffect(
    contactId?: string,
    options: { now?: string } = {},
  ): Promise<{ contactId: string; values: ContactAffectValues; updatedAt: string }> {
    const id = requireText(contactId, 'contactId', 120)
    const contact = this.#row<{ contact_id: string }>(
      `SELECT contact_id FROM contacts WHERE contact_id = ? AND persona_id = ?`,
      [id, PERSONA_ID],
    )
    if (!contact) throw new PsycheError(CODE.notFound, `找不到 Contact：${id}`)
    const at = cleanText(options.now, 40) || nowIso()
    if (!Number.isFinite(Date.parse(at))) throw invalid('now 不是合法时间', { now: at })
    const rows = this.#rows<{ dimension: string; value: number; updated_at: string }>(
      `SELECT dimension, value, updated_at FROM contact_affect_state WHERE persona_id = ? AND contact_id = ?`,
      [PERSONA_ID, id],
    )
    const raw: Record<string, { value: number; updatedAt: string }> = {}
    for (const row of rows) raw[row.dimension] = { value: Number(row.value), updatedAt: row.updated_at }
    return { contactId: id, values: effectiveAffectValues(raw, at), updatedAt: at }
  }

  /**
   * 写一批 Affect 更新（P3-B-2）。**写库**，走 #write（opId 幂等 + 失败整笔回滚）。
   *
   * 每维先按状态行的 updated_at 冷却到 now，再加 delta、clamp 0–100，然后 UPSERT 状态并追加历史。
   * 校验：维度属于五维、同批不重复、|delta| ≤ 10、每条至少一条证据且证据存在。
   * 证据不要求属于该 Contact 的 source（与关系信号同一口径），但必须真实存在。
   * 历史表现由 Schema v20 的触发器保证不可改不可删。
   * @throws E_VALIDATION（维度/增量/证据非法）、E_NOT_FOUND（Contact 不存在）
   */
  async recordContactAffect(input: ContactAffectInput = {}): Promise<WriteResult<ContactAffectPayload>> {
    return this.#write('psyche_contact_affect', input, ({ opId }) => {
      const contactId = requireText(input.contactId, 'contactId', 120)
      const contact = this.#row<{ contact_id: string }>(
        `SELECT contact_id FROM contacts WHERE contact_id = ? AND persona_id = ?`,
        [contactId, PERSONA_ID],
      )
      if (!contact) throw new PsycheError(CODE.notFound, `找不到 Contact：${contactId}`)
      const at = cleanText(input.now, 40) || nowIso()
      if (!Number.isFinite(Date.parse(at))) throw invalid('now 不是合法时间', { now: at })
      const updates = input.updates
      if (!Array.isArray(updates) || updates.length === 0) throw invalid('至少提交一条 Affect 更新')
      if (updates.length > 5) throw invalid('一次最多更新五个维度')
      const seen = new Set<string>()
      const prepared: Array<{ dimension: AffectDimensionKey; delta: number }> = []
      for (const update of updates) {
        const dimension = cleanText(update?.dimension, 40)
        if (!affectDimensionOf(dimension)) throw invalid(`未知的 Affect 维度：${dimension}`)
        if (seen.has(dimension)) throw invalid(`同一维度不能重复提交：${dimension}`)
        seen.add(dimension)
        const delta = Number(update?.delta)
        if (!Number.isFinite(delta)) throw invalid(`Affect delta 必须是有限数：${dimension}`)
        if (Math.abs(delta) > AFFECT_PER_SIGNAL_CAP) {
          throw invalid(`单维单次变化不能超过 ±${AFFECT_PER_SIGNAL_CAP}：${dimension}`, { delta })
        }
        const refs = normaliseRelationshipEvidence(update?.evidenceRefs)
        if (refs.length === 0) throw invalid(`Affect 更新至少需要一条证据：${dimension}`)
        for (const ref of refs) {
          const hit = this.#row(
            `SELECT 1 AS hit FROM sources WHERE source_id = ?
             UNION ALL SELECT 1 AS hit FROM events WHERE event_id = ? LIMIT 1`,
            [ref, ref],
          )
          if (!hit) throw invalid(`Affect 证据不存在：${ref}`, { evidenceRefs: refs })
        }
        prepared.push({ dimension: dimension as AffectDimensionKey, delta })
      }

      const rows = this.#rows<{ dimension: string; value: number; updated_at: string }>(
        `SELECT dimension, value, updated_at FROM contact_affect_state WHERE persona_id = ? AND contact_id = ?`,
        [PERSONA_ID, contactId],
      )
      const raw: Record<string, { value: number; updatedAt: string }> = {}
      for (const row of rows) raw[row.dimension] = { value: Number(row.value), updatedAt: row.updated_at }
      // 先冷却到 now 再加增量：否则旧值会被重复累加，Cooling 变成「越久越高」
      const before = effectiveAffectValues(raw, at)
      const values: ContactAffectValues = { ...before }
      const applied: ContactAffectPayload['applied'] = []
      for (const item of prepared) {
        const prior = before[item.dimension]
        const next = clampAffectValue(prior + item.delta)
        values[item.dimension] = next
        applied.push({ dimension: item.dimension, before: prior, delta: item.delta, after: next })
        this.db.run(
          `INSERT INTO contact_affect_state (persona_id, contact_id, dimension, value, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(persona_id, contact_id, dimension) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [PERSONA_ID, contactId, item.dimension, next, at],
        )
        this.db.run(
          `INSERT INTO contact_affect_history (persona_id, contact_id, dimension, value, at, op_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [PERSONA_ID, contactId, item.dimension, next, at, opId],
        )
      }
      return {
        ok: true as const,
        contactId,
        applied,
        values,
        ruleVersion: AFFECT_RULE_VERSION,
        replayed: false,
        updatedAt: at,
      }
    })
  }

  /**
   * 复核某人的 Trust（P3-B-2）。**写库**，走 #write；只有 owner 能调用，模型自报无效。
   *
   * 顺序：Contact → decidedBy 只接受 owner → 证据 ≥2 条独立 Source → 当前值差 ≤ ±20
   * → 写新 revision（首次则新建 relationship Artifact）。撤回/非 active 的历史不当作有效 Trust，
   * 再次评估会新建一条 Artifact，而不是复活旧结论。
   * @throws E_VALIDATION（权限/数值/证据/变化量非法）、E_NOT_FOUND（Contact 不存在）
   */
  async reviewContactTrust(input: ContactTrustReviewInput = {}): Promise<WriteResult<ContactTrustReviewPayload>> {
    return this.#write('psyche_contact_trust', input, ({ opId }) => {
      const contactId = requireText(input.contactId, 'contactId', 120)
      const contact = this.#row<{ contact_id: string }>(
        `SELECT contact_id FROM contacts WHERE contact_id = ? AND persona_id = ?`,
        [contactId, PERSONA_ID],
      )
      if (!contact) throw new PsycheError(CODE.notFound, `找不到 Contact：${contactId}`)
      if (input.decidedBy !== 'owner') {
        throw invalid('Trust 只能由 owner 复核；persona 或模型自报不生效')
      }
      const value = Number(input.proposedValue)
      if (!Number.isFinite(value) || value < 0 || value > 100) throw invalid('Trust 值必须是 0–100 的有限数')
      const refs = normaliseRelationshipEvidence(input.evidenceRefs)
      if (refs.length < MIN_TRUST_EVIDENCE) throw invalid(`Trust 至少需要 ${MIN_TRUST_EVIDENCE} 条独立证据`)
      const sourceRows: SourceRow[] = []
      for (const ref of refs) {
        const row = this.#row<SourceRow>(`SELECT * FROM sources WHERE source_id = ?`, [ref])
        if (!row) throw invalid(`Trust 证据必须是已存在的 Source：${ref}`)
        if (row.sender_contact_id && row.sender_contact_id !== contactId) {
          throw invalid(`Trust 证据不属于该联系人：${ref}`)
        }
        sourceRows.push(row)
      }
      const independent = new Set(sourceRows.map((row) => row.activity_window_key || `source:${row.source_id}`))
      if (independent.size < MIN_TRUST_EVIDENCE) {
        throw invalid(`Trust 需要 ${MIN_TRUST_EVIDENCE} 条独立证据（不同活动窗口），当前只有 ${independent.size} 条`)
      }
      const at = cleanText(input.now, 40) || nowIso()
      if (!Number.isFinite(Date.parse(at))) throw invalid('now 不是合法时间', { now: at })

      const head = this.#row<{
        artifact_id: string
        revision: number
        state: ArtifactState
        payload: string
        confidence: string
      }>(
        `SELECT r.artifact_id, r.revision, r.state, r.payload, r.confidence
           FROM artifacts a
           JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
          WHERE a.kind = 'relationship'
            AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
            AND json_valid(r.payload) = 1
            AND json_extract(r.payload, '$.type') = 'contact_trust_assessment'
            AND json_valid(r.subject_refs) = 1
            AND EXISTS (SELECT 1 FROM json_each(r.subject_refs) WHERE value = ?)
          ORDER BY r.updated_at DESC, r.revision DESC LIMIT 1`,
        [contactId],
      )
      const previous =
        head && head.state === 'active' && isContactTrustPayload(parseJson(head.payload, {}))
          ? { value: Number(parseJson<{ value?: number }>(head.payload, {}).value ?? 0) }
          : null
      if (previous && Math.abs(value - previous.value) > MAX_TRUST_DELTA) {
        throw invalid(`Trust 单次变化不能超过 ±${MAX_TRUST_DELTA}（当前 ${previous.value}，请求 ${value}）`)
      }
      const band = trustBandOf(clampTrustValue(value))
      const payload: ContactTrustReviewPayload = {
        ok: true as const,
        contactId,
        artifactId: head?.artifact_id ?? '',
        revision: (head?.revision ?? 0) + 1,
        value: clampTrustValue(value),
        band,
        previous: previous ? { value: previous.value, band: trustBandOf(previous.value) } : null,
        decidedBy: 'owner',
        ruleVersion: TRUST_RULE_VERSION,
        replayed: false,
      }
      const trustPayload = {
        type: 'contact_trust_assessment' as const,
        value: payload.value,
        band,
        basis: { evidenceRefs: refs, ruleVersion: TRUST_RULE_VERSION, decidedBy: 'owner' as const },
      }
      const statement = `对联系人 ${contactId} 的信任评估：${band}（${payload.value}/100）`
      const evidence = this.#evidenceFromSources(sourceRows, 'supports', 'high')
      if (head && head.state === 'active') {
        const inserted = this.#insertRevision({
          artifactId: head.artifact_id,
          kind: 'relationship',
          revision: payload.revision,
          state: 'active',
          statement,
          subjectRefs: [contactId],
          payload: trustPayload,
          confidence: 'high',
          evidence,
          triggerEvents: [],
          opId,
        })
        payload.artifactId = inserted.artifactId
        payload.revision = inserted.revision
      } else {
        const created = this.#createArtifact({
          kind: 'relationship',
          statement,
          evidence,
          triggerEvents: [],
          subjectRefs: [contactId],
          payload: trustPayload,
          confidence: 'high',
          state: 'active',
          opId,
        })
        payload.artifactId = created.artifactId
        payload.revision = created.revision
      }
      return payload
    })
  }

  /**
   * 签发一条披露授权凭据：把「原本受限的敏感内容」提升为 public 的一次性凭证。
   *
   * 这是宿主侧可信流程的入口（用户在界面上明确批准某条内容可以公开），
   * 不是模型可自填的普通参数——模型伪造 grantId 没有用，因为凭据必须先在库里存在。
   *
   * 参数：artifactId（指向已有结论的当前 head）或 statement（准备新建的内容），二选一；
   * grantedBy 是人类可读的授权人标识；ttlMs 可选有效期；reason 可选说明。
   * 返回：grantId 与 contentHash，调用方把 grantId 传给 remember/revise 的 disclosureGrant。
   * 边界：一次授权只能消费一次；绑定 content_hash，给了 artifactId 时再绑 artifact+revision；
   * 不改变任何 revision 的披露等级——等级仍由写入时显式落库，授权只证明「这一次可以」。
   * @throws E_VALIDATION（artifactId 不存在 / revision 与 head 不符 / statement 为空）
   */
  async grantDisclosure(input: GrantDisclosureInput = {}): Promise<GrantDisclosurePayload & { ok: true }> {
    return this.db.transaction(() => {
      const artifactId = cleanText(input.artifactId ?? input.artifact_id, 120) || null
      const grantedBy = requireText(input.grantedBy ?? input.granted_by, 'grantedBy', 120)
      const reason = cleanText(input.reason, 500) || null
      const opId = cleanText(input.opId, 120) || null
      let statement: string
      let revision: number | null = null
      let before: Disclosure = 'restricted'
      if (artifactId) {
        const head = this.#head(artifactId)
        if (input.revision !== undefined && input.revision !== null && input.revision !== head.revision) {
          throw invalid(`授权对象不是当前 head（当前 r${head.revision}，请求 r${input.revision}）`)
        }
        statement = head.statement
        revision = head.revision
        before = normaliseDisclosure(head.disclosure)
      } else {
        statement = requireText(input.statement, 'statement', 8000)
        // 无 artifactId 时授权的是「即将写入的这一段内容」；before 一律按 restricted 记，
        // 避免出现 before=after=public 的「没有变化」授权行。
        before = 'restricted'
      }
      const contentHash = hashText(statement)
      // E5.5-E1：签发本身也要幂等——同一个 opId 重放必须拿到同一张 grant，
      // 不能每次重试都多签一张（否则调用方手里的旧凭据会和新凭据并存）。
      if (opId) {
        const existing = this.#row<{
          grant_id: string
          artifact_id: string | null
          revision: number | null
          content_hash: string
          before_disclosure: string
          after_disclosure: string
          expires_at: string | null
        }>(
          `SELECT grant_id, artifact_id, revision, content_hash, before_disclosure, after_disclosure, expires_at
             FROM disclosure_grants
            WHERE op_id = ? AND persona_id = ?`,
          [opId, PERSONA_ID],
        )
        if (existing) {
          if (
            existing.content_hash !== contentHash ||
            (existing.artifact_id ?? null) !== artifactId ||
            (existing.revision ?? null) !== revision ||
            existing.after_disclosure !== 'public'
          ) {
            throw new PsycheError(CODE.idempotent, `opId ${opId} 已经用于另一笔披露授权`)
          }
          return {
            ok: true as const,
            replayed: true,
            grantId: existing.grant_id,
            contentHash: existing.content_hash,
            artifactId: existing.artifact_id,
            revision: existing.revision,
            beforeDisclosure: normaliseDisclosure(existing.before_disclosure),
            afterDisclosure: normaliseDisclosure(existing.after_disclosure),
            expiresAt: existing.expires_at,
          }
        }
      }
      const now = nowIso()
      const ttl =
        typeof input.ttlMs === 'number' && Number.isFinite(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : null
      const expiresAt = ttl === null ? null : new Date(Date.now() + ttl).toISOString()
      const grantId = newId(PREFIX.grant)
      this.db.run(
        `INSERT INTO disclosure_grants
           (grant_id, persona_id, artifact_id, revision, content_hash, op_id, granted_by,
            reason, before_disclosure, after_disclosure, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          grantId,
          PERSONA_ID,
          artifactId,
          revision,
          contentHash,
          opId,
          grantedBy,
          reason,
          before,
          'public',
          now,
          expiresAt,
        ],
      )
      return {
        ok: true as const,
        replayed: false,
        grantId,
        contentHash,
        artifactId,
        revision,
        beforeDisclosure: before,
        afterDisclosure: 'public' as const,
        expiresAt,
      }
    })
  }

  /**
   * 撤销一张尚未消费的授权（宿主侧操作）。
   * 撤销不是删除：grant 行是审计事实，删掉就说不清「这条公开当年是谁批的」。
   * 已消费的授权不能撤销——已经公开的 revision 由它自己的披露等级和后续 revision 控制。
   */
  async revokeDisclosureGrant(
    input: RevokeDisclosureGrantInput = {},
  ): Promise<RevokeDisclosureGrantPayload & { ok: true }> {
    return this.db.transaction(() => {
      const grantId = requireText(input.grantId ?? input.grant_id, 'grantId', 120)
      const revokedBy = cleanText(input.revokedBy ?? input.revoked_by, 120) || null
      const row = this.#row<{ grant_id: string; used_at: string | null; revoked_at: string | null }>(
        `SELECT grant_id, used_at, revoked_at FROM disclosure_grants WHERE grant_id = ?`,
        [grantId],
      )
      if (!row) throw new PsycheError(CODE.notFound, `没有这张披露授权：${grantId}`)
      if (row.used_at) {
        throw new PsycheError(CODE.state, '这张授权已经被消费，不能撤销；已公开的版本由它自己的披露等级控制')
      }
      if (row.revoked_at) {
        return { ok: true as const, grantId, revokedAt: row.revoked_at, alreadyRevoked: true }
      }
      const revokedAt = nowIso()
      const result = this.db.run(
        `UPDATE disclosure_grants SET revoked_at = ?, revoked_by = ?
          WHERE grant_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
        [revokedAt, revokedBy, grantId],
      )
      if (result.changes !== 1) {
        throw new PsycheError(CODE.state, '这张授权刚刚被消费或撤销，撤销没有生效')
      }
      return { ok: true as const, grantId, revokedAt, alreadyRevoked: false }
    })
  }

  /** 只读列出授权事实（宿主审计用）；不含任何正文。 */
  async listDisclosureGrants(input: ListDisclosureGrantsInput = {}): Promise<ListDisclosureGrantsPayload> {
    const artifactId = cleanText(input.artifactId ?? input.artifact_id, 120) || null
    const limit = Math.max(1, Math.min(200, Math.trunc(Number(input.limit) || 50)))
    const rows = this.#rows<{
      grant_id: string
      artifact_id: string | null
      revision: number | null
      content_hash: string
      granted_by: string
      before_disclosure: string
      after_disclosure: string
      created_at: string
      expires_at: string | null
      used_at: string | null
      revoked_at: string | null
    }>(
      `SELECT grant_id, artifact_id, revision, content_hash, granted_by,
              before_disclosure, after_disclosure, created_at, expires_at, used_at, revoked_at
         FROM disclosure_grants
        WHERE persona_id = ? AND (? IS NULL OR artifact_id = ?)
        ORDER BY created_at DESC, grant_id DESC
        LIMIT ?`,
      [PERSONA_ID, artifactId, artifactId, limit],
    )
    return {
      rows: rows.map((row) => ({
        grantId: row.grant_id,
        artifactId: row.artifact_id,
        revision: row.revision,
        contentHash: row.content_hash,
        grantedBy: row.granted_by,
        beforeDisclosure: normaliseDisclosure(row.before_disclosure),
        afterDisclosure: normaliseDisclosure(row.after_disclosure),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
        revokedAt: row.revoked_at,
      })),
    }
  }

  /**
   * 给当前 head 追加证据（「记住这条」按钮的唯一业务写入入口）。
   *
   * 边界（与 revise 分开，不让按钮成为绕开记忆治理的旁路）：
   * - 只追加证据，不改结论内容、披露、主体、状态；要改结论仍走 revise；
   * - 只能追加到当前 Contact 自己的 restricted 记忆（公开记忆的内容变更走 Grant / revise）；
   * - 来源必须存在、未被隔离；群来源不能作为私聊结论的证据；
   * - 走 #write：opId 幂等、换内容 E_IDEMPOTENT_CONFLICT、失败整笔回滚。
   * @throws E_NOT_FOUND（没有这条记忆）、E_STATE（状态不可追加）、
   *   E_VALIDATION（披露/归属/来源域不满足）、E_NO_SOURCE（来源缺失）、E_IDEMPOTENT_CONFLICT。
   */
  async appendEvidence(
    artifactId: string,
    input: AppendEvidenceInput = {},
    scope: { contactId?: string | null } = {},
  ): Promise<WriteResult<AppendEvidencePayload>> {
    const id = cleanText(artifactId, 120)
    if (!id) throw invalid('appendEvidence 需要 artifactId')
    return this.#write('psyche_append_evidence', { artifactId: id, ...input }, () => {
      const head = this.#row<{
        revision: number
        state: string
        subject_refs: string | null
        disclosure: string | null
        confidence: string
      }>(
        `SELECT revision, state, subject_refs, disclosure, confidence
           FROM artifact_revisions
          WHERE artifact_id = ?
          ORDER BY revision DESC
          LIMIT 1`,
        [id],
      )
      if (!head) throw new PsycheError(CODE.notFound, `没有这条记忆：${id}`)
      if (head.state !== 'active' && head.state !== 'challenged') {
        throw new PsycheError(CODE.state, `这条记忆当前状态是「${head.state}」，不能追加证据`)
      }
      // 只允许 restricted：公开记忆追加证据等于在公开内容上做未披露的变更，
      // 要走 Grant / revise 的显式流程。
      if (normaliseDisclosure(head.disclosure) !== 'restricted') {
        throw invalid('只能给 restricted 记忆追加证据：公开记忆的内容变更请走 Grant / revise')
      }
      const contactId = cleanText(scope.contactId, 120)
      // subject_refs 在库里是 JSON 数组文本；parseList 会按分隔符切字符串，
      // 对 `["ct_x"]` 这种文本会切出带引号括号的碎片，所以这里必须用 parseJson。
      const subjectRefs = parseJson<string[]>(head.subject_refs, [])
      if (!contactId || !Array.isArray(subjectRefs) || !subjectRefs.includes(contactId)) {
        throw invalid('只能给当前联系人自己的记忆追加证据')
      }
      // 共享结论（subject_refs 同时含多个 Contact）不通过按钮追加证据：
      // 「包含当前 Contact」不等于「这条结论只属于当前 Contact」，否则 A 的按钮
      // 会把 A 的证据写进一条同时属于 A/B 的结论，B 再去读就看到 A 的私人内容。
      const contactRefs = subjectRefs.filter((ref) => ref.startsWith('ct_'))
      if (contactRefs.length !== 1 || contactRefs[0] !== contactId) {
        throw invalid('共享归属的结论不能通过按钮追加证据：请走 revise 的显式流程')
      }
      const rows = this.#loadSources(input.sourceIds ?? input.source_ids)
      const quarantined = quarantinedIds(
        this.db,
        rows.map((row) => row.source_id),
      )
      if (quarantined.length > 0) {
        throw invalid(`这些来源已被隔离，不能作为证据：${quarantined.join(', ')}`)
      }
      // 群来源不能当私聊结论的证据：否则「群成员身份」会反向污染私聊记忆。
      for (const row of rows) {
        if (row.channel === 'group') {
          throw invalid('群来源不能作为私聊结论的证据：请用当前会话的来源')
        }
      }
      // 每条 Source 还必须属于当前 Contact 的私有来源域：只查「存在、未隔离、
      // 非群来源」不够——Contact A 的结论 + Contact B 的私人 Source 会把 B 的
      // 内容追加进 A 的记忆。sender_contact_id 为空（unknown/无绑定）同样拒绝。
      for (const row of rows) {
        if (row.sender_contact_id !== contactId) {
          throw invalid('这些来源不属于当前联系人，不能作为这条结论的证据')
        }
      }
      const relation = normaliseEnum(
        input.relation ?? 'supports',
        ['supports', 'qualifies', 'contradicts', 'contextualizes'] as const,
        'relation',
        'supports',
      )
      const confidence = normaliseEnum(
        input.confidence ?? head.confidence,
        ['low', 'medium', 'high'] as const,
        'confidence',
        'medium',
      )
      const evidence = this.#evidenceFromSources(rows, relation, confidence)
      const now = nowIso()
      let added = 0
      for (const item of evidence) {
        const result = this.db.run(
          `INSERT OR IGNORE INTO artifact_evidence
             (artifact_id, revision, source_id, relation, quote, confidence, independence_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            head.revision,
            item.sourceId,
            item.relation,
            item.quote ?? null,
            item.confidence,
            item.independenceKey,
            now,
          ],
        )
        if (result.changes > 0) added += 1
      }
      // v13：basis_count / independent_evidence_count 是派生统计，证据变化时刷新；
      // 内容列由触发器继续保护（见 schema 的 trg_artifact_revisions_no_update）。
      const totals = this.#row<{ basis: number; indep: number }>(
        `SELECT COUNT(*) AS basis, COUNT(DISTINCT independence_key) AS indep
           FROM artifact_evidence
          WHERE artifact_id = ? AND revision = ?`,
        [id, head.revision],
      )
      const basisCount = Number(totals?.basis ?? 0)
      const independentEvidenceCount = Number(totals?.indep ?? 0)
      this.db.run(
        `UPDATE artifact_revisions
            SET basis_count = ?, independent_evidence_count = ?, updated_at = ?
          WHERE artifact_id = ? AND revision = ?`,
        [basisCount, independentEvidenceCount, now, id, head.revision],
      )
      this.db.run(`UPDATE artifacts SET updated_at = ? WHERE artifact_id = ?`, [now, id])
      return {
        artifactId: id,
        revision: head.revision,
        added,
        basisCount,
        independentEvidenceCount,
      }
    })
  }

  /**
   * 记一件事：先落一条 interaction 事件，再按门槛决定要不要升成结论。
   * **写库**，走 #write（重要写入 → FULL synchronous）。可能抛：
   * E_VALIDATION（text/statement 缺失、kind=stance、kind 给了却没 statement）、
   * E_NO_SOURCE（兜底来源也写不进去）、E_IDEMPOTENT_CONFLICT（同 opId 不同入参）。
   */
  async remember(input: RememberInput = {}): Promise<WriteResult<RememberPayload>> {
    const result = await this.#write('psyche_remember', input, ({ opId }) => {
      // 没给事件类型就按 conversation 记：默认「记了一句话」，而不是「记了一个动作」
      const eventType = normaliseEventType(input.eventType ?? input.event_type)
      // text 兜底取 statement：只给结论不给原话时，事件正文就用那句结论，避免空正文事件
      const text = requireText(input.text ?? input.statement, 'text', 500)
      const kind = input.kind ? normaliseKind(input.kind) : null
      // stance 不是「直接记下来的」：正式立场由 Core 从同类同向的 belief 合成，单条输入没有资格
      if (kind === 'stance') {
        throw invalid(
          '正式立场只能由 Core 从 belief 合成：请把这次的观点记成 kind=belief（同类同向的 belief 攒够了，Core 才会合成 stance）',
        )
      }
      const statement = cleanText(input.statement, 2000)
      // 给了 kind 就是「要沉淀成结论」，结论本身不能为空；只记事件时才允许没有 statement
      if (kind && !statement) throw invalid('给了 kind 就必须给 statement（要记的结论）')

      const subjectRefs = this.#subjectRefsOf(input)
      // 一行事件背后的证据：没给 sourceIds 时会兜底落一条 origin=self 的来源，保证事件有源可依
      const sourceRows = this.#sourcesForWrite(input, { fallbackText: text })
      // D1-7：P1 只观测不拦截。质量评估 + 准入判定落成一行观测，供后续校准阈值；
      // 真正按 decision 拒写是 P2 的事，这里绝不影响本次写入的结果。
      const quality = assessQuality(text, { kind: kind ?? undefined })
      const admission = decideAdmission({ quality, text, kind: kind ?? undefined })
      this.#insertAdmissionObservation({
        opId,
        sourceId: sourceRows[0] ? String(sourceRows[0].sourceId) : null,
        quality,
        admission,
      })
      // 事件**先写**：结论必须由事件触发，否则结论会变成没有时间线来源的孤儿
      const eventId = this.#insertEvent({
        kind: 'interaction',
        type: eventType,
        text,
        at: input.at ?? nowIso(),
        sessionRef: input.sessionRef ?? 'psyche:tool',
        roomId: input.roomId ?? null,
        subjectRefs,
        sourceRows,
        confidence: input.confidence ?? 'medium',
        causedBy: input.causedBy ?? null,
        relationTo: input.relationTo ?? null,
        opId,
      })

      let artifact: (RevisionResult & { kind: ArtifactKind }) | null = null
      let promotion: PromotionResult | null = null
      // E5.3：披露等级是分类结果，public 是「请求」而不是「授权」。
      // 内容被判定敏感时，显式 public 必须附带宿主侧签发的一次性 grant；没有就降回 restricted。
      const requestedDisclosure = normaliseDisclosure(input.disclosure)
      const disclosureText = statement || text
      const needsGrant =
        requiresDisclosureGrant(requestedDisclosure, disclosureText) ||
        // 显式带了凭据、又要 public：说明这一步走的是授权链，必须真的核销，
        // 否则「授权后再修订」会被记成普通显式公开，下一次修订又静默继承。
        (requestedDisclosure === 'public' && input.disclosureGrant !== undefined)
      const granted = needsGrant
        ? this.#consumeDisclosureGrant(input.disclosureGrant, {
            contentHash: hashText(disclosureText),
          })
        : false
      const grantRequired = needsGrant && !granted
      const effectiveDisclosure: Disclosure = grantRequired ? 'restricted' : requestedDisclosure
      // public 的来源：靠凭据提升的记 grant（不随修订继承），其余按默认策略
      const effectiveDisclosureSource: DisclosureSource = granted ? 'grant' : 'default'
      if (kind) {
        const confidence = normaliseEnum(
          input.confidence,
          ['low', 'medium', 'high'] as const,
          'confidence',
          'medium',
        )
        const evidence = this.#evidenceFromSources(sourceRows, 'supports', confidence)
        // 门槛（附录 A.5）：fact 1 条；belief/relationship/procedure 独立≥2；
        // impression 独立≥3 且 high；stance 独立≥2 且 sessions≥2——不够就只记事件，不硬造结论
        const gate = checkPromotion(kind, evidence, confidence, sourceRows)
        if (gate.ok) {
          artifact = this.#createArtifact({
            kind,
            statement,
            evidence,
            triggerEvents: [eventId],
            subjectRefs,
            payload: input.payload ?? {},
            confidence: input.confidence ?? 'medium',
            salience: input.salience ?? 0,
            temporal: input.temporal ?? { validFrom: input.at ?? nowIso() },
            directExtraction: input.directExtraction === true,
            // 未指定就是 restricted；敏感内容即使请求 public，没有授权也落 restricted
            disclosure: effectiveDisclosure,
            disclosureSource: effectiveDisclosureSource,
            opId,
          })
        } else {
          // 没够门槛也要把 gate 结果回给调用方：要让人知道「差什么」，而不是静默吞掉
          promotion = { ...gate, kind }
        }
      }

      return {
        eventId,
        eventType,
        sourceIds: sourceRows.map((row) => row.source_id),
        artifactId: artifact?.artifactId ?? null,
        revision: artifact?.revision ?? null,
        state: artifact?.state ?? null,
        artifactKind: artifact?.kind ?? null,
        independentEvidenceCount: artifact?.independentEvidenceCount ?? null,
        // promotion 非空 = 这次只落了事件、没升结论，透出原因（missing/threshold 之类）
        promotion,
        disclosure: effectiveDisclosure,
        grantRequired,
      }
    })
    // 写后局部重算立场：belief 攒够了才合成；失败只 warn，不影响这次记住
    this.#reconcileStancesOf(result.artifactId)
    return result
  }

  /**
   * 撞上一个反证：带了 targetId 记成 cognitive/contradiction_detected（推翻某条结论），
   * 否则记成一次人际冲突。**写库**，走 #write 但 important=false——冲突晚了还能再说一次，
   * 不值得为它争一次 FULL synchronous。可能抛：
   * E_NO_SOURCE（没引用真实来源）、E_SELF_PROOF（认知事件全是模型自述）、E_NOT_FOUND（targetId 不存在）。
   */
  async clash(input: ClashInput = {}): Promise<WriteResult<ClashPayload>> {
    const result = await this.#write<ClashPayload>(
      'psyche_clash',
      input,
      ({ opId }) => {
        const targetId = cleanText(input.targetId ?? input.target_id, 120)
        // 先取 head 确认目标真实存在：取不到就该让它抛 E_NOT_FOUND，而不是把矛盾记到空气上
        const target = targetId ? this.#head(targetId) : null
        // 有目标才是「认知事件」（新证据和旧结论打架）；没目标只是一次分歧，不必动结论
        const kind: EventKind = target ? 'cognitive' : 'interaction'
        const type: EventType = target ? 'contradiction_detected' : 'conflict'
        const text =
          cleanText(input.text ?? input.statement, 500) ||
          (target ? `对 ${targetId} 出现不能同时成立的反证` : '出现一次分歧')

        // 这里用 #loadSources 而不是 #sourcesForWrite：冲突**必须**引用真实来源，不落 self 兜底
        const sourceRows = this.#loadSources(input.sourceIds ?? input.source_ids)
        if (sourceRows.length === 0) {
          throw new PsycheError(
            CODE.noSource,
            'clash 必须引用真实来源（sourceIds）：撞上的是外部反驳或新证据，不能凭空断言',
          )
        }
        // 认知事件要能指向「外部的谁为什么反驳」；全是模型自述的话，等于自己证明自己错了
        const nonSelf = sourceRows.filter((row) => row.origin !== 'self')
        if (kind === 'cognitive' && nonSelf.length === 0) {
          throw new PsycheError(
            CODE.selfProof,
            'cognitive 事件至少要有一条非自身产生的 Source：不能用模型自己的话证明模型自己错了',
          )
        }

        // causedBy 指回目标**最后一条**触发事件：时间线上能倒推出「这条结论是被哪一步引出、又被谁推翻」
        let causedBy: string | null = null
        if (target) {
          const triggers = this.#triggerEventsOf(target.artifact_id, target.revision)
          causedBy = triggers.length > 0 ? triggers[triggers.length - 1]! : null
        }
        const eventId = this.#insertEvent({
          kind,
          type,
          text,
          at: input.at ?? nowIso(),
          sessionRef: input.sessionRef ?? 'psyche:tool',
          subjectRefs: this.#subjectRefsOf(input),
          sourceRows,
          confidence: input.confidence ?? 'medium',
          causedBy,
          relationTo: causedBy ? 'respondsTo' : null,
          opId,
        })

        return {
          eventId,
          kind,
          type,
          targetArtifactId: target ? target.artifact_id : null,
          targetRevision: target ? target.revision : null,
          sourceIds: sourceRows.map((row) => row.source_id),
          // 非自身来源条数单独透出：调用方据此判断这次反驳到底有多硬
          nonSelfSourceCount: nonSelf.length,
          causedBy,
        }
      },
      // 冲突不必等落盘：写慢了还能再说一次，不值得为它争一次 full synchronous
      { important: false },
    )
    // 写后登记张力：只报不裁决，失败不影响这次写入
    if (result.targetArtifactId) this.#syncTensionsOf(result.targetArtifactId)
    // 撞上反证也可能改变 belief 的活跃性：立场跟着重算
    this.#reconcileStancesOf(result.targetArtifactId)
    // 写后登记决策回执：记「这次为什么改判」，同样只报不裁决
    this.#recordDecision({
      kind: 'clash',
      opId: result.opId,
      items: [
        ...(result.targetArtifactId
          ? [
              {
                refType: 'artifact' as const,
                refId: result.targetArtifactId,
                refRevision: result.targetRevision,
                role: 'input' as const,
              },
            ]
          : []),
        { refType: 'event' as const, refId: result.eventId, role: 'input' as const },
        ...result.sourceIds.map((sourceId) => ({
          refType: 'source' as const,
          refId: sourceId,
          role: 'input' as const,
        })),
      ],
      resultArtifactId: result.targetArtifactId,
      resultRevision: result.targetRevision,
    })
    return result
  }

  /**
   * 改一条已有的结论，两种模式：
   * - 同 id（带 artifactId）：head.revision+1 追加新 revision，旧版本原样保留（只追加、不改写）；
   * - 新 id（带 supersedes）：为新命题另起一个 Artifact，用 supersedes 关系指回旧的。
   * **写库**，走 #write（重要写入 → FULL synchronous）。可能抛：
   * E_VALIDATION（statement 空 / refs 空 / state 不合法 / kind=stance）、
   * E_NOT_FOUND（artifactId 或 supersedes 指向的 Artifact/Event 不存在）。
   */
  async revise(input: ReviseInput = {}): Promise<WriteResult<RevisePayload>> {
    const result = await this.#write('psyche_revise', input, ({ opId }) => {
      // statement 是「改完之后那句话」，必填：改口不能只说「我改主意了」却不说改成什么
      const statement = requireText(input.statement, 'statement', 2000)
      // refs 指回**被改的那一句**（事件 id / 主题引用），不是转录原文 id——要的是坐标，不是全文
      const refs = parseList(input.refs)
      if (refs.length === 0) {
        throw invalid('revise 必须带 refs：指回被改的那一句（事件 id 或主题引用），不是转录原文 id')
      }
      const evidence: EvidenceDraft[] = []
      const triggerEvents: string[] = []
      // ref 命中事件时把该事件的来源一并作为 contextualizes 证据带进来：改口要有据可查
      for (const ref of refs) {
        const event = this.#row<{ event_id: string }>(`SELECT event_id FROM events WHERE event_id = ?`, [ref])
        if (event) {
          triggerEvents.push(event.event_id)
          const rows = this.#rows<SourceRow>(
            `SELECT s.* FROM sources s JOIN event_sources es ON es.source_id = s.source_id WHERE es.event_id = ?`,
            [event.event_id],
          )
          evidence.push(...this.#evidenceFromSources(rows, 'contextualizes', 'medium'))
        }
      }
      // 调用方额外给的来源按 supports 算新证据：新说法也要有自己的依据，不能只吃旧证据
      const extraSources = this.#loadSources(input.sourceIds ?? input.source_ids)
      evidence.push(
        ...this.#evidenceFromSources(
          extraSources,
          'supports',
          normaliseEnum(input.confidence, ['low', 'medium', 'high'] as const, 'confidence', 'medium'),
        ),
      )

      // 模式一：同 id 追加 revision（revision 只增不减，旧版本永远能回查）
      if (input.artifactId ?? input.artifact_id) {
        const artifactId = String(input.artifactId ?? input.artifact_id).trim()
        const head = this.#head(artifactId)
        // 正式立场的正文只能由 Core 的 StanceEngine 写（同 id 是第二条入口）：
        // 只封 remember/supersedes 的话，模型仍能借 revise 直接改立场，绕过 belief 合成。
        if (head.kind === 'stance') {
          throw invalid(
            '正式立场的正文只能由 Core 合成/修订，不能经 revise 直接改：想改立场，请改它背后的 belief（Core 会重新合成 stance）',
          )
        }
        // 乐观并发检查：调用方给了 expectedRevision 就必须与事务内读到的 head 一致。
        // 不给则保持旧行为（不强制），因为模型并不知道当前版本号——但它至少可以选择带上。
        if (input.expectedRevision !== undefined && input.expectedRevision !== head.revision) {
          throw new PsycheError(
            CODE.revisionConflict,
            `${artifactId} 当前是 r${head.revision}，不是你以为的 r${input.expectedRevision}；` +
              '另一个写入者先改过了，请重新读取后再改',
          )
        }
        // 休眠态（遗忘 / 撤回 / 被取代 / 废弃）不是普通修订：那等于「复活」一条已经不用的结论，
        // 必须显式 restore:true 并带上新的 refs（refs 在函数开头已强制），否则就是无痕改写历史。
        const dormant =
          head.state === 'forgotten' ||
          head.state === 'retracted' ||
          head.state === 'superseded' ||
          head.state === 'deprecated'
        if (dormant && input.restore !== true) {
          throw new PsycheError(
            CODE.state,
            `这条结论当前是 ${head.state}，不能直接改写；要恢复请显式传 restore:true，并说明新的依据`,
          )
        }
        const revision = head.revision + 1
        // state 可用入参覆盖，但必须落在该 kind 允许的状态集合里（例如 fact 没有 challenged）；
        // 显式恢复时由 Core 定状态：procedure 回 testing，其余回 active。
        const state = dormant
          ? normaliseEnum(head.kind === 'procedure' ? 'testing' : 'active', KIND_STATES[head.kind], 'state')
          : input.state
            ? normaliseEnum(input.state, KIND_STATES[head.kind], 'state')
            : head.state
        // 旧证据必须带上：改口不该丢掉原来的依据，否则独立证据数会凭空缩水
        const carried = this.#evidenceOf(artifactId, head.revision)
        const merged = dedupeEvidence([...carried, ...evidence])
        // E5.3：修订也可能把披露提到 public；敏感内容同样需要宿主侧授权。
        // grant 绑定 artifact + 当前 head.revision + 新 statement 的内容 hash，
        // 改内容不等于沿用原授权，必须重新申请。
        // E5.5-E1：一次公开授权不能变成对未来内容的持续授权。
        // 未显式指定披露时，head 是 public 且新内容敏感 → 回到 restricted，需要为这一版重新申请授权。
        const inheritedDisclosure = normaliseDisclosure(head.disclosure)
        // 一次性授权不随修订继承：head 的 public 来自 grant 时，未显式指定披露就回到 restricted
        const inheritedFromGrant =
          inheritedDisclosure === 'public' && head.disclosure_source === 'grant'
        const requestedDisclosure = input.disclosure
          ? normaliseDisclosure(input.disclosure)
          : inheritedDisclosure === 'public' &&
              (inheritedFromGrant || requiresDisclosureGrant('public', statement))
            ? 'restricted'
            : inheritedDisclosure
        // 敏感内容要授权；从 grant 链上来的 public 再次公开也要授权（不能默认沿用）
        const needsGrant =
          requiresDisclosureGrant(requestedDisclosure, statement) ||
          (inheritedFromGrant && requestedDisclosure === 'public') ||
          (requestedDisclosure === 'public' && input.disclosureGrant !== undefined)
        const granted = needsGrant
          ? this.#consumeDisclosureGrant(input.disclosureGrant, {
              contentHash: hashText(statement),
              artifactId,
              revision: head.revision,
            })
          : false
        const grantRequired = needsGrant && !granted
        const effectiveDisclosure: Disclosure = grantRequired ? 'restricted' : requestedDisclosure
        const effectiveDisclosureSource: DisclosureSource = granted
          ? 'grant'
          : input.disclosure
            ? 'explicit'
            : 'default'
        const result = this.#insertRevision({
          artifactId,
          kind: head.kind,
          revision,
          state,
          statement,
          subjectRefs: input.subjectRefs ?? parseJson<string[]>(head.subject_refs, []),
          payload: input.payload ?? parseJson<Record<string, unknown>>(head.payload, {}),
          confidence: input.confidence ?? head.confidence,
          evidence: merged,
          // 触发事件累积（旧的全留）+ 本次 refs 命中的事件
          triggerEvents: [...this.#triggerEventsOf(artifactId, head.revision), ...triggerEvents],
          // lineage 追加 revisedFrom：能回答「第几版改了哪一版」，而不是只有一个最新态
          lineage: [
            ...this.#lineageOf(artifactId, head.revision),
            {
              fromArtifactId: artifactId,
              fromRevision: head.revision,
              relation: 'revisedFrom',
            },
          ],
          relations: this.#relationsOf(artifactId, head.revision),
          salience: input.salience ?? head.salience,
          temporal: input.temporal ?? parseJson<Record<string, unknown>>(head.temporal, {}),
          directExtraction: head.direct_extraction === 1,
          // 披露属于 revision：修订不传就沿用当前 head，收紧或放宽都必须显式设置；
          // 敏感内容请求 public 但授权不足时强制落 restricted；来源一并记下（grant 链不继承）
          disclosure: effectiveDisclosure,
          disclosureSource: effectiveDisclosureSource,
          opId,
        })
        // previousRevision 也回给调用方：让人能确认「我这次改的是第几版」，而不是只看最新态
        const payload: ReviseSameId = {
          mode: 'same-id',
          artifactId: result.artifactId,
          revision: result.revision,
          previousRevision: head.revision,
          previousState: head.state,
          state: result.state,
          basisCount: result.basisCount,
          independentEvidenceCount: result.independentEvidenceCount,
          refs,
          disclosure: effectiveDisclosure,
          grantRequired,
        }
        return payload
      }

      // 模式二：新命题取代旧对象。既没 artifactId 也没 supersedes，就不知道该改哪一句
      const supersedesRaw = cleanText(input.supersedes, 120)
      if (!supersedesRaw) {
        throw invalid('revise 需要 artifactId（同 id 改）或 supersedes（新命题取代旧的 Artifact / Event）')
      }

      // 同一个 id 先按 Artifact 查、查不到再按 Event 查：两种被改对象共用一个参数名
      const supersededArtifact = this.#row<{ artifact_id: string; kind: ArtifactKind }>(
        `SELECT * FROM artifacts WHERE artifact_id = ?`,
        [supersedesRaw],
      )
      const supersededEvent = supersededArtifact
        ? null
        : this.#row<{ event_id: string }>(`SELECT * FROM events WHERE event_id = ?`, [supersedesRaw])
      // 两边都没有就该报 E_NOT_FOUND：静默新建会让「取代」变成无头悬案
      if (!supersededArtifact && !supersededEvent) {
        throw new PsycheError(CODE.notFound, `supersedes 指向的 Artifact/Event 不存在：${supersedesRaw}`)
      }

      // 取代的是一个事件时，把它的来源也拉进来当 supports 证据：新命题也要站得住
      if (supersededEvent) {
        triggerEvents.push(supersededEvent.event_id)
        const rows = this.#rows<SourceRow>(
          `SELECT s.* FROM sources s JOIN event_sources es ON es.source_id = s.source_id WHERE es.event_id = ?`,
          [supersededEvent.event_id],
        )
        evidence.push(
          ...this.#evidenceFromSources(
            rows,
            'supports',
            normaliseEnum(input.confidence, ['low', 'medium', 'high'] as const, 'confidence', 'medium'),
          ),
        )
      }

      // kind 缺省沿用被取代者的 kind：多半是同一类判断的修订，换类通常该显式说明
      const kind: ArtifactKind = input.kind
        ? normaliseKind(input.kind)
        : supersededArtifact
          ? supersededArtifact.kind
          : 'belief'
      // 立场仍然不能经 revise 新建，只能回来改它背后的 belief
      if (kind === 'stance') {
        throw invalid(
          '正式立场只能由 Core 合成，不能经 revise 新建：想改立场，请改它背后的 belief（Core 会重新合成 stance）',
        )
      }
      const oldHead = supersededArtifact ? this.#head(supersededArtifact.artifact_id) : null
      // E5.3：新命题取代旧对象时，披露默认继承；敏感内容请求 public 仍需宿主侧授权。
      // E5.5-E1：新命题取代旧对象时同理——旧对象的 public 不会自动授权新内容的公开；
      // 未显式指定披露且新内容敏感时回到 restricted。
      const inheritedDisclosure = normaliseDisclosure(oldHead?.disclosure ?? 'restricted')
      // new-id 同样不让 grant 链无限延伸：旧对象 public 来自凭据时，未显式指定就回 restricted
      const inheritedFromGrant =
        inheritedDisclosure === 'public' && oldHead?.disclosure_source === 'grant'
      const requestedDisclosure = input.disclosure
        ? normaliseDisclosure(input.disclosure)
        : inheritedDisclosure === 'public' &&
            (inheritedFromGrant || requiresDisclosureGrant('public', statement))
          ? 'restricted'
          : inheritedDisclosure
      const needsGrant =
        requiresDisclosureGrant(requestedDisclosure, statement) ||
        (inheritedFromGrant && requestedDisclosure === 'public') ||
        (requestedDisclosure === 'public' && input.disclosureGrant !== undefined)
      const granted = needsGrant
        ? this.#consumeDisclosureGrant(input.disclosureGrant, { contentHash: hashText(statement) })
        : false
      const grantRequired = needsGrant && !granted
      const effectiveDisclosure: Disclosure = grantRequired ? 'restricted' : requestedDisclosure
      const effectiveDisclosureSource: DisclosureSource = granted
        ? 'grant'
        : input.disclosure
          ? 'explicit'
          : 'default'
      const created = this.#createArtifact({
        kind,
        statement,
        evidence: dedupeEvidence(
          oldHead ? [...this.#evidenceOf(oldHead.artifact_id, oldHead.revision), ...evidence] : evidence,
        ),
        triggerEvents: [...triggerEvents],
        lineage: oldHead
          ? [{ fromArtifactId: oldHead.artifact_id, fromRevision: oldHead.revision, relation: 'derivedFrom' }]
          : [],
        relations: oldHead
          ? [
              {
                targetArtifactId: oldHead.artifact_id,
                targetRevision: oldHead.revision,
                relation: 'supersedes',
              },
            ]
          : [],
        subjectRefs: input.subjectRefs ?? (oldHead ? parseJson<string[]>(oldHead.subject_refs, []) : []),
        payload: input.payload ?? {},
        confidence: input.confidence ?? oldHead?.confidence ?? 'medium',
        salience: input.salience ?? oldHead?.salience ?? 0,
        temporal: input.temporal ?? {},
        directExtraction: false,
        state: input.state ? normaliseEnum(input.state, KIND_STATES[kind], 'state') : undefined,
        // 新命题取代旧对象：不传就继承被取代者的披露等级；不因为换了句话就自动放宽；
        // 敏感内容请求 public 但授权不足时强制落 restricted；来源一并记下（grant 链不继承）
        disclosure: effectiveDisclosure,
        disclosureSource: effectiveDisclosureSource,
        opId,
      })

      const payload: ReviseNewId = {
        mode: 'new-id',
        artifactId: created.artifactId,
        revision: created.revision,
        kind,
        state: created.state,
        supersedes: supersededArtifact ? supersededArtifact.artifact_id : null,
        supersedesEvent: supersededEvent ? supersededEvent.event_id : null,
        basisCount: created.basisCount,
        independentEvidenceCount: created.independentEvidenceCount,
        refs,
        supersededRevision: null,
        disclosure: effectiveDisclosure,
        grantRequired,
      }
      // 旧命题随之置 superseded（§11.4 约定：supersedes 表示新命题取代旧命题，旧的随之置 superseded）。
      // 旧行不动，给旧 Artifact 追加一条状态 revision（head 变成 superseded，检索侧据此过滤）；
      // 已处于 superseded / forgotten 的旧对象不重复追加。
      let supersededRevision: number | null = null
      if (
        oldHead &&
        KIND_STATES[oldHead.kind].includes('superseded') &&
        oldHead.state !== 'superseded' &&
        oldHead.state !== 'forgotten'
      ) {
        const marked = this.#insertRevision({
          artifactId: oldHead.artifact_id,
          kind: oldHead.kind,
          revision: oldHead.revision + 1,
          state: 'superseded',
          statement: oldHead.statement,
          subjectRefs: parseJson<string[]>(oldHead.subject_refs, []),
          payload: parseJson<Record<string, unknown>>(oldHead.payload, {}),
          confidence: oldHead.confidence,
          evidence: this.#evidenceOf(oldHead.artifact_id, oldHead.revision),
          triggerEvents: this.#triggerEventsOf(oldHead.artifact_id, oldHead.revision),
          lineage: this.#lineageOf(oldHead.artifact_id, oldHead.revision),
          relations: this.#relationsOf(oldHead.artifact_id, oldHead.revision),
          salience: oldHead.salience,
          temporal: parseJson<Record<string, unknown>>(oldHead.temporal, {}),
          directExtraction: oldHead.direct_extraction === 1,
          // superseded 只是状态变化，披露等级与来源原样保留
          disclosure: normaliseDisclosure(oldHead.disclosure),
          disclosureSource: normaliseDisclosureSource(oldHead.disclosure_source),
          opId,
        })
        supersededRevision = marked.revision
      }
      return { ...payload, supersededRevision }
    })
    // 写后登记决策回执：改判有据可查，失败不影响主写
    const basis: DecisionItemInput[] = result.refs
      .filter((ref) => ref.startsWith('evt_'))
      .map((ref) => ({ refType: 'event' as const, refId: ref, role: 'input' as const }))
    if (result.mode === 'same-id') {
      basis.push({
        refType: 'artifact',
        refId: result.artifactId,
        refRevision: result.previousRevision,
        role: 'input',
      })
    }
    this.#recordDecision({
      kind: 'revise',
      opId: result.opId,
      items: basis,
      resultArtifactId: result.artifactId,
      resultRevision: result.revision,
    })
    // 立场修改后重算：belief 的正文/依据变了，可能触发 stance 新版本
    this.#reconcileStancesOf(result.artifactId)
    return result
  }

  /**
   * 复核一条结论，按 verdict 决定它是否还站得住，并追加新 revision（旧版不动）。
   * 复核本身必须是一条 cognitive/review_result 事件，且证据不能全来自自身。
   * **写库**，走 #write（重要写入 → FULL synchronous）。可能抛：
   * E_VALIDATION（verdict 不认识 / artifactId 空）、E_NOT_FOUND（artifactId 不存在）、
   * E_SELF_PROOF（来源全是 self，或根本找不到外部来源）。
   */
  async review(input: ReviewInput = {}): Promise<WriteResult<ReviewPayload>> {
    const result = await this.#write('psyche_review', input, ({ opId }) => {
      // verdict 没有默认值：复核必须明确表态，不能默默「看过了」就算数（normaliseVerdict 无兜底）
      const verdict = normaliseVerdict(input.verdict)
      const artifactId = requireText(input.artifactId ?? input.artifact_id, 'artifactId', 120)
      // 复核针对的是「当前这条结论」，所以取最新 revision，而不是调用方指定的某一版
      const head = this.#head(artifactId)
      const note = cleanText(input.note, 200)

      const sourceRows = this.#loadSources(input.sourceIds ?? input.source_ids)
      // 给了来源却全是模型自己的话 → 直接拒：自己的话不能当自己的证据（§5.2 约束 5）
      const nonSelf = sourceRows.filter((row) => row.origin !== 'self')
      if (nonSelf.length === 0 && sourceRows.length > 0) {
        throw new PsycheError(
          CODE.selfProof,
          'review 是 cognitive 事件，至少要有一条非自身产生的 Source（§5.2 约束 5）',
        )
      }
      if (sourceRows.length === 0) {
        // 完全没给来源时，回退到「这条结论当初的触发事件里有没有外部来源」——
        // 结论本来就是从某些事件长出来的，那些事件带的外部证据可以复用
        const triggers = this.#triggerEventsOf(artifactId, head.revision)
        const placeholders = triggers.map(() => '?').join(',')
        const fromEvents = triggers.length
          ? this.#rows<SourceRow>(
              `SELECT s.* FROM sources s JOIN event_sources es ON es.source_id = s.source_id
                WHERE es.event_id IN (${placeholders}) AND s.origin <> 'self'`,
              triggers,
            )
          : []
        if (fromEvents.length === 0) {
          throw new PsycheError(
            CODE.selfProof,
            'review 需要至少一条非自身来源：给 sourceIds，或让这条结论的触发事件本身来自用户/外部',
          )
        }
        // 补进 sourceRows：后面既用作事件来源，也用来生成这次复核的新证据
        sourceRows.push(...fromEvents)
      }

      // 立场的正文同样不能借 review 覆盖：review 可以判它「还站不站得住」（改状态），
      // 但不能换一句话把它偷换成新立场——那等于绕过 belief 合成。
      if (head.kind === 'stance' && cleanText(input.statement, 2000)) {
        throw invalid(
          '正式立场的正文不能经 review 改写：复核可以改状态，想改立场请改背后的 belief（Core 会重新合成 stance）',
        )
      }
      // 状态机收在 nextStateFor 里，这里只负责把算出来的结果落库（confirmed 会把 challenged 拉回 active）
      const next = nextStateFor(head.kind, head.state, verdict, input, head)
      const eventId = this.#insertEvent({
        kind: 'cognitive',
        type: 'review_result',
        // 正文写清 verdict 与版本号：时间线上能直接看出「第几版被判过什么」
        text: `review ${verdict}：${artifactId}@r${head.revision}${note ? ` — ${note}` : ''}`,
        sessionRef: input.sessionRef ?? 'psyche:tool',
        subjectRefs: [artifactId],
        sourceRows,
        confidence: input.confidence ?? 'medium',
        opId,
      })

      // 旧证据照搬 + 这次的新证据合并：复核是「在原有依据上再加一次判断」，不是推翻重来
      const carried = this.#evidenceOf(artifactId, head.revision)
      const added = this.#evidenceFromSources(
        sourceRows,
        // 判 challenged/rejected 时这批证据是反证，其余判决下是支持
        verdict === 'challenged' || verdict === 'rejected' ? 'contradicts' : 'supports',
        normaliseEnum(input.confidence, ['low', 'medium', 'high'] as const, 'confidence', 'medium'),
      )
      const revision = head.revision + 1
      const result = this.#insertRevision({
        artifactId,
        kind: head.kind,
        revision,
        state: next.state,
        statement: next.statement,
        subjectRefs: parseJson<string[]>(head.subject_refs, []),
        payload: parseJson<Record<string, unknown>>(head.payload, {}),
        confidence: next.confidence,
        evidence: dedupeEvidence([...carried, ...added]),
        // 把这次复核事件本身也追加进触发事件：让「谁在什么时候复核的」留在时间线上
        triggerEvents: [...this.#triggerEventsOf(artifactId, head.revision), eventId],
        lineage: this.#lineageOf(artifactId, head.revision),
        relations: this.#relationsOf(artifactId, head.revision),
        salience: head.salience,
        temporal: parseJson<Record<string, unknown>>(head.temporal, {}),
        directExtraction: head.direct_extraction === 1,
        // 复核不改披露等级：它只回答「还站不站得住」
        disclosure: normaliseDisclosure(head.disclosure),
        disclosureSource: normaliseDisclosureSource(head.disclosure_source),
        opId,
      })

      const payload: ReviewPayload = {
        artifactId,
        revision: result.revision,
        previousRevision: head.revision,
        previousState: head.state,
        state: result.state,
        verdict,
        eventId,
        note,
      }
      return payload
    })
    // 写后登记决策回执：复核为什么这样判，失败不影响主写
    this.#recordDecision({
      kind: 'review',
      opId: result.opId,
      items: [
        {
          refType: 'artifact',
          refId: result.artifactId,
          refRevision: result.previousRevision,
          role: 'input',
        },
        { refType: 'event', refId: result.eventId, role: 'input' },
      ],
      resultArtifactId: result.artifactId,
      resultRevision: result.revision,
    })
    // 复核改的是状态/正文：belief 的活跃性变了，立场要跟着重算
    this.#reconcileStancesOf(result.artifactId)
    return result
  }

  /**
   * 认知遗忘：把一条结论标成不再作为有效认知使用（fact→forgotten、其余→retracted、
   * procedure→deprecated）。只追加新 revision、不删任何历史证据；检索侧按 head.state 过滤，
   * 所以 rebuild 也不会把它复活。重复调用幂等（head 已是目标状态时直接返回）。
   * **写库**，走 #write（opId 幂等）。
   * @throws E_NOT_FOUND（artifactId 不存在）、E_VALIDATION（artifactId 空）
   */
  async forget(input: ForgetInput = {}): Promise<WriteResult<ForgetPayload>> {
    return this.#write('psyche_forget', input, ({ opId }) => {
      const artifactId = requireText(input.artifactId ?? input.artifact_id, 'artifactId', 120)
      const head = this.#head(artifactId)
      const target = forgottenStateFor(head.kind)
      if (head.state === target) {
        const payload: ForgetPayload = {
          artifactId,
          kind: head.kind,
          state: head.state,
          revision: head.revision,
          previousRevision: head.revision,
          previousState: head.state,
          alreadyForgotten: true,
        }
        return payload
      }
      // 状态变化也走新 revision：历史证据与旧状态都保留，审计能回答「什么时候被遗忘的」
      const inserted = this.#insertRevision({
        artifactId,
        kind: head.kind,
        revision: head.revision + 1,
        state: target,
        statement: head.statement,
        subjectRefs: parseJson<string[]>(head.subject_refs, []),
        payload: parseJson<Record<string, unknown>>(head.payload, {}),
        confidence: head.confidence,
        evidence: this.#evidenceOf(artifactId, head.revision),
        triggerEvents: this.#triggerEventsOf(artifactId, head.revision),
        lineage: this.#lineageOf(artifactId, head.revision),
        relations: this.#relationsOf(artifactId, head.revision),
        salience: head.salience,
        temporal: parseJson<Record<string, unknown>>(head.temporal, {}),
        directExtraction: head.direct_extraction === 1,
        // 遗忘不改披露等级：它只回答「还用不用」，不回答「能不能说」
        disclosure: normaliseDisclosure(head.disclosure),
        disclosureSource: normaliseDisclosureSource(head.disclosure_source),
        opId,
      })
      const payload: ForgetPayload = {
        artifactId,
        kind: head.kind,
        state: inserted.state,
        revision: inserted.revision,
        previousRevision: head.revision,
        previousState: head.state,
        alreadyForgotten: false,
      }
      return payload
    })
  }

  /**
   * 提一个自我设定改动建议。**写库**，走 #write（重要写入 → FULL synchronous），但只往 proposals
   * 表插一行 status='pending'——提案只是排队，等人批准才生效，提案 ≠ 修改。
   * 只能提 life 分区。可能抛：E_PARTITION（growth / relationship / safety 一律拒绝）、
   * E_VALIDATION（target / change 缺失或超长）。
   */
  async propose(input: ProposeInput = {}): Promise<WriteResult<ProposePayload>> {
    return this.#write('psyche_propose', input, ({ opId }) => {
      // growth 不在模型可用的分区集合里，但要用 E_PARTITION 明确拒绝（而不是笼统的「枚举不认识」）
      // 先小写化再比较：模型偶尔把分区名写成大写，这里不该因此报「未知分区」
      const rawPartition = cleanText(input.partition ?? input.part ?? '', 40).toLowerCase()
      if (rawPartition === 'growth') {
        throw new PsycheError(
          CODE.partition,
          '成长分区不接受模型提案：整合阶段由 Core 生成、由人类在观测台确认（v14 §22），模型只能提 life 分区',
        )
      }
      const partition = normalisePartition(rawPartition)
      // 关系分区属于「别人才能动」的部分：连提案都不写，避免提案队列里出现越权的无效项
      if (partition === 'relationship') {
        throw new PsycheError(
          CODE.partition,
          '关系参数只有用户本人能改（§12.1）：AI 不能提议，这条拒绝连提案都不写',
        )
      }
      // 安全参数是只读分区：不生效，也不接受提议
      if (partition === 'safety') {
        throw new PsycheError(CODE.partition, '安全参数是只读分区：不生效，也不接受提议')
      }
      // target = 改哪个参数/哪段设定，change = 改成什么：两个都必须有，否则提案无法审阅
      const target = requireText(input.target, 'target', 200)
      const change = requireText(input.change, 'change', 2000)
      // rationale 可空：有些改动理由一句话就够，不必强行凑
      const rationale = cleanText(input.rationale, 1000) || null
      // proposalId 现生成而不是靠自增：提案从诞生起就有稳定 id，批准/拒绝都靠它定位
      const proposalId = newId(PREFIX.proposal)
      const now = nowIso()
      // 只 INSERT 一行 pending，**不碰 persona_config**：真正生效要等人类在观测台确认
      this.db.run(
        `INSERT INTO proposals (proposal_id, persona_id, partition, target, change, rationale, status, created_at, decided_at, decided_by, op_id)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?)`,
        [proposalId, PERSONA_ID, partition, target, change, rationale, now, opId],
      )
      // 待批数量现查：不维护冗余计数，避免多处写入导致「显示的待批」和实际行数对不上
      const pending = Number(
        this.#row<{ n: number }>(`SELECT count(*) AS n FROM proposals WHERE status = 'pending'`)?.n ?? 0,
      )
      const payload: ProposePayload = {
        proposalId,
        partition,
        target,
        change,
        rationale,
        status: 'pending',
        // 回给界面：让人一眼看到「还有几条在等我批」
        pendingProposals: pending,
      }
      return payload
    })
  }

  // ── 只读 ────────────────────────────────────────────────────

  /**
   * 查当前立场（默认只取 stance）。**只读**，走 #read（会记一条 operations）。
   * 默认同时带 challenged：被挑战但还没被推翻的立场仍然要说出来，藏起来等于假装没被质疑过。
   * @throws E_VALIDATION（kind / state 枚举不认识）
   */
  async stances(query: StancesQuery = {}): Promise<ReadResult<StancesPayload>> {
    return this.#read('psyche_stances', query, () => {
      // 没指定类型就只看 stance；显式给 kind 时跨类型翻（belief / impression 也能这么查）
      const kinds: ArtifactKind[] = query.kind ? [normaliseKind(query.kind)] : ['stance']
      // 默认带 challenged：它只表示「被质疑」，不等于被推翻，不该从视野里消失
      const stateFilter = query.state ? parseList(query.state) : ['active', 'challenged']
      const limit = clampLimit(query.limit, 10, 50)
      const subject = cleanText(query.subject, 100)
      // 占位符按数组长度拼：kinds/state 是变长的，不能用固定条数写死
      const kindPlaceholders = kinds.map(() => '?').join(',')
      const statePlaceholders = stateFilter.map(() => '?').join(',')
      const params: (string | number)[] = [...kinds, ...stateFilter]
      // 只取每个 artifact 的**最新** revision（子查询 max）：历史版本不进「当前立场」列表
      let sql = `SELECT a.artifact_id, a.kind, r.revision, r.state, r.statement, r.subject_refs,
                        r.confidence, r.basis_count, r.independent_evidence_count, r.updated_at
                   FROM artifacts a
                   JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
                  WHERE a.kind IN (${kindPlaceholders})
                    AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
                    AND r.state IN (${statePlaceholders})
                    AND r.disclosure = 'public'`
      if (subject) {
        // subject_refs 是 JSON 数组文本，用 instr 子串匹配而不是等值：能匹配到数组里的单个元素
        sql += ` AND instr(r.subject_refs, ?) > 0`
        params.push(subject)
      }
      // 排序：独立证据多的优先，其次最近变动过的优先——「立得住的」和「还在长的」都靠前
      sql += ` ORDER BY r.independent_evidence_count DESC, r.updated_at DESC LIMIT ?`
      params.push(limit)
      const items: StanceItem[] = this.#rows<{
        artifact_id: string
        kind: ArtifactKind
        revision: number
        state: ArtifactState
        statement: string
        subject_refs: string | null
        confidence: Confidence
        basis_count: number
        independent_evidence_count: number
        updated_at: string
      }>(sql, params).map((row) => ({
        artifactId: row.artifact_id,
        kind: row.kind,
        revision: row.revision,
        state: row.state,
        statement: row.statement,
        subjectRefs: parseJson<string[]>(row.subject_refs, []),
        confidence: row.confidence,
        basisCount: row.basis_count,
        independentEvidenceCount: row.independent_evidence_count,
        updatedAt: row.updated_at,
      }))
      const payload: StancesPayload = {
        // scope 明确回「这次查的是哪类」：默认值不该让调用方去猜
        scope: query.kind ? kinds : ['stance'],
        // 没给 subject 就回 null，而不是空串
        subject: subject || null,
        // total 是**本次返回条数**（已按 limit 截断），不是库里总数——
        // 想要总数得单独 count，否则界面会把「前 10 条」误报成「一共 10 条」
        total: items.length,
        items,
      }
      return payload
    })
  }

  /**
   * 观测台用的整体状态：人格配置、自我认知、当前阶段、各表规模、存储健康度。
   * **只读**，走 #read。`audit:false` 供前端轮询——高频读取不记 operations，免得把表撑肿。
   */
  async getState(options: { audit?: boolean } = {}): Promise<ReadResult<StatePayload>> {
    return this.#read('psyche_state', {}, () => {
      // 三处单行配置各查一次：缺行时下面统一用默认值兜底，不在这里抛错
      const persona = this.#row<{
        persona_id: string
        type: string
        identity_path: string | null
        persona_json: string
      }>(`SELECT * FROM persona_config WHERE persona_id = ?`, [PERSONA_ID])
      const state = this.#row<{ self_view: string; revision: number; updated_at: string }>(
        `SELECT * FROM persona_state WHERE persona_id = ?`,
        [PERSONA_ID],
      )
      const phase = this.#row<{ phase: string; since: string; stalled_at: string | null }>(
        `SELECT * FROM phase_state WHERE persona_id = ?`,
        [PERSONA_ID],
      )
      // 各表规模现查：面板要的是「有多少」，不是每张表的明细
      const count = (table: string): number =>
        Number(this.#row<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0)
      // pending_writes 单独数：它表示「还没落盘的写入」，和表行数不是一回事
      const pendingWrites = Number(
        this.#row<{ n: number }>(`SELECT count(*) AS n FROM pending_writes WHERE status = 'pending'`)?.n ?? 0,
      )
      const payload: StatePayload = {
        persona: {
          id: persona?.persona_id ?? PERSONA_ID,
          type: persona?.type ?? 'preset',
          identityPath: persona?.identity_path ?? null,
          personaJson: parseJson(persona?.persona_json, {}),
        },
        self: {
          view: state?.self_view ?? '',
          revision: state?.revision ?? 1,
          updatedAt: state?.updated_at ?? null,
        },
        phase: {
          phase: phase?.phase ?? 'trust',
          since: phase?.since ?? null,
          stalledAt: phase?.stalled_at ?? null,
        },
        counts: {
          sources: count('sources'),
          events: count('events'),
          artifacts: count('artifacts'),
          revisions: count('artifact_revisions'),
          operations: count('operations'),
          proposals: count('proposals'),
          pendingWrites,
          activityWindows: count('session_activity_windows'),
        },
        // 存储健康度直接透 db.health()：文件大小、页数这类信息只有底层知道
        storage: this.db.health(),
        // dataDir 一起回：排查「数据到底存在哪」时不用再猜
        dataDir: this.dataDir,
      }
      return payload
    }, options)
  }

  /**
   * 成长状态（设计 v14 §21–§22）。
   *
   * 只读派生：按当前证据重算四道闸，**不写库**。
   * 阶段的推进发生在写入之后（`syncGrowth()`）或人确认整合时——面板刷新多少次都不会改变成长历史。
   */
  async getGrowth(options: { audit?: boolean } = {}): Promise<ReadResult<GrowthPayload>> {
    return this.#read('psyche_growth', {}, () => {
      // 纯派生：按当前证据重算四道闸，**不写库**——所以面板刷多少次都不会改变成长历史
      const { derived } = deriveGrowthNow(this.db)
      // 但「从哪天开始」是历史事实，只能从库里读，派生算不出来
      const phase = this.#row<{ phase: string; since: string | null }>(
        `SELECT phase, since FROM phase_state WHERE persona_id = ?`,
        [PERSONA_ID],
      )
      const payload: GrowthPayload = {
        stage: derived.stage,
        stageLabel: derived.stageLabel,
        since: phase?.since ?? null,
        elapsedDays: derived.elapsedDays,
        algorithmVersion: derived.algorithmVersion,
        // 闸门映射成对外形状：label/have/need/shortfall 都给，界面不用再自己拼阈值
        gates: (Object.values(derived.gates) as GateResult[]).map((gate) => ({
          gate: gate.gate,
          label: PHASE_LABELS[gate.gate],
          passed: gate.passed,
          have: gate.have,
          need: gate.need,
          shortfall: gate.shortfall,
        })),
        bottleneck: derived.bottleneck,
        bottleneckReason: derived.bottleneckReason,
        counts: derived.counts,
        // 读路径恒为空：推进只发生在写完认知之后或启动自检里（见 syncGrowth）
        advanced: [],
      }
      return payload
    }, options)
  }

  /**
   * 把「已经满足的闸」落成里程碑（写操作之后调用，或启动时补一次）。
   *
   * 与 `getGrowth()` 的分工：这里会写库，所以它只出现在写完认知之后和启动自检里，
   * 不在读路径上。幂等：阶段已经推过去之后再调，不会再写第二个里程碑。
   */
  async syncGrowth(): Promise<{ advanced: GrowthPayload['advanced'] }> {
    // 真正的推进入口在 growth.ts 的 advancePhase（校验前三道闸 + 写 milestone），这里只做字段映射
    const { advanced } = advancePhase(this.db, { logger: this.logger })
    return {
      // 返回本次新增的里程碑：调用方据此提示「刚刚进到下一阶段」，没推进就是空数组
      advanced: advanced.map((item) => ({
        gate: item.gate,
        fromPhase: item.fromPhase,
        fromPhaseLabel: PHASE_LABELS[item.fromPhase],
        toPhase: item.toPhase,
        milestoneId: item.milestoneId,
      })),
    }
  }

  /**
   * Core 内部：为整合阶段建一条 growth 提案（模型工具走不到这里）。
   * **写库**，但不走 #write：它由 Core 在写入之后自己调用，不需要 opId 幂等语义。
   * @returns alreadyConfirmed=true 表示这批证据对应的阶段早就确认过，本次没有新建提案。
   */
  async createGrowthProposal(input: { statement?: string; rationale?: string } = {}): Promise<{
    proposalId: string
    phase: Gate
    alreadyConfirmed: boolean
  }> {
    // 具体落库逻辑在 growth.ts：这里只做转发，保持 Core 的公开面简洁
    return insertGrowthProposal(this.db, { statement: input.statement, rationale: input.rationale })
  }

  /**
   * 人类入口：确认或驳回一条 growth 提案；确认仍要前三道闸全过（不是「人点了就一定过」）。
   * **写库**：applyGrowthDecision 会写 proposals.decided_* 并（接受时）落里程碑。
   * @throws E_VALIDATION proposalId 缺失；E_NOT_FOUND 提案不存在。
   */
  async confirmGrowthProposal(input: {
    proposalId: string
    accept: boolean
    actor?: string
  }): Promise<{ proposalId: string; status: 'accepted' | 'rejected'; phase: Gate; milestoneId: string | null }> {
    const proposalId = requireText(input.proposalId, 'proposalId', 120)
    // accept 用 === true 收严：传字符串 "true"/1 之类不该被当成同意
    return applyGrowthDecision(this.db, { proposalId, accept: input.accept === true, actor: input.actor })
  }

  /**
   * 证据撤回：只打 redacted_at，里程碑与阶段都不动（审计链保留）。
   * **写库**，但属于「标记」而非「删除」：原始行还在，只是不再作为证据展示。
   * @returns redacted = 本次被标记的里程碑证据条数。
   */
  async redactMilestone(milestoneId: string): Promise<{ milestoneId: string; redacted: number }> {
    const id = requireText(milestoneId, 'milestoneId', 120)
    // 删除会让「当时凭什么晋级」变成无据可查，所以只标记不删行
    return markEvidenceRedacted(this.db, { milestoneId: id })
  }

  /**
   * 模型视角的上下文（§10 / v14 §22）：只给「此刻的她」需要的最小信息。
   *
   * 刻意不给：闸门计数、距下一阶段还差几条、salience 原值、阈值、质量分。
   * 那些是观测台给人看的，进了模型上下文就会变成「表演成长」。
   */
  async context(): Promise<ReadResult<ContextPayload>> {
    return this.#read('psyche_context', {}, () => {
      const { derived } = deriveGrowthNow(this.db)
      const state = this.#row<{ self_view: string }>(`SELECT self_view FROM persona_state WHERE persona_id = ?`, [
        PERSONA_ID,
      ])
      const beliefs = this.#rows<{ artifact_id: string; kind: ArtifactKind; statement: string }>(
        `SELECT a.artifact_id, a.kind, r.statement
           FROM artifacts a
           JOIN artifact_revisions r
             ON r.artifact_id = a.artifact_id
            AND r.revision = (SELECT MAX(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
          WHERE a.kind = 'belief' AND r.state IN ('active', 'challenged')
          ORDER BY a.updated_at DESC
          LIMIT 5`,
      ).map((row) => ({ artifactId: row.artifact_id, kind: row.kind, statement: row.statement }))
      const changes = this.#rows<{ type: string; text: string; at: string }>(
        `SELECT type, text, at FROM events
          WHERE persona_id = ? AND kind = 'cognitive'
          ORDER BY at DESC, rowid DESC
          LIMIT 3`,
        [PERSONA_ID],
      ).map((row) => ({ type: row.type, statement: cleanText(row.text, 120), at: row.at }))
      // 批准过的自我调整：只取最近 3 条，且每条截到 80 字——这段是「她该照做的一句话」，不是日志
      const approvals = recentApprovedAdjustments(this.db, 3).map((item) => ({
        target: cleanText(item.target, 40),
        change: cleanText(item.change, 80),
        at: item.decidedAt,
      }))
      const payload: ContextPayload = {
        persona: { id: PERSONA_ID, stage: derived.stage, stageLabel: derived.stageLabel },
        self: (state?.self_view ?? '').slice(0, 400),
        beliefs,
        recentCognitiveChanges: changes,
        recentApprovals: approvals,
        note: '细节用 psyche_recall / psyche_stances / psyche_fetch 取；这里只给当前阶段、几条已经立住的判断和最近的变化。',
      }
      return payload
    })
  }

  /**
   * 查「我」和某个人的关系。**只读**，走 #read（记一条 operations）。
   * 对外只给好感**档位**（band/bandLabel），数值留在 internalValue 里仅供调试——§6.2：好感不公开、不报分。
   * @throws E_VALIDATION（contactId 空）、E_NOT_FOUND（查无此人）。
   */
  /**
   * 关系投影快照（同步、只读）：给 Context / 预注入层拼一行所需的数据。
   *
   * 与 getRelationship 的差异：不写 operations、不返回证据与计数；信任仍只认
   * payload.type 判别 + subject_refs JSON 精确匹配。找不到 Contact 抛 E_NOT_FOUND，
   * 读取失败由调用方决定「不注入」，而不是注入一份「中立」。
   */
  readRelationshipBrief(
    contactId: string,
    options: { now?: string | number | Date } = {},
  ): RelationshipBrief {
    const id = requireText(contactId, 'contactId', 120)
    const contact = this.#row<{ contact_id: string }>(`SELECT contact_id FROM contacts WHERE contact_id = ?`, [id])
    if (!contact) throw new PsycheError(CODE.notFound, `找不到 Contact：${id}`)
    const projection = this.#row<{ affinity: number }>(
      `SELECT affinity FROM relationship_affinity_state WHERE persona_id = ? AND contact_id = ?`,
      [PERSONA_ID, id],
    )
    const band = bandFor(Number(projection?.affinity ?? this.defaultAffinity))
    const trustHead = this.#row<{ payload: string }>(
      `SELECT r.payload
         FROM artifacts a
         JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
        WHERE a.kind = 'relationship'
          AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
          AND r.state = 'active'
          AND json_valid(r.payload) = 1
          AND json_extract(r.payload, '$.type') = 'contact_trust_assessment'
          AND json_valid(r.subject_refs) = 1
          AND EXISTS (SELECT 1 FROM json_each(r.subject_refs) WHERE value = ?)
        ORDER BY r.updated_at DESC, r.revision DESC LIMIT 1`,
      [id],
    )
    const trustPayload = trustHead ? parseJson<unknown>(trustHead.payload, null) : null
    const trustBand = trustHead && isContactTrustPayload(trustPayload) ? trustPayload.band : null
    const now = options.now ?? new Date().toISOString()
    const rows = this.#rows<{ dimension: string; value: number; updated_at: string }>(
      `SELECT dimension, value, updated_at FROM contact_affect_state WHERE persona_id = ? AND contact_id = ?`,
      [PERSONA_ID, id],
    )
    const raw: Record<string, { value: number; updatedAt: string }> = {}
    for (const row of rows) raw[row.dimension] = { value: Number(row.value), updatedAt: row.updated_at }
    const values = effectiveAffectValues(raw, now)
    return {
      affinityBand: band.band,
      trustBand,
      affect: AFFECT_KEYS.map((dimension) => ({ dimension, value: values[dimension] })),
    }
  }

  /** P4-B-4-2c：只读解析 (platform, stableUserId) 的 Contact；没有返回 null，不建号。 */
  findContactId(platform: string, stableUserId: string): string | null {
    const row = this.db.get<{ contact_id: string }>(
      `SELECT contact_id FROM contacts WHERE persona_id = ? AND platform = ? AND stable_user_id = ?`,
      [PERSONA_ID, platform, stableUserId],
    )
    return row?.contact_id ?? null
  }

  async getRelationship(contactId?: string): Promise<ReadResult<RelationshipPayload>> {
    return this.#read('psyche_relationship', { contactId }, () => {
      const id = requireText(contactId, 'contactId', 120)
      const contact = this.#row<{
        contact_id: string
        platform: string
        stable_user_id: string
        display_name: string | null
        relation_label: string | null
      }>(`SELECT * FROM contacts WHERE contact_id = ?`, [id])
      // 连人都查不到就抛 E_NOT_FOUND：不要把「不存在」伪装成「中立关系」
      if (!contact) throw new PsycheError(CODE.notFound, `找不到 Contact：${id}`)
      const projection = this.#row<{
        affinity: number
        manual_override: number
        updated_at: string
      }>(`SELECT * FROM relationship_affinity_state WHERE persona_id = ? AND contact_id = ?`, [PERSONA_ID, id])
      // 投影缺行时用配置的初值：新联系人的起点由 affinity.neutral 决定，不在这里写死
      const affinity = Number(projection?.affinity ?? this.defaultAffinity)
      const band = bandFor(affinity)
      // 信任取「最新一版、状态 active、payload.type 明确的 Trust 结论」：没有就是 null，而不是「信任 0」
      // subject_refs 必须用 JSON 成员精确匹配：instr 会把 ct_1 误配到 ct_10，也会把说明文字当成 subject。
      const trustHead = this.#row<{
        artifact_id: string
        revision: number
        state: ArtifactState
        statement: string
        payload: string
        updated_at: string
      }>(
        `SELECT r.artifact_id, r.revision, r.state, r.statement, r.payload, r.updated_at
           FROM artifacts a
           JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
          WHERE a.kind = 'relationship'
            AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
            AND r.state = 'active'
            AND json_valid(r.payload) = 1
            AND json_extract(r.payload, '$.type') = 'contact_trust_assessment'
            AND json_valid(r.subject_refs) = 1
            AND EXISTS (SELECT 1 FROM json_each(r.subject_refs) WHERE value = ?)
          ORDER BY r.updated_at DESC, r.revision DESC LIMIT 1`,
        [id],
      )
      const trustPayload = trustHead ? parseJson<unknown>(trustHead.payload, null) : null
      const trust =
        trustHead && isContactTrustPayload(trustPayload)
          ? {
              artifactId: trustHead.artifact_id,
              revision: trustHead.revision,
              state: trustHead.state,
              statement: trustHead.statement,
              value: trustPayload.value,
              band: trustPayload.band,
              updatedAt: trustHead.updated_at,
            }
          : null
      // 信号账本分两查：总数回答「这段关系累积了多少次互动」，最近 10 条回答「最近发生了什么」
      const signalCount = Number(
        this.#row<{ n: number }>(`SELECT count(*) AS n FROM relationship_signals WHERE contact_id = ?`, [id])?.n ??
          0,
      )
      const recentSignals = this.#rows<{
        signal_id: string
        signal_type: string
        polarity: string
        applied_delta: number
        confidence: string
        created_at: string
      }>(
        `SELECT signal_id, signal_type, polarity, applied_delta, confidence, created_at
           FROM relationship_signals WHERE contact_id = ? ORDER BY created_at DESC LIMIT 10`,
        [id],
      ).map((row) => ({
        signalId: row.signal_id,
        signalType: row.signal_type,
        polarity: row.polarity,
        appliedDelta: row.applied_delta,
        confidence: row.confidence,
        createdAt: row.created_at,
      }))
      // affect 与好感分开存：好感是长期档位，affect 是当下情绪（刻度不同，不能混算）
      const affect = this.#rows<{ dimension: string; value: number; updated_at: string }>(
        `SELECT dimension, value, updated_at FROM contact_affect_state WHERE persona_id = ? AND contact_id = ?`,
        [PERSONA_ID, id],
      ).map((row) => ({ dimension: row.dimension, value: row.value, updatedAt: row.updated_at }))
      const payload: RelationshipPayload = {
        contact: {
          contactId: contact.contact_id,
          platform: contact.platform,
          stableUserId: contact.stable_user_id,
          displayName: contact.display_name,
          relationLabel: contact.relation_label,
        },
        // §6.2 好感不公开、不报分：对外只给档位，数值仅内部调试可见
        affinity: {
          band: band.band,
          bandLabel: band.label,
          manualOverride: projection?.manual_override === 1,
          updatedAt: projection?.updated_at ?? null,
          internalValue: affinity,
        },
        trust,
        // 信号只回总数 + 最近几条：P1 不做账本翻页，所以 ledgerComplete 恒真
        signals: { total: signalCount, recent: recentSignals },
        affect,
        ledgerComplete: true,
      }
      return payload
    })
  }

  /**
   * 按线索找回旧事：结论 head + 支持证据数 + 非敏感关联事件摘要。**只读**，走 #read。
   *
   * R3：与自动注入共用 `recallMemory`（FTS5 + BM25，状态/披露/Scope/Subject 准入在 LIMIT 之前）；
   * 不再用 `instr` 子串，不再返回 Event 原文。Scope 只能由调用方从可信 RuntimeInput 或
   * Owner 授权上下文传入——Core 不解析来源，模型参数也进不到这里。
   * @throws E_VALIDATION（kind 枚举不认识）、E_QUERY_TOO_LONG / E_QUERY_TOO_COMPLEX
   */
  async recall(query: RecallQuery = {}, scope: RecallScope = {}): Promise<ReadResult<RecallPayload>> {
    let engine: RecallEngineResult | undefined
    const read = await this.#read('psyche_recall', query, () => {
      const text = cleanText(query.text ?? query.query, 200)
      const kind = query.kind ? normaliseKind(query.kind) : null
      const subject = cleanText(query.subject, 100)
      const limit = clampLimit(query.limit, 8, 20)
      const result = recallMemory(
        this.db,
        { ...(text ? { text } : {}), ...(kind ? { kind } : {}), ...(subject ? { subject } : {}), limit },
        scope,
      )
      engine = result
      // R4-A：对外只收敛成 RecallResult；rejected/searched 留在内核，不进模型可见结果。
      return {
        results: result.items,
        abstained: result.abstained,
        abstainReason: result.abstainReason,
        ...(result.abstained ? { guidance: RECALL_ABSTAIN_GUIDANCE } : {}),
      }
    })
    // R4-B：回执独立于返回值；回执写失败不影响这次召回（但不能静默成功，记 warn）。
    if (engine !== undefined) this.#recordRecallReceipt(engine, query, scope)
    return read
  }

  /**
   * R4-B：把这次召回写成一条回执（run + 候选行）。
   *
   * 三条边界：
   * - 回执不是第二事实源：只记录「这次召回发生了什么」，不参与任何判定；
   * - 不存查询原文，只存本地密钥 HMAC（密钥文件不在普通备份里）；
   * - 回执写失败不影响召回结果，但要留 warn——静默失败会让「可解释的召回链」变成假象。
   *
   * 为什么 rawRank 与 finalRank 分开：检索原始序与准入后最终序是两次排序，
   * 只留一个就回答不了「这条高相关记忆为什么被拒」。
   */
  #recordRecallReceipt(result: RecallEngineResult, query: RecallQuery, scope: RecallScope): void {
    if (!this.dataDir) return
    try {
      this.#recallKey ??= loadOrCreateRecallKey(this.dataDir)
      const key = this.#recallKey
      const text = cleanText(query.text ?? query.query, 200)
      const limit = clampLimit(query.limit, 8, 20)
      const scopeType = recallScopeTypeOf(scope)
      const runId = randomUUID()
      createRecallRun(this.db, {
        runId,
        requestId: null,
        personaId: PERSONA_ID,
        queryHash: text ? hashQueryText(key.key, text) : null,
        queryMode: 'recall',
        scopeType,
        scopeHash: hashRecallScope(key.key, {
          scopeType,
          contactId: scope.contactId ?? null,
          roomId: scope.roomId ?? null,
        }),
        requestedLimit: limit,
        matchedCount: result.searched,
        eligibleCount: result.items.length,
        returnedCount: result.items.length,
        abstained: result.abstained,
        compositionStatus: 'not_applicable',
        keyVersion: key.keyVersion,
        createdAt: nowIso(),
      })
      recordRecallCandidates(
        this.db,
        runId,
        result.candidates.map((candidate) => ({
          artifactId: candidate.artifactId,
          revision: candidate.revision,
          rawRank: candidate.rawRank,
          eligible: candidate.eligible,
          rejectReason: candidate.rejectReason,
          finalRank: candidate.finalRank,
        })),
      )
    } catch (error) {
      this.logger?.warn?.(
        `[psyche] 召回回执未写入：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * 按 id 取原文（Source / Event / Artifact 最新版），在预算内尽量多取。**只读**，走 #read。
   * 找不到的 id 不抛错，而是以 `type:'missing'` 占位——批量取里个别 id 失效不该让整批失败。
   * @throws E_VALIDATION（ids 为空）
   */
  async fetch(ids?: string | string[], budget?: number): Promise<ReadResult<FetchPayload>> {
    // ids 两种形状都收：模型工具传逗号串，内部调用直接传数组
    const list = parseList(ids)
    return this.#read('psyche_fetch', { ids: list, budget }, () => {
      if (list.length === 0) throw invalid('fetch 需要 ids（Source / Event / Artifact id，逗号分隔）')
      // 预算夹在 200..8000，默认 2000：太小取不到东西，太大一次把上下文塞爆
      const remaining = Math.max(200, Math.min(Number(budget) || 2000, 8000))
      const items: FetchItem[] = []
      let used = 0
      let truncated = false
      for (const id of list) {
        // 预算用尽就停，并标记 truncated：让调用方知道「还有没取到的」，而不是以为取全了
        if (used >= remaining) {
          truncated = true
          break
        }
        // 依次按三种 id 试：sources → events → artifacts head（前缀不同，但顺序试最省事）
        const source = this.#row<SourceRow>(`SELECT * FROM sources WHERE source_id = ?`, [id])
        let item: Exclude<FetchItem, { type: 'missing' }> | null = null
        if (source) {
          item = {
            id,
            type: 'source',
            origin: source.origin,
            kind: source.kind,
            at: source.captured_at,
            text: source.text || '',
            platform: source.platform,
          }
        } else if (id.includes('@')) {
          // D1-4 第 4 条：art_xxx@2 精确取历史版本（head 只能取最新版，旧版本必须可回读）。
          // 用 lastIndexOf 而不是 split：id 本身不含 @，但传错格式时也要给出明确的 missing 而不是猜。
          const at = id.lastIndexOf('@')
          const rawId = id.slice(0, at)
          const revisionNo = Number(id.slice(at + 1))
          const row = this.#row<{
            kind: ArtifactKind
            revision: number
            state: ArtifactState
            statement: string
            updated_at: string
          }>(
            `SELECT a.kind, r.revision, r.state, r.statement, r.updated_at
               FROM artifacts a JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
              WHERE a.artifact_id = ? AND r.revision = ?
                AND r.disclosure = 'public'`,
            [rawId, Number.isFinite(revisionNo) ? revisionNo : -1],
          )
          if (row) {
            item = {
              id,
              type: 'artifact',
              kind: row.kind,
              revision: row.revision,
              state: row.state,
              at: row.updated_at,
              text: row.statement,
            }
          }
        } else {
          // 不是 source 就按事件查：事件正文是「当时说了什么」，比结论更接近原话
          const event = this.#row<{
            kind: EventKind
            type: EventType
            at: string
            text: string
          }>(`SELECT * FROM events WHERE event_id = ?`, [id])
          if (event) {
            item = {
              id,
              type: 'event',
              kind: event.kind,
              eventType: event.type,
              at: event.at,
              text: event.text,
            }
          } else {
            // 最后按 artifact head 查：取的是结论**最新版**原文，历史版本要用 revise 的 lineage 追
            const artifact = this.#row<{
              kind: ArtifactKind
              revision: number
              state: ArtifactState
              statement: string
              updated_at: string
            }>(
              `SELECT a.kind, r.revision, r.state, r.statement, r.updated_at
                 FROM artifacts a JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
                WHERE a.artifact_id = ?
                  AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
                  AND r.disclosure = 'public'`,
              [id],
            )
            if (artifact) {
              item = {
                id,
                type: 'artifact',
                kind: artifact.kind,
                revision: artifact.revision,
                state: artifact.state,
                at: artifact.updated_at,
                text: artifact.statement,
              }
            }
          }
        }
        // 三种 id 都不是就记一条 missing 占位并继续：部分缺失不该让整批 fetch 失败
        if (!item) {
          items.push({ id, type: 'missing', error: '找不到这个 id' })
          continue
        }
        // 每条按剩余预算截断，并在末尾加省略号——被截的条目要让人一眼看出来
        const left = remaining - used
        if (item.text.length > left) {
          item.text = `${item.text.slice(0, left)}…`
          truncated = true
        }
        used += item.text.length
        items.push(item)
      }
      // budget 回传的是**实际生效**的预算（可能被夹到 200..8000），调用方据此判断是否还有余量
      const payload: FetchPayload = { items, budget: remaining, used, truncated }
      return payload
    })
  }
}

/**
 * 把调用方给的条数夹到 [1, max]。
 * 非法值（NaN / 0 / 负数 / 非数字）统一回落 fallback——「没给」和「给了个离谱值」都按默认处理。
 * @returns 不超过 max 的整数；value 不合法时返回 fallback。
 */
function clampLimit(value: unknown, fallback: number, max: number): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(Math.floor(number), max)
}

/**
 * 证据去重：按 `${sourceId}|${relation}` 作为唯一键，同一条来源对同一条结论只留一种关系。
 * @returns 保持首次出现顺序的新数组（不改入参）。
 */
function dedupeEvidence(evidence: EvidenceDraft[]): EvidenceDraft[] {
  const seen = new Map<string, EvidenceDraft>()
  for (const item of evidence) {
    // relation 也进 key：同一条来源既支持又反证是两种记录，不该被合并
    const key = `${item.sourceId}|${item.relation}`
    if (!seen.has(key)) seen.set(key, item)
  }
  return [...seen.values()]
}

/**
 * 附录 A.5 晋升门槛：单次事件不能定终身（§6.6）。
 * 独立性按 independenceKey 去重（同一活动窗口里的多句话只算一份），sessions 按 session_ref 数跨了几个会话。
 * @param evidence 本次写入产出的候选证据。
 * @param sourceRows 原始来源行，用来数「跨了几个会话」与补充 have 明细。
 * @returns { ok, need, have }：ok=false 时 need 说明差什么，have 是当前计数的完整明细。
 * 不抛错——门槛不足是正常结果，调用方据此「只记事件、先不升结论」。
 */
export function checkPromotion(
  kind: ArtifactKind,
  evidence: EvidenceDraft[],
  confidence: Confidence,
  sourceRows: SourceRow[] = [],
): PromotionResult {
  // 独立证据数按 independenceKey 去重：同一个活动窗口里连说三句只算一份
  const independent = new Set(evidence.map((item) => item.independenceKey)).size
  // 会话数：同一轮对话里反复说也只算一次「跨会话」
  const sessions = new Set(sourceRows.map((row) => row.session_ref).filter(Boolean)).size
  // have 原样回给调用方：失败时也能解释「现在有几条、差几条」
  const have = { evidence: evidence.length, independent, sessions, confidence }
  // need 是个小工厂：每次调用把 ok/need 补上同一份 have，避免各处重复拼对象
  const need = (label: string, ok: boolean): PromotionResult => ({ ok, need: label, have })
  switch (kind) {
    // fact 是「有据可查的一件事」，一条直接来源就够
    case 'fact':
      return need('至少 1 条直接来源', evidence.length >= 1)
    // belief 是观点：至少两个独立活动组，避免同一段对话里自言自语就升格
    case 'belief':
      return need('至少 2 条独立证据（独立活动组）', independent >= 2)
    // impression 比 belief 更主观，要求更高：三条独立证据且置信度 high
    case 'impression':
      return need('至少 3 条独立证据且 confidence=high', independent >= 3 && confidence === 'high')
    // stance 要「同类同向」跨会话反复出现：独立证据≥2 且至少 2 个会话
    case 'stance':
      return need('至少 2 次同类同向且至少 1 次跨会话', independent >= 2 && sessions >= 2)
    // relationship 是对某人的判断：也要两个独立活动组，不能一次互动就定型
    case 'relationship':
      return need('至少 2 个独立活动组', independent >= 2)
    // procedure 是「这么做能成」：两次成功执行才算稳
    case 'procedure':
      return need('至少 2 次成功执行', independent >= 2)
    // 未知类型一律不晋升：宁可只留事件，也不凭空造结论
    default:
      return need('未知类型', false)
  }
}

/**
 * 认知遗忘的目标状态：fact 记 forgotten；belief/impression/stance/relationship 记 retracted；
 * procedure 记 deprecated。三者不能混成一个「删除标记」——语义与检索过滤都不同。
 * @throws E_STATE（该 kind 没有任何可用的遗忘状态）
 */
export function forgottenStateFor(kind: ArtifactKind): ArtifactState {
  if (kind === 'fact') return 'forgotten'
  if (kind === 'procedure') return 'deprecated'
  if (KIND_STATES[kind].includes('retracted')) return 'retracted'
  if (KIND_STATES[kind].includes('forgotten')) return 'forgotten'
  throw new PsycheError(CODE.state, `${kind} 没有可用的遗忘状态`)
}

/**
 * 附录 A.3 状态机 + §9.1 review 五档，算出复核后的 (state, statement, confidence)。
 * confirmed：当前是 challenged 就拉回 active；refined：只换表述、状态不动；
 * revised → active；rejected → fact 记 forgotten、其余记 retracted。
 * procedure 走自己的状态机（draft → testing → active / deprecated）。
 * @param input.statement / input.confidence 可覆盖表述与置信度，缺省沿用 head（复核时不改口就沿用原句）。
 * @throws E_STATE（该 kind 没有 challenged 状态却给了 verdict=challenged）、E_VALIDATION（未知 verdict）。
 */
export function nextStateFor(
  kind: ArtifactKind,
  current: ArtifactState,
  verdict: Verdict,
  input: { statement?: string; confidence?: string },
  head: { statement: string; confidence: Confidence },
): { state: ArtifactState; statement: string; confidence: Confidence } {
  // 没给新表述就沿用旧句，置信度同理：复核可以只表态、不改字
  const statement = cleanText(input.statement, 2000) || head.statement
  const confidence = (input.confidence ?? head.confidence) as Confidence
  // procedure 不适用通用五档：要区分「还在验证（testing）」和「验证通过（active）」
  if (kind === 'procedure') {
    const map: Record<Verdict, ArtifactState> = {
      // draft 的第一次 confirmed 只能进 testing，不能直接 active
      confirmed: current === 'draft' ? 'testing' : 'active',
      refined: 'testing',
      challenged: 'testing',
      revised: 'testing',
      // 做法被否就直接 deprecated（不是 retracted：procedure 没有 retracted 状态）
      rejected: 'deprecated',
    }
    return { state: map[verdict], statement, confidence }
  }
  switch (verdict) {
    case 'confirmed':
      // 对 challenged 是「拉回」而不是新建：确认的正是这条被质疑过的结论
      return { state: current === 'challenged' ? 'active' : current, statement, confidence }
    case 'refined':
      // 只把话说得更准，不改变「它是否成立」——状态原样保留
      return { state: current, statement, confidence }
    case 'challenged':
      // 有的类型根本没有 challenged 状态（如 fact）；硬写会让 KIND_STATES 校验在写入时炸掉，
      // 所以在这里就明确报 E_STATE，并指引用 revised / rejected
      if (!KIND_STATES[kind].includes('challenged')) {
        throw new PsycheError(CODE.state, `${kind} 没有 challenged 状态；要否定这条请用 revised / rejected`)
      }
      return { state: 'challenged', statement, confidence }
    case 'revised':
      return { state: 'active', statement, confidence }
    case 'rejected':
      // fact 被推翻记 forgotten（不再当作事实），其余记 retracted（撤回但历史仍在）
      return { state: kind === 'fact' ? 'forgotten' : 'retracted', statement, confidence }
    default:
      throw invalid(`未知 verdict：${verdict}`)
  }
}

/**
 * 把一行 head 记录转成对外 JSON 形状：SQL 列名 snake_case → 对外 camelCase，
 * 并把 subject_refs / payload / temporal 这几个 TEXT 列解析成结构。
 * schemaVersion 原样透出，方便前端判断「我拿到的是哪一版数据结构」。
 * @returns 不含 SQL 列名的纯数据对象。
 */
export function selectHeadJson(row: ArtifactHeadRow): {
  id: string
  kind: ArtifactKind
  revision: number
  state: ArtifactState
  statement: string
  subjectRefs: string[]
  payload: unknown
  confidence: Confidence
  basisCount: number
  independentEvidenceCount: number
  salience: number
  temporal: unknown
  directExtraction: boolean
  updatedAt: string
  schemaVersion: string
} {
  return {
    id: row.artifact_id,
    kind: row.kind,
    revision: row.revision,
    state: row.state,
    statement: row.statement,
    // 几个 TEXT 列就地 parseJson：坏 JSON 回落默认值，不让一行坏数据炸掉整个读取
    subjectRefs: parseJson<string[]>(row.subject_refs, []),
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    confidence: row.confidence,
    basisCount: row.basis_count,
    independentEvidenceCount: row.independent_evidence_count,
    salience: row.salience,
    temporal: parseJson<Record<string, unknown>>(row.temporal, {}),
    // 库里存 0/1，对外转 boolean：调用方不该看见「半个布尔」
    directExtraction: row.direct_extraction === 1,
    updatedAt: row.updated_at,
    schemaVersion: row.schema_version,
  }
}
