// SEA-V2-1：意识海状态 HUD 的 DTO → 视图映射。
//
// 不启动浏览器：用 __ModuleLoader__ 桩捕获客户端模块，直接调用它的只读探针
// `__seaHud`。这样测的是实际 bundle 里的映射，而不是另抄一份纯函数。
import { existsSync } from 'node:fs'

const tag = 'sea-state'
let passed = 0
let failed = 0

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1
    console.log(`  PASS ${label}`)
    return
  }
  failed += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : `：${JSON.stringify(detail)}`}`)
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

if (!existsSync('dist/client/index.js')) {
  console.error(`[${tag}] 先跑 npm run build`)
  process.exit(1)
}

const loaderKey = '__ModuleLoader__'
const host = globalThis as any
let spec: any = null
host[loaderKey] = {
  load(input: any) {
    spec = input
  },
}

await import(`../dist/client/index.js?${tag}=${Date.now()}`)
ok('客户端模块通过宿主 loader 注册', Boolean(spec) && spec.id === 'dsh-psyche')
if (!spec) process.exit(1)

const reactStub = {
  createElement: () => null,
  useState: (value: any) => [value, () => undefined],
  useEffect: () => undefined,
  useRef: (value: any) => ({ current: value }),
  useMemo: (fn: () => any) => fn(),
  Fragment: 'fragment',
  // 客户端 bundle 里还有 PageBoundary 等 error boundary 类组件；不渲染，只求能加载模块。
  Component: class {
    props: any
    state: any
    constructor(props: any) {
      this.props = props
      this.state = {}
    }
    setState() {}
    render() {
      return null
    }
  },
  PureComponent: class {
    props: any
    constructor(props: any) {
      this.props = props
    }
    render() {
      return null
    }
  },
}
const plugin = spec.factory((id: string) => {
  if (id === 'react') return reactStub
  throw new Error(`unexpected require: ${id}`)
})
const build = plugin && plugin.__seaHud
ok('客户端暴露只读 __seaHud 探针', typeof build === 'function')
if (typeof build !== 'function') process.exit(1)

const mood = {
  ok: true,
  groups: {
    basic: [
      { key: 'calm', label: '平静', value: 62, baseline: 50 },
      { key: 'happy', label: '开心', value: 40, baseline: 50 },
    ],
    compound: [{ key: 'curious', label: '好奇', value: 75, baseline: 50 }],
    contemporary: [],
  },
}
const panel = {
  ok: true,
  contacts: [
    { contactId: 'ct_1', displayName: '小满', bandLabel: '亲近' },
    { contactId: 'ct_2', displayName: '  ', bandLabel: null },
  ],
  growth: { stage: 'trust', stageLabel: '信任' },
  intention: { text: '想把上次没写完的整理完。' },
}

const full = build({ mood, panel })
eq('八维只映射已知维度、缺的补空', full.mood.length, 3)
eq('Mood delta 相对自身基线', full.mood[1].delta, -10)
eq('关系按 Contact 分行', full.relations.length, 2)
eq('无 displayName 用中性占位', full.relations[1].displayName, '未命名联系人')
eq('无档位不猜中立', full.relations[1].bandLabel, '')
eq('成长展示有效阶段', full.growth.stageLabel, '信任')
eq('意愿展示可披露文本', full.intention.text, '想把上次没写完的整理完。')

const empty = build({ mood: { ok: false }, panel: { ok: true } })
eq('Mood 失败时整块隐藏', empty.mood, null)
eq('无关系/成长/意愿时全部隐藏', [empty.relations, empty.growth, empty.intention], [null, null, null])

const partial = build({ mood: null, panel: { ok: true, contacts: [] } })
eq('空输入不伪造占位', [partial.mood, partial.relations, partial.growth, partial.intention], [null, null, null, null])

console.log(`[${tag}] ${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1
