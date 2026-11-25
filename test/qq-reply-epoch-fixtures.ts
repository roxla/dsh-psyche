// 12a 的正式夹具：走真实的 QqReplyOutboxStore + QqReplyWorker + 迁移到 v38 的 SQLite，
// 只把 transport 换成计数替身。目的是回答评审那条判据——
// 「旧任务在换代之后，到底有没有被底层发送」。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ChatSendResult, ChatTarget, ChatTransport } from '../packages/core/dist/chat-transport.js'
import { migrate, openDatabase } from '../packages/core/dist/adapter.js'
import { QqReplyOutboxStore } from '../packages/core/dist/qq-reply-outbox.js'
import { QqReplyWorker } from '../packages/core/dist/qq-reply-worker.js'

let passed = 0
let failed = 0
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(error instanceof Error ? error.stack : String(error))
  }
}

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error(message)
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** persona_config 与 contacts 是 outbox 的外键目标，两个最小行先种上。 */
function seedIdentity(db: { run: (sql: string, params?: readonly unknown[]) => unknown }): void {
  db.run(
    `INSERT OR IGNORE INTO persona_config (persona_id, created_at, updated_at) VALUES ('main', ?, ?)`,
    ['2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z'],
  )
  for (const uid of ['10002', '10003']) {
    db.run(
      `INSERT OR IGNORE INTO contacts (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
       VALUES (?, 'main', 'qq', ?, ?, 'friend', ?, ?)`,
      [`ct_${uid}`, uid, `probe-${uid}`, '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z'],
    )
  }
}

/** 计数型 transport：能进入已连接状态，记录每条发出去的消息。 */
class CountingTransport implements ChatTransport {
  readonly id = 'probe-transport'
  readonly platform = 'qq'
  readonly sent: { target: ChatTarget; text: string }[] = []
  state: 'connected' | 'disconnected' = 'connected'

  status(): 'connected' | 'disconnected' {
    return this.state
  }
  async waitConnected(): Promise<boolean> {
    return this.state === 'connected'
  }
  capabilities() {
    return { text: true, image: false, replyQuote: true, proactive: true }
  }
  async send(target: ChatTarget, outgoing: { text: string }): Promise<ChatSendResult> {
    this.sent.push({ target, text: outgoing.text })
    return { outcome: 'accepted', messageId: `sent_${this.sent.length}` }
  }
  async close(): Promise<void> {}
}

/**
 * 只到 store + worker 这一层，不建 QqBridge：夹具要验的是「持久化的代次
 * 能不能挡住上一个代次写进去的行」，而代次本身在 access_epochs 表里。
 */
async function withDb(run: (ctx: { db: Awaited<ReturnType<typeof openDatabase>>; dir: string }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-epoch-fx-'))
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: quiet })
  const db = opened.db
  try {
    await migrate(db, quiet)
    seedIdentity(db)
    await run({ db, dir })
  } finally {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const base = (stableUserId: string, seq: number, text: string, accessEpoch: number | null) => ({
  personaId: 'main',
  contactId: `ct_${stableUserId}`,
  stableUserId,
  sessionId: `qq-private-${stableUserId}`,
  sessionSeq: seq,
  transportId: 'probe-transport',
  payloadText: text,
  accessEpoch,
  now: new Date().toISOString(),
})

async function main(): Promise<void> {
  // 夹具 ②：旧代次写进去的行，换代之后重启也不能发。
  await test('F2 已入队的旧代次行，换代并重启后仍不发送', async () => {
    await withDb(async ({ db }) => {
      const store = new QqReplyOutboxStore({ db, ownerId: '10001' })
      const { row } = store.enqueue(base('10002', 1, '旧代次的回复', 0))

      // 换代：模拟 applyAccess 撤销再重加后的落库结果。
      db.run(
        `INSERT INTO access_epochs (persona_id, peer_key, epoch, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(persona_id, peer_key) DO UPDATE SET epoch = excluded.epoch`,
        ['main', 'private:10002', 2, '2026-11-22T00:01:00.000Z'],
      )

      const transport = new CountingTransport()
      const worker = new QqReplyWorker({
        store,
        transport,
        targetOf: (r) => ({ kind: 'private', platform: 'qq', stableUserId: r.stableUserId }),
        authorization: (r) => {
          const current = db.get<{ epoch: number }>(
            `SELECT epoch FROM access_epochs WHERE persona_id = ? AND peer_key = ?`,
            ['main', `private:${r.stableUserId}`],
          )
          if (r.accessEpoch === null) return 'epoch-missing'
          return r.accessEpoch === (current?.epoch ?? 0) ? null : 'access-superseded'
        },
        intervalMs: 3600_000,
      })
      worker.start()
      await worker.tick()
      worker.start()
      await worker.tick()
      await worker.stop()

      const after = store.get(row.replyId)
      assert(transport.sent.length === 0, `底层发送应为 0 次，实际 ${transport.sent.length}`)
      // 评审要的是「已结束 + 不再被领取」，不锁定具体状态名。
      assert(after?.status !== 'pending', `该行应已结束，实际 status=${after?.status}`)
      const attemptsAfter = after?.attemptCount ?? 0
      await worker.tick()
      await worker.tick()
      assert(transport.sent.length === 0, '后续轮次不该再发它')
      assert(
        (store.get(row.replyId)?.attemptCount ?? 0) === attemptsAfter,
        '尝试次数不该再增长',
      )
    })
  })

  // 夹具 ② 的正例：同代次的行必须能真的发出去，否则「0 次」可能只是链路没通。
  await test('同代次的行能发出一次（正例，防止 0 次是假象）', async () => {
    await withDb(async ({ db }) => {
      const store = new QqReplyOutboxStore({ db, ownerId: '10001' })
      db.run(
        `INSERT INTO access_epochs (persona_id, peer_key, epoch, updated_at) VALUES (?, ?, ?, ?)`,
        ['main', 'private:10002', 2, '2026-11-22T00:01:00.000Z'],
      )
      const { row } = store.enqueue(base('10002', 2, '当前代次的回复', 2))

      const transport = new CountingTransport()
      const worker = new QqReplyWorker({
        store,
        transport,
        targetOf: (r) => ({ kind: 'private', platform: 'qq', stableUserId: r.stableUserId }),
        authorization: (r) => {
          const current = db.get<{ epoch: number }>(
            `SELECT epoch FROM access_epochs WHERE persona_id = ? AND peer_key = ?`,
            ['main', `private:${r.stableUserId}`],
          )
          if (r.accessEpoch === null) return 'epoch-missing'
          return r.accessEpoch === (current?.epoch ?? 0) ? null : 'access-superseded'
        },
        intervalMs: 3600_000,
      })
      worker.start()
      await worker.tick()
      await worker.stop()

      assert(transport.sent.length === 1, `应发出 1 次，实际 ${transport.sent.length}`)
      assert(store.get(row.replyId)?.status === 'sent', '该行应记为 sent')
    })
  })

  // 夹具 ② 的另一半：没有快照的历史行一律不发。
  await test('迁移前没有快照的行不发（epoch-missing）', async () => {
    await withDb(async ({ db }) => {
      const store = new QqReplyOutboxStore({ db, ownerId: '10001' })
      const { row } = store.enqueue(base('10002', 3, '没有快照的历史回复', null))
      const transport = new CountingTransport()
      const worker = new QqReplyWorker({
        store,
        transport,
        targetOf: (r) => ({ kind: 'private', platform: 'qq', stableUserId: r.stableUserId }),
        authorization: (r) => (r.accessEpoch === null ? 'epoch-missing' : null),
        intervalMs: 3600_000,
      })
      worker.start()
      await worker.tick()
      await worker.stop()
      const missingRow = store.get(row.replyId)
      assert(transport.sent.length === 0, '没有快照的行不该发出')
      assert(missingRow?.status === 'cancelled', '没有快照的行应被取消')
    })
  })

  // 夹具 ②：冷启动恢复——关库、重开、新 worker，旧代次的行仍然不能发。
  await test('F3 冷启动：关库重开后旧代次的行仍不发，新代次能发', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psyche-epoch-cold-'))
    const file = join(dir, 'memory.sqlite3')
    let staleId = ''
    let freshId = ''
    try {
      const first = await openDatabase({ file, driverPreference: 'auto', logger: quiet })
      try {
        await migrate(first.db, quiet)
        seedIdentity(first.db)
        const store = new QqReplyOutboxStore({ db: first.db, ownerId: '10001' })
        staleId = store.enqueue(base('10002', 11, '旧代次的回复', 0)).row.replyId
        freshId = store.enqueue(base('10002', 12, '新代次的回复', 3)).row.replyId
        first.db.run(
          `INSERT INTO access_epochs (persona_id, peer_key, epoch, updated_at) VALUES (?, ?, ?, ?)`,
          ['main', 'private:10002', 3, '2026-11-22T00:01:00.000Z'],
        )
      } finally {
        first.db.close()
      }

      // 第二次打开：全新 store 与 worker，只共享同一份库文件。
      const second = await openDatabase({ file, driverPreference: 'auto', logger: quiet })
      try {
        const store2 = new QqReplyOutboxStore({ db: second.db, ownerId: '10001' })
        const transport = new CountingTransport()
        const worker = new QqReplyWorker({
          store: store2,
          transport,
          targetOf: (r) => ({ kind: 'private', platform: 'qq', stableUserId: r.stableUserId }),
          authorization: (r) => {
            const current = second.db.get<{ epoch: number }>(
              `SELECT epoch FROM access_epochs WHERE persona_id = ? AND peer_key = ?`,
              ['main', `private:${r.stableUserId}`],
            )
            if (r.accessEpoch === null) return 'epoch-missing'
            return r.accessEpoch === (current?.epoch ?? 0) ? null : 'access-superseded'
          },
          intervalMs: 3600_000,
        })
        worker.start()
        await worker.tick()
        await worker.tick()
        await worker.stop()

        assert(transport.sent.length === 1, `只该发新代次那条，实际 ${transport.sent.length}`)
        assert(transport.sent[0]?.text === '新代次的回复', '发出去的应该是新代次那条')
        assert(store2.get(staleId)?.status !== 'pending', '旧代次那条应已结束')
        assert(store2.get(freshId)?.status === 'sent', '新代次那条应记为 sent')
      } finally {
        second.db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  console.log(`\n[qq-reply-epoch-fixtures] ${passed} 通过 / ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

await main()




