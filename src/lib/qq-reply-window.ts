/**
 * 第二批：目标级允许回复时段（replySchedules）的运行时判定。
 *
 * 这里只有一个问题：某个时刻是否落在该对象允许回复的时段里。
 * 判定完全由「读这个时刻的当地钟面」得出，不做「当地钟面 → 时刻」的反推——
 * 这样夏令时跳过的那一小时根本不会出现在判定里，回拨重复的那一小时
 * 两次都读到同一个钟面，规格要求的语义自然成立（见 docs/audit/前置证据-qq-reply-schedules.md）。
 *
 * 边界：
 * - 没有规则（继承宿主原有行为）→ 允许；
 * - `paused` → 不允许；
 * - 每段左闭右开；跨夜段按「开始那天」归属，不按结束那天；
 * - 起止相同视为空段（不会命中），保存侧的校验也会拒绝它。
 */

export interface QqReplyWindowRule {
  /** ISO 星期：1=周一 … 7=周日。 */
  days: number[]
  /** 当地分钟数，0–1439。 */
  startMinute: number
  /** 当地分钟数，0–1439；小于 startMinute 表示跨夜到次日。 */
  endMinute: number
}

export type QqReplyRule =
  | { mode: 'paused' }
  | { mode: 'windows'; timeZone: string; windows: QqReplyWindowRule[] }

/** `Intl` 的 weekday 短名，顺序固定，据此换算成 ISO 星期。 */
const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

export interface LocalClock {
  /** ISO 星期 1–7。 */
  day: number
  /** 当地分钟数 0–1439。 */
  minute: number
}

/** 缓存 formatter：`Intl.DateTimeFormat` 构造比 format 贵得多。 */
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone)
  if (cached !== undefined) return cached
  const created = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  formatterCache.set(timeZone, created)
  return created
}

/**
 * 读某个时刻在指定时区的当地星期与分钟。
 *
 * 时区非法时 `new Intl.DateTimeFormat` 会抛 `RangeError`；调用方应把这种情况
 * 当成「无法判定」而不是「允许」（保存侧已经拦过非法时区，运行期只在配置被手改时才可能遇到）。
 */
export function localClockAt(timeZone: string, at: Date): LocalClock {
  const parts = formatterFor(timeZone).formatToParts(at)
  let day = 0
  let hour = 0
  let minute = 0
  for (const part of parts) {
    if (part.type === 'weekday') {
      const index = WEEKDAY_NAMES.indexOf(part.value.slice(0, 3) as (typeof WEEKDAY_NAMES)[number])
      if (index < 0) throw new RangeError(`无法识别的星期名：${part.value}`)
      day = index + 1
    } else if (part.type === 'hour') {
      hour = Number.parseInt(part.value, 10)
    } else if (part.type === 'minute') {
      minute = Number.parseInt(part.value, 10)
    }
  }
  if (day === 0 || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new RangeError('时区格式里缺少星期或时间')
  }
  // h23 在部分运行时对午夜给 "24"：归一到 0。
  const normalized = hour === 24 ? 0 : hour
  return { day, minute: normalized * 60 + minute }
}

/**
 * 该时刻是否落在允许回复的时段内。
 *
 * @param rule `undefined` 表示继承（允许）；`paused` 表示暂停（不允许）。
 * @param at 判定用的时刻，默认取当前时间。
 * @param clock 仅供测试替换时钟读取；生产调用不要传。
 */
export function inReplyWindow(
  rule: QqReplyRule | undefined,
  at: Date = new Date(),
  clock: (timeZone: string, at: Date) => LocalClock = localClockAt,
): boolean {
  if (rule === undefined) return true
  if (rule.mode === 'paused') return false
  const { day, minute } = clock(rule.timeZone, at)
  const previousDay = day === 1 ? 7 : day - 1
  for (const window of rule.windows) {
    if (window.startMinute < window.endMinute) {
      // 同日窗口
      if (window.days.indexOf(day) >= 0 && minute >= window.startMinute && minute < window.endMinute) {
        return true
      }
      continue
    }
    if (window.startMinute === window.endMinute) continue
    // 跨夜：开始那天从 start 到 24:00，结束那天从 00:00 到 end。
    if (window.days.indexOf(day) >= 0 && minute >= window.startMinute) return true
    if (window.days.indexOf(previousDay) >= 0 && minute < window.endMinute) return true
  }
  return false
}

/**
 * 下一个允许回复的时刻。
 *
 * 第 56 轮 P1-B：提醒撞上安静时段时不能判死，得算清楚「最早什么时候能发」。
 * 与 `inReplyWindow` 共用同一套星期归属与左闭右开判断，只是把「现在行不行」
 * 换成「什么时候行」——两处口径必须一致，否则会出现「窗口算作开、发送仍被拦」。
 *
 * @param rule `undefined` 表示继承（放行），直接返回 `at`。
 * @param at 起算时刻，默认取当前时间。
 * @param clock 仅供测试替换时钟读取；生产调用不要传。
 * @returns 可发时刻；`paused` 或八天内都没有窗口时返回 `null`（调用方显示「暂无」）。
 */
export function nextAllowedReplyAt(
  rule: QqReplyRule | undefined,
  at: Date = new Date(),
  clock: (timeZone: string, at: Date) => LocalClock = localClockAt,
): Date | null {
  if (rule === undefined) return at
  if (rule.mode === 'paused') return null
  if (inReplyWindow(rule, at, clock)) return at
  // 按分钟推进：窗口边界就是分钟粒度，逐分钟试与解析式计算等价，且不必处理
  // 夏令时跳变（直接问「这一分钟在不在窗内」）。上限八天覆盖最长的周循环。
  const horizon = at.getTime() + 8 * 24 * 60 * 60 * 1000
  let probe = Math.floor(at.getTime() / 60_000) * 60_000 + 60_000
  while (probe <= horizon) {
    const candidate = new Date(probe)
    if (inReplyWindow(rule, candidate, clock)) return candidate
    probe += 60_000
  }
  return null
}
