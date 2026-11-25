// v29.18：关系信号入账（情感五维）。
//
// 三张表从 v20 就在、却一直没有写入路径——真机实测
// `relationship_signals` / `contact_affect_state` / `contact_affect_history`
// 全是 0 行，面板上的「好感 50 / 中立」只是初始化值。这里验的是补上写入之后
// 的四条判据（外部评审第 36 轮给的）：
//   ① A 明确感谢 → 新信号可追溯到本次输入，A 的维度按规则变化，B 不变；
//   ② 同一输入重放 → 信号数 / history 行数都不增，A 的数值不叠加；
//   ③ 联系人无法归属 → 写入 0，且能区分「没登记」和「文本里没有信号」；
//   ④ A、B 各自独立 → 固定同一时刻，A 的变化不会漏给 B。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '../packages/core/dist/adapter.js'
import {
  AFFECT_SIGNAL_RULES,
  detectAffectSignal,
  ingestAffectSignal,
} from '../packages/core/dist/relationship-ingest.js'

let passed = 0
const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const NOW = '2026-02-01T09:00:00.000Z'
const logger = { debug() {}, info() {}, warn() {}, error() {} }

interface Fixture {
  dir: string
  db: Awaited<ReturnType<typeof openDatabase>>['db']
  close: () => void
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-affect-'))
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger })
  migrate(opened.db, logger)
  // 信号要能追回原始输入，所以先把两条 source 落好。
  opened.db.run(
    "INSERT INTO sources (source_id, persona_id, platform, channel, origin, kind, text, captured_at, created_at) " +
      "VALUES ('src_a1', 'main', 'desktop', 'desktop', 'user', 'message', '谢谢你，这次帮了大忙', ?, ?), " +
      "('src_b1', 'main', 'desktop', 'desktop', 'user', 'message', '谢谢你提醒我', ?, ?), " +
      "('src_y', 'main', 'desktop', 'desktop', 'user', 'message', '今天天气不错', ?, ?)",
    [NOW, NOW, NOW, NOW, NOW, NOW],
  )
  // 第 38 轮新增：两笔串行累加的夹具（source_id 有外键，先落行）。
  opened.db.run(
    "INSERT INTO sources (source_id, persona_id, platform, channel, origin, kind, text, captured_at, created_at) " +
      "VALUES ('src_acc1', 'main', 'desktop', 'desktop', 'user', 'message', '谢谢你，帮了大忙', ?, ?), " +
      "('src_acc2', 'main', 'desktop', 'desktop', 'user', 'message', '谢谢你又提醒我一次', ?, ?), " +
      "('src_x', 'main', 'desktop', 'desktop', 'user', 'message', '谢谢你', ?, ?)",
    [NOW, NOW, NOW, NOW, NOW, NOW],
  )
  opened.db.run(
    "INSERT INTO contacts (contact_id, persona_id, platform, stable_user_id, display_name, created_at, updated_at) " +
      "VALUES ('ct_a', 'main', 'desktop', 'u_a', 'A', ?, ?), ('ct_b', 'main', 'desktop', 'u_b', 'B', ?, ?)",
    [NOW, NOW, NOW, NOW],
  )
  return {
    dir,
    db: opened.db,
    close: () => {
      opened.db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const count = (db: Fixture['db'], table: string): number => {
  const row = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
  return row ? Number(row.n) : 0
}

const values = (db: Fixture['db'], contactId: string): Record<string, number> => {
  const rows = db.all<{ dimension: string; value: number }>(
    'SELECT dimension, value FROM contact_affect_state WHERE contact_id = ?',
    [contactId],
  )
  const out: Record<string, number> = {}
  for (const row of rows) out[row.dimension] = row.value
  return out
}

await test('规则表只认明确表达，且能识别感谢', () => {
  assert.ok(AFFECT_SIGNAL_RULES.length >= 4)
  assert.equal(detectAffectSignal('谢谢你，这次帮了大忙')?.type, 'gratitude')
  assert.equal(detectAffectSignal('对不起，刚才是我说重了')?.type, 'apology')
  // 第 37 轮 P1（05）改了负向规则：抱怨必须指向心灵。「怎么又崩」说的是东西。
  assert.equal(detectAffectSignal('烦死了，怎么又崩'), null, '没指向心灵的烦躁不算关系信号')
  assert.equal(detectAffectSignal('你这样说让我很烦')?.type, 'complaint')
  assert.equal(detectAffectSignal('今天天气不错'), null, '中性陈述不该命中')
})

const fixture = await setup()

await test('A 明确感谢：写入一条信号，A 的 warmth 上升，B 不变', () => {
  const result = ingestAffectSignal(fixture.db, {
    contactId: 'ct_a',
    text: '谢谢你，这次帮了大忙',
    sourceId: 'src_a1',
    now: NOW,
  })
  assert.equal(result.status, 'applied')
  assert.equal(result.signalType, 'gratitude')
  assert.ok(result.signalId !== null)
  assert.equal(count(fixture.db, 'relationship_signals'), 1)
  assert.ok(count(fixture.db, 'contact_affect_state') >= 1)
  assert.ok(count(fixture.db, 'contact_affect_history') >= 1)
  const a = values(fixture.db, 'ct_a')
  assert.ok((a.warmth ?? 0) > 0, 'warmth 应该上升')
  assert.deepEqual(values(fixture.db, 'ct_b'), {}, 'B 一个维度都不该有')
})

await test('同一输入重放：不新增信号，数值不叠加', () => {
  const before = values(fixture.db, 'ct_a')
  const signalsBefore = count(fixture.db, 'relationship_signals')
  const historyBefore = count(fixture.db, 'contact_affect_history')
  const again = ingestAffectSignal(fixture.db, {
    contactId: 'ct_a',
    text: '谢谢你，这次帮了大忙',
    sourceId: 'src_a1',
    now: NOW,
  })
  assert.equal(again.status, 'replayed')
  assert.equal(count(fixture.db, 'relationship_signals'), signalsBefore)
  assert.equal(count(fixture.db, 'contact_affect_history'), historyBefore)
  assert.deepEqual(values(fixture.db, 'ct_a'), before, '重放不能把 warmth 再推一遍')
})

await test('归属无法确认时写入 0，且与「没有信号」区分开', () => {
  const unknown = ingestAffectSignal(fixture.db, {
    contactId: 'ct_not_registered',
    text: '谢谢你',
    sourceId: 'src_x',
    now: NOW,
  })
  assert.equal(unknown.status, 'no-contact')
  const empty = ingestAffectSignal(fixture.db, {
    contactId: 'ct_a',
    text: '今天天气不错',
    sourceId: 'src_y',
    now: NOW,
  })
  assert.equal(empty.status, 'no-signal')
  const missing = ingestAffectSignal(fixture.db, { text: '谢谢你', now: NOW })
  assert.equal(missing.status, 'no-contact')
  assert.equal(count(fixture.db, 'relationship_signals'), 1, '三次拒绝都不该新增信号行')
})

await test('A、B 各自独立：固定同一时刻，A 的变化不漏给 B', () => {
  const b = ingestAffectSignal(fixture.db, {
    contactId: 'ct_b',
    text: '谢谢你提醒我',
    sourceId: 'src_b1',
    now: NOW,
  })
  assert.equal(b.status, 'applied')
  const a = values(fixture.db, 'ct_a')
  const bv = values(fixture.db, 'ct_b')
  assert.ok((bv.warmth ?? 0) > 0)
  assert.notEqual(a.warmth, bv.warmth + a.warmth - bv.warmth + 0.0001, '断言 A 的 warmth 未被 B 覆盖')
  // 两条信号各记各的联系人
  const rows = fixture.db.all<{ contact_id: string }>(
    'SELECT contact_id FROM relationship_signals ORDER BY created_at',
  )
  assert.deepEqual(
    rows.map((row) => row.contact_id),
    ['ct_a', 'ct_b'],
  )
})

await test('负向信号要指向心灵才记，「我在烦编译器」不算', () => {
  // 第 37 轮外部评审 P1（05）：「编译器又崩了，我很烦」命中 complaint，
  // 会抬高对联系人的 irritation——用户看到的是一段他并没有的感情。
  assert.equal(detectAffectSignal('编译器又崩了，我很烦'), null, '说的是代码不是人')
  assert.equal(detectAffectSignal('我对这个软件失望'), null, '说的是软件')
  assert.equal(detectAffectSignal('我没有生你的气'), null, '否定句不是抱怨')
  const hit = detectAffectSignal('你刚才那样说让我失望')
  assert.equal(hit?.type, 'complaint', '明确指向心灵的失望要认')
})

await test('两次合法更新串行累加，不会互相覆盖', () => {
  // 第 38 轮外部评审 P1：现值原先在事务外读，两笔合法更新会各自
  // 基于同一个旧值算绝对新值，后写者整条覆盖前写者，前一笔凭空消失。
  const before = values(fixture.db, 'ct_a').warmth ?? 0
  const first = ingestAffectSignal(fixture.db, {
    contactId: 'ct_a',
    text: '谢谢你，帮了大忙',
    sourceId: 'src_acc1',
    independenceKey: 'acc:1',
    now: NOW,
  })
  const second = ingestAffectSignal(fixture.db, {
    contactId: 'ct_a',
    text: '谢谢你又提醒我一次',
    sourceId: 'src_acc2',
    independenceKey: 'acc:2',
    now: NOW,
  })
  assert.equal(first.status, 'applied')
  assert.equal(second.status, 'applied')
  const after = values(fixture.db, 'ct_a').warmth ?? 0
  const firstDelta = first.applied.find((item) => item.dimension === 'warmth')?.delta ?? 0
  const secondDelta = second.applied.find((item) => item.dimension === 'warmth')?.delta ?? 0
  assert.ok(
    Math.abs(after - (before + firstDelta + secondDelta)) < 0.001,
    `两笔增量都要留下：${before} + ${firstDelta} + ${secondDelta} 应为 ${after}`,
  )
  // 第二笔看到的 before 必须是第一笔之后的值，否则它算的就是覆盖而不是累加
  assert.ok(
    Math.abs((second.applied.find((item) => item.dimension === 'warmth')?.before ?? 0) - (before + firstDelta)) < 0.001,
    '第二笔的 before 要读到第一笔的结果',
  )
})

fixture.close()
console.log(`${passed} 通过 0 失败`)
