/**
 * P7-1/P7-2：人格主导（dominance）。
 *
 * 只有「开关打开 + 可信 Psyche Agent + 人格已锁定且 ready」同时成立时：
 * - `system-prompt/assemble` 在 next() 之后一次性校验宿主身份句，
 *   把 coding-agent 身份句替换成中性纪律句，并插入人格段与表达约束；
 * - 任一步失败都保持宿主原样，不插入任何段（原子回退）；
 * - 旧 Context 与 Composer 的 persona 块同时让位，避免重复注入。
 *
 * 不再注册独立 Section：Section 阶段看不到完整段列表，无法预检宿主身份句，
 * 会出现「人格段已插入、宿主句却没换成」的半接管。
 */
import type { PersonaProjection } from './persona-runtime.js'

export const PERSONA_SECTION_NAME = 'psyche-persona'
export const PERSONA_SECTION_ORDER = -90
export const PERSONA_EXPRESSION_NAME = 'psyche-expression'
export const PERSONA_EXPRESSION_ORDER = 1000
export const HOST_PERSONA_PREFIX = 'deployment:persona-prefix'
export const HOST_PERSONA = 'deployment:persona'

/** GPT 冻结的表达约束：不超过 120 字，不碰事实/权限/工具边界。 */
export const PERSONA_EXPRESSION_TEXT = '先给结论，再简短说依据；口语、少术语，情绪克制，不夸大事实与权限。'

/** P7-3：只改说话方式，不重复 Mood/Relationship 状态，也不碰事实与权限。 */
export function expressionTextFor(band?: string): string {
  if (band === 'reserved') return '先给结论，短句，留白；语气收着，不主动铺陈。'
  if (band === 'expressive') return '先给结论，再补一两句具体依据；语气可以更放松，但不夸张、不编造。'
  return PERSONA_EXPRESSION_TEXT
}

/** 替换后的中性纪律句：保留工具/安全/任务约束，不重复人格。 */
export const HOST_DISCIPLINE_TEXT =
  '你在 DeepSeek Harness 的工具运行时里工作：工具调用、安全边界与任务纪律优先；不展示内部流程，不编造权限。'

/** 当前 rc3 宿主的人格前缀原文；文案变了就不改写（未知版本跳过）。 */
export const HOST_PREFIX_PATTERN = /^You are a coding agent powered by the \{\{model\}\} model\.?$/

export interface DominanceAgent {
  id?: string
  session?: { id?: string }
}

export interface DominanceSection {
  name: string
  text: string
}

export interface DominanceAssembly {
  agent?: DominanceAgent
  sections?: DominanceSection[]
}

export interface DominanceOptions {
  enabled: () => boolean
  dominance: () => boolean
  resolveAgent: (agent: DominanceAgent | undefined) => boolean
  read: () => PersonaProjection
  onError?: (error: unknown) => void
}

/**
 * 每轮共享一次判定：Section、waterfall、Composer 都从这里取。
 * 以传入的 assembly 对象做 WeakMap 缓存，保证同一轮三处看到同一份人格文本。
 */
export function createPersonaDominance(
  options: DominanceOptions,
): (assembly?: DominanceAssembly) => PersonaProjection | null {
  const cache = new WeakMap<object, PersonaProjection | null>()
  return (assembly?: DominanceAssembly): PersonaProjection | null => {
    if (!options.enabled() || !options.dominance()) return null
    if (assembly === undefined || !options.resolveAgent(assembly.agent)) return null
    const key = assembly as object
    if (cache.has(key)) return cache.get(key) ?? null
    let projection: PersonaProjection | null = null
    try {
      const read = options.read()
      projection = read.status === 'ready' && read.text ? read : null
    } catch (error) {
      options.onError?.(error)
      projection = null
    }
    cache.set(key, projection)
    return projection
  }
}

/**
 * 只替换宿主的 coding-agent 身份句；其余段、顺序、工具与安全约束一字不动。
 * 找不到目标段、文案不是已知版本、或没有判定通过时返回 false。
 */
export function rewriteHostPersona(assembly: DominanceAssembly | null | undefined): boolean {
  if (!assembly || !Array.isArray(assembly.sections)) return false
  const targets = assembly.sections.filter(
    (item) => item?.name === HOST_PERSONA_PREFIX || item?.name === HOST_PERSONA,
  )
  // 同名重复说明宿主版本/其它插件不可信，跳过而不是猜第一个。
  if (targets.length !== 1) return false
  const section = targets[0]
  const current = String(section.text ?? '').trim()
  if (!HOST_PREFIX_PATTERN.test(current)) return false
  section.text = HOST_DISCIPLINE_TEXT
  return true
}

/**
 * P7-2 原子注入：在 waterfall 的 `next()` 之后一次性完成
 * 「校验唯一宿主身份句 → 替换为中性纪律 → 插入人格段与表达段」。
 *
 * 任何一步不成立都返回 null，调用方保持组装结果原样，避免出现
 * 「宿主句没换、人格段却已经插进去」的半接管。返回新数组，不改入参。
 */
export function injectDominanceSections(
  sections: DominanceSection[] | undefined,
  personaText: string,
  expressionText: string,
): DominanceSection[] | null {
  if (!Array.isArray(sections) || sections.length === 0) return null
  const persona = String(personaText ?? '').trim()
  if (persona.length === 0) return null
  if (sections.some((item) => item?.name === PERSONA_SECTION_NAME || item?.name === PERSONA_EXPRESSION_NAME)) {
    return null
  }
  const targets = sections.filter(
    (item) => item?.name === HOST_PERSONA_PREFIX || item?.name === HOST_PERSONA,
  )
  if (targets.length !== 1) return null
  const prefixIndex = sections.indexOf(targets[0])
  if (prefixIndex < 0) return null
  const current = String(targets[0].text ?? '').trim()
  if (!HOST_PREFIX_PATTERN.test(current)) return null

  const next = sections.map((item) => ({ name: item.name, text: item.text }))
  next[prefixIndex] = { name: targets[0].name, text: HOST_DISCIPLINE_TEXT }
  next.splice(prefixIndex, 0, { name: PERSONA_SECTION_NAME, text: persona })

  const expression = String(expressionText ?? '').trim()
  if (expression.length > 0) {
    const suffixIndex = next.findIndex((item) => item.name === 'deployment:persona-suffix')
    const entry = { name: PERSONA_EXPRESSION_NAME, text: expression }
    if (suffixIndex >= 0) next.splice(suffixIndex, 0, entry)
    else next.push(entry)
  }
  return next
}

/** 供 Context/Composer 让位：本轮已由 waterfall 接管时返回 true。 */
export function shouldSuppressLegacyPersona(
  decision: (assembly?: DominanceAssembly) => PersonaProjection | null,
  assembly?: DominanceAssembly,
): boolean {
  return decision(assembly) !== null
}
