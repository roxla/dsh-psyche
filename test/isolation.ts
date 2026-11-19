// P2-FTS5 E5.2：Contact / Channel 隔离测试。
//
// 冻结语义（p2-fts5-e5-freeze.md §4）：
// 1. 身份主键是 platform + stableUserId；显示名相同不等于同一个人
// 2. 同一 platform + stableUserId 重复解析是幂等（同一个 Contact）
// 3. Contact 私有内容不跨联系人注入；全局记忆（无 contactId）可跨渠道
// 4. Affinity / Contact Affect / relationship 只按 contactId 返回，不串人
// 5. 不自动合并 QQ 用户与 Desktop 用户
//
// 跑法：node test/isolation.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { composeInjection } from '../dist/lib/composer.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-isolation-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const NOW = '2026-11-06T00:00:00.000Z'

console.log('\n[P2-FTS5 E5.2] Contact / Channel 隔离')

// ── 1. 身份：platform + stableUserId ────────────────────────────────────
const qqUser = await core.resolveContact({ platform: 'qq', stableUserId: 'u-100', displayName: '小鹿' })
const desktopUser = await core.resolveContact({ platform: 'desktop', stableUserId: 'u-100', displayName: '小鹿' })
const qqAgain = await core.resolveContact({ platform: 'qq', stableUserId: 'u-100', displayName: '小鹿改名了' })
const otherQq = await core.resolveContact({ platform: 'qq', stableUserId: 'u-200', displayName: '小鹿' })

ok('相同 stableUserId 不同 platform 是两个 Contact', qqUser.contactId !== desktopUser.contactId)
eq('同 platform + 同 stableUserId 幂等', qqAgain.contactId, qqUser.contactId)
ok('相同显示名不同 stableUserId 是两个 Contact', qqUser.contactId !== otherQq.contactId)
eq('QQ Contact 的 platform', qqUser.platform, 'qq')
eq('Desktop Contact 的 platform', desktopUser.platform, 'desktop')

// ── 2. 造内容：全局 + A 私有 + B 私有 ──────────────────────────────────
function addArtifact(id, kind, statement, subjectRefs) {
  db.run(
    `INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at) VALUES (?, 'main', ?, ?, ?)`,
    [id, kind, NOW, NOW],
  )
  db.run(
    `INSERT INTO artifact_revisions
       (artifact_id, revision, state, statement, subject_refs, confidence, basis_count,
        independent_evidence_count, created_at, updated_at, disclosure)
     VALUES (?, 1, 'active', ?, ?, 'medium', 1, 1, ?, ?, 'public')`,
    [id, statement, JSON.stringify(subjectRefs), NOW, NOW],
  )
}

const G1 = 'art_global'
const A1 = 'art_a_private'
const B1 = 'art_b_private'
addArtifact(G1, 'fact', '全局记忆：用户喜欢整理相册', [])
addArtifact(A1, 'belief', 'A 的私密事项：A 在准备考试', [qqUser.contactId])
addArtifact(B1, 'belief', 'B 的私密事项：B 在准备面试', [desktopUser.contactId])

// ── 3. Composer 注入隔离 ────────────────────────────────────────────────
const scopeA = { contactId: qqUser.contactId, channel: 'qq' }
const candidates = [
  { artifactId: G1 },
  { artifactId: A1 },
  { artifactId: B1 },
]
const asA = composeInjection(db, candidates, scopeA)
eq('A 的上下文注入 2 条（全局 + A 私有）', asA.items.length, 2)
ok('A 看不到 B 的私密事项', !asA.text.includes('准备面试'))
ok('A 能看到自己的私密事项', asA.text.includes('准备考试'))
eq('跨联系人被拒绝', asA.stats.scope, 1)

const scopeB = { contactId: desktopUser.contactId, channel: 'desktop' }
const asB = composeInjection(db, candidates, scopeB)
ok('B 看不到 A 的私密事项', !asB.text.includes('准备考试'))
ok('B 能看到自己的私密事项', asB.text.includes('准备面试'))

// 全局记忆在无联系人上下文也能注入
const anonymous = composeInjection(db, [{ artifactId: G1 }], { channel: 'web' })
eq('全局记忆在匿名上下文可注入', anonymous.items.length, 1)
// 私有记忆在无联系人上下文不能注入
const anonymousPrivate = composeInjection(db, [{ artifactId: A1 }], { channel: 'web' })
eq('无联系人上下文不注入私有记忆', anonymousPrivate.items.length, 0)

// ── 4. 关系数据不串人 ──────────────────────────────────────────────────
const relA = await core.getRelationship(qqUser.contactId)
const relB = await core.getRelationship(desktopUser.contactId)
eq('关系记录指向 A', relA.contact.contactId, qqUser.contactId)
eq('关系记录指向 B', relB.contact.contactId, desktopUser.contactId)
ok('A 的关系不返回 B 的身份', relA.contact.contactId !== relB.contact.contactId)

// ── 5. 召回隔离（可信 Scope + 结构化 subject 过滤） ────────────────────
const recallA = await core.recall({ subject: qqUser.contactId }, { contactId: qqUser.contactId })
const recallB = await core.recall({ subject: desktopUser.contactId }, { contactId: desktopUser.contactId })
const recallAnon = await core.recall({})
ok('A 的召回含 A 私有', recallA.results.some((a) => a.artifactId === A1))
ok('A 的召回不含 B 私有', !recallA.results.some((a) => a.artifactId === B1))
ok('B 的召回含 B 私有', recallB.results.some((a) => a.artifactId === B1))
ok('B 的召回不含 A 私有', !recallB.results.some((a) => a.artifactId === A1))
ok(
  '无 Scope 不召回任何私有',
  !recallAnon.results.some((a) => a.artifactId === A1 || a.artifactId === B1),
  recallAnon.results.map((a) => a.artifactId),
)

console.log(`\n[isolation] ${passed} 通过 ${failed} 失败`)
db.close()
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  // Windows 句柄未释放时忽略清理失败
}
process.exitCode = failed === 0 ? 0 : 1
