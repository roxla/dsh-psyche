// P6-2：Intention Store——状态机、终态去重、TTL、observed 与跨重启持久化。
//
// 只验证模块契约，不证明 Host 已接线；Host 集成见 P6-2 的 turn-stopping 验收。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '../packages/core/dist/adapter.js'
import { EXPECTED_TABLE_COUNT, SCHEMA_VERSION } from '../packages/core/dist/schema.js'
import {
  INTENTION_REVIVAL_WINDOW_MS,
  INTENTION_TTL_MS,
  abandonIntention,
  getIntention,
  listIntentionEvents,
  listIntentions,
  markIntentionsObserved,
  reconcileIntentions,
} from '../packages/core/dist/intention-store.js'
import type { IntentionCandidate } from '../packages/core/dist/intention-candidate.js'
import type { ChoiceDecision } from '../packages/core/dist/intention-choice.js'

let passed = 0
const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const NOW = '2026-01-10T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const logger = { debug() {}, info() {}, warn() {}, error() {} }

interface Fixture {
  dir: string
  db: Awaited<ReturnType<typeof openDatabase>>['db']
  close: () => void
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-intention-store-'))
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger })
  migrate(opened.db, logger)
  return {
    dir,
    db: opened.db,
    close: () => {
      opened.db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function candidate(index: number, overrides: Partial<IntentionCandidate> = {}): IntentionCandidate {
  return {
    intentionId: `int:candidate-${index}`,
    attentionId: `att:open-plan:${index}`,
    kind: 'open-plan',
    scope: { kind: 'personal' },
    title: `想补完计划 ${index}`,
    score: 0.7,
    evidenceIds: [`src_${index}`],
    createdAt: NOW,
    expiresAt: new Date(NOW_MS + INTENTION_TTL_MS).toISOString(),
    ...overrides,
  }
}

function choose(intentionId: string, choice: ChoiceDecision['choice'] = 'internal'): ChoiceDecision {
  return { intentionId, choice, reason: choice === 'abandon' ? 'missing-evidence' : choice === 'defer' ? 'lower-priority' : 'selected' }
}

await test('Schema v36 建出两张意愿表', async () => {
  const f = await setup()
  try {
    assert.equal(SCHEMA_VERSION, 42)
    assert.equal(EXPECTED_TABLE_COUNT, 81)
    const names = f.db
      .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('intentions','intention_events')`)
      .map((row) => row.name)
      .sort()
    assert.deepEqual(names, ['intention_events', 'intentions'])
  } finally {
    f.close()
  }
})

await test('internal 意愿落库并追加 created/chosen 事件', async () => {
  const f = await setup()
  try {
    const c = candidate(1)
    const result = reconcileIntentions(f.db, { now: NOW, personaId: 'main', candidates: [c], decisions: [choose(c.intentionId)] })
    assert.equal(result.created, 1)
    const row = getIntention(f.db, c.intentionId)
    assert.equal(row?.status, 'internal')
    assert.deepEqual(row?.evidenceIds, ['src_1'])
    assert.deepEqual(
      listIntentionEvents(f.db, c.intentionId).map((event) => event.action),
      ['created', 'chosen'],
    )
  } finally {
    f.close()
  }
})

await test('同一意愿同一轮重复收敛不新增行', async () => {
  const f = await setup()
  try {
    const c = candidate(1)
    const input = { now: NOW, personaId: 'main', candidates: [c], decisions: [choose(c.intentionId)] }
    reconcileIntentions(f.db, input)
    const second = reconcileIntentions(f.db, input)
    assert.equal(second.created, 0)
    assert.equal(second.updated, 0)
    assert.equal(listIntentions(f.db, { personaId: 'main' }).length, 1)
  } finally {
    f.close()
  }
})

await test('证据变化只升 revision 并重算摘要', async () => {
  const f = await setup()
  try {
    const c = candidate(1)
    reconcileIntentions(f.db, { now: NOW, personaId: 'main', candidates: [c], decisions: [choose(c.intentionId)] })
    const before = getIntention(f.db, c.intentionId)
    const changed = { ...c, evidenceIds: ['src_1', 'src_extra'] }
    reconcileIntentions(f.db, { now: NOW, personaId: 'main', candidates: [changed], decisions: [choose(c.intentionId)] })
    const after = getIntention(f.db, c.intentionId)
    assert.equal(after?.revision, (before?.revision ?? 0) + 1)
    assert.notEqual(after?.evidenceDigest, before?.evidenceDigest)
    assert.equal(after?.status, 'internal')
  } finally {
    f.close()
  }
})

await test('每 Persona 最多 3 条非终态', async () => {
  const f = await setup()
  try {
    const candidates = [1, 2, 3, 4].map((index) => candidate(index))
    const result = reconcileIntentions(f.db, {
      now: NOW,
      personaId: 'main',
      candidates,
      decisions: candidates.map((c) => choose(c.intentionId)),
    })
    assert.equal(result.created, 3)
    assert.equal(listIntentions(f.db, { personaId: 'main' }).length, 3)
    assert.equal(result.skipped, 1)
  } finally {
    f.close()
  }
})

await test('abandon 进入终态且不删除历史', async () => {
  const f = await setup()
  try {
    const c = candidate(1)
    reconcileIntentions(f.db, { now: NOW, personaId: 'main', candidates: [c], decisions: [choose(c.intentionId)] })
    assert.equal(abandonIntention(f.db, { now: NOW, intentionId: c.intentionId, reason: 'owner-declined' }), true)
    const row = getIntention(f.db, c.intentionId)
    assert.equal(row?.status, 'abandoned')
    assert.equal(row?.terminalAt, NOW_MS)
    assert.deepEqual(
      listIntentionEvents(f.db, c.intentionId).map((event) => event.action),
      ['created', 'chosen', 'abandoned'],
    )
  } finally {
    f.close()
  }
})

await test('终态同语义同证据在窗口内不复活', async () => {
  const f = await setup()
  try {
    const c = candidate(1)
    reconcileIntentions(f.db, { now: NOW, personaId: 'main', candidates: [c], decisions: [choose(c.intentionId)] })
    abandonIntention(f.db, { now: NOW, intentionId: c.intentionId, reason: 'owner-declined' })
    const again = reconcileIntentions(f.db, {
      now: new Date(NOW_MS + 60_000).toISOString(),
      personaId: 'main',
      candidates: [c],
      decisions: [choose(c.intentionId)],
    })
    assert.equal(again.created, 0)
    assert.equal(listIntentions(f.db, { personaId: 'main' }).length, 0)
    assert.ok(NOW_MS + 60_000 < NOW_MS + INTENTION_REVIVAL_WINDOW_MS)
  } finally {
    f.close()
  }
})

await test('终态后出现新证据可以创建新意愿', async () => {
  const f = await setup()
  try {
    const first = candidate(1)
    reconcileIntentions(f.db, { now: NOW, personaId: 'main', candidates: [first], decisions: [choose(first.intentionId)] })
    abandonIntention(f.db, { now: NOW, intentionId: first.intentionId, reason: 'owner-declined' })
    const second = candidate(2, { evidenceIds: ['src_2'], title: '想补完计划 1' })
    const result = reconcileIntentions(f.db, {
      now: new Date(NOW_MS + 60_000).toISOString(),
      personaId: 'main',
      candidates: [second],
      decisions: [choose(second.intentionId)],
    })
    assert.equal(result.created, 1)
    assert.equal(getIntention(f.db, second.intentionId)?.status, 'internal')
  } finally {
    f.close()
  }
})

await test('TTL 到期只改状态，不物理删除', async () => {
  const f = await setup()
  try {
    const c = candidate(1)
    reconcileIntentions(f.db, { now: NOW, personaId: 'main', candidates: [c], decisions: [choose(c.intentionId)] })
    const later = new Date(NOW_MS + INTENTION_TTL_MS + 60_000).toISOString()
    const result = reconcileIntentions(f.db, { now: later, personaId: 'main', candidates: [], decisions: [] })
    assert.equal(result.expired, 1)
    const row = getIntention(f.db, c.intentionId)
    assert.equal(row?.status, 'expired')
    assert.equal(listIntentionEvents(f.db, c.intentionId).at(-1)?.action, 'expired')
  } finally {
    f.close()
  }
})

await test('observed 只追加事件，不改变状态', async () => {
  const f = await setup()
  try {
    const c = candidate(1)
    reconcileIntentions(f.db, { now: NOW, personaId: 'main', candidates: [c], decisions: [choose(c.intentionId)] })
    const appended = markIntentionsObserved(f.db, { now: NOW, personaId: 'main', intentionIds: [c.intentionId] })
    assert.equal(appended, 1)
    assert.equal(getIntention(f.db, c.intentionId)?.status, 'internal')
    assert.deepEqual(
      listIntentionEvents(f.db, c.intentionId).map((event) => event.action),
      ['created', 'chosen', 'observed'],
    )
  } finally {
    f.close()
  }
})

await test('关闭并重开数据库后意愿与事件仍在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-intention-store-'))
  try {
    const first = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger })
    migrate(first.db, logger)
    const c = candidate(1)
    reconcileIntentions(first.db, { now: NOW, personaId: 'main', candidates: [c], decisions: [choose(c.intentionId)] })
    first.db.close()

    const reopened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger })
    migrate(reopened.db, logger)
    assert.equal(getIntention(reopened.db, c.intentionId)?.status, 'internal')
    assert.equal(listIntentionEvents(reopened.db, c.intentionId).length, 2)
    reopened.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await test('非法 now/persona 不抛错且不写库', async () => {
  const f = await setup()
  try {
    const c = candidate(1)
    const result = reconcileIntentions(f.db, { now: 'not-a-time', personaId: 'main', candidates: [c], decisions: [choose(c.intentionId)] })
    assert.equal(result.created, 0)
    assert.equal(listIntentions(f.db, { personaId: 'main' }).length, 0)
    assert.equal(reconcileIntentions(f.db, { now: NOW, personaId: '   ', candidates: [c], decisions: [choose(c.intentionId)] }).created, 0)
  } finally {
    f.close()
  }
})

console.log(`\nintention-store: ${passed} 通过 / 0 失败`)
