// P1-C 行为锁：第 15 轮评审冻结的「结果不确定的提醒必须有人工出口」。
//
// 背景（实测缺陷）：提醒会停在 `pending/unknown/unknown`（发送结果不确定），按 P1-A 的设计
// 它不进自动扫描、不重投，只有 `resolveUnknown` 能改——但插件侧从来没调用过它，
// 于是这条提醒永远停在 unknown，还因为卡片过滤了 `unknown` 而对外不可见。
//
// 分组：
//   R1 received：提醒落 `fired/sent/sent`，队列行落 `sent`
//   R2 not-received：提醒落 `failed/unsupported/failed`，队列行落 `failed` + `owner_confirmed_not_received`
//   R3 越权：非 Owner 调用被拒且零写入（普通联系人即使是接收人也不行）
//   R4 状态冲突：提醒不是 `pending/unknown/unknown` 时如实拒绝、零写入
//   R5 过期边界：`unknown → expired`（码 `unknown_unresolved_expired`）可以裁决；
//      普通 pending 过期（`reply_ttl_expired`）即使提醒被改成 unknown 也必须拒绝
//   R6 竞态：两个相反裁决只有一个成功，两表结果一致，发送次数 0
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../packages/core/dist/adapter.js'
import { createReminder, dispatchDueReminders, getReminder } from '../packages/core/dist/reminders.js'
import { QqReplyOutboxStore } from '../packages/core/dist/qq-reply-outbox.js'
import { reminderEnqueue } from './helpers/reminder-enqueue.ts'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const dir = mkdtempSync(join(tmpdir(), 'psyche-p1c-'))
const opened = await openDatabase({ file: join(dir, 'p1c.sqlite3'), driverPreference: 'auto', logger: quiet })
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

const NOW = '2026-04-01T00:00:00.000Z'
const NOW_DATE = new Date(NOW)
const at = (minute: number) => new Date(NOW_DATE.getTime() + minute * 60_000).toISOString()
const SCAN = new Date(NOW_DATE.getTime() + 60 * 60_000)
const CLAIM_ISO = at(5)
const qq = (contactId: string) => ({ channel: 'qq' as const, contactId })
const store = new QqReplyOutboxStore({ db, ownerId: 'owner', now: () => NOW })

db.run(
  `INSERT OR IGNORE INTO contacts
     (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
   VALUES ('ct_owner', 'main', 'qq', '90001', '主人', 'owner', ?, ?)`,
  [NOW, NOW],
)

let seq = 0
function mk(label: string, minute: number) {
  seq += 1
  const created = createReminder({
    db,
    personaId: 'main',
    receiver: qq('ct_owner'),
    dueAt: at(minute),
    timezone: 'Asia/Shanghai',
    text: `裁决用例 ${label}`,
    requestId: `req-p1c-${label}-${seq}`,
    now: NOW,
  })
  ok(`登记 ${label}`, created.status === 'created', created.status)
  return created.reminder?.reminder_id ?? ''
}

function triple(reminderId: string) {
  const row = getReminder({ db, personaId: 'main', reminderId })
  return [row?.status ?? null, row?.delivery_state ?? null, row?.delivery_result ?? null]
}
function outboxOf(reminderId: string) {
  return db.get<{ reply_id: string; status: string; last_error_code: string | null; sent_at: string | null }>(
    'SELECT reply_id, status, last_error_code, sent_at FROM qq_reply_outbox WHERE reminder_id = ?',
    [reminderId],
  )
}
/** 造一条停在 `pending/unknown/unknown` 的提醒（真实路径：入队 → 领取 → unknown 回执）。 */
function makeUnknown(label: string) {
  const id = mk(label, 2)
  const enqueue = reminderEnqueue({ db: db as never, personaId: 'main', ownerId: 'owner' })
  dispatchDueReminders({ db, personaId: 'main', now: SCAN, enqueueOutbox: enqueue.callback })
  const claimed = store.claim({
    limit: 1,
    authorization: () => null,
    transportCheck: (row) => row.reminderId === id,
    now: CLAIM_ISO,
  })
  ok(`${label} 领到一条`, claimed.length === 1, claimed.length)
  store.applyResult(claimed[0].replyId, { outcome: 'unknown', errorCode: 'ack_timeout' }, CLAIM_ISO)
  eq(`${label} 停在 unknown`, triple(id), ['pending', 'unknown', 'unknown'])
  return { id, replyId: claimed[0].replyId }
}

// ── R1 received ─────────────────────────────────────────────
console.log('[R1] 裁决 received')
{
  const { id, replyId } = makeUnknown('r1')
  const result = store.resolveUnknownByReminder({ reminderId: id, verdict: 'received', by: 'owner', now: at(20) })
  eq('R1 裁决成功', result.status, 'resolved')
  eq('R1 返回的队列行 id 一致', result.replyId, replyId)
  eq('R1 提醒落 fired/sent/sent', triple(id), ['fired', 'sent', 'sent'])
  const row = outboxOf(id)
  eq('R1 队列行 sent', row?.status, 'sent')
  ok('R1 队列行有 sent_at', typeof row?.sent_at === 'string' && row.sent_at.length > 0, row?.sent_at)
  ok('R1 错误码被清空', row?.last_error_code === null, row?.last_error_code)
}

// ── R2 not-received ─────────────────────────────────────────
console.log('[R2] 裁决 not-received')
{
  const { id } = makeUnknown('r2')
  const result = store.resolveUnknownByReminder({ reminderId: id, verdict: 'not-received', by: 'owner', now: at(20) })
  eq('R2 裁决成功', result.status, 'resolved')
  eq('R2 提醒落 failed/unsupported/failed', triple(id), ['failed', 'unsupported', 'failed'])
  const row = outboxOf(id)
  eq('R2 队列行 failed', row?.status, 'failed')
  eq('R2 队列行记 owner_confirmed_not_received', row?.last_error_code, 'owner_confirmed_not_received')
}

// ── R3 越权 ─────────────────────────────────────────────────
console.log('[R3] 非 Owner 不能裁决')
{
  const { id } = makeUnknown('r3')
  throws('R3 非 Owner 抛 ownerMismatch', () => {
    store.resolveUnknownByReminder({ reminderId: id, verdict: 'received', by: 'someone-else', now: at(20) })
  }, /owner/i)
  eq('R3 提醒零写入', triple(id), ['pending', 'unknown', 'unknown'])
  eq('R3 队列行零写入', outboxOf(id)?.status, 'unknown')
  // 收尾：unknown 行会阻塞同一联系人后续的领取（P1-A A10 的行为），这一条必须裁决掉，
  // 否则后面几组用例根本领不到自己那条。裁决本身不影响上面三条零写入断言。
  store.resolveUnknownByReminder({ reminderId: id, verdict: 'not-received', by: 'owner', now: at(20) })
  eq('R3 收尾：裁决把它挪出 unknown', triple(id), ['failed', 'unsupported', 'failed'])
}

// ── R4 状态冲突 ─────────────────────────────────────────────
console.log('[R4] 不是 unknown 的提醒不能被裁决')
{
  // 到期时间故意放远：这条只用来验「不是 unknown 就拒绝」，不能让它到点被后面的扫描捡走。
  const id = mk('r4', 600)
  const result = store.resolveUnknownByReminder({ reminderId: id, verdict: 'received', by: 'owner', now: at(20) })
  eq('R4 返回冲突', result.status, 'conflict')
  eq('R4 原因写清当前状态', result.reason, 'reminder-pending/unsupported')
  eq('R4 提醒零写入', triple(id), ['pending', 'unsupported', null])
  const missing = store.resolveUnknownByReminder({ reminderId: 'rem_missing', verdict: 'received', by: 'owner', now: at(20) })
  eq('R4 不存在的提醒 not-found', missing.status, 'not-found')
}

// ── R5 过期边界 ─────────────────────────────────────────────
console.log('[R5] unknown → expired 可以裁决，普通过期不行')
{
  const { id } = makeUnknown('r5a')
  // 让队列行到点：unknown 行到期会被 #expireDue 转 expired 并记 unknown_unresolved_expired。
  db.run('UPDATE qq_reply_outbox SET expires_at = ? WHERE reminder_id = ?', [at(1), id])
  store.expireDue(at(10))
  const expired = outboxOf(id)
  eq('R5a 队列行已 expired', expired?.status, 'expired')
  eq('R5a 过期码来自 unknown 分支', expired?.last_error_code, 'unknown_unresolved_expired')
  eq('R5a 提醒仍停在 unknown', triple(id), ['pending', 'unknown', 'unknown'])
  const resolved = store.resolveUnknownByReminder({ reminderId: id, verdict: 'received', by: 'owner', now: at(20) })
  eq('R5a 过期后仍可裁决', resolved.status, 'resolved')
  eq('R5a 裁决后提醒 fired/sent/sent', triple(id), ['fired', 'sent', 'sent'])
  eq('R5a 队列行 sent', outboxOf(id)?.status, 'sent')
}
{
  const { id } = makeUnknown('r5b')
  // 普通 pending 过期：队列行码是 reply_ttl_expired，提醒会被写成 failed。
  db.run('UPDATE reminders SET delivery_state = ? , delivery_result = ? WHERE reminder_id = ?', ['unknown', 'unknown', id])
  db.run('UPDATE reminders SET status = ? WHERE reminder_id = ?', ['pending', id])
  db.run('UPDATE qq_reply_outbox SET expires_at = ? WHERE reminder_id = ?', [at(1), id])
  db.run(
    `UPDATE qq_reply_outbox SET status = 'expired', last_error_code = 'reply_ttl_expired'
      WHERE reminder_id = ?`,
    [id],
  )
  const result = store.resolveUnknownByReminder({ reminderId: id, verdict: 'received', by: 'owner', now: at(20) })
  eq('R5b 普通过期行不能裁决', result.status, 'conflict')
  eq('R5b 提醒零写入', triple(id), ['pending', 'unknown', 'unknown'])
  eq('R5b 队列行仍 expired/reply_ttl_expired', outboxOf(id)?.status, 'expired')
}

// ── R6 竞态：两个相反裁决只有一个成功 ───────────────────────
console.log('[R6] 相反裁决的竞态')
{
  const { id } = makeUnknown('r6')
  const first = store.resolveUnknownByReminder({ reminderId: id, verdict: 'received', by: 'owner', now: at(20) })
  const second = (() => {
    try {
      return store.resolveUnknownByReminder({ reminderId: id, verdict: 'not-received', by: 'owner', now: at(21) })
    } catch (error) {
      return { status: 'threw' as const, error: String(error) }
    }
  })()
  eq('R6 第一个成功', first.status, 'resolved')
  ok('R6 第二个被拒', second.status !== 'resolved', second)
  eq('R6 两表结果一致（以第一个为准）', triple(id), ['fired', 'sent', 'sent'])
  eq('R6 队列行与提醒一致', outboxOf(id)?.status, 'sent')

  // R6c：两个**独立连接**同时提交相反裁决——这是数据库层的保证，不是同一个 store 的方法顺序。
  const race = makeUnknown('r6-race')
  const otherOpened = await openDatabase({ file: join(dir, 'p1c.sqlite3'), driverPreference: 'auto', logger: quiet })
  const otherStore = new QqReplyOutboxStore({ db: otherOpened.db, ownerId: 'owner', now: () => NOW })
  const fire = (target: typeof store, verdict: 'received' | 'not-received') => {
    try {
      return target.resolveUnknownByReminder({ reminderId: race.id, verdict, by: 'owner', now: at(22) })
    } catch (error) {
      return { status: 'threw' as const, reason: String(error) }
    }
  }
  const [left, right] = await Promise.all([
    Promise.resolve().then(() => fire(store, 'received')),
    Promise.resolve().then(() => fire(otherStore, 'not-received')),
  ])
  const winners = [left, right].filter((result) => result.status === 'resolved')
  eq('R6c 两个连接同时裁决只有一方成功', winners.length, 1)
  const verdictRows = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM qq_reply_verdicts WHERE reminder_id = ?', [
    race.id,
  ])?.n
  eq('R6c 裁决记录恰好一条', verdictRows, 1)
  eq('R6c 队列行与胜方一致', outboxOf(race.id)?.status, winners[0] === left ? 'sent' : 'failed')
  eq('R6c 提醒与胜方一致', triple(race.id), winners[0] === left ? ['fired', 'sent', 'sent'] : ['failed', 'unsupported', 'failed'])
  ok('R6c 两个连接读到同一份终态', JSON.stringify(triple(race.id)) === JSON.stringify(triple(race.id)))
  otherOpened.db.close()
}

// ── R7 关联核对：提醒与队列行必须同 persona、同 contact、同会话 ──────
console.log('[R7] 关联核对')
{
  // 造一条「提醒挂在 ct_owner，队列行却属于 ct_other」的串账记录：
  // 队列行的绑定列不可改（触发器），所以只能从 enqueue 的参数下手。
  db.run(
    `INSERT OR IGNORE INTO contacts
       (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
     VALUES ('ct_other', 'main', 'qq', '90003', '别人', 'friend', ?, ?)`,
    [NOW, NOW],
  )
  const id = mk('r7', 2)
  const mismatched = store.enqueue({
    personaId: 'main',
    contactId: 'ct_other',
    stableUserId: '90003',
    sessionId: 'qq-private-90003',
    sessionSeq: 9001,
    transportId: 'probe-transport',
    payloadText: '串账的队列行',
    reminderId: id,
    now: NOW,
  })
  db.run(`UPDATE qq_reply_outbox SET status = 'unknown' WHERE reply_id = ?`, [mismatched.row.replyId])
  db.run(
    `UPDATE reminders SET delivery_state = 'unknown', delivery_result = 'unknown' WHERE reminder_id = ?`,
    [id],
  )
  const result = store.resolveUnknownByReminder({ reminderId: id, verdict: 'received', by: 'owner', now: at(30) })
  eq('R7 关联不符被拒', result.status, 'conflict')
  eq('R7 原因写明关联不符', result.reason, 'association-mismatch')
  eq('R7 提醒零写入', triple(id), ['pending', 'unknown', 'unknown'])
  eq('R7 队列行零写入', db.get<{ status: string }>('SELECT status FROM qq_reply_outbox WHERE reply_id = ?', [mismatched.row.replyId])?.status, 'unknown')
  ok(
    'R7 没有留下裁决记录',
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM qq_reply_verdicts WHERE reminder_id = ?', [id])?.n === 0,
  )

  // 关联缺失的另一种形态：提醒挂着「结果不确定」，但根本没有队列行可裁。
  const orphanId = mk('r7-orphan', 2)
  db.run(
    `UPDATE reminders SET delivery_state = 'unknown', delivery_result = 'unknown' WHERE reminder_id = ?`,
    [orphanId],
  )
  const orphan = store.resolveUnknownByReminder({ reminderId: orphanId, verdict: 'received', by: 'owner', now: at(31) })
  eq('R7b 没有队列行时拒绝', orphan.status, 'not-found')
  eq('R7b 原因写明缺队列行', orphan.reason, 'reply-missing')
  eq('R7b 提醒零写入', triple(orphanId), ['pending', 'unknown', 'unknown'])

  // 提醒已终态：取消后的提醒不能再被裁决改回「已发送」。
  const doneId = mk('r7-done', 2)
  db.run(`UPDATE reminders SET status = 'cancelled' WHERE reminder_id = ?`, [doneId])
  const done = store.resolveUnknownByReminder({ reminderId: doneId, verdict: 'received', by: 'owner', now: at(32) })
  eq('R7c 已终态的提醒拒绝裁决', done.status, 'conflict')
  eq('R7c 状态冲突原因如实', done.reason, 'reminder-cancelled/unsupported')
}

// ── R8 裁决证据：人、时间、结论都要落账，且不拿 terminal_at 冒充 ──────
console.log('[R8] 裁决证据')
{
  const { id } = makeUnknown('r8')
  // 先让它从 unknown 过期：此时 terminal_at 是「过期时刻」，不是裁决时刻。
  db.run(`UPDATE qq_reply_outbox SET expires_at = ? WHERE reminder_id = ?`, [at(1), id])
  store.expireDue(at(10))
  const expiredAt = db.get<{ terminal_at: string | null }>(
    'SELECT terminal_at FROM qq_reply_outbox WHERE reminder_id = ?',
    [id],
  )?.terminal_at
  const decidedAt = at(40)
  const result = store.resolveUnknownByReminder({ reminderId: id, verdict: 'not-received', by: 'owner', now: decidedAt })
  eq('R8 过期行可裁决', result.status, 'resolved')
  const verdictRow = db.get<{ verdict: string; decided_by: string; decided_at: string }>(
    'SELECT verdict, decided_by, decided_at FROM qq_reply_verdicts WHERE reminder_id = ?',
    [id],
  )
  eq('R8 结论落账', verdictRow?.verdict, 'not-received')
  eq('R8 裁决人落账', verdictRow?.decided_by, 'owner')
  eq('R8 裁决时间落账', verdictRow?.decided_at, decidedAt)
  ok('R8 裁决时间不是过期时刻', verdictRow?.decided_at !== expiredAt, { expiredAt, decidedAt })
  eq('R8 提醒落 failed', triple(id), ['failed', 'unsupported', 'failed'])
}

// ── R9 写入落空必须整笔回滚（不能「队列行改了、提醒没改」还提交） ──────
console.log('[R9] 提醒写不动就整笔回滚')
{
  const { id } = makeUnknown('r9')
  db.run(
    `CREATE TRIGGER IF NOT EXISTS p1c_block_reminder_update BEFORE UPDATE ON reminders
     BEGIN SELECT RAISE(ABORT, 'p1c-injected'); END`,
  )
  let blocked: { status?: string; reason?: string } | null = null
  try {
    blocked = store.resolveUnknownByReminder({ reminderId: id, verdict: 'received', by: 'owner', now: at(50) })
  } catch (error) {
    blocked = { status: 'threw', reason: String(error) }
  }
  db.run('DROP TRIGGER IF EXISTS p1c_block_reminder_update')
  eq('R9 提醒写不动时裁决被拒', blocked?.status, 'conflict')
  eq('R9 队列行回滚回 unknown', outboxOf(id)?.status, 'unknown')
  eq('R9 提醒没被改', triple(id), ['pending', 'unknown', 'unknown'])
  ok(
    'R9 裁决记录也回滚',
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM qq_reply_verdicts WHERE reminder_id = ?', [id])?.n === 0,
  )
  // 收尾：撤掉注入后能正常裁决（证明失败是注入造成的，不是状态坏了）
  const retry = store.resolveUnknownByReminder({ reminderId: id, verdict: 'received', by: 'owner', now: at(51) })
  eq('R9 撤掉注入后可以正常裁决', retry.status, 'resolved')
}

// ── R10 谁算主人：渠道身份判定 + 工具入口把身份传进来 ──────────────
console.log('[R10] 裁决身份')
{
  const { isOwnerReminderScope } = await import('../dist/lib/reminder-owner.js')
  const lookup = {
    get: <T>(sql: string, params?: readonly (string | number | null)[]): T | undefined => {
      const contactId = String(params?.[0] ?? '')
      return db.get<T>(sql, [contactId])
    },
  }
  ok('R10 桌面会话算主人', isOwnerReminderScope(lookup, { channel: 'desktop' }, '90001'))
  ok('R10 QQ 主人本人算主人', isOwnerReminderScope(lookup, { channel: 'qq', contactId: 'ct_owner' }, '90001'))
  // 关键一条：普通联系人**正是这条提醒的接收人**也不行。
  ok('R10 普通联系人（也是接收人）不算主人', !isOwnerReminderScope(lookup, { channel: 'qq', contactId: 'ct_other' }, '90001'))
  ok('R10 没配 Owner 号时失败关闭', !isOwnerReminderScope(lookup, { channel: 'qq', contactId: 'ct_owner' }, '  '))
  ok('R10 联系人查不到时失败关闭', !isOwnerReminderScope(lookup, { channel: 'qq', contactId: 'ct_missing' }, '90001'))

  const { buildTools } = await import('../dist/lib/tools.js')
  type ExecTool = { name: string; execute: (args: unknown, exec?: unknown) => Promise<unknown>; render?: unknown }
  const seen: { reminderId?: string; verdict?: string; receiver?: unknown }[] = []
  const tools = buildTools(
    {
      resolveReminderDelivery: async (input: {
        reminderId: string
        verdict: 'received' | 'not-received'
        receiver: unknown
      }) => {
        seen.push({ reminderId: input.reminderId, verdict: input.verdict, receiver: input.receiver })
        return { ok: false, status: 'no-permission' as const }
      },
    } as never,
    { reminderScope: () => ({ channel: 'qq' as const, contactId: 'ct_other', sessionRef: 'sess-p1c' }) },
  ) as ExecTool[]
  const tool = tools.find((item) => item.name === 'psyche_resolve_delivery')
  ok('R10 工具表里有 psyche_resolve_delivery', tool !== undefined)
  const output = (await tool?.execute({ reminder_id: 'rem_x', verdict: 'received' }, { agent: { id: 'a1' } })) as {
    status?: string
  }
  eq('R10 工具把会话身份原样传给门面', seen[0]?.receiver, {
    channel: 'qq',
    contactId: 'ct_other',
    sessionRef: 'sess-p1c',
  })
  eq('R10 门面拒绝时工具如实返回 no-permission', output?.status, 'no-permission')

  // 真实门面 + 真实 store + 真实库：非主人（哪怕正是接收人）必须被拒且零写入；主人调用才成功。
  const { resolveReminderDelivery } = await import('../dist/lib/reminder-resolve.js')
  const facadeInput = (email: 'owner' | 'contact') => {
    const contactId = email === 'owner' ? 'ct_owner' : 'ct_other'
    return {
      isOwner: isOwnerReminderScope(lookup, { channel: 'qq', contactId }, '90001'),
      owned: true,
      store,
      ownerId: 'owner',
    }
  }
  const first = makeUnknown('r10-owner')
  const ownerResult = resolveReminderDelivery({
    reminderId: first.id,
    verdict: 'received',
    now: at(60),
    deps: facadeInput('owner'),
  })
  eq('R10 主人经真实门面裁决成功', ownerResult.status, 'resolved')
  eq('R10 主人裁决后提醒 fired/sent/sent', triple(first.id), ['fired', 'sent', 'sent'])

  const second = makeUnknown('r10-contact')
  const contactResult = resolveReminderDelivery({
    reminderId: second.id,
    verdict: 'received',
    now: at(61),
    deps: facadeInput('contact'),
  })
  eq('R10 普通联系人（正是接收人）经真实门面被拒', contactResult.status, 'no-permission')
  eq('R10 非主人调用零写入（提醒仍在待裁决）', triple(second.id), ['pending', 'unknown', 'unknown'])
  eq('R10 非主人调用没有改队列行', outboxOf(second.id)?.status, 'unknown')
  ok(
    'R10 非主人调用没有留下裁决记录',
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM qq_reply_verdicts WHERE reminder_id = ?', [second.id])?.n === 0,
  )
  // 收尾：把第二条也裁掉，避免 unknown 行阻塞同联系人后续领取。
  store.resolveUnknownByReminder({ reminderId: second.id, verdict: 'not-received', by: 'owner', now: at(62) })
}

console.log(`\n[reminder-p1c] ${passed} 通过 ${failed} 失败`)
db.close?.()
process.exitCode = failed === 0 ? 0 : 1
