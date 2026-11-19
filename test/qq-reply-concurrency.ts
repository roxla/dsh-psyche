// P4-B-4-2a 并发回归：两个进程同时入队同一 session_seq。
//
// 预期：
// - 同内容：一个进程真正写入（duplicate=false），另一个按幂等待既有行（duplicate=true），
//   队列只有 1 行；BEGIN IMMEDIATE + 事务内幂等查重共同保证。
// - 不同内容：一个成功，另一个以 conflict 失败；队列仍只有该 seq 的 1 行，不产生覆盖。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate, openDatabase } from '../packages/core/dist/adapter.js'
import { Core } from '../packages/core/dist/store.js'
import { QQ_REPLY_ERROR } from '../packages/core/dist/qq-reply-outbox.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HELPER = join(ROOT, 'test', 'helpers', 'qq-reply-child.mjs')
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
    }, 20)
  })
}

function runChild(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER, ...args], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

interface ChildResult {
  ok: boolean
  duplicate?: boolean
  reason?: string
  replyId?: string
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-reply-concurrent-'))
const file = join(dir, 'memory.sqlite3')
const opened = await openDatabase({ file, driverPreference: 'auto', logger: log })
migrate(opened.db, log)
const core = new Core({ db: opened.db, config: {}, logger: log, dataDir: dir })
const contact = await core.resolveContact({ platform: 'qq', stableUserId: '20001' })
opened.db.close()

async function race(seq: number, texts: [string, string]): Promise<{ a: ChildResult; b: ChildResult }> {
  const readyA = join(dir, `a-${seq}.ready`)
  const readyB = join(dir, `b-${seq}.ready`)
  const barrier = join(dir, `go-${seq}`)
  const outA = join(dir, `a-${seq}.json`)
  const outB = join(dir, `b-${seq}.json`)
  const childA = runChild([file, contact.contactId, String(seq), texts[0], readyA, barrier, outA])
  const childB = runChild([file, contact.contactId, String(seq), texts[1], readyB, barrier, outB])
  await Promise.all([waitFile(readyA), waitFile(readyB)])
  writeFileSync(barrier, 'go')
  const [codeA, codeB] = await Promise.all([childA, childB])
  check(codeA === 0 && codeB === 0, `seq=${seq} 两个子进程正常退出`)
  return {
    a: JSON.parse(readFileSync(outA, 'utf8')) as ChildResult,
    b: JSON.parse(readFileSync(outB, 'utf8')) as ChildResult,
  }
}

async function countRows(seq: number): Promise<number> {
  const reopened = await openDatabase({ file, driverPreference: 'auto', logger: log })
  const row = reopened.db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM qq_reply_outbox WHERE session_seq = ?',
    [seq],
  )
  reopened.db.close()
  return row?.n ?? 0
}

// 1) 同内容并发：一写一幂等，最终同 seq 只有 1 行。
{
  const result = await race(9001, ['并发同内容', '并发同内容'])
  const results = [result.a, result.b]
  check(results.every((item) => item.ok), '同内容两个进程都成功')
  check(
    results.filter((item) => item.duplicate === false).length === 1
      && results.filter((item) => item.duplicate === true).length === 1,
    '同内容恰好一个写入、一个幂等返回',
  )
  check((await countRows(9001)) === 1, '同内容并发后同 seq 只有 1 行')
}

// 2) 不同内容并发：一写一冲突，不覆盖已有行。
{
  const result = await race(9002, ['并发内容A', '并发内容B'])
  const results = [result.a, result.b]
  check(results.filter((item) => item.ok).length === 1, '不同内容恰好一个成功')
  const rejected = results.find((item) => !item.ok)
  check(rejected?.reason === QQ_REPLY_ERROR.conflict, '不同内容失败方为 conflict')
  check((await countRows(9002)) === 1, '不同内容并发后同 seq 仍只有 1 行')
}

console.log(`[P4-B-4-2a qq-reply-concurrency] ${passed} 通过 0 失败`)
