import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { openDatabase } from '../packages/core/dist/adapter.js'
import { Core } from '../packages/core/dist/store.js'
import { OutboxStore } from '../packages/core/dist/proactive-outbox.js'
import { OutboundService } from '../packages/core/dist/proactive-outbound-service.js'
import { acquireOutboundLease, localOwnerIdentity } from '../dist/lib/proactive-owner-runtime.js'
import { createOwnerQqConnection } from '../dist/lib/proactive-qq-runtime.js'
import { parseOutboundArgs } from '../tools/psyche-outbound.mjs'
import { oneBotFixture } from './helpers/proactive-onebot.mjs'

let passed = 0
let failed = 0
function eq(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.error(`  FAIL ${label} ${JSON.stringify({ actual, expected })}`) }
}
const throws = (fn) => { try { fn(); return false } catch { return true } }
eq('无参数仅帮助，不启动 Worker', parseOutboundArgs([]).command, 'help')
for (const option of ['--yes', '--owner', '--ownerId', '--decidedBy']) {
  eq(`不接受自报/跳过审批参数 ${option}`, throws(() => parseOutboundArgs(['approve', option, 'owner'])), true)
}
eq('非法 QQ 身份拒绝', throws(() => parseOutboundArgs(['consent', '--data', 'x', '--recipient', '*'])), true)
eq('重复参数拒绝', throws(() => parseOutboundArgs(['status', '--data', 'x', '--data', 'y'])), true)
eq('非法 unknown 核验结论拒绝', throws(() => parseOutboundArgs(['resolve', '--data', 'x', '--outbox', 'ob_x', '--verdict', 'retry'])), true)
eq('Owner ID 由 OS 稳定取得', localOwnerIdentity().id, localOwnerIdentity().id)
eq('Owner 不是调用方提供的字符串', localOwnerIdentity().id.startsWith('local-owner:'), true)

const dir = mkdtempSync(join(tmpdir(), 'psyche-owner-'))
const file = join(dir, 'memory.sqlite3')
const log = { info() {}, debug() {}, warn() {}, error() {} }
const { db } = await openDatabase({ file, logger: log })
const core = new Core({ db, config: {}, logger: log, dataDir: dir })
const contact = await core.resolveContact({ platform: 'qq', stableUserId: '10001' })
const T0 = '2026-11-13T02:00:00.000Z'
const store = new OutboxStore({ db, ownerId: 'fixture-owner', now: () => T0 })
const input = (approvalId, transportId) => ({ approvalId, draft: { draftId: 'fixture-draft', revision: 1, draftHash: 'fixture-hash', contactId: contact.contactId, text: 'PRIVATE-APPROVED-BODY' },
  contact, transportId, consent: { status: 'granted' }, decision: 'approved', decidedBy: 'fixture-owner', decidedAt: T0 })
const textFile = join(dir, 'text.txt')
writeFileSync(textFile, 'PRIVATE-APPROVED-BODY', 'utf8')
let refused
try {
  execFileSync(process.execPath, ['tools/psyche-outbound.mjs', 'approve-send', '--data', dir, '--snowluma', dir, '--sender', '39999', '--recipient', '10001', '--text-file', textFile], { cwd: resolve('.'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
} catch (error) { refused = error }
eq('非交互入口明确拒绝', refused?.status, 2)
eq('非交互拒绝不暴露正文', String(refused?.stdout).includes('PRIVATE-APPROVED-BODY'), false)
eq('非交互拒绝不留下审批', store.countActive(), 0)
const row = store.enqueue(input('crash-approval', 'qq-fixture')).row
const status = execFileSync(process.execPath, ['tools/psyche-outbound.mjs', 'status', '--data', dir], { cwd: resolve('.'), encoding: 'utf8' })
eq('状态查询不显示审批正文', status.includes('PRIVATE-APPROVED-BODY'), false)
eq('状态查询不改变 pending', store.get(row.outboxId)?.status, 'pending')

const launch = () => {
  const child = spawn(process.execPath, ['test/helpers/proactive-worker-child.mjs', file, row.outboxId], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] })
  const first = new Promise((resolve, reject) => {
    let text = ''
    child.stdout.on('data', (chunk) => { text += chunk; const line = text.split('\n').find((s) => s.startsWith('{')); if (line) resolve(JSON.parse(line)) })
    child.on('error', reject)
    child.on('exit', (code) => { if (!text.trim()) reject(new Error(`child exited ${code}`)) })
  })
  const exit = new Promise((resolve) => child.on('exit', resolve))
  return { child, first, exit }
}
const children = [launch(), launch(), launch()]
let lease
let wire
let connection
try {
  const results = await Promise.all(children.map((c) => c.first))
  eq('三进程只一个取得运行权', results.filter((r) => r.ready).length, 1)
  eq('其余进程明确拒绝', results.filter((r) => r.busy).length, 2)
  eq('跨进程仅一次领取', results.reduce((n, r) => n + (r.claimed ?? 0), 0), 1)
  eq('崩溃前已持久化 dispatching', store.get(row.outboxId)?.status, 'dispatching')
  let busy = false
  try { await acquireOutboundLease(file) } catch { busy = true }
  eq('活动 Worker 存在时父进程不能启动恢复', busy, true)
  const winner = children[results.findIndex((r) => r.ready)]
  winner.child.kill('SIGKILL')
  await winner.exit
  lease = await acquireOutboundLease(file)
  eq('进程崩溃后内核释放租约', Boolean(lease), true)
  eq('排他运行权内恢复一行', store.recoverInflight(), 1)
  eq('恢复落 unknown', store.get(row.outboxId)?.status, 'unknown')
  eq('恢复原因 worker_restart', store.get(row.outboxId)?.lastErrorCode, 'worker_restart')
  wire = await oneBotFixture()
  connection = createOwnerQqConnection(wire)
  await connection.connect(2000)
  const service = new OutboundService({ store, transport: connection.transport, ownerId: 'fixture-owner', consentReader: () => ({ status: 'granted' }), allowReader: () => 'allowed' })
  await service.runOnce({ outboxId: row.outboxId, limit: 1 })
  eq('恢复后真实 Transport 零重发', wire.actions.length, 0)
  store.resolveUnknown(row.outboxId, 'not-received', 'fixture-owner')
  eq('人工未收到落 failed', store.get(row.outboxId)?.status, 'failed')
  eq('旧批准不能复活', store.enqueue(input('crash-approval', 'qq-fixture')).row.status, 'failed')
  const fresh = store.enqueue(input('new-approval', connection.transport.id)).row
  await service.runOnce({ outboxId: fresh.outboxId, limit: 1 })
  eq('重新审批后才发送一次', wire.actions.length, 1)
  eq('新审批 sent', store.get(fresh.outboxId)?.status, 'sent')
} finally {
  for (const c of children) if (c.child.exitCode === null) c.child.kill('SIGKILL')
  await Promise.all(children.map((c) => c.exit))
  await connection?.transport.close()
  await wire?.close()
  await lease?.release()
  db.close()
}
console.log(`[C3b proactive-owner] ${passed} 通过 ${failed} 失败`)
if (failed) process.exitCode = 1
