// Q1：默认模型目录与保存前校验。
//
// 只验证目录适配层自己的契约（列出 / 查档位 / 三步校验 / 深度校验 / 宿主缺服务），
// 不证明控制中心路由已接线，也不证明 effort 真的进了模型请求——后者需要
// 「记录型测试适配器 + 隔离 profile」的证据，属下一批（外部评审第 22 轮明确要求）。
import assert from 'node:assert/strict'
import {
  createQqModelCatalog,
  type QqModelCatalog,
} from '../dist/lib/qq-model-catalog.js'

let passed = 0
const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

/** 造一个够用的假宿主：两个提供方、三个模型、只有 m1 有档位。 */
function fakeLlm(options: { withResolveCallConfig?: boolean; rejectedByCallConfig?: string[] } = {}) {
  const providers = [
    { id: 'p1', name: '提供方一' },
    { id: 'p2', name: '提供方二' },
  ]
  const models: Record<string, Array<{ provider: string; id: string; name: string }>> = {
    p1: [
      { provider: 'p1', id: 'm1', name: '模型一' },
      { provider: 'p1', id: 'm2', name: '模型二' },
    ],
    p2: [{ provider: 'p2', id: 'x1', name: '模型甲' }],
  }
  const efforts: Record<string, { id: string; name: string }[]> = {
    m1: [
      { id: 'low', name: '低' },
      { id: 'high', name: '高' },
    ],
  }
  const calls: unknown[] = []
  const llm: Record<string, unknown> = {
    listProviders: async () => providers,
    listModels: async (provider: string) => models[provider] ?? [],
    resolveModelInfo: async (provider: string, model: string) => {
      const listed = (models[provider] ?? []).find((item) => item.id === model)
      if (listed === undefined) throw new Error(`没有这个模型：${model}`)
      const offered = efforts[model]
      if (offered === undefined) return { ...listed }
      return { ...listed, reasoning: { efforts: offered, defaultEffort: offered[0].id } }
    },
  }
  if (options.withResolveCallConfig === true) {
    llm.resolveCallConfig = async (config: { model: string; reasoningEffort?: string }) => {
      calls.push(config)
      if ((options.rejectedByCallConfig ?? []).includes(config.model)) {
        // 模拟「目录里报了档位、adapter 其实不支持」：这正是必须再走一道
        // 宿主校验的理由，只信目录会保存一个发不出去的组合。
        throw new Error(`unsupported explicit effort for ${config.model}`)
      }
      if (config.reasoningEffort === undefined) return config
      const offered = efforts[config.model] ?? []
      if (!offered.some((item) => item.id === config.reasoningEffort)) {
        throw new Error(`unsupported reasoning effort: ${config.reasoningEffort}`)
      }
      return config
    }
  }
  return { llm, calls }
}

function catalogOf(llm: unknown): QqModelCatalog {
  return createQqModelCatalog(() => llm as never)
}

const { llm } = fakeLlm()

await test('目录能列出全部提供方与模型', async () => {
  const view = await catalogOf(llm).view()
  assert.equal(view.available, true)
  assert.deepEqual(
    view.providers.map((item) => item.id),
    ['p1', 'p2'],
  )
  assert.deepEqual(
    view.models.map((item) => `${item.provider}/${item.id}`),
    ['p1/m1', 'p1/m2', 'p2/x1'],
  )
})

await test('有档位的模型能查到档位与默认档', async () => {
  const view = await catalogOf(llm).efforts('p1', 'm1')
  assert.equal(view.available, true)
  assert.equal(view.notOffered, false)
  assert.deepEqual(
    view.efforts.map((item) => item.id),
    ['low', 'high'],
  )
  assert.equal(view.defaultEffort, 'low')
})

await test('没有档位的模型标 notOffered 而不是报错', async () => {
  const view = await catalogOf(llm).efforts('p1', 'm2')
  assert.equal(view.available, true)
  assert.equal(view.notOffered, true)
  assert.deepEqual(view.efforts, [])
})

await test('校验通过：提供方、模型、档位都在目录里', async () => {
  assert.equal(await catalogOf(llm).validate({ provider: 'p1', model: 'm1', reasoningEffort: 'high' }), null)
})

await test('校验拒绝：提供方不存在', async () => {
  const problem = await catalogOf(llm).validate({ provider: 'nope', model: 'm1' })
  assert.match(String(problem), /没有这个提供方/)
})

await test('校验拒绝：模型不在该提供方下', async () => {
  const problem = await catalogOf(llm).validate({ provider: 'p2', model: 'm1' })
  assert.match(String(problem), /没有该模型/)
})

await test('校验拒绝：无档位模型指定档位', async () => {
  const problem = await catalogOf(llm).validate({ provider: 'p1', model: 'm2', reasoningEffort: 'high' })
  assert.match(String(problem), /没有可选的推理档位/)
})

await test('校验拒绝：档位不在该模型的可选集里', async () => {
  const problem = await catalogOf(llm).validate({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
  assert.match(String(problem), /不支持档位 max/)
})

await test('深度校验用宿主的 resolveCallConfig 兜住目录误报的档位', async () => {
  const deep = fakeLlm({ withResolveCallConfig: true, rejectedByCallConfig: ['m1'] })
  const catalog = catalogOf(deep.llm)
  // m1 在目录里报了 low/high，前三步会放行；真正拦住它的是宿主那一层。
  const problem = await catalog.validate({ provider: 'p1', model: 'm1', reasoningEffort: 'high' })
  assert.match(String(problem), /unsupported explicit effort/)
  assert.equal(deep.calls.length, 1)
})

await test('宿主没有 llm 服务时目录标 unavailable，不抛', async () => {
  const view = await createQqModelCatalog(() => null).view()
  assert.equal(view.available, false)
  assert.ok(String(view.error).length > 0)
})

console.log(`\n${passed} 通过 0 失败`)
