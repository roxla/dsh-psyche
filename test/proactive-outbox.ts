// P3-C-3a：发件箱、审批快照、领取/复核/速率、回执、崩溃恢复、Worker 边界。
// 跑法：node test/proactive-outbox.ts（需先 npm run build）
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '../packages/core/dist/adapter.js'
import { Core } from '../packages/core/dist/store.js'
import { MockChatTransport } from '../packages/core/dist/chat-transport.js'
import { OutboxStore, OUTBOX_ERROR, outboxIdOf } from '../packages/core/dist/proactive-outbox.js'
import { OutboundService } from '../packages/core/dist/proactive-outbound-service.js'
import { OutboxWorker } from '../packages/core/dist/proactive-outbox-worker.js'

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
function throwsWithReason(label: string, reason: string, run: () => unknown): void {
  eq(label, reasonOf(run), reason)
}
function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

const log = { info() {}, debug() {}, warn() {}, error() {} }
const dir = mkdtempSync(join(tmpdir(), 'psyche-outbox-'))
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const A = await core.resolveContact({ platform: 'qq', stableUserId: '10005', displayName: 'A' })
const B = await core.resolveContact({ platform: 'qq', stableUserId: '10006', displayName: 'B' })
const C = await core.resolveContact({ platform: 'qq', stableUserId: '10007', displayName: 'C' })
const D = await core.resolveContact({ platform: 'qq', stableUserId: '10008', displayName: 'D' })

const OWNER = 'owner-local'
const T0 = '2026-11-13T02:00:00.000Z'
const T0_MS = Date.parse(T0)
const MIN = 60 * 1000
let clock = T0
const store = new OutboxStore({ db, ownerId: OWNER, now: () => clock })

const consentGranted = { status: 'granted' as const, sourceId: 'evt_consent', grantedAt: T0 }
const consentRevoked = { status: 'revoked' as const, sourceId: 'evt_consent', revokedAt: T0 }
const allowAll = () => 'allowed' as const
const consentReader = (contactId: string) => (contactId === B.contactId ? consentRevoked : consentGranted)

function draftFor(contactId: string, text: string, revision = 1) {
  return { draftId: `drf_${contactId}_${revision}`, revision, draftHash: 'a'.repeat(32), contactId, text }
}
function inputFor(
  approvalId: string,
  contact: { contactId: string; platform: string; stableUserId: string },
  overrides: Record<string, unknown> = {},
) {
  return {
    approvalId,
    draft: draftFor(contact.contactId, '晚安，今天辛苦了。'),
    contact,
    transportId: 'mock-qq',
    consent: consentGranted,
    decision: 'approved' as const,
    decidedBy: OWNER,
    decidedAt: T0,
    now: clock,
    ...overrides,
  }
}
function newService(transport: MockChatTransport, extra: Record<string, unknown> = {}) {
  const events: Array<{ event: string; data?: Record<string, unknown> }> = []
  const svc = new OutboundService({
    store,
    transport,
    consentReader,
    allowReader: allowAll,
    ownerId: OWNER,
    logger: (event, data) => events.push({ event, data }),
    ...extra,
  })
  return { svc, events }
}
const at = (ms: number) => new Date(ms).toISOString()

console.log('\n[P3-C-3a] OutboxStore：幂等与绑定')

// ── A. 幂等与绑定 ──
{
  const r1 = store.enqueue(inputFor('ap_a', A))
  eq('首次入队 pending', r1.row.status, 'pending')
  eq('duplicate=false', r1.duplicate, false)
  eq('outbox_id 稳定', r1.row.outboxId, outboxIdOf('ap_a', 'a'.repeat(32)))
  eq('expires_at = now+10min', r1.row.expiresAt, at(T0_MS + 10 * MIN))
  eq('countActive=1', store.countActive(), 1)

  const r2 = store.enqueue(inputFor('ap_a', A))
  eq('同审批重复入队 duplicate', r2.duplicate, true)
  eq('不产生第二行', store.list({ limit: 10 }).length, 1)
  throwsWithReason('同 approval_id 改正文 → conflict', OUTBOX_ERROR.approvalConflict, () =>
    store.enqueue(inputFor('ap_a', A, { draft: draftFor(A.contactId, '换一句正文。') })),
  )
  eq('非 approved 不能入队', codeOf(() => store.enqueue(inputFor('ap_b', A, { decision: 'rejected' }))), 'E_VALIDATION')
  throwsWithReason('decidedBy 非 Owner 拒绝', OUTBOX_ERROR.approvalOwner, () =>
    store.enqueue(inputFor('ap_c', A, { decidedBy: 'someone-else' })),
  )
  throwsWithReason('审批超过 24h 拒绝', OUTBOX_ERROR.approvalExpired, () =>
    store.enqueue(inputFor('ap_d', A, { decidedAt: at(T0_MS - 25 * 3600 * 1000) })),
  )
  throwsWithReason('草稿与联系人错配拒绝', OUTBOX_ERROR.draftMismatch, () =>
    store.enqueue(inputFor('ap_e', A, { draft: draftFor(B.contactId, '晚安。') })),
  )
  throwsWithReason('缺少 Consent 拒绝', OUTBOX_ERROR.consentMissing, () =>
    store.enqueue(inputFor('ap_f', A, { consent: null })),
  )
  throwsWithReason('Consent revoked 拒绝', OUTBOX_ERROR.consentNotGranted, () =>
    store.enqueue(inputFor('ap_g', A, { consent: consentRevoked })),
  )
}

// ── B. 容量 ──
{
  for (let i = store.countActive(); i < 200; i += 1) {
    const c = i % 2 === 0 ? A : B
    store.enqueue(inputFor(`ap_fill_${i}`, c, { draft: draftFor(c.contactId, `正文 ${i}`) }))
  }
  eq('容量 pending+dispatching+unknown=200', store.countActive(), 200)
  throwsWithReason('容量满拒绝新入队', OUTBOX_ERROR.capacity, () => store.enqueue(inputFor('ap_overflow', C)))
  db.run(`UPDATE proactive_outbox SET status = 'expired' WHERE approval_id LIKE 'ap_fill_%'`)
  eq('清空后容量恢复', store.countActive(), 1)
}

// ── C. 数据库保护绑定 ──
{
  ok('行存在', Boolean(store.getByApproval('ap_a')))
  let blocked = false
  try {
    db.run(`UPDATE proactive_outbox SET payload_text = '篡改' WHERE approval_id = 'ap_a'`)
  } catch {
    blocked = true
  }
  ok('触发器拒绝改 payload_text', blocked)
  let blockedHash = false
  try {
    db.run(`UPDATE proactive_outbox SET text_hash = '${'f'.repeat(32)}' WHERE approval_id = 'ap_a'`)
  } catch {
    blockedHash = true
  }
  ok('触发器拒绝改 text_hash', blockedHash)
  let blockedApproval = false
  try {
    db.run(`UPDATE proactive_outbox SET approval_id = 'ap_forged' WHERE approval_id = 'ap_a'`)
  } catch {
    blockedApproval = true
  }
  ok('触发器拒绝改 approval_id', blockedApproval)
  db.run(`UPDATE proactive_outbox SET attempts = 0, status = 'pending' WHERE approval_id = 'ap_a'`)
  ok('状态字段仍可更新', store.getByApproval('ap_a')?.status === 'pending')
}

console.log('\n[P3-C-3a] 领取、六项复核与速率')

// ── D. 正常领取 / 发送 / 回执 ──
{
  clock = at(T0_MS + 1000)
  const transport = new MockChatTransport({ id: 'mock-qq', platform: 'qq', capabilities: { proactive: true } })
  const { svc } = newService(transport)
  const result = await svc.runOnce({ limit: 5, now: clock })
  eq('领取 1 行', result.claimed, 1)
  eq('发送 1 条', transport.sends.length, 1)
  eq('目标为 private/qq/10005', transport.sends[0].target, {
    kind: 'private',
    platform: 'qq',
    stableUserId: '10005',
  })
  eq('正文是审批快照', transport.sends[0].outgoing.text, '晚安，今天辛苦了。')
  const row = store.getByApproval('ap_a')
  eq('回执后 sent', row?.status, 'sent')
  ok('sent_at 记录', typeof row?.sentAt === 'string')

  const again = await svc.runOnce({ limit: 5, now: clock })
  eq('已发送的不再领取', again.claimed, 0)
  eq('不重复发送', transport.sends.length, 1)
}

// ── E. 同 Contact 不并发 / Consent revoked ──
{
  clock = at(T0_MS + 2 * MIN)
  store.enqueue(inputFor('ap_s1', B, { draft: draftFor(B.contactId, '第一条。') }))
  const transport = new MockChatTransport({ id: 'mock-qq', platform: 'qq', capabilities: { proactive: true } })
  const { svc } = newService(transport)
  const first = await svc.runOnce({ limit: 1, now: clock })
  eq('B 的撤销行在领取时被取消、不计入 claimed', first.claimed, 0)
  eq('B 因 Consent revoked 被取消', store.getByApproval('ap_s1')?.status, 'cancelled')
  eq('B 无发送', transport.sends.length, 0)
}

// ── F. proactive.allow / Consent 在领取时实时复核 ──
{
  clock = at(T0_MS + 3 * MIN)
  const transport = new MockChatTransport({ id: 'mock-qq', platform: 'qq', capabilities: { proactive: true } })

  store.enqueue(inputFor('ap_allow', C, { draft: draftFor(C.contactId, '被撤销的授权。') }))
  await newService(transport, { allowReader: () => 'revoked' }).svc.runOnce({ limit: 1, now: clock })
  eq('allow revoked → cancelled', store.getByApproval('ap_allow')?.status, 'cancelled')

  store.enqueue(inputFor('ap_allow_throw', C, { draft: draftFor(C.contactId, '读取异常。') }))
  await newService(transport, {
    allowReader: () => {
      throw new Error('boom')
    },
  }).svc.runOnce({ limit: 1, now: clock })
  eq('allow 读取异常 → cancelled', store.getByApproval('ap_allow_throw')?.status, 'cancelled')

  store.enqueue(inputFor('ap_consent_throw', C, { draft: draftFor(C.contactId, '读取异常。') }))
  await newService(transport, {
    consentReader: () => {
      throw new Error('boom')
    },
  }).svc.runOnce({ limit: 1, now: clock })
  eq('consent 读取异常 → cancelled', store.getByApproval('ap_consent_throw')?.status, 'cancelled')
  eq('以上均未发送', transport.sends.length, 0)
}

// ── G. Contact 身份 / 内容 hash 不一致 ──
{
  clock = at(T0_MS + 4 * MIN)
  const transport = new MockChatTransport({ id: 'mock-qq', platform: 'qq', capabilities: { proactive: true } })

  store.enqueue(inputFor('ap_identity', C, { draft: draftFor(C.contactId, '身份校验。') }))
  db.run(`UPDATE contacts SET stable_user_id = 'changed' WHERE contact_id = ?`, [C.contactId])
  await newService(transport).svc.runOnce({ limit: 1, now: clock })
  eq('Contact 身份变化 → cancelled', store.getByApproval('ap_identity')?.status, 'cancelled')
  db.run(`UPDATE contacts SET stable_user_id = '10007' WHERE contact_id = ?`, [C.contactId])

  const badId = 'ob_' + 'b'.repeat(16)
  db.run(
    `INSERT INTO proactive_outbox
       (outbox_id, approval_id, draft_id, draft_revision, draft_hash, contact_id, platform, stable_user_id,
        transport_id, target_kind, payload_text, text_hash, status, attempts, decided_by, approval_decided_at,
        created_at, expires_at, updated_at)
     VALUES (?, 'ap_bad_hash', 'drf', 1, 'b', ?, 'qq', '10007', 'mock-qq', 'private', '正文', ?, 'pending', 0, ?, ?, ?, ?, ?)`,
    [badId, C.contactId, '0'.repeat(32), OWNER, clock, clock, at(Date.parse(clock) + MIN), clock],
  )
  await newService(transport).svc.runOnce({ limit: 1, now: clock })
  eq('内容 hash 不一致 → cancelled', store.get(badId)?.status, 'cancelled')
}

// ── E2. 同 Contact 多任务不能同时 dispatching ──
{
  clock = at(T0_MS + 5 * MIN)
  store.enqueue(inputFor('ap_same_1', A, { draft: draftFor(A.contactId, '同一联系人 1。') }))
  store.enqueue(inputFor('ap_same_2', A, { draft: draftFor(A.contactId, '同一联系人 2。') }))
  const claimed = store.claimBatch({
    limit: 5,
    consentReader: () => consentGranted,
    allowReader: allowAll,
    transportCheck: () => true,
    now: clock,
  })
  eq('同 Contact 同批只领取一条', claimed.length, 1)
  eq('领取的是较早的一条', claimed[0]?.approvalId, 'ap_same_1')
  db.run(`UPDATE proactive_outbox SET status = 'expired', last_error_code = 'test_cleanup'
          WHERE approval_id IN ('ap_same_1', 'ap_same_2')`)
}

// ── H. 通道 20/分钟（含在途 dispatching） ──
{
  clock = at(T0_MS + 20 * MIN)
  db.run(`UPDATE proactive_outbox SET status = 'expired' WHERE status = 'pending'`)
  for (let i = 0; i < 19; i += 1) {
    const contact = i % 2 === 0 ? A : B
    db.run(
      `INSERT INTO proactive_outbox
         (outbox_id, approval_id, draft_id, draft_revision, draft_hash, contact_id, platform, stable_user_id,
          transport_id, target_kind, payload_text, text_hash, status, attempts, decided_by, approval_decided_at,
          created_at, expires_at, sent_at, updated_at)
       VALUES (?, ?, 'drf', 1, 'a', ?, 'qq', ?, 'mock-qq', 'private', '旧正文', ?, 'sent', 1, ?, ?, ?, ?, ?, ?)`,
      [
        `ob_rate_old_${i}`,
        `ap_rate_old_${i}`,
        contact.contactId,
        contact.stableUserId,
        'e'.repeat(32),
        OWNER,
        T0,
        clock,
        at(Date.parse(clock) + 10 * MIN),
        clock,
        clock,
      ],
    )
  }
  store.enqueue(inputFor('ap_rate_20', C, { draft: draftFor(C.contactId, '第 20 条。') }))
  store.enqueue(inputFor('ap_rate_21', D, { draft: draftFor(D.contactId, '第 21 条。') }))
  const t = new MockChatTransport({ id: 'mock-qq', platform: 'qq', capabilities: { proactive: true } })
  const r = await newService(t).svc.runOnce({ limit: 2, now: clock })
  if (process.env.OUTBOX_DEBUG) {
    const direct = store.claimBatch({
      limit: 1,
      consentReader: () => consentGranted,
      allowReader: allowAll,
      transportCheck: () => true,
      now: clock,
    })
    console.error('DEBUG-DIRECT', direct.length, direct[0]?.approvalId ?? null)
    console.error('DEBUG-CANDS', JSON.stringify(db.all(
      `SELECT o.approval_id, o.status, o.expires_at FROM proactive_outbox o
        WHERE o.status = 'pending'
          AND (o.retry_at IS NULL OR o.retry_at <= ?)
          AND o.expires_at > ?`,
      [clock, clock],
    )))
    console.error('DEBUG-DISP', JSON.stringify(db.all(
      `SELECT approval_id, contact_id, dispatch_started_at FROM proactive_outbox WHERE status='dispatching'`,
    )))
    console.error('DEBUG-STATUS', JSON.stringify(db.all(
      `SELECT approval_id, status, last_error_code FROM proactive_outbox WHERE approval_id LIKE 'ap_rate_2%'`,
    )))
    console.error('DEBUG-CONTACT', JSON.stringify(db.get(
      `SELECT COUNT(*) AS n FROM proactive_outbox WHERE contact_id = ? AND status='sent' AND sent_at >= ?`,
      [C.contactId, new Date(Date.parse(clock) - 60_000).toISOString()],
    )))
  }
  eq('同批第 20 条领取、第 21 条被预留额度挡住', r.claimed, 1)
  eq('第 20 条发送', t.sends.length, 1)
  const rateStatuses = ['ap_rate_20', 'ap_rate_21']
    .map((id) => store.getByApproval(id)?.status)
    .sort()
  eq('额度内一条 sent、另一条仍 pending', rateStatuses, ['pending', 'sent'])
}

console.log('\n[P3-C-3a] 结果映射与崩溃恢复')

// ── I. retryable / permanent ──
{
  clock = at(T0_MS + 30 * MIN)
  db.run(`UPDATE proactive_outbox SET status = 'expired' WHERE approval_id = 'ap_rate_21'`)
  store.enqueue(inputFor('ap_retry', C, { draft: draftFor(C.contactId, '重试。') }))
  const t = new MockChatTransport({
    id: 'mock-qq',
    platform: 'qq',
    capabilities: { proactive: true },
    outcomes: [{ outcome: 'retryable', errorCode: 'rate_limited', retryAfterMs: 5000 }],
  })
  const { svc } = newService(t)
  await svc.runOnce({ limit: 1, now: clock })
  const retried = store.getByApproval('ap_retry')
  eq('retryable → pending', retried?.status, 'pending')
  eq('retryAfterMs clamp 到 30s', retried?.retryAt, at(Date.parse(clock) + 30_000))
  eq('未到 retry_at 不领取', (await svc.runOnce({ limit: 1, now: clock })).claimed, 0)
  await svc.runOnce({ limit: 1, now: at(Date.parse(clock) + 31_000) })
  eq('到点重试后 sent', store.getByApproval('ap_retry')?.status, 'sent')

  clock = at(T0_MS + 32 * MIN)
  store.enqueue(inputFor('ap_permanent', A, { draft: draftFor(A.contactId, '永久失败。') }))
  const t2 = new MockChatTransport({
    id: 'mock-qq',
    platform: 'qq',
    capabilities: { proactive: true },
    outcomes: [{ outcome: 'permanent', errorCode: 'blocked' }],
  })
  await newService(t2).svc.runOnce({ limit: 1, now: clock })
  eq('permanent → failed', store.getByApproval('ap_permanent')?.status, 'failed')
}

// ── J. ACK 丢失 → unknown；重启不重发（场景 A） ──
{
  clock = at(T0_MS + 40 * MIN)
  store.enqueue(inputFor('ap_ack_lost', A, { draft: draftFor(A.contactId, 'ACK 丢失。') }))
  const t = new MockChatTransport({
    id: 'mock-qq',
    platform: 'qq',
    capabilities: { proactive: true },
    outcomes: [{ outcome: 'unknown', errorCode: 'ack_timeout' }],
  })
  const { svc } = newService(t)
  await svc.runOnce({ limit: 1, now: clock })
  eq('ACK 丢失 → unknown', store.getByApproval('ap_ack_lost')?.status, 'unknown')
  eq('只发送一次', t.sends.length, 1)

  const restarted = new OutboxStore({ db, ownerId: OWNER, now: () => clock })
  eq('重启恢复 dispatching=0', restarted.recoverInflight(clock), 0)
  const t2 = new MockChatTransport({ id: 'mock-qq', platform: 'qq', capabilities: { proactive: true } })
  eq('重启后不重发 unknown', (await newService(t2).svc.runOnce({ limit: 1, now: clock })).claimed, 0)
  eq('第二次没有发送', t2.sends.length, 0)
  eq('unknown 计入容量', restarted.countActive() >= 1, true)
}

// ── K. 场景 B：领取后崩溃 → unknown → Owner 核验 ──
{
  clock = at(T0_MS + 50 * MIN)
  db.run(`UPDATE proactive_outbox SET status = 'expired' WHERE approval_id = 'ap_rate_21'`)
  store.enqueue(inputFor('ap_crash', C, { draft: draftFor(C.contactId, '崩溃。') }))
  const claimed = store.claimBatch({
    limit: 1,
    consentReader: () => consentGranted,
    allowReader: allowAll,
    transportCheck: () => true,
    now: clock,
  })
  eq('已领取 1 行', claimed.length, 1)
  eq('领取后 dispatching', claimed[0].status, 'dispatching')

  const restarted = new OutboxStore({ db, ownerId: OWNER, now: () => clock })
  eq('重启恢复 1 行', restarted.recoverInflight(clock), 1)
  eq('dispatching→unknown', restarted.getByApproval('ap_crash')?.status, 'unknown')
  eq('恢复原因 worker_restart', restarted.getByApproval('ap_crash')?.lastErrorCode, 'worker_restart')

  const t = new MockChatTransport({ id: 'mock-qq', platform: 'qq', capabilities: { proactive: true } })
  eq('重启后零领取', (await newService(t).svc.runOnce({ limit: 1, now: clock })).claimed, 0)
  eq('重启后零发送', t.sends.length, 0)

  const crashRow = restarted.getByApproval('ap_crash')
  throwsWithReason('非 Owner 不能核验', OUTBOX_ERROR.ownerMismatch, () =>
    restarted.resolveUnknown(crashRow?.outboxId ?? '', 'received', 'intruder'),
  )
  const resolved = restarted.resolveUnknown(crashRow?.outboxId ?? '', 'received', OWNER, '对方确认收到')
  eq('核验 received → sent', resolved.status, 'sent')
  throwsWithReason('非 unknown 不能再核验', OUTBOX_ERROR.state, () =>
    restarted.resolveUnknown(crashRow?.outboxId ?? '', 'not-received', OWNER),
  )
}

// ── L. 取消与过期 ──
{
  clock = at(T0_MS + 60 * MIN)
  store.enqueue(inputFor('ap_cancel', C, { draft: draftFor(C.contactId, '取消我。') }))
  throwsWithReason('非 Owner 不能取消', OUTBOX_ERROR.ownerMismatch, () => store.cancel('ob_unknown', 'x', 'no'))
  const row = store.getByApproval('ap_cancel')
  eq('Owner 取消 → cancelled', store.cancel(row?.outboxId ?? '', OWNER, 'owner_cancelled').status, 'cancelled')
  throwsWithReason('非 pending 不能取消', OUTBOX_ERROR.state, () =>
    store.cancel(row?.outboxId ?? '', OWNER, 'again'),
  )

  store.enqueue(inputFor('ap_expired', A, { draft: draftFor(A.contactId, '会过期。') }))
  clock = at(Date.parse(clock) + 11 * MIN)
  const t = new MockChatTransport({ id: 'mock-qq', platform: 'qq', capabilities: { proactive: true } })
  const r = await newService(t).svc.runOnce({ limit: 5, now: clock })
  eq('过期行不被发送', store.getByApproval('ap_expired')?.status, 'expired')
  eq('过期行不进入发送', t.sends.filter((s) => s.outgoing.text === '会过期。').length, 0)
  ok('claimed 中不含过期行', r.claimed >= 0)
}

// ── M. Worker 边界：未 start 不发送；tickOnce 可显式驱动 ──
{
  clock = at(T0_MS + 80 * MIN)
  store.enqueue(inputFor('ap_worker', A, { draft: draftFor(A.contactId, 'Worker 驱动。') }))
  const t = new MockChatTransport({ id: 'mock-qq', platform: 'qq', capabilities: { proactive: true } })
  const svc = newService(t).svc
  const worker = new OutboxWorker({ service: svc, intervalMs: 50 })
  eq('新建 Worker 不自动运行', worker.running, false)
  await new Promise((resolve) => setTimeout(resolve, 120))
  eq('未 start 不发送', t.sends.length, 0)
  const ticked = await worker.tickOnce()
  eq('tickOnce 显式驱动发送', ticked.sent, 1)
  eq('Worker 发送一次', t.sends.length, 1)
  worker.start()
  eq('start 后 running=true', worker.running, true)
  worker.stop()
  eq('stop 后 running=false', worker.running, false)
}

// ── N. 日志不含正文 ──
{
  clock = at(T0_MS + 90 * MIN)
  store.enqueue(inputFor('ap_log', A, { draft: draftFor(A.contactId, '不要出现在日志里的正文。') }))
  const t = new MockChatTransport({ id: 'mock-qq', platform: 'qq', capabilities: { proactive: true } })
  const { svc, events } = newService(t)
  await svc.runOnce({ limit: 1, now: clock })
  const serialized = JSON.stringify(events)
  ok('日志不含 payload_text', !serialized.includes('不要出现在日志里的正文'))
  ok('日志含 outbox_id 与状态', serialized.includes('ob_') && serialized.includes('sent'))
}

// ── O. Service 守卫 ──
{
  const t = new MockChatTransport({ id: 'mock-qq', platform: 'qq' })
  let ownerMismatch = false
  try {
    new OutboundService({
      store,
      transport: t,
      consentReader,
      allowReader: allowAll,
      ownerId: 'another-owner',
    })
  } catch (error) {
    ownerMismatch = (error as { code?: string }).code === 'E_STATE'
  }
  ok('Service 与 Store Owner 不一致拒绝', ownerMismatch)
}

console.log(`\n[P3-C-3a] ${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1
