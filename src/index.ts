// 心灵（Psyche）· DeepSeek Harness 插件入口 · P1 核心
//
// 职责：只做「装配 + 转发」——Config Schema、Runtime（库/日志/偏好/用量）、boot、
//   11 个工具的注册、systemPrompt 段落热挂摘、webServer 六条路由、ctx.psyche 服务。
//   业务判定一律在 lib/store.ts / lib/panel.ts，本文件不写业务 SQL、不碰状态机。
// 约束：status/panel/usage/ops/sea 五条读路由只读，不写库、不改 profile；
//   写口只有 /prefs（视图偏好）与 ops 的三个动作，且每次写都落一条日志。
// 约束：工具可能在 boot 完成前被调用，所以每个桥接都先 await ready 再转发，
//   绝不把半初始化的 Core 交出去；boot 失败也不抛给宿主，而是折进 status().error。
// 设计文档：dsh-psyche-DEV.md v13 的 §14 范围（schema+migrations+适配器自检、operations 幂等、
//   五写五读工具、revision/supersedes、Event→Artifact 反向查询、慢查询记账与备份边界）。
// 调用方：宿主 Cordis 调 apply()；Web 面板打 /api/psyche/*；模型侧经工具表调到 buildTools()。
// 注意：后续阶段（检索投影、心情、QQ 通道、桌宠）不在这个包里。
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Service } from '@deepseek-ai/cordis'
import type { Context, HttpRequest, HttpRoute, HttpResponse } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Schema } from '@deepseek-ai/schemastery'
import { nowIso, openDatabase } from './lib/adapter.js'
import { rebuildFtsIndex, verifyFtsIndex } from './lib/fts.js'
import { markInterruptedRecallRuns } from './lib/recall-receipt.js'
import type { Db, DbHealth, DbLogger, OpenAttempt, SelfCheck } from './lib/adapter.js'
import { Core, PHASE_LABELS, decideGrowthCandidate, formatConfirmedGrowthLine, growthCandidateContentHash, listGrowthCandidates, planDigestJob, projectMoodTone, readConfirmedGrowthChanges } from './lib/store.js'
import { resumeDigestOnStartup } from './lib/digest-resume.js'
import { cancelReminder, createReminder, enqueueReminderReply, listReminders } from './lib/store.js'
import { NO_REPLY_WINDOW_AT, createReminderDelivery } from './lib/reminder-delivery.js'
import { isOwnerReminderScope as isOwnerReminderScopeByScope, readOwnerUin } from './lib/reminder-owner.js'
import { resolveReminderDelivery as resolveReminderDeliveryByFacade } from './lib/reminder-resolve.js'
import { ReminderTicker } from './lib/reminder-ticker.js'
import { loadAccessEpochs, saveAccessEpochs } from './lib/store.js'
import { beginAccessEpochChange, commitAccessEpochChange, loadPendingEpochs } from './lib/store.js'
import { ensureProductDataDir } from './lib/product-isolation.js'

/**
 * 提醒行 → 工具层视图。刻意丢掉 persona_id / request_id / contact_id：
 * 模型只需要判断「什么时候、提醒什么、现在什么状态」，
 * 内部记账字段露出去只会被它当成可引用的内容。
 */
function reminderView(row: {
  reminder_id: string
  due_at: string
  text: string
  status: string
  delivery_state: string
  created_at: string
  channel?: 'desktop' | 'qq'
  next_attempt_at?: string | null
}): {
  reminderId: string
  dueAt: string
  text: string
  status: string
  deliveryState: string
  createdAt: string
  channel?: 'desktop' | 'qq'
  nextAttemptAt: string | null
} {
  return {
    reminderId: row.reminder_id,
    dueAt: row.due_at,
    text: row.text,
    status: row.status,
    deliveryState: row.delivery_state,
    createdAt: row.created_at,
    channel: row.channel,
    nextAttemptAt: row.next_attempt_at ?? null,
  }
}
import { startQqGroupRuntime } from './lib/qq-group-runtime.js'
import type { GroupScheduler } from './lib/group-scheduler.js'
import type { CaptureInput, ResolveContactInput } from './lib/store.js'
import { buildTools } from './lib/tools.js'
import { auditConfigLoad, behaviorOf, type BehaviorState } from './lib/behavior.js'
import { buildPanel } from './lib/panel.js'
import type { PanelPayload } from './lib/panel.js'
import { readPrefs, writePrefs } from './lib/prefs.js'
import type { PanelPrefs } from './lib/prefs.js'
import { buildSeaScene, resolveSeaWindow } from './lib/sea.js'
import { buildNodeDetail } from './lib/node-detail.js'
import { createArchive, listArchiveRows } from './lib/archive.js'
import {
  applyPendingRestore,
  cancelRestore,
  confirmRestore,
  prepareRestorePackage,
  restoreStatus,
} from './lib/restore.js'
import type { RestoreApplyOutcome } from './lib/restore.js'
import { decideProposal } from './lib/proposals.js'
import { SCHEMA_VERSION } from './lib/schema.js'
import { ALGORITHM_VERSION } from './lib/derive.js'
import { OpLogger, backupDatabase, buildOps, readCounters } from './lib/ops.js'
import type { OpsPayload } from './lib/ops.js'
import { aggregateUsage } from './lib/usage.js'
import type { UsagePayload } from './lib/usage.js'
import { SelfUsageLedger } from './lib/self-usage.js'
import { CODE, PsycheError, toErrorPayload } from './lib/errors.js'
import type { ErrorPayload } from './lib/errors.js'
import { httpErrorBody, toPanelView, toStatusView } from './lib/http-dto.js'
import { inspectInitialization } from './lib/persona-init.js'
import type { InitSnapshot } from './lib/persona-init.js'
import { createPersonaInitService } from './lib/persona-init-service.js'
import type { PersonaInitService } from './lib/persona-init-service.js'
import { buildInitRoutes } from './lib/init-routes.js'
import { buildGrantRoutes } from './lib/grant-routes.js'
import { buildInjectionRoutes } from './lib/injection-routes.js'
import { registerRememberRoutes } from './lib/remember-routes.js'
import { registerProjectHandoffRoutes } from './lib/project-handoff-routes.js'
import { buildProjectBrief } from './lib/project-brief.js'
import { buildConversationRecall } from './lib/conversation-recall.js'
import {
  buildRecallMessage,
  delegationOfAgent,
  extractRecallQuery,
  sourceKindOf,
  stripRecallBlocks,
  textOfContent,
  type RecallQuery,
} from './lib/pre-step-recall.js'
import { ingestAffectSignal } from 'dsh-psyche-core'
import { planAffectContact } from './lib/affect-contact.js'
import { briefPlatformFor, isDelegatedAgent, resolveSessionChannel } from './lib/session-channel.js'
import { AssemblyReceiptStore } from './lib/assembly-receipt.js'
import type { ChannelBinding } from './lib/session-channel.js'
import type { RememberPersistence } from './lib/remember-button.js'
import { PRESET_IDS, loadPresets } from './lib/presets.js'
import { CaptureHost } from './lib/capture-host.js'
import type { SessionEventLike, SessionLike } from './lib/capture-host.js'
import { GhostSyncHost } from './lib/sync-recovery.js'
import { CaptureCursorStore } from './lib/capture-cursor.js'
import { RecoveryScanner } from './lib/recovery-scanner.js'
import { RuntimeInputStore } from './lib/runtime-input.js'
import { AgentBindingLifecycle } from './lib/channel-binding.js'
import { HostChannelRegistry } from './lib/host-channels.js'
import { QqBridge } from './lib/qq-bridge.js'
import { createQqTransport } from './lib/qq-transport.js'
import { qqGroupAllowed } from './lib/qq-group-admission.js'
import { QqLogBuffer, buildQqAdminPayload, formatQqLogLine } from './lib/qq-admin.js'
import { buildPendingReminders } from './lib/pending-reminders.js'
import { canExportDiagnostics, parseQqDiagnosticFilter } from './lib/qq-diagnostics.js'
import { ManagedProcess } from './lib/managed-process.js'
import { QqControlCenter } from './lib/qq-control-center.js'
import {
  buildQqWorkspaceCard,
  readWorkspaceCardWithRetry,
  type QqWorkspaceAttempt,
  type QqWorkspaceCard,
} from './lib/qq-workspace-card.js'
import { readWorkspaceBaseline } from './lib/qq-workspace-read.js'
import {
  defaultSessionsDirs,
  findExistingQqSessionCwd,
  isQualifiedWorkspacePath,
  resolveQqWorkspaceCwd,
} from './lib/qq-workspace-path.js'
import { attachQqSessionToWorkspace, type QqWorkspaceEntityLike } from './lib/qq-workspace-attach.js'
import { sameOriginWrite } from './lib/qq-request-origin.js'
import { createQqModelCatalog } from './lib/qq-model-catalog.js'
import { QqSettingsOverlay } from './lib/qq-settings-overlay.js'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { inspectSnowlumaDir } from './lib/snowluma.js'
import { spawn } from 'node:child_process'
import { createQqAdapter } from 'dsh-psyche-qq'
import { PreStepInjector } from './lib/pre-step-injection.js'
import type { PreStepMessage } from './lib/pre-step-injection.js'
import { registerRelationshipContext } from './lib/relationship-context.js'
import { InjectionManifestStore } from './lib/injection-manifest.js'
import { validateFinalRequest } from './lib/final-check.js'
import { MoodTurnBuffer } from './lib/mood-turn-buffer.js'
import { registerMoodToneContext } from './lib/mood-tone.js'
import { QqReplyOutboxStore, reflectGrowthCandidates } from 'dsh-psyche-core'
import { readPersonaProjection } from './lib/persona-runtime.js'
import { ProjectionController, readPersistedGrowthLine } from './lib/projection-context.js'
import { readLatestIntentionLine } from './lib/intention-context.js'
import { runIntentionTick } from './lib/intention-tick.js'
import { createRelationshipContextProvider } from './lib/relationship-context.js'
import { createPersonaAgentGate, registerPersonaContext } from './lib/persona-context.js'
import {
  createPersonaDominance,
  expressionTextFor,
  injectDominanceSections,
} from './lib/persona-dominance.js'
import { PROJECTION_MAX_CHARS, PROJECTION_MAX_TOKENS } from './lib/projection-composer.js'
import { readContactAffectSync } from './lib/contact-affect-read.js'
import { buildMoodPanel } from './lib/mood-panel.js'
import { applyMoodTurn, loadMood, MOOD_RULES_VERSION } from './lib/mood.js'
import {
  MoodBehaviorState,
  MoodTurnClock,
  computeMoodBehavior,
  moodStateKey,
  renderMoodProjection,
} from './lib/mood-behavior.js'

/**
 * 插件自己的版本号，写进迁移包清单（`manifest.plugin.version`）。
 *
 * 为什么读 package.json 而不是写常量：版本号只有一处真相，发版时改 package.json 就够，
 * 不会出现「代码说 0.2.0、包里写 0.1.9」这种对不上。读不到（打包剥离/权限异常）就退回
 * '0.0.0'——清单里版本号不准不影响恢复，但整个包因此打不出来才是问题。
 */
function pluginVersion(): string {
  try {
    const file = new URL('../package.json', import.meta.url)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: string }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * 插件名：宿主拿它当配置键、日志前缀与 effect 标签的前缀。
 */
export const name = 'dsh-psyche'
/** 硬依赖只有 tools；systemPrompt / webServer 走 ctx.inject 可选接入，缺了也照常启动。 */
export const inject = ['tools']

/**
 * 注入系统提示的「记忆纪律」（§10 的 P1 缩水版：只给写入门槛，不做七段注入）。
 *
 * 为什么是常量而不是函数：内容跟运行时状态无关，每次装配都读同一份；
 * 每多一行就挤占一轮真正的任务上下文，所以措辞刻意压到最短。
 * 改这段等于改模型行为——它同时是「什么时候该写」的唯一判据，别在这里加密钥或路径。
 */
const PROMPT_SECTION = `心灵记忆（本机 SQLite）：
- 值得长期留下的才写：明确事实、稳定偏好、承诺约定、立场变化。闲聊不要写。
- 写之前想清楚类型：事实 fact、看法 belief、印象 impression、立场 stance、关系 relationship、做法 procedure。
  主观的东西不要记成 fact；证据不够会返回 promotion.ok=false，攒够独立来源再写。
- 遇到反证用 psyche_clash，改口用 psyche_revise，复核用 psyche_review，别用 remember 覆盖。
- 好感只以档位表达（亲近/友善/中立…），不报分数。
- 记忆不确定就用 psyche_recall 查，不要凭印象编。`

/**
 * 插件配置的 TS 形状：与下面的 `ConfigSchema` 手工保持同形（Schema 才是运行时真相）。
 *
 * 全是启动期参数，改完要重启宿主；面板里能热改的只有 prefs（sea / promptSection），
 * 那是视图偏好、写数据目录，跟这里存在 profile 里的配置是两套东西，别混着读。
 */
export interface PsycheConfig {
  enabled: boolean
  dataDir: string
  storage: { driver: string; db: string }
  independence: { activityWindowMinutes: number }
  affinity: { neutral: number }
  prompt: { section: boolean; order: number }
  /** P5-1b：人格原文注入；上限只能收紧（6000 字符 / 3000 token）。 */
  persona: {
    enabled: boolean
    maxChars: number
    maxTokens: number
    /** P7-1：人格主导；默认关，开启后需重启宿主。 */
    dominance: boolean
    /** P7-1：人格主导时追加的表达约束段。 */
    expression: boolean
  }
  /** P5-2b：统一投影 Context（true=单 Context；false=旧四件套；切换需重载）。 */
  projection: { enabled: boolean; intention: boolean }
  performance: { slowQueryMs: number; slowWarnMs: number }
  /** P2-CAP-1b：DSH 会话的实时捕获（C 阶段默认开：持续积累 Source，不代表自动形成记忆）。 */
  capture: {
    enabled: boolean
    /** 逗号分隔的会话 id 白名单；空表示不限制。 */
    allowSessions: string
    /** 逗号分隔的会话 id 排除表。 */
    excludeSessions: string
    maxQueue: number
    maxText: number
  }
  /** P2-CAP-1c1：Ghost 历史补采（默认关；只覆盖「上一轮用户消息没落库」这一种缺口）。 */
  ghostRecovery: {
    enabled: boolean
    /** 每次补采最多读多少条持久化事件。 */
    maxScan: number
    /** 只补最近这么多毫秒内的用户消息。 */
    lookbackMs: number
  }
  /** P2-CAP-1c3：按持久化日志的顺序补采（默认关；由 Cursor 记录水位，可重入）。 */
  recoveryScan: {
    enabled: boolean
    /** 单轮扫描最多捕获多少条；到上限就释放租约，下一轮接着扫。 */
    maxEventsPerScan: number
    /** 每次 read 的分页大小（事件条数）。 */
    pageSize: number
    /** 单条来源正文上限。 */
    maxText: number
  }
  /** P2-FTS5 E5.5-C：agent/pre-step 记忆注入（C 阶段默认开：仍受 Scope / 披露 / Recall / 预算约束）。 */
  injection: {
    enabled: boolean
    /** 单次注入最多几条记忆。 */
    maxItems: number
    /** 注入块正文上限（字符）。 */
    maxChars: number
    /** 注入前检索候选条数。 */
    searchLimit: number
  }
  /**
   * P3-A：Mood 功能总开关（B2 每轮判定 + B3 语气注入，默认开）。
   * `enabled=true`：B2 按真实用户消息更新 4 张 mood 表；B3 每轮装配读取并注入两行语气 Context。
   * `enabled=false`：B2 停止更新，B3 不注册/不输出语气；保留库中已有状态，不删不重置，
   * 重新开启后 `loadMood()` 按时间正常衰减。
   * 只写 global_mood_state / global_mood_history / mood_meta 四张心情表；
   * 不改事实、不进 Recall/Diary/Stance、不决定是否联系。
   */
  mood: {
    enabled: boolean
    /** 单维单轮最大改变量（B0 §4.3，默认 8）。 */
    maxDelta: number
    /** 单轮参与判定的用户正文上限（字符）。 */
    maxText: number
    /** 逗号分隔的会话 id 排除表；空表示不限制。 */
    excludeSessions: string
  }
  /**
   * P5-3a：成长反思候选（rule-only v1，默认开）。
   * 只写 growth_reflections / growth_candidates / growth_candidate_sources；
   * 不自动确认、不生效、不投影 Prompt；预算跳过不消耗执行额度。
   */
  growthReflection: {
    enabled: boolean
    /** 每个对象每天最多几次有效反思。 */
    perContactDaily: number
    /** 全局每天最多几次有效反思。 */
    globalDaily: number
    /** evaluating 遗留的判定超时（毫秒）。 */
    timeoutMs: number
  }
  /**
   * P6-2：自主意愿 tick（默认开）。只把已有承诺/计划派生成内部意愿并落库；
   * 不发送、不执行、不投影 Prompt。`projection.intention` 仍单独默认关。
   */
  intention: {
    enabled: boolean
  }
  /**
   * P3-B-3：关系投影注入（默认开，只对 QQ 私聊可信绑定的 Contact 生效）。
   * 每轮 `agent/pre-step` 重新解析当前 Contact，独立注入 `psyche-relationship` 块；
   * 只读关系快照，不写关系表、不影响记忆注入与 Mood 语气。
   */
  relationship: {
    enabled: boolean
  }
  /**
   * P2-FTS5 E5.5-D：llm/stream 最终完整性检查。
   * C 阶段起**强制开启**，不再定义 `enabled`、也不再接受配置覆盖。
   * 这里保留一个 `unknown` 形状的占位字段，只为让旧 profile 里的 `finalCheck`
   * 能进入运行时对象、被 `behaviorOf()` 识别为迁移提示（无论 true/false 都忽略，
   * 只写审计与 warning）——它不是有效配置项。
   */
  finalCheck?: unknown
  /** R6-3C-Live：SnowLuma OneBot 桥（默认关；只在 R6 临时 profile 里显式打开）。 */
  qq: {
    enabled: boolean
    /** D-1 默认关的群采集白名单；逐条 fail-closed，不创建群 Agent。 */
    groups?: unknown
    /** OneBot WS 服务端。 */
    wsUrl: string
    /** OneBot access token（Bearer）。留空时从 SnowLuma 配置只读发现。 */
    accessToken: string
    /** SnowLuma 安装目录（含 `config/onebot_<QQ>.json`）；留空则不做 token 发现。 */
    snowlumaHome: string
    /** 创建 Agent 时使用的 provider（沿用宿主已配置的模型路由）。 */
    provider: string
    /** 创建 Agent 时使用的 model。 */
    model: string
    /** QQ 会话所属工作区目录（`cwd`）；留空时先用磁盘上已有 QQ 会话的目录，没有才用 `<宿主工作目录>/QQ 聊天`，相对值按宿主工作目录补全。 */
    cwd: string
    /** 断线重连间隔（毫秒，指数退避到 30 秒）。 */
    reconnectMs: number
    /** 单条消息正文上限（字符）。 */
    maxText: number
    /**
     * P4-A：QQ 私聊准入白名单。`owner` 必填、`extra` 可选，纯数字 QQ 号字符串；
     * 缺失/空/含通配符/非法条目时整份白名单失效（全部私聊先被拒绝）。
     */
    allowFrom: { owner: string; extra: string[] }
    /** 未授权来源的处理策略；P4-A 只允许 `reject`。 */
    unknownPolicy: 'reject'
    /** P4-B-3：QQ 私聊联系人级策略；结构由 `parseQqContactPolicies` 严格校验。 */
    contacts?: unknown
    /** P4-B-4-2b：私聊回复 Outbox（默认关；只在启动时读取，切换需重载）。 */
    replyOutbox: { enabled: boolean; intervalMs: number }
    /** 同一陌生人两次拒绝回复的最小间隔（毫秒，默认 24 小时）。 */
    rejectCooldownMs: number
    /** 进程内滚动窗口里最多发送的拒绝回复条数（默认 20）。 */
    rejectGlobalLimit: number
    /** 拒绝回复的滚动窗口（毫秒，默认 1 小时）。 */
    rejectGlobalWindowMs: number
  }
}

// 每段都是「内层字段 default + 外层对象 default」写两遍，缺一不可：
// 整段没配时靠外层兜底，配了但少键时靠内层兜底——schemastery 不会把两层默认值合并。
const ConfigSchema = z.object({
  enabled: z.boolean().default(true).description('是否启用心灵记忆'),
  // 留空是常态：真实路径要异步解析（可能 import 宿主的 dsh-home-paths），见 resolveDataDir。
  dataDir: z.string().default('').description('数据目录，留空用 $DSH_HOME/psyche'),
  storage: z
    .object({
      driver: z.string().default('auto').description('SQLite 驱动：auto / node:sqlite / better-sqlite3'),
      db: z.string().default('memory.sqlite3').description('数据库文件名'),
    })
    .default({ driver: 'auto', db: 'memory.sqlite3' }),
  independence: z
    .object({
      // 同一窗口内的多条消息只算一条独立证据；窗口太短会把一次长谈拆成「多次独立确认」。
      activityWindowMinutes: z
        .number()
        .min(1)
        .max(120)
        .default(10)
        .description('独立证据的连续活动窗口（分钟）'),
    })
    .default({ activityWindowMinutes: 10 }),
  affinity: z
    .object({
      neutral: z.number().min(0).max(100).default(50).description('新人默认好感值'),
    })
    .default({ neutral: 50 }),
  prompt: z
    .object({
      section: z.boolean().default(true).description('是否向系统提示注入心灵记忆约定'),
      order: z.number().default(60).description('系统提示段落顺序'),
    })
    .default({ section: true, order: 60 }),
  // P5-1b：人格原文注入。上限只能收紧，不能超过 P5-0 冻结的 6000 字符 / 3000 token。
  persona: z
    .object({
      enabled: z.boolean().default(true).description('是否把已锁定的人格原文注入系统提示'),
      maxChars: z.number().min(1).max(6000).default(6000).description('人格字符硬上限（不超过 6000）'),
      maxTokens: z.number().min(1).max(3000).default(3000).description('人格 token 硬上限（不超过 3000）'),
      dominance: z.boolean().default(false).description('P7-2：人格主导（waterfall 原子注入 + 替换宿主身份句 + 表达约束）；仅在无 complete section 的宿主有效，默认关，改动需重启'),
      expression: z.boolean().default(true).description('P7-1：人格主导时是否追加表达约束段（≤120 字）'),
    })
    .default({ enabled: true, maxChars: 6000, maxTokens: 3000, dominance: false, expression: true }),
  performance: z
    .object({
      slowQueryMs: z.number().min(10).max(5000).default(50).description('超过这个毫秒数记慢查询（§14 性能边界）'),
      slowWarnMs: z.number().min(50).max(20000).default(200).description('超过这个毫秒数记警告'),
    })
    .default({ slowQueryMs: 50, slowWarnMs: 200 }),
  // P2-CAP-1b：默认关。1c 通过之前不默认开全量自动监听，也不把它说成生产级可靠捕获。
  capture: z
    .object({
      enabled: z.boolean().default(true).description('是否把桌面会话里的用户消息与模型回复自动捕获成来源（默认开；只采 Source，不代表自动形成记忆）'),
      allowSessions: z.string().default('').description('逗号分隔的会话 id 白名单；留空不按白名单限制'),
      excludeSessions: z.string().default('').description('逗号分隔的会话 id 排除表'),
      maxQueue: z.number().min(1).max(5000).default(200).description('有界队列上限，满时记溢出而不是静默丢弃'),
      maxText: z.number().min(100).max(100000).default(8000).description('单条来源正文上限（字符）'),
    })
    .default({ enabled: true, allowSessions: '', excludeSessions: '', maxQueue: 200, maxText: 8000 }),
  // P2-CAP-1c1：默认关。补采只覆盖「上一轮用户消息没落库」；没有原文的溢出事件不假装能恢复。
  ghostRecovery: z
    .object({
      enabled: z.boolean().default(false).description('是否在每轮开始时检查上一轮用户消息是否漏记并补采'),
      maxScan: z.number().min(10).max(2000).default(200).description('每次补采最多读取的持久化事件条数'),
      lookbackMs: z.number().min(1000).max(86400000).default(300000).description('只补最近这么多毫秒内的用户消息'),
    })
    .default({ enabled: false, maxScan: 200, lookbackMs: 300000 }),
  // P2-CAP-1c3：默认关。按 Cursor 水位顺序补采，可反复扫同一会话而不重复落库。
  recoveryScan: z
    .object({
      enabled: z.boolean().default(false).description('是否按持久化日志顺序补采（Cursor 记录水位，可重入）'),
      maxEventsPerScan: z.number().min(1).max(10000).default(200).description('单轮扫描最多捕获条数，到上限释放租约下一轮继续'),
      pageSize: z.number().min(1).max(1000).default(200).description('每次 read 分页的事件条数'),
      maxText: z.number().min(100).max(100000).default(8000).description('单条来源正文上限（字符）'),
    })
    .default({ enabled: false, maxEventsPerScan: 200, pageSize: 200, maxText: 8000 }),
  // P2-FTS5 E5.5-C：C 阶段默认开。开只代表「允许检索 + 组装 + 注入」，
  // 是否真的注入仍由 Scope / 披露 / Recall / Composer / 预算决定；
  // 关闭它只停止注入，不影响 capture 继续采集。
  injection: z
    .object({
      enabled: z.boolean().default(true).description('是否在 agent/pre-step 注入记忆上下文（默认开；仍受 Scope / 披露 / 预算约束）'),
      maxItems: z.number().min(1).max(20).default(6).description('单次注入最多几条记忆'),
      maxChars: z.number().min(100).max(4000).default(800).description('注入块正文上限（字符）'),
      searchLimit: z.number().min(1).max(100).default(12).description('注入前检索候选条数'),
    })
    .default({ enabled: true, maxItems: 6, maxChars: 800, searchLimit: 12 }),
  // P3-A：Mood 功能总开关，默认开。B2 写 4 张 mood 表；B3 注入两行语气 Context；不进记忆链路。
  mood: z
    .object({
      enabled: z.boolean().default(true).description('Mood 功能总开关（默认开）：开=B2 更新情绪 + B3 注入语气；关=停止更新且不注入，保留库中状态（只写 mood 表，不进记忆）'),
      maxDelta: z.number().min(1).max(20).default(8).description('单维单轮最大改变量'),
      maxText: z.number().min(100).max(20000).default(4000).description('单轮参与判定的用户正文上限（字符）'),
      excludeSessions: z.string().default('').description('逗号分隔的会话 id 排除表'),
    })
    .default({ enabled: true, maxDelta: 8, maxText: 4000, excludeSessions: '' }),
  // P5-3a：成长反思候选（rule-only v1），默认开。只写 growth_reflections /
  // growth_candidates / growth_candidate_sources；不自动确认、不生效、不投影 Prompt。
  growthReflection: z
    .object({
      enabled: z.boolean().default(true).description('成长反思候选开关（默认开）：只生成候选，不确认、不生效'),
      perContactDaily: z.number().min(1).max(10).default(1).description('每个对象每天最多几次有效反思'),
      globalDaily: z.number().min(1).max(20).default(3).description('全局每天最多几次有效反思'),
      timeoutMs: z.number().min(1000).max(600000).default(120000).description('evaluating 遗留的判定超时'),
    })
    .default({ enabled: true, perContactDaily: 1, globalDaily: 3, timeoutMs: 120000 }),
  // P6-2：意愿 tick。默认开，只派生成内部意愿并落库；不发送、不执行、不投影。
  intention: z
    .object({
      enabled: z.boolean().default(true).description('意愿 tick 开关（默认开）：只生成内部意愿，不发送、不执行'),
    })
    .default({ enabled: true }),
  // P3-B-3：关系投影注入开关，默认开。只在 QQ 私聊可信绑定存在时注入独立块；只读、不写库。
  relationship: z
    .object({
      enabled: z.boolean().default(true).description('关系投影注入开关（默认开）：只对 QQ 私聊可信绑定生效；只读关系快照，不写库、不影响记忆与 Mood'),
    })
    .default({ enabled: true }),
  // P5-2b：统一投影 Context。默认开：只注册 `psyche-projections`（order 60），
  // 由组合器统一分配投影预算；关=沿用 P5-1 的 memory Section + persona/mood/relationship 四件套。
  // 两模式互斥，切换需要插件重载（apply 时只读一次）。
  projection: z
    .object({
      enabled: z
        .boolean()
        .default(true)
        .description('P5-2b 统一投影 Context（默认开）：开=单 Context + 投影预算；关=沿用旧四件套；切换需重载插件'),
      intention: z
        .boolean()
        .default(false)
        .description('P6-1 自主意愿分段（默认关）：开=有 internal 意愿时在投影末尾追加一行；不新增 Context'),
    })
    .default({ enabled: true, intention: false }),
  // 保留一个「任意值」占位字段，只为让旧 profile 里的 `finalCheck` 进入运行时对象、
  // 被 `behaviorOf()` 识别为迁移提示（无论 true/false 都不影响行为，只写审计与 warning）。
  // 注意：这里用 `z.any()` 的断言形式，因为默认导出的类型是实例接口、没有 Static 的 `any`。
  finalCheck: (z as unknown as { any: () => Schema<unknown> }).any().description(
    '已废弃：仅用于识别旧配置；最终完整性检查始终开启，此字段不生效',
  ),
  // R6-3C-Live：SnowLuma OneBot 桥。默认关；只有 R6 临时 profile 里显式打开。
  // 身份仍然由 Host 注册的 `qq-snowluma` Adapter 声明，桥本身不接触 RuntimeInputStore。
  qq: z
    .object({
      enabled: z.boolean().default(false).description('是否连接 SnowLuma OneBot 网关（默认关）'),
      wsUrl: z.string().default('ws://127.0.0.1:3001').description('OneBot WS 服务端地址'),
      accessToken: z.string().default('').description('OneBot access token（Bearer）；留空时从 SnowLuma 配置只读发现'),
      snowlumaHome: z.string().default('').description('SnowLuma 安装目录（含 config/onebot_<QQ>.json）；留空不做 token 发现'),
      provider: z.string().default('').description('创建 QQ Agent 时使用的 provider（沿用宿主模型路由）'),
      model: z.string().default('').description('创建 QQ Agent 时使用的 model'),
      cwd: z.string().default('').description('QQ 会话所属工作区目录；留空先用磁盘上已有 QQ 会话的目录，没有才用 <宿主工作目录>/QQ 聊天（相对值按宿主工作目录补全）'),
      reconnectMs: z.number().min(200).max(60000).default(3000).description('断线重连初始间隔（毫秒，指数退避到 30 秒）'),
      maxText: z.number().min(100).max(100000).default(8000).description('单条消息正文上限（字符）'),
      groups: (z as unknown as { any: () => Schema<unknown> }).any().default({ enabled:false,allowed:[] }).description('群白名单与确定性回复（D-2）：采集/回复默认关闭；回复需受信模型输入证明能力'),
      allowFrom: z
        .object({
          owner: z.string().default('').description('主人 QQ 号（纯数字；缺失/非法时所有私聊先被拒绝）'),
          extra: z.array(z.string()).default([]).description('额外允许私聊的 QQ 号（纯数字，不支持通配符）'),
        })
        .default({ owner: '', extra: [] }),
      unknownPolicy: z.const('reject').default('reject').description('未授权来源的处理策略；P4-A 只允许 reject'),
      contacts: (z as unknown as { any: () => Schema<unknown> }).any().default([]).description('P4-B-3：QQ 私聊联系人策略（enabled/silence/maxPerHour）；缺失时保持 B-2 行为'),
      // P4-B-4-2b：默认关。开启后私聊助手回复只入 Outbox，由 Worker 独占发送；
      // 关闭时走原直发路径。开关只在启动时读取，修改后需重载插件。
      replyOutbox: z
        .object({
          enabled: z.boolean().default(false).description('私聊回复 Outbox 开关（默认关；重启生效）：开=助手回复入队由 Worker 独占发送，关=原直发路径'),
          intervalMs: z.number().min(250).max(60000).default(2000).description('Worker 轮询间隔（毫秒）'),
        })
        .default({ enabled: false, intervalMs: 2000 }),
      rejectCooldownMs: z
        .natural()
        .min(0)
        .max(7 * 24 * 60 * 60 * 1000)
        .default(24 * 60 * 60 * 1000)
        .description('同一陌生人两次拒绝回复的最小间隔（毫秒，默认 24 小时）'),
      rejectGlobalLimit: z
        .natural()
        .min(0)
        .max(1000)
        .default(20)
        .description('进程内滚动窗口里最多发送的拒绝回复条数（默认 20）'),
      rejectGlobalWindowMs: z
        .natural()
        .min(1000)
        .max(24 * 60 * 60 * 1000)
        .default(60 * 60 * 1000)
        .description('拒绝回复的滚动窗口（毫秒，默认 1 小时）'),
    })
    .default({
      enabled: false,
      wsUrl: 'ws://127.0.0.1:3001',
      groups: { enabled:false,allowed:[] },
      accessToken: '',
      snowlumaHome: '',
      provider: '',
      model: '',
      cwd: '',
      reconnectMs: 3000,
      maxText: 8000,
      allowFrom: { owner: '', extra: [] },
      unknownPolicy: 'reject',
      contacts: [],
      replyOutbox: { enabled: false, intervalMs: 2000 },
      rejectCooldownMs: 24 * 60 * 60 * 1000,
      rejectGlobalLimit: 20,
      rejectGlobalWindowMs: 60 * 60 * 1000,
    }),
})

/** 导出的 Schema：宿主据此渲染设置页、校验 profile；默认值以这里为准。 */
export const Config: Schema<PsycheConfig> = ConfigSchema

/**
 * 状态快照：`/api/psyche/status` 与 `psyche.status()` 共用这一个形状（只读、可直接 JSON 化）。
 *
 * 设计上「启动失败」不是异常而是字段：`ok=false` + `error` + `attempts` 足以让运维页说明为什么起不来。
 * `driver` / `selfCheck` / `storage` 在库没起来时是 null，调用方不要当它们一定有值。
 */
export interface StatusPayload {
  ok: boolean
  enabled: boolean
  driver: string | null
  dataDir: string
  startedAt: string
  selfCheck: SelfCheck | null
  attempts: OpenAttempt[]
  error: ErrorPayload | null
  storage: DbHealth | null
  /** 人格初始化状态（I-3）：启动时只读判定一次；null 表示还没走到或判定失败。 */
  personaInit: InitSnapshot | null
  /**
   * C 阶段：三个记忆功能在**运行时实际生效**的状态。
   * 面板只认这个字段，不回显配置文件里的字面值——配置可能被默认值 / 旧字段覆盖。
   * 类型直接用 `BehaviorState`（唯一计算点），避免这里再写一遍形状。
   */
  behavior: BehaviorState
}

/**
 * 进程内单例运行时：boot 把东西填进来，其余函数只读它。
 *
 * 为什么用可变对象而不是闭包返回值：`status()` 要能在 boot 前后都被调到，
 * 而且 `ctx.psyche` 服务、路由、工具桥接共享同一份引用——换对象会让它们看到不同的库。
 */
interface Runtime {
  core: Core | null
  db: Db | null
  /** boot 抛出的原始错误；非 null 表示启动失败，后续所有读写都应报它。 */
  bootError: unknown
  dataDir: string
  driver: string | null
  selfCheck: SelfCheck | null
  attempts: OpenAttempt[]
  startedAt: string
  /** 数据目录下的子目录表（assets/narrative/view/exports/backups），boot 时一次建好。 */
  dirs: Record<string, string>
  /** 面板视图偏好（意识海开关等）；写/读都在数据目录里，改完立刻生效。 */
  prefs: PanelPrefs
  /** 引擎日志（内存环形缓冲）：boot、DB、路由的重要事件都往里写，运维页直接读。 */
  log: OpLogger
  /** 心灵**自己**的模型调用账本（内存，重启清零）：只记插件内部发起的调用。 */
  selfUsage: SelfUsageLedger
  /**
   * 启动门禁的结果（§34.14）：这次启动有没有应用待恢复任务。
   *
   * `null` 表示门禁还没走到（例如 enabled=false）。门禁必须在 `openDatabase()` 之前跑完，
   * 否则「换目录」会撞上本进程已经打开的库句柄（Windows 上直接失败）。
   */
  restore: RestoreApplyOutcome | null
  /** 门禁抛错的原因（现场不明确/回滚失败等）；非 null 时启动被拦下，页面要显式报出来。 */
  restoreError: string | null
  /** 人格初始化判定结果（I-3）：启动时只读一次，null 表示还没判定/判定失败。 */
  personaInit: InitSnapshot | null
  /** 人格判定抛错的原因（不影响库读写，只影响「是否已初始化」的展示）。 */
  personaInitError: string | null
  /**
   * 人格初始化服务（I-7）：路由层唯一入口。
   *
   * 路由不直接碰 claim / 人格文件 / 数据库快照——所有初始化动作都经这个服务，
   * 由它在 Core 侧完成锁归属、状态门与跨存储一致性校验。boot 失败时为 null。
   */
  init: PersonaInitService | null
  /** boot 的 promise：工具/路由都 await 它，保证不会读到半初始化的状态。 */
  ready?: Promise<Runtime>
  status(): StatusPayload
}

/**
 * 拼一份状态快照（不缓存、不抛错）。
 *
 * @param runtime 当前运行时；boot 前后都可传。
 * @param cfg 宿主配置，决定 `enabled` 的显示值。
 * @returns 可直接 JSON 化的 `StatusPayload`。
 *
 * 副作用：`db.health()` 会跑几条 PRAGMA 加一次表计数（还会进慢查询统计），
 * 所以它只在真有库的时候调用；面板每次刷新都会打一次，别把它放到热循环里。
 */
function statusOf(runtime: Runtime, cfg: PsycheConfig): StatusPayload {
  return {
    ok: !runtime.bootError,
    enabled: cfg.enabled !== false,
    driver: runtime.driver,
    dataDir: runtime.dataDir,
    startedAt: runtime.startedAt,
    selfCheck: runtime.selfCheck,
    attempts: runtime.attempts,
    error: runtime.bootError ? toErrorPayload(runtime.bootError) : null,
    storage: runtime.db ? runtime.db.health() : null,
    personaInit: runtime.personaInit,
    // 只认 lib/behavior.ts 的计算：面板与启动审计都从这里来，避免两处判断漂移。
    behavior: behaviorOf(cfg),
  }
}

/**
 * C 阶段：把三个记忆功能的生效状态、旧配置迁移提示与非法值告警追加到
 * `<dataDir>/config-audit.jsonl`。规则在 `lib/behavior.ts`，这里只负责落盘与告警。
 * 审计失败不回滚任何配置语义（只告警），见 C1 决议第 5 条。
 */
function writeConfigAudit(dataDir: string, cfg: PsycheConfig, logger: DbLogger): void {
  const behavior = behaviorOf(cfg)
  for (const message of behavior.legacy) {
    logger.warn?.(`[psyche] 旧配置已忽略：${message}`)
  }
  for (const message of behavior.warnings) {
    logger.warn?.(`[psyche] 配置值非法，已按默认处理：${message}`)
  }
  if (!auditConfigLoad(dataDir, cfg, nowIso())) {
    logger.warn?.('[psyche] 写配置审计失败（不影响启动，也不回滚已生效配置）')
  }
}

/** 把 unknown 错误压成一行字符串（日志用）；不判断错误类型，失败也就失败在日志上。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 解析数据目录：配置优先，其次 $DSH_HOME，最后退回 ~/.dsh/psyche。
 *
 * 为什么是 async：`@deepseek-ai/dsh-home-paths` 是可选依赖，用动态 import 解析——
 * 宿主外（单测、无该包）拿不到就静默回退，不能让「取路径」把整个插件启动拖死。
 *
 * @param configured 配置里的 `dataDir`，空白串视为「没配」。
 * @returns 绝对路径（已 resolve，不含末尾分隔符）。
 * 副作用：仅一次模块动态 import；不建目录。
 */
async function resolveDataDir(configured: string | undefined): Promise<string> {
  if (configured && configured.trim()) return resolve(configured.trim())
  let home = process.env.DSH_HOME
  // 环境变量是快路径；没有才去问宿主包（可能根本没装，所以整段 try/catch）。
  if (!home) {
    try {
      const mod: typeof import('@deepseek-ai/dsh-home-paths') = await import('@deepseek-ai/dsh-home-paths')
      if (typeof mod.resolveDshHome === 'function') home = mod.resolveDshHome()
    } catch {
      // 宿主没提供这个包就用 ~/.dsh
    }
  }
  return resolve(home || join(homedir(), '.dsh'), 'psyche')
}

/**
 * 建好数据目录及全部子目录（幂等，已存在不报错）。
 *
 * @param dataDir 已 resolve 的根目录。
 * @returns 子目录名 → 绝对路径，后续路由/导出直接查表。
 * 副作用：`mkdirSync(..., { recursive: true })`，会真的落盘。
 * 异常：磁盘不可写时抛 fs 的 EACCES / EPERM / ENOSPC 等——boot 外层会把它收成 bootError。
 */
function prepareDirs(dataDir: string): Record<string, string> {
  const dirs: Record<string, string> = {
    root: dataDir,
    assets: join(dataDir, 'assets'),
    narrative: join(dataDir, 'narrative'),
    view: join(dataDir, 'memory-view'),
    exports: join(dataDir, 'exports'),
    backups: join(dataDir, 'backups'),
  }
  // 一次建全：后面任何一条路由都不该再关心「目录在不在」。
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  return dirs
}

/**
 * 服务接口（§13.2）：§13.2 的十一个方法，外加 later 阶段补的 growth / context / redact 口子，全部 Promise。
 *
 * @param runtime 闭包捕获的运行时；服务实例自身不持有库句柄，只是转发。
 * @returns 一个可交给 `ctx.plugin()` 的 Service 子类（构造时以 `psyche` 名注册）。
 *
 * 为什么用工厂而不是直接写 class：基类必须拿到 boot 阶段的 runtime 才能转发，
 * 而 runtime 是 apply() 里的局部对象——工厂让 class 定义推迟到 runtime 存在之后。
 * 错误约定：任何方法在 boot 失败/未完成时都抛 bootError 或 `心灵还没准备好`，
 * 不返回 null、也不吞异常——工具的 `wrap()` 会把它折成 E_INTERNAL 载荷给模型看。
 */
function createServiceClass(runtime: Runtime) {
  return class PsycheService extends Service {
    readonly runtime: Runtime

    constructor(ctx: Context) {
      super(ctx, 'psyche')
      this.runtime = runtime
    }

    /** 取 Core；没起来就抛（带原始 bootError 时优先抛它，便于定位根因）。 */
    get core(): Core {
      if (!this.runtime.core) {
        throw this.runtime.bootError ?? new Error('心灵还没准备好')
      }
      return this.runtime.core
    }

    // 下面全是薄转发：签名一律用 ReturnType<Core[...]> 从真实实现推导，避免手写第二份形状。
    status(): StatusPayload {
      return this.runtime.status()
    }

    // capture 与 perceive 目前同义（都只落一条 Source，区别仅是 debug 日志），
    // 保留两个名字是为了给通道插件一个稳定口子；别以为 perceive 会顺手升成结论。
    capture(input?: CaptureInput): ReturnType<Core['capture']> {
      return this.core.capture(input)
    }

    perceive(input?: CaptureInput): ReturnType<Core['perceive']> {
      return this.core.perceive(input)
    }

    remember(input?: Parameters<Core['remember']>[0]): ReturnType<Core['remember']> {
      return this.core.remember(input)
    }

    clash(input?: Parameters<Core['clash']>[0]): ReturnType<Core['clash']> {
      return this.core.clash(input)
    }

    revise(input?: Parameters<Core['revise']>[0]): ReturnType<Core['revise']> {
      return this.core.revise(input)
    }

    review(input?: Parameters<Core['review']>[0]): ReturnType<Core['review']> {
      return this.core.review(input)
    }

    // 服务层允许不传参：`?? {}` 让 recall() 等价于「全库最近几条」，
    // 而不是把 undefined 透给 Core（那边虽然也有默认值，但签名要求实参形状）。
    recall(input?: Parameters<Core['recall']>[0]): ReturnType<Core['recall']> {
      return this.core.recall(input ?? {})
    }

    fetch(ids?: string, budget?: number): ReturnType<Core['fetch']> {
      return this.core.fetch(ids, budget)
    }

    getState(): ReturnType<Core['getState']> {
      return this.core.getState()
    }

    getRelationship(contactId?: string): ReturnType<Core['getRelationship']> {
      return this.core.getRelationship(contactId)
    }

    /** 成长派生（v14 §21–§22）：纯读，不写库；阶段推进只发生在写入之后或人确认整合时。 */
    getGrowth(): ReturnType<Core['getGrowth']> {
      return this.core.getGrowth()
    }

    /** 显式补一次闸门评估（启动自检、迁移后回填用）；幂等。 */
    syncGrowth(): ReturnType<Core['syncGrowth']> {
      return this.core.syncGrowth()
    }

    /** Core 内部口子：生成一条 growth 提案（模型工具没有这个能力）。 */
    createGrowthProposal(input: { statement?: string; rationale?: string } = {}): ReturnType<
      Core['createGrowthProposal']
    > {
      return this.core.createGrowthProposal(input)
    }

    /** 人类确认口子：接受/驳回 growth 提案；接受仍要前三道闸全过。 */
    confirmGrowthProposal(input: {
      proposalId: string
      accept: boolean
      actor?: string
    }): ReturnType<Core['confirmGrowthProposal']> {
      return this.core.confirmGrowthProposal(input)
    }

    /** 证据撤回（隐私第二档）：只打脱敏标记，里程碑与阶段都不动。 */
    redactMilestone(milestoneId: string): ReturnType<Core['redactMilestone']> {
      return this.core.redactMilestone(milestoneId)
    }

    /** 模型视角的最小上下文（§10）：阶段 + 几条立住的判断，不含计数与阈值。 */
    context(): ReturnType<Core['context']> {
      return this.core.context()
    }

    resolveContact(input?: ResolveContactInput): ReturnType<Core['resolveContact']> {
      return this.core.resolveContact(input ?? {})
    }
  }
}

/**
 * 插件入口：宿主加载时调一次，之后所有能力都挂在这一个 ctx 上。
 *
 * @param ctx 宿主上下文；tools / systemPrompt / webServer 都从这里注入。
 * @param config 已按 ConfigSchema 校验过的配置；整段禁用时宿主可能传 undefined。
 * @returns void——同步返回，真正的初始化在后台 boot 里跑。
 *
 * 副作用：建目录、开库、注册 11 个工具、挂 6 条路由、注册 systemPrompt 段落，
 * 外加一个卸载时关库的 effect。任何一步失败都只写进 `runtime.bootError`，
 * 不向宿主抛——插件加载抛异常会连累整个 profile，启动问题必须降级成页面上的提示。
 * 可能抛的错误：只有 effect 注册本身（宿主已拆）会抛，其余都被吞进日志。
 */
export function apply(ctx: Context, config: PsycheConfig): void {
  // 配置整段缺失时宿主会传 undefined：兜成空对象，后面一律走可选链 + ?? 默认值。
  const cfg: PsycheConfig = config ?? ({} as PsycheConfig)
  // 先建占位 runtime 再 boot：status()、工具桥接、路由都持有同一份引用，boot 只是往里填字段。
  const runtime: Runtime = {
    core: null,
    db: null,
    bootError: null,
    dataDir: '',
    driver: null,
    selfCheck: null,
    attempts: [],
    startedAt: nowIso(),
    dirs: {},
    prefs: { sea: false, promptSection: null },
    log: new OpLogger({ limit: 300 }),
    selfUsage: new SelfUsageLedger(),
    restore: null,
    restoreError: null,
    personaInit: null,
    personaInitError: null,
    init: null,
    status: () => statusOf(runtime, cfg),
  }
  // 日志双写：环形缓冲给面板/运维页回看，宿主 logger 给控制台。
  // 宿主 logger 全是可选的（宿主外跑单测时没有），所以每个方法都要 ?.。
  const logger: DbLogger = {
    debug: (message) => {
      runtime.log.debug('db', message)
      ctx.logger?.debug?.(message)
    },
    info: (message) => {
      runtime.log.info('db', message)
      ctx.logger?.info?.(message)
    },
    warn: (message) => {
      runtime.log.warn('db', message)
      ctx.logger?.warn?.(message)
    },
    error: (message) => {
      runtime.log.error('db', message)
      ctx.logger?.error?.(message)
    },
  }

  // ── 启动：开库 → 自检 → 迁移（§11.6 / §11.10）───────────────
  if (cfg.enabled === false) {
    logger.info?.('[psyche] 已在配置里关闭，跳过启动')
  } else {
    // dataDir 需要异步解析（可选 import），所以先建占位 runtime，再在 ready 里填
    const boot = async (): Promise<Runtime> => {
      const dataDir = await resolveDataDir(cfg.dataDir)
      runtime.dataDir = dataDir
      ensureProductDataDir(dataDir)
      // C 阶段：把生效策略与「被忽略的旧配置」落一行审计（只追加）。
      writeConfigAudit(dataDir, cfg, logger)

      // ── 恢复启动门禁（§34.14）：必须在 openDatabase() 之前 ────────────
      // 顺序是硬约束：先把待应用的恢复做完（可能要改数据根的名字），再去开库。
      // 反过来的话，本进程已经把 memory.sqlite3 打开，rename 会失败（Windows 尤其明显），
      // 更糟的是会出现「库开着、目录被换走」的分裂状态。
      // 拦截策略：recovery_required（现场不明确）不能赌，直接拒绝启动——宁可整页报错，
      // 也不要用一个可能是空库的目录去接写入。其它情况（no-pending / completed /
      // restored-old）都可以继续启动。
      try {
        const outcome = applyPendingRestore({ dataDir })
        runtime.restore = outcome
        if (outcome.applied) {
          logger.info?.(`[psyche] ${outcome.note}`)
        } else if (outcome.reason !== 'no-pending' && outcome.reason !== 'completed') {
          logger.warn?.(`[psyche] 恢复状态：${outcome.note}`)
        }
        if (outcome.reason === 'recovery-required') {
          throw new Error(outcome.note)
        }
      } catch (error) {
        runtime.restoreError = errorText(error)
        logger.error?.(`[psyche] 恢复门禁没通过，不打开数据库：${runtime.restoreError}`)
        // 抛给外层 catch → 落进 bootError，工具/面板都会报「没准备好」，而不是静默用旧数据。
        throw error
      }

      runtime.prefs = readPrefs(dataDir)
      const dirs = prepareDirs(dataDir)
      // 库文件名拼在数据目录下；改名等于换一个新库，旧库留在原处不会被删。
      const dbFile = join(dataDir, cfg.storage?.db || 'memory.sqlite3')
      mkdirSync(dirname(dbFile), { recursive: true })
      // openDatabase 负责驱动自检/回退 + migration；它抛错就是真的起不来
      // （磁盘满、二进制不兼容、库损坏），由外层 catch 收成 bootError。
      const opened = await openDatabase({
        file: dbFile,
        driverPreference: cfg.storage?.driver ?? 'auto',
        logger,
        slowQueryMs: cfg.performance?.slowQueryMs ?? 50,
        slowWarnMs: cfg.performance?.slowWarnMs ?? 200,
      })
      // 先落库再构造 Core：万一 Core 构造同步抛错，status() 至少还能报告 driver / selfCheck。
      runtime.db = opened.db
      runtime.driver = opened.driver
      runtime.selfCheck = opened.selfCheck
      runtime.attempts = opened.attempts
      // openDatabase 内部已经跑过 migration，这里只取它应用了哪几步（§11.10）
      const applied = opened.applied ?? []
      runtime.core = new Core({ db: opened.db, config: cfg, logger, dataDir })
      // ── R4-C：上次进程留下的 pending 回执标 interrupted ──────────────────
      // 单写者下，启动时还停在 pending 的 run 只可能是进程在 Composer 回填前退出。
      // 只动 pending；completed / not_applicable 都是已定论状态，不因重启回退。
      try {
        const interrupted = markInterruptedRecallRuns(opened.db)
        if (interrupted > 0) {
          logger.warn?.(`[psyche] 标记 ${interrupted} 条中断的召回回执为 interrupted`)
        }
      } catch (error) {
        logger.warn?.(`[psyche] 中断回执标记失败（不影响启动）：${errorText(error)}`)
      }
      runtime.dirs = dirs
      logger.info?.(
        `[psyche] 就绪：${opened.driver}，${dbFile}（迁移 ${applied.length} 步，自检 ${opened.selfCheck.ok ? '通过' : '未通过'}）`,
      )
      // ── 人格初始化状态（I-3）：只读判定一次，绝不自动初始化/恢复默认/覆盖漂移 ──
      // 判定失败不影响库读写：状态是「展示与保护」用的，不是启动前置条件。
      try {
        const snapshot = inspectInitialization({ dataDir, db: opened.db })
        runtime.personaInit = snapshot
        if (snapshot.state === 'locked') {
          logger.info?.(
            `[psyche] 人格已锁定：${snapshot.presetName ?? '未知预设'}${snapshot.presetVersion ? ` ${snapshot.presetVersion}` : ''}`,
          )
        } else if (snapshot.state === 'uninitialized') {
          logger.info?.('[psyche] 人格未初始化：等待 initialize（不自动套默认预设）')
        } else {
          logger.warn?.(`[psyche] 人格初始化状态 ${snapshot.state}：${snapshot.detail}`)
        }
      } catch (error) {
        runtime.personaInitError = errorText(error)
        logger.warn?.(`[psyche] 人格状态判定失败（不影响库读写）：${runtime.personaInitError}`)
      }
      // ── 人格初始化服务（I-7）：路由层的唯一入口 ──────────────────
      // 建在判定之后：服务自己会重新 inspect，不依赖上面那次快照；库已打开时传进去，
      // 让 finish 能把派生快照补齐（文件权威、库派生）。失败不应该发生（纯构造），
      // 万一抛也收进 personaInitError，让面板显示原因而不是整页崩。
      try {
        runtime.init = createPersonaInitService({ dataDir, db: opened.db })
      } catch (error) {
        runtime.personaInitError = errorText(error)
        logger.warn?.(`[psyche] 初始化服务创建失败：${runtime.personaInitError}`)
      }
      // ── FTS5 索引一致性（E4）：旧库升级/数据库恢复后，索引可能为空或与 head 不一致 ──
      // 只做两件事：空索引且库里有 head → 按 head 原子重建（首次启用/恢复后的正常路径）；
      // 其余不一致只告警，不自动修（自动修会把「为什么坏」一起修掉，损坏要人来判断）。
      try {
        const fts = verifyFtsIndex(opened.db)
        const drift =
          fts.missing.length + fts.orphan.length + fts.duplicate.length + fts.contentMismatch.length
        if (fts.headCount > 0 && fts.rowCount === 0) {
          const rebuilt = rebuildFtsIndex(opened.db)
          logger.info?.(`[psyche] FTS5 索引为空，已按 ${rebuilt.indexed} 条 head 重建`)
        } else if (drift > 0 || !fts.integrityOk) {
          logger.warn?.(
            `[psyche] FTS5 索引不一致（missing ${fts.missing.length} / orphan ${fts.orphan.length} / ` +
              `duplicate ${fts.duplicate.length} / contentMismatch ${fts.contentMismatch.length} / ` +
              `integrity ${fts.integrityOk ? 'ok' : 'bad'}）：只报告，按需调用 rebuildFtsIndex 修复`,
          )
        }
      } catch (error) {
        logger.warn?.(`[psyche] FTS5 一致性检查失败（不影响启动）：${errorText(error)}`)
      }
      // ── P0-B2：启动恢复摘要积压 ────────────────────────────────────────
      // 进程可能在「摘要已提交、续排还没落库」之间退出，留下的积压不会再有人补。
      // 实现在 `src/lib/digest-resume.ts`（抽出去是为了让测试能调用宿主真正走的这一段），
      // 内部按同一套资格判定（绑定仍活动 + 项目 active + 自动模式开）补出真正缺的那一条：
      // 幂等，不建定时器、不调用模型、不发消息。
      //
      // 「自动模式」开关属于 AM-1，本批尚未落到配置上；在它出现之前按开启处理，
      // 参数已经接好，等开关落地只改调用点。
      resumeDigestOnStartup({
        db: opened.db as never,
        now: new Date(),
        autoEnabled: true,
        log: (line) => logger.info?.(line),
      })
      // 自检不通过也不阻止启动：缺的只是某项能力（例如 FTS 不可用），降级能用好过整个不可用。
      if (!opened.selfCheck.ok) {        const failed = opened.selfCheck.items
          .filter((item) => !item.ok)
          .map((item) => `${item.name}: ${item.detail}`)
        logger.warn?.(`[psyche] 能力自检有问题：${failed.join('；')}`)
      }
      // 启动时补一次闸门评估：上次写入后如果进程崩了，阶段在这里补齐（幂等，不重复写里程碑）。
      try {
        const synced = await runtime.core.syncGrowth()
        if (synced.advanced.length > 0) {
          logger.info?.(`[psyche] 启动补齐 ${synced.advanced.length} 个阶段里程碑`)
        }
      } catch (error) {
        logger.warn?.(`[psyche] 启动时的阶段评估失败（不影响读写）：${errorText(error)}`)
      }
      return runtime
    }
    runtime.ready = boot().catch((error: unknown) => {
      runtime.bootError = error
      logger.error?.(`[psyche] 启动失败：${errorText(error)}`)
      return runtime
    })
  }

  // enabled=false 时上面没赋 ready：这里补一个已完成的 promise，
  // 让后面所有 await ready 立刻通过（只是 core 仍是 null，工具会报「没准备好」）。
  runtime.ready ??= Promise.resolve(runtime)

  // ready 与 core() 两层分开：读路径只要数据（db/selfCheck）就能渲染页面，
  // 只有真正要查 Core 的入口才用 core()——它会把 bootError 原样抛出来定位根因。
  const ready = runtime.ready
  const core = (): Promise<Core> =>
    ready.then(() => {
      if (!runtime.core) throw runtime.bootError ?? new Error('心灵还没准备好')
      return runtime.core
    })

  // 面板数据（v14 §24）：只读聚合，供侧栏状态页渲染。
  // 这里等的是 ready 而不是 core()：库没起来时面板仍要能显示启动记录与失败原因。
  const panel = async (): Promise<PanelPayload> => {
    await ready
    return buildPanel({
      dataDir: runtime.dataDir,
      enabled: cfg.enabled !== false,
      driver: runtime.driver,
      startedAt: runtime.startedAt,
      selfCheck: runtime.selfCheck,
      attempts: runtime.attempts,
      bootError: runtime.bootError,
      db: runtime.db,
      core: runtime.core,
      config: cfg,
      prefs: runtime.prefs,
      personaInit: runtime.personaInit,
      personaInitError: runtime.personaInitError,
    })
  }

  // 用量（v16 §32.1 修正口径）：只统计**心灵自己发起的模型调用**（日记 Writer、自述、摘要等）。
  // 不再汇总宿主活会话的 assistant/message.usage —— 那是整个 agent 的消耗，
  // 跟「这个插件花了多少」是两件事（用户 m08799 明确要求）。
  // 账本是内存的（`runtime.selfUsage`）：重启清零、不进库，用量不是记忆。
  const usage = async (hours: number): Promise<UsagePayload> => {
    await ready
    const samples = runtime.selfUsage.samples()
    return aggregateUsage(samples, {
      hours,
      now: Date.now(),
      emptyNote: '心灵自己还没有发起过模型调用：这一页只记插件自身的调用（日记生成、以后的自述/摘要等），不含对话本身的消耗。'
    })
  }

  // 运维（v14 §32）：健康、计数、最近操作、日志、备份。
  const ops = (): OpsPayload =>
    buildOps({
      db: runtime.db,
      logger: runtime.log,
      dataDir: runtime.dataDir,
      slowQueryMs: cfg.performance?.slowQueryMs ?? 50,
      note: runtime.bootError ? `启动有问题：${errorText(runtime.bootError)}` : undefined,
    })

  // 迁移包（v14 §33）：把这一份人格打成一个能搬到另一台电脑的文件。
  // 与 backups/ 的区别：backup 只有库、用于回滚；archive 带人格原文/配置/素材/清单，用于搬家。
  const makeArchive = () => {
    if (!runtime.db || !runtime.dataDir) throw new Error('数据库还没准备好')
    const result = createArchive({
      db: runtime.db,
      dataDir: runtime.dataDir,
      // 计数只是清单里的可读摘要，失败不该让整包打不出来，所以单独兜一层
      counts: (() => {
        try {
          return readCounters(runtime.db) as unknown as Record<string, number>
        } catch {
          return {}
        }
      })(),
      version: pluginVersion(),
      schemaVersion: runtime.db.userVersion(),
      algorithmVersion: ALGORITHM_VERSION,
      // E6-B：包要自证用途与快照路径。driver 只用于审计——恢复端不据此改变行为。
      kind: 'backup',
      driver: runtime.driver ?? 'node:sqlite',
    })
    runtime.log.info(
      'archive',
      `迁移包已导出：${result.file}（${Math.round(result.bytes / 1024)} KB，${result.manifest.files.length} 个文件，${result.durationMs} ms）`,
    )
    return result
  }

  // 列出 exports/ 里的迁移包，并顺手逐包校验（文件不多，页面上一次性给出「能不能用」更有用）。
  const archives = () => {
    const dataDir = runtime.dataDir
    if (!dataDir) return { ok: true, rows: [], note: '数据目录还没解析出来' }
    try {
      return { ok: true, rows: listArchiveRows(dataDir) }
    } catch (error) {
      return { ok: false, rows: [], error: errorText(error) }
    }
  }

  // 包路径归一：面板只给文件名（exports/ 下的），CLI 与测试给绝对路径。
  // 提前判存在是为了让 404 之前先给出「找不到哪个文件」，而不是让底层抛一个 ENOENT。
  const resolveArchiveFile = (dataDir: string, input: string): string => {
    const trimmed = input.trim()
    if (!trimmed) throw new Error('要指定迁移包（file：exports 里的文件名或绝对路径）')
    const candidate = isAbsolute(trimmed) ? trimmed : join(dataDir, 'exports', trimmed)
    if (!existsSync(candidate)) throw new Error(`找不到迁移包：${candidate}`)
    return candidate
  }

  // ── 工具（§9.1 的五写五读 + v14 补的 psyche_context）────────────
  // ── P2-Recall R3：可信身份绑定（工具与自动注入共用同一份）──
  // 只由宿主 Adapter / 探针写入；模型的工具参数永远进不到这里。
  const runtimeInputs = new RuntimeInputStore()

  // ── P3-A B2：每轮情绪判定的内存缓冲（默认开，见 Config.mood）──
  // 只收集 pre-step 里 source.kind === 'user' 的正文；turn-stopping 取走即清空。
  // 有界、不落盘；enabled=false 时监听器不注册（见 apply 里的 mood effect）。
  const moodTurns = new MoodTurnBuffer({
    maxText: cfg.mood?.maxText,
    excludeSessions: cfg.mood?.excludeSessions,
    // 轮首固化：本轮用哪版规则判定，之后改规则不回溯已完成轮次。
    configVersion: MOOD_RULES_VERSION,
  })
  // P5-4：Host 可信 Turn 时钟 + 每 (agent, session) 的档位状态；卸载时一并清空。
  const moodTurnClock = new MoodTurnClock()
  const moodBehaviorStates = new Map<string, MoodBehaviorState>()
  const moodBehaviorStateFor = (agent: { id?: string; session?: { id?: string } } | undefined): MoodBehaviorState | null => {
    const key = moodStateKey(agent)
    if (key === null) return null
    let state = moodBehaviorStates.get(key)
    if (state === undefined) {
      state = new MoodBehaviorState()
      moodBehaviorStates.set(key, state)
    }
    return state
  }

  // ── R6-1：桌面 personal 表面的可信身份绑定 ────────────────────────
  // 只由宿主 Agent 生命周期建立：agent/created 时绑定、agent/disposed 时清理。
  // 身份来自宿主信任域，不来自模型工具参数、用户文本、显示名或普通 HTTP 请求体。
  // stableUserId 优先用 DSH 自己的匿名用户 id（$DSH_HOME/.anonymous-user-id，随机 UUID、
  // 与机器名/网络地址无关）；缺失时由 psyche 在数据根内生成一份（同样随机 UUID）。
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  let desktopStableUserId: string | null = null
  const loadDesktopStableUserId = async (): Promise<string | null> => {
    if (desktopStableUserId !== null) return desktopStableUserId
    try {
      await ready
      const dshHome = dirname(runtime.dataDir)
      const anonymousFile = join(dshHome, '.anonymous-user-id')
      const persisted = existsSync(anonymousFile) ? readFileSync(anonymousFile, 'utf8').trim() : ''
      if (UUID_PATTERN.test(persisted)) {
        desktopStableUserId = persisted
        return persisted
      }
      const ownFile = join(runtime.dataDir, 'desktop-user-id')
      const own = existsSync(ownFile) ? readFileSync(ownFile, 'utf8').trim() : ''
      if (UUID_PATTERN.test(own)) {
        desktopStableUserId = own
        return own
      }
      const created = randomUUID()
      mkdirSync(runtime.dataDir, { recursive: true })
      writeFileSync(ownFile, `${created}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      desktopStableUserId = created
      return created
    } catch (error) {
      logger.warn?.(`[psyche] 桌面身份初始化失败：${String(error)}`)
      return null
    }
  }
  // ── R6-3A / R6-3C：可信通道绑定（Adapter 声明 → Host 校验 → Core 解析 → 能力绑定）──
  // Adapter 只能提交身份声明；Contact / Room 由 Core 解析；RuntimeInputStore.bind()
  // 只接受 Host 发放的一次性能力。注册入口收在 HostChannelRegistry 里：
  // 只有 Host 白名单内的内建 Adapter 能注册，普通插件拿不到 registry，也调不到 bind()。
  const hostChannels = new HostChannelRegistry()
  const agentLifecycle = new AgentBindingLifecycle()
  // R6-3C-Live：QQ Adapter 只在配置启用时由 Host 注册；桥本身只在收到 messages 时
  // 通过 `adapter.announce()` 提交声明，不接触 RuntimeInputStore.bind()。
  const qqAdapter = createQqAdapter()
  let qqBridge: QqBridge | null = null
  /**
   * P1-C：回复队列的 store 句柄。工具侧要用它做 `unknown` 的人工裁决
   * （`resolveUnknownByReminder`），而它是随桥接一起构造的，所以留个引用；
   * outbox 没启用时为 null，裁决工具会如实说「当前没有可用队列」。
   */
  let replyOutboxStore: QqReplyOutboxStore | null = null
  /**
   * 桥接最近一次的启动错误。
   *
   * `qqBridge === null` 有两种完全不同的原因：配置里没开（正常），
   * 和构造函数抛错（故障）。面板过去只看 `qqBridge !== null`，
   * 两者都显示成「QQ 通道没有启用」——故障就伪装成了「你没开」。
   */
  let qqStartError: string | null = null
  let bridgeFailedEpoch = 0
  // 提醒派发器：桥接就绪后才 start()，桥接重建时先 stop() 再换新的。
  let reminderTicker: ReminderTicker | null = null
  let groupScheduler: GroupScheduler | null = null
  let groupStarting: Promise<GroupScheduler|null> | null = null
  let groupRuntimeClosed=false
  let groupProofWarned=false
  // P4-A-3：只保留本次进程内的 QQ 桥日志（脱敏在入环前完成），供只读管理页消费。
  const qqLogs = new QqLogBuffer()
  // P8：本机独立控制中心。只管理自己启动的 SnowLuma 子进程；默认不启用、无匿名路由。
  let qqControl: QqControlCenter | null = null
  let qqManager: ManagedProcess | null = null
  /** Q1：QQ 访问控制与默认模型的插件覆盖层；数据目录不可写时为 null。 */
  let qqOverlay: QqSettingsOverlay | null = null
  /**
   * Q5-E：组装回执。只在内存里，不落库、不升 Schema。
   * 有了它，「召回到了但被预算裁掉」和「根本没召回」才分得开。
   */
  const assemblyReceipts = new AssemblyReceiptStore({ perSession: 20, total: 200 })
  /** 最近一次原话召回的明细，供回执读取（同一轮内同步写入，不会串）。 */
  /**
   * 召回结果按会话存，不是全局一份。
   *
   * 第 37 轮外部评审 P2（11）：「回执用共享最近值 + sessionId 关联，并行可丢、同会话可误挂上轮」。
   * 真机复现：用户会话 `session-1cf1920b` 的三条回执里，`recallSourceIds` 挂的是我这边
   * `session-6d420bb0` 的召回来源——两个会话同时在跑，最后一次写 wins。
   *
   * 改成按会话 id 存：pre-step 写自己那条，Composer 组装时取自己那条。
   * 侧栏并行、子代理并行都不会串。
   */
  const recallMetaBySession = new Map<
    string,
    {
      sourceIds: string[]
      sessionRef: string | null
      skipped: string | null
      /** Q5-F：这一轮是怎么判定的（ok / delegated / no-user-input / unresolved）。 */
      status: string | null
      queryMode: 'none' | 'continue' | 'specific' | null
      /** 命中的本轮用户消息 id，便于与回执对照。 */
      messageId: string | null
      at: number
    }
  >()
  /** 同轮只注入一次召回；按 (会话, 轮) 记，重入时不再重复追加。 */
  const recallTurnSeen = new Map<string, number>()
  /**
   * Q5 渠道判定：回答「谁在问」时要知道 Owner 是谁。优先取插件覆盖层的有效值
   * （管理员可能在控制中心改过），覆盖层不可用时退回宿主配置。取不到就是空串，
   * `resolveSessionChannel` 会把 QQ 私聊判成 other、读不到跨侧内容。
   *
   * 提前到这里是因为 pre-step 的日常召回也要用它，而它原先定义在
   * systemPrompt 注入块内部。
   */
  const ownerUin = (): string =>
    readOwnerUin({
      overlay: qqOverlay,
      host: config.qq?.allowFrom,
      runtime: {
        provider: config.qq?.provider ?? '',
        model: config.qq?.model ?? '',
      },
      onCorrupt: (reason) => {
        // 第 57 轮 P1-D：覆盖文件损坏时**不**退回宿主值——坏配置期间 QQ 侧不授予 Owner，
        // 否则名单里残留的旧号可能借宿主旧值拿到主人权限。桌面侧不受影响。
        // 第 20 轮追加：顺手把桥标成不可信，否则桥可能还在「上一次读是好的」的状态里。
        if (qqBridge !== null) qqBridge.markConfigUntrusted(reason)
      },
      trusted: () => qqBridge === null || qqBridge.configTrust().trusted,
    })
  /**
   * P1-C 第 16 轮：判断「现在这个会话是不是主人本人在说话」——只有主人能裁决 unknown 投递。
   * 判据与失败关闭口径见 `lib/reminder-owner.ts`（那边有单测）。
   */
  const isOwnerReminderScope = (
    db: { get?: <T>(sql: string, params?: readonly (string | number | null)[]) => T | undefined },
    receiver: { channel: 'qq' | 'desktop'; contactId?: string | null },
  ): boolean => isOwnerReminderScopeByScope(db, receiver, ownerUin())
  /** 最近一次项目 Brief 读到的 Checkpoint，供回执读取。 */
  let lastBriefMeta: { checkpointId: string | null; revision: number | null; sessionId: string | null } = {
    checkpointId: null,
    revision: null,
    sessionId: null,
  }
  let snowlumaOverride: string | null = null
  const qqSnowlumaDir = (): string => snowlumaOverride ?? cfg.qq?.snowlumaHome ?? ''
  const openLocalUrl = (url: string): void => {
    try {
      const spec = process.platform === 'win32'
        ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', url] }
        : process.platform === 'darwin'
          ? { command: 'open', args: [url] }
          : { command: 'xdg-open', args: [url] }
      spawn(spec.command, spec.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } catch (error) {
      logger.warn?.(`[psyche][qq-control] 打开控制中心失败：${errorText(error)}`)
    }
  }

  // P8-FINAL：QQ 页内嵌控制中心。只把带 fragment 令牌的 loopback URL 返回给同源页面，
  // 由 iframe 自己读取 fragment；不在父页面展示令牌，不打开外部浏览器窗口。
  // Q1：默认模型目录来自宿主 `llm` 服务。它可能晚于本插件注册，所以这里只取引用，
  // 真正查询放到控制中心 GET /api/model 时再走；服务缺失时模型页显示「目录不可用」
  // 并禁用保存，而不是给一个能填但校验不了的表单。
  let llmApi: LlmRuntime | null = null
  const injectLlm = ctx.inject.bind(ctx) as (
    deps: string[],
    callback: (llmCtx: Context) => void,
  ) => unknown
  injectLlm(['llm'], (llmCtx) => {
    llmApi = (llmCtx as unknown as { llm: LlmRuntime }).llm
  })

  // 归档是 Workspace 级状态：被归档的会话在 `agent/pre-step` 就被 Host 的
  // `ArchivedSessionGate` 拒掉——消息投进去了却没有回应，桥接只会看到
  // 「投递成功」然后永远等不到 assistant/message。QQ 会话归桥接独占管理，
  // 所以每个入站消息投递前都先确保它不在归档名单里。
  type WorkspaceControllerLike = {
    unarchiveSession?: (request: { sessionId: string }) => Promise<unknown>
    create?: (request: { path: string }) => Promise<{
      workspace: { workspaceId: string; title: string }
      created: boolean
    }>
    rename?: (request: { workspaceId: string; title: string }) => Promise<unknown>
    insertSessionBefore?: (request: {
      workspaceId: string
      sessionId: string
      beforeSessionId?: string
    }) => Promise<unknown>
    /**
     * 宿主没有 `workspace/list`（HTTP 方法表里确认过），唯一的读取面是这条流：
     * 每代先给一份完整 baseline，再给增量。工作区卡只取第一帧就断开。
     */
    follow?: (signal: AbortSignal) => AsyncIterable<WorkspaceFollowFrameLike>
  }
  type WorkspaceViewLike = {
    workspaceId: string
    path: string
    title: string
    sessionIds: string[]
  }
  type WorkspaceFollowFrameLike =
    | { type: 'baseline'; value: { items: WorkspaceViewLike[] } }
    | { type: 'replace'; value: { items: WorkspaceViewLike[] } }
    | { type: 'upsert'; workspace: WorkspaceViewLike }
    | { type: 'remove'; workspaceId: string }
    | { type: 'order'; workspaceIds: string[] }
    | { type: 'archived'; archivedSessionIds: string[] }
    | { type: 'pinned'; pinnedSessionIds: string[] }
  // session/create 同时带 workspaceId 与 sessionId 时，宿主会接受我们给的 id 并把
  // 它登记进该工作区（真机验证：返回 { sessionId: 'qq-private-probe-b-1' }，
  // workspace.json 里该工作区 members 出现这一条）。用它把桥接自己造的会话补进账目。
  type SessionsLike = {
    create?: (request: {
      workspaceId?: string
      cwd?: string
      sessionId?: string
      agentPreset?: string
    }) => Promise<{ sessionId: string }>
  }
  let sessionsApi: SessionsLike | null = null
  let workspaceApi: WorkspaceControllerLike | null = null
  /**
   * 工作区注册表。宿主的两条路里，只有实体上的 `attachSession` 能把**账外**会话
   * 补挂进工作区（`workspace/insertSessionBefore` 只做已登记会话的排序，账外会话
   * 直接被拒 `the session is not accounted`）。RPC 面没有 attach，所以只能注入服务。
   */
  type WorkspaceRegistryLike = {
    resolveByPath?: (path: string) => Promise<QqWorkspaceEntityLike | undefined>
  }
  let workspaceRegistryApi: WorkspaceRegistryLike | null = null
  injectLlm(['workspaceRegistry'], (rctx) => {
    workspaceRegistryApi =
      (rctx as unknown as { workspaceRegistry?: WorkspaceRegistryLike }).workspaceRegistry ?? null
  })
  injectLlm(['workspaceController'], (wctx) => {
    workspaceApi =
      (wctx as unknown as { workspaceController?: WorkspaceControllerLike }).workspaceController ?? null
  })
  injectLlm(['sessionController'], (sctx) => {
    sessionsApi = (sctx as unknown as { sessionController?: SessionsLike }).sessionController ?? null
  })

  // 宿主只在 `workspace/create` 时登记工作区条目：只给会话写 `meta.cwd` 的话，
  // 侧栏会把它归到「未分组」。dsh-qq 的做法是先建工作区、首次创建后改名，
  // 再把会话挂进去——这里照做，历史会话也会在下次投递时被搬回去。
  let qqWorkspaceId: string | null = null
  /**
   * 等 `workspaceController` 服务就绪。
   *
   * 启动补归属那一刻，宿主可能还没把这个服务注入进来；直接返回会让历史会话
   * 一直留在「未分组」，所以短暂等一会儿（最多约 3 秒）。
   */
  const waitWorkspaceApi = async (): Promise<WorkspaceControllerLike | null> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (workspaceApi !== null) return workspaceApi
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return workspaceApi
  }
  /** 等 `sessionController` 服务就绪（原因同上：插件可能先于服务注入完成注册）。 */
  const waitSessionsApi = async (): Promise<SessionsLike | null> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (sessionsApi !== null) return sessionsApi
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return sessionsApi
  }
  /** 等 `workspaceRegistry` 服务就绪（历史会话补挂唯一的入口，值得等这一下）。 */
  const waitWorkspaceRegistry = async (): Promise<WorkspaceRegistryLike | null> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (workspaceRegistryApi !== null) return workspaceRegistryApi
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return workspaceRegistryApi
  }
  /** 记录工作区补登/新建走到哪一步；宿主不落文本日志，只能自己写文件留证据。 */
  const noteWorkspaceStep = (sessionId: string, cwd: string, step: string): void => {
    try {
      writeFileSync(
        join(dirname(cwd), 'qq-workspace-probe.json'),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            sessionId,
            cwd,
            step,
            workspaceApi: workspaceApi !== null,
            sessionsApi: sessionsApi !== null,
            workspaceId: qqWorkspaceId,
          },
          null,
          2,
        ),
        'utf8',
      )
    } catch {
      // 留证据失败不能影响主流程。
    }
  }
  // 工作区卡：宿主的 HTTP 方法表里**没有** `workspace/list`（只有 create/rename/
  // insertSessionBefore/follow 等），所以「宿主实际名 + 成员数」只能靠 `workspace/follow`
  // 的 baseline 读一眼就断开。读不到就如实标「未核实」，不拿缓存猜。
  const QQ_WORKSPACE_TITLE = 'QQ 聊天'
  let qqWorkspaceCwd: string | null = null
  let qqWorkspaceCwdSource: 'config' | 'default' | 'unknown' = 'unknown'
  let qqWorkspaceAttempt: QqWorkspaceAttempt | null = null
  /**
   * 回执版本号：每次登记 +1。
   *
   * `attempt.at` 只有毫秒精度，同一会话在同一毫秒里重新登记会得到同一个时间戳；
   * 补读核对「还是不是同一份回执」需要时间戳之外的判据（GPT 第 34 轮）。
   */
  let qqWorkspaceAttemptSeq = 0
  let qqWorkspaceInFlight = 0
  /** 「查工作区 → 建工作区」的单次执行锁：并发到达的消息共用同一个 promise。 */
  let qqWorkspaceSetup: Promise<string | null> | null = null
  /**
   * 记一次登记尝试。
   *
   * `sessionId` 只在**会话级**动作（建会话、补挂、排序）上给：卡要用它核对「这条会话
   * 到底在不在成员里」（GPT 第 31 轮）。建工作区、改名不针对任何会话，给了就是假回执。
   */
  const recordWorkspaceAttempt = (
    step: string,
    ok: boolean,
    error?: string,
    sessionId?: string,
  ): void => {
    qqWorkspaceAttemptSeq += 1
    qqWorkspaceAttempt = {
      at: new Date().toISOString(),
      step,
      ok,
      seq: qqWorkspaceAttemptSeq,
      ...(error === undefined ? {} : { error }),
      ...(sessionId === undefined ? {} : { sessionId }),
    }
  }
  /** 路径比较：斜杠/反斜杠、大小写、末尾分隔符都不该让同一个目录判成两个。 */
  const workspacePathKey = (path: string): string =>
    path.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
  /** 读一次宿主工作区 baseline；`follow` 缺失、超时或没拿到有效帧返回 null（≠ 空清单）。 */
  const readWorkspaceViews = async (): Promise<WorkspaceViewLike[] | null> => {
    const api = await waitWorkspaceApi()
    const follow = api?.follow
    if (follow === undefined) return null
    return await readWorkspaceBaseline((signal) => follow.call(api, signal), {
      timeoutMs: 800,
      onError: (error) => logger.warn?.(`[psyche][qq] 读工作区清单失败：${String(error)}`),
    })
  }
  const currentQqWorkspace = async (): Promise<{
    items: WorkspaceViewLike[] | null
    found: WorkspaceViewLike | null
  }> => {
    const items = await readWorkspaceViews()
    if (items === null || qqWorkspaceCwd === null) return { items, found: null }
    const wanted = workspacePathKey(qqWorkspaceCwd)
    return { items, found: items.find((item) => workspacePathKey(item.path) === wanted) ?? null }
  }
  /**
   * 读一次清单并判一张卡。
   *
   * `readAt` 记的是**发起**时刻，判「读回是否早于登记」要用它；`priorMisses` 是此前
   * 已经有过几次「登记之后发起、且都没看到目标会话」的有效读回（第 32 轮：第一次缺席
   * 只算还没看到，第二次仍缺席才是矛盾）。
   */
  const buildWorkspaceCardOnce = async (priorMisses = 0): Promise<QqWorkspaceCard> => {
    const readAt = new Date().toISOString()
    const { items, found } = await currentQqWorkspace()
    return buildQqWorkspaceCard({
      cwd: qqWorkspaceCwd,
      cwdSource: qqWorkspaceCwdSource,
      expectedTitle: QQ_WORKSPACE_TITLE,
      serviceAvailable: workspaceApi?.create !== undefined,
      inFlight: qqWorkspaceInFlight > 0,
      attempt: qqWorkspaceAttempt,
      actual:
        found === null
          ? null
          : {
              workspaceId: found.workspaceId,
              title: found.title,
              path: found.path,
              memberCount: found.sessionIds.length,
              sessionIds: found.sessionIds,
            },
      read: items === null ? 'unavailable' : 'ok',
      readAt,
      priorMisses,
      checkedAt: new Date().toISOString(),
    })
  }
  /**
   * 工作区卡。
   *
   * 第 31/32 轮：补读策略在 `readWorkspaceCardWithRetry()` 里（纯函数、可测）——
   * 读回早于登记的缺席不算数，第二次有效缺席才报 `needs-review`；两次读之间目标换了
   * 就丢弃旧核验，按新目标重新核验。第 35 轮：每次读取前后都比一次回执版本（目标 + `seq`），
   * 期间变了就整份作废。
   */
  const qqWorkspaceCard = async (): Promise<QqWorkspaceCard> =>
    readWorkspaceCardWithRetry(
      (priorMisses) => buildWorkspaceCardOnce(priorMisses),
      () => qqWorkspaceAttempt,
    )
  /** 内嵌编辑表单唯一的写动作：改显示名。目录与配置来源只读展示。 */
  const renameQqWorkspace = async (title: string): Promise<QqWorkspaceCard> => {
    const api = await waitWorkspaceApi()
    if (api?.rename === undefined) throw new Error('宿主没有提供 workspace/rename')
    const { found } = await currentQqWorkspace()
    const workspaceId = found?.workspaceId ?? qqWorkspaceId
    if (workspaceId === null) throw new Error('宿主里还没有 QQ 工作区，先让一条 QQ 消息把它建出来')
    await api.rename({ workspaceId, title })
    recordWorkspaceAttempt('renamed', true)
    return await qqWorkspaceCard()
  }
  /**
   * 确保「QQ 聊天」工作区存在，返回它的 id（服务不可用或目录建不出来时返回 null）。
   *
   * 宿主的 `workspace/create` 会先 realpath 这个路径，目录不存在就直接 invalid-path；
   * 早期版本只把 cwd 写进 meta、从未建过目录，所以这里必须先落盘。
   */
  const ensureQqWorkspaceRoot = async (cwd: string, sessionId: string): Promise<string | null> => {
    // 同一时刻只执行一次「查已有工作区 → 建工作区」：两条 QQ 消息几乎同时到达时，
    // 如果各查各建，就会产出两个同路径工作区（GPT 第 2 轮第 1 条）。
    if (qqWorkspaceSetup !== null) return await qqWorkspaceSetup
    const run = (async (): Promise<string | null> => {
      qqWorkspaceInFlight += 1
      try {
        // 非全限定路径一定过不了宿主的 realpath 校验，没必要送去撞一次——
        // 就地记成 invalid-cwd，卡上会显示「需人工核对」，也不会留下半成品工作区。
        if (!isQualifiedWorkspacePath(cwd)) {
          noteWorkspaceStep(sessionId, cwd, 'invalid-cwd')
          recordWorkspaceAttempt('invalid-cwd', false, `工作区路径不是绝对路径：${cwd}`, sessionId)
          return null
        }
        const api = await waitWorkspaceApi()
        noteWorkspaceStep(sessionId, cwd, api === null ? 'workspace-api-missing' : 'workspace-api-ready')
        if (api?.create === undefined) {
          recordWorkspaceAttempt('workspace-api-missing', false, undefined, sessionId)
          return null
        }
        try {
          mkdirSync(cwd, { recursive: true })
        } catch (error) {
          logger.warn?.(`[psyche][qq] 创建工作区目录失败：${cwd}（${String(error)}）`)
          recordWorkspaceAttempt('mkdir', false, String(error))
          return null
        }
        if (qqWorkspaceId === null) {
          // 先按目录找已有的：workspace/create 成功但 session/create 失败后重试、
          // 或插件重启把内存里的 id 丢了，都不该再建一个同路径的工作区（GPT 第 1 轮第 1 条：
          // 非幂等重试会产生重复工作区）。找到就复用，不再 create。
          let views = await readWorkspaceViews()
          if (views === null) views = await readWorkspaceViews()
          if (views === null) {
            // follow 超时或 baseline 读不到时，不能据此推断「工作区不存在」——
            // 宁可这次失败，也不拿一次失败的读取去 create（GPT 第 2 轮第 1 条）。
            recordWorkspaceAttempt('workspace/read', false, '读取宿主工作区清单失败')
            throw new Error('读取宿主工作区清单失败，这次先不创建工作区')
          }
          const wanted = workspacePathKey(cwd)
          const existing = views.find((item) => workspacePathKey(item.path) === wanted) ?? null
          if (existing !== null) {
            qqWorkspaceId = existing.workspaceId
            recordWorkspaceAttempt('reused', true)
            return qqWorkspaceId
          }
          let value: Awaited<ReturnType<NonNullable<WorkspaceControllerLike['create']>>>
          try {
            value = await api.create({ path: cwd })
          } catch (error) {
            recordWorkspaceAttempt('workspace/create', false, String(error))
            throw error
          }
          qqWorkspaceId = value.workspace.workspaceId
          if (value.created && api.rename !== undefined) {
            try {
              await api.rename({ workspaceId: qqWorkspaceId, title: QQ_WORKSPACE_TITLE })
            } catch (error) {
              // 标题重复等情况不影响使用：工作区已经建好，只是名字没改成。
              // 记成失败，卡上会显示「需人工核对」，用户可以就地改名。
              logger.warn?.(`[psyche][qq] 工作区改名失败：${String(error)}`)
              recordWorkspaceAttempt('rename', false, String(error))
              return qqWorkspaceId
            }
          }
          recordWorkspaceAttempt(value.created ? 'created' : 'reused', true)
        }
        return qqWorkspaceId
      } finally {
        qqWorkspaceInFlight -= 1
      }
    })()
    qqWorkspaceSetup = run
    try {
      return await run
    } finally {
      qqWorkspaceSetup = null
    }
  }
  const ensureQqWorkspace = async (sessionId: string, cwd: string): Promise<void> => {
    const workspaceId = await ensureQqWorkspaceRoot(cwd, sessionId)
    const registry = await waitWorkspaceRegistry()
    const api = workspaceApi
    const result = await attachQqSessionToWorkspace({
      workspaceId,
      sessionId,
      cwd,
      ...(registry?.resolveByPath === undefined
        ? {}
        : { resolveWorkspace: (path: string) => registry.resolveByPath!(path) }),
      ...(api?.insertSessionBefore === undefined
        ? {}
        : {
            insertSessionBefore: (request: { workspaceId: string; sessionId: string }) =>
              api.insertSessionBefore!(request),
          }),
    })
    if (result.status === 'attached') {
      // 顺序没调成不影响归属，只是新会话排到了末尾；如实记一步，卡上可查。
      recordWorkspaceAttempt(result.ordered ? 'attached' : 'attached-unordered', true, undefined, sessionId)
      noteWorkspaceStep(sessionId, cwd, result.ordered ? 'session-attached' : 'session-attached-unordered')
      return
    }
    // 补挂失败就是补挂失败：不退到 insertSessionBefore（它对账外会话只会再失败一次），
    // 也不假装成功。卡上会显示「需人工核对」并带上阶段与原因。
    logger.warn?.(`[psyche][qq] 会话补挂工作区失败（${result.stage}）：${result.error}`)
    recordWorkspaceAttempt(`attach:${result.stage}`, false, result.error, sessionId)
    noteWorkspaceStep(sessionId, cwd, `session-attach-failed:${result.stage}`)
  }

  /**
   * 按固定 id 建 QQ 会话（`createSessionThroughControllers` 的生产实现）。
   *
   * 先把「QQ 聊天」工作区确保出来，再让宿主的 `session/create` 带着 workspaceId 与
   * 我们给的 sessionId 建会话：宿主会同时建出 Agent 并登记进工作区（真机实测，
   * 返回后 `session/state` 就是 active 的活 Agent），不再出现「agents.create 造出来
   * 的会话不在宿主账目里」那种账外会话。
   *
   * @returns 宿主实际使用的会话 id，由桥接核对是不是我们要的那个。
   */
  const createQqSession = async (sessionId: string, cwd: string): Promise<string> => {
    const workspaceId = await ensureQqWorkspaceRoot(cwd, sessionId)
    if (workspaceId === null) throw new Error('workspaceController 不可用，无法把 QQ 会话登记进工作区')
    const sessions = await waitSessionsApi()
    if (sessions?.create === undefined) throw new Error('sessionController 不可用，无法按指定 id 建会话')
    let created: { sessionId: string }
    try {
      created = await sessions.create({ workspaceId, sessionId })
    } catch (error) {
      recordWorkspaceAttempt('session/create', false, String(error), sessionId)
      throw error
    }
    recordWorkspaceAttempt('session/create', true, undefined, sessionId)
    noteWorkspaceStep(sessionId, cwd, 'session-created')
    return created.sessionId
  }

  const ensureQqControl = async (): Promise<QqControlCenter> => {
    const dataDir = runtime.dataDir || (await resolveDataDir(cfg.dataDir))
    if (qqManager === null) qqManager = new ManagedProcess('snowluma')
    if (qqOverlay === null) {
      qqOverlay = new QqSettingsOverlay({ file: join(dataDir, 'qq-overrides.json'), logger })
    }
    if (qqControl === null) {
      const overlay = qqOverlay
      qqControl = new QqControlCenter({
        stateDir: join(dataDir, 'qq-control'),
        manager: qqManager,
        // Q5-E：把组装回执接到控制中心，这样「提示里到底放了什么」可查。
        receipts: assemblyReceipts,
        snowlumaDir: qqSnowlumaDir,
        setSnowlumaDir: (dir) => {
          snowlumaOverride = dir
        },
        bridge: {
          connect: () => qqBridge?.start(),
          disconnect: async () => { await qqBridge?.stop() },
          reconnect: () => qqBridge?.reconnectNow(),
          snapshot: () => qqBridge?.adminSnapshot() ?? null,
        },
        openBrowser: openLocalUrl,
        logger,
        // Q1：访问控制与默认模型的写入入口。宿主只读展示，写入在这里完成，
        // 因为这里已经有 loopback + 一次性令牌 + Origin/Host 校验。
        workspace: {
          snapshot: () => qqWorkspaceCard(),
          rename: (title: string) => renameQqWorkspace(title),
        },
        settings: {
          overlay,
          hostAccess: () => config.qq?.allowFrom,
          hostModel: () => ({ provider: config.qq?.provider ?? '', model: config.qq?.model ?? '' }),
          apply: (snapshot) => {
            qqBridge?.applyAccess(snapshot.hasAccessOverride ? snapshot.access : null)
            qqBridge?.applyModelSelection(snapshot.hasModelOverride ? snapshot.modelSelection : null)
            // 第二批：时段规则和名单一样，保存后立刻让发送路径用新值。
            qqBridge?.applyReplySchedules(snapshot.replySchedules)
            // 第 57 轮 P1-D：保存成功即代表覆盖层重新可信（三组一起完整校验过）。
            qqBridge?.markConfigTrusted()
          },
          // 迁移 37：控制中心在写覆盖文件之前先走这一步。记不下来就整次变更作废，
          // 磁盘上不会留下「文件改了、没人记得变更没走完」的状态。
          prepareAccess: (access) => {
            qqBridge?.beginAccessChange(access)
          },
          reapplyAccess: () => qqBridge?.reapplyAccess() ?? { ok: true, peers: [] },
          catalog: createQqModelCatalog(() => llmApi),
        },
      })
    }
    return qqControl
  }
  const registerHostDesktopAdapter = (): void => {
    hostChannels.register('host-desktop', {
      adapterId: 'host-desktop',
      platform: 'desktop',
      allowedSurfaces: ['personal', 'private'],
      resolveIdentity: async (context) => {
        const stableUserId = await loadDesktopStableUserId()
        if (stableUserId === null) return null
        // Desktop 会话按 personal 表面认领；本人 private 是否可见，取决于 Core 能否解析出本人 Contact。
        return { kind: 'personal', stableUserId, channelId: context.sessionId }
      },
    })
  }
  const sessionIdOf = (payload: unknown): string | null => {
    const agent = (payload as { agent?: { id?: string; session?: { id?: string } } } | undefined)?.agent
    const id = agent?.id ?? agent?.session?.id
    return typeof id === 'string' && id.length > 0 ? id : null
  }
  /** QQ 桥的日志适配：把 detail 折成一行，避免 logger 支持结构化字段。 */
  const formatBridgeLog = (message: string, detail?: Record<string, unknown>): string =>
    detail === undefined ? message : `${message} ${JSON.stringify(detail)}`
  // R6-3C-Live：QQ 通道依赖宿主 `agents` 服务。这里用 ctx.inject 声明，
  // 服务缺失时 QQ 桥不启动、其余功能照常；同时避免在无 inject 时访问
  // `ctx.agents` 抛「cannot get property without inject」把进程带崩。
  // agents 由 dsh-agent 在运行时注册，但本仓库的 ServiceMap 类型没有合并该服务名，
  // 所以这里用一次类型断言调用 inject；运行时行为与 ctx.inject(['agents']) 一致。
  const injectAgents = ctx.inject.bind(ctx) as (
    deps: string[],
    callback: (agentsCtx: Context) => void,
  ) => unknown
  injectAgents(['agents'], (agentsCtx) => {
    // 配置显式启用时才注册 QQ Adapter 并连 OneBot；
    // 注册失败（白名单/定义不一致）只记日志，不带病启动。
    const qqConfig = config.qq
    if (qqConfig === undefined || !qqConfig.enabled) return
    try {
      hostChannels.register('qq-snowluma', qqAdapter.definition)
      // QQ 会话统一落在「QQ 聊天」工作区：DSH 用 session header 的 cwd 分组，
      // 不传就落到 sessions/_no-cwd（界面上看不见工作区，也不好归档）。
      // 注意：DSH 会校验 cwd 目录必须真实存在，否则 turn 直接报
      // `working-directory: directory does not exist`，所以先建目录。
      // 路径必须是全限定的：宿主 `workspace/create` 会先 realpath，非绝对路径直接
      // 报 `Workspace path is not fully qualified`，工作区建不出来、会话就留在未分组。
      // 这里统一走 resolveQqWorkspaceCwd：配置 → 磁盘上已有 QQ 会话的 cwd → 宿主工作
      // 目录。中间的「已有会话目录」很关键——宿主按会话 header 的 cwd 归属工作区，历史
      // QQ 会话的 cwd 早就定死在当时解析出来的绝对路径（本机是 D:\project\psyche\QQ 聊天），
      // 而插件进程的工作目录在升级后变成了 %USERPROFILE%\.dsh\profiles\<profile>，
      // 只按 process.cwd() 推会把新旧会话劈成两组。
      const existingQqCwd = findExistingQqSessionCwd({
        sessionsDirs: defaultSessionsDirs(runtime.dataDir),
      })
      const qqCwd = resolveQqWorkspaceCwd({
        configured: qqConfig.cwd,
        existing: existingQqCwd,
        cwd: process.cwd(),
      })
      // 工作区卡要如实说这个目录是从配置里读的，还是按默认规则推出来的。
      qqWorkspaceCwd = qqCwd
      qqWorkspaceCwdSource = qqConfig.cwd !== '' ? 'config' : 'default'
      mkdirSync(qqCwd, { recursive: true })
      let bridge:QqBridge
      const ensureGroupRuntime=async(target:Core,isActive:()=>boolean):Promise<GroupScheduler|null>=>{
        if(!isActive()||groupRuntimeClosed)return null
        if(groupScheduler?.ready)return groupScheduler
        if(groupScheduler){await groupScheduler.stop();groupScheduler=null}
        groupStarting??=startQqGroupRuntime({
          core:target,host:agentsCtx,bridge,groups:qqConfig.groups,provider:qqConfig.provider,model:qqConfig.model,cwd:qqCwd,
          active:()=>isActive()&&!groupRuntimeClosed,
          warn:(code)=>{if(code==='GROUP_PROOF_UNAVAILABLE'){if(groupProofWarned)return;groupProofWarned=true}logger.warn?.(`[psyche][group] ${code}`)},
          announce(snapshot){
            const b=snapshot.batch
            const sender=target.db.get<{stable_user_id:string}>(`SELECT c.stable_user_id FROM room_batch_members m JOIN sources s ON s.source_id=m.source_id JOIN contacts c ON c.contact_id=s.sender_contact_id WHERE m.batch_id=? AND m.is_trigger=1 ORDER BY m.room_seq LIMIT 1`,[b.batch_id])
            if(!sender)throw new Error('GROUP_SENDER_BINDING_UNAVAILABLE')
            qqAdapter.announce(b.session_id,{kind:'group',stableUserId:sender.stable_user_id,externalRoomId:JSON.parse(b.policy_json).externalRoomId})
          },
          bound(sessionId,roomId){
            const binding=runtimeInputs.read(sessionId)
            return binding?.platform==='qq'&&binding.contactId===null&&!!target.db.get("SELECT 1 FROM rooms WHERE room_id=? AND platform='qq' AND external_room_id=?",[roomId,binding.groupId??''])
          },
          forget(sessionId){qqAdapter.forget(sessionId);runtimeInputs.clear(sessionId)},
        }).then(async scheduler=>{
          if(!isActive()||groupRuntimeClosed){await scheduler?.stop();return null}
          groupScheduler=scheduler;return scheduler
        }).catch((error)=>{const code=error instanceof Error&&/^GROUP_[A-Z_]+$/.test(error.message)?error.message:'GROUP_START_UNAVAILABLE';logger.warn?.(`[psyche][group] ${code}`);return null}).finally(()=>{groupStarting=null})
        return groupStarting
      }
      bridge = new QqBridge(
        {
          enabled: true,
          wsUrl: qqConfig.wsUrl,
          accessToken: qqConfig.accessToken,
          snowlumaHome: qqConfig.snowlumaHome,
          provider: qqConfig.provider,
          model: qqConfig.model,
          cwd: qqCwd,
          reconnectMs: qqConfig.reconnectMs,
          maxText: qqConfig.maxText,
          groups: qqConfig.groups,
          contacts: qqConfig.contacts,
          replyOutbox: qqConfig.replyOutbox,
          resolveContactId: async (stableUserId) => {
            try {
              return (await core()).findContactId('qq', stableUserId)
            } catch {
              return null
            }
          },
          allowFrom: qqConfig.allowFrom,
          unknownPolicy: qqConfig.unknownPolicy,
          rejectCooldownMs: qqConfig.rejectCooldownMs,
          rejectGlobalLimit: qqConfig.rejectGlobalLimit,
          rejectGlobalWindowMs: qqConfig.rejectGlobalWindowMs,
        },
        {
          host: agentsCtx as unknown as import('./lib/qq-bridge.js').QqBridgeHost,
          adapter: qqAdapter,
          // 消息投递前确认 Host 已完成身份绑定，避免 Capture 先于绑定写 null。
          isSessionBound: (sessionId) => runtimeInputs.read(sessionId) !== null,
          // 被归档的会话在 Host 的 `agent/pre-step` 直接被拒，桥接这边只会看到
          // 「投递成功」然后永远等不到回复。走 Host 的正式接口恢复，不直接改存储文件。
          unarchiveSession: async (sessionId) => {
            const api = workspaceApi
            if (api?.unarchiveSession === undefined) return
            await api.unarchiveSession({ sessionId })
          },
          // 让 QQ 会话落在「QQ 聊天」工作区：只写 meta.cwd 会掉进「未分组」。
          ensureSessionWorkspace: async (sessionId) => {
            await ensureQqWorkspace(sessionId, qqCwd)
          },
          // 全新 QQ 会话的生产创建路径：workspace/create + session/create 按固定 id 建，
          // 宿主当场发布活 Agent 并把它登记进工作区（真机实测），不再出现账外会话。
          createSessionThroughControllers: (sessionId) => createQqSession(sessionId, qqCwd),
          ingestGroupMessage: async (input, isActive) => {
            const target = await core()
            if(!isActive()||groupRuntimeClosed)return null
            if(input.policy?.reply.enabled)await ensureGroupRuntime(target,isActive)
            if(!isActive()||groupRuntimeClosed)return null
            const result=await target.ingestGroupMessage({...input,schedulingReady:groupScheduler?.ready===true})
            if(!result.replayed&&groupScheduler?.active&&isActive())try{await groupScheduler.notify(result.roomId)}catch{logger.warn?.('[psyche][group] GROUP_PUMP_FAILED')}
            return result
          },
          onGroupConnectionGap:()=>groupScheduler?.noteInboundGap(),
          // 第二批（GPT 第 2 轮裁定 a）：时段外的独立私聊采集。只写 Source + Event，
          // 不建回复轮、不排队、不发送——「时段外不进记忆」是不允许的。
          ingestPrivateMessage: async (input) => {
            const target = await core()
            const result = await target.ingestPrivateMessage(input)
            return { sourceId: result.sourceId, eventId: result.eventId, replayed: result.replayed }
          },
          // 采集开关跟着宿主走：关掉自动采集时，时段外这条独立路径也不许写记忆。
          captureEnabled: cfg.capture?.enabled === true,
          // 迁移 36：授权代次的策略侧持久化。不注入的话重启后代次归零，而任务行
          // 上的 access_epoch 还停在旧值，所有在途回复都会被判 access-superseded——
          // 表现为「重启之后他就不理我了」。库不可用时返回空/丢弃，由桥接保持内存行为。
          accessEpochStore: {
            load: () => {
              const db = runtime.db
              if (db === null) return new Map()
              try {
                return loadAccessEpochs(db as unknown as Parameters<typeof loadAccessEpochs>[0], 'main')
              } catch (error) {
                logger.warn?.('[psyche][qq] 授权代次读取失败')
                return new Map()
              }
            },
            save: (epochs) => {
              const db = runtime.db
              if (db === null) return
              saveAccessEpochs({
                db: db as unknown as Parameters<typeof saveAccessEpochs>[0]['db'],
                personaId: 'main',
                epochs,
                now: new Date().toISOString(),
              })
            },
            // 迁移 37 两阶段提交：先把「打算涨到几代」落盘，再改名单，最后提交并清标记。
            // 这样做是为了覆盖「撤销 → 重新授权 → 代次写失败 → 重启」这个组合：
            // 只看覆盖文件会以为是新名单、只看库会看到旧代次，两者拼起来正好把旧任务放回来。
            begin: (targets) => {
              const db = runtime.db
              if (db === null) throw new Error('数据库不可用，无法记录待完成的授权变更')
              beginAccessEpochChange({
                db: db as unknown as Parameters<typeof beginAccessEpochChange>[0]['db'],
                personaId: 'main',
                targets,
                now: new Date().toISOString(),
              })
            },
            commit: (epochs) => {
              const db = runtime.db
              if (db === null) throw new Error('数据库不可用，无法提交授权代次')
              commitAccessEpochChange({
                db: db as unknown as Parameters<typeof commitAccessEpochChange>[0]['db'],
                personaId: 'main',
                epochs,
                now: new Date().toISOString(),
              })
            },
            loadPending: () => {
              const db = runtime.db
              if (db === null) return new Map()
              return loadPendingEpochs(db as unknown as Parameters<typeof loadPendingEpochs>[0], 'main')
            },
          },
          // 显式注入定时器：桥内部创建发送超时计时器后需要能清理，
          // 否则每次成功发送都会在 10 秒后多打一条「回复发送超时」的误报。
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
          logger: {
            // 同时进内存 ring buffer 与 stdout：管理页只能看最近 200 条，stdout 保留排障可见性。
            info: (message, detail) => {
              const line = formatQqLogLine(message, detail)
              qqLogs.push('info', line)
              console.warn(line)
            },
            warn: (message, detail) => {
              const line = formatQqLogLine(message, detail)
              qqLogs.push('warn', line)
              console.warn(line)
            },
            error: (message, detail) => {
              const line = formatQqLogLine(message, detail)
              qqLogs.push('error', line)
              console.warn(line)
            },
          },
        },
      )
      // P4-C-0：把桥包装成 ChatTransport；助手回复走 Transport，准入仍由桥处理。
      bridge.attachTransport(
        createQqTransport({
          sendText: (target, text) => bridge.sendOutgoingText(target, text),
          status: () => bridge.transportStatus(),
          waitConnected: (timeoutMs) => bridge.transportWaitConnected(timeoutMs),
        }),
      )
      // Q1：应用插件覆盖层（如果有），让第一次连上就用有效名单而不是宿主旧值。
      // 第 57 轮 P1-D：覆盖文件坏了**不再**退回宿主配置继续发——整份校验失败就无法可靠
      // 识别哪些对象原本被暂停，退回旧名单等于让主人设的暂停悄悄失效。改为把桥标记成
      // 「配置不可信」：入站不回复、出站返回 config-corrupt、队列保持等待，直到文件被还原。
      // 这里不 await 解析数据目录：能走到这一步说明 boot 已经把它解析好了。
      const applyQqOverlay = (origin: 'boot' | 'recheck'): boolean => {
        const hostAccess = qqConfig.allowFrom
        const hostModel = { provider: qqConfig.provider, model: qqConfig.model }
        if (qqOverlay === null) {
          const dirForOverlay = runtime.dataDir
          if (dirForOverlay === '') return bridge.configTrust().trusted
          qqOverlay = new QqSettingsOverlay({ file: join(dirForOverlay, 'qq-overrides.json'), logger })
        }
        try {
          const snapshot = qqOverlay.effective(hostAccess, hostModel)
          // 第 20 轮：运行中每秒都会走一次校验。已经可信且配置没变时不重复应用，
          // 免得 applyAccess 无谓地推进授权代次、把在途行打成「过了代次」。
          if (origin === 'recheck' && bridge.configTrust().trusted) return true
          // 只有三组一起完整校验通过并应用之后才解除暂停（第 19 轮第 3 条）。
          if (snapshot.hasAccessOverride) bridge.applyAccess(snapshot.access)
          if (snapshot.hasModelOverride) bridge.applyModelSelection(snapshot.modelSelection)
          bridge.applyReplySchedules(snapshot.replySchedules)
          bridge.markConfigTrusted()
          return true
        } catch (error) {
          bridge.markConfigUntrusted(errorText(error))
          if (origin === 'boot') {
            logger.warn?.(`[psyche][qq] 覆盖配置不可信，QQ 收发已暂停：${errorText(error)}`)
          }
          return false
        }
      }
      const recheckQqOverlay = (): boolean => applyQqOverlay('recheck')
      applyQqOverlay('boot')
      // 配置可信性检查入口：桥内节流 1 秒，每次入站/出站都试一次，所以
      // ①文件还原后无需重启；②文件在运行中被改坏也能立刻发现（不等重启）。
      bridge.setConfigRecheck(recheckQqOverlay)
      bridge.start()
      // 早期版本创建 QQ 会话时只写了 meta.cwd、没登记工作区，它们会留在侧栏
      // 「未分组」。启动时按库里出现过的 QQ 会话 id 补一次归属：幂等，失败只告警。
      void core()
        .then(async (target) => {
          if (qqBridge !== bridge) return
          const rows = target.db.all<{ session_ref: string }>(
            "SELECT DISTINCT session_ref FROM sources WHERE session_ref LIKE 'qq-%'",
          )
          for (const row of rows) {
            if (qqBridge !== bridge) return
            await ensureQqWorkspace(row.session_ref, qqCwd)
          }
        })
        .catch((error) => {
          logger.warn?.(`[psyche][qq] 补历史会话的工作区归属失败：${errorText(error)}`)
        })
      // P4-B-4-2b：默认关闭；开启时由 Outbox Worker 独占私聊回复发送。
      if (qqConfig.replyOutbox.enabled) {
        void core().then((target) => {
          if (qqBridge !== bridge) return
          const store = new QqReplyOutboxStore({
            db: target.db,
            ownerId: 'main',
            // P1-B：提醒行撞上安静时段要延后而不是取消。普通对话回复不走这里。
            // P1-D 第 20 轮：这里同时充当「发送前重读配置」的触发点——Worker 领取时读的是
            // 排队前的缓存结论，文件可能在那之后被改坏。重读一次，坏了就退化成暂停。
            nextAllowedAt: (row, now) => {
              recheckQqOverlay()
              const current = qqBridge
              if (current === null) return null
              current.recheckConfigNow()
              const at = current.nextPrivateSendAt(row.stableUserId, new Date(now))
              if (at === null) return null
              // 规则暂停 / 八天内无窗口 / 配置不可信：用远未来占位，行停在等待态而不是被判死。
              return at === 'paused' ? NO_REPLY_WINDOW_AT : at.toISOString()
            },
          })
          replyOutboxStore = store
          bridge.attachReplyOutbox(store, { enabled: true })
        }).catch(() => logger.warn?.('[psyche][qq] replyOutbox 初始化失败，助手回复将由 Worker 之外路径兜底'))
      }
      qqBridge = bridge
      // 提醒派发：桥接就绪后才开始扫——扫出来的行要立刻能进 QQ 队列，
      // 所以 transportId 必须已经存在，否则那一轮只会空转到下一分钟。
      void core()
        .then((target) => {
          if (qqBridge !== bridge) return
          const delivery = createReminderDelivery({
            db: target.db as never,
            personaId: 'main',
            ownerId: 'main',
            bridge: () => {
              const current = qqBridge
              if (current === null) return null
              // 桥接没连上时 transportId 为空，delivery 自己会跳过整轮；这里只做类型上的收窄。
              return current
            },
            enqueue: (input) => enqueueReminderReply(input as never),
          })
          reminderTicker?.stop()
          reminderTicker = new ReminderTicker({
            tick: delivery.tick,
            onError: (error) => logger.warn?.(`[psyche][reminder] 扫描失败：${errorText(error)}`),
          })
          reminderTicker.start()
        })
        .catch(() => logger.warn?.('[psyche][reminder] 派发器初始化失败，到点提醒不会自动送出'))
      // Recovery is independent of a new message; no previous submitted Turn/intent is resent.
      void core().then(target=>ensureGroupRuntime(target,()=>!groupRuntimeClosed&&qqBridge===bridge)).catch(()=>logger.warn?.('[psyche][group] GROUP_START_UNAVAILABLE'))
    } catch (error) {
      logger.warn?.(`[psyche] QQ 通道启动失败：${String(error)}`)
      qqStartError = errorText(error)
      bridgeFailedEpoch += 1
      qqBridge = null
    }
  })
  ctx.effect(() => {
    registerHostDesktopAdapter()
    const onCreated = ctx.on('agent/created', (payload: unknown) => {
      const sessionId = sessionIdOf(payload)
      if (sessionId === null) return
      // R6-4A：每个 Agent 生命周期一个代际。异步解析结束前必须复核代际仍然有效，
      // 否则 disposed 之后迟到的解析会把刚清掉的绑定重新写回来。
      const generation = agentLifecycle.begin(sessionId)
      // 不阻塞宿主创建 Agent：绑定在后台完成；首个请求若还没绑上，
      // pre-step 会按「无可信身份」只召回全局（fail closed）。
      void (async () => {
        const instance = await core()
        const db = runtime.db
        if (db === null) return
        const binding = await hostChannels.resolve(
          {
            db,
            store: runtimeInputs,
            lifecycle: agentLifecycle,
            resolveContact: async (input) => {
              const resolved = await instance.resolveContact(input)
              return { contactId: resolved.contactId }
            },
          },
          {
            agentId: sessionId,
            sessionId,
            generation,
            // QQ 会话 id 由 QQ 桥约定（qq-private-* / qq-group-*）。只有 Host 认识这个前缀，
            // Adapter 自己不能指定 platformHint；其他会话仍由 desktop Adapter 认领。
            platformHint: sessionId.startsWith('qq-') ? 'qq' : undefined,
          },
        )
        if (binding === null) return
        logger.debug?.(binding.surface==='group'?'[psyche] runtime binding: platform=qq surface=group bound=true':
          `[psyche] runtime binding: session=${binding.sessionId} platform=${binding.platform} surface=${binding.surface} contact=${binding.contactId ?? '-'} room=${binding.roomId ?? '-'}`)
      })().catch((error: unknown) => {
        logger.warn?.(`[psyche] 会话 ${sessionId} 身份绑定失败，本轮只召回全局：${String(error)}`)
      })
    })
    const onDisposed = ctx.on('agent/disposed', (payload: unknown) => {
      const sessionId = sessionIdOf(payload)
      if (sessionId === null) return
      // 先让代际失效，再清理绑定——顺序不能反：先 clean 再失效，
      // 中间窗口里迟到的解析仍可能写回来。
      agentLifecycle.end(sessionId)
      runtimeInputs.clear(sessionId)
      moodTurns.dropSession(sessionId)
    })
    return () => {
      onCreated?.()
      onDisposed?.()
      if (qqBridge !== null) {
        groupRuntimeClosed=true
        void groupScheduler?.stop().catch(()=>logger.warn?.('[psyche][group] GROUP_STOP_FAILED'))
        void qqBridge.stop()
        qqBridge = null
        replyOutboxStore = null
      }
    }
  }, 'dsh-psyche.runtime-bindings()')

  // 工具可能在 boot 完成前被调用：这里的每个方法都先等 ready 再转发。
  // 注意 propose 不能走 ctx.psyche 服务——它要拿到 Core 的写路径与 E_PARTITION 校验，
  // 而 growth 分区在 Core 里被显式拒绝，别在这里做「顺手放行」。
  const tools = buildTools(
    {
      remember: async (args) => (await core()).remember(args),
      clash: async (args) => (await core()).clash(args),
      revise: async (args) => (await core()).revise(args),
      review: async (args) => (await core()).review(args),
      forget: async (args) => (await core()).forget(args),
      propose: async (args) => (await core()).propose(args),
      stances: async (args) => (await core()).stances(args),
      getState: async () => (await core()).getState(),
      getRelationship: async (id) => (await core()).getRelationship(id),
      recall: async (args, scope) => (await core()).recall(args, scope),
      fetch: async (ids, budget) => (await core()).fetch(ids, budget),
      context: async () => (await core()).context(),
      // G5 提醒：三件事都要求接收者身份，缺了直接拒绝（不兜底记到 Owner 名下）。
      createReminder: async (input) => {
        const db = runtime.db
        if (!db) return { ok: false, status: 'no-receiver', reason: '记忆库还没准备好' }
        if (!input.receiver) return { ok: false, status: 'no-receiver', reason: '这个会话没有可归属的接收者' }
        const result = createReminder({
          db: db as never,
          personaId: 'main',
          receiver: input.receiver,
          dueAt: input.dueAt,
          timezone: input.timezone,
          text: input.text,
          requestId: input.requestId,
          now: input.now,
        })
        return { ok: result.status === 'created' || result.status === 'replayed', status: result.status, reminder: result.reminder ? reminderView(result.reminder) : undefined, reason: result.reason }
      },
      listReminders: async (limit, receiver) => {
        const db = runtime.db
        if (!db || !receiver) return { ok: true, items: [], total: 0 }
        const rows = listReminders({ db: db as never, personaId: 'main', receiver, limit })
        return { ok: true, items: rows.map(reminderView), total: rows.length }
      },
      cancelReminder: async (reminderId, now, receiver) => {
        const db = runtime.db
        if (!db || !receiver) return { ok: false, status: 'no-permission' }
        const result = cancelReminder({ db: db as never, personaId: 'main', reminderId, receiver, now })
        return { ok: result.status === 'cancelled' || result.status === 'replayed', status: result.status, reminder: result.reminder ? reminderView(result.reminder) : undefined }
      },
      /**
       * P1-C：`unknown` 的人工出口。只有 Owner（本机 `ownerId === 'main'`）能裁决，
       * 且必须能拿到这条提醒（接收者身份与归属都核对）——普通联系人即使是接收人也不行。
       */
      resolveReminderDelivery: async ({ reminderId, verdict, receiver, now }) => {
        const db = runtime.db
        if (!db || !receiver) return { ok: false, status: 'no-permission' as const }
        const store = replyOutboxStore
        // 归属核对：提醒必须挂在当前会话的接收者上，否则连裁决入口都不给。
        const owned =
          store !== null &&
          listReminders({ db: db as never, personaId: 'main', receiver, limit: 50 }).some(
            (row) => row.reminder_id === reminderId,
          )
        return resolveReminderDeliveryByFacade({
          reminderId,
          verdict,
          now,
          deps: {
            // 第 16 轮第 3 条：身份看渠道，不看「这条提醒在不在你能看见的列表里」——
            // 普通联系人本来就是接收人。未启用队列时 store 为 null，门面返回 unavailable。
            isOwner: isOwnerReminderScope(db as never, receiver),
            owned,
            store: store as never,
            ownerId: 'main',
          },
        })
      },
      // 人格成长：确认是这条候选进入投影的唯一入口。没有这两个方法，
      // 候选会永远停在 proposed，`readConfirmedGrowthChanges` 读到的永远是空。
      growthCandidates: async (limit) => {
        const db = runtime.db
        if (!db) return { ok: true, total: 0, items: [] }
        const rows = listGrowthCandidates(db as never, { status: 'proposed', limit: limit ?? 5 })
        const items = rows.slice(0, 10).map((row) => ({
          candidateId: row.candidateId,
          type: row.type,
          statement: row.statement,
          independentCount: row.independentCount,
          hash: growthCandidateContentHash(db as never, row.candidateId).hash,
        }))
        return { ok: true, total: items.length, items }
      },
      growthDecide: async (candidateId, decision, hash) => {
        const db = runtime.db
        if (!db) return { ok: false, decision: 'confirm', candidateId, idempotent: false }
        const normalized = decision === 'confirm' || decision === 'reject' || decision === 'withdraw' ? decision : 'reject'
        const result = decideGrowthCandidate(db as never, {
          candidateId,
          decision: normalized,
          decidedBy: 'user',
          expectedHash: hash,
        })
        return { ok: true, decision: result.decision, candidateId: result.candidateId, idempotent: result.idempotent }
      },
    },
    {
      // R3：主动 Recall 的 Scope 只从宿主的 Agent → RuntimeInput 绑定里取。
      // exec 是宿主工具执行上下文（dsh-tools 的 dispatchToolBody 里是 `tool.execute(args, exec)`）。
      // R3.1：platform/groupId 用于把群身份解析成 rooms.room_id；解析由 Core 完成。
      recallScope: (exec) => {
        const agent = (exec as { agent?: { id?: string; session?: { id?: string } } } | undefined)?.agent
        const input = runtimeInputs.readForAgent(agent ?? null)
        if (input === null) return {}
        const platform = (input.platform ?? '').toLowerCase()
        const surface =
          platform === 'desktop' || platform === 'web' || platform === 'system' || platform === 'dsh'
            ? 'personal'
            : input.groupId
              ? 'group'
              : 'private'
        return {
          contactId: input.contactId ?? null,
          channel: input.platform,
          platform: input.platform,
          groupId: input.groupId ?? null,
          surface,
        }
      },
      // G5：提醒的接收者。QQ 会话按联系人，桌面会话按会话标识；
      // 两者都取不到就返回 null，工具层会拒绝登记——宁可让模型说「记不了」，
      // 也不要落一条没人认领的提醒。
      reminderScope: (exec) => {
        const agent = (exec as { agent?: { id?: string; session?: { id?: string } } } | undefined)?.agent
        const sessionId = agent?.session?.id ?? null
        const input = runtimeInputs.readForAgent(agent ?? null)
        const platform = (input?.platform ?? '').toLowerCase()
        const contactId = input?.contactId ?? null
        if (platform === 'qq') {
          return contactId && sessionId ? { channel: 'qq' as const, contactId, sessionRef: sessionId } : null
        }
        return sessionId ? { channel: 'desktop' as const, sessionRef: sessionId } : null
      },
    },
  )

  ctx.effect(() => {
    const disposers = tools.map((tool) => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          // 宿主已经在拆了
        }
      }
    }
  }, 'dsh-psyche.tools()')

  // ── P2-CAP-1b：桌面会话的双向捕获（默认关，见 Config.capture）────
  // 边界：只写 Source。这里不调 remember / clash / revise / review，也不碰成长、关系、人格。
  // session/event 是 Post-commit、fire-and-forget：监听器里只做过滤与入队，真正的写入放到
  // 队列消费器里；消费失败只记日志（1c 再做失败保留、重启补采与 Fork 去重）。
  const splitCsv = (value: string | undefined): string[] =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  // G2-A 接入层：每写进一条 Source 就看一次「这个绑定的连续前缀够不够 8 轮」。
  // 放在这里而不是 turn/end 上，是因为宿主的 turn/end 不保证带正文、而助手正文
  // 落库才意味着这一轮真的完整了。planDigestJob 自己是幂等的（同一区间只会建一个
  // 任务），所以重复调用无害；拿不到 db 或该会话没绑项目就直接跳过。
  const maybePlanDigest = (sessionRef: string): void => {
    const db = runtime.db
    if (!db) return
    try {
      const binding = db.get?.<{ binding_id: string }>(
        `SELECT binding_id FROM project_session_bindings WHERE session_ref = ? ORDER BY bound_at DESC LIMIT 1`,
        [sessionRef],
      )
      const bindingId = binding?.binding_id
      if (typeof bindingId !== 'string' || bindingId.length === 0) return
      planDigestJob({ db: db as never, bindingId, sessionRef, now: new Date() })
    } catch (error) {
      logger.warn?.(`[psyche] 摘要入队检查失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const captureHost = new CaptureHost({
    sink: {
      capture: async (input: CaptureInput) => {
        const result = await (await core()).capture(input)
        const sessionRef = typeof input.sessionRef === 'string' ? input.sessionRef : ''
        if (sessionRef.length > 0) maybePlanDigest(sessionRef)
        return result
      },
    },
    scope: {
      enabled: cfg.capture?.enabled === true,
      allowSessions: splitCsv(cfg.capture?.allowSessions),
      excludeSessions: splitCsv(cfg.capture?.excludeSessions),
    },
    maxQueue: cfg.capture?.maxQueue,
    maxText: cfg.capture?.maxText,
    // QQ 私聊的来源域靠 senderContactId 解析；取不到就写 null（域 unknown，宁可不可见）。
    resolveSender: (sessionId) => runtimeInputs.read(sessionId)?.contactId ?? null,
    logger: { warn: (message) => logger.warn?.(message) },
  })
  // P2-CAP-1c1：Ghost 补采。只在 turn/start 时读一次持久化日志，确认上一轮用户消息
  // 是否已有 Source；没有才补。没有 sessionPersistence 的宿主（headless）明确降级。
  const ghostHost =
    cfg.ghostRecovery?.enabled === true
      ? new GhostSyncHost({
          ctx,
          sink: { capture: async (input) => (await core()).capture(input) },
          scope: {
            enabled: true,
            allowSessions: splitCsv(cfg.capture?.allowSessions),
            excludeSessions: splitCsv(cfg.capture?.excludeSessions),
          },
          maxScan: cfg.ghostRecovery?.maxScan,
          lookbackMs: cfg.ghostRecovery?.lookbackMs,
          logger: { warn: (message) => logger.warn?.(message) },
        })
      : null
  // P2-CAP-1c3：Recovery Scanner。turn/start 时后台扫当前会话；Cursor 保证同一会话
  // 只有一个扫描器在写，失败/到预算上限就释放租约，下一次 turn/start 从水位处接着扫。
  // 默认关（recoveryScan.enabled），1c 完成前不默认开全量历史回填。
  let recoveryScanner: RecoveryScanner | null = null
  const ensureRecoveryScanner = async (): Promise<RecoveryScanner | null> => {
    if (cfg.recoveryScan?.enabled !== true) return null
    await ready
    if (!runtime.db) return null
    recoveryScanner ??= new RecoveryScanner({
      sink: { capture: async (input) => (await core()).capture(input) },
      cursors: new CaptureCursorStore({ db: runtime.db }),
      ctx,
      scope: {
        enabled: true,
        allowSessions: splitCsv(cfg.capture?.allowSessions),
        excludeSessions: splitCsv(cfg.capture?.excludeSessions),
      },
      maxEventsPerScan: cfg.recoveryScan?.maxEventsPerScan,
      pageSize: cfg.recoveryScan?.pageSize,
      maxText: cfg.recoveryScan?.maxText,
      logger: { warn: (message) => logger.warn?.(message) },
    })
    return recoveryScanner
  }
  const scheduleRecoveryScan = (sessionId: string): void => {
    void ensureRecoveryScanner()
      .then((scanner) => scanner?.scanSession(sessionId))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn?.(`恢复扫描失败：${message}`)
      })
  }
  // ── P2-FTS5 E5.5-C：agent/pre-step 记忆注入（默认关，见 Config.injection）──
  // 职责边界：只做「取身份 → 召回 → Composer 组装 → 按 turn 幂等 → 一次性改写消息」。
  // 不建立 Contact 身份、不接受模型传入身份；没有 RuntimeInput 时只放行全局记忆。
  // runtimeInputs 在工具构造之前已声明：主动 Recall 与自动注入必须共用同一份绑定。
  // E5.5-D：注入清单与最终检查器共用同一份宿主内存状态——模型与普通消息都创建不了它。
  const injectionManifests = new InjectionManifestStore()
  let preStepInjector: PreStepInjector | null = null
  const ensurePreStepInjector = async (): Promise<PreStepInjector | null> => {
    if (cfg.injection?.enabled !== true) return null
    await ready
    if (!runtime.db) return null
    preStepInjector ??= new PreStepInjector({
      db: runtime.db,
      runtimeInputs,
      manifests: injectionManifests,
      maxItems: cfg.injection?.maxItems,
      maxChars: cfg.injection?.maxChars,
      searchLimit: cfg.injection?.searchLimit,
      // R4-B：自动注入也写召回回执（composition_status=pending，等 R4-C 回填）。
      receipt: { dataDir: runtime.dataDir },
    })
    return preStepInjector
  }
  /**
   * Q5-F：在 pre-step 上注入日常原话召回。
   *
   * 为什么不在 Composer：那条路上拿不到本轮用户问题（`ProjectionAssembly` 只有
   * 会话 id，`SessionSurface` 只给事件序号），只能退化成「取最近一轮」，真机上
   * 把「别人问过同一句话 + 答不知道」顶进了提示。
   *
   * 返回 null 表示「这一轮不动 messages」；返回数组表示已替换。
   * 不论查不查，都先把历史里的旧召回块摘掉——否则上一轮的内容会跟着
   * agent-loop 的 append 一直留在会话里。
   */
  const applyRecallInjection = async (input: {
    db: { get?: unknown } | null
    agent: { id?: string; session?: { id?: string } }
    turn: number
    query: RecallQuery
    messages: unknown[]
    /** 当前会话绑定的联系人；私聊据此把范围收到「这个人说过的话」。 */
    contactId?: string | null
  }): Promise<unknown[] | null> => {
    // 会话标识优先取 `session.id`：`agent.id` 是 agent 实例标识，与回执里
    // `assembly.agent.session.id` 不是同一个值。此前拿 agent.id 当键去存召回元数据，
    // 组装回执按 session.id 去取，两边对不上——于是用户会话的回执里读到的是
    // 另一个会话留下的那一条（第 37 轮真机：receiver 是用户会话，ref 却是我这边）。
    const sessionId = input.agent.session?.id ?? input.agent.id ?? ''
    const stripped = stripRecallBlocks(input.messages)
    const settle = (patch: Partial<{ sourceIds: string[]; sessionRef: string | null; skipped: string | null; status: string | null; queryMode: 'none' | 'continue' | 'specific' | null; messageId: string | null }>): void => {
      if (sessionId === '') return
      const prev = recallMetaBySession.get(sessionId)
      recallMetaBySession.set(sessionId, {
        sourceIds: prev?.sourceIds ?? [],
        sessionRef: prev?.sessionRef ?? null,
        skipped: prev?.skipped ?? null,
        status: prev?.status ?? null,
        queryMode: prev?.queryMode ?? null,
        messageId: prev?.messageId ?? null,
        at: Date.now(),
        ...patch,
      })
    }
    const hadBlock = stripped.length !== input.messages.length
    settle({
      sourceIds: [],
      sessionRef: null,
      skipped: input.query.status === 'ok' ? 'pending' : input.query.status,
      status: input.query.status,
      queryMode: input.query.queryMode,
      messageId: input.query.messageId,
    })
    // 没拿到唯一可归属的本轮输入、没有库、没有会话标识：一律不猜。
    if (
      input.query.status !== 'ok' ||
      input.query.query === null ||
      input.db === null ||
      sessionId === ''
    ) {
      settle({ skipped: input.query.status })
      return hadBlock ? stripped : null
    }
    // 第 37 轮外部评审 P1：总开关此前只挡住原来的 injector，原话召回照样查库。
    // 关闭态应当连 Source 查询一起停——否则「关掉了记忆」只是关掉了注入。
    if (cfg.injection?.enabled === false) {
      settle({ skipped: 'disabled' })
      return hadBlock ? stripped : null
    }
    // 同轮重入保护：宿主可能在同一轮再次调用 pre-step，重复追加会叠块。
    if (recallTurnSeen.get(sessionId) === input.turn) {
      return hadBlock ? stripped : null
    }
    // 渠道判定：QQ 会话只读自己那侧，委派会话已在 query 阶段短路。
    const channel = resolveSessionChannel(sessionId, ownerUin(), channelBindingOf(input.agent))
    if (channel.platforms.length === 0) {
      settle({ skipped: 'no-channel' })
      return hadBlock ? stripped : null
    }
    const recall = buildConversationRecall({
      db: input.db as never,
      personaId: 'main',
      platform: channel.platforms,
      sourceChannel: channel.sourceChannel,
      currentSessionRef: sessionId,
      query: input.query.query,
      // 第 37 轮外部评审 P0：QQ 私聊此前只按 platform+channel 过滤，
      // B 私聊独有的 Source 会出现在 A 的查询里——同 platform 同 channel
      // 不等于同一联系人。作用域是**联系人**而不是会话：拿会话当范围会和
      // `currentSessionRef` 互相抵消（唯一允许的会话正好是被排除的那一个），
      // 本人以前说过的话就一条都召回不到。桌面会话读全部桌面别名。
      allowedContactId: channel.kind === 'owner-private' ? (input.contactId ?? undefined) : undefined,
    })
    recallTurnSeen.set(sessionId, input.turn)
    const sourceIds = recall.items.flatMap((item) => item.sourceIds)
    settle({
      sourceIds,
      sessionRef: recall.items[0]?.sessionRef ?? null,
      skipped: recall.skipped,
      status: input.query.status,
      queryMode: input.query.queryMode,
      messageId: input.query.messageId,
    })
    if (recall.text === null) return hadBlock ? stripped : null
    return [
      ...stripped,
      buildRecallMessage({
        text: recall.text,
        sourceIds,
        sessionRef: recall.items[0]?.sessionRef ?? null,
        id: randomUUID(),
      }),
    ]
  }
  ctx.effect(() => {
    // cordis 的监听器签名统一是 (...args: unknown[]) => unknown；事件契约在运行时由
    // dsh-agent-loop 保证：args[0] 是 { messages, turn, step, signal }，args[1] 是 next()。
    const listener = function (
      this: { id?: string; session?: { id?: string } },
      ...args: unknown[]
    ): unknown {
      const payload = args[0] as {
        turn: number
        step: number
        messages?: unknown[]
        agent?: { id?: string; session?: { id?: string } }
      }
      const next = args[1] as () => Promise<{ kind?: string; messages?: unknown[] }>
      return (async () => {
        const decision = await next()
        if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) {
          return decision
        }
        const agent = (payload.agent ?? this) as { id?: string; session?: { id?: string } }
        const input = runtimeInputs.readForAgent(agent)
        if(input?.platform==='qq'&&input.groupId&&(groupRuntimeClosed||!qqGroupAllowed(cfg.qq,input)))return decision
        const injector = await ensurePreStepInjector()
        // dsh-agent 的 agentEvents 会把 `agent` 注入 payload（fused），监听器的
        // this 是 scope carrier 而不是 Agent——身份必须从 payload.agent 取。
        let messages = Array.isArray(decision.messages) ? decision.messages : []
        let changed = false
        // ① 记忆注入（既有）。注意这里不再因为「没有注入器」就整体早退——
        //    日常召回走的是另一条链路，早退会把它一起丢掉。
        if (injector !== null) {
          try {
            const result = injector.inject(agent, messages as PreStepMessage[], {
              turn: payload.turn,
              step: payload.step,
            })
            logger.debug?.(
              `[psyche] pre-step turn=${payload.turn} step=${payload.step} bound=${result.requestId !== null} injected=${result.injected} skipped=${result.skipped ?? '-'} abstained=${result.abstained}`,
            )
            if (result.injected) {
              messages = result.messages
              changed = true
            }
          } catch (error) {
            // 记忆链路自身失败不能挡住对话：退回原 decision（fail open）。
            // 抛出去会让 waterfall 拿到 rejected 值，agent-loop 随后读 undefined.messages 崩掉整轮。
            logger.warn?.(`[psyche] pre-step 注入失败（已跳过本次注入）：${String(error)}`)
          }
        } else {
          logger.debug?.('[psyche] pre-step: 注入器未启用（injection.enabled=false 或库未就绪）')
        }
        // ② 日常原话召回（Q5-F）。它与记忆注入互不依赖：Composer 拿不到本轮问题，
        //    只有 pre-step 同时有 payload.messages（本轮新增输入）和 decision.messages
        //    （即将提交的完整列表，可以摘旧块）。
        try {
          // 第 35 轮曾在 `Agent.meta` 上找委派信号，但 `Agent` 接口没有 `meta`
          // （runtime-types.d.ts:60 起只有 id/options/session/inbox/status/ctx）。
          // 第 36 轮从 asar 里查到宿主的真实判据是持久化的会话委派深度：
          // `SessionHeader.delegationDepth`（顶层缺席＝0，子代理为父深度 + 1），
          // 另一个信号是 `SessionHeader.origin === 'subagent'`。
          // header 拿不到才算「判不出」，此时 fail-closed 不查。
          const delegated = delegationOfAgent(payload.agent ?? this)
          const query = extractRecallQuery({
            messages: payload.messages,
            delegated,
            // 判得出委派深度（header 在）就算身份已验证；判不出才 fail-closed。
            receiverVerified: delegated !== null,
          })
          const next = await applyRecallInjection({
            db: runtime.db,
            agent,
            turn: payload.turn,
            query,
            messages,
            contactId: channelBindingOf(agent)?.contactId ?? null,
          })
          if (next !== null) {
            messages = next
            changed = true
          }
        } catch (error) {
          logger.warn?.(`[psyche] pre-step 日常召回注入失败（已跳过）：${String(error)}`)
        }
        return changed ? { ...decision, messages } : decision
      })()
    }
    const off = ctx.on('agent/pre-step', listener as (...args: unknown[]) => unknown)
    logger.debug?.('[psyche] agent/pre-step 监听已注册')
    return () => {
      off?.()
    }
  }, 'dsh-psyche.injection()')

  // ── P3-A B2：pre-step 文本收集（只收真实用户消息；进决策才收）──
  // 原则：不收 decision.messages（注入层可能往同一条消息里拼记忆块），
  // 只收宿主已分类的 payload.messages 里 source.kind === 'user' 的那些。
  ctx.effect(() => {
    // 第 37 轮外部评审 P1（04）：这两件事原先是绑在一起的——关掉 mood 就整个
    // 监听器不注册，关系信号也跟着停。它们是两条独立链路：mood 算全局心情，
    // 关系信号只认四种明确表达。所以这里按各自开关分别决定跑不跑，只有两条
    // 都关才不注册监听器。
    const moodEnabled = cfg.mood?.enabled !== false
    const relationshipEnabled = cfg.relationship?.enabled !== false
    if (!moodEnabled && !relationshipEnabled) {
      logger.debug?.('[psyche] mood 与关系采集都关闭：不收集每轮文本')
      return () => {}
    }
    const listener = function (
      this: { id?: string; session?: { id?: string } },
      ...args: unknown[]
    ): unknown {
      const payload = args[0] as {
        turn: number
        messages?: unknown[]
        agent?: { id?: string; session?: { id?: string } }
      }
      const next = args[1] as () => Promise<{ kind?: string }>
      return (async () => {
        const decision = await next()
        if (decision?.kind !== 'enter') return decision
        const agent = payload.agent ?? this
        const sessionId = agent.id ?? agent.session?.id
        if (typeof sessionId !== 'string' || sessionId === '') return decision
        try {
          if (moodEnabled) {
            moodTurns.record(sessionId, payload.turn, payload.messages)
            // P5-4：使用 Host 提供的可信 Turn 作为档位驻留门控；重复/回退不推进。
            moodTurnClock.record(agent, payload.turn)
          }
        } catch (error) {
          // 收集失败不能挡住对话：Mood 是旁路状态。
          logger.warn?.(`[psyche] mood 文本收集失败（已跳过本 step）：${String(error)}`)
        }
        // v29.18：关系信号入账。和 mood 不同源——mood 读全部用户文本算 33 维，
        // 这里只认「明确表达」的四种（感谢/夸赞/道歉/抱怨），而且**必须先有可信
        // 联系人**：contactId 来自 Adapter 绑定，拿不到就不写，绝不默认记到 Owner
        // 名下。同一条消息重放用 (contactId, sessionId, turn, messageId) 去重。
        //
        // 第 37 轮外部评审 P1（04）：去重键里的 messageId 是必需的。此前拿
        // `text.length` 当兜底，两条同长但内容不同的消息会撞成同一条，第二次
        // 被判成 replayed 直接丢掉。拿不到 ID 就跳过，不猜。
        try {
          if (relationshipEnabled && runtime.db) {
            const contactId = resolveAffectContact(agent)
            if (typeof contactId === 'string' && contactId.length > 0) {
              for (const raw of payload.messages ?? []) {
                if (sourceKindOf(raw) !== 'user') continue
                const text = textOfContent((raw as { content?: unknown }).content)
                if (text.length === 0) continue
                const messageId = (raw as { id?: unknown }).id
                if (typeof messageId !== 'string' || messageId.length === 0) continue
                ingestAffectSignal(runtime.db, {
                  contactId,
                  text,
                  independenceKey: `${contactId}:${sessionId}:${payload.turn}:${messageId}`,
                  opId: `affect:${contactId}:${payload.turn}`,
                })
              }
            }
          }
        } catch (error) {
          // 关系数值是旁路状态，写失败不能挡住对话。
          logger.warn?.(`[psyche] 关系信号入账失败（已跳过本 step）：${String(error)}`)
        }
        return decision
      })()
    }
    const off = ctx.on('agent/pre-step', listener as (...args: unknown[]) => unknown)
    return () => {
      off?.()
      moodTurns.clear()
      moodTurnClock.clear()
      moodBehaviorStates.clear()
    }
  }, 'dsh-psyche.mood-collect()')

  // ── P3-B-3：关系投影（Prompt Context，注册在下面 systemPrompt 注入块）──
  // 不能用 agent/pre-step 追加：pre-step 的 messages 只有本轮新消息，
  // 追加的块会被宿主持久化并随历史累积（实测 2/3 轮出现 2/3 份旧块）。
  // Context 由宿主按快照替换，天然不累积；provider 从 assembly.agent 解析可信 Contact。

  // ── P3-A B2：turn-stopping 写库（每轮一次；serial、awaited）──
  // 失败一律吞掉：不回滚对话、不改 prompt、不抛 error。
  ctx.effect(() => {
    if (cfg.mood?.enabled === false) return () => {}
    const listener = async (...args: unknown[]): Promise<void> => {
      const payload = args[0] as {
        agent?: { id?: string; session?: { id?: string } }
        turn?: number
      }
      const db = runtime.db
      if (db === null) return
      const agent = payload?.agent
      const sessionId = agent?.id ?? agent?.session?.id
      const turn = Number(payload?.turn)
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (!Number.isInteger(turn) || turn < 1) return
      const snapshot = moodTurns.take(sessionId, turn)
      if (snapshot === null) return
      try {
        const result = applyMoodTurn(db, {
          sessionRef: sessionId,
          turn,
          texts: snapshot.texts,
          evidenceIds: snapshot.evidenceIds,
          // 轮首固化：pre-step 只收真实用户消息，所以这里恒为 user；
          // turn-stopping 不再从最后一条消息的 role 推断。
          initiator: snapshot.initiator,
          eventType: 'user_message',
          configVersion: snapshot.configVersion,
          userMessageCount: snapshot.userMessageCount,
          maxDelta: cfg.mood?.maxDelta,
        })
        if (result.reason === 'applied') {
          logger.debug?.(
            `[psyche] mood turn=${turn} applied op=${result.opId} version=${result.stateVersion ?? '-'} signals=${result.signals.join(',') || '-'}`,
          )
        } else {
          logger.debug?.(`[psyche] mood turn=${turn} skipped reason=${result.reason}`)
        }
      } catch (error) {
        // 只记错误摘要，不带用户原文。
        logger.warn?.(`[psyche] mood 写入失败（已跳过本轮）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const off = ctx.on('agent/turn-stopping', listener as (...args: unknown[]) => unknown)
    return () => {
      off?.()
    }
  }, 'dsh-psyche.mood()')

  // ── P5-3a：turn-stopping 后生成成长反思候选（rule-only v1）──
  // 只写 growth_* 三表；失败吞掉，不影响对话；预算/scope 由 core 判定。
  ctx.effect(() => {
    if (cfg.growthReflection?.enabled === false) return () => {}
    const listener = async (): Promise<void> => {
      const db = runtime.db
      if (db === null) return
      try {
        const result = reflectGrowthCandidates(db, {
          perContactDaily: cfg.growthReflection?.perContactDaily,
          globalDaily: cfg.growthReflection?.globalDaily,
          timeoutMs: cfg.growthReflection?.timeoutMs,
        })
        if (result.status !== 'no_source') {
          logger.debug?.(
            `[psyche] growth reflection ${result.status} candidates=${result.candidates} reason=${result.reason ?? '-'}`,
          )
        }
      } catch (error) {
        logger.warn?.(
          `[psyche] growth reflection 失败（已跳过本轮）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    const off = ctx.on('agent/turn-stopping', listener as (...args: unknown[]) => unknown)
    return () => {
      off?.()
    }
  }, 'dsh-psyche.growth-reflection()')

  // ── P6-2：turn-stopping 后跑一次意愿 tick（只写内部 intentions）──
  // 只读 events/event_sources 派生未完成承诺；不发送、不执行、不投影。
  // 失败吞掉，不影响对话；projection.intention 仍默认关。
  ctx.effect(() => {
    if (cfg.intention?.enabled === false) return () => {}
    const listener = async (): Promise<void> => {
      const db = runtime.db
      if (db === null) return
      try {
        const result = runIntentionTick({
          db,
          now: new Date().toISOString(),
          personaId: 'main',
        })
        if (result.error !== undefined) {
          logger.warn?.(`[psyche] intention tick 失败（已跳过本轮）：${result.error}`)
          return
        }
        if (result.created > 0 || result.updated > 0 || result.expired > 0) {
          logger.debug?.(
            `[psyche] intention tick attention=${result.attention} candidates=${result.candidates} created=${result.created} updated=${result.updated} expired=${result.expired}`,
          )
        }
      } catch (error) {
        logger.warn?.(
          `[psyche] intention tick 失败（已跳过本轮）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    const off = ctx.on('agent/turn-stopping', listener as (...args: unknown[]) => unknown)
    return () => {
      off?.()
    }
  }, 'dsh-psyche.intention-tick()')

  // ── P2-FTS5 E5.5-D：llm/stream 最终完整性检查（默认关，见 Config.finalCheck）──
  // 位置：prepend 监听器——等所有普通监听器改完 messages 之后、Adapter 消费之前。
  // E5.5-D2 修正：不能在校验后直接返回流。prepend 监听器是栈式嵌套（后注册者在外层），
  // 外层 prepend 可能在「本监听器校验之后、Adapter 真正消费之前」再改 messages；
  // 由于 Adapter 的 stream 是惰性的，那些修改仍会进入请求。因此把校验放进一个守卫流，
  // 在第一次拉取时才执行——此时所有同步监听器都已退出、messages 已定格，而 Adapter 尚未被消费。
  // 失败：抛 E_FINAL_CHECK（fail closed），Adapter 调用计数保持 0。
  ctx.effect(() => {
    const listener = function (...args: unknown[]): unknown {
      const options = args[0] as { messages?: unknown[]; sessionId?: string; purpose?: string }
      const next = args[1] as () => unknown
      const stream = next()
      // C 阶段冻结：最终完整性检查始终开启，不再读 cfg.finalCheck.enabled。
      // 旧配置里显式写过 enabled:false 的，在启动配置审计里告警并忽略。
      const db = runtime.db
      if (db === null || !Array.isArray(options.messages)) return stream
      const requestMessages = options.messages
      return (async function* guarded() {
        // R6-2.1：把当前请求的可信绑定一起交给检查器——只对消息做完整性检查不够，
        // 还要确认「到达 Provider 时仍是注入时那个 Session / 表面 / Contact / Room」。
        const sessionKey = typeof options.sessionId === 'string' ? options.sessionId : null
        const runtimeInput = sessionKey === null ? null : runtimeInputs.read(sessionKey)
        const result = validateFinalRequest({
          manifests: injectionManifests,
          db,
          messages: requestMessages as never[],
          sessionId: options.sessionId,
          purpose: options.purpose,
          runtimeInput,
          groupAllowed:input=>!groupRuntimeClosed&&qqGroupAllowed(cfg.qq,input),
        })
        if (!result.ok) {
          logger.warn?.(
            '[psyche] final-check 拒绝 ' +
              JSON.stringify({
                mode: result.mode,
                purpose: result.purpose,
                blocks: result.blocks,
                trusted: result.trusted,
                violations: result.violations.slice(0, 5),
              }),
          )
          throw new PsycheError(CODE.finalCheck, '最终请求完整性检查失败，已拒绝这次模型调用', {
            mode: result.mode,
            purpose: result.purpose,
            blocks: result.blocks,
            trusted: result.trusted,
            violations: result.violations.slice(0, 20),
          })
        }
        // R6-5 前置：FinalCheck 会把「不属于本次请求」的注入块从 messages 里移除
        // （历史块、第三方插件在 PreStep 清理后重新插入的块）。Adapter 的流是惰性的、
        // 引用的是同一个 messages 数组，所以这里必须原地替换，让清理结果真正生效；
        // 只校验不清理，等于把「重新插入的历史块」原样送进 Provider。
        if (result.strippedBlocks > 0 || result.strippedMessages > 0) {
          logger.warn?.(
            '[psyche] final-check 移除了不属于本次请求的注入块 ' +
              JSON.stringify({
                strippedBlocks: result.strippedBlocks,
                strippedMessages: result.strippedMessages,
              }),
          )
          // 宿主或其它插件可能把 messages 数组冻结/密封：splice 内部会逐个 delete
          // 旧元素，遇到不可配置属性会抛 "Cannot delete property 'N' of [object Array]"
          // 并直接打断整轮对话。这里降级为「放弃本次剥离」而不是崩掉本轮：
          // 完整性检查本身已经跑完（result.ok 为真），清理失败只影响本次是否把
          // 历史块送进 Provider，不应该让用户看到 "本轮运行失败"。
          try {
            requestMessages.splice(0, requestMessages.length, ...result.messages)
          } catch (error) {
            logger.warn?.(
              '[psyche] final-check 无法原地剥离（messages 不可变），本轮放行原始请求 ' +
                JSON.stringify({
                  strippedBlocks: result.strippedBlocks,
                  strippedMessages: result.strippedMessages,
                  error: String(error),
                }),
            )
          }
        }
        // E5.5-D2 收尾：校验通过后释放活动保护，这些清单才允许被环形淘汰。
        for (const requestId of result.verifiedRequestIds) injectionManifests.markVerified(requestId)
        yield* stream as AsyncIterable<unknown>
      })()
    }
    // cordis 运行时支持 { prepend: true }（E5.5-A 已实测），但类型声明只写了两个参数。
    const on = ctx.on as unknown as (
      name: string,
      listener: (...args: unknown[]) => unknown,
      options?: { prepend?: boolean },
    ) => (() => void) | undefined
    const off = on('llm/stream', listener, { prepend: true })
    return () => {
      off?.()
    }
  }, 'dsh-psyche.final-check()')

  ctx.effect(() => {
    const off = ctx.on('session/event', (session: unknown, event: unknown) => {
      // D-2 owns group Source/outputs. Never duplicate the batch projection via desktop Capture/Ghost.
      if(typeof (session as SessionLike)?.id==='string'&&(session as SessionLike).id!.startsWith('qq-group-'))return
      captureHost.handle(session as SessionLike, event as SessionEventLike)
      ghostHost?.handle(session as SessionLike, event as SessionEventLike)
      const fact = event as SessionEventLike
      const sessionId = (session as SessionLike).id
      // 每轮开始时补一次历史：Ghost 只补上一轮 user，Recovery Scanner 按 Cursor 顺序补缺口。
      if (fact.type === 'turn/start' && typeof sessionId === 'string' && sessionId.length > 0) {
        scheduleRecoveryScan(sessionId)
      }
    })
    return () => {
      // 卸载顺序：先停止接收，再排空队列；数据库由宿主在更外层关闭，这里只负责把手上的活干完。
      captureHost.stop()
      void captureHost.drain().catch(() => undefined)
      ghostHost?.stop()
      void ghostHost?.drain().catch(() => undefined)
      recoveryScanner?.stop()
      try {
        off()
      } catch {
        // 宿主已经在拆了
      }
    }
  }, 'dsh-psyche.capture()')

  // ── 系统提示段落（§10 的 P1 缩水版：只给写入门槛，不做七段注入）──
  // 开关是「偏好」而不是配置：面板里的 switch 一拨就重新挂/摘，不用重启。
  // 优先级：prefs.promptSection 为 null 表示「没表过态」→ 退回配置里的 prompt.section；
  // 只有 false 才是用户主动关。这个 ?? 与 !== false 的组合别改，写反会让「关掉」自己变回开。
  const promptEnabled = (): boolean => runtime.prefs.promptSection ?? cfg.prompt?.section !== false
  // promptApi：宿主有没有 systemPrompt 服务；promptDispose：当前是否已挂（拿它当状态标记）。
  let promptApi: Context['systemPrompt'] | null = null
  let promptDispose: (() => void) | null = null
  const syncPromptSection = (): void => {
    if (!promptApi) return
    const want = promptEnabled()
    // 只在状态真的变化时动作：同名 section 重复注册会抛，所以 promptDispose 兼作「已挂」判断。
    if (want && !promptDispose) {
      promptDispose =
        promptApi.section({
          name: 'psyche-memory',
          order: cfg.prompt?.order ?? 60,
          // text 用回调而不是字符串：每轮装配都取一次，将来换动态内容不用改挂载逻辑。
          text: () => PROMPT_SECTION,
          interpolate: false,
        }) ?? null
      return
    }
    // 先清本地标记再 dispose：dispose 若重入 syncPromptSection，不会再拿到已释放的句柄。
    if (!want && promptDispose) {
      const dispose = promptDispose
      promptDispose = null
      try {
        dispose()
      } catch {
        // 宿主已经在拆了
      }
    }
  }
  // ── P3-A B3-2：Mood 语气 Context（动态、同步、只读）──
  // 与 psyche-memory Section 分开：Section 是固定纪律段，Context 是每轮组装的动态快照。
  // mood.enabled 是 Mood 功能总开关：关闭时 B2 不写、B3 不注册；库里的状态保留，重开后按时间衰减。
  let toneDispose: (() => void) | null = null
  const readMoodValues = (): Record<string, number> | null => {
    const db = runtime.db
    if (db === null) return null
    return loadMood(db).values
  }
  const onMoodToneError = (error: unknown): void => {
    logger.warn?.(
      `[psyche] mood 语气读取失败，已降级为平稳：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const syncMoodToneContext = (): void => {
    if (!promptApi) return
    const want = cfg.mood?.enabled !== false
    if (want && !toneDispose) {
      // 同步只读：每次 assembly 取当前有效值；不 await runtime.ready、不建库、不写库。
      const registration = registerMoodToneContext({
        api: promptApi,
        enabled: true,
        readValues: readMoodValues,
        onError: onMoodToneError,
      })
      toneDispose = registration?.dispose ?? null
      return
    }
    if (!want && toneDispose) {
      const dispose = toneDispose
      toneDispose = null
      try {
        dispose()
      } catch {
        // 宿主已经在拆了
      }
    }
  }
  // ── P3-B-3：关系 Context（只读、同步、失败空串）──
  // 与记忆块、语气块并列的独立 Context；每轮从 assembly.agent 重新解析可信 Contact，
  // 不按 Agent 缓存。relationship.enabled 是总开关：关闭时注销注册。
  let relationshipDispose: (() => void) | null = null
  const onRelationshipError = (error: unknown): void => {
    logger.warn?.(
      `[psyche] 关系背景读取失败，本轮不注入：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const syncRelationshipContext = (): void => {
    if (!promptApi) return
    const want = cfg.relationship?.enabled !== false
    if (want && !relationshipDispose) {
      const registration = registerRelationshipContext({
        api: promptApi,
        enabled: () => true,
        resolve: (agent) => {
          const input = runtimeInputs.readForAgent(agent)
          if (input === null || input.contactId === null) return null
          return {
            contactId: input.contactId,
            platform: input.platform,
            groupId: input.groupId ?? null,
          }
        },
        readBrief: (contactId, at) => {
          const core = runtime.core
          if (core === null) throw new Error('core 尚未就绪')
          return core.readRelationshipBrief(contactId, { now: at })
        },
        onError: onRelationshipError,
      })
      relationshipDispose = registration?.dispose ?? null
      return
    }
    if (!want && relationshipDispose) {
      const dispose = relationshipDispose
      relationshipDispose = null
      try {
        dispose()
      } catch {
        // 宿主已经在拆了
      }
    }
  }
  // ── P5-1b：人格原文 Context（只读、按 Agent 可信绑定、失败空串）──
  // 只对存在 Psyche 可信绑定的 Agent 注入；其他 Agent/Profile 返回空串。
  // dataDir 用读取时值，避免服务先于 ready 注册时拿到空路径。
  let personaDispose: (() => void) | null = null
  const onPersonaError = (error: unknown): void => {
    logger.warn?.(
      `[psyche] 人格原文读取失败，本轮不注入：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  // P7-1：Section、waterfall、Context、Composer 共用这一份判定与快照。
  const personaGate = createPersonaAgentGate((agent) => runtimeInputs.readForAgent(agent))
  /** 第 29 轮：宿主记在 agent.meta 上的委派信息（origin / delegationDepth）。 */
  const agentMetaOf = (agent: unknown): unknown => (agent as { meta?: unknown } | null | undefined)?.meta
  /**
   * 关系信号要记到谁头上。
   *
   * QQ 侧只认 Adapter 绑定——猜错就是记到别人头上，宁可这条信号不写。
   * 桌面侧没有 Adapter 绑定（`readForAgent` 返回 null），但桌面只有本机主人一个人，
   * 所以退回 `platform='desktop'` 的那条联系人；连这条都没有就仍然不写。
   *
   * 这是 v29.18 上线后 `contact_affect_state` 一直是 0 行的原因：桌面会话拿不到
   * contactId，所有桌面上的「谢谢你」「做得好」都被静默跳过了。
   */
  const resolveAffectContact = (agent: unknown): string | null => {
    // 归属判定抽在 planAffectContact 里（可测）：委派、非用户消息、有绑定但没
    // contactId 三种都直接跳过，都不查库。这里只负责「桌面主人是谁」那一步 I/O。
    const bound = channelBindingOf(agent)
    const plan = planAffectContact({
      delegated: delegationOfAgent(agent),
      hasBinding: bound !== null,
      boundContactId: bound?.contactId ?? null,
      messageKind: 'user',
    })
    if (plan.kind === 'skip') return null
    if (plan.kind === 'bound') return plan.contactId
    const db = runtime.db as { get?: <T>(sql: string, params?: unknown[]) => T | undefined } | null
    if (db === null) return null
    try {
      const row = db.get?.<{ contact_id: string }>(
        `SELECT contact_id FROM contacts WHERE platform = 'desktop' ORDER BY created_at LIMIT 1`,
      )
      return typeof row?.contact_id === 'string' && row.contact_id.length > 0 ? row.contact_id : null
    } catch {
      return null
    }
  }
  /**
   * 第 29 轮：QQ 侧的可信身份来自 RuntimeInput 绑定（Adapter 声明、Core 解析），
   * 不从会话标识里猜。桌面会话本来就没有 Adapter 绑定，`readForAgent` 返回 null，
   * 由 `resolveSessionChannel` 退回形状判定。
   */
  const channelBindingOf = (agent: unknown): ChannelBinding | null => {
    const bound = runtimeInputs.readForAgent((agent ?? null) as never)
    if (bound === null) return null
    let stableUserId: string | null = null
    const db = runtime.db as { get?: <T>(sql: string, params?: unknown[]) => T | undefined } | null
    if (db !== null && bound.contactId !== null) {
      try {
        const row = db.get?.<{ stable_user_id: string }>(
          'SELECT stable_user_id FROM contacts WHERE contact_id = ?',
          [bound.contactId],
        )
        stableUserId = row?.stable_user_id ?? null
      } catch {
        stableUserId = null
      }
    }
    return {
      platform: bound.platform,
      contactId: bound.contactId,
      groupId: bound.groupId ?? null,
      stableUserId,
    }
  }
  const personaDominance = createPersonaDominance({
    enabled: () => cfg.persona?.enabled !== false,
    dominance: () => cfg.persona?.dominance === true,
    resolveAgent: personaGate,
    read: () =>
      readPersonaProjection({
        dataDir: runtime.dataDir,
        maxChars: cfg.persona?.maxChars ?? 6000,
        maxTokens: cfg.persona?.maxTokens ?? 3000,
      }),
    onError: onPersonaError,
  })
  // P7-2：人格/表达与 Composer 共用同一份表达文案；预算按实际拼接长度扣减。
  const dominanceExpressionText = (
    assembly?: { agent?: { id?: string; session?: { id?: string } } },
  ): string =>
    cfg.persona?.expression === false
      ? ''
      : expressionTextFor(moodBehaviorStateFor(assembly?.agent)?.band)
  let personaAssembleOff: (() => void) | null = null
  const syncPersonaContext = (): void => {
    if (!promptApi) return
    const want = cfg.persona?.enabled !== false
    if (want && !personaDispose) {
      const registration = registerPersonaContext({
        api: promptApi,
        dataDir: () => runtime.dataDir,
        enabled: true,
        maxChars: cfg.persona?.maxChars ?? 6000,
        maxTokens: cfg.persona?.maxTokens ?? 3000,
        resolveAgent: personaGate,
        suppress: (assembly) => personaDominance(assembly as never) !== null,
        onError: onPersonaError,
      })
      personaDispose = registration?.dispose ?? null
      return
    }
    if (!want && personaDispose) {
      const dispose = personaDispose
      personaDispose = null
      try {
        dispose()
      } catch {
        // 宿主已经在拆了
      }
    }
  }
  // 用 inject 而不是硬依赖：宿主没提供 systemPrompt 服务时插件照常启动，只是不注入纪律。
  ctx.inject(['systemPrompt'], (sctx) => {
    promptApi = sctx.systemPrompt
    // effect 里挂、cleanup 里摘：宿主重载该服务时会整体重放这次挂载，
    // 所以 promptApi 必须跟着置空，否则下一次会往已销毁的 service 上挂。
    sctx.effect(() => {
      // P7-2：dominance 不注册 Section，全部在 waterfall 的 next() 之后一次性完成，
      // 失败时一个段都不加、宿主原文也不改，避免半接管。
      if (promptApi && cfg.persona?.dominance === true && cfg.persona?.enabled !== false) {
        const onAssemble = ctx.on as unknown as (
          event: string,
          listener: (
            assembly: never,
            context: never,
            next: () => Promise<never>,
          ) => Promise<never>,
          options: { prepend: boolean },
        ) => () => void
        personaAssembleOff = onAssemble(
          'system-prompt/assemble',
          async (_assembly, context, next) => {
            const assembled = await next()
            try {
              const projection = personaDominance(context as never)
              if (!projection || !projection.text) return assembled
              const agent = (context as { agent?: { id?: string; session?: { id?: string } } } | undefined)?.agent
              const expression = dominanceExpressionText(agent ? { agent } : undefined)
              const current = (assembled as { sections?: Array<{ name: string; text: string }> }).sections
              const injected = injectDominanceSections(current, projection.text, expression)
              if (!injected) return assembled
              return { ...(assembled as object), sections: injected } as never
            } catch {
              // 任一步失败都原样放行，不能让整轮系统提示装配断掉或半接管。
              return assembled
            }
          },
          { prepend: true },
        )
      }
      // P5-2b：启动模式在 apply 时读一次，两模式互斥。
      // 统一模式只注册 psyche-projections；legacy 模式完全沿用 P5-1 的四件套。
      const registerLegacy = (): void => {
        syncPromptSection()
        syncMoodToneContext()
        syncRelationshipContext()
        syncPersonaContext()
      }
      let projection: ProjectionController | null = null
      // Q5 渠道判定：回答「谁在问」时要知道 Owner 是谁（`ownerUin` 已提到外层，
      // 因为 pre-step 的日常召回也要用它）。
      if (promptApi && cfg.projection?.enabled !== false) {
        const relationshipProvider = createRelationshipContextProvider({
          enabled: () => cfg.relationship?.enabled !== false,
          resolve: (agent) => {
            const input = runtimeInputs.readForAgent(agent)
            if (input === null || input.contactId === null) return null
            return {
              contactId: input.contactId,
              platform: input.platform,
              groupId: input.groupId ?? null,
            }
          },
          readBrief: (contactId, at) => {
            const core = runtime.core
            if (core === null) throw new Error('core 尚未就绪')
            return core.readRelationshipBrief(contactId, { now: at })
          },
          onError: onRelationshipError,
        })
        projection = new ProjectionController({
          api: promptApi,
          onError: (error) => {
            logger.warn?.(
              `[psyche] 统一投影组装失败，本轮只保留空投影：${error instanceof Error ? error.message : String(error)}`,
            )
          },
          budget: (assembly) => {
            // P7-2：dominance 接管时，人格与表达从 Composer 的同一预算里扣除。
            const projection = personaDominance(assembly as never)
            if (!projection || !projection.text) return undefined
            const expression = dominanceExpressionText(assembly)
            const chars = projection.text.length + (expression.length > 0 ? expression.length + 1 : 0)
            const tokens = Math.ceil(chars * 1.2)
            return {
              maxChars: Math.max(0, PROJECTION_MAX_CHARS - chars),
              maxTokens: Math.max(0, PROJECTION_MAX_TOKENS - tokens),
            }
          },
          // Q5-E：只读组装回执。采样点在 ProjectionController 里——
          // 只有那里同时知道「这块有没有被保留」和「最终占了多少字符」。
          receipts: assemblyReceipts,
          receiptMeta: (assembly) => {
            const sessionId = assembly?.agent?.session?.id ?? null
            // 委派信号改从会话 header 读（第 36 轮）：宿主把深度持久化在
            // `SessionHeader.delegationDepth`，`origin` 作否定信号兜底。
            const delegatedFlag = delegationOfAgent(assembly?.agent)
            const header = (assembly?.agent?.session as { header?: { delegationDepth?: unknown; origin?: unknown } } | undefined)?.header
            const delegated = delegatedFlag === true
            const delegatedBy: 'session.header.depth' | 'session.header.origin' | 'none' =
              typeof header?.delegationDepth === 'number' && header.delegationDepth > 0
                ? 'session.header.depth'
                : header?.origin === 'subagent'
                  ? 'session.header.origin'
                  : 'none'
            let channel: 'desktop' | 'owner-private' | 'other' | 'unknown' = 'unknown'
            if (sessionId !== null && sessionId.length > 0) {
              try {
                channel = resolveSessionChannel(sessionId, ownerUin(), channelBindingOf(assembly?.agent)).kind
              } catch {
                channel = 'unknown'
              }
            }
            // 只有「这一轮确实调过」才把明细挂上去，否则看不出是没调还是调了没命中。
            const recallMeta = sessionId !== null ? recallMetaBySession.get(sessionId) : undefined
            const recallCalled = recallMeta !== undefined
            const briefCalled = sessionId !== null && lastBriefMeta.sessionId === sessionId
            return {
              channel,
              delegated,
              delegatedBy,
              turnId: null,
              recallSourceIds: recallCalled ? recallMeta.sourceIds : [],
              recallSessionRef: recallCalled ? recallMeta.sessionRef : null,
              recallSkipped: recallCalled ? recallMeta.skipped : 'not-called',
              projectCheckpointId: briefCalled ? lastBriefMeta.checkpointId : null,
              projectRevision: briefCalled ? lastBriefMeta.revision : null,
            }
          },
          sources: {
            // P5-R：隐私/Scope 纪律是必需层，不随普通 prompt.section 偏好关闭。
            discipline: () => PROMPT_SECTION,            persona: (assembly) => {              if (cfg.persona?.enabled === false) return ''
              // P7-1：dominance 接管时 Composer 让位，避免与 Section/waterfall 重复。
              if (personaDominance(assembly as never)) return ''
              if (!personaGate(assembly?.agent)) return ''
              const read = readPersonaProjection({
                dataDir: runtime.dataDir,
                maxChars: cfg.persona?.maxChars ?? 6000,
                maxTokens: cfg.persona?.maxTokens ?? 3000,
              })
              return read.status === 'ready' && read.text ? read.text : ''
            },
            growth: () => {
              const persisted = readPersistedGrowthLine(
                runtime.db as { get?: <T>(sql: string, params?: unknown[]) => T | undefined } | null,
                PHASE_LABELS as unknown as Record<string, string>,
              )
              const db = runtime.db
              if (db === null) return persisted
              try {
                const confirmed = readConfirmedGrowthChanges(db, { limit: 3 })
                if (confirmed.length === 0) return persisted
                return [persisted, ...confirmed.map((change) => formatConfirmedGrowthLine(change))]
                  .filter((line) => line.length > 0)
                  .join('\n')
              } catch {
                return persisted
              }
            },
            mood: (assembly) => {
              if (cfg.mood?.enabled === false) return ''
              const values = readMoodValues()
              if (values === null) return ''
              const state = moodBehaviorStateFor(assembly?.agent)
              if (state === null) return renderMoodProjection('balanced', projectMoodTone(values).tone)
              // P5-R-4x：只从 Host 可信绑定取 contactId；读不到 Affect 就按 0，
              // 不回退上一轮、不跨 Contact，也不改变 Scope/Disclosure。
              const bound = runtimeInputs.readForAgent(assembly?.agent)
              const affect = readContactAffectSync(
                runtime.db as { all?: <T>(sql: string, params?: unknown[]) => T[] } | null,
                bound?.contactId ?? null,
              )
              const behavior = computeMoodBehavior(
                { mood: values, affect, turn: moodTurnClock.get(assembly?.agent) },
                state,
              )
              const tone = projectMoodTone(values).tone
              return renderMoodProjection(behavior.band, tone === '平稳' ? '' : tone)
            },
            relationship: (assembly) => relationshipProvider.text(assembly ?? {}),
            // G1-B：同一项目的只读 Brief。零模型调用、不写库；
            // 没绑定、没存过 Checkpoint、正文为空都返回空串（整块省略）。
            projectBrief: (assembly) => {
              const db = runtime.db
              if (db === null) return ''
              const sessionId = assembly?.agent?.session?.id ?? null
              if (sessionId === null || sessionId.length === 0) return ''
              try {
                // 第 29 轮：子代理会话不读主人的项目进度。第 36 轮把判据从
                // `Agent.meta`（不存在）换成持久化的会话委派深度；判不出时按
                // fail-closed 也不给——项目进度同属主人私有上下文。
                if (delegationOfAgent(assembly?.agent) !== false) return ''
                // 渠道判定：项目 Brief 只在桌面侧装配。QQ 侧还没有项目绑定的
                // 映射关系，先明确不给，避免 QQ 会话读到桌面绑定的项目。
                const channel = resolveSessionChannel(sessionId, ownerUin(), channelBindingOf(assembly?.agent))
                const platform = briefPlatformFor(channel)
                if (platform === null) return ''
                const brief = buildProjectBrief({
                  db: db as unknown as Parameters<typeof buildProjectBrief>[0]['db'],
                  sessionId,
                  personaId: 'main',
                  platform,
                })
                lastBriefMeta = { checkpointId: brief.checkpointId, revision: brief.revision, sessionId }
                return brief.text ?? ''
              } catch {
                return ''
              }
            },
            // Q5-F：日常原话召回**已从这里撤下**，改在 `agent/pre-step` 注入。
            // 原因：这条路上拿不到本轮用户问题（`ProjectionAssembly` 只有会话 id，
            // `SessionSurface` 只给事件序号），只能退化成「取最近一轮」，真机上把
            // 「别人问过同一句话 + 答不知道」顶进了提示。Composer 与 pre-step
            // 必须同一批切换，否则一轮会注入两次。
            // P6-1：默认关；只有可信绑定 Agent + 显式开启时才读一行 internal 意愿。
            // 表不存在（P6-2 迁移前）时 readLatestIntentionLine 返回 null，整块省略。
            intention: (assembly) => {
              if (cfg.projection?.intention !== true) return ''
              if (cfg.persona?.enabled === false) return ''
              if (!personaGate(assembly?.agent)) return ''
              const db = runtime.db
              if (db === null) return ''
              return readLatestIntentionLine(db as { get?: <T>(sql: string, params?: unknown[]) => T | undefined }, {
                now: Date.now(),
                personaId: 'main',
              }) ?? ''
            },
          },
        })
        if (!projection.start()) {
          projection = null
          registerLegacy()
        }
      } else {
        registerLegacy()
      }
      return () => {
        projection?.dispose()
        moodBehaviorStates.clear()
        moodTurnClock.clear()
        const dispose = promptDispose
        const tone = toneDispose
        const relationship = relationshipDispose
        const persona = personaDispose
        const assembleOff = personaAssembleOff
        promptDispose = null
        toneDispose = null
        relationshipDispose = null
        personaDispose = null
        personaAssembleOff = null
        promptApi = null
        try {
          dispose?.()
        } catch {
          // 同上
        }
        try {
          tone?.()
        } catch {
          // 同上
        }
        try {
          relationship?.()
        } catch {
          // 同上
        }
        try {
          persona?.()
        } catch {
          // 同上
        }
        try {
          assembleOff?.()
        } catch {
          // 同上
        }
      }
    }, 'dsh-psyche.prompt()')
  })

  // ── 服务接口（§13.2）───────────────────────────────────────
  // 注册成 ctx.psyche：通道插件、面板、桌面端都靠它调能力。
  // 服务对象只持有 runtime 引用，boot 失败时每个方法都会抛（不会静默返回空）。
  ctx.plugin(createServiceClass(runtime))

  // ── 面板路由（读数据 + 写视图偏好；插件行为配置仍走宿主设置页）────
  // 六条路由都挂在这个 inject 里：宿主没有 webServer（纯 CLI）时整块跳过，不报错。
  ctx.inject(['webServer'], (sctx) => {
    // 统一 JSON 响应：面板只按 JSON 解析，所以 header 在这里一次性兜住。
    // setHeader / end 用可选调用是因为不同宿主版本给的响应对象形状略有差异（测试里是 mock）。
    // no-store：面板会反复轮询，缓存住会让人以为「改完没生效」。
    const send = (response: HttpResponse, statusCode: number, body: unknown): void => {
      response.statusCode = statusCode
      response.setHeader?.('content-type', 'application/json; charset=utf-8')
      response.setHeader?.('cache-control', 'no-store')
      response.end?.(JSON.stringify(body))
    }
    // 成功路径就是 200 + JSON，单独抽出避免每个 handler 都重复写 200。
    const sendJson = (response: HttpResponse, body: unknown): void => send(response, 200, body)
    // 500 统一出口：浏览器只拿到稳定 code + 普通说明；完整异常写服务端日志。
    // 不把 error.stack / detail / 绝对路径放进响应体（P4-A-5 安全整改）。
    const sendServerError = (response: HttpResponse, label: string, error: unknown): void => {
      logger.error?.(`[psyche] ${label}：${errorText(error)}`)
      send(response, 500, httpErrorBody(error))
    }
    // 预设展示行：只给选择需要的字段，不带人格正文（正文留在服务端，避免前端能拼出完整人设）。
    const presetRows = (): { id: string; name: string; version: string; summary: string; recommended: boolean; draft: boolean }[] => {
      try {
        const loaded = loadPresets()
        if (!loaded.ok) return []
        const wanted = new Set<string>(PRESET_IDS)
        return loaded.presets
          .filter((preset) => wanted.has(preset.presetId))
          .map((preset) => ({
            id: preset.presetId,
            name: preset.presetName,
            version: preset.presetVersion,
            summary: preset.summary,
            recommended: preset.recommended,
            draft: preset.draft,
          }))
      } catch (error) {
        logger.warn?.(`[psyche] 预设列表读取失败：${errorText(error)}`)
        return []
      }
    }
    // 读请求体：优先用宿主已经解析好的 request.body（少数中间件会代劳），
    // 否则自己收流。只在「是对象」时接受——数组/字符串/null 都按空对象处理，
    // 让 handler 的键判断逻辑成为唯一的形状校验点。
    const readJsonBody = (request: HttpRequest): Promise<Record<string, unknown>> =>
      new Promise((resolveBody, rejectBody) => {
        if (request.body && typeof request.body === 'object') {
          resolveBody(request.body as Record<string, unknown>)
          return
        }
        // 没有 stream 接口（或测试桩）时不要挂死：直接当空体，交给上层报「没有可写的键」。
        if (typeof request.on !== 'function') {
          resolveBody({})
          return
        }
        const chunks: string[] = []
        request.on('data', (chunk) => {
          chunks.push(typeof chunk === 'string' ? chunk : String(chunk ?? ''))
        })
        request.on('end', () => {
          const text = chunks.join('').trim()
          // 空体是合法输入（例如「一键恢复默认」将来可能不带 payload），返回 {} 而不是报错。
          if (!text) {
            resolveBody({})
            return
          }
          try {
            const parsed: unknown = JSON.parse(text)
            resolveBody(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {})
          } catch (error) {
            // 语法错误要 reject 出去：handler 会回 400，别静默吞成 {} 让前端以为写成功了。
            rejectBody(error instanceof Error ? error : new Error('请求体不是合法 JSON'))
          }
        })
        // 连接中断不 reject：上层只需要「没有可用字段」这个结果，错误刷屏没意义。
        request.on('error', () => resolveBody({}))
      })

    // 人格初始化三条 Owner 路由（I-7）：HTTP 形状与错误码映射在 lib/init-routes.ts，
    // 这里只注入运行时依赖。路由层不碰 claim / 人格文件 / 数据库快照——全部经 PersonaInitService。
    const initRoutes = buildInitRoutes({
      ready,
      service: () => runtime.init,
      unavailable: () => runtime.personaInitError,
      onSnapshot: (snapshot) => {
        runtime.personaInit = snapshot
        runtime.personaInitError = null
      },
      presets: presetRows,
      logger,
      send,
      sendJson,
      readJsonBody,
    })

    // 披露授权的宿主入口（E5.5-E1）：签发 / 撤销 / 只读审计。
    // 这是 Owner 路由，不是模型工具——tools.ts 里没有也不应有 grantDisclosure。
    const grantRoutes = buildGrantRoutes({
      ready,
      core: () => runtime.core,
      unavailable: () =>
        runtime.bootError ? `记忆引擎没起来：${runtime.bootError instanceof Error ? runtime.bootError.message : String(runtime.bootError)}` : '记忆引擎还没准备好',
      logger,
      send,
      sendJson,
      readJsonBody,
    })

    // C2-C：本轮「记忆上下文」的只读回执（turnTail 标签展开用）。
    // 只按 session+turn 查 pre-step 回执，不接受 runId；只返回 completed 且确实注入的条目。
    const injectionRoutes = buildInjectionRoutes({
      ready,
      db: () => runtime.db,
      unavailable: () =>
        runtime.bootError
          ? `记忆引擎没起来：${runtime.bootError instanceof Error ? runtime.bootError.message : String(runtime.bootError)}`
          : '记忆引擎还没准备好',
      logger,
      send,
      sendJson,
    })

    // 「记住这条」按钮（P2 remember-button）：只收 sessionId + assistantMessageId。
    // 身份从 RuntimeInput 取、正文从会话事件取，客户端不能指定 Contact/正文/kind/披露。
    const rememberRoutes = registerRememberRoutes({
      ready,
      deps: async () => {
        const instance = runtime.core
        if (instance === null) return null
        const persistence = ctx.get?.('sessionPersistence') as RememberPersistence | undefined
        return {
          core: async () => instance as never,
          runtimeInputs: { read: (sessionId: string) => runtimeInputs.read(sessionId) ?? null },
          persistence: persistence ?? null,
        }
      },
      unavailable: () =>
        runtime.bootError
          ? `记忆引擎没起来：${runtime.bootError instanceof Error ? runtime.bootError.message : String(runtime.bootError)}`
          : null,
      logger,
      send,
      sendJson,
      readJsonBody,
    })

    // G1-A 手动交接（预览 / 保存 / 读取）。模型调用为零：预览只读库、保存只写 v32 七张表。
    const projectHandoffRoutes = registerProjectHandoffRoutes({
      ready,
      db: () => runtime.db,
      unavailable: () =>
        runtime.bootError
          ? `记忆引擎没起来：${runtime.bootError instanceof Error ? runtime.bootError.message : String(runtime.bootError)}`
          : null,
      logger,
      send,
      sendJson,
      readJsonBody,
    })

    const routes: readonly HttpRoute[] = [
      ...initRoutes,
      ...grantRoutes,
      ...injectionRoutes,
      ...rememberRoutes,
      ...projectHandoffRoutes,
      {
        // 面板图表用的 ECharts 离线包：直接从插件包内 assets 读，不依赖 CDN 与网络。
        // 返回 JS 而不是 JSON，所以不走 send()；文件缺失时 404，面板退回纯数字卡片。
        kind: 'exact',
        path: '/psyche/echarts.js',
        handler: async (_request, response) => {
          const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'echarts.min.js')
          if (!existsSync(file)) {
            response.statusCode = 404
            response.setHeader?.('content-type', 'text/plain; charset=utf-8')
            response.end?.('echarts.min.js not found')
            return
          }
          response.statusCode = 200
          response.setHeader?.('content-type', 'application/javascript; charset=utf-8')
          response.setHeader?.('cache-control', 'public, max-age=86400')
          response.end?.(readFileSync(file, 'utf8'))
        },
      },
      {
        // 只读状态：不碰 Core，所以 boot 失败也能返回 200，靠 payload 里的 ok 字段自证。
        kind: 'exact',
        path: '/api/psyche/status',
        handler: async (_request, response) => {
          sendJson(response, toStatusView(runtime.status()))
        },
      },
      {
        // 面板聚合（/panel 也是纯读）：同样只 await ready，库没好也给出 notes 而不是 5xx。
        kind: 'exact',
        path: '/api/psyche/panel',
        handler: async (_request, response) => {
          sendJson(response, toPanelView(await panel()))
        },
      },
      {
        // 只读情绪面板：当前有效值 + 真实写入快照。只提供 GET，没有任何写入口。
        // 库没准备好时给 503（明确错误状态），而不是伪造一份中性数据。
        kind: 'exact',
        path: '/api/psyche/mood',
        handler: async (request, response) => {
          if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
            send(response, 405, { ok: false, error: '只接受 GET' })
            return
          }
          await ready
          if (!runtime.db) {
            send(response, 503, { ok: false, error: '数据库还没准备好' })
            return
          }
          let limit: unknown
          try {
            const url = new URL(request.url ?? '/', 'http://127.0.0.1')
            limit = url.searchParams.get('limit')
          } catch {
            limit = undefined
          }
          try {
            // Owner 面板数据：不落浏览器/中间缓存。
            response.setHeader?.('Cache-Control', 'no-store')
            sendJson(response, buildMoodPanel(runtime.db, { limit }))
          } catch (error) {
            logger.warn?.(`[psyche] 读情绪面板失败：${errorText(error)}`)
            send(response, 500, httpErrorBody(error))
          }
        },
      },
      {
        // P4-A-3 只读 QQ 管理页：连接/账号/授权/计数/活动/日志。只提供 GET。
        // 桥没启用也返回 200 的 disabled 空态，让前端能稳定渲染「未启用」而不是报错。
        kind: 'exact',
        path: '/api/psyche/qq',
        handler: async (request, response) => {
          if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
            send(response, 405, { ok: false, error: '只接受 GET' })
            return
          }
          await ready
          try {
            response.setHeader?.('Cache-Control', 'no-store')
            sendJson(
              response,
              {
                ...buildQqAdminPayload({
                  enabled: qqBridge !== null,
                  // 桥接没建起来时要能分清「没开」和「开不起来」。
                  startError: qqStartError,
                  failedEpoch: bridgeFailedEpoch,
                  snapshot: qqBridge?.adminSnapshot() ?? null,
                  logs: qqLogs.snapshot(),
                }),
                // 第 12 轮评审：QQ 页要有一块只读「待投递提醒」，让「已延后」看得见。
                // 只读视图现读现算，展示用的预计时间优先取队列行的 retry_at。
                pendingReminders: buildPendingReminders({
                  db: runtime.db as never,
                  personaId: 'main',
                  limit: 8,
                }),
              },
            )
          } catch (error) {
            logger.warn?.(`[psyche] 读 QQ 管理页失败：${errorText(error)}`)
            send(response, 500, httpErrorBody(error))
          }
        },
      },
      {
        // 工作区卡（第一批 · 五态）：宿主没有 `workspace/list`，所以这里用
        // `workspace/follow` 的 baseline 现读一次再判状态；读不到就如实标「未核实」。
        // GET 只读；POST 只做一件事——改显示名（目录与配置来源只读）。
        kind: 'exact',
        path: '/api/psyche/qq/workspace',
        handler: async (request, response) => {
          await ready
          const method = (request.method ?? 'GET').toUpperCase()
          response.setHeader?.('Cache-Control', 'no-store')
          // GPT 第 1 轮第 5 条：写动作不能只靠前端隐藏入口 + 输入校验。
          // 可信身份由宿主提供——`/api/psyche/*` 要过宿主的 browser-session 鉴权，
          // 插件不重复造身份体系；这里再补一道来源校验，挡掉别的站点页面直接 POST。
          if (
            method === 'POST'
            && !sameOriginWrite(
              request as unknown as {
                headers?: Record<string, string | string[] | undefined>
                protocol?: string
                socket?: { encrypted?: boolean }
              },
            )
          ) {
            send(response, 403, { ok: false, error: '改工作区名只接受本机同源请求' })
            return
          }
          if (method === 'GET') {
            try {
              sendJson(response, await qqWorkspaceCard())
            } catch (error) {
              logger.warn?.(`[psyche][qq] 读工作区卡失败：${errorText(error)}`)
              send(response, 500, { ok: false, error: '读工作区状态失败' })
            }
            return
          }
          if (method !== 'POST') {
            send(response, 405, { ok: false, error: '只接受 GET / POST' })
            return
          }
          let body: Record<string, unknown>
          try {
            body = await readJsonBody(request as unknown as HttpRequest)
          } catch {
            send(response, 400, { ok: false, error: '请求体不是合法 JSON' })
            return
          }
          const raw = body.title
          if (typeof raw !== 'string') {
            send(response, 400, { ok: false, error: '缺少 title' })
            return
          }
          const title = raw.trim()
          if (title === '' || title.length > 40 || /[\r\n]/.test(title)) {
            send(response, 400, { ok: false, error: '标题留空、超过 40 字或含换行都不行' })
            return
          }
          try {
            sendJson(response, await renameQqWorkspace(title))
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn?.(`[psyche][qq] 改工作区名失败：${message}`)
            const status = message.startsWith('宿主里还没有') ? 409 : 500
            send(response, status, { ok: false, error: message })
          }
        },
      },
      {
        // P8-4：打开本机独立 QQ 控制中心。Host 路由不返回令牌；令牌只出现在
        // 由本机浏览器打开的 URL fragment 里，页面自己读取，不写日志、不跨域。
        // 该入口只允许本机 loopback 访问；AI/QQ 联系人没有调用路径。
        kind: 'exact',
        path: '/api/psyche/qq/control/open',
        handler: async (request, response) => {
          if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
            send(response, 405, { ok: false, error: '只接受 POST' })
            return
          }
          await ready
          try {
            const control = await ensureQqControl()
            const { url, token } = await control.ensureStarted()
            openLocalUrl(`${url}#t=${token}`)
            sendJson(response, { ok: true })
          } catch (error) {
            logger.warn?.(`[psyche][qq-control] 打开控制中心失败：${errorText(error)}`)
            send(response, 500, { ok: false, error: '控制中心启动失败' })
          }
        },
      },
      {
        // P8-FINAL：把控制中心内嵌到 QQ 页。返回带 fragment 令牌的 loopback URL，
        // 由插件客户端放进 iframe；不打开浏览器、不在父页面渲染令牌。
        // 与 open 共用 ensureStarted，不新增控制能力，只改变展示位置。
        kind: 'exact',
        path: '/api/psyche/qq/control/embed',
        handler: async (request, response) => {
          if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
            send(response, 405, { ok: false, error: '只接受 POST' })
            return
          }
          await ready
          try {
            const control = await ensureQqControl()
            const { url, token } = await control.ensureStarted()
            response.setHeader?.('Cache-Control', 'no-store')
            sendJson(response, { ok: true, url: `${url}#t=${token}` })
          } catch (error) {
            logger.warn?.(`[psyche][qq-control] 启动内嵌控制中心失败：${errorText(error)}`)
            send(response, 500, { ok: false, error: '控制中心启动失败' })
          }
        },
      },
      {
        // P4-B-5-1 只读诊断分页：过滤/字段白名单在 qq-diagnostics 内完成，不接触消息正文。
        kind: 'exact',
        path: '/api/psyche/qq/diagnostics',
        handler: async (request, response) => {
          if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
            send(response, 405, { ok: false, error: '只接受 GET' })
            return
          }
          let params: URLSearchParams
          try {
            params = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams
          } catch {
            send(response, 400, { ok: false, error: { code: 'E_DIAGNOSTICS_FILTER', message: '请求地址无法解析' } })
            return
          }
          const parsed = parseQqDiagnosticFilter(params)
          if (!parsed.ok) {
            send(response, 400, { ok: false, error: { code: 'E_DIAGNOSTICS_FILTER', message: parsed.message } })
            return
          }
          await ready
          response.setHeader?.('Cache-Control', 'no-store')
          const page = qqBridge === null
            ? { generatedAt: new Date().toISOString(), items: [], nextBefore: null, matched: 0 }
            : qqBridge.diagnosticPage(parsed.filter)
          sendJson(response, { ok: true, ...page })
        },
      },
      {
        // P4-B-5-2：导出默认且当前固定关闭。Host 无可信管理员身份时，直接请求也不返回任何数据。
        kind: 'exact',
        path: '/api/psyche/qq/diagnostics/export',
        handler: async (request, response) => {
          if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
            send(response, 405, { ok: false, error: '只接受 GET' })
            return
          }
          await ready
          response.setHeader?.('Cache-Control', 'no-store')
          if (!canExportDiagnostics()) {
            send(response, 403, {
              ok: false,
              error: {
                code: 'EXPORT_AUTH_UNAVAILABLE',
                message: '导出需要宿主可信鉴权，当前未启用',
              },
            })
            return
          }
          // 可信鉴权接入后再实现；此分支目前不可达，避免无意中把数据导出。
          send(response, 403, { ok: false, error: { code: 'EXPORT_AUTH_UNAVAILABLE', message: '导出未启用' } })
        },
      },
      {
        // 意识海场景：这个必须要真库，所以单独判 db 给 503，让前端区分「没起来」和「构建崩了」。
        kind: 'exact',
        path: '/api/psyche/sea',
        handler: async (request, response) => {
          await ready
          if (!runtime.db) {
            send(response, 503, { ok: false, error: '数据库还没准备好' })
            return
          }
          let from: string | undefined
          let to: string | undefined
          try {
            const url = new URL(request.url ?? '/', 'http://localhost')
            const window = resolveSeaWindow(url.searchParams)
            from = window.from
            to = window.to
          } catch (error) {
            send(response, 400, { ok: false, error: error instanceof Error ? error.message : '时间参数无效' })
            return
          }
          try {
            sendJson(response, buildSeaScene(runtime.db, { from, to }))
          } catch (error) {
            // 场景构建是渲染逻辑，失败不该让整个宿主崩：日志留痕 + 把原文回给前端。
            logger.warn?.(`[psyche] 意识海场景构建失败：${errorText(error)}`)
            send(response, 500, httpErrorBody(error))
          }
        },
      },
      {
        // 意识海下钻：点一颗星之后取「凭什么记得」——head、全部版本、证据、触发事件。
        // 只读；id 走 query（`/api/psyche/node?id=art_xxx`），不新增任何写入口。
        kind: 'exact',
        path: '/api/psyche/node',
        handler: async (request, response) => {
          await ready
          if (!runtime.db) {
            send(response, 503, { ok: false, error: '数据库还没准备好' })
            return
          }
          let id = ''
          try {
            const url = new URL(request.url ?? '/', 'http://localhost')
            id = url.searchParams.get('id') ?? ''
          } catch {
            id = ''
          }
          if (!id) {
            send(response, 400, { ok: false, error: '缺少 id' })
            return
          }
          try {
            const detail = buildNodeDetail(runtime.db, id)
            if (!detail) {
              send(response, 404, { ok: false, error: '没有这条记忆' })
              return
            }
            // Owner 面板数据：不落浏览器/中间缓存。响应本身已经按披露白名单裁剪。
            response.setHeader?.('Cache-Control', 'no-store')
            sendJson(response, detail)
          } catch (error) {
            logger.warn?.(`[psyche] 记忆下钻失败 ${id}：${errorText(error)}`)
            send(response, 500, httpErrorBody(error))
          }
        },
      },
      {
        // 面板开关的唯一写入口：只认白名单里的键，写完立刻生效。
        // 注意先判方法再读体：GET 命中这条会给 405，避免被「顺手访问」触发写盘。
        kind: 'exact',
        path: '/api/psyche/prefs',
        handler: async (request, response) => {
          if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
            send(response, 405, { ok: false, error: '只接受 POST' })
            return
          }
          let body: Record<string, unknown>
          try {
            body = await readJsonBody(request)
          } catch {
            send(response, 400, { ok: false, error: '请求体不是合法 JSON' })
            return
          }
          // 只挑白名单键：未知键静默忽略而不是 400——前端先加字段、后端后升级时不该直接坏掉。
          const patch: { sea?: boolean; promptSection?: boolean | null } = {}
          if (typeof body.sea === 'boolean') patch.sea = body.sea
          // promptSection 三种合法值：true 开、false 关、null 表示「清掉偏好、回退配置」。
          if (body.promptSection === null || typeof body.promptSection === 'boolean') {
            patch.promptSection = body.promptSection as boolean | null
          }
          if (patch.sea === undefined && patch.promptSection === undefined) {
            send(response, 400, { ok: false, error: '没有可写的偏好键（sea / promptSection）' })
            return
          }
          // boot 可能还没跑到建目录那一步（dataDir 还是空串）：这里兜底解析一次并回填，
          // 否则 writePrefs 会往当前工作目录里写文件。
          const dataDir = runtime.dataDir || (await resolveDataDir(cfg.dataDir))
          runtime.dataDir ||= dataDir
          try {
            // 写盘成功才覆盖内存里的 prefs：writePrefs 抛了的话旧值保持有效，面板不会与磁盘不一致。
            runtime.prefs = writePrefs(dataDir, patch)
            syncPromptSection()
            logger.debug?.(`[psyche] 面板偏好已更新：${JSON.stringify(runtime.prefs)}`)
            sendJson(response, { ok: true, prefs: runtime.prefs })
          } catch (error) {
            logger.warn?.(`[psyche] 写偏好失败：${errorText(error)}`)
            send(response, 500, httpErrorBody(error))
          }
        },
      },
      {
        // 令牌与花费（只读）：?hours=N 只看最近 N 小时
        kind: 'exact',
        path: '/api/psyche/usage',
        handler: async (request, response) => {
          // 只支持一个查询参数 hours；用固定 base 构造 URL 是为了容忍相对路径形式。
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          const hours = Number(url.searchParams.get('hours') ?? '0')
          try {
            // 夹到 [0, 720]：非法/负数一律归 0（= 全部），上限一个月，防止把聚合器拖死。
            sendJson(response, await usage(Number.isFinite(hours) ? Math.max(0, Math.min(720, hours)) : 0))
          } catch (error) {
            logger.warn?.(`[psyche] 用量统计失败：${errorText(error)}`)
            send(response, 500, httpErrorBody(error))
          }
        },
      },
      {
        // 迁移包列表（只读）：逐个校验 sha256，页面上直接给「能不能用」。
        kind: 'exact',
        path: '/api/psyche/archives',
        handler: async (_request, response) => {
          await ready
          try {
            sendJson(response, { ...archives(), schemaVersion: runtime.db?.userVersion() ?? null, pluginVersion: pluginVersion() })
          } catch (error) {
            logger.warn?.(`[psyche] 读迁移包失败：${errorText(error)}`)
            send(response, 500, httpErrorBody(error))
          }
        },
      },
      {
        // 恢复状态（只读）：面板用它决定显示「空人格可直接导入 / 非空需确认 / 拒绝导入」。
        // 不 await ready：门禁失败时这里更该能打开，好把 boot 的原因显示出来。
        kind: 'exact',
        path: '/api/psyche/restore/status',
        handler: async (_request, response) => {
          const dataDir = runtime.dataDir || (await resolveDataDir(cfg.dataDir))
          try {
            sendJson(response, {
              ...restoreStatus({ dataDir, db: runtime.db ?? undefined }),
              boot: {
                restore: runtime.restore,
                restoreError: runtime.restoreError,
                bootError: runtime.bootError ? errorText(runtime.bootError) : null,
              },
            })
          } catch (error) {
            logger.warn?.(`[psyche] 读恢复状态失败：${errorText(error)}`)
            send(response, 500, httpErrorBody(error))
          }
        },
      },
      {
        // 阶段 A 第一步：准备导入。只校验包 + 解到同级暂存 + 写状态文件，
        // **一个字节都不动数据根**——所以运行中调用是安全的。
        kind: 'exact',
        path: '/api/psyche/restore/prepare',
        handler: async (request, response) => {
          if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
            send(response, 405, { ok: false, error: '只接受 POST' })
            return
          }
          let body: Record<string, unknown>
          try {
            body = await readJsonBody(request)
          } catch {
            send(response, 400, { ok: false, error: '请求体不是合法 JSON' })
            return
          }
          const file = typeof body.file === 'string' ? body.file : ''
          try {
            const dataDir = runtime.dataDir || (await resolveDataDir(cfg.dataDir))
            runtime.dataDir ||= dataDir
            const view = prepareRestorePackage({
              dataDir,
              file: resolveArchiveFile(dataDir, file),
              // 用插件支持的最大 schema 判「这个包比我新」——恢复器读不了的格式必须拒绝。
              schemaVersion: SCHEMA_VERSION,
              personaId: 'main',
              db: runtime.db ?? undefined,
            })
            runtime.log.info(
              'restore',
              `恢复已准备：${view.restoreId}（${view.mode}，包 ${view.packageId}，目标 ${view.targetState}）`,
            )
            sendJson(response, view)
          } catch (error) {
            // 这里失败大多是「用户给错了包/数据状态不允许」，用 400 让面板显示原因。
            logger.warn?.(`[psyche] 准备恢复失败：${errorText(error)}`)
            send(response, 400, toErrorPayload(error))
          }
        },
      },
      {
        // 阶段 A 第二步：确认替换。会冻结写入并导出预恢复包，然后提示关 DSH。
        // 非空数据必须手打包 ID（confirmation）——这是唯一的人工闸门。
        kind: 'exact',
        path: '/api/psyche/restore/confirm',
        handler: async (request, response) => {
          if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
            send(response, 405, { ok: false, error: '只接受 POST' })
            return
          }
          let body: Record<string, unknown>
          try {
            body = await readJsonBody(request)
          } catch {
            send(response, 400, { ok: false, error: '请求体不是合法 JSON' })
            return
          }
          const db = runtime.db
          if (!db) {
            send(response, 503, { ok: false, error: '数据库还没准备好，不能确认恢复' })
            return
          }
          try {
            const dataDir = runtime.dataDir || (await resolveDataDir(cfg.dataDir))
            runtime.dataDir ||= dataDir
            const result = confirmRestore({
              dataDir,
              restoreId: typeof body.restoreId === 'string' ? body.restoreId : undefined,
              confirmation: typeof body.confirmation === 'string' ? body.confirmation : undefined,
              db,
              version: pluginVersion(),
              schemaVersion: db.userVersion(),
              algorithmVersion: ALGORITHM_VERSION,
              // 注入 Core 的冻结开关：restore.ts 不反向依赖 store.ts，测试也好造假。
              freeze: (reason) => runtime.core?.freezeWrites(reason),
              unfreeze: () => runtime.core?.unfreezeWrites(),
            })
            runtime.log.info('restore', `恢复已确认：${result.restoreId}，预恢复包 ${result.preRestoreArchive}`)
            sendJson(response, result)
          } catch (error) {
            logger.warn?.(`[psyche] 确认恢复失败：${errorText(error)}`)
            send(response, 400, toErrorPayload(error))
          }
        },
      },
      {
        // 取消一次还没应用的恢复：删暂存目录、清状态文件、解冻写入。
        kind: 'exact',
        path: '/api/psyche/restore/cancel',
        handler: async (request, response) => {
          if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
            send(response, 405, { ok: false, error: '只接受 POST' })
            return
          }
          try {
            const dataDir = runtime.dataDir || (await resolveDataDir(cfg.dataDir))
            runtime.dataDir ||= dataDir
            const result = cancelRestore({ dataDir, unfreeze: () => runtime.core?.unfreezeWrites() })
            runtime.log.info('restore', `恢复取消：${result.note}`)
            sendJson(response, result)
          } catch (error) {
            logger.warn?.(`[psyche] 取消恢复失败：${errorText(error)}`)
            send(response, 500, httpErrorBody(error))
          }
        },
      },
      {
        // 提案审批：模型只能提，人只能在这里批。life 只记决定，growth 会真的推进阶段。
        kind: 'exact',
        path: '/api/psyche/proposals/decide',
        handler: async (request, response) => {
          if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
            send(response, 405, { ok: false, error: '只接受 POST' })
            return
          }
          let body: Record<string, unknown>
          try {
            body = await readJsonBody(request)
          } catch {
            send(response, 400, { ok: false, error: '请求体不是合法 JSON' })
            return
          }
          // 三个参数都显式校验：accept 必须是真布尔，避免 "false" 字符串被当成批准
          const proposalId = typeof body.proposalId === 'string' ? body.proposalId.trim() : ''
          if (!proposalId) {
            send(response, 400, { ok: false, error: 'proposalId 必填' })
            return
          }
          if (typeof body.accept !== 'boolean') {
            send(response, 400, { ok: false, error: 'accept 必须是 true 或 false' })
            return
          }
          const db = runtime.db
          if (!db) {
            send(response, 503, { ok: false, error: '数据库还没准备好' })
            return
          }
          // 恢复任务排上队之后数据根马上要被整体替换，这时的决定写进去也会被覆盖，
          // 所以直接拒绝而不是让它静默成功（解冻入口在 cancelRestore）。
          if (runtime.core?.writesFrozen) {
            send(response, 409, {
              ok: false,
              code: 'E_RESTORE_PENDING',
              error: '有一次恢复已经排上队，数据马上要整体替换：请先应用或取消它，再来决定提案',
            })
            return
          }
          try {
            const result = decideProposal(db, {
              proposalId,
              accept: body.accept,
              actor: typeof body.actor === 'string' && body.actor ? body.actor : 'owner',
            })
            runtime.log.info('proposal', `提案 ${proposalId} → ${result.status}：${result.note}`)
            sendJson(response, result)
          } catch (error) {
            logger.warn?.(`[psyche] 提案审批失败：${errorText(error)}`)
            send(response, 400, toErrorPayload(error))
          }
        },
      },
      {
        // 调试与运维：GET 读现状，POST 执行动作（每个动作都会记一条日志）
        kind: 'exact',
        path: '/api/psyche/ops',
        handler: async (request, response) => {
          const method = (request.method ?? 'GET').toUpperCase()
          if (method === 'GET') {
            sendJson(response, ops())
            return
          }
          if (method !== 'POST') {
            send(response, 405, { ok: false, error: '只接受 GET / POST' })
            return
          }
          let body: Record<string, unknown>
          try {
            body = await readJsonBody(request)
          } catch {
            send(response, 400, { ok: false, error: '请求体不是合法 JSON' })
            return
          }
          // action 非法就落 default 的 400；不做前缀/模糊匹配，避免 'backup-now' 之类误触发真实动作。
          const action = typeof body.action === 'string' ? body.action : ''
          await ready
          try {
            switch (action) {
              case 'backup': {
                // 备份走 SQLite 的在线备份接口，读不锁写；要 db 与 dataDir 都有，缺一个就 503。
                if (!runtime.db || !runtime.dataDir) {
                  send(response, 503, { ok: false, error: '数据库还没准备好' })
                  return
                }
                const result = backupDatabase(runtime.db, runtime.dataDir)
                runtime.log.info('backup', `备份完成：${result.file}（${Math.round(result.bytes / 1024)} KB，${result.durationMs} ms）`)
                // 回包带上最新的 ops()：前端不用再追一发 GET 才能刷新运维面板。
                sendJson(response, { ok: true, action, backup: result, ops: ops() })
                return
              }
              case 'sync-growth': {
                // 阶段推进只发生在写路径：这里手动触发 syncGrowth（内部幂等，连点不会重复记里程碑）。
                const synced = await (await core()).syncGrowth()
                runtime.log.info('growth', `手动评估闸门：推进 ${synced.advanced.length} 个阶段`)
                sendJson(response, { ok: true, action, advanced: synced.advanced, ops: ops() })
                return
              }
              case 'archive': {
                // 迁移包：库快照 + 人格原文 + 配置 + 偏好 + 素材，打成一个 tar.gz。
                // 这条比 backup 重（要读全库快照再 gzip），所以按钮上写清楚是「导出迁移包」。
                try {
                  const result = makeArchive()
                  sendJson(response, { ok: true, action, archive: { file: result.file, bytes: result.bytes, files: result.manifest.files.length }, ops: ops() })
                } catch (error) {
                  sendServerError(response, '导出迁移包失败', error)
                }
                return
              }
              case 'purge-logs': {
                // 只清内存里的引擎日志环，不动数据库里的 operations 表（那是审计记录）。
                runtime.log.clear()
                runtime.log.info('ops', '引擎日志已清空')
                sendJson(response, { ok: true, action, ops: ops() })
                return
              }
              default:
                // 错误文案里直接列出可用动作，省得前端维护一份镜像枚举。
                send(response, 400, {
                  ok: false,
                  error: '不认识的动作（backup / sync-growth / purge-logs）',
                })
            }
          } catch (error) {
            logger.warn?.(`[psyche] 运维动作 ${action || '(空)'} 失败：${errorText(error)}`)
            send(response, 500, httpErrorBody(error))
          }
        },
      },
    ]
    // 每条路由单独一个 effect：这样宿主重载 webServer 或单条卸载时能逐条回收，
    // 合并成一个 effect 会出现「一条失败整组丢失」。
    for (const route of routes) {
      sctx.effect(() => {
        const dispose = sctx.webServer.register(route)
        return () => {
          try {
            dispose?.()
          } catch {
            // 宿主已卸载：这里再抛会把卸载流程打断，所以吞掉。
          }
        }
      }, `dsh-psyche.route(${route.path})`)
    }
  })

  // ── 卸载 ──────────────────────────────────────────────────
  // 关库放在卸载 effect 里：插件被停用/宿主退出时释放连接与 WAL。
  // close 失败只告警不抛：进程正在退出，抛出去也没人能处理。
  ctx.effect(() => async () => {
    groupRuntimeClosed=true
    try {
      await groupStarting
      await groupScheduler?.stop()
      groupScheduler=null
      await qqBridge?.stop()
      qqBridge=null
      await qqControl?.close()
      qqControl=null
      await qqManager?.stop()
      qqManager=null
    } catch {logger.warn?.('[psyche][group] GROUP_STOP_FAILED')}
    try {
      runtime.db?.close()
      logger.debug?.('[psyche] 数据库连接已关闭')
    } catch (error) {
      logger.warn?.(`[psyche] 关闭数据库失败：${errorText(error)}`)
    }
  }, 'dsh-psyche.lifecycle()')
}

export default { name, inject, Config, apply }

