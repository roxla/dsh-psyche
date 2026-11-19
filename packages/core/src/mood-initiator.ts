// P3-A B2：Initiator 判定（纯函数，不做 IO、不读消息正文）。
//
// 定位：Mood 只对「这一轮是谁发起的」做判定；判定依据必须来自宿主事件或 Core 内部标识，
// 不能来自工具参数、模型输出、或者「最后一条消息的 role」。
//
// 冻结口径（docs/design/p3-a-mood-state-machine.md §5）：
//   - 四类：user / persona / scheduled / unknown；
//   - 优先级：scheduled > persona > user > unknown；
//   - 同一 Turn 内不变；外部插件注入 → unknown，不产生 delta。
/** 四类 Initiator（B0 §5.1 冻结）。 */
export type MoodInitiator = 'user' | 'persona' | 'scheduled' | 'unknown'

/** 判定依据：给日志/诊断用，不写库、不进历史。 */
export type MoodInitiatorBasis =
  | 'scheduled-task'
  | 'core-persona-trigger'
  | 'user-message'
  | 'no-trusted-source'

/** Scheduler 的可信任务标识；v1 没有生产者，为 P3-C 预留。 */
export interface MoodScheduledToken {
  taskId: string
  taskType?: string
}

/** Core 内部主动触发标识；v1 没有生产者，为 P3-C 预留。 */
export interface MoodPersonaToken {
  trigger: 'proactive' | 'reflection'
}

export interface MoodTrustedTokens {
  scheduled?: MoodScheduledToken | null
  persona?: MoodPersonaToken | null
}

/**
 * 判定证据。
 *
 * `userMessageCount` 只数 `source.kind === 'user'` 的真实用户消息——外部插件注入、
 * system / runtime-context、assistant 消息都不算。
 */
export interface MoodInitiatorEvidence {
  userMessageCount: number
  tokens?: MoodTrustedTokens | null
}

export interface MoodInitiatorDecision {
  initiator: MoodInitiator
  basis: MoodInitiatorBasis
  /** 归一化后的真实用户消息数（非法输入按 0）。 */
  userMessageCount: number
}

/** 冻结优先级（高 → 低），导出给测试与文档引用。 */
export const MOOD_INITIATOR_PRIORITY: readonly MoodInitiator[] = Object.freeze([
  'scheduled',
  'persona',
  'user',
  'unknown',
])

function countOf(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return Math.floor(numeric)
}

function scheduledOf(tokens: MoodTrustedTokens | null | undefined): MoodScheduledToken | null {
  const token = tokens?.scheduled
  if (token === null || token === undefined) return null
  const taskId = typeof token.taskId === 'string' ? token.taskId.trim() : ''
  if (taskId === '' || taskId.length > 120) return null
  const taskType = typeof token.taskType === 'string' ? token.taskType.trim().slice(0, 40) : undefined
  return taskType === undefined || taskType === '' ? { taskId } : { taskId, taskType }
}

function personaOf(tokens: MoodTrustedTokens | null | undefined): MoodPersonaToken | null {
  const token = tokens?.persona
  if (token === null || token === undefined) return null
  if (token.trigger !== 'proactive' && token.trigger !== 'reflection') return null
  return { trigger: token.trigger }
}

/**
 * 判定这一轮的 Initiator。
 *
 * 只认两类证据：真实用户消息数、Core 内部 token。
 * 拿不准时返回 `unknown`——unknown 不产生 delta，读时衰减照常。
 */
export function resolveMoodInitiator(evidence: MoodInitiatorEvidence): MoodInitiatorDecision {
  const userMessageCount = countOf(evidence?.userMessageCount)
  const tokens = evidence?.tokens ?? null
  if (scheduledOf(tokens) !== null) {
    return { initiator: 'scheduled', basis: 'scheduled-task', userMessageCount }
  }
  if (personaOf(tokens) !== null) {
    return { initiator: 'persona', basis: 'core-persona-trigger', userMessageCount }
  }
  if (userMessageCount > 0) {
    return { initiator: 'user', basis: 'user-message', userMessageCount }
  }
  return { initiator: 'unknown', basis: 'no-trusted-source', userMessageCount }
}

/** 可信来源（v1 只有 user 会真正算 delta；persona/scheduled 先识别、不评估内容）。 */
export function isMoodInitiatorTrusted(initiator: MoodInitiator): boolean {
  return initiator === 'user' || initiator === 'persona' || initiator === 'scheduled'
}
