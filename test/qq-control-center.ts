// P8-4 本机 QQ 控制中心（模块级）。
//
// 覆盖：令牌入口、无令牌 401、跨源 403、页面不带令牌、目录记忆、未知路由 404。
// 跑法：npm run build && node test/qq-control-center.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QqControlCenter, hasControlToken } from '../dist/lib/qq-control-center.js'

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
} finally {
  await center.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
