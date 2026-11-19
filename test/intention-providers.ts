// P6-3：五类关注源接到账本的 provider 契约。
//
// 只验证只读派生与三态判定；Host 行为另做隔离验收。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '../packages/core/dist/adapter.js'
import {
  deferIntention,
  getIntention,
  listIntentionEvents,
  listIntentions,
} from '../packages/core/dist/intention-store.js'
import { readLatestIntentionLine } from '../dist/lib/intention-context.js'
import {
  affectEpisodes,
  idleWindow,
  moodEpisodes,
  openCommitments,
  recurringThemes,
} from '../dist/lib/intention-providers.js'
import { runIntentionTick } from '../dist/lib/intention-tick.js'

let passed = 0
const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const NOW = '2026-01-10T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const HOUR = 60 * 60 * 1000
const personaId = 'main'

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

interface Fixture {
  dir: string
  db: Awaited<ReturnType<typeof openDatabase>>['db']
  close: () => void
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-intention-providers-'))
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: { debug() {}, info() {}, warn() {}, error() {} } })
  migrate(opened.db, { debug() {}, info() {}, warn() {}, error() {} })
  opened.db.run(
    `INSERT OR IGNORE INTO persona_config (persona_id, type, persona_json, created_at, updated_at)
     VALUES (?, 'preset', '{}', ?, ?)`,
    [personaId, NOW, NOW],
  )
  return {
    dir,
    db: opened.db,
    close: () => {
      opened.db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function addSource(db: Fixture['db'], id: string, capturedAt: string, independenceKey = id, metadata = '{}'): void {
  db.run(
    `INSERT INTO sources
       (source_id, persona_id, platform, channel, origin, kind, text, independence_key, metadata, captured_at, created_at)
     VALUES (?, ?, 'qq', 'private', 'user', 'message', ?, ?, ?, ?, ?)`,
    [id, personaId, `记录 ${id}`, independenceKey, metadata, capturedAt, capturedAt],
  )
}

function addEvent(
  db: Fixture['db'],
  id: string,
  type: string,
  at: string,
  text: string,
  causedBy: string | null = null,
): void {
  db.run(
    `INSERT INTO events (event_id, persona_id, kind, type, at, text, caused_by, confidence, created_at)
     VALUES (?, ?, 'interaction', ?, ?, ?, ?, 'medium', ?)`,
    [id, personaId, type, at, text, causedBy, at],
  )
}

function linkEventSource(db: Fixture['db'], eventId: string, sourceId: string): void {
  db.run(`INSERT INTO event_sources (event_id, source_id) VALUES (?, ?)`, [eventId, sourceId])
}

function addMood(db: Fixture['db'], dim: string, value: number, at: string, reason: string): void {
  db.run(
    `INSERT INTO global_mood_history (persona_id, dimension, value, reason, at) VALUES (?, ?, ?, ?, ?)`,
    [personaId, dim, value, reason, at],
  )
}

function addContact(db: Fixture['db'], contactId: string): void {
  db.run(
    `INSERT OR IGNORE INTO contacts
       (contact_id, persona_id, platform, stable_user_id, display_name, created_at, updated_at)
     VALUES (?, ?, 'qq', ?, ?, ?, ?)`,
    [contactId, personaId, contactId.replace(/^qq:/, ''), contactId, NOW, NOW],
  )
}

function addAffect(db: Fixture['db'], contactId: string, dim: string, value: number, at: string): void {
  addContact(db, contactId)
  db.run(
    `INSERT INTO contact_affect_history (persona_id, contact_id, dimension, value, at) VALUES (?, ?, ?, ?, ?)`,
    [personaId, contactId, dim, value, at],
  )
}

function addTheme(db: Fixture['db'], artifactId: string, sourceIds: string[], disclosure = 'public'): void {
  const at = iso(NOW_MS - HOUR)
  db.run(
    `INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at) VALUES (?, ?, 'fact', ?, ?)`,
    [artifactId, personaId, at, at],
  )
  db.run(
    `INSERT INTO artifact_revisions
       (artifact_id, revision, state, statement, payload, confidence, basis_count, independent_evidence_count,
        salience, temporal, created_at, updated_at)
     VALUES (?, 1, 'active', ?, ?, 'medium', ?, ?, 0.5, '{}', ?, ?)`,
    [
      artifactId,
      '对夜里散步这件事反复提起',
      JSON.stringify({ scope: { kind: 'personal' }, disclosure }),
      sourceIds.length,
      sourceIds.length,
      at,
      at,
    ],
  )
  for (const sourceId of sourceIds) {
    db.run(
      `INSERT INTO artifact_evidence (artifact_id, revision, source_id, relation, independence_key, created_at)
       VALUES (?, 1, ?, 'supports', ?, ?)`,
      [artifactId, sourceId, `ind:${sourceId}`, at],
    )
  }
}

async function run(): Promise<void> {
  let fixture = await setup()
  try {
    addSource(fixture.db, 'src_c1', iso(NOW_MS - 30 * HOUR))
    addEvent(fixture.db, 'evt_c1', 'commitment', iso(NOW_MS - 30 * HOUR), '答应整理房间')
    linkEventSource(fixture.db, 'evt_c1', 'src_c1')
    const open = openCommitments(fixture.db, personaId, NOW)
    await test('开放承诺被识别', () => {
      assert.equal(open.length, 1)
      assert.equal(open[0]?.id, 'evt_c1')
      assert.deepEqual(open[0]?.evidenceIds, ['src_c1'])
    })

    addEvent(fixture.db, 'evt_c2', 'refusal', iso(NOW_MS - 20 * HOUR), '这件事不做了', 'evt_c1')
    await test('取消/撤销把承诺归为 closed', () => {
      assert.equal(openCommitments(fixture.db, personaId, NOW).length, 0)
    })

    addEvent(fixture.db, 'evt_c3', 'action_result', iso(NOW_MS - 10 * HOUR), '执行失败', 'evt_c1')
    await test('失败结果归为 unknown，不生成', () => {
      assert.equal(openCommitments(fixture.db, personaId, NOW).length, 0)
    })
  } finally {
    fixture.close()
  }

  fixture = await setup()
  try {
    addSource(fixture.db, 'src_t1', iso(NOW_MS - 6 * HOUR))
    addSource(fixture.db, 'src_t2', iso(NOW_MS - 5 * HOUR))
    addSource(fixture.db, 'src_t3', iso(NOW_MS - 4 * HOUR))
    addTheme(fixture.db, 'art_t1', ['src_t1', 'src_t2', 'src_t3'])
    const themes = recurringThemes(fixture.db, personaId, NOW)
    await test('反复主题需要三个独立来源', () => {
      assert.equal(themes.length, 1)
      assert.equal(themes[0]?.count, 3)
    })

    addSource(fixture.db, 'src_s1', iso(NOW_MS - 3 * HOUR), 'ind:same', JSON.stringify({ disclosure: 'secret' }))
    addSource(fixture.db, 'src_s2', iso(NOW_MS - 2 * HOUR), 'ind:same', JSON.stringify({ disclosure: 'secret' }))
    addSource(fixture.db, 'src_s3', iso(NOW_MS - 1 * HOUR), 'ind:same', JSON.stringify({ disclosure: 'secret' }))
    addTheme(fixture.db, 'art_t2', ['src_s1', 'src_s2', 'src_s3'])
    await test('secret 主题被跳过', () => {
      const next = recurringThemes(fixture.db, personaId, NOW)
      assert.equal(next.some((item) => item.key === 'art_t2'), false)
    })
  } finally {
    fixture.close()
  }

  fixture = await setup()
  try {
    addSource(fixture.db, 'src_i1', iso(NOW_MS - 13 * HOUR))
    await test('13 小时无活动产生空闲关注', () => {
      const idle = idleWindow(fixture.db, personaId, NOW)
      assert.ok(idle)
      assert.deepEqual(idle?.evidenceIds, ['src_i1'])
    })

    addSource(fixture.db, 'src_i2', iso(NOW_MS - 1 * HOUR))
    await test('1 小时前的活动不产生空闲关注', () => {
      assert.equal(idleWindow(fixture.db, personaId, NOW), undefined)
    })
  } finally {
    fixture.close()
  }

  fixture = await setup()
  try {
    const base = iso(NOW_MS - 3 * HOUR)
    addMood(fixture.db, 'happy', 62, iso(NOW_MS - 3 * HOUR), `turn:qq-private-77:${1}`)
    addMood(fixture.db, 'happy', 64, iso(NOW_MS - 2 * HOUR), `turn:qq-private-77:${2}`)
    addMood(fixture.db, 'happy', 66, iso(NOW_MS - 1 * HOUR), `turn:qq-private-77:${3}`)
    const moods = moodEpisodes(fixture.db, personaId, NOW)
    await test('连续三轮同向偏离形成情绪 episode', () => {
      assert.equal(moods.length, 1)
      assert.equal(moods[0]?.sustainedTurns, 3)
      assert.match(moods[0]?.evidenceIds[0] ?? '', /^moodhist:\d+$/)
    })
    void base

    addMood(fixture.db, 'calm', 20, iso(NOW_MS - 3 * HOUR), 'turn:qq-private-77:1')
    addMood(fixture.db, 'calm', 30, iso(NOW_MS - 2 * HOUR), 'turn:qq-private-77:2')
    await test('不足三轮不形成 episode', () => {
      const next = moodEpisodes(fixture.db, personaId, NOW)
      assert.equal(next.some((item) => item.evidenceIds[0]?.startsWith('moodhist:') && next.length > 0 && item.sustainedTurns < 3), false)
    })

    addAffect(fixture.db, 'ct_test', 'tension', 50, iso(NOW_MS - 3 * HOUR))
    addAffect(fixture.db, 'ct_test', 'tension', 55, iso(NOW_MS - 2 * HOUR))
    addAffect(fixture.db, 'ct_test', 'tension', 60, iso(NOW_MS - 1 * HOUR))
    await test('同向高张力形成 Affect episode', () => {
      const affects = affectEpisodes(fixture.db, personaId, NOW)
      assert.equal(affects.length, 1)
      assert.equal(affects[0]?.contactId, 'ct_test')
      assert.equal(affects[0]?.dim, 'tension')
    })
  } finally {
    fixture.close()
  }

  fixture = await setup()
  try {
    addSource(fixture.db, 'src_d1', iso(NOW_MS - 30 * HOUR))
    addSource(fixture.db, 'src_d2', iso(NOW_MS - 1 * HOUR))
    addEvent(fixture.db, 'evt_d1', 'commitment', iso(NOW_MS - 30 * HOUR), '答应整理房间')
    linkEventSource(fixture.db, 'evt_d1', 'src_d1')
    const tick = runIntentionTick({ db: fixture.db, now: NOW, personaId })
    await test('tick 由承诺生成内部意愿', () => {
      assert.equal(tick.created, 1)
      const rows = listIntentions(fixture.db, { personaId })
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.status, 'internal')
    })

    const intentionId = listIntentions(fixture.db, { personaId })[0]?.intentionId ?? ''
    const revisitAt = iso(NOW_MS + 2 * HOUR)
    await test('defer 事务更新状态并追加事件', () => {
      assert.equal(
        deferIntention(fixture.db, {
          now: NOW,
          intentionId,
          reason: 'timing',
          revisitAt,
          condition: 'baseline-recovered',
        }),
        true,
      )
      const row = getIntention(fixture.db, intentionId)
      assert.equal(row?.status, 'deferred')
      assert.equal(row?.reevaluateAt, Date.parse(revisitAt))
      assert.equal(row?.reevaluateCondition, 'baseline-recovered')
      assert.equal(listIntentionEvents(fixture.db, intentionId).at(-1)?.action, 'deferred')
    })

    await test('重复 defer 不重复记账', () => {
      const before = listIntentionEvents(fixture.db, intentionId).length
      const row = getIntention(fixture.db, intentionId)
      deferIntention(fixture.db, {
        now: NOW,
        intentionId,
        reason: 'timing',
        revisitAt,
        condition: 'baseline-recovered',
      })
      assert.equal(getIntention(fixture.db, intentionId)?.revision, row?.revision)
      assert.equal(listIntentionEvents(fixture.db, intentionId).length, before)
    })

    await test('revisitAt 晚于 TTL 被拒绝', () => {
      const row = getIntention(fixture.db, intentionId)
      const ok = deferIntention(fixture.db, {
        now: NOW,
        intentionId,
        reason: 'late',
        revisitAt: iso((row?.expiresAt ?? NOW_MS) + HOUR),
        condition: 'new-evidence',
      })
      assert.equal(ok, false)
    })

    const line = readLatestIntentionLine(fixture.db, { now: NOW_MS, personaId })
    await test('deferred 不投影为「此刻的念头」', () => {
      assert.equal(line, null)
    })
  } finally {
    fixture.close()
  }

  console.log(`intention-providers: ${passed} 通过`)
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
