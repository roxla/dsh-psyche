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
import type { QqModelCatalog } from './qq-model-catalog.js'
import {
  QqOverlayConflictError,
  QqOverlayCorruptError,
  QqOverlayValidationError,
  QqSettingsOverlay,
  normalizeReplyRule,
  replyTargetKey,
  type QqOverlaySnapshot,
  type QqReplyRule,
  type QqReplyTarget,
} from './qq-settings-overlay.js'
import { inspectSnowlumaDir, snowlumaLaunchSpec, type SnowlumaInfo } from './snowluma.js'
import type { AssemblyReceiptStore } from './assembly-receipt.js'

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
  /**
   * Q5-E：只读组装回执。
   *
   * 缺省时 `/api/diagnostics/assemblies` 返回 `available:false`，
   * 这样测试部署不会凭空多出一个看起来有数据、其实从没记录过的诊断口。
   */
  receipts?: AssemblyReceiptStore
  /**
   * 访问控制与默认模型的覆盖层（Q1）。
   *
   * 缺省时控制中心不提供这两个编辑页——这样只在宿主侧被动运行的部署（例如测试）不用
   * 凭空多出一个写配置的入口。真正接线的宿主会传进来。
   */
  settings?: {
    overlay: QqSettingsOverlay
    /** 宿主插件配置里的 allowFrom（覆盖缺失时兜底）。 */
    hostAccess: () => { owner?: string; extra?: string[] } | undefined
    /** 宿主插件配置里的 provider / model / reasoningEffort。 */
    hostModel: () => { provider?: string; model?: string; reasoningEffort?: string } | undefined
    /**
     * 保存成功后让桥接换用新快照。
     *
     * 不重连、不重启：桥接在每次入站、入队和最终发送前都会重新读有效快照，
     * 这里只是立刻触发一次刷新，让界面上的状态与发送路径一致。
     */
    apply: (snapshot: QqOverlaySnapshot) => void
    /**
     * 迁移 37：写覆盖文件**之前**先把「打算怎么变」落盘。
     *
     * 缺省不调用（测试与一次性脚本）；生产由 `src/index.ts` 注入桥接的
     * `beginAccessChange`。顺序理由见 `#handleAccess` 里的注释。
     */
    prepareAccess?: (access: { owner: string; extra: string[] } | null) => void
    reapplyAccess?: () => { ok: boolean; peers: string[] }
    /**
     * 宿主的模型能力目录（Q1 模型选择）。
     *
     * 缺省时模型编辑页整体隐藏——宿主没有 llm 服务时不该给一个「能填但校验不了」的表单。
     */
    catalog?: QqModelCatalog
  }
  /**
   * QQ 工作区卡（第一批 · 五态）。
   *
   * 缺省时 `/api/workspace` 返回 503 `{available:false}`：只读形态的部署（测试、一次性脚本）
   * 没有工作区控制器，不该显示一张读不到真实状态的卡。
   */
  workspace?: {
    /** 现读一次：五态卡。形状由宿主的 `buildQqWorkspaceCard` 决定。 */
    snapshot: () => Promise<unknown>
    /** 只改显示名；目录与配置来源只读。 */
    rename: (title: string) => Promise<unknown>
  }
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

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 把覆盖层的三类错误映射成 HTTP 语义。
 *
 * 冲突带 `revision` 回去，页面可以立刻显示「别人刚改过」并刷新，不用用户自己猜；
 * 内容不合法只回 400 不写库；文件损坏回 500，因为此时**任何**写入都会被拒绝，
 * 属于要人工处理的状态而不是可重试的竞态。
 */
function mapOverlayError(error: unknown): { status: number; code: string; revision?: number } {
  if (error instanceof QqOverlayConflictError) {
    return { status: 409, code: error.code, revision: error.actual }
  }
  if (error instanceof QqOverlayValidationError) {
    return { status: 400, code: error.code }
  }
  if (error instanceof QqOverlayCorruptError) {
    return { status: 500, code: error.code }
  }
  return { status: 500, code: 'E_OVERLAY_UNKNOWN' }
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

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {  const type = String(request.headers['content-type'] ?? '')
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
/* 回复时段：对象表 + 编辑卡（第 45 轮 UI 收整，布局对齐效果图，配色沿用本页）。 */
.rs-table{border:1px solid #22314a;border-radius:8px;margin:8px 0 14px;overflow:hidden}
.rs-table .rs-line{display:flex;gap:10px;align-items:center;padding:8px 10px;border-bottom:1px solid #1b2740}
.rs-table .rs-line:last-child{border-bottom:0}
.rs-table .rs-line.rs-head{background:#121b2c;color:#8fa3bd;font-size:12px;letter-spacing:.04em}
.rs-table .rs-line.rs-item{cursor:pointer}
.rs-table .rs-line.rs-item[aria-selected="true"]{background:#16233a}
.rs-table .c-pick{flex:0 0 18px}.rs-table .c-type{flex:0 0 92px}.rs-table .c-target{flex:0 0 150px}
.rs-table .c-window{flex:1 1 auto;min-width:0;color:#e6eefb;font-size:13px}
.rs-table .rs-empty{padding:12px 10px;color:#8fa3bd;font-size:13px}
.rs-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:12px 0 0}
.rs-toolbar .t{font-size:13px;color:#e6eefb;font-weight:600}
#msg{min-height:20px;color:#f0b35b}
nav.views{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 16px}
nav.views button{background:#121b2c;border:1px solid #22314a;color:#9fb2c9;margin:0;font-size:13px}
nav.views button[aria-selected="true"]{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
section[data-view]{display:none}
body[data-active="status"] section[data-view="status"],
body[data-active="access"] section[data-view="access"],
body[data-active="model"] section[data-view="model"],
body[data-active="events"] section[data-view="events"],
body[data-active="logs"] section[data-view="logs"]{display:block}
html[data-embed="1"] h1,html[data-embed="1"] p.hint,html[data-embed="1"] nav.views{display:none}
html[data-embed="1"] main{max-width:none;padding:0}
</style></head><body><main>
<h1>心灵 · QQ 控制中心</h1>
<p class="hint">本机独立窗口：令牌只在 URL fragment，不落日志；这里只管理心灵自己启动的进程。嵌入 QQ 标签页时视图由宿主横向子导航驱动。</p>
<nav class="views" id="views" role="tablist" aria-label="控制中心视图">
<button type="button" role="tab" data-go="status" aria-selected="true">运行管理</button>
<button type="button" role="tab" data-go="access" aria-selected="false">访问与安全</button>
<button type="button" role="tab" data-go="model" aria-selected="false">模型与推理</button>
<button type="button" role="tab" data-go="events" aria-selected="false">诊断事件</button>
<button type="button" role="tab" data-go="logs" aria-selected="false">运行日志</button>
</nav>
<section data-view="status"><h2>SnowLuma</h2>
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
<section data-view="status"><h2>QQ 桥接</h2><div id="bridge" class="v">—</div>
<button id="connect">连接</button><button id="disconnect" class="secondary">断开</button><button id="reconnect" class="secondary">重连</button><button id="btest" class="secondary">测试连接</button></section>
<section data-view="status"><h2>QQ 工作区</h2>
<div class="row"><div><span class="k">状态</span> <span class="v" id="ws-state" data-ws-state="">—</span></div>
<div><span class="k">目录来源</span> <span class="v" id="ws-source">—</span></div>
<div><span class="k">会话成员</span> <span class="v" id="ws-members">—</span></div></div>
<p><span class="k">目录</span> <span class="v" id="ws-cwd">—</span></p>
<p><span class="k">期望名</span> <span class="v" id="ws-expected">—</span> <span class="k">宿主实际名</span> <span class="v" id="ws-actual">—</span></p>
<p><span class="k">目标会话</span> <span class="v" id="ws-target">—</span></p>
<p><span class="k">成员核验</span> <span class="v" id="ws-verify">—</span></p>
<p><span class="k">登记回执</span> <span class="v" id="ws-attempt">—</span> <span class="k">读回核验</span> <span class="v" id="ws-checked">—</span></p>
<p class="hint" id="ws-reason">—</p>
<div id="ws-edit" style="display:none">
<p><input id="ws-title" maxlength="40" placeholder="工作区显示名（最多 40 字）"></p>
<button id="ws-save">保存名称</button><button id="ws-cancel" class="secondary">取消</button></div>
<button id="ws-open" class="secondary">编辑工作区</button></section>
<section id="acc-section" data-view="access"><h2>访问与安全</h2>
<div class="row"><div><span class="k">主人</span> <span class="v" id="acc-owner">—</span></div>
<div><span class="k">额外允许</span> <span class="v" id="acc-extra">—</span></div>
<div><span class="k">来源</span> <span class="v" id="acc-source">—</span></div></div>
<p><input id="acc-owner-input" placeholder="主人 QQ 号（纯数字；留空=清除主人，所有私聊都会被拒绝）"></p>
<p><input id="acc-extra-input" placeholder="额外允许私聊的 QQ 号，用逗号或空格分隔"></p>
<button id="acc-save">保存</button>
<button id="acc-restore" class="secondary">恢复宿主配置</button>
<p class="hint" id="acc-note">保存后立即生效：入站、排队与最终发送前都会按新名单复核；撤销某个账号的授权会同时移除它对应的 QQ 工作区会话。</p>
<h2>允许回复时段</h2>
<p class="hint" id="rs-note">不设置＝继承原行为：名单、群回复开关、静默与限额照旧，时段只再加一道。私聊按 QQ 号、群按群号分别保存；时段外只记录诊断，不生成也不发送。</p>
<div class="rs-toolbar"><span class="t">已配置对象</span><button id="rs-goto-access" class="secondary" type="button">去管理名单</button></div>
<div id="rs-list" class="rs-table">—</div>
<div id="rs-editor" style="display:none">
<p><span class="k">对象</span> <span class="v" id="rs-target">—</span></p>
<p><select id="rs-mode"><option value="inherit">继承（删除规则）</option><option value="windows">自定义时段</option><option value="paused">暂停回复</option></select> <span id="rs-tz-wrap">时区 <input id="rs-tz" size="18" value="Asia/Shanghai" placeholder="Asia/Shanghai"></span></p>
<div id="rs-windows"></div>
<p><button id="rs-add" class="secondary">添加时段</button></p>
<button id="rs-save">保存</button> <button id="rs-cancel" class="secondary">取消</button>
<p class="hint" id="rs-tip">星期用 1–7（周一=1），时间用 HH:MM；结束早于开始表示跨夜，界面上显示为「次日」。</p>
</div></section>
<section id="model-section" data-view="model"><h2>模型与推理</h2>
<div class="row"><div><span class="k">当前选择</span> <span class="v" id="md-current">—</span></div>
<div><span class="k">来源</span> <span class="v" id="md-source">—</span></div>
<div><span class="k">推理档位</span> <span class="v" id="md-effort">—</span></div></div>
<p><select id="md-provider"></select> <select id="md-model"></select> <select id="md-effort-sel"></select></p>
<button id="md-save">保存</button>
<button id="md-restore" class="secondary">恢复宿主配置</button>
<p class="hint" id="md-note"></p></section>
<section id="events-section" data-view="events"><h2>诊断事件 · 组装回执</h2>
<div class="row"><div><span class="k">本进程保留</span> <span class="v" id="ev-size">—</span></div>
<div><span class="k">范围</span> <span class="v" id="ev-scope">最近 50 条</span></div></div>
<pre id="events">—</pre>
<button id="ev-refresh" class="secondary">刷新</button>
<p class="hint" id="ev-note">只驻留内存、最多 200 条；只记块名、字符数、来源 ID，不含提示正文、消息内容与完整身份。</p></section>
<section data-view="logs"><h2>最近动作（最近 8 条，不含令牌）</h2><pre id="audit">—</pre></section>
<section data-view="logs"><h2>运行日志（最近 ${MAX_LINES} 行）</h2><pre id="logs">—</pre></section>
</main><script>
const HASH_PARAMS = new URLSearchParams((location.hash || '').replace(/^#/, ''));
const token = HASH_PARAMS.get('t') || '';
const VIEWS = ['status', 'access', 'model', 'events', 'logs'];
let activeView = VIEWS.indexOf(HASH_PARAMS.get('v')) >= 0 ? HASH_PARAMS.get('v') : 'status';
// 嵌入判定只看与本窗口的父子关系：同源 iframe 与独立窗口的唯一区别就是 parent。
const embed = window.parent !== window;
if (embed) document.documentElement.dataset.embed = '1';
// 父页 origin：iframe 的 referrer 就是宿主页面地址，取它的精确 origin。
// 取不到就先留空，等父页第一条消息再学一次（那时 source 已核对是 parent）；
// 无论哪种情况都不往 '*' 发——GPT 第 1 轮第 3 条。
const REFERRER_ORIGIN = (function () { try { return document.referrer ? new URL(document.referrer).origin : ''; } catch (e) { return ''; } })();
let hostOrigin = REFERRER_ORIGIN;
/** 只有嵌入时才向宿主说话；独立窗口不该有任何 parent 消息。 */
function post(type, extra) {
  if (!embed || hostOrigin === '') return;
  try { window.parent.postMessage(Object.assign({ type: type }, extra || {}), hostOrigin); } catch (e) { /* 宿主不在时不报错 */ }
}
/** 宿主按高度自适应 iframe；量 documentElement，避免 body 边距被漏掉。 */
function reportHeight() {
  if (!embed) return;
  const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
  if (height > 0) post('psyche:qq:height', { height: height });
}
function tabs() { return document.querySelectorAll('#views [data-go]'); }
function setViewAvailable(id, available) {
  const button = document.querySelector('#views [data-go="' + id + '"]');
  if (button) button.style.display = available ? '' : 'none';
  if (!available && activeView === id) setView('status');
}
function enterView(id) {
  if (id === 'status' || id === 'logs') refresh();
  else if (id === 'access') { refreshAccess(); rsRefresh(); }
  else if (id === 'model') refreshModel();
  else if (id === 'events') refreshEvents();
  // 工作区卡只在状态视图里；它读的是宿主 workspace/follow，跟 /api/status 不是一路。
  if (id === 'status') refreshWorkspace();
}
function setView(id) {
  if (VIEWS.indexOf(id) < 0) return;
  activeView = id;
  document.body.dataset.active = id;
  const all = tabs();
  for (let i = 0; i < all.length; i += 1) all[i].setAttribute('aria-selected', all[i].getAttribute('data-go') === id ? 'true' : 'false');
  // 独立窗口把视图写回 fragment；嵌入时 URL 属于宿主，不改。
  if (!embed) {
    const params = new URLSearchParams();
    params.set('t', token);
    params.set('v', id);
    history.replaceState(null, '', '#' + params.toString());
  }
  enterView(id);
  reportHeight();
}
async function call(path, body) {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: Object.assign({ 'x-control-token': token }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || '请求失败');
  return data;
}
function set(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
/** 页内提示；消息同时上报宿主，页面收起时用户仍能看到结果。 */
function msg(text) { set('msg', text); post('psyche:qq:toast', { text: String(text || '') }); }
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
    } else { msg('官方更新源暂不可用，请稍后重试'); }
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
// ── 访问与安全（Q1） ──────────────────────────────────────────────────────────
// 保存后不重连：桥接在下一条入站消息、入队和最终发送前都会重新读有效快照。
let accessRevision = 0;
function splitIds(text) {
  return String(text || '').split(/[,，\\s]+/).map(x => x.trim()).filter(x => x !== '');
}
function renderAccess(a) {
  if (a.available === false) { setViewAvailable('access', false); return; }
  setViewAvailable('access', true);
  if (a.corrupt) {
    set('acc-owner', '—'); set('acc-extra', '—'); set('acc-source', '覆盖文件损坏');
    document.getElementById('acc-note').textContent = '覆盖文件无法解析，任何保存都会被拒绝：' + (a.error || '') + '（文件：' + (a.overlayFile || '') + '）';
    return;
  }
  accessRevision = a.revision || 0;
  set('acc-owner', a.owner ? a.owner : '（未设置）');
  set('acc-extra', (a.extra && a.extra.length) ? a.extra.join('、') : '（无）');
  set('acc-source', a.source === 'overlay' ? '来自插件覆盖' : '来自宿主配置');
  document.getElementById('acc-owner-input').value = a.owner || '';
  document.getElementById('acc-extra-input').value = (a.extra || []).join(', ');
}
async function refreshAccess() {
  try { renderAccess(await call('/api/access')); } catch (e) { set('acc-source', String(e.message || e)); }
}
async function saveAccess(path, body) {
  try {
    const r = await call(path, Object.assign({ revision: accessRevision }, body));
    renderAccess(r); msg('已保存并生效');
  } catch (e) {
    msg(String(e.message || e));
    // 冲突说明别的标签页先改过：拉一次最新值，避免用户对着旧表单反复失败。
    await refreshAccess();
  }
}
document.getElementById('acc-save').onclick = () => saveAccess('/api/access', {
  owner: document.getElementById('acc-owner-input').value.trim(),
  extra: splitIds(document.getElementById('acc-extra-input').value),
});
document.getElementById('acc-restore').onclick = () => {
  if (confirm('恢复宿主配置？这会删掉插件的覆盖记录，让这一组重新跟随宿主设置。')) saveAccess('/api/access/clear', {});
};
// ── 允许回复时段（第二批） ─────────────────────────────────────────────────
// 规则不授予任何权力：只在上层名单与群开关之后，再收紧「什么时候可以回复」。
const RS_DAYS = ['一', '二', '三', '四', '五', '六', '日'];
let rsRevision = 0;
let rsItems = [];
let rsTarget = null;
function rsMask(id) {
  const text = String(id || '');
  return text.length <= 4 ? text : text.slice(0, 2) + '****' + text.slice(-2);
}
function rsPad(n) { const s = String(n); return s.length < 2 ? '0' + s : s; }
function rsTimeText(minute) { return rsPad(Math.floor(minute / 60)) + ':' + rsPad(minute % 60); }
function rsParseTime(text) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function rsRuleText(rule) {
  if (rule === null || rule === undefined) return '继承';
  if (rule.mode === 'paused') return '暂停回复';
  const out = [];
  const list = rule.windows || [];
  for (const w of list) {
    const days = [];
    for (const d of (w.days || [])) days.push(RS_DAYS[d - 1] || '?');
    const cross = w.endMinute < w.startMinute ? '次日' : '';
    out.push('周' + days.join('') + ' ' + rsTimeText(w.startMinute) + '–' + cross + rsTimeText(w.endMinute));
  }
  return (rule.timeZone || '—') + '：' + (out.length ? out.join('；') : '无时段');
}
function rsRender() {
  const box = document.getElementById('rs-list');
  // 第 46 轮评委：切对象后表格整块重绘，焦点会跟着节点一起没掉；键盘用户按方向键切完就
  // 停在 body 上。重绘前记住「焦点原本在表格的单选钮上」，重绘后把它放回当前选中行。
  const activeBefore = document.activeElement;
  const restoreFocus = box !== null && activeBefore !== null && box.contains(activeBefore) && activeBefore.tagName === 'INPUT';
  box.textContent = '';
  if (!rsItems.length) {
    const empty = document.createElement('div');
    empty.className = 'rs-empty';
    empty.textContent = '还没有可配置的对象：先在上方「访问与安全」里保存主人 / 额外允许的 QQ 号，或配上群白名单。';
    box.appendChild(empty);
    return;
  }
  const head = document.createElement('div');
  head.className = 'rs-line rs-head';
  const headCells = [['c-pick', ''], ['c-type', '类型'], ['c-target', '对象'], ['c-window', '允许回复时段']];
  for (const pair of headCells) {
    const cell = document.createElement('span');
    cell.className = pair[0];
    cell.textContent = pair[1];
    head.appendChild(cell);
  }
  box.appendChild(head);
  for (const item of rsItems) {
    const selected = rsTarget !== null && rsTarget.kind === item.kind && rsTarget.id === item.id;
    const row = document.createElement('div');
    row.className = 'rs-line rs-item';
    row.setAttribute('aria-selected', selected ? 'true' : 'false');
    const pick = document.createElement('input');
    pick.type = 'radio';
    pick.name = 'rs-target';
    pick.className = 'c-pick';
    pick.checked = selected;
    pick.style.width = 'auto';
    const type = document.createElement('span');
    type.className = 'c-type';
    type.textContent = item.kind === 'group' ? 'QQ 群' : '私聊 QQ';
    const target = document.createElement('span');
    target.className = 'c-target';
    target.textContent = rsMask(item.id) + (item.authorized ? '' : '（已失去授权）');
    const windowText = document.createElement('span');
    windowText.className = 'c-window';
    windowText.textContent = rsRuleText(item.rule);
    row.appendChild(pick);
    row.appendChild(type);
    row.appendChild(target);
    row.appendChild(windowText);
    row.onclick = () => { if (!selected) rsEdit(item); };
    box.appendChild(row);
  }
  if (restoreFocus) {
    const checked = box.querySelector('input[type=radio]:checked');
    if (checked !== null) checked.focus();
  }
}
function rsWindowRow(dayText, startText, endText) {
  const row = document.createElement('p');
  row.dataset.role = 'window';
  const days = document.createElement('input');
  days.value = dayText;
  days.size = 12;
  days.placeholder = '1,2,3（周一=1）';
  const start = document.createElement('input');
  start.value = startText;
  start.size = 6;
  start.placeholder = '22:00';
  const end = document.createElement('input');
  end.value = endText;
  end.size = 6;
  end.placeholder = '02:00';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'secondary';
  del.textContent = '删除';
  del.onclick = () => row.parentNode.removeChild(row);
  row.appendChild(days);
  row.appendChild(document.createTextNode(' '));
  row.appendChild(start);
  row.appendChild(document.createTextNode('–'));
  row.appendChild(end);
  row.appendChild(document.createTextNode(' '));
  row.appendChild(del);
  return row;
}
function rsReadWindows() {
  const windows = [];
  const rows = document.querySelectorAll('#rs-windows p[data-role="window"]');
  for (const row of rows) {
    const inputs = row.querySelectorAll('input');
    const rawDays = String(inputs[0].value || '').split(/[,，\\s]+/);
    const days = [];
    for (const part of rawDays) {
      if (part === '') continue;
      const d = Number(part);
      if (!Number.isInteger(d) || d < 1 || d > 7) throw new Error('星期只能写 1–7（周一=1）');
      if (days.indexOf(d) < 0) days.push(d);
    }
    days.sort((a, b) => a - b);
    if (!days.length) throw new Error('每段至少要选一天');
    const startMinute = rsParseTime(inputs[1].value);
    const endMinute = rsParseTime(inputs[2].value);
    if (startMinute === null || endMinute === null) throw new Error('时间要写成 HH:MM（例如 22:00）');
    windows.push({ days: days, startMinute: startMinute, endMinute: endMinute });
  }
  return windows;
}
function rsSyncMode() {
  const mode = document.getElementById('rs-mode').value;
  const open = mode === 'windows';
  document.getElementById('rs-tz-wrap').style.display = open ? '' : 'none';
  document.getElementById('rs-windows').style.display = open ? '' : 'none';
  document.getElementById('rs-add').style.display = open ? '' : 'none';
}
function rsShow(show) { document.getElementById('rs-editor').style.display = show ? '' : 'none'; }
function rsEdit(item) {
  rsTarget = item;
  set('rs-target', (item.kind === 'group' ? '群 ' : '私聊 ') + rsMask(item.id) + (item.authorized ? '' : '（已失去授权）'));
  const rule = item.rule;
  document.getElementById('rs-mode').value = (rule === null || rule === undefined) ? 'inherit' : rule.mode;
  document.getElementById('rs-tz').value = (rule && rule.timeZone) ? rule.timeZone : 'Asia/Shanghai';
  const box = document.getElementById('rs-windows');
  box.textContent = '';
  if (rule && rule.mode === 'windows') {
    for (const w of (rule.windows || [])) {
      box.appendChild(rsWindowRow((w.days || []).join(','), rsTimeText(w.startMinute), rsTimeText(w.endMinute)));
    }
  }
  rsSyncMode();
  rsShow(true);
  // 选中态画在表的行上，切对象后重绘一次（不重新拉数据）。
  rsRender();
}
async function rsRefresh() {
  try {
    const r = await call('/api/reply-schedules');
    if (r.available === false) { set('rs-list', '当前没有可用的设置存储，时段无法保存。'); return; }
    rsRevision = r.revision || 0;
    rsItems = r.items || [];
    rsRender();
  } catch (e) {
    set('rs-list', '读取失败：' + String(e.message || e));
  }
}
async function rsSave() {
  if (rsTarget === null) return;
  const mode = document.getElementById('rs-mode').value;
  let rule = null;
  try {
    if (mode === 'paused') rule = { mode: 'paused' };
    else if (mode === 'windows') {
      const tz = String(document.getElementById('rs-tz').value || '').trim() || 'Asia/Shanghai';
      const windows = rsReadWindows();
      if (!windows.length) throw new Error('自定义时段至少要留一段');
      rule = { mode: 'windows', timeZone: tz, windows: windows };
    }
  } catch (e) { msg(String(e.message || e)); return; }
  try {
    const r = await call('/api/reply-schedules', { revision: rsRevision, target: { kind: rsTarget.kind, id: rsTarget.id }, rule: rule });
    rsRevision = r.revision || 0;
    rsItems = r.items || [];
    rsRender();
    rsShow(false);
    msg('已保存并生效');
  } catch (e) {
    // 冲突时保留草稿：表单不动，用户能看到自己填的内容再决定是否重存。
    msg('保存失败：' + String(e.message || e));
  }
}
document.getElementById('rs-mode').onchange = rsSyncMode;
document.getElementById('rs-add').onclick = () => {
  document.getElementById('rs-windows').appendChild(rsWindowRow('1,2,3,4,5', '09:00', '18:00'));
};
document.getElementById('rs-save').onclick = () => rsSave();
document.getElementById('rs-cancel').onclick = () => rsShow(false);
// 对象本身来自主人/额外允许/群白名单，这里不给「凭空新建」，只把人带到能加号的那一栏。
document.getElementById('rs-goto-access').onclick = () => {
  setView('access');
  const owner = document.getElementById('acc-owner-input');
  if (owner) owner.focus();
};
// ── 默认模型（Q1） ───────────────────────────────────────────────────────────
// 目录整体不可用时禁用保存：宁可让用户看见「目录不可用」，
// 也不要让他保存一个校验不了的组合再在发送时失败。
let modelRevision = 0;
let modelCatalog = { providers: [], models: [], efforts: [] };
function fillSelect(id, items, valueKey, labelKey, value) {
  const el = document.getElementById(id);
  el.textContent = '';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item[valueKey];
    option.textContent = item[labelKey] || item[valueKey];
    if (item[valueKey] === value) option.selected = true;
    el.appendChild(option);
  }
}
function modelsOf(provider) {
  return (modelCatalog.models || []).filter(m => m.provider === provider);
}
function renderEfforts(list, selected) {
  const el = document.getElementById('md-effort-sel');
  el.textContent = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = list.length ? '（跟随提供方默认）' : '（该模型没有档位）';
  if (!selected) none.selected = true;
  el.appendChild(none);
  for (const effort of list) {
    const option = document.createElement('option');
    option.value = effort.id;
    option.textContent = effort.name || effort.id;
    if (effort.id === selected) option.selected = true;
    el.appendChild(option);
  }
  el.disabled = list.length === 0;
}
async function loadEfforts(selected) {
  const provider = document.getElementById('md-provider').value;
  const model = document.getElementById('md-model').value;
  if (!provider || !model) { renderEfforts([], ''); return; }
  try {
    const r = await call('/api/model/efforts?provider=' + encodeURIComponent(provider) + '&model=' + encodeURIComponent(model));
    renderEfforts(r.available === false ? [] : (r.efforts || []), r.available === false ? '' : selected);
    if (r.available === false) set('md-note', '档位查询失败：' + (r.error || '原因未知'));
  } catch (e) {
    renderEfforts([], ''); set('md-note', String(e.message || e));
  }
}
function renderModel(v) {
  if (v.available === false) { setViewAvailable('model', false); return; }
  setViewAvailable('model', true);
  if (v.corrupt) {
    set('md-current', '—'); set('md-source', '覆盖文件损坏');
    document.getElementById('md-note').textContent = '覆盖文件无法解析，任何保存都会被拒绝：' + (v.error || '') + '（文件：' + (v.overlayFile || '') + '）';
    return;
  }
  modelRevision = v.revision || 0;
  modelCatalog = v.catalog || { providers: [], models: [], efforts: [] };
  const saved = v.saved || {};
  const catalogOk = v.catalogSource === 'host';
  set('md-current', (saved.provider || '（未设置）') + ' / ' + (saved.model || '（未设置）'));
  set('md-source', v.source === 'overlay' ? '来自插件覆盖' : '来自宿主配置');
  set('md-effort', saved.reasoningEffort ? saved.reasoningEffort + '（已保存，本版不生效）' : '—');
  fillSelect('md-provider', modelCatalog.providers || [], 'id', 'name', saved.provider || '');
  fillSelect('md-model', modelsOf(saved.provider || ''), 'id', 'name', saved.model || '');
  document.getElementById('md-provider').disabled = !catalogOk;
  document.getElementById('md-model').disabled = !catalogOk;
  document.getElementById('md-save').disabled = !catalogOk;
  const note = document.getElementById('md-note');
  if (!catalogOk) {
    note.textContent = '模型目录不可用（' + (v.catalogError || '原因未知') + '），无法校验，保存已禁用。';
  } else {
    note.textContent = '保存后立即写入覆盖文件；QQ 会话在下一次新建 Agent 时采用新模型。推理档位本版只保存，不随请求发送（宿主 loop 的请求对象是只读的，插件无法在发送前改写）。';
  }
  if (catalogOk) loadEfforts(saved.reasoningEffort || '');
}
async function refreshModel() {
  try { renderModel(await call('/api/model')); } catch (e) { set('md-note', String(e.message || e)); }
}
async function saveModel(path, body) {
  try {
    const r = await call(path, Object.assign({ revision: modelRevision }, body));
    renderModel(r); msg('已保存默认模型');
  } catch (e) {
    msg(String(e.message || e));
    await refreshModel();
  }
}
document.getElementById('md-provider').onchange = () => {
  const provider = document.getElementById('md-provider').value;
  fillSelect('md-model', modelsOf(provider), 'id', 'name', '');
  loadEfforts('');
};
document.getElementById('md-model').onchange = () => loadEfforts('');
document.getElementById('md-save').onclick = () => saveModel('/api/model', {
  provider: document.getElementById('md-provider').value,
  model: document.getElementById('md-model').value,
  reasoningEffort: document.getElementById('md-effort-sel').value,
});
document.getElementById('md-restore').onclick = () => {
  if (confirm('恢复宿主配置？这会删掉默认模型的覆盖记录，让这一组重新跟随宿主设置。')) saveModel('/api/model/clear', {});
};
// ── 诊断事件（Q5-E 组装回执） ────────────────────────────────────────────────
// 只读：说清「这一轮到底往提示里放了什么」，命中被预算裁掉、渠道挡住、根本没调，三者分开。
const WS_LABELS = { registered: '已登记', unverified: '未核实', unavailable: '不可用', pending: '待登记', 'needs-review': '需人工核对' };
const WS_SOURCES = { config: '配置 qq.cwd', default: '默认（数据目录同级）', unknown: '未知' };
const WS_ERRORS = {
  'missing-title': '请填写工作区名称',
  'invalid-title': '名称留空、超过 40 字或含换行都不行',
  unavailable: '这个宿主没有提供工作区服务',
  'rename-failed': '改名失败，稍后再试',
  'workspace-read-failed': '读工作区状态失败',
};
let workspaceCard = null;
function renderWorkspace(card) {
  workspaceCard = card && card.ok === true ? card : null;
  const state = workspaceCard ? workspaceCard.state : 'unavailable';
  const badge = document.getElementById('ws-state');
  if (badge) {
    badge.textContent = WS_LABELS[state] || state;
    badge.setAttribute('data-ws-state', state);
  }
  set('ws-cwd', workspaceCard && workspaceCard.cwd ? workspaceCard.cwd : '—');
  set('ws-source', WS_SOURCES[workspaceCard ? workspaceCard.cwdSource : 'unknown'] || '未知');
  const expected = workspaceCard && workspaceCard.expectedTitle ? workspaceCard.expectedTitle : 'QQ 聊天';
  const actual = workspaceCard && workspaceCard.actualTitle ? workspaceCard.actualTitle : '';
  set('ws-expected', expected);
  set('ws-actual', actual === '' ? '—' : actual + (actual === expected ? '' : '（与期望不一致）'));
  set('ws-members', workspaceCard && typeof workspaceCard.memberCount === 'number' ? String(workspaceCard.memberCount) : '未知');
  // 目标会话：本进程最近一次会话级登记针对的那条。没登记过就说没有，不拿成员数冒充。
  set('ws-target', workspaceCard && workspaceCard.targetSessionId ? workspaceCard.targetSessionId : '本进程未登记过会话');
  var verify = workspaceCard ? workspaceCard.memberVerify : null;
  set('ws-verify', verify === 'contains' ? '清单里已包含它' : verify === 'missing' ? '清单里还没有它' : '读不到成员 id，无法核对');
  const attempt = workspaceCard && workspaceCard.attempt
    ? (workspaceCard.attempt.ok ? '成功' : '失败') + ' · ' + workspaceCard.attempt.step + ' · ' + workspaceCard.attempt.at
    : '还没有登记记录';
  set('ws-attempt', attempt);
  // 没有有效读回时不能显示上一轮的时间：那会让「未核实」看起来像刚核验过。
  set('ws-checked', workspaceCard && workspaceCard.readAt
    ? (workspaceCard.checkedAt || '—')
    : '未核验');
  set('ws-reason', workspaceCard && workspaceCard.reason ? workspaceCard.reason : '');
  const open = document.getElementById('ws-open');
  if (open) open.style.display = state === 'unavailable' ? 'none' : '';
  if (state === 'unavailable') hideWorkspaceForm();
}
function showWorkspaceForm() {
  const box = document.getElementById('ws-edit');
  const input = document.getElementById('ws-title');
  if (input) input.value = workspaceCard && workspaceCard.actualTitle ? workspaceCard.actualTitle : 'QQ 聊天';
  if (box) box.style.display = '';
  reportHeight();
}
function hideWorkspaceForm() {
  const box = document.getElementById('ws-edit');
  if (box) box.style.display = 'none';
  reportHeight();
}
async function refreshWorkspace() {
  try {
    renderWorkspace(await call('/api/workspace'));
  } catch (e) {
    renderWorkspace(null);
  }
}
async function saveWorkspaceTitle() {
  const input = document.getElementById('ws-title');
  const title = input ? String(input.value || '').trim() : '';
  if (title === '') { msg(WS_ERRORS['invalid-title']); return; }
  try {
    renderWorkspace(await call('/api/workspace', { title: title }));
    hideWorkspaceForm();
    msg('工作区名称已保存');
  } catch (e) {
    msg(WS_ERRORS[String(e.message || e)] || String(e.message || e));
  }
}
async function refreshEvents() {
  try {
    const r = await call('/api/diagnostics/assemblies?limit=50');
    const items = (r && r.items) || [];
    set('ev-size', r && r.available === false ? '不可用' : String(items.length));
    if (r && r.available === false) {
      set('events', '—');
      set('ev-note', '本次进程里没有组装回执：可能还没跑过一轮，或宿主没有接上注入。');
      return;
    }
    const lines = items.map(item => {
      const blocks = item.blocks || [];
      const kept = blocks.filter(b => b.kept).length;
      const dropped = blocks.filter(b => !b.kept && b.reason !== 'empty').length;
      const channel = (item.receiver && item.receiver.channel) || 'unknown';
      const tokens = item.usedTokens == null ? '—' : item.usedTokens;
      return item.at + '  ' + channel + '  ' + tokens + ' tokens  ' + kept + ' 块入内 / ' + dropped + ' 块被弃';
    });
    set('events', lines.length ? lines.join('\\n') : '—');
  } catch (e) { set('events', String(e.message || e)); }
}
document.getElementById('ev-refresh').onclick = () => { refreshEvents().then(reportHeight); };
document.getElementById('ws-open').onclick = () => showWorkspaceForm();
document.getElementById('ws-save').onclick = () => { saveWorkspaceTitle().then(reportHeight); };
document.getElementById('ws-cancel').onclick = () => hideWorkspaceForm();
for (const button of tabs()) {
  button.onclick = () => setView(button.getAttribute('data-go'));
}
document.body.dataset.active = activeView;
enterView(activeView);
setInterval(() => { if (activeView === 'status' || activeView === 'logs') refresh(); }, 4000);
if (embed) {
  // 先握手再量高度：宿主收到 ready 才下发当前 view，加载期间的点击以最后一次为准。
  post('psyche:qq:ready', { view: activeView });
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => reportHeight()) : null;
  if (observer) observer.observe(document.body);
  window.addEventListener('load', () => reportHeight());
  window.addEventListener('resize', () => reportHeight());
  window.addEventListener('message', event => {
    // 只认父窗口；视图只接受五个固定值，其余消息一律丢弃（宿主契约，不当数据用）。
    if (event.source !== window.parent) return;
    // 父页 origin 必须与我们认定的宿主 origin 一致。referrer 为空时不能随便认——
    // 只有「一条合格的视图消息」才允许锁定宿主 origin，别的消息不许抢先占位
    // （否则任意一帧都能把来源钉死，后面的真消息全被挡）。GPT 第 2 轮第 3 条。
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (hostOrigin === '') {
      if (data.type !== 'psyche:qq:view') return;
      if (typeof data.view !== 'string' || VIEWS.indexOf(data.view) < 0) return;
      hostOrigin = event.origin;
    } else if (event.origin !== hostOrigin) {
      return;
    }
    // 宿主卡上的「编辑工作区」：切到运行管理并就地展开表单（不重签令牌、不重建页面）。
    if (data.type === 'psyche:qq:action' && data.action === 'workspace-edit') {
      setView('status');
      showWorkspaceForm();
      return;
    }
    if (data.type !== 'psyche:qq:view') return;
    const view = typeof data.view === 'string' ? data.view : '';
    if (VIEWS.indexOf(view) < 0) return;
    setView(view);
  });
  reportHeight();
}
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

  /**
   * 访问控制组的展示视图。
   *
   * 覆盖文件损坏时**不**退回宿主值假装正常：那样用户会以为当前生效的是宿主配置，
   * 而桥接仍可能持有上一次已验证的快照。这里明确标 `corrupt`，让页面显示红色提示。
   */
  #accessView(): Record<string, unknown> {
    const settings = this.#options.settings
    if (settings === undefined) return { ok: true, available: false }
    try {
      const snapshot = settings.overlay.effective(settings.hostAccess(), settings.hostModel())
      return {
        ok: true,
        available: true,
        corrupt: false,
        overlayFile: settings.overlay.file,
        revision: snapshot.revision,
        hasOverride: snapshot.hasAccessOverride,
        source: snapshot.accessSource,
        owner: snapshot.access.owner,
        extra: snapshot.access.extra,
      }
    } catch (error) {
      return {
        ok: true,
        available: true,
        corrupt: true,
        error: errorText(error),
        overlayFile: settings.overlay.file,
      }
    }
  }

  /**
   * 保存或恢复访问控制组。
   *
   * 三种结果分开返回，让页面能给出不同动作：400 改表单、409 刷新后重提交、500 让人看文件。
   */
  async #handleAccess(
    response: ServerResponse,
    mode: 'save' | 'clear',
    body: Record<string, unknown>,
  ): Promise<void> {
    const settings = this.#options.settings
    if (settings === undefined) {
      json(response, 409, { ok: false, error: 'settings-unavailable' })
      return
    }
    const expectedRevision = typeof body.revision === 'number' ? body.revision : Number.NaN
    const action = mode === 'clear' ? 'access/clear' : 'access/save'
    try {
      // 迁移 37 的两阶段顺序（评审第 41 轮）：先记「打算怎么变」，再写覆盖文件。
      // 反过来做的话，只要覆盖文件写成功、后面任何一步失败，磁盘上就留下一份
      // 「名单已改、没人记得这次变更没走完」的状态——重启后最容易放行旧任务。
      // `groups` 必须一起带过去：覆盖层的 normalizeQqAccess 把「缺省」当空数组，
      // 少了这一项，保存私聊名单就会顺手把白名单群清空（开发文档 §1 的数据往返问题）。
      // 语义沿用文档：请求里没带 groups = 保留当前生效值，显式传 [] 才是清空。
      const before = settings.overlay.effective(settings.hostAccess(), settings.hostModel())
      const nextGroups = Array.isArray(body.groups)
        ? body.groups.map(String)
        : before.access.groups
      const proposed = mode === 'clear'
        ? null
        : {
            owner: typeof body.owner === 'string' ? body.owner : '',
            extra: Array.isArray(body.extra) ? body.extra.map(String) : [],
            groups: nextGroups,
          }
      if (settings.prepareAccess !== undefined) settings.prepareAccess(proposed)
      if (mode === 'clear') {
        await settings.overlay.clearAccess(expectedRevision)
      } else {
        await settings.overlay.saveAccess(
          {
            owner: typeof body.owner === 'string' ? body.owner : '',
            extra: Array.isArray(body.extra) ? body.extra.map(String) : [],
            groups: nextGroups,
          },
          expectedRevision,
        )
      }
      // 发布新快照：桥接在入站、入队与最终发送前都会读它，所以这里不需要重连。
      const snapshot = settings.overlay.effective(settings.hostAccess(), settings.hostModel())
      settings.apply(snapshot)
      this.#record(action, true)
      this.#options.logger?.warn?.(`[psyche][qq-control] ${action} ok，owner=${snapshot.access.owner === '' ? '（空）' : snapshot.access.owner}，extra=${snapshot.access.extra.length} 个`)
      json(response, 200, this.#accessView())
    } catch (error) {
      const mapped = mapOverlayError(error)
      this.#record(action, false, mapped.code)
      json(response, mapped.status, {
        ok: false,
        error: mapped.code,
        message: errorText(error),
        revision: mapped.revision,
      })
    }
  }

  /**
   * 默认模型这一组的视图。
   *
   * 目录不可用时**不能**拿上一次保存值冒充「当前可选」，否则用户会以为保存成功的是
   * 一个可用的模型。这里分开返回 `catalogSource` 与 `saved`，页面据此禁用保存。
   */
  async #modelView(): Promise<Record<string, unknown>> {
    const settings = this.#options.settings
    if (settings === undefined) return { ok: true, available: false }
    try {
      const snapshot = settings.overlay.effective(settings.hostAccess(), settings.hostModel())
      const base: Record<string, unknown> = {
        ok: true,
        available: true,
        corrupt: false,
        overlayFile: settings.overlay.file,
        revision: snapshot.revision,
        hasOverride: snapshot.hasModelOverride,
        source: snapshot.modelSource,
        saved: {
          provider: snapshot.modelSelection.provider ?? '',
          model: snapshot.modelSelection.model ?? '',
          ...(snapshot.modelSelection.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: snapshot.modelSelection.reasoningEffort }),
        },
        // effort 在当前版本只保存不生效：loop 构造的请求是 deep-frozen 的，
        // 插件无法在 llm/stream 里改写。页面必须把这点显式告诉用户。
        effortEffective: false,
      }
      if (settings.catalog === undefined) {
        base.catalogSource = 'unavailable'
        base.catalogError = '宿主没有提供模型目录'
        base.catalog = { providers: [], models: [], efforts: [] }
        return base
      }
      const catalog = await settings.catalog.view()
      base.catalogSource = catalog.available ? 'host' : 'unavailable'
      if (!catalog.available && catalog.error !== undefined) base.catalogError = catalog.error
      base.catalog = {
        providers: catalog.providers,
        models: catalog.models,
        efforts: catalog.efforts,
        ...(catalog.defaultEffort === undefined ? {} : { defaultEffort: catalog.defaultEffort }),
      }
      return base
    } catch (error) {
      return {
        ok: true,
        available: true,
        corrupt: true,
        error: errorText(error),
        overlayFile: settings.overlay.file,
      }
    }
  }

  /**
   * 保存或恢复默认模型这一组。
   *
   * 校验不过返回 400 / 503 且**零写入**；过期修订返回 409。
   */
  async #handleModel(
    response: ServerResponse,
    mode: 'save' | 'clear',
    body: Record<string, unknown>,
  ): Promise<void> {
    const settings = this.#options.settings
    if (settings === undefined) {
      json(response, 409, { ok: false, error: 'settings-unavailable' })
      return
    }
    const expectedRevision = typeof body.revision === 'number' ? body.revision : Number.NaN
    const action = mode === 'clear' ? 'model/clear' : 'model/save'
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    const reasoningEffort = typeof body.reasoningEffort === 'string' ? body.reasoningEffort.trim() : ''
    try {
      if (mode === 'clear') {
        await settings.overlay.clearModelSelection(expectedRevision)
      } else {
        // 目录不可用就没有可信的校验依据，直接拒绝保存（与外部评审的 503 口径一致）。
        if (settings.catalog === undefined) {
          json(response, 503, { ok: false, error: 'catalog-unavailable', message: '宿主没有提供模型目录，无法校验，未保存' })
          return
        }
        const catalog = await settings.catalog.view()
        if (!catalog.available) {
          json(response, 503, {
            ok: false,
            error: 'catalog-unavailable',
            message: `模型目录不可用，无法校验，未保存：${catalog.error ?? '原因未知'}`,
          })
          return
        }
        // 空档位等价于「跟随提供方默认」：既不能带给 validate（会被判成非法档位），
        // 也不能存进覆盖文件（会变成一条看起来在、其实无效的 effort）。
        const selection: { provider: string; model: string; reasoningEffort?: string } = { provider, model }
        if (reasoningEffort !== '') selection.reasoningEffort = reasoningEffort
        const problem = await settings.catalog.validate(selection)
        if (problem !== null) {
          json(response, 400, { ok: false, error: 'invalid-selection', message: problem })
          return
        }
        await settings.overlay.saveModelSelection(selection, expectedRevision)
      }
      const snapshot = settings.overlay.effective(settings.hostAccess(), settings.hostModel())
      settings.apply(snapshot)
      this.#record(action, true)
      this.#options.logger?.warn?.(
        `[psyche][qq-control] ${action} ok，model=${snapshot.modelSelection.provider}/${snapshot.modelSelection.model}`,
      )
      json(response, 200, await this.#modelView())
    } catch (error) {
      const mapped = mapOverlayError(error)
      this.#record(action, false, mapped.code)
      json(response, mapped.status, {
        ok: false,
        error: mapped.code,
        message: errorText(error),
        revision: mapped.revision,
      })
    }
  }

  /**
   * 工作区改名：只改显示名。
   *
   * 目录、配置来源、会话成员都只读——工作区目录是 QQ 桥接建会话的依据，从控制中心改它
   * 会让「下一条消息落到哪个目录」变得不可预测，所以这里不给入口。
   */
  async #handleWorkspaceRename(
    response: ServerResponse,
    body: Record<string, unknown>,
  ): Promise<void> {
    const workspace = this.#options.workspace
    if (workspace === undefined) {
      json(response, 503, { ok: false, error: 'unavailable' })
      return
    }
    const raw = body.title
    if (typeof raw !== 'string') {
      json(response, 400, { ok: false, error: 'missing-title' })
      return
    }
    const title = raw.trim()
    if (title === '' || title.length > 40 || /[\r\n]/.test(title)) {
      json(response, 400, { ok: false, error: 'invalid-title' })
      return
    }
    try {
      json(response, 200, await workspace.rename(title))
      this.#record('workspace/rename', true)
    } catch (error) {
      const message = errorText(error)
      this.#record('workspace/rename', false, 'rename-failed')
      json(response, message.startsWith('宿主里还没有') ? 409 : 500, {
        ok: false,
        error: 'rename-failed',
        message,
      })
    }
  }

  /**
   * 第二批：允许回复时段的对象清单。
   *
   * 对象来源 = 当前生效的访问名单（私聊 owner/extra、群 groups）∪ 已存规则的对象。
   * 后者可能已经不在名单里——这类条目照样显示，但标 `authorized:false`：
   * 规则本身不增权，撤销授权之后再恢复，旧规则的效力要让人看得见。
   */
  async #replySchedulesView(): Promise<Record<string, unknown>> {
    const settings = this.#options.settings
    if (settings === undefined) return { ok: false, available: false, error: 'unavailable' }
    const raw = settings.overlay.read()
    const effective = settings.overlay.effective(settings.hostAccess(), settings.hostModel())
    const access = effective.access
    const schedules = raw.replySchedules ?? {}
    const items: Record<string, unknown>[] = []
    const seen = new Set<string>()
    const add = (target: QqReplyTarget, authorized: boolean): void => {
      const key = replyTargetKey(target)
      if (seen.has(key)) return
      seen.add(key)
      items.push({
        kind: target.kind,
        id: target.id,
        key,
        authorized,
        rule: schedules[key] ?? null,
      })
    }
    if (access.owner !== '') add({ kind: 'private', id: access.owner }, true)
    for (const id of access.extra) add({ kind: 'private', id }, true)
    for (const id of access.groups ?? []) add({ kind: 'group', id }, true)
    for (const key of Object.keys(schedules)) {
      const [kind, id] = key.split(':')
      if (kind !== 'private' && kind !== 'group') continue
      add({ kind, id }, false)
    }
    return { ok: true, available: true, revision: raw.revision, items }
  }

  /**
   * 保存一条规则（`rule === null` 表示恢复继承）。
   *
   * 校验在覆盖层里做（`normalizeReplyRule`），这里只负责把 HTTP 状态码映射成
   * 400 非法 / 409 冲突 / 503 不可用；写成功后才让桥接换用新快照。
   */
  async #handleReplySchedulesSave(
    response: ServerResponse,
    body: Record<string, unknown>,
  ): Promise<void> {
    const settings = this.#options.settings
    if (settings === undefined) {
      json(response, 503, { ok: false, error: 'unavailable' })
      return
    }
    const revision = body.revision
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision)) {
      json(response, 400, { ok: false, error: 'invalid-revision' })
      return
    }
    const rawTarget = body.target
    let target: QqReplyTarget
    try {
      const source = typeof rawTarget === 'object' && rawTarget !== null ? rawTarget as Record<string, unknown> : {}
      const kind = source.kind
      const id = typeof source.id === 'string' ? source.id.trim() : ''
      if ((kind !== 'private' && kind !== 'group') || !/^[1-9][0-9]{0,19}$/.test(id)) {
        throw new Error('对象必须是 {kind: private|group, id: 数字}')
      }
      target = { kind, id }
    } catch (error) {
      json(response, 400, { ok: false, error: 'invalid-target', message: errorText(error) })
      return
    }
    let rule: QqReplyRule | null = null
    if (body.rule !== null && body.rule !== undefined) {
      try {
        rule = normalizeReplyRule(body.rule)
      } catch (error) {
        json(response, 400, { ok: false, error: 'invalid-rule', message: errorText(error) })
        return
      }
    }
    try {
      const revision2 = await settings.overlay.saveReplyRule(target, rule, revision)
      // 写完立刻把「生效快照」交给宿主侧，避免发送路径继续用旧规则一整个轮询周期。
      settings.apply(settings.overlay.effective(settings.hostAccess(), settings.hostModel()))
      this.#record('reply-schedule/save', true)
      this.#options.logger?.warn?.(`[psyche][qq-control] 允许回复时段已保存：${replyTargetKey(target)}，revision=${revision2}`)
      json(response, 200, await this.#replySchedulesView())
    } catch (error) {
      const message = errorText(error)
      if (error instanceof QqOverlayConflictError) {
        this.#record('reply-schedule/save', false, 'revision-conflict')
        json(response, 409, { ok: false, error: 'revision-conflict', revision: error.actual, message })
        return
      }
      if (error instanceof QqOverlayValidationError) {
        this.#record('reply-schedule/save', false, 'invalid-rule')
        json(response, 400, { ok: false, error: 'invalid-rule', message })
        return
      }
      if (error instanceof QqOverlayCorruptError) {
        this.#record('reply-schedule/save', false, 'config-corrupt')
        json(response, 503, { ok: false, error: 'config-corrupt', message })
        return
      }
      this.#record('reply-schedule/save', false, 'save-failed')
      json(response, 500, { ok: false, error: 'save-failed', message })
    }
  }

  /** 单个 provider/model 的档位。换模型时前端要重新问一次，不能拿首模型的档位凑数。 */
  async #effortsView(provider: string, model: string): Promise<Record<string, unknown>> {
    const settings = this.#options.settings
    if (settings?.catalog === undefined) return { ok: true, available: false, efforts: [] }
    const view = await settings.catalog.efforts(provider, model)
    return { ok: true, ...view }
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
    // Q5-E：只读组装回执。它回答「这一轮到底往提示里放了什么」——
    // 召回命中但被预算裁掉、渠道判定挡住、根本没调，三者在这里能分开。
    if (request.method === 'GET' && url.pathname === '/api/diagnostics/assemblies') {
      const store = this.#options.receipts
      if (store === undefined) {
        json(response, 200, { ok: true, available: false, items: [] })
        return
      }
      const sessionId = url.searchParams.get('sessionId')
      const rawLimit = Number(url.searchParams.get('limit') ?? '20')
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 20
      json(response, 200, {
        ok: true,
        available: true,
        size: store.size,
        items: store.recent(sessionId, limit),
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/access') {
      json(response, 200, this.#accessView())
      return
    }
    // 迁移 37 恢复入口：名单内容可能没变，但上一次变更没走完，需要重新校验并换代。
    if (request.method === 'POST' && url.pathname === '/api/access/reapply') {
      if (this.#options.settings?.reapplyAccess === undefined) {
        json(response, 503, { ok: false, error: 'unavailable' })
        return
      }
      try {
        const result = this.#options.settings?.reapplyAccess()
        json(response, result.ok ? 200 : 500, result)
      } catch (error) {
        json(response, 500, {
          ok: false,
          error: 'reapply-failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/model/efforts') {
      json(
        response,
        200,
        await this.#effortsView(
          url.searchParams.get('provider') ?? '',
          url.searchParams.get('model') ?? '',
        ),
      )
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/model') {
      json(response, 200, await this.#modelView())
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/reply-schedules') {
      if (this.#options.settings === undefined) {
        json(response, 503, { ok: false, available: false, error: 'unavailable' })
        return
      }
      try {
        json(response, 200, await this.#replySchedulesView())
      } catch (error) {
        this.#options.logger?.warn?.(`[psyche][qq-control] 读允许回复时段失败：${errorText(error)}`)
        json(response, 500, { ok: false, error: 'reply-schedules-read-failed', message: errorText(error) })
      }
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/workspace') {
      const workspace = this.#options.workspace
      if (workspace === undefined) {
        json(response, 503, { ok: false, available: false, error: 'unavailable' })
        return
      }
      try {
        json(response, 200, await workspace.snapshot())
      } catch (error) {
        this.#options.logger?.warn?.(`[psyche][qq-control] 读工作区状态失败：${String(error)}`)
        json(response, 500, {
          ok: false,
          error: 'workspace-read-failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
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
    if (action === '/api/access' || action === '/api/access/clear') {
      await this.#handleAccess(response, action === '/api/access/clear' ? 'clear' : 'save', body)
      return
    }
    if (action === '/api/model' || action === '/api/model/clear') {
      await this.#handleModel(response, action === '/api/model/clear' ? 'clear' : 'save', body)
      return
    }
    if (action === '/api/workspace') {
      await this.#handleWorkspaceRename(response, body)
      return
    }
    if (action === '/api/reply-schedules') {
      await this.#handleReplySchedulesSave(response, body)
      return
    }
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
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) return { ok: false, error: 'upstream-unavailable' }
      const data = (await response.json()) as { tag_name?: unknown; html_url?: unknown }
      const latest = typeof data.tag_name === 'string' ? data.tag_name : ''
      const url = typeof data.html_url === 'string' ? data.html_url : ''
      return { ok: true, latest, url }
    } catch {
      return { ok: false, error: 'upstream-unavailable' }
    }
  }
}

/** 供测试/调用方确认状态目录里是否有令牌文件；不返回令牌。 */
export function hasControlToken(stateDir: string): boolean {
  return existsSync(join(stateDir, TOKEN_FILE))
}

