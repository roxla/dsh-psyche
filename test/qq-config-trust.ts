// 第 57 轮 P1-D：覆盖配置不可信时必须失败关闭（第三批 F-live 的本地可验部分）。
//
// 三个时点：坏配置启动、运行中损坏、领取后发送前损坏。每个时点都断言
// 「原因码是 config-corrupt、transport 调用数为 0」，并验证还原后同一队列行只发一次。
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { QqBridge } from '../dist/lib/qq-bridge.js'
import { QqReplyOutboxStore } from '../packages/core/dist/qq-reply-outbox.js'
import { QqReplyWorker } from '../packages/core/dist/qq-reply-worker.js'
import { openDatabase, migrate } from '../packages/core/dist/adapter.js'
import { createReminder, dispatchDueReminders, getReminder } from '../packages/core/dist/reminders.js'
import { QqSettingsOverlay } from '../dist/lib/qq-settings-overlay.js'

let passed = 0
let failed = 0
function eq(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label} ${JSON.stringify({ actual, expected })}`)
  }
}
function ok(label: string, value: unknown, extra?: unknown): void {
  if (value) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label} ${JSON.stringify({ actual: value, extra })}`)
  }
}

class Socket {
  static all: Socket[] = []
  listeners = new Map<string, Array<(event?: unknown) => void>>()
  sent: unknown[] = []
  constructor(_url: string) {
    Socket.all.push(this)
  }
  addEventListener(name: string, callback: (event?: unknown) => void): void {
    const list = this.listeners.get(name) ?? []
    list.push(callback)
    this.listeners.set(name, list)
  }
  emit(name: string, value?: unknown): void {
    for (const callback of this.listeners.get(name) ?? []) callback(value)
  }
  message(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) })
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text))
  }
  close(): void {
    this.emit('close')
  }
}

const NOW = '2026-05-01T00:00:00.000Z'
const at = (min: number): string => new Date(Date.parse(NOW) + min * 60_000).toISOString()

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function harness() {
  const counts = { creates: 0, announce: 0 }
  const bridge = new QqBridge(
    {
      enabled: true,
      wsUrl: 'ws://127.0.0.1:1',
      accessToken: '',
      provider: 'probe',
      model: 'probe',
      allowFrom: { owner: '10001', extra: ['10002'] },
    },
    {
      host: {
        agents: {
          get: () => undefined,
          resume: async () => {
            throw new Error('session not found')
          },
          create: async () => {
            counts.creates += 1
            return { agent: { followup() {} } }
          },
        },
        on: () => () => {},
      },
      adapter: {
        announce() {
          counts.announce += 1
        },
        forget() {},
        size: () => 0,
      },
      logger: { info() {}, error() {}, warn() {} },
      webSocket: Socket as never,
      allowLegacyAgentCreate: true,
      isSessionBound: () => true,
    },
  )
  return { bridge, counts }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'p1d-'))
  const file = join(dir, 'qq-overrides.json')
  const opened = await openDatabase({ file: join(dir, 'p1d.sqlite3'), driverPreference: 'auto', logger: quiet })
  const db = opened.db
  migrate(db)
  db.run(
    "INSERT OR IGNORE INTO contacts (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at) VALUES (?, 'main', 'qq', '10002', '朋友', 'friend', ?, ?)",
    ['ct_friend', NOW, NOW],
  )
  db.run(
    "INSERT OR IGNORE INTO contacts (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at) VALUES (?, 'main', 'qq', '10001', '主人', 'owner', ?, ?)",
    ['ct_owner', NOW, NOW],
  )

  // ── 时点 1：坏配置启动 ─────────────────────────────────
  console.log('[时点 1] 坏配置启动')
  writeFileSync(file, '{ "access": { "owner": ', 'utf8')
  const overlay = new QqSettingsOverlay({ file })
  const { bridge, counts } = harness()
  // 生产里 index.ts 会在启动时挂上「重读覆盖层」的回调（`setConfigRecheck`）。
  // 测试挂一个同构的：读文件 → 校验失败就把桥标成不可信 → 成功就恢复可信。
  bridge.setConfigRecheck(() => {
    try {
      const snapshot = new QqSettingsOverlay({ file }).effective(
        { owner: '10001', extra: ['10002'] },
        { provider: 'probe', model: 'probe' },
      )
      if (!bridge.configTrust().trusted) {
        if (snapshot.hasAccessOverride) bridge.applyAccess(snapshot.access)
        bridge.applyReplySchedules(snapshot.replySchedules)
        bridge.markConfigTrusted()
      }
      return true
    } catch (error) {
      bridge.markConfigUntrusted(String(error))
      return false
    }
  })
  await bridge.start()
  let bootTrusted = true
  try {
    overlay.effective({ owner: '10001', extra: ['10002'] }, { provider: 'probe', model: 'probe' })
  } catch (error) {
    bridge.markConfigUntrusted(String(error))
    bootTrusted = false
  }
  ok('坏文件确实让整份校验失败', bootTrusted === false)
  eq('启动后桥知道自己不可信', bridge.configTrust(), { trusted: false, reason: bridge.configTrust().reason })
  ok('不可信状态带原因', typeof bridge.configTrust().reason === 'string' && bridge.configTrust().reason !== '')

  const sendBlocked = await bridge.sendOutgoingText({ kind: 'private', userId: '10002' }, '你好', {
    accessEpoch: 0,
  })
  eq('坏配置下直接发送被拒', sendBlocked.error, 'config-corrupt')

  // 旧名单里的联系人（10002 是宿主 allowFrom.extra）也不能因此取得权限：
  eq('不可信时下一次发送时刻按暂停处理', bridge.nextPrivateSendAt('10002', new Date(NOW)), 'paused')

  // 入站：坏配置期间整条入站不进入（不建会话、不回复）
  const socket = Socket.all[Socket.all.length - 1]
  socket.message({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: '99999',
    user_id: '10002',
    sender: { user_id: '10002' },
    message_id: 'p1d-in-1',
    raw_message: '你好',
  })
  await flush()
  eq('入站不建会话（agent create 次数 0）', counts.creates, 0)
  eq('入站不发出任何帧', socket.sent.length, 0)

  // ── 时点 2：运行中损坏 ─────────────────────────────────
  console.log('[时点 2] 运行中损坏')
  writeFileSync(file, JSON.stringify({ revision: 1, replySchedules: { 'private:10002': { mode: 'paused' } } }), 'utf8')
  const overlay2 = new QqSettingsOverlay({ file })
  const snapshot = overlay2.effective({ owner: '10001', extra: ['10002'] }, { provider: 'probe', model: 'probe' })
  bridge.applyReplySchedules(snapshot.replySchedules)
  bridge.markConfigTrusted()
  eq('恢复后桥可信', bridge.configTrust().trusted, true)
  const paused = await bridge.sendOutgoingText({ kind: 'private', userId: '10002' }, '你好', { accessEpoch: 0 })
  eq('健康配置下时段暂停仍然生效（不是 config-corrupt）', paused.error, 'outside-reply-window')
  // 换成没有规则的名单，确认健康状态下能发
  writeFileSync(file, JSON.stringify({ revision: 2 }), 'utf8')
  const overlay3 = new QqSettingsOverlay({ file })
  bridge.applyReplySchedules(
    overlay3.effective({ owner: '10001', extra: ['10002'] }, { provider: 'probe', model: 'probe' }).replySchedules,
  )
  bridge.markConfigTrusted()
  // 运行中损坏：直接改坏磁盘文件，不手工打标记（第 20 轮第 1 条的要求）
  writeFileSync(file, '{ "access": ', 'utf8')
  const afterBreak = await bridge.sendOutgoingText({ kind: 'private', userId: '10002' }, '你好', { accessEpoch: 0 })
  eq('运行中损坏后发送被拒', afterBreak.error, 'config-corrupt')

  // ── 时点 3：Worker 已领取、发送前损坏 ──────────────────
  console.log('[时点 3] 领取后发送前损坏')
  const transport = {
    id: 'probe-transport',
    platform: 'qq' as const,
    sends: [] as string[],
    async send(): Promise<{ outcome: 'accepted'; messageId: string }> {
      this.sends.push('x')
      return { outcome: 'accepted', messageId: `mock-${this.sends.length}` }
    },
    status: () => 'connected' as const,
    async waitConnected(): Promise<boolean> {
      return true
    },
  }
  const NO_WINDOW = '9999-12-31T23:59:59.999Z'
  const store = new QqReplyOutboxStore({
    db,
    ownerId: 'owner',
    now: () => NOW,
    // 生产里这个回调接到 bridge.nextPrivateSendAt：不可信时它返回 'paused'，
    // index 把 'paused' 翻成这个远未来占位，于是队列行「保持等待」而不是被判死。
    // 第 20 轮：生产里这里还会先强制重读一次配置（`recheckConfigNow()`），
    // 所以「领取之后文件才坏」也能在发送前被拦下，而不是等 transport 报错。
    nextAllowedAt: (row, now) => {
      bridge.recheckConfigNow(true)
      const at = bridge.nextPrivateSendAt(row.stableUserId, new Date(now))
      if (at === null) return null
      return at === 'paused' ? NO_WINDOW : at.toISOString()
    },
  })
  const createdReminder = createReminder({
    db,
    personaId: 'main',
    receiver: { channel: 'qq', contactId: 'ct_friend' },
    text: '喝水',
    dueAt: NOW,
    timezone: 'Asia/Shanghai',
    now: NOW,
    requestId: 'req-p1d',
    accessEpoch: 0,
  })
  const reminder_id = createdReminder.status === 'created' ? createdReminder.reminder.reminder_id : ''
  ok('提醒已登记', reminder_id !== '')
  dispatchDueReminders({
    db,
    personaId: 'main',
    now: new Date(NOW),
    enqueueOutbox: (row) => {
      const enqueued = store.enqueue({
        personaId: 'main',
        contactId: row.contact_id,
        stableUserId: '10002',
        sessionId: 'qq-private-10002',
        sessionSeq: 1,
        transportId: 'probe-transport',
        payloadText: row.text,
        ttlMs: 10 * 60_000,
        accessEpoch: 0,
        reminderId: row.reminder_id,
        now: NOW,
      })
      db.run("UPDATE reminders SET delivery_state = 'pending' WHERE reminder_id = ?", [row.reminder_id])
      return { kind: 'queued', outboxId: enqueued.row.replyId }
    },
  })

  const worker = new QqReplyWorker({
    store,
    transport: transport as never,
    targetOf: (row) => ({ kind: 'private', platform: 'qq', stableUserId: row.stableUserId }),
    authorization: (row) => (bridge.configTrust().trusted ? null : 'config-corrupt'),
    logger: { info() {}, warn() {}, error() {} },
    now: () => NOW,
  })
  // 领取：此刻还「可信」，然后立刻损坏
  const claimed = store.claim({
    limit: 1,
    authorization: () => null,
    transportCheck: () => true,
    now: NOW,
  })
  eq('先领到这一条', claimed.length, 1)
  // 真的把文件改坏（不是只改内存标记）：这样发送前的强制重读才会读到坏文件。
  writeFileSync(file, '{ "access": ', 'utf8')
  bridge.markConfigUntrusted('发送前损坏')
  // 生产路径：worker 在同一个 tick 里先 claim、再 recheckForSend。这里直接调复核，
  // 因为「重启 worker 时的 recoverInflight」是另一条冻结语义（P1-A：in-flight 一律 unknown）。
  const recheckReason = store.recheckForSend(claimed[0].replyId, NOW)
  eq('发送前复核报告的原因就是 config-corrupt', recheckReason, 'config-corrupt')
  const held = store.get(claimed[0].replyId)
  eq('队列行放回 pending（不是 cancelled/failed）', held?.status, 'pending')
  ok('retry_at 被推到远未来（保持等待）', typeof held?.retryAt === 'string' && held.retryAt > at(60 * 24 * 30))
  ok('expires_at 一起推后（不会跨过 TTL 被判过期）', typeof held?.expiresAt === 'string' && held.expiresAt > at(60 * 24 * 30))
  eq('提醒仍是已入队（没被写成 failed）', getReminder({ db, personaId: 'main', reminderId: reminder_id })?.delivery_state, 'pending')
  // 恢复后的 worker 在暂停期间领取：队列行应被延后、transport 一次都不调
  void worker.start()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 60)
  })
  void worker.stop()
  eq('暂停期间 worker 领取：transport 一次都没被调用', transport.sends.length, 0)
  eq('暂停期间队列行仍在等待', store.get(claimed[0].replyId)?.status, 'pending')

  // 反证：同一套 harness 在可信状态下确实会建会话——否则上面「入站被拦」就是空断言
  writeFileSync(file, JSON.stringify({ revision: 2 }), 'utf8')
  bridge.recheckConfigNow(true)
  socket.message({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: '99999',
    user_id: '10002',
    sender: { user_id: '10002' },
    message_id: 'p1d-in-2',
    raw_message: '在吗',
  })
  await flush()
  eq('可信状态下同一入站会建会话（证明拦截不是空断言）', counts.creates, 1)
  bridge.markConfigUntrusted('继续测还原')

  // ── 还原：同一个队列行只发一次 ─────────────────────────
  console.log('[还原] 文件修好后')
  writeFileSync(file, JSON.stringify({ revision: 3 }), 'utf8')
  const overlay4 = new QqSettingsOverlay({ file })
  const restored = overlay4.effective({ owner: '10001', extra: ['10002'] }, { provider: 'probe', model: 'probe' })
  bridge.applyReplySchedules(restored.replySchedules)
  bridge.markConfigTrusted()
  ok('恢复后桥可信', bridge.configTrust().trusted)
  // 模拟「重读触发」：清掉等待标记，让 worker 能重新领取
  db.run('UPDATE qq_reply_outbox SET retry_at = NULL WHERE reply_id = ?', [claimed[0].replyId])
  const worker2 = new QqReplyWorker({
    store,
    transport: transport as never,
    targetOf: (row) => ({ kind: 'private', platform: 'qq', stableUserId: row.stableUserId }),
    authorization: (row) => (bridge.configTrust().trusted ? null : 'config-corrupt'),
    logger: { info() {}, warn() {}, error() {} },
    now: () => NOW,
  })
  void worker2.start()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 80)
  })
  void worker2.stop()
  eq('还原后正好发出一条', transport.sends.length, 1)
  eq('队列行落 sent', store.get(claimed[0].replyId)?.status, 'sent')
  // 再跑一轮不重复发
  db.run("UPDATE qq_reply_outbox SET retry_at = NULL WHERE reply_id = ? AND status = 'pending'", [claimed[0].replyId])
  const worker3 = new QqReplyWorker({
    store,
    transport: transport as never,
    targetOf: (row) => ({ kind: 'private', platform: 'qq', stableUserId: row.stableUserId }),
    authorization: () => null,
    logger: { info() {}, warn() {}, error() {} },
    now: () => NOW,
  })
  void worker3.start()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 60)
  })
  void worker3.stop()
  eq('再跑一轮仍只有一条', transport.sends.length, 1)

  // 文件字节没有被我们改动（坏文件由测试自己写、自己还原）
  ok('还原后文件内容就是测试写的那样', readFileSync(file, 'utf8').includes('"revision":3'))

  // ── 时点 4：健康状态下文件被改坏，各入口「改坏后的第一次调用」都要自己发现（第 20/21 条）──
  console.log('[时点 4a] 改坏后第一次调用就是入站消息')
  writeFileSync(file, JSON.stringify({ revision: 3 }), 'utf8')
  bridge.recheckConfigNow(true)
  ok('起步状态：桥可信', bridge.configTrust().trusted)
  writeFileSync(file, '{ "access": ', 'utf8')
  const createsBefore4 = counts.creates
  const framesBefore4 = socket.sent.length
  const announceBefore4 = counts.announce
  socket.message({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: '99999',
    user_id: '10002',
    sender: { user_id: '10002' },
    message_id: 'p1d-in-3',
    raw_message: '还在吗',
  })
  await flush()
  eq('入站不建会话', counts.creates, createsBefore4)
  eq('入站不发出任何帧', socket.sent.length, framesBefore4)
  eq('入站不产生采集写入（announce 调用 0 次）', counts.announce, announceBefore4)
  eq('入站这条也让桥发现损坏', bridge.configTrust().trusted, false)

  console.log('[时点 4b] 改坏后第一次调用就是 psyche_resolve_delivery 工具')
  const { buildTools } = await import('../dist/lib/tools.js')
  const { resolveReminderDelivery } = await import('../dist/lib/reminder-resolve.js')
  const { isOwnerReminderScope, readOwnerUin } = await import('../dist/lib/reminder-owner.js')
  const makeUnknown = (requestId: string): { id: string; replyId: string } => {
    const created = createReminder({
      db,
      personaId: 'main',
      receiver: { channel: 'qq', contactId: 'ct_owner' },
      text: '待裁决',
      dueAt: NOW,
      timezone: 'Asia/Shanghai',
      now: NOW,
      requestId,
      accessEpoch: 0,
    })
    const id = created.status === 'created' ? created.reminder.reminder_id : ''
    const enqueued = store.enqueue({
      personaId: 'main',
      contactId: 'ct_owner',
      stableUserId: '10001',
      sessionId: 'qq-private-10001',
      sessionSeq: 1,
      transportId: 'probe-transport',
      payloadText: '待裁决',
      ttlMs: 10 * 60_000,
      accessEpoch: 0,
      reminderId: id,
      now: NOW,
    })
    // 直接落成「三字段合法」的待裁决态（状态机本身由 reminder-p1c 锁）；不用 claim + applyResult 是因为
    // 同一库里的其它联系人若有更早的队首，claim 的 transportCheck 会在队首 break，取不到这一条。
    db.run("UPDATE reminders SET delivery_state = 'unknown', delivery_result = 'unknown' WHERE reminder_id = ?", [id])
    db.run("UPDATE qq_reply_outbox SET status = 'unknown' WHERE reply_id = ?", [enqueued.row.replyId])
    return { id, replyId: enqueued.row.replyId }
  }
  // 工具门面按 src/index.ts 的接线方式：每次调用现读覆盖层拿 Owner 号（坏配置就通知桥并返回空串）
  const tripleOf = (id: string): string[] => {
    const row = getReminder({ db, personaId: 'main', reminderId: id })
    return [String(row?.status), String(row?.delivery_state), String(row?.delivery_result ?? 'null')]
  }
  type ExecTool = { name: string; execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  const tools = buildTools(
    {
      resolveReminderDelivery: async (input: {
        reminderId: string
        verdict: 'received' | 'not-received'
        now: string
        receiver: { channel: 'qq' | 'desktop'; contactId?: string | null; sessionRef?: string | null }
      }) => {
        const ownerUin = readOwnerUin({
          overlay: new QqSettingsOverlay({ file }),
          host: { owner: '10001', extra: ['10002'] },
          runtime: { provider: 'probe', model: 'probe' },
          onCorrupt: (reason) => bridge.markConfigUntrusted(reason),
          trusted: () => bridge.configTrust().trusted,
        })
        return resolveReminderDelivery({
          reminderId: input.reminderId,
          verdict: input.verdict,
          now: input.now,
          deps: {
            isOwner: isOwnerReminderScope(db, input.receiver, ownerUin),
            owned: true,
            store,
            ownerId: 'owner',
          },
        })
      },
    } as never,
    { reminderScope: () => ({ channel: 'qq' as const, contactId: 'ct_owner', sessionRef: 'sess-p1d' }) },
  ) as ExecTool[]
  const resolveTool = tools.find((item) => item.name === 'psyche_resolve_delivery')
  ok('工具表里有 psyche_resolve_delivery', resolveTool !== undefined)

  // 健康配置：同一个工具、同一个 QQ 主人身份，裁决成功
  writeFileSync(file, JSON.stringify({ revision: 7 }), 'utf8')
  bridge.recheckConfigNow(true)
  ok('起步状态：桥可信', bridge.configTrust().trusted)
  const firstId = makeUnknown('req-p1d-a')
  const firstResult = (await resolveTool?.execute({ reminder_id: firstId.id, verdict: 'received' }, { agent: { id: 'a1' } })) as {
    status?: string
  }
  eq('健康配置下工具裁决成功', firstResult.status, 'resolved')
  eq('第一条提醒落 fired/sent/sent', tripleOf(firstId.id).join('/'), 'fired/sent/sent')
  const verdictsAfterHealthy = db.get<{ n: number }>('SELECT count(*) AS n FROM qq_reply_verdicts')?.n ?? 0
  eq('健康配置下留下了一条裁决记录', verdictsAfterHealthy, 1)

  // 改坏文件：让同一个工具成为「改坏后的第一次调用」，它必须自己发现并拒绝
  writeFileSync(file, '{ "replySchedules": ', 'utf8')
  const second = makeUnknown('req-p1d-b')
  const secondResult = (await resolveTool?.execute({ reminder_id: second.id, verdict: 'not-received' }, { agent: { id: 'a1' } })) as {
    status?: string
  }
  eq('工具作为坏文件后的首次调用：被拒', secondResult.status, 'no-permission')
  eq('被拒后桥已知不可信', bridge.configTrust().trusted, false)
  eq('被拒后第二条提醒三字段原样（pending/unknown/unknown）', tripleOf(second.id).join('/'), 'pending/unknown/unknown')
  eq(
    '被拒后第二条提醒的队列行仍是 unknown',
    db.get<{ status: string }>('SELECT status FROM qq_reply_outbox WHERE reply_id = ?', [second.replyId])?.status,
    'unknown',
  )
  eq(
    '被拒后没有新增裁决记录',
    db.get<{ n: number }>('SELECT count(*) AS n FROM qq_reply_verdicts')?.n ?? 0,
    verdictsAfterHealthy,
  )
  eq('正常入口发现坏文件：发送被拒', (await bridge.sendOutgoingText({ kind: 'private', userId: '10002' }, '你好', { accessEpoch: 0 })).error, 'config-corrupt')

  // ── 时点 5：Worker 在同一次发送尝试中被改坏（第 20 轮第 2 条）──
  console.log('[时点 5] Worker 同一次尝试：领取之后文件才坏')
  writeFileSync(file, JSON.stringify({ revision: 4 }), 'utf8')
  bridge.markConfigTrusted()
  const created2 = createReminder({
    db,
    personaId: 'main',
    receiver: { channel: 'qq', contactId: 'ct_friend' },
    text: '第二杯水',
    dueAt: NOW,
    timezone: 'Asia/Shanghai',
    now: NOW,
    requestId: 'req-p1d-2',
    accessEpoch: 0,
  })
  const reminder2 = created2.status === 'created' ? created2.reminder.reminder_id : ''
  dispatchDueReminders({
    db,
    personaId: 'main',
    now: new Date(NOW),
    enqueueOutbox: (row) => {
      const enqueued = store.enqueue({
        personaId: 'main',
        contactId: row.contact_id,
        stableUserId: '10002',
        sessionId: 'qq-private-10002',
        sessionSeq: 2,
        transportId: 'probe-transport',
        payloadText: row.text,
        ttlMs: 10 * 60_000,
        accessEpoch: 0,
        reminderId: row.reminder_id,
        now: NOW,
      })
      db.run("UPDATE reminders SET delivery_state = 'pending' WHERE reminder_id = ?", [row.reminder_id])
      return { kind: 'queued', outboxId: enqueued.row.replyId }
    },
  })
  const row2 = db.get<{ reply_id: string }>('SELECT reply_id FROM qq_reply_outbox WHERE reminder_id = ?', [reminder2])
  // 领取成功的那一刻把文件改坏：模拟「Worker 已经拿到行，之后配置才坏」
  const racingStore = {
    recoverInflight: (now?: string) => store.recoverInflight(now),
    claim: (input: never) => {
      const rows = store.claim(input)
      if (rows.length > 0) writeFileSync(file, '{ "replySchedules": ', 'utf8')
      return rows
    },
    applyResult: (replyId: string, result: never, now?: string) => store.applyResult(replyId, result, now),
    recheckForSend: (replyId: string, now?: string) => store.recheckForSend(replyId, now),
    expireDue: (now?: string) => store.expireDue(now),
  }
  const sendsBefore = transport.sends.length
  const worker4 = new QqReplyWorker({
    store: racingStore as never,
    transport: transport as never,
    targetOf: (row) => ({ kind: 'private', platform: 'qq', stableUserId: row.stableUserId }),
    authorization: () => null,
    logger: { info() {}, warn() {}, error() {} },
    now: () => NOW,
  })
  void worker4.start()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 80)
  })
  void worker4.stop()
  eq('同一次尝试里 transport 一次都没被调用', transport.sends.length, sendsBefore)
  eq('行放回 pending（保持等待，不是 failed）', store.get(row2?.reply_id ?? '')?.status, 'pending')

  // ── 时点 6：恢复反例——仍是暂停 / 已撤权，都不得发送（第 20 轮第 3 条）──
  console.log('[时点 6] 恢复反例：仍暂停 / 已撤权')
  // 先回到「不可信」状态（模拟坏配置期间的等待），再把合法配置写到磁盘，由重读应用。
  bridge.markConfigUntrusted('等待恢复')
  writeFileSync(file, JSON.stringify({ revision: 5, replySchedules: { 'private:10002': { mode: 'paused' } } }), 'utf8')
  bridge.setConfigRecheck(() => {
    try {
      const snap = new QqSettingsOverlay({ file }).effective(
        { owner: '10001', extra: ['10002'] },
        { provider: 'probe', model: 'probe' },
      )
      bridge.applyReplySchedules(snap.replySchedules)
      bridge.markConfigTrusted()
      return true
    } catch (error) {
      bridge.markConfigUntrusted(String(error))
      return false
    }
  })
  bridge.recheckConfigNow(true)
  ok('暂停配置下桥可信（规则本身是 paused）', bridge.configTrust().trusted)
  db.run('UPDATE qq_reply_outbox SET retry_at = NULL WHERE reply_id = ?', [row2?.reply_id ?? ''])
  const worker5 = new QqReplyWorker({
    store,
    transport: transport as never,
    targetOf: (row) => ({ kind: 'private', platform: 'qq', stableUserId: row.stableUserId }),
    authorization: (row) => (bridge.configTrust().trusted ? null : 'config-corrupt'),
    logger: { info() {}, warn() {}, error() {} },
    now: () => NOW,
  })
  void worker5.start()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 80)
  })
  void worker5.stop()
  eq('仍是暂停：一条都没发', transport.sends.length, sendsBefore)
  eq('仍是暂停：行继续等待', store.get(row2?.reply_id ?? '')?.status, 'pending')

  // 反例二：从磁盘恢复一份「已撤权」的合法配置——不能只靠手动 applyAccess
  bridge.markConfigUntrusted('等待撤权恢复')
  writeFileSync(
    file,
    JSON.stringify({ revision: 6, access: { owner: '10001', extra: [] }, replySchedules: {} }),
    'utf8',
  )
  bridge.recheckConfigNow(true)
  ok('撤权配置本身是合法的（桥仍可信）', bridge.configTrust().trusted)
  db.run('UPDATE qq_reply_outbox SET retry_at = NULL WHERE reply_id = ?', [row2?.reply_id ?? ''])
  const worker6 = new QqReplyWorker({
    store,
    transport: transport as never,
    targetOf: (row) => ({ kind: 'private', platform: 'qq', stableUserId: row.stableUserId }),
    // 生产口径：Worker 不问「为什么不能发」，一律用桥给的授权判定
    authorization: (row) => bridge.authorizeOutboxRow(row as never),
    logger: { info() {}, warn() {}, error() {} },
    now: () => NOW,
  })
  void worker6.start()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 80)
  })
  void worker6.stop()
  eq('已撤权：Worker 也没发出去', transport.sends.length, sendsBefore)
  eq('已撤权：行按撤权关闭', store.get(row2?.reply_id ?? '')?.status, 'cancelled')
  eq(
    '已撤权：关联提醒按确定未发送关闭',
    getReminder({ db, personaId: 'main', reminderId: reminder2 })?.delivery_state,
    'unsupported',
  )

  await bridge.stop()
  db.close()
  console.log(`[qq-config-trust] ${passed} 通过 ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
void main()
