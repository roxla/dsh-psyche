// D1-3：Operations 失败重试端到端测试。
//
// 目标只有一个：证明「失败的操作可以安全重试，而且不会产生重复数据」。
// 故障注入在业务事务的**中间**：在 artifact_revisions 上建一个 BEFORE INSERT
// 触发器，让 remember 先成功写 event、再在写 revision 时整笔回滚。
// 这样测的是真事务回滚，而不是「一进来就抛错」。
//
// 跑法：node test/operations.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'

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

async function expectError(label, fn, code) {
  try {
    await fn()
    ok(label, false, { reason: '本应抛错但成功了' })
  } catch (error) {
    ok(`${label}（${error.code ?? 'no-code'}）`, code ? error.code === code : true, code ? { expected: code, message: error.message } : undefined)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-ops-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const scalar = (sql, params = []) => db.all(sql, params)[0]?.n ?? null
const countOf = (table) => Number(scalar(`SELECT count(*) AS n FROM ${table}`) ?? 0)

console.log('\n[D1-3] Operations 失败重试端到端')

const opArgs = {
  opId: 'op_d13_retry',
  text: '阿岚说她养了一只叫团子的橘猫，今年三岁。',
  kind: 'fact',
  statement: '阿岚养了一只叫团子的橘猫。',
  confidence: 'high',
}

// 1) 故障注入：让 revision 写入在事务中途失败
db.exec(`CREATE TRIGGER d13_fail_revision BEFORE INSERT ON artifact_revisions
         BEGIN SELECT RAISE(ABORT, 'D1-3 注入故障'); END`)
const eventsBefore = countOf('events')
const artifactsBefore = countOf('artifacts')

await expectError('第一次执行在事务中途失败', () => core.remember(opArgs))

const opRow = db.all(`SELECT status, error, result FROM operations WHERE op_id = ?`, [opArgs.opId])[0]
eq('operations 记下 failed', opRow?.status, 'failed')
ok('失败原因写进 error', typeof opRow?.error === 'string' && opRow.error.length > 0, opRow?.error)
eq('失败没有留下 event', countOf('events'), eventsBefore)
eq('失败没有留下 artifact', countOf('artifacts'), artifactsBefore)
eq('失败没有留下 revision', countOf('artifact_revisions'), 0)

// 2) 解除故障后，同 opId + 同参数重试
db.exec('DROP TRIGGER d13_fail_revision')
const retried = await core.remember(opArgs)
ok('同参重试成功', retried.ok === true, retried)
eq('重试不是重放', retried.replayed, false)
eq('重试后只有一份 event', countOf('events'), eventsBefore + 1)
eq('重试后只有一份 artifact', countOf('artifacts'), artifactsBefore + 1)
eq('重试后只有一个 revision', countOf('artifact_revisions'), 1)

// 3) 成功后再用同 opId + 同参数调用：只重放，不产生第二次副作用
const replay = await core.remember(opArgs)
eq('成功后再次调用是重放', replay.replayed, true)
eq('重放不新增 event', countOf('events'), eventsBefore + 1)
eq('重放不新增 revision', countOf('artifact_revisions'), 1)
eq('重放返回同一个 artifactId', replay.artifactId, retried.artifactId)

// 4) 同 opId 不同参数：冲突，且不执行
await expectError(
  '同 opId 换参数被拒',
  () => core.remember({ ...opArgs, statement: '阿岚养了一只叫别的名字的猫。' }),
  'E_IDEMPOTENT_CONFLICT',
)
eq('冲突没有新增 event', countOf('events'), eventsBefore + 1)

// 5) 成功记录不被后续重放覆盖
const finalRow = db.all(`SELECT status, result FROM operations WHERE op_id = ?`, [opArgs.opId])[0]
eq('operations 仍是 ok', finalRow?.status, 'ok')
ok('operations 保留了结果', typeof finalRow?.result === 'string' && finalRow.result.includes('artifactId'), finalRow?.result)

console.log(`\nOperations 自检：${passed} 通过 ${failed} 失败`)
db.close()
rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
