// P5-R-4x：Contact Affect 只读投影读取的边界测试。
//
// 验收口径：
// - 缺行 / 空 contactId / DB 不可用 / 值非法 → null（调用方按 0 处理）。
// - 五维按各自半衰期冷却到 now，复用 Core 的 effectiveAffectValues。
// - 只查给定 contactId，不跨 Contact、不回退上一轮。
import assert from 'node:assert/strict'
import { readContactAffectSync } from '../dist/lib/contact-affect-read.js'

let passed = 0
const test = (name: string, fn: () => void): void => {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const NOW = '2026-01-01T12:00:00.000Z'
const HOUR = 60 * 60 * 1000

const fakeDb = (rows: unknown[], seen: string[] = []) => ({
  all: <T>(sql: string, params?: unknown[]): T[] => {
    seen.push(`${sql}|${JSON.stringify(params)}`)
    return rows as T[]
  },
})

test('缺 contactId 返回 null', () => {
  assert.equal(readContactAffectSync(fakeDb([{ dimension: 'warmth', value: 10, updated_at: NOW }]), null, NOW), null)
  assert.equal(readContactAffectSync(fakeDb([]), '   ', NOW), null)
})

test('无行返回 null', () => {
  assert.equal(readContactAffectSync(fakeDb([]), 'ct_1', NOW), null)
})

test('DB 不可用或 all 抛错返回 null', () => {
  assert.equal(readContactAffectSync(null, 'ct_1', NOW), null)
  const boom = { all: () => { throw new Error('db down') } }
  assert.equal(readContactAffectSync(boom, 'ct_1', NOW), null)
})

test('非法行被忽略，全部非法返回 null', () => {
  const rows = [
    { dimension: 'warmth', value: 'x', updated_at: NOW },
    { dimension: '', value: 10, updated_at: NOW },
    { dimension: 'hurt', value: 5 },
  ]
  assert.equal(readContactAffectSync(fakeDb(rows), 'ct_1', NOW), null)
})

test('按半衰期冷却：warmth 8h、irritation 2h', () => {
  const rows = [
    { dimension: 'warmth', value: 80, updated_at: '2026-01-01T04:00:00.000Z' }, // 8h 前 → 40
    { dimension: 'irritation', value: 80, updated_at: '2026-01-01T10:00:00.000Z' }, // 2h 前 → 40
    { dimension: 'tension', value: 20, updated_at: NOW }, // 刚更新 → 20
  ]
  const values = readContactAffectSync(fakeDb(rows), 'ct_1', NOW)
  assert.ok(values)
  assert.ok(Math.abs(values!.warmth - 40) < 1e-9)
  assert.ok(Math.abs(values!.irritation - 40) < 1e-9)
  assert.equal(values!.tension, 20)
  assert.equal(values!.hurt, 0)
  assert.equal(values!.missing, 0)
})

test('查询只带 persona=main 与给定 contactId', () => {
  const seen: string[] = []
  readContactAffectSync(fakeDb([{ dimension: 'warmth', value: 1, updated_at: NOW }], seen), 'ct_42', NOW)
  assert.equal(seen.length, 1)
  assert.ok(seen[0].includes('contact_affect_state'))
  assert.ok(seen[0].includes('["main","ct_42"]'))
})

test('跨 Contact 不串：不同 contactId 各查各的行', () => {
  const byContact: Record<string, unknown[]> = {
    ct_a: [{ dimension: 'warmth', value: 30, updated_at: NOW }],
    ct_b: [{ dimension: 'hurt', value: 30, updated_at: NOW }],
  }
  const db = {
    all: <T>(sql: string, params?: unknown[]): T[] => (byContact[String(params?.[1])] ?? []) as T[],
  }
  const a = readContactAffectSync(db, 'ct_a', NOW)
  const b = readContactAffectSync(db, 'ct_b', NOW)
  assert.equal(a!.warmth, 30)
  assert.equal(a!.hurt, 0)
  assert.equal(b!.hurt, 30)
  assert.equal(b!.warmth, 0)
})

console.log(`\n${passed} passed, 0 failed`)
