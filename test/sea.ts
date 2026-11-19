// 意识海场景与下钻的回归测试。
//
// 覆盖四件事：
// 1. 分簇（subject 优先、无 subject 回退 kind）——决定星的落点；
// 2. 新鲜度（recency）——决定星的亮度，只影响观感，不影响排序；
// 3. 弱连（topic 边）——只在跨簇、共享低频词、且该词命中 2–5 个点时连；
// 4. 下钻（buildNodeDetail）——结论的 head/版本/证据/触发事件，事件的来源/触发结论。
//
// 这条测试不打真实 HTTP：路由只是把 buildNodeDetail 的返回值包一层，
// 把纯函数测住，比起一个宿主去点星便宜得多。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { buildSeaScene, resolveSeaWindow } from '../dist/lib/sea.js'
import { buildNodeDetail } from '../dist/lib/node-detail.js'

const tag = 'sea'
let passed = 0
let failed = 0

/** 断言：条件为真才通过；失败时打一行带标签的详情，方便直接定位。 */
function ok(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  console.log(`  FAIL ${label}${detail ? `：${detail}` : ''}`)
}

/** 断言：两个值严格相等（对象先 JSON 化，避免引用比较误判）。 */
function eq(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
}

/** 断言：调用会抛错（只关心是否抛，不关心消息）。 */
function throws(label: string, fn: () => unknown): void {
  try {
    fn()
    failed += 1
    console.log(`  FAIL ${label}：没有抛错`)
  } catch {
    passed += 1
  }
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-sea-'))
const file = join(dir, 'memory.sqlite3')

let closeDb: (() => void) | null = null
try {
  const opened = await openDatabase({ file, driverPreference: 'auto' })
  const db = opened.db
  closeDb = () => db.close()
  migrate(db, () => undefined)

  // 四个人格结论 + 一条经历：足够同时测分簇、回退、弱连、下钻。
  // 时间跨度故意拉开（11 月 vs 6 月），好让 recency 的差异看得见。
  db.run(
    `INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
    [
      'art_a', 'main', 'fact', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z',
      'art_b', 'main', 'belief', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z',
      'art_c', 'main', 'belief', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z',
      'art_d', 'main', 'impression', '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z',
    ],
  )
  db.run(
    `INSERT INTO artifact_revisions
       (artifact_id, revision, state, statement, subject_refs, confidence, basis_count,
        independent_evidence_count, disclosure, created_at, updated_at)
     VALUES (?, 1, 'active', ?, ?, 'high', 1, 1, 'public', ?, ?),
            (?, 1, 'active', ?, ?, 'medium', 1, 1, 'public', ?, ?),
            (?, 1, 'active', ?, ?, 'medium', 1, 1, 'public', ?, ?),
            (?, 1, 'active', ?, ?, 'low', 1, 1, 'public', ?, ?)`,
    [
      'art_a', '用户喜欢猫猫', '["user"]', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z',
      'art_b', '用户最近在学做饭', '["user"]', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z',
      'art_c', '猫猫是很好的谈资', '["topic:猫"]', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z',
      'art_d', '用户说话很直接', '[]', '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z',
    ],
  )

  // 来源与事件：给 art_a 挂一条证据和一个触发事件，供下钻断言。
  db.run(
    `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at)
     VALUES ('src_1', 'main', 'dsh-session', 'desktop', 'session-1', 'user', 'message', '我喜欢猫', ?, ?)`,
    ['2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'],
  )
  db.run(
    `INSERT INTO events (event_id, persona_id, kind, type, at, subject_refs, text, confidence, created_at)
     VALUES ('evt_1', 'main', 'interaction', 'conversation', ?, '["user"]', '用户说喜欢猫', 'high', ?)`,
    ['2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'],
  )
  db.run(`INSERT INTO event_sources (event_id, source_id) VALUES ('evt_1', 'src_1')`)
  db.run(
    `INSERT INTO artifact_evidence
       (artifact_id, revision, source_id, relation, quote, confidence, independence_key, created_at)
     VALUES ('art_a', 1, 'src_1', 'supports', '我喜欢猫', 'high', 'session-1:1', ?)`,
    ['2026-11-01T00:00:00.000Z'],
  )
  db.run(
    `INSERT INTO artifact_trigger_events (artifact_id, revision, event_id) VALUES ('art_a', 1, 'evt_1')`,
  )

  const now = Date.parse('2026-11-06T00:00:00.000Z')
  const scene = buildSeaScene(db, { now, artifactLimit: 50, eventLimit: 50 })
  const byId = new Map(scene.nodes.map((node: any) => [node.id, node]))

  // 1. 分簇：同 subject 同簇、名字用 subject 原文；空 subject 回退 kind。
  eq('场景里有四个结论点加一个经历点', scene.nodes.length, 5)
  eq('art_a 落在 user 簇', byId.get('art_a')?.cluster, 'user')
  eq('art_a 的簇名显示为「用户」', byId.get('art_a')?.clusterName, '用户')
  eq('art_c 用 topic:猫 建簇', byId.get('art_c')?.cluster, 'topic:猫')
  eq('art_c 的簇名去掉 topic: 前缀', byId.get('art_c')?.clusterName, '猫')
  eq('art_d 无 subject 回退到 impression', byId.get('art_d')?.cluster, 'impression')
  eq('事件落在 user 簇（事件也认 subject）', byId.get('evt_1')?.cluster, 'user')
  ok('stats 里带 byCluster 计数', (scene.stats.byCluster?.user ?? 0) >= 2, JSON.stringify(scene.stats.byCluster))

  // 1.5 时间与差异元数据：createdAt/revisedAt 只做标记；窗口只过滤当前可读记录。
  eq('结论 createdAt 来自 artifact 首次写入', byId.get('art_a')?.createdAt, '2026-11-01T00:00:00.000Z')
  eq('结论 revisedAt 来自 head revision', byId.get('art_a')?.revisedAt, '2026-11-01T00:00:00.000Z')
  const windowed = buildSeaScene(db, {
    now,
    from: '2026-10-31T00:00:00.000Z',
    to: '2026-11-02T12:00:00.000Z',
    artifactLimit: 50,
    eventLimit: 50,
  })
  eq('窗口只留 11 月 1–2 日的两条结论', windowed.stats.artifacts, 2)
  ok('窗口排除 6 月的旧结论', !windowed.nodes.some((node: any) => node.id === 'art_b'))
  eq('窗口内总数按窗口统计', windowed.stats.totalArtifacts, 2)
  eq('空窗口参数视为未提供', resolveSeaWindow(new URLSearchParams()), {})
  eq(
    '合法窗口原样返回',
    resolveSeaWindow(new URLSearchParams('from=2026-10-31T00%3A00%3A00.000Z&to=2026-11-02T12%3A00%3A00.000Z')),
    { from: '2026-10-31T00:00:00.000Z', to: '2026-11-02T12:00:00.000Z' },
  )
  throws('非法 from 抛错', () => resolveSeaWindow(new URLSearchParams('from=not-a-date')))
  throws('from 晚于 to 抛错', () =>
    resolveSeaWindow(new URLSearchParams('from=2026-11-03T00%3A00%3A00.000Z&to=2026-11-02T00%3A00%3A00.000Z')),
  )
  const capped = buildSeaScene(db, { now, artifactLimit: 1, eventLimit: 1 })
  eq('截断时显示数=limit', capped.stats.displayedArtifacts, 1)
  eq('截断时总数仍是全量', capped.stats.totalArtifacts, 4)
  ok('显示数小于总数时标 truncated', capped.stats.truncated)
  eq('没有 persona.json 时 instanceKey 为 null', scene.instanceKey, null)
  eq('没有 instanceKey 时关闭差异', scene.diffAvailable, false)
  writeFileSync(
    join(dir, 'persona.json'),
    JSON.stringify({ initialization: { identityHash: 'a'.repeat(64) } }),
  )
  const keyed = buildSeaScene(db, { now })
  ok(
    '有身份哈希时 instanceKey 为 16 位',
    typeof keyed.instanceKey === 'string' && keyed.instanceKey.length === 16,
    String(keyed.instanceKey),
  )
  eq('同一数据实例 key 稳定', keyed.instanceKey, buildSeaScene(db, { now }).instanceKey)
  eq('同一数据实例可做差异', keyed.diffAvailable, true)

  // 2. 新鲜度：新点接近 1，旧点明显更暗，但都留底盘 0.35。
  const fresh = Number(byId.get('art_a')?.recency)
  const old = Number(byId.get('art_b')?.recency)
  ok('新点 recency 接近 1', fresh > 0.9 && fresh <= 1, String(fresh))
  ok('旧点 recency 明显更低', old < 0.55 && old >= 0.35, String(old))
  ok('recency 永远不低于底盘', old >= 0.35, String(old))

  // 3. 弱连：art_a 与 art_c 跨簇共享「猫」，应该有一条 topic 边；
  //    同簇的两颗星不靠 topic 连（那是真关系该干的事）。
  const topicEdges = scene.edges.filter((edge: any) => edge.kind === 'topic')
  const crosses = topicEdges.some(
    (edge: any) => (edge.a === 'art_a' && edge.b === 'art_c') || (edge.a === 'art_c' && edge.b === 'art_a'),
  )
  ok('跨簇共享「猫」连出一条 topic 边', crosses, JSON.stringify(topicEdges))
  const sameCluster = topicEdges.some((edge: any) => {
    const a = byId.get(edge.a)
    const b = byId.get(edge.b)
    return a && b && a.cluster === b.cluster
  })
  ok('topic 边不连同簇的点', !sameCluster)

  // 4. 下钻：结论带 head/版本/证据元数据/触发事件；事件不返回正文与 Source。
  const artifactDetail = buildNodeDetail(db, 'art_a')
  eq('下钻结论返回 artifact 类型', artifactDetail?.kind, 'artifact')
  if (artifactDetail && artifactDetail.kind === 'artifact') {
    eq('head 是最新版本', artifactDetail.head?.revision, 1)
    eq('head 正文可读', artifactDetail.head?.statement, '用户喜欢猫猫')
    eq('版本列表有 1 条', artifactDetail.revisions.length, 1)
    eq('证据只给关系元数据', artifactDetail.evidence[0]?.relation, 'supports')
    eq('证据不返回 Source 正文', (artifactDetail.evidence[0] as unknown as { text?: unknown }).text, undefined)
    eq('触发事件有 1 条', artifactDetail.triggers[0]?.eventId, 'evt_1')
    eq('证据上限不越过 5', artifactDetail.evidence.length <= 5, true)
  }

  const eventDetail = buildNodeDetail(db, 'evt_1')
  eq('下钻事件返回 event 类型', eventDetail?.kind, 'event')
  if (eventDetail && eventDetail.kind === 'event') {
    eq('事件不返回正文', (eventDetail as unknown as { text?: unknown }).text, undefined)
    eq('事件只报来源计数', eventDetail.sources.count, 1)
    eq('事件来源被撤回展示', eventDetail.sources.withheld, true)
    const firstTriggered = eventDetail.triggered[0]
    eq('事件触发结论可读（public）', firstTriggered?.withheld === false && firstTriggered.artifactId, 'art_a')
  }

  // 5. 确定性截断：同一时间的并列项按 artifact_id 升序保留，截断集合可复现。
  db.run(
    `INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at)
     VALUES ('art_tie_b', 'main', 'fact', ?, ?), ('art_tie_a', 'main', 'fact', ?, ?)`,
    ['2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z'],
  )
  db.run(
    `INSERT INTO artifact_revisions
       (artifact_id, revision, state, statement, subject_refs, confidence, basis_count,
        independent_evidence_count, disclosure, created_at, updated_at)
     VALUES ('art_tie_b', 1, 'active', '并列 b', '[]', 'low', 1, 1, 'public', ?, ?),
            ('art_tie_a', 1, 'active', '并列 a', '[]', 'low', 1, 1, 'public', ?, ?)`,
    ['2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z'],
  )
  const tie = buildSeaScene(db, { artifactLimit: 2, eventLimit: 0 })
  eq(
    '同一时间截断按 artifact_id 升序',
    tie.nodes.map((node: any) => node.id),
    ['art_tie_a', 'art_tie_b'],
  )

  eq('未知 id 返回 null（路由转 404）', buildNodeDetail(db, 'art_missing'), null)
  eq('空 id 返回 null', buildNodeDetail(db, ''), null)
} catch (error) {
  failed += 1
  console.log(`  FAIL 抛异常：${error instanceof Error ? error.stack : String(error)}`)
} finally {
  try {
    closeDb?.()
  } catch {
    // 已关闭或连接失效：不影响断言结果。
  }
  rmSync(dir, { recursive: true, force: true })
}

console.log(`[${tag}] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
