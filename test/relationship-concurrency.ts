// P3-B-1 关系账本并发测试：两个进程同投递同一 independence_key。
//
// 预期：BEGIN IMMEDIATE 串行化后，一个真正写入（duplicate=false），另一个命中事务内查重
// （duplicate=true），账本只有 1 行、好感只加一次。当前没有唯一索引，查重是唯一防线。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, migrate } from '../packages/core/dist/adapter.js'
import { Core } from '../packages/core/dist/store.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}
function near(actual: number, expected: number, tolerance: number, message: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}（actual=${actual} expected=${expected}）`)
  passed += 1
}

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HELPER = join(ROOT, 'test', 'helpers', 'relationship-child.mjs')
const log = { info() {}, debug() {}, warn() {}, error() {} }

function waitFile(file: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (existsSync(file)) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`等待超时：${file}`))
      }
    }, 25)
  })
}
function runChild(args: string[], evidence: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER, ...args], {
      stdio: 'ignore',
      env: { ...process.env, REL_EVIDENCE: evidence },
    })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-rel-concurrent-'))
const file = join(dir, 'memory.sqlite3')
const opened = await openDatabase({ file, driverPreference: 'auto', logger: log })
migrate(opened.db, log)
const core = new Core({ db: opened.db, config: {}, logger: log, dataDir: dir })
const contact = await core.resolveContact({ platform: 'qq', stableUserId: '99001' })
const captured = await core.capture({ text: '并发证据', sessionRef: 'rel-conc', at: '2026-11-12T04:00:00.000Z' })
const evidence = captured.sourceId
opened.db.close()

const readyA = join(dir, 'a.ready')
const readyB = join(dir, 'b.ready')
const barrier = join(dir, 'go')
const resultA = join(dir, 'a.result.json')
const resultB = join(dir, 'b.result.json')

const childA = runChild([file, contact.contactId, 'conc-rel-a', 'same-key', readyA, barrier, resultA], evidence)
const childB = runChild([file, contact.contactId, 'conc-rel-b', 'same-key', readyB, barrier, resultB], evidence)
await Promise.all([waitFile(readyA), waitFile(readyB)])
writeFileSync(barrier, 'go')
const [codeA, codeB] = await Promise.all([childA, childB])

check(codeA === 0, '子进程 A 正常退出')
check(codeB === 0, '子进程 B 正常退出')
const a = JSON.parse(readFileSync(resultA, 'utf8')) as { ok: boolean; duplicate?: boolean; code?: string; error?: string }
const b = JSON.parse(readFileSync(resultB, 'utf8')) as { ok: boolean; duplicate?: boolean; code?: string; error?: string }
check(a.ok, `A 成功${a.error ? `（${a.error}）` : ''}`)
check(b.ok, `B 成功${b.error ? `（${b.error}）` : ''}`)
check([a.duplicate, b.duplicate].filter((x) => x === false).length === 1, '恰好一个真正写入')
check([a.duplicate, b.duplicate].filter((x) => x === true).length === 1, '恰好一个命中查重')

const reopened = await openDatabase({ file, driverPreference: 'auto', logger: log })
const signals = reopened.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM relationship_signals') as { n: number }
check(Number(signals.n) === 1, `账本只有 1 行（实际 ${signals.n}）`)
const state = reopened.db.get<{ affinity: number }>(
  'SELECT affinity FROM relationship_affinity_state WHERE contact_id = ?',
  [contact.contactId],
) as { affinity: number }
near(Number(state.affinity), 54, 1e-6, '好感只加一次 50+4=54')

reopened.db.close()
rmSync(dir, { recursive: true, force: true })
console.log(`[P3-B-1 relationship-concurrency] ${passed} 通过 0 失败`)
