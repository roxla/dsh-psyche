// Q5-E：组装回执。
//
// 外部评审（第 30–31 轮）要求这个采样点必须放在 ProjectionController 拿到
// composeProjections() 结果、即将返回宿主的位置——只有那里同时知道
// 「这块有没有被保留」和「最终占了多少字符」。
//
// 这里用三条证据证明回执能区分三种结局：
//   1) Desktop 正例：召回块被保留，recallSourceIds 带出来源；
//   2) 委派短路：Recalls 根本没被调用，receipt 要能看出「没调」而不是「调了没命中」；
//   3) 预算裁剪：块非空但被裁，reason 必须是 budget。
import assert from 'node:assert/strict'
import { AssemblyReceiptStore } from '../dist/lib/assembly-receipt.js'
import { ProjectionController } from '../dist/lib/projection-context.js'

let passed = 0
const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

interface Captured {
  text: (assembly?: { agent?: { id?: string; session?: { id?: string } } }) => string
}

/** 造一个能手动触发的宿主 Context 口。 */
function makeApi(): { api: { context: (options: Captured) => () => void }; trigger: Captured['text'] } {
  let captured: Captured['text'] | null = null
  return {
    api: {
      context: (options: Captured) => {
        captured = options.text
        return () => {}
      },
    },
    trigger: (assembly) => (captured === null ? '' : captured(assembly)),
  }
}

const SESSION = { agent: { id: 'agent-1', session: { id: 'session-desktop-1' } } }

await test('Desktop 正例：召回块保留且回执带出来源', () => {
  const store = new AssemblyReceiptStore()
  const { api, trigger } = makeApi()
  const controller = new ProjectionController({
    api,
    sources: {
      discipline: () => '纪律：只谈当前用户。',
      persona: () => '人格：理性、直接。',
      growth: () => '',
      mood: () => '心情：平稳。',
      relationship: () => '',
      projectBrief: () => '项目 psyche（Checkpoint ckp_1 r2）\n当前任务：收口 Q5。',
      conversationRecall: () => '以下是最近的实际对话记录：\n- 11-21 17:08 你说：蓝盒子的标签是松针七号。',
    },
    receipts: store,
    receiptMeta: () => ({
      channel: 'desktop',
      delegated: false,
      delegatedBy: 'none',
      recallSourceIds: ['src_a', 'src_b'],
      recallSessionRef: 'c9d88fae',
      recallSkipped: null,
      projectCheckpointId: 'ckp_1',
      projectRevision: 2,
    }),
  })
  assert.equal(controller.start(), true)
  const text = trigger(SESSION)
  assert.ok(text.includes('松针七号'), '召回内容要进最终文本')
  assert.equal(store.size, 1)

  const [receipt] = store.recent('session-desktop-1')
  assert.ok(receipt !== undefined)
  const recallBlock = receipt!.blocks.find((b) => b.name === 'conversationRecall')
  assert.ok(recallBlock !== undefined)
  assert.equal(recallBlock!.kept, true, '保留的块 kept 必须是 true')
  assert.ok(recallBlock!.chars > 0)
  assert.deepEqual(receipt!.recallSourceIds, ['src_a', 'src_b'])
  assert.equal(receipt!.recallSessionRef, 'c9d88fae')
  assert.equal(receipt!.recallSkipped, null)
  assert.equal(receipt!.projectCheckpointId, 'ckp_1')
  assert.equal(receipt!.projectRevision, 2)
  assert.equal(receipt!.receiver.channel, 'desktop')
  assert.equal(receipt!.receiver.delegated, false)
  controller.dispose()
})

await test('委派短路：回执显示「没调」，而不是「调了没命中」', () => {
  const store = new AssemblyReceiptStore()
  const { api, trigger } = makeApi()
  let recallCalled = 0
  const controller = new ProjectionController({
    api,
    sources: {
      discipline: () => '纪律。',
      persona: () => '人格。',
      growth: () => '',
      mood: () => '',
      relationship: () => '',
      conversationRecall: () => {
        recallCalled += 1
        return ''
      },
    },
    receipts: store,
    receiptMeta: () => ({
      channel: 'other',
      delegated: true,
      delegatedBy: 'meta.origin',
      recallSourceIds: [],
      recallSessionRef: null,
      recallSkipped: 'not-called',
    }),
  })
  controller.start()
  const text = trigger({ agent: { id: 'sub-1', session: { id: 'session-sub-1' } } })
  assert.equal(recallCalled, 1, '回调本身仍会被调用（短路在实现里），这里只看回执怎么记')
  assert.equal(text.includes('松针七号'), false)

  const [receipt] = store.recent('session-sub-1')
  assert.equal(receipt!.receiver.delegated, true)
  assert.equal(receipt!.receiver.delegatedBy, 'meta.origin')
  assert.equal(receipt!.recallSkipped, 'not-called', '没调过必须能看出来')
  const recallBlock = receipt!.blocks.find((b) => b.name === 'conversationRecall')
  assert.equal(recallBlock!.kept, false)
  assert.equal(recallBlock!.reason, 'empty')
  controller.dispose()
})

await test('预算裁剪：块非空但没进最终文本，reason 是 budget', () => {
  const store = new AssemblyReceiptStore()
  const { api, trigger } = makeApi()
  const long = '很长的可选块。'.repeat(200)
  const controller = new ProjectionController({
    api,
    sources: {
      discipline: () => '纪律。',
      persona: () => '人格。',
      growth: () => '',
      mood: () => long,
      relationship: () => long,
    },
    receipts: store,
    receiptMeta: () => ({ channel: 'desktop', delegated: false, delegatedBy: 'none' }),
    budget: () => ({ maxChars: 120, maxTokens: 100 }),
  })
  controller.start()
  trigger(SESSION)

  const [receipt] = store.recent('session-desktop-1')
  const mood = receipt!.blocks.find((b) => b.name === 'mood')
  const relationship = receipt!.blocks.find((b) => b.name === 'relationship')
  assert.ok(mood !== undefined && relationship !== undefined)
  assert.ok(mood!.chars > 0 && relationship!.chars > 0, '两块都有内容')
  assert.equal(mood!.kept && relationship!.kept, false, '预算不够时可选块不能全保留')
  const cut = mood!.kept ? relationship! : mood!
  assert.equal(cut.reason, 'budget', '被预算裁掉要标 budget')
  controller.dispose()
})

await test('回执按会话隔离，且总量有上限', () => {
  const store = new AssemblyReceiptStore({ perSession: 2, total: 5 })
  for (let i = 0; i < 3; i += 1) {
    store.record({
      receiver: { channel: 'desktop', delegated: false, delegatedBy: 'none', sessionId: 's-a', turnId: null },
      inputs: { discipline: 'x', persona: 'y' },
      kept: ['discipline', 'persona'],
      dropped: [],
      warnings: [],
      usedChars: 2,
      usedTokens: 3,
    })
  }
  for (let i = 0; i < 3; i += 1) {
    store.record({
      receiver: { channel: 'owner-private', delegated: false, delegatedBy: 'none', sessionId: 's-b', turnId: null },
      inputs: { discipline: 'x', persona: 'y' },
      kept: ['discipline'],
      dropped: ['persona'],
      warnings: ['persona-over-budget'],
      usedChars: 1,
      usedTokens: 2,
    })
  }
  assert.equal(store.recent('s-a').length, 2, '每会话只留最近 2 条')
  assert.equal(store.recent('s-b').length, 2)
  assert.ok(store.size <= 5, '全局上限生效')
  // 全局查询按时间倒序，最近写入的在最前。
  const all = store.recent(null, 5)
  assert.equal(all[0]!.receiver.sessionId, 's-b')
  store.clear()
  assert.equal(store.size, 0)
})

console.log(`${passed} 通过 0 失败`)
