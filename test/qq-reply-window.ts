/**
 * 第二批：允许回复时段的运行时判定（`dist/lib/qq-reply-window.js`）。
 *
 * 只验纯函数：规则缺省、暂停、同日/跨夜边界、多段、夏令时两个方向、非法时区。
 * 发送路径上的两个检查点由 `test/qq-reply-window-gate.ts` 负责。
 */
import { inReplyWindow, localClockAt } from '../dist/lib/qq-reply-window.js'

let passed = 0
let failed = 0

function ok(name: string, condition: boolean): void {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  console.error(`FAIL ${name}`)
}

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (!same) console.error(`  实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`)
  ok(name, same)
}

const SH = 'Asia/Shanghai'

/** 规格第 4 节给的固定时钟：周五 22:00 到次日 02:00。 */
const FRIDAY_NIGHT = {
  mode: 'windows' as const,
  timeZone: SH,
  windows: [{ days: [5], startMinute: 1320, endMinute: 120 }],
}

// A. 缺省 = 继承 = 允许
ok('A1 没有规则时允许', inReplyWindow(undefined, new Date('2026-11-23T00:00:00Z')))
ok('A2 暂停时不回复', !inReplyWindow({ mode: 'paused' }, new Date('2026-11-23T00:00:00Z')))

// B. 规格固定时钟四条
ok('B1 周五 21:59 北京时间在时段外', !inReplyWindow(FRIDAY_NIGHT, new Date('2026-11-27T13:59:00Z')))
ok('B2 周五 22:00 进入时段', inReplyWindow(FRIDAY_NIGHT, new Date('2026-11-27T14:00:00Z')))
ok('B3 周六 01:59 仍属周五这段', inReplyWindow(FRIDAY_NIGHT, new Date('2026-11-27T17:59:00Z')))
ok('B4 周六 02:00 已出时段', !inReplyWindow(FRIDAY_NIGHT, new Date('2026-11-27T18:00:00Z')))

// C. 同日时段的左闭右开
const MONDAY_MORNING = {
  mode: 'windows' as const,
  timeZone: SH,
  windows: [{ days: [1], startMinute: 540, endMinute: 720 }],
}
ok('C1 周一 08:59 在外', !inReplyWindow(MONDAY_MORNING, new Date('2026-11-23T00:59:00Z')))
ok('C2 周一 09:00 命中', inReplyWindow(MONDAY_MORNING, new Date('2026-11-23T01:00:00Z')))
ok('C3 周一 11:59 命中', inReplyWindow(MONDAY_MORNING, new Date('2026-11-23T03:59:00Z')))
ok('C4 周一 12:00 已出', !inReplyWindow(MONDAY_MORNING, new Date('2026-11-23T04:00:00Z')))
ok('C5 周二同一时刻不命中', !inReplyWindow(MONDAY_MORNING, new Date('2026-11-24T01:00:00Z')))

// D. 多段：任一段命中即通过
const TWO_SPANS = {
  mode: 'windows' as const,
  timeZone: SH,
  windows: [
    { days: [1], startMinute: 540, endMinute: 600 },
    { days: [1], startMinute: 1200, endMinute: 1260 },
  ],
}
ok('D1 第一段内命中', inReplyWindow(TWO_SPANS, new Date('2026-11-23T01:30:00Z')))
ok('D2 第二段内命中', inReplyWindow(TWO_SPANS, new Date('2026-11-23T12:30:00Z')))
ok('D3 两段之间不命中', !inReplyWindow(TWO_SPANS, new Date('2026-11-23T08:00:00Z')))

// E. 跨夜只按「开始那天」归属：周六 01:30 属于周五那段，周日 01:30 不属于
ok('E1 周六 01:30 接在周五段之后', inReplyWindow(FRIDAY_NIGHT, new Date('2026-11-27T17:30:00Z')))
ok('E2 周日 01:30 不接', !inReplyWindow(FRIDAY_NIGHT, new Date('2026-11-28T17:30:00Z')))

// F. 起止相同视为空段
ok(
  'F1 起止相同不命中',
  !inReplyWindow({ mode: 'windows', timeZone: SH, windows: [{ days: [1], startMinute: 600, endMinute: 600 }] }, new Date('2026-11-23T02:00:00Z')),
)

// G. 夏令时前跳：当地 02:00–03:00 那天根本没有对应时刻，任何瞬时都读不到它
const NY_GAP = {
  mode: 'windows' as const,
  timeZone: 'America/New_York',
  windows: [{ days: [7], startMinute: 120, endMinute: 180 }],
}
ok('G1 前跳前的 01:30 不在 02–03 段', !inReplyWindow(NY_GAP, new Date('2024-03-10T06:30:00Z')))
ok('G2 前跳后的 03:30 不在 02–03 段', !inReplyWindow(NY_GAP, new Date('2024-03-10T07:30:00Z')))

// H. 夏令时回拨：同一钟面 01:30 出现两次，两次都命中
const NY_OVERLAP = {
  mode: 'windows' as const,
  timeZone: 'America/New_York',
  windows: [{ days: [7], startMinute: 60, endMinute: 120 }],
}
ok('H1 回拨第一次 01:30 命中', inReplyWindow(NY_OVERLAP, new Date('2024-11-03T05:30:00Z')))
ok('H2 回拨第二次 01:30 也命中', inReplyWindow(NY_OVERLAP, new Date('2024-11-03T06:30:00Z')))

// I. 读钟面本身
eq('I1 上海 22:00 读成周五 1320 分', localClockAt(SH, new Date('2026-11-27T14:00:00Z')), { day: 5, minute: 1320 })
eq('I2 上海周六 01:59 读成周六 119 分', localClockAt(SH, new Date('2026-11-27T17:59:00Z')), { day: 6, minute: 119 })

// J. 非法时区必须抛错，调用方据此 fail-closed，而不是当允许
let threw = false
try {
  localClockAt('Mars/Olympus', new Date('2026-11-23T00:00:00Z'))
} catch (error) {
  threw = error instanceof RangeError || error instanceof Error
}
ok('J1 非法时区抛错', threw)

console.log(`${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
