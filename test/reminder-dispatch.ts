// 到期扫描：原子入队 + 可取消 + 重启补扫（第 52/53 轮外部评审）。
//
// P1-A 之后这条路径的契约变了：回调必须真的把行写进 `qq_reply_outbox` 并返回
// `{kind:'queued',outboxId}`；`queued` 里出现的是 `{reminderId,outboxId}` 对象。
// 所以这个文件里所有入队都走 `test/helpers/reminder-enqueue.ts`（与生产回调同构），
// 不再用「回调里 push 一下 id」这种假排队写法。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../packages/core/dist/adapter.js'
import {
  cancelReminder,
  createReminder,
  dispatchDueReminders,
  dueReminders,
  getReminder,
} from '../packages/core/dist/reminders.js'
import { reminderEnqueue } from './helpers/reminder-enqueue.ts'
import { insertLegacyDesktopReminder } from './helpers/legacy-desktop-reminder.ts'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const dir = mkdtempSync(join(tmpdir(), 'psyche-dispatch-'))
const opened = await openDatabase({ file: join(dir, 'm.sqlite3'), driverPreference: 'auto', logger: quiet })
const db = opened.db
await migrate(db, quiet)

const AT = '2026-01-01T00:00:00.000Z'
db.run(
  `INSERT OR IGNORE INTO contacts
     (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
   VALUES ('ct_owner', 'main', 'qq', '90001', '主人', 'owner', ?, ?)`,
  [AT, AT],
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

const now = new Date('2026-01-01T00:00:00.000Z')
const qq = (contactId: string) => ({ channel: 'qq' as const, contactId })
/** 到期扫描之后的时间：两条提醒都到点。 */
const after = new Date('2026-01-01T01:00:00.000Z')

function outboxRows(dbase: typeof db) {
  return dbase.all<{
    reply_id: string
    reminder_id: string | null
    status: string
    last_error_code: string | null
    session_id: string
    access_epoch: number | null
  }>('SELECT reply_id, reminder_id, status, last_error_code, session_id, access_epoch FROM qq_reply_outbox ORDER BY session_seq')
}

const aRes = createReminder({
  db, personaId: 'main', receiver: qq('ct_owner'),
  dueAt: '2026-01-01T00:00:00.000Z', timezone: 'Asia/Shanghai',
  text: '到点提醒 A', requestId: 'req-dispatch-a', now, accessEpoch: 5,
})
ok('登记 A', aRes.status === 'created', aRes.status)
const bRes = createReminder({
  db, personaId: 'main', receiver: qq('ct_owner'),
  dueAt: '2026-01-01T00:05:00.000Z', timezone: 'Asia/Shanghai',
  text: '到点提醒 B', requestId: 'req-dispatch-b', now, accessEpoch: 5,
})
ok('登记 B', bRes.status === 'created', bRes.status)

const aId = aRes.reminder?.reminder_id ?? ''
const bId = bRes.reminder?.reminder_id ?? ''
ok('拿到两个 id', aId.length > 0 && bId.length > 0, { aId, bId })

const cancelled = cancelReminder({ db, personaId: 'main', receiver: qq('ct_owner'), reminderId: bId, now })
eq('取消 B', cancelled.status, 'cancelled')

// ① 只入队没被取消的那条
const h1 = reminderEnqueue({ db, personaId: 'main' })
const first = dispatchDueReminders({ db, personaId: 'main', now: after, enqueueOutbox: h1.callback })
eq('只入队一条（被取消的不算）', first.queued.map((q) => q.reminderId), [aId])
eq('回调只被叫了那一条', h1.calls, [aId])
ok('queued 里带着真实 outboxId', first.queued[0]?.outboxId.length > 0, first.queued[0])
{
  const rows = outboxRows(db)
  eq('outbox 里恰好一行', rows.length, 1)
  eq('队列行挂着 reminder_id', rows[0]?.reminder_id, aId)
  eq('会话是 qq-private-<稳定号>', rows[0]?.session_id, 'qq-private-90001')
  eq('代次从提醒行快照带下来', rows[0]?.access_epoch, 5)
  eq('排队状态 pending', rows[0]?.status, 'pending')
}

// ② 双扫描只生成一行
const h2 = reminderEnqueue({ db, personaId: 'main' })
const second = dispatchDueReminders({ db, personaId: 'main', now: after, enqueueOutbox: h2.callback })
eq('再扫一次不重复入队', second.queued, [])
eq('并且回调根本没被叫', h2.calls, [])
eq('outbox 仍是一行', outboxRows(db).length, 1)

// ③ 入队后的状态口径（冻结表：pending/pending/NULL）
{
  const rowA = getReminder({ db, personaId: 'main', reminderId: aId })
  eq('delivery_state 变成 pending', rowA?.delivery_state, 'pending')
  ok('status 仍是 pending（还没发出去）', rowA?.status === 'pending', rowA?.status)
  eq('delivery_result 还没写', rowA?.delivery_result ?? null, null)
}

// ④ 入队后取消 → 队列行跟着终态，提醒不再被扫到
cancelReminder({ db, personaId: 'main', receiver: qq('ct_owner'), reminderId: aId, now: after })
{
  const rowA = getReminder({ db, personaId: 'main', reminderId: aId })
  eq('提醒取消后 status=cancelled', rowA?.status, 'cancelled')
  eq('代次列不受影响', rowA?.access_epoch, 5)
  const rows = outboxRows(db)
  eq('还没发出去的队列行被就地取消', rows[0]?.status, 'cancelled')
  eq('取消原因写到队列行', rows[0]?.last_error_code, 'reminder_cancelled')
}
const h3 = reminderEnqueue({ db, personaId: 'main' })
const third = dispatchDueReminders({ db, personaId: 'main', now: after, enqueueOutbox: h3.callback })
eq('取消后不再入队', third.queued, [])
eq('dueReminders 也拿不到它', dueReminders({ db, personaId: 'main', now: after }).length, 0)

// ⑤ 重启后按 due_at 补扫（同一个库文件重新打开）
db.close()
const again = await openDatabase({ file: join(dir, 'm.sqlite3'), driverPreference: 'auto', logger: quiet })
await migrate(again.db, quiet)
const cRes = createReminder({
  db: again.db, personaId: 'main', receiver: qq('ct_owner'),
  dueAt: '2026-01-01T00:30:00.000Z', timezone: 'Asia/Shanghai',
  text: '重启前登记的提醒', requestId: 'req-dispatch-c', now, accessEpoch: 5,
})
ok('重启后仍能登记', cRes.status === 'created', cRes.status)
const cId = cRes.reminder?.reminder_id ?? ''
const h4 = reminderEnqueue({ db: again.db, personaId: 'main' })
const rebooted = dispatchDueReminders({ db: again.db, personaId: 'main', now: after, enqueueOutbox: h4.callback })
eq('重启后补扫到这条', rebooted.queued.map((q) => q.reminderId), [cId])
eq('新队列行也进了库', outboxRows(again.db).filter((r) => r.reminder_id === cId).length, 1)

// ⑥ 入队回调与状态变更同生共死（第 53 轮外部评审的事务边界）
{
  const now2 = new Date('2026-02-01T00:00:00.000Z')
  const after2 = new Date('2026-02-01T01:00:00.000Z')

  // 6a 历史桌面提醒：回调显式说 skipped，提醒落 failed 而不是假排队
  // （第 57 轮 P1-E 起 createReminder 直接拒绝桌面渠道，历史行由 helper 直接落库）
  const deskId = insertLegacyDesktopReminder({
    db: again.db as never, reminderId: 'rem_legacy_desktop', dueAt: '2026-02-01T00:00:00.000Z',
    text: '桌面提醒', sessionRef: 'desk-1', now: '2026-02-01T00:00:00.000Z', requestId: 'req-desktop',
  })
  const h5 = reminderEnqueue({ db: again.db, personaId: 'main' })
  const deskScan = dispatchDueReminders({ db: again.db, personaId: 'main', now: after2, enqueueOutbox: h5.callback })
  eq('桌面提醒被显式跳过', deskScan.skipped.map((s) => [s.reminderId, s.reason]), [[deskId, 'desktop-channel']])
  eq('跳过不算入队', deskScan.queued, [])
  {
    const row = getReminder({ db: again.db, personaId: 'main', reminderId: deskId })
    eq('桌面提醒落 failed', row?.status, 'failed')
    eq('delivery_state 说明没进队列', row?.delivery_state, 'unsupported')
    eq('delivery_result 记下失败', row?.delivery_result, 'failed')
  }
  eq('桌面提醒没有队列行', outboxRows(again.db).filter((r) => r.reminder_id === deskId).length, 0)

  // 6b 回调抛错：状态变更一起回滚，且只回滚这一条
  const probe2 = createReminder({
    db: again.db, personaId: 'main', receiver: qq('ct_owner'),
    dueAt: '2026-02-01T00:00:00.000Z', timezone: 'Asia/Shanghai',
    text: '会回滚的提醒', requestId: 'req-rollback', now: now2,
  })
  const probe2Id = probe2.reminder?.reminder_id ?? ''
  const before = outboxRows(again.db).length
  const rolledBack = dispatchDueReminders({
    db: again.db, personaId: 'main', now: after2,
    enqueueOutbox: () => { throw new Error('outbox 写失败') },
  })
  eq('抛错不外抛，记成 released', rolledBack.released, 1)
  eq('这一轮没有入队', rolledBack.queued, [])
  eq('outbox 没多写', outboxRows(again.db).length, before)
  {
    const row = getReminder({ db: again.db, personaId: 'main', reminderId: probe2Id })
    eq('回滚后 status 还是 pending', row?.status, 'pending')
    eq('回滚后 delivery_state 还是 unsupported', row?.delivery_state, 'unsupported')
    eq('回滚后没有 delivery_result', row?.delivery_result ?? null, null)
  }

  // 6c 下一轮还能扫到它 —— 说明失败没有被吃掉，也没靠 last_attempt_at 永久排除
  const h6 = reminderEnqueue({ db: again.db, personaId: 'main' })
  const retried = dispatchDueReminders({ db: again.db, personaId: 'main', now: after2, enqueueOutbox: h6.callback })
  eq('下一轮还能扫到它', retried.queued.map((q) => q.reminderId), [probe2Id])
  eq('这次真的进了 outbox', outboxRows(again.db).filter((r) => r.reminder_id === probe2Id).length, 1)
}

again.db.close()
console.log(`[reminder-dispatch] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
