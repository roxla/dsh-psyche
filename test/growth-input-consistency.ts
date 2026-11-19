// P2 Growth Gate 语义一致性：写路径删掉全量派生后，判定结果必须完全不变。
//
// 覆盖：
// 1. 写入不推进阶段（仍只有 syncGrowth 能落账）
// 2. syncGrowth 在写入后能正常推进（旧行为保持）
// 3. `deriveGrowthNow` 与 `getGrowth` 的 stage / gates have/need 一致
// 4. 空库不报错、不产生假通过
// 5. 源码级契约：`#write` 内不再调用 `deriveGrowthNow`（性能修复的唯一入口）
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
const dir = mkdtempSync(join(tmpdir(), 'psyche-growth-consistency-'))
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const phase = () => db.get('SELECT phase FROM phase_state WHERE persona_id = ?', ['main'])?.phase

console.log('\n[P2 Growth Gate 一致性]')

// ── 1. 空库：只读派生不报错、不假通过 ─────────────────────────────────────
const empty = deriveGrowthNow(db)
ok('空库 stage=trust', empty.derived.stage === 'trust', empty.derived.stage)
ok('空库 trust 闸未通过', empty.derived.gates.trust.passed === false)

// ── 2. 写一条成熟 belief（两个独立来源）→ 写路径不推进阶段 ────────────────
const a = await core.capture({
  platform: 'desktop',
  channel: 'desktop',
  sessionRef: 'growth-a',
  origin: 'user',
  kind: 'message',
  text: '阿岚每天都喝乌龙茶。',
})
const b = await core.capture({
  platform: 'desktop',
  channel: 'desktop',
  sessionRef: 'growth-b',
  origin: 'user',
  kind: 'message',
  text: '早上第一件事就是泡乌龙茶。',
})
await core.remember({
  text: '阿岚每天都喝乌龙茶。',
  kind: 'belief',
  statement: '阿岚每天都喝乌龙茶。',
  sourceIds: [a.sourceId, b.sourceId],
  confidence: 'high',
  disclosure: 'public',
})
ok('写入后阶段仍是 trust（写路径不推进）', phase() === 'trust', phase())

const afterWrite = deriveGrowthNow(db)
ok('写入后 trust 闸已满足（只读派生能看到）', afterWrite.derived.gates.trust.passed === true)

// ── 3. syncGrowth 唯一落账 → 推进到 autonomy ─────────────────────────────
const synced = await core.syncGrowth()
ok('syncGrowth 报告推进了 trust 闸', synced.advanced.some((item) => item.gate === 'trust'), synced.advanced)
const advancedGrowth = await core.getGrowth()
ok('syncGrowth 推进到 autonomy', advancedGrowth.stage === 'autonomy', advancedGrowth.stage)
ok('phase_state 落账 autonomy', phase() === 'autonomy', phase())
const trustedMilestone = db.get(
  `SELECT COUNT(*) AS c FROM phase_milestones WHERE gate = 'trust' AND redacted_at IS NULL`,
)
ok('trust 里程碑写入 1 条', trustedMilestone.c === 1, trustedMilestone)

// ── 4. getGrowth 与 deriveGrowthNow 同源一致 ────────────────────────────
const growth = await core.getGrowth()
const derivedAgain = deriveGrowthNow(db)
ok('getGrowth.stage 与派生一致', growth.stage === derivedAgain.derived.stage)
ok(
  'getGrowth 四闸 have/need 与派生一致',
  growth.gates.every((gate) => {
    const source = derivedAgain.derived.gates[gate.gate]
    return source && source.have === gate.have && source.need === gate.need
  }),
)

// ── 5. 重复 syncGrowth 幂等（不重复写里程碑）────────────────────────────
const again = await core.syncGrowth()
ok('重复 syncGrowth 不再推进', again.advanced.length === 0, again.advanced)
const milestoneCount = db.get(`SELECT COUNT(*) AS c FROM phase_milestones WHERE gate = 'trust'`)
ok('trust 里程碑仍只有 1 条', milestoneCount.c === 1, milestoneCount)

// ── 6. 源码契约：#write 内不再调 deriveGrowthNow ─────────────────────────
const source = readFileSync(join(process.cwd(), 'packages', 'core', 'src', 'store.ts'), 'utf8')
const writeStart = source.indexOf('async #write<T extends object>')
const readStart = source.indexOf('async #read<T extends object>')
const writeBody = writeStart >= 0 && readStart > writeStart ? source.slice(writeStart, readStart) : ''
ok('#write 方法体存在', writeBody.length > 0)
ok('#write 内不再调用 deriveGrowthNow', !writeBody.includes('deriveGrowthNow('))
ok('#write 内不再调用 evaluateGrowthAfterWrite', !writeBody.includes('evaluateGrowthAfterWrite'))

db.close?.()
rmSync(dir, { recursive: true, force: true })

console.log(`\n[P2 Growth Gate 一致性] ${passed} 通过 ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
