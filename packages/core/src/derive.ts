/**
 * 成长计算层（设计文档 v14 §21–§22 的 P1 部分）。
 *
 * 职责：只回答「按当前证据，她走到哪一阶段了、下一道闸差什么」，不改任何数据。
 * 为什么纯函数：不碰数据库、不调模型，除 `now` 外不读外部状态；同输入必得同输出，方便断言与重算。
 * 被谁调用：`growth.ts`（deriveGrowthNow / advancePhase 取结论再写里程碑）、`store.ts`（标签与类型）。
 * 关键不变量：
 *   1. 只算不写——不为过闸补写 Event、更不因为「时间到了」放人过关；
 *   2. 可重建——`phase_milestones` 只是晋级时刻的快照，真相永远是这里算出来的；
 *   3. 独立键去重——过闸看「几个独立经历」而不是「几条记录」；阶段单调只升不回退。
 */

/** 一道闸的判定结果。`have / need` 是给观测台看的，不给模型看。 */
export interface GateResult {
  gate: Gate
  passed: boolean
  /** 已经数到的依据条数；`integration` 恒为 0 或 1（人工确认）。 */
  have: number
  /** 过闸需要的条数；`integration` 为 1。 */
  need: number
  /** 计入本闸的依据 id：信念 id / 事件 id / 修正对（`artifact#rev`）。 */
  evidenceIds: string[]
  /** 去重后的独立键，过闸看的是「几个独立经历」而不是「几条记录」。 */
  independenceKeys: string[]
  /** 差在哪里，一句话，中文，给人看。 */
  shortfall: string
}

/**
 * 四道闸的标识。字符串字面量直接进库（`phase_milestones.gate`），所以**不许改名**。
 */
export type Gate = 'trust' | 'autonomy' | 'initiative' | 'integration'

/**
 * 阶段与闸同一套名字：过哪道闸就是哪个阶段。
 * 这样 `earned` 计数可以直接当 `PHASE_ORDER` 的下标用，不必再维护一张映射表。
 */
export type Phase = Gate

/** 四阶段的顺序；单调只升，不回退。 */
export const PHASE_ORDER: readonly Phase[] = Object.freeze(['trust', 'autonomy', 'initiative', 'integration'])

/** 阶段的中文名，只给界面与提示词看；别拿它做判据（判据一律用英文 id）。 */
export const PHASE_LABELS: Readonly<Record<Phase, string>> = Object.freeze({
  trust: '信任',
  autonomy: '自主',
  initiative: '主动',
  integration: '整合',
})

/** 一道闸的及格线；阈值写在这里，别散落在各处。 */
export const GATE_THRESHOLDS = Object.freeze({
  /** 信任：至少一条「成熟信念」（active + 两个以上独立来源的 supports 证据）。 */
  trust: 1,
  /** 自主：两次有效拒绝，且来自不同经历。 */
  autonomy: 2,
  /** 主动：两次带新证据的实质修正，且不是同一件事的措辞反复。 */
  initiative: 2,
  /** 整合：只有人确认，系统自己永远算不过。 */
  integration: 1,
})

/** 一条信念（取其 head revision）加上它这一版的 supports 证据。 */
export interface BeliefInput {
  artifactId: string
  revision: number
  state: string
  confidence: string
  /** 该 revision 中 relation='supports' 的证据的独立键（已去重、已剔除空值）。 */
  independenceKeys: string[]
  /** 该 revision 的 supports 证据落在哪些会话里。 */
  sessionRefs: string[]
}

/** 一次拒绝（事件）。 */
export interface RefusalInput {
  eventId: string
  at: string
  /** 这次拒绝所在经历的独立键（来源窗口 / 平台消息）。 */
  independenceKey: string
}

/** 一次「实质修正」：某个结论的某一版，比上一版多出了新的独立证据。 */
export interface CorrectionInput {
  artifactId: string
  revision: number
  /** 这一版新增、上一版没有的独立键。 */
  newIndependenceKeys: string[]
}

/** `deriveGrowth` 的全部输入：当前阶段下界 + 三类证据 + 整合里程碑 + 时钟；纯数据，不含任何 IO。 */
export interface DeriveInput {
  /** 当前已到达的阶段（单调下界）。 */
  currentPhase: Phase
  beliefs: BeliefInput[]
  refusals: RefusalInput[]
  corrections: CorrectionInput[]
  /** 人确认过的整合里程碑数。 */
  integrationConfirmed: number
  /** 最早一条事件的时间，用来算「一起待了多久」（只展示，不参与判定）。 */
  firstEventAt?: string | null
  now: string
}

/** `deriveGrowth` 的返回值：阶段、四道闸、瓶颈与稳定摘要，给 growth.ts 落库、面板展示。 */
export interface GrowthDerivation {
  /** 她现在已经到达的阶段（受 currentPhase 单调约束）。 */
  stage: Phase
  stageLabel: string
  /** 四道闸的完整结果，含未到达的。 */
  gates: Record<Gate, GateResult>
  /** 下一道没过的闸；全过了就是 null。 */
  bottleneck: Gate | null
  /** 一句话说明瓶颈（给观测台；不注入模型上下文）。 */
  bottleneckReason: string
  matureBeliefIds: string[]
  refusalEvidenceIds: string[]
  revisionEvidenceIds: string[]
  /** 与输入有关、与时间无关的稳定摘要，方便断言「同一输入算两次一致」。 */
  algorithmVersion: string
  elapsedDays: number
  counts: {
    beliefs: number
    matureBeliefs: number
    refusals: number
    corrections: number
    independentKeys: number
  }
}

/** 算法版本：改动任何阈值、判据、去重方式都必须改这个串。 */
export const ALGORITHM_VERSION = 'grow-1'

/**
 * 成熟信念判据——全仓唯一一份，晋升与过闸共用。
 *
 * 参数 `belief`：一条信念（head revision）+ 它的 supports 独立键。
 * 返回：`active` 且独立来源 ≥ 2 才为 true；`challenged` / `draft` 一律不算。
 * 边界：`state` 必须严格等于 `'active'`；独立键先 trim 去空再去重，空串不计数。
 */
export function isMatureBelief(belief: BeliefInput): boolean {
  // 状态先挡一道：被质疑或还在草稿的结论不能当「成熟」用，哪怕来源再多。
  if (!belief || belief.state !== 'active') return false
  // 阈值 2 是「两个独立来源」，不是「两条记录」——同一段经历记两遍仍算 1。
  return uniqueKeys(belief.independenceKeys).length >= 2
}

/** 去空、去首尾空白、去重，保持首次出现的顺序（顺序参与不了判定，只为结果稳定）。 */
function uniqueKeys(keys: readonly string[]): string[] {
  const out: string[] = []
  for (const key of keys) {
    const clean = typeof key === 'string' ? key.trim() : ''
    if (clean && !out.includes(clean)) out.push(clean)
  }
  return out
}

/** 阶段下标；认不出来的（旧库里的脏值）一律当 0 = trust，绝不让它把阶段抬高。 */
function phaseIndex(phase: string): number {
  const index = PHASE_ORDER.indexOf(phase as Phase)
  return index < 0 ? 0 : index
}

/**
 * 从 `from` 到 `to` 已经过了几个整天。
 *
 * 只用 `firstEventAt` 算「一起待了多久」，**不参与任何判定**（所以不影响晋级）。
 * 边界：缺值 / 解析失败 / 未来时间（负数）一律返回 0，不抛错也不返回 NaN。
 */
function dayDistance(from: string | null | undefined, to: string): number {
  if (!from) return 0
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  const days = Math.floor((end - start) / 86_400_000)
  return days > 0 ? days : 0
}

/**
 * 一次算完四道闸。
 *
 * 参数 `input`：信念 / 拒绝 / 修正三批依据 + 人确认的里程碑数 + 当前阶段下界。
 * 返回：四道闸的完整结果、当前阶段、瓶颈，以及与时间无关的稳定摘要。
 *
 * 关键性质：
 * - 不看时间，所以「放假一个月」不会自动升级；
 * - 独立键去重，所以「同一件事说三遍」不算三次；
 * - `integration` 只看人确认过的里程碑，系统算不出通过；
 * - 同一个 `input` 算两次，除 `counts.beliefs` 之类的计数外逐字段一致。
 */
export function deriveGrowth(input: DeriveInput): GrowthDerivation {
  const matureBeliefs = (input.beliefs ?? []).filter(isMatureBelief)

  const refusalKeys = uniqueKeys((input.refusals ?? []).map((item) => item.independenceKey))
  const refusalIds = dedupeById(input.refusals ?? [])

  const corrections = input.corrections ?? []
  const correctionKeys = uniqueKeys(corrections.flatMap((item) => item.newIndependenceKeys))
  // 两处不同的事各自被修正过一次，才算两次「实质修正」；
  // 同一个结论来回改措辞只算一次。
  const correctionArtifacts = dedupeStrings(corrections.map((item) => item.artifactId))

  const trust: GateResult = {
    gate: 'trust',
    passed: matureBeliefs.length >= GATE_THRESHOLDS.trust,
    have: matureBeliefs.length,
    need: GATE_THRESHOLDS.trust,
    evidenceIds: matureBeliefs.map((item) => item.artifactId),
    independenceKeys: uniqueKeys(matureBeliefs.flatMap((item) => item.independenceKeys)),
    shortfall: '',
  }
  trust.shortfall = trust.passed
    ? ''
    : matureBeliefs.length === 0
      ? '还没有一条有两个独立来源支撑的成熟信念'
      : `成熟信念还差 ${GATE_THRESHOLDS.trust - matureBeliefs.length} 条`

  // 拒绝要同时满足「条数够」和「独立经历够」：取两者较小值，
  // 这样同一次拒绝记了三条事件也不会被算成三次有效拒绝。
  const refusalCount = Math.min(refusalIds.length, refusalKeys.length)
  const autonomy: GateResult = {
    gate: 'autonomy',
    passed: refusalCount >= GATE_THRESHOLDS.autonomy,
    have: refusalCount,
    need: GATE_THRESHOLDS.autonomy,
    evidenceIds: refusalIds,
    independenceKeys: refusalKeys,
    shortfall: '',
  }
  autonomy.shortfall = autonomy.passed
    ? ''
    : refusalCount === 0
      ? '还没有一次明确的拒绝'
      : `有效拒绝还差 ${GATE_THRESHOLDS.autonomy - refusalCount} 次（要来自不同经历，同一件事重复不算）`

  // 同理：被修正的结论个数与新增独立键个数取小——一个结论改两次措辞只算一次实质修正。
  const correctionCount = Math.min(correctionArtifacts.length, correctionKeys.length)
  const initiative: GateResult = {
    gate: 'initiative',
    passed: correctionCount >= GATE_THRESHOLDS.initiative,
    have: correctionCount,
    need: GATE_THRESHOLDS.initiative,
    evidenceIds: corrections.map((item) => `${item.artifactId}#${item.revision}`),
    independenceKeys: correctionKeys,
    shortfall: '',
  }
  initiative.shortfall = initiative.passed
    ? ''
    : correctionCount === 0
      ? '还没有一次「带着新证据」的实质修正'
      : `实质修正还差 ${GATE_THRESHOLDS.initiative - correctionCount} 次（措辞反复不算，要新证据）`

  // 整数化 + 下限 0：脏数据（负数、小数、NaN）不许把整合闸顶过去。
  const confirmed = Math.max(0, Math.floor(input.integrationConfirmed ?? 0))
  const integration: GateResult = {
    gate: 'integration',
    passed: confirmed >= GATE_THRESHOLDS.integration,
    have: confirmed,
    need: GATE_THRESHOLDS.integration,
    evidenceIds: [],
    independenceKeys: [],
    shortfall: confirmed >= GATE_THRESHOLDS.integration ? '' : '整合阶段只能由人确认一次复盘，系统不会自己过闸',
  }

  const gates: Record<Gate, GateResult> = { trust, autonomy, initiative, integration }

  // 单调推进：每过一道闸，「够得着」的阶段就往上一格；但不低于 currentPhase。
  // 过 trust 闸 = 有资格进自主阶段，所以 earned 直接当索引用。
  // 遇到第一道没过的闸就 break：闸是串行的，trust 没过就谈不上自主/主动。
  let earned = 0
  for (const gate of PHASE_ORDER) {
    if (gate === 'integration') break // 最后一道只能靠人确认，算不出来
    if (gates[gate].passed) earned += 1
    else break
  }
  const floor = phaseIndex(input.currentPhase)
  const index = Math.min(PHASE_ORDER.length - 1, Math.max(floor, earned))
  const stage = PHASE_ORDER[index]

  const bottleneck = PHASE_ORDER.find((gate) => !gates[gate].passed) ?? null

  return {
    stage,
    stageLabel: PHASE_LABELS[stage],
    gates,
    bottleneck,
    bottleneckReason: bottleneck ? gates[bottleneck].shortfall : '四阶段都过了',
    matureBeliefIds: trust.evidenceIds,
    refusalEvidenceIds: refusalIds,
    revisionEvidenceIds: initiative.evidenceIds,
    algorithmVersion: ALGORITHM_VERSION,
    elapsedDays: dayDistance(input.firstEventAt ?? null, input.now),
    counts: {
      beliefs: (input.beliefs ?? []).length,
      matureBeliefs: matureBeliefs.length,
      refusals: refusalIds.length,
      corrections: correctionCount,
      independentKeys: uniqueKeys([
        ...trust.independenceKeys,
        ...autonomy.independenceKeys,
        ...initiative.independenceKeys,
      ]).length,
    },
  }
}

/** 按 `eventId` 去重，保住首次出现的顺序；空 id 丢弃（它证明不了任何事）。 */
function dedupeById(items: readonly RefusalInput[]): string[] {
  const ids: string[] = []
  for (const item of items) {
    if (item?.eventId && !ids.includes(item.eventId)) ids.push(item.eventId)
  }
  return ids
}

/** 字符串去空行/去重；用于 artifactId 这类「同一个东西只算一次」的键。 */
function dedupeStrings(items: readonly string[]): string[] {
  const out: string[] = []
  for (const item of items) {
    const clean = typeof item === 'string' ? item.trim() : ''
    if (clean && !out.includes(clean)) out.push(clean)
  }
  return out
}

/**
 * 单调推进的下一步：只有当下一道闸确实通过时，才允许把阶段推进一格。
 *
 * 参数 `current`：库里已到达的阶段（下界）；`derived`：这次算出来的阶段。
 * 返回：两者中靠后的那个——阶段永不回退。
 * 边界：两个值都认不出来时按 trust 处理（`phaseIndex` 兜底 0），不会突然跳到高阶段。
 *
 * 传进来的 `current` 与 `derived` 都可能是旧值（比如刚删了证据），
 * 所以这里取两者中靠后的那个——阶段永不回退。
 */
export function nextPhase(current: Phase, derived: Phase): Phase {
  return phaseIndex(derived) > phaseIndex(current) ? derived : current
}
