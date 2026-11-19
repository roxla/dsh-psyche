/**
 * P8-2/P8-4：本机独立 QQ 控制中心（loopback + 一次性令牌）。
 *
 * 为什么不挂在 DSH 的 `/api/psyche/*` 上：宿主 API 认证仍是 PARTIAL/OPEN，
 * 匿名注册 `/start` `/stop` 等于把进程控制暴露给本机任意网页。这里单独起一个
 * 只监听 `127.0.0.1` 的 HTTP 服务，页面从 URL fragment 取令牌，所有动作都要
 * `x-control-token`，并校验 Origin/Host；令牌只写本机状态目录，不进日志。
 *
 * 边界：
 * - 只启动/停止 `ManagedProcess` 自己记录的子进程；不接管外部 SnowLuma。
 * - 只执行固定的 launcher（`cmd.exe /c launcher.bat` 或 `bash ./launcher.sh`），
 *   不接受任意命令/参数。
 * - 启动成功不等于 QQ 已登录；状态只如实展示进程与桥接快照。
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { ManagedProcess, ManagedProcessLogLine } from './managed-process.js'
import { inspectSnowlumaDir, snowlumaLaunchSpec, type SnowlumaInfo } from './snowluma.js'

export interface QqControlBridge {
  connect: () => void
  disconnect: () => Promise<void>
  reconnect: () => void
  snapshot: () => unknown
}

export interface QqControlCenterOptions {
  /** 令牌与目录记忆写在这里；应是本机私有目录。 */
  stateDir: string
  manager: ManagedProcess
  /** 当前配置/记忆的 SnowLuma 目录。 */
  snowlumaDir: () => string
  /** 用户改目录时持久化；实现方只写自己的状态文件。 */
  setSnowlumaDir: (dir: string) => void
  bridge: QqControlBridge
  openBrowser: (url: string) => void
  logger?: { warn?: (message: string) => void }
}

export interface QqControlCenterStatus {
  ok: true
  snowluma: { info: SnowlumaInfo; process: unknown; logs: ManagedProcessLogLine[] }
  bridge: unknown
  control: { running: boolean; url: string }
  audit: QqControlAuditEntry[]
}

export interface QqControlAuditEntry {
  at: string
  action: string
  ok: boolean
  error?: string
}

const TOKEN_FILE = 'control-token'
const DIR_FILE = 'snowluma-dir.txt'
const MAX_BODY = 8192
const MAX_LINES = 120

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function timingSafeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(sha256(a))
  const right = Buffer.from(sha256(b))
  return left.length === right.length && left.equals(right)
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(text)
}

function readToken(stateDir: string): string {
  const file = join(stateDir, TOKEN_FILE)
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (/^[a-f0-9]{48}$/.test(existing)) return existing
  } catch {
    /* 首次运行 */
  }
  const token = randomBytes(24).toString('hex')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(file, token + '\n', { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    /* Windows 上 chmod 语义有限，保持默认 ACL */
  }
  return token
}

function readDir(stateDir: string): string {
  try {
    return readFileSync(join(stateDir, DIR_FILE), 'utf8').trim()
  } catch {
    return ''
  }
}

function writeDir(stateDir: string, dir: string): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, DIR_FILE), dir + '\n', { encoding: 'utf8' })
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const type = String(request.headers['content-type'] ?? '')
  if (!type.toLowerCase().startsWith('application/json')) return null
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > MAX_BODY) return null
    chunks.push(buf)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>心灵 · QQ 控制中心</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#0b1220;color:#dbe4f0;font:14px/1.6 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif}
main{max-width:760px;margin:0 auto;padding:28px}h1{font-size:20px;margin:0 0 4px}p.hint{color:#8fa3bd;margin:0 0 20px}
section{background:#121b2c;border:1px solid #22314a;border-radius:10px;padding:14px 16px;margin:0 0 14px}
h2{font-size:13px;letter-spacing:.08em;color:#8fa3bd;margin:0 0 10px;text-transform:uppercase}
button{background:#1d4ed8;color:#fff;border:0;border-radius:7px;padding:7px 12px;margin:4px 6px 4px 0;cursor:pointer}
button.secondary{background:#243247;color:#cfe0f5}button:disabled{opacity:.45;cursor:default}
input{width:100%;box-sizing:border-box;background:#0c1421;color:#dbe4f0;border:1px solid #2a3a55;border-radius:7px;padding:8px 10px}
pre{white-space:pre-wrap;word-break:break-all;max-height:280px;overflow:auto;background:#0c1421;border-radius:7px;padding:10px;font-size:12px}
.k{color:#8fa3bd}.v{color:#e6eefb}.row{display:flex;gap:10px;flex-wrap:wrap}.row>div{flex:1 1 180px}
#msg{min-height:20px;color:#f0b35b}
</style></head><body><main>
<h1>心灵 · QQ 控制中心</h1>
<p class="hint">本机独立窗口：令牌只在 URL fragment，不落日志；这里只管理心灵自己启动的进程。</p>
<section><h2>SnowLuma</h2>
<div class="row"><div><span class="k">状态</span> <span class="v" id="sl-state">—</span></div>
<div><span class="k">版本</span> <span class="v" id="sl-version">—</span></div>
<div><span class="k">PID</span> <span class="v" id="sl-pid">—</span></div>
<div><span class="k">WebUI</span> <span class="v" id="sl-webui">—</span></div></div>
<p><input id="dir" placeholder="SnowLuma 安装目录（含 package.json 与 launcher.bat）"></p>
<button id="save">保存目录</button>
<button id="start">启动</button><button id="stop" class="secondary">停止</button><button id="restart" class="secondary">重启</button>
<button id="webui" class="secondary">打开 WebUI</button><button id="check" class="secondary">检查更新</button>
<a id="dl" href="#" target="_blank" rel="noreferrer" style="display:none;color:#7dd3fc;margin-left:8px">下载页</a>
<p id="msg"></p></section>
<section><h2>QQ 桥接</h2><div id="bridge" class="v">—</div>
<button id="connect">连接</button><button id="disconnect" class="secondary">断开</button><button id="reconnect" class="secondary">重连</button><button id="btest" class="secondary">测试连接</button></section>
<section><h2>最近动作（最近 8 条，不含令牌）</h2><pre id="audit">—</pre></section>
<section><h2>运行日志（最近 ${MAX_LINES} 行）</h2><pre id="logs">—</pre></section>
</main><script>
const token = (location.hash || '').replace(/^#t=/, '');
async function call(path, body) {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: Object.assign({ 'x-control-token': token }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || '请求失败');
  return data;
}
function set(id, text) { document.getElementById(id).textContent = text; }
function msg(text) { set('msg', text); }
async function refresh() {
  try {
    const s = await call('/api/status');
    const sl = s.snowluma || {}; const info = sl.info || {}; const proc = sl.process || {};
    set('sl-state', proc.running ? '运行中' : (info.valid ? '未运行' : '目录无效'));
    set('sl-version', info.version || '—'); set('sl-pid', proc.pid == null ? '—' : String(proc.pid));
    set('sl-webui', info.webuiUrl || '—');
    document.getElementById('dir').value = info.dir || '';
    const b = s.bridge || {};
    const c = b.counts || {};
    const online = b.accountOnline === null || b.accountOnline === undefined ? '未知' : (b.accountOnline ? '在线' : '离线');
    set('bridge', '连接：' + (b.connection || 'unknown') + '；账号：' + online + '；收到/投递：' + (c.received == null ? '—' : c.received) + '/' + (c.delivered == null ? '—' : c.delivered) + '；私聊名单：' + (b.allowFromValid ? '有效' : '无效') + '；最近心跳：' + (b.lastHeartbeatAt || '—'));
    const lines = (sl.logs || []).slice(-${MAX_LINES}).map(l => '[' + l.stream + '] ' + l.text);
    set('logs', lines.length ? lines.join('\\n') : '—');
    const audit = (s.audit || []).slice(-8).map(a => a.at + '  ' + a.action + '  ' + (a.ok ? 'ok' : (a.error || 'failed')));
    set('audit', audit.length ? audit.join('\\n') : '—');
  } catch (e) { msg(String(e.message || e)); }
}
async function act(path, body) { try { await call(path, body || {}); msg('已提交'); await refresh(); } catch (e) { msg(String(e.message || e)); } }
document.getElementById('save').onclick = () => act('/api/snowluma/dir', { dir: document.getElementById('dir').value });
document.getElementById('start').onclick = () => act('/api/snowluma/start');
document.getElementById('stop').onclick = () => {
  if (confirm('停止心灵自己启动的 SnowLuma？外部实例不会被操作。')) act('/api/snowluma/stop', { confirm: true });
};
document.getElementById('restart').onclick = () => {
  if (confirm('重启心灵自己启动的 SnowLuma？外部实例不会被操作。')) act('/api/snowluma/restart', { confirm: true });
};
document.getElementById('webui').onclick = () => act('/api/snowluma/webui');
document.getElementById('check').onclick = async () => {
  try {
    const r = await call('/api/snowluma/check', {});
    const current = document.getElementById('sl-version').textContent || '—';
    if (r.ok && r.latest) {
      const link = document.getElementById('dl');
      if (r.url) { link.href = r.url; link.style.display = 'inline'; }
      msg(r.latest === current ? '已是最新版本 ' + current : '可更新：' + r.latest + '（当前 ' + current + '）');
    } else { msg('检查失败：' + (r.error || 'unknown')); }
  } catch (e) { msg(String(e.message || e)); }
};
document.getElementById('reconnect').onclick = () => act('/api/bridge/reconnect');
document.getElementById('connect').onclick = () => act('/api/bridge/connect');
document.getElementById('disconnect').onclick = () => act('/api/bridge/disconnect');
document.getElementById('btest').onclick = async () => {
  try {
    const r = await call('/api/bridge/test', {});
    msg(r.ok ? '连接正常' : '当前未连接：' + (r.connection || 'unknown'));
    await refresh();
  } catch (e) { msg(String(e.message || e)); }
};
refresh(); setInterval(refresh, 4000);
</script></body></html>`

export class QqControlCenter {
  readonly #options: QqControlCenterOptions
  readonly #token: string
  #server: Server | null = null
  #port = 0
  #audit: QqControlAuditEntry[] = []

  constructor(options: QqControlCenterOptions) {
    this.#options = options
    this.#token = readToken(options.stateDir)
    const remembered = readDir(options.stateDir)
    if (remembered && !options.snowlumaDir()) {
      options.setSnowlumaDir(remembered)
    }
  }

  get running(): boolean {
    return this.#server !== null
  }

  get port(): number {
    return this.#port
  }

  /** 启动（幂等）；返回带令牌 fragment 的页面地址，调用方负责打开浏览器。 */
  async ensureStarted(): Promise<{ url: string; token: string }> {
    if (this.#server !== null && this.#port > 0) {
      return { url: `http://127.0.0.1:${this.#port}/`, token: this.#token }
    }
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        this.#options.logger?.warn?.(`[psyche][qq-control] ${String(error)}`)
        if (!response.headersSent) json(response, 500, { ok: false, error: '内部错误' })
        else response.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.close()
      throw new Error('control-listen-failed')
    }
    this.#server = server
    this.#port = address.port
    return { url: `http://127.0.0.1:${this.#port}/`, token: this.#token }
  }

  async close(): Promise<void> {
    const server = this.#server
    this.#server = null
    this.#port = 0
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  #record(action: string, ok: boolean, error?: string): void {
    this.#audit.push({ at: new Date().toISOString(), action, ok, ...(error ? { error } : {}) })
    if (this.#audit.length > 50) this.#audit.splice(0, this.#audit.length - 50)
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/' && (request.method ?? 'GET') === 'GET') {
      response.statusCode = 200
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.end(PAGE)
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      json(response, 404, { ok: false, error: 'not-found' })
      return
    }
    if (!this.#originAllowed(request)) {
      json(response, 403, { ok: false, error: 'origin-rejected' })
      return
    }
    const token = String(request.headers['x-control-token'] ?? '')
    if (!timingSafeEqualText(token, this.#token)) {
      json(response, 401, { ok: false, error: 'unauthorized' })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      json(response, 200, this.status())
      return
    }
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const body = await readJsonBody(request)
    if (body === null) {
      json(response, 400, { ok: false, error: 'invalid-json' })
      return
    }
    const action = url.pathname
    if (action === '/api/snowluma/dir') {
      const dir = typeof body.dir === 'string' ? body.dir.trim() : ''
      const info = inspectSnowlumaDir(dir)
      if (!info.valid) {
        json(response, 400, { ok: false, error: info.error })
        return
      }
      writeDir(this.#options.stateDir, info.dir)
      this.#options.setSnowlumaDir(info.dir)
      json(response, 200, { ok: true, snowluma: info })
      return
    }
    if (action === '/api/snowluma/start' || action === '/api/snowluma/restart') {
      if (action === '/api/snowluma/restart' && body.confirm !== true) {
        this.#record('snowluma/restart', false, 'confirmation-required')
        json(response, 400, { ok: false, error: 'confirmation-required' })
        return
      }
      const info = inspectSnowlumaDir(this.#options.snowlumaDir())
      if (!info.valid) {
        this.#record(action === '/api/snowluma/restart' ? 'snowluma/restart' : 'snowluma/start', false, info.error)
        json(response, 409, { ok: false, error: info.error })
        return
      }
      const spec = snowlumaLaunchSpec(info)
      if (spec === null) {
        this.#record(action === '/api/snowluma/restart' ? 'snowluma/restart' : 'snowluma/start', false, 'launcher-missing')
        json(response, 409, { ok: false, error: 'launcher-missing' })
        return
      }
      const result = action === '/api/snowluma/restart'
        ? await this.#options.manager.restart({ name: 'snowluma', command: spec.command, args: spec.args, cwd: spec.cwd })
        : this.#options.manager.start({ name: 'snowluma', command: spec.command, args: spec.args, cwd: spec.cwd })
      if (!result.ok) {
        this.#record(action === '/api/snowluma/restart' ? 'snowluma/restart' : 'snowluma/start', false, result.error)
        const status = result.error === 'already-running' ? 409 : 500
        json(response, status, { ok: false, error: result.error })
        return
      }
      this.#record(action === '/api/snowluma/restart' ? 'snowluma/restart' : 'snowluma/start', true)
      json(response, 200, { ok: true })
      return
    }
    if (action === '/api/snowluma/stop') {
      if (body.confirm !== true) {
        this.#record('snowluma/stop', false, 'confirmation-required')
        json(response, 400, { ok: false, error: 'confirmation-required' })
        return
      }
      const result = await this.#options.manager.stop()
      if (!result.ok) {
        this.#record('snowluma/stop', false, result.error)
        json(response, result.error === 'not-running' ? 409 : 500, { ok: false, error: result.error })
        return
      }
      this.#record('snowluma/stop', true)
      json(response, 200, { ok: true })
      return
    }
    if (action === '/api/snowluma/webui') {
      const info = inspectSnowlumaDir(this.#options.snowlumaDir())
      if (!info.valid) {
        json(response, 409, { ok: false, error: info.error })
        return
      }
      this.#options.openBrowser(info.webuiUrl)
      json(response, 200, { ok: true })
      return
    }
    if (action === '/api/snowluma/check') {
      json(response, 200, await this.#checkUpdate())
      return
    }
    if (action === '/api/bridge/connect') {
      this.#options.bridge.connect()
      json(response, 200, { ok: true })
      return
    }
    if (action === '/api/bridge/disconnect') {
      await this.#options.bridge.disconnect()
      json(response, 200, { ok: true })
      return
    }
    if (action === '/api/bridge/reconnect') {
      this.#options.bridge.reconnect()
      json(response, 200, { ok: true })
      return
    }
    if (action === '/api/bridge/test') {
      const snapshot = this.#options.bridge.snapshot() as Record<string, unknown> | null
      const connection = typeof snapshot?.connection === 'string' ? snapshot.connection : 'unknown'
      json(response, 200, { ok: connection === 'connected', connection })
      return
    }
    json(response, 404, { ok: false, error: 'unknown-action' })
  }

  status(): QqControlCenterStatus {
    const info = inspectSnowlumaDir(this.#options.snowlumaDir())
    return {
      ok: true,
      snowluma: {
        info,
        process: this.#options.manager.snapshot(),
        logs: this.#options.manager.logs(MAX_LINES),
      },
      bridge: this.#options.bridge.snapshot(),
      control: { running: this.running, url: `http://127.0.0.1:${this.#port}/` },
      audit: this.#audit.slice(-20),
    }
  }

  #originAllowed(request: IncomingMessage): boolean {
    const host = String(request.headers.host ?? '')
    const expected = `127.0.0.1:${this.#port}`
    if (host !== expected && host !== `localhost:${this.#port}`) return false
    const origin = request.headers.origin
    if (origin === undefined) return true
    return origin === `http://${expected}` || origin === `http://localhost:${this.#port}`
  }

  async #checkUpdate(): Promise<{ ok: boolean; latest?: string; url?: string; error?: string }> {
    try {
      const response = await fetch('https://api.github.com/repos/SnowLuma/SnowLuma/releases/latest', {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-psyche-control-center' },
      })
      if (!response.ok) return { ok: false, error: 'check-failed' }
      const data = (await response.json()) as { tag_name?: unknown; html_url?: unknown }
      const latest = typeof data.tag_name === 'string' ? data.tag_name : ''
      const url = typeof data.html_url === 'string' ? data.html_url : ''
      return { ok: true, latest, url }
    } catch {
      return { ok: false, error: 'check-failed' }
    }
  }
}

/** 供测试/调用方确认状态目录里是否有令牌文件；不返回令牌。 */
export function hasControlToken(stateDir: string): boolean {
  return existsSync(join(stateDir, TOKEN_FILE))
}
