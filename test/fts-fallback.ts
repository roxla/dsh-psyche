/**
 * 长句/长查询回退（v1）：
 * - exact phrase 为空时，按内容子句重试（整句 / 子句 OR / 子句前 8 个 bigram）；
 * - 仍为空时，句尾 2 字 / 1 字 LIKE 兜底；
 * - 只在 exact 为空时触发，安全过滤、Scope、排序语义不变。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { analyzeFtsQuery, fallbackFtsQueries, fallbackLikeHints, searchFts } from '../dist/lib/fts.js'

const checks: string[] = []
let failed = 0
function ok(name: string): void {
  checks.push(`ok   ${name}`)
}
function eq<T>(actual: T, expected: T, name: string): void {
  if (Object.is(actual, expected)) ok(name)
  else {
    failed += 1
    checks.push(`FAIL ${name}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-fts-fallback-'))
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'node:sqlite' })
const core = new Core({ db: opened.db, config: {}, logger: { warn() {}, info() {}, debug() {} } as never, dataDir: dir })

const src = await core.capture({
  platform: 'dsh-session',
  sessionRef: 's-fallback-1',
  captureKey: '1',
  origin: 'user',
  kind: 'message',
  text: 'R6-3C 私聊联通测试第二轮，我喜欢喝乌龙茶。',
})
const src2 = await core.capture({
  platform: 'dsh-session',
  sessionRef: 's-fallback-2',
  captureKey: '2',
  origin: 'user',
  kind: 'message',
  text: '用户的下午茶习惯：喜欢乌龙茶。',
})
const fact = await core.remember({
  kind: 'fact',
  statement: 'R6-3C 私聊联通测试第二轮，用户偏好乌龙茶。',
  sourceIds: [src.sourceId, src2.sourceId],
  disclosure: 'public',
})
const factId = fact.artifactId

const long = 'R6-3C 私聊联通测试第二轮，你还记得吗？'
const longHits = searchFts(opened.db, long)
eq(longHits.some((hit) => hit.artifactId === factId), true, '长句（含疑问尾）命中结论')

const filler = '那你平时喝什么茶？'
const fillerHits = searchFts(opened.db, filler)
eq(fillerHits.length > 0, true, '纯疑问句走 LIKE 兜底命中')
eq(fillerHits.some((hit) => hit.artifactId === factId), true, 'LIKE 兜底命中的是乌龙茶结论')

const multi = '昨天聊了项目，今天想问下乌龙茶。'
eq(searchFts(opened.db, multi).some((hit) => hit.artifactId === factId), true, '多子句 OR 命中')

const short = '乌龙茶'
eq(searchFts(opened.db, short).some((hit) => hit.artifactId === factId), true, '短查询仍正常')

const english = 'R6-3C 私聊联通测试'
eq(searchFts(opened.db, english).some((hit) => hit.artifactId === factId), true, '英文数字混合仍命中')

// 安全：其它 Contact 的 restricted 结论不能被回退捞出来。
const other = await core.remember({
  kind: 'fact',
  statement: '别人的秘密：R6-3C 私聊联通测试第二轮，用户偏好乌龙茶。',
  sourceIds: [src.sourceId],
  disclosure: 'restricted',
  subjectRefs: ['ct_someone_else'],
})
const leak = searchFts(opened.db, long)
eq(leak.some((hit) => hit.artifactId === other.artifactId), false, '回退不绕过披露过滤（restricted 不返回）')
const scoped = searchFts(opened.db, long, { scope: { contactId: 'ct_nobody', surface: 'private' } })
eq(scoped.length, 0, '回退不绕过 Scope（无匹配 Contact 不返回）')

// 候选自检：纯寒暄不产生 FTS 回退候选；长句至少有一个候选。
eq(fallbackFtsQueries(analyzeFtsQuery('嗯嗯，好的')).length, 0, '纯寒暄不产生回退候选')
eq(fallbackFtsQueries(analyzeFtsQuery(long)).length > 0, true, '长句产生回退候选')
eq(fallbackLikeHints(analyzeFtsQuery(filler)).includes('茶'), true, '疑问句的 LIKE 线索包含「茶」')

opened.db.close()
rmSync(dir, { recursive: true, force: true })
console.log(checks.join('\n'))
const passed = checks.length - failed
console.log(`\n[P2-FTS5 fallback] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exit(1)
