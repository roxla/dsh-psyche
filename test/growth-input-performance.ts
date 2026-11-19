// P2 Growth Gate 性能：证明写路径不再随历史线性变慢。
//
// 背景：`#write` 原来每次成功后都调 `deriveGrowthNow` → `loadGrowthInputs`，
// 后者要扫 artifact_evidence / events / artifact_revisions 全表并在 JS 里聚合。
// v27.52 起写路径不再做全量派生，阶段判定仍由 `syncGrowth()` / `getGrowth()` 全量完成。
//
// 本测试用同一台机器、同一条库，分别测：
//   oldCost = 一次 `deriveGrowthNow`（旧写路径每次写入都要付的成本）
//   newCost = 一次 `core.remember`（新写路径）
// 在 N=100 / 1000 / 3000 条历史 belief 下的耗时，断言：
//   1) oldCost 随 N 明显增长（确认 O(N) 的真实来源）
//   2) newCost 基本不随 N 增长（比值上限 2.5，留运行抖动余量）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { deriveGrowthNow } from '../dist/lib/growth.js'

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

const log = { info() {}, debug() {}, warn() {}, error() {} }
const SIZES = [100, 1000, 3000]

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function timeIt(fn, rounds = 5) {
  const samples = []
  for (let i = 0; i < rounds; i += 1) {
    const start = process.hrtime.bigint()
    fn()
    samples.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  return median(samples)
}

function seedHistory(db, count) {
  const now = new Date().toISOString()
  for (let i = 0; i < count; i += 1) {
    const artifactId = `art_perf_${i}`
    const sourceId = `src_perf_${i}`
    db.run(
      `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, sender_contact_id, origin, kind, text, captured_at, created_at, independence_key)
       VALUES (?, 'main', 'desktop', 'desktop', ?, NULL, 'user', 'message', ?, ?, ?, ?)`,
      [sourceId, `perf-${i}`, `历史第 ${i} 条观察`, now, now, `perf-key-${i}`],
    )
    db.run(
      `INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at)
       VALUES (?, 'main', 'belief', ?, ?)`,
      [artifactId, now, now],
    )
    db.run(
      `INSERT INTO artifact_revisions (artifact_id, revision, state, statement, subject_refs, payload, confidence, basis_count, independent_evidence_count, salience, temporal, direct_extraction, created_at, updated_at, schema_version)
       VALUES (?, 1, 'active', ?, '[]', '{}', 'medium', 1, 1, 0, '{}', 0, ?, ?, '1.0')`,
      [artifactId, `历史结论 ${i}`, now, now],
    )
    db.run(
      `INSERT INTO artifact_evidence (artifact_id, revision, source_id, relation, quote, confidence, independence_key, created_at)
       VALUES (?, 1, ?, 'supports', NULL, 'medium', ?, ?)`,
      [artifactId, sourceId, `perf-key-${i}`, now],
    )
  }
}

const results = []
for (const size of SIZES) {
  const dir = mkdtempSync(join(tmpdir(), `psyche-growth-perf-${size}-`))
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
  const db = opened.db
  migrate(db, log)
  const core = new Core({ db, config: {}, logger: log, dataDir: dir })
  seedHistory(db, size)

  const oldCost = timeIt(() => {
    deriveGrowthNow(db)
  })

  const writeSamples = []
  for (let i = 0; i < 5; i += 1) {
    const start = process.hrtime.bigint()
    const source = await core.capture({
      platform: 'desktop',
      channel: 'desktop',
      sessionRef: `perf-write-${size}-${i}`,
      origin: 'user',
      kind: 'message',
      text: `性能采样第 ${size}-${i} 条`,
    })
    await core.remember({
      text: `性能采样结论 ${size}-${i}`,
      kind: 'belief',
      statement: `性能采样结论 ${size}-${i}`,
      sourceIds: [source.sourceId],
      confidence: 'medium',
      disclosure: 'public',
    })
    writeSamples.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  const writeCost = median(writeSamples)
  results.push({ size, deriveGrowthNowMs: Number(oldCost.toFixed(3)), rememberMs: Number(writeCost.toFixed(3)) })
  db.close?.()
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n[P2 Growth Gate 性能]')
console.table(results)

const first = results[0]
const last = results[results.length - 1]
const deriveRatio = last.deriveGrowthNowMs / first.deriveGrowthNowMs
const writeRatio = last.rememberMs / first.rememberMs
ok('旧路径（deriveGrowthNow）随历史增长明显变慢', deriveRatio > 3, { deriveRatio })
ok('新写路径（capture+remember）不随历史线性增长', writeRatio < 2.5, { writeRatio })

const outDir = join(process.cwd(), 'docs', 'eval', 'growth')
mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 'perf.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), sizes: SIZES, results, deriveRatio, writeRatio }, null, 2)}\n`,
)

console.log(`\n[P2 Growth Gate 性能] ${passed} 通过 ${failed} 失败`)
console.log(`性能数据写入 docs/eval/growth/perf.json`)
process.exit(failed === 0 ? 0 : 1)
