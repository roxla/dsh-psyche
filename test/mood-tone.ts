/**
 * P3-A B3-2：语气 Context 渲染与降级（同步、只读、两行受控文本）。
 *
 * 这里测的是宿主装配时会调用的纯渲染层与 Provider 收口；真实 SystemPrompt 服务的
 * 注册/卸载/两轮行为放在 B3-3 宿主验收（B5 之前）。
 */
import { defaultMoodValues } from '../packages/core/dist/mood-schema.js'
import {
  createMoodToneProvider,
  MOOD_TONE_CONTEXT_NAME,
  MOOD_TONE_ORDER,
  MOOD_TONE_SAFETY_LINE,
  NEUTRAL_MOOD_TONE_TEXT,
  renderMoodToneText,
} from '../dist/lib/mood-tone.js'

let passed = 0
let failed = 0
const failures: string[] = []

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(`${label}${detail === undefined ? '' : ` :: ${String(detail)}`}`)
}

function near(label: string, actual: number, expected: number): void {
  ok(label, Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)
}

const values = (patch: Record<string, number>): Record<string, number> => ({
  ...defaultMoodValues(),
  ...patch,
})

const lineCount = (text: string): number => text.split('\n').length
const hasNumber = (text: string): boolean => /[0-9]/.test(text)

// 1. 常量：唯一名与 Context 顺序，不能和记忆 Section 混用。
ok('context 名称固定', MOOD_TONE_CONTEXT_NAME === 'psyche-mood-tone')
ok('context 顺序固定', MOOD_TONE_ORDER === 100)

// 2. 只有主语气：两行，第一行不带辅助。
{
  const text = renderMoodToneText({
    tone: '轻快',
    secondary: null,
    neutral: false,
    projectionVersion: 1,
  })
  ok('单语气两行', lineCount(text) === 2, lineCount(text))
  ok('单语气首行', text.split('\n')[0] === '当前语气：轻快。', text.split('\n')[0])
  ok('单语气含安全行', text.split('\n')[1] === MOOD_TONE_SAFETY_LINE)
}

// 3. 主 + 辅助：一个辅助，不叠加。
{
  const text = renderMoodToneText({
    tone: '轻快',
    secondary: '好奇',
    neutral: false,
    projectionVersion: 1,
  })
  ok('主辅首行', text.split('\n')[0] === '当前语气：轻快，略带好奇。', text.split('\n')[0])
  ok('主辅仍两行', lineCount(text) === 2)
}

// 4. 中性文本：平稳 + 安全行。
{
  ok('中性首行', NEUTRAL_MOOD_TONE_TEXT.split('\n')[0] === '当前语气：平稳。', NEUTRAL_MOOD_TONE_TEXT)
  ok('中性两行', lineCount(NEUTRAL_MOOD_TONE_TEXT) === 2)
}

// 5. 安全边界必须包含全部承诺项。
for (const phrase of ['事实判断', '任务目标', '安全边界', '身份定义', '记忆写入权限', '主动联系', '真实的人类情感', '不诱导']) {
  ok(`安全行包含「${phrase}」`, MOOD_TONE_SAFETY_LINE.includes(phrase))
}

// 6. Provider：正常路径输出语气，且不泄漏内部值。
{
  const provider = createMoodToneProvider({ readValues: () => values({ happy: 45 }) })
  const text = provider()
  ok('provider 输出轻快', text.startsWith('当前语气：轻快'), text)
  ok('provider 输出两行', lineCount(text) === 2)
  ok('不泄漏维度 key', !/happy|baseline|strength|projectionVersion|dimension/i.test(text), text)
  ok('不泄漏数值', !hasNumber(text), text)
}

// 7. 主辅：happy 45 / curious 40 → 差约 0.048 < 0.10 且在白名单。
{
  const provider = createMoodToneProvider({ readValues: () => values({ happy: 45, curious: 40 }) })
  const text = provider()
  ok('主辅输出', text.split('\n')[0] === '当前语气：轻快，略带好奇。', text.split('\n')[0])
}

// 8. 未就绪 / 无状态：中性，不调用投影。
{
  const text = createMoodToneProvider({ readValues: () => null })()
  ok('null 走中性', text === NEUTRAL_MOOD_TONE_TEXT)
}

// 9. 读取异常：降级中性并上报一次。
{
  const seen: unknown[] = []
  const boom = new Error('db closed')
  const text = createMoodToneProvider({
    readValues: () => {
      throw boom
    },
    onError: (error) => seen.push(error),
  })()
  ok('读取异常走中性', text === NEUTRAL_MOOD_TONE_TEXT)
  ok('读取异常上报一次', seen.length === 1 && seen[0] === boom)
}

// 10. 投影异常（缺维）：降级中性并上报。
{
  const seen: unknown[] = []
  const partial = values({})
  delete partial.calm
  const text = createMoodToneProvider({
    readValues: () => partial,
    onError: (error) => seen.push(error),
  })()
  ok('缺维走中性', text === NEUTRAL_MOOD_TONE_TEXT)
  ok('缺维上报一次', seen.length === 1)
}

// 11. 投影异常（NaN / 越界）：同样收口。
{
  for (const bad of [Number.NaN, 101, -1]) {
    const seen: unknown[] = []
    const text = createMoodToneProvider({
      readValues: () => values({ happy: bad }),
      onError: (error) => seen.push(error),
    })()
    ok(`非法值 ${String(bad)} 走中性`, text === NEUTRAL_MOOD_TONE_TEXT)
    ok(`非法值 ${String(bad)} 上报`, seen.length === 1)
  }
}

// 12. 确定性：同输入同输出；provider 可重复调用。
{
  const provider = createMoodToneProvider({ readValues: () => values({ happy: 45 }) })
  ok('重复调用一致', provider() === provider())
}

// 13. Context 注册不会与记忆 Section 同名。
ok('不与记忆段同名', MOOD_TONE_CONTEXT_NAME !== 'psyche-memory')

console.log(`[P3-A B3 mood-tone] ${passed} 通过 ${failed} 失败`)
if (failed > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
