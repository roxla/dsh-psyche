// prompt.section 开关往返：false（注入停）→ null（跟随配置，应恢复注入）
const base = process.argv[2] ?? 'http://127.0.0.1:61490'

async function post(path, body) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return [r.status, await r.json()]
}

async function get(path) {
  const r = await fetch(base + path)
  return await r.json()
}

const fields = panel => (panel.settings ?? []).find(g => g.id === 'prompt').fields.map(f => [f.key, f.value])

console.log('off ->', JSON.stringify(await post('/api/psyche/prefs', { promptSection: false })))
let panel = await get('/api/psyche/panel')
console.log('panel off:', JSON.stringify(panel.prefs), JSON.stringify(fields(panel)))

console.log('follow ->', JSON.stringify(await post('/api/psyche/prefs', { promptSection: null })))
panel = await get('/api/psyche/panel')
console.log('panel follow:', JSON.stringify(panel.prefs), JSON.stringify(fields(panel)))
