// P1-A 行为锁：A1–A16（第 53/54/55 轮外部评审冻结结论的逐条落地）。
//
// 分五组：
//   ① 入队契约 A1–A7：回调返回值、归属回读复核、单条事务边界、坏行不吃额度、幂等、取消只命中目标；
//   ② Worker 复核 A8：领取前取消必须零发送；领取后（已取得发送权）取消只能说「无法确认」，
//      不许把提醒写成 cancelled；
//   ③ 终态一致性 A9–A12：sent / unknown / failed 三种结果必须与提醒的三个字段同时落定，
//      迟到的结果不许覆盖已生效的取消；
//   ④ 迁移演练 A13 / A13-epoch：v39 库升到 v41，列与**部分唯一索引**补齐，代次快照原样保留；
//   ⑤ 并发边界 A14–A16：取消与在途发送（A14）、unknown 不可被迟到结果/普通取消改写（A15）、
//      单轮额度不足时的轮转，别让持续失败的最早 N 条饿死后面（A16）。
//
// 每个用例只断言「自己那条提醒 / 自己那一行队列」，不靠全表计数——同一个库里的
// 其它用例会留下历史行，用绝对值断言容易把噪声当成回归。
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
  writeReminderOutcome,
} from '../packages/core/dist/reminders.js'
import { QqReplyOutboxStore } from '../packages/core/dist/qq-reply-outbox.js'
import { QqReplyWorker } from '../packages/core/dist/qq-reply-worker.js'
import { MockChatTransport } from '../packages/core/dist/chat-transport.js'
import { reminderEnqueue } from './helpers/reminder-enqueue.ts'
import { insertLegacyDesktopReminder } from './helpers/legacy-desktop-reminder.ts'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const dir = mkdtempSync(join(tmpdir(), 'psyche-p1a-'))
const opened = await openDatabase({ file: join(dir, 'p1a.sqlite3'), driverPreference: 'auto', logger: quiet })
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
function throws(label: string, fn: () => unknown, match?: RegExp) {
  try {
    fn()
    failed += 1
    console.error('  FAIL ' + label, { actual: '没有抛错' })
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (match && !match.test(message)) { failed += 1; console.error('  FAIL ' + label, { actual: message }) }
    else { passed += 1; console.log('  ok ' + label) }
  }
}

const NOW = '2026-03-01T00:00:00.000Z'
const NOW_DATE = new Date(NOW)
/** 相对 NOW 的第 n 分钟（ISO 文本）。 */
const at = (minute: number) => new Date(NOW_DATE.getTime() + minute * 60_000).toISOString()
/** 到期扫描用的「现在」：把这一批提醒都算成到点。 */
const SCAN = new Date(Date.parse(NOW) + 60 * 60_000)
/** 领取/回执用的时间：必须落在队列 TTL（10 分钟）之内，否则会被判过期。 */
const CLAIM_ISO = at(5)
const qq = (contactId: string) => ({ channel: 'qq' as const, contactId })
const store = new QqReplyOutboxStore({ db, ownerId: 'owner', now: () => NOW })

db.run(
  `INSERT OR IGNORE INTO contacts
     (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
   VALUES ('ct_owner', 'main', 'qq', '90001', '主人', 'owner', ?, ?)`,
  [NOW, NOW],
)
db.run(
  `INSERT OR IGNORE INTO contacts
     (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
   VALUES ('ct_other', 'main', 'qq', '90003', '别人', 'friend', ?, ?)`,
  [NOW, NOW],
)

let seq = 0
function mk(
  label: string,
  minute: number,
  options: { contactId?: string; accessEpoch?: number | null; text?: string } = {},
) {
  seq += 1
  const created = createReminder({
    db,
    personaId: 'main',
    receiver: qq(options.contactId ?? 'ct_owner'),
    dueAt: at(minute),
    timezone: 'Asia/Shanghai',
    text: options.text ?? `提醒 ${label}`,
    requestId: `req-${label}-${seq}`,
    now: NOW,
    ...(options.accessEpoch === undefined ? {} : { accessEpoch: options.accessEpoch }),
  })
  ok(`登记 ${label}`, created.status === 'created', created.status)
  return created.reminder?.reminder_id ?? ''
}
/** 历史桌面提醒：入队回调只能显式 skipped('desktop-channel')，拿它当「永久坏行」。
 *  第 57 轮 P1-E 起 createReminder 拒绝桌面渠道，这类行只能直接落库（历史数据不迁移）。 */
function mkDesktop(label: string, minute: number) {
  seq += 1
  const reminderId = `rem_desk_${label.replace(/[^a-z0-9]/gi, '_')}_${seq}`
  insertLegacyDesktopReminder({
    db: db as never,
    reminderId,
    dueAt: at(minute),
    text: `桌面提醒 ${label}`,
    sessionRef: `desk-${label}-${seq}`,
    now: NOW,
    requestId: `req-${label}-${seq}`,
  })
  ok(`登记 ${label}`, true, 'ok')
  return reminderId
}

function row(reminderId: string) {
  return getReminder({ db, personaId: 'main', reminderId })
}
function outboxOf(reminderId: string) {
  return db.all<{ reply_id: string; status: string; last_error_code: string | null; receipt: string | null }>(
    'SELECT reply_id, status, last_error_code, receipt FROM qq_reply_outbox WHERE reminder_id = ?',
    [reminderId],
  )
}
function dueIds() {
  return dueReminders({ db, personaId: 'main', now: SCAN }).map((r) => r.reminder_id)
}
/** 一条提醒的冻结口径：[status, delivery_state, delivery_result]。 */
function triple(reminderId: string) {
  const found = row(reminderId)
  return [found?.status ?? null, found?.delivery_state ?? null, found?.delivery_result ?? null]
}
let sessionSeq = 500
function rawOutbox(over: Record<string, unknown> = {}) {
  sessionSeq += 1
  return store.enqueue({
    personaId: 'main',
    contactId: 'ct_owner',
    stableUserId: '90001',
    sessionId: 'qq-private-90001',
    sessionSeq,
    transportId: 'probe-transport',
    payloadText: '夹具队列行',
    now: NOW,
    ...over,
  } as never).row
}
/** 用完即弃：取消掉还没入队的提醒，并清掉这一条留下的队列行。 */
function dispose(reminderId: string) {
  const current = row(reminderId)
  if (current && current.status === 'pending') {
    const receiver = current.channel === 'qq'
      ? { channel: 'qq' as const, contactId: current.contact_id ?? '' }
      : { channel: 'desktop' as const, sessionRef: current.session_ref ?? '' }
    cancelReminder({ db, personaId: 'main', reminderId, receiver, now: NOW })
  }
  db.run('DELETE FROM qq_reply_outbox WHERE reminder_id = ?', [reminderId])
}
/** 检查员用的最小 Worker：真实结算路径 + 允许把「已被前一轮领走」的行塞进来。 */
function probeWorker(options: {
  forced?: Array<ReturnType<QqReplyOutboxStore['get']>>
  transport?: MockChatTransport
  nowIso?: string
}) {
  const transport = options.transport ?? new MockChatTransport({ id: 'probe-transport', platform: 'qq' })
  const forced = [...(options.forced ?? [])]
  const worker = new QqReplyWorker({
    store: {
      recoverInflight: () => 0,
      claim: (input) => {
        const mine = store.claim(input)
        if (mine.length > 0) return mine
        const next = forced.shift()
        return next ? [next] : []
      },
      applyResult: (replyId, result, nowIso) => store.applyResult(replyId, result, nowIso),
      recheckForSend: (replyId, nowIso) => store.recheckForSend(replyId, nowIso),
    },
    transport,
    targetOf: (r) => ({ kind: 'private', platform: r.platform, stableUserId: r.stableUserId }),
    now: () => options.nowIso ?? CLAIM_ISO,
    logger: { warn() {} },
  })
  return { worker, transport }
}
async function tickOnce(options: Parameters<typeof probeWorker>[0]) {
  const probe = probeWorker(options)
  probe.worker.start()
  await new Promise((resolve) => setTimeout(resolve, 40))
  await probe.worker.stop()
  return probe.transport
}

// ── A1：没有入队入口时，一个字都不写 ────────────────────────────────
console.log('[A1] 缺少 enqueueOutbox 回调')
{
  const id = mk('a1', 0)
  const scanned = dispatchDueReminders({ db, personaId: 'main', now: SCAN })
  eq('A1 记成 skipped(bridge-unavailable)', scanned.skipped.map((s) => [s.reminderId, s.reason]), [[id, 'bridge-unavailable']])
  eq('A1 不算入队', scanned.queued, [])
  eq('A1 三个字段还是 pending/unsupported/NULL', triple(id), ['pending', 'unsupported', null])
  eq('A1 没有队列行', outboxOf(id).length, 0)
  eq('A1 last_attempt_at 没被写', row(id)?.last_attempt_at ?? null, null)
  ok('A1 下一轮仍能扫到它', dueIds().includes(id))
  dispose(id)
}

// ── A2：入队结果必须回读核实归属，六项任何一项不符都拒绝提交 ──────────
console.log('[A2] 归属回读复核')
{
  const cases: Array<[string, (reminderId: string) => string]> = [
    ['outboxId 不存在', () => 'rep_不存在'],
    ['contact 不符', (reminderId) => rawOutbox({
      contactId: 'ct_other', stableUserId: '90003', sessionId: 'qq-private-90003', reminderId,
    }).replyId],
    ['stable_user_id 不符', (reminderId) => rawOutbox({
      stableUserId: '90002', sessionId: 'qq-private-90002', reminderId,
    }).replyId],
    ['session_id 不符', (reminderId) => rawOutbox({
      sessionId: 'qq-private-77777', reminderId,
    }).replyId],
    ['access_epoch 不符', (reminderId) => rawOutbox({ reminderId, accessEpoch: 7 }).replyId],
    ['reminder_id 没挂上', () => rawOutbox({ accessEpoch: 5 }).replyId],
  ]
  for (const [label, makeOutbox] of cases) {
    const id = mk(`a2-${label}`, 0, { accessEpoch: 5 })
    const outboxId = makeOutbox(id)
    const scanned = dispatchDueReminders({
      db, personaId: 'main', now: SCAN,
      enqueueOutbox: () => ({ kind: 'queued', outboxId }),
    })
    eq(`A2 ${label} → 拒绝提交`, scanned.queued, [])
    eq(`A2 ${label} → 计成回滚`, scanned.released, 1)
    eq(`A2 ${label} → 提醒没被改动`, triple(id), ['pending', 'unsupported', null])
    dispose(id)
  }
  // 「reminder_id 没挂上」那一行按 reminder_id 删不掉（NULL 不等于 NULL）。留着它会成为
  // ct_owner 的 FIFO 队首，后面所有 claim 都在队首被判 transportCheck 不匹配而 break。
  db.run('DELETE FROM qq_reply_outbox WHERE reminder_id IS NULL')
}

// ── A2-epoch：代次快照五种组合 ────────────────────────────────────────
console.log('[A2-epoch] 登记代次 vs 队列行代次')
{
  const combos: Array<[string, number | null, number | null, boolean]> = [
    ['5/5', 5, 5, true],
    ['5/7', 5, 7, false],
    ['5/NULL', 5, null, false],
    ['NULL/5', null, 5, false],
    ['NULL/NULL', null, null, true],
  ]
  for (const [label, reminderEpoch, queuedEpoch, shouldQueue] of combos) {
    const id = mk(`a2e-${label}`, 0, { accessEpoch: reminderEpoch })
    const scanned = dispatchDueReminders({
      db, personaId: 'main', now: SCAN,
      enqueueOutbox: (r: Record<string, unknown>) => {
        const queued = rawOutbox({ reminderId: String(r.reminder_id), accessEpoch: queuedEpoch })
        return { kind: 'queued', outboxId: queued.replyId }
      },
    })
    if (shouldQueue) {
      eq(`A2-epoch ${label} → 允许入队`, scanned.queued.map((q) => q.reminderId), [id])
      const linked = db.get<{ access_epoch: number | null }>(
        'SELECT access_epoch FROM qq_reply_outbox WHERE reminder_id = ?', [id])
      eq(`A2-epoch ${label} → 队列行代次原样`, linked === undefined ? 'no-row' : linked.access_epoch, queuedEpoch)
      eq(`A2-epoch ${label} → 提醒已入队口径`, triple(id), ['pending', 'pending', null])
      eq(`A2-epoch ${label} → 队列行数`, outboxOf(id).length, 1)
      dispose(id)
    } else {
      eq(`A2-epoch ${label} → 拒绝提交`, scanned.queued, [])
      eq(`A2-epoch ${label} → 提醒没被改动`, triple(id), ['pending', 'unsupported', null])
      dispose(id)
    }
  }
  // 代次缺失的队列行即使入队成功，领取时也会被授权复核拦下（QQ 桥接里的 epoch-missing）。
  const id = mk('a2e-worker-epoch-missing', 0, { accessEpoch: null })
  dispatchDueReminders({
    db, personaId: 'main', now: SCAN,
    enqueueOutbox: () => ({ kind: 'queued', outboxId: rawOutbox({ reminderId: id, accessEpoch: null }).replyId }),
  })
  const claimed = store.claim({
    limit: 1,
    authorization: (r) => (r.reminderId === id && r.accessEpoch === null ? 'epoch-missing' : null),
    transportCheck: () => true,
    now: CLAIM_ISO,
  })
  const mine = claimed.find((r) => r.reminderId === id)
  const afterClaim = outboxOf(id)[0]
  ok('A2-epoch NULL/NULL 入队后 worker 不领取（epoch-missing 就地取消）',
    mine === undefined && afterClaim?.status === 'cancelled', { claimed: claimed.length, afterClaim })
  eq('A2-epoch NULL/NULL 取消原因', afterClaim?.last_error_code, 'epoch-missing')
  eq('A2-epoch NULL/NULL 提醒落「确定没发」', triple(id), ['failed', 'unsupported', 'failed'])
  dispose(id)
}

// ── A3：入队与状态变更必须同一事务 ───────────────────────────────────
console.log('[A3] 原子性')
{
  // A3a：写提醒状态时炸了 → 整条回滚，不留僵尸队列行。
  const id = mk('a3-status', 0)
  db.exec(`CREATE TRIGGER p1a_block_update BEFORE UPDATE ON reminders
           BEGIN SELECT RAISE(ABORT, 'p1a-injected'); END`)
  let released = 0
  try {
    const harness = reminderEnqueue({ db, personaId: 'main' })
    const scanned = dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: harness.callback })
    released = scanned.released
    eq('A3a 这一轮没有入队', scanned.queued, [])
    eq('A3a 回调根本没被叫到（先写状态后入队）', harness.calls, [])
  } finally {
    db.exec('DROP TRIGGER p1a_block_update')
  }
  eq('A3a 计成回滚', released, 1)
  eq('A3a 队列行不存在', outboxOf(id).length, 0)
  eq('A3a 提醒没被改动', triple(id), ['pending', 'unsupported', null])
  ok('A3a 下一轮还能扫到它', dueIds().includes(id))
  dispose(id)

  // A3b：队列行真的写进去了，但这一条随后被判契约违约 → 队列行必须跟着回滚。
  const id2 = mk('a3-commit', 0)
  const harness2 = reminderEnqueue({ db, personaId: 'main' })
  let inserted = ''
  const bogus = dispatchDueReminders({
    db, personaId: 'main', now: SCAN,
    enqueueOutbox: (r: Record<string, unknown>, nowIso: string) => {
      const outcome = harness2.callback(r, nowIso)
      if (outcome.kind === 'queued') inserted = outcome.outboxId
      return { kind: 'bogus' } as never
    },
  })
  eq('A3b 计成回滚', bogus.released, 1)
  ok('A3b 队列行确实写进去过', inserted.length > 0, { inserted })
  eq('A3b 但随事务一起回滚了', outboxOf(id2).length, 0)
  eq('A3b 提醒没被改动', triple(id2), ['pending', 'unsupported', null])
  dispose(id2)
}

// ── A4：同批一条抛错，其它照常入队 ───────────────────────────────────
console.log('[A4] 一条抛错不连累同批')
{
  const bad = mk('a4-bad', 0)
  const good = mk('a4-good', 1)
  const harness = reminderEnqueue({ db, personaId: 'main' })
  const scanned = dispatchDueReminders({
    db, personaId: 'main', now: SCAN,
    enqueueOutbox: (r: Record<string, unknown>, nowIso: string) => {
      if (String(r.reminder_id) === bad) throw new Error('这一条故意炸')
      return harness.callback(r, nowIso)
    },
  })
  eq('A4 只有好的那一条入队', scanned.queued.map((q) => q.reminderId), [good])
  eq('A4 坏的那条计成回滚', scanned.released, 1)
  eq('A4 坏的那条没被改动', triple(bad), ['pending', 'unsupported', null])
  eq('A4 好的那条已入队', triple(good), ['pending', 'pending', null])
  dispose(bad)
  dispose(good)
}

// ── A5：25 条永久坏行不占额度 ────────────────────────────────────────
console.log('[A5] 坏行不吃额度')
{
  const badIds: string[] = []
  for (let i = 0; i < 25; i += 1) badIds.push(mkDesktop(`a5-bad-${i}`, -30 + i * 0.01))
  const goodIds: string[] = []
  for (let i = 0; i < 3; i += 1) goodIds.push(mk(`a5-good-${i}`, 0 + i))
  const harness = reminderEnqueue({ db, personaId: 'main' })
  const first = dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: harness.callback })
  eq('A5 第一轮扫满 20 条（全是坏行）', first.skipped.length, 20)
  eq('A5 第一轮一条都没入队', first.queued, [])
  eq('A5 坏行的跳过原因是 desktop-channel',
    first.skipped.every((s) => s.reason === 'desktop-channel'), true)
  const second = dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: harness.callback })
  eq('A5 第二轮把 3 条好的都入队', second.queued.map((q) => q.reminderId).sort(), [...goodIds].sort())
  eq('A5 每条好提醒恰好一行队列', goodIds.map((id) => outboxOf(id).length), [1, 1, 1])
  eq('A5 25 条坏行全部落 failed', badIds.map((id) => triple(id)).filter((t) => t[0] === 'failed').length, 25)
  eq('A5 坏行没有队列行', badIds.map((id) => outboxOf(id).length).reduce((a, b) => a + b, 0), 0)
  for (const id of [...badIds, ...goodIds]) dispose(id)
}

// ── A6：重复扫描 / 重启重放只留一条持久任务 ──────────────────────────
console.log('[A6] 幂等')
{
  const id = mk('a6', 0)
  const h1 = reminderEnqueue({ db, personaId: 'main' })
  const first = dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: h1.callback })
  eq('A6 第一轮入队', first.queued.map((q) => q.reminderId), [id])
  const h2 = reminderEnqueue({ db, personaId: 'main' })
  const again = dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: h2.callback })
  eq('A6 第二轮什么都不做', again.queued, [])
  eq('A6 第二轮回调没被叫', h2.calls, [])
  eq('A6 持久任务仍只有一条', outboxOf(id).length, 1)
  dispose(id)
}

// ── A7：两条正文相同，取消其一只命中目标 ─────────────────────────────
console.log('[A7] 取消只命中目标')
{
  const one = mk('a7-one', 0, { text: '一模一样的正文' })
  const two = mk('a7-two', 1, { text: '一模一样的正文' })
  const harness = reminderEnqueue({ db, personaId: 'main' })
  dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: harness.callback })
  eq('A7 两条都入了队', [outboxOf(one).length, outboxOf(two).length], [1, 1])
  const cancelled = cancelReminder({ db, personaId: 'main', reminderId: one, receiver: qq('ct_owner'), now: NOW })
  eq('A7 取消返回 cancelled', cancelled.status, 'cancelled')
  eq('A7 目标提醒已取消', triple(one), ['cancelled', 'unsupported', null])
  eq('A7 目标队列行跟着取消', outboxOf(one)[0]?.status, 'cancelled')
  eq('A7 目标的取消原因', outboxOf(one)[0]?.last_error_code, 'reminder_cancelled')
  eq('A7 同文的那条完全不受影响', triple(two), ['pending', 'pending', null])
  eq('A7 同文的队列行还在排队', outboxOf(two)[0]?.status, 'pending')
  dispose(two)
}

// ── A8：取消与在途发送的边界 ────────────────────────────────────────
console.log('[A8] 领取前 / 领取后取消')
{
  // (a) 还没被领取时取消：真的拦住了，Worker 一次都不发。
  const before = mk('a8-before', 0)
  const harness0 = reminderEnqueue({ db, personaId: 'main' })
  dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: harness0.callback })
  const early = cancelReminder({ db, personaId: 'main', reminderId: before, receiver: qq('ct_owner'), now: CLAIM_ISO })
  eq('A8a 领取前取消确实成功', early.status, 'cancelled')
  eq('A8a 队列行跟着取消', outboxOf(before)[0]?.status, 'cancelled')
  const transport0 = await tickOnce({})
  eq('A8a Worker 一次都没发', transport0.sends.length, 0)
  eq('A8a 提醒仍是取消态', triple(before), ['cancelled', 'unsupported', null])

  // (b) 已经被领取（dispatching）：Worker 已取得发送权，消息可能已在路上。
  //     这时取消必须说「无法确认」，绝不能写 cancelled 骗调用方。
  const id = mk('a8', 1)
  const harness = reminderEnqueue({ db, personaId: 'main' })
  dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: harness.callback })
  const claimed = store.claim({
    limit: 1, authorization: () => null, transportCheck: (r) => r.reminderId === id, now: CLAIM_ISO,
  })
  eq('A8b 先领到这一条', claimed.map((r) => r.reminderId), [id])
  eq('A8b 领取后队列行是 dispatching', outboxOf(id)[0]?.status, 'dispatching')

  const blocked = cancelReminder({ db, personaId: 'main', reminderId: id, receiver: qq('ct_owner'), now: CLAIM_ISO })
  eq('A8b 取消返回「无法确认」', blocked.status, 'in-flight')
  eq('A8b 队列行没有被抹掉', outboxOf(id)[0]?.status, 'dispatching')
  eq('A8b 提醒没有被写成 cancelled', triple(id), ['pending', 'pending', null])

  // 恢复 Worker：这一条按原计划发出——既然取消没生效，界面就不能声称已撤销。
  const transport = await tickOnce({ forced: [claimed[0]] })
  eq('A8b 恢复后确实发了这一条', transport.sends.length, 1)
  eq('A8b 提醒落 fired/sent/sent', triple(id), ['fired', 'sent', 'sent'])
  dispose(before)
  dispose(id)
}

// ── A9：真正发出去 → 提醒与队列同时落「已发送」─────────────────────
console.log('[A9] 发送成功终态一致')
{
  const id = mk('a9', 0)
  const harness = reminderEnqueue({ db, personaId: 'main' })
  dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: harness.callback })
  const transport = await tickOnce({})
  eq('A9 真的发了一条', transport.sends.length, 1)
  eq('A9 队列行 sent', outboxOf(id)[0]?.status, 'sent')
  ok('A9 回执落在队列行', (outboxOf(id)[0]?.receipt ?? '').length > 0, outboxOf(id)[0])
  eq('A9 提醒落 fired/sent/sent', triple(id), ['fired', 'sent', 'sent'])
  dispose(id)
}

// ── A10：结果不确定 → 不许自动重投 ──────────────────────────────────
console.log('[A10] unknown ACK')
{
  const id = mk('a10', 0)
  const harness = reminderEnqueue({ db, personaId: 'main' })
  dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: harness.callback })
  const claimed = store.claim({
    limit: 1, authorization: () => null, transportCheck: (r) => r.reminderId === id, now: CLAIM_ISO,
  })
  eq('A10 先领到', claimed.length, 1)
  store.applyResult(claimed[0].replyId, { outcome: 'unknown', errorCode: 'ack_timeout' }, CLAIM_ISO)
  eq('A10 队列行 unknown', outboxOf(id)[0]?.status, 'unknown')
  eq('A10 提醒 pending/unknown/unknown', triple(id), ['pending', 'unknown', 'unknown'])
  ok('A10 扫描不再选中它', !dueIds().includes(id))
  const h2 = reminderEnqueue({ db, personaId: 'main' })
  const again = dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: h2.callback })
  eq('A10 再扫不会重投', again.queued.filter((q) => q.reminderId === id), [])
  eq('A10 也没有第二条队列行', outboxOf(id).length, 1)
  const reclaim = store.claim({
    limit: 5, authorization: () => null, transportCheck: (r) => r.reminderId === id, now: CLAIM_ISO,
  })
  eq('A10 unknown 阻塞同联系人，worker 不会重领', reclaim.filter((r) => r.reminderId === id), [])
  dispose(id)
}

// ── A11：确定失败 → failed/unsupported/failed ───────────────────────
console.log('[A11] permanent 失败')
{
  const id = mk('a11', 0)
  const harness = reminderEnqueue({ db, personaId: 'main' })
  dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: harness.callback })
  const claimed = store.claim({
    limit: 1, authorization: () => null, transportCheck: (r) => r.reminderId === id, now: CLAIM_ISO,
  })
  store.applyResult(claimed[0].replyId, { outcome: 'permanent', errorCode: 'blocked_by_peer' }, CLAIM_ISO)
  eq('A11 队列行 failed', outboxOf(id)[0]?.status, 'failed')
  eq('A11 失败原因保留', outboxOf(id)[0]?.last_error_code, 'blocked_by_peer')
  eq('A11 提醒 failed/unsupported/failed', triple(id), ['failed', 'unsupported', 'failed'])
  ok('A11 不再被扫描', !dueIds().includes(id))
  dispose(id)
}

// ── A12：迟到的结果不许覆盖已生效的取消 / 终态 ──────────────────────
console.log('[A12] 迟到结果')
{
  // (a) 取消生效之后，那条「其实发成功了」的回执迟到：队列行与提醒都不许翻回来。
  const id = mk('a12-late-accepted', 0)
  const harness = reminderEnqueue({ db, personaId: 'main' })
  dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: harness.callback })
  const replyId = outboxOf(id)[0].reply_id
  const cancelled = cancelReminder({ db, personaId: 'main', reminderId: id, receiver: qq('ct_owner'), now: CLAIM_ISO })
  eq('A12a 取消成功', cancelled.status, 'cancelled')
  const late = store.applyResult(replyId, { outcome: 'accepted', messageId: 'late-1' }, CLAIM_ISO)
  eq('A12a 迟到的成功不改队列终态', late?.status, 'cancelled')
  eq('A12a 也没写回执', outboxOf(id)[0]?.receipt ?? null, null)
  eq('A12a 提醒仍是取消态', triple(id), ['cancelled', 'unsupported', null])
  const transport = await tickOnce({})
  eq('A12a 取消后 Worker 不会补发', transport.sends.length, 0)

  // (b) 领取 → 可重试回执（退回 pending）→ 取消 → 之后的重试回执不许把它复活。
  const id2 = mk('a12-late-retry', 1)
  const harness2 = reminderEnqueue({ db, personaId: 'main' })
  dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: harness2.callback })
  const claimed2 = store.claim({
    limit: 1, authorization: () => null, transportCheck: (r) => r.reminderId === id2, now: CLAIM_ISO,
  })
  const replyId2 = claimed2[0].replyId
  store.applyResult(replyId2, { outcome: 'retryable', errorCode: 'rate_limited' }, CLAIM_ISO)
  eq('A12b 可重试回执退回 pending', outboxOf(id2)[0]?.status, 'pending')
  const cancelled2 = cancelReminder({ db, personaId: 'main', reminderId: id2, receiver: qq('ct_owner'), now: CLAIM_ISO })
  eq('A12b 退回 pending 后取消生效', cancelled2.status, 'cancelled')
  const retried = store.applyResult(replyId2, { outcome: 'retryable', errorCode: 'rate_limited' }, CLAIM_ISO)
  eq('A12b 迟到的重试回执不改终态', retried?.status, 'cancelled')
  eq('A12b 提醒仍是取消态', triple(id2), ['cancelled', 'unsupported', null])
  const reclaim = store.claim({
    limit: 5, authorization: () => null, transportCheck: (r) => r.reminderId === id2, now: CLAIM_ISO,
  })
  eq('A12b 之后再也领不到', reclaim.filter((r) => r.reminderId === id2), [])
  dispose(id)
  dispose(id2)
}

// ── A13：v39 → v42 迁移演练 ─────────────────────────────────────────
console.log('[A13] v39 → v42 迁移')
{
  const drill = await openDatabase({ file: join(dir, 'v39.sqlite3'), driverPreference: 'auto', logger: quiet })
  // openDatabase 会直接迁到最新；把结构倒回 v39，再跑一次真实迁移。
  // 回退的是「v40/v41/v42 加的东西」（列、索引、证据表真的删掉），不是伪造版本号。
  drill.db.exec('DROP INDEX IF EXISTS idx_qq_reply_outbox_reminder')
  drill.db.exec('ALTER TABLE qq_reply_outbox DROP COLUMN reminder_id')
  drill.db.exec('ALTER TABLE reminders DROP COLUMN delivery_result')
  drill.db.exec('ALTER TABLE reminders DROP COLUMN next_attempt_at')
  drill.db.exec('DROP TABLE IF EXISTS qq_reply_verdicts')
  drill.db.exec('PRAGMA user_version = 39')
  drill.db.run('DELETE FROM schema_migrations WHERE version IN (40, 41, 42)')
  eq('A13 倒回 v39', drill.db.userVersion(), 39)
  eq('A13 v39 里没有 reminder_id 列',
    drill.db.all<{ name: string }>('PRAGMA table_info(qq_reply_outbox)').some((c) => c.name === 'reminder_id'), false)

  drill.db.run(
    `INSERT OR IGNORE INTO contacts
       (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
     VALUES ('ct_owner', 'main', 'qq', '90001', '主人', 'owner', ?, ?)`,
    [NOW, NOW],
  )
  const historical5 = createReminder({
    db: drill.db, personaId: 'main', receiver: qq('ct_owner'),
    dueAt: at(0), timezone: 'Asia/Shanghai', text: '迁移前的提醒（有代次）',
    requestId: 'req-v39-epoch-5', now: NOW, accessEpoch: 5,
  })
  const historicalNull = createReminder({
    db: drill.db, personaId: 'main', receiver: qq('ct_owner'),
    dueAt: at(1), timezone: 'Asia/Shanghai', text: '迁移前的提醒（无代次）',
    requestId: 'req-v39-epoch-null', now: NOW,
  })
  eq('A13 两条历史提醒都登记成功', [historical5.status, historicalNull.status], ['created', 'created'])
  const fiveId = historical5.reminder?.reminder_id ?? ''
  const nullId = historicalNull.reminder?.reminder_id ?? ''

  const applied = migrate(drill.db, quiet)
  eq('A13 只补了待补的三条迁移', applied.map((m) => m.version), [40, 41, 42])
  eq('A13 版本升到 42', drill.db.userVersion(), 42)
  eq('A13 迁移记录里写着 v40',
    drill.db.get<{ name: string }>('SELECT name FROM schema_migrations WHERE version = 40')?.name,
    'reply-reminder-link')
  eq('A13 迁移记录里写着 v41',
    drill.db.get<{ name: string }>('SELECT name FROM schema_migrations WHERE version = 41')?.name,
    'reminder-next-attempt')
  eq('A13 迁移记录里写着 v42',
    drill.db.get<{ name: string }>('SELECT name FROM schema_migrations WHERE version = 42')?.name,
    'reply-verdicts')
  eq('A13 裁决证据表建出来了',
    drill.db.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'qq_reply_verdicts'`)?.name,
    'qq_reply_verdicts')
  eq('A13 next_attempt_at 列补上了',
    drill.db.all<{ name: string }>('PRAGMA table_info(reminders)').some((c) => c.name === 'next_attempt_at'), true)
  eq('A13 迁移后 next_attempt_at 默认是 NULL',
    drill.db.all<{ next_attempt_at: string | null }>('SELECT next_attempt_at FROM reminders').map((r) => r.next_attempt_at),
    [null, null])
  eq('A13 部分唯一索引补上了',
    drill.db.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_qq_reply_outbox_reminder'`)?.name,
    'idx_qq_reply_outbox_reminder')
  {
    const indexRow = drill.db.all<{ name: string; unique: number; partial: number }>(
      'PRAGMA index_list(qq_reply_outbox)').find((i) => i.name === 'idx_qq_reply_outbox_reminder')
    eq('A13 索引是 unique + partial', [indexRow?.unique, indexRow?.partial], [1, 1])
  }
  eq('A13 delivery_result 列补上了',
    drill.db.all<{ name: string }>('PRAGMA table_info(reminders)').some((c) => c.name === 'delivery_result'), true)
  eq('A13 迁移后 delivery_result 默认是 NULL',
    drill.db.all<{ delivery_result: string | null }>('SELECT delivery_result FROM reminders').map((r) => r.delivery_result),
    [null, null])

  // A13-epoch：代次快照原样保留，注意「NULL 就是 NULL」，不许补当前值。
  eq('A13-epoch 代次 5 原样保留',
    drill.db.get<{ access_epoch: number | null }>(
      'SELECT access_epoch FROM reminders WHERE reminder_id = ?', [fiveId])?.access_epoch, 5)
  eq('A13-epoch 代次 NULL 原样保留',
    drill.db.get<{ access_epoch: number | null }>(
      'SELECT access_epoch FROM reminders WHERE reminder_id = ?', [nullId])?.access_epoch, null)
  eq('A13-epoch 两条历史提醒状态没被迁移改动',
    [tripleOfDrill(fiveId), tripleOfDrill(nullId)],
    [['pending', 'unsupported', null], ['pending', 'unsupported', null]])

  // 索引真的在约束：同一条提醒不能有第二行队列。
  const drillStore = new QqReplyOutboxStore({ db: drill.db, ownerId: 'owner', now: () => NOW })
  const enqueueFor = (sessionSeqNo: number) => drillStore.enqueue({
    personaId: 'main', contactId: 'ct_owner', stableUserId: '90001',
    sessionId: 'qq-private-90001', sessionSeq: sessionSeqNo, transportId: 'probe-transport',
    payloadText: '迁移演练', now: NOW, accessEpoch: 5, reminderId: fiveId,
  })
  enqueueFor(9001)
  throws('A13 同一条提醒的第二行队列被索引拒绝', () => enqueueFor(9002), /CONFLICT|UNIQUE|约束/)

  const again = migrate(drill.db, quiet)
  eq('A13 重跑迁移不再重复执行', again, [])

  function tripleOfDrill(reminderId: string) {
    const found = drill.db.get<{ status: string; delivery_state: string; delivery_result: string | null }>(
      'SELECT status, delivery_state, delivery_result FROM reminders WHERE persona_id = ? AND reminder_id = ?',
      ['main', reminderId],
    )
    return [found?.status ?? null, found?.delivery_state ?? null, found?.delivery_result ?? null]
  }
  drill.db.close()
}

// ── A14：取消与在途发送的边界（第 55 轮评审第 1 条）─────────────────
// 评审原文：暂停在 recheckForSend 通过之后、transport.send 之前，从另一事务取消。
// 结论必须是：取消失败（in-flight）时提醒不得写成 cancelled；真正被取消时 send 为 0。
console.log('[A14] 取消与在途发送')
{
  // (a) 复核通过之后取消：Worker 已持有这条 dispatching 行，取消只能返回 in-flight，
  //     随后这一条仍会被发出——这正是「仅靠发送前再读一次」证明不了的边界。
  const id = mk('a14-rechecked', 0)
  const harness = reminderEnqueue({ db, personaId: 'main' })
  dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: harness.callback })
  const claimed = store.claim({
    limit: 1, authorization: () => null, transportCheck: (r) => r.reminderId === id, now: CLAIM_ISO,
  })
  const replyId = claimed[0].replyId
  eq('A14 复核放行', store.recheckForSend(replyId, CLAIM_ISO), null)
  // 复核之后、send 之前：另一条事务来取消。
  const race = cancelReminder({ db, personaId: 'main', reminderId: id, receiver: qq('ct_owner'), now: CLAIM_ISO })
  eq('A14 复核通过后取消只能返回 in-flight', race.status, 'in-flight')
  eq('A14 提醒没有被写成 cancelled', triple(id), ['pending', 'pending', null])
  eq('A14 在途队列行保持 dispatching', outboxOf(id)[0]?.status, 'dispatching')
  const sent = store.applyResult(replyId, { outcome: 'accepted', messageId: 'a14-sent' }, CLAIM_ISO)
  eq('A14 这一条按原计划发出', sent?.status, 'sent')
  eq('A14 提醒落 fired/sent/sent', triple(id), ['fired', 'sent', 'sent'])

  // (b) 同一时刻如果取消赢在后面（队列行还没被领走），Worker 恢复后 send 必须是 0。
  const id2 = mk('a14-cancel-wins', 1)
  const harness2 = reminderEnqueue({ db, personaId: 'main' })
  dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: harness2.callback })
  const won = cancelReminder({ db, personaId: 'main', reminderId: id2, receiver: qq('ct_owner'), now: CLAIM_ISO })
  eq('A14b 取消赢下这一条', won.status, 'cancelled')
  const transport = await tickOnce({})
  eq('A14b 恢复 Worker 后 send 为 0', transport.sends.length, 0)
  eq('A14b 队列行封死', outboxOf(id2)[0]?.status, 'cancelled')
  eq('A14b 提醒仍是取消态', triple(id2), ['cancelled', 'unsupported', null])
  dispose(id)
  dispose(id2)
}

// ── A15：unknown 不可被迟到结果 / 普通取消改写（第 55 轮评审第 2 条）──
console.log('[A15] unknown 不可改写')
{
  const id = mk('a15', 0)
  const harness = reminderEnqueue({ db, personaId: 'main' })
  dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: harness.callback })
  const claimed = store.claim({
    limit: 1, authorization: () => null, transportCheck: (r) => r.reminderId === id, now: CLAIM_ISO,
  })
  const replyId = claimed[0].replyId
  store.applyResult(replyId, { outcome: 'unknown', errorCode: 'ack_timeout' }, CLAIM_ISO)
  eq('A15 先落 unknown', triple(id), ['pending', 'unknown', 'unknown'])

  store.applyResult(replyId, { outcome: 'accepted', messageId: 'late-ok' }, CLAIM_ISO)
  eq('A15 迟到的成功改不动它', triple(id), ['pending', 'unknown', 'unknown'])
  store.applyResult(replyId, { outcome: 'permanent', errorCode: 'late-fail' }, CLAIM_ISO)
  eq('A15 迟到的失败也改不动它', triple(id), ['pending', 'unknown', 'unknown'])

  const blocked = cancelReminder({ db, personaId: 'main', reminderId: id, receiver: qq('ct_owner'), now: CLAIM_ISO })
  eq('A15 普通取消返回 unknown', blocked.status, 'unknown')
  eq('A15 普通取消没有改写它', triple(id), ['pending', 'unknown', 'unknown'])

  // 底层唯一写入口也要挡：不经 resolveUnknown 不许越过 unknown。
  eq('A15 底层写入被守卫挡下',
    writeReminderOutcome({ db, personaId: 'main', reminderId: id, now: CLAIM_ISO, outcome: 'failed' }), false)
  eq('A15 挡下之后仍是 unknown', triple(id), ['pending', 'unknown', 'unknown'])

  // 只有 Owner 的人工裁决能定结果。
  store.resolveUnknown(replyId, 'received', 'owner', CLAIM_ISO)
  eq('A15 裁决定为已发送', triple(id), ['fired', 'sent', 'sent'])

  // 另一条：裁决为未收到 → 落 failed。
  const id2 = mk('a15-not-received', 1)
  const harness2 = reminderEnqueue({ db, personaId: 'main' })
  dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: harness2.callback })
  const claimed2 = store.claim({
    limit: 1, authorization: () => null, transportCheck: (r) => r.reminderId === id2, now: CLAIM_ISO,
  })
  store.applyResult(claimed2[0].replyId, { outcome: 'unknown', errorCode: 'ack_timeout' }, CLAIM_ISO)
  store.resolveUnknown(claimed2[0].replyId, 'not-received', 'owner', CLAIM_ISO)
  eq('A15 裁决定为未送达', triple(id2), ['failed', 'unsupported', 'failed'])
  dispose(id)
  dispose(id2)
}

// ── A16：单轮额度不足时的轮转（第 55 轮评审 LIMIT 段）────────────────
// N=1、两条到期提醒：首条持续回滚时，第二条必须在有限轮次内入队。
console.log('[A16] 单轮额度轮转')
{
  const stuck = mk('a16-stuck', 0)
  const good = mk('a16-good', 1)
  const base = reminderEnqueue({ db, personaId: 'main' })
  const flaky = (row: { reminder_id: string }, nowIso: string) => {
    if (row.reminder_id === stuck) throw new Error('a16 持续失败')
    return base.callback(row as never, nowIso)
  }
  const first = dispatchDueReminders({ db, personaId: 'main', now: SCAN, limit: 1, enqueueOutbox: flaky })
  eq('A16 第一轮只处理了更早到期的坏行', [first.queued.length, first.skipped.length, first.released], [0, 0, 1])
  eq('A16 坏行仍然留在候选里', triple(stuck), ['pending', 'unsupported', null])
  ok('A16 坏行记了尝试时间（只用于轮转）', (row(stuck)?.last_attempt_at ?? '').length > 0, row(stuck)?.last_attempt_at)
  ok('A16 它没有被排除出扫描', dueIds().includes(stuck))

  const second = dispatchDueReminders({ db, personaId: 'main', now: SCAN, limit: 1, enqueueOutbox: flaky })
  eq('A16 第二轮轮到第二条并成功入队', second.queued.map((q) => q.reminderId), [good])

  const third = dispatchDueReminders({ db, personaId: 'main', now: SCAN, limit: 1, enqueueOutbox: flaky })
  eq('A16 第三轮又轮回到坏行', third.released, 1)

  // 故障排除后坏行照样能进队——轮转不等于放弃。
  const fixed = reminderEnqueue({ db, personaId: 'main' })
  const fourth = dispatchDueReminders({ db, personaId: 'main', now: SCAN, limit: 1, enqueueOutbox: fixed.callback })
  eq('A16 坏行恢复后仍能入队', fourth.queued.map((q) => q.reminderId), [stuck])
  dispose(stuck)
  dispose(good)
}

db.close()
console.log(`[reminder-p1a] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
