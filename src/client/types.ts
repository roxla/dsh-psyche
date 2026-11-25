// 心灵 · 浏览器半侧：类型接线图
//
// 只描述我们用到的字段：服务端多给无所谓，少给由各处的 `?? fallback` 兜住，不做运行时校验。


// ── 类型（只描述我们用到的字段，避免和宿主类型体系耦合）──────────
// 这些 interface 是「接线图」而非 API 契约：服务端多给字段无所谓，
// 少给的字段由下面各处的 `?? fallback` 兜住，不做运行时校验。
/** 设置表单里的一个字段：kind 决定控件形态，apply='restart' 表示改完要重启。 */
interface FieldView {
  key: string
  label: string
  kind: string
  apply: string
  value: unknown
  unit?: string
  min?: number
  max?: number
  options?: string[]
  help: string
}
/** 一组设置字段；设置页按它拆成「热开关」和「只读镜像」两类卡。 */
interface GroupView {
  id: string
  title: string
  hint?: string
  fields: FieldView[]
}
/** 成长阶段的一道闸门。passed 由服务端算，前端只画 ✓ / ·，不参与判定。 */
interface GateView {
  gate: string
  label: string
  passed: boolean
  need: string
  have: string
}
/** 心灵提给自己的设定改动：只排队等人批，面板不提供批准入口。 */
interface ProposalView {
  proposalId: string
  partition: string
  target: string
  change: string
  rationale: string | null
  status: string
  createdAt: string
}
/** 认识的人。bandLabel 只给档位名——好感不暴露分数。 */
interface ContactView {
  contactId: string
  platform: string
  displayName: string | null
  band: string | null
  bandLabel: string | null
}
/** 初始化状态快照（服务端 persona-init 的展示子集；前端不推断，只按 state 渲染）。 */
interface InitSnapshotView {
  state: 'uninitialized' | 'initializing' | 'locked' | 'identity-drift' | 'damaged'
  personaId: string
  presetId: string | null
  presetName: string | null
  presetVersion: string | null
  draft: boolean
  initializedAt: string | null
  lockedAt: string | null
  identityHash: string | null
  identityBytes: number | null
  hashMatches: boolean | null
  claim: {
    kind: string
    pid: number | null
    startedAt: string | null
    ownerAlive: boolean | null
    presetId: string | null
  } | null
  detail: string
  actions: string[]
  files: { identity: boolean; persona: boolean }
}
/** GET /api/psyche/init 返回的预设展示行（不含人设正文）。 */
interface PresetRow {
  id: string
  name: string
  version: string
  summary: string
  recommended: boolean
  draft: boolean
}
/** 记忆规模计数，纯展示，不参与任何逻辑分支。 */
interface CountsView {
  sources: number
  events: number
  artifacts: number
  revisions: number
  operations: number
  proposals: number
  pendingWrites: number
  activityWindows: number
}
/**
 * GET /api/psyche/panel 的整包快照：状态 / 设置 / 提案 / 关系四个页签都吃它。
 * 几乎每块都可能为 null（数据库没就绪、旧服务端），所以消费方必须逐块判空；
 * 只有 prefs 与 notes 是必定存在的。
 */
interface PanelData {
  ok: boolean
  enabled: boolean
  driver: string | null
  startedAt: string
  error: { code?: string; error?: string; detail?: unknown } | null
  storage: Record<string, any> | null
  selfCheck: {
    ok: boolean
    items: { name: string; ok: boolean; detail: string }[]
    backupMode: string | null
    journalMode: string | null
  } | null
  state: {
    persona: { id: string; type: string; identityPath: string | null }
    self: { view: string; revision: number; updatedAt: string | null }
    phase: { phase: string; since: string | null; stalledAt: string | null }
    counts: CountsView
  } | null
  // 成长阶段与闸门。null = 数据库还没准备好，状态页会整卡跳过。
  growth: {
    stage: string
    stageLabel: string
    since: string | null
    stalledAt: string | null
    bottleneck: string | null
    gates: GateView[]
    algorithmVersion: string
    derivationNote: string
  } | null
  // 人格初始化状态（I-7）：首启横幅据此渲染；locked 时横幅不出现。
  personaInit: InitSnapshotView | null
  personaInitError: string | null
  /**
   * C 阶段：三个记忆功能的运行时生效状态（服务端算好，前端只显示）。
   * finalCheck 恒为 true；source 固定是宿主插件设置页；legacy 是旧配置迁移提示，
   * warnings 是非法配置告警——两者都只展示，不回写配置。
   */
  behavior: {
    capture: boolean
    injection: boolean
    finalCheck: true
    source: 'host-settings'
    legacy: string[]
    warnings: string[]
  } | null
  // 重要度榜：score 只用于排序，前端不拿它做任何判断。
  salience: {
    artifactId: string
    kind: string
    statement: string
    score: number
    solid: boolean
    reasons: string[]
  }[]
  // 现在的上下文折叠预览：lines 是进模型的那几行，foldedLine 是被折叠的统计。
  fold: {
    lines: { id: string; text: string; truncated: boolean }[]
    foldedCount: number
    foldedLine: string | null
    usedChars: number
    usedTokens: number
    budgetChars: number
    budgetTokens: number
  } | null
  proposals: ProposalView[]
  contacts: ContactView[]
  // 设置页的原始分组，和宿主插件设置页是同一份 schema。
  settings: GroupView[]
  // sea 控制意识海页签；promptSection 为 null 表示跟随宿主配置。
  prefs: { sea: boolean; promptSection: boolean | null }
  notes: string[]
}

/** 33 维里的一个维度（B4 面板只读展示）。value 是衰减后的有效值。 */
interface MoodDimensionView {
  key: string
  label: string
  layer: string
  value: number
  baseline: number
  halfLifeHours: number
}
/** GET /api/psyche/mood 的快照：当前语气 + 33 维 + 真实写入快照。 */
interface MoodView {
  ok: boolean
  tone: { tone: string; secondary: string | null; neutral: boolean; projectionVersion: number }
  groups: {
    basic: MoodDimensionView[]
    compound: MoodDimensionView[]
    contemporary: MoodDimensionView[]
  }
  /** 真实写入快照：at 是 UTC，values 是写入当时的原始值（不衰减）。 */
  history: { at: string; values: Record<string, number> }[]
  historyLimit: number
  historyTotal: number
}

/** GET /api/psyche/qq 的只读快照：计数全部是本次进程启动以来。 */
interface QqAdminView {
  ok: boolean
  enabled: boolean
  /** 桥接启动失败的原因；`enabled: false` 且这里非空说明是故障不是没开。 */
  startError?: string | null
  failedEpoch?: number
  connection: 'connected' | 'degraded' | 'disconnected' | 'unknown'
  reconnect?: {
    attempts: number
    mode: 'idle' | 'fast' | 'slow'
    lastAttemptAt: string | null
    nextAttemptAt: string | null
  }
  account: { uinMasked: string | null; nickname: string | null; online: boolean | null }
  allowFrom: {
    ownerConfigured: boolean
    ownerMasked: string | null
    extraCount: number
    extraMasked: string[]
    groupsCount?: number
    groupsMasked?: string[]
  }
  counts: {
    received: number
    delivered: number
    sendErrors: number
    rejected: number
    rejectReplies: number
    rateLimitedDrops: number
    rejectSendErrors: number
    outOfScopeDrops: number
    contactSuppressed: number
  }
  activity: { lastHeartbeatAt: string | null; lastMessageAt: string | null; lastSentAt: string | null }
  logs: { seq: number; at: string; level: 'info' | 'warn' | 'error'; message: string }[]
  /**
   * 只读「待投递提醒」（第 12 轮评审）。
   *
   * `scheduledAt` 是**预计最早发送时间**，来源是队列行的 `retry_at`（未入队时退回提醒行的
   * `next_attempt_at`）；为 `null` 时按 `state` 解释：`due` = 等待调度，`queued` = 已入队等待发送，
   * `paused` = 暂无可用时段。发送结果不确定（`pending/unknown/unknown`）的提醒不在这里出现，也不计入 `total`。
   */
  pendingReminders?: {
    items: { reminderId: string; dueAt: string; scheduledAt: string | null; state: 'due' | 'queued' | 'waiting' | 'paused' }[]
    total: number
    /** P1-C：结果不确定、等 Owner 裁决的条数；不进 items/total。 */
    awaitingVerdict?: number
  }
}

/** GET /api/psyche/qq/diagnostics 的只读事件；不含正文、URL 与完整身份。 */
interface QqDiagnosticEventView {
  seq: number
  at: string
  direction: 'in' | 'out'
  platform: 'qq'
  target: 'private' | 'group'
  contactRef: string | null
  roomRef: string | null
  result: 'accepted' | 'delivered' | 'rejected' | 'rate_limited' | 'out_of_scope' | 'deduplicated' | 'failed' | 'unknown'
  errorCode: string | null
  quote: 'applied' | 'omitted-unbound' | 'omitted-unsupported' | null
  media: { type: string; count: number }[]
  textLength: number | null
}

interface QqDiagnosticPageView {
  ok: boolean
  items: QqDiagnosticEventView[]
  nextBefore: number | null
  matched: number
}

/**
 * GET /api/psyche/qq/workspace 的五态卡。
 *
 * 宿主没有 workspace/list，卡是由 `workspace/follow` 的 baseline 现读现判的，
 * 所以 `memberCount` 可能是 null（读不到清单）——界面要显示「未知」而不是 0。
 */
interface QqWorkspaceCardView {
  ok: boolean
  state: 'registered' | 'unverified' | 'unavailable' | 'pending' | 'needs-review'
  label: string
  reason: string
  expectedTitle: string
  cwd: string
  cwdSource: 'config' | 'default' | 'unknown'
  workspaceId: string | null
  actualTitle: string | null
  memberCount: number | null
  /** 成员会话 id；`null` 表示只拿到个数，核对不了「是不是这条」。 */
  memberIds: string[] | null
  /** 本进程最近一次会话级登记针对的会话 id；`null` 表示没登记过。 */
  targetSessionId: string | null
  /** 当前回执的进程内序号；同一毫秒重新登记时用它区分两次回执。 */
  attemptSeq: number | null
  /** 这次的缺失可能只是读回早于登记（宿主会自己补读一次）。 */
  pendingReadback: boolean
  /** 成员核验：清单里有它 / 没有它 / 读不到成员 id。与「登记回执」是两件事。 */
  memberVerify: 'contains' | 'missing' | 'unknown'
  /** 这次读回的发起时间。 */
  readAt: string | null
  attempt: { at: string; step: string; ok: boolean; error?: string; sessionId?: string; seq?: number } | null
  checkedAt: string
}

/** 意识海里的一个点。x/y/z 由服务端按 id 与簇心算好，前端只做投影与漂移。 */
interface SeaNodeView {
  id: string
  kind: string
  label: string
  at: string | null
  // 独立证据数：点的大小与标签优先级都按它加权，不是置信度。
  weight: number
  x: number
  y: number
  z: number
  cluster?: string
  // 簇的显示名（subject 原文截断 / kind 中文 / 「其他」）与具体 subject。
  clusterName?: string
  subject?: string | null
  // 新鲜度 0–1：越新越亮，前端只做乘法。
  recency?: number
  meta: string
}
/** 两个点之间的关系线；score 缺省时前端按 0.4 画，只影响透明度。 */
interface SeaEdgeView {
  a: string
  b: string
  kind: string
  label: string
  score?: number
}
/** GET /api/psyche/sea 的快照。truncated 表示点被服务端截断，只影响提示文案。 */
interface SeaSceneView {
  ok: boolean
  nodes: SeaNodeView[]
  edges: SeaEdgeView[]
  instanceKey?: string | null
  diffAvailable?: boolean
  stats: {
    artifacts: number
    events: number
    edges: number
    byKind: Record<string, number>
    byCluster?: Record<string, number>
    truncated: boolean
    span?: { from: string | null; to: string | null }
    totalArtifacts?: number
    totalEvents?: number
    displayedArtifacts?: number
    displayedEvents?: number
  }
  note: string
}
/** 下钻详情（GET /api/psyche/node?id=…）的宽松视图：只为展示，不做严格建模。 */
interface SeaNodeDetailView {
  ok: boolean
  kind: 'artifact' | 'event'
  id: string
  artifactKind?: string
  head?: { revision: number; state: string; statement: string; confidence: string; createdAt: string } | null
  revisions?: { revision: number; state: string; statement: string; createdAt: string }[]
  evidence?: { revision: number; relation: string; quote: string | null; text: string | null; origin: string; createdAt: string }[]
  triggers?: { eventId: string; type: string; text: string; at: string }[]
  eventKind?: string
  eventType?: string
  text?: string
  at?: string
  sources?: { sourceId: string; text: string | null; origin: string; capturedAt: string }[]
  triggered?: { artifactId: string; statement: string }[]
}
