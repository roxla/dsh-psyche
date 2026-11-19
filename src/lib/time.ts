// 时间显示：整个插件对外只用这几种格式
//   2026-11-01 20:12:33   （要精确到秒时）
//   2026-11-01            （只需要到天时）
//   20:12:33              （只给「今天几点」用）
// 库里一律存 ISO 字符串（带 Z），**显示层**才转本地时间——不要把 ISO 直接甩给人看。
// 纯函数、零 IO、不读时钟：同一个输入永远同一输出，所以可以直接单测。
// 被谁调用：tools.ts（工具结果里给人看的时间）、面板接口的时间字段。

/**
 * 补零到两位。
 *
 * 参数 `value`：0–99 的整数（小时/月/日等）；返回：`05` / `12` 这样的字符串。
 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * 把 Date / ISO 字符串 / 毫秒时间戳都收成 Date；认不出来返回 null。
 *
 * 参数 `value`：`Date`、数字（毫秒）、或可被 `Date` 解析的字符串（空串直接 null）。
 * 返回：有效 `Date` 或 null。边界：`Invalid Date`、`NaN`、`null`/对象等一律 null，
 * 绝不抛错——调用方都把它当「没有时间」处理。
 *
 * 坑：库里是 ISO（带 Z），`new Date(iso)` 会按 UTC 解析，再由下面的 getter 转成本地时区显示；
 * 无时区的字符串（如 `2026-11-01`）会被当成 UTC 午夜，跨时区时日期可能差一天。
 */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    const fromNumber = new Date(value)
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = new Date(trimmed)
    if (Number.isNaN(parsed.getTime())) return null
    return parsed
  }
  return null
}

/**
 * `2026-11-01 20:12:33`（本地时区）；空的或认不出来给 fallback。
 *
 * 参数：`value` 任意时间输入；`fallback` 认不出时的占位（默认「—」）。
 * 返回：定长 19 字符的字符串，方便表格对齐。
 */
export function formatDateTime(value: unknown, fallback = '—'): string {
  const date = toDate(value)
  if (!date) return fallback
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  )
}

/**
 * `2026-11-01`（本地时区）；空的或认不出来给 fallback。
 *
 * 参数：`value` 任意时间输入；`fallback` 认不出时的占位（默认「—」）。
 * 注意 `getMonth()` 从 0 开始，所以这里 +1。
 */
export function formatDate(value: unknown, fallback = '—'): string {
  const date = toDate(value)
  if (!date) return fallback
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * `20:12:33`；只给「今天几点」用。
 *
 * 参数：`value` 任意时间输入；`fallback` 认不出时的占位（默认「—」）。
 * 注意它只取本地时钟，不包含日期——跨天的事件用它会看不出是哪天。
 */
export function formatClock(value: unknown, fallback = '—'): string {
  const date = toDate(value)
  if (!date) return fallback
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}
