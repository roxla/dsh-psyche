// Mood 并发测试（P3-A B1）：两个子进程同时 applyMood，BEGIN IMMEDIATE 串行化、不丢更新。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../packages/core/dist/adapter.js'
import { ensureMoodInitialized, loadMood, readMoodMeta } from '../packages/core/dist/mood-store.js'

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
const HELPER = join(ROOT, 'test', 'helpers', 'mood-child.mjs')

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

function runChild(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER, ...args], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-mood-concurrent-'))
const file = join(dir, 'memory.sqlite3')
const opened = await openDatabase({ file })
ensureMoodInitialized(opened.db, { now: '2026-01-01T00:00:00.000Z' })
opened.db.close()

const readyA = join(dir, 'a.ready')
const readyB = join(dir, 'b.ready')
const barrier = join(dir, 'go')
const resultA = join(dir, 'a.result.json')
const resultB = join(dir, 'b.result.json')

const childA = runChild([file, 'conc-op-a', '10', readyA, barrier, resultA])
const childB = runChild([file, 'conc-op-b', '5', readyB, barrier, resultB])
await Promise.all([waitFile(readyA), waitFile(readyB)])
writeFileSync(barrier, 'go')
const [codeA, codeB] = await Promise.all([childA, childB])

check(codeA === 0, '子进程 A 正常退出')
check(codeB === 0, '子进程 B 正常退出')
const resultARaw = JSON.parse(readFileSync(resultA, 'utf8')) as { ok: boolean; applied?: boolean; stateVersion?: number; error?: string }
const resultBRaw = JSON.parse(readFileSync(resultB, 'utf8')) as { ok: boolean; applied?: boolean; stateVersion?: number; error?: string }
check(resultARaw.ok, `A 应用成功${resultARaw.error ? `（${resultARaw.error}）` : ''}`)
check(resultBRaw.ok, `B 应用成功${resultBRaw.error ? `（${resultBRaw.error}）` : ''}`)
check(resultARaw.applied === true && resultBRaw.applied === true, '两个操作都真正应用（不是重放）')

const reopened = await openDatabase({ file })
const meta = readMoodMeta(reopened.db)
check(meta?.stateVersion === 3, `版本从 1 推进到 3（实际 ${meta?.stateVersion}）`)
const history = reopened.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM global_mood_history') as { n: number }
check(Number(history.n) === 66, `两次操作各 33 行历史（实际 ${history.n}）`)
const state = loadMood(reopened.db, { now: '2026-01-05T00:00:00.000Z' })
near(Number(state.values.calm ?? 0), 60, 1e-6, 'calm 45+10+5=60（没有丢失更新）')
const distinctOps = reopened.db.get<{ n: number }>(
  'SELECT COUNT(DISTINCT op_id) AS n FROM global_mood_history WHERE op_id IS NOT NULL',
) as { n: number }
check(Number(distinctOps.n) === 2, '两个 op_id 都在历史里')

reopened.db.close()
rmSync(dir, { recursive: true, force: true })
console.log(`[P3-A B1 mood-concurrency] ${passed} 通过 0 失败`)
