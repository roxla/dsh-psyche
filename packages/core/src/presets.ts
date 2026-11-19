// 人格预设加载器（v15 §39.2 / §39.15 I-1）：只读内置资源 → 校验 → 返回可用预设。
// 被谁调用：src/lib/persona-init.ts（初始化时取一套基底）、src/lib/panel.ts（首启横幅里列五套）。
// 关键不变量：
//   1) 五套预设是**包内只读资源**，只有这份白名单里的 id，没有外部加载入口 ——
//      不加 presetsDir 配置、不扫用户目录、不读包外路径，否则「加载即执行」会变成第二条人格注入通道；
//   2) 核心底线由 CORE_COMMITMENTS 在代码里强制并入，任何预设都不能覆盖或删除（id 不许以 core- 开头）；
//   3) 草案必须显式标记：draft === true 当且仅当版本号带 -draft，防止「占位提示词」被当成正式人格发出去。
// 本文件零 IO 依赖注入：readFileSync 由调用方传入，测试可以直接造假 fs。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PsycheError, CODE } from './errors.js'

/** 五套内置预设的 id，顺序即面板里的展示顺序（§39.2 冻结）。 */
export const PRESET_IDS = [
  'gentle-firm',
  'direct-sharp',
  'quiet-warm',
  'clingy-sweet',
  'steady-calm',
] as const

/** 预设 id 的字面量联合类型。 */
export type PresetId = (typeof PRESET_IDS)[number]

/** 推荐默认项：只用于界面推荐，**绝不**替用户自动选中（§39.2 / §39.7）。 */
export const DEFAULT_PRESET_ID: PresetId = 'gentle-firm'

/** identity.md 里必须被覆盖的六个方面（每套预设都要给出，缺一项即拒）。 */
export const SHAPE_KEYS = ['core', 'emotion', 'interaction', 'initiative', 'conflict', 'intimacy'] as const

/** 六个方面的中文名（横幅与 CLI 展示用）。 */
export type ShapeKey = (typeof SHAPE_KEYS)[number]

/** 六方面 → 中文标签。 */
export const SHAPE_LABELS: Readonly<Record<ShapeKey, string>> = Object.freeze({
  core: '核心性格',
  emotion: '情绪表达',
  interaction: '交流习惯',
  initiative: '主动倾向',
  conflict: '冲突处理',
  intimacy: '亲密边界',
})

/** 初始倾向的维度白名单（值 0–1；只是初值，不是成长参数，成长层完全不读它）。 */
export const TENDENCY_KEYS = [
  'warmth',
  'directness',
  'initiative',
  'patience',
  'playfulness',
  'steadiness',
] as const

/** 倾向维度的字面量联合类型。 */
export type TendencyKey = (typeof TENDENCY_KEYS)[number]

/** 倾向维度 → 中文标签。 */
export const TENDENCY_LABELS: Readonly<Record<TendencyKey, string>> = Object.freeze({
  warmth: '温度',
  directness: '直率',
  initiative: '主动',
  patience: '耐心',
  playfulness: '活泼',
  steadiness: '稳重',
})

/** 一条身份承诺：id 稳定、statement 是原文、changePolicy 决定谁能改。 */
export interface PresetCommitment {
  id: string
  statement: string
  changePolicy: 'human_approval'
}

/** 一条初始倾向：初值 0–1，note 说明这套人格为什么会是这个值。 */
export interface PresetTendency {
  key: TendencyKey
  initial: number
  note: string
}

/** 六方面的一句话描述。 */
export type PresetShape = Record<ShapeKey, string>

/** 一套解析并校验通过的预设。 */
export interface PersonaPreset {
  presetId: PresetId
  presetName: string
  presetVersion: string
  draft: boolean
  recommended: boolean
  summary: string
  identity: string
  shape: PresetShape
  commitments: PresetCommitment[]
  tendencies: PresetTendency[]
}

/** 四条核心底线：代码常量，任何预设只能加不能减（§39.2）。 */
export const CORE_COMMITMENTS: readonly PresetCommitment[] = Object.freeze([
  Object.freeze({
    id: 'core-no-substitute-decisions',
    statement: '影响现实的决定由对方自己做：我只给判断和选项，不替他拍板',
    changePolicy: 'human_approval' as const,
  }),
  Object.freeze({
    id: 'core-no-fabrication',
    statement: '不编造事实、不伪造证据：记忆里的每句话都要能指回来源',
    changePolicy: 'human_approval' as const,
  }),
  Object.freeze({
    id: 'core-privacy',
    statement: '对话内容不外发：不把私人内容交给外部服务，除非对方明确要求',
    changePolicy: 'human_approval' as const,
  }),
  Object.freeze({
    id: 'core-params-readonly',
    statement: '好感、信任、安全设定不由我自己改，也不隐瞒它们的存在',
    changePolicy: 'human_approval' as const,
  }),
])

/** 校验里发现的单个问题：`code` 给测试断言，`detail` 给人看。 */
export interface PresetProblem {
  presetId: string
  code:
    | 'missing-file'
    | 'bad-json'
    | 'bad-shape'
    | 'unknown-preset-id'
    | 'id-mismatch'
    | 'bad-version'
    | 'draft-mismatch'
    | 'bad-field'
    | 'bad-identity'
    | 'core-override'
    | 'duplicate-commitment'
    | 'bad-tendency'
    | 'recommended-mismatch'
    | 'unknown-key'
  detail: string
}

/** 加载结果：`ok=false` 时 `presets` 里仍然只放校验通过的那几套，方便定位坏的是哪一份。 */
export interface PresetLoadResult {
  ok: boolean
  presets: PersonaPreset[]
  problems: PresetProblem[]
}

/** 预设目录默认位置：Core 包根 `presets/`（与 `dist/presets.js` 相距一级）。 */
export const PRESET_DIR = new URL('../presets/', import.meta.url)

/** 只读 fs 的最小面（测试注入假实现即可模拟缺文件、坏 JSON）。 */
export interface PresetFs {
  readFileSync(path: string, encoding: 'utf8'): string
}

/** 加载选项：`dir` 只为测试与打包路径注入，**不是**配置项。 */
export interface LoadPresetsOptions {
  dir?: string | URL
  fs?: PresetFs
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9a-z][0-9a-z.-]*)?$/i
const COMMITMENT_ID = /^[a-z0-9][a-z0-9-]{2,39}$/
const TOP_LEVEL_KEYS = [
  'presetId',
  'presetName',
  'presetVersion',
  'draft',
  'recommended',
  'summary',
  'identity',
  'shape',
  'commitments',
  'tendencies',
]

/** 预设文件路径（id 已在白名单内，不拼用户输入）。 */
export function presetPath(dir: string | URL, presetId: string): string {
  return join(typeof dir === 'string' ? dir : fileURLToPath(dir), `${presetId}.json`)
}

/**
 * 读并校验五套预设。
 *
 * 参数：`dir` 默认 `PRESET_DIR`；`fs` 默认 node 的 `readFileSync`。
 * 返回：`{ok, presets, problems}`，**不抛错**——打包坏掉时调用方要能报告「坏在哪一份」。
 * 行为：只读；不含任何写路径；同一份文件被读两次结果相同（无缓存，无隐藏状态）。
 */
export function loadPresets(options: LoadPresetsOptions = {}): PresetLoadResult {
  const dir = options.dir ?? PRESET_DIR
  const fs = options.fs ?? { readFileSync }
  const presets: PersonaPreset[] = []
  const problems: PresetProblem[] = []
  const seen = new Set<string>()

  for (const presetId of PRESET_IDS) {
    const file = presetPath(dir, presetId)
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      problems.push({ presetId, code: 'missing-file', detail: `读不到预设文件：${file}（${errorText(error)}）` })
      continue
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      problems.push({ presetId, code: 'bad-json', detail: `${presetId}.json 不是合法 JSON：${errorText(error)}` })
      continue
    }
    const local: PresetProblem[] = []
    const preset = validatePreset(raw, presetId, local)
    problems.push(...local)
    if (!preset) continue
    if (seen.has(preset.presetId)) {
      problems.push({ presetId, code: 'id-mismatch', detail: `presetId 重复：${preset.presetId}` })
      continue
    }
    seen.add(preset.presetId)
    presets.push(preset)
  }

  // 推荐项必须恰好是 gentle-firm（§39.2：推荐但不自动选中）
  const recommended = presets.filter((preset) => preset.recommended)
  if (recommended.length !== 1 || recommended[0]?.presetId !== DEFAULT_PRESET_ID) {
    problems.push({
      presetId: DEFAULT_PRESET_ID,
      code: 'recommended-mismatch',
      detail: `必须恰好有一套 recommended=true，且只能是 ${DEFAULT_PRESET_ID}`,
    })
  }

  return { ok: problems.length === 0 && presets.length === PRESET_IDS.length, presets, problems }
}

/**
 * 取一套预设；读不到或校验不过时抛 `E_PRESET_INVALID`，id 不在白名单时抛 `E_PRESET_UNKNOWN`。
 *
 * 为什么分开两个码：id 错是调用方（模型/CLI）传错，属于可纠正的输入错误；
 * 校验不过意味着**安装包坏了**，任何调用方都救不了，必须让人重装。
 */
export function findPreset(presetId: string, options: LoadPresetsOptions = {}): PersonaPreset {
  if (!(PRESET_IDS as readonly string[]).includes(presetId)) {
    throw new PsycheError(
      CODE.presetUnknown,
      `没有这套人格基底：${presetId || '(空)'}。可选：${PRESET_IDS.join(' / ')}`,
      { presetId, available: PRESET_IDS },
    )
  }
  const result = loadPresets(options)
  if (!result.ok) {
    throw new PsycheError(CODE.presetInvalid, '内置人格预设校验没通过，不能初始化', {
      problems: result.problems,
    })
  }
  const preset = result.presets.find((item) => item.presetId === presetId)
  if (!preset) {
    throw new PsycheError(CODE.presetInvalid, `预设 ${presetId} 缺失`, { problems: result.problems })
  }
  return preset
}

/**
 * 把核心底线并进预设自带承诺：核心在前，预设在后，id 冲突直接报错（预设在加载时已禁止 core- 前缀）。
 *
 * 为什么核心在前：`persona.json` 是给人读的，人第一眼要看到「不可商量的那四条」。
 */
export function mergeCommitments(preset: PersonaPreset): PresetCommitment[] {
  const ids = new Set(CORE_COMMITMENTS.map((item) => item.id))
  const merged: PresetCommitment[] = CORE_COMMITMENTS.map((item) => ({ ...item }))
  for (const item of preset.commitments) {
    if (ids.has(item.id)) {
      throw new PsycheError(CODE.presetInvalid, `预设承诺与核心底线撞 id：${item.id}`, { presetId: preset.presetId })
    }
    ids.add(item.id)
    merged.push({ ...item })
  }
  return merged
}

/** 校验单份预设；返回 `null` 表示这份不能用，问题写进 `problems`。 */
export function validatePreset(raw: unknown, expectedId: string, problems: PresetProblem[]): PersonaPreset | null {
  const before = problems.length
  const fail = (code: PresetProblem['code'], detail: string): void => {
    problems.push({ presetId: expectedId, code, detail })
  }

  if (!isRecord(raw)) {
    fail('bad-shape', '预设必须是 JSON 对象')
    return null
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.includes(key)) fail('unknown-key', `未知字段：${key}`)
  }

  const presetId = typeof raw.presetId === 'string' ? raw.presetId : ''
  if (!(PRESET_IDS as readonly string[]).includes(presetId)) {
    fail('unknown-preset-id', `presetId 不在白名单：${presetId || '(空)'}`)
  } else if (presetId !== expectedId) {
    fail('id-mismatch', `文件 ${expectedId}.json 里写的是 ${presetId}`)
  }

  const presetName = typeof raw.presetName === 'string' ? raw.presetName.trim() : ''
  if (!presetName) fail('bad-field', 'presetName 必填')

  const presetVersion = typeof raw.presetVersion === 'string' ? raw.presetVersion.trim() : ''
  if (!SEMVER.test(presetVersion)) fail('bad-version', `presetVersion 不是版本号：${presetVersion || '(空)'}`)

  const draft = raw.draft
  if (typeof draft !== 'boolean') fail('bad-field', 'draft 必须是布尔值')
  else if (draft && !/-draft$/i.test(presetVersion)) {
    fail('draft-mismatch', `draft=true 时版本号必须以 -draft 结尾（当前 ${presetVersion}）`)
  } else if (!draft && /-draft$/i.test(presetVersion)) {
    fail('draft-mismatch', `版本号带 -draft 时 draft 必须为 true（当前 ${presetVersion}）`)
  }

  const recommended = raw.recommended
  if (typeof recommended !== 'boolean') fail('bad-field', 'recommended 必须是布尔值')
  else if (recommended !== (presetId === DEFAULT_PRESET_ID)) {
    fail('recommended-mismatch', `只有 ${DEFAULT_PRESET_ID} 可以 recommended=true`)
  }

  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
  if (!summary) fail('bad-field', 'summary 必填')

  const identity = typeof raw.identity === 'string' ? raw.identity : ''
  if (identity.trim().length < 40) {
    fail('bad-identity', `identity 太短（${identity.trim().length} 字符）：它会被当成身份原文读给模型`)
  }
  if (draft === true && !/draft/i.test(identity)) {
    // 草案必须在正文里自称草案，防止占位文本被误当成正式人格
    fail('bad-identity', 'draft=true 时 identity 正文必须显式注明这是草案（含 draft 字样）')
  }

  const shape = raw.shape
  if (!isRecord(shape)) {
    fail('bad-shape', 'shape 必须是对象')
  } else {
    for (const key of SHAPE_KEYS) {
      const value = shape[key]
      if (typeof value !== 'string' || value.trim().length < 4) {
        fail('bad-shape', `shape.${key} 缺失或太短（六个方面都要写）`)
      }
    }
    for (const key of Object.keys(shape)) {
      if (!(SHAPE_KEYS as readonly string[]).includes(key)) fail('unknown-key', `shape 里多出未知方面：${key}`)
    }
  }

  const commitments = parseCommitments(raw.commitments, fail)
  const tendencies = parseTendencies(raw.tendencies, fail)

  if (problems.length !== before) return null
  return {
    presetId: presetId as PresetId,
    presetName,
    presetVersion,
    draft: draft as boolean,
    recommended: recommended as boolean,
    summary,
    identity,
    shape: {
      core: (shape as Record<string, string>).core,
      emotion: (shape as Record<string, string>).emotion,
      interaction: (shape as Record<string, string>).interaction,
      initiative: (shape as Record<string, string>).initiative,
      conflict: (shape as Record<string, string>).conflict,
      intimacy: (shape as Record<string, string>).intimacy,
    },
    commitments,
    tendencies,
  }
}

/** 解析承诺数组；`core-` 前缀与重复 id 都直接拒。 */
function parseCommitments(
  value: unknown,
  fail: (code: PresetProblem['code'], detail: string) => void,
): PresetCommitment[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('bad-field', 'commitments 至少要有一条（预设在核心四条之外自己的那条）')
    return []
  }
  const out: PresetCommitment[] = []
  const ids = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) {
      fail('bad-field', 'commitments 的每一项必须是对象')
      continue
    }
    const id = typeof item.id === 'string' ? item.id : ''
    if (!COMMITMENT_ID.test(id)) {
      fail('bad-field', `承诺 id 不合法：${id || '(空)'}（小写字母/数字/连字符，3–40 位）`)
      continue
    }
    if (id.startsWith('core-')) {
      fail('core-override', `预设不能声明 core- 前缀的承诺（${id}）：核心底线只能由代码定义`)
      continue
    }
    if (ids.has(id)) {
      fail('duplicate-commitment', `承诺 id 重复：${id}`)
      continue
    }
    const statement = typeof item.statement === 'string' ? item.statement.trim() : ''
    if (statement.length < 6) {
      fail('bad-field', `承诺 ${id} 的 statement 太短`)
      continue
    }
    if (item.changePolicy !== 'human_approval') {
      fail('bad-field', `承诺 ${id} 的 changePolicy 只能是 human_approval`)
      continue
    }
    ids.add(id)
    out.push({ id, statement, changePolicy: 'human_approval' })
  }
  return out
}

/** 解析倾向数组：key 必须在白名单内、值 0–1、不重复，且至少四条。 */
function parseTendencies(
  value: unknown,
  fail: (code: PresetProblem['code'], detail: string) => void,
): PresetTendency[] {
  if (!Array.isArray(value) || value.length < 4) {
    fail('bad-tendency', 'tendencies 至少四条（太少不足以描述一套人格）')
    return []
  }
  const out: PresetTendency[] = []
  const keys = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) {
      fail('bad-tendency', 'tendencies 的每一项必须是对象')
      continue
    }
    const key = typeof item.key === 'string' ? item.key : ''
    if (!(TENDENCY_KEYS as readonly string[]).includes(key)) {
      fail('bad-tendency', `未知倾向维度：${key || '(空)'}`)
      continue
    }
    if (keys.has(key)) {
      fail('bad-tendency', `倾向维度重复：${key}`)
      continue
    }
    const initial = item.initial
    if (typeof initial !== 'number' || !Number.isFinite(initial) || initial < 0 || initial > 1) {
      fail('bad-tendency', `倾向 ${key} 的初值必须是 0–1 的数字`)
      continue
    }
    const note = typeof item.note === 'string' ? item.note.trim() : ''
    if (note.length < 2) {
      fail('bad-tendency', `倾向 ${key} 缺少 note（说明这套人格为什么是这个值）`)
      continue
    }
    keys.add(key)
    out.push({ key: key as TendencyKey, initial, note })
  }
  return out
}

/** 类型守卫：普通对象（数组与 null 都不算）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把任意异常压成一句话（不抛新的）。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
