// P1-B 行为锁（第 56 轮外部评审：提醒撞上「允许回复时段」不许判死）。
//
// 分三组：
//   ① 窗口算术：`nextAllowedReplyAt` 必须和 `inReplyWindow` 用同一套口径；
//   ② 入队前延后：到点但窗外 → 只记 `next_attempt_at`，不写 outbox、不动状态；
//   ③ 入队后延后：领取时窗外 / 发送前刚关窗 → 队列行放回 pending，本次零发送；
//      而撤权、取消这类「确定不该发」的路径仍然失败关闭，不许被延后逻辑吞掉。
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
  refreshDeferredReminders,
} from '../packages/core/dist/reminders.js'
import { QqReplyOutboxStore, refreshDeferredReplies } from '../packages/core/dist/qq-reply-outbox.js'
import { QqReplyWorker } from '../packages/core/dist/qq-reply-worker.js'
import { MockChatTransport } from '../packages/core/dist/chat-transport.js'
import { inReplyWindow, nextAllowedReplyAt } from '../dist/lib/qq-reply-window.js'
import { NO_REPLY_WINDOW_AT, createReminderDelivery } from '../dist/lib/reminder-delivery.js'
import { deferredNote } from '../dist/lib/tools.js'
import { enqueueReminderReply } from '../packages/core/dist/reminder-outbox.js'
import type { QqReplyOutboxRow } from '../packages/core/dist/qq-reply-outbox.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const dir = mkdtempSync(join(tmpdir(), 'psyche-p1b-'))
const opened = await openDatabase({ file: join(dir, 'p1b.sqlite3'), driverPreference: 'auto', logger: quiet })
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

// 固定时钟：2026-03-02 是周一，本地时区 Asia/Shanghai。
const NOW = '2026-03-02T04:00:00.000Z' // 本地 12:00
const NOW_DATE = new Date(NOW)
const at = (minute: number) => new Date(NOW_DATE.getTime() + minute * 60_000).toISOString()
const qq = (contactId: string) => ({ channel: 'qq' as const, contactId })

db.run(
  `INSERT OR IGNORE INTO contacts
     (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
   VALUES ('ct_owner', 'main', 'qq', '90001', '主人', 'owner', ?, ?)`,
  [NOW, NOW],
)

// ── ① 窗口算术 ───────────────────────────────────────────────────────
console.log('[B1] nextAllowedReplyAt')
{
  const noonTo13 = {
    mode: 'windows' as const,
    timeZone: 'Asia/Shanghai',
    windows: [{ days: [1, 2, 3, 4, 5, 6, 7], startMinute: 12 * 60, endMinute: 13 * 60 }],
  }
  eq('B1 没有规则 = 现在就能发', nextAllowedReplyAt(undefined, new Date(NOW))?.toISOString(), NOW)
  eq('B1 窗内直接返回当前时刻', nextAllowedReplyAt(noonTo13, new Date(NOW))?.toISOString(), NOW)
  eq('B1 窗外返回下一个起点',
    nextAllowedReplyAt(noonTo13, new Date(at(60)))?.toISOString(), // 13:00，窗口刚关
    at(24 * 60))
  eq('B1 暂停没有下一个窗口',
    nextAllowedReplyAt({ mode: 'paused', timeZone: 'Asia/Shanghai', windows: [] }, new Date(NOW)),
    null)

  const overnight = {
    mode: 'windows' as const,
    timeZone: 'Asia/Shanghai',
    windows: [{ days: [1, 2, 3, 4, 5, 6, 7], startMinute: 22 * 60, endMinute: 6 * 60 }],
  }
  // 本地 23:00 在跨夜窗内
  const night = new Date('2026-03-02T15:00:00.000Z')
  eq('B1 跨夜窗内放行', inReplyWindow(overnight, night), true)
  eq('B1 跨夜窗内返回当前时刻', nextAllowedReplyAt(overnight, night)?.toISOString(), night.toISOString())
  // 本地 12:00 在跨夜窗外 → 当天 22:00
  eq('B1 跨夜窗外返回当天 22:00', nextAllowedReplyAt(overnight, new Date(NOW))?.toISOString(),
    new Date('2026-03-02T14:00:00.000Z').toISOString())
  // 两处口径必须一致：算出来的时刻一定在窗内
  const candidate = nextAllowedReplyAt(overnight, new Date(NOW))
  ok('B1 算出来的时刻确实在窗内', candidate !== null && inReplyWindow(overnight, candidate))
}

// ── ② 入队前延后 ─────────────────────────────────────────────────────
console.log('[B2] 到点但窗外：延后而不是判死')
{
  const created = createReminder({
    db, personaId: 'main', receiver: qq('ct_owner'), dueAt: at(0),
    timezone: 'Asia/Shanghai', text: '窗外提醒', requestId: 'req-b2', now: NOW, accessEpoch: 5,
  })
  const id = created.reminder?.reminder_id ?? ''
  const until = at(360)
  const scanned = dispatchDueReminders({
    db, personaId: 'main', now: new Date(at(1)), channels: ['qq'],
    enqueueOutbox: () => { throw new Error('窗外不该入队') },
    deferUntil: () => until,
  })
  eq('B2 记成延后', scanned.deferred, [{ reminderId: id, until }])
  eq('B2 没有入队', scanned.queued, [])
  eq('B2 三个字段仍是 pending/unsupported/NULL',
    [getReminder({ db, personaId: 'main', reminderId: id })?.status,
      getReminder({ db, personaId: 'main', reminderId: id })?.delivery_state,
      getReminder({ db, personaId: 'main', reminderId: id })?.delivery_result],
    ['pending', 'unsupported', null])
  eq('B2 due_at 没被改写', getReminder({ db, personaId: 'main', reminderId: id })?.due_at, at(0))
  eq('B2 next_attempt_at 记下了',
    getReminder({ db, personaId: 'main', reminderId: id })?.next_attempt_at, until)
  eq('B2 没有队列行',
    db.all('SELECT reply_id FROM qq_reply_outbox WHERE reminder_id = ?', [id]).length, 0)
  ok('B2 未到可试时刻不再进候选',
    !dueReminders({ db, personaId: 'main', now: new Date(at(2)) }).some((r) => r.reminder_id === id))
  ok('B2 到了可试时刻重新进候选',
    dueReminders({ db, personaId: 'main', now: new Date(at(361)) }).some((r) => r.reminder_id === id))

  // 时间到、窗口开了：正常入队，且延后标记被清掉
  const enqueued = dispatchDueReminders({
    db, personaId: 'main', now: new Date(at(361)), channels: ['qq'],
    enqueueOutbox: () => ({ kind: 'skipped', reason: 'missing-stable-id' }),
    deferUntil: () => null,
  })
  eq('B2 窗口开了照常处理', enqueued.skipped.map((s) => s.reminderId), [id])
  eq('B2 终态清掉 next_attempt_at',
    getReminder({ db, personaId: 'main', reminderId: id })?.next_attempt_at, null)
  cancelReminder({ db, personaId: 'main', reminderId: id, receiver: qq('ct_owner'), now: new Date(at(2)) })
}

// ── ③ 入队后延后 ─────────────────────────────────────────────────────
console.log('[B3] 入队后遇到窗外：队列行放回 pending')
{
  let windowUntil: string | null = null
  const store = new QqReplyOutboxStore({
    db, ownerId: 'owner', now: () => at(5),
    nextAllowedAt: (_row: QqReplyOutboxRow) => windowUntil,
  })
  const created = createReminder({
    db, personaId: 'main', receiver: qq('ct_owner'), dueAt: at(0),
    timezone: 'Asia/Shanghai', text: '入队后窗外', requestId: 'req-b3', now: NOW, accessEpoch: 5,
  })
  const id = created.reminder?.reminder_id ?? ''
  const enqueued = store.enqueue({
    personaId: 'main', contactId: 'ct_owner', stableUserId: '90001',
    sessionId: 'qq-private-90001', sessionSeq: 900, transportId: 'probe-transport',
    payloadText: '提醒正文', now: at(1), reminderId: id, accessEpoch: 5,
  })
  const replyId = enqueued.row.replyId
  db.run(`UPDATE reminders SET delivery_state = 'pending' WHERE reminder_id = ?`, [id])

  const until = at(60)
  windowUntil = until
  const claimed = store.claim({
    limit: 5,
    authorization: () => 'outside-reply-window',
    transportCheck: () => true,
    now: at(2),
  })
  eq('B3 窗外不领取', claimed, [])
  const after = store.get(replyId)
  eq('B3 队列行仍是 pending', after?.status, 'pending')
  eq('B3 retry_at 推到下一个窗口', after?.retryAt, until)
  eq('B3 提醒没被判死',
    [getReminder({ db, personaId: 'main', reminderId: id })?.status,
      getReminder({ db, personaId: 'main', reminderId: id })?.delivery_state],
    ['pending', 'pending'])
  ok('B3 expires_at 一起推后（否则会被判过期）',
    (after?.expiresAt ?? '') >= until)

  // 窗口开：正常领取并发送
  windowUntil = null
  const claimed2 = store.claim({ limit: 5, authorization: () => null, transportCheck: () => true, now: at(61) })
  eq('B3 窗口开了能领到', claimed2.map((r) => r.replyId), [replyId])
  eq('B3 领取后是 dispatching', store.get(replyId)?.status, 'dispatching')

  // ── B4：领取时窗内、发送前刚关窗 ──
  windowUntil = at(120)
  const blocked = store.recheckForSend(replyId, at(62))
  eq('B4 发送前关窗 → 停发', blocked, 'outside-reply-window')
  const reverted = store.get(replyId)
  eq('B4 队列行放回 pending', reverted?.status, 'pending')
  eq('B4 队列行没被取消', reverted?.lastErrorCode ?? null, null)
  eq('B4 retry_at 推到下一个窗口', reverted?.retryAt, at(120))
  eq('B4 提醒仍是 pending/pending',
    [getReminder({ db, personaId: 'main', reminderId: id })?.status,
      getReminder({ db, personaId: 'main', reminderId: id })?.delivery_state],
    ['pending', 'pending'])

  // ── B5：等窗口期间撤权，窗口开了也必须失败关闭 ──
  windowUntil = null
  const cancelled = store.claim({
    limit: 5,
    authorization: () => 'access-superseded',
    transportCheck: () => true,
    now: at(121),
  })
  eq('B5 撤权后不领取', cancelled, [])
  eq('B5 队列行被取消', store.get(replyId)?.lastErrorCode, 'access-superseded')
  eq('B5 提醒失败关闭',
    [getReminder({ db, personaId: 'main', reminderId: id })?.status,
      getReminder({ db, personaId: 'main', reminderId: id })?.delivery_state,
      getReminder({ db, personaId: 'main', reminderId: id })?.delivery_result],
    ['failed', 'unsupported', 'failed'])
  db.run('DELETE FROM qq_reply_outbox WHERE reminder_id = ?', [id])
}

console.log('[B6] 等窗口期间取消：零发送')
{
  let windowUntil: string | null = null
  const store = new QqReplyOutboxStore({
    db, ownerId: 'owner', now: () => at(5),
    nextAllowedAt: () => windowUntil,
  })
  const created = createReminder({
    db, personaId: 'main', receiver: qq('ct_owner'), dueAt: at(0),
    timezone: 'Asia/Shanghai', text: '等待期间取消', requestId: 'req-b6', now: NOW, accessEpoch: 5,
  })
  const id = created.reminder?.reminder_id ?? ''
  const enqueued = store.enqueue({
    personaId: 'main', contactId: 'ct_owner', stableUserId: '90001',
    sessionId: 'qq-private-90001', sessionSeq: 901, transportId: 'probe-transport',
    payloadText: '提醒正文', now: at(1), reminderId: id, accessEpoch: 5,
  })
  const replyId = enqueued.row.replyId
  db.run(`UPDATE reminders SET delivery_state = 'pending' WHERE reminder_id = ?`, [id])
  windowUntil = at(300)
  store.claim({ limit: 5, authorization: () => 'outside-reply-window', transportCheck: () => true, now: at(2) })

  const cancelled = cancelReminder({ db, personaId: 'main', reminderId: id, receiver: qq('ct_owner'), now: at(3) })
  eq('B6 取消成功', cancelled.status, 'cancelled')
  eq('B6 提醒落 cancelled/unsupported/NULL',
    [getReminder({ db, personaId: 'main', reminderId: id })?.status,
      getReminder({ db, personaId: 'main', reminderId: id })?.delivery_state,
      getReminder({ db, personaId: 'main', reminderId: id })?.delivery_result],
    ['cancelled', 'unsupported', null])
  eq('B6 队列行跟着取消', store.get(replyId)?.lastErrorCode, 'reminder_cancelled')
  windowUntil = null
  eq('B6 窗口开了也领不到', store.claim({
    limit: 5, authorization: () => null, transportCheck: () => true, now: at(400),
  }), [])
  db.run('DELETE FROM qq_reply_outbox WHERE reminder_id = ?', [id])
}

console.log('[B7] Worker 入口：窗外零发送')
{
  let windowUntil = at(240)
  const store = new QqReplyOutboxStore({
    db, ownerId: 'owner', now: () => at(5),
    nextAllowedAt: () => windowUntil,
  })
  const created = createReminder({
    db, personaId: 'main', receiver: qq('ct_owner'), dueAt: at(0),
    timezone: 'Asia/Shanghai', text: 'Worker 窗外', requestId: 'req-b7', now: NOW, accessEpoch: 5,
  })
  const id = created.reminder?.reminder_id ?? ''
  const enqueued = store.enqueue({
    personaId: 'main', contactId: 'ct_owner', stableUserId: '90001',
    sessionId: 'qq-private-90001', sessionSeq: 902, transportId: 'probe-transport',
    payloadText: '提醒正文', now: at(1), reminderId: id, accessEpoch: 5,
  })
  db.run(`UPDATE reminders SET delivery_state = 'pending' WHERE reminder_id = ?`, [id])
  const transport = new MockChatTransport({ id: 'probe-transport', platform: 'qq' })
  const worker = new QqReplyWorker({
    store,
    transport,
    targetOf: (row) => ({ kind: 'private', platform: row.platform, stableUserId: row.stableUserId }),
    now: () => at(5),
    authorization: () => 'outside-reply-window',
    logger: { warn() {} },
  })
  worker.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  await worker.stop()
  eq('B7 窗外零发送', transport.sends.length, 0)
  const row = store.get(enqueued.row.replyId)
  eq('B7 队列行仍是 pending', row?.status, 'pending')
  eq('B7 提醒仍是 pending/pending',
    [getReminder({ db, personaId: 'main', reminderId: id })?.status,
      getReminder({ db, personaId: 'main', reminderId: id })?.delivery_state],
    ['pending', 'pending'])
  windowUntil = null
  cancelReminder({ db, personaId: 'main', reminderId: id, receiver: qq('ct_owner'), now: at(6) })
  db.run('DELETE FROM qq_reply_outbox WHERE reminder_id = ?', [id])
}

// ── ⑧ 规则变更 / 暂停：下一轮扫描必须触及被旧时刻过滤的行 ───────────────
console.log('[B8] 规则变更与暂停（第 9 轮第 4 条）')
{
  // 可控时钟 + 可控窗口：`plan` 换成什么，下一轮 tick 就必须按它重算。
  let clock = at(0)
  let plan: 'open' | 'paused' | { until: string } = { until: at(60) }
  const bridge = {
    transportId: 'probe-transport',
    accessEpochOf: () => 5,
    nextPrivateSendAt: () => {
      if (plan === 'open') return null
      if (plan === 'paused') return 'paused' as const
      return new Date(plan.until)
    },
  }
  const store = new QqReplyOutboxStore({
    db,
    ownerId: 'owner',
    now: () => clock,
    nextAllowedAt: () => {
      if (plan === 'open' || plan === 'paused') return null
      return plan.until
    },
  })
  const delivery = createReminderDelivery({
    db,
    personaId: 'main',
    ownerId: 'owner',
    bridge: () => bridge,
    now: () => new Date(clock),
    enqueue: (input) => {
      const enqueued = enqueueReminderReply({
        db: input.db as never,
        ownerId: input.ownerId,
        personaId: input.personaId,
        reminder: input.reminder,
        transportId: input.transportId,
        now: input.now,
        accessEpoch: input.accessEpoch,
      })
      return { replyId: enqueued.replyId }
    },
  })

  const created = createReminder({
    db, personaId: 'main', receiver: qq('ct_owner'), dueAt: at(0),
    timezone: 'Asia/Shanghai', text: '规则变更', requestId: 'req-b8', now: NOW, accessEpoch: 5,
  })
  const id = created.reminder?.reminder_id ?? ''

  // C1 规则改早：原先算到 at(60)，规则改成现在就能发 → 下一轮立刻入队。
  await delivery.tick()
  eq('B8 先按旧规则延后到 at(60)',
    getReminder({ db, personaId: 'main', reminderId: id })?.next_attempt_at, at(60))
  plan = 'open'
  clock = at(1)
  await delivery.tick()
  eq('B8 规则改早后这一轮就入队',
    delivery.lastReport().queued.map((q) => q.reminderId), [id])
  const queuedRow = db.get<{ reply_id: string }>(
    'SELECT reply_id FROM qq_reply_outbox WHERE reminder_id = ?', [id],
  )
  ok('B8 队列行已生成', typeof queuedRow?.reply_id === 'string')

  // C2 窗口开了：从正常 Worker 入口只发一次，再跑一轮仍是一次。
  const transport = new MockChatTransport({ id: 'probe-transport', platform: 'qq' })
  const worker = new QqReplyWorker({
    store,
    transport,
    targetOf: (row) => ({ kind: 'private', platform: row.platform, stableUserId: row.stableUserId }),
    now: () => clock,
    authorization: () => null,
    logger: { warn() {} },
  })
  worker.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  await worker.stop()
  eq('B8 开窗后发一次', transport.sends.length, 1)
  eq('B8 提醒落 fired/sent/sent',
    [getReminder({ db, personaId: 'main', reminderId: id })?.status,
      getReminder({ db, personaId: 'main', reminderId: id })?.delivery_state,
      getReminder({ db, personaId: 'main', reminderId: id })?.delivery_result],
    ['fired', 'sent', 'sent'])
  worker.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  await worker.stop()
  eq('B8 再跑一轮仍是 1 次', transport.sends.length, 1)
  db.run('DELETE FROM qq_reply_outbox WHERE reminder_id = ?', [id])
}

{
  // C3 暂停：保持等待、跨过原 TTL 也不判死、不逐轮空转。
  let clock = at(0)
  let plan: 'open' | 'paused' | { until: string } = 'paused'
  const bridge = {
    transportId: 'probe-transport',
    accessEpochOf: () => 5,
    nextPrivateSendAt: () => {
      if (plan === 'open') return null
      if (plan === 'paused') return 'paused' as const
      return new Date(plan.until)
    },
  }
  const delivery = createReminderDelivery({
    db, personaId: 'main', ownerId: 'owner',
    bridge: () => bridge,
    now: () => new Date(clock),
    enqueue: (input) => {
      const enqueued = enqueueReminderReply({
        db: input.db as never,
        ownerId: input.ownerId,
        personaId: input.personaId,
        reminder: input.reminder,
        transportId: input.transportId,
        now: input.now,
        accessEpoch: input.accessEpoch,
      })
      return { replyId: enqueued.replyId }
    },
  })
  const created = createReminder({
    db, personaId: 'main', receiver: qq('ct_owner'), dueAt: at(0),
    timezone: 'Asia/Shanghai', text: '暂停期间', requestId: 'req-b8-paused', now: NOW, accessEpoch: 5,
  })
  const id = created.reminder?.reminder_id ?? ''
  await delivery.tick()
  eq('B8 暂停记成远未来哨兵',
    getReminder({ db, personaId: 'main', reminderId: id })?.next_attempt_at, NO_REPLY_WINDOW_AT)
  // 跨过提醒 outbox 的 10 分钟 TTL：仍是 pending/pending，没有队列行，也没有 failed。
  clock = at(30)
  await delivery.tick()
  eq('B8 跨过 TTL 仍是 pending/unsupported',
    [getReminder({ db, personaId: 'main', reminderId: id })?.status,
      getReminder({ db, personaId: 'main', reminderId: id })?.delivery_state,
      getReminder({ db, personaId: 'main', reminderId: id })?.delivery_result],
    ['pending', 'unsupported', null])
  eq('B8 暂停期间不产生队列行', db.all(
    'SELECT reply_id FROM qq_reply_outbox WHERE reminder_id = ?', [id]), [])

  // C4 恢复规则：下一轮立刻入队。
  plan = 'open'
  clock = at(31)
  await delivery.tick()
  eq('B8 恢复规则后下一轮入队',
    delivery.lastReport().queued.map((q) => q.reminderId), [id])
  db.run('DELETE FROM qq_reply_outbox WHERE reminder_id = ?', [id])
  cancelReminder({ db, personaId: 'main', reminderId: id, receiver: qq('ct_owner'), now: at(32) })
}

console.log('[B10] 已入队的行在规则变化后按新时刻走（第 11 轮第 1 条）')
{
  // 这一组全部从「已经有一条带 retry_at 的队列行」起测：B8 那些用例都是还没入队的提醒。
  let clock = at(1)
  let plan: { kind: 'open' } | { kind: 'wait'; until: string } = { kind: 'wait', until: at(60) }
  const store = new QqReplyOutboxStore({
    db,
    ownerId: 'owner',
    now: () => clock,
    nextAllowedAt: () => (plan.kind === 'open' ? null : plan.until),
  })
  const transport = new MockChatTransport({ id: 'probe-transport', platform: 'qq' })
  const worker = new QqReplyWorker({
    store,
    transport,
    targetOf: (row) => ({ kind: 'private', platform: row.platform, stableUserId: row.stableUserId }),
    now: () => clock,
    authorization: (row) => (plan.kind === 'open' ? null : 'outside-reply-window'),
    logger: { warn() {} },
  })

  const makeDeferredRow = (requestId: string, until: string): string => {
    const created = createReminder({
      db, personaId: 'main', receiver: qq('ct_owner'), dueAt: at(0),
      timezone: 'Asia/Shanghai', text: requestId, requestId, now: NOW, accessEpoch: 5,
    })
    const id = created.reminder?.reminder_id ?? ''
    // 走真实派发路径：提醒落 pending/pending（直接塞 outbox 会停在 pending/unsupported）。
    const dispatched = dispatchDueReminders({
      db, personaId: 'main', now: new Date(at(1)), channels: ['qq'],
      enqueueOutbox: (row, nowIso) => {
        const enqueued = enqueueReminderReply({
          db: db as never, ownerId: 'owner', personaId: 'main', reminder: row,
          transportId: 'probe-transport', now: nowIso, accessEpoch: row.access_epoch,
        })
        return { kind: 'queued', outboxId: enqueued.replyId }
      },
    })
    eq(`${requestId} 已入队`, dispatched.queued.map((q) => q.reminderId), [id])
    // 让这一行进「窗外延后」状态：claim 撞上 outside-reply-window。
    const claimed = store.claim({
      limit: 1,
      authorization: () => 'outside-reply-window',
      transportCheck: () => true,
      now: at(1),
    })
    eq(`${requestId} 领取时被延后（不是取消）`, claimed.length, 0)
    eq(`${requestId} retry_at 推到下一窗口`, rowOf(id)?.retryAt, until)
    eq(`${requestId} 提醒仍是 pending/pending`,
      [getReminder({ db, personaId: 'main', reminderId: id })?.status,
        getReminder({ db, personaId: 'main', reminderId: id })?.delivery_state],
      ['pending', 'pending'])
    return id
  }
  function rowOf(reminderId: string) {
    const row = db.get<{ retry_at: string | null; status: string; expires_at: string }>(
      'SELECT retry_at, status, expires_at FROM qq_reply_outbox WHERE reminder_id = ?', [reminderId],
    )
    return row === undefined
      ? undefined
      : { retryAt: row.retry_at, status: row.status, expiresAt: row.expires_at }
  }
  const refreshReplies = () => refreshDeferredReplies({
    db: db as never,
    now: clock,
    plan: () => plan,
  })

  // D1 窗口提前：旧时刻 at(60)，改成现在就能发 → 下一轮按新时刻发出。
  {
    const id = makeDeferredRow('req-b10-earlier', at(60))
    plan = { kind: 'open' }
    clock = at(10)
    const changed = refreshReplies()
    ok('B10 规则改早后队列行被重算', changed >= 1, changed)
    eq('B10 提前后 retry_at 清空', rowOf(id)?.retryAt, null)
    worker.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    await worker.stop()
    eq('B10 提前后下一轮就发', transport.sends.length, 1)
    eq('B10 提醒落 fired/sent/sent',
      [getReminder({ db, personaId: 'main', reminderId: id })?.status,
        getReminder({ db, personaId: 'main', reminderId: id })?.delivery_state,
        getReminder({ db, personaId: 'main', reminderId: id })?.delivery_result],
      ['fired', 'sent', 'sent'])
    db.run('DELETE FROM qq_reply_outbox WHERE reminder_id = ?', [id])
  }

  // D2 窗口推迟：旧开窗时刻 at(30) 到了也不许发。
  {
    plan = { kind: 'wait', until: at(30) }
    clock = at(1)
    const id = makeDeferredRow('req-b10-later', at(30))
    plan = { kind: 'wait', until: at(120) }
    clock = at(10)
    refreshReplies()
    eq('B10 推迟后 retry_at 改成新窗口', rowOf(id)?.retryAt, at(120))
    const before = transport.sends.length
    clock = at(30)
    worker.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    await worker.stop()
    eq('B10 旧开窗时刻零发送', transport.sends.length, before)
    eq('B10 推迟期间队列行仍 pending', rowOf(id)?.status, 'pending')

    // D3 暂停：跨过原 TTL 仍 pending/pending，连续 tick 不反复领取。
    plan = { kind: 'wait', until: NO_REPLY_WINDOW_AT }
    clock = at(31)
    refreshReplies()
    eq('B10 暂停记成远未来哨兵', rowOf(id)?.retryAt, NO_REPLY_WINDOW_AT)
    clock = at(300)
    refreshReplies()
    worker.start()
    await new Promise((resolve) => setTimeout(resolve, 120))
    await worker.stop()
    eq('B10 暂停跨过 TTL 队列行仍 pending', rowOf(id)?.status, 'pending')
    eq('B10 暂停跨过 TTL 提醒仍 pending/pending',
      [getReminder({ db, personaId: 'main', reminderId: id })?.status,
        getReminder({ db, personaId: 'main', reminderId: id })?.delivery_state],
      ['pending', 'pending'])
    eq('B10 暂停期间零发送', transport.sends.length, before)

    // D4 恢复：用原队列行发一次，再跑一轮累计仍是一次。
    plan = { kind: 'open' }
    clock = at(301)
    refreshReplies()
    worker.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    await worker.stop()
    eq('B10 恢复后发一次', transport.sends.length, before + 1)
    worker.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    await worker.stop()
    eq('B10 再跑一轮累计仍是一次', transport.sends.length, before + 1)
    db.run('DELETE FROM qq_reply_outbox WHERE reminder_id = ?', [id])
  }

  // D5 还没入队的一侧：窗口推迟要让 next_attempt_at 跟着改，不能按旧时刻被扫到。
  {
    const created = createReminder({
      db, personaId: 'main', receiver: qq('ct_owner'), dueAt: at(0),
      timezone: 'Asia/Shanghai', text: '未入队推迟', requestId: 'req-b10-reminder', now: NOW, accessEpoch: 5,
    })
    const id = created.reminder?.reminder_id ?? ''
    dispatchDueReminders({
      db, personaId: 'main', now: new Date(at(1)), channels: ['qq'],
      enqueueOutbox: () => { throw new Error('窗外不该入队') },
      deferUntil: () => at(30),
    })
    eq('B10 未入队先延后到 at(30)',
      getReminder({ db, personaId: 'main', reminderId: id })?.next_attempt_at, at(30))
    const changed = refreshDeferredReminders({
      db: db as never, personaId: 'main', now: at(10),
      plan: () => ({ kind: 'wait', until: at(120) }),
    })
    ok('B10 未入队推迟后行被重算', changed >= 1, changed)
    eq('B10 未入队推迟后 next_attempt_at 改到新窗口',
      getReminder({ db, personaId: 'main', reminderId: id })?.next_attempt_at, at(120))
    ok('B10 旧时刻不再进候选',
      !dueReminders({ db, personaId: 'main', now: new Date(at(31)) }).some((r) => r.reminder_id === id))
    ok('B10 新时刻才进候选',
      dueReminders({ db, personaId: 'main', now: new Date(at(121)) }).some((r) => r.reminder_id === id))
    cancelReminder({ db, personaId: 'main', reminderId: id, receiver: qq('ct_owner'), now: at(2) })
  }
}

console.log('[B9] 工具渲染：已延后要显示原定与预计最早时间')
{
  const base = {
    reminderId: 'rem_1',
    dueAt: '2026-03-02T04:00:00.000Z',
    text: '喝水',
    status: 'pending',
    deliveryState: 'pending',
    createdAt: NOW,
  }
  eq('B9 没延就不加话', deferredNote({ ...base, nextAttemptAt: null }), '')
  const later = deferredNote({ ...base, nextAttemptAt: '2026-03-02T14:00:00.000Z' })
  ok('B9 延后说清原定与预计', later.includes('原定') && later.includes('预计最早'), later)
  ok('B9 预计时刻出现在文案里', later.includes('22:00'), later)
  const noWindow = deferredNote({ ...base, nextAttemptAt: NO_REPLY_WINDOW_AT })
  ok('B9 无可用时段写「暂无可用时段」', noWindow.includes('暂无可用时段'), noWindow)
}

console.log(`\n[reminder-p1b] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
