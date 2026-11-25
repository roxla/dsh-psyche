/**
 * P4-B-5-1：QQ 诊断事件字段白名单、环形缓冲、过滤与分页。
 * 只测内存模块；Host 页面/路由由 B-5-3 验收。
 */
import { strict as assert } from 'node:assert'
import { QqDiagnostics, canExportDiagnostics, parseQqDiagnosticFilter, QQ_DIAGNOSTIC_LIMIT } from '../dist/lib/qq-diagnostics.js'
import { QqBridge } from '../dist/lib/qq-bridge.js'

let passed = 0
function eq(label: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, label)
  passed += 1
}
function ok(label: string, value: unknown): void {
  assert.ok(value, label)
  passed += 1
}

const targetPrivate = (userId: string) => ({ kind: 'private' as const, userId })
const targetGroup = (groupId: string) => ({ kind: 'group' as const, groupId })

// A. 事件构造与脱敏
{
  const diagnostics = new QqDiagnostics()
  const event = diagnostics.record({
    direction: 'in',
    target: targetPrivate('10001234'),
    result: 'delivered',
    textLength: 12,
    media: [{ type: 'image', count: 2 }, { type: 'image', count: 3 }, { type: 'record', count: 1 }],
  })
  eq('A1 seq 从 1 开始', event.seq, 1)
  eq('A2 私聊 contactRef 掩码', event.contactRef, '100****34')
  eq('A3 私聊 roomRef 为空', event.roomRef, null)
  eq('A4 platform 固定 qq', event.platform, 'qq')
  eq('A5 媒体按类型合并', event.media, [{ type: 'image', count: 5 }, { type: 'record', count: 1 }])
  eq('A6 文本只保留长度', event.textLength, 12)
  ok('A7 无正文/原始字段', !('text' in event) && !('message' in event) && !('url' in event))

  const groupEvent = diagnostics.record({
    direction: 'out',
    target: targetGroup('987654321'),
    result: 'accepted',
    textLength: 5,
  })
  eq('A8 群 roomRef 掩码', groupEvent.roomRef, '987****21')
  eq('A9 群 contactRef 为空', groupEvent.contactRef, null)
  eq('A10 目标类型', groupEvent.target, 'group')
}

// B. 媒体与错误码白名单
{
  const diagnostics = new QqDiagnostics()
  const event = diagnostics.record({
    direction: 'out',
    target: targetPrivate('20001'),
    result: 'failed',
    errorCode: 'not-connected',
    textLength: 100_000,
    media: [{ type: 'image', count: 200 }, { type: 'unknown', count: 1 }, { type: 'file', count: 0 }],
  })
  eq('B1 白名单错误码保留', event.errorCode, 'not-connected')
  eq('B2 未知媒体类型丢弃', event.media, [])
  eq('B3 文本长度封顶', event.textLength, 10_000)

  const folded = diagnostics.record({
    direction: 'out', target: targetPrivate('20001'), result: 'failed', errorCode: 'raw stack trace', textLength: 0,
  })
  eq('B4 自由文本错误码折叠', folded.errorCode, 'other')
}

// C. 结果与时间过滤（AND / result OR / 左闭右开）
{
  const diagnostics = new QqDiagnostics()
  const base = Date.parse('2026-11-14T10:00:00.000Z')
  for (let i = 0; i < 6; i += 1) {
    diagnostics.record({
      direction: i % 2 === 0 ? 'in' : 'out',
      target: targetPrivate(`1000${i}`),
      result: i === 0 ? 'rejected' : i === 1 ? 'rate_limited' : i === 2 ? 'out_of_scope' : i === 3 ? 'deduplicated' : 'delivered',
      textLength: i,
      at: new Date(base + i * 1000),
    })
  }
  const query = (search: string) => {
    const parsed = parseQqDiagnosticFilter(new URLSearchParams(search))
    assert.ok(parsed.ok, `filter ${search}`)
    return diagnostics.query(parsed.filter)
  }
  eq('C1 方向过滤', query('direction=in').items.map((event) => event.seq), [5, 3, 1])
  eq('C2 result OR', query('result=rejected,rate_limited').items.map((event) => event.seq), [2, 1])
  eq('C3 组合 AND', query('direction=out&result=delivered').items.map((event) => event.seq), [6])
  eq('C4 from 含', query(`from=${new Date(base + 3000).toISOString()}`).items.length, 3)
  eq('C5 to 不含', query(`to=${new Date(base + 3000).toISOString()}`).items.length, 3)
  eq('C6 before 游标', query('before=5').items.map((event) => event.seq), [4, 3, 2, 1])
  eq('C7 matched 为过滤后总数', query('direction=in&limit=1').matched, 3)
  eq('C8 分页 nextBefore', query('direction=in&limit=1').nextBefore, 5)
  eq('C9 分页第二页', query('direction=in&limit=1&before=5').items.map((event) => event.seq), [3])
  eq('C10 分页不改变 matched 总数', query('direction=in&limit=1&before=5').matched, 3)
}

// D. 环形缓冲上限与顺序
{
  const diagnostics = new QqDiagnostics()
  for (let i = 0; i < QQ_DIAGNOSTIC_LIMIT + 5; i += 1) {
    diagnostics.record({ direction: 'in', target: targetPrivate('10001'), result: 'delivered', textLength: 0 })
  }
  eq('D1 有界缓冲', diagnostics.size, QQ_DIAGNOSTIC_LIMIT)
  const parsed = parseQqDiagnosticFilter(new URLSearchParams('limit=100'))
  assert.ok(parsed.ok)
  const page = diagnostics.query(parsed.filter)
  eq('D2 保留最新事件', page.items[0]!.seq, QQ_DIAGNOSTIC_LIMIT + 5)
  eq('D3 最旧被淘汰', page.matched, QQ_DIAGNOSTIC_LIMIT)
}

// E. 过滤参数严格校验
{
  const invalid = (search: string): string => {
    const parsed = parseQqDiagnosticFilter(new URLSearchParams(search))
    assert.equal(parsed.ok, false, search)
    return (parsed as { message: string }).message
  }
  ok('E1 未知参数', invalid('foo=1').includes('不支持'))
  ok('E2 limit 越界', invalid('limit=101').includes('limit'))
  ok('E3 limit 非数', invalid('limit=x').includes('limit'))
  ok('E4 before 非法', invalid('before=-1').includes('before'))
  ok('E5 direction 非法', invalid('direction=sideways').includes('direction'))
  ok('E6 target 非法', invalid('target=room').includes('target'))
  ok('E7 result 非法', invalid('result=nope').includes('result'))
  ok('E8 时间非法', invalid('from=yesterday').includes('from'))
  ok('E9 from>=to', invalid('from=2026-11-14T10:00:00Z&to=2026-11-14T09:00:00Z').includes('早于'))
  ok('E10 重复参数', invalid('limit=1&limit=2').includes('limit'))
  ok('E11 contactRef 过长', invalid(`contactRef=${'x'.repeat(33)}`).includes('过长'))
  ok('E12 默认分页', (() => {
    const parsed = parseQqDiagnosticFilter(new URLSearchParams(''))
    assert.ok(parsed.ok)
    return parsed.filter.limit === 50 && parsed.filter.before === null
  })())
}

// F. 桥接埋点：入站结果进入诊断流，正文不进入
{
  class FakeSocket {
    static last: any = null
    listeners = new Map<string, any[]>()
    sent: any[] = []
    replies = 0
    constructor(_url: string) { FakeSocket.last = this }
    addEventListener(type: string, fn: any) {
      const list = this.listeners.get(type) ?? []
      list.push(fn)
      this.listeners.set(type, list)
    }
    send(data: string) {
      const parsed = JSON.parse(data)
      this.sent.push(parsed)
      const echo = parsed.echo
      queueMicrotask(() => {
        this.replies += 1
        this.emit({ status: 'ok', retcode: 0, data: { message_id: `reply-${this.replies}` }, echo })
      })
    }
    close() {}
    emit(event: unknown) {
      for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(event) })
    }
  }
  let seq = 0
  const privateEvent = (userId: string) => {
    seq += 1
    return {
      post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: '99999',
      user_id: userId, message_id: `diag-${seq}`, raw_message: '诊断正文不应落库',
      sender: { user_id: userId },
    }
  }
  const bridge = new QqBridge({
    enabled: true, wsUrl: 'ws://127.0.0.1:1', accessToken: '', provider: 'p', model: 'm',
    allowFrom: { owner: '10001234', extra: [] },
    rejectCooldownMs: 24 * 60 * 60_000, rejectGlobalLimit: 20, rejectGlobalWindowMs: 60 * 60_000,
    sendTimeoutMs: 5_000,
  } as any, {
    host: {
      agents: {
        get: () => undefined,
        resume: async () => { throw new Error('session not found: qq-private-10001') },
        create: async () => ({ agent: { followup() {} } }),
      },
      on: () => () => {},
    },
    adapter: { announce() {}, forget() {}, size() { return 0 } },
    logger: { info() {}, warn() {}, error() {} },
    webSocket: FakeSocket as any,
    allowLegacyAgentCreate: true,
    isSessionBound: () => true,
  } as any)
  bridge.start()
  const socket = FakeSocket.last
  socket.emit(privateEvent('10001234'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  socket.emit(privateEvent('20002222'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  socket.emit(privateEvent('20002222'))
  await new Promise((resolve) => setTimeout(resolve, 10))

  const all = parseQqDiagnosticFilter(new URLSearchParams('limit=50'))
  assert.ok(all.ok)
  const page = bridge.diagnosticPage(all.filter)
  eq('F1 已授权入站记 delivered', page.items.some((event) => event.result === 'delivered' && event.contactRef === '100****34'), true)
  eq('F2 未授权记 rejected', page.items.some((event) => event.result === 'rejected' && event.contactRef === '200****22'), true)
  eq('F3 冷却期记 rate_limited', page.items.some((event) => event.result === 'rate_limited'), true)
  eq('F4 诊断流无正文/URL', page.items.every((event) => !('text' in event) && !('url' in event) && !('message' in event)), true)
  eq('F5 结果枚举受控', page.items.every((event) => ['accepted', 'delivered', 'rejected', 'rate_limited', 'out_of_scope', 'deduplicated', 'failed', 'unknown'].includes(event.result)), true)
  eq('F6 导出在无可信鉴权时固定关闭', canExportDiagnostics(), false)
}

console.log(`[P4-B-5 qq-diagnostics] ${passed} 通过 0 失败`)
