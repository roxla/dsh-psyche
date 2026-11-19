/**
 * 张力管理（设计文档 v15 §36，P2 第二批第一件）。
 *
 * 职责：把「两条结论不能同时算数」这件事**登记成一条有独立生命周期的记录**，
 * 跟踪它从开放到解决/作废的全过程；**不替任何一方裁决**。
 * 为什么单独成模块：矛盾既是认知对象（会反复出现、需要人看），又是写路径的并发点
 * （clash / revise / review 都可能碰它），揉进 store.ts 会让「谁在什么时候改了状态」不可审计。
 *
 * 三条硬约束（用户 m05134 定稿，写在这里因为后续每处实现都要照着它）：
 * 1. 矛盾不等于错误：登记只描述「两边不能同时为真」，不写哪条错；
 * 2. 解决矛盾不等于删除矛盾：状态只追加新版本，历史版本与证据永久保留；
 * 3. 矛盾记录不推进成长阶段：成长只认 `review(verdict=revised)` 与 `revise` 产生的实质修订。
 *
 * 纯函数边界（v14 §30.1 的同一条纪律）：本文件零 IO、零数据库、零模型调用。
 * 库侧读写、事务边界、幂等由 `tension-store.ts`（下一步实现）负责；
 * 这里只定义类型、状态机、严重度与「候选发现」，保证可单测、可复算。
 */

import { CODE, PsycheError } from './errors.js'

/** 算法版本：改否定词表、相似度阈值、去重方式都必须改这个串，否则旧记录无法解释。 */
export const TENSION_ALGORITHM_VERSION = 'ten-1'

/**
 * 张力类型。
 * - `contradiction`：两边不能同时为真（「她喜欢猫」/「她不喜欢猫」）；
 * - `qualification`：不是相反，而是一边限定了另一边的适用范围（「她讨厌猫」/「她只讨厌邻居家的猫」）。
 * 自动探测只产出 `contradiction`；`qualification` 只能由 `clash` 或人显式登记——
 * 限定关系靠字符相似度判不出来，硬猜比不猜更糟。
 */
export type TensionKind = 'contradiction' | 'qualification'

/**
 * 状态有四个（加一个终态）。
 *
 * - `open`：已登记、还没人动它；
 * - `investigating`：**有新的证据在查**（进入这个状态必须携带新 sourceId——
 *   否则「我在查」就只是一句台词，状态会变成自我安慰）；
 * - `parked`：查过了、暂时放一放（必须写 note 说明为什么先放着）；
 * - `resolved`：由 `revise` / `review` / 人明确判定处理过（保留解决方式与依据）；
 * - `withdrawn`：误报或重复登记，作废但记录仍在——**终态，不复活**。
 *
 * 为什么 `parked` 与 `withdrawn` 必须分开：前者是「还可能，只是现在不该花力气」，
 * 后者是「这条根本不该存在」。把前者记成后者，会让真实矛盾在面板里永久消失。
 */
export type TensionStatus = 'open' | 'investigating' | 'parked' | 'resolved' | 'withdrawn'

/** 五个状态的固定顺序（面板排序、文档、迁移脚本共用一份，避免各处自己拼数组）。 */
export const TENSION_STATUSES: readonly TensionStatus[] = Object.freeze(['open', 'investigating', 'parked', 'resolved', 'withdrawn'])

/** 给面板看的中文名；`?` 不在这里，展示层自己决定要不要加。 */
export const TENSION_STATUS_LABELS: Readonly<Record<TensionStatus, string>> = Object.freeze({
  open: '待处理',
  investigating: '在查',
  parked: '搁置',
  resolved: '已解决',
  withdrawn: '已作废',
})

/** 谁做的这次状态变化。`model` 只能登记，不能判「已解决」（见 §36.4）。 */
export type TensionActor = 'human' | 'core' | 'model'

/**
 * 张力从哪来。
 * - `clash`：模型撞上反证时主动登记（§9.2 第 2 条，必须带非自身来源）；
 * - `detect`：`syncCognition()` 的自动探测（只报不裁决）；
 * - `human`：用户/观测台手动登记。
 */
export type TensionOrigin = 'clash' | 'detect' | 'human'

/**
 * 解决方式（只在 `resolved` 时有值）。
 * - `revised`：某侧被 `revise` 改成新版本；
 * - `superseded`：某侧被新命题取代（新 id + supersedes）；
 * - `rejected`：`review` 判该侧不成立（fact→forgotten，其余→retracted）；
 * - `qualified`：新证据没推翻任何一侧，但把适用范围缩了（`qualifies` 证据）。
 */
export type TensionResolution = 'revised' | 'superseded' | 'rejected' | 'qualified'

/** 一个结论侧：绑到**版本**而不是对象（§5.4 同一条纪律：证据跟着它支撑的那一版走）。 */
export interface TensionSide {
  artifactId: string
  revision: number
  /** 六类之一；自动探测只比较 fact / belief / impression / stance。 */
  kind: string
  /** 该版本的状态（active / challenged / …），探测时用于跳过死掉的版本。 */
  state: string
  statement: string
  /** 规范化后的话题锚点；两边没有交集就不构成可比对的一对。 */
  subjectRefs: string[]
}

/** 一条张力的当前形态（head 版本）。 */
export interface TensionRecord {
  tensionId: string
  /** 追加式版本号，从 1 开始；head 取 `max(version)`。 */
  version: number
  /** 规范化 pair 键，用于幂等：`id#rev|id#rev`（字典序，与调用顺序无关）。 */
  pairKey: string
  left: TensionSide
  right: TensionSide
  kind: TensionKind
  origin: TensionOrigin
  status: TensionStatus
  severity: 'low' | 'medium' | 'high'
  /** 判定依据（自动探测才有）：相似度、否定标记、共享话题，供人复核。 */
  basis: TensionBasis
  openedAt: string
  openedBy: TensionActor
  /** 最后一次状态变化。 */
  changedAt: string
  changedBy: TensionActor
  /** 解决方式；`withdrawn` 留空（它的「原因」写在 note 里）。 */
  resolution: TensionResolution | null
  note: string | null
  /** 登记或解决时引用的 cognitive 事件（可用于回溯「哪次反证」）。 */
  eventId: string | null
  /** 解决时指向产生了新版本的那条结论。 */
  resolvedArtifactId: string | null
  resolvedRevision: number | null
  /** 再次出现时指回前一条张力，串起同一对结论的完整历史。 */
  previousTensionId: string | null
}

/** 自动探测给出的判定依据——必须能被人一眼看明白「凭什么说这两条打架」。 */
export interface TensionBasis {
  /** 共享话题（subjectRefs 交集，已规范化）。 */
  sharedSubjects: string[]
  /** 去掉否定词之后的文本相似度 0–1。 */
  similarity: number
  /** 左侧是否带否定。 */
  negatedLeft: boolean
  /** 右侧是否带否定。 */
  negatedRight: boolean
  /** 命中的否定词（去重后的字面量），用于解释判定。 */
  negationMarkers: string[]
  /** 算法版本，写进记录以便日后解释。 */
  algorithmVersion: string
}

/** 探测输入的一侧（比 `TensionSide` 多一个时间，用于稳定排序与「只看较新的」）。 */
export interface TensionCandidateItem extends TensionSide {
  updatedAt?: string
}

/** 探测参数。默认值写在这里而不是调用方，避免两处各有一套阈值。 */
export interface TensionDetectOptions {
  /** 已经登记过或已有关系的 pair 键，直接跳过（幂等 + 去重）。 */
  existingPairKeys?: Iterable<string>
  /** 一次最多产出多少条，防止首次全量扫描把面板灌爆。 */
  maxPairs?: number
  /** 去否定文本的 bigram Jaccard 下限，默认 0.5。 */
  minSimilarity?: number
  /** 参与自动探测的结论类型，默认 `fact/belief/impression/stance`。 */
  allowKinds?: readonly string[]
  /** 参与自动探测的结论状态，默认 `active` 与 `challenged`。 */
  allowStates?: readonly string[]
}

/** 候选对（还没落库，落库时才会分配 tensionId）。 */
export interface TensionCandidate {
  pairKey: string
  left: TensionSide
  right: TensionSide
  kind: TensionKind
  basis: TensionBasis
}

/**
 * 允许的状态转移（§36.3）：只有这十条，其余一律 `E_STATE`。
 *
 * 两条刻意的「不直接」：
 * - `open→parked` 不允许：没查过就搁置等于忽略，要忽略请显式 `withdrawn`；
 * - `parked→resolved` 不允许：搁置中的矛盾必须先回到 `investigating` 才能判解决，
 *   否则「已解决」会变成一句没有依据的状态改写。
 */
export const TENSION_TRANSITIONS: Readonly<Record<TensionStatus, readonly TensionStatus[]>> = Object.freeze({
  open: ['investigating', 'resolved', 'withdrawn'],
  investigating: ['resolved', 'parked', 'open', 'withdrawn'],
  parked: ['investigating', 'withdrawn'],
  resolved: ['open'],
  withdrawn: [],
})

/** 状态机的说明文案，抛错与文档共用一份，避免两处措辞漂移。 */
const TRANSITION_HINT: Readonly<Record<string, string>> = Object.freeze({
  'open→investigating': '进入「在查」必须带新的 sourceId：没有新证据的调查只是台词',
  'open→resolved': '要判「已解决」，走 revise / review 或人明确判定',
  'open→withdrawn': '要作废，必须给出 note（误报还是重复）',
  'investigating→parked': '搁置要写 note：为什么先放着、什么条件下再捡起来',
  'investigating→open': '放弃调查要写 note，别把「查了一半」悄悄退回待处理',
  'parked→investigating': '唤醒搁置必须带新的 sourceId：没新证据就回到在查只是来回打转',
  'resolved→open': '再次出现必须引用一条新的反证事件（eventId），不能只改状态',
  'withdrawn→open': '已作废的张力不复活：真出现新冲突时两侧至少有一版变了，会生成新的一对',
})

/**
 * 默认否定词表。故意很短：宁可漏报（留给 clash 补），也不要因为「不错」「不得不」这类
 * 固定搭配把一句话读反——误报会让面板里全是假矛盾，比没有自动探测更糟。
 * 处理顺序上先剥 `NEGATION_EXCEPTIONS`，再数标记；解析见 `polarityOf()`。
 */
const NEGATION_MARKERS: readonly string[] = Object.freeze(['不是', '不会', '不能', '不想', '没有', '并不', '不', '没', '无', '未', '非'])

/**
 * 固定搭配：出现时**不算否定**。
 * 这些词都是「看着像否定、语义上却是肯定或另有所指」，是中文里最典型的假阳性来源。
 */
const NEGATION_EXCEPTIONS: readonly string[] = Object.freeze([
  '不错',
  '不但',
  '不仅',
  '不过',
  '不得不',
  '不少',
  '不久',
  '不断',
  '不够',
  '不妨',
  '不客气',
  '没关系',
])

/** 参与自动探测的默认结论类型：关系/做法各有自己的生命周期，不和事实混在一起比。 */
const DEFAULT_ALLOW_KINDS: readonly string[] = Object.freeze(['fact', 'belief', 'impression', 'stance'])

/** 只有「还活着」的版本值得比较；retracted / superseded 已经被处理过，再报就是噪音。 */
const DEFAULT_ALLOW_STATES: readonly string[] = Object.freeze(['active', 'challenged'])

/** 默认一次最多 20 对（首次全量扫描时面板能看、人愿意看）。 */
const DEFAULT_MAX_PAIRS = 20

/** 默认相似度阈值：低于它说明共享话题之外没多少共同措辞，不构成可比对的一对。 */
const DEFAULT_MIN_SIMILARITY = 0.5

/** 去掉首尾空白并压缩内部空白：比较与存储都用同一个形态。 */
export function normalizeText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 话题锚点规范化：小写 + 去空白；空值过滤，重复只留一个（保持首次出现顺序）。 */
export function normalizeSubjects(refs: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const ref of refs ?? []) {
    const value = normalizeText(ref).toLowerCase()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * 判定一句话是否带否定，并给出「剥掉否定词之后」的文本。
 *
 * 参数 `statement`：原始陈述。返回 `{negated, stripped, markers}`：
 * - `stripped`：去掉固定搭配与全部否定标记后的文本，用于相似度比较；
 * - `markers`：命中的否定词（按长度优先匹配后去重），用于给人解释。
 * 边界：`不` 出现在「差不多」「对不起」这类词里仍会被当成否定——词表覆盖不到所有口语，
 * 所以自动探测只当线索；真判断要靠 `clash` 带来的外部来源。
 */
export function polarityOf(statement: string): { negated: boolean; stripped: string; markers: string[] } {
  let text = normalizeText(statement)
  // 先剥固定搭配：它们含「不」但语义不是否定，留着会让下面的计数全错
  for (const phrase of NEGATION_EXCEPTIONS) text = text.split(phrase).join('')
  /** 本句里真正算数的否定标记（同一词只记一次，避免「不不不」被算成三重否定） */
  const markers = new Set<string>()
  let stripped = text
  // 长词优先：先匹配「不是」，才不会在「不是」里先吃掉「不」而留下「是」
  for (const marker of [...NEGATION_MARKERS].sort((a, b) => b.length - a.length)) {
    if (!stripped.includes(marker)) continue
    let count = 0
    while (stripped.includes(marker)) {
      const at = stripped.indexOf(marker)
      stripped = `${stripped.slice(0, at)}${stripped.slice(at + marker.length)}`
      count += 1
    }
    // 同一个词出现偶数次互相抵消（「不不」），不跨词叠加——不同否定词连用手法太绕，不在这里建模
    if (count % 2 === 1) markers.add(marker)
  }
  return { negated: markers.size > 0, stripped: stripped.replace(/\s+/g, ''), markers: [...markers] }
}

/**
 * 字符 bigram 集合：中文没有空格，按 2 字滑窗比按"词"切更稳。
 * 单字文本退化成单字集合，避免空集让相似度恒为 0。
 */
function bigrams(text: string): Set<string> {
  const chars = [...text.replace(/[\s\p{P}\p{S}]+/gu, '')]
  if (chars.length === 0) return new Set()
  if (chars.length === 1) return new Set([chars[0]!])
  const out = new Set<string>()
  for (let index = 0; index + 1 < chars.length; index += 1) out.add(`${chars[index]}${chars[index + 1]}`)
  return out
}

/** 两段文本的 bigram Jaccard（0–1）；任一侧为空返回 0。 */
export function similarityOf(left: string, right: string): number {
  const a = bigrams(left)
  const b = bigrams(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * 构造 pair 键：两侧各取 `id#revision`，按字典序排序后拼接。
 * 为什么排序：同一对结论不管谁先被写进来，都必须算出同一个 key，否则幂等失效。
 */
export function pairKeyOf(left: { artifactId: string; revision: number }, right: { artifactId: string; revision: number }): string {
  const a = `${left.artifactId}#${left.revision}`
  const b = `${right.artifactId}#${right.revision}`
  return a <= b ? `${a}|${b}` : `${b}|${a}`
}

/** 话题锚点交集（已规范化、去重、保持左侧顺序）。 */
function sharedSubjectsOf(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(normalizeSubjects(right))
  return normalizeSubjects(left).filter((item) => rightSet.has(item))
}

/**
 * 这条张力有多硬（只用于排序与展示，不参与任何判据）。
 * 依据：两侧是否仍 active、共享话题数、相似度。
 * 为什么不让模型填：严重度一旦可被模型左右，就可以用它把重要矛盾压到列表底部。
 */
export function severityOf(input: {
  left: Pick<TensionSide, 'state'>
  right: Pick<TensionSide, 'state'>
  basis: Pick<TensionBasis, 'sharedSubjects' | 'similarity'>
}): 'low' | 'medium' | 'high' {
  const alive = (state: string): boolean => state === 'active' || state === 'challenged'
  const bothAlive = alive(input.left.state) && alive(input.right.state)
  if (input.basis.similarity >= 0.85 && input.basis.sharedSubjects.length >= 1 && bothAlive) return 'high'
  if (input.basis.similarity >= 0.6 && bothAlive) return 'medium'
  return 'low'
}

/**
 * 自动矛盾发现（只报不裁决）。
 *
 * 判据（全部满足才产出候选）：
 * 1. 两条结论属于不同 artifact，且在允许的类型/状态里；
 * 2. `subjectRefs` 有交集——没有共同话题就不判「同一件事」；
 * 3. 去否定之后文本相似度 ≥ `minSimilarity`；
 * 4. 两侧否定性**不同**（一边否一边不否）；
 * 5. pair 不在 `existingPairKeys` 里。
 *
 * 边界（写清楚，避免以后被当成 bug）：反义词（喜欢/讨厌）、数值冲突、时序冲突、
 * 限定关系都不在自动探测范围内——那些交给 `clash` 与人工登记。
 * 返回按 pairKey 排序，取前 `maxPairs` 条（确定性输出，方便测试与面板 diff）。
 */
export function detectTensions(items: readonly TensionCandidateItem[], options: TensionDetectOptions = {}): TensionCandidate[] {
  const allowKinds = new Set(options.allowKinds ?? DEFAULT_ALLOW_KINDS)
  const allowStates = new Set(options.allowStates ?? DEFAULT_ALLOW_STATES)
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY
  const maxPairs = Math.max(0, options.maxPairs ?? DEFAULT_MAX_PAIRS)
  const existing = new Set<string>(options.existingPairKeys ?? [])

  // 先过滤：类型/状态不对、没有话题锚点的直接出局，减少下面的两两比较
  const pool = items.filter((item) => allowKinds.has(item.kind) && allowStates.has(item.state) && normalizeSubjects(item.subjectRefs).length > 0)
  const found: TensionCandidate[] = []
  const seen = new Set<string>()

  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const left = pool[i]!
      const right = pool[j]!
      if (left.artifactId === right.artifactId) continue
      const pairKey = pairKeyOf(left, right)
      if (existing.has(pairKey) || seen.has(pairKey)) continue

      const sharedSubjects = sharedSubjectsOf(left.subjectRefs, right.subjectRefs)
      if (sharedSubjects.length === 0) continue

      const leftPolarity = polarityOf(left.statement)
      const rightPolarity = polarityOf(right.statement)
      // 否定性相同 = 说法同向，不是矛盾（「喜欢」对「喜欢」）
      if (leftPolarity.negated === rightPolarity.negated) continue

      const similarity = similarityOf(leftPolarity.stripped, rightPolarity.stripped)
      if (similarity < minSimilarity) continue

      const basis: TensionBasis = {
        sharedSubjects,
        similarity: Math.round(similarity * 1000) / 1000,
        negatedLeft: leftPolarity.negated,
        negatedRight: rightPolarity.negated,
        negationMarkers: [...new Set([...leftPolarity.markers, ...rightPolarity.markers])],
        algorithmVersion: TENSION_ALGORITHM_VERSION,
      }
      seen.add(pairKey)
      found.push({ pairKey, left, right, kind: 'contradiction', basis })
    }
  }

  found.sort((a, b) => (a.pairKey < b.pairKey ? -1 : a.pairKey > b.pairKey ? 1 : 0))
  return found.slice(0, maxPairs)
}

/** 这条状态能不能转过去（纯判定，不看上下文）。 */
export function canTransition(from: TensionStatus, to: TensionStatus): boolean {
  return (TENSION_TRANSITIONS[from] ?? []).includes(to)
}

/** 状态转移的上下文：不同目标状态要求的材料不一样，缺一项就拒。 */
export interface TransitionContext {
  /** 新的 cognitive 事件 id（`contradiction_detected` / `fact_learned` 等）。 */
  eventId?: string | null
  /** 这次转移说明（搁置、作废、解决、放弃调查时必填）。 */
  note?: string | null
  /** 新拿到的来源 id；进「在查」与从「搁置」唤醒时必须非空。 */
  sourceIds?: readonly string[] | null
}

/**
 * 校验一次状态转移，不合法就抛 `E_STATE`。
 *
 * 参数 `from` / `to`：当前与目标状态；`context`：见 `TransitionContext`。
 * 返回 `{from, to, reopened}`，`reopened` 表示这是「已解决后再次出现」。
 *
 * 每一条额外要求的理由（不是形式主义，缺了哪条都对应过一种真实塌陷）：
 * - 进 `investigating` 要 `sourceIds`：没有新证据的调查 = 用状态假装在努力；
 * - `parked` 要 `note`：不写为什么先放着，三个月后没人知道该不该捡起来；
 * - `resolved` 要 `note`：解决方式必须可回读，否则「已解决」是信仰；
 * - `withdrawn` 要 `note`：误报还是重复，决定下同类矛盾要不要再报；
 * - `resolved→open` 要 `eventId`：没有反证的重开就是情绪；
 * - `withdrawn` 终态：真出现新冲突时两侧至少有一版变了，pairKey 随之变化，
 *   会自然生成新记录，不需要也不允许复活旧记录。
 */
export function assertTransition(from: TensionStatus, to: TensionStatus, context: TransitionContext = {}): { from: TensionStatus; to: TensionStatus; reopened: boolean } {
  if (from === to) {
    throw new PsycheError(CODE.state, `张力已经是 ${from} 状态，没有变化可写`)
  }
  if (!canTransition(from, to)) {
    const hint = TRANSITION_HINT[`${from}→${to}`] ?? '这条转移不在状态机里'
    throw new PsycheError(CODE.state, `张力不能从 ${from} 变成 ${to}：${hint}`)
  }
  const sourceIds = (context.sourceIds ?? []).map((item) => String(item ?? '').trim()).filter(Boolean)
  if (to === 'investigating' && sourceIds.length === 0) {
    throw new PsycheError(CODE.state, TRANSITION_HINT[`${from}→investigating`]!)
  }
  if (to === 'parked' && !context.note) {
    throw new PsycheError(CODE.state, TRANSITION_HINT['investigating→parked']!)
  }
  if (to === 'open' && from === 'investigating' && !context.note) {
    throw new PsycheError(CODE.state, TRANSITION_HINT['investigating→open']!)
  }
  if (to === 'resolved' && !context.note) {
    throw new PsycheError(CODE.state, '判「已解决」必须写明依据（note）：是修订、取代、否定还是限定')
  }
  if (to === 'withdrawn' && !context.note) {
    throw new PsycheError(CODE.state, '作废必须说明原因（note）：误报还是重复登记')
  }
  if (from === 'resolved' && to === 'open' && !context.eventId) {
    throw new PsycheError(CODE.state, TRANSITION_HINT['resolved→open']!)
  }
  return { from, to, reopened: from === 'resolved' && to === 'open' }
}

/** 解决方式 ↔ 认知动作的映射：给调用方一个唯一写法，别在三个地方各拼一遍。 */
export function resolutionOfVerdict(verdict: 'revised' | 'rejected' | 'refined' | 'confirmed' | 'challenged'): TensionResolution | null {
  // refined/confirmed 说明这条还能用，不构成对「矛盾」的裁决
  if (verdict === 'revised') return 'revised'
  if (verdict === 'rejected') return 'rejected'
  return null
}
