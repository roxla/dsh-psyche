import {
  PROJECTION_CONTEXT_NAME,
  PROJECTION_CONTEXT_ORDER,
  ProjectionController,
  readPersistedGrowthLine,
} from '../dist/lib/projection-context.js'

let passed = 0
let failed = 0
function ok(label: string, condition: boolean): void {
  if (condition) {
    passed += 1
    console.log(`  ok ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}`)
  }
}
function eq<T>(label: string, actual: T, expected: T): void {
  ok(`${label} (expected ${String(expected)}, got ${String(actual)})`, actual === expected)
}

interface Registration {
  name: string
  order?: number
  text: (assembly?: { agent?: { id?: string } }) => string
  disposed: number
}

function fakeApi(options: { fail?: boolean } = {}) {
  const registrations: Registration[] = []
  return {
    registrations,
    context(input: { name: string; order?: number; text: Registration['text'] }): () => void {
      if (options.fail) throw new Error('register failed')
      const entry: Registration = { ...input, disposed: 0 }
      registrations.push(entry)
      return () => {
        entry.disposed += 1
      }
    },
  }
}

const sources = {
  discipline: () => 'DISCIPLINE',
  persona: () => 'PERSONA',
  growth: () => 'GROWTH',
  mood: () => 'MOOD',
  relationship: () => 'RELATION',
}

// A. 注册与顺序
{
  const api = fakeApi()
  const controller = new ProjectionController({ api, sources })
  eq('A1 start returns true', controller.start(), true)
  eq('A2 one registration', api.registrations.length, 1)
  eq('A3 name', api.registrations[0]?.name, PROJECTION_CONTEXT_NAME)
  eq('A4 order', api.registrations[0]?.order, PROJECTION_CONTEXT_ORDER)
  const text = api.registrations[0]!.text()
  ok('A5 serialization order', text.indexOf('DISCIPLINE') < text.indexOf('PERSONA') && text.indexOf('PERSONA') < text.indexOf('GROWTH') && text.indexOf('GROWTH') < text.indexOf('MOOD') && text.indexOf('MOOD') < text.indexOf('RELATION'))
  eq('A6 repeat start does not double register', controller.start() && api.registrations.length === 1, true)
}

// A1. P6-1 意愿段：提供时追加在最后；返回空串时整块省略
{
  const api = fakeApi()
  const controller = new ProjectionController({ api, sources: { ...sources, intention: () => 'INTENT' } })
  controller.start()
  const text = api.registrations[0]!.text()
  ok('A1a intention appended last', text.trim().endsWith('INTENT'))

  const emptyApi = fakeApi()
  const empty = new ProjectionController({ api: emptyApi, sources: { ...sources, intention: () => '' } })
  empty.start()
  ok('A1b empty intention omitted', !emptyApi.registrations[0]!.text().includes('INTENT'))
}

// B. 预算：人格超预算整块省略，纪律保留
{
  const api = fakeApi()
  const controller = new ProjectionController({
    api,
    sources: { ...sources, persona: () => 'P'.repeat(9000) },
  })
  controller.start()
  const text = api.registrations[0]!.text()
  ok('B1 discipline kept', text.includes('DISCIPLINE'))
  ok('B2 over-budget persona omitted', !text.includes('PPPPPPPP'))
  ok('B3 optional blocks still kept', text.includes('GROWTH') && text.includes('MOOD') && text.includes('RELATION'))
}

// C. 失败与降级
{
  const api = fakeApi({ fail: true })
  const controller = new ProjectionController({ api, sources })
  eq('C1 start false on register error', controller.start(), false)
  eq('C2 not started', controller.started, false)
  eq('C3 dispose safe', (() => { controller.dispose(); return controller.disposed })(), true)
}

// D. 生命周期：dispose 后空串、单次 dispose
{
  const api = fakeApi()
  const controller = new ProjectionController({ api, sources })
  controller.start()
  controller.dispose()
  eq('D1 callback empty after dispose', api.registrations[0]!.text(), '')
  eq('D2 dispose called once', api.registrations[0]!.disposed, 1)
  controller.dispose()
  eq('D3 dispose idempotent', api.registrations[0]!.disposed, 1)
}

// E. 成长只读持久化阶段
{
  const labels = { trust: '信任', autonomy: '自主' }
  eq('E1 no db', readPersistedGrowthLine(null, labels), '')
  eq('E2 missing row', readPersistedGrowthLine({ get: () => undefined }, labels), '')
  eq('E3 unknown phase', readPersistedGrowthLine({ get: () => ({ phase: 'unknown' }) as unknown as { phase: string } }, labels), '')
  const line = readPersistedGrowthLine({ get: () => ({ phase: 'autonomy' }) as unknown as { phase: string } }, labels)
  ok('E4 persisted stage line', line.startsWith('成长阶段：自主') && line.length <= 120)
  eq('E5 db throws', readPersistedGrowthLine({ get: () => { throw new Error('boom') } }, labels), '')
}

// F. P7-2 统一预算：dominance 预留后由回调收窄
{
  const api = fakeApi()
  const seen: Array<{ agent?: { id?: string } } | undefined> = []
  const controller = new ProjectionController({
    api,
    sources: { ...sources, persona: () => 'P'.repeat(120) },
    budget: (assembly) => {
      seen.push(assembly as { agent?: { id?: string } } | undefined)
      return { maxTokens: 6000, maxChars: 40 }
    },
  })
  controller.start()
  const text = api.registrations[0]!.text({ agent: { id: 'budget-agent' } })
  ok('F1 budget callback receives assembly', seen.length === 1 && seen[0]?.agent?.id === 'budget-agent')
  ok('F2 discipline kept under narrowed budget', text.includes('DISCIPLINE'))
  ok('F3 persona omitted by narrowed budget', !text.includes('PPPPPPPP'))
}

console.log(`\n[P5-2b projection-context] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
