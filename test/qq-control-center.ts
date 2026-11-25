// P8-4 本机 QQ 控制中心（模块级）。
//
// 覆盖：令牌入口、无令牌 401、跨源 403、页面不带令牌、目录记忆、未知路由 404。
// 跑法：npm run build && node test/qq-control-center.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QqControlCenter, hasControlToken } from '../dist/lib/qq-control-center.js'
import { QqSettingsOverlay } from '../dist/lib/qq-settings-overlay.js'

let passed = 0
let failed = 0

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-control-'))
const manager = {
  snapshot: () => ({ name: 'snowluma', running: false, pid: null }),
  logs: () => [],
  start: () => ({ ok: false, error: 'disabled in test' }),
  stop: async () => ({ ok: true }),
  restart: async () => ({ ok: false, error: 'disabled in test' }),
}
// Q1：访问控制写入入口。桥接用假的记录器，只验「保存后有没有把有效快照推给它」。
let applied = null
const overlay = new QqSettingsOverlay({ file: join(dir, 'qq-overrides.json') })
const center = new QqControlCenter({
  stateDir: dir,
  manager,
  snowlumaDir: () => '',
  setSnowlumaDir: () => {},
  bridge: {
    connect: () => {},
    disconnect: async () => {},
    reconnect: () => {},
    snapshot: () => ({ connection: 'disconnected' }),
  },
  openBrowser: () => {},
  settings: {
    overlay,
    hostAccess: () => ({ owner: '695115698', extra: [] }),
    hostModel: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
    apply: (snapshot) => { applied = snapshot },
    // 假目录：只认 deepseek-account / deepseek-flash，且该模型有 low/high 两档。
    // 用假目录而不是真宿主，是因为这里验的是「路由是否按目录校验」，
    // 真宿主目录随环境变化会让断言不稳。
    catalog: {
      view: async () => ({
        available: true,
        providers: [{ id: 'deepseek-account', name: 'DeepSeek' }],
        models: [{ provider: 'deepseek-account', id: 'deepseek-flash', name: 'Flash' }],
        efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }],
        defaultEffort: 'low',
      }),
      efforts: async () => ({
        available: true,
        notOffered: false,
        efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }],
        defaultEffort: 'low',
      }),
      validate: async (selection) => {
        if (selection.provider !== 'deepseek-account') return `宿主没有这个提供方：${selection.provider}`
        if (selection.model !== 'deepseek-flash') return `这个提供方下没有该模型：${selection.model}`
        if (selection.reasoningEffort !== undefined && !['low', 'high'].includes(selection.reasoningEffort)) {
          return `模型 ${selection.model} 不支持档位 ${selection.reasoningEffort}`
        }
        return null
      },
    },
  },
})

try {
  const started = await center.ensureStarted()
  ok('启动后返回 loopback 地址', started.url.startsWith('http://127.0.0.1:') && started.url.endsWith('/'), started.url)
  ok('令牌为 48 位十六进制', /^[a-f0-9]{48}$/.test(started.token), started.token)
  ok('令牌文件存在且可用', hasControlToken(dir))

  const noToken = await fetch(`${started.url}api/status`)
  ok('无令牌被拒', noToken.status === 401, noToken.status)

  const withToken = await fetch(`${started.url}api/status`, { headers: { 'x-control-token': started.token } })
  const status = await withToken.json()
  ok('带令牌可读状态', withToken.status === 200 && status.ok === true, withToken.status)
  ok('状态包含 snowluma/bridge/control', Boolean(status.snowluma && status.bridge && status.control), Object.keys(status))

  const page = await fetch(started.url)
  const html = await page.text()
  ok('首页是 HTML 且不泄露令牌', page.status === 200 && html.includes('<html') && !html.includes(started.token), page.status)
  ok('更新失败不外泄内部错误码', !html.includes('check-failed') && html.includes('官方更新源暂不可用'), html.includes('check-failed'))

  // 视图层（v29.48）：五个固定视图 + 双向握手 + 嵌入时隐藏自身导航。
  const viewIds = ['status', 'access', 'model', 'events', 'logs']
  ok('五个视图按钮齐全', viewIds.every((id) => html.includes(`data-go="${id}"`)), viewIds.filter((id) => !html.includes(`data-go="${id}"`)))
  ok('每个视图都有独立 section', viewIds.every((id) => html.includes(`data-view="${id}"`)), viewIds.filter((id) => !html.includes(`data-view="${id}"`)))
  ok(
    '握手消息三种类型都在页面里',
    html.includes('psyche:qq:ready') && html.includes('psyche:qq:view') && html.includes('psyche:qq:height'),
    [html.includes('psyche:qq:ready'), html.includes('psyche:qq:view'), html.includes('psyche:qq:height')],
  )
  ok(
    '视图集合是固定白名单，不拼接外部输入',
    html.includes('const VIEWS =') && html.includes('VIEWS.indexOf(view) < 0') && html.includes('VIEWS.indexOf(id) < 0'),
    html.includes('VIEWS.indexOf'),
  )
  ok(
    '页面只认父窗口消息',
    html.includes('event.source !== window.parent') && html.includes('window.parent !== window'),
    html.includes('event.source !== window.parent'),
  )
  ok(
    '嵌入模式隐藏自身导航与标题',
    html.includes('html[data-embed="1"]') && html.includes('nav.views{display:none}'),
    html.includes('html[data-embed="1"]'),
  )
  ok('诊断事件视图读组装回执接口', html.includes('/api/diagnostics/assemblies'), html.includes('/api/diagnostics/assemblies'))
  // 工作区卡（第一批 · 五态）：页面要能显示五态与改名表单，并响应宿主卡上的「编辑工作区」。
  ok(
    '页面有工作区五态卡与改名表单',
    html.includes('id="ws-state"') && html.includes('id="ws-title"') && html.includes('id="ws-edit"'),
    [html.includes('id="ws-state"'), html.includes('id="ws-title"'), html.includes('id="ws-edit"')],
  )
  ok(
    '页面响应宿主的编辑工作区动作',
    html.includes('psyche:qq:action') && html.includes('workspace-edit'),
    html.includes('psyche:qq:action'),
  )
  // 握手加固（GPT 第 1 轮第 3 条）：双向都发精确 origin，不再用通配。
  ok(
    '子页只向精确 hostOrigin 发消息',
    html.includes('let hostOrigin = REFERRER_ORIGIN') &&
      html.includes('window.parent.postMessage(Object.assign({ type: type }, extra || {}), hostOrigin)'),
    [html.includes('REFERRER_ORIGIN'), html.includes(', hostOrigin)')],
  )
  ok(
    '子页收到消息时核对父页 origin',
    html.includes("if (data.type !== 'psyche:qq:view') return;") &&
      html.includes('else if (event.origin !== hostOrigin) {'),
    [html.includes("if (data.type !== 'psyche:qq:view') return;"), html.includes('else if (event.origin !== hostOrigin) {')],
  )
  // GPT 第 2 轮第 3 条：referrer 为空时，只有合格的视图消息才能锁定宿主 origin。
  ok(
    '只有合格视图消息能锁定宿主 origin',
    html.includes("if (hostOrigin === '') {") &&
      html.includes('hostOrigin = event.origin;') &&
      html.indexOf("if (data.type !== 'psyche:qq:view') return;") < html.indexOf('hostOrigin = event.origin;'),
    [
      html.includes("if (hostOrigin === '') {"),
      html.indexOf("if (data.type !== 'psyche:qq:view') return;") < html.indexOf('hostOrigin = event.origin;'),
    ],
  )
  // 依赖缺省时不假装有数据：503 + available:false，而不是一张读不到真实状态的卡。
  const noWorkspace = await fetch(`${started.url}api/workspace`, { headers: { 'x-control-token': started.token } })
  const noWorkspaceBody = await noWorkspace.json()
  ok(
    '没有工作区依赖时返回 503 且不假装有数据',
    noWorkspace.status === 503 && noWorkspaceBody.available === false,
    { status: noWorkspace.status, noWorkspaceBody },
  )

  const cross = await fetch(`${started.url}api/status`, {
    headers: { 'x-control-token': started.token, origin: 'http://evil.example' },
  })
  ok('跨源请求被拒', cross.status === 403, cross.status)

  const snowlumaDir = join(dir, 'SnowLuma')
  mkdirSync(snowlumaDir, { recursive: true })
  writeFileSync(join(snowlumaDir, 'package.json'), JSON.stringify({ name: '@snowluma/runtime', version: '1.0.0' }))
  writeFileSync(join(snowlumaDir, 'launcher.bat'), '@echo off\r\n')
  const setDir = await fetch(`${started.url}api/snowluma/dir`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-control-token': started.token },
    body: JSON.stringify({ dir: snowlumaDir }),
  })
  const setResult = await setDir.json()
  ok('设置目录成功', setDir.status === 200 && setResult.ok === true, setDir.status)
  ok('目录写入状态文件', readFileSync(join(dir, 'snowluma-dir.txt'), 'utf8').trim() === snowlumaDir)

  for (const [name, expectedOk] of [['connect', true], ['disconnect', true], ['reconnect', true], ['test', false]] as const) {
    const result = await fetch(`${started.url}api/bridge/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-control-token': started.token },
      body: '{}',
    })
    const data = await result.json()
    ok(`桥接 ${name} 路由可用且不泄露令牌`, result.status === 200 && data.ok === expectedOk && !JSON.stringify(data).includes(started.token), { status: result.status, data })
  }

  const unknown = await fetch(`${started.url}api/nope`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-control-token': started.token },
    body: '{}',
  })
  ok('未知路由 404', unknown.status === 404, unknown.status)

  const deniedStop = await fetch(`${started.url}api/snowluma/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-control-token': started.token },
    body: '{}',
  })
  ok('危险动作拒绝隐式确认', deniedStop.status === 400, deniedStop.status)

  const deniedRestart = await fetch(`${started.url}api/snowluma/restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-control-token': started.token },
    body: '{}',
  })
  ok('重启拒绝隐式确认', deniedRestart.status === 400, deniedRestart.status)

  const confirmedStop = await fetch(`${started.url}api/snowluma/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-control-token': started.token },
    body: JSON.stringify({ confirm: true }),
  })
  ok('显式确认后停止可用', confirmedStop.status === 200, confirmedStop.status)

  const audited = await fetch(`${started.url}api/status`, { headers: { 'x-control-token': started.token } })
  const auditedStatus = await audited.json()
  const audit = Array.isArray(auditedStatus.audit) ? auditedStatus.audit : []
  ok('危险动作留下脱敏审计', audit.some((entry) => entry.action === 'snowluma/stop' && entry.ok === true) && !JSON.stringify(audit).includes(started.token), audit)

  // ── Q1：访问与安全写入入口 ────────────────────────────────────────────────
  const accessHeaders = { 'content-type': 'application/json', 'x-control-token': started.token }
  const accessNoToken = await fetch(`${started.url}api/access`)
  ok('访问控制无令牌被拒', accessNoToken.status === 401, accessNoToken.status)

  const initialAccess = await fetch(`${started.url}api/access`, { headers: { 'x-control-token': started.token } })
  const initialBody = await initialAccess.json()
  ok('初始来源是宿主配置', initialAccess.status === 200 && initialBody.source === 'host' && initialBody.hasOverride === false, initialBody)
  ok('初始值与宿主配置一致', initialBody.owner === '695115698' && Array.isArray(initialBody.extra) && initialBody.extra.length === 0, initialBody)

  const saved = await fetch(`${started.url}api/access`, {
    method: 'POST',
    headers: accessHeaders,
    body: JSON.stringify({ revision: 0, owner: '695115698', extra: ['3320044'] }),
  })
  const savedBody = await saved.json()
  ok('保存白名单成功并立即推给桥接', saved.status === 200 && savedBody.source === 'overlay' && savedBody.revision === 1 && applied !== null, { status: saved.status, savedBody, applied: applied !== null })
  ok('保存后 extra 生效', Array.isArray(savedBody.extra) && savedBody.extra.join(',') === '3320044', savedBody.extra)

  const stale = await fetch(`${started.url}api/access`, {
    method: 'POST',
    headers: accessHeaders,
    body: JSON.stringify({ revision: 0, owner: '111', extra: [] }),
  })
  const staleBody = await stale.json()
  ok('过期修订返回 409 并给出现值', stale.status === 409 && staleBody.revision === 1, { status: stale.status, staleBody })

  const badOwner = await fetch(`${started.url}api/access`, {
    method: 'POST',
    headers: accessHeaders,
    body: JSON.stringify({ revision: 1, owner: 'not-a-qq', extra: [] }),
  })
  ok('非法 QQ 号返回 400 且不写库', badOwner.status === 400, badOwner.status)
  const afterBad = await (await fetch(`${started.url}api/access`, { headers: { 'x-control-token': started.token } })).json()
  ok('非法提交没有改动已有值', afterBad.revision === 1 && afterBad.owner === '695115698', afterBad)

  const restored = await fetch(`${started.url}api/access/clear`, {
    method: 'POST',
    headers: accessHeaders,
    body: JSON.stringify({ revision: 1 }),
  })
  const restoredBody = await restored.json()
  ok('恢复宿主配置后来源变回 host', restored.status === 200 && restoredBody.source === 'host' && restoredBody.revision === 2, restoredBody)
  ok('恢复后回到宿主值', restoredBody.owner === '695115698' && restoredBody.extra.length === 0, restoredBody)

  // ── Q1：默认模型写入入口 ──────────────────────────────────────────────────
  const modelNoToken = await fetch(`${started.url}api/model`)
  ok('默认模型无令牌被拒', modelNoToken.status === 401, modelNoToken.status)

  const initialModel = await fetch(`${started.url}api/model`, { headers: { 'x-control-token': started.token } })
  const initialModelBody = await initialModel.json()
  ok('模型初始来源是宿主配置', initialModel.status === 200 && initialModelBody.source === 'host' && initialModelBody.hasOverride === false, initialModelBody)
  ok('模型初始值与宿主一致', initialModelBody.saved?.provider === 'deepseek-account' && initialModelBody.saved?.model === 'deepseek-flash', initialModelBody.saved)
  ok('能力目录可用并带出档位', initialModelBody.catalogSource === 'host' && Array.isArray(initialModelBody.catalog?.efforts), initialModelBody.catalogSource)
  // effort 在当前版本只保存不生效，页面必须能读到这个事实而不是靠猜。
  ok('模型视图标明档位不生效', initialModelBody.effortEffective === false, initialModelBody.effortEffective)

  const badModel = await fetch(`${started.url}api/model`, {
    method: 'POST',
    headers: accessHeaders,
    body: JSON.stringify({ revision: initialModelBody.revision, provider: 'nope', model: 'x' }),
  })
  const badModelBody = await badModel.json()
  ok('非法模型选择返回 400 且不写库', badModel.status === 400 && badModelBody.error === 'invalid-selection', { status: badModel.status, badModelBody })
  const afterBadModel = await (await fetch(`${started.url}api/model`, { headers: { 'x-control-token': started.token } })).json()
  ok('非法模型提交没有改动覆盖', afterBadModel.hasOverride === false, afterBadModel)

  const savedModel = await fetch(`${started.url}api/model`, {
    method: 'POST',
    headers: accessHeaders,
    body: JSON.stringify({ revision: initialModelBody.revision, provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }),
  })
  const savedModelBody = await savedModel.json()
  ok('保存默认模型成功并推给桥接', savedModel.status === 200 && savedModelBody.source === 'overlay' && savedModelBody.saved?.reasoningEffort === 'high' && applied?.hasModelOverride === true, { status: savedModel.status, savedModelBody, hasOverride: applied?.hasModelOverride })

  const staleModel = await fetch(`${started.url}api/model`, {
    method: 'POST',
    headers: accessHeaders,
    body: JSON.stringify({ revision: initialModelBody.revision, provider: 'deepseek-account', model: 'deepseek-flash' }),
  })
  ok('模型保存的过期修订返回 409', staleModel.status === 409, staleModel.status)

  const clearedModel = await fetch(`${started.url}api/model/clear`, {
    method: 'POST',
    headers: accessHeaders,
    body: JSON.stringify({ revision: initialModelBody.revision + 1 }),
  })
  const clearedModelBody = await clearedModel.json()
  ok('恢复宿主模型后来源变回 host', clearedModel.status === 200 && clearedModelBody.source === 'host' && clearedModelBody.hasOverride === false, clearedModelBody)
} finally {
  await center.close()
  rmSync(dir, { recursive: true, force: true })
}

// ── 工作区卡（第一批 · 五态）：注入依赖后的读与改名 ────────────────────────
{
  const wsDir = mkdtempSync(join(tmpdir(), 'psyche-control-ws-'))
  const renames: string[] = []
  const workspaceCard = {
    ok: true,
    state: 'registered',
    label: '已登记',
    reason: 'QQ 聊天',
    expectedTitle: 'QQ 聊天',
    cwd: 'D:\\ws',
    cwdSource: 'default',
    workspaceId: 'ws-1',
    actualTitle: 'QQ 聊天',
    memberCount: 2,
    attempt: { at: '2026-11-23T00:00:00.000Z', step: 'created', ok: true },
    checkedAt: '2026-11-23T00:00:01.000Z',
  }
  const wsCenter = new QqControlCenter({
    stateDir: wsDir,
    manager,
    snowlumaDir: () => '',
    setSnowlumaDir: () => {},
    bridge: {
      connect: () => {},
      disconnect: async () => {},
      reconnect: () => {},
      snapshot: () => ({ connection: 'disconnected' }),
    },
    openBrowser: () => {},
    workspace: {
      snapshot: async () => workspaceCard,
      rename: async (title: string) => {
        // 「宿主里还没有 QQ 工作区」是宿主的真实错误文案，控制中心按前缀映射成 409。
        if (title === '还没有') throw new Error('宿主里还没有 QQ 工作区，先让一条 QQ 消息把它建出来')
        renames.push(title)
        return { ...workspaceCard, actualTitle: title }
      },
    },
  })
  try {
    const ws = await wsCenter.ensureStarted()
    const wsHeaders = { 'content-type': 'application/json', 'x-control-token': ws.token }
    const wsNoToken = await fetch(`${ws.url}api/workspace`)
    ok('工作区卡无令牌被拒', wsNoToken.status === 401, wsNoToken.status)

    const gotWs = await fetch(`${ws.url}api/workspace`, { headers: { 'x-control-token': ws.token } })
    const gotWsBody = await gotWs.json()
    ok(
      '工作区卡返回五态字段',
      gotWs.status === 200 && gotWsBody.state === 'registered' && gotWsBody.memberCount === 2 && gotWsBody.cwdSource === 'default',
      gotWsBody,
    )

    const missingTitle = await fetch(`${ws.url}api/workspace`, { method: 'POST', headers: wsHeaders, body: '{}' })
    const missingTitleBody = await missingTitle.json()
    ok('改名缺 title 返回 400', missingTitle.status === 400 && missingTitleBody.error === 'missing-title', { status: missingTitle.status, missingTitleBody })

    const tooLong = await fetch(`${ws.url}api/workspace`, {
      method: 'POST',
      headers: wsHeaders,
      body: JSON.stringify({ title: '名'.repeat(41) }),
    })
    const tooLongBody = await tooLong.json()
    ok('改名超长返回 400', tooLong.status === 400 && tooLongBody.error === 'invalid-title', { status: tooLong.status, tooLongBody })

    const renamed = await fetch(`${ws.url}api/workspace`, {
      method: 'POST',
      headers: wsHeaders,
      body: JSON.stringify({ title: '  新名字  ' }),
    })
    const renamedBody = await renamed.json()
    ok(
      '改名成功且前后空白已去掉',
      renamed.status === 200 && renamedBody.actualTitle === '新名字' && renames.join(',') === '新名字',
      { status: renamed.status, renamedBody, renames },
    )

    const notYet = await fetch(`${ws.url}api/workspace`, {
      method: 'POST',
      headers: wsHeaders,
      body: JSON.stringify({ title: '还没有' }),
    })
    ok('工作区还不存在时返回 409', notYet.status === 409, notYet.status)

    const wsAudit = await (await fetch(`${ws.url}api/status`, { headers: { 'x-control-token': ws.token } })).json()
    ok(
      '改名留脱敏审计',
      Array.isArray(wsAudit.audit)
        && wsAudit.audit.some((entry) => entry.action === 'workspace/rename' && entry.ok === true)
        && !JSON.stringify(wsAudit.audit).includes(ws.token),
      wsAudit.audit,
    )
  } finally {
    await wsCenter.close()
    rmSync(wsDir, { recursive: true, force: true })
  }
}

// ── Q1 回归：只改私聊名单不能顺手清空群白名单（c18880d 的锁）────────────────
//
// 控制中心的表单只编辑「主人」与「额外允许」，压根没有 groups 输入框；所以服务端
// 必须把「请求里没带 groups」当成「保留当前生效值」。c18880d 之前这里直接传
// `{ owner, extra }`，覆盖层把缺省当空数组，于是保存一次私聊名单就把群白名单清了。
{
  const gDir = mkdtempSync(join(tmpdir(), 'psyche-control-groups-'))
  const gOverlay = new QqSettingsOverlay({ file: join(gDir, 'qq-overrides.json') })
  const hostAccess = (): { owner?: string; extra?: string[]; groups?: string[] } => ({
    owner: '695115698',
    extra: [],
    groups: ['30001'],
  })
  const hostModel = (): { provider?: string; model?: string } => ({
    provider: 'deepseek-account',
    model: 'deepseek-flash',
  })
  const gCenter = new QqControlCenter({
    stateDir: gDir,
    manager,
    snowlumaDir: () => '',
    setSnowlumaDir: () => {},
    bridge: {
      connect: () => {},
      disconnect: async () => {},
      reconnect: () => {},
      snapshot: () => ({ connection: 'disconnected' }),
    },
    openBrowser: () => {},
    settings: {
      overlay: gOverlay,
      hostAccess,
      hostModel,
      apply: () => {},
    },
  })
  try {
    const g = await gCenter.ensureStarted()
    const gHeaders = { 'content-type': 'application/json', 'x-control-token': g.token }
    const groupsNow = () => gOverlay.effective(hostAccess(), hostModel()).access.groups

    const keepGroups = await fetch(`${g.url}api/access`, {
      method: 'POST',
      headers: gHeaders,
      body: JSON.stringify({ revision: 0, owner: '695115698', extra: ['3320044'] }),
    })
    ok(
      '保存私聊名单不会清空群白名单',
      keepGroups.status === 200 && groupsNow().join(',') === '30001',
      { status: keepGroups.status, groups: groupsNow() },
    )

    // 语义的另一头：显式传空数组才是清空（将来页面真给了入口时要靠这条守住）。
    const clearGroups = await fetch(`${g.url}api/access`, {
      method: 'POST',
      headers: gHeaders,
      body: JSON.stringify({ revision: 1, owner: '695115698', extra: ['3320044'], groups: [] }),
    })
    ok(
      '显式传空数组才清空群白名单',
      clearGroups.status === 200 && groupsNow().length === 0,
      { status: clearGroups.status, groups: groupsNow() },
    )
  } finally {
    await gCenter.close()
    rmSync(gDir, { recursive: true, force: true })
  }
}

// ── 第二批：允许回复时段的读写接口 ─────────────────────────────────────────
{
  const rDir = mkdtempSync(join(tmpdir(), 'psyche-control-schedules-'))
  const rOverlay = new QqSettingsOverlay({ file: join(rDir, 'qq-overrides.json') })
  const hostAccess = (): { owner?: string; extra?: string[]; groups?: string[] } => ({
    owner: '695115698',
    extra: [],
    groups: ['30001'],
  })
  const hostModel = (): { provider?: string; model?: string } => ({
    provider: 'deepseek-account',
    model: 'deepseek-flash',
  })
  const applied: unknown[] = []
  const rCenter = new QqControlCenter({
    stateDir: rDir,
    manager,
    snowlumaDir: () => '',
    setSnowlumaDir: () => {},
    bridge: {
      connect: () => {},
      disconnect: async () => {},
      reconnect: () => {},
      snapshot: () => ({ connection: 'disconnected' }),
    },
    openBrowser: () => {},
    settings: {
      overlay: rOverlay,
      hostAccess,
      hostModel,
      apply: (snapshot: { replySchedules?: unknown }) => {
        applied.push(snapshot.replySchedules)
      },
    },
  })
  try {
    const r = await rCenter.ensureStarted()
    const headers = { 'content-type': 'application/json', 'x-control-token': r.token }
    const page = await (await fetch(`${r.url}`)).text()
    ok(
      '页面带时段编辑器',
      page.includes('允许回复时段') && page.includes('rs-mode') && page.includes('rs-windows') && page.includes('rs-save'),
      page.length,
    )

    const empty = await (await fetch(`${r.url}api/reply-schedules`, { headers: { 'x-control-token': r.token } })).json()
    const ids = (empty.items ?? []).map((item: { key: string }) => item.key).sort()
    ok(
      '时段列表列出可管理对象',
      empty.ok === true && empty.available === true && ids.join(',') === 'group:30001,private:695115698',
      { ids, revision: empty.revision },
    )

    const windowRule = {
      mode: 'windows',
      timeZone: 'Asia/Shanghai',
      windows: [{ days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1080 }],
    }
    const first = await fetch(`${r.url}api/reply-schedules`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ revision: empty.revision, target: { kind: 'private', id: '695115698' }, rule: windowRule }),
    })
    const firstBody = await first.json()
    ok(
      '保存私聊时段返回新视图',
      first.status === 200 && firstBody.revision === empty.revision + 1
        && (firstBody.items ?? []).some((item: { key: string; rule?: { mode?: string } }) => item.key === 'private:695115698' && item.rule?.mode === 'windows'),
      { status: first.status, revision: firstBody.revision },
    )
    ok('保存后把新策略推给发送路径', applied.length >= 1, applied.length)

    const stale = await fetch(`${r.url}api/reply-schedules`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ revision: empty.revision, target: { kind: 'group', id: '30001' }, rule: { mode: 'paused' } }),
    })
    const staleBody = await stale.json()
    ok(
      '旧 revision 返回 409 且带当前修订',
      stale.status === 409 && staleBody.error === 'revision-conflict' && staleBody.revision === firstBody.revision,
      { status: stale.status, staleBody },
    )

    const bad = await fetch(`${r.url}api/reply-schedules`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ revision: firstBody.revision, target: { kind: 'group', id: '30001' }, rule: { mode: 'windows', timeZone: 'Asia/Shanghai', windows: [] } }),
    })
    const badBody = await bad.json()
    ok('空时段被拒绝', bad.status === 400 && badBody.error === 'invalid-rule', { status: bad.status, badBody })

    const paused = await fetch(`${r.url}api/reply-schedules`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ revision: firstBody.revision, target: { kind: 'group', id: '30001' }, rule: { mode: 'paused' } }),
    })
    const pausedBody = await paused.json()
    ok(
      '群可以单独设成暂停',
      paused.status === 200
        && (pausedBody.items ?? []).some((item: { key: string; rule?: { mode?: string } }) => item.key === 'group:30001' && item.rule?.mode === 'paused'),
      { status: paused.status },
    )

    const cleared = await fetch(`${r.url}api/reply-schedules`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ revision: pausedBody.revision, target: { kind: 'group', id: '30001' }, rule: null }),
    })
    const clearedBody = await cleared.json()
    ok(
      'rule=null 恢复继承',
      cleared.status === 200
        && !(clearedBody.items ?? []).some((item: { key: string; rule?: unknown }) => item.key === 'group:30001' && item.rule !== null && item.rule !== undefined),
      { status: cleared.status },
    )

    const scheduleAudit = await (await fetch(`${r.url}api/status`, { headers: { 'x-control-token': r.token } })).json()
    ok(
      '时段保存留脱敏审计',
      Array.isArray(scheduleAudit.audit)
        && scheduleAudit.audit.some((entry: { action: string }) => entry.action === 'reply-schedule/save')
        && !JSON.stringify(scheduleAudit.audit).includes(r.token),
      scheduleAudit.audit,
    )
  } finally {
    await rCenter.close()
    rmSync(rDir, { recursive: true, force: true })
  }
}

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
