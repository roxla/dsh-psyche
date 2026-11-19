/**
 * 「记住这条」按钮服务层测试。
 *
 * 覆盖设计稿 §17 的 T1–T11：提炼、kind、Source 配对/缺失/隔离、
 * duplicate/appended/conflict/created、幂等、无 Contact/群聊拒绝、消息定位。
 * 全部走真实 sqlite（临时目录），不 mock 存储。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Core, migrate, openDatabase, type Db } from 'dsh-psyche-core'

// 有几个用例故意触发定位失败，服务层会 warn 一条诊断；测试里静音，免得
// PowerShell 把 stderr 当命令错误、让单跑退出码变成 1。
const originalWarn = console.warn
console.warn = () => undefined

import {
  RememberButtonError,
  extractStatement,
  isFillerSentence,
  kindOf,
  looksContradictory,
  rememberAssistantMessage,
  similarity,
  type RememberButtonDeps,
  type RememberSessionEvent,
} from '../dist/lib/remember-button.js'

const log = { info() {}, debug() {}, warn() {}, error() {} }
let passed = 0
const failures: string[] = []

function ok(name: string, value: boolean): void {
  if (value) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}`)
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  ok(`${name}（${JSON.stringify(actual)} === ${JSON.stringify(expected)}）`, JSON.stringify(actual) === JSON.stringify(expected))
}

async function throws(code: string, name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
    ok(`${name}（未抛出）`, false)
  } catch (error) {
    const actual = error instanceof RememberButtonError ? error.code : `非 RememberButtonError：${String(error)}`
    eq(name, actual, code)
  }
}

// ── T1：纯函数（提炼 / kind / 相似 / 否定） ──────────────────────────────────
ok('T1a 短句寒暄被跳过', isFillerSentence('你好呀'))
ok('T1b 正常陈述不被当寒暄', !isFillerSentence('用户喜欢喝乌龙茶，这条结论有两个来源'))
eq('T1c 提炼取第一句有效陈述', extractStatement('好的。用户喜欢喝乌龙茶，平时每天都会泡一杯。'), '用户喜欢喝乌龙茶，平时每天都会泡一杯。')
eq('T1d 提炼跳过寒暄', extractStatement('谢谢你。其实用户喜欢喝乌龙茶。'), '其实用户喜欢喝乌龙茶。')
eq('T1e 提炼去掉 markdown', extractStatement('**用户**喜欢喝乌龙茶。'), '用户喜欢喝乌龙茶。')
eq('T1f 提不出结论返回 null', extractStatement('嗯。好的。'), null)
eq('T1g 含偏好的句子归 belief', kindOf('用户喜欢喝乌龙茶'), 'belief')
eq('T1h 普通事实归 fact', kindOf('用户住在杭州'), 'fact')
ok('T1i 高相似', similarity('用户喜欢喝乌龙茶', '用户喜欢喝乌龙茶。') >= 0.8)
ok('T1j 低相似', similarity('用户喜欢喝乌龙茶', '今天下雨了') < 0.3)
ok('T1k 否定冲突', looksContradictory('用户喜欢喝乌龙茶', '用户不喜欢喝乌龙茶'))
ok('T1l 同向不冲突', !looksContradictory('用户喜欢喝乌龙茶', '用户喜欢喝乌龙茶。'))

// ── 主流程夹具 ───────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'psyche-remember-button-'))
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db: Db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const now = new Date().toISOString()
db.run(
  `INSERT INTO contacts (contact_id, persona_id, platform, stable_user_id, created_at, updated_at)
   VALUES ('ct_a', 'main', 'qq', '10001', ?, ?)`,
  [now, now],
)

const SESSION = 'qq-private-10001'

function userEvent(seq: number, messageId: string, text: string): RememberSessionEvent {
  // 真实 DSH 的 `user/message` 事件：data 本身就是 UserMessage，不带 message 包一层。
  return {
    seq,
    type: 'user/message',
    data: { id: messageId, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

function assistantEvent(messageId: string, text: string): RememberSessionEvent {
  return {
    type: 'assistant/message',
    data: {
      message: {
        id: messageId,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model' },
      },
    },
  }
}

function persistenceOf(events: RememberSessionEvent[]): RememberButtonDeps['persistence'] {
  return {
    open: () => ({
      read: async () => ({ eventState: 'shared-frozen', events }),
      close: async () => undefined,
    }),
  }
}

function deps(events: RememberSessionEvent[], binding: { contactId: string | null; groupId?: string | null } = { contactId: 'ct_a' }): RememberButtonDeps {
  return {
    core: async () => core as never,
    runtimeInputs: {
      read: () =>
        ({
          platform: 'qq',
          stableUserId: '10001',
          contactId: binding.contactId,
          groupId: binding.groupId ?? null,
          channelId: null,
          sessionId: SESSION,
          trustedSource: 'channel-adapter',
          boundAt: now,
        }) as never,
    },
    persistence: persistenceOf(events),
  }
}

async function capture(text: string, captureKey: string): Promise<string> {
  const captured = await core.capture({
    platform: 'qq',
    channel: 'private',
    sessionRef: SESSION,
    origin: 'user',
    kind: 'message',
    text,
    captureKey,
    senderContactId: 'ct_a',
  })
  return captured.sourceId
}

// ── T2：新建 ─────────────────────────────────────────────────────────────────
const headStatement = '用户喜欢喝乌龙茶，每天都会泡一杯。'
const userText = '我今天买了乌龙茶，很喜欢它的味道。'
await capture(userText, '1')
const created = await rememberAssistantMessage(
  deps([userEvent(1, 'm-u1', userText), assistantEvent('m-a1', headStatement)]),
  { sessionId: SESSION, assistantMessageId: 'm-a1' },
)
eq('T2a 新建返回 created', created.action, 'created')
ok('T2b 新建拿到 artifactId', typeof created.artifactId === 'string' && created.artifactId.length > 0)
ok('T2c 结论含乌龙茶', created.statement.includes('乌龙茶'))

// ── T3：幂等（同 assistantMessageId 再点一次） ────────────────────────────────
const replayed = await rememberAssistantMessage(
  deps([userEvent(1, 'm-u1', userText), assistantEvent('m-a1', headStatement)]),
  { sessionId: SESSION, assistantMessageId: 'm-a1' },
)
eq('T3a 重放判 duplicate（不重复建结论）', replayed.action, 'duplicate')
eq('T3b 重放同一个 artifactId', replayed.artifactId, created.artifactId)

// ── T4：精确重复 ─────────────────────────────────────────────────────────────
await capture(headStatement, '2')
const duplicate = await rememberAssistantMessage(
  deps([userEvent(2, 'm-u2', headStatement), assistantEvent('m-a2', headStatement)]),
  { sessionId: SESSION, assistantMessageId: 'm-a2' },
)
eq('T4a 同句返回 duplicate', duplicate.action, 'duplicate')
eq('T4b duplicate 指向原结论', duplicate.artifactId, created.artifactId)

// ── T5：高相似追加 ───────────────────────────────────────────────────────────
const nearStatement = '用户喜欢喝乌龙茶，每天都会泡一杯茶。'
await capture(nearStatement, '3')
const appended = await rememberAssistantMessage(
  deps([userEvent(3, 'm-u3', nearStatement), assistantEvent('m-a3', nearStatement)]),
  { sessionId: SESSION, assistantMessageId: 'm-a3' },
)
eq('T5a 高相似返回 appended', appended.action, 'appended')
eq('T5b appended 指向原结论', appended.artifactId, created.artifactId)

// ── T6：否定冲突 ─────────────────────────────────────────────────────────────
const conflictStatement = '用户不喜欢喝乌龙茶，每天都会泡一杯。'
await capture(conflictStatement, '4')
const conflict = await rememberAssistantMessage(
  deps([userEvent(4, 'm-u4', conflictStatement), assistantEvent('m-a4', conflictStatement)]),
  { sessionId: SESSION, assistantMessageId: 'm-a4' },
)
eq('T6a 否定冲突返回 conflict', conflict.action, 'conflict')
eq('T6b conflict 指向被撞的结论', conflict.artifactId, created.artifactId)

// ── T7：Source 缺失补采 / 隔离 ───────────────────────────────────────────────
// 按钮是用户主动动作：本地没开 capture 时补采本轮 user 原文，再正常写入。
const recovered = await rememberAssistantMessage(
  deps([userEvent(99, 'm-u99', userText), assistantEvent('m-a99', userText)]),
  { sessionId: SESSION, assistantMessageId: 'm-a99' },
)
eq('T7a 来源未采集时补采并写入', recovered.action, 'created')
eq(
  'T7a2 补采的 Source 已落库',
  db.get(`SELECT COUNT(*) AS n FROM sources WHERE capture_key = '99'`)?.n,
  1,
)
db.run(`INSERT INTO quarantined_sources (source_id, reason, note, quarantined_at) VALUES ((SELECT source_id FROM sources WHERE capture_key = '2' LIMIT 1), 'runtime-injection', 'test', ?)`, [now])
await capture('用户喜欢喝乌龙茶，每天一杯。', '5')
db.run(`INSERT INTO quarantined_sources (source_id, reason, note, quarantined_at) VALUES ((SELECT source_id FROM sources WHERE capture_key = '5' LIMIT 1), 'runtime-injection', 'test', ?)`, [now])
await throws(
  'E_SOURCE_QUARANTINED',
  'T7b 隔离来源拒绝',
  () =>
    rememberAssistantMessage(
      deps([userEvent(5, 'm-u5', '用户喜欢喝乌龙茶，每天一杯。'), assistantEvent('m-a5', '用户喜欢喝乌龙茶，每天一杯。')]),
      { sessionId: SESSION, assistantMessageId: 'm-a5' },
    ),
)

// ── T8：无 Contact / 群聊 ────────────────────────────────────────────────────
await throws('E_UNSUPPORTED', 'T8a 无 Contact 拒绝', () =>
  rememberAssistantMessage(
    deps([userEvent(1, 'm-u1', userText), assistantEvent('m-a1', '好的。')], { contactId: null }),
    { sessionId: SESSION, assistantMessageId: 'm-a1' },
  ),
)
await throws('E_UNSUPPORTED', 'T8b 群聊拒绝', () =>
  rememberAssistantMessage(
    deps([userEvent(1, 'm-u1', userText), assistantEvent('m-a1', '好的。')], { contactId: 'ct_a', groupId: '20001' }),
    { sessionId: SESSION, assistantMessageId: 'm-a1' },
  ),
)

// ── T9：消息定位 ─────────────────────────────────────────────────────────────
await throws('E_NOT_FOUND', 'T9a 找不到 assistant 消息', () =>
  rememberAssistantMessage(deps([userEvent(1, 'm-u1', userText)]), {
    sessionId: SESSION,
    assistantMessageId: 'm-missing',
  }),
)
await throws('E_NOT_FOUND', 'T9b 前面没有真实用户消息', () =>
  rememberAssistantMessage(deps([assistantEvent('m-a9', '好的。')]), {
    sessionId: SESSION,
    assistantMessageId: 'm-a9',
  }),
)

// ── T10：注入块不算用户消息 ──────────────────────────────────────────────────
await capture('用户喜欢喝乌龙茶。', '6')
const injection = {
  seq: 6,
  type: 'user/message',
  data: {
    message: {
      id: 'msg_psyche_x',
      role: 'user',
      content: [{ type: 'text', text: '<memory-context>用户喜欢喝乌龙茶。</memory-context>' }],
      source: { kind: 'user', psyche: { injection: 'memory-context', requestId: 'req_x' } },
    },
  },
} satisfies RememberSessionEvent
await throws('E_NOT_FOUND', 'T10a 只有注入块时拒绝', () =>
  rememberAssistantMessage(deps([injection, assistantEvent('m-a10', '好的。')]), {
    sessionId: SESSION,
    assistantMessageId: 'm-a10',
  }),
)

// T10b：旧 Lingban 来源标记只读识别，仍不能当作用户原话
const legacyInjection = {
  seq: 9,
  type: 'user/message',
  data: {
    message: {
      id: 'msg_lingban_legacy',
      role: 'user',
      content: [{ type: 'text', text: '<memory-context>旧注入。</memory-context>' }],
      source: { kind: 'user', lingban: { injection: 'memory-context' } },
    },
  },
} satisfies RememberSessionEvent
await throws('E_NOT_FOUND', 'T10b 旧版注入块同样拒绝', () =>
  rememberAssistantMessage(deps([legacyInjection, assistantEvent('m-a10b', '好的。')]), {
    sessionId: SESSION,
    assistantMessageId: 'm-a10b',
  }),
)

// ── T11：提炼为空 ────────────────────────────────────────────────────────────
await capture('嗯。', '7')
await throws('E_EMPTY_STATEMENT', 'T11a 提炼为空拒绝', () =>
  rememberAssistantMessage(deps([userEvent(7, 'm-u7', '嗯。'), assistantEvent('m-a11', '嗯。')]), {
    sessionId: SESSION,
    assistantMessageId: 'm-a11',
  }),
)

await opened.db.close()
rmSync(dir, { recursive: true, force: true })
console.warn = originalWarn
console.log(`\n[P2-Recall remember-button] ${passed} 通过 ${failures.length} 失败`)
if (failures.length > 0) process.exitCode = 1
