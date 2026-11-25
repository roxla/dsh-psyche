// v29.26：提醒登记（G5 第一批）。
//
// 用户说「十分钟后提醒我喝水」时，心灵之前**没有任何入口**——真机实测
// 子代理只能去调宿主的 schedule_create，被 `subagent_session` 拒掉，
// `proactive_outbox` 一直是 0 行。
//
// 这批只做登记 / 查询 / 取消，**不做派发**。所以判据也只有三条：
//   ① 同一请求重放返回同一个 reminderId，表里只有一行；
//   ② 接收者认不出来就拒绝登记（不兜底记到 Owner 名下），零写入；
//   ③ 取消可重放；别人拿同一个 ID 取消不了；已发出的不能被「撤销」。
//
// 另外验一句产品口径：登记成功时 delivery_state 必须是 unsupported——
// 界面据此显示「已登记，自动发送尚未启用」，不能让用户以为手机会响。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '../packages/core/dist/adapter.js'
import {
  cancelReminder,
  createReminder,
  dueReminders,
  getReminder,
  listReminders,
  markReminderFired,
  type ReminderReceiver,
} from '../packages/core/dist/reminders.js'

let passed = 0
const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const NOW = '2026-02-01T09:00:00.000Z'
const DUE = '2026-02-01T09:10:00.000Z'
const logger = { debug() {}, info() {}, warn() {}, error() {} }

const DESKTOP_A: ReminderReceiver = { channel: 'desktop', sessionRef: 'session-aaa' }
const DESKTOP_B: ReminderReceiver = { channel: 'desktop', sessionRef: 'session-bbb' }
const QQ_A: ReminderReceiver = { channel: 'qq', contactId: 'ct_a' }
const QQ_B: ReminderReceiver = { channel: 'qq', contactId: 'ct_b' }

interface Fixture {
  dir: string
  db: Awaited<ReturnType<typeof openDatabase>>['db']
  close: () => void
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-reminders-'))
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger })
  migrate(opened.db, logger)
  opened.db.run(
    "INSERT INTO contacts (contact_id, persona_id, platform, stable_user_id, display_name, created_at, updated_at) " +
      "VALUES ('ct_a', 'main', 'qq', 'u_a', 'A', ?, ?), ('ct_b', 'main', 'qq', 'u_b', 'B', ?, ?)",
    [NOW, NOW, NOW, NOW],
  )
  return {
    dir,
    db: opened.db,
    close: () => {
      opened.db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const fixture = await setup()
const db = fixture.db as never

await test('登记成功：写一行，派发状态如实记 unsupported', () => {
  const result = createReminder({
    db,
    personaId: 'main',
    receiver: QQ_A,
    dueAt: DUE,
    timezone: 'Asia/Shanghai',
    text: '喝水',
    requestId: 'req-1',
    now: NOW,
  })
  assert.equal(result.status, 'created')
  assert.equal(result.reminder?.status, 'pending')
  // 派发没实现就不能记 pending，否则界面会假装「快到了」。
  assert.equal(result.reminder?.delivery_state, 'unsupported')
  const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reminders')
  assert.equal(count?.n, 1)
})

await test('同一请求重放：返回同一个 ID，表里仍然一行', () => {
  const again = createReminder({
    db,
    personaId: 'main',
    receiver: QQ_A,
    dueAt: DUE,
    timezone: 'Asia/Shanghai',
    text: '喝水',
    requestId: 'req-1',
    now: '2026-02-01T09:01:00.000Z',
  })
  assert.equal(again.status, 'replayed')
  assert.equal(again.reminder?.request_id, 'req-1')
  const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reminders')
  assert.equal(count?.n, 1)
})

await test('接收者认不出来：拒绝登记，零写入', () => {
  const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reminders')?.n ?? 0
  const noRef = createReminder({
    db,
    personaId: 'main',
    receiver: { channel: 'desktop', sessionRef: null },
    dueAt: DUE,
    timezone: 'Asia/Shanghai',
    text: '喝水',
    requestId: 'req-2',
    now: NOW,
  })
  assert.equal(noRef.status, 'no-receiver')
  const noContact = createReminder({
    db,
    personaId: 'main',
    receiver: { channel: 'qq', contactId: '' },
    dueAt: DUE,
    timezone: 'Asia/Shanghai',
    text: '喝水',
    requestId: 'req-3',
    now: NOW,
  })
  assert.equal(noContact.status, 'no-receiver')
  const after = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reminders')?.n ?? 0
  assert.equal(after, before)
})

await test('到期时间格式与空内容各自拒绝，且不写库', () => {
  const badDue = createReminder({
    db,
    personaId: 'main',
    receiver: DESKTOP_A,
    dueAt: '十分钟后',
    timezone: 'Asia/Shanghai',
    text: '喝水',
    requestId: 'req-4',
    now: NOW,
  })
  assert.equal(badDue.status, 'bad-due')
  const empty = createReminder({
    db,
    personaId: 'main',
    receiver: DESKTOP_A,
    dueAt: DUE,
    timezone: 'Asia/Shanghai',
    text: '   ',
    requestId: 'req-5',
    now: NOW,
  })
  assert.equal(empty.status, 'empty-text')
  const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reminders')
  assert.equal(count?.n, 1)
})

await test('列表按接收者隔离：别人的提醒看不见', () => {
  // B 自己登记一条（注：桌面渠道自第 57 轮 P1-E 起会被拒，这里用两个 QQ 联系人表达同样的隔离语义）。
  createReminder({
    db,
    personaId: 'main',
    receiver: QQ_B,
    dueAt: DUE,
    timezone: 'Asia/Shanghai',
    text: '交房租',
    requestId: 'req-b1',
    now: NOW,
  })
  const aList = listReminders({ db, personaId: 'main', receiver: QQ_A })
  assert.equal(aList.length, 1)
  assert.equal(aList[0]?.text, '喝水')
  const bList = listReminders({ db, personaId: 'main', receiver: QQ_B })
  assert.equal(bList.length, 1)
  assert.equal(bList[0]?.text, '交房租')
  // 桌面侧完全独立：QQ 登记的东西不该出现在桌面列表里。
  assert.equal(listReminders({ db, personaId: 'main', receiver: DESKTOP_A }).length, 0)
})

await test('P1-E：桌面提醒在登记入口就被拒，零写入', () => {
  const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reminders')?.n ?? 0
  const result = createReminder({
    db,
    personaId: 'main',
    receiver: DESKTOP_A,
    dueAt: DUE,
    timezone: 'Asia/Shanghai',
    text: '桌面提醒',
    requestId: 'req-desktop-rejected',
    now: NOW,
  })
  assert.equal(result.status, 'unsupported-channel')
  assert.equal(result.reason, '当前不支持桌面自动提醒，本次未登记')
  assert.equal(result.reminder, undefined)
  const after = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reminders')?.n ?? 0
  assert.equal(after, before)
})

await test('取消可重放；别人取消不了；已发出状态不被改写', () => {
  const created = createReminder({
    db,
    personaId: 'main',
    receiver: QQ_A,
    dueAt: DUE,
    timezone: 'Asia/Shanghai',
    text: '买牛奶',
    requestId: 'req-qq1',
    now: NOW,
  })
  assert.equal(created.status, 'created')
  const id = created.reminder?.reminder_id ?? ''

  // 别人拿同一个 ID 取消：拒绝，且状态不变。
  const foreign = cancelReminder({ db, personaId: 'main', reminderId: id, receiver: QQ_B, now: NOW })
  assert.equal(foreign.status, 'no-permission')
  assert.equal(getReminder({ db, personaId: 'main', reminderId: id })?.status, 'pending')

  const cancelled = cancelReminder({ db, personaId: 'main', reminderId: id, receiver: QQ_A, now: NOW })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.reminder?.status, 'cancelled')
  // 重放：返回同一行，不报错、不再改 updated_at。
  const replay = cancelReminder({
    db,
    personaId: 'main',
    reminderId: id,
    receiver: QQ_A,
    now: '2026-02-01T09:05:00.000Z',
  })
  assert.equal(replay.status, 'replayed')
  assert.equal(replay.reminder?.status, 'cancelled')

  // 已发出的提醒不能取消：状态原样返回，不假装撤销成功。
  const fired = createReminder({
    db,
    personaId: 'main',
    receiver: QQ_A,
    dueAt: DUE,
    timezone: 'Asia/Shanghai',
    text: '做饭',
    requestId: 'req-qq2',
    now: NOW,
  })
  const firedId = fired.reminder?.reminder_id ?? ''
  db.run("UPDATE reminders SET status = 'fired', fired_at = ? WHERE reminder_id = ?", [DUE, firedId])
  const tooLate = cancelReminder({ db, personaId: 'main', reminderId: firedId, receiver: QQ_A, now: NOW })
  assert.equal(tooLate.status, 'replayed')
  assert.equal(getReminder({ db, personaId: 'main', reminderId: firedId })?.status, 'fired')

  // 不存在的 ID：not-found，不是 no-permission。
  const missing = cancelReminder({ db, personaId: 'main', reminderId: 'rem_nope', receiver: QQ_A, now: NOW })
  assert.equal(missing.status, 'not-found')
})

await test('到期扫描只取未发且已到点的行，两个派发者只有一个能标记成功', () => {
  const nowDate = new Date(NOW)
  const later = new Date(nowDate.getTime() + 60 * 60_000)
  const created = createReminder({
    db,
    personaId: 'main',
    receiver: QQ_A,
    dueAt: new Date(nowDate.getTime() + 5 * 60_000).toISOString(),
    timezone: 'Asia/Shanghai',
    text: '五分钟后提醒喝水',
    requestId: 'req_due_1',
    now: nowDate,
  })
  assert.equal(created.status, 'created')
  const reminderId = created.reminder?.reminder_id ?? ''

  // 还没到点，扫不到。
  assert.equal(dueReminders({ db, personaId: 'main', now: nowDate }).some((r) => r.reminder_id === reminderId), false)
  // 到点了，能被扫到（前面用例可能还留着未到期或已发出的行，所以只认这一条）。
  const due = dueReminders({ db, personaId: 'main', now: later })
  assert.equal(due.some((r) => r.reminder_id === reminderId), true)

  // 两个派发者同时扫到同一行，只有一个能把状态改成 fired。
  const first = markReminderFired({ db, personaId: 'main', reminderId, now: later, deliveryState: 'pending' })
  const second = markReminderFired({ db, personaId: 'main', reminderId, now: later, deliveryState: 'pending' })
  assert.equal(first, true)
  assert.equal(second, false)
  assert.equal(getReminder({ db, personaId: 'main', reminderId })?.status, 'fired')
  // 发出去之后不该再被扫到。
  assert.equal(dueReminders({ db, personaId: 'main', now: later }).some((r) => r.reminder_id === reminderId), false)
})

fixture.close()
console.log(`${passed} 通过 0 失败`)
