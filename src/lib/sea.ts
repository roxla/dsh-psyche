// 意识海的场景数据：节点坐标、簇、边（v14 §29；对照 asdfd3/3d-memory-sea 的思路，但边来自真库）。
//
// 与原版的区别：它靠 bigram 猜连线，我们把库里已有的关系当边——四张表见 `SeaEdgeKind` 上方的表。
// 只读只算：不做 AI、不写库、不改记忆；位置由 id 哈希决定，同一张库重复请求得到完全一样的形状。
// 坐标口径对齐 3d-memory-sea：簇按 kind 铺在斐波那契球面上（簇心半径 230–420），簇内点在各自
// 小球壳里散开（16–136），前端按透视投影（FOCAL 1100 / dist 1200）画。
// 调用方：index.ts 的海景接口；显著度算失败时退回独立证据数，绝不让整片海空掉。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Db } from './adapter.js'
import { PERSONA_ID } from './store.js'
import { deriveSalienceNow } from './cognition.js'

/** 七种节点：六种结论（与 salience 的 kind 一致）+ 经历（event）。 */
export type SeaNodeKind = 'fact' | 'belief' | 'impression' | 'stance' | 'relationship' | 'procedure' | 'event'

/**
 * 海里的一个点。
 *
 * `x/y/z` 是**世界坐标**，由 `anchorOf` 按 id 哈希算出：同一个 id 永远同一处，
 * 所以两次请求的位置可以直接比较（新增点才是真新增）。`weight` 决定前端亮度/半径。
 */
export interface SeaNode {
  id: string
  kind: SeaNodeKind
  label: string
  at: string | null
  /** 独立证据数（事件恒为 1），决定点的半径。 */
  weight: number
  /** 世界坐标（三维，量级 ±500），同一 id 永远同一处。 */
  x: number
  y: number
  z: number
  /**
   * 所属簇的 key：优先是 `subject_refs` 的第一个值（关于谁/什么），
   * 没有 subject 时退回 kind（事实/看法/经历…），簇数超限时归 'other'。
   */
  cluster: string
  /** 簇的显示名（subject 原值截断、kind 的中文名、或「其他」）。 */
  clusterName: string
  /** 这个点具体关于谁/什么（无 subject 时为空）。 */
  subject: string | null
  /** 首次写入时间；用于“新增”判断，不参与坐标。 */
  createdAt: string | null
  /** 最近一次修订时间；用于“更新”判断，不参与坐标。 */
  revisedAt: string | null
  /**
   * 新鲜度 0–1：`0.35 + 0.65·exp(-days/90)`，按 `at` 距现在算。
   * 越新越亮；没有时间戳时给 0.35（最暗但可见）。前端直接拿它乘亮度。
   */
  recency: number
  /** 事件节点带类型，结论节点带状态，前端做图例用。 */
  meta: string
}

/**
 * 五种边，前四种各对应库里的一张真关系表（不是相似度猜的），最后一种是弱连：
 * - `trigger`：events ──▶ artifacts（artifact_trigger_events，事件触发了结论）
 * - `relation`：artifacts ──▶ artifacts（artifact_relations：supersedes / contradicts / tensionWith / relatedTo）
 * - `lineage`：artifacts ──▶ artifacts（artifact_lineage：derivedFrom / revisedFrom / splitFrom）
 * - `caused`：events ──▶ events（event_relations）
 * - `topic`：任意两个点（跨簇共享少见词，`TOPIC_*` 有上限，见 `buildTopicEdges`）
 */
export type SeaEdgeKind = 'trigger' | 'relation' | 'lineage' | 'caused' | 'topic'

/** 一条边。`a` / `b` 都是节点 id，方向按上表；`score` 是固定权重（见 `EDGE_SCORE`）。 */
export interface SeaEdge {
  a: string
  b: string
  kind: SeaEdgeKind
  label: string
  /** 0–1，前端换算成线的透明度。 */
  score: number
}

/**
 * 一次海景渲染的全部数据。
 *
 * 只返回能画的那一屏：超限的节点不返回，但 `stats.truncated` 与 `note` 会说明
 * 「库里还有更早的记忆没画」，避免用户以为记忆真的只有这些。
 */
export interface SeaScene {
  ok: true
  /** 不透明数据实例标识；无法可靠识别时为 null。 */
  instanceKey: string | null
  /** 为 false 时客户端不得显示“新增/更新”标记。 */
  diffAvailable: boolean
  nodes: SeaNode[]
  edges: SeaEdge[]
  stats: {
    artifacts: number
    events: number
    edges: number
    byKind: Record<string, number>
    /** 每个簇（subject / kind / other）有多少点，前端画图例用。 */
    byCluster: Record<string, number>
    truncated: boolean
    /** 权限与时间窗口内、截断前的总数。 */
    totalArtifacts: number
    totalEvents: number
    displayedArtifacts: number
    displayedEvents: number
    /** 最早/最晚记忆的时间戳，前端算跨度天数。 */
    span: { from: string | null; to: string | null }
  }
  note: string
}

/**
 * 渲染参数（全部可选，默认值见下面三个常量）。
 *
 * 三个值都是**上限**：`artifactLimit` / `eventLimit` 控制这一屏画多少点，
 * `labelChars` 控制标签截断长度（事件标签再乘 0.7，因为事件多、字要更短）。
 */
export interface SeaOptions {
  artifactLimit?: number
  eventLimit?: number
  labelChars?: number
  /** 可选观察窗口（ISO）；按 revisedAt/at 过滤当前可读记录，不是历史快照。 */
  from?: string
  to?: string
  /** 算新鲜度用的「现在」（毫秒）；不传取 Date.now()，测试可注入固定时钟。 */
  now?: number
}

/** 默认最多画多少条结论（head 版本）。再多前端就糊成一片，且查询本身开始变慢。 */
const DEFAULT_ARTIFACT_LIMIT = 420
/** 默认最多画多少条经历。事件比结论多得多，所以给的数量更大。 */
const DEFAULT_EVENT_LIMIT = 600
/** 结论标签默认截断到多少字符（按显示宽度算的近似值，不是字节数）。 */
const DEFAULT_LABEL_CHARS = 90

/** 一整圈（2π），方位角取样时用。 */
const TAU = Math.PI * 2

/** 每种节点在簇球面上的落点半径倍率（关系/立场靠里，经历在最外层）。 */
const KIND_RADIUS: Record<string, number> = {
  relationship: 0.42,
  stance: 0.55,
  belief: 0.7,
  impression: 0.78,
  procedure: 0.84,
  fact: 0.9,
  event: 1,
}

/** 簇的中文名（前端画簇名用）；不是已知 kind 就原样返回，不报错。 */
const CLUSTER_LABEL: Record<string, string> = {
  fact: '事实',
  belief: '看法',
  impression: '印象',
  stance: '立场',
  relationship: '关系',
  procedure: '做法',
  event: '经历',
}

/** 簇心半径（同 3d-memory-sea 的 230 + rand*190）。 */
const CLUSTER_RADIUS_BASE = 230
const CLUSTER_RADIUS_SPAN = 190

/**
 * 各类边的固定权重（0–1），前端换算成线的不透明度。
 *
 * 值只表达「这条关系有多确定」：`relation`（明确写下的关系）最实，`trigger` 次之，
 * `caused` 最虚（事件因果常是推断出来的）。改这些数字会直接改变画面观感，别随手调。
 */
const EDGE_SCORE: Record<SeaEdgeKind, number> = {
  trigger: 0.42,
  relation: 0.6,
  lineage: 0.5,
  caused: 0.34,
  // 弱连：只表示「两段记忆共享一个少见词」，比任何真关系都虚，所以给最低的分数。
  topic: 0.26,
}

/** 最多同时铺多少个簇（subject 太多时，多出来的归「其他」，否则球面会碎成几百个小球）。 */
const MAX_CLUSTERS = 12

/** 弱连的数量上限：再多线就会盖住点本身。 */
const TOPIC_EDGE_LIMIT = 300

/** 一个词最多出现在几个点上才算「少见」；超过它说明太常见（如「用户」「今天」），连了没意义。 */
const TOPIC_TOKEN_MAX_NODES = 5

/** 最少出现在几个点上才连（只出现一次的词连不出边）。 */
const TOPIC_TOKEN_MIN_NODES = 2

/** 中文里几乎每句都出现、不该当主题词的双字组合。 */
const TOPIC_STOPWORDS = new Set([
  '今天', '现在', '这个', '那个', '什么', '一个', '我们', '他们', '你们', '自己',
  '可以', '就是', '因为', '所以', '但是', '如果', '没有', '已经', '还是', '这样',
  '那样', '时候', '东西', '事情', '一样', '知道', '觉得', '应该', '需要', '用户',
  '的话', '不要', '不是', '一样', '可能', '喜欢', '有点', '真的', '开始', '一下',
])

/** 新鲜度衰减的半衰期（天）：90 天后约剩 0.35 + 0.65·e^-1 ≈ 0.59。 */
const RECENCY_HALF_LIFE_DAYS = 90

/** 没有时间戳的点给这个值：可见但明显偏暗。 */
const RECENCY_FLOOR = 0.35

/**
 * FNV-1a 32 位哈希。
 *
 * 用它给坐标定位：稳定（同串永远同值）、够快、不需要加密强度。
 * `Math.imul` 保证 32 位乘法不丢精度；最后 `>>> 0` 转成无符号数，避免负数影响取模。
 */
function hash32(text: string): number {
  let h = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    h ^= text.charCodeAt(index)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * 把任意 key 映射成 [0, 1) 的确定性伪随机数。
 *
 * 取模 100000 是为了让低位的相关性不那么明显；这里**不是**密码学随机，
 * 但足以让不同 id 的落点看起来自然散开。
 */
function rand(key: string): number {
  return (hash32(key) % 100000) / 100000
}

/**
 * kind → 中文簇名。
 *
 * 参数 `kind`：节点类型（或任意字符串）；返回：中文名，未知类型原样返回。
 */
export function clusterLabel(kind: string): string {
  return CLUSTER_LABEL[kind] ?? kind
}

/** 内建 subject 的中文名（`user` / `self` 这类由 Core 生成，不是业务中文）。 */
const SUBJECT_LABELS: Record<string, string> = { user: '用户', self: '自己' }

/**
 * 把 `subject_refs` 的 JSON 串解析成字符串数组。
 * 坏数据（null / 非数组 / 元素不是字符串）一律当空，不抛：一个脏字段不该让整片海空掉。
 */
function parseSubjects(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  } catch {
    return []
  }
}

/**
 * 簇 key → 显示名：
 * 固定 kind 用中文；`user`/`self` 用中文；`topic:xxx` 这类去掉命名空间前缀；
 * 其余原样截断，太长的话前端也画不下。
 */
function subjectName(key: string): string {
  if (key === 'other') return '其他'
  if (CLUSTER_LABEL[key]) return CLUSTER_LABEL[key]
  if (SUBJECT_LABELS[key]) return SUBJECT_LABELS[key]
  const clean = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
  return clip(clean, 16) || key
}

/**
 * 新鲜度：`0.35 + 0.65·exp(-days/90)`。
 * 没有时间戳（或时间戳坏了）时给 0.35——可见，但一眼能看出「不知道多久以前」。
 */
function recencyOf(at: string | null, now: number): number {
  if (!at) return RECENCY_FLOOR
  const time = Date.parse(at)
  if (!Number.isFinite(time)) return RECENCY_FLOOR
  const days = Math.max(0, (now - time) / 86400000)
  return round3(RECENCY_FLOOR + (1 - RECENCY_FLOOR) * Math.exp(-days / RECENCY_HALF_LIFE_DAYS))
}

/**
 * 把一句话切成「主题词」：中文按 2 字滑窗，英文/数字按整词（≥3 字符）。
 * 为什么不用分词：没有词典依赖，2 字组合对中文够用；太常见的组合由 `TOPIC_STOPWORDS`
 * 和「最多出现在 5 个点」两道闸挡掉。
 */
function topicTokens(label: string): string[] {
  const cleaned = label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')
  const out = new Set<string>()
  for (const piece of cleaned.split(' ')) {
    if (!piece) continue
    if (/^[a-z0-9]+$/.test(piece)) {
      if (piece.length >= 3) out.add(piece)
      continue
    }
    for (let index = 0; index + 2 <= piece.length; index += 1) out.add(piece.slice(index, index + 2))
  }
  return [...out]
}

/**
 * 共享词弱连：只连「跨簇」且共享一个少见词的两颗星。
 *
 * 三条闸（照 3d-memory-sea / 星汐的经验）：
 * 1. 词必须出现在 2–5 个点之间——只出现一次连不出边，出现太多次说明是口头禅；
 * 2. 只在**不同簇**之间连——同簇已经有真关系边，再连一遍只会缠成一团；
 * 3. 全图最多 300 条，且频次低的词先连（低频词才真有区分度）。
 *
 * 参数 `clusterOf` 按节点 id 反查簇 key；`pushEdge` 负责去重与两端都在屏上的校验。
 */
function buildTopicEdges(
  nodes: readonly SeaNode[],
  clusterOf: (id: string) => string,
  pushEdge: (a: string, b: string, kind: SeaEdgeKind, label: string) => void,
): void {
  const tokenNodes = new Map<string, string[]>()
  for (const node of nodes) {
    for (const token of topicTokens(node.label)) {
      if (TOPIC_STOPWORDS.has(token)) continue
      const list = tokenNodes.get(token)
      if (list) list.push(node.id)
      else tokenNodes.set(token, [node.id])
    }
  }
  const entries = [...tokenNodes.entries()]
    .filter(([, ids]) => ids.length >= TOPIC_TOKEN_MIN_NODES && ids.length <= TOPIC_TOKEN_MAX_NODES)
    .sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]))
  const pairs = new Set<string>()
  let made = 0
  for (const [token, ids] of entries) {
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        if (made >= TOPIC_EDGE_LIMIT) return
        const a = ids[i]
        const b = ids[j]
        // 同簇不画：真正的结构关系已经由 trigger/relation/lineage 表达了。
        if (clusterOf(a) === clusterOf(b)) continue
        const key = a < b ? `${a}|${b}` : `${b}|${a}`
        if (pairs.has(key)) continue
        pairs.add(key)
        pushEdge(a, b, 'topic', token)
        made += 1
      }
    }
  }
}

/**
 * 簇心：所有簇 key 按斐波那契球面均匀铺开（簇与簇之间在三维里分开）。
 *
 * 顺序必须**稳定**：固定 kind（KIND_ORDER）先排，其余（subject / other）按字典序，
 * 这样同一张库重复请求得到完全一样的形状；新增一个 subject 只会多一个球面方向，
 * 不会让已有簇的位置整体洗牌。参数 `keys`：库里出现过的簇 key；返回：key → 簇心坐标。
 */
const KIND_ORDER: SeaNodeKind[] = ['event', 'fact', 'belief', 'impression', 'stance', 'relationship', 'procedure']

function clusterCenters(keys: readonly string[]): Map<string, { x: number; y: number; z: number }> {
  const list = [...new Set([...KIND_ORDER, ...keys])]
  list.sort((a, b) => {
    const ai = KIND_ORDER.indexOf(a as SeaNodeKind)
    const bi = KIND_ORDER.indexOf(b as SeaNodeKind)
    // 已知 kind 永远排在前面（负数在前），两者都是 kind 时按 KIND_ORDER 的原顺序。
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    }
    return a.localeCompare(b)
  })
  const total = Math.max(1, list.length)
  const centers = new Map<string, { x: number; y: number; z: number }>()
  list.forEach((kind, index) => {
    // y 从 +1 线性降到 -1：先按「纬度」等分，再在纬线圈上取方位角，得到球面近似均匀分布。
    const y = total === 1 ? 0 : 1 - (index / (total - 1)) * 2
    const ring = Math.sqrt(Math.max(0, 1 - y * y))
    // 黄金角（π(3−√5)）依次旋转，避免所有簇挤在同一条经线上；+ 一点按 kind 的抖动，视觉上更散。
    const phi = index * Math.PI * (3 - Math.sqrt(5)) + rand(kind) * 0.6
    const radius = CLUSTER_RADIUS_BASE + rand(`${kind}r`) * CLUSTER_RADIUS_SPAN
    centers.set(kind, {
      x: round3(Math.cos(phi) * ring * radius),
      y: round3(y * radius * 0.82),
      z: round3(Math.sin(phi) * ring * radius),
    })
  })
  return centers
}

/**
 * 由 id 定死的坐标：簇心 + 一段方向（两段哈希取方位角/天顶角）+ 半径。
 *
 * 只依赖 id 与 kind，**与顺序、库的新旧无关**：同一个 id 永远落在同一个点，
 * 这样「上周的海」和「这周的海」可以直接对比，新增的点才是真的新增。
 *
 * 参数：`id` 节点 id、`kind` 决定半径倍率、`center` 所属簇心。
 * 返回：世界坐标（已 round3）。坑：`b` 用 `acos(2r−1)` 而不是直接乘 π，是为了球面均匀。
 */
function anchorOf(
  id: string,
  kind: SeaNodeKind,
  center: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const a = rand(`${id}a`) * TAU
  const b = Math.acos(2 * rand(`${id}b`) - 1)
  const rr = (16 + Math.pow(rand(`${id}r`), 0.65) * 120) * (KIND_RADIUS[kind] ?? 1)
  return {
    x: round3(center.x + Math.sin(b) * Math.cos(a) * rr),
    y: round3(center.y + Math.cos(b) * rr * 0.72),
    z: round3(center.z + Math.sin(b) * Math.sin(a) * rr),
  }
}

/** 保留 3 位小数：坐标精度足够（量级 ±500），又能让返回的 JSON 小一大截。 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * 标签截断：先把换行/连续空白压成一个空格，再按**字符数**截断（不是字节）。
 *
 * 参数：`text` 原文；`chars` 上限。返回：不超限的原样，超限的加「…」。
 * 注意是 `slice` 字符而非按宽度折行：中文宽度差不影响「够不够短」这个用途。
 */
function clip(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > chars ? `${flat.slice(0, chars)}…` : flat
}

/** 结论查询的行形状（`revision` 是 head 版本，不是全部历史）。 */
interface ArtifactRow {
  artifact_id: string
  kind: string
  revision: number
  state: string
  statement: string
  subject_refs: string
  independent_evidence_count: number
  created_at: string
  artifact_created_at: string
}

/** 经历查询的行形状。`type` 是事件类型（conversation / commitment …），前端当图例。 */
interface EventRow {
  event_id: string
  kind: string
  type: string
  text: string
  subject_refs: string
  at: string
}

/**
 * 解析 `/sea` 的时间窗口参数。
 *
 * 只接受能被 Date.parse 认出的时间串；非法值直接抛错，由路由转 400。
 * 空串视为未提供（前端清空输入框时会传空）。
 */
export function resolveSeaWindow(params: URLSearchParams): { from?: string; to?: string } {
  const rawFrom = params.get('from')
  const rawTo = params.get('to')
  const from = rawFrom ? rawFrom : undefined
  const to = rawTo ? rawTo : undefined
  if (from && Number.isNaN(Date.parse(from))) throw new Error('from 不是有效时间')
  if (to && Number.isNaN(Date.parse(to))) throw new Error('to 不是有效时间')
  if (from && to && Date.parse(from) > Date.parse(to)) throw new Error('from 晚于 to')
  return { from, to }
}

/**
 * 计算不透明的数据实例标识。
 *
 * 只用于客户端区分「同一份数据实例」：文件身份 + 人格身份哈希，不返回路径。
 * 任一可观测值缺失或不可靠时返回 null；此时上层关闭差异对比，不回退猜测值。
 */
function dataInstanceKey(db: Db): string | null {
  try {
    const real = realpathSync(db.file)
    const stat = statSync(real, { bigint: true })
    if (stat.ino === 0n || stat.dev === 0n) return null
    const personaFile = join(dirname(real), 'persona.json')
    if (!existsSync(personaFile)) return null
    const persona = JSON.parse(readFileSync(personaFile, 'utf8')) as {
      initialization?: { identityHash?: unknown }
    }
    const identityHash = persona.initialization?.identityHash
    if (typeof identityHash !== 'string' || identityHash.length === 0) return null
    return createHash('sha256')
      .update(`${real}\n${stat.dev}\n${stat.ino}\n${stat.birthtimeMs}\n${identityHash}`)
      .digest('hex')
      .slice(0, 16)
  } catch {
    return null
  }
}

/**
 * 组装一屏意识海。
 *
 * 参数：`db` 只读连接；`options` 见 `SeaOptions`。
 * 返回：`SeaScene`（永远 `ok:true`——算不出来是上层的事，这里不静默重试）。
 * 顺序：先取节点（结论 head 版 + 最近经历）→ 定坐标 → 再查四张关系表连边（只连两端都在屏上的）。
 * 边界：显著度整块失败只退回独立证据数；`truncated` 看是否撞到 LIMIT。
 */
export function buildSeaScene(db: Db, options: SeaOptions = {}): SeaScene {
  const artifactLimit = options.artifactLimit ?? DEFAULT_ARTIFACT_LIMIT
  const eventLimit = options.eventLimit ?? DEFAULT_EVENT_LIMIT
  const labelChars = options.labelChars ?? DEFAULT_LABEL_CHARS
  const from = options.from ?? null
  const to = options.to ?? null

  // 结论只取 head 版本（同 id 取 max(revision)，不先按 state 过滤，与 §11.3 一致）
  // 子查询在 JOIN 条件里求值：每个 artifact 只留 revision 最大的那行，避免把历史版本也画成点。
  // LIMIT 按 head 版本数算，`ORDER BY created_at DESC, artifact_id ASC` 表示超限时保留最近的；
  // 同一时间的并列项按 id 升序，保证截断集合可复现（SEA-V2-3 确定性截断）。
  const artifactRows = db.all<ArtifactRow>(
    `SELECT a.artifact_id, a.kind, a.created_at AS artifact_created_at,
            r.revision, r.state, r.statement, r.subject_refs,
            r.independent_evidence_count, r.created_at
       FROM artifacts a
       JOIN artifact_revisions r
         ON r.artifact_id = a.artifact_id
        AND r.revision = (SELECT MAX(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
      WHERE a.persona_id = ?
        AND (? IS NULL OR r.created_at >= ?)
        AND (? IS NULL OR r.created_at <= ?)
      ORDER BY r.created_at DESC, a.artifact_id ASC
      LIMIT ?`,
    [PERSONA_ID, from, from, to, to, artifactLimit],
  )
  const totalArtifacts = Number(
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM artifacts a
         JOIN artifact_revisions r
           ON r.artifact_id = a.artifact_id
          AND r.revision = (SELECT MAX(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
        WHERE a.persona_id = ?
          AND (? IS NULL OR r.created_at >= ?)
          AND (? IS NULL OR r.created_at <= ?)`,
      [PERSONA_ID, from, from, to, to],
    )?.n ?? 0,
  )

  // 经历按时间倒序取最近 eventLimit 条；同屏并列按 id 升序，保证截断集合可复现。
  const eventRows = db.all<EventRow>(
    `SELECT event_id, kind, type, text, subject_refs, at
       FROM events WHERE persona_id = ?
        AND (? IS NULL OR at >= ?)
        AND (? IS NULL OR at <= ?)
      ORDER BY at DESC, event_id ASC LIMIT ?`,
    [PERSONA_ID, from, from, to, to, eventLimit],
  )
  const totalEvents = Number(
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE persona_id = ?
        AND (? IS NULL OR at >= ?)
        AND (? IS NULL OR at <= ?)`,
      [PERSONA_ID, from, from, to, to],
    )?.n ?? 0,
  )

  const nodes: SeaNode[] = []
  const byKind: Record<string, number> = {}
  const byCluster: Record<string, number> = {}
  const now = options.now ?? Date.now()

  // 先决定「这个点归哪个簇」：subject_refs 的第一个值优先（关于谁/什么），
  // 没有 subject 时退回 kind（事实/看法/经历…）。簇数超过 MAX_CLUSTERS 时，
  // 出现次数少的 subject 统一归 'other'——球面上铺几十个主题会碎成一地小球。
  const keyOf = (subjects: string[], kind: string): string => subjects[0] ?? kind
  const clusterCount = new Map<string, number>()
  for (const row of artifactRows) {
    const key = keyOf(parseSubjects(row.subject_refs), row.kind ?? 'fact')
    clusterCount.set(key, (clusterCount.get(key) ?? 0) + 1)
  }
  for (const row of eventRows) {
    const key = keyOf(parseSubjects(row.subject_refs), 'event')
    clusterCount.set(key, (clusterCount.get(key) ?? 0) + 1)
  }
  const ranked = [...clusterCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const keep = new Set(ranked.slice(0, Math.max(1, MAX_CLUSTERS - 1)).map(([key]) => key))
  const clusterOf = (subjects: string[], kind: string): { key: string; name: string; subject: string | null } => {
    const raw = keyOf(subjects, kind)
    if (clusterCount.size > MAX_CLUSTERS && !keep.has(raw)) {
      return { key: 'other', name: '其他', subject: subjects[0] ?? null }
    }
    return { key: raw, name: subjectName(raw), subject: subjects[0] ?? null }
  }

  // 簇心只给真正用到的 key 铺位置：没有节点的簇不需要占一个球面方向。
  const usedKeys = new Set<string>()
  for (const row of artifactRows) usedKeys.add(clusterOf(parseSubjects(row.subject_refs), row.kind ?? 'fact').key)
  for (const row of eventRows) usedKeys.add(clusterOf(parseSubjects(row.subject_refs), 'event').key)
  const centers = clusterCenters([...usedKeys])

  // 亮度按显著度（v14 §21.2）：独立经历多、被复核过、有后果的点更亮。
  // 算不出来就退回「独立证据数」，不让整个海因为一块派生失败而空掉。
  // limit 取 max(artifactLimit, 120)：至少够覆盖这一屏的点，多算不会更贵。
  const salience = (() => {
    try {
      return new Map(
        deriveSalienceNow(db, { limit: Math.max(artifactLimit, 120) }).map((entry) => [
          entry.artifactId,
          entry,
        ]),
      )
    } catch {
      return new Map<string, { score: number; solid: boolean }>()
    }
  })()

  artifactRows.forEach((row) => {
    const kind = (row.kind as SeaNodeKind) ?? 'fact'
    const subjects = parseSubjects(row.subject_refs)
    const group = clusterOf(subjects, kind)
    const center = centers.get(group.key) ?? { x: 0, y: 0, z: 0 }
    const anchor = anchorOf(row.artifact_id, kind, center)
    const rated = salience.get(row.artifact_id)
    // 兜底权重 = 独立证据数（至少 1），让没有显著度的点也不至于完全看不见。
    const fallback = Math.max(1, Number(row.independent_evidence_count ?? 1))
    byKind[kind] = (byKind[kind] ?? 0) + 1
    byCluster[group.key] = (byCluster[group.key] ?? 0) + 1
    nodes.push({
      id: row.artifact_id,
      kind,
      label: clip(row.statement ?? '', labelChars),
      at: row.created_at ?? null,
      // 有显著度就 0.8 + score（保底 0.8，避免低分点缩成看不见）；没有就用证据数。
      weight: rated ? Math.round((0.8 + rated.score) * 100) / 100 : Math.round(fallback * 100) / 100,
      ...anchor,
      cluster: group.key,
      clusterName: group.name,
      subject: group.subject,
      createdAt: row.artifact_created_at ?? row.created_at ?? null,
      revisedAt: row.created_at ?? null,
      recency: recencyOf(row.created_at ?? null, now),
      meta: `${row.state ?? 'active'} · r${row.revision}${rated?.solid ? ' · 已固化' : ''}`,
    })
  })

  eventRows.forEach((row) => {
    const subjects = parseSubjects(row.subject_refs)
    const group = clusterOf(subjects, 'event')
    const center = centers.get(group.key) ?? { x: 0, y: 0, z: 0 }
    const anchor = anchorOf(row.event_id, 'event', center)
    byKind.event = (byKind.event ?? 0) + 1
    byCluster[group.key] = (byCluster[group.key] ?? 0) + 1
    nodes.push({
      id: row.event_id,
      kind: 'event',
      label: clip(row.text ?? '', Math.round(labelChars * 0.7)),
      at: row.at ?? null,
      weight: 1,
      ...anchor,
      cluster: group.key,
      clusterName: group.name,
      subject: group.subject,
      createdAt: row.at ?? null,
      revisedAt: row.at ?? null,
      recency: recencyOf(row.at ?? null, now),
      meta: row.type ?? row.kind ?? 'event',
    })
  })

  const known = new Set(nodes.map((node) => node.id))
  const edges: SeaEdge[] = []
  const seen = new Set<string>()
  // 去重键带上 kind 与方向：同一对节点可以既有 relation 又有 lineage，它们是两条不同的边。
  // 两端必须都在本屏（known）：库里有、但这屏没画的点不能连出来，否则线会指向虚空。
  const pushEdge = (a: string, b: string, kind: SeaEdgeKind, label: string): void => {
    if (!known.has(a) || !known.has(b) || a === b) return
    const key = `${kind}:${a}>${b}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ a, b, kind, label, score: EDGE_SCORE[kind] })
  }

  // 以下四段各查一张关系表；方向一律「先 a 后 b」，与 `SeaEdgeKind` 上的说明一致。
  for (const row of db.all<{ artifact_id: string; event_id: string }>(
    `SELECT t.artifact_id, t.event_id
       FROM artifact_trigger_events t
       JOIN artifacts a ON a.artifact_id = t.artifact_id
      WHERE a.persona_id = ?`,
    [PERSONA_ID],
  )) {
    pushEdge(row.event_id, row.artifact_id, 'trigger', '触发')
  }

  for (const row of db.all<{ artifact_id: string; target_artifact_id: string; relation: string }>(
    `SELECT r.artifact_id, r.target_artifact_id, r.relation
       FROM artifact_relations r
       JOIN artifacts a ON a.artifact_id = r.artifact_id
      WHERE a.persona_id = ?`,
    [PERSONA_ID],
  )) {
    pushEdge(row.artifact_id, row.target_artifact_id, 'relation', row.relation)
  }

  for (const row of db.all<{ artifact_id: string; from_artifact_id: string; relation: string }>(
    `SELECT l.artifact_id, l.from_artifact_id, l.relation
       FROM artifact_lineage l
       JOIN artifacts a ON a.artifact_id = l.artifact_id
      WHERE a.persona_id = ?`,
    [PERSONA_ID],
  )) {
    pushEdge(row.from_artifact_id, row.artifact_id, 'lineage', row.relation)
  }

  for (const row of db.all<{ event_id: string; target_event_id: string; relation: string }>(
    `SELECT e.event_id, e.target_event_id, e.relation
       FROM event_relations e
       JOIN events s ON s.event_id = e.event_id
      WHERE s.persona_id = ?`,
    [PERSONA_ID],
  )) {
    pushEdge(row.event_id, row.target_event_id, 'caused', row.relation)
  }

  // 弱连放在最后：真关系永远优先，它只补「跨簇但共享一个少见词」的那些空隙。
  const clusterById = new Map(nodes.map((node) => [node.id, node.cluster]))
  buildTopicEdges(nodes, (id) => clusterById.get(id) ?? 'event', pushEdge)

  const artifactCount = artifactRows.length
  const eventCount = eventRows.length
  // 统计在权限/时间窗口内、截断前；用总数判断是否还有没画出来的点。
  const truncated = totalArtifacts > artifactCount || totalEvents > eventCount
  // ISO 时间串按字典序排 = 按时间排（同格式带 Z），所以 sort() 不用比较器。
  const times = nodes.map((node) => node.at).filter((at): at is string => typeof at === 'string').sort()
  const instanceKey = dataInstanceKey(db)

  return {
    ok: true,
    instanceKey,
    diffAvailable: instanceKey !== null,
    nodes,
    edges,
    stats: {
      artifacts: artifactCount,
      events: eventCount,
      edges: edges.length,
      byKind,
      byCluster,
      truncated,
      totalArtifacts,
      totalEvents,
      displayedArtifacts: artifactCount,
      displayedEvents: eventCount,
      span: { from: times[0] ?? null, to: times[times.length - 1] ?? null },
    },
    note: truncated
      ? `当前窗口共 ${totalArtifacts} 条结论 / ${totalEvents} 条事件；这一屏显示 ${artifactCount} / ${eventCount} 条（其余仍在库里，只是不画）。`
      : '这一屏就是当前窗口内的全部记忆。',
  }
}
