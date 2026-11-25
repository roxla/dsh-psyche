// 提醒能不能真的进 QQ 私聊回复队列（第 53 轮外部评审的方向）。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../packages/core/dist/adapter.js'
import { createReminder, getReminder } from '../packages/core/dist/reminders.js'
import { enqueueReminderReply, REMINDER_OUTBOX_TTL_MS } from '../packages/core/dist/reminder-outbox.js'
import { insertLegacyDesktopReminder } from './helpers/legacy-desktop-reminder.ts'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const dir = mkdtempSync(join(tmpdir(), 'psyche-reminder-outbox-'))
const opened = await openDatabase({ file: join(dir, 'o.sqlite3'), driverPreference: 'auto', logger: quiet })
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

const now = new Date('2026-03-01T00:00:00.000Z')
const nowIso = now.toISOString()
db.exec(`INSERT OR IGNORE INTO contacts
  (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
  VALUES ('ct_owner', 'main', 'qq', '90001', '主人', 'owner', '${nowIso}', '${nowIso}')`)

const created = createReminder({
  db, personaId: 'main',
  receiver: { channel: 'qq', contactId: 'ct_owner' },
  dueAt: '2026-03-01T00:10:00.000Z', timezone: 'Asia/Shanghai',
  text: '该喝水了', requestId: 'req-outbox-1', now,
})
ok('登记 QQ 提醒', created.status === 'created', created.status)
const reminder = created.reminder
if (!reminder) throw new Error('没有拿到提醒行')

// ① 第一次入队
const first = enqueueReminderReply({
  db, ownerId: 'owner', personaId: 'main', reminder,
  transportId: 'probe-transport', now: nowIso,
})
ok('拿到 replyId', first.replyId.length > 0, first.replyId)
eq('第一次不是重放', first.duplicate, false)

const row = db.get<{
  session_id: string
  session_seq: number
  payload_text: string
  status: string
  access_epoch: number | null
  expires_at: string
}>('SELECT * FROM qq_reply_outbox WHERE reply_id = ?', [first.replyId])
ok('行写进去了', row !== undefined, row)
eq('会话是 qq-private-<稳定号>', row?.session_id, 'qq-private-90001')
eq('正文来自提醒', row?.payload_text, '该喝水了')
eq('初始状态 pending', row?.status, 'pending')
// 没给授权代次时写 null：worker 会按 epoch-missing 停下，这是刻意的 fail-closed。
eq('没有代次就写 null', row?.access_epoch, null)
eq(
  'TTL 用提醒自己的 10 分钟',
  row === undefined ? null : new Date(row.expires_at).getTime() - now.getTime(),
  REMINDER_OUTBOX_TTL_MS,
)

// ② 第二条提醒会用不同的 seq
const second = createReminder({
  db, personaId: 'main',
  receiver: { channel: 'qq', contactId: 'ct_owner' },
  dueAt: '2026-03-01T00:20:00.000Z', timezone: 'Asia/Shanghai',
  text: '该起来了', requestId: 'req-outbox-2', now,
})
const secondRow = second.reminder
if (!secondRow) throw new Error('没有拿到第二条提醒')
const secondEnqueue = enqueueReminderReply({
  db, ownerId: 'owner', personaId: 'main', reminder: secondRow,
  transportId: 'probe-transport', now: nowIso,
})
const seqs = db.all<{ session_seq: number }>(
  'SELECT session_seq FROM qq_reply_outbox WHERE session_id = ? ORDER BY session_seq',
  ['qq-private-90001'],
)
eq('两条提醒拿到两个不同的 seq', seqs.map((r) => r.session_seq), [1, 2])
ok('第二条也有 replyId', secondEnqueue.replyId.length > 0)

// ③ 历史桌面提醒不能进 QQ 队列（第 57 轮 P1-E 起新登记会被入口拒绝，历史行直接落库）
insertLegacyDesktopReminder({
  db: db as never, reminderId: 'rem_legacy_desktop_outbox',
  dueAt: '2026-03-01T00:30:00.000Z', text: '桌面提醒', sessionRef: 'desktop-x',
  now, requestId: 'req-outbox-3',
})
const desktopRow = getReminder({ db, personaId: 'main', reminderId: 'rem_legacy_desktop_outbox' })
if (desktopRow) {
  let rejected = false
  try {
    enqueueReminderReply({
      db, ownerId: 'owner', personaId: 'main', reminder: desktopRow,
      transportId: 'probe-transport', now: nowIso,
    })
  } catch (error) {
    rejected = /只有 QQ 提醒/.test(error instanceof Error ? error.message : String(error))
  }
  ok('桌面提醒被拒', rejected)
}

// ④ 联系人没有稳定号时拒绝，且不写任何行
db.exec(`INSERT OR IGNORE INTO contacts
  (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
  VALUES ('ct_nostable', 'main', 'qq', '', '无号', 'friend', '${nowIso}', '${nowIso}')`)
const noStable = createReminder({
  db, personaId: 'main',
  receiver: { channel: 'qq', contactId: 'ct_nostable' },
  dueAt: '2026-03-01T00:40:00.000Z', timezone: 'Asia/Shanghai',
  text: '没号', requestId: 'req-outbox-4', now,
})
const noStableRow = noStable.reminder
if (noStableRow) {
  const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM qq_reply_outbox')?.n ?? 0
  let rejected = false
  try {
    enqueueReminderReply({
      db, ownerId: 'owner', personaId: 'main', reminder: noStableRow,
      transportId: 'probe-transport', now: nowIso,
    })
  } catch (error) {
    rejected = /稳定 QQ 号/.test(error instanceof Error ? error.message : String(error))
  }
  ok('没有稳定号被拒', rejected)
  eq('并且没有多写行', db.get<{ n: number }>('SELECT COUNT(*) AS n FROM qq_reply_outbox')?.n, before)
}

// ⑤ 给了授权代次就写进队列（撤销后不发靠的就是它）
{
  const withEpoch = createReminder({
    db, personaId: 'main',
    receiver: { channel: 'qq', contactId: 'ct_owner' },
    dueAt: '2026-03-01T00:50:00.000Z', timezone: 'Asia/Shanghai',
    text: '带代次的提醒', requestId: 'req-outbox-5', now,
  })
  const epochRow = withEpoch.reminder
  if (epochRow) {
    const enqueued = enqueueReminderReply({
      db, ownerId: 'owner', personaId: 'main', reminder: epochRow,
      transportId: 'probe-transport', now: nowIso, accessEpoch: 7,
    })
    const stored = db.get<{ access_epoch: number | null }>(
      'SELECT access_epoch FROM qq_reply_outbox WHERE reply_id = ?', [enqueued.replyId],
    )
    eq('代次 7 被写进队列', stored?.access_epoch, 7)
  }
}

db.close()
console.log(`[reminder-outbox] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
