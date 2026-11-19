// 面板数据聚合（v14 §7 / §24 的只读视图）。
//
// 职责：把 Runtime（库/启动记录/配置/偏好）和 Core（自我状态/成长派生）拼成一份 PanelPayload，
//   给 GET /api/psyche/panel 直接 JSON.stringify 出去。只做聚合，不做判断、不算阶段、不改库。
// 设计约定：
//   - 面板只读；写配置走插件设置页（宿主 Config），这里不回写 profile。
//   - 字段描述符（SettingsGroup）是唯一来源，将来面板可写时直接拿它渲染输入框。
//   - 所有值都用 JSON 安全的原始类型，渲染层不再二次解析。
// 约束：任何一段数据拿不到都退化成 null/[] 并往 notes 里写一句，绝不让整个面板 500——
//   启动失败时面板正是用户唯一能看到原因的地方。
// 调用方：src/index.ts 的 panel()（经 ctx.psyche 与路由两处），它只负责 await ready 后传 source。
import type { Db, DbHealth, OpenAttempt, SelfCheck } from './adapter.js'
import { PERSONA_ID, BANDS } from './store.js'
import type { Core, GrowthPayload, StatePayload } from './store.js'
import type { PanelPrefs } from './prefs.js'
import type { ErrorPayload } from './errors.js'
import { toErrorPayload } from './errors.js'
import type { InitSnapshot } from './persona-init.js'
import { deriveSalienceNow } from './cognition.js'
import type { SalienceEntry } from './salience.js'
import { foldWithinBudget } from './fold.js'
import type { FoldCandidate, FoldResult } from './fold.js'
import { behaviorOf, type BehaviorState } from './behavior.js'

/** 设置项的控件类型；面板按它选渲染组件，未识别的值按 text 兜底。 */
export type SettingKind = 'switch' | 'number' | 'select' | 'path' | 'text'
/** 生效时机：hot = 改完立刻生效；restart = 需要重启宿主（改的是启动期参数或库位置）。 */
export type SettingApply = 'hot' | 'restart'

/**
 * 一个设置项的完整描述（值 + 元数据）。
 * key 是配置里的点路径（如 `prompt.order`），面板写回时按它拼 patch；
 * apply 决定 UI 是否提示「需重启」；min/max/options/unit 只用于渲染控件，不做校验。
 */
export interface SettingsField {
  key: string
  label: string
  kind: SettingKind
  apply: SettingApply
  value: unknown
  unit?: string
  min?: number
  max?: number
  options?: string[]
  help: string
}

/** 一组设置项；hint 是组标题下的一句话，用来解释「这组为什么要重启」。 */
export interface SettingsGroup {
  id: string
  title: string
  hint?: string
  fields: SettingsField[]
}

/** 一条待批/历史提案。rationale 可为 null（模型没给理由）；status 是排队中/已批准/被拒的枚举值。 */
export interface ProposalRow {
  proposalId: string
  partition: string
  target: string
  change: string
  rationale: string | null
  status: string
  createdAt: string
}

/** 一条联系人 +（可能没有的）关系档位。band 来自 LEFT JOIN，没有关系状态时为 null。 */
export interface ContactRow {
  contactId: string
  platform: string
  stableUserId: string
  displayName: string | null
  band: string | null
  bandLabel: string | null
}

/** 一道成长闸的展示行：label 已拼成「信任：有成熟信念：已过」，前端不用再判 passed。 */
export interface GrowthGateRow {
  gate: string
  label: string
  passed: boolean
  need: string
  have: string
}

/** 成长面板：stage 是权威阶段，其余是展示辅助；派生层不可用时整个对象为 null。 */
export interface GrowthPanel {
  stage: string
  stageLabel: string
  since: string | null
  stalledAt: string | null
  bottleneck: string | null
  gates: GrowthGateRow[]
  algorithmVersion: string
  derivationNote: string
}

/** 显著度排序里的一行（P2 §21.2）：score 只用于排序展示，solid 表示证据是否够硬。 */
export interface SalienceRow {
  artifactId: string
  kind: string
  statement: string
  score: number
  solid: boolean
  reasons: string[]
}

/** 「若此刻注入会长什么样」的预览：预算与用量都带上，前端据此画进度条。 */
export interface FoldPreview {
  lines: { id: string; text: string; truncated: boolean }[]
  foldedCount: number
  foldedLine: string | null
  usedChars: number
  usedTokens: number
  budgetChars: number
  budgetTokens: number
}

/**
 * 面板的完整返回体。字段全部是 JSON 安全值，可直接序列化。
 * 读法：ok=false 时看 error/attempts/selfCheck；ok=true 时 state/growth 仍可能为 null（各自失败）。
 */
export interface PanelPayload {
  ok: boolean
  enabled: boolean
  driver: string | null
  dataDir: string
  startedAt: string
  selfCheck: SelfCheck | null
  attempts: OpenAttempt[]
  error: ErrorPayload | null
  storage: DbHealth | null
  state: StatePayload | null
  growth: GrowthPanel | null
  /** 人格初始化状态（I-7 §22.12）：首启横幅据此渲染；locked 时横幅不出现。 */
  personaInit: InitSnapshot | null
  /** 初始化状态判定失败的原因（只影响横幅提示，不影响面板其它部分）。 */
  personaInitError: string | null
  /** 显著度最高的几条结论（P2 §21.2；只用于排序，不注入模型）。 */
  salience: SalienceRow[]
  /** 「如果现在注入，会是这样」的折叠预览（budget 取 §10.1 的默认值）。 */
  fold: FoldPreview | null
  proposals: ProposalRow[]
  contacts: ContactRow[]
  settings: SettingsGroup[]
  /** 面板视图偏好（开关状态由它驱动；`settings` 里也有同名的开关项）。 */
  prefs: PanelPrefs
  /**
   * C 阶段：三个记忆功能的**运行时实际生效**状态。
   * 面板只认这个字段，不回显配置文件里的字面值——配置可能被默认值 / 旧字段覆盖。
   * 类型直接复用 `BehaviorState`（唯一计算点）。
   */
  behavior: BehaviorState
  notes: string[]
}

/**
 * buildPanel 的输入：由 index.ts 从 Runtime 里原样摘出来。
 * core 为 null 表示 boot 还没到 Core 那一步（或库开不起来），此时只靠启动记录渲染。
 */
export interface PanelSource {
  dataDir: string
  enabled: boolean
  driver: string | null
  startedAt: string
  selfCheck: SelfCheck | null
  attempts: OpenAttempt[]
  bootError: unknown
  db: Db | null
  core: Core | null
  config: PanelConfig
  prefs: PanelPrefs
  personaInit?: InitSnapshot | null
  personaInitError?: string | null
}

/** index.ts 的 PsycheConfig 子集；避免与入口文件形成类型环。 */
export interface PanelConfig {
  enabled?: boolean
  dataDir?: string
  storage?: { driver?: string; db?: string }
  independence?: { activityWindowMinutes?: number }
  affinity?: { neutral?: number }
  prompt?: { section?: boolean; order?: number }
  persona?: { enabled?: boolean; dominance?: boolean; expression?: boolean; maxChars?: number; maxTokens?: number }
  inject?: { budgetTokens?: number; budgetChars?: number }
  performance?: { slowQueryMs?: number; slowWarnMs?: number }
  capture?: { enabled?: boolean }
  injection?: { enabled?: boolean }
  /** @deprecated 仅用于识别旧 profile；最终完整性检查强制开启，此字段不生效。 */
  finalCheck?: unknown
}

// 阶段与闸门的文案表：key 必须与 store 的阶段枚举一致；这里只翻译，不参与判断。
// 找不到对应 key 时下游会退回原始英文值（见 growthPanelOf），不会崩。
const STAGE_LABELS: Record<string, string> = {
  trust: '信任',
  autonomy: '自主',
  initiative: '主动',
  integration: '整合',
}

const GATE_LABELS: Record<string, string> = {
  trust: '信任：有成熟信念',
  autonomy: '自主：两次有效拒绝',
  initiative: '主动：两次实质修正',
  integration: '整合：复盘并确认',
}

/**
 * 把关系档位枚举翻成人话标签。
 * 返回 null 表示「还没有关系状态」；未知档位原样返回，方便排查数据里出现了新值。
 */
function bandLabelOf(band: string | null): string | null {
  if (!band) return null
  const rule = BANDS.find((item) => item.band === band)
  return rule ? rule.label : band
}

/**
 * 生成设置页的六组字段描述（面板分组 → 存储 → 记忆 → 注入 → 性能 → 数据）。
 * 参数 cfg：插件启动期配置；prefs：数据目录里的视图偏好（只覆盖 panel.sea / prompt.section）。
 * 返回：可直接渲染的 SettingsGroup[]；值都取「配置缺省 → 默认值」折叠后的实际生效值。
 * 副作用：无（纯函数）。
 * 注意：这里只描述、不校验——写回由宿主设置页做，改这里不会改变运行时行为。
 */
function settingsGroups(cfg: PanelConfig, prefs: PanelPrefs): SettingsGroup[] {
  const storage = cfg.storage ?? {}
  const perf = cfg.performance ?? {}
  // prompt 的开关有两条来源：偏好优先（用户点过），没表过态（null）才退回配置。
  // 与 index.ts 的 promptEnabled() 必须保持一致，否则面板显示与实际注入会不一致。
  const promptOn = prefs.promptSection ?? cfg.prompt?.section !== false
  return [
    {
      id: 'panel',
      title: '面板',
      hint: '这几项改完立刻生效，不用重启。',
      fields: [
        {
          key: 'panel.sea',
          label: '显示意识海',
          kind: 'switch',
          apply: 'hot',
          // 面板内开关存 prefs 而不是 Config：它只影响视图，不该改插件行为配置。
          value: prefs.sea,
          help: '打开后侧栏最后多一个「意识海」页签；关掉就完全不画，省资源',
        },
      ],
    },
    {
      id: 'storage',
      title: '存储',
      hint: '改这两项要重启宿主才生效。',
      fields: [
        {
          key: 'storage.driver',
          label: '数据库驱动',
          kind: 'select',
          apply: 'restart',
          // 顺序即优先级：auto 的自检顺序由 adapter 决定，这里只列出可选项。
          options: ['auto', 'node:sqlite', 'better-sqlite3'],
          value: storage.driver ?? 'auto',
          help: 'auto 会按 node:sqlite → better-sqlite3 顺序自检',
        },
        {
          key: 'storage.db',
          label: '库文件名',
          kind: 'path',
          apply: 'restart',
          value: storage.db ?? 'memory.sqlite3',
          help: '相对数据目录；改名等于换一个新库，旧库不会被删',
        },
      ],
    },
    {
      id: 'memory',
      title: '记忆',
      hint: '影响「几条证据算独立」。',
      fields: [
        {
          key: 'independence.activityWindowMinutes',
          label: '活动窗口（分钟）',
          kind: 'number',
          apply: 'hot',
          // 窗口越界没有意义：1 分钟以下几乎不合并，120 分钟以上会把一天算成一条。
          min: 1,
          max: 120,
          value: cfg.independence?.activityWindowMinutes ?? 10,
          unit: '分钟',
          help: '同一窗口内的多条消息只算一条独立证据',
        },
        {
          key: 'affinity.neutral',
          label: '初始好感',
          kind: 'number',
          apply: 'restart',
          // 改它只影响「以后新建的关系」，已有联系人的档位不会被重算——所以标 restart。
          min: 0,
          max: 100,
          value: cfg.affinity?.neutral ?? 50,
          help: '新人第一次见面时的起点值；好感分数本身不对外显示',
        },
      ],
    },
    {
      id: 'prompt',
      title: '注入',
      fields: [
        {
          key: 'prompt.section',
          label: '注入记忆纪律',
          kind: 'switch',
          apply: 'hot',
          value: promptOn,
          help: '关掉后模型看不到写入纪律，仍可调用工具',
        },
        {
          key: 'prompt.order',
          label: '段落顺序',
          kind: 'number',
          apply: 'hot',
          min: 0,
          max: 200,
          value: cfg.prompt?.order ?? 60,
          help: '数字小的先出现在系统提示里',
        },
      ],
    },
    {
      id: 'persona',
      title: '人格',
      hint: '这三项要重启宿主才生效；改动以 DSH 插件配置为准。',
      fields: [
        {
          key: 'persona.enabled',
          label: '人格注入',
          kind: 'switch',
          apply: 'restart',
          value: cfg.persona?.enabled !== false,
          help: '关闭后不读 identity.md，也不注册人格段',
        },
        {
          key: 'persona.dominance',
          label: '人格主导',
          kind: 'switch',
          apply: 'restart',
          value: cfg.persona?.dominance === true,
          help: '替换宿主 coding-agent 身份句，并让出旧人格 Context；默认关',
        },
        {
          key: 'persona.expression',
          label: '表达约束',
          kind: 'switch',
          apply: 'restart',
          value: cfg.persona?.expression !== false,
          help: '仅在人格主导开启时追加 ≤120 字表达段',
        },
      ],
    },
    {
      id: 'performance',
      title: '性能',
      fields: [
        {
          key: 'performance.slowQueryMs',
          label: '慢查询阈值',
          kind: 'number',
          apply: 'hot',
          min: 10,
          max: 5000,
          value: perf.slowQueryMs ?? 50,
          unit: 'ms',
          help: '超过就记一次慢查询',
        },
        {
          key: 'performance.slowWarnMs',
          label: '慢查询警告',
          kind: 'number',
          apply: 'hot',
          // 警告阈值应高于记录阈值（200 > 50）：这里不做交叉校验，靠默认值与文案约束。
          min: 50,
          max: 20000,
          value: perf.slowWarnMs ?? 200,
          unit: 'ms',
          help: '超过就写警告日志',
        },
      ],
    },
    {
      id: 'data',
      title: '数据',
      hint: '改数据目录等于换一个库，旧库不会被删。',
      fields: [
        {
          key: 'enabled',
          label: '启用插件',
          kind: 'switch',
          apply: 'restart',
          // 只有显式 false 才算关闭（与 ConfigSchema 的 default 语义一致），undefined 视为开。
          value: cfg.enabled !== false,
          help: '关掉后不启动数据库，工具仍会报「没准备好」',
        },
        {
          key: 'dataDir',
          label: '数据目录',
          kind: 'path',
          apply: 'restart',
          // 显示原始配置值而不是解析后的绝对路径：留空才表示「用默认」，回填绝对路径会固化默认值。
          value: cfg.dataDir ?? '',
          help: '留空用 $DSH_HOME/psyche',
        },
      ],
    },
  ]
}

/**
 * 读最近 50 条提案（新→旧）。
 * 参数 db：已打开的库；返回 proposal 的驼峰视图。
 * 这里用裸 SQL 而不是 Core：Core 没有「列提案」的读接口（提案队列是给人看的，模型不查）。
 * 副作用：只读。失败（表缺失/库损坏）时返回 [] 而不是抛——面板缺一块比整页 500 好。
 */
function queryProposals(db: Db): ProposalRow[] {
  try {
    return db
      .all<{
        proposal_id: string
        partition: string
        target: string
        change: string
        rationale: string | null
        status: string
        created_at: string
      }>(
        // 固定 PERSONA_ID：这个包只服务单人格（v13 §3），多租户不在 P1 范围。
        `SELECT proposal_id, partition, target, change, rationale, status, created_at
           FROM proposals WHERE persona_id = ? ORDER BY created_at DESC LIMIT 50`,
        [PERSONA_ID],
      )
      .map((row) => ({
        proposalId: row.proposal_id,
        partition: row.partition,
        target: row.target,
        change: row.change,
        rationale: row.rationale,
        status: row.status,
        createdAt: row.created_at,
      }))
  } catch {
    // 吞掉异常是刻意的：调用方只在乎「有没有数据」，错误细节在 notes / 宿主日志里。
    return []
  }
}

/**
 * 读最近 50 个联系人，并用 LEFT JOIN 带上关系档位（没建立关系状态的联系人 band 为 null）。
 * 参数 db：已打开的库。返回已翻译 bandLabel 的行。
 * 副作用：只读。失败同样退化成 []，不阻塞面板其余部分。
 */
function queryContacts(db: Db): ContactRow[] {
  try {
    return db
      .all<{
        contact_id: string
        platform: string
        stable_user_id: string
        display_name: string | null
        band: string | null
      }>(
        // LEFT JOIN 而不是 INNER JOIN：刚认识、还没算档位的联系人也必须显示出来。
        // persona_id 条件同时写在 ON 与 WHERE 里，是为了不把「关系状态属于别人格」的行带进来。
        `SELECT c.contact_id, c.platform, c.stable_user_id, c.display_name, a.band
           FROM contacts c
           LEFT JOIN relationship_affinity_state a
             ON a.contact_id = c.contact_id AND a.persona_id = c.persona_id
          WHERE c.persona_id = ?
          ORDER BY c.updated_at DESC LIMIT 50`,
        [PERSONA_ID],
      )
      .map((row) => ({
        contactId: row.contact_id,
        platform: row.platform,
        stableUserId: row.stable_user_id,
        displayName: row.display_name,
        band: row.band,
        bandLabel: bandLabelOf(row.band),
      }))
  } catch {
    return []
  }
}

/**
 * 成长面板：数据来自派生层（§21–§22），不再读 `phase_state` 当真相。
 * 参数 growth：Core.getGrowth 的派生结果（null = 派生失败或库没起来）；state：自我状态，仅用于补字段。
 * 返回：可直接渲染的 GrowthPanel；派生层不可用时返回 null，面板显示「不可用」而不是伪造闸门。
 * 副作用：无（纯映射，不写库、不推进阶段）。
 */
function growthPanelOf(growth: GrowthPayload | null, state: StatePayload | null): GrowthPanel | null {
  // 没有派生结果就整体为 null：宁可让前端显示「不能算」，也不要拿 phase_state 的旧值冒充。
  if (!growth) return null
  return {
    stage: growth.stage,
    stageLabel: growth.stageLabel,
    // since 优先取派生层的；派生层没给时退回 state 里记录的阶段起点。
    since: growth.since ?? state?.phase.since ?? null,
    stalledAt: state?.phase.stalledAt ?? null,
    // bottleneck 是枚举值，bottleneckReason 是给人看的补充；补白后为空则退回枚举本身。
    bottleneck: growth.bottleneck ? `${growth.bottleneckReason || ''}`.trim() || growth.bottleneck : null,
    // 闸门按后端给的顺序原样映射：顺序即「从下往上」的推进顺序，前端不要重排。
    gates: growth.gates.map((gate) => ({
      gate: gate.gate,
      label: `${gate.label}：${gate.passed ? '已过' : '未过'}`,
      passed: gate.passed,
      need: String(gate.need),
      have: String(gate.have),
    })),
    algorithmVersion: growth.algorithmVersion,
    // advanced 只有 syncGrowth 写过之后才非空；只读路径下恒为空，走 else 分支说明「这次只是看一眼」。
    derivationNote:
      growth.advanced.length > 0
        ? `刚推进了 ${growth.advanced.length} 个阶段（${growth.advanced
            .map((item) => `${item.fromPhaseLabel}→${item.toPhase}（${item.milestoneId}）`)
            .join('，')}）。`
        : `纯读派生，不改库：一起待了 ${growth.elapsedDays} 天；成熟信念 ${growth.counts.matureBeliefs} 条、有效拒绝 ${growth.counts.refusals} 次、实质修正 ${growth.counts.corrections} 次。`,
  }
}

/**
 * 把任意启动期错误折成 ErrorPayload。
 * 返回 null 表示启动成功；否则是 { ok:false, code, error, detail? }，可直接塞进 PanelPayload.error。
 * 副作用：无（toErrorPayload 只做形状转换，不打日志）。
 */
function errorPayloadOf(error: unknown): ErrorPayload | null {
  // 用 !error 而不是 === null：bootError 可能是 undefined 或空串，都算「没有错误」。
  if (!error) return null
  return toErrorPayload(error)
}

/** §10.1 的四段地板：人格约定 150 + 当前自我 80 + 当前关系 100 + 当前感受 80。 */
const FOLD_FLOOR_TOKENS = 410

/** 地板按每 token 约 1.6 字折算，得出竞争段的字符预算。 */
const CHARS_PER_TOKEN = 1.6

/**
 * 取显著度最高的若干条结论，裁成渲染行。
 * 参数 entries：deriveSalienceNow 的输出（已按分数降序）；limit 默认 8，就取前 8 条。
 * 返回：只保留展示需要的字段；reasons 原样带出（前端 hover 用）。
 * 副作用：无。注意这里不做二次排序，顺序完全依赖派生层。
 */
function salienceRowsOf(entries: readonly SalienceEntry[], limit = 8): SalienceRow[] {
  return entries.slice(0, limit).map((entry) => ({
    artifactId: entry.artifactId,
    kind: entry.kind,
    statement: entry.statement,
    score: entry.score,
    solid: entry.solid,
    reasons: entry.reasons,
  }))
}

/**
 * 折叠预览：拿同一份显著度排序，按 §10.1 的地板口径扣掉必留段后塞预算。
 * 参数 entries：显著度排序；cfg：用来取注入预算（缺省 1500 tokens / 800 字）。
 * 返回：裁剪结果 + 用量；注意它**只是预览**——真正注入由 P2 的 Prompt Composer 接管，
 *   这里先让人看见「会塞进去什么」。
 * 副作用：无（纯计算，不写库、不改 prefs）。
 */
function foldPreviewOf(entries: readonly SalienceEntry[], cfg: PanelConfig): FoldPreview | null {
  // 预算就地取配置并清成非负整数：负数会让 foldWithinBudget 直接返回空，等于静默失效。
  const budgetTokens = Math.max(0, Math.trunc(cfg.inject?.budgetTokens ?? 1500))
  const budgetChars = Math.max(0, Math.trunc(cfg.inject?.budgetChars ?? 800))
  // 先扣掉四段地板才是「竞争段」的可用预算；扣成负数时归 0，仍会走 foldWithinBudget 的空结果分支。
  const remainTokens = Math.max(0, budgetTokens - FOLD_FLOOR_TOKENS)
  const remainChars = Math.max(0, Math.trunc(budgetChars - FOLD_FLOOR_TOKENS / CHARS_PER_TOKEN))

  // 只挑折叠器需要的字段：FoldCandidate 与 SalienceEntry 结构不同，不能直接传。
  const candidates: FoldCandidate[] = entries.map((entry) => ({
    id: entry.artifactId,
    kind: entry.kind,
    text: entry.statement,
    score: entry.score,
    solid: entry.solid,
  }))
  // 60 字/条是展示口径：再长就截断（结果里的 truncated 会标出来），保证一屏能看完。
  const result: FoldResult = foldWithinBudget(candidates, {
    maxChars: remainChars,
    maxTokens: remainTokens,
    perItemChars: 60,
  })
  return {
    // lines 只透传展示字段，别把 FoldResult 的内部结构泄漏给前端（它还有调试用的原始长度）。
    lines: result.lines.map((line) => ({ id: line.id, text: line.text, truncated: line.truncated })),
    foldedCount: result.foldedCount,
    foldedLine: result.foldedLine,
    usedChars: result.usedChars,
    usedTokens: result.usedTokens,
    budgetChars: result.budgetChars,
    budgetTokens: result.budgetTokens,
  }
}

/**
 * 组装面板返回体：GET /api/psyche/panel 的全部内容都在这里产出。
 * 参数 source：index.ts 从 Runtime 摘出来的快照（db/core 可能为 null）。
 * 返回：PanelPayload；从不抛——每段数据各自 try/catch，失败就退化成 null/[] 并写进 notes。
 * 副作用：只读查询 + db.health()（会跑 PRAGMA/statSync 并记入慢查询统计，所以别放进热循环）。
 */
export async function buildPanel(source: PanelSource): Promise<PanelPayload> {
  // state / growth 分开 try：一个挂了不该把另一个也清零，面板能显示半份也比全空强。
  let state: StatePayload | null = null
  let growth: GrowthPayload | null = null
  if (source.core) {
    try {
      // audit:false：面板轮询很频繁，不追审计记录，避免把 audit 表刷满。
      state = await source.core.getState({ audit: false })
    } catch {
      state = null
    }
    try {
      // 纯读派生：只算不写库（v14 §30）。里程碑由写路径尾钩与启动期的 syncGrowth() 落。
      growth = await source.core.getGrowth({ audit: false })
    } catch {
      growth = null
    }
  }
  const notes: string[] = []
  // notes 是给用户看的「为什么这块是空的」，三类原因分开写，别合成一句笼统的「加载失败」。
  if (!source.core) notes.push('数据库还没准备好；下面的信息来自启动记录。')
  if (source.core && !state) notes.push('读取自我状态失败，请查看宿主日志。')
  if (source.core && !growth) notes.push('成长派生失败，阶段按库里最后写入的值显示。')

  // 显著度与折叠都是只读派生（P2 §21.2）：算不出来就空着，不编。
  let salienceEntries: SalienceEntry[] = []
  if (source.db) {
    try {
      // limit 120 足够覆盖前 8 名的取舍空间，又不至于把整库结论都拉出来算分。
      salienceEntries = deriveSalienceNow(source.db, { limit: 120 })
    } catch {
      salienceEntries = []
      notes.push('显著度派生失败，这次先按更新时间排序。')
    }
  }

  return {
    ok: !source.bootError,
    enabled: source.enabled,
    driver: source.driver,
    dataDir: source.dataDir,
    startedAt: source.startedAt,
    selfCheck: source.selfCheck,
    attempts: source.attempts,
    error: errorPayloadOf(source.bootError),
    // health() 只在库存在时调：它是「真读」，会跑 PRAGMA 并计入慢查询统计。
    storage: source.db ? source.db.health() : null,
    state,
    growth: growthPanelOf(growth, state),
    // 初始化状态原样透出：面板横幅是唯一消费者，这里不做判断（locked 与否由前端决定显不显示）。
    personaInit: source.personaInit ?? null,
    personaInitError: source.personaInitError ?? null,
    salience: salienceRowsOf(salienceEntries),
    // 没有显著度就不给预览：空数组时 foldPreviewOf 只会产出一堆 0，反而误导。
    fold: salienceEntries.length > 0 ? foldPreviewOf(salienceEntries, source.config ?? {}) : null,
    proposals: source.db ? queryProposals(source.db) : [],
    contacts: source.db ? queryContacts(source.db) : [],
    settings: settingsGroups(source.config ?? {}, source.prefs),
    prefs: source.prefs,
    // 三个记忆功能的生效状态：与启动审计、状态接口共用 lib/behavior.ts 的同一套规则。
    behavior: behaviorOf(source.config ?? {}),
    notes,
  }
}
