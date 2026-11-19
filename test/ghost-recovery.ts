// P2-CAP-1c1：Ghost 历史补采测试（纯逻辑，不需要数据库）。
//
// 覆盖（DEV.md §23.0 的 1c1 验收表）：
// - 只认 turn/start；其他事件不触发
// - 找「本轮开始之前」最近的真实用户消息补采；captureKey = user.seq
// - 已有 Source（sink 返回 replayed）记 replayed，不重复
// - 没有上一轮用户消息 / 旧消息超出 lookback / 注入上下文 不补
// - 范围：excludeSessions 生效
// - 没有 sessionPersistence 时降级不抛
// - stop 后不再处理；drain 排空
// - Fork：inheritedEventCount 之前的继承前缀不补
//
// 跑法：node test/ghost-recovery.ts（需要先 npm run build）

import {
  GhostSyncHost,
  eventsOf,
  inheritedCountOf,
  isRealUserMessage,
  turnStartOf,
} from '../dist/lib/sync-recovery.js'

let passed = 0
let failed = 0

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function eq(label, actual, expected) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function userMessage(seq, time, options = {}) {
  const { sourceKind = 'user', text = '上一轮说过的话', id = `u${seq}` } = options
  return {
    type: 'user/message',
    seq,
    time,
    data: { id, role: 'user', source: { kind: sourceKind }, content: [{ type: 'text', text }] },
  }
}

function turnStart(seq, time) {
  return { type: 'turn/start', seq, time, data: { turn: 2 } }
}

function makeService(pages, inherited = 0) {
  const calls = { list: 0, open: 0, read: 0, close: 0 }
  const service = {
    list: async () => {
      calls.list += 1
      return [{ header: { id: 's1' } }]
    },
    open: async (id, mode) => {
      calls.open += 1
      ok('open 使用只读模式', mode === 'read')
      return {
        inheritedEventCount: inherited,
        read: async (offset, length) => {
          calls.read += 1
          return { eventState: 'shared-frozen', events: pages }
        },
        close: async () => {
          calls.close += 1
        },
      }
    },
  }
  return { service, calls }
}

function makeHost(service, options = {}) {
  const captured = []
  const host = new GhostSyncHost({
    ctx: { get: (name) => (name === 'sessionPersistence' ? service : undefined) },
    sink: {
      capture: async (input) => {
        captured.push(input)
        return options.replayed === true
          ? { replayed: true, sourceId: 'src_existing' }
          : { replayed: false, sourceId: 'src_new' }
      },
    },
    scope: { enabled: true, excludeSessions: options.excludeSessions ?? [] },
    lookbackMs: options.lookbackMs ?? 300000,
    maxScan: options.maxScan ?? 200,
  })
  return { host, captured }
}

const now = Date.now()
const session = { id: 's1' }

// 1. 非 turn/start 不触发
{
  const { service, calls } = makeService([])
  const { host } = makeHost(service)
  host.handle(session, userMessage(1, now - 1000))
  await sleep(5)
  eq('非 turn/start 不读取持久化', calls.list, 0)
  eq('非 turn/start 不记 turnsSeen', host.stats().turnsSeen, 0)
}

// 2. turn/start → 补采上一轮用户消息
{
  const events = [
    userMessage(8, now - 60000, { text: '上一轮说过的话' }),
    turnStart(20, now - 1000),
    userMessage(21, now, { text: '这是本轮的消息' }),
  ]
  const { service, calls } = makeService(events)
  const { host, captured } = makeHost(service)
  host.handle(session, turnStart(20, now - 1000))
  await host.drain()
  eq('turn/start 触发一次读取', calls.list, 1)
  eq('只补一条', captured.length, 1)
  const input = captured[0] ?? {}
  eq('captureKey 是上一轮 user 的 seq', input.captureKey, '8')
  eq('platform 正确', input.platform, 'dsh-session')
  eq('channel 正确', input.channel, 'desktop')
  eq('origin 是 user', input.origin, 'user')
  eq('kind 是 message', input.kind, 'message')
  eq('正文取上一轮', input.text, '上一轮说过的话')
  eq('metadata 标记补采', input.metadata?.dsh?.recovered, true)
  eq('补采计数', host.stats().recovered, 1)
}

// 3. 已有 Source（幂等命中）记 replayed
{
  const events = [userMessage(8, now - 60000), turnStart(20, now - 1000)]
  const { service } = makeService(events)
  const { host } = makeHost(service, { replayed: true })
  host.handle(session, turnStart(20, now - 1000))
  await host.drain()
  eq('幂等命中记 replayed', host.stats().replayed, 1)
  eq('幂等命中不记 recovered', host.stats().recovered, 0)
}

// 4. 没有上一轮用户消息时不补
{
  const events = [turnStart(20, now - 1000), userMessage(21, now)]
  const { service } = makeService(events)
  const { host, captured } = makeHost(service)
  host.handle(session, turnStart(20, now - 1000))
  await host.drain()
  eq('没有上一轮消息不补', captured.length, 0)
}

// 5. 超出 lookback 的旧消息不补
{
  const events = [userMessage(8, now - 600000), turnStart(20, now - 1000)]
  const { service } = makeService(events)
  const { host, captured } = makeHost(service, { lookbackMs: 60000 })
  host.handle(session, turnStart(20, now - 1000))
  await host.drain()
  eq('旧消息不补', captured.length, 0)
}

// 6. 注入上下文（runtime-context）不算真实用户输入
{
  const events = [userMessage(8, now - 60000, { sourceKind: 'runtime-context' }), turnStart(20, now - 1000)]
  const { service } = makeService(events)
  const { host, captured } = makeHost(service)
  host.handle(session, turnStart(20, now - 1000))
  await host.drain()
  eq('注入上下文不补', captured.length, 0)
  eq('isRealUserMessage 拒绝注入上下文', isRealUserMessage(events[0]), null)
}

// 6.1 与实时捕获共用正文提取：reasoning 块不能混进补采原话
{
  const events = [
    {
      type: 'user/message',
      seq: 8,
      time: now - 60000,
      data: {
        id: 'u8',
        role: 'user',
        source: { kind: 'user' },
        content: [
          { type: 'reasoning', text: '模型的内部推理' },
          { type: 'text', text: '这是用户真正说的话' },
        ],
      },
    },
    turnStart(20, now - 1000),
  ]
  const { service } = makeService(events)
  const { host, captured } = makeHost(service)
  host.handle(session, turnStart(20, now - 1000))
  await host.drain()
  eq('补采只取可见文本', captured.map((item) => item.text), ['这是用户真正说的话'])
  eq('isRealUserMessage 与实时捕获同源', isRealUserMessage(events[0])?.text, '这是用户真正说的话')
}

// 7. excludeSessions 生效
{
  const events = [userMessage(8, now - 60000), turnStart(20, now - 1000)]
  const { service } = makeService(events)
  const { host, captured } = makeHost(service, { excludeSessions: ['s1'] })
  host.handle(session, turnStart(20, now - 1000))
  await host.drain()
  eq('排除会话不补', captured.length, 0)
  eq('排除会话记 skipped', host.stats().skipped, 1)
}

// 8. 没有 sessionPersistence 时降级不抛
{
  const host = new GhostSyncHost({
    ctx: { get: () => undefined },
    sink: { capture: async () => undefined },
    scope: { enabled: true },
  })
  host.handle(session, turnStart(20, now - 1000))
  await host.drain()
  eq('缺持久化服务不补', host.stats().recovered, 0)
  eq('缺持久化服务不失败', host.stats().failed, 0)
}

// 9. stop 后不再处理
{
  const events = [userMessage(8, now - 60000), turnStart(20, now - 1000)]
  const { service } = makeService(events)
  const { host, captured } = makeHost(service)
  host.stop()
  host.handle(session, turnStart(20, now - 1000))
  await host.drain()
  eq('stop 后不补', captured.length, 0)
}

// 10. Fork：继承前缀不补，只补子会话自己的上一轮消息
{
  const events = [
    userMessage(3, now - 120000, { text: '父会话说过的话' }),
    userMessage(8, now - 60000, { text: '子会话上一轮' }),
    turnStart(20, now - 1000),
  ]
  const { service } = makeService(events, 5)
  const { host, captured } = makeHost(service)
  host.handle(session, turnStart(20, now - 1000))
  await host.drain()
  eq('Fork 只补子会话自己的消息', captured.length, 1)
  eq('Fork 补采 captureKey 是子会话的 seq', captured[0]?.captureKey, '8')
}

// 11. Fork：只有继承前缀里的用户消息时不补
{
  const events = [userMessage(3, now - 60000), turnStart(20, now - 1000)]
  const { service } = makeService(events, 5)
  const { host, captured } = makeHost(service)
  host.handle(session, turnStart(20, now - 1000))
  await host.drain()
  eq('继承前缀里的消息不补', captured.length, 0)
}

// 12. 纯函数
{
  eq('eventsOf 取事件数组', eventsOf({ events: [1, 2] }).length, 2)
  eq('eventsOf 形状不对返回空', eventsOf({ events: 'x' }).length, 0)
  eq('turnStartOf 识别', turnStartOf(turnStart(3, now))?.seq, 3)
  eq('inheritedCountOf 数字', inheritedCountOf({ inheritedEventCount: 5 }), 5)
  eq('inheritedCountOf 函数', inheritedCountOf({ inheritedEventCount: () => 7 }), 7)
  eq('inheritedCountOf 无效值归零', inheritedCountOf({ inheritedEventCount: -1 }), 0)
  eq('inheritedCountOf 缺字段归零', inheritedCountOf({}), 0)
}

console.log(`\n${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
