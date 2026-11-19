// 面板视图偏好（v14 §29 的补充）：数据目录下一个 json，零依赖、不碰数据库。
//
// 为什么不写回 profile patch：这些是「看什么」的偏好，不是插件行为配置。
// 写 profile 要宿主配合、还要重启；偏好在数据目录里存一个 json，改了立刻生效。
// 权威仍然是 `config.json` / 插件设置页：这里只覆盖「显示与否」这一层。
// 调用方：index.ts 的面板接口（读写各一次）；不变量：文件坏了绝不让插件起不来。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 面板偏好。
 *
 * `promptSection` 是三态：`true` 强制注入、`false` 强制不注入、`null` 跟随插件配置——
 * 所以它不能用 `boolean`，否则「没表态」和「明确关掉」就分不开了。
 */
export interface PanelPrefs {
  /** 意识海 tab 是否显示（默认关闭）。 */
  sea: boolean
  /** 是否把写入纪律注入系统提示（默认跟随 Config 的 prompt.section）。 */
  promptSection: boolean | null
}

/**
 * 默认偏好：海 tab 关闭、注入跟随配置。
 *
 * 冻结后当只读模板用；`readPrefs` 的兜底会再展开一层，调用方改它不会污染默认值。
 */
export const DEFAULT_PREFS: PanelPrefs = Object.freeze({ sea: false, promptSection: null })

/**
 * 偏好文件路径：`<dataDir>/panel-prefs.json`。
 *
 * 参数 `dataDir`：插件数据根目录（与 memory 库同目录，备份/迁移时一起带走）。
 */
export function prefsPath(dataDir: string): string {
  return join(dataDir, 'panel-prefs.json')
}

/**
 * 把任意 JSON 值收敛成合法偏好（逐字段校验，不信任文件内容）。
 *
 * `sea` 只认严格的 `true`（'true' / 1 都算 false）；`promptSection` 只认布尔，其余一律 null。
 */
function coerce(raw: unknown): PanelPrefs {
  const source = (raw ?? {}) as Record<string, unknown>
  const promptSection =
    typeof source.promptSection === 'boolean' ? source.promptSection : null
  return { sea: source.sea === true, promptSection }
}

/**
 * 读偏好。文件不存在或坏了都退回默认值，绝不因为偏好把插件拖死。
 *
 * 参数 `dataDir`：数据根目录。返回：合法 `PanelPrefs`（每次都是新对象）。
 * 边界：JSON 语法错、字段类型错、目录不可读——全部走同一个 catch，静默退回默认。
 */
export function readPrefs(dataDir: string): PanelPrefs {
  try {
    const text = readFileSync(prefsPath(dataDir), 'utf8')
    return coerce(JSON.parse(text))
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

/**
 * 写偏好（只覆盖传进来的键）。
 *
 * 先写临时文件再 rename：中途崩了不会留下半个 json。
 *
 * 参数：`dataDir` 数据根；`patch` 要改的键（`undefined` = 不动，`null` 对 promptSection 是有效值）。
 * 返回：合并后的完整偏好。副作用：先 `readPrefs` 合并，所以不会把其他字段写丢。
 * 临时文件名带 `process.pid`：两个进程同时写也不会互相截断。
 */
export function writePrefs(dataDir: string, patch: Partial<PanelPrefs>): PanelPrefs {
  // 先读再改：没传的键保持原值，避免一次局部写把别的偏好抹成默认。
  const next: PanelPrefs = { ...readPrefs(dataDir) }
  if (typeof patch.sea === 'boolean') next.sea = patch.sea
  // promptSection 要先判 null：null 是有效值（=跟随配置），不能用 `typeof === 'boolean'` 一起处理。
  if (patch.promptSection === null) next.promptSection = null
  else if (typeof patch.promptSection === 'boolean') next.promptSection = patch.promptSection
  const file = prefsPath(dataDir)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
  return next
}
