// 只读验证：读面板/读状态不得推进成长（里程碑数量与阶段在一次读前后必须不变）
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { homedir } from 'node:os'

const base = process.argv[2] ?? 'http://127.0.0.1:58091'
const file = process.argv[3] ?? join(homedir(), '.dsh', 'psyche', 'memory.sqlite3')

function snapshot() {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const phase = db.prepare('SELECT phase, since FROM phase_state ORDER BY rowid LIMIT 1').get()
    const milestones = db.prepare('SELECT COUNT(*) AS n FROM phase_milestones').get()
    const evidence = db.prepare('SELECT COUNT(*) AS n FROM phase_evidence').get()
    const ops = db.prepare("SELECT COUNT(*) AS n FROM operations WHERE tool = 'psyche_growth'").get()
    return { phase: phase?.phase ?? null, since: phase?.since ?? null, milestones: milestones.n, evidence: evidence.n, growthOps: ops.n }
  } finally {
    db.close()
  }
}

async function hit(path) {
  const res = await fetch(`${base}${path}`)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

const before = snapshot()

const first = await hit('/api/psyche/panel')
const second = await hit('/api/psyche/panel')
const third = await hit('/api/psyche/status')

const after = snapshot()

const growth = first.body?.growth ?? null
const gateList = Array.isArray(growth?.gates) ? growth.gates.map((g) => `${g.gate}:${g.passed ? 'pass' : 'wait'}`) : []

console.log(JSON.stringify({
  panel: { status: first.status, ok: first.body?.ok, stage: growth?.stage, stageLabel: growth?.stageLabel, algorithmVersion: growth?.algorithmVersion, bottleneck: growth?.bottleneck, advanced: growth?.advanced, gates: gateList },
  secondPanel: { status: second.status, stage: second.body?.growth?.stage },
  status: { status: third.status, ok: third.body?.ok },
  before,
  after,
  unchanged: JSON.stringify(before) === JSON.stringify(after),
}, null, 2))
