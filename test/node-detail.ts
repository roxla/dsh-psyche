// 下钻详情的披露回归（P0）。
//
// 这里只测纯函数 buildNodeDetail()，不打真实 HTTP：路由只是把它包一层 JSON，
// 详情接口的披露边界完全由这个函数的返回结构决定。
//
// 断言分三层：
// 1. 完整响应序列化后不得出现受限正文/受限 Subject/受限目标 ID/Source 正文；
// 2. 受限 head、历史受限 revision、受限关系/血统各自按最小元数据返回；
// 3. 事件详情不得带正文与来源标识，异常消息不得夹带正文。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { buildNodeDetail } from '../dist/lib/node-detail.js'

const tag = 'node-detail'
let passed = 0
let failed = 0

function ok(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  console.log(`  FAIL ${label}${detail ? `：${detail}` : ''}`)
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
}

const SENTINELS = [
  'SENTINEL_RESTRICTED_HEAD',
  'SENTINEL_RESTRICTED_REVISION',
  'SENTINEL_SECRET_HEAD',
  'SENTINEL_SOURCE_TEXT',
  'SENTINEL_EVENT_TEXT',
  'art_restricted',
  'art_secret',
  'ct_sentinel_restricted',
]

const dir = mkdtempSync(join(tmpdir(), 'psyche-node-detail-'))
const file = join(dir, 'memory.sqlite3')
const T = '2026-11-07T00:00:00.000Z'

let closeDb: (() => void) | null = null
try {
  const opened = await openDatabase({ file, driverPreference: 'auto' })
  const db = opened.db
  closeDb = () => db.close()
  migrate(db, () => undefined)

  db.run(
    `INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at)
     VALUES ('art_pub', 'main', 'fact', ?, ?),
            ('art_restricted', 'main', 'fact', ?, ?),
            ('art_secret', 'main', 'stance', ?, ?)`,
    [T, T, T, T, T, T],
  )
  // art_pub 有两版：r2 public 是 head，r1 restricted 是历史版本。
  db.run(
    `INSERT INTO artifact_revisions
       (artifact_id, revision, state, statement, subject_refs, confidence, basis_count,
        independent_evidence_count, disclosure, created_at, updated_at)
     VALUES ('art_pub', 1, 'active', 'SENTINEL_RESTRICTED_REVISION', '["ct_sentinel_restricted"]',
             'medium', 1, 1, 'restricted', ?, ?),
            ('art_pub', 2, 'active', '公开结论：她喜欢猫。', '["topic:猫"]',
             'high', 1, 1, 'public', ?, ?),
            ('art_restricted', 1, 'active', 'SENTINEL_RESTRICTED_HEAD', '["ct_sentinel_restricted"]',
             'high', 1, 1, 'restricted', ?, ?),
            ('art_secret', 1, 'active', 'SENTINEL_SECRET_HEAD', '["ct_sentinel_restricted"]',
             'low', 1, 1, 'secret', ?, ?)`,
    [T, T, T, T, T, T, T, T],
  )

  // 来源与事件：正文都放哨兵，验证它们不会从详情接口漏出。
  db.run(
    `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at)
     VALUES ('src_1', 'main', 'dsh-session', 'desktop', 'session-1', 'user', 'message', 'SENTINEL_SOURCE_TEXT', ?, ?)`,
    [T, T],
  )
  db.run(
    `INSERT INTO events (event_id, persona_id, kind, type, at, subject_refs, text, confidence, created_at)
     VALUES ('evt_1', 'main', 'interaction', 'conversation', ?, '["user"]', 'SENTINEL_EVENT_TEXT', 'high', ?)`,
    [T, T],
  )
  db.run(`INSERT INTO event_sources (event_id, source_id) VALUES ('evt_1', 'src_1')`)

  // 证据：art_pub r2 挂 src_1（正文是哨兵，但 evidence DTO 只应给元数据）。
  db.run(
    `INSERT INTO artifact_evidence (artifact_id, revision, source_id, relation, quote, confidence, independence_key, created_at)
     VALUES ('art_pub', 2, 'src_1', 'supports', 'SENTINEL_SOURCE_TEXT', 'high', 'k1', ?)`,
    [T],
  )

  // 关系与血统：目标都是受限/密级对象，整条都应 withheld。
  db.run(
    `INSERT INTO artifact_relations (artifact_id, revision, target_artifact_id, relation, created_at)
     VALUES ('art_pub', 2, 'art_restricted', 'relatedTo', ?),
            ('art_pub', 2, 'art_secret', 'contradicts', ?)`,
    [T, T],
  )
  db.run(
    `INSERT INTO artifact_lineage (artifact_id, revision, from_artifact_id, from_revision, relation, created_at)
     VALUES ('art_pub', 2, 'art_restricted', 1, 'derivedFrom', ?)`,
    [T],
  )
  db.run(
    `INSERT INTO artifact_trigger_events (artifact_id, revision, event_id)
     VALUES ('art_pub', 2, 'evt_1'), ('art_restricted', 1, 'evt_1')`,
  )

  // ── 1. public head：正文可读，受限历史与受限目标全部隐藏 ─────────────────
  const pub = buildNodeDetail(db, 'art_pub')
  ok('public 详情可返回', pub?.kind === 'artifact')
  if (pub?.kind === 'artifact') {
    eq('head 正文可读', pub.head?.statement, '公开结论：她喜欢猫。')
    eq('public 详情自身不标记 withheld', pub.withheld, false)
    const previous = pub.revisions.find((item) => item.revision === 1)
    eq('历史受限 revision 正文置空', previous?.statement, null)
    eq('历史受限 revision 标记 withheld', previous?.withheld, true)
    ok('历史受限 revision 不返回 subjectRefs', previous !== undefined && !('subjectRefs' in previous))

    const text = JSON.stringify(pub)
    for (const sentinel of SENTINELS) {
      ok(`public 完整响应不含 ${sentinel}`, !text.includes(sentinel))
    }
    const relationText = JSON.stringify(pub.relations)
    ok('关系目标受限时整条隐藏', pub.relations.length === 2 && pub.relations.every((item) => item.withheld === true))
    ok('关系序列化不含目标 ID', !relationText.includes('art_restricted') && !relationText.includes('art_secret'))
    ok('血统来源受限时整条隐藏', pub.lineage.length === 1 && pub.lineage.every((item) => item.withheld === true))
    ok('证据只给元数据，不给 quote 正文', pub.evidence.every((item) => !('quote' in item) && !('text' in item)))
  }

  // ── 2. 受限 head：只给最小元数据，连历史 revision 都不查 ────────────────
  const restricted = buildNodeDetail(db, 'art_restricted')
  ok('受限详情仍能返回对象壳', restricted?.kind === 'artifact')
  if (restricted?.kind === 'artifact') {
    eq('受限详情标记 withheld', restricted.withheld, true)
    eq('受限详情不返回 head', restricted.head, null)
    eq('受限详情不返回 revision 列表', restricted.revisions.length, 0)
    eq('受限详情仍返回自身 id（最小元数据）', restricted.id, 'art_restricted')
    const text = JSON.stringify(restricted)
    // 自身 id 是允许返回的最小元数据；这里只禁止其它对象与正文。
    for (const sentinel of SENTINELS.filter((item) => item !== 'art_restricted')) {
      ok(`受限详情不含 ${sentinel}`, !text.includes(sentinel))
    }
  }

  // ── 3. 事件详情：无正文、无 Source 标识，触发目标按披露分层 ──────────────
  const event = buildNodeDetail(db, 'evt_1')
  ok('事件详情可返回', event?.kind === 'event')
  if (event?.kind === 'event') {
    ok('事件详情不返回正文', !('text' in event))
    eq('事件来源只报计数', event.sources.count, 1)
    eq('事件来源标记 withheld', event.sources.withheld, true)
    ok('事件触发目标含受限项且被隐藏', event.triggered.some((item) => item.withheld === true))
    ok('事件触发目标含 public 项且可读', event.triggered.some((item) => item.withheld === false && item.artifactId === 'art_pub'))
    const text = JSON.stringify(event)
    for (const sentinel of SENTINELS) {
      ok(`事件详情不含 ${sentinel}`, !text.includes(sentinel))
    }
  }

  // ── 4. 未知 id 与异常路径 ─────────────────────────────────────────────
  eq('未知 id 返回 null', buildNodeDetail(db, 'art_missing'), null)
  eq('空 id 返回 null', buildNodeDetail(db, ''), null)
  const broken = {
    get() {
      throw new Error('SQLITE_BUSY: database is locked')
    },
    all() {
      return []
    },
  } as unknown as Parameters<typeof buildNodeDetail>[0]
  try {
    buildNodeDetail(broken, 'art_pub')
    ok('异常路径应当抛错', false)
  } catch (error) {
    ok('异常消息不夹带正文（日志可安全记录）', !String(error).includes('SENTINEL'))
  }
} catch (error) {
  failed += 1
  console.log(`  FAIL 抛异常：${error instanceof Error ? error.stack : String(error)}`)
} finally {
  try {
    closeDb?.()
  } catch {
    // 已关闭：不影响断言结果。
  }
  rmSync(dir, { recursive: true, force: true })
}

console.log(`[${tag}] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
