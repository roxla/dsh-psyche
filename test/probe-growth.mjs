import { readFileSync } from "node:fs"
const res = await fetch("http://127.0.0.1:60231/api/psyche/panel")
const json = await res.json()
console.log(JSON.stringify({ growth: json.growth, state: { phase: json.state?.growth ?? null, tables: json.storage?.tables } }, null, 2).slice(0, 2200))
