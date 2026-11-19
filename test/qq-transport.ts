/**
 * P4-C-0：qq-onebot Transport 适配器。
 */
import {
  QQ_TRANSPORT_ID,
  QQ_TRANSPORT_PLATFORM,
  createQqTransport,
  mapQqSendResult,
} from '../dist/lib/qq-transport.js'

let passed = 0
let failed = 0
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  console.error(`FAIL ${label}${detail === '' ? '' : ` :: ${detail}`}`)
}

const privateTarget = { kind: 'private' as const, platform: 'qq', stableUserId: '10001' }
const groupTarget = { kind: 'group' as const, platform: 'qq', groupId: '88888' }

function makeDeps(overrides = {}) {
  const calls = []
  const deps = {
    state: 'connected',
    waitResult: true,
    waitCalls: 0,
    sendImpl: async (target, text) => {
      calls.push({ target, text })
      return { ok: true, messageId: 'm-1' }
    },
    sendText: async (target, text) => deps.sendImpl(target, text),
    status: () => deps.state,
    waitConnected: async (_timeoutMs) => {
      deps.waitCalls += 1
      return deps.waitResult
    },
    ...overrides,
  }
  return { deps, calls }
}

// A. 结果映射
{
  ok('A1 ok → accepted', mapQqSendResult({ ok: true }).outcome === 'accepted')
  const withId = mapQqSendResult({ ok: true, messageId: '42' })
  ok('A2 ok 带 messageId', withId.outcome === 'accepted' && withId.messageId === '42')
  const timeout = mapQqSendResult({ ok: false, error: 'timeout' })
  ok('A3 timeout → unknown', timeout.outcome === 'unknown' && timeout.errorCode === 'send-timeout')
  const offline = mapQqSendResult({ ok: false, error: 'not-connected' })
  ok('A4 not-connected → retryable', offline.outcome === 'retryable')
  const failed = mapQqSendResult({ ok: false, error: 'send-failed' })
  ok('A5 send-failed → permanent', failed.outcome === 'permanent' && failed.errorCode === 'send-failed')
  const unknown = mapQqSendResult({ ok: false })
  ok('A6 无 error → permanent send-failed', unknown.outcome === 'permanent' && unknown.errorCode === 'send-failed')
  const limited = mapQqSendResult({ ok: false, error: 'retcode:429' })
  ok('A7 retcode:429 → retryable rate_limited', limited.outcome === 'retryable' && limited.errorCode === 'rate_limited')
}

// B. 静态身份与能力
{
  const { deps } = makeDeps()
  const transport = createQqTransport(deps)
  ok('B1 id', transport.id === QQ_TRANSPORT_ID)
  ok('B2 平台', transport.platform === QQ_TRANSPORT_PLATFORM)
  const caps = transport.capabilities()
  ok('B3 能力 text/reply/proactive', caps.text && caps.replyQuote && caps.proactive)
  ok('B4 能力 image=false', caps.image === false)
  ok('B5 自定义 id', createQqTransport(deps, { id: 'qq-test' }).id === 'qq-test')
}

// C. 状态与等待
{
  const { deps } = makeDeps({ state: 'degraded' })
  const transport = createQqTransport(deps)
  ok('C1 状态透传', transport.status() === 'degraded')
  ok('C2 degraded 视为可用', (await transport.waitConnected(10)) === true)
  ok('C3 已可用不调 deps', deps.waitCalls === 0)

  const disconnected = makeDeps({ state: 'disconnected', waitResult: false })
  const t2 = createQqTransport(disconnected.deps)
  ok('C4 断开时委托 wait', (await t2.waitConnected(30)) === false)
  ok('C5 wait 调用一次', disconnected.deps.waitCalls === 1)

  const throwing = makeDeps({
    state: 'disconnected',
    waitConnected: async () => {
      throw new Error('boom')
    },
  })
  ok('C6 wait 抛错收敛 false', (await createQqTransport(throwing.deps).waitConnected(5)) === false)
}

// D. 发送目标映射
{
  const { deps, calls } = makeDeps()
  const transport = createQqTransport(deps)
  const result = await transport.send(privateTarget, { text: '你好' })
  ok('D1 私聊 accepted', result.outcome === 'accepted' && result.messageId === 'm-1')
  ok('D2 私聊 userId', calls[0]?.target.kind === 'private' && calls[0]?.target.userId === '10001')
  ok('D3 正文透传', calls[0]?.text === '你好')

  await transport.send(groupTarget, { text: '群里' })
  ok('D4 群聊 groupId', calls[1]?.target.kind === 'group' && calls[1]?.target.groupId === '88888')

  const otherPlatform = await transport.send(
    { kind: 'private', platform: 'telegram', stableUserId: '1' },
    { text: 'x' },
  )
  ok('D5 平台不符 permanent', otherPlatform.outcome === 'permanent' && otherPlatform.errorCode === 'unsupported-target')
  ok('D6 平台不符不发送', calls.length === 2)

  const empty = await transport.send(privateTarget, { text: '   ' })
  ok('D7 空正文 permanent', empty.outcome === 'permanent' && empty.errorCode === 'empty-text')

  const offlineDeps = makeDeps({
    sendImpl: async () => ({ ok: false, error: 'not-connected' }),
  })
  const offline = await createQqTransport(offlineDeps.deps).send(privateTarget, { text: 'x' })
  ok('D8 离线 retryable', offline.outcome === 'retryable')

  const throwingDeps = makeDeps({
    sendImpl: async () => {
      throw new Error('ws down')
    },
  })
  const thrown = await createQqTransport(throwingDeps.deps).send(privateTarget, { text: 'x' })
  ok('D9 异常 unknown（不得当成失败重发）', thrown.outcome === 'unknown' && thrown.errorCode === 'send-exception')
}

// E. close 不关闭共享连接
{
  const { deps } = makeDeps()
  const transport = createQqTransport(deps)
  await transport.close()
  ok('E1 close 后仍可读状态', transport.status() === 'connected')
  ok('E2 close 幂等', (await transport.close(), true))
}

console.log(`[P4-C-0 qq-transport] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exit(1)
