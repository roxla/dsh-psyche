// Q5-A：日常对话的原话召回。
//
// 外部评审（第 25–26 轮）定的第一条验收：「短会话只有原文」——
// A 只聊 1 轮、摘要数为 0，新会话 B 说「接着上次说」时，
// 当轮实际组装内容要包含夹具独有的细节（这里用「青屿」）、
// A 的会话标识和正确 Source ID，且新增模型调用为 0。
//
// 这里直接测 buildConversationRecall 的返回值；composer 的块顺序另有断言。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '../dist/lib/adapter.js'
import {
  buildConversationRecall,
  keywordsOf,
} from '../dist/lib/conversation-recall.js'

let passed = 0
const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const logger = { debug() {}, info() {}, warn() {}, error() {} }
const NOW = '2026-02-02T10:00:00.000Z'

type Db = Awaited<ReturnType<typeof openDatabase>>['db']

interface Fixture {
  dir: string
  db: Db
  close: () => void
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-recall-'))
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger })
  migrate(opened.db, logger)
  return {
    dir,
    db: opened.db,
    close: () => {
      opened.db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

interface SeedOptions {
  id: string
  kind: 'message' | 'model'
  text: string
  at: string
  sessionRef?: string | null
  personaId?: string
  platform?: string
  channel?: string
  senderContactId?: string
}

function seed(db: Db, options: SeedOptions): void {
  db.run(
    `INSERT INTO sources (
       source_id, persona_id, platform, channel, session_ref, sender_contact_id,
       kind, text, captured_at, created_at, origin
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      options.id,
      options.personaId ?? 'main',
      options.platform ?? 'desktop',
      options.channel ?? 'desktop',
      options.sessionRef === undefined ? 'session-A' : options.sessionRef,
      options.senderContactId ?? null,
      options.kind,
      options.text,
      options.at,
      options.at,
      'user',
    ],
  )
}

const f = await setup()

await test('关键词命中：跨会话也能找回「青屿」这一轮', () => {
  seed(f.db, {
    id: 'src_a1', kind: 'message', at: '2026-02-01T09:00:00.000Z',
    text: '下周上线 QQ 群回复，先只开灰度群「青屿」',
  })
  seed(f.db, {
    id: 'src_a2', kind: 'model', at: '2026-02-01T09:00:30.000Z',
    text: '好，先只开青屿，灰度期间只看入站不回。',
  })
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'desktop',
    currentSessionRef: 'session-B',
    query: '接着上次说',
    now: NOW,
  })
  assert.equal(result.skipped, null)
  assert.ok(result.text !== null && result.text.includes('青屿'), '召回文本要含夹具独有细节')
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]!.sessionRef, 'session-A', '要能指出是哪个会话')
  assert.deepEqual(result.items[0]!.sourceIds, ['src_a1', 'src_a2'], '要能指回两条 Source')
})

await test('只有当前会话时没有可召回内容', () => {
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'desktop',
    currentSessionRef: 'session-A',
    now: NOW,
  })
  // 库里只有 session-A 自己的对话，而它正是当前会话 → 排除后没有可召回内容。
  assert.equal(result.skipped, 'no-match')
  assert.equal(result.text, null)
})

await test('另一个会话的对话可被召回', () => {
  seed(f.db, {
    id: 'src_b1', kind: 'message', at: '2026-02-01T15:00:00.000Z',
    sessionRef: 'session-B',
    text: '把 SnowLuma 的启动顺序写进设置页',
  })
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'desktop',
    currentSessionRef: 'session-C',
    now: NOW,
  })
  assert.equal(result.skipped, null)
  assert.ok(result.items.some((item) => item.sourceIds.includes('src_b1')))
  assert.ok(result.text !== null && result.text.includes('你说：'))
})

await test('跨平台不可见', () => {
  seed(f.db, {
    id: 'src_q1', kind: 'message', at: '2026-02-01T17:00:00.000Z',
    sessionRef: 'qq-private-1', platform: 'qq',
    text: 'QQ 私聊里说的青屿群也要上线',
  })
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'desktop',
    currentSessionRef: 'session-C',
    now: NOW,
    query: '青屿',
  })
  assert.ok(
    result.items.every((item) => item.sourceIds.every((id) => id !== 'src_q1')),
    'desktop 召回想不应带出 QQ 的 Source',
  )
})

await test('关键词没命中时退到最近一轮（「接着上次说」这类无实词的句子）', () => {
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'desktop',
    currentSessionRef: 'session-C',
    now: NOW,
    query: '接着上次说',
  })
  assert.equal(result.skipped, null)
  assert.ok(result.items.length >= 1)
  assert.ok(
    result.items.every((item) => item.sessionRef !== 'session-C'),
    '当前会话要被排除',
  )
})

await test('超出回溯窗口不召回', () => {
  seed(f.db, {
    id: 'src_old', kind: 'message', at: '2026-01-20T09:00:00.000Z',
    sessionRef: 'session-old',
    text: '很久以前的青屿讨论',
  })
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'desktop',
    currentSessionRef: 'session-C',
    now: NOW,
    query: '很久以前',
  })
  assert.ok(
    result.items.every((item) => item.sourceIds.every((id) => id !== 'src_old')),
    '超出回溯窗口的 Source 不该被召回',
  )
})

await test('无 persona 直接跳过，不抛错', () => {
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: '',
    platform: 'desktop',
    now: NOW,
  })
  assert.equal(result.skipped, 'no-persona')
})

await test('一问一答配成一轮，未答复的问题也算一轮', () => {
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'desktop',
    currentSessionRef: 'session-Z',
    now: NOW,
  })
  assert.equal(result.skipped, null)
  for (const item of result.items) {
    assert.ok(item.userText.length > 0, '每一轮必须有用户文本')
    assert.ok(item.sourceIds.length >= 1)
  }
})

await test('软预算裁剪：只留得下的事项才注入', () => {
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'desktop',
    currentSessionRef: 'session-Z',
    now: NOW,
    softChars: 20,
    maxItems: 2,
  })
  assert.ok(result.items.length <= 2)
  if (result.skipped === null) {
    assert.ok(result.text !== null && result.text.length < 600, '裁剪后不应是大段原文')
  }
})

await test('关键词抽取：中文二元组与英文整词', () => {
  const grams = keywordsOf('SnowLuma 为什么没回复青屿')
  assert.ok(grams.includes('snowluma'))
  assert.ok(grams.includes('青屿'))
  assert.ok(!grams.includes('为什'), '停用二元组要被挡住')
})

// 第 29 轮外部评审：真实库上问句自匹配会把答案挤出去。
// 夹具复刻那一幕：原始陈述（助手只回「收到」）+ 无关更新 + 三轮「问 / 不知道」。
await test('原始陈述胜过重复问句', () => {
  seed(f.db, {
    id: 'src_qa1', kind: 'message', at: '2026-02-01T20:00:00.000Z', sessionRef: 'session-QA',
    text: '蓝盒子的标签是松针七号。',
  })
  seed(f.db, {
    id: 'src_qa2', kind: 'model', at: '2026-02-01T20:00:05.000Z', sessionRef: 'session-QA',
    text: '收到',
  })
  seed(f.db, {
    id: 'src_qb1', kind: 'message', at: '2026-02-01T20:10:00.000Z', sessionRef: 'session-QB',
    text: '今天把报表导出的时间范围筛选做完了。',
  })
  const repeated = ['2026-02-01T20:20:00.000Z', '2026-02-01T20:30:00.000Z', '2026-02-01T20:40:00.000Z']
  repeated.forEach((at, index) => {
    seed(f.db, {
      id: `src_qq${index}a`, kind: 'message', at, sessionRef: `session-QQ${index}`,
      text: '之前蓝盒子的标签叫什么？',
    })
    seed(f.db, {
      id: `src_qq${index}b`, kind: 'model', at: `${at.slice(0, 17)}05.000Z`, sessionRef: `session-QQ${index}`,
      text: '不知道，我的记忆里没有这条。',
    })
  })

  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'desktop',
    currentSessionRef: 'session-QZ',
    query: '之前蓝盒子的标签叫什么',
    now: NOW,
  })
  assert.equal(result.skipped, null)
  assert.equal(result.items[0]!.sessionRef, 'session-QA', '第一名必须是写着答案的原始陈述')
  assert.ok(result.items[0]!.sourceIds.includes('src_qa1'), '要能指回用户原话那条 Source')
  assert.ok(
    result.items.every((item) => item.sessionRef === null || !item.sessionRef.startsWith('session-QQ')),
    '纯提问 + 「不知道」的轮次不能入选',
  )

  // 评审给的退出条件：maxItems=1 时第一条就该是 A 的用户 sourceId。
  const single = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'desktop',
    currentSessionRef: 'session-QZ',
    query: '之前蓝盒子的标签叫什么',
    now: NOW,
    maxItems: 1,
  })
  assert.equal(single.items.length, 1)
  assert.equal(single.items[0]!.sessionRef, 'session-QA')
  assert.equal(single.items[0]!.sourceIds[0], 'src_qa1', '首条 sourceId 必须是用户原话')
})

await test('事实查询只赚到问句时返回空，不退回最近一轮', () => {
  // 「松针七号」只出现在上面那条陈述里；把它所在的会话排除掉之后，
  // 剩下的候选只有问句和「不知道」，此时必须 abstain，而不是拿最近一轮凑数。
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'desktop',
    currentSessionRef: 'session-QA',
    query: '松针七号',
    now: '2026-02-01T20:25:00.000Z',
  })
  assert.equal(result.skipped, 'no-match')
  assert.equal(result.text, null)
})

// 评审第二行验收：答案只由助手说过时也要能找回，并标明是谁提的。
await test('助手给过的答案可找回', () => {
  seed(f.db, {
    id: 'src_adv1', kind: 'message', at: '2026-02-01T21:00:00.000Z', sessionRef: 'session-ADV',
    text: '可写边界怎么处理？',
  })
  seed(f.db, {
    id: 'src_adv2', kind: 'model', at: '2026-02-01T21:00:20.000Z', sessionRef: 'session-ADV',
    text: '可写边界先按 50 字符截断，超过就分页。',
  })
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'desktop',
    currentSessionRef: 'session-NEW',
    query: '你上次建议可写边界怎么处理',
    now: NOW,
  })
  assert.equal(result.skipped, null)
  assert.equal(result.items[0]!.sessionRef, 'session-ADV')
  assert.ok(result.items[0]!.sourceIds.includes('src_adv2'), '要能指回助手那条 Source')
  assert.ok(
    result.text !== null && result.text.includes('我当时答：可写边界先按 50 字符截断'),
    '注入文本要把助手原话标成「我当时答」',
  )
})

await test('助手只答了短语也能找回', () => {
  // 评审提醒：12 字门槛会挡住「返回空页」这种短答案——它单独看没有主题，
  // 但配上同一轮的问题就是完整答案。
  seed(f.db, {
    id: 'src_short1', kind: 'message', at: '2026-02-01T21:30:00.000Z', sessionRef: 'session-SHORT',
    text: '删除确认怎么处理？',
  })
  seed(f.db, {
    id: 'src_short2', kind: 'model', at: '2026-02-01T21:30:10.000Z', sessionRef: 'session-SHORT',
    text: '返回空页。',
  })
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'desktop',
    currentSessionRef: 'session-NEW',
    query: '你上次建议删除确认怎么处理',
    now: NOW,
  })
  assert.equal(result.skipped, null)
  assert.equal(result.items[0]!.sessionRef, 'session-SHORT')
  assert.ok(result.items[0]!.sourceIds.includes('src_short2'))
})

await test('同轮前半句的陈述仍然算证据', () => {
  // 「蓝盒子放在二楼，你还记得标签吗？」只有后半句是提问，
  // 前半句提供位置事实，不能被整轮丢弃。
  seed(f.db, {
    id: 'src_pos1', kind: 'message', at: '2026-02-01T22:00:00.000Z', sessionRef: 'session-POS',
    text: '蓝盒子放在二楼，你还记得标签吗？',
  })
  seed(f.db, {
    id: 'src_pos2', kind: 'model', at: '2026-02-01T22:00:10.000Z', sessionRef: 'session-POS',
    text: '记得，标签是松针七号。',
  })
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'desktop',
    currentSessionRef: 'session-NEW',
    query: '蓝盒子放在哪',
    now: NOW,
  })
  assert.equal(result.skipped, null)
  assert.equal(result.items[0]!.sessionRef, 'session-POS', '前半句的陈述要能命中')
})

await test('否认开头但后面给了新答案，不能整段丢', () => {
  // 「不知道旧配色，新配色是赭石三号」——开头是否认，但后半段是答案。
  // 只看开头就判「无答案」会把这句扔掉。
  seed(f.db, {
    id: 'src_neg1', kind: 'message', at: '2026-02-01T22:30:00.000Z', sessionRef: 'session-NEG',
    text: '旧配色还是灰蓝吗？',
  })
  seed(f.db, {
    id: 'src_neg2', kind: 'model', at: '2026-02-01T22:30:10.000Z', sessionRef: 'session-NEG',
    text: '不知道旧配色，新配色是赭石三号。',
  })
  const result = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'desktop',
    currentSessionRef: 'session-NEW',
    query: '新配色是什么',
    now: NOW,
  })
  assert.equal(result.skipped, null)
  assert.equal(result.items[0]!.sessionRef, 'session-NEG')
  assert.ok(result.items[0]!.sourceIds.includes('src_neg2'))
})

await test('会话范围收窄：B 私聊独有的来源不出现在 A 的查询里', () => {
  // 第 37 轮外部评审 P0：QQ 私聊此前只按 platform='qq' + channel='private'
  // 过滤，同 platform 同 channel 不等于同一联系人。这里复现那个场景：
  // A 和 B 都是 qq/private，B 说过「松针七号」，A 问同一件事不能拿到 B 的源。
  seed(f.db, {
    id: 'src_qq_b1', kind: 'message', at: '2026-02-01T20:00:00.000Z',
    sessionRef: 'qq-private-B', platform: 'qq', channel: 'private',
    text: '蓝盒子的标签是松针七号',
  })
  const scoped = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'qq',
    sourceChannel: 'private',
    currentSessionRef: 'qq-private-A',
    allowedSessionRefs: ['qq-private-A'],
    query: '蓝盒子的标签叫什么',
    now: NOW,
  })
  assert.equal(scoped.skipped, 'no-sources', 'A 看不到 B 的私聊')
  assert.equal(scoped.items.length, 0)
  // 放开范围（模拟 B 自己查）能拿到，证明是范围收窄而不是数据没进去。
  // 注意 currentSessionRef 是「排除自己」，所以这里给 A 的会话标识。
  const bSelf = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'qq',
    sourceChannel: 'private',
    currentSessionRef: 'qq-private-A',
    allowedSessionRefs: ['qq-private-B'],
    query: '松针七号',
    now: NOW,
  })
  assert.ok(bSelf.items.length > 0, 'B 查自己那一侧要能命中')
  // 传了空数组 = 明确「无范围」，必须返回空而不是退化成「不限制」。
  const none = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'qq',
    sourceChannel: 'private',
    allowedSessionRefs: [],
    query: '松针七号',
    now: NOW,
  })
  assert.equal(none.skipped, 'no-persona')
})

await test('Owner 私聊：本人以前会话里说过的话，当前会话也能召回', () => {
  // 第 38 轮真机缺陷：allowedSessionRefs 用「当前会话」当范围，而
  // currentSessionRef 又会排除当前会话——两个条件叠起来互相抵消，
  // 本人以前说过的话一条都召回不到（no-match、0 条）。
  // 作用域应该是「这个联系人」，不是「这一个会话」。
  // sender_contact_id 有外键，先把两个联系人登记上。
  for (const [contactId, stable] of [
    ['ct_owner', '10001'],
    ['ct_stranger', '10002'],
  ] as const) {
    f.db.run(
      `INSERT INTO contacts (contact_id, persona_id, platform, stable_user_id, created_at, updated_at)
       VALUES (?, 'main', 'qq', ?, ?, ?)`,
      [contactId, stable, NOW, NOW],
    )
  }
  seed(f.db, {
    id: 'src_owner_old', kind: 'message', at: '2026-02-01T19:00:00.000Z',
    sessionRef: 'qq-private-OWNER-old', platform: 'qq', channel: 'private',
    senderContactId: 'ct_owner',
    text: '蓝盒子的标签是松针七号',
  })
  seed(f.db, {
    id: 'src_stranger', kind: 'message', at: '2026-02-01T19:05:00.000Z',
    sessionRef: 'qq-private-STRANGER', platform: 'qq', channel: 'private',
    senderContactId: 'ct_stranger',
    text: '松针七号是我编的',
  })
  const recall = buildConversationRecall({
    db: f.db as never,
    personaId: 'main',
    platform: 'qq',
    sourceChannel: 'private',
    currentSessionRef: 'qq-private-OWNER-now',
    allowedContactId: 'ct_owner',
    query: '蓝盒子的标签叫什么',
    now: NOW,
  })
  assert.equal(recall.skipped, null, '本人以前会话要能召回')
  assert.ok(
    recall.items[0]!.sourceIds.includes('src_owner_old'),
    '命中的是本人那条，不是陌生人的',
  )
  assert.ok(
    !recall.items.some((item) => item.sourceIds.includes('src_stranger')),
    '陌生人的来源不得进入',
  )
});

f.close()
console.log(`${passed} 通过 0 失败`)
