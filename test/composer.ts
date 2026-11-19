// P2-FTS5 E5.1：Composer 注入安全测试。
//
// 冻结语义（p2-fts5-e5-freeze.md）：
// 1. 注入四条件：当前 head + 状态准入 + disclosure=public + Scope 匹配
// 2. Composer **不信任候选字段**：revision/state/disclosure/statement 一律回库重读
// 3. restricted/secret 不得出现在最终注入文本；旧 revision 不得注入
// 4. Scope：Contact 私有内容不跨联系人；Channel 不跨渠道；全局记忆（无 contactId）可跨渠道
// 5. 统计只看最终注入：staleInjectionRate=0、disclosureLeaked=0
//
// 跑法：node test/composer.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
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

const dir = mkdtempSync(join(tmpdir(), 'psyche-composer-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)

const NOW = '2026-11-06T00:00:00.000Z'

function addArtifact(id, kind, revisions) {
  db.run(
    `INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at) VALUES (?, 'main', ?, ?, ?)`,
    [id, kind, NOW, NOW],
  )
  for (const rev of revisions) {
    db.run(
      `INSERT INTO artifact_revisions
         (artifact_id, revision, state, statement, subject_refs, confidence, basis_count,
          independent_evidence_count, created_at, updated_at, disclosure)
       VALUES (?, ?, ?, ?, ?, 'medium', 1, 1, ?, ?, ?)`,
      [
        id,
        rev.revision,
        rev.state,
        rev.statement,
        JSON.stringify(rev.subjectRefs ?? []),
        NOW,
        NOW,
        rev.disclosure,
      ],
    )
  }
}

const A1 = 'art_pub_fact'
const A2 = 'art_restricted_fact'
const A3 = 'art_secret_belief'
const A4 = 'art_revised_belief'
const A5 = 'art_forgotten_fact'
const A6 = 'art_contact_b_belief'
const A7 = 'art_challenged_belief'

addArtifact(A1, 'fact', [{ revision: 1, state: 'active', statement: '用户喜欢在周末整理相册', disclosure: 'public' }])
addArtifact(A2, 'fact', [
  { revision: 1, state: 'active', statement: '用户的身份证号是 110101199001011234（虚构）', disclosure: 'restricted' },
])
addArtifact(A3, 'belief', [
  { revision: 1, state: 'active', statement: '用户提到过一段不愿公开的往事', disclosure: 'secret' },
])
addArtifact(A4, 'belief', [
  { revision: 1, state: 'active', statement: '用户最近在准备考试', disclosure: 'public' },
  { revision: 2, state: 'active', statement: '用户考试通过了', disclosure: 'public' },
])
addArtifact(A5, 'fact', [
  { revision: 1, state: 'forgotten', statement: '用户以前住在老城区', disclosure: 'public' },
])
addArtifact(A6, 'belief', [
  { revision: 1, state: 'active', statement: 'B 的联系人私密事项', disclosure: 'public', subjectRefs: ['ct_b'] },
])
addArtifact(A7, 'belief', [
  { revision: 1, state: 'challenged', statement: '一条有争议的结论', disclosure: 'public' },
])

console.log('\n[P2-FTS5 E5.1] Composer 注入安全')

// ── 1. 空候选 ────────────────────────────────────────────────────────────
const empty = composeInjection(db, [], {})
eq('空候选：无注入文本', empty.text, '')
eq('空候选：统计归零', empty.stats.injected, 0)
eq('空候选：泄漏计数为 0', empty.stats.disclosureLeaked, 0)

// ── 2. 当前 head + public + active → 允许注入 ───────────────────────────
const okOne = composeInjection(db, [{ artifactId: A1 }], {})
eq('public head 允许注入', okOne.items.length, 1)
ok('注入文本使用库中 statement', okOne.text.includes('用户喜欢在周末整理相册'))
eq('注入项带 revision', okOne.items[0].revision, 1)
eq('注入项带 blockType', okOne.items[0].blockType, 'memory')
eq('无拒绝', okOne.rejections.length, 0)

// ── 3. restricted / secret 不注入 ────────────────────────────────────────
const blocked = composeInjection(db, [{ artifactId: A1 }, { artifactId: A2 }, { artifactId: A3 }], {})
eq('restricted/secret 被拦截', blocked.items.length, 1)
eq('两条 disclosure 拒绝', blocked.stats.disclosure, 2)
ok('注入文本不含受限内容', !blocked.text.includes('身份证'))
ok('注入文本不含秘密内容', !blocked.text.includes('往事'))
eq('disclosureLeaked 为 0', blocked.stats.disclosureLeaked, 0)
ok('拒绝记录含 artifactId 与原因', blocked.rejections.every((r) => r.artifactId && r.reason === 'disclosure'))

// ── 4. 旧 revision 不注入（stale） ───────────────────────────────────────
const stale = composeInjection(db, [{ artifactId: A4, revision: 1 }], {})
eq('旧 revision 被拒绝', stale.items.length, 0)
eq('记 stale', stale.stats.stale, 1)
ok('注入文本不含旧说法', !stale.text.includes('准备考试'))
const fresh = composeInjection(db, [{ artifactId: A4 }], {})
eq('不传 revision 时按 head 注入', fresh.items.length, 1)
ok('注入的是最新版本', fresh.text.includes('用户考试通过了'))
eq('注入项 revision=2', fresh.items[0].revision, 2)

// ── 5. forgotten 状态拒绝 ────────────────────────────────────────────────
const forgotten = composeInjection(db, [{ artifactId: A5 }], {})
eq('forgotten 不注入', forgotten.items.length, 0)
eq('记 state 拒绝', forgotten.stats.state, 1)
ok('注入文本不含已遗忘内容', !forgotten.text.includes('老城区'))

// ── 6. 上游伪造字段不被采信 ─────────────────────────────────────────────
const forged = composeInjection(
  db,
  [{ artifactId: A2, claimedState: 'active', claimedDisclosure: 'public', claimedStatement: '伪造的公开文本' }],
  {},
)
eq('伪造 disclosure 仍被拦截', forged.items.length, 0)
ok('伪造文本未进入注入', !forged.text.includes('伪造的公开文本'))
const forgedOk = composeInjection(db, [{ artifactId: A1, claimedStatement: '伪造的公开文本' }], {})
ok('允许注入时也只用库文本', forgedOk.text.includes('用户喜欢在周末整理相册'))
ok('库文本未被伪造文本替代', !forgedOk.text.includes('伪造的公开文本'))

// ── 7. Scope：Contact 隔离 ──────────────────────────────────────────────
const otherContact = composeInjection(db, [{ artifactId: A6, contactId: 'ct_b' }], { contactId: 'ct_a' })
eq('跨联系人被拒绝', otherContact.items.length, 0)
eq('记 scope 拒绝', otherContact.stats.scope, 1)
const sameContact = composeInjection(db, [{ artifactId: A6, contactId: 'ct_b' }], { contactId: 'ct_b' })
eq('同联系人允许注入', sameContact.items.length, 1)
const globalInContact = composeInjection(db, [{ artifactId: A1 }], { contactId: 'ct_a' })
eq('全局记忆可在联系人上下文注入', globalInContact.items.length, 1)

// ── 8. Scope：Channel 已移交 Recall Engine（R3.1）───────────────────────
// R3.1 起可见性（含渠道/群）在共享召回内核的 SQL 里完成，Composer 不再独立判 channel。
// 这里锁住「不留第二套判定」：渠道不同的候选不会被 Composer 二次拒绝，也不会记 scope 拒绝。
const channelMismatch = composeInjection(db, [{ artifactId: A1, channel: 'qq' }], { channel: 'desktop' })
eq('渠道由 Recall Engine 负责，Composer 不再拒绝', channelMismatch.items.length, 1)
eq('不记 scope 拒绝（渠道）', channelMismatch.stats.scope, 0)

// ── 9. challenged 允许 ──────────────────────────────────────────────────
const challenged = composeInjection(db, [{ artifactId: A7 }], {})
eq('challenged 允许注入', challenged.items.length, 1)

// ── 10. 预算 ────────────────────────────────────────────────────────────
const capped = composeInjection(db, [{ artifactId: A1 }, { artifactId: A7 }], {}, { maxItems: 1 })
eq('maxItems 截断', capped.items.length, 1)
const chars = composeInjection(db, [{ artifactId: A1 }], {}, { maxChars: 3 })
eq('maxChars 截断为空', chars.items.length, 0)
eq('maxChars 截断后文本为空', chars.text, '')

// ── 11. 去重 ────────────────────────────────────────────────────────────
const deduped = composeInjection(db, [{ artifactId: A1 }, { artifactId: A1 }], {})
eq('同一 revision 只注入一次', deduped.items.length, 1)

// ── 12. 全量统计口径 ────────────────────────────────────────────────────
const mixed = composeInjection(
  db,
  [
    { artifactId: A1 },
    { artifactId: A2 },
    { artifactId: A3 },
    { artifactId: A4, revision: 1 },
    { artifactId: A5 },
    { artifactId: A6, contactId: 'ct_b' },
    { artifactId: A7 },
  ],
  { contactId: 'ct_a', channel: 'desktop' },
)
eq('混合批次注入条数', mixed.items.length, 2)
eq('staleInjectionRate 为 0', mixed.stats.staleInjectionRate, 0)
eq('disclosureLeaked 为 0', mixed.stats.disclosureLeaked, 0)
eq('候选总数', mixed.stats.candidates, 7)
ok('每条拒绝都有原因', mixed.rejections.every((r) => typeof r.reason === 'string' && r.reason.length > 0))
ok('每条注入都有审计字段', mixed.items.every((i) => i.artifactId && i.revision !== undefined && i.blockType === 'memory'))

console.log(`\n[composer] ${passed} 通过 ${failed} 失败`)
db.close()
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  // Windows 句柄未释放时忽略清理失败，不盖掉断言结果
}
process.exitCode = failed === 0 ? 0 : 1
