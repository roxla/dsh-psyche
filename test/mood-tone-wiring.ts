/**
 * P3-A B3-2：语气 Context 的注册/注销/开关/动态读取（模块级，不启动宿主）。
 *
 * 真实的 SystemPrompt 服务装配与两轮行为留在 B3-3 宿主专项验收；这里用最小替身
 * 验证接线契约：唯一名、独立 disposer、每次装配读最新值、关闭不注册、重载可恢复。
 */
import { defaultMoodValues } from '../packages/core/dist/mood-schema.js'
import {
  MOOD_TONE_CONTEXT_NAME,
  MOOD_TONE_ORDER,
  NEUTRAL_MOOD_TONE_TEXT,
  registerMoodToneContext,
  type MoodTonePromptApi,
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

const values = (patch: Record<string, number>): Record<string, number> => ({
  ...defaultMoodValues(),
  ...patch,
})

/** 最小 SystemPrompt 替身：只实现 context()，并记录每次注册。 */
class FakePromptApi implements MoodTonePromptApi {
  readonly entries = new Map<string, { name: string; order: number; text: () => string }>()
  readonly calls: string[] = []
  private seq = 0

  context(options: { name: string; order: number; text: () => string }): () => void {
    this.calls.push(options.name)
    if (this.entries.has(options.name)) throw new Error(`duplicate context: ${options.name}`)
    const token = ++this.seq
    this.entries.set(options.name, options)
    let active = true
    return () => {
      if (!active) return
      active = false
      const current = this.entries.get(options.name)
      if (current === options) this.entries.delete(options.name)
      void token
    }
  }

  render(): string {
    const list = [...this.entries.values()].sort((a, b) => a.order - b.order)
    return list.map((entry) => entry.text()).join('\n')
  }
}

// 1. 开启时注册唯一 Context，名字与顺序固定。
{
  const api = new FakePromptApi()
  const registration = registerMoodToneContext({
    api,
    enabled: true,
    readValues: () => values({ happy: 45 }),
  })
  ok('enabled 时返回 registration', registration !== null)
  ok('只注册一次', api.calls.length === 1)
  ok('注册名固定', api.calls[0] === MOOD_TONE_CONTEXT_NAME)
  const entry = api.entries.get(MOOD_TONE_CONTEXT_NAME)
  ok('顺序固定', entry?.order === MOOD_TONE_ORDER)
  ok('text 是同步函数', typeof entry?.text === 'function')
  ok('渲染轻快', api.render().startsWith('当前语气：轻快。'), api.render())
  ok('渲染两行', api.render().split('\n').length === 2)
}

// 2. 每次装配动态读取：不重新注册也能反映最新值。
{
  const api = new FakePromptApi()
  let current: Record<string, number> = defaultMoodValues()
  let reads = 0
  registerMoodToneContext({
    api,
    enabled: true,
    readValues: () => {
      reads += 1
      return current
    },
  })
  ok('baseline 中性', api.render() === NEUTRAL_MOOD_TONE_TEXT)
  current = values({ happy: 45 })
  const after = api.render()
  ok('更新后轻快', after.startsWith('当前语气：轻快。'), after)
  ok('仍是同一次注册', api.calls.length === 1)
  ok('每次装配读一次', reads === 2, reads)
}

// 3. 关闭时不注册，调用方拿到 null。
{
  const api = new FakePromptApi()
  const registration = registerMoodToneContext({
    api,
    enabled: false,
    readValues: () => values({ happy: 45 }),
  })
  ok('disabled 返回 null', registration === null)
  ok('disabled 不注册', api.entries.size === 0)
  ok('disabled 不调用 api', api.calls.length === 0)
}

// 4. dispose 注销；服务重载后可重新注册（同名不冲突）。
{
  const api = new FakePromptApi()
  const first = registerMoodToneContext({
    api,
    enabled: true,
    readValues: () => values({ happy: 45 }),
  })
  ok('注销前存在', api.entries.size === 1)
  first?.dispose()
  ok('注销后移除', api.entries.size === 0)
  const second = registerMoodToneContext({
    api,
    enabled: true,
    readValues: () => values({ curious: 40 }),
  })
  ok('重载后可再注册', api.entries.size === 1 && second !== null)
  ok('重载后内容正确', api.render().startsWith('当前语气：好奇'), api.render())
  second?.dispose()
  ok('二次销毁后为空', api.entries.size === 0)
}

// 5. 读取失败：降级中性，不抛出、仍保持注册。
{
  const api = new FakePromptApi()
  const seen: unknown[] = []
  const registration = registerMoodToneContext({
    api,
    enabled: true,
    readValues: () => {
      throw new Error('db closed')
    },
    onError: (error) => seen.push(error),
  })
  ok('异常仍注册', registration !== null && api.entries.size === 1)
  ok('异常文本中性', api.render() === NEUTRAL_MOOD_TONE_TEXT)
  ok('异常上报一次', seen.length === 1)
  ok('可重复渲染不抛', api.render() === NEUTRAL_MOOD_TONE_TEXT)
}

// 6. 只碰 context，不碰 Section：替身没有 section 调用记录。
{
  const api = new FakePromptApi()
  registerMoodToneContext({ api, enabled: true, readValues: () => values({ happy: 45 }) })
  ok('只注册 context', api.calls.every((name) => name === MOOD_TONE_CONTEXT_NAME))
  ok('未触碰 psyche-memory', !api.calls.includes('psyche-memory'))
}

// 7. 输出不泄漏内部值与维度名。
{
  const api = new FakePromptApi()
  registerMoodToneContext({
    api,
    enabled: true,
    readValues: () => values({ happy: 45, curious: 40 }),
  })
  const text = api.render()
  ok('输出只有两行', text.split('\n').length === 2)
  ok('不含维度 key', !/happy|curious|baseline|strength|dimension/i.test(text), text)
  ok('不含数值', !/[0-9]/.test(text), text)
}

console.log(`[P3-A B3 mood-tone-wiring] ${passed} 通过 ${failed} 失败`)
if (failed > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
