// G1-B：同一项目的只读 Brief。
//
// 外部评审要求的三个会话（Q6）在这里用三个 session_ref 表达：
//   A：项目 P 保存 u-017 与一条具体下一步；
//   B：同项目同分支的新会话，Brief 必须含 u-017 与那条下一步，并能给出 ID/revision；
//   C：另一个项目（故意用同名目录项目），Brief 不得含 u-017，也不得指向 P。
// 只做 C 的反例会让「永远返回空 Brief」的实现也蒙混过关，所以 A、B 必须真的读到内容。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '../dist/lib/adapter.js'
import {
  bindSession,
  ensureProject,
  saveCheckpoint,
} from '../dist/lib/project-handoff-store.js'
import { buildProjectBrief } from '../dist/lib/project-brief.js'

let passed = 0
const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const NOW = '2026-02-01T09:00:00.000Z'
const logger = { debug() {}, info() {}, warn() {}, error() {} }

type Db = Awaited<ReturnType<typeof openDatabase>>['db']

interface Fixture {
  dir: string
  db: Db
  close: () => void
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-brief-'))
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

function seedSource(db: Db, id: string, sessionRef: string): void {
  db.run(
    'INSERT INTO sources (source_id, persona_id, platform, channel, origin, kind, text, session_ref, captured_at, created_at) ' +
      "VALUES (?, 'main', 'desktop', 'desktop', 'user', 'message', ?, ?, ?, ?)",
    [id, `正文 ${id}`, sessionRef, NOW, NOW],
  )
}

/** 建项目 → 绑会话 → 存一次手动 Checkpoint。 */
function seedProject(
  db: Db,
  options: {
    projectId: string
    canonicalName: string
    workspaceKey: string | null
    sessionRef: string
    bindingId: string
    currentGoal: string | null
    completed?: string[]
    blockers?: string[]
    nextSteps?: string[]
    decisions?: string[]
    sourceIds?: string[]
  },
): { checkpointId: string; revision: number } {
  ensureProject(db, {
    projectId: options.projectId,
    canonicalName: options.canonicalName,
    workspaceKey: options.workspaceKey,
    deps: { now: () => NOW },
  })
  bindSession(db, {
    bindingId: options.bindingId,
    projectId: options.projectId,
    platform: 'desktop',
    sessionRef: options.sessionRef,
    grantGeneration: 'manual',
    deps: { now: () => NOW },
  })
  const saved = saveCheckpoint(db, {
    projectId: options.projectId,
    bindingId: options.bindingId,
    mode: 'manual',
    requestId: `req-${options.bindingId}`,
    payloadHash: `h-${options.bindingId}`,
    fromSeq: 1,
    toSeq: 1,
    algorithmVersion: 'manual-v1',
    digest: { bodyJson: JSON.stringify({ goal: options.currentGoal }) },
    revision: {
      currentGoal: options.currentGoal,
      completed: options.completed ?? [],
      blockers: options.blockers ?? [],
      nextSteps: options.nextSteps ?? [],
      decisions: options.decisions ?? [],
      generator: 'manual',
    },
    references: (options.sourceIds ?? []).map((sourceId) => ({ itemKey: 'u-017', sourceId })),
  })
  return { checkpointId: saved.checkpointId, revision: saved.revision }
}

const fixture = await setup()
const { db } = fixture

try {
  // A：项目 P，保存 u-017 与一条具体下一步。
  seedSource(db, 'src_p_1', 'sess-A')
  const savedA = seedProject(db, {
    projectId: 'proj-p',
    canonicalName: '心灵',
    workspaceKey: 'ws-p',
    sessionRef: 'sess-A',
    bindingId: 'bind-A',
    currentGoal: '把项目交接 UI 做完',
    completed: ['手动保存入口已上线'],
    blockers: ['真实 QQ 账号还没提供'],
    nextSteps: ['补 G1-B 的 Brief 注入', '再补 G2 的持久队列'],
    decisions: ['手动保存不推进水位'],
    sourceIds: ['src_p_1'],
  })

  await test('A 会话能读到自己的 Brief，含目标、阻塞、下一步与 Checkpoint 标识', () => {
    const brief = buildProjectBrief({ db, sessionId: 'sess-A' })
    assert.equal(brief.skipped, null, JSON.stringify(brief))
    assert.equal(brief.projectId, 'proj-p')
    assert.equal(brief.checkpointId, savedA.checkpointId)
    assert.equal(brief.revision, savedA.revision)
    assert.ok(brief.text !== null)
    assert.match(brief.text!, /把项目交接 UI 做完/)
    assert.match(brief.text!, /真实 QQ 账号还没提供/)
    assert.match(brief.text!, /补 G1-B 的 Brief 注入/)
    assert.match(brief.text!, /手动保存不推进水位/)
    assert.match(brief.text!, /Checkpoint .* r1/)
  })

  // B：同项目同分支的另一个会话，只绑了项目、没存过东西。
  bindSession(db, {
    bindingId: 'bind-B',
    projectId: 'proj-p',
    platform: 'desktop',
    sessionRef: 'sess-B',
    grantGeneration: 'manual',
    deps: { now: () => NOW },
  })

  await test('B 会话（同项目另一会话）读到的就是 A 存的那一份，不跨项目混用', () => {
    const brief = buildProjectBrief({ db, sessionId: 'sess-B' })
    assert.equal(brief.skipped, null, JSON.stringify(brief))
    assert.equal(brief.projectId, 'proj-p')
    assert.equal(brief.checkpointId, savedA.checkpointId, 'B 没有自己的修订，读的是分支 head')
    assert.match(brief.text!, /补 G1-B 的 Brief 注入/)
  })

  // C：另一个项目，目录同名（canonicalName 一样），但 workspace_key 不同。
  seedSource(db, 'src_q_1', 'sess-C')
  const savedC = seedProject(db, {
    projectId: 'proj-q',
    canonicalName: '心灵',
    workspaceKey: 'ws-q',
    sessionRef: 'sess-C',
    bindingId: 'bind-C',
    currentGoal: '另一个项目自己的目标',
    nextSteps: ['另一条完全不同的下一步'],
    sourceIds: ['src_q_1'],
  })

  await test('C 会话（同名目录的另一项目）看不到 A 的目标与下一步', () => {
    const brief = buildProjectBrief({ db, sessionId: 'sess-C' })
    assert.equal(brief.skipped, null, JSON.stringify(brief))
    assert.equal(brief.projectId, 'proj-q')
    assert.equal(brief.checkpointId, savedC.checkpointId)
    assert.doesNotMatch(brief.text!, /把项目交接 UI 做完/)
    assert.doesNotMatch(brief.text!, /补 G1-B 的 Brief 注入/)
    assert.match(brief.text!, /另一个项目自己的目标/)
  })

  await test('未绑定会话静默跳过，不抛错、不返回半截文本', () => {
    const brief = buildProjectBrief({ db, sessionId: 'sess-never-bound' })
    assert.equal(brief.text, null)
    assert.equal(brief.skipped, 'no-binding')
  })

  await test('绑了项目但还没存过 Checkpoint 时也是跳过', () => {
    bindSession(db, {
      bindingId: 'bind-D',
      projectId: 'proj-q',
      platform: 'desktop',
      sessionRef: 'sess-D',
      grantGeneration: 'manual',
      deps: { now: () => NOW },
    })
    // proj-q 已经有 Checkpoint，所以换一条没有项目的绑定来验「有绑定无进度」。
    ensureProject(db, {
      projectId: 'proj-empty',
      canonicalName: '空项目',
      workspaceKey: 'ws-empty',
      deps: { now: () => NOW },
    })
    bindSession(db, {
      bindingId: 'bind-E',
      projectId: 'proj-empty',
      platform: 'desktop',
      sessionRef: 'sess-E',
      grantGeneration: 'manual',
      deps: { now: () => NOW },
    })
    const brief = buildProjectBrief({ db, sessionId: 'sess-E' })
    assert.equal(brief.text, null)
    assert.equal(brief.skipped, 'no-checkpoint')
  })

  await test('软预算不够时从最不重要的段落开始删，并报告删了什么', () => {
    ensureProject(db, {
      projectId: 'proj-fat',
      canonicalName: '长项目',
      workspaceKey: 'ws-fat',
      deps: { now: () => NOW },
    })
    bindSession(db, {
      bindingId: 'bind-F',
      projectId: 'proj-fat',
      platform: 'desktop',
      sessionRef: 'sess-F',
      grantGeneration: 'manual',
      deps: { now: () => NOW },
    })
    saveCheckpoint(db, {
      projectId: 'proj-fat',
      bindingId: 'bind-F',
      mode: 'manual',
      requestId: 'req-fat',
      payloadHash: 'h-fat',
      fromSeq: 1,
      toSeq: 1,
      algorithmVersion: 'manual-v1',
      digest: { bodyJson: '{}' },
      revision: {
        currentGoal: '当前任务要保留',
        completed: Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 条已完成事项的描述文字`),
        blockers: [],
        nextSteps: ['下一步也要尽量保留'],
        decisions: Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 条冻结决策的描述文字`),
        generator: 'manual',
      },
    })
    const wide = buildProjectBrief({ db, sessionId: 'sess-F', softLimit: 5000 })
    const narrow = buildProjectBrief({ db, sessionId: 'sess-F', softLimit: 200 })
    assert.ok(narrow.text !== null && wide.text !== null)
    assert.ok(narrow.text.length < wide.text.length, '窄预算必须真的更短')
    assert.ok(narrow.dropped.length > 0, '必须记录被删的条目')
    assert.match(narrow.text, /当前任务要保留/, '当前任务优先级最高，不能先被删')
    assert.ok(
      narrow.dropped.some((line) => line.includes('已冻结的决策') || line.includes('已经完成')),
      `应当先删低优先级段，实际删了：${narrow.dropped.join(' | ')}`,
    )
  })

  await test('引用全部可读时不出「来源不可读」提示', () => {
    const brief = buildProjectBrief({ db, sessionId: 'sess-A' })
    assert.equal(brief.hiddenReferences, 0)
    assert.doesNotMatch(brief.text!, /当前不可读/)
  })
} finally {
  fixture.close()
}

console.log(`[G1-B project-brief] ${passed} 通过 0 失败`)
