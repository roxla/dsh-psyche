/**
 * E5.5-E1 宿主授权路由自检。
 *
 * 测什么：
 *   1. 三条路由的形状（签发 / 撤销 / 只读审计）；
 *   2. **授权人只能是宿主**——请求体里伪造 grantedBy 不生效；
 *   3. 参数缺失 → 400，方法不对 → 405，Core 不可用 → 503；
 *   4. 错误码映射（E_VALIDATION→400、E_NOT_FOUND→404、E_STATE/E_IDEMPOTENT_CONFLICT→409、其他→500）；
 *   5. **授权入口不是模型工具**——buildTools 的工具表里没有 grant/disclosure 类工具。
 *
 * 为什么这层必须单独测：Core 的原子核销再正确，只要路由把 grantedBy 透传，
 * 模型就能靠一次工具参数把「谁批准了公开」伪造成自己。授权链的可信度取决于入口。
 *
 * 跑法：`node test/grant-routes.ts`（要求先 `npm run build`）。
 */
import { buildGrantRoutes, grantErrorStatus, HOST_GRANTOR } from '../dist/lib/grant-routes.js'
import type { GrantRouteDeps } from '../dist/lib/grant-routes.js'
import { buildTools } from '../dist/lib/tools.js'

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

const makeResponse = (): FakeResponse => ({ statusCode: 0, headers: {}, body: '' })
const send = (response: FakeResponse, statusCode: number, body: unknown): void => {
  response.statusCode = statusCode
  response.body = JSON.stringify(body)
}
const sendJson = (response: FakeResponse, body: unknown): void => send(response, 200, body)
const bodyOf = (response: FakeResponse): any => JSON.parse(response.body || '{}')

const makeRequest = (method: string, body?: unknown, url?: string): any =>
  url === undefined ? { method, body } : { method, body, url }

const readJsonBody = async (request: any): Promise<Record<string, unknown>> => {
  if (request.body && typeof request.body === 'object' && !Array.isArray(request.body)) return request.body
  return {}
}

const grantResult = {
  ok: true as const,
  grantId: 'grn_test_1',
  contentHash: 'hash-1',
  artifactId: 'art_1',
  revision: 2,
  beforeDisclosure: 'restricted' as const,
  afterDisclosure: 'public' as const,
  expiresAt: null,
  replayed: false,
}

interface FakeCore {
  grantDisclosure: (input: any) => Promise<any>
  revokeDisclosureGrant: (input: any) => Promise<any>
  listDisclosureGrants: (input: any) => Promise<any>
}

function makeCore(overrides: Partial<FakeCore> = {}): { core: FakeCore; calls: any[] } {
  const calls: any[] = []
  const core: FakeCore = {
    grantDisclosure: async (input) => {
      calls.push({ method: 'grantDisclosure', input })
      return grantResult
    },
    revokeDisclosureGrant: async (input) => {
      calls.push({ method: 'revokeDisclosureGrant', input })
      return { grantId: input.grantId, revokedAt: '2026-11-07T00:00:00.000Z', alreadyRevoked: false }
    },
    listDisclosureGrants: async (input) => {
      calls.push({ method: 'listDisclosureGrants', input })
      return {
        rows: [
          {
            grantId: 'grn_test_1',
            artifactId: 'art_1',
            revision: 2,
            contentHash: 'hash-1',
            grantedBy: HOST_GRANTOR,
            beforeDisclosure: 'restricted',
            afterDisclosure: 'public',
            createdAt: '2026-11-07T00:00:00.000Z',
            expiresAt: null,
            usedAt: null,
            revokedAt: null,
          },
        ],
      }
    },
    ...overrides,
  }
  return { core, calls }
}

function depsFor(core: FakeCore | null, unavailable: string | null = null): GrantRouteDeps {
  return {
    ready: Promise.resolve(),
    core: () => core as never,
    unavailable: () => unavailable,
    send: send as unknown as GrantRouteDeps['send'],
    sendJson: sendJson as unknown as GrantRouteDeps['sendJson'],
    readJsonBody: readJsonBody as unknown as GrantRouteDeps['readJsonBody'],
    logger: {},
  }
}

async function main(): Promise<void> {
  // ── 1. 形状 ─────────────────────────────────────────────────────────
  const shape = buildGrantRoutes(depsFor(makeCore().core))
  check('三条路由', shape.length === 3, shape.map((r) => r.path))
  check(
    '路由路径与顺序',
    shape.map((r) => r.path).join(',') ===
      '/api/psyche/disclosure/grant,/api/psyche/disclosure/revoke,/api/psyche/disclosure/grants',
    shape.map((r) => r.path),
  )
  const [routeGrant, routeRevoke, routeList] = shape

  // ── 2. 签发：宿主身份不可伪造 ───────────────────────────────────────
  {
    const { core, calls } = makeCore()
    const routes = buildGrantRoutes(depsFor(core))
    const response = makeResponse()
    await routes[0].handler(
      makeRequest('POST', { artifactId: 'art_1', grantedBy: 'model:evil', granted_by: 'model:evil' }) as never,
      response as never,
    )
    const body = bodyOf(response)
    check('签发 200', response.statusCode === 200)
    check('返回 grantId', body.grant && body.grant.grantId === grantResult.grantId)
    check('返回宿主授权人', body.grantedBy === HOST_GRANTOR)
    check('Core 收到的 grantedBy 是宿主', calls[0]?.input?.grantedBy === HOST_GRANTOR, calls[0]?.input?.grantedBy)
    check('请求体里的 grantedBy 被忽略', calls[0]?.input?.grantedBy !== 'model:evil')
  }

  // ── 3. 签发参数校验 ─────────────────────────────────────────────────
  {
    const routes = buildGrantRoutes(depsFor(makeCore().core))
    const response = makeResponse()
    await routes[0].handler(makeRequest('POST', {}) as never, response as never)
    check('既无 artifactId 也无 statement → 400', response.statusCode === 400, bodyOf(response))
  }
  {
    const routes = buildGrantRoutes(depsFor(makeCore().core))
    const response = makeResponse()
    await routes[0].handler(makeRequest('GET') as never, response as never)
    check('GET 签发口 → 405', response.statusCode === 405)
  }

  // ── 4. 错误码映射 ───────────────────────────────────────────────────
  for (const [code, status] of [
    ['E_VALIDATION', 400],
    ['E_NOT_FOUND', 404],
    ['E_STATE', 409],
    ['E_IDEMPOTENT_CONFLICT', 409],
    ['E_INTERNAL', 500],
  ] as const) {
    check(`错误码 ${code} → ${status}`, grantErrorStatus(code) === status, grantErrorStatus(code))
  }
  {
    const { core } = makeCore({
      grantDisclosure: async () => {
        throw Object.assign(new Error('这张授权已经被消费'), { code: 'E_STATE' })
      },
    })
    const routes = buildGrantRoutes(depsFor(core))
    const response = makeResponse()
    await routes[0].handler(makeRequest('POST', { artifactId: 'art_1' }) as never, response as never)
    check('Core 抛 E_STATE → 409', response.statusCode === 409, bodyOf(response))
    check('错误体带 code', bodyOf(response).code === 'E_STATE')
  }

  // ── 5. Core 不可用 ──────────────────────────────────────────────────
  {
    const routes = buildGrantRoutes(depsFor(null, '记忆引擎没起来'))
    const response = makeResponse()
    await routes[0].handler(makeRequest('POST', { artifactId: 'art_1' }) as never, response as never)
    check('Core 为空 → 503', response.statusCode === 503)
    check('503 带原因', bodyOf(response).error === '记忆引擎没起来')
  }

  // ── 6. 撤销 ─────────────────────────────────────────────────────────
  {
    const { core, calls } = makeCore()
    const routes = buildGrantRoutes(depsFor(core))
    const response = makeResponse()
    await routes[1].handler(makeRequest('POST', { grantId: 'grn_test_1' }) as never, response as never)
    check('撤销 200', response.statusCode === 200, bodyOf(response))
    check('撤销返回 alreadyRevoked=false', bodyOf(response).alreadyRevoked === false)
    check('撤销人由宿主固定', calls[0]?.input?.revokedBy === HOST_GRANTOR)
  }
  {
    const routes = buildGrantRoutes(depsFor(makeCore().core))
    const response = makeResponse()
    await routes[1].handler(makeRequest('POST', {}) as never, response as never)
    check('撤销缺 grantId → 400', response.statusCode === 400)
  }

  // ── 7. 只读列表 ─────────────────────────────────────────────────────
  {
    const { core, calls } = makeCore()
    const routes = buildGrantRoutes(depsFor(core))
    const response = makeResponse()
    await routes[2].handler(
      makeRequest('GET', undefined, '/api/psyche/disclosure/grants?artifactId=art_1&limit=10') as never,
      response as never,
    )
    const body = bodyOf(response)
    check('列表 200', response.statusCode === 200)
    check('列表返回行', Array.isArray(body.rows) && body.rows.length === 1)
    check('列表按 artifactId 过滤', calls[0]?.input?.artifactId === 'art_1')
    check('列表不含正文', !JSON.stringify(body).includes('statement'))
  }

  // ── 8. 授权入口不是模型工具 ─────────────────────────────────────────
  {
    const names = (buildTools({} as never) as Array<{ name?: string }>).map((tool) => String(tool.name ?? ''))
    check('工具表非空', names.length > 0, names.length)
    check('没有 grant/disclosure 工具', !names.some((name) => /grant|disclosure/i.test(name)), names)
    check('remember 工具仍在', names.includes('psyche_remember'))
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  if (fail > 0) process.exitCode = 1
}

await main()
