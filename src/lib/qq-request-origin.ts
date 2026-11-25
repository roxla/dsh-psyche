// 写请求的来源校验（GPT 第 1、2 轮第 5 条）。
//
// 可信身份由宿主的 browser-session 鉴权提供——`/api/psyche/*` 没有它进不来，
// 插件不重复造一套 Owner 体系；这里只补「这次写入确实来自同一站点」这一层：
// - cross-site 一律拒绝；
// - 带 Origin 的必须与请求自身「协议 + 主机 + 端口」完全一致（只比 host 不够）；
// - 不带 Origin 时，只有浏览器给出 `Sec-Fetch-Site: same-origin` 才放行；
//   两者都缺的写请求一律失败关闭——只靠 Cookie 的写入存在 CSRF 缺口。

export interface OriginCheckRequest {
  readonly headers?: Record<string, string | string[] | undefined> | undefined
  readonly protocol?: string | undefined
  readonly socket?: { readonly encrypted?: boolean | undefined } | undefined
}

function readHeader(request: OriginCheckRequest, name: string): string {
  const value = request.headers?.[name]
  if (Array.isArray(value)) return value[0] ?? ''
  return typeof value === 'string' ? value : ''
}

/** 请求自身用的协议：优先框架给的 `protocol`，其次看 socket 是否 TLS，默认 http。 */
function requestProtocol(request: OriginCheckRequest): string {
  if (typeof request.protocol === 'string' && request.protocol !== '') {
    return request.protocol.replace(/:$/, '').toLowerCase()
  }
  return request.socket?.encrypted === true ? 'https' : 'http'
}

export function sameOriginWrite(request: OriginCheckRequest): boolean {
  const site = readHeader(request, 'sec-fetch-site')
  if (site === 'cross-site') return false
  const origin = readHeader(request, 'origin')
  if (origin === '') return site === 'same-origin'
  try {
    const parsed = new URL(origin)
    if (parsed.host === '') return false
    if (parsed.protocol !== `${requestProtocol(request)}:`) return false
    return parsed.host === readHeader(request, 'host')
  } catch {
    return false
  }
}
