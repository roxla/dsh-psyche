// P2-CAP-1c3-B：Capture Cursor Store 测试。
//
// 冻结的语义（DEV.md §11.11）：
// 1. 首次使用自动建行；重复 initialize 不重置水位
// 2. 认领成功 = cursor_version+1；同一时刻第二个认领失败
// 3. 租约过期后别人可以接管；被接管的 claim 续租/推进/释放全部失败
// 4. 推进把 last_scanned_seq / scan_index / ignored_summary 一次提交，并续租
// 5. 水位不许倒退（调用方 bug → E_VALIDATION）
// 6. 释放回到 idle；旧 claim 不能靠 release 抢回控制权
// 7. 双进程并发认领：恰好一个成功
//
// 跑法：node test/capture-cursor.ts（需要先 npm run build）

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate, openDatabase } from '../dist/lib/adapter.js'
import { CaptureCursorStore } from '../dist/lib/capture-cursor.js'

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

function errorCode(fn) {
  try {
    fn()
    return null
  } catch (error) {
    return error?.code ?? String(error)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-cursor-'))
const dbFile = join(dir, 'memory.sqlite3')
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: dbFile, driverPreference: 'auto', logger: log })
migrate(opened.db, log)
const db = opened.db

// 固定时钟：租约过期与否完全由测试控制，不 sleep。
const clock = { now: '2026-11-05T10:00:00.000Z' }
const store = new CaptureCursorStore({ db, now: () => clock.now, leaseMs: 60_000 })

const identity = { platform: 'dsh', sessionRef: 'session-1' }
const cursorCount = () => Number(db.get(`SELECT COUNT(*) AS n FROM capture_cursors`).n)

console.log('\n[P2-CAP-1c3-B] Capture Cursor Store')

// 1. 不存在时 read 返回 null，不建行
eq('read 不存在返回 null', store.read(identity), null)
eq('read 不产生行', cursorCount(), 0)

// 2. initialize 幂等
const first = store.initialize(identity)
eq('initialize 建行', first.lastScannedSeq, -1)
eq('初始版本 0', first.cursorVersion, 0)
eq('初始状态 idle', first.recoveryState, 'idle')
eq('继承前缀计数默认 0', first.inheritedEventCount, 0)
store.initialize(identity)
eq('重复 initialize 不新增行', cursorCount(), 1)
eq('重复 initialize 不重置水位', store.read(identity)?.cursorVersion, 0)

// 3. 认领：成功一次，第二次失败
const claimA = store.claim(identity, { owner: 'owner-a', scanTargetSeq: 100 })
ok('首次认领成功', claimA !== null)
eq('认领后版本 1', claimA?.cursorVersion, 1)
eq('认领后状态 scanning', store.read(identity)?.recoveryState, 'scanning')
eq('认领记录目标水位', store.read(identity)?.scanTargetSeq, 100)
const claimB = store.claim(identity, { owner: 'owner-b', scanTargetSeq: 100 })
eq('租约未过期时第二个认领失败', claimB, null)

// 4. 非持有者不能写
eq('非持有者 renew 失败', store.renew({ ...claimA, owner: 'owner-b' }, 60_000), null)
eq('非持有者 release 失败', store.release({ ...claimA, owner: 'owner-b' }), false)

// 5. 持有者续租
const renewed = store.renew(claimA, 120_000)
ok('持有者续租成功', renewed !== null)
eq('续租后版本 2', renewed?.cursorVersion, 2)

// 6. 推进：水位 + 下标 + 忽略统计一次提交
const advanced = store.advance(renewed, {
  lastScannedSeq: 42,
  scanIndex: 7,
  ignoredSummary: '{"v1":{"attempt":3}}',
})
ok('推进成功', advanced !== null)
const afterAdvance = store.read(identity)
eq('水位推进到实际 seq', afterAdvance?.lastScannedSeq, 42)
eq('翻页下标更新', afterAdvance?.scanIndex, 7)
eq('忽略统计与水位同一次提交', afterAdvance?.ignoredSummary, '{"v1":{"attempt":3}}')
eq('推进后版本 3', afterAdvance?.cursorVersion, 3)

// 7. 水位不许倒退
eq(
  '水位倒退抛 E_VALIDATION',
  errorCode(() => store.advance(advanced, { lastScannedSeq: 41 })),
  'E_VALIDATION',
)
eq('倒退失败不改库', store.read(identity)?.lastScannedSeq, 42)

// 8. 旧 claim 不能推进
eq('旧 claim 推进失败', store.advance(claimA, { lastScannedSeq: 50 }), null)
eq('旧 claim 续租失败', store.renew(claimA), null)

// 9. 租约过期：别人接管，旧 claim 全失效
clock.now = '2026-11-05T10:02:00.000Z'
const claimC = store.claim(identity, { owner: 'owner-c', scanTargetSeq: 200 })
ok('租约过期后可接管', claimC !== null)
eq('接管后版本 4', claimC?.cursorVersion, 4)
eq('接管者成为 owner', store.read(identity)?.scanOwner, 'owner-c')
eq('旧 claim 接管后续租失败', store.renew(advanced), null)
eq('旧 claim 接管后推进失败', store.advance(advanced, { lastScannedSeq: 60 }), null)
eq('旧 claim 接管后释放失败', store.release(advanced), false)

// 10. 接管者推进并释放
const advancedC = store.advance(claimC, { lastScannedSeq: 150, scanIndex: 0 })
ok('接管者推进成功', advancedC !== null)
eq('释放成功', store.release(advancedC), true)
const afterRelease = store.read(identity)
eq('释放后 owner 清空', afterRelease?.scanOwner, null)
eq('释放后状态 idle', afterRelease?.recoveryState, 'idle')
eq('释放后水位保留', afterRelease?.lastScannedSeq, 150)
eq('重复释放失败', store.release(advancedC), false)
eq('释放后别人可以立刻认领', store.claim(identity, { owner: 'owner-d', scanTargetSeq: 300 })?.owner, 'owner-d')

// 11. 不 initialize 直接 claim 也能用（自动补建）
const fresh = { platform: 'dsh', sessionRef: 'session-fresh' }
const freshClaim = store.claim(fresh, { owner: 'owner-e', scanTargetSeq: 10 })
ok('未 initialize 直接认领成功', freshClaim !== null)
eq('自动补建后行存在', store.read(fresh)?.lastScannedSeq, -1)

// 12. 非法参数
eq('非 JSON 忽略统计抛 E_VALIDATION', errorCode(() => store.advance(freshClaim, {
  lastScannedSeq: 1,
  ignoredSummary: 'not-json',
})), 'E_VALIDATION')
eq('owner 为空抛 E_VALIDATION', errorCode(() => store.claim(fresh, { owner: '', scanTargetSeq: 1 })), 'E_VALIDATION')

db.close?.()

// ── 跨进程并发认领 ─────────────────────────────────────────────
{
  const childPath = fileURLToPath(new URL('./helpers/cursor-child.mjs', import.meta.url))
  const barrier = join(dir, 'cursor-barrier')
  const resultA = join(dir, 'cursor-a.json')
  const resultB = join(dir, 'cursor-b.json')

  const spawnChild = (owner, result) =>
    spawn(process.execPath, [childPath, dbFile, owner, barrier, result], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  const childA = spawnChild('owner-a', resultA)
  const childB = spawnChild('owner-b', resultB)
  const readyA = `${resultA}.ready`
  const readyB = `${resultB}.ready`

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !(existsSync(readyA) && existsSync(readyB))) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  ok('两个子进程都到达起跑线', existsSync(readyA) && existsSync(readyB))
  writeFileSync(barrier, 'go', 'utf8')

  await Promise.all([
    new Promise((resolve) => childA.on('exit', resolve)),
    new Promise((resolve) => childB.on('exit', resolve)),
  ])
  const read = (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      return { ok: false, message: String(error) }
    }
  }
  const ra = read(resultA)
  const rb = read(resultB)
  const results = [ra, rb]
  eq('并发认领恰好一个成功', results.filter((r) => r.ok === true).length, 1)
  eq('成功者拿到版本 1', results.find((r) => r.ok === true)?.cursorVersion, 1)
  eq('失败者返回 null', results.filter((r) => r.ok === false).length, 1)

  const verify = await openDatabase({ file: dbFile, driverPreference: 'auto', logger: log })
  const row = verify.db.get(
    `SELECT scan_owner, cursor_version FROM capture_cursors WHERE platform = ? AND session_ref = ?`,
    ['dsh', 'session-concurrent'],
  )
  eq('库里只有一个 owner', row.scan_owner, results.find((r) => r.ok === true)?.owner)
  eq('库里版本只加一次', Number(row.cursor_version), 1)
  verify.db.close?.()
}

rmSync(dir, { recursive: true, force: true })

console.log(`\n[P2-CAP-1c3-B] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
