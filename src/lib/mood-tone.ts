/**
 * P3-A B3-2：语气投影 → 受控 Prompt Context 文本。
 *
 * 边界（B3-0 冻结稿 §7/§8）：
 * - 只把 `MoodProjection` 渲染成两行受控文本；不输出维度 key、强度、baseline 或任何数值。
 * - Provider 必须同步、无副作用：不 await、不初始化数据库、不写库、不调模型。
 * - 读取失败 / 投影失败一律降级为「平稳」，由调用方记诊断，绝不阻断回复。
 */
import {
  MOOD_NEUTRAL_TONE,
  MOOD_PROJECTION_VERSION,
  projectMoodTone,
  type MoodProjection,
  type MoodValues,
} from './mood.js'

/** Context 注册名（唯一；与 `psyche-memory` Section 互不影响）。 */
export const MOOD_TONE_CONTEXT_NAME = 'psyche-mood-tone'

/** Context 之间的排序值；只决定多个 Context 的相对顺序，不影响 Section。 */
export const MOOD_TONE_ORDER = 100

/** 安全边界行：固定文本，不随投影结果变化。 */
export const MOOD_TONE_SAFETY_LINE =
  '语气只用于轻微调整措辞与表达节奏；不改变事实判断、任务目标、安全边界、身份定义、记忆写入权限或是否主动联系的决策；不声称拥有真实的人类情感，不诱导、操控或施压。'

/** 把投影结果渲染成固定两行文本。 */
export function renderMoodToneText(projection: MoodProjection): string {
  const opening = projection.secondary
    ? `当前语气：${projection.tone}，略带${projection.secondary}。`
    : `当前语气：${projection.tone}。`
  return `${opening}\n${MOOD_TONE_SAFETY_LINE}`
}

/** 中性文本（平稳）。DB 未就绪或任何异常都回退到这里。 */
export const NEUTRAL_MOOD_TONE_TEXT: string = renderMoodToneText({
  tone: MOOD_NEUTRAL_TONE,
  secondary: null,
  neutral: true,
  projectionVersion: MOOD_PROJECTION_VERSION,
})

export interface MoodToneProviderOptions {
  /** 同步读取当前有效值；返回 `null` 表示「暂时没有可用状态」，走中性。 */
  readValues: () => MoodValues | null
  /** 读取或投影失败时的诊断回调（只记摘要，不带用户原文）。 */
  onError?: (error: unknown) => void
}

/**
 * 构造 PromptContext.text 使用的同步 Provider。
 *
 * 该函数本身不做 I/O：`readValues` 由宿主接线传入（通常是 `loadMood(db).values`）。
 * 任何异常都在这里收口成中性文本，保证 Prompt Assembly 不会被 Mood 故障打断。
 */
export function createMoodToneProvider(options: MoodToneProviderOptions): () => string {
  return () => {
    let values: MoodValues | null
    try {
      values = options.readValues()
    } catch (error) {
      options.onError?.(error)
      return NEUTRAL_MOOD_TONE_TEXT
    }
    if (values === null) return NEUTRAL_MOOD_TONE_TEXT
    try {
      return renderMoodToneText(projectMoodTone(values))
    } catch (error) {
      options.onError?.(error)
      return NEUTRAL_MOOD_TONE_TEXT
    }
  }
}

/** `systemPrompt.context()` 的最小形状；只声明本模块用到的部分，便于测试替身。 */
export interface MoodTonePromptApi {
  context(options: { name: string; order: number; text: () => string }): () => void
}

export interface MoodToneRegistration {
  /** 注销该 Context。 */
  dispose: () => void
  /** 当前注册的 Provider（测试可直接调用）。 */
  text: () => string
}

export interface MoodToneRegisterOptions {
  api: MoodTonePromptApi
  /** 总开关关闭时不注册，返回 `null`。 */
  enabled: boolean
  readValues: () => MoodValues | null
  onError?: (error: unknown) => void
}

/**
 * 注册（或按开关跳过）`psyche-mood-tone` Context。
 *
 * 调用方负责生命周期：拿到 `dispose` 后在 effect cleanup 里注销；同一时刻只注册一次。
 */
export function registerMoodToneContext(options: MoodToneRegisterOptions): MoodToneRegistration | null {
  if (!options.enabled) return null
  const text = createMoodToneProvider({ readValues: options.readValues, onError: options.onError })
  const dispose = options.api.context({
    name: MOOD_TONE_CONTEXT_NAME,
    order: MOOD_TONE_ORDER,
    text,
  })
  return { dispose, text }
}
