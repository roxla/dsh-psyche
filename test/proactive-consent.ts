// C-3b：真实 Capture Source 的同意/撤回读取（模块级，不伪称宿主验收）。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../packages/core/dist/adapter.js'
import { Core } from '../packages/core/dist/store.js'
import { parseConsentCommand, readProactiveConsent } from '../packages/core/dist/proactive-consent.js'

let passed = 0
let failed = 0
function eq(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.error(`  FAIL ${label} ${JSON.stringify({ actual, expected })}`) }
}
const dir = mkdtempSync(join(tmpdir(), 'psyche-consent-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const { db } = await openDatabase({ file: join(dir, 'memory.sqlite3'), logger: log })
const core = new Core({ db, dataDir: dir, config: {}, logger: log })
const A = await core.resolveContact({ platform: 'qq', stableUserId: '10001' })
const B = await core.resolveContact({ platform: 'qq', stableUserId: '10002' })
const D = await core.resolveContact({ platform: 'desktop', stableUserId: 'owner' })
const T0 = '2026-11-13T01:00:00.000Z'
const NOW = '2026-11-13T02:00:00.000Z'
const GRANT = '同意心灵主动测试至 2026-11-13T12:00:00+08:00；时区 Asia/Shanghai'
let seq = 0
async function source(text: string, extra: Record<string, unknown> = {}) {
  seq++
  return core.capture({ platform: 'qq', channel: 'private', senderContactId: A.contactId,
    sessionRef: 'qq-private-10001', captureKey: `consent-${seq}`, messageId: `message-${seq}`,
    origin: 'user', kind: 'message', text, at: new Date(Date.parse(T0) + seq * 1000).toISOString(),
    metadata: { dsh: { sessionId: 'qq-private-10001', seq, role: 'user' } }, ...extra })
}
const read = (id = A.contactId, now = NOW) => readProactiveConsent(db, id, now)
eq('A1 未授权没有同意', read().reason, 'missing')
eq('A2 Contact 不存在', read('not-a-contact').reason, 'contact-not-found')
eq('A3 其他平台 Contact 不参与', read(D.contactId).reason, 'contact-not-found')
eq('A4 带 IANA 和明确截止时间的完整指令', parseConsentCommand(GRANT, T0)?.kind, 'grant')
eq('A5 没有 IANA 不猜测', parseConsentCommand('同意心灵主动测试至 2026-11-13T12:00:00+08:00', T0), null)
eq('A6 不接受模糊时区简称', parseConsentCommand(GRANT.replace('Asia/Shanghai', 'CST'), T0), null)
eq('A7 不存在的 IANA 拒绝', parseConsentCommand(GRANT.replace('Asia/Shanghai', 'Asia/Invalid'), T0), null)
eq('A8 超过 24h 拒绝', parseConsentCommand(GRANT.replace('2026-11-13', '2026-11-15'), T0), null)
eq('A9 到期在捕获前拒绝', parseConsentCommand(GRANT.replace('T12:00:00', 'T08:00:00'), T0), null)
eq('A10 无时区的 ISO 拒绝', parseConsentCommand(GRANT.replace('+08:00', ''), T0), null)
eq('A11 非法日期不由 Date.parse 归一化', parseConsentCommand('同意心灵主动测试至 2026-02-30T10:00:00Z；时区 UTC', '2026-02-28T01:00:00Z'), null)
eq('A12 引用转述不算明确指令', parseConsentCommand(`他说：${GRANT}`, T0), null)

const granted = await source(GRANT)
eq('B1 来源被持久化，读取为 granted', read().reason, 'granted')
eq('B2 绑定原 Source', read().consent?.sourceId, granted.sourceId)
eq('B3 收件人时区来自本人控制消息', read().timezone, 'Asia/Shanghai')
eq('B4 不串到其他 Contact', read(B.contactId).reason, 'missing')
eq('B5 截止时间按 UTC 精确计算', read().consent?.expiresAt, '2026-11-13T04:00:00.000Z')
eq('B6 到期边界不给宽限', read(A.contactId, '2026-11-13T04:00:00.000Z').reason, 'expired')
await source(GRANT, { origin: 'self', kind: 'model' })
eq('B7 助手重复不构成新授权', read().consent?.sourceId, granted.sourceId)
await source(GRANT, { channel: 'group' })
eq('B8 群来源不进入私聊同意', read().consent?.sourceId, granted.sourceId)
await source('撤回心灵主动测试')
eq('B9 本人撤回生效', read().reason, 'revoked')
await source('同意心灵主动测试至 明天；时区 Asia/Shanghai')
eq('B10 非法新授予不回退旧授权', read().reason, 'invalid-command')
await source(GRANT, { sessionRef: 'qq-private-10002' })
eq('B11 会话与 Contact 不匹配拒绝', read().reason, 'invalid-source')
await source(GRANT, { metadata: { dsh: { sessionId: 'qq-private-10001', seq, role: 'assistant' } } })
eq('B12 Host 角色不匹配拒绝', read().reason, 'invalid-source')
await source(GRANT, { quotedSourceRefs: [granted.sourceId] })
eq('B13 被引用内容不能授予同意', read().reason, 'invalid-source')
const quarantined = await source(GRANT)
db.run('INSERT INTO quarantined_sources (source_id, reason, quarantined_at) VALUES (?, ?, ?)', [quarantined.sourceId, 'runtime-injection', NOW])
eq('B14 最新来源被隔离也不回退', read().reason, 'invalid-source')
await source(GRANT, { at: '2026-11-13T03:00:00.000Z' })
eq('B15 未来捕获时间不授权', read().reason, 'invalid-source')

const counts = () => db.all("SELECT 'sources' AS name, COUNT(*) AS n FROM sources UNION ALL SELECT 'operations', COUNT(*) FROM operations")
const before = counts()
read()
eq('C1 同意读取不写 Source/operations', counts(), before)
let threw = false
try { readProactiveConsent({ get() { throw new Error('db unavailable') } }, A.contactId, NOW) } catch { threw = true }
eq('C2 DB 失败明确抛错，不伪装 missing', threw, true)
db.close()
console.log(`[C3b proactive-consent] ${passed} 通过 ${failed} 失败`)
if (failed) process.exitCode = 1
