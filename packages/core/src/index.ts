/**
 * dsh-psyche-core —— 心灵套装的核心插件入口。
 *
 * P1-1 的边界：只保证「能被宿主加载、能声明依赖、内部模块目录就位」。
 * 数据库、工具、注入段、认知闭环都不在这里实现——它们按 P1-3 起的顺序进来。
 *
 * 入口形状对齐 DSH 的插件约定：具名 `name` / `inject` / `apply` +
 * 一个 default 导出（宿主 loader 两种写法都认）。
 */
import { PSYCHE_CONTRACT_VERSION } from 'dsh-psyche-contract'

// D1-2a：错误码与 id 生成搬进 Core，作为唯一实现。根包 src/lib/{errors,ids}.ts
// 只剩 re-export 壳，不允许出现第二套定义。
export * from './errors.js'
export * from './ids.js'

// D1-2b：schema / adapter / dbcheck 搬进 Core，作为唯一实现。
// 根包 src/lib/{schema,adapter,dbcheck}.ts 只剩 re-export 壳。
export * from './schema.js'
export * from './adapter.js'
export * from './dbcheck.js'

// D1-2c：store 的依赖闭包先搬（叶子 → 根）。顺序：
// derive（零依赖）→ quality（零依赖）→ admission（只 type 依赖 quality）
// → growth → proposals → store。
export * from './derive.js'
export * from './quality/index.js'
export * from './admission/index.js'
export * from './growth.js'
export * from './growth-reflection.js'
export * from './growth-candidate-filter.js'
export * from './growth-confirmation.js'
export * from './memory-hygiene.js'
export * from './external-source.js'
export * from './external-source-erase.js'
export * from './proposals.js'
export * from './store.js'
export * from './room-intake.js'
export * from './group-policy.js'
export * from './group-proof.js'
export type { GroupCommand, GroupMember, GroupBatch } from './group-scheduling.js'
export { groupProjection, groupMemberText, groupProjectionHash, GROUP_PROJECTION_VERSION } from './group-scheduling.js'
export * from './relationship.js'
export * from './contact-affect.js'
export * from './contact-trust.js'
// P3-B-3：关系投影（纯函数；只输出一行受控文本，不写库）与独立 Prompt Context。
export * from './relationship-projection.js'
export * from './relationship-context.js'

// P4-C-0：传输层契约（只送消息，不判权限、不重试、不持久化）。
export * from './chat-transport.js'

// P4-B-4：私聊回复 Outbox（Store + 唯一发送 Worker；默认关闭，见 B-4-2b 接线）。
export * from './qq-reply-outbox.js'
export * from './qq-reply-worker.js'

// D1-2e：认知与展示叶子模块搬进 Core（provenance/salience/fold 零依赖，
// tensions 只依赖 errors，cognition 依赖 adapter+salience）。
export * from './provenance.js'
export * from './salience.js'
export * from './fold.js'
export * from './tensions.js'
export * from './tension-store.js'
export * from './decision-store.js'
export * from './stance-engine.js'
export * from './stance-store.js'
export * from './projection.js'
export * from './diary-store.js'
export * from './diary-generation.js'
export * from './diary-recall.js'
export * from './diary-integrity.js'
export * from './audit-db.js'
export * from './audit-health.js'
export * from './audit-integrity.js'
// P3-A：情绪状态机（运行状态，不是长期记忆；不进 Artifact/Evidence/FTS/Recall）。
export * from './mood-schema.js'
export * from './mood-decay.js'
export * from './mood-store.js'
export * from './mood-initiator.js'
export * from './mood-rules.js'
export * from './mood-evaluator.js'
export * from './mood-turn.js'
export * from './mood-projection.js'

// P3-C：主动联系（v1 只产生候选与草稿；不发送、不持久化）。
export * from './proactive-trigger.js'
export * from './proactive-eligibility.js'
export * from './proactive-candidate.js'
export * from './proactive-draft.js'
export * from './proactive-consent.js'
export * from './cognition.js'

// D1-2f：人格预设加载器；资源 `presets/` 跟实现一起进 Core（唯一权威）。
export * from './presets.js'

// D1-2f：人格初始化状态机（文件为唯一真相，DB 是派生快照）。
export * from './persona-init.js'
// store 与 persona-init 都导出 PERSONA_ID（值同为 'main'）；显式再导出消歧。
export { PERSONA_ID } from './store.js'

// I-6：初始化协调服务（Owner 层用；不挂 Contract、不给聊天工具）。
export * from './persona-init-service.js'

// I-8：人格重置（reset 的 Core 半边；清文件 + 写历史，不删记忆库）。
export * from './persona-reset.js'

// D1-2f：归档包（只读打包/恢复前校验；无未用驱动 import）。
export * from './archive.js'

// D1-2f：恢复编排（保留 3 处只读 DatabaseSync 校验）。
export * from './restore.js'

// D1-2f：运维快照/日志（只读文件系统，不碰数据库连接）。
export * from './ops.js'

// P2-CAP-1c3-B：历史补采的扫描游标（CAS + 租约；只做存储，不读会话）。
export * from './capture-cursor.js'

// P2-FTS5 E1/E2：生产检索（bigram 交织、head 索引、原生 BM25、硬过滤）。
export * from './fts.js'

// E3/E5.3：敏感内容分类（只回答「像不像」；能不能公开由披露等级与授权流程决定）。
export * from './sensitive.js'

// P2-FTS5 E5.1：注入层二次校验（不信任候选字段；只读）。
export * from './composer.js'

// P2-FTS5 E5.5-B：RuntimeInput（可信身份绑定；会话级，请求级载体待宿主提供）。
export * from './runtime-input.js'
// R6-3A：可信通道绑定（Adapter 声明身份 → Host 校验 → Core 解析 → 一次性能力绑定）。
export * from './channel-binding.js'

// P2-FTS5 E5.5-C：agent/pre-step 注入（按 turn 幂等；无绑定只放行全局记忆）。
export * from './pre-step-injection.js'
export * from './injection-manifest.js'
export * from './final-check.js'

// P2-Recall R3：统一召回内核（主动 Recall 与自动注入共用同一套候选与准入）。
export * from './recall.js'
export * from './recall-receipt.js'

// R6-CAP-2：Source 隔离标记（append-only 的 sources 不能原地改，隔离另记一张表）。
export * from './quarantine.js'

// P6-0/P6-2：自主意愿（只读派生 + 持久化账本；不执行动作、不发送）。
export * from './intention-attention.js'
export {
  INTENTION_CANDIDATE_VERSION,
  MAX_INTENTION_CANDIDATES,
  INTENTION_TTL_MS as INTENTION_CANDIDATE_TTL_MS,
  deriveIntentionId,
  buildIntentionCandidates,
} from './intention-candidate.js'
export type {
  IntentionCandidate,
  CandidateSkipReason,
  CandidateSkip,
  BuildCandidatesInput as IntentionBuildCandidatesInput,
  CandidateResult as IntentionCandidateResult,
} from './intention-candidate.js'
export * from './intention-choice.js'
export * from './intention-projection.js'
export * from './intention-store.js'

export const name = 'dsh-psyche-core'

/** P1-1 只声明 tools；宿主服务（sessions / webServer 等）在 P1-2 之后按需追加。 */
export const inject = ['tools'] as const

export interface CoreOptions {
  /** 数据根；不填时由 P1-3 的 store 层按 $DSH_HOME/psyche 解析。 */
  dataDir?: string
  /** 驱动偏好；不填时按「先 node:sqlite、后 better-sqlite3」探测。 */
  driver?: 'node:sqlite' | 'better-sqlite3'
}

export const contractVersion = PSYCHE_CONTRACT_VERSION

/**
 * 插件入口。P1-1 不注册任何服务与工具，只确认契约能被解析。
 * P1-2 起：注册 ctx.psyche 服务、十个工具、注入段。
 */
export function apply(ctx: unknown, options: CoreOptions = {}): void {
  void ctx
  void options
}

const plugin = { name, inject, apply, contractVersion }
export default plugin
