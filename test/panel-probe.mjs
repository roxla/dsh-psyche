// 只读探测：宿主上 /api/psyche/panel 的形状（不写库、不改配置）。
const base = process.argv[2] ?? 'http://127.0.0.1:60231'
const res = await fetch(`${base}/api/psyche/panel`, { headers: { accept: 'application/json' } })
const text = await res.text()
let payload = null
try {
  payload = JSON.parse(text)
} catch {
  payload = null
}
console.log(
  JSON.stringify(
    {
      status: res.status,
      ok: payload?.ok ?? null,
      enabled: payload?.enabled ?? null,
      driver: payload?.driver ?? null,
      tables: payload?.storage?.tables ?? null,
      groups: (payload?.settings ?? []).map((group) => `${group.id}:${group.fields.length}`),
      growth: payload?.growth?.algorithmVersion ?? null,
      salience: (payload?.salience ?? []).map((row) => `${row.score}${row.solid ? '●' : '○'} ${row.kind} ${row.statement.slice(0, 18)}`),
      fold: payload?.fold
        ? {
            lines: payload.fold.lines.length,
            foldedCount: payload.fold.foldedCount,
            usedChars: payload.fold.usedChars,
            budgetChars: payload.fold.budgetChars,
            usedTokens: payload.fold.usedTokens,
            budgetTokens: payload.fold.budgetTokens,
          }
        : null,
      proposals: payload?.proposals?.length ?? null,
      contacts: payload?.contacts?.length ?? null,
      notes: payload?.notes ?? null,
      error: payload?.error ?? (payload ? null : text.slice(0, 200)),
    },
    null,
    2,
  ),
)
