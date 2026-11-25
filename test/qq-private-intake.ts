// 第二批 replySchedules：私聊采集入口（GPT 第 2 轮裁定 (a)）。
//
// 这条入口只负责「时段外仍然采集」：写一条 Source + 一条 conversation 事件，
// 不建回复轮、不排队、不发送。锁住的是幂等键、内容冲突、以及「不碰 room」。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../packages/core/dist/adapter.js'
import { Core } from '../packages/core/dist/store.js'

let passed = 0
let failed = 0
function eq(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1
    console.log('  ok ' + label)
  } else {
    failed += 1
    console.error('  FAIL ' + label, { actual, expected })
  }
}
const log = { info() {}, debug() {}, warn() {}, error() {} }
const dir = mkdtempSync(join(tmpdir(), 'psyche-private-intake-'))
const { db } = await openDatabase({ file: join(dir, 'memory.sqlite3'), logger: log })
const core = new Core({ db, config: {}, logger: log, dataDir: dir })
const count = (table) => Number(db.get(`SELECT COUNT(*) AS n FROM ${table}`).n)
const T = '2026-11-24T00:30:00.000Z'
const input = (messageId, overrides = {}) => ({
  stableUserId: '10001',
  messageId,
  text: 'PRIVATE-BODY',
  at: T,
  ...overrides,
})
async function rejects(label, fn) {
  let rejected = false
  try {
    await fn()
  } catch {
    rejected = true
  }
  eq(label, rejected, true)
}

const first = await core.ingestPrivateMessage(input('m1'))
eq('首次采集写一条 Source 与一条 Event', [!!first.sourceId, !!first.eventId, count('sources'), count('events')], [true, true, 1, 1])
eq('Source 归属 qq/private 与会话引用', [db.get('SELECT platform,channel,session_ref FROM sources WHERE source_id=?', [first.sourceId]).platform,
  db.get('SELECT channel FROM sources WHERE source_id=?', [first.sourceId]).channel,
  db.get('SELECT session_ref FROM sources WHERE source_id=?', [first.sourceId]).session_ref],
['qq', 'private', 'qq-private-10001'])
eq('captureKey 由稳定 QQ 消息 id 构造', db.get('SELECT capture_key FROM sources WHERE source_id=?', [first.sourceId]).capture_key,
  'qq-private:10001:message:m1')
eq('事件挂到同一条 Source', db.get('SELECT COUNT(*) AS n FROM event_sources WHERE event_id=? AND source_id=?', [first.eventId, first.sourceId]).n, 1)
eq('事件不复刻正文', db.get('SELECT text FROM events WHERE event_id=?', [first.eventId]).text.includes('PRIVATE-BODY'), false)
eq('私聊采集不建 room', count('rooms'), 0)
eq('联系人按稳定 QQ 号建档', [count('contacts'), db.get('SELECT platform,stable_user_id FROM contacts').platform,
  db.get('SELECT stable_user_id FROM contacts').stable_user_id], [1, 'qq', '10001'])
eq('displayName 只在建档时补名字', db.get('SELECT display_name FROM contacts').display_name, null)

const replay = await core.ingestPrivateMessage(input('m1'))
eq('重复消息重放同一 Source/Event', [replay.replayed, replay.sourceId, replay.eventId], [true, first.sourceId, first.eventId])
eq('重放不新增 Source/Event', [count('sources'), count('events')], [1, 1])

await rejects('同一消息改正文拒绝（内容冲突）', () => core.ingestPrivateMessage(input('m1', { text: 'CHANGED' })))
eq('内容冲突后没有新行', [count('sources'), count('events')], [1, 1])

const second = await core.ingestPrivateMessage(input('m2', { text: 'SECOND' }))
eq('换一条消息就新写一条', [second.replayed, second.sourceId === first.sourceId, count('sources')], [false, false, 2])

const renamed = await core.ingestPrivateMessage(input('m3', { displayName: '新名字' }))
eq('带 displayName 的新消息会补名字', [!!renamed.sourceId, db.get('SELECT display_name FROM contacts').display_name], [true, '新名字'])

const custom = await core.ingestPrivateMessage(input('m4', { sessionRef: 'qq-private-custom' }))
eq('sessionRef 可覆盖', db.get('SELECT session_ref FROM sources WHERE source_id=?', [custom.sourceId]).session_ref, 'qq-private-custom')

await rejects('非 QQ 号身份拒绝', () => core.ingestPrivateMessage(input('m9', { stableUserId: '0abc' })))
await rejects('消息 id 非法拒绝', () => core.ingestPrivateMessage(input('bad id with space')))
await rejects('正文超长拒绝', () => core.ingestPrivateMessage(input('m10', { text: 'x'.repeat(20001) })))
await rejects('采集时间非法拒绝', () => core.ingestPrivateMessage(input('m11', { at: 'not-a-time' })))
await rejects('会话引用非法拒绝', () => core.ingestPrivateMessage(input('m12', { sessionRef: 'x'.repeat(201) })))
eq('非法输入没有落任何行', count('sources'), 4)

const again = new Core({ db, config: {}, logger: log, dataDir: dir })
const reopened = await again.ingestPrivateMessage(input('m1'))
eq('重开 Core 后幂等键仍生效', [reopened.replayed, reopened.sourceId], [true, first.sourceId])

// K：跨路径幂等（GPT 第 3 轮 ③ 锁一）。
// Host capture 与独立采集是两条写入口；同一条 QQ 消息的身份统一按
// (platform, session_ref, message_id) 认定，不因 captureKey 不同而写第二份。
const hostBody = 'HOST-CAPTURED-BODY'
const sourcesBeforeHost = count('sources')
const eventsBeforeHost = count('events')
const viaHost = await core.capture({
  platform: 'qq',
  channel: 'private',
  sessionRef: 'qq-private-20002',
  messageId: 'h1',
  origin: 'user',
  kind: 'message',
  text: hostBody,
  at: T,
})
eq('K1 Host capture 先写入一条 Source', [viaHost.ok, !!viaHost.sourceId, count('sources') - sourcesBeforeHost], [true, true, 1])
const afterHost = await core.ingestPrivateMessage({ stableUserId: '20002', messageId: 'h1', text: hostBody, at: T })
eq('K2 同一 QQ 消息经独立入口命中既有行', [afterHost.replayed, afterHost.sourceId], [true, viaHost.sourceId])
eq('K3 跨路径去重不新增 Source/Event', [count('sources') - sourcesBeforeHost, count('events') - eventsBeforeHost], [1, 0])
const afterHostChanged = await core.ingestPrivateMessage({ stableUserId: '20002', messageId: 'h1', text: 'OTHER-BODY', at: T })
eq('K4 身份命中后正文差异不新增行', [afterHostChanged.replayed, afterHostChanged.sourceId, count('sources') - sourcesBeforeHost], [true, viaHost.sourceId, 1])

// K5–K6：反向幂等——先由独立入口写，再让 Host capture 写同一条消息，也不该多一行。
const sourcesBeforeReverse = count('sources')
const eventsBeforeReverse = count('events')
const reverseFirst = await core.ingestPrivateMessage({ stableUserId: '20003', messageId: 'r1', text: 'REVERSE-BODY', at: T })
const reverseHost = await core.capture({
  platform: 'qq',
  channel: 'private',
  sessionRef: 'qq-private-20003',
  messageId: 'r1',
  origin: 'user',
  kind: 'message',
  text: 'REVERSE-BODY',
  at: T,
})
eq('K5 独立入口先写、Host capture 后写时命中同一行', [reverseHost.ok, reverseHost.sourceId, reverseFirst.sourceId], [true, reverseFirst.sourceId, reverseFirst.sourceId])
eq('K6 反向去重不新增 Source', count('sources') - sourcesBeforeReverse, 1)
// K7：反向路径同样不许把 Event 写第二份——独立入口只留一条 conversation 事件，
// 后续 Host capture 命中既有 Source 时不再挂新事件。
eq('K7 反向去重不新增 Event', count('events') - eventsBeforeReverse, 1)

db.close()
console.log(`[v29.53 private-intake] ${passed} 通过 ${failed} 失败`)
if (failed) process.exitCode = 1
