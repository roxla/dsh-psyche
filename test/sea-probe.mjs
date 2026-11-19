// 只读 + 一次偏好开关往返，验证 /api/psyche/{panel,sea,prefs}
// 用法：node test/sea-probe.mjs [baseUrl]

const base = (process.argv[2] ?? 'http://127.0.0.1:61490').replace(/\/$/, '')

async function get(path) {
  const response = await fetch(`${base}${path}`)
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text.slice(0, 200) }
  return { status: response.status, body }
}

async function post(path, payload) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text.slice(0, 200) }
  return { status: response.status, body }
}

const first = await get('/api/psyche/panel')
const panel = first.body ?? {}
console.log('panel:', JSON.stringify({
  status: first.status,
  ok: panel.ok,
  tables: panel.storage?.tables,
  growth: panel.growth?.algorithmVersion,
  stage: panel.growth?.stage,
  prefs: panel.prefs,
  groups: (panel.settings ?? []).map(g => `${g.id}:${g.fields.length}`),
  seaField: (panel.settings ?? []).flatMap(g => g.fields).find(f => f.key === 'panel.sea') ?? null,
}))

const sea = await get('/api/psyche/sea')
const scene = sea.body ?? {}
console.log('sea:', JSON.stringify({
  status: sea.status,
  ok: scene.ok,
  nodes: scene.nodes?.length,
  edges: scene.edges?.length,
  stats: scene.stats,
  note: scene.note,
  sampleEdgeKinds: [...new Set((scene.edges ?? []).map(e => e.kind))],
}))

const on = await post('/api/psyche/prefs', { sea: true })
console.log('prefs on:', JSON.stringify({ status: on.status, body: on.body }))
const after = await get('/api/psyche/panel')
console.log('panel after on:', JSON.stringify({ prefs: after.body?.prefs }))

const off = await post('/api/psyche/prefs', { sea: false })
const restored = await get('/api/psyche/panel')
console.log('prefs restore:', JSON.stringify({ status: off.status, prefs: restored.body?.prefs }))

const bad = await post('/api/psyche/prefs', { nope: 1 })
console.log('prefs reject unknown key:', JSON.stringify({ status: bad.status, body: bad.body }))
