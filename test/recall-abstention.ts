// P2-Recall R4-A：Abstention 契约（ABS-01~12）。
//
// 验收口径（用户 m19725 冻结）：
// - 没有合格记忆 = abstention，四种「全被拒」对外结构完全一致；
// - 有合格与不合格混合时只返回合格，不 abstain；
// - 自动注入 abstained 时不生成空 memory-context、不建 Manifest、不动原消息；
// - Composer 未注入不等于 abstention（abstained 描述召回阶段）；
// - 工具层成功/abstention 两种状态都正确渲染，guidance 来自 Core 唯一常量；
// - 数据库/查询异常保持异常语义，不包装成 no_eligible_results。
//
// 跑法：node test/recall-abstention.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { PreStepInjector } from '../dist/lib/pre-step-injection.js'
import { RuntimeInputStore } from '../dist/lib/runtime-input.js'
import { RECALL_ABSTAIN_GUIDANCE } from '../dist/lib/recall.js'
import { buildTools } from '../dist/lib/tools.js'

let passed = 0
let failed = 0

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-recall-abstain-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

console.log('\n[P2-Recall R4-A] Abstention 契约')

const now = new Date().toISOString()
// capture 带 senderContactId 时 sources 有外键，联系人必须先建。
for (const contactId of ['ct_alice', 'ct_bob']) {
  db.run(
    `INSERT INTO contacts (contact_id, persona_id, platform, stable_user_id, created_at, updated_at)
     VALUES (?, 'main', 'qq', ?, ?, ?)`,
    [contactId, contactId, now, now],
  )
}

let sourceSeq = 0

async function source(text: string, channel: 'desktop' | 'private' = 'desktop', senderContactId?: string): Promise<string> {
  sourceSeq += 1
  const captured = await core.capture({
    platform: 'dsh',
    channel,
    sessionRef: `abs-s${sourceSeq}`,
    origin: 'user',
    kind: 'message',
    ...(senderContactId === undefined ? {} : { senderContactId }),
    text,
  })
  return captured.sourceId
}

/** 两条不同会话来源 → 两条独立证据，才够升格成 fact。 */
async function fact(
  text: string,
  options: { disclosure?: 'public' | 'restricted' | 'secret'; channel?: 'desktop' | 'private'; contactId?: string } = {},
): Promise<string> {
  const channel = options.channel ?? 'desktop'
  const a = await source(text, channel, options.contactId)
  const b = await source(`${text}（补充确认）`, channel, options.contactId)
  const remembered = await core.remember({
    text,
    kind: 'fact',
    statement: text,
    sourceIds: [a, b],
    disclosure: options.disclosure ?? 'public',
    ...(options.contactId === undefined ? {} : { subjectRefs: [options.contactId] }),
  })
  if (!remembered.artifactId) throw new Error(`未升格：${JSON.stringify(remembered)}`)
  return remembered.artifactId
}

/** 取对外 payload（忽略 #read 的 ok/opId 壳）。 */
function shape(result: { results?: unknown; abstained?: boolean; abstainReason?: unknown; guidance?: unknown }): unknown {
  return {
    results: result.results,
    abstained: result.abstained,
    abstainReason: result.abstainReason,
    guidance: result.guidance,
  }
}

// ── 1. 四种「全被拒」对外结构完全一致 ───────────────────────────────────

// 1a. 原始检索无命中
const noCandidate = await core.recall({ text: '完全没有出现过的词 zzz' }, { surface: 'personal' })
eq('无原始候选 → abstained=true', noCandidate.abstained, true)
eq('无原始候选 → 统一原因', noCandidate.abstainReason, 'no_eligible_results')
eq('无原始候选 → results 空', noCandidate.results.length, 0)
eq('无原始候选 → guidance 用 Core 常量', noCandidate.guidance, RECALL_ABSTAIN_GUIDANCE)
ok('R4-A 不生成临时 runId', noCandidate.runId === undefined, noCandidate.runId)

// 1b. 命中但全部披露受限
const restrictedId = await fact('冰箱里有一张受限便签', { disclosure: 'restricted' })
const allRestricted = await core.recall({ text: '冰箱里有一张受限便签' }, { surface: 'personal' })
eq('全受限 → abstained=true', allRestricted.abstained, true)
ok('全受限 → 不返回受限正文', !JSON.stringify(allRestricted).includes(restrictedId), allRestricted)

// 1c. 命中但全部跨来源域（Bob 的私聊记忆，Alice 查不到）
const bobPrivate = await fact('Bob 的私聊暗号是青铜钥匙', { channel: 'private', contactId: 'ct_bob' })
const allOutOfScope = await core.recall({ text: 'Bob 的私聊暗号是青铜钥匙' }, { contactId: 'ct_alice', surface: 'private' })
eq('全跨域 → abstained=true', allOutOfScope.abstained, true)
ok('全跨域 → 不返回他人记忆', !JSON.stringify(allOutOfScope).includes(bobPrivate), allOutOfScope)

// 1d. 命中但全部 Evidence 异常（坏 evidence 行指向不存在的 Source）
const brokenEvidenceId = await fact('来源关联坏掉的结论')
db.run('PRAGMA foreign_keys = OFF')
db.run(
  `INSERT INTO artifact_evidence (artifact_id, revision, source_id, relation, independence_key, created_at)
   VALUES (?, 1, 'src_missing', 'supports', 'ik_abs_lost', ?)`,
  [brokenEvidenceId, now],
)
db.run('PRAGMA foreign_keys = ON')
const allBroken = await core.recall({ text: '来源关联坏掉的结论' }, { surface: 'personal' })
eq('全证据异常 → abstained=true', allBroken.abstained, true)

// 四场景对外结构逐字节一致（只有 results 都是空数组、原因与 guidance 相同）
const fourShapes = [noCandidate, allRestricted, allOutOfScope, allBroken].map(shape)
ok(
  '四种全拒的对外结构完全一致',
  fourShapes.every((item) => JSON.stringify(item) === JSON.stringify(fourShapes[0])),
  fourShapes,
)

// ── 2. 混合候选：只返回合格结果，不 abstain ────────────────────────────
const publicMixed = await fact('混合候选里的公开结论')
await fact('混合候选里的公开结论（受限版）', { disclosure: 'restricted' })
const mixed = await core.recall({ text: '混合候选里的公开结论' }, { surface: 'personal' })
eq('混合候选不 abstain', mixed.abstained, false)
eq('混合候选只返回合格的公开结论', mixed.results.length, 1)
eq('混合候选返回的就是那条公开结论', mixed.results[0]?.artifactId, publicMixed)
ok('混合候选不带 guidance', mixed.guidance === undefined, mixed.guidance)
ok('混合候选 abstainReason 为 null', mixed.abstainReason === null, mixed.abstainReason)

// ── 3. 自动注入：abstained 不生成空 memory-context、不建 Manifest ──────
const runtimeInputs = new RuntimeInputStore()
const injector = new PreStepInjector({ db, runtimeInputs, searchLimit: 12 })
const messages = [{ role: 'user', content: '完全没记过的查询词 zzz' }]
const injected = injector.inject({ id: 'sess-abs' }, messages, { turn: 1, step: 0 })
eq('自动注入空召回 → injected=false', injected.injected, false)
eq('自动注入空召回 → skipped=empty', injected.skipped, 'empty')
eq('自动注入空召回 → abstained=true', injected.abstained, true)
ok('自动注入空召回 → 不建 Manifest', injected.manifest === null, injected.manifest)
ok('自动注入空召回 → 消息数组是原引用', injected.messages === messages)
eq('自动注入空召回 → 消息数量不变', injected.messages.length, 1)

// ── 4. Composer 未注入 ≠ abstention ─────────────────────────────────────
// 用 maxItems=0 让 Composer 有候选但选不出内容：这是「召回有候选、注入阶段没东西」，
// 不是 no_eligible_results。候选必须是无 Evidence 的 global 结论，才能在无绑定注入器里通过准入。
const globalOnlyId = await fact('没有任何来源的全球候选词')
db.run('DELETE FROM artifact_evidence WHERE artifact_id = ?', [globalOnlyId])
const zeroInjector = new PreStepInjector({ db, runtimeInputs, searchLimit: 12, maxItems: 0 })
const zeroMessages = [{ role: 'user', content: '没有任何来源的全球候选词' }]
const zeroComposed = zeroInjector.inject({ id: 'sess-zero' }, zeroMessages, { turn: 1, step: 0 })
eq('Composer 空注入 → injected=false', zeroComposed.injected, false)
eq('Composer 空注入 → 不算 abstention', zeroComposed.abstained, false)
ok('Composer 空注入 → 有 composed 但 text 为空', zeroComposed.composed !== null && zeroComposed.composed.text === '', zeroComposed.composed)
ok('Composer 空注入 → 不建 Manifest', zeroComposed.manifest === null)
ok('Composer 空注入 → 消息数组是原引用', zeroComposed.messages === zeroMessages)

// ── 5. 工具层渲染：abstention 不能显示成普通空列表 ──────────────────────
type ToolLike = { name: string; output: { render: (args: unknown, value: unknown) => { type: string; text: string }[] } }
const tools = buildTools(core as never) as unknown as ToolLike[]
const recallTool = tools.find((tool) => tool.name === 'psyche_recall')
ok('存在 psyche_recall 工具', recallTool !== undefined)

const abstainRender = recallTool?.output.render({}, {
  ok: true,
  results: [],
  abstained: true,
  abstainReason: 'no_eligible_results',
  guidance: RECALL_ABSTAIN_GUIDANCE,
})
eq('abstention 渲染直接给固定 guidance', abstainRender?.[0]?.text, RECALL_ABSTAIN_GUIDANCE)

const okRender = recallTool?.output.render({}, {
  ok: true,
  results: [
    {
      artifactId: 'art_demo',
      kind: 'fact',
      revision: 2,
      state: 'active',
      statement: '阿岚喜欢白茶',
      disclosure: 'public',
      confidence: 'high',
      supportEvidenceCount: 2,
      updatedAt: now,
      relatedEvents: [],
    },
  ],
  abstained: false,
  abstainReason: null,
})
ok('成功结果渲染成结论列表', (okRender?.[0]?.text ?? '').includes('阿岚喜欢白茶'), okRender)
ok('成功结果不出现 abstention 文案', !(okRender?.[0]?.text ?? '').includes('没有找到可用的记忆'), okRender)

// ── 6. 数据库/查询异常保持异常语义 ──────────────────────────────────────
let queryError: unknown = null
try {
  await core.recall({ text: '长'.repeat(300) }, { surface: 'personal' })
} catch (error) {
  queryError = error
}
ok('超长查询抛错而不是 abstention', queryError !== null, queryError)
eq('超长查询的错误码', (queryError as { code?: string } | null)?.code, 'E_QUERY_TOO_LONG')

console.log(`\n[P2-Recall R4-A] ${passed} 通过 ${failed} 失败`)

db.close()
rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
