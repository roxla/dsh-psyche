// 第 12 轮评审：QQ 页「待投递提醒」只读视图。
//
// 这一组只锁**展示来源**，因为评审点名的最大风险就是「卡片读错调度来源」：
// 已入队的行必须拿队列行的 `retry_at`（规则变化后由 refreshDeferredReplies 改的正是它），
// 只有还没入队时才退回提醒行的 `next_attempt_at`。两个值不一致时绝不能显示旧的那个。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../packages/core/dist/adapter.js'
import { createReminder } from '../packages/core/dist/reminders.js'
import { QqReplyOutboxStore } from '../packages/core/dist/qq-reply-outbox.js'
import { buildPendingReminders } from '../dist/lib/pending-reminders.js'
import { refreshDeferredReminders, refreshDeferredReplies } from '../packages/core/dist/index.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const dir = mkdtempSync(join(tmpdir(), 'psyche-pending-'))
const opened = await openDatabase({ file: join(dir, 'pending.sqlite3'), driverPreference: 'auto', logger: quiet })
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

const NOW = '2026-03-02T04:00:00.000Z' // 本地 12:00
const at = (minute: number) => new Date(Date.parse(NOW) + minute * 60_000).toISOString()
const NO_WINDOW = '9999-12-31T23:59:59.999Z'
const qq = (contactId: string) => ({ channel: 'qq' as const, contactId })

db.run(
  `INSERT OR IGNORE INTO contacts
     (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
   VALUES ('ct_owner', 'main', 'qq', '90001', '主人', 'owner', ?, ?)`,
  [NOW, NOW],
)

const mk = (requestId: string, dueAt: string) => {
  const created = createReminder({
    db, personaId: 'main', receiver: qq('ct_owner'), dueAt,
    timezone: 'Asia/Shanghai', text: requestId, requestId, now: NOW, accessEpoch: 5,
  })
  return created.reminder?.reminder_id ?? ''
}
const store = new QqReplyOutboxStore({ db, ownerId: 'owner', now: () => NOW, nextAllowedAt: () => at(120) })

console.log('[P1] 未入队：读提醒行的 next_attempt_at')
{
  const id = mk('req-p1-wait', at(30))
  ok('P1 提醒已登记', id !== '')
  // 先有延后标记（真实路径里由 dispatchDueReminders 写），再看卡片读什么。
  db.run('UPDATE reminders SET next_attempt_at = ? WHERE reminder_id = ?', [at(30), id])
  refreshDeferredReminders({
    db: db as never, personaId: 'main', now: at(1),
    plan: () => ({ kind: 'wait', until: at(90) }),
  })
  const view = buildPendingReminders({ db: db as never, personaId: 'main' })
  const item = view.items.find((x) => x.reminderId === id)
  eq('P1 未入队显示提醒行的下一次可试时刻', item?.scheduledAt, at(90))
  eq('P1 状态是已延后', item?.state, 'waiting')
  eq('P1 原定时间原样显示', item?.dueAt, at(30))

  const dueId = mk('req-p1-due', at(10))
  const dueItem = buildPendingReminders({ db: db as never, personaId: 'main' })
    .items.find((x) => x.reminderId === dueId)
  eq('P1 没有延后标记时是「到点就发」', dueItem?.state, 'due')
  eq('P1 到点就发没有预计时间', dueItem?.scheduledAt, null)

  refreshDeferredReminders({
    db: db as never, personaId: 'main', now: at(2),
    plan: () => ({ kind: 'wait', until: NO_WINDOW }),
  })
  const pausedItem = buildPendingReminders({ db: db as never, personaId: 'main' })
    .items.find((x) => x.reminderId === id)
  eq('P1 暂停时不把占位时刻当预计时间', pausedItem?.scheduledAt, null)
  eq('P1 暂停状态是 paused', pausedItem?.state, 'paused')
  eq('P1 暂停仍显示原定时间', pausedItem?.dueAt, at(30))
}

console.log('[P2] 已入队：必须读队列行的 retry_at，不能读提醒行')
{
  const id = mk('req-p2-queued', at(30))
  // 入队（模拟派发成功后提醒行的样子：delivery_state 变 pending）。
  const enqueued = store.enqueue({
    personaId: 'main', contactId: 'ct_owner', stableUserId: '90001',
    sessionId: 'qq-private-90001', sessionSeq: 900, transportId: 'probe-transport',
    payloadText: '提醒内容', ttlMs: 60 * 60 * 1000, now: at(1), accessEpoch: 5, reminderId: id,
  })
  db.run("UPDATE reminders SET delivery_state = 'pending' WHERE reminder_id = ?", [id])
  // 提醒行留一个**旧**的 next_attempt_at，队列行是新时刻：显示必须跟队列行走。
  db.run('UPDATE reminders SET next_attempt_at = ? WHERE reminder_id = ?', [at(30), id])

  const deferred = store.claim({
    limit: 1,
    authorization: () => 'outside-reply-window',
    transportCheck: () => true,
    now: at(2),
  })
  eq('P2 领取时被延后（不是取消）', deferred.length, 0)
  const row = db.get<{ retry_at: string | null }>(
    'SELECT retry_at FROM qq_reply_outbox WHERE reply_id = ?', [enqueued.row.replyId],
  )
  eq('P2 队列行 retry_at 是新窗口', row?.retry_at, at(120))

  const item = buildPendingReminders({ db: db as never, personaId: 'main' })
    .items.find((x) => x.reminderId === id)
  eq('P2 已入队显示队列行的 retry_at', item?.scheduledAt, at(120))
  ok('P2 没有把提醒行的旧时刻显示出来', item?.scheduledAt !== at(30), item)
  eq('P2 状态是已延后', item?.state, 'waiting')

  // 规则再改早：refresh 把 retry_at 清空 → 卡片说「已排队」，不再给旧预计时间。
  refreshDeferredReplies({ db: db as never, now: at(3), plan: () => ({ kind: 'open' }) })
  const nowItem = buildPendingReminders({ db: db as never, personaId: 'main' })
    .items.find((x) => x.reminderId === id)
  eq('P2 窗口开着的已入队行没有预计时间', nowItem?.scheduledAt, null)
  eq('P2 窗口开着的已入队行是 queued', nowItem?.state, 'queued')

  // 暂停：先把这一行重新延后（真实路径里下一次领取会这样写），再让规则暂停。
  db.run("UPDATE reminders SET delivery_state = 'pending' WHERE reminder_id = ?", [id])
  store.claim({
    limit: 1,
    authorization: () => 'outside-reply-window',
    transportCheck: () => true,
    now: at(3),
  })
  refreshDeferredReplies({ db: db as never, now: at(4), plan: () => ({ kind: 'wait', until: NO_WINDOW }) })
  const pausedItem = buildPendingReminders({ db: db as never, personaId: 'main' })
    .items.find((x) => x.reminderId === id)
  eq('P2 暂停时已入队行也说暂无时段', pausedItem?.scheduledAt, null)
  eq('P2 暂停时已入队行是 paused', pausedItem?.state, 'paused')
  eq('P2 暂停时仍显示原定时间', pausedItem?.dueAt, at(30))

  db.run('DELETE FROM qq_reply_outbox WHERE reminder_id = ?', [id])
}

console.log('[P3] 上限与总数')
{
  const view = buildPendingReminders({ db: db as never, personaId: 'main', limit: 1 })
  ok('P3 limit 生效', view.items.length <= 1, view.items.length)
  ok('P3 总数不受 limit 影响', view.total >= view.items.length, view)
  const many = buildPendingReminders({ db: db as never, personaId: 'main', limit: 999 })
  ok('P3 limit 上限被夹住', many.items.length <= 20, many.items.length)
  const zero = buildPendingReminders({ db: db as never, personaId: 'main', limit: 0 })
  ok('P3 limit 下限被夹住', zero.items.length >= 1, zero.items.length)
  eq('P3 只读：查询后仍没有队列行被改写',
    db.all("SELECT reply_id FROM qq_reply_outbox WHERE status = 'cancelled'").length, 0)
}

console.log('[P4] unknown 不展示也不计数（第 13 轮）')
{
  const visibleBefore = buildPendingReminders({ db: db as never, personaId: 'main' }).total
  const id = mk('req-p4-unknown', at(40))
  const enqueued = store.enqueue({
    personaId: 'main', contactId: 'ct_owner', stableUserId: '90001',
    sessionId: 'qq-private-90001', sessionSeq: 990, transportId: 'probe-transport',
    payloadText: 'unknown 提醒', ttlMs: 60 * 60 * 1000, now: at(1), accessEpoch: 5, reminderId: id,
  })
  db.run("UPDATE reminders SET delivery_state = 'pending' WHERE reminder_id = ?", [id])
  store.claim({ limit: 1, authorization: () => null, transportCheck: () => true, now: at(2) })
  store.applyResult(enqueued.row.replyId, { outcome: 'unknown', errorCode: 'ack_timeout' }, at(3))
  const triple = db.get<{ status: string; delivery_state: string; delivery_result: string | null }>(
    'SELECT status, delivery_state, delivery_result FROM reminders WHERE reminder_id = ?', [id],
  )
  eq('P4 提醒落 pending/unknown/unknown', [triple?.status, triple?.delivery_state, triple?.delivery_result],
    ['pending', 'unknown', 'unknown'])

  const view = buildPendingReminders({ db: db as never, personaId: 'main', limit: 20 })
  ok('P4 unknown 不出现在卡片里', view.items.every((x) => x.reminderId !== id), view.items.map((x) => x.reminderId))
  eq('P4 unknown 不计入 total', view.total, visibleBefore)
}

console.log('[P5] 待裁决计数（P1-C 第 15 轮）')
{
  const before = buildPendingReminders({ db: db as never, personaId: 'main' })
  ok('P5 当前有 1 条待裁决', before.awaitingVerdict === 1, before.awaitingVerdict)
  // 这里只验「卡片视图怎么数」，状态机怎么进 unknown 由 test/reminder-p1c.ts 锁；
  // 直接写库是为了绕开「同联系人的 unknown 行会阻塞领取」这条既有行为（P1-A A10）。
  const id = mk('req-p5-unknown', at(45))
  store.enqueue({
    personaId: 'main', contactId: 'ct_owner', stableUserId: '90001',
    sessionId: 'qq-private-90001', sessionSeq: 991, transportId: 'probe-transport',
    payloadText: '第二条 unknown', ttlMs: 60 * 60 * 1000, now: at(1), accessEpoch: 5, reminderId: id,
  })
  db.run(
    "UPDATE reminders SET delivery_state = 'unknown', delivery_result = 'unknown' WHERE reminder_id = ?",
    [id],
  )
  const after = buildPendingReminders({ db: db as never, personaId: 'main' })
  eq('P5 计数跟着加一条', after.awaitingVerdict, before.awaitingVerdict + 1)
  eq('P5 待裁决项不进 total', after.total, before.total)
  ok('P5 待裁决项也不在 items 里', after.items.every((x) => x.reminderId !== id), after.items.length)
}

db.close()
console.log(`\n[pending-reminders] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
