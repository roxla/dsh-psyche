/**
 * 第 57 轮 P1-E：提醒的两处「说不准」。
 *
 * A. 桌面提醒没有自动投递通道（派发只取 `channels: ['qq']`），以前会照常登记、
 *    然后永远停在 `pending/unsupported`，卡片却渲染成「下一轮就发」。现在入口直接拒，零写入。
 * B. `delivery_state='unsupported'` 在新建 QQ 提醒上表示「等待入队」，旧文案却按它说
 *    「自动发送尚未启用」，等于每次登记都说错话。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../packages/core/dist/adapter.js'
import { createReminder, getReminder, listReminders, cancelReminder } from '../packages/core/dist/reminders.js'
import { buildTools, reminderStateText } from '../dist/lib/tools.js'
import { buildPendingReminders } from '../dist/lib/pending-reminders.js'
import { insertLegacyDesktopReminder } from './helpers/legacy-desktop-reminder.ts'

let passed = 0
let failed = 0
function ok(label: string, condition: boolean, actual?: unknown) {
  if (condition) { passed += 1; console.log('  ok ' + label) }
  else { failed += 1; console.error('  FAIL ' + label, { actual }) }
}
function eq(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed += 1; console.log('  ok ' + label) }
  else { failed += 1; console.error('  FAIL ' + label, { actual, expected }) }
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const dir = mkdtempSync(join(tmpdir(), 'psyche-desktop-reminder-'))
const opened = await openDatabase({ file: join(dir, 'p1e.sqlite3'), driverPreference: 'auto', logger: quiet })
const db = opened.db
await migrate(db, quiet)
const NOW = '2026-06-01T00:00:00.000Z'
const at = (minute: number) => new Date(Date.parse(NOW) + minute * 60_000).toISOString()
await db.run(
  `INSERT OR IGNORE INTO contacts
   (contact_id, persona_id, platform, stable_user_id, display_name, relation_label, created_at, updated_at)
   VALUES ('ct_owner', 'main', 'qq', '90001', '主人', 'owner', ?, ?)`,
  [NOW, NOW],
)

type Scope = { channel: 'desktop'; sessionRef: string } | { channel: 'qq'; contactId: string }

/** 与 `src/index.ts` 的 `toReminderView()` 同口径：工具层拿到的是视图，不是裸行。 */
function toView(row: {
  reminder_id: string; due_at: string; text: string; status: string; delivery_state: string
  created_at: string; channel?: 'desktop' | 'qq'; next_attempt_at?: string | null
}) {
  return {
    reminderId: row.reminder_id,
    dueAt: row.due_at,
    text: row.text,
    status: row.status,
    deliveryState: row.delivery_state,
    createdAt: row.created_at,
    channel: row.channel,
    nextAttemptAt: row.next_attempt_at ?? null,
  }
}

// ── A. 桌面提醒在登记入口被拒，零写入
{
  const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reminders')?.n ?? 0
  const result = createReminder({
    db: db as never, personaId: 'main',
    receiver: { channel: 'desktop', sessionRef: 'desk-1' },
    dueAt: at(10), timezone: 'Asia/Shanghai', text: '叫我喝水',
    requestId: 'req-desktop-1', now: NOW,
  })
  eq('桌面登记返回 unsupported-channel', result.status, 'unsupported-channel')
  eq('理由直接说清「本次未登记」', result.reason, '当前不支持桌面自动提醒，本次未登记')
  eq('不发生成提醒行', result.reminder, undefined)
  const after = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reminders')?.n ?? 0
  eq('表里一行都没多', after, before)
  const outbox = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM qq_reply_outbox')?.n ?? 0
  eq('队列里一行都没多', outbox, 0)
}

// ── B. 历史桌面提醒：列表显示「历史记录·桌面不支持自动发送」，卡片不再展示、也不占额度
{
  insertLegacyDesktopReminder({
    db: db as never, reminderId: 'rem_legacy_old', dueAt: at(-120),
    text: '旧的桌面提醒', sessionRef: 'desk-old', now: NOW,
  })
  const legacy = getReminder({ db: db as never, personaId: 'main', reminderId: 'rem_legacy_old' })
  ok('历史行仍然在读得到（不迁移、不删）', legacy !== undefined)

  // QQ 提醒（较晚到期）——它必须出现在卡片里，且不被旧的桌面行挤掉
  const created = createReminder({
    db: db as never, personaId: 'main',
    receiver: { channel: 'qq', contactId: 'ct_owner' },
    dueAt: at(5), timezone: 'Asia/Shanghai', text: 'QQ 提醒',
    requestId: 'req-qq-1', now: NOW, accessEpoch: 0,
  })
  eq('QQ 登记成功', created.status, 'created')

  const view = buildPendingReminders({ db: db as never, personaId: 'main', limit: 8 })
  eq('卡片只列 QQ 渠道', view.items.map((item) => item.reminderId), [created.reminder?.reminder_id])
  eq('卡片总数只算 QQ 渠道', view.total, 1)
  ok('桌面历史行不在 items 里', view.items.every((item) => item.reminderId !== 'rem_legacy_old'))

  const tiny = buildPendingReminders({ db: db as never, personaId: 'main', limit: 1 })
  eq('limit=1 也不会被桌面行占掉', tiny.items.map((item) => item.reminderId), [created.reminder?.reminder_id])
}

// ── C. 工具文案：桌面说「本次未登记」，QQ 说「会尝试发送」，都不再出现旧口径
{
  const toolList = buildTools({} as never, { reminderScope: () => ({ channel: 'qq', contactId: 'ct_owner' }) } as never) as unknown as {
    name: string
    output?: { render?: (args: unknown, value: unknown) => { text: string }[] }
    execute?: (args: unknown, exec?: unknown) => Promise<unknown>
  }[]
  const createTool = toolList.find((tool) => tool.name === 'psyche_create_reminder')
  ok('工具表里有 psyche_create_reminder', createTool !== undefined)

  const desktopText = createTool?.output?.render?.({}, {
    ok: true, status: 'unsupported-channel', reason: '当前不支持桌面自动提醒，本次未登记',
  })?.[0]?.text
  eq('桌面拒绝的文案', desktopText, '当前不支持桌面自动提醒，本次未登记。')

  const qqText = createTool?.output?.render?.({}, {
    ok: true,
    status: 'created',
    reminder: {
      reminderId: 'rem_x', dueAt: at(5), text: 'QQ 提醒', status: 'pending',
      deliveryState: 'unsupported', createdAt: NOW, channel: 'qq', nextAttemptAt: null,
    },
  })?.[0]?.text ?? ''
  ok('QQ 登记文案不再说「尚未启用」', !qqText.includes('自动发送尚未启用'), qqText)
  ok('QQ 登记文案说明会按允许回复时段尝试发送', qqText.includes('到点会按允许回复时段尝试发送'), qqText)

  const listTool = toolList.find((tool) => tool.name === 'psyche_list_reminders')
  void listTool
  const legacy = getReminder({ db: db as never, personaId: 'main', reminderId: 'rem_legacy_old' })
  ok('历史桌面行的 channel 仍是 desktop（列表据此改口径）', legacy?.channel, 'desktop')
  eq(
    '列表状态列对历史桌面行的说法',
    reminderStateText({
      reminderId: 'rem_legacy_old', dueAt: at(-120), text: '旧的桌面提醒', status: 'pending',
      deliveryState: 'unsupported', createdAt: NOW, channel: 'desktop', nextAttemptAt: null,
    }),
    '历史记录·桌面不支持自动发送',
  )
  eq(
    '列表状态列对 QQ 已入队行的说法',
    reminderStateText({
      reminderId: 'rem_x', dueAt: at(5), text: 'QQ 提醒', status: 'pending',
      deliveryState: 'pending', createdAt: NOW, channel: 'qq', nextAttemptAt: null,
    }),
    '已入队',
  )
  eq(
    '取消后的桌面历史行不再显示「不支持自动发送」',
    reminderStateText({
      reminderId: 'rem_legacy_old', dueAt: at(-120), text: '旧的桌面提醒', status: 'cancelled',
      deliveryState: 'unsupported', createdAt: NOW, channel: 'desktop', nextAttemptAt: null,
    }),
    '已取消',
  )
}

// ── D. 正常工具入口：列表 → 取消 → 再列表（取消必须看得出来）
{
  const tools = (scope: Scope) => buildTools(
    {
      createReminder: async (input: never) =>
        createReminder({ personaId: 'main', now: NOW, ...(input as object), db: db as never } as never),
      listReminders: async (limit?: number, receiver?: never) => {
        const rows = listReminders({ db: db as never, personaId: 'main', receiver: receiver as never, limit })
        return { ok: true, items: rows.map((row) => toView(row as never)), total: rows.length }
      },
      cancelReminder: async (reminderId: string, nowIso: string, receiver?: never) =>
        cancelReminder({ db: db as never, personaId: 'main', reminderId, receiver: receiver as never, now: nowIso }),
    } as never,
    { reminderScope: () => scope } as never,
  ) as unknown as {
    name: string
    output?: { render?: (args: unknown, value: unknown) => { text: string }[] }
    execute?: (args: unknown) => Promise<unknown>
  }[]

  const scope: Scope = { channel: 'desktop', sessionRef: 'desk-old' }
  const table = tools(scope)
  const listTool = table.find((tool) => tool.name === 'psyche_list_reminders')
  const cancelTool = table.find((tool) => tool.name === 'psyche_cancel_reminder')
  ok('工具表里有 psyche_list_reminders / psyche_cancel_reminder', listTool !== undefined && cancelTool !== undefined)

  const before = await listTool?.execute?.({}) as never
  const beforeText = listTool?.output?.render?.({}, before)?.[0]?.text ?? ''
  ok('取消前列表显示历史提示', beforeText.includes('历史记录·桌面不支持自动发送'), beforeText)

  const queuedBefore = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM qq_reply_outbox')?.n ?? 0
  const cancelled = await cancelTool?.execute?.({ reminder_id: 'rem_legacy_old' }) as { status?: string }
  eq('历史桌面行仍可取消', cancelled?.status, 'cancelled')

  const after = await listTool?.execute?.({}) as never
  const afterText = listTool?.output?.render?.({}, after)?.[0]?.text ?? ''
  ok('取消后列表显示「已取消」', afterText.includes('已取消'), afterText)
  ok('取消后不再显示「桌面不支持自动发送」', !afterText.includes('历史记录·桌面不支持自动发送'), afterText)
  const queuedAfter = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM qq_reply_outbox')?.n ?? 0
  eq('取消不新增队列行', queuedAfter, queuedBefore)
}

// ── E. 正常工具入口：桌面 execute 被拒、QQ execute 成功且不声称已入队
{
  const created: string[] = []
  const makeTools = (scope: Scope) => buildTools(
    {
      createReminder: async (input: never) => {
        created.push(String((input as { receiver?: { channel?: string } }).receiver?.channel))
        return createReminder({ personaId: 'main', now: NOW, ...(input as object), db: db as never } as never)
      },
    } as never,
    { reminderScope: () => scope } as never,
  ) as unknown as {
    name: string
    output?: { render?: (args: unknown, value: unknown) => { text: string }[] }
    execute?: (args: unknown) => Promise<unknown>
  }[]

  const rowsBefore = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reminders')?.n ?? 0
  const queuedBefore = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM qq_reply_outbox')?.n ?? 0

  const desktopTool = makeTools({ channel: 'desktop', sessionRef: 'desk-new' })
    .find((tool) => tool.name === 'psyche_create_reminder')
  const desktopValue = await desktopTool?.execute?.({ text: '桌面登记', due_at: at(30) })
  const desktopText = desktopTool?.output?.render?.({}, desktopValue)?.[0]?.text ?? ''
  eq('桌面 execute 的文案', desktopText, '当前不支持桌面自动提醒，本次未登记。')
  eq('桌面 execute 后提醒表零新增', db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reminders')?.n, rowsBefore)
  eq('桌面 execute 后队列零新增', db.get<{ n: number }>('SELECT COUNT(*) AS n FROM qq_reply_outbox')?.n, queuedBefore)

  const qqTool = makeTools({ channel: 'qq', contactId: 'ct_owner' })
    .find((tool) => tool.name === 'psyche_create_reminder')
  const qqValue = await qqTool?.execute?.({ text: 'QQ 登记', due_at: at(45) }) as { status?: string }
  const qqText = qqTool?.output?.render?.({}, qqValue)?.[0]?.text ?? ''
  eq('QQ execute 登记成功', qqValue?.status, 'created')
  ok('QQ execute 文案说明到点会尝试发送', qqText.includes('到点会按允许回复时段尝试发送'), qqText)
  ok('QQ execute 文案不声称已入队', !qqText.includes('已入队'), qqText)
}

db.close()
console.log(`[reminder-desktop] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
