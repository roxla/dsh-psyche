// 披露授权的宿主路由（E5.5-E1）。
//
// 职责边界（本文件最重要的约束）：
//   - 这是宿主侧入口，不是模型工具。grantDisclosure 绝不注册进 tools 表，
//     否则模型可以靠一次工具调用给自己开「公开」权限，授权链就白做了。
//   - grantedBy 由路由固定写成宿主身份，**不读请求体里的 grantedBy**：
//     模型能填的字段不能作为「谁批准了这次公开」的依据。
//   - 路由只做 HTTP 形状翻译与错误码映射；内容绑定、一次性核销、事务一致性
//     全部在 Core 的 grantDisclosure / revokeDisclosureGrant 里完成。
//   - 审计只回 grant 元数据（id/artifactId/revision/contentHash/前后披露/时间），
//     不回 statement 正文。
//
// 授权范围（E5.5-E1 冻结）：只授权「某条 Artifact 的指定 Revision 成为 public」，
// 不自动扩展到 Source/Event、其他历史 Revision、其他 Contact，也不延伸到未来修订。
import type { HttpRequest, HttpRoute, HttpResponse } from '@deepseek-ai/cordis'
import type { Core, RevokeDisclosureGrantInput } from 'dsh-psyche-core'

/** 宿主身份：Owner 面板通过本机 Web 服务调用，不是模型工具。 */
export const HOST_GRANTOR = 'host:owner'

export interface GrantRouteDeps {
  /** boot 的 promise：路由先等它，避免读到半初始化状态。 */
  ready: Promise<unknown>
  /** 取 Core；boot 失败/未创建时返回 null。 */
  core: () => Core | null
  /** Core 不可用时的原因（给 503 的 error 文案用）。 */
  unavailable: () => string | null
  send: (response: HttpResponse, statusCode: number, body: unknown) => void
  sendJson: (response: HttpResponse, body: unknown) => void
  readJsonBody: (request: HttpRequest) => Promise<Record<string, unknown>>
  logger: { warn?: (message: string) => void }
}

/** 错误码 → HTTP 状态：400 调用方给错；404 授权不存在；409 当前状态不允许；500 真故障。 */
export function grantErrorStatus(code: string | null): number {
  if (code === 'E_VALIDATION' || code === 'E_TEXT') return 400
  if (code === 'E_NOT_FOUND') return 404
  if (code === 'E_STATE' || code === 'E_IDEMPOTENT_CONFLICT') return 409
  return 500
}

function errorCodeOf(error: unknown): string | null {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' ? code : null
}

function errorTextOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function bodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  return typeof value === 'string' ? value.trim() : ''
}

function bodyNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/**
 * 构建三条宿主路由：
 *   POST /api/psyche/disclosure/grant   签发一次性授权
 *   POST /api/psyche/disclosure/revoke  撤销一张未消费的授权
 *   GET  /api/psyche/disclosure/grants  只读列出授权事实（审计）
 */
export function buildGrantRoutes(deps: GrantRouteDeps): HttpRoute[] {
  const unavailable = (response: HttpResponse): void => {
    deps.send(response, 503, { ok: false, error: deps.unavailable() ?? '记忆引擎还没准备好' })
  }
  const fail = (response: HttpResponse, error: unknown): void => {
    const code = errorCodeOf(error)
    deps.logger.warn?.(`[grant] ${code ?? 'E_INTERNAL'} ${errorTextOf(error)}`)
    deps.send(response, grantErrorStatus(code), { ok: false, code, error: errorTextOf(error) })
  }
  const requirePost = (request: HttpRequest, response: HttpResponse): boolean => {
    if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
      deps.send(response, 405, { ok: false, error: '只接受 POST' })
      return false
    }
    return true
  }
  const readBody = async (
    request: HttpRequest,
    response: HttpResponse,
  ): Promise<Record<string, unknown> | null> => {
    try {
      return await deps.readJsonBody(request)
    } catch {
      deps.send(response, 400, { ok: false, error: '请求体不是合法 JSON' })
      return null
    }
  }

  return [
    {
      // 签发：只认宿主身份；body 里的 grantedBy / granted_by 一律忽略。
      kind: 'exact',
      path: '/api/psyche/disclosure/grant',
      handler: async (request, response) => {
        if (!requirePost(request, response)) return
        await deps.ready
        const core = deps.core()
        if (!core) {
          unavailable(response)
          return
        }
        const body = await readBody(request, response)
        if (!body) return
        const artifactId = bodyString(body, 'artifactId') || bodyString(body, 'artifact_id')
        const statement = bodyString(body, 'statement')
        if (!artifactId && !statement) {
          deps.send(response, 400, { ok: false, error: '必须给 artifactId 或 statement 之一' })
          return
        }
        try {
          const result = await core.grantDisclosure({
            artifactId: artifactId || undefined,
            revision: bodyNumber(body, 'revision'),
            statement: statement || undefined,
            reason: bodyString(body, 'reason') || undefined,
            ttlMs: bodyNumber(body, 'ttlMs'),
            opId: bodyString(body, 'opId') || undefined,
            // 关键：不读 body.grantedBy；授权人只能是宿主。
            grantedBy: HOST_GRANTOR,
          })
          deps.sendJson(response, {
            ok: true,
            grant: {
              grantId: result.grantId,
              artifactId: result.artifactId,
              revision: result.revision,
              contentHash: result.contentHash,
              beforeDisclosure: result.beforeDisclosure,
              afterDisclosure: result.afterDisclosure,
              expiresAt: result.expiresAt,
              replayed: result.replayed === true,
            },
            grantedBy: HOST_GRANTOR,
            boundary: {
              kind: 'owner-local',
              note: '宿主签发；只授权这一个 Revision 成为 public，不延伸未来修订、Source/Event 或其他 Contact。',
            },
          })
        } catch (error) {
          fail(response, error)
        }
      },
    },
    {
      // 撤销：只撤销「已签发、未消费」的授权；已消费的返回 409。
      kind: 'exact',
      path: '/api/psyche/disclosure/revoke',
      handler: async (request, response) => {
        if (!requirePost(request, response)) return
        await deps.ready
        const core = deps.core()
        if (!core) {
          unavailable(response)
          return
        }
        const body = await readBody(request, response)
        if (!body) return
        const grantId = bodyString(body, 'grantId') || bodyString(body, 'grant_id')
        if (!grantId) {
          deps.send(response, 400, { ok: false, error: '必须给 grantId' })
          return
        }
        try {
          const input: RevokeDisclosureGrantInput = { grantId, revokedBy: HOST_GRANTOR }
          const result = await core.revokeDisclosureGrant(input)
          deps.sendJson(response, {
            ok: true,
            grantId: result.grantId,
            revokedAt: result.revokedAt,
            alreadyRevoked: result.alreadyRevoked,
            revokedBy: HOST_GRANTOR,
          })
        } catch (error) {
          fail(response, error)
        }
      },
    },
    {
      // 只读审计：只回授权元数据，不回正文。
      kind: 'exact',
      path: '/api/psyche/disclosure/grants',
      handler: async (request, response) => {
        await deps.ready
        const core = deps.core()
        if (!core) {
          unavailable(response)
          return
        }
        const url = new URL(request.url ?? '/', 'http://localhost')
        const artifactId = (url.searchParams.get('artifactId') ?? '').trim() || undefined
        const rawLimit = url.searchParams.get('limit')
        const limit = rawLimit && Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : undefined
        try {
          const result = await core.listDisclosureGrants({ artifactId, limit })
          deps.sendJson(response, { ok: true, rows: result.rows })
        } catch (error) {
          fail(response, error)
        }
      },
    },
  ]
}
