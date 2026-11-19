/**
 * P4-C-0：ChatTransport 契约与 Mock Transport。
 */
import { MockChatTransport, chatTargetKey } from '../packages/core/dist/chat-transport.js'

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

const target = { kind: 'private' as const, platform: 'qq', stableUserId: '10001' }

// A. 基本形状
{
  const transport = new MockChatTransport()
  ok('A1 默认 id', transport.id === 'mock')
  ok('A2 默认平台', transport.platform === 'mock')
  ok('A3 默认 connected', transport.status() === 'connected')
  const caps = transport.capabilities()
  ok('A4 能力 text', caps.text === true)
  ok('A5 能力 proactive 默认 false', caps.proactive === false)
  caps.text = false
  ok('A6 能力返回副本', transport.capabilities().text === true)
}

// B. 发送与结果序列
{
  const transport = new MockChatTransport()
  const first = await transport.send(target, { text: '你好' })
  ok('B1 accepted', first.outcome === 'accepted')
  ok('B2 messageId 回显序号', first.messageId === 'mock-1')
  ok('B3 记录目标', transport.sends[0]?.target.kind === 'private')
  ok('B4 记录正文', transport.sends[0]?.outgoing.text === '你好')

  const preset = new MockChatTransport({
    outcomes: [
      { outcome: 'retryable', errorCode: 'not-connected' },
      { outcome: 'permanent', errorCode: 'bad-target' },
      { outcome: 'unknown', errorCode: 'send-timeout' },
    ],
  })
  ok('B5 retryable', (await preset.send(target, { text: 'a' })).outcome === 'retryable')
  ok('B6 permanent', (await preset.send(target, { text: 'b' })).outcome === 'permanent')
  ok('B7 unknown', (await preset.send(target, { text: 'c' })).outcome === 'unknown')
  ok('B8 预设耗尽后 accepted', (await preset.send(target, { text: 'd' })).outcome === 'accepted')
}

// C. 关闭与等待连接
{
  const transport = new MockChatTransport({ state: 'disconnected' })
  ok('C1 初始断开', transport.status() === 'disconnected')
  ok('C2 等待超时返回 false', (await transport.waitConnected(20)) === false)
  transport.setState('connected')
  ok('C3 已连接立即 true', (await transport.waitConnected(20)) === true)
  await transport.close()
  ok('C4 关闭后 disconnected', transport.status() === 'disconnected')
  const afterClose = await transport.send(target, { text: 'x' })
  ok('C5 关闭后发送 permanent', afterClose.outcome === 'permanent' && afterClose.errorCode === 'transport-closed')
}

// D. 目标键
{
  ok('D1 私聊键', chatTargetKey(target) === 'qq:private:10001')
  ok(
    'D2 群聊键',
    chatTargetKey({ kind: 'group', platform: 'qq', groupId: '88888' }) === 'qq:group:88888',
  )
}

console.log(`[P4-C-0 chat-transport] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exit(1)
