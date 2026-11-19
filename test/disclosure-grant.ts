// P2-FTS5 E5.3：披露授权（grant）——分类结果 vs 公开授权。
//
// Core 的默认是 restricted；工具层可以把普通内容放宽成 public，但「模型显式要求 public」
// 不是「用户授权公开」。敏感内容要落 public，必须由宿主侧流程先签发一条一次性 grant，
// 凭据绑定内容 hash（可选 artifact + revision），用完即废。
//
// 验收（E5.3）：
// 1. 敏感 + 显式 public + 无 grant → restricted，payload.grantRequired=true；
// 2. 普通 + 显式 public → public（不需要 grant）；
// 3. grant 签发后按内容绑定，可把敏感内容提到 public；
// 4. 同一 grant 只能消费一次；
// 5. 伪造 / 过期 / 内容不匹配的 grant 一律降回 restricted；
// 6. 绑定 artifact + revision 的 grant 只对那一条生效；
// 7. 授权审计行存在，used_at 有值。
//
// 跑法：node test/disclosure-grant.ts（需要先 npm run build）
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

const eq = (label, actual, expected) =>
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })

const dir = mkdtempSync(join(tmpdir(), 'psyche-disclosure-grant-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

console.log('\n[P2-FTS5 E5.3] 披露授权（分类 ≠ 授权）')

/** 造一条真实来源；同 sessionRef 的第二条会算同一活动窗口，所以这里按需换 session。 */
async function source(text, sessionRef) {
  const result = await core.capture({ text, sessionRef, platform: 'dsh', channel: 'desktop' })
  return result.sourceId
}

const sensitive = '用户的手机号是 13800138000，只在本地保存。'
const plain = '用户喜欢在晚上散步。'

// ── 1. 敏感 + 显式 public + 无 grant：降回 restricted ─────────────────
const src1 = await source('记住手机号 13800138000', 'session-grant-1')
const noGrant = await core.remember({
  text: '用户登记了手机号。',
  statement: sensitive,
  kind: 'fact',
  sourceIds: [src1],
  disclosure: 'public',
})
eq('GRANT-01 无授权时敏感内容落 restricted', noGrant.disclosure, 'restricted')
eq('GRANT-02 明确回执 grantRequired', noGrant.grantRequired, true)
const hits = await core.recall({ text: '手机号' }, { surface: 'personal' })
eq('GRANT-03 restricted 不进普通检索', hits.results.length, 0)

// ── 2. 普通内容显式 public：不需要 grant ─────────────────────────────
const src2 = await source('她喜欢傍晚散步', 'session-grant-2')
const plainOk = await core.remember({
  text: '用户喜欢散步。',
  statement: plain,
  kind: 'fact',
  sourceIds: [src2],
  disclosure: 'public',
})
eq('GRANT-04 普通内容显式 public 直接生效', plainOk.disclosure, 'public')
eq('GRANT-05 普通内容不需要授权', plainOk.grantRequired, false)

// ── 3. 签发 grant → 同一内容可落 public ──────────────────────────────
const grant = await core.grantDisclosure({
  statement: sensitive,
  grantedBy: 'owner:test',
  reason: '用户明确说这条可以公开检索',
  ttlMs: 60_000,
})
ok('GRANT-06 签发返回 grantId', grant.grantId.startsWith('grn_'), grant.grantId)
ok('GRANT-07 内容 hash 绑定的是那段正文', grant.contentHash.length === 64, grant.contentHash)

const src3 = await source('再记一次手机号', 'session-grant-3')
const withGrant = await core.remember({
  text: '用户再次登记手机号。',
  statement: sensitive,
  kind: 'fact',
  sourceIds: [src3],
  disclosure: 'public',
  disclosureGrant: grant.grantId,
})
eq('GRANT-08 有授权时敏感内容可落 public', withGrant.disclosure, 'public')
eq('GRANT-09 有授权时不再回执 grantRequired', withGrant.grantRequired, false)
const publicHits = await core.recall({ text: '手机号' }, { surface: 'personal' })
ok('GRANT-10 public 内容可被普通检索命中', publicHits.results.length > 0)

// ── 4. 同一 grant 只能用一次 ─────────────────────────────────────────
const src4 = await source('第三次手机号', 'session-grant-4')
const reuse = await core.remember({
  text: '第三次登记手机号。',
  statement: sensitive,
  kind: 'fact',
  sourceIds: [src4],
  disclosure: 'public',
  disclosureGrant: grant.grantId,
})
eq('GRANT-11 同一 grant 第二次使用被拒（降 restricted）', reuse.disclosure, 'restricted')
eq('GRANT-12 第二次回执 grantRequired', reuse.grantRequired, true)

// ── 5. 伪造 / 内容不匹配 / 过期 ─────────────────────────────────────
const src5 = await source('伪造授权', 'session-grant-5')
const forged = await core.remember({
  text: '伪造授权。',
  statement: sensitive,
  kind: 'fact',
  sourceIds: [src5],
  disclosure: 'public',
  disclosureGrant: 'grn_forged_000000',
})
eq('GRANT-13 伪造 grantId 被拒', forged.disclosure, 'restricted')

const otherGrant = await core.grantDisclosure({
  statement: '另一段敏感内容：身份证 110101199001011234。',
  grantedBy: 'owner:test',
  ttlMs: 60_000,
})
const src6 = await source('内容不匹配', 'session-grant-6')
const mismatch = await core.remember({
  text: '内容不匹配。',
  statement: sensitive,
  kind: 'fact',
  sourceIds: [src6],
  disclosure: 'public',
  disclosureGrant: otherGrant.grantId,
})
eq('GRANT-14 内容不匹配的 grant 被拒', mismatch.disclosure, 'restricted')

const expired = await core.grantDisclosure({
  statement: sensitive,
  grantedBy: 'owner:test',
  ttlMs: 1,
})
await new Promise((resolve) => setTimeout(resolve, 10))
const src7 = await source('过期授权', 'session-grant-7')
const expiredResult = await core.remember({
  text: '过期授权。',
  statement: sensitive,
  kind: 'fact',
  sourceIds: [src7],
  disclosure: 'public',
  disclosureGrant: expired.grantId,
})
eq('GRANT-15 过期 grant 被拒', expiredResult.disclosure, 'restricted')

// ── 6. 绑定 artifact + revision 的 grant 只对那一条生效 ──────────────
const src8 = await source('绑定目标的授权', 'session-grant-8')
const target = await core.remember({
  text: '目标结论。',
  statement: sensitive,
  kind: 'fact',
  sourceIds: [src8],
  disclosure: 'restricted',
})
const targetGrant = await core.grantDisclosure({
  artifactId: target.artifactId,
  grantedBy: 'owner:test',
  ttlMs: 60_000,
})
const revised = await core.revise({
  artifactId: target.artifactId,
  statement: sensitive,
  refs: [src8],
  disclosure: 'public',
  disclosureGrant: targetGrant.grantId,
})
eq('GRANT-16 绑定 artifact 的 grant 可把该条修订提到 public', revised.disclosure, 'public')
eq('GRANT-17 修订后仍是同一 artifact', revised.artifactId, target.artifactId)

// ── 7. 授权审计行 ───────────────────────────────────────────────────
const audit = db.get(
  `SELECT grant_id, used_at, before_disclosure, after_disclosure, granted_by FROM disclosure_grants WHERE grant_id = ?`,
  [grant.grantId],
)
ok('GRANT-18 授权审计行存在', audit !== undefined && audit !== null)
ok('GRANT-19 用过的 grant 有 used_at', typeof audit?.used_at === 'string' && audit.used_at.length > 0)
eq('GRANT-20 审计记录前后披露等级', [audit?.before_disclosure, audit?.after_disclosure], ['restricted', 'public'])
eq('GRANT-21 审计记录授权人', audit?.granted_by, 'owner:test')

// ── 8. 事务回滚：revision 写入失败时 grant 不被消费 ─────────────────────
const src9 = await source('回滚授权', 'session-grant-9')
const rollbackTarget = await core.remember({
  text: '回滚目标。',
  statement: sensitive,
  kind: 'fact',
  sourceIds: [src9],
  disclosure: 'restricted',
})
const rollbackGrant = await core.grantDisclosure({
  artifactId: rollbackTarget.artifactId,
  grantedBy: 'owner:test',
  ttlMs: 60_000,
})
let conflict = false
try {
  await core.revise({
    artifactId: rollbackTarget.artifactId,
    statement: sensitive,
    refs: [src9],
    disclosure: 'public',
    disclosureGrant: rollbackGrant.grantId,
    expectedRevision: 999,
  })
} catch (error) {
  conflict = error?.code === 'E_REVISION_CONFLICT'
}
ok('GRANT-22 错误 expectedRevision 被拒', conflict)
const afterConflict = db.get(
  `SELECT used_at FROM disclosure_grants WHERE grant_id = ?`,
  [rollbackGrant.grantId],
)
ok('GRANT-23 失败后 grant 未被消费', afterConflict?.used_at === null || afterConflict?.used_at === undefined)
const retried = await core.revise({
  artifactId: rollbackTarget.artifactId,
  statement: sensitive,
  refs: [src9],
  disclosure: 'public',
  disclosureGrant: rollbackGrant.grantId,
})
eq('GRANT-24 回滚后同一 grant 可正常使用', retried.disclosure, 'public')
const afterRetry = db.get(
  `SELECT used_at FROM disclosure_grants WHERE grant_id = ?`,
  [rollbackGrant.grantId],
)
ok('GRANT-25 重试成功后 grant 才被核销', typeof afterRetry?.used_at === 'string' && afterRetry.used_at.length > 0)

// ── 9. 一次授权不延伸未来修订（E5.5-E1）──────────────────────────────
const src10 = await source('授权不延伸', 'session-grant-10')
const base = await core.remember({
  text: '授权不延伸测试。',
  statement: sensitive,
  kind: 'fact',
  sourceIds: [src10],
  disclosure: 'restricted',
})
const g10 = await core.grantDisclosure({ artifactId: base.artifactId, grantedBy: 'owner:test', ttlMs: 60_000 })
const rev2 = await core.revise({
  artifactId: base.artifactId,
  statement: sensitive,
  refs: [src10],
  disclosure: 'public',
  disclosureGrant: g10.grantId,
})
eq('GRANT-26 首次授权把 rev2 提到 public', rev2.disclosure, 'public')
const rev3 = await core.revise({
  artifactId: base.artifactId,
  statement: '用户的另一个手机号是 13900139000，也要本地保存。',
  refs: [src10],
})
eq('GRANT-27 未显式指定披露时，敏感新内容不继承 public', rev3.disclosure, 'restricted')
ok('GRANT-28 新修订没有消费任何 grant', rev3.grantRequired === false)

// 旧 revision 的 grant 不能授权新的 head。
const src11 = await source('旧版本授权', 'session-grant-11')
const a11 = await core.remember({
  text: '旧版本授权测试。',
  statement: sensitive,
  kind: 'fact',
  sourceIds: [src11],
  disclosure: 'restricted',
})
const g11 = await core.grantDisclosure({ artifactId: a11.artifactId, grantedBy: 'owner:test', ttlMs: 60_000 })
const r2 = await core.revise({
  artifactId: a11.artifactId,
  statement: sensitive,
  refs: [src11],
  disclosure: 'restricted',
})
eq('GRANT-29 先普通修订到 rev2', r2.revision, 2)
const r3 = await core.revise({
  artifactId: a11.artifactId,
  statement: '用户的第三个手机号是 13700137000。',
  refs: [src11],
  disclosure: 'public',
  disclosureGrant: g11.grantId,
})
eq('GRANT-30 旧 revision 的 grant 不能授权新的 head', r3.disclosure, 'restricted')
const g11Row = db.get(`SELECT used_at FROM disclosure_grants WHERE grant_id = ?`, [g11.grantId])
ok('GRANT-31 该 grant 仍未被消费', g11Row?.used_at === null || g11Row?.used_at === undefined)

// ── 10. 撤销 ────────────────────────────────────────────────────────
const src12 = await source('撤销授权', 'session-grant-12')
const a12 = await core.remember({
  text: '撤销授权测试。',
  statement: sensitive,
  kind: 'fact',
  sourceIds: [src12],
  disclosure: 'restricted',
})
const g12 = await core.grantDisclosure({ artifactId: a12.artifactId, grantedBy: 'owner:test', ttlMs: 60_000 })
const revoked = await core.revokeDisclosureGrant({ grantId: g12.grantId, revokedBy: 'host:owner' })
eq('GRANT-32 撤销成功', revoked.alreadyRevoked, false)
const r4 = await core.revise({
  artifactId: a12.artifactId,
  statement: sensitive,
  refs: [src12],
  disclosure: 'public',
  disclosureGrant: g12.grantId,
})
eq('GRANT-33 已撤销的 grant 不能消费，落回 restricted', r4.disclosure, 'restricted')
let revokeConsumedRejected = false
try {
  await core.revokeDisclosureGrant({ grantId: g10.grantId })
} catch (error) {
  revokeConsumedRejected = error && error.code === 'E_STATE'
}
ok('GRANT-34 已消费的 grant 不能撤销', revokeConsumedRejected)

// ── 11. 签发幂等 ─────────────────────────────────────────────────────
const grantOpId = 'grant-op-idem-1'
const firstGrant = await core.grantDisclosure({ statement: sensitive, grantedBy: 'owner:test', opId: grantOpId })
const againGrant = await core.grantDisclosure({ statement: sensitive, grantedBy: 'owner:test', opId: grantOpId })
eq('GRANT-35 同 opId 重放拿回同一张 grant', againGrant.grantId, firstGrant.grantId)
ok('GRANT-36 重放标记 replayed', againGrant.replayed === true && firstGrant.replayed === false)
const opRows = db.get(`SELECT COUNT(*) AS n FROM disclosure_grants WHERE op_id = ?`, [grantOpId]).n
eq('GRANT-37 同 opId 只落一行', opRows, 1)
let opConflict = false
try {
  await core.grantDisclosure({ statement: '另一段敏感内容 13600136000。', grantedBy: 'owner:test', opId: grantOpId })
} catch (error) {
  opConflict = error && error.code === 'E_IDEMPOTENT_CONFLICT'
}
ok('GRANT-38 同 opId 不同内容被拒', opConflict)

// ── 12. 只读审计列表 ────────────────────────────────────────────────
const listed = await core.listDisclosureGrants({ artifactId: base.artifactId })
ok('GRANT-39 授权列表可按 artifact 过滤', listed.rows.length >= 1)
ok('GRANT-40 列表不含正文', !JSON.stringify(listed).includes('手机号'))

// ── 13. 一次性授权不随修订继承 ──────────────────────────────────────────────
// 用户只授权 r2 公开；r3 即使是非敏感内容也不能自动沿用，必须为这一版重新申请。
const inheritedSource = await source('护照和证件放在哪里', 'session-grant-13')
const inheritable = await core.remember({
  text: '护照号记一下。',
  statement: '我的护照号是 E12345678。',
  kind: 'fact',
  sourceIds: [inheritedSource],
  disclosure: 'public',
})
eq('GRANT-41 敏感内容无 grant 落 restricted', inheritable.disclosure, 'restricted')

const inheritableGrant = await core.grantDisclosure({
  artifactId: inheritable.artifactId,
  grantedBy: 'host:owner',
  ttlMs: 60_000,
})
const inheritedR2 = await core.revise({
  artifactId: inheritable.artifactId,
  statement: '我的护照号是 E12345678。',
  refs: [inheritedSource],
  disclosure: 'public',
  disclosureGrant: inheritableGrant.grantId,
})
eq('GRANT-42 凭 grant 授权后落 public', inheritedR2.disclosure, 'public')

const inheritedR3 = await core.revise({
  artifactId: inheritable.artifactId,
  statement: '护照放在书桌第二个抽屉。',
  refs: [inheritedSource],
})
eq('GRANT-43 下一次非敏感修订不继承 grant 的 public', inheritedR3.disclosure, 'restricted')

const inheritedR4Grant = await core.grantDisclosure({
  statement: '护照放在书桌第二个抽屉。',
  grantedBy: 'host:owner',
})
const inheritedR4 = await core.revise({
  artifactId: inheritable.artifactId,
  statement: '护照放在书桌第二个抽屉。',
  refs: [inheritedSource],
  disclosure: 'public',
  disclosureGrant: inheritedR4Grant.grantId,
})
eq('GRANT-44 为这一版重新授权后落 public', inheritedR4.disclosure, 'public')

const inheritedR5 = await core.revise({
  artifactId: inheritable.artifactId,
  statement: '护照在抽屉里，出差记得带。',
  refs: [inheritedSource],
})
eq('GRANT-45 再下一版仍然不继承', inheritedR5.disclosure, 'restricted')

// 对照：普通非敏感内容的 public 由默认策略提供，可以正常继承，不受上面规则影响
const inheritedNormal = await core.remember({
  text: '周末做什么。',
  statement: '周末一般在家看书。',
  kind: 'fact',
  sourceIds: [inheritedSource],
  disclosure: 'public',
})
const inheritedNormal2 = await core.revise({
  artifactId: inheritedNormal.artifactId,
  statement: '周末一般在家看书或散步。',
  refs: [inheritedSource],
})
eq('GRANT-46 普通 public 仍按原规则继承', inheritedNormal2.disclosure, 'public')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
db.close()
rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
