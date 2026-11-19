// C-3b 本机人工入口的 OS 身份与进程租约；不注册工具/HTTP，不保存授权真值。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { realpathSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'

export function localOwnerIdentity(): { id: string; label: string } {
  if (process.platform !== 'win32') {
    const user = userInfo()
    return { id: `local-owner:uid:${user.uid}`, label: user.username }
  }
  const value = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
  const sid = /\bS-1-\d+(?:-\d+)+\b/.exec(value)?.[0]
  if (!sid) throw new Error('无法确认本机 Owner 身份')
  const label = /^"((?:[^"]|"")*)",/.exec(value.trim())?.[1].replaceAll('""', '"') ?? 'local-owner'
  return { id: `local-owner:${sid}`, label }
}

/** 同 DB 路径在同主机独占；碰撞保守拒绝，崩溃时内核自动释放。 */
export async function acquireOutboundLease(databaseFile: string): Promise<{ release(): Promise<void> }> {
  const real = realpathSync(databaseFile)
  const canonical = process.platform === 'win32' ? real.toLowerCase() : real
  const port = 42000 + createHash('sha256').update(canonical).digest().readUInt32BE(0) % 6000
  const server = createServer((socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error('主动发送入口已被占用；请确认其他本机入口已退出')))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve())
  })
  let released = false
  return { release: async () => {
    if (released) return
    released = true
    await new Promise<void>((resolve) => server.close(() => resolve()))
  } }
}

/** 只选用户明确指定账号的本地 WS 配置，不扫描/切换其他账号。 */
export function readOwnerQqEndpoint(home: string, account: string): { wsUrl: string; token: string } {
  if (!/^[1-9]\d{4,19}$/.test(account)) throw new Error('发送账号格式非法')
  const config = JSON.parse(readFileSync(join(home, 'config', `onebot_${account}.json`), 'utf8').replace(/^\uFEFF/, ''))
  const servers: Array<{ host?: string; port?: number; path?: string; accessToken?: string; enable?: boolean; enabled?: boolean }> = config.networks?.wsServers ?? []
  const available = servers.filter((s) => s.enabled !== false && s.enable !== false)
  if (available.length !== 1) throw new Error('指定账号必须配置唯一的本地 OneBot WS 服务')
  const server = available[0]
  if (!['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'].includes(server.host ?? '')) throw new Error('本机 CLI 只连接 loopback OneBot')
  if (!Number.isInteger(server.port) || Number(server.port) < 1 || Number(server.port) > 65535) throw new Error('OneBot 端口非法')
  const pathname = server.path ?? '/'
  if (!pathname.startsWith('/') || /[?#\s]/.test(pathname)) throw new Error('OneBot WS 路径非法')
  if (typeof server.accessToken !== 'string' || server.accessToken.trim() === '') throw new Error('指定账号缺少 OneBot WS 凭证')
  const host = server.host === '::1' ? '[::1]' : '127.0.0.1'
  return { wsUrl: `ws://${host}:${server.port}${pathname}`, token: server.accessToken }
}
