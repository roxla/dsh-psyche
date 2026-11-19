// 用量与运维路由探针：只读为主，备份动作会真的写一份备份文件（可重复）。
// 用法：node test/ops-probe.mjs http://127.0.0.1:61490 [--backup]

const base = process.argv[2] || 'http://127.0.0.1:61490'
const withBackup = process.argv.includes('--backup')

function pick(value, keys) {
  const out = {}
  if (!value || typeof value !== 'object') return value
  for (const key of keys) if (key in value) out[key] = value[key]
  return out
}

async function getJson(path) {
  const response = await fetch(base + path, { headers: { accept: 'application/json' } })
  return { status: response.status, body: await response.json().catch(() => null) }
}

const usage = await getJson('/api/psyche/usage?hours=72')
console.log(
  'usage',
  JSON.stringify({
    status: usage.status,
    ok: usage.body?.ok,
    tier: usage.body?.priceTable?.tier,
    tierLabel: usage.body?.priceTable?.tierLabel,
    calls: usage.body?.totals?.calls,
    sessions: usage.body?.totals?.sessions,
    turns: usage.body?.totals?.turns,
    tokens: usage.body?.totals?.tokens,
    hitRate: usage.body?.totals?.hitRate,
    cost: usage.body?.totals?.cost?.total,
    bySession: (usage.body?.bySession ?? []).map((item) => `${item.label}:${item.tokens}tok/${item.turns}turn`),
    hours: (usage.body?.byHour ?? []).length,
    notes: usage.body?.notes,
  }),
)

const ops = await getJson('/api/psyche/ops')
console.log(
  'ops',
  JSON.stringify({
    status: ops.status,
    ok: ops.body?.ok,
    health: pick(ops.body?.health, ['driver', 'userVersion', 'tables', 'journalMode', 'queries', 'slowQueries', 'maxQueryMs', 'bytes']),
    counters: ops.body?.counters,
    operations: pick(ops.body?.operations, ['total', 'failed', 'slowCount']),
    recent: (ops.body?.operations?.recent ?? []).slice(0, 3),
    logs: (ops.body?.logs ?? []).length,
    logCounts: ops.body?.logCounts,
    backups: (ops.body?.backups ?? []).length,
    note: ops.body?.note,
  }),
)

if (withBackup) {
  const response = await fetch(base + '/api/psyche/ops', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ action: 'backup' }),
  })
  const body = await response.json().catch(() => null)
  console.log('backup', JSON.stringify({ status: response.status, ok: body?.ok, backup: body?.backup, backups: (body?.ops?.backups ?? []).length }))
}

const bad = await fetch(base + '/api/psyche/ops', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'nope' }),
})
console.log('unknown-action', bad.status, JSON.stringify(await bad.json().catch(() => null)))
