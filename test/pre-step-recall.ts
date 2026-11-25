// Q5-F：日常召回迁到 agent/pre-step 之后的入口判定。
//
// 时序探针实测的关键事实：`payload.messages` 里 `role` 全是 `user`，但
// `source.kind` 分三种（user / agent-message / subagent-settled）。按 role 取
// 本轮问题会把「子代理完成回执」当成用户提问——这类消息是系统回执，拿它去查
// 日常召回毫无意义，还会顶掉真正的用户问题。
//
// 下面把四种状态一次钉住：委派优先、无用户输入、候选不唯一、唯一命中。
import assert from 'node:assert/strict'
import {
  buildRecallMessage,
  delegationOfAgent,
  extractRecallQuery,
  RECALL_INJECTION,
  RECALL_MESSAGE_PREFIX,
  stripRecallBlocks,
  textOfContent,
} from '../dist/lib/pre-step-recall.js'

let passed = 0
const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const userMsg = (id: string, text: string): unknown => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

const agentMsg = (id: string, text: string): unknown => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'agent-message' },
})

const settledMsg = (): unknown => ({
  id: 'settled-1',
  role: 'user',
  content: [{ type: 'text', text: '[Agent probe finished]' }],
  source: { kind: 'subagent-settled' },
})

await test('接收者身份未验证时不查（fail-closed）', () => {
  const result = extractRecallQuery({
    messages: [userMsg('m1', '我之前跟你说过蓝盒子的标签')],
    delegated: false,
    receiverVerified: false,
  })
  assert.equal(result.status, 'receiver-unverified')
  assert.equal(result.query, null)
})

await test('委派接收者优先短路：即使带 kind=user 也不读正文', () => {
  const result = extractRecallQuery({
    messages: [userMsg('m1', '我之前跟你说过蓝盒子的标签')],
    delegated: true,
    receiverVerified: true,
  })
  assert.equal(result.status, 'delegated')
  assert.equal(result.query, null)
  assert.equal(result.queryMode, 'none')
})

await test('只有代理事件时是 no-user-input', () => {
  const result = extractRecallQuery({
    messages: [agentMsg('m2', '帮我查一下'), settledMsg()],
    delegated: false,
    receiverVerified: true,
  })
  assert.equal(result.status, 'no-user-input')
  assert.equal(result.query, null)
})

await test('多条用户候选无法唯一定位时拒绝猜', () => {
  const result = extractRecallQuery({
    messages: [userMsg('m3', '问题一'), userMsg('m4', '问题二')],
    delegated: false,
    receiverVerified: true,
  })
  assert.equal(result.status, 'current-user-message-unresolved')
  assert.equal(result.query, null)
  assert.equal(result.queryMode, 'none')
})

await test('唯一命中时取正文，并区分具体查询与续聊', () => {
  const specific = extractRecallQuery({
    messages: [settledMsg(), userMsg('m5', '之前蓝盒子的标签叫什么')],
    delegated: false,
    receiverVerified: true,
  })
  assert.equal(specific.status, 'ok')
  assert.equal(specific.query, '之前蓝盒子的标签叫什么')
  assert.equal(specific.messageId, 'm5')
  assert.equal(specific.queryMode, 'specific')

  const followUp = extractRecallQuery({
    messages: [userMsg('m6', '接着上次说')],
    delegated: false,
    receiverVerified: true,
  })
  assert.equal(followUp.queryMode, 'continue')
})

await test('正文为空的用户消息退成 no-user-input', () => {
  const result = extractRecallQuery({
    messages: [{ id: 'm7', role: 'user', content: [], source: { kind: 'user' } }],
    delegated: false,
    receiverVerified: true,
  })
  assert.equal(result.status, 'no-user-input')
  assert.equal(result.messageId, 'm7')
})

await test('content 里的非文本 part 被跳过', () => {
  const text = textOfContent([
    { type: 'text', text: '第一段' },
    { type: 'image', url: 'x' },
    { type: 'text', text: '第二段' },
  ])
  assert.equal(text, '第一段\n第二段')
})

await test('摘旧块只认来源标记，不碰用户自己写的同样文本', () => {
  const recallOld = buildRecallMessage({
    text: '旧的召回块',
    sourceIds: ['src_1'],
    sessionRef: 'session-A',
    id: 'old',
  })
  const memoryBlock = {
    id: 'msg_psyche_memory_1',
    role: 'user',
    content: [{ type: 'text', text: '记忆上下文' }],
    source: { kind: 'psyche-memory', psyche: { injection: 'memory-context' } },
  }
  const userSaysSameWords = userMsg('u-1', '旧的召回块')
  const kept = stripRecallBlocks([recallOld, memoryBlock, userSaysSameWords])
  assert.equal(kept.length, 2, '召回块被摘掉，其它两块保留')
  assert.ok(!kept.some((m) => (m as { id?: string }).id === (recallOld as { id: string }).id))
  assert.ok(kept.includes(memoryBlock as never))
  assert.ok(kept.includes(userSaysSameWords as never))
})

await test('注入块的形状：role 是 user，但 source.kind 不是 user', () => {
  const message = buildRecallMessage({
    text: '- 11-21 17:08 你说：…',
    sourceIds: ['src_a', 'src_b'],
    sessionRef: 'session-1',
    id: 'x1',
  }) as {
    id: string
    role: string
    content: Array<{ type: string; text: string }>
    source: { kind: string; summary: string; psyche: { injection: string; sourceIds: string[] } }
  }
  assert.ok(message.id.startsWith(RECALL_MESSAGE_PREFIX))
  assert.equal(message.role, 'user', 'Provider 要看到正文，必须是 user 语义')
  assert.notEqual(message.source.kind, 'user', '但不能冒充用户说的话')
  assert.equal(message.source.kind, 'psyche-memory')
  assert.equal(message.source.psyche.injection, RECALL_INJECTION)
  assert.deepEqual(message.source.psyche.sourceIds, ['src_a', 'src_b'])
  assert.ok(message.source.summary.includes('2 条来源'))
  assert.ok(message.content[0]!.text.includes('17:08'))
})

await test('委派深度从会话 header 读：缺席是顶层，正数是子代理', () => {
  // 顶层会话：header 在，delegationDepth 缺席
  assert.equal(delegationOfAgent({ session: { header: { version: 0, id: 's1' } } }), false)
  // 显式 0 也是顶层
  assert.equal(delegationOfAgent({ session: { header: { delegationDepth: 0 } } }), false)
  // 子代理：父深度 + 1
  assert.equal(delegationOfAgent({ session: { header: { delegationDepth: 1 } } }), true)
  assert.equal(delegationOfAgent({ session: { header: { delegationDepth: 3 } } }), true)
  // 只有展示用的 origin 时按否定信号用
  assert.equal(delegationOfAgent({ session: { header: { origin: 'subagent' } } }), true)
  // 拿不到 header 才是「判不出」，交给 fail-closed
  assert.equal(delegationOfAgent({}), null)
  assert.equal(delegationOfAgent({ session: {} }), null)
  assert.equal(delegationOfAgent(null), null)
})

await test('判不出接收者身份时不查（fail-closed 走 receiver-unverified）', () => {
  const unresolved = extractRecallQuery({
    messages: [userMsg('m1', '之前蓝盒子的标签叫什么？')],
    delegated: null,
    receiverVerified: false,
  })
  assert.equal(unresolved.status, 'receiver-unverified')
  assert.equal(unresolved.query, null)
})

console.log(`${passed} 通过 0 失败`)
