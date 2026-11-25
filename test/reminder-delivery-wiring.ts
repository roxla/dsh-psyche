// 提醒派发器的组装点：桥接没连上就不写、代次用稳定号查（第 53 轮外部评审的顺序）。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../packages/core/dist/adapter.js'
import { cancelReminder, createReminder } from '../packages/core/dist/reminders.js'
import { enqueueReminderReply } from '../packages/core/dist/reminder-outbox.js'
import { createReminderDelivery } from '../dist/lib/reminder-delivery.js'
import { insertLegacyDesktopReminder } from './helpers/legacy-desktop-reminder.ts'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const dir = mkdtempSync(join(tmpdir(), 'psyche-delivery2-'))
const opened = await openDatabase({ file: join(dir, 'm.sqlite3'), driverPreference: 'auto', logger: quiet })
const db = opened.db
await migrate(db, quiet)

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

const AT = '2026-09-01T00:00:00.000Z'
db.run(
  `INSERT OR IGNORE INTO contacts
     (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
   VALUES ('ct_owner', 'main', 'qq', '90001', 'Owner', 'owner', ?, ?)`,
  [AT, AT],
)

const now = new Date(AT)
const made = createReminder({
  db, personaId: 'main', receiver: { channel: 'qq', contactId: 'ct_owner' },
  dueAt: AT, timezone: 'Asia/Shanghai', text: '该喝水了', requestId: 'req-d2-1', now,
  // 迁移 39：代次必须在登记时就定下来，到期扫描不现查
  accessEpoch: 5,
})
ok('登记提醒', made.status === 'created', made.status)

function outboxCount(): number {
  return Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM qq_reply_outbox')?.n ?? 0)
}

// ① 桥接不存在 → 什么都不写
{
  const delivery = createReminderDelivery({
    db, personaId: 'main', ownerId: 'owner',
    bridge: () => null,
    enqueue: (input) => enqueueReminderReply(input as never),
    now: () => now,
  })
  eq('桥接为空时一条都不入队', await delivery.tick(), 0)
  eq('outbox 仍是 0', outboxCount(), 0)
}

// ② 桥接存在但没连上（transportId 为空）→ 也不写
{
  const delivery = createReminderDelivery({
    db, personaId: 'main', ownerId: 'owner',
    bridge: () => ({ transportId: '', accessEpochOf: () => 1 }),
    enqueue: (input) => enqueueReminderReply(input as never),
    now: () => now,
  })
  eq('没连上时一条都不入队', await delivery.tick(), 0)
  eq('outbox 仍是 0', outboxCount(), 0)
}

// ③ 正常路径：入队一条，且代次来自稳定号
{
  const seen: string[] = []
  const delivery = createReminderDelivery({
    db, personaId: 'main', ownerId: 'owner',
    bridge: () => ({
      transportId: 'probe-transport',
      accessEpochOf: (target) => { seen.push(target.userId); return 5 },
    }),
    enqueue: (input) => enqueueReminderReply(input as never),
    now: () => now,
  })
  eq('入队一条', await delivery.tick(), 1)
  eq('outbox 有一条', outboxCount(), 1)
  eq('入队不再现查代次（用行里的快照）', seen, [])
  const row = db.get<{ access_epoch: number | null }>(
    'SELECT access_epoch FROM qq_reply_outbox ORDER BY rowid DESC LIMIT 1',
  )
  eq('代次 5 落到了队列行上', row?.access_epoch, 5)
}

// ④ 再扫一次不重复
{
  const delivery = createReminderDelivery({
    db, personaId: 'main', ownerId: 'owner',
    bridge: () => ({ transportId: 'probe-transport', accessEpochOf: () => 5 }),
    enqueue: (input) => enqueueReminderReply(input as never),
    now: () => now,
  })
  eq('再扫一次不入队', await delivery.tick(), 0)
  eq('outbox 仍是一条', outboxCount(), 1)
}

// ⑤ 历史桌面提醒不会被塞进 QQ 队列（第 57 轮 P1-E 起新登记会被入口拒绝，历史行直接落库）
{
  const deskId = insertLegacyDesktopReminder({
    db: db as never, reminderId: 'rem_legacy_desktop_wiring', dueAt: AT,
    text: '桌面提醒', sessionRef: 'desk-1', now,
  })
  ok('历史桌面提醒已落库', deskId.length > 0, deskId)
  const delivery = createReminderDelivery({
    db, personaId: 'main', ownerId: 'owner',
    bridge: () => ({ transportId: 'probe-transport', accessEpochOf: () => 5 }),
    enqueue: (input) => enqueueReminderReply(input as never),
    now: () => now,
  })
  const queued = await delivery.tick()
  ok('桌面提醒不会进 QQ 队列（入队数为 0）', queued === 0, queued)
  eq('outbox 没有多行', outboxCount(), 1)
}

// ⑥ 取消后不再入队
{
  const made2 = createReminder({
    db, personaId: 'main', receiver: { channel: 'qq', contactId: 'ct_owner' },
    dueAt: AT, timezone: 'Asia/Shanghai', text: '要取消的', requestId: 'req-d2-3', now,
  })
  const id = made2.reminder?.reminder_id ?? ''
  cancelReminder({ db, personaId: 'main', receiver: { channel: 'qq', contactId: 'ct_owner' }, reminderId: id, now })
  const delivery = createReminderDelivery({
    db, personaId: 'main', ownerId: 'owner',
    bridge: () => ({ transportId: 'probe-transport', accessEpochOf: () => 5 }),
    enqueue: (input) => enqueueReminderReply(input as never),
    now: () => now,
  })
  eq('取消过的不会入队', await delivery.tick(), 0)
  eq('outbox 仍是一条', outboxCount(), 1)
}

db.close()
console.log(`[reminder-delivery-wiring] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
