// 正例：一条已到期的提醒走完「登记 → 扫描 → 入队 → worker 发送」，真的发出 1 次。
//
// 第 53 轮外部评审特别要这一条：如果只有「取消后发送 0 次」这类负例，
// worker 根本没运行、桥接没连上、transport 返回 rejected，都会得到 0 次，
// 于是「拦住了」和「压根没跑」分不开。这里必须真的看见 sent 里有一条。
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
function ok(label: string, good: boolean, detail?: unknown) {
  if (good) { passed += 1; console.log('  ok ' + label) }
  else { failed += 1; console.error('  FAIL ' + label, detail) }
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

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-reminder-positive-'))
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: quiet })
  const db = opened.db
  await migrate(db, quiet)

  // 用「真实时间往前一分钟」：worker 的 tick 用系统时钟判 TTL，固定未来时间会直接过期。
  const AT = new Date(Date.now() - 60_000).toISOString()
  db.run(
    `INSERT OR IGNORE INTO contacts
       (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
     VALUES ('ct_owner', 'main', 'qq', ?, 'Owner', 'owner', ?, ?)`,
    [STABLE, AT, AT],
  )
  // 授权代次表里先放一个 3，入队时桥接会给出同一个值
  db.run(
    `INSERT OR REPLACE INTO access_epochs (persona_id, peer_key, epoch, updated_at) VALUES ('main', ?, 3, ?)`,
    [`private:${STABLE}`, AT],
  )

  const now = new Date(AT)
  const made = createReminder({
    db, personaId: 'main', receiver: { channel: 'qq', contactId: 'ct_owner' },
    dueAt: AT, timezone: 'Asia/Shanghai',
    text: '该喝水了', requestId: 'req-positive-1', now,
    // 登记那一刻的代次快照——到期扫描不现查，避免「撤权后再授权」让旧提醒复活
    accessEpoch: 3,
  })
  ok('登记提醒', made.status === 'created', made.status)

  // ① 扫描并把提醒塞进队列（代次从「桥接」取，这里用一个最小替身）
  const delivery = createReminderDelivery({
    db, personaId: 'main', ownerId: 'main',
    bridge: () => ({ transportId: 'probe-transport', accessEpochOf: () => 3 }),
    enqueue: (input) => enqueueReminderReply(input as never),
    now: () => now,
  })
  eq('扫描入队一条', await delivery.tick(), 1)

  // ② 真 worker 把它发出去
  const transport = new CountingTransport()
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
  await worker.tick()

  eq('真的发出了 1 条', transport.sent.length, 1)
  eq('正文就是提醒正文', transport.sent[0]?.text, '该喝水了')
  ok('收件人是那个稳定号', JSON.stringify(transport.sent[0]?.target).includes(STABLE), transport.sent[0]?.target)

  // ③ 发完之后不会被重复发
  await worker.tick()
  eq('再 tick 不重复发', transport.sent.length, 1)

  worker.stop()
  db.close()
  console.log(`[reminder-positive] ${passed} 通过 ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

await main()
