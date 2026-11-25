// 每轮文本缓冲测试（P3-A B2）：只收 user、跨 step 累加、take 清空、边界与淘汰。
import assert from 'node:assert/strict'
import {
  MoodTurnBuffer,
  textOfContent,
  userTextsOf,
} from '../dist/lib/mood-turn-buffer.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}

function user(text: string, id?: string): unknown {
  return { id, source: { kind: 'user' }, content: [{ type: 'text', text }] }
}
function assistant(text: string): unknown {
  return { source: { kind: 'model' }, content: [{ type: 'text', text }] }
}
function plugin(text: string): unknown {
  return { source: { kind: 'plugin' }, content: [{ type: 'text', text }] }
}
function runtimeContext(text: string): unknown {
  return { source: { kind: 'runtime-context' }, content: [{ type: 'text', text }] }
}

// 消息分类：只认 source.kind === 'user'
assert.deepEqual(
  userTextsOf([user('你好'), assistant('答'), plugin('注入'), runtimeContext('上下文')]),
  ['你好'],
)
passed += 1
check(userTextsOf(undefined).length === 0, 'undefined 消息为空')
check(userTextsOf([{ role: 'user', content: '没有 source' } as unknown]).length === 0, '不看 role，只看 source.kind')
check(
  userTextsOf([{ source: { kind: 'user' }, content: '纯字符串' } as unknown]).join('') === '纯字符串',
  '字符串正文',
)
check(
  textOfContent([{ type: 'text', text: '正文' }, { type: 'reasoning', text: '思考' }]) === '正文',
  '跳过非正文块',
)

const buffer = new MoodTurnBuffer({ maxText: 80, maxSessions: 2, maxTurnsPerSession: 2 })

// 收集与取走
check(buffer.record('s1', 1, [user('第一句', 'm1'), user('第二句', 'm2')]) === true, 'record 用户消息')
const taken = buffer.take('s1', 1)
check(taken !== null && taken.texts.join('|') === '第一句|第二句', 'take 返回全部文本')
check(taken?.evidenceIds.join('|') === 'm1|m2', 'take 返回对齐的消息 id')
check(taken?.initiator === 'user', '轮首来源固化为 user')
check(taken?.userMessageCount === 2, 'userMessageCount 数消息条数')
check(buffer.take('s1', 1) === null, 'take 后清空')

// 跨 step 累加
buffer.record('s1', 2, [user('甲')])
buffer.record('s1', 2, [user('乙')])
check(buffer.take('s1', 2)?.texts.join('|') === '甲|乙', '同 turn 跨 step 累加')

// 非用户消息不产生桶
check(buffer.record('s1', 3, [assistant('答'), plugin('注入')]) === false, '非用户消息不收集')
check(buffer.turnsOf('s1').length === 0, '无用户消息不建桶')

// psyche 记忆注入：source.kind 仍是 user，必须排除（与 CaptureHost R6-CAP-2 同一判定）
function injected(text: string, id?: string): unknown {
  return {
    id,
    source: { kind: 'user', psyche: { injection: 'memory-context' } },
    content: [{ type: 'text', text }],
  }
}
check(buffer.record('s1', 4, [injected('你记得我怕冷吗')]) === false, 'psyche 注入不收集（source 标记）')
check(buffer.record('s1', 5, [user('旧注入', 'msg_psyche_abc')]) === false, 'psyche 注入不收集（id 前缀）')
check(buffer.record('s1', 6, [injected('注入'), user('真话', 'm6')]) === true, '混入注入时只收真实用户消息')
check(buffer.take('s1', 6)?.texts.join('|') === '真话', '注入文本被丢弃')
check(userTextsOf([injected('我今天好开心')]).length === 0, '注入即使命中关键词也不产生文本')

// 轮首固化规则版本：之后改规则不回溯已完成轮次
const versioned = new MoodTurnBuffer({ configVersion: 7 })
versioned.record('v', 1, [user('你好', 'm1')])
check(versioned.take('v', 1)?.configVersion === 7, '轮首固化规则版本')
const versionUnknown = new MoodTurnBuffer()
versionUnknown.record('v', 1, [user('你好')])
check(versionUnknown.take('v', 1)?.configVersion === undefined, '未提供版本时不伪造')

// 排除会话
const excluded = new MoodTurnBuffer({ excludeSessions: 's2, s3' })
check(excluded.record('s2', 1, [user('你好')]) === false, '排除会话不收集')
check(excluded.record('s3', 1, [user('你好')]) === false, '排除表去空格后匹配')
check(excluded.record('s4', 1, [user('你好')]) === true, '未排除会话正常收集')

// 单轮字数上限：保留最近文本
const tiny = new MoodTurnBuffer({ maxText: 100 })
tiny.record('s1', 1, [user('1'.repeat(60))])
tiny.record('s1', 1, [user('2'.repeat(60))])
check(tiny.charsOf('s1', 1) <= 100, '超预算截断')
const truncated = tiny.take('s1', 1)
check(truncated !== null && truncated.texts.length === truncated.evidenceIds.length, 'id 与文本仍对齐')
check(truncated?.texts[truncated.texts.length - 1] === '2'.repeat(60), '保留最近文本')

// 会话上限：淘汰最老会话
const sessions = new MoodTurnBuffer({ maxSessions: 2 })
sessions.record('a', 1, [user('a')])
sessions.record('b', 1, [user('b')])
sessions.record('c', 1, [user('c')])
check(sessions.size === 2, '会话数受上限约束')
check(sessions.take('a', 1) === null, '最老会话被淘汰')
check(sessions.take('c', 1) !== null, '最新会话保留')

// 每会话轮数上限
const turns = new MoodTurnBuffer({ maxTurnsPerSession: 2 })
turns.record('s', 1, [user('1')])
turns.record('s', 2, [user('2')])
turns.record('s', 3, [user('3')])
check(turns.turnsOf('s').join(',') === '2,3', '轮数受上限约束')

// dropSession / clear / 非法入参
turns.dropSession('s')
check(turns.take('s', 2) === null, 'dropSession 清空该会话')
check(buffer.record('', 1, [user('x')]) === false, '空 sessionId 不收集')
check(buffer.record('s', 0, [user('x')]) === false, '非法 turn 不收集')
buffer.clear()
check(buffer.size === 0, 'clear 清空')

console.log(`[P3-A B2 mood-wiring] ${passed} 通过 0 失败`)
