// Growth Gate：阶段推进的唯一自动入口是 syncGrowth()。
//
// 背景（v18，用户 2026-11-03 定性）：写入之后的 `#advanceAfterWrite()` 曾直接调
// `advancePhase()`，等于在 remember/revise 里开了第二个阶段写入口，`syncGrowth()`
// 就不是唯一闸门了。修复后写路径只做只读评估，真正落账只发生在 syncGrowth()。
//
// 六条回归：
// 1. 空库 syncGrowth 不推进
// 2. 普通 remember 满足闸门条件 → 只评估，阶段不变
// 3. syncGrowth 重校验证据 → 推进一次
// 4. 再调 syncGrowth → 幂等，不重复写里程碑
// 5. 证据不足时 syncGrowth 不推进
// 6. 注入失败 → 整笔回滚，阶段与里程碑都保持原样
//
// 跑法：node test/growth-gate.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
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

function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-growth-gate-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const phase = () => db.all(`SELECT phase FROM phase_state WHERE persona_id = 'main'`)[0].phase
const milestones = () => Number(db.all(`SELECT count(*) AS n FROM phase_milestones`)[0].n)
const countOf = (table) => Number(db.all(`SELECT count(*) AS n FROM ${table}`)[0].n)

async function capture(text, sessionRef, origin = 'user', platform = 'qq') {
  return core.capture({
    platform,
    channel: 'private',
    externalRoomId: 'gg-1',
    stableUserId: '40001',
    displayName: '阿岚',
    origin,
    kind: 'message',
    text,
    sessionRef,
  })
}

console.log('\n[Growth Gate] 阶段写入唯一入口')

// ── 1. 空库：不推进 ────────────────────────────────────────────────────────
eq('空库停在信任阶段', phase(), 'trust')
const empty = await core.syncGrowth()
eq('空库 syncGrowth 不推进', empty.advanced.length, 0)
eq('空库没有里程碑', milestones(), 0)

// ── 2. 普通 remember 满足条件：只评估，阶段不变 ───────────────────────────
const s1 = await capture('阿岚每天早上喝乌龙茶。', 'gg-a')
const s2 = await capture('她起床第一件事就是泡乌龙茶。', 'gg-b')
const belief = await core.remember({
  text: '阿岚每天早上喝乌龙茶。',
  kind: 'belief',
  statement: '阿岚每天早上喝乌龙茶。',
  sourceIds: [s1.sourceId, s2.sourceId],
  confidence: 'high',
})
ok('remember 晋升出结论', Boolean(belief.artifactId), belief)
eq('普通 remember 之后阶段仍是 trust', phase(), 'trust')
eq('普通 remember 不写里程碑', milestones(), 0)
// 只读评估能看到「闸门已满足」——这正是「只算不写」
const evaluated = deriveGrowthNow(db)
ok('只读评估认为信任闸已通过', evaluated.derived.gates.trust.passed, evaluated.derived.gates.trust)

// ── 3. syncGrowth：重校验后推进一次 ───────────────────────────────────────
const advanced = await core.syncGrowth()
eq('syncGrowth 推进一次', advanced.advanced.length, 1)
eq('推进的是信任闸', advanced.advanced[0].gate, 'trust')
eq('阶段变为自主', phase(), 'autonomy')
eq('写了 1 条里程碑', milestones(), 1)

// ── 4. 幂等：再调不重复写 ─────────────────────────────────────────────────
const again = await core.syncGrowth()
eq('再调 syncGrowth 不推进', again.advanced.length, 0)
eq('里程碑仍然只有 1 条', milestones(), 1)
eq('阶段没有回退', phase(), 'autonomy')

// ── 5. 证据不足：不推进 ───────────────────────────────────────────────────
const s3 = await capture('阿岚说她周末会去爬山。', 'gg-c')
await core.remember({
  text: '阿岚周末会去爬山。',
  kind: 'belief',
  statement: '阿岚周末会去爬山。',
  sourceIds: [s3.sourceId],
  confidence: 'high',
})
const beforeInsufficient = phase()
const insufficient = await core.syncGrowth()
eq('证据不足时 syncGrowth 不推进', insufficient.advanced.length, 0)
eq('阶段保持自主', phase(), beforeInsufficient)

// ── 6. 注入失败：整笔回滚 ─────────────────────────────────────────────────
// 用第二个库造出「trust 闸已满足」的条件，再让写里程碑的 INSERT 失败，
// 验证失败时阶段不变、没有半截里程碑（与 D1-3 同一个注入手法）。
const dir2 = mkdtempSync(join(tmpdir(), 'psyche-growth-gate-fail-'))
const opened2 = await openDatabase({ file: join(dir2, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db2 = opened2.db
migrate(db2, log)
const core2 = new Core({ db: db2, config: {}, logger: log, dataDir: dir2 })
const phase2 = () => db2.all(`SELECT phase FROM phase_state WHERE persona_id = 'main'`)[0].phase
const milestones2 = () => Number(db2.all(`SELECT count(*) AS n FROM phase_milestones`)[0].n)

const c1 = await core2.capture({
  platform: 'qq', channel: 'private', externalRoomId: 'gg-fail', stableUserId: '40002',
  displayName: '阿岚', origin: 'user', kind: 'message', text: '阿岚说她想学画画。', sessionRef: 'gg-f1',
})
const c2 = await core2.capture({
  platform: 'qq', channel: 'private', externalRoomId: 'gg-fail', stableUserId: '40002',
  displayName: '阿岚', origin: 'user', kind: 'message', text: '她最近每天都在练速写。', sessionRef: 'gg-f2',
})
await core2.remember({
  text: '阿岚想学画画。',
  kind: 'belief',
  statement: '阿岚想学画画。',
  sourceIds: [c1.sourceId, c2.sourceId],
  confidence: 'high',
})
eq('失败库：写后阶段仍是 trust', phase2(), 'trust')
db2.run(`CREATE TRIGGER gg_fail_milestone BEFORE INSERT ON phase_milestones
         BEGIN SELECT RAISE(ABORT, 'Growth Gate 注入故障'); END`)
let threw = false
try {
  await core2.syncGrowth()
} catch (error) {
  threw = true
  ok(`注入故障后 syncGrowth 抛错（${error.code ?? 'no-code'}）`, true)
}
if (!threw) ok('注入故障后 syncGrowth 抛错', false, '本应抛错但成功了')
eq('失败后阶段没有变', phase2(), 'trust')
eq('失败后没有留下里程碑', milestones2(), 0)
db2.run(`DROP TRIGGER gg_fail_milestone`)
const recovered = await core2.syncGrowth()
eq('触发器移除后 syncGrowth 能推进', recovered.advanced.length, 1)
eq('恢复后阶段变为自主', phase2(), 'autonomy')
eq('恢复后里程碑为 1', milestones2(), 1)

// ── 7. 阶段写入点审计（静态断言） ─────────────────────────────────────────
// 代码层已确认：UPDATE/INSERT phase_state 只出现在 growth.ts 的 advancePhase
// （唯一自动入口，只被 syncGrowth 调用）、commitIntegration（人确认）、schema seed。
// 这里做运行时断言：写路径没有绕过 syncGrowth 改动阶段。
const sources = await capture('阿岚说她想学做菜。', 'gg-d', 'external', 'bilibili')
await core.remember({
  text: '阿岚想学做菜。',
  kind: 'fact',
  statement: '阿岚想学做菜。',
  sourceIds: [sources.sourceId],
  confidence: 'high',
})
eq('外部来源写入后阶段仍不变', phase(), beforeInsufficient)
eq('外部来源写入后里程碑仍为 1', milestones(), 1)
eq('提示性操作没有写 operations 之外的阶段表', countOf('phase_state'), 1)

db2.close()
db.close()
rmSync(dir2, { recursive: true, force: true })
rmSync(dir, { recursive: true, force: true })
console.log(`\nGrowth Gate 自检：${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
