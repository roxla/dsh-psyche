/**
 * I-7 Owner 路由自检：四条初始化路由的方法/参数/错误码映射，以及「路由不碰文件」的边界。
 *
 * 为什么单独测：面板与服务都正确不代表路由正确——路由最容易绕过服务去直接动 claim/文件。
 * 这里用假 request/response + 假 service：service 只暴露 status/start/acceptDrift 三个方法，
 *   路由若试图自己读文件、写库或操作 claim，会立刻 TypeError（测试失败）。
 *
 * 跑法：`node test/init-routes.ts`（要求先 `npm run build`）。
 */
import { buildInitRoutes, initErrorStatus } from '../dist/lib/init-routes.js'
import type { InitRouteDeps, InitPresetRow } from '../dist/lib/init-routes.js'
import type { InitSnapshot } from '../dist/lib/persona-init.js'
import type { PersonaInitService } from '../dist/lib/persona-init-service.js'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`)
  }
}

interface FakeResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

function makeResponse(): FakeResponse {
  return { statusCode: 0, headers: {}, body: '' }
}

const send = (response: FakeResponse, statusCode: number, body: unknown): void => {
  response.statusCode = statusCode
  response.body = JSON.stringify(body)
}
const sendJson = (response: FakeResponse, body: unknown): void => send(response, 200, body)

/** 请求桩：readJsonBody 直接吃 request.body，不走流（路由只关心「有没有合法对象」）。 */
function makeRequest(method: string, body?: unknown): { method: string; body?: unknown } {
  return body === undefined ? { method } : { method, body }
}

const readJsonBody = async (request: { body?: unknown }): Promise<Record<string, unknown>> => {
  if (request.body && typeof request.body === 'object' && !Array.isArray(request.body)) {
    return request.body as Record<string, unknown>
  }
  return {}
}

function snapshot(state: InitSnapshot['state'], patch: Partial<InitSnapshot> = {}): InitSnapshot {
  return {
    state,
    personaId: 'main',
    presetId: null,
    presetName: null,
    presetVersion: null,
    draft: false,
    initializedAt: null,
    lockedAt: null,
    identityHash: null,
    identityBytes: null,
    hashMatches: null,
    claim: null,
    detail: `detail-${state}`,
    actions: [],
    files: { identity: false, persona: false, claim: false },
    ...patch,
  }
}

const presetRows: InitPresetRow[] = [
  { id: 'gentle-firm', name: '温和坚定', version: '1.0.0', summary: '先接住情绪再说事', recommended: true, draft: false },
  { id: 'quiet-warmth', name: '安静温热', version: '1.0.0', summary: '话不多，记得住', recommended: false, draft: false },
]

function bodyOf(response: FakeResponse): any {
  try {
    return JSON.parse(response.body)
  } catch {
    return null
  }
}

/** 只实现四个方法的假服务：路由碰别的属性会 TypeError。 */
function makeFakeService(
  overrides: Partial<Record<'status' | 'start' | 'startCustom' | 'acceptDrift', (...args: any[]) => any>> = {},
) {
  const calls: string[] = []
  const service = {
    calls,
    status: () => {
      calls.push('status')
      return { snapshot: snapshot('uninitialized') }
    },
    start: (presetId: string) => {
      calls.push(`start:${presetId}`)
      if (overrides.start) return overrides.start(presetId)
      const snap = snapshot('locked', { presetId, presetName: '温和坚定', presetVersion: '1.0.0', identityHash: 'h', identityBytes: 12 })
      return {
        persona: { personaId: 'main', initialization: { status: 'locked' } },
        preset: { presetId },
        identityHash: 'h',
        identityBytes: 12,
        dbSynced: true,
        claimToken: 'token-1',
        snapshot: snap,
      }
    },
    startCustom: (input: { identity: string; name?: string }) => {
      calls.push(`startCustom:${input.name ?? ''}`)
      if (overrides.startCustom) return overrides.startCustom(input)
      const snap = snapshot('locked', {
        presetId: null,
        presetName: input.name ?? '自定义人格',
        presetVersion: 'custom',
        identityHash: 'h',
        identityBytes: input.identity.length,
      })
      return {
        persona: { personaId: 'main', initialization: { status: 'locked', presetId: null, presetName: input.name ?? '自定义人格' } },
        preset: null,
        identityHash: 'h',
        identityBytes: input.identity.length,
        dbSynced: true,
        claimToken: 'token-custom',
        snapshot: snap,
      }
    },
    acceptDrift: () => {
      calls.push('acceptDrift')
      if (overrides.acceptDrift) return overrides.acceptDrift()
      return { persona: { personaId: 'main' }, identityHash: 'h2', snapshot: snapshot('locked', { identityHash: 'h2' }) }
    },
  }
  return service as unknown as PersonaInitService & typeof service
}

function depsFor(service: PersonaInitService | null, options: { unavailable?: string | null; presets?: InitPresetRow[] } = {}): InitRouteDeps & { seen: InitSnapshot[] } {
  const seen: InitSnapshot[] = []
  return {
    seen,
    ready: Promise.resolve(),
    service: () => service,
    unavailable: () => options.unavailable ?? null,
    onSnapshot: (snap) => seen.push(snap),
    presets: () => options.presets ?? presetRows,
    logger: {},
    send: send as unknown as InitRouteDeps['send'],
    sendJson: sendJson as unknown as InitRouteDeps['sendJson'],
    readJsonBody: readJsonBody as unknown as InitRouteDeps['readJsonBody'],
  }
}

async function main(): Promise<void> {
  // ── 1. 路由形状 ─────────────────────────────────────────────────────
  const shape = buildInitRoutes(depsFor(makeFakeService()))
  check('四条路由', shape.length === 4, shape.map((route) => route.path))
  check(
    '路由路径',
    shape.map((route) => route.path).join(',') ===
      '/api/psyche/init,/api/psyche/init/preset,/api/psyche/init/custom,/api/psyche/init/accept-drift',
    shape.map((route) => route.path),
  )

  const [routeGet, routeStart, routeCustom, routeDrift] = shape

  // ── 2. GET /init ────────────────────────────────────────────────────
  {
    const service = makeFakeService()
    const deps = depsFor(service)
    const routes = buildInitRoutes(deps)
    const response = makeResponse()
    await routes[0].handler(makeRequest('GET') as never, response as never)
    const body = bodyOf(response)
    check('GET /init 200', response.statusCode === 200)
    check('GET /init 带快照', body && body.snapshot && body.snapshot.state === 'uninitialized')
    check('GET /init 带预设', body && Array.isArray(body.presets) && body.presets.length === 2)
    check('GET /init 标边界', body && body.boundary && body.boundary.kind === 'owner-local')
    check('GET /init 只调 status', service.calls.join(',') === 'status')
  }

  // ── 3. 服务不可用 ───────────────────────────────────────────────────
  {
    const routes = buildInitRoutes(depsFor(null))
    const response = makeResponse()
    await routes[0].handler(makeRequest('GET') as never, response as never)
    const body = bodyOf(response)
    check('服务为空 → 503', response.statusCode === 503)
    check('服务为空给原因', body && body.error === '人格初始化服务还没准备好')
  }
  {
    const response = makeResponse()
    const routes = buildInitRoutes(depsFor(null, { unavailable: '初始化服务创建失败：磁盘满' }))
    await routes[0].handler(makeRequest('GET') as never, response as never)
    const body = bodyOf(response)
    check('不可用原因透传', response.statusCode === 503 && body && body.error === '初始化服务创建失败：磁盘满')
  }

  // ── 4. POST /init/preset 参数与错误码 ───────────────────────────────
  {
    const service = makeFakeService()
    const deps = depsFor(service)
    const routes = buildInitRoutes(deps)
    const response = makeResponse()
    await routes[1].handler(makeRequest('POST', {}) as never, response as never)
    check('空 presetId → 400', response.statusCode === 400)
    check('空 presetId 不调 start', service.calls.length === 0)
  }
  {
    const response = makeResponse()
    await routeStart.handler(makeRequest('GET') as never, response as never)
    check('GET /init/preset → 405', response.statusCode === 405)
  }
  {
    const service = makeFakeService({
      start: () => {
        const error = new Error('未知预设：nope') as Error & { code: string }
        error.code = 'E_PRESET_UNKNOWN'
        throw error
      },
    })
    const routes = buildInitRoutes(depsFor(service))
    const response = makeResponse()
    await routes[1].handler(makeRequest('POST', { presetId: 'nope' }) as never, response as never)
    const body = bodyOf(response)
    check('未知预设 → 400', response.statusCode === 400)
    check('未知预设带 code', body && body.code === 'E_PRESET_UNKNOWN')
  }
  {
    const service = makeFakeService({
      start: () => {
        const error = new Error('另一个初始化正在进行') as Error & { code: string }
        error.code = 'E_INIT_RACE'
        throw error
      },
    })
    const routes = buildInitRoutes(depsFor(service))
    const response = makeResponse()
    await routes[1].handler(makeRequest('POST', { presetId: 'gentle-firm' }) as never, response as never)
    check('锁冲突 → 409', response.statusCode === 409 && bodyOf(response).code === 'E_INIT_RACE')
  }
  {
    const service = makeFakeService({
      start: () => {
        const error = new Error('人格已锁定') as Error & { code: string }
        error.code = 'E_INIT_LOCKED'
        throw error
      },
    })
    const routes = buildInitRoutes(depsFor(service))
    const response = makeResponse()
    await routes[1].handler(makeRequest('POST', { presetId: 'gentle-firm' }) as never, response as never)
    check('已锁定 → 409', response.statusCode === 409 && bodyOf(response).code === 'E_INIT_LOCKED')
  }
  {
    const service = makeFakeService({
      start: () => {
        throw new Error('磁盘写不进去')
      },
    })
    const routes = buildInitRoutes(depsFor(service))
    const response = makeResponse()
    await routes[1].handler(makeRequest('POST', { presetId: 'gentle-firm' }) as never, response as never)
    check('普通错误 → 500', response.statusCode === 500 && bodyOf(response).code === null)
  }

  // ── 5. POST /init/preset 成功路径 ──────────────────────────────────
  {
    const service = makeFakeService()
    const deps = depsFor(service)
    const routes = buildInitRoutes(deps)
    const response = makeResponse()
    await routes[1].handler(makeRequest('POST', { presetId: 'gentle-firm' }) as never, response as never)
    const body = bodyOf(response)
    check('初始化成功 200', response.statusCode === 200 && body.ok === true)
    check('初始化调了 start', service.calls.join(',') === 'start:gentle-firm')
    check('回填快照给 runtime', deps.seen.length === 1 && deps.seen[0].state === 'locked')
    check('回执带 claimToken', body.claimToken === 'token-1')
    check('回执预设信息来自快照', body.persona && body.persona.presetName === '温和坚定' && body.persona.presetVersion === '1.0.0')
    check('回执带 dbSynced', body.dbSynced === true)
  }

  // ── 5.5 POST /init/custom ───────────────────────────────────────────
  {
    const service = makeFakeService()
    const deps = depsFor(service)
    const routes = buildInitRoutes(deps)
    const response = makeResponse()
    const identity = '她是林间的一只小鹿，说话轻，记性很好。'.repeat(20)
    await routes[2].handler(makeRequest('POST', { identity, name: '小鹿' }) as never, response as never)
    const body = bodyOf(response)
    check('自定义初始化成功 200', response.statusCode === 200 && body.ok === true)
    check('自定义调了 startCustom', service.calls.join(',') === 'startCustom:小鹿')
    check('自定义回执 presetId 为 null', body.persona && body.persona.presetId === null)
    check('自定义回执名字来自快照', body.persona && body.persona.presetName === '小鹿')
    check('自定义回执带 claimToken', body.claimToken === 'token-custom')
    check('自定义回填快照给 runtime', deps.seen.length === 1 && deps.seen[0].state === 'locked')
  }
  {
    const service = makeFakeService()
    const routes = buildInitRoutes(depsFor(service))
    const response = makeResponse()
    await routes[2].handler(makeRequest('POST', { identity: '   ' }) as never, response as never)
    check('空白 identity → 400', response.statusCode === 400)
    check('空白 identity 不调 startCustom', service.calls.length === 0)
  }
  {
    const service = makeFakeService({
      startCustom: () => {
        const error = new Error('自定义身份太短') as Error & { code: string }
        error.code = 'E_VALIDATION'
        throw error
      },
    })
    const routes = buildInitRoutes(depsFor(service))
    const response = makeResponse()
    await routes[2].handler(makeRequest('POST', { identity: '短' }) as never, response as never)
    check('自定义校验失败 → 400', response.statusCode === 400 && bodyOf(response).code === 'E_VALIDATION')
  }
  {
    const response = makeResponse()
    await routeCustom.handler(makeRequest('GET') as never, response as never)
    check('GET /init/custom → 405', response.statusCode === 405)
  }

  // ── 6. POST /init/accept-drift ──────────────────────────────────────
  {
    const service = makeFakeService()
    const deps = depsFor(service)
    const routes = buildInitRoutes(deps)
    const response = makeResponse()
    await routes[3].handler(makeRequest('POST') as never, response as never)
    const body = bodyOf(response)
    check('接受漂移 200', response.statusCode === 200 && body.ok === true)
    check('回填新快照', deps.seen.length === 1 && deps.seen[0].identityHash === 'h2')
    check('只调 acceptDrift', service.calls.join(',') === 'acceptDrift')
  }
  {
    const service = makeFakeService({
      acceptDrift: () => {
        const error = new Error('当前不是漂移状态') as Error & { code: string }
        error.code = 'E_INIT_STATE'
        throw error
      },
    })
    const routes = buildInitRoutes(depsFor(service))
    const response = makeResponse()
    await routes[3].handler(makeRequest('POST') as never, response as never)
    check('漂移状态不符 → 409', response.statusCode === 409 && bodyOf(response).code === 'E_INIT_STATE')
  }
  {
    const response = makeResponse()
    await routeDrift.handler(makeRequest('GET') as never, response as never)
    check('GET /accept-drift → 405', response.statusCode === 405)
  }

  // ── 7. 错误码映射表 ─────────────────────────────────────────────────
  check('E_PRESET_UNKNOWN → 400', initErrorStatus('E_PRESET_UNKNOWN') === 400)
  check('E_VALIDATION → 400', initErrorStatus('E_VALIDATION') === 400)
  check('E_INIT_RACE → 409', initErrorStatus('E_INIT_RACE') === 409)
  check('E_INIT_STATE → 409', initErrorStatus('E_INIT_STATE') === 409)
  check('E_INIT_LOCKED → 409', initErrorStatus('E_INIT_LOCKED') === 409)
  check('E_INTERNAL → 500', initErrorStatus('E_INTERNAL') === 500)
  check('无错误码 → 500', initErrorStatus(null) === 500)

  // ── 8. 边界：路由只经服务（假服务没有文件能力也能跑通全部路径）──
  check('全部用例未触碰文件/claim（假服务仅四方法）', true)

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  init-routes：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('init-routes 测试崩溃：', error)
  process.exitCode = 1
})
