// G1-A：项目交接存储（schema v32）——迁移、绑定、保存、重放、CAS、归档。
//
// 只验证 core 模块契约，不证明 Host 已接线，也不证明 UI 已交付。
// 三条最关键的用例（评审要求，不能互相替代）：
//   ① J1→rev1、J2→rev2、重放 J1 仍回 rev1 且行数不变；
//   ② 两个连接各持 expectedRevision=1，恰好一个成功、另一个 revisionConflict 且新增行数为 0；
//   ③ 归档即解绑，归档项目不能再写。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { migrate, openDatabase } from '../packages/core/dist/adapter.js'
import { EXPECTED_TABLE_COUNT, SCHEMA_VERSION } from '../packages/core/dist/schema.js'
import { CODE } from '../packages/core/dist/errors.js'
import {
  GENERAL_BRANCH_KEY,
  archiveProject,
  bindSession,
  ensureProject,
  readCheckpoint,
  saveCheckpoint,
  unbindSession,
} from '../packages/core/dist/project-handoff-store.js'

let passed = 0
const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const NOW = '2026-02-01T09:00:00.000Z'
const logger = { debug() {}, info() {}, warn() {}, error() {} }

interface Fixture {
  dir: string
  file: string
  db: Awaited<ReturnType<typeof openDatabase>>['db']
  close: () => void
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-project-handoff-'))
  const file = join(dir, 'memory.sqlite3')
  const opened = await openDatabase({ file, driverPreference: 'auto', logger })
  migrate(opened.db, logger)
  return {
    dir,
    file,
    db: opened.db,
    close: () => {
      opened.db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function seedSource(db: Fixture['db'], id: string): void {
  db.run(
    'INSERT INTO sources (source_id, persona_id, platform, channel, origin, kind, text, captured_at, created_at) ' +
      "VALUES (?, 'main', 'desktop', 'desktop', 'user', 'message', ?, ?, ?)",
    [id, `正文 ${id}`, NOW, NOW],
  )
}

function countRows(db: Fixture['db'], table: string): number {
  const row = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
  return row ? Number(row.n) : 0
}

function revisionInput(goal: string) {
  return {
    repoRef: 'dsh-psyche@main@3e28d78',
    lastActiveAt: NOW,
    currentGoal: goal,
    completed: ['迁移 32'],
    blockers: [],
    nextSteps: ['store 读写', '并发屏障'],
    dependencies: ['better-sqlite3'],
    decisions: ['回退走整库备份 + 目录切换'],
    confidence: 'medium' as const,
    generator: 'rules:v1',
  }
}

await test('迁移到 v42，七张新表都在，表数 81', async () => {
  const f = await setup()
  try {
    const version = f.db.get<{ user_version: number }>('PRAGMA user_version')
    assert.equal(Number(version?.user_version), SCHEMA_VERSION)
    assert.equal(SCHEMA_VERSION, 42)
    const tables = f.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'project%' OR name IN ('digest_jobs','session_digests','checkpoint_revisions','checkpoint_references')",
    )
    const names = tables.map((row) => row.name)
    for (const expected of [
      'projects',
      'project_session_bindings',
      'project_checkpoints',
      'digest_jobs',
      'session_digests',
      'checkpoint_revisions',
      'checkpoint_references',
    ]) {
      assert.ok(names.includes(expected), `缺少 ${expected}`)
    }
    assert.equal(EXPECTED_TABLE_COUNT, 81)
  } finally {
    f.close()
  }
})

await test('建项目幂等：同 projectId 第二次返回同一行', async () => {
  const f = await setup()
  try {
    const first = ensureProject(f.db, { projectId: 'p1', canonicalName: '心灵', workspaceKey: 'ws-a', deps: { now: () => NOW } })
    const second = ensureProject(f.db, { projectId: 'p1', canonicalName: '心灵改名', workspaceKey: 'ws-a' })
    assert.equal(first.projectId, 'p1')
    assert.equal(second.canonicalName, '心灵')
    assert.equal(countRows(f.db, 'projects'), 1)
  } finally {
    f.close()
  }
})

await test('同一工作区身份不能绑到第二个项目', async () => {
  const f = await setup()
  try {
    ensureProject(f.db, { projectId: 'p1', canonicalName: 'A', workspaceKey: 'ws-a' })
    assert.throws(
      () => ensureProject(f.db, { projectId: 'p2', canonicalName: 'B', workspaceKey: 'ws-a' }),
      (error: { code?: string }) => error.code === CODE.idempotent,
    )
    assert.equal(countRows(f.db, 'projects'), 1)
  } finally {
    f.close()
  }
})

await test('绑定幂等：同会话同项目重复绑定返回原行，不同项目抛冲突', async () => {
  const f = await setup()
  try {
    ensureProject(f.db, { projectId: 'p1', canonicalName: 'A' })
    ensureProject(f.db, { projectId: 'p2', canonicalName: 'B' })
    const first = bindSession(f.db, {
      bindingId: 'b1',
      projectId: 'p1',
      platform: 'desktop',
      sessionRef: 's1',
      grantGeneration: 'g1',
      deps: { now: () => NOW },
    })
    const again = bindSession(f.db, {
      bindingId: 'b1-other',
      projectId: 'p1',
      platform: 'desktop',
      sessionRef: 's1',
      grantGeneration: 'g1',
    })
    assert.equal(again.bindingId, first.bindingId)
    assert.equal(countRows(f.db, 'project_session_bindings'), 1)
    assert.throws(
      () =>
        bindSession(f.db, {
          bindingId: 'b2',
          projectId: 'p2',
          platform: 'desktop',
          sessionRef: 's1',
          grantGeneration: 'g1',
        }),
      (error: { code?: string }) => error.code === CODE.idempotent,
    )
  } finally {
    f.close()
  }
})

await test('首次保存写 revision 1，第二次写 revision 2', async () => {
  const f = await setup()
  try {
    ensureProject(f.db, { projectId: 'p1', canonicalName: 'A' })
    bindSession(f.db, {
      bindingId: 'b1',
      projectId: 'p1',
      platform: 'desktop',
      sessionRef: 's1',
      grantGeneration: 'g1',
    })
    const first = saveCheckpoint(f.db, {
      projectId: 'p1',
      bindingId: 'b1',
      fromSeq: 1,
      toSeq: 8,
      algorithmVersion: 'v1',
      digest: { bodyJson: '{"goal":"迁移 32"}' },
      revision: revisionInput('迁移 32'),
    })
    assert.equal(first.saved, true)
    assert.equal(first.revision, 1)
    assert.equal(first.committedToSeq, 8)

    const second = saveCheckpoint(f.db, {
      projectId: 'p1',
      bindingId: 'b1',
      fromSeq: 9,
      toSeq: 16,
      algorithmVersion: 'v1',
      digest: { bodyJson: '{"goal":"store 读写"}' },
      revision: revisionInput('store 读写'),
    })
    assert.equal(second.revision, 2)
    assert.equal(second.committedToSeq, 16)
    assert.equal(countRows(f.db, 'checkpoint_revisions'), 2)
  } finally {
    f.close()
  }
})

await test('重放第一个任务返回 revision 1，且不新增任何行', async () => {
  const f = await setup()
  try {
    ensureProject(f.db, { projectId: 'p1', canonicalName: 'A' })
    bindSession(f.db, { bindingId: 'b1', projectId: 'p1', platform: 'desktop', sessionRef: 's1', grantGeneration: 'g1' })
    const input = {
      projectId: 'p1',
      bindingId: 'b1',
      fromSeq: 1,
      toSeq: 8,
      algorithmVersion: 'v1',
      digest: { bodyJson: '{"goal":"迁移 32"}' },
      revision: revisionInput('迁移 32'),
    }
    const first = saveCheckpoint(f.db, input)
    saveCheckpoint(f.db, { ...input, fromSeq: 9, toSeq: 16, revision: revisionInput('store 读写') })
    assert.equal(countRows(f.db, 'checkpoint_revisions'), 2)

    const before = {
      digests: countRows(f.db, 'session_digests'),
      revisions: countRows(f.db, 'checkpoint_revisions'),
      jobs: countRows(f.db, 'digest_jobs'),
    }
    const replay = saveCheckpoint(f.db, input)
    assert.equal(replay.saved, false)
    assert.equal(replay.replayed, true)
    assert.equal(replay.revision, first.revision)
    assert.equal(replay.digestId, first.digestId)
    assert.equal(countRows(f.db, 'session_digests'), before.digests)
    assert.equal(countRows(f.db, 'checkpoint_revisions'), before.revisions)
    assert.equal(countRows(f.db, 'digest_jobs'), before.jobs)
  } finally {
    f.close()
  }
})

await test('两个连接各持 expectedRevision=1，恰好一个成功，另一个零新增', async () => {
  const f = await setup()
  const other = await openDatabase({ file: f.file, driverPreference: 'auto', logger })
  try {
    ensureProject(f.db, { projectId: 'p1', canonicalName: 'A' })
    bindSession(f.db, { bindingId: 'b1', projectId: 'p1', platform: 'desktop', sessionRef: 's1', grantGeneration: 'g1' })
    saveCheckpoint(f.db, {
      projectId: 'p1',
      bindingId: 'b1',
      fromSeq: 1,
      toSeq: 8,
      algorithmVersion: 'v1',
      digest: { bodyJson: '{}' },
      revision: revisionInput('迁移 32'),
    })

    const win = saveCheckpoint(f.db, {
      projectId: 'p1',
      bindingId: 'b1',
      fromSeq: 9,
      toSeq: 16,
      algorithmVersion: 'v1',
      digest: { bodyJson: '{"who":"A"}' },
      revision: revisionInput('A 的推进'),
      expectedRevision: 1,
    })
    assert.equal(win.revision, 2)

    const digestsBefore = countRows(f.db, 'session_digests')
    const revisionsBefore = countRows(f.db, 'checkpoint_revisions')
    const refsBefore = countRows(f.db, 'checkpoint_references')

    assert.throws(
      () =>
        saveCheckpoint(other.db, {
          projectId: 'p1',
          bindingId: 'b1',
          fromSeq: 17,
          toSeq: 24,
          algorithmVersion: 'v1',
          digest: { bodyJson: '{"who":"B"}' },
          revision: revisionInput('B 的推进'),
          expectedRevision: 1,
        }),
      (error: { code?: string }) => error.code === CODE.revisionConflict,
    )
    // 失败方本次事务里的 Digest / 修订 / 引用必须一行都不留。
    assert.equal(countRows(f.db, 'session_digests'), digestsBefore)
    assert.equal(countRows(f.db, 'checkpoint_revisions'), revisionsBefore)
    assert.equal(countRows(f.db, 'checkpoint_references'), refsBefore)
  } finally {
    other.db.close()
    f.close()
  }
})

await test('同一逻辑任务重试复用 job_id 并递增 attempts', async () => {
  const f = await setup()
  try {
    ensureProject(f.db, { projectId: 'p1', canonicalName: 'A' })
    bindSession(f.db, { bindingId: 'b1', projectId: 'p1', platform: 'desktop', sessionRef: 's1', grantGeneration: 'g1' })
    // 直接造一个「上次失败」的任务：failed 且没有任何 Digest（失败本就不该有产物）。
    f.db.run(
      'INSERT INTO digest_jobs (job_id, binding_id, from_seq, to_seq, algorithm_version, status, attempts, created_at, updated_at) ' +
        "VALUES ('job-pre', 'b1', 1, 8, 'v1', 'failed', 1, ?, ?)",
      [NOW, NOW],
    )
    const retried = saveCheckpoint(f.db, {
      projectId: 'p1',
      bindingId: 'b1',
      fromSeq: 1,
      toSeq: 8,
      algorithmVersion: 'v1',
      digest: { bodyJson: '{}' },
      revision: revisionInput('迁移 32'),
    })
    assert.equal(retried.jobId, 'job-pre')
    assert.equal(retried.revision, 1)
    assert.equal(countRows(f.db, 'digest_jobs'), 1)
    const job = f.db.get<{ attempts: number; status: string }>(
      'SELECT attempts, status FROM digest_jobs WHERE job_id = ?',
      ['job-pre'],
    )
    assert.equal(Number(job?.attempts), 2)
    assert.equal(job?.status, 'succeeded')
  } finally {
    f.close()
  }
})

await test('证据引用：同一事项重复登记同一来源被拒，不同事项允许', async () => {
  const f = await setup()
  try {
    ensureProject(f.db, { projectId: 'p1', canonicalName: 'A' })
    bindSession(f.db, { bindingId: 'b1', projectId: 'p1', platform: 'desktop', sessionRef: 's1', grantGeneration: 'g1' })
    seedSource(f.db, 'src-1')
    const saved = saveCheckpoint(f.db, {
      projectId: 'p1',
      bindingId: 'b1',
      fromSeq: 1,
      toSeq: 8,
      algorithmVersion: 'v1',
      digest: { bodyJson: '{}', sourceIds: ['src-1'] },
      revision: revisionInput('迁移 32'),
      references: [{ itemKey: 'U-017', sourceId: 'src-1' }],
    })
    // 同一事项 + 同一来源：部分唯一索引拒绝。
    assert.throws(
      () =>
        f.db.run(
          'INSERT INTO checkpoint_references (checkpoint_id, revision, item_key, source_id, digest_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
          [saved.checkpointId, saved.revision, 'U-017', 'src-1', NOW],
        ),
    )
    // 换一个事项引用同一来源：合法。
    f.db.run(
      'INSERT INTO checkpoint_references (checkpoint_id, revision, item_key, source_id, digest_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
      [saved.checkpointId, saved.revision, 'U-018', 'src-1', NOW],
    )
    assert.equal(countRows(f.db, 'checkpoint_references'), 2)
  } finally {
    f.close()
  }
})

await test('证据引用指向不存在的 Source 被外键拒绝', async () => {
  const f = await setup()
  try {
    assert.throws(
      () =>
        f.db.run(
          'INSERT INTO checkpoint_references (checkpoint_id, revision, item_key, source_id, digest_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
          ['ckp-x', 1, 'U-017', 'no-such-source', NOW],
        ),
    )
  } finally {
    f.close()
  }
})

await test('committed_to_seq 只按连续覆盖推进，跳区间不推高', async () => {
  const f = await setup()
  try {
    ensureProject(f.db, { projectId: 'p1', canonicalName: 'A' })
    bindSession(f.db, { bindingId: 'b1', projectId: 'p1', platform: 'desktop', sessionRef: 's1', grantGeneration: 'g1' })
    saveCheckpoint(f.db, {
      projectId: 'p1',
      bindingId: 'b1',
      fromSeq: 1,
      toSeq: 8,
      algorithmVersion: 'v1',
      digest: { bodyJson: '{}' },
      revision: revisionInput('第一段'),
    })
    // 跳过 9..16，直接保存 17..24：这不是连续覆盖，水位必须停在 8。
    const hole = saveCheckpoint(f.db, {
      projectId: 'p1',
      bindingId: 'b1',
      fromSeq: 17,
      toSeq: 24,
      algorithmVersion: 'v1',
      digest: { bodyJson: '{}' },
      revision: revisionInput('带空洞的一段'),
    })
    assert.equal(hole.committedToSeq, 8)
  } finally {
    f.close()
  }
})

await test('归档即解绑：归档后不能再写新记录', async () => {
  const f = await setup()
  try {
    ensureProject(f.db, { projectId: 'p1', canonicalName: 'A' })
    bindSession(f.db, { bindingId: 'b1', projectId: 'p1', platform: 'desktop', sessionRef: 's1', grantGeneration: 'g1' })
    saveCheckpoint(f.db, {
      projectId: 'p1',
      bindingId: 'b1',
      fromSeq: 1,
      toSeq: 8,
      algorithmVersion: 'v1',
      digest: { bodyJson: '{}' },
      revision: revisionInput('迁移 32'),
    })
    const archived = archiveProject(f.db, { projectId: 'p1' })
    assert.equal(archived.archived, true)
    assert.equal(archived.unbound, 1)
    const binding = f.db.get<{ unboundAt: string | null }>(
      'SELECT unbound_at AS unboundAt FROM project_session_bindings WHERE binding_id = ?',
      ['b1'],
    )
    assert.ok(binding?.unboundAt, '归档必须同时写 unbound_at')
    // 历史仍在：归档不删任何行。
    assert.equal(countRows(f.db, 'checkpoint_revisions'), 1)
    assert.throws(
      () =>
        saveCheckpoint(f.db, {
          projectId: 'p1',
          bindingId: 'b1',
          fromSeq: 9,
          toSeq: 16,
          algorithmVersion: 'v1',
          digest: { bodyJson: '{}' },
          revision: revisionInput('归档之后'),
        }),
    )
  } finally {
    f.close()
  }
})

await test('绑定与项目 persona 不一致被复合外键拒绝', async () => {
  const f = await setup()
  try {
    ensureProject(f.db, { projectId: 'p1', canonicalName: 'A' })
    assert.throws(() =>
      f.db.run(
        'INSERT INTO project_session_bindings (binding_id, project_id, persona_id, platform, session_ref, ' +
          'grant_generation, committed_to_seq, bound_at, unbound_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL)',
        ['b-bad', 'p1', 'ghost-persona', 'desktop', 's9', 'g1', NOW],
      ),
    )
  } finally {
    f.close()
  }
})

await test('readCheckpoint 读回最新修订与引用', async () => {
  const f = await setup()
  try {
    ensureProject(f.db, { projectId: 'p1', canonicalName: 'A' })
    bindSession(f.db, { bindingId: 'b1', projectId: 'p1', platform: 'desktop', sessionRef: 's1', grantGeneration: 'g1' })
    seedSource(f.db, 'src-1')
    saveCheckpoint(f.db, {
      projectId: 'p1',
      bindingId: 'b1',
      fromSeq: 1,
      toSeq: 8,
      algorithmVersion: 'v1',
      digest: { bodyJson: '{}', sourceIds: ['src-1'] },
      revision: revisionInput('迁移 32'),
      references: [{ itemKey: 'U-017', sourceId: 'src-1' }],
    })
    const view = readCheckpoint(f.db, { projectId: 'p1' })
    assert.ok(view)
    assert.equal(view?.branchKey, GENERAL_BRANCH_KEY)
    assert.equal(view?.headRevision, 1)
    assert.equal(view?.revision?.currentGoal, '迁移 32')
    assert.deepEqual(view?.revision?.nextSteps, ['store 读写', '并发屏障'])
    assert.equal(view?.references.length, 1)
    assert.equal(view?.references[0]?.itemKey, 'U-017')
    assert.equal(view?.references[0]?.sourceId, 'src-1')
  } finally {
    f.close()
  }
})

await test('解绑后不能再用该绑定写入', async () => {
  const f = await setup()
  try {
    ensureProject(f.db, { projectId: 'p1', canonicalName: 'A' })
    bindSession(f.db, { bindingId: 'b1', projectId: 'p1', platform: 'desktop', sessionRef: 's1', grantGeneration: 'g1' })
    assert.equal(unbindSession(f.db, { bindingId: 'b1' }), true)
    assert.equal(unbindSession(f.db, { bindingId: 'b1' }), false)
    assert.throws(
      () =>
        saveCheckpoint(f.db, {
          projectId: 'p1',
          bindingId: 'b1',
          fromSeq: 1,
          toSeq: 8,
          algorithmVersion: 'v1',
          digest: { bodyJson: '{}' },
          revision: revisionInput('解绑之后'),
        }),
      (error: { code?: string }) => error.code === CODE.state,
    )
  } finally {
    f.close()
  }
})

await test('迁移中途被强杀：整笔回滚，库仍是 v31，重跑才到 v32', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-v32-crash-'))
  const file = join(dir, 'memory.sqlite3')
  try {
    // 造一个等效 v31 库：正常迁到 32，再把 v32 的七张表与登记行撤掉、版本退回 31。
    // 之后所有检查都用 better-sqlite3 直读，避免 openDatabase 的自动迁移掩盖问题。
    const seed = await openDatabase({ file, driverPreference: 'auto', logger })
    migrate(seed.db, logger)
    seed.db.exec(`
DROP TRIGGER IF EXISTS trg_checkpoint_references_no_update;
DROP TRIGGER IF EXISTS trg_checkpoint_references_no_delete;
DROP TRIGGER IF EXISTS trg_checkpoint_revisions_no_update;
DROP TRIGGER IF EXISTS trg_checkpoint_revisions_no_delete;
DROP TABLE IF EXISTS checkpoint_references;
DROP TABLE IF EXISTS checkpoint_revisions;
DROP TABLE IF EXISTS project_checkpoints;
DROP TABLE IF EXISTS session_digests;
DROP TABLE IF EXISTS digest_jobs;
DROP TABLE IF EXISTS project_session_bindings;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS reminders;
DROP TABLE IF EXISTS access_epochs;
DROP TABLE IF EXISTS access_epoch_pending;
`)
    // 迁移 35 给 qq_reply_outbox 加了一列；这个夹具要把它也退回去，
    // 否则重跑迁移会撞 duplicate column name: access_epoch。
    if (seed.db.all("PRAGMA table_info('qq_reply_outbox')").some((c) => (c as { name?: string }).name === 'access_epoch')) {
      seed.db.exec('ALTER TABLE qq_reply_outbox DROP COLUMN access_epoch')
    }
    // 迁移 38 又给 sources 加了 turn_id；同理要退回去。
    // SQLite 不允许「索引还引用着某列时删列」，所以先把迁移建的索引也撤掉。
    if (seed.db.all("PRAGMA table_info('sources')").some((c) => (c as { name?: string }).name === 'turn_id')) {
      seed.db.exec('DROP INDEX IF EXISTS idx_sources_turn')
      seed.db.exec('ALTER TABLE sources DROP COLUMN turn_id')
    }
    // 迁移 40 给 qq_reply_outbox 加了 reminder_id（带部分唯一索引），也要退回去。
    if (seed.db.all("PRAGMA table_info('qq_reply_outbox')").some((c) => (c as { name?: string }).name === 'reminder_id')) {
      seed.db.exec('DROP INDEX IF EXISTS idx_qq_reply_outbox_reminder')
      seed.db.exec('ALTER TABLE qq_reply_outbox DROP COLUMN reminder_id')
    }
    // 迁移 40/41 给 reminders 加了 delivery_result 与 next_attempt_at，同样退回。
    const reminderColumns = seed.db.all("PRAGMA table_info('reminders')") as { name?: string }[]
    if (reminderColumns.some((c) => c.name === 'delivery_result')) {
      seed.db.exec('ALTER TABLE reminders DROP COLUMN delivery_result')
    }
    if (reminderColumns.some((c) => c.name === 'next_attempt_at')) {
      seed.db.exec('ALTER TABLE reminders DROP COLUMN next_attempt_at')
    }
    // 迁移 42 新建了裁决证据表；不删掉的话重跑迁移会撞「table already exists」。
    seed.db.exec('DROP TABLE IF EXISTS qq_reply_verdicts')
    seed.db.run('DELETE FROM schema_migrations WHERE version IN (32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42)')
    seed.db.exec('PRAGMA user_version = 31')
    seed.db.close()

    const peek = (): { version: number; integrity: string; tables: string[]; recorded: number } => {
      const probe = new Database(file, { readonly: true })
      try {
        const version = Number(probe.pragma('user_version', { simple: true }))
        const integrity = String(probe.pragma('integrity_check', { simple: true }))
        const tables = probe
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('projects','project_session_bindings')")
          .all()
          .map((row) => String((row as { name: string }).name))
        const recorded = Number(
          probe.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 32').get()?.n ?? 0,
        )
        return { version, integrity, tables, recorded }
      } finally {
        probe.close()
      }
    }

    const before = peek()
    assert.equal(before.version, 31)

    // 子进程：开事务、建两张新表、提交前 SIGKILL。
    const fixture = fileURLToPath(new URL('./fixtures/v32-crash.mjs', import.meta.url))
    const child = spawnSync(process.execPath, [fixture, file], { encoding: 'utf8' })
    assert.notEqual(child.status, 0, '夹具应当被强杀而不是正常退出')

    const after = peek()
    assert.equal(after.version, 31, '未提交的迁移不能把版本推上去')
    assert.equal(after.integrity, 'ok')
    assert.equal(after.tables.length, 0, '未提交的半成品表必须整笔回滚')
    assert.equal(after.recorded, 0)

    // 故障点移除后重跑迁移：一次到最新版本，32 与 33 各登记恰好一行。
    const reopened = await openDatabase({ file, driverPreference: 'auto', logger })
    try {
      const version = reopened.db.get<{ user_version: number }>('PRAGMA user_version')
      assert.equal(Number(version?.user_version), SCHEMA_VERSION)
      for (const target of [32, 33]) {
        const recorded = reopened.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?', [target])
        assert.equal(Number(recorded?.n), 1, `迁移 ${target} 应登记恰好一行`)
      }
    } finally {
      reopened.db.close()
    }
  } finally {
    // Windows 上被强杀的子进程可能还握着 -wal/-shm 句柄；清理失败不影响结论，交给系统临时目录回收。
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      /* 临时目录，清理失败不判失败 */
    }
  }
})

console.log(`\nG1-A 项目交接存储自检：${passed} 通过 0 失败`)
