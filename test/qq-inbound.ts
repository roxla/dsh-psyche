/**
 * P4-B-1：QQ 入站媒体/引用识别与 CQ 兜底脱敏。
 *
 * 只验证纯解析与 capture metadata；不证明真实 OneBot 平台行为。
 */
import { oneBotMessage, oneBotText, qqUserMessage } from '../dist/lib/qq-bridge.js'
import { classifySessionEvent, normalizeSessionEvent } from '../dist/lib/capture-host.js'

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

// 1. 结构化消息：text + image，媒体只留类型/数量。
const mixed = oneBotMessage({
  message: [
    { type: 'text', data: { text: '看这个' } },
    { type: 'image', data: { file: 'a.jpg', url: 'https://cdn.example/a.jpg' } },
  ],
})
ok('array text+image text', mixed.text === '看这个[图片]', mixed.text)
ok('array image media', mixed.media.length === 1 && mixed.media[0].type === 'image' && mixed.media[0].count === 1)
ok('array image no url', !mixed.text.includes('http') && !JSON.stringify(mixed).includes('cdn.example'))

// 2. reply / at / face：引用 id 单独返回，@ 只保留昵称，不泄漏 QQ 号。
const replied = oneBotMessage({
  message: [
    { type: 'reply', data: { id: 42 } },
    { type: 'at', data: { qq: '10001', name: '小明' } },
    { type: 'text', data: { text: ' 看一下' } },
    { type: 'face', data: { id: 178 } },
  ],
})
ok('array reply id', replied.replyToMessageId === '42', String(replied.replyToMessageId))
ok('array at name', replied.text.includes('@小明') && !replied.text.includes('10001'), replied.text)
ok('array face label', replied.text.includes('[表情]'), replied.text)
ok('array mentions', replied.mentions === 1)

// 3. raw_message CQ 兜底：图片参数丢弃，保留正文。
const cq = oneBotMessage({ raw_message: '[CQ:image,file=/tmp/secret.png,url=https://x/y.png]晚上好' })
ok('cq image text', cq.text === '[图片]晚上好', cq.text)
ok('cq image no path/url', !cq.text.includes('/tmp') && !cq.text.includes('https://'))
ok('cq image media', cq.media[0]?.type === 'image')

// 4. CQ reply 只取 id，不进入模型正文。
const cqReply = oneBotMessage({ raw_message: '[CQ:reply,id=77]收到了' })
ok('cq reply id', cqReply.replyToMessageId === '77', String(cqReply.replyToMessageId))
ok('cq reply text', cqReply.text === '收到了', cqReply.text)

// 5. 未知 CQ 标签只留占位，file/路径不泄漏。
const unknownCq = oneBotMessage({ raw_message: '[CQ:trace,file=/etc/passwd]hi' })
ok('cq unknown placeholder', unknownCq.text === '[消息]hi', unknownCq.text)
ok('cq unknown no path', !unknownCq.text.includes('/etc/passwd'))

// 6. 纯媒体消息仍有可读正文；纯空消息为空。
const imageOnly = oneBotMessage({ message: [{ type: 'image', data: { file: 'x.jpg' } }] })
ok('media only text', imageOnly.text === '[图片]', imageOnly.text)
const empty = oneBotMessage({ message: [] })
ok('empty message', empty.text === '' && empty.media.length === 0)

// 7. 上限截断与旧 oneBotText 兼容。
const longText = 'x'.repeat(20)
ok('max text', oneBotMessage({ message: [{ type: 'text', data: { text: longText } }] }, 5).text.length === 5)
ok('oneBotText compat', oneBotText({ raw_message: '你好' }) === '你好')

// 8. qqUserMessage 把媒体摘要挂在 source.psyche，不进入正文。
const message = qqUserMessage('看这个[图片]', '9001', [{ type: 'image', count: 1 }])
const source = message.source as { kind?: string; psyche?: { media?: unknown } }
ok('user message role', message.role === 'user')
ok('user message media source', source.kind === 'user' && Array.isArray(source.psyche?.media))

// 9. 无媒体时不添加空 psyche 字段。
const plain = qqUserMessage('你好', null)
ok('plain user message no media', (plain.source as { psyche?: unknown }).psyche === undefined)

// 10. capture 分类读取可信媒体摘要；非法类型/计数被丢弃。
const event = {
  type: 'user/message',
  seq: 7,
  time: '2026-11-14T10:00:00.000Z',
  data: {
    id: 'm1',
    content: [{ type: 'text', text: '看这个' }],
    source: {
      kind: 'user',
      psyche: {
        media: [
          { type: 'image', count: 2 },
          { type: 'video', count: 1 },
          { type: 'script', count: 5 },
          { type: 'file', count: 0 },
        ],
      },
    },
  },
}
const classified = classifySessionEvent(event)
ok('classify media', classified?.metadata?.['media'] !== undefined)
const media = (classified?.metadata?.['media'] ?? []) as Array<{ type: string; count: number }>
ok('classify media whitelist', media.length === 2 && media[0].type === 'image' && media[0].count === 2)
ok('classify media rejects bad', media.every((item) => item.type !== 'script' && item.count > 0))

// 11. normalize 把媒体摘要并入 Source.metadata，同时保留 dsh 字段。
const normalized = normalizeSessionEvent({ id: 'qq-private-10005' }, event, { resolveSender: () => 'ct_test' })
const metadata = (normalized?.input.metadata ?? {}) as { dsh?: unknown; media?: unknown }
ok('normalize keeps dsh', metadata.dsh !== undefined)
ok('normalize keeps media', Array.isArray(metadata.media))
ok('normalize source private', normalized?.input.platform === 'qq' && normalized.input.channel === 'private')

// 12. 模型回复不携带媒体 metadata。
const assistant = classifySessionEvent({
  type: 'assistant/message',
  seq: 8,
  data: { message: { id: 'm2', source: { kind: 'model' }, content: [{ type: 'text', text: '收到' }] } },
})
ok('assistant no media', assistant !== null && assistant.metadata === undefined)

console.log(`[P4-B-1 qq-inbound] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
