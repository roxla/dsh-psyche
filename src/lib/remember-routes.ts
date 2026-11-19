// 「记住这条」按钮的一条 Owner 路由。
//
// 职责：把 HTTP 形状（POST + { sessionId, assistantMessageId }）翻译成
// `rememberAssistantMessage` 的调用，再把结果翻回 JSON。
//
// 不做的事（边界）：
//   - 不接收 contactId / 正文 / kind / disclosure——身份从 RuntimeInput 取，正文从会话事件取；
//   - 不直接操作数据库，写入全部走 Core（opId 幂等、归属校验、v13 派生列）；
//   - 不返回会话原文，只返回提炼出的结论与动作。
//
// 访问控制与 init/grant 路由一致：只挂在本机 Web 服务上，不做独立身份认证。
import type { HttpRequest, HttpRoute, HttpResponse } from '@deepseek-ai/cordis'

import {
  RememberButtonError,
  rememberAssistantMessage,
  type RememberButtonDeps,
} from './remember-button.js'

export interface RememberRouteDeps {
  ready: Promise<unknown>
  /** 每次请求现取：依赖 boot 完成后的 runtimeInputs / Core / persistence。 */
  deps: () => Promise<RememberButtonDeps | null>
  unavailable: () => string | null
  logger: { warn?: (message: string, detail?: unknown) => void }
  send: (response: HttpResponse, statusCode: number, body: unknown) => void
  sendJson: (response: HttpResponse, body: unknown) => void
  readJsonBody: (request: HttpRequest) => Promise<Record<string, unknown>>
}

/** 错误码 → HTTP 状态：400 调用方给错；404 找不到消息；409 状态不允许；503 环境不支持。 */
export function rememberErrorStatus(code: string | null): number {
  if (code === 'E_EMPTY_STATEMENT' || code === 'E_SOURCE_MISSING') return 400
  if (code === 'E_NOT_FOUND') return 404
  if (code === 'E_SOURCE_QUARANTINED' || code === 'E_UNSUPPORTED') return 409
  return 500
}

function errorFieldOf(error: unknown, field: string): unknown {
  return (error as Record<string, unknown> | null)?.[field]
}

export function registerRememberRoutes(deps: RememberRouteDeps): HttpRoute[] {
  const remember: HttpRoute = {
    kind: 'exact',
    path: '/api/psyche/remember-message',
    async handler(request: HttpRequest, response: HttpResponse) {
      if (request.method !== 'POST') {
        deps.send(response, 405, { ok: false, code: 'E_METHOD', error: '只接受 POST' })
        return
      }
      await deps.ready
      const unavailable = deps.unavailable()
      if (unavailable !== null) {
        deps.send(response, 503, { ok: false, code: 'E_UNAVAILABLE', error: unavailable })
        return
      }
      const body = await deps.readJsonBody(request)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      const assistantMessageId = typeof body.assistantMessageId === 'string' ? body.assistantMessageId : ''
      if (sessionId === '' || assistantMessageId === '') {
        deps.send(response, 400, {
          ok: false,
          code: 'E_EMPTY_STATEMENT',
          error: '需要 sessionId 与 assistantMessageId',
        })
        return
      }
      const current = await deps.deps()
      if (current === null) {
        deps.send(response, 503, { ok: false, code: 'E_UNAVAILABLE', error: '记忆服务还没就绪' })
        return
      }
      try {
        const result = await rememberAssistantMessage(current, { sessionId, assistantMessageId })
        deps.sendJson(response, result)
      } catch (error) {
        const code = error instanceof RememberButtonError ? error.code : errorFieldOf(error, 'code')
        const message = error instanceof Error ? error.message : String(error)
        const status = rememberErrorStatus(typeof code === 'string' ? code : null)
        // 按钮只有 toast 能显示一句话，失败原因走 logger；不回显正文。
        if (status >= 500) {
          deps.logger.warn?.('[psyche] 记住这条失败', { code: String(code ?? 'unknown'), message })
        }
        deps.send(response, status, { ok: false, code: typeof code === 'string' ? code : 'E_INTERNAL', error: message })
      }
    },
  }
  return [remember]
}
