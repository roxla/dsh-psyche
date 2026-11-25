// G1-A 手动交接 UI 的后端契约：预览 / 保存 / 定点读回。
//
// 这里测的是三条路由的行为，不是浏览器里的按钮。验收三点在这里的对应物：
//   ① 取消后零持久写入 —— preview 之后库里一行都不多；
//   ② 同一请求双击保存只产生一个修订 —— 同一 draftKey 再 POST 一次返回重放，修订数不变；
//   ③ 重启后能按原 Checkpoint ID 和 revision 读回内容 —— 关库重开后 GET 仍读出原文。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '../dist/lib/adapter.js'
import { registerProjectHandoffRoutes } from '../dist/lib/project-handoff-routes.js'

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
  file: string
  db: Db
  close: () => void
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-handoff-ui-'))
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

function seedSource(db: Db, id: string, sessionRef: string, platform = 'desktop'): void {
  db.run(
    'INSERT INTO sources (source_id, persona_id, platform, channel, origin, kind, text, session_ref, captured_at, created_at) ' +
      "VALUES (?, 'main', ?, 'desktop', 'user', 'message', ?, ?, ?, ?)",
    [id, platform, `正文 ${id}`, sessionRef, NOW, NOW],
  )
}

function countRows(db: Db, table: string): number {
  const row = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
  return row?.n ?? 0
}

const HANDOFF_TABLES = [
  'projects',
  'project_session_bindings',
  'digest_jobs',
  'session_digests',
  'project_checkpoints',
  'checkpoint_revisions',
  'checkpoint_references',
]

function snapshotCounts(db: Db): Record<string, number> {
  const out: Record<string, number> = {}
  for (const table of HANDOFF_TABLES) out[table] = countRows(db, table)
  return out
}

interface Reply {
  status: number
  body: any
}

interface Harness {
  preview: (sessionId: string) => Promise<Reply>
  save: (body: Record<string, unknown>) => Promise<Reply>
  read: (query: string) => Promise<Reply>
}

function harnessOf(db: Db): Harness {
  const routes = registerProjectHandoffRoutes({
    ready: Promise.resolve(true),
    db: () => db,
    unavailable: () => null,
    logger: { warn() {} },
    send: (response: any, statusCode: number, body: unknown) => {
      response.status = statusCode
      response.body = body
    },
    sendJson: (response: any, body: unknown) => {
      response.status = 200
      response.body = body
    },
    readJsonBody: async (request: any) => (request.body ?? {}) as Record<string, unknown>,
  })
  const byPath = (suffix: string) => {
    const found = routes.find((route) => route.path === `/api/psyche/project-handoff${suffix}`)
    assert.ok(found, `找不到路由 ${suffix}`)
    return found
  }
  const invoke = async (suffix: string, request: any): Promise<Reply> => {
    const route = byPath(suffix)
    const response: any = { status: 0, body: null }
    await route.handler(request, response)
    return { status: response.status, body: response.body }
  }
  return {
    preview: (sessionId: string, branchKey?: string) =>
      invoke('/preview', {
        method: 'POST',
        url: '/api/psyche/project-handoff/preview',
        body: branchKey === undefined ? { sessionId } : { sessionId, branchKey },
      }),
    save: (body: Record<string, unknown>) => invoke('/save', { method: 'POST', url: '/api/psyche/project-handoff/save', body }),
    read: (query: string) => invoke('', { method: 'GET', url: `/api/psyche/project-handoff${query}` }),
  }
}

async function main(): Promise<void> {
  const fixture = await setup()
  try {
    seedSource(fixture.db, 'src_ui_1', 'sess-ui-1')
    seedSource(fixture.db, 'src_ui_2', 'sess-ui-1')
    const ui = harnessOf(fixture.db)
    const sessionId = 'sess-ui-1'

    let draftKey = ''

    await test('预览不写库，返回草稿键与区间', async () => {
      const before = snapshotCounts(fixture.db)
      const reply = await ui.preview(sessionId)
      assert.equal(reply.status, 200, JSON.stringify(reply.body))
      assert.equal(reply.body.ok, true)
      assert.equal(reply.body.bound, false)
      assert.equal(typeof reply.body.draftKey, 'string')
      assert.ok(reply.body.draftKey.length > 0)
      assert.equal(reply.body.range.fromSeq, 1)
      // 手动任务没有区间：fromSeq/toSeq 只是保存时刻的水位位置，不随证据条数变化。
      assert.equal(reply.body.range.toSeq, 1, '手动任务不按证据条数推算区间')
      assert.equal(reply.body.candidates.length, 2)
      draftKey = reply.body.draftKey
      const after = snapshotCounts(fixture.db)
      assert.deepEqual(after, before, '预览阶段不允许任何新行')
    })

    await test('取消（不调保存）后仍然零写入', async () => {
      const before = snapshotCounts(fixture.db)
      // 取消在客户端就是「丢掉草稿、不发 /save」，后端看到的是又一个 preview。
      const reply = await ui.preview(sessionId)
      assert.equal(reply.status, 200)
      const after = snapshotCounts(fixture.db)
      assert.deepEqual(after, before)
    })

    await test('保存产生 revision 1，并回传 checkpointId', async () => {
      const reply = await ui.save({
        draftKey,
        canonicalName: '心灵',
        workspaceKey: 'ws-ui',
        branchKey: 'main',
        currentGoal: '做完手动交接 UI',
        completed: ['路由三条', '客户端按钮'],
        blockers: [],
        nextSteps: ['写测试', '更新文档'],
        itemKey: 'u-017',
        expectedRevision: null,
      })
      assert.equal(reply.status, 200, JSON.stringify(reply.body))
      assert.equal(reply.body.ok, true)
      assert.equal(reply.body.saved, true)
      assert.equal(reply.body.revision, 1)
      assert.match(String(reply.body.checkpointId), /^ckp_/)
      // 手动保存不推进水位：否则「保存了两条证据」会被误读成「处理了两个位置」。
      assert.equal(reply.body.committedToSeq, 0, '手动保存不动水位')
    })

    await test('同一 draftKey 再保存一次只重放，不新增修订', async () => {
      const before = snapshotCounts(fixture.db)
      const reply = await ui.save({
        draftKey,
        canonicalName: '心灵',
        workspaceKey: 'ws-ui',
        branchKey: 'main',
        currentGoal: '做完手动交接 UI',
        completed: ['路由三条', '客户端按钮'],
        blockers: [],
        nextSteps: ['写测试', '更新文档'],
        itemKey: 'u-017',
        expectedRevision: null,
      })
      assert.equal(reply.status, 200, JSON.stringify(reply.body))
      assert.equal(reply.body.saved, false, '第二次必须是重放')
      assert.equal(reply.body.replayed, true)
      assert.equal(reply.body.revision, 1, '修订号不能往前走')
      const after = snapshotCounts(fixture.db)
      assert.equal(after.session_digests, before.session_digests)
      assert.equal(after.checkpoint_revisions, before.checkpoint_revisions)
      assert.equal(after.checkpoint_references, before.checkpoint_references)
      assert.equal(after.digest_jobs, before.digest_jobs, '重放不新建任务')
    })

    let checkpointId = ''
    let revision = 0

    await test('按 checkpointId + revision 定点读回内容', async () => {
      const latest = await ui.read(`?sessionId=${sessionId}&branchKey=main`)
      assert.equal(latest.status, 200, JSON.stringify(latest.body))
      assert.equal(latest.body.bound, true)
      assert.ok(latest.body.view)
      checkpointId = String(latest.body.view.checkpointId)
      revision = Number(latest.body.view.headRevision)
      assert.equal(revision, 1)

      const picked = await ui.read(`?checkpointId=${checkpointId}&revision=${revision}`)
      assert.equal(picked.status, 200, JSON.stringify(picked.body))
      assert.equal(picked.body.view.checkpointId, checkpointId)
      assert.equal(picked.body.view.headRevision, revision)
      assert.equal(picked.body.view.revision.revision, revision)
      assert.equal(picked.body.view.revision.currentGoal, '做完手动交接 UI')
      assert.deepEqual(picked.body.view.revision.completed, ['路由三条', '客户端按钮'])
      assert.deepEqual(picked.body.view.revision.nextSteps, ['写测试', '更新文档'])
    })

    await test('关库重开后仍能按原 ID 与 revision 读回', async () => {
      const reopened = await openDatabase({ file: fixture.file, driverPreference: 'auto', logger })
      try {
        const ui2 = harnessOf(reopened.db)
        const picked = await ui2.read(`?checkpointId=${checkpointId}&revision=${revision}`)
        assert.equal(picked.status, 200, JSON.stringify(picked.body))
        assert.equal(picked.body.view.revision.currentGoal, '做完手动交接 UI')
        assert.deepEqual(picked.body.view.revision.completed, ['路由三条', '客户端按钮'])
        // 重启后草稿已随进程消失：这里没法在同一进程里清掉模块级 Map，
        // 所以用「不存在的 draftKey」等价验证 —— 真实重启后旧键必然落到这个分支。
        const stale = await ui2.save({
          draftKey: 'drf_never_issued',
          canonicalName: '心灵',
          branchKey: 'main',
          currentGoal: 'x',
          completed: [],
          blockers: [],
          nextSteps: [],
        })
        assert.equal(stale.status, 409, '失效草稿要求重新预览')
        assert.equal(stale.body.code, 'E_STATE')
      } finally {
        reopened.db.close()
      }
    })

    await test('未绑定会话读回是 bound:false，点位读取没命中的 revision 返回 404', async () => {
      const none = await ui.read('?sessionId=sess-never-bound')
      assert.equal(none.status, 200)
      assert.equal(none.body.bound, false)
      const missing = await ui.read(`?checkpointId=${checkpointId}&revision=99`)
      assert.equal(missing.status, 404)
      assert.equal(missing.body.code, 'E_NOT_FOUND')
    })

    await test('正文与证据都为空时拒绝保存，且零写入', async () => {
      const before = snapshotCounts(fixture.db)
      const empty = await ui.preview(sessionId)
      const reply = await ui.save({
        draftKey: empty.body.draftKey,
        canonicalName: '心灵',
        branchKey: 'main',
        currentGoal: '',
        completed: [],
        blockers: [],
        nextSteps: [],
      })
      assert.equal(reply.status, 400, JSON.stringify(reply.body))
      assert.equal(reply.body.code, 'E_VALIDATION')
      const after = snapshotCounts(fixture.db)
      assert.deepEqual(after, before, '空内容不能留下任何行')
    })

    await test('零证据保存：允许，但不推进水位、引用数为 0', async () => {
      // 换一个没有候选证据的会话，模拟「只写正文、不附来源」。
      const lonely = 'sess-ui-empty'
      const draft = await ui.preview(lonely)
      assert.equal(draft.status, 200, JSON.stringify(draft.body))
      assert.equal(draft.body.candidates.length, 0)
      assert.equal(draft.body.range.fromSeq, draft.body.range.toSeq, '零证据不能推出区间')
      const reply = await ui.save({
        draftKey: draft.body.draftKey,
        canonicalName: '心灵',
        branchKey: 'no-evidence',
        currentGoal: '只写正文',
        completed: [],
        blockers: [],
        nextSteps: [],
      })
      assert.equal(reply.status, 200, JSON.stringify(reply.body))
      assert.equal(reply.body.saved, true)
      assert.equal(reply.body.committedToSeq, 0, '零证据不许推水位')
      const refs = fixture.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM checkpoint_references WHERE checkpoint_id = ? AND revision = ? AND source_id IS NOT NULL',
        [reply.body.checkpointId, reply.body.revision],
      )
      assert.equal(Number(refs?.n), 0)
    })

    await test('同一来源在新草稿里保存得到新修订（不是重放）', async () => {
      const before = snapshotCounts(fixture.db)
      const again = await ui.preview(sessionId)
      const reply = await ui.save({
        draftKey: again.body.draftKey,
        canonicalName: '心灵',
        workspaceKey: 'ws-ui',
        branchKey: 'main',
        currentGoal: '第二轮：仍然选同两条来源',
        completed: [],
        blockers: [],
        nextSteps: ['继续'],
        itemKey: 'u-017',
        expectedRevision: null,
      })
      assert.equal(reply.status, 200, JSON.stringify(reply.body))
      assert.equal(reply.body.saved, true, '新草稿是独立请求，不能被当成重放')
      assert.equal(reply.body.revision, 2, '同一分支的第二次手动保存应是 revision 2')
      assert.equal(reply.body.committedToSeq, 0, '手动保存始终不动水位')
      const after = snapshotCounts(fixture.db)
      assert.equal(after.checkpoint_revisions, before.checkpoint_revisions + 1)
    })

    await test('同一 requestId 内容不一致时拒绝，不写第二条', async () => {
      const draft = await ui.preview(sessionId)
      const first = await ui.save({
        draftKey: draft.body.draftKey,
        canonicalName: '心灵',
        workspaceKey: 'ws-ui',
        branchKey: 'main',
        currentGoal: '第一次内容',
        completed: [],
        blockers: [],
        nextSteps: [],
      })
      assert.equal(first.status, 200, JSON.stringify(first.body))
      const before = snapshotCounts(fixture.db)
      const second = await ui.save({
        draftKey: draft.body.draftKey,
        canonicalName: '心灵',
        workspaceKey: 'ws-ui',
        branchKey: 'main',
        currentGoal: '改过的内容',
        completed: [],
        blockers: [],
        nextSteps: [],
      })
      assert.equal(second.status, 400, JSON.stringify(second.body))
      assert.equal(second.body.code, 'E_VALIDATION')
      const after = snapshotCounts(fixture.db)
      assert.deepEqual(after, before, '内容不一致时不能写库')
    })

  // 第 37 轮外部评审 P1（07）：真实 Desktop 会话的 Source 记在 dsh-session，
      // 绑定键记 desktop。候选查询如果用规范值查来源，就会出现「已绑定却预览不到证据」。
    await test('dsh-session 来源在 desktop 绑定下能预览到', async () => {
      seedSource(fixture.db, 'src_alias_1', 'sess-alias', 'dsh-session')
      const preview = await ui.preview('sess-alias')
      assert.equal(preview.status, 200, JSON.stringify(preview.body))
      const ids = (preview.body.candidates as { sourceId: string }[]).map((c) => c.sourceId)
      assert.ok(ids.includes('src_alias_1'), `候选应含 dsh-session 来源，实际 ${JSON.stringify(ids)}`)
    })
  // 第 37 轮外部评审 P1（06）：重开表单要读回上一版内容，事项标识不能写死。
    await test('重开预览读回上一版的已完成、阻塞与事项标识', async () => {
      const sessionId = 'sess-readback'
      seedSource(fixture.db, 'src_rb_1', sessionId)
      const preview = await ui.preview(sessionId)
      const saved = await ui.save({
        draftKey: preview.body.draftKey,
        canonicalName: '读回项目',
        workspaceKey: 'ws-rb',
        branchKey: 'main',
        currentGoal: '把分页查询的边界改完',
        completed: ['分页边界已改成 50'],
        blockers: ['越界用例还没写'],
        nextSteps: ['补一个越界用例'],
        itemKey: 'ZETA-9',
      })
      assert.equal(saved.status, 200, JSON.stringify(saved.body))

      const again = await ui.preview(sessionId)
      assert.equal(again.status, 200, JSON.stringify(again.body))
      assert.ok(again.body.base !== null, `预览没拿到 base：${JSON.stringify(again.body)}`)
      assert.equal(again.body.base.currentGoal, '把分页查询的边界改完')
      assert.deepEqual(again.body.base.completed, ['分页边界已改成 50'])
      assert.deepEqual(again.body.base.blockers, ['越界用例还没写'])
      // 关键：此前客户端写死 'u-017'，重开也读不到；现在必须回传上次真实用过的值。
      assert.equal(again.body.base.itemKey, 'ZETA-9')
    })

  // 第 37 轮外部评审 P2（09）：清理不能只在新建预览时发生。
    await test('超过 TTL 的草稿即使没有其他请求也不能保存', async () => {
      const sessionId = 'sess-ttl'
      seedSource(fixture.db, 'src_ttl_1', sessionId)
      const preview = await ui.preview(sessionId)
      const beforeRows = countRows(fixture.db, 'project_checkpoints')
      const realNow = Date.now
      try {
        // 把时钟推到 TTL 之后：期间没有任何其他请求，prune 不会被触发。
        Date.now = () => realNow() + 31 * 60 * 1000
        const expired = await ui.save({
          draftKey: preview.body.draftKey,
          canonicalName: '过期项目',
          workspaceKey: 'ws-ttl',
          branchKey: 'main',
          currentGoal: '这条不该被写进去',
          completed: [],
          blockers: [],
          nextSteps: [],
        })
        assert.equal(expired.status, 409, JSON.stringify(expired.body))
        assert.equal(expired.body.code, 'E_STATE')
      } finally {
        Date.now = realNow
      }
      const rows = countRows(fixture.db, 'project_checkpoints')
      assert.equal(rows, beforeRows, '过期草稿不能落库')
    })

  // 第 37 轮外部评审 P2（09）边界修正：满额要拒绝新预览，而不是淘汰仍有效的草稿
  // ——淘汰会让另一个窗口正在编辑的那份凭空消失。
    await test('草稿满额时拒绝新预览，已有草稿仍能保存', async () => {
      const sessionId = 'sess-cap'
      seedSource(fixture.db, 'src_cap_1', sessionId)
      // 草稿是模块级 Map，前面的用例已经占了一部分；这里一直开到被拒为止。
      const keys: string[] = []
      let rejected: any = null
      for (let i = 0; i < 80; i += 1) {
        const preview = await ui.preview(sessionId)
        if (preview.status === 200) {
          keys.push(preview.body.draftKey)
          continue
        }
        rejected = preview
        break
      }
      assert.ok(rejected !== null, '应该能撞到容量上限')
      assert.equal(rejected.status, 429, JSON.stringify(rejected.body))
      assert.equal(rejected.body.code, 'E_DRAFT_FULL')

      // 关键：最早打开的那份仍然可以保存（没有被淘汰掉）。
      const oldest = await ui.save({
        draftKey: keys[0]!,
        canonicalName: '容量项目',
        workspaceKey: 'ws-cap',
        branchKey: 'main',
        currentGoal: '最早的草稿',
        completed: [],
        blockers: [],
        nextSteps: [],
      })
      assert.equal(oldest.status, 200, JSON.stringify(oldest.body))

      // 空出一份之后（把时钟推过 TTL 让它们过期 + 一次请求触发清理），新预览恢复。
      const realNow = Date.now
      try {
        Date.now = () => realNow() + 31 * 60 * 1000
        const afterExpiry = await ui.preview(sessionId)
        assert.equal(afterExpiry.status, 200, JSON.stringify(afterExpiry.body))
      } finally {
        Date.now = realNow
      }
    })
  // 第 37 轮追加边界（06）：最近更新的分支未必是用户要编辑的那条。
    await test('显式重开 main 时读回 main 的内容，不会被更新的 feature 顶掉', async () => {
      const sessionId = 'sess-branch'
      seedSource(fixture.db, 'src_br_1', sessionId)
      const p1 = await ui.preview(sessionId, 'main')
      assert.equal(p1.status, 200, JSON.stringify(p1.body))
      const mainSave = await ui.save({
        draftKey: p1.body.draftKey,
        canonicalName: '分支项目',
        workspaceKey: 'ws-br',
        branchKey: 'main',
        currentGoal: 'main 上的目标',
        completed: ['main 上完成的事'],
        blockers: ['main 上的阻塞'],
        nextSteps: [],
        itemKey: 'MAIN-1',
      })
      assert.equal(mainSave.status, 200, JSON.stringify(mainSave.body))

      const p2 = await ui.preview(sessionId, 'feature')
      assert.equal(p2.status, 200, JSON.stringify(p2.body))
      const featureSave = await ui.save({
        draftKey: p2.body.draftKey,
        canonicalName: '分支项目',
        workspaceKey: 'ws-br',
        branchKey: 'feature',
        currentGoal: 'feature 上的目标',
        completed: ['feature 上完成的事'],
        blockers: [],
        nextSteps: [],
        itemKey: 'FEAT-2',
      })
      assert.equal(featureSave.status, 200, JSON.stringify(featureSave.body))

      // feature 更晚保存，是「最近更新的分支」；显式要 main 就必须拿到 main 的。
      const back = await ui.preview(sessionId, 'main')
      assert.equal(back.status, 200, JSON.stringify(back.body))
      assert.equal(back.body.branchKey, 'main')
      assert.equal(back.body.base.currentGoal, 'main 上的目标')
      assert.deepEqual(back.body.base.completed, ['main 上完成的事'])
      assert.deepEqual(back.body.base.blockers, ['main 上的阻塞'])
      assert.equal(back.body.base.itemKey, 'MAIN-1')
    })
  } finally {
    fixture.close()
  }
  console.log(`\n${passed} 通过 0 失败`)
}

await main()
