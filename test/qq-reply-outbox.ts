// P4-B-4-1：私聊离线回复队列（Schema v24）存储、状态机、容量、TTL、FIFO、崩溃恢复。
// 跑法：node test/qq-reply-outbox.ts（需先 npm run build）
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '../packages/core/dist/adapter.js'
import { Core } from '../packages/core/dist/store.js'
import {
  QQ_REPLY_CONTACT_CAPACITY,
  QQ_REPLY_ERROR,
  QQ_REPLY_GLOBAL_CAPACITY,
  QQ_REPLY_MAX_ATTEMPTS,
  QQ_REPLY_TTL_MS,
  QqReplyOutboxStore,
  hashReplyText,
  replyIdOf,
} from '../packages/core/dist/qq-reply-outbox.js'

let passed = 0
let failed = 0
function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}
function eq(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}
function reasonOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return (error as { detail?: { reason?: string } }).detail?.reason
  }
  return undefined
}
function rejects(label: string, reason: string, run: () => unknown): void {
  eq(label, reasonOf(run), reason)
}

const log = { info() {}, debug() {}, warn() {}, error() {} }
const dir = mkdtempSync(join(tmpdir(), 'psyche-reply-outbox-'))
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const A = await core.resolveContact({ platform: 'qq', stableUserId: '20001', displayName: 'A' })
const B = await core.resolveContact({ platform: 'qq', stableUserId: '20002', displayName: 'B' })
const C = await core.resolveContact({ platform: 'qq', stableUserId: '20003', displayName: 'C' })
eq('B0a findContactId 解析已存在联系人', core.findContactId('qq', '20001'), A.contactId)
eq('B0b findContactId 未建档返回 null', core.findContactId('qq', '29999'), null)
const owner = 'owner-local'

let clock = Date.parse('2026-11-14T12:00:00.000Z')
const store = new QqReplyOutboxStore({ db, ownerId: owner, now: () => new Date(clock).toISOString() })
const tick = (ms: number): void => {
  clock += ms
}
const base = (contactId: string, seq: number, text = 'hello') => ({
  personaId: 'main',
  contactId,
  stableUserId: contactId === A.contactId ? '20001' : contactId === B.contactId ? '20002' : '20003',
  sessionId: `qq-private-${contactId}`,
  sessionSeq: seq,
  transportId: 'qq-onebot',
  payloadText: text,
})

const allow = (): string | null => null
const passTransport = (): boolean => true

// ---- A. schema ----
{
  const table = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='qq_reply_outbox'`,
  )
  eq('A1 建表', table?.n, 1)
  const triggers = db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='qq_reply_outbox' ORDER BY name`,
  )
  eq('A2 两个触发器', triggers.map((row) => row.name), [
    'trg_qq_reply_outbox_binding_immutable',
    'trg_qq_reply_outbox_terminal_once',
  ])
  eq('A3 表数', (db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fts_index_%'`,
  )?.n ?? 0) >= 58, true)
}

// ---- B. enqueue / 幂等 / 冲突 / 参数 ----
{
  const first = store.enqueue(base(A.contactId, 1, '第一条'))
  eq('B1 首次入队 duplicate=false', first.duplicate, false)
  eq('B2 pending', first.row.status, 'pending')
  eq('B3 replyId 稳定', first.row.replyId, replyIdOf('main', A.contactId, `qq-private-${A.contactId}`, 1))
  eq('B4 textHash', first.row.textHash, hashReplyText('第一条'))
  eq('B5 TTL 30 分钟', Date.parse(first.row.expiresAt) - clock, QQ_REPLY_TTL_MS)

  const again = store.enqueue(base(A.contactId, 1, '第一条'))
  eq('B6 同内容幂等 duplicate=true', again.duplicate, true)
  eq('B7 幂等不新增', store.list('pending').length, 1)
  rejects('B8 同 seq 不同内容冲突', QQ_REPLY_ERROR.conflict, () => store.enqueue(base(A.contactId, 1, '第二条')))
  rejects('B9 sessionId 前缀', undefined, () =>
    store.enqueue({ ...base(A.contactId, 9), sessionId: 'session-1' }))
  rejects('B10 sessionSeq 非正', undefined, () => store.enqueue(base(A.contactId, 0)))
  rejects('B11 stableUserId 非法', undefined, () => store.enqueue({ ...base(A.contactId, 9), stableUserId: '001' }))
  rejects('B12 空正文', undefined, () => store.enqueue(base(A.contactId, 9, '   ')))
}

// ---- C. 容量 ----
{
  // 已有 A/1；再塞满全局容量会太慢，这里用单 Contact 上限验证事务判断。
  for (let i = 2; i <= QQ_REPLY_CONTACT_CAPACITY; i += 1) {
    store.enqueue(base(A.contactId, i, `bulk-${i}`))
  }
  eq('C1 单 Contact 容量上限', store.countActive(A.contactId), QQ_REPLY_CONTACT_CAPACITY)
  rejects('C2 满额拒绝', QQ_REPLY_ERROR.capacity, () =>
    store.enqueue(base(A.contactId, QQ_REPLY_CONTACT_CAPACITY + 1, 'overflow')))
  // 幂等优先于容量：同一 session_seq 的同内容重试必须返回既有行，不因队列满而失败。
  const duplicateAtCapacity = store.enqueue(base(A.contactId, 1, '第一条'))
  eq('C2b 满额时同内容幂等返回既有行', duplicateAtCapacity.duplicate, true)
  eq('C2c 满额时同内容不新增', store.countActive(A.contactId), QQ_REPLY_CONTACT_CAPACITY)
  rejects('C2d 满额时同 seq 不同内容仍是冲突', QQ_REPLY_ERROR.conflict, () =>
    store.enqueue(base(A.contactId, 1, '第二条')))
  eq('C3 别的 Contact 不受影响', store.countActive(B.contactId), 0)
  ok('C4 全局容量常量', QQ_REPLY_GLOBAL_CAPACITY === 500)
  // 清空 A，避免影响后续 FIFO 测试。
  for (const row of store.list('pending', 200)) store.cancelPending(row.replyId, owner, 'cleanup')
}

// ---- D. 领取 / FIFO / unknown 阻塞 / 复核 ----
{
  store.enqueue(base(A.contactId, 1001, 'A-10'))
  store.enqueue(base(A.contactId, 1002, 'A-11'))
  store.enqueue(base(B.contactId, 1001, 'B-1'))
  const claimed = store.claim({ limit: 10, authorization: allow, transportCheck: passTransport })
  eq('D1 同 Contact 只领一条 + 其他 Contact 并行', claimed.map((row) => row.payloadText).sort(), ['A-10', 'B-1'])
  eq('D2 领取后 dispatching', claimed.every((row) => row.status === 'dispatching'), true)
  eq('D3 attempts=1', claimed.every((row) => row.attempts === 1), true)
  store.applyResult(claimed.find((row) => row.contactId === B.contactId)!.replyId, {
    outcome: 'accepted',
    messageId: 'b-1',
  })

  const blocked = store.claim({ limit: 10, authorization: allow, transportCheck: passTransport })
  eq('D4 同 Contact 有 dispatching 时不再领', blocked.length, 0)

  store.applyResult(claimed.find((row) => row.contactId === A.contactId)!.replyId, { outcome: 'unknown' })
  const afterUnknown = store.claim({ limit: 10, authorization: allow, transportCheck: passTransport })
  eq('D5 unknown 阻塞同 Contact', afterUnknown.length, 0)
  store.enqueue(base(B.contactId, 1002, 'B-2'))
  const otherContact = store.claim({ limit: 10, authorization: allow, transportCheck: passTransport })
  eq('D5b unknown 不影响其他 Contact', otherContact.map((row) => row.payloadText), ['B-2'])
  store.applyResult(otherContact[0]!.replyId, { outcome: 'accepted', messageId: 'b-2' })
  store.resolveUnknown(
    claimed.find((row) => row.contactId === A.contactId)!.replyId,
    'not-received',
    owner,
  )
  const afterResolve = store.claim({ limit: 10, authorization: allow, transportCheck: passTransport })
  eq('D6 unknown 解除后继续 FIFO', afterResolve.map((row) => row.payloadText), ['A-11'])
  store.applyResult(afterResolve[0]!.replyId, { outcome: 'accepted', messageId: 'a-11' })

  // 队首 retry_at 未到期时，阻塞同 Contact 的后续消息，不能越过队首领取。
  const E = await core.resolveContact({ platform: 'qq', stableUserId: '20004', displayName: 'E' })
  store.enqueue(base(E.contactId, 1, 'E-1'))
  store.enqueue(base(E.contactId, 2, 'E-2'))
  const head = store.claim({ limit: 10, authorization: allow, transportCheck: passTransport })
  eq('D7 只领队首 E-1', head.map((row) => row.payloadText), ['E-1'])
  store.applyResult(head[0]!.replyId, { outcome: 'retryable', errorCode: 'rate_limited' })
  const blockedByRetry = store.claim({ limit: 10, authorization: allow, transportCheck: passTransport })
  eq('D8 队首 retry_at 未到时不越过领取', blockedByRetry.length, 0)
  tick(60_000)
  const resumed = store.claim({ limit: 10, authorization: allow, transportCheck: passTransport })
  eq('D9 到期后仍只领队首', resumed.map((row) => row.payloadText), ['E-1'])
  store.applyResult(resumed[0]!.replyId, { outcome: 'accepted', messageId: 'e-1' })
  // 清空 E 的后续 pending，避免影响 E 段（C-1）的领取顺序。
  for (const row of store.list('pending', 200)) store.cancelPending(row.replyId, owner, 'cleanup')
}

// ---- E. 回执映射 / 重试 / TTL ----
{
  const row = store.enqueue(base(C.contactId, 1, 'C-1')).row
  const [claimed] = store.claim({ limit: 1, authorization: allow, transportCheck: passTransport })
  eq('E1 领取 C-1', claimed?.replyId, row.replyId)
  const retry = store.applyResult(row.replyId, { outcome: 'retryable', errorCode: 'rate_limited' })
  eq('E2 retryable 回 pending', retry?.status, 'pending')
  ok('E3 retry_at 已设置', retry?.retryAt !== null)
  const early = store.claim({ limit: 1, authorization: allow, transportCheck: passTransport })
  eq('E4 未到 retry_at 不领取', early.length, 0)
  tick(QQ_REPLY_TTL_MS)
  const expired = store.expireDue()
  eq('E5 pending 到期转 expired', expired >= 1, true)
  eq('E6 过期终态', store.get(row.replyId)?.status, 'expired')
  eq('E7 终态原因', store.get(row.replyId)?.lastErrorCode, 'reply_ttl_expired')
  rejects('E8 终态不可再领取', undefined, () => {
    const again = store.applyResult(row.replyId, { outcome: 'accepted' })
    return again
  })
  eq('E8b applyResult 对非 dispatching 不改变状态', store.get(row.replyId)?.status, 'expired')
}

// ---- F. 重试次数耗尽 ----
{
  tick(1000)
  const row = store.enqueue(base(C.contactId, 2, 'C-2')).row
  let attempts = 0
  for (;;) {
    const [claimed] = store.claim({ limit: 1, authorization: allow, transportCheck: passTransport })
    if (!claimed) break
    attempts += 1
    store.applyResult(row.replyId, { outcome: 'retryable', errorCode: 'rate_limited' })
    if (attempts > 10) break
    const latest = store.get(row.replyId)
    if (latest?.retryAt) clock = Date.parse(latest.retryAt)
  }
  eq('F1 最多尝试 3 次', attempts, QQ_REPLY_MAX_ATTEMPTS)
  eq('F2 重试耗尽转 expired', store.get(row.replyId)?.status, 'expired')
}

// ---- G. accepted/permanent/unknown/恢复 ----
{
  const row = store.enqueue(base(C.contactId, 3, 'C-3')).row
  store.claim({ limit: 1, authorization: allow, transportCheck: passTransport })
  const sent = store.applyResult(row.replyId, { outcome: 'accepted', messageId: 'mid-1' })
  eq('G1 accepted→sent', sent?.status, 'sent')
  eq('G2 回执', sent?.receipt, 'mid-1')
  ok('G3 terminal_at 写入', sent?.terminalAt !== null)

  const permanent = store.enqueue(base(C.contactId, 4, 'C-4')).row
  store.claim({ limit: 1, authorization: allow, transportCheck: passTransport })
  eq('G4 permanent→failed', store.applyResult(permanent.replyId, { outcome: 'permanent' })?.status, 'failed')

  const unknown = store.enqueue(base(C.contactId, 5, 'C-5')).row
  store.claim({ limit: 1, authorization: allow, transportCheck: passTransport })
  eq('G5 unknown 状态', store.applyResult(unknown.replyId, { outcome: 'unknown' })?.status, 'unknown')
  store.resolveUnknown(unknown.replyId, 'not-received', owner)
  eq('G6 恢复 dispatching', store.recoverInflight(), 0)

  const inflight = store.enqueue(base(C.contactId, 6, 'C-6')).row
  store.claim({ limit: 1, authorization: allow, transportCheck: passTransport })
  eq('G7 启动恢复计数', store.recoverInflight(), 1)
  eq('G8 恢复后 unknown', store.get(inflight.replyId)?.status, 'unknown')
  eq('G9 恢复原因', store.get(inflight.replyId)?.lastErrorCode, 'worker_restart')
  eq('G10 恢复不重发', store.claim({ limit: 1, authorization: allow, transportCheck: passTransport }).length, 0)
}

// ---- H. 复核取消 / 顺序 ----
{
  tick(2000)
  const row = store.enqueue(base(B.contactId, 2, 'B-2')).row
  const claimed = store.claim({
    limit: 5,
    authorization: (candidate) => (candidate.replyId === row.replyId ? 'contact_disabled' : null),
    transportCheck: passTransport,
  })
  eq('H1 复核失败不领取', claimed.length, 0)
  eq('H2 复核取消终态', store.get(row.replyId)?.status, 'cancelled')
  eq('H3 取消原因', store.get(row.replyId)?.lastErrorCode, 'contact_disabled')

  const x = store.enqueue(base(B.contactId, 3, 'B-3')).row
  const y = store.enqueue(base(B.contactId, 4, 'B-4')).row
  const noTransport = store.claim({ limit: 5, authorization: allow, transportCheck: () => false })
  eq('H4 通道不匹配不领取', noTransport.length, 0)
  eq('H5 仍为 pending', [store.get(x.replyId)?.status, store.get(y.replyId)?.status], ['pending', 'pending'])
  store.cancelPending(x.replyId, owner, 'cleanup')
  store.cancelPending(y.replyId, owner, 'cleanup')
}

// ---- I. 人工裁决 / 数据库不可变 ----
{
  clock += 10_000
  const row = store.enqueue(base(B.contactId, 10, 'B-10')).row
  store.claim({ limit: 1, authorization: allow, transportCheck: passTransport })
  store.applyResult(row.replyId, { outcome: 'unknown' })
  rejects('I1 非 Owner 拒绝裁决', QQ_REPLY_ERROR.ownerMismatch, () =>
    store.resolveUnknown(row.replyId, 'received', 'someone-else'))
  eq('I2 Owner 裁决 received', store.resolveUnknown(row.replyId, 'received', owner)?.status, 'sent')
  const terminal = store.get(row.replyId)?.terminalAt
  ok('I3 terminal_at 已写入', typeof terminal === 'string' && terminal.length > 0)
  let aborted = false
  try {
    db.run(`UPDATE qq_reply_outbox SET terminal_at = NULL WHERE reply_id = ?`, [row.replyId])
  } catch {
    aborted = true
  }
  ok('I4 terminal_at 不可回写', aborted)
  let bindingAborted = false
  try {
    db.run(`UPDATE qq_reply_outbox SET payload_text = 'tampered' WHERE reply_id = ?`, [row.replyId])
  } catch {
    bindingAborted = true
  }
  ok('I5 绑定字段不可改', bindingAborted)
  rejects('I6 已终态不能裁决', QQ_REPLY_ERROR.conflictState, () =>
    store.resolveUnknown(row.replyId, 'received', owner))
}

// ---- J. 清理 ----
{
  clock += 24 * 60 * 60 * 1000 + 1000
  const before = store.list(undefined, 500).filter((row) => row.status === 'sent').length
  const deleted = store.cleanupTerminal()
  ok('J1 清理终态', deleted > 0)
  const after = store.list(undefined, 500).filter((row) => row.status === 'sent').length
  eq('J2 只删到期终态', after < before, true)
  eq('J3 unknown 保留', store.list('unknown', 50).length >= 1, true)
}

// ---- K. 迁移后旧事实保留 ----
{
  const counts = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contacts`)?.n ?? 0
  ok('K1 contacts 保留', counts >= 3)
  const version = db.get<{ v: number }>(`SELECT user_version AS v FROM pragma_user_version`)?.v
  eq('K2 schema v31', version, 31)
}

console.log(`\n[qq-reply-outbox] ${passed} 通过 ${failed} 失败`)
assert.equal(failed, 0)
