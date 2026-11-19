// P2-CAP-1c2a：跨进程并发 Capture 测试。
//
// 1a 的同进程「并发」测试（Promise.all）在 SQLite 同步 API 下实际是串行的，
// 只验证了查重逻辑。这里用两个独立 Node 子进程、两个独立数据库连接，
// 让它们在同一时刻对同一 captureKey 执行 capture：
//
// 1. 同 key 同文本：只产生一条 Source，两个进程拿到同一个 sourceId，
//    恰好一个 replayed=false、一个 replayed=true。
// 2. 同 key 不同文本：一个成功，另一个 E_CAPTURE_CONFLICT，原行不被覆盖。
//
// 跑法：node test/capture-concurrent.ts（需要先 npm run build）

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, migrate } from '../dist/lib/adapter.js'

const dir = mkdtempSync(join(tmpdir(), 'psyche-concurrent-'))
const dbFile = join(dir, 'memory.sqlite3')
const childPath = fileURLToPath(new URL('./helpers/capture-child.mjs', import.meta.url))

let passed = 0
let failed = 0

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function runChild(tag, captureKey, text) {
  const barrier = join(dir, `barrier-${tag}`)
  const result = join(dir, `result-${tag}.json`)
  const child = spawn(process.execPath, [childPath, dir, captureKey, text, barrier, result], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const done = new Promise((resolve) => child.on('exit', () => resolve(result)))
  return { child, barrier, result, done, stderr: () => stderr }
}

async function waitReady(handles) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (handles.every((h) => existsSync(`${h.result}.ready`))) return true
    await sleep(20)
  }
  return false
}

async function readResult(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { ok: false, code: null, message: `结果文件不可读：${String(error)}` }
  }
}

// 父进程先建库：避免两个子进程同时跑迁移产生额外竞争（这里只测 capture）
{
  const log = { info() {}, debug() {}, warn() {}, error() {} }
  const opened = await openDatabase({ file: dbFile, driverPreference: 'auto', logger: log })
  migrate(opened.db, log)
  opened.db.close?.()
}

const openRead = async () => {
  const log = { info() {}, debug() {}, warn() {}, error() {} }
  const opened = await openDatabase({ file: dbFile, driverPreference: 'auto', logger: log })
  return opened.db
}

console.log('\n[P2-CAP-1c2a] 跨进程并发 Capture')

// --- 场景 1：同 key 同文本 ---
{
  const a = runChild('a', 'k-same', '同一句话')
  const b = runChild('b', 'k-same', '同一句话')
  const ready = await waitReady([a, b])
  ok('两个子进程都到达起跑线', ready === true)
  if (!ready) {
    console.log(`  子进程 a stderr: ${a.stderr()}`)
    console.log(`  子进程 b stderr: ${b.stderr()}`)
  }
  writeFileSync(a.barrier, 'go', 'utf8')
  writeFileSync(b.barrier, 'go', 'utf8')
  const [ar, br] = await Promise.all([a.done, b.done])
  const ra = await readResult(ar)
  const rb = await readResult(br)

  ok('两个进程都成功返回', ra.ok === true && rb.ok === true, { ra, rb })
  ok('两边 sourceId 一致', ra.sourceId === rb.sourceId, { a: ra.sourceId, b: rb.sourceId })
  ok(
    '恰好一个首次、一个重放',
    [ra.replayed, rb.replayed].sort().join(',') === 'false,true',
    { a: ra.replayed, b: rb.replayed },
  )

  const db = await openRead()
  const count = Number(db.get(`SELECT COUNT(*) AS n FROM sources WHERE capture_key = ?`, ['k-same']).n)
  eq('数据库里同 key 只有一条 Source', count, 1)
  const row = db.get(`SELECT source_id, text FROM sources WHERE capture_key = ?`, ['k-same'])
  eq('落库内容没有被改', row.text, '同一句话')
  db.close?.()
}

// --- 场景 2：同 key 不同文本 ---
{
  const a = runChild('c', 'k-conflict', '第一版')
  const b = runChild('d', 'k-conflict', '第二版')
  const ready = await waitReady([a, b])
  ok('冲突场景两个子进程都到达起跑线', ready === true)
  writeFileSync(a.barrier, 'go', 'utf8')
  writeFileSync(b.barrier, 'go', 'utf8')
  const [ar, br] = await Promise.all([a.done, b.done])
  const ra = await readResult(ar)
  const rb = await readResult(br)

  const results = [ra, rb]
  const success = results.filter((r) => r.ok === true)
  const conflicts = results.filter((r) => r.ok === false)
  eq('同 key 不同文本：恰好一个成功', success.length, 1)
  eq('同 key 不同文本：恰好一个冲突', conflicts.length, 1)
  eq('冲突错误码是 E_CAPTURE_CONFLICT', conflicts[0]?.code, 'E_CAPTURE_CONFLICT')

  const db = await openRead()
  const count = Number(db.get(`SELECT COUNT(*) AS n FROM sources WHERE capture_key = ?`, ['k-conflict']).n)
  eq('冲突场景数据库只保留一条 Source', count, 1)
  db.close?.()
}

// --- 清理 ---
rmSync(dir, { recursive: true, force: true })

console.log(`\n[P2-CAP-1c2a] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
