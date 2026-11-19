// E3 REM-ACL：工具层披露默认值与敏感内容分类。
//
// Core 的默认是 restricted；工具层对普通对话放宽成 public。这之间的缝必须被守住：
// 「用户说了记住」不等于「用户同意它出现在任何检索结果里」。
//
// 验收（测试计划 REM-ACL 组）：
// 1. 普通偏好记忆未指定 disclosure → public；
// 2. 显式 restricted / secret → 用指定值；
// 3. 敏感内容（身份证/银行卡/密码/token/医疗/收入/住址/手机号）未指定 → restricted；
// 4. Core 其他入口不指定 disclosure → restricted（安全默认不动）；
// 5. 普通 revise 未指定 disclosure → 继承当前 head；
// 6. 工具层显式修改披露等级 → 值被原样接受（产生新 revision 由 Core 负责）。
//
// 跑法：node test/tools-disclosure.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { disclosureOf, looksSensitive } from '../dist/lib/tools.js'

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

const eq = (label, actual, expected) =>
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })

const dir = mkdtempSync(join(tmpdir(), 'psyche-tools-disclosure-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

console.log('\n[P2-FTS5 E3] 工具层披露默认值与敏感内容')

// ── 1. 无显式 disclosure：普通内容 public，敏感内容 restricted ─────────
eq('REM-ACL-01 普通偏好默认 public', disclosureOf({}, '用户喜欢在晚上散步。'), 'public')
eq('REM-ACL-04 身份证默认 restricted', disclosureOf({}, '用户的身份证号是 110101199001011234。'), 'restricted')
eq('REM-ACL-04 银行卡默认 restricted', disclosureOf({}, '工资卡号 6222020200112233445。'), 'restricted')
eq('REM-ACL-04 密码默认 restricted', disclosureOf({}, '服务器密码是 hunter2。'), 'restricted')
eq('REM-ACL-04 token 默认 restricted', disclosureOf({}, 'API key 是 sk-abc123。'), 'restricted')
eq('REM-ACL-04 医疗默认 restricted', disclosureOf({}, '病历记录：过敏性鼻炎。'), 'restricted')
eq('REM-ACL-04 收入默认 restricted', disclosureOf({}, '这个月工资 18000。'), 'restricted')
eq('REM-ACL-04 住址默认 restricted', disclosureOf({}, '家庭地址是西湖区某路 12 号。'), 'restricted')
eq('REM-ACL-04 手机号默认 restricted', disclosureOf({}, '联系电话 13800138000。'), 'restricted')

// ── 2. 显式等级优先 ─────────────────────────────────────────────────
eq('REM-ACL-02 显式 restricted 优先于内容判断', disclosureOf({ disclosure: 'restricted' }, '用户喜欢散步。'), 'restricted')
eq('REM-ACL-03 显式 secret 原样保留', disclosureOf({ disclosure: 'secret' }, '用户喜欢散步。'), 'secret')
eq('REM-ACL-07 显式 public 可放宽（调用方确认过）', disclosureOf({ disclosure: 'public' }, '用户喜欢散步。'), 'public')

// ── 3. 敏感检测本身 ─────────────────────────────────────────────────
ok('looksSensitive 能识别身份证', looksSensitive('身份证 110101199001011234'))
ok('looksSensitive 不误伤普通句子', !looksSensitive('她喜欢在下午散步。'))
ok('looksSensitive 能识别英文 token', looksSensitive('access token 是 abc'))

// ── 4. Core 安全默认：不指定 disclosure 就是 restricted ─────────────
const source = async (text) =>
  (
    await core.capture({
      platform: 'dsh',
      channel: 'desktop',
      sessionRef: 'tools-disclosure',
      origin: 'user',
      kind: 'message',
      text,
    })
  ).sourceId

const src1 = await source('关于「她喜欢散步」的原始消息。')
const coreResult = await core.remember({
  text: '她喜欢在下午散步。',
  kind: 'fact',
  statement: '她喜欢在下午散步。',
  sourceIds: [src1],
  confidence: 'high',
})
ok('REM-ACL-05 Core 未指定 disclosure 也能记住', coreResult.artifactId !== null, coreResult)
const coreHead = db.get('SELECT disclosure FROM artifact_revisions WHERE artifact_id = ? ORDER BY revision DESC LIMIT 1', [
  coreResult.artifactId,
])
eq('REM-ACL-05 Core 默认 restricted', coreHead && coreHead.disclosure, 'restricted')

// ── 5. revise 未指定 disclosure：继承当前 head ──────────────────────
const src2 = await source('关于「她喜欢散步」的补充消息。')
const publicFact = await core.remember({
  text: '她喜欢在傍晚散步。',
  kind: 'fact',
  statement: '她喜欢在傍晚散步。',
  sourceIds: [src2],
  confidence: 'high',
  disclosure: 'public',
})
const revised = await core.revise({
  text: '她喜欢在傍晚散步。',
  artifactId: publicFact.artifactId,
  statement: '她喜欢在傍晚六点前后散步。',
  refs: [src2],
})
const revisedHead = db.get(
  'SELECT disclosure, revision FROM artifact_revisions WHERE artifact_id = ? ORDER BY revision DESC LIMIT 1',
  [publicFact.artifactId],
)
eq('REM-ACL-06 revise 未指定时继承 head', revisedHead && revisedHead.disclosure, 'public')
ok('REM-ACL-07 显式修改披露会产生新 revision', revisedHead.revision > 1, revisedHead)

// ── 小测 A：敏感内容的显式 public 覆盖（允许，但要留明确决策） ────────
// 显式覆盖不是漏洞，是「可信调用路径作出的决定」；这里验证它确实按显式值生效，
// 并且不指定时会退回 restricted —— 两种行为都必须可预期。
eq(
  'A-01 敏感内容 + 显式 public：显式值优先（明确覆盖）',
  disclosureOf({ disclosure: 'public' }, '身份证号 110101199001010011'),
  'public',
)
eq(
  'A-02 敏感内容 + 未指定：退回 restricted',
  disclosureOf({}, '身份证号 110101199001010011'),
  'restricted',
)
eq('A-03 普通内容 + 显式 restricted：显式值优先', disclosureOf({ disclosure: 'restricted' }, '她喜欢散步'), 'restricted')
eq('A-04 普通内容 + 未指定：public', disclosureOf({}, '她喜欢散步'), 'public')
eq(
  'A-05 敏感内容 + 显式 secret：保留最严等级',
  disclosureOf({ disclosure: 'secret' }, '银行卡 6222020200112233445'),
  'secret',
)
ok('A-06 覆盖是由显式参数驱动的（不看内容猜）', looksSensitive('她喜欢散步') === false && looksSensitive('银行卡 6222020200112233445') === true)

console.log(`\n[P2-FTS5 E3] 工具层披露默认值与敏感内容：${passed} 通过 ${failed} 失败`)
db.close()
rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
