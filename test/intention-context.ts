/**
 * P6-1：意愿投影读取的边界测试。
 * 不依赖真实库：用最小 fake db 验证 SQL 参数、空结果、异常与语气收缩。
 */
import assert from 'node:assert/strict'
import {
  INTENTION_LINE_MAX_CHARS,
  normalizeIntentionStatement,
  readLatestIntentionLine,
} from '../dist/lib/intention-context.js'

let passed = 0
let failed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}`)
    console.error(error instanceof Error ? error.stack : String(error))
  }
}

test('表不存在或查询异常时返回 null', () => {
  const broken = {
    get: () => {
      throw new Error('no such table: intentions')
    },
  }
  assert.equal(readLatestIntentionLine(broken, { now: 1000, personaId: 'main' }), null)
})

test('db 为 null 时返回 null', () => {
  assert.equal(readLatestIntentionLine(null, { now: 1000, personaId: 'main' }), null)
})

test('查询带 persona 与过期下界，并取最高分一条', () => {
  let seen: { sql: string; params: unknown[] } | null = null
  const db = {
    get: (sql: string, params: unknown[]) => {
      if (sql.includes('FROM intentions')) seen = { sql, params }
      if (sql.includes('FROM sources') || sql.includes('FROM artifacts')) return { ok: 1 }
      return {
        id: 'int_1',
        type: 'commitment',
        statement: '想把上次没读完的那本书接着读完',
        evidence_json: '["src_1"]',
        expires_at: 2000,
      }
    },
  }
  const line = readLatestIntentionLine(db, { now: 1500, personaId: 'main' })
  assert.ok(line?.startsWith('此刻的念头：'))
  assert.equal(seen?.params[0], 'main')
  assert.equal(seen?.params[1], 1500)
  assert.match(seen?.sql ?? '', /status = 'internal'/)
  assert.match(seen?.sql ?? '', /ORDER BY score DESC/)
})

test('空 statement 或非字符串返回 null', () => {
  const db = { get: () => ({ id: 'int_1', type: 'plan', statement: '   ', evidence_json: '[]', expires_at: 2000 }) }
  assert.equal(readLatestIntentionLine(db, { now: 1500, personaId: 'main' }), null)
})

test('去掉系统播报腔并保留原句', () => {
  assert.equal(normalizeIntentionStatement('检测到 未完成事项，想把上次没做完的部分补上'), '未完成事项，想把上次没做完的部分补上')
})

test('超长念头按上限截断并保留省略号', () => {
  const line = '想'.repeat(INTENTION_LINE_MAX_CHARS + 20)
  const normalized = normalizeIntentionStatement(line)
  assert.equal(normalized.length, INTENTION_LINE_MAX_CHARS)
  assert.ok(normalized.endsWith('…'))
})

console.log(`intention-context: ${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1
