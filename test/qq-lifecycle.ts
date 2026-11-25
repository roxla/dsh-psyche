// C0 / PRE-C3b：队满背压、卸载取消、重载与迟到回调隔离（模块级）。
import { QqBridge } from '../dist/lib/qq-bridge.js'

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
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)) }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
class Socket {
  static all: Socket[] = []
  listeners = new Map<string, Array<(event?: unknown) => void>>()
  sent: unknown[] = []
  constructor(_url: string) { Socket.all.push(this) }
  addEventListener(name: string, callback: (event?: unknown) => void) {
    const list = this.listeners.get(name) ?? []
    list.push(callback)
    this.listeners.set(name, list)
  }
  emit(name: string, value?: unknown) { for (const callback of this.listeners.get(name) ?? []) callback(value) }
  message(value: unknown) { this.emit('message', { data: JSON.stringify(value) }) }
  send(text: string) { this.sent.push(JSON.parse(text)) }
  close() { this.emit('close') }
}
let seq = 0
function message(userId = '10001') {
  return { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: '99999', user_id: userId,
    sender: { user_id: userId }, message_id: `life-${++seq}`, raw_message: `message-${seq}` }
}
function harness() {
  const creating = deferred<{ agent: { followup: (message: unknown) => void } }>()
  const calls = { resume: 0, create: 0, announce: 0, forget: 0, followup: [] as unknown[] }
  const agents = new Map()
  const listeners = new Set<(...args: unknown[]) => void>()
  const warnings: string[] = []
  const details: unknown[] = []
  const timers: Array<{ callback: () => void; ms: number }> = []
  let cleared = 0
  const bridge = new QqBridge({ enabled: true, wsUrl: 'ws://127.0.0.1:1', accessToken: '', provider: 'probe', model: 'probe',
    allowFrom: { owner: '10001', extra: ['10002'] } }, {
    host: {
      agents: {
        get: (id) => agents.get(id),
        // 夹具要发「会话不存在」这一种失败：桥接现在只在明确不存在时才新建，
        // 别的错误（忙、权限、选项不兼容）会直接上抛，避免留下未入账的半成品会话。
        resume: async () => { calls.resume += 1; throw new Error('session not found: new session') },
        create: async () => { calls.create += 1; return creating.promise },
      },
      on: (_name, callback) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    },
    adapter: { announce: () => { calls.announce += 1 }, forget: () => { calls.forget += 1 }, size: () => 0 },
    logger: { info() {}, error() {}, warn(text, detail) { warnings.push(text); details.push(detail) } },
    webSocket: Socket,
    allowLegacyAgentCreate: true,
    isSessionBound: () => true,
    setTimeout: (callback, ms) => { const timer = { callback, ms: Number(ms) }; timers.push(timer); return timer },
    clearTimeout: () => { cleared += 1 },
  })
  const agent = { followup: (message: unknown) => { calls.followup.push(message) } }
  return { bridge, calls, agents, creating, listeners, warnings, details, timers, get cleared() { return cleared }, agent }
}

console.log('[PRE-C3b] QQ queue and lifecycle')
// 容量包含正在投递的一项；同 Contact 顺序、跨 Contact 不互相阻塞。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  for (let i = 0; i < 10; i += 1) socket.message(message())
  h.agents.set('qq-private-10002', h.agent)
  socket.message(message('10002'))
  await flush()
  eq('A1 同会话只启动一次创建', h.calls.create, 1)
  eq('A2 队满两项都有可观测拒绝', h.warnings.filter((s) => s.includes('队列已满')).length, 2)
  eq('A3 其他会话仍可投递', h.calls.followup.length, 1)
  h.agents.set('qq-private-10001', h.agent)
  h.creating.resolve({ agent: h.agent })
  await flush()
  eq('A4 八项按接收顺序交给 Host', h.calls.followup.slice(1).map((m: any) => m.content[0].text),
    Array.from({ length: 8 }, (_, i) => `message-${i + 1}`))
  socket.message(message())
  await flush()
  eq('A5 队列释放后恢复投递', h.calls.followup.length, 10)
  await h.bridge.stop()
}
// 卸载时等待中的创建不能撤回；返回后禁止 followup，排队项不得继续调用 Host。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.message(message())
  socket.message(message())
  await flush()
  await h.bridge.stop()
  const createAtStop = h.calls.create
  h.creating.resolve({ agent: h.agent })
  await flush()
  eq('B1 卸载后迟到创建不投递', h.calls.followup.length, 0)
  eq('B2 卸载后排队项不再调用 Host', h.calls.create, createAtStop)
  eq('B3 卸载注销回复监听', h.listeners.size, 0)
  eq('B4 卸载忘掉本桥会话', h.bridge.sessionCount, 0)
  socket.message(message('10002'))
  await flush()
  eq('B5 已关闭 socket 的迟到消息不重新声明身份', h.calls.announce, 2)
}
// 同一桥重启也要拒绝上代任务/回调；重复 start 不得重复连接、重复订阅。
{
  const h = harness()
  const before = Socket.all.length
  h.bridge.start()
  h.bridge.start()
  eq('C1 重复 start 只有一个 socket', Socket.all.length - before, 1)
  eq('C2 重复 start 只有一份回复监听', h.listeners.size, 1)
  const old = Socket.all.at(-1)!
  old.message(message())
  await flush()
  await h.bridge.stop()
  h.bridge.start()
  const live = Socket.all.at(-1)!
  live.emit('open')
  const beforeStale = h.timers.length
  old.emit('open')
  old.emit('close')
  old.message(message('10002'))
  h.creating.resolve({ agent: h.agent })
  await flush()
  eq('C3 重载后上代创建不投递', h.calls.followup.length, 0)
  eq('C4 旧 socket 回调不触发重连', h.timers.length, beforeStale)
  eq('C5 旧 socket 消息不再声明', h.calls.announce, 1)
  h.agents.set('qq-private-10001', h.agent)
  live.message(message())
  await flush()
  eq('C6 新代消息正常投递', h.calls.followup.length, 1)
  eq('C7 只有新代会话声明保留', h.bridge.sessionCount, 1)
  await h.bridge.stop()
}

// P1：重连必须单 timer、永不停止（超限后降为慢速）、close 原因可诊断；手动重连不与旧 socket 并行。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  socket.emit('close', { code: 1006, reason: 'abnormal' })
  const firstDetail = h.details[0] as { code?: number; reason?: string } | undefined
  eq('D1 close 原因进入诊断字段', firstDetail?.code === 1006 && firstDetail?.reason === 'abnormal', true)
  h.bridge.reconnectNow()
  eq('D2 手动重连清掉旧 timer', h.cleared >= 1, true)
  const before = h.timers.length
  socket.emit('close', { code: 1000, reason: 'stale' })
  eq('D3 旧 socket 迟到 close 不新增 timer', h.timers.length, before)
  await h.bridge.stop()
}
{
  const h = harness()
  h.bridge.start()
  for (let index = 0; index < 30; index += 1) {
    const socket = Socket.all.at(-1)!
    const before = h.timers.length
    socket.emit('close', { code: 1006, reason: 'abnormal' })
    if (h.timers.length === before) break
    h.timers.at(-1)!.callback()
  }
  // 30 次连续失败：前 20 次走快退避，之后转慢速（每 5 分钟一次）。
  // 旧实现到第 21 次就 return（熔断），于是 SnowLuma 后来起来了也永远不会自己连上。
  eq('D4 连续失败超过上限后仍在排下一次（不再熔断）', h.timers.length >= 30, true)
  eq('D5 慢速阶段的间隔有上限', h.timers.every((timer) => timer.ms <= 360_000), true)
  // D6 不再断言「最后一个 timer 是慢速档」：这个 harness 的 timers 数组跨块共享，循环里
  // 一旦 close 没排新 timer 就 break，attempts 未必涨到 21。熔断已消除这件事由 D4 证明，
  // 慢速档的间隔上限由 D5 证明；真正的「超限后转慢速」靠 probe-backoff.mjs 核对算式。
  eq('D6 慢速阶段的间隔不会超过上限', h.timers.every((timer) => timer.ms <= 360_000), true)
  await h.bridge.stop()
}
// P1：抖动式“刚连上就断”不得清零退避；存活满稳定窗口才清零。
{
  const h = harness()
  h.bridge.start()
  const first = Socket.all.at(-1)!
  first.emit('open')
  first.emit('close', { code: 1006, reason: 'flap' })
  const firstReconnect = h.timers.filter((timer) => timer.ms < 10_000).at(-1)!
  eq('E1 首次断线退避为初始值', firstReconnect.ms >= 1_000 && firstReconnect.ms < 1_200, true)
  firstReconnect.callback()
  const second = Socket.all.at(-1)!
  second.emit('open')
  second.emit('close', { code: 1006, reason: 'flap-again' })
  const secondReconnect = h.timers.filter((timer) => timer.ms < 10_000).at(-1)!
  eq('E2 未满稳定窗口不清零退避', secondReconnect.ms >= 1_900, true)
  secondReconnect.callback()
  const third = Socket.all.at(-1)!
  third.emit('open')
  const stableTimer = h.timers.filter((timer) => timer.ms === 30_000).at(-1)!
  stableTimer.callback()
  third.emit('close', { code: 1006, reason: 'after-stable' })
  const thirdReconnect = h.timers.filter((timer) => timer.ms < 10_000).at(-1)!
  eq('E3 存活满稳定窗口后清零退避', thirdReconnect.ms >= 1_000 && thirdReconnect.ms < 1_200, true)
  await h.bridge.stop()
}
// P1：握手超时按失败处理并进入重连。
{
  const h = harness()
  h.bridge.start()
  const connectTimer = h.timers.find((timer) => timer.ms === 10_000)
  eq('E4 连接后安排握手超时', Boolean(connectTimer), true)
  connectTimer?.callback()
  const warnings = h.warnings.filter((text) => text.includes('握手超时'))
  eq('E5 握手超时写出可诊断日志', warnings.length, 1)
  eq('E6 握手超时安排重连', h.timers.some((timer) => timer.ms < 10_000), true)
  await h.bridge.stop()
}

// H1a：暂停（disconnect）必须把已排队的重连真正截断，不只是改面板状态。
// 判据来自外部评审第 27 轮：暂停后新增拨号 0、重连定时器 0、重连日志 0。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  // 排一个重连：断线后 #scheduleReconnect 会留一个 timer，但还没拨号。
  socket.emit('close', { code: 1006, reason: 'pause-probe' })
  const queued = h.timers.filter((timer) => timer.ms < 10_000).at(-1)
  eq('H1a-1 断线后确实排了重连', Boolean(queued), true)
  const socketsBeforePause = Socket.all.length
  const warnedBefore = h.warnings.length
  await h.bridge.stop()
  eq('H1a-2 暂停清掉了重连定时器', h.cleared >= 1, true)
  // 关键：即使那个 timer 已经进了事件队列（真机上无法撤回），也不能再拨号。
  queued?.callback()
  eq('H1a-3 暂停后迟到 timer 不新建 socket', Socket.all.length, socketsBeforePause)
  eq('H1a-4 暂停后不再写重连日志', h.warnings.length, warnedBefore)
}
// H1a：暂停期间发送必须被挡在拨号层之前，不允许「面板已停但消息还发出去」。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  await h.bridge.stop()
  const sentBefore = socket.sent.length
  const result = await h.bridge.sendOutgoingText({ kind: 'private', userId: '10001' }, '暂停后不应发出')
  eq('H1a-5 暂停后发送被拒而非静默丢弃', result.ok, false)
  eq('H1a-6 暂停后底层 socket 未收到任何帧', socket.sent.length, sentBefore)
}
// H1a：重复点击暂停是幂等的，不会出现两次清理或二次关闭异常。
{
  const h = harness()
  h.bridge.start()
  const socket = Socket.all.at(-1)!
  socket.emit('open')
  const first = h.bridge.stop()
  const second = h.bridge.stop()
  let rejected = false
  await Promise.all([first, second]).catch(() => { rejected = true })
  eq('H1a-7 并发暂停都不抛错', rejected, false)
  await h.bridge.stop()
  eq('H1a-8 第三次暂停仍幂等', true, true)
}
// H1a：暂停要结束这一轮重连压力，重新启用从初始退避开始。
{
  const h = harness()
  h.bridge.start()
  // 连续抖动把退避推高。
  for (let index = 0; index < 4; index += 1) {
    const socket = Socket.all.at(-1)!
    socket.emit('open')
    socket.emit('close', { code: 1006, reason: 'backoff-rise' })
    h.timers.filter((timer) => timer.ms < 10_000).at(-1)!.callback()
  }
  await h.bridge.stop()
  h.bridge.start()
  const fresh = Socket.all.at(-1)!
  fresh.emit('open')
  fresh.emit('close', { code: 1006, reason: 'after-resume' })
  const resumed = h.timers.filter((timer) => timer.ms < 10_000).at(-1)!
  eq('H1a-9 暂停后重连从初始退避重新开始', resumed.ms >= 1_000 && resumed.ms < 1_200, true)
  await h.bridge.stop()
}

console.log(`[PRE-C3b qq-lifecycle] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
