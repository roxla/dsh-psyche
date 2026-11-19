// 人格初始化的四条 Owner 路由（I-7 / 自定义人格）。
//
// 职责：把 HTTP 形状（方法/JSON/错误码）翻译成 PersonaInitService 的调用，再把结果翻回 JSON。
// 不做的事（这是本文件最重要的约束）：
//   - 不碰 claim 文件、不写 identity.md / persona.json、不写数据库快照；
//   - 不判断人格状态（状态由服务返回的快照决定）；
//   - 不替调用方选默认预设——缺 presetId 就直接 400。
// 边界：这些路由只挂在本机 Web 服务上，不做独立身份认证；访问控制依赖宿主 webServer 的
//   监听地址与来源限制。面板按钮隐藏只是体验优化，真正的保护在 Core（状态门/锁归属/文件权威）。
// 调用方：src/index.ts 的 webServer inject；测试：test/init-routes.ts（用假 request/response）。
import type { HttpRequest, HttpRoute, HttpResponse } from '@deepseek-ai/cordis'
import type { InitSnapshot } from './persona-init.js'
import type { PersonaInitService } from './persona-init-service.js'

/** 预设展示行：只带选择需要的字段，不含人格正文。 */
export interface InitPresetRow {
  id: string
  name: string
  version: string
  summary: string
  recommended: boolean
  draft: boolean
}

/** 路由依赖：全部由 index.ts 注入，测试可逐项替换。 */
export interface InitRouteDeps {
  /** boot 的 promise：路由先等它，避免读到半初始化状态。 */
  ready: Promise<unknown>
  /** 取当前服务；boot 失败/未创建时返回 null。 */
  service: () => PersonaInitService | null
  /** 服务不可用时的原因（给 503 的 error 文案用）。 */
  unavailable: () => string | null
  /** 成功写入后把新快照回填给 runtime，让下一次轮询看到服务端结果。 */
  onSnapshot: (snapshot: InitSnapshot) => void
  /** 预设列表（读失败返回空数组，由前端提示）。 */
  presets: () => InitPresetRow[]
  logger: { warn?: (message: string) => void }
  /** 统一 JSON 响应（index.ts 的 send/sendJson/readJsonBody 原样传入）。 */
  send: (response: HttpResponse, statusCode: number, body: unknown) => void
  sendJson: (response: HttpResponse, body: unknown) => void
  readJsonBody: (request: HttpRequest) => Promise<Record<string, unknown>>
}

/** 错误码 → HTTP 状态：400 调用方给错；409 当前状态不允许；500 真故障。 */
export function initErrorStatus(code: string | null): number {
  if (code === 'E_PRESET_UNKNOWN' || code === 'E_VALIDATION') return 400
  if (code && /^E_INIT_/.test(code)) return 409
  return 500
}

/** 从未知错误里取错误码（PsycheError 的 code；非 PsycheError 返回 null）。 */
function errorCodeOf(error: unknown): string | null {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' ? code : null
}

/** 从未知错误里取人话（只回 message，不回堆栈/路径）。 */
function errorTextOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/**
 * 构建三条路由。返回数组顺序固定：GET /init、POST /init/preset、POST /init/accept-drift。
 * 纯装配：不读文件、不碰数据库，所有副作用都在 service 里。
 */
export function buildInitRoutes(deps: InitRouteDeps): HttpRoute[] {
  const unavailable = (response: HttpResponse): void => {
    deps.send(response, 503, { ok: false, error: deps.unavailable() ?? '人格初始化服务还没准备好' })
  }
  const fail = (response: HttpResponse, error: unknown): void => {
    const code = errorCodeOf(error)
    deps.send(response, initErrorStatus(code), { ok: false, code, error: errorTextOf(error) })
  }
  const requirePost = (request: HttpRequest, response: HttpResponse): boolean => {
    if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
      deps.send(response, 405, { ok: false, error: '只接受 POST' })
      return false
    }
    return true
  }

  return [
    {
      // 只读：状态 + 预设展示行 + 边界说明（让前端/CLI 都能自证「这是本机管理口」）。
      kind: 'exact',
      path: '/api/psyche/init',
      handler: async (_request, response) => {
        await deps.ready
        const service = deps.service()
        if (!service) {
          unavailable(response)
          return
        }
        const { snapshot } = service.status()
        deps.sendJson(response, {
          ok: true,
          snapshot,
          presets: deps.presets(),
          boundary: {
            kind: 'owner-local',
            note: '仅本机管理面板可达；不做独立身份认证，依赖宿主 webServer 的监听与来源限制。',
          },
        })
      },
    },
    {
      // 初始化：必须显式给 presetId（空串直接 400，不替人拍板人格）。
      kind: 'exact',
      path: '/api/psyche/init/preset',
      handler: async (request, response) => {
        if (!requirePost(request, response)) return
        await deps.ready
        const service = deps.service()
        if (!service) {
          unavailable(response)
          return
        }
        let body: Record<string, unknown>
        try {
          body = await deps.readJsonBody(request)
        } catch {
          deps.send(response, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const presetId = typeof body.presetId === 'string' ? body.presetId.trim() : ''
        if (!presetId) {
          deps.send(response, 400, { ok: false, error: '必须显式指定 presetId（不自动选默认预设）' })
          return
        }
        try {
          const result = await service.start(presetId)
          deps.onSnapshot(result.snapshot)
          deps.sendJson(response, {
            ok: true,
            persona: {
              personaId: result.persona.personaId,
              presetId: result.snapshot.presetId,
              presetName: result.snapshot.presetName,
              presetVersion: result.snapshot.presetVersion,
              identityHash: result.identityHash,
              identityBytes: result.identityBytes,
            },
            claimToken: result.claimToken,
            dbSynced: result.dbSynced,
            snapshot: result.snapshot,
          })
        } catch (error) {
          fail(response, error)
        }
      },
    },
    {
      // 自定义人格：必须给 identity 正文（200–8000 字）；名字可选，缺省「自定义人格」。
      kind: 'exact',
      path: '/api/psyche/init/custom',
      handler: async (request, response) => {
        if (!requirePost(request, response)) return
        await deps.ready
        const service = deps.service()
        if (!service) {
          unavailable(response)
          return
        }
        let body: Record<string, unknown>
        try {
          body = await deps.readJsonBody(request)
        } catch {
          deps.send(response, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const identity = typeof body.identity === 'string' ? body.identity : ''
        if (!identity.trim()) {
          deps.send(response, 400, { ok: false, error: '必须提供 identity 正文（200–8000 字）' })
          return
        }
        const name = typeof body.name === 'string' ? body.name : undefined
        try {
          const result = await service.startCustom({ identity, name })
          deps.onSnapshot(result.snapshot)
          deps.sendJson(response, {
            ok: true,
            persona: {
              personaId: result.persona.personaId,
              presetId: result.snapshot.presetId,
              presetName: result.snapshot.presetName,
              presetVersion: result.snapshot.presetVersion,
              identityHash: result.identityHash,
              identityBytes: result.identityBytes,
            },
            claimToken: result.claimToken,
            dbSynced: result.dbSynced,
            snapshot: result.snapshot,
          })
        } catch (error) {
          fail(response, error)
        }
      },
    },
    {
      // 身份漂移：只有人工点确认才接受新哈希；服务只改哈希/字节数，不覆盖原文。
      kind: 'exact',
      path: '/api/psyche/init/accept-drift',
      handler: async (request, response) => {
        if (!requirePost(request, response)) return
        await deps.ready
        const service = deps.service()
        if (!service) {
          unavailable(response)
          return
        }
        try {
          const { snapshot } = service.acceptDrift()
          deps.onSnapshot(snapshot)
          deps.sendJson(response, { ok: true, snapshot })
        } catch (error) {
          fail(response, error)
        }
      },
    },
  ]
}
