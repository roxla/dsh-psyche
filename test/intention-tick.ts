// P6-2：意愿 tick——从已有承诺派生意愿、跳过无证据项、幂等、TTL 与失败关闭。
//
// 只验证模块契约，不证明 Host 已接线；Host 集成见 P6-2 的 turn-stopping 验收。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '../packages/core/dist/adapter.js'
import { listIntentionEvents, listIntentions } from '../packages/core/dist/intention-store.js'
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
const logger = { debug() {}, info() {}, warn() {}, error() {} }

interface Fixture {
  dir: string
  db: Awaited<ReturnType<typeof openDatabase>>['db']
  close: () => void
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-intention-tick-'))
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger })
  migrate(opened.db, logger)
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

function addSource(db: Fixture['db'], id: string, text: string): void {
  db.run(
    `INSERT INTO sources
       (source_id, persona_id, platform, channel, origin, kind, text, captured_at, created_at)
     VALUES (?, ?, 'qq', 'private', 'user', 'message', ?, ?, ?)`,
    [id, personaId, text, NOW, NOW],
  )
}

function addCommitment(
  db: Fixture['db'],
  id: string,
  atMs: number,
  text: string,
  sourceIds: readonly string[],
): void {
  const at = new Date(atMs).toISOString()
  db.run(
    `INSERT INTO events
       (event_id, persona_id, kind, type, at, text, created_at)
     VALUES (?, ?, 'interaction', 'commitment', ?, ?, ?)`,
    [id, personaId, at, text, at],
  )
  for (const sourceId of sourceIds) {
    db.run('INSERT INTO event_sources (event_id, source_id) VALUES (?, ?)', [id, sourceId])
  }
}

async function main(): Promise<void> {
  await test('没有承诺时不产生候选', async () => {
    const fixture = await setup()
    try {
      const result = runIntentionTick({ db: fixture.db, now: NOW, personaId })
      assert.equal(result.created, 0)
      assert.equal(result.attention, 0)
      assert.equal(result.error, undefined)
    } finally {
      fixture.close()
    }
  })

  await test('超过 24h 且有来源的承诺生成 internal 意愿', async () => {
    const fixture = await setup()
    try {
      addSource(fixture.db, 'src-1', '我周四前把报告发你')
      addCommitment(fixture.db, 'evt-1', NOW_MS - 48 * HOUR, '周四前把报告发你', ['src-1'])
      const result = runIntentionTick({ db: fixture.db, now: NOW, personaId })
      assert.equal(result.error, undefined)
      assert.equal(result.attention, 1)
      assert.equal(result.created, 1)
      const rows = listIntentions(fixture.db, { personaId })
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.status, 'internal')
      const actions = listIntentionEvents(fixture.db, rows[0]!.intentionId).map((item) => item.action)
      assert.ok(actions.includes('created'))
      assert.ok(actions.includes('chosen'))
    } finally {
      fixture.close()
    }
  })

  await test('不足 24h 的承诺不进入关注', async () => {
    const fixture = await setup()
    try {
      addSource(fixture.db, 'src-2', '明天给你')
      addCommitment(fixture.db, 'evt-2', NOW_MS - 2 * HOUR, '明天给你', ['src-2'])
      const result = runIntentionTick({ db: fixture.db, now: NOW, personaId })
      assert.equal(result.attention, 0)
      assert.equal(result.created, 0)
    } finally {
      fixture.close()
    }
  })

  await test('无来源证据的承诺被跳过，不伪造证据链', async () => {
    const fixture = await setup()
    try {
      addCommitment(fixture.db, 'evt-3', NOW_MS - 48 * HOUR, '改天一起吃饭', [])
      const result = runIntentionTick({ db: fixture.db, now: NOW, personaId })
      assert.equal(result.created, 0)
      assert.ok(result.skipped >= 1)
      assert.equal(listIntentions(fixture.db, { personaId }).length, 0)
    } finally {
      fixture.close()
    }
  })

  await test('重复 tick 不重复建行', async () => {
    const fixture = await setup()
    try {
      addSource(fixture.db, 'src-4', '周五前交稿')
      addCommitment(fixture.db, 'evt-4', NOW_MS - 48 * HOUR, '周五前交稿', ['src-4'])
      assert.equal(runIntentionTick({ db: fixture.db, now: NOW, personaId }).created, 1)
      const second = runIntentionTick({ db: fixture.db, now: NOW, personaId })
      assert.equal(second.created, 0)
      assert.equal(listIntentions(fixture.db, { personaId }).length, 1)
    } finally {
      fixture.close()
    }
  })

  await test('关闭时只做过期，不生成新候选', async () => {
    const fixture = await setup()
    try {
      addSource(fixture.db, 'src-5', '下周整理旧项目')
      addCommitment(fixture.db, 'evt-5', NOW_MS - 48 * HOUR, '整理旧项目', ['src-5'])
      assert.equal(runIntentionTick({ db: fixture.db, now: NOW, personaId }).created, 1)
      const later = new Date(NOW_MS + 25 * HOUR).toISOString()
      const result = runIntentionTick({ db: fixture.db, now: later, personaId, enabled: false })
      assert.equal(result.created, 0)
      assert.equal(result.expired, 1)
      const expired = listIntentions(fixture.db, { personaId, statuses: ['expired'] })
      assert.equal(expired[0]?.status, 'expired')
    } finally {
      fixture.close()
    }
  })

  await test('数据库不可用时不抛异常，返回 error', async () => {
    const fixture = await setup()
    try {
      fixture.db.close()
      const result = runIntentionTick({ db: fixture.db, now: NOW, personaId })
      assert.equal(result.created, 0)
      assert.ok(result.error !== undefined)
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  console.log(`intention-tick: ${passed} 通过 / 0 失败`)
}

main().catch((error) => {
  console.error('intention-tick: 失败')
  console.error(error)
  process.exitCode = 1
})
