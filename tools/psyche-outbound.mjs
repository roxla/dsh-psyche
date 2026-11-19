#!/usr/bin/env node
// C-3b 本机人工入口。无 HTTP/模型工具注册，无后台 Worker；审批正文只在交互预览显示。
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { openDatabase } from '../packages/core/dist/adapter.js'
import { openAuditDatabase } from '../packages/core/dist/audit-db.js'
import { SCHEMA_VERSION } from '../packages/core/dist/schema.js'
import { readProactiveConsent } from '../packages/core/dist/proactive-consent.js'
import { proactiveTriggerOf } from '../packages/core/dist/proactive-trigger.js'
import { evaluateProactiveEligibility } from '../packages/core/dist/proactive-eligibility.js'
import { buildProactiveCandidates } from '../packages/core/dist/proactive-candidate.js'
import { createProactiveDraft } from '../packages/core/dist/proactive-draft.js'
import { OutboxStore } from '../packages/core/dist/proactive-outbox.js'
import { OutboundService } from '../packages/core/dist/proactive-outbound-service.js'
import { OutboxWorker } from '../packages/core/dist/proactive-outbox-worker.js'
import { acquireOutboundLease, localOwnerIdentity, readOwnerQqEndpoint } from '../dist/lib/proactive-owner-runtime.js'
import { createOwnerQqConnection } from '../dist/lib/proactive-qq-runtime.js'
import { redactAbsolutePaths } from '../dist/lib/http-dto.js'

const COMMANDS = new Set(['consent', 'status', 'approve', 'approve-send', 'send', 'resolve'])
const OPTIONS = new Set(['data', 'snowluma', 'sender', 'recipient', 'text-file', 'outbox', 'verdict'])
export function parseOutboundArgs(argv) {
  if (argv.length === 0 || argv[0] === '--help') return { command: 'help' }
  const command = argv[0]
  if (!COMMANDS.has(command)) throw new Error('未知主动发送命令')
  const options = { command }
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i].startsWith('--') ? argv[i].slice(2) : ''
    if (!OPTIONS.has(key) || options[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('未知、重复或缺失的参数')
    options[key] = argv[i + 1]
  }
  const required = ['data']
  if (['consent', 'approve', 'approve-send'].includes(command)) required.push('recipient')
  if (['approve', 'approve-send', 'send'].includes(command)) required.push('snowluma', 'sender')
  if (['approve', 'approve-send'].includes(command)) required.push('text-file')
  if (['send', 'resolve'].includes(command)) required.push('outbox')
  if (command === 'resolve') required.push('verdict')
  if (required.some((key) => !options[key])) throw new Error('缺少必填参数；请先查看 --help')
  for (const key of ['recipient', 'sender']) if (options[key] && !/^[1-9]\d{4,19}$/.test(options[key])) throw new Error('QQ 身份格式非法')
  if (command === 'resolve' && !['received', 'not-received'].includes(options.verdict)) throw new Error('核验结论非法')
  return options
}

export function requireInteractiveOwner() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('审批、发送与核验只接受本机交互终端；不接受非交互确认或 --yes')
}
const now = () => new Date().toISOString()
const viewRow = (row) => ({ outboxId: row.outboxId, status: row.status, attempts: row.attempts,
  errorCode: row.lastErrorCode, messageId: row.status === 'sent' && row.receipt && !row.receipt.startsWith('{') ? row.receipt : undefined, expiresAt: row.expiresAt })

function contactFor(db, recipient) {
  const contact = db.get("SELECT contact_id, platform, stable_user_id FROM contacts WHERE persona_id='main' AND platform='qq' AND stable_user_id=?", [recipient])
  if (!contact) throw new Error('未找到已由可信入站建立的 Contact；CLI 不创建联系人')
  return { contactId: contact.contact_id, platform: contact.platform, stableUserId: contact.stable_user_id }
}

/** 测试版全局额度保守使用滚动 24h/7d；人工核验 sent 使用 updated_at 计入。 */
export function ownerEligibility(db, contact, connectionState, at, selectedId) {
  const snapshot = readProactiveConsent(db, contact.contactId, at)
  const last = db.get("SELECT MAX(COALESCE(sent_at, updated_at)) AS at FROM proactive_outbox WHERE contact_id=? AND status='sent'", [contact.contactId])
  const daily = new Date(Date.parse(at) - 24 * 60 * 60 * 1000).toISOString()
  const weekly = new Date(Date.parse(at) - 7 * 24 * 60 * 60 * 1000).toISOString()
  const counts = db.get(`SELECT SUM(CASE WHEN COALESCE(sent_at, updated_at)>=? THEN 1 ELSE 0 END) AS daily,
    SUM(CASE WHEN COALESCE(sent_at, updated_at)>=? THEN 1 ELSE 0 END) AS weekly FROM proactive_outbox WHERE status='sent'`, [daily, weekly])
  const duplicate = db.get("SELECT COUNT(*) AS n FROM proactive_outbox WHERE contact_id=? AND status IN ('pending','dispatching','unknown') AND (? IS NULL OR outbox_id<>?)",
    [contact.contactId, selectedId ?? null, selectedId ?? null])
  const trigger = proactiveTriggerOf({ kind: 'owner_request', now: at, contactId: contact.contactId, evidenceRefs: snapshot.consent?.sourceId ? [snapshot.consent.sourceId] : [] })
  const eligibility = evaluateProactiveEligibility({
    contact: { ...contact, personaId: 'main', timezone: snapshot.timezone ?? undefined },
    channel: { platform: 'qq', kind: 'private', status: connectionState },
    consent: { status: snapshot.consent?.status ?? 'missing', expiresAt: snapshot.consent?.expiresAt },
    policy: { proactiveEnabled: true }, trigger, now: at,
    usage: { lastContactedAt: last?.at ?? undefined, globalToday: Number(counts?.daily ?? 0), globalWeek: Number(counts?.weekly ?? 0) },
    duplicateCandidate: Number(duplicate?.n ?? 0) > 0,
  })
  return { snapshot, trigger, eligibility }
}

async function confirmed(token) {
  const input = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await input.question(`输入 ${token} 继续：`)
    if (answer.trim() !== token) throw new Error('未确认，操作已取消')
  } finally { input.close() }
}

function usage() {
  console.log(`心灵主动联系（本机人工 CLI，需先 npm run build）
consent --data <目录> --recipient <收件QQ>                         只读同意状态
status --data <目录> [--outbox <ID>]                              只读状态，不显示正文
approve --data <目录> --snowluma <目录> --sender <发送QQ> --recipient <收件QQ> --text-file <UTF8文件>
approve-send <同 approve 参数>                                  预览/确认后只发送本次审批
send --data <目录> --snowluma <目录> --sender <发送QQ> --outbox <ID>  显式派发已审批任务一次
resolve --data <目录> --outbox <ID> --verdict received|not-received 人工核验，不重发
同意指令：同意心灵主动测试至 <带时区ISO时间>；时区 <IANA>
撤回指令：撤回心灵主动测试
无 --owner/--decidedBy/--yes。Worker 不随宿主启动。`)
}

export async function runOutboundCli(argv) {
  const args = parseOutboundArgs(argv)
  if (args.command === 'help') { usage(); return }
  const writing = !['consent', 'status'].includes(args.command)
  if (writing) requireInteractiveOwner()
  const file = join(resolve(args.data), 'memory.sqlite3')
  if (!existsSync(file)) throw new Error('数据根尚无数据库；请先通过可信入站建立数据')
  const read = openAuditDatabase(file)
  try {
    if (Number(read.db.get('PRAGMA user_version')?.user_version) !== SCHEMA_VERSION) throw new Error('数据库 Schema 与当前实现不一致；CLI 不自动升级')
    if (args.command === 'consent') {
      const contact = contactFor(read.db, args.recipient)
      const value = readProactiveConsent(read.db, contact.contactId, now())
      console.log(JSON.stringify({ status: value.reason, timezone: value.timezone, expiresAt: value.consent?.expiresAt ?? null }))
      return
    }
    if (args.command === 'status') {
      const store = new OutboxStore({ db: read.db, ownerId: localOwnerIdentity().id })
      const rows = args.outbox ? [store.get(args.outbox)].filter(Boolean) : store.list()
      console.log(JSON.stringify(rows.map(viewRow), null, 2))
      return
    }
  } finally { read.close() }

  const lease = await acquireOutboundLease(file)
  let db
  let connection
  try {
    const opened = await openDatabase({ file, logger: { info() {}, debug() {}, warn() {}, error() {} } })
    db = opened.db
    const owner = localOwnerIdentity()
    const store = new OutboxStore({ db, ownerId: owner.id })
    // 排他运行权内，任何上代 dispatching 都已没有本入口的活动发送者。
    const recovered = store.recoverInflight()
    if (recovered) console.log(JSON.stringify({ recoveredUnknown: recovered }))
    if (args.command === 'resolve') {
      const row = store.get(args.outbox)
      if (!row || row.status !== 'unknown') throw new Error('只有 unknown 任务可以人工核验')
      console.log(`Owner ${owner.label}：核验 ${row.outboxId} 为 ${args.verdict}，此操作不会发送。`)
      await confirmed(`VERIFIED ${args.verdict} ${row.outboxId}`)
      console.log(JSON.stringify(viewRow(store.resolveUnknown(row.outboxId, args.verdict, owner.id))))
      return
    }
    const endpoint = readOwnerQqEndpoint(resolve(args.snowluma), args.sender)
    connection = createOwnerQqConnection({ ...endpoint, senderAccount: args.sender })
    await connection.connect()
    let selectedId = args.outbox
    const consentReader = (id) => readProactiveConsent(db, id, now()).consent
    const service = new OutboundService({ store, transport: connection.transport, ownerId: owner.id, consentReader,
      allowReader: (id) => {
        const row = db.get("SELECT stable_user_id FROM contacts WHERE contact_id=? AND persona_id='main' AND platform='qq'", [id])
        if (!row) return 'missing'
        const contact = { contactId: id, platform: 'qq', stableUserId: row.stable_user_id }
        return ownerEligibility(db, contact, connection.transport.status(), now(), selectedId).eligibility.eligible ? 'allowed' : 'revoked'
      },
    })
    if (args.command === 'approve' || args.command === 'approve-send') {
      const contact = contactFor(db, args.recipient)
      const initial = ownerEligibility(db, contact, connection.transport.status(), now())
      if (!initial.eligibility.eligible) throw new Error('资格未通过：' + initial.eligibility.reasonCodes.join(','))
      const text = readFileSync(resolve(args['text-file']), 'utf8').replace(/^\uFEFF/, '')
      const ref = initial.snapshot.consent.sourceId
      const candidate = buildProactiveCandidates({ trigger: initial.trigger, now: now(), contacts: [{
        contactId: contact.contactId, eligibility: initial.eligibility, evidence: [ref],
      }] }).candidates[0]
      const draft = createProactiveDraft({ candidate, text, evidenceRefs: [ref], evidence: [{ ref, text: '联系人本人明确同意限时主动测试' }], now: now() })
      console.log(`Owner ${owner.label}\n发送账号：${args.sender}\n收件人：${args.recipient}\n通道：qq-onebot\nrevision：${draft.revision}\nhash：${draft.draftHash}\n正文（JSON 转义预览）：\n${JSON.stringify(draft.text)}\n`)
      await confirmed(`APPROVE ${draft.draftHash}`)
      const fresh = ownerEligibility(db, contact, connection.transport.status(), now())
      if (!fresh.eligibility.eligible) throw new Error('确认后资格已变化：' + fresh.eligibility.reasonCodes.join(','))
      const enqueued = service.approveAndEnqueue({ approvalId: `ap_${randomUUID()}`, draft, contact,
        transportId: connection.transport.id, consent: fresh.snapshot.consent, decidedBy: owner.id, decidedAt: now() })
      selectedId = enqueued.row.outboxId
      console.log(JSON.stringify(viewRow(enqueued.row)))
      if (args.command === 'approve') return
    } else {
      const row = store.get(selectedId)
      if (!row || row.status !== 'pending') throw new Error('所选审批任务不处于 pending；不会重发其他状态')
      console.log(`Owner ${owner.label}\n派发所选审批：${row.outboxId}\nrevision：${row.draftRevision}\nhash：${row.draftHash}\n正文（JSON 转义预览）：\n${JSON.stringify(row.payloadText)}\n`)
      await confirmed(`SEND ${row.outboxId}`)
    }
    let workerError
    const worker = new OutboxWorker({ service, limit: 1, outboxId: selectedId, onError: (error) => { workerError = error } })
    try { await worker.tickOnce() } finally { worker.stop() }
    if (workerError) throw workerError
    console.log(JSON.stringify(viewRow(store.get(selectedId))))
  } finally {
    await connection?.transport.close()
    db?.close()
    await lease.release()
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runOutboundCli(process.argv.slice(2)).catch((error) => {
    // 不输出 stack、审批正文、路径或凭据。错误码属于本机管理输出。
    console.error(redactAbsolutePaths(error?.detail?.reason ?? error?.message ?? '主动联系入口失败'))
    process.exitCode = 2
  })
}
