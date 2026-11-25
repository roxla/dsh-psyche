/**
 * P5-2a 投影组合器（纯函数，无 I/O）。
 *
 * 契约见 docs/design/p5-projection-composition.md 与 P5-2 问答冻结记录：
 * - 必需层：隐私/Scope 纪律 + 完整人格；两者都不可截断。
 * - 可选层丢弃顺序：Relationship → Mood → Growth。
 * - 6000 token / 8000 字符只是「投影预算」，不包含 Recall 正文。
 * - 只按实际序列化内容计量；token 数是估算，不宣称精确上限。
 */

import { estimatePersonaTokens } from './persona-runtime.js'

export const PROJECTION_POLICY_VERSION = 'projection-v1'
export const PROJECTION_MAX_TOKENS = 6_000
export const PROJECTION_MAX_CHARS = 8_000

export type ProjectionBlockName =
  | 'memoryDiscipline'
  | 'persona'
  | 'projectBrief'
  | 'conversationRecall'
  | 'growth'
  | 'mood'
  | 'relationship'
  | 'intention'

export interface ProjectionBlock {
  text: string
  enabled?: boolean
}

export interface ProjectionInput {
  memoryDiscipline: string
  persona: ProjectionBlock
  /**
   * G1-B：同一项目的只读 Brief（当前目标 / 已完成 / 阻塞 / 下一步）。
   * 它回答「这一轮要接着做什么」，比成长、情绪更贴近当轮任务，
   * 所以在可选层里最后才丢；但排在人格之后，不挤占必需层。
   */
  projectBrief?: ProjectionBlock
  /**
   * Q5-A：最近的实际对话片段（原话召回）。
   * 它回答「我们上次聊到哪」，与 projectBrief 的「这一轮接着做什么」正交互补；
   * 排在 Brief 之后、成长之前——聊过的内容比长期画像更该进当轮上下文。
   */
  conversationRecall?: ProjectionBlock
  growth?: ProjectionBlock
  mood?: ProjectionBlock
  relationship?: ProjectionBlock
  /** P6-1：自主意愿层只作为最低优先级的可选分段，默认关闭。 */
  intention?: ProjectionBlock
}

export interface ProjectionBudget {
  maxTokens: number
  maxChars: number
}

export interface ProjectionResult {
  text: string
  kept: ProjectionBlockName[]
  dropped: ProjectionBlockName[]
  usedTokens: number
  usedChars: number
  policyVersion: string
  warnings: string[]
}

const OPTIONAL_KEEP_ORDER: Array<Exclude<ProjectionBlockName, 'memoryDiscipline' | 'persona'>> = [
  'projectBrief',
  'conversationRecall',
  'growth',
  'mood',
  'relationship',
  'intention',
]

const OPTIONAL_DROP_ORDER: Array<Exclude<ProjectionBlockName, 'memoryDiscipline' | 'persona'>> = [
  'intention',
  'relationship',
  'mood',
  'growth',
  'conversationRecall',
  'projectBrief',
]

const SERIALIZE_ORDER: ProjectionBlockName[] = [
  'memoryDiscipline',
  'persona',
  'projectBrief',
  'conversationRecall',
  'growth',
  'mood',
  'relationship',
  'intention',
]

function measure(text: string): { tokens: number; chars: number } {
  return { tokens: estimatePersonaTokens(text), chars: text.length }
}

/**
 * 组合一轮的投影文本。输入块由调用方读取；本函数不写库、不缓存、不读系统时钟。
 */
export function composeProjections(
  input: ProjectionInput,
  budget: ProjectionBudget = { maxTokens: PROJECTION_MAX_TOKENS, maxChars: PROJECTION_MAX_CHARS },
): ProjectionResult {
  const warnings: string[] = []
  const dropped: ProjectionBlockName[] = []

  const discipline = input.memoryDiscipline.trim()
  const persona = input.persona.enabled === false ? '' : input.persona.text.trim()

  if (discipline.length === 0) warnings.push('memory-discipline-missing')

  const requiredChars = discipline.length + (persona.length > 0 ? persona.length + 2 : 0)
  const requiredTokens = measure(discipline).tokens + (persona.length > 0 ? measure(`\n\n${persona}`).tokens : 0)
  let keepPersona = persona.length > 0

  // 必需层放不下：整块省略人格，只保留纪律；其余可选块全部省略。
  if (keepPersona && (requiredTokens > budget.maxTokens || requiredChars > budget.maxChars)) {
    keepPersona = false
    warnings.push('persona-over-budget')
    for (const name of OPTIONAL_DROP_ORDER) dropped.push(name)
  }

  const kept: ProjectionBlockName[] = ['memoryDiscipline']
  if (keepPersona) kept.push('persona')

  // 先按优先级收下全部可选块，再按最终序列化文本（含分隔符）逐块裁剪。
  for (const name of OPTIONAL_KEEP_ORDER) {
    const block = input[name]
    if (block === undefined) continue
    if (block.enabled === false || block.text.trim().length === 0) {
      dropped.push(name)
      continue
    }
    kept.push(name)
  }

  const byName: Record<ProjectionBlockName, ProjectionBlock | undefined> = {
    memoryDiscipline: { text: discipline },
    persona: keepPersona ? { text: persona } : undefined,
    projectBrief: input.projectBrief,
    conversationRecall: input.conversationRecall,
    growth: input.growth,
    mood: input.mood,
    relationship: input.relationship,
    intention: input.intention,
  }

  for (;;) {
    const orderedKept = SERIALIZE_ORDER.filter((name) => kept.includes(name))
    const text = orderedKept
      .map((name) => byName[name]?.text.trim() ?? '')
      .filter((part) => part.length > 0)
      .join('\n\n')
    const size = measure(text)
    const orderedDropped = OPTIONAL_DROP_ORDER.filter((name) => dropped.includes(name))
    if (size.tokens <= budget.maxTokens && size.chars <= budget.maxChars) {
      return {
        text,
        kept: orderedKept,
        dropped: orderedDropped,
        usedTokens: size.tokens,
        usedChars: size.chars,
        policyVersion: PROJECTION_POLICY_VERSION,
        warnings,
      }
    }
    const optionalKept = orderedKept.filter((name) => name !== 'memoryDiscipline' && name !== 'persona')
    if (optionalKept.length === 0) {
      // 只可能是必需层本身就超限：隐私纪律不允许截断，保留并明确告警。
      warnings.push('required-layer-over-budget')
      return {
        text,
        kept: orderedKept,
        dropped: orderedDropped,
        usedTokens: size.tokens,
        usedChars: size.chars,
        policyVersion: PROJECTION_POLICY_VERSION,
        warnings,
      }
    }
    const drop = OPTIONAL_DROP_ORDER.find((name) => optionalKept.includes(name))
    if (drop === undefined) break
    kept.splice(kept.indexOf(drop), 1)
    if (!dropped.includes(drop)) dropped.push(drop)
    warnings.push(`${drop}-over-budget`)
  }

  // 理论上不可达；保守返回空文本，避免超预算字符串外泄。
  return { text: '', kept: [], dropped: [...OPTIONAL_DROP_ORDER], usedTokens: 0, usedChars: 0,
    policyVersion: PROJECTION_POLICY_VERSION, warnings }
}
