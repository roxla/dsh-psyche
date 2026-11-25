// 「登记 → 撤权 → 重新授权 → 到期」这条链的夹具。
//
// 为什么要单独一个文件：迁移 39 修好了代次的**来源**（登记时快照），
// 但「撤权真的拦得住旧提醒」这件事，必须在库里制造出「授权代次变过」的状态才验得到。
// 不需要真 QQ——授权代次就是 access_epochs 表里的一行。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../packages/core/dist/adapter.js'
import { createReminder } from '../packages/core/dist/reminders.js'
import { QqReplyOutboxStore } from '../packages/core/dist/qq-reply-outbox.js'
import { QqReplyWorker } from '../packages/core/dist/qq-reply-worker.js'
import { enqueueReminderReply } from '../packages/core/dist/reminder-outbox.js'
import { createReminderDelivery } from '../dist/lib/reminder-delivery.js'
import type { ChatTarget, ChatSendResult, ChatTransport } from '../packages/core/dist/chat-transport.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

let passed = 0
let failed = 0
function eq(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed += 1; console.log('  ok ' + label) }
  else { failed += 1; console.error('  FAIL ' + label, { actual, expected }) }
}

const STABLE = '90001'

class CountingTransport implements ChatTransport {
  readonly id = 'probe-transport'
  readonly platform = 'qq'
  readonly sent: { target: ChatTarget; text: string }[] = []
  state: 'connected' | 'disconnected' = 'connected'
  status(): 'connected' | 'disconnected' { return this.state }
  async waitConnected(): Promise<boolean> { return this.state === 'connected' }
  capabilities() { return { text: true, image: false, replyQuote: true, proactive: true } }
  async send(target: ChatTarget, outgoing: { text: string }): Promise<ChatSendResult> {
    this.sent.push({ target, text: outgoing.text })
    return { outcome: 'accepted', messageId: `sent_${this.sent.length}` }
  }
  async close(): Promise<void> {}
}

function workerFor(db: Awaited<ReturnType<typeof openDatabase>>['db'], transport: CountingTransport) {
  const store = new QqReplyOutboxStore({ db, ownerId: 'main' })
  const worker = new QqReplyWorker({
    store, transport,
    targetOf: (row) => ({ kind: 'private', platform: 'qq', stableUserId: row.stableUserId }),
    authorization: (row) => {
      const current = db.get<{ epoch: number }>(
        'SELECT epoch FROM access_epochs WHERE persona_id = ? AND peer_key = ?',
        ['main', `private:${row.stableUserId}`],
      )
      if (row.accessEpoch === null) return 'epoch-missing'
      return row.accessEpoch === (current?.epoch ?? 0) ? null : 'access-superseded'
    },
    intervalMs: 3600_000,
  })
  worker.start()
  return worker
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-reminder-revoke-'))
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: quiet })
  const db = opened.db
  await migrate(db, quiet)

  const AT = new Date(Date.now() - 60_000).toISOString()
  db.run(
    `INSERT OR IGNORE INTO contacts
       (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
     VALUES ('ct_owner', 'main', 'qq', ?, 'Owner', 'owner', ?, ?)`,
    [STABLE, AT, AT],
  )
  const setEpoch = (n: number) => db.run(
    `INSERT OR REPLACE INTO access_epochs (persona_id, peer_key, epoch, updated_at) VALUES ('main', ?, ?, ?)`,
    [`private:${STABLE}`, n, AT],
  )
  const now = new Date(AT)

  // ① 旧代次登记的提醒：撤权（代次涨到 7）之后到期
  setEpoch(5)
  const old = createReminder({
    db, personaId: 'main', receiver: { channel: 'qq', contactId: 'ct_owner' },
    dueAt: AT, timezone: 'Asia/Shanghai', text: '撤销前登记的提醒', requestId: 'req-revoke-1', now,
    accessEpoch: 5,
  })
  eq('旧提醒登记成功', old.status, 'created')

  setEpoch(7) // 撤权 + 重新授权，代次涨过一轮

  const delivery = createReminderDelivery({
    db, personaId: 'main', ownerId: 'main',
    bridge: () => ({ transportId: 'probe-transport', accessEpochOf: () => 7 }),
    enqueue: (input) => enqueueReminderReply(input as never),
    now: () => now,
  })
  eq('旧提醒被扫描入队', await delivery.tick(), 1)

  const oldRow = db.get<{ access_epoch: number | null }>(
    'SELECT access_epoch FROM qq_reply_outbox ORDER BY rowid DESC LIMIT 1',
  )
  eq('队列行带的是登记那天的 5，不是现在的 7', oldRow?.access_epoch, 5)

  const t1 = new CountingTransport()
  const w1 = workerFor(db, t1)
  await w1.tick()
  eq('旧提醒一条都没发出去', t1.sent.length, 0)
  w1.stop()

  // ② 新代次登记的提醒：应当正常发出
  const fresh = createReminder({
    db, personaId: 'main', receiver: { channel: 'qq', contactId: 'ct_owner' },
    dueAt: AT, timezone: 'Asia/Shanghai', text: '重授权后的提醒', requestId: 'req-revoke-2', now,
    accessEpoch: 7,
  })
  eq('新提醒登记成功', fresh.status, 'created')
  eq('新提醒被扫描入队', await delivery.tick(), 1)

  const t2 = new CountingTransport()
  const w2 = workerFor(db, t2)
  await w2.tick()
  eq('新提醒发出 1 条', t2.sent.length, 1)
  eq('正文是新提醒的', t2.sent[0]?.text, '重授权后的提醒')
  w2.stop()

  db.close()
  console.log(`[reminder-revoke] ${passed} 通过 ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

await main()
