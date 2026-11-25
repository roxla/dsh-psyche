// 提醒 → outbox 的事务边界（第 53 轮外部评审的三条夹具）。
//
// P1-A 之后回调必须返回合法 outcome、并且真的写出队列行，所以入队统一走
// `test/helpers/reminder-enqueue.ts`（与 `src/lib/reminder-delivery.ts` 同构）。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../packages/core/dist/adapter.js'
import {
  cancelReminder,
  createReminder,
  dispatchDueReminders,
} from '../packages/core/dist/reminders.js'
import { reminderEnqueue } from './helpers/reminder-enqueue.ts'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const dir = mkdtempSync(join(tmpdir(), 'psyche-delivery-'))
const opened = await openDatabase({ file: join(dir, 'm.sqlite3'), driverPreference: 'auto', logger: quiet })
const db = opened.db
await migrate(db, quiet)

// 提醒行的 contact_id 有外键，先造一个 QQ 联系人（persona 'main' 由 migrate 种入）
db.run(
  `INSERT OR IGNORE INTO contacts
     (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
   VALUES ('ct_owner', 'main', 'qq', '90001', 'Owner', 'owner', ?, ?)`,
  ['2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'],
)

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

const now = new Date('2026-08-01T00:00:00.000Z')
const due = new Date('2026-08-01T00:00:00.000Z')
const qq = { channel: 'qq' as const, contactId: 'ct_owner' }

// 登记一个已到期的 QQ 提醒（代次在登记时快照下来，扫描时按行传）
const created = createReminder({
  db, personaId: 'main', receiver: qq,
  dueAt: due.toISOString(), timezone: 'Asia/Shanghai',
  text: '该喝水了', requestId: 'req-delivery-1', now, accessEpoch: 3,
})
ok('登记 QQ 提醒', created.status === 'created', created.status)
const reminder = created.reminder
if (!reminder) throw new Error('没有拿到提醒行')

// 入队回调：与生产路径同构（skipped / queued 都是显式的）
const harness = reminderEnqueue({ db, personaId: 'main' })

function outboxCount(): number {
  const row = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM qq_reply_outbox')
  return Number(row?.n ?? 0)
}

// ① 两个扫描器扫同一批，最终只有一条 outbox
const first = dispatchDueReminders({ db, personaId: 'main', now, enqueueOutbox: harness.callback })
eq('第一个扫描器入队一条', first.queued.length, 1)
ok('拿到的是真实 outboxId', first.queued[0]?.outboxId.length > 0, first.queued[0])
eq('outbox 里一条', outboxCount(), 1)

const second = dispatchDueReminders({ db, personaId: 'main', now, enqueueOutbox: harness.callback })
eq('第二个扫描器拿到 0 条', second.queued.length, 0)
eq('outbox 仍是一条', outboxCount(), 1)

// ② 入队后取消 → 提醒不再被扫到、队列行落终态且不会被再塞一次
const cancelled = cancelReminder({
  db, personaId: 'main', receiver: qq,
  reminderId: reminder.reminder_id, now,
})
eq('确认取消', cancelled.status, 'cancelled')
{
  const row = db.get<{ status: string; last_error_code: string | null }>(
    'SELECT status, last_error_code FROM qq_reply_outbox WHERE reminder_id = ?', [reminder.reminder_id],
  )
  eq('队列行被就地取消', row?.status, 'cancelled')
  eq('取消原因写进队列行', row?.last_error_code, 'reminder_cancelled')
}
const third = dispatchDueReminders({ db, personaId: 'main', now, enqueueOutbox: harness.callback })
eq('取消后扫描拿不到它', third.queued.length, 0)
eq('outbox 没多出行', outboxCount(), 1)

// ③ 事务边界：入队回调抛错时，提醒状态和 outbox 一起回滚（这条不外抛，记成 released）
const created2 = createReminder({
  db, personaId: 'main', receiver: qq,
  dueAt: due.toISOString(), timezone: 'Asia/Shanghai',
  text: '第二条', requestId: 'req-delivery-2', now, accessEpoch: 3,
})
const reminder2 = created2.reminder
if (!reminder2) throw new Error('没有拿到第二条')

let boom = 0
const before = outboxCount()
const rolledBack = dispatchDueReminders({
  db, personaId: 'main', now,
  enqueueOutbox: () => { boom += 1; throw new Error('INJECTED') },
})
eq('回调抛错只回滚这一条', rolledBack.released, 1)
eq('这一轮没有入队', rolledBack.queued, [])
ok('回调被调用过', boom === 1, boom)
const row2 = db.get<{ delivery_state: string; status: string; delivery_result: string | null }>(
  'SELECT delivery_state, status, delivery_result FROM reminders WHERE reminder_id = ?', [reminder2.reminder_id],
)
eq('失败后 delivery_state 回滚成 unsupported', row2?.delivery_state, 'unsupported')
eq('status 也没有被改坏', row2?.status, 'pending')
eq('delivery_result 没有被写成失败', row2?.delivery_result ?? null, null)
eq('outbox 没多写', outboxCount(), before)

// 失败后下一轮还能扫到它（不靠 last_attempt_at 永久排除）
const retried = dispatchDueReminders({ db, personaId: 'main', now, enqueueOutbox: harness.callback })
eq('下一轮还能扫到这条', retried.queued.length, 1)
eq('这次真的进了 outbox', outboxCount(), before + 1)

db.close()
console.log(`[reminder-delivery] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
