/**
 * P2-CAP-1c3-C：Recovery Scanner 回归。
 *
 * 全程用真实 SQLite（Cursor 与 Sources 都要落库），只把 DSH 的 sessionPersistence
 * 换成假对象——因为 1c3-A 已经证明宿主接口形状，单测只验证扫描协议本身。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { CaptureCursorStore } from '../dist/lib/capture-cursor.js'
import { RecoveryScanner } from '../dist/lib/recovery-scanner.js'
import type { SessionEventLike } from '../dist/lib/capture-host.js'
import type { PersistenceHandleLike, PersistenceServiceLike } from '../dist/lib/sync-recovery.js'

let passed = 0
let failed = 0
function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}
function eq(label: string, actual: unknown, expected: unknown): void {
  ok(label, Object.is(actual, expected), { actual, expected })
}

function userEvent(seq: number, text: string, sourceKind = 'user'): SessionEventLike {
  return {
    type: 'user/message',
    seq,
    time: `2026-11-05T10:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    data: { id: `u${seq}`, source: { kind: sourceKind }, content: [{ type: 'text', text }] },
  }
}

function assistantEvent(seq: number, text: string): SessionEventLike {
  return {
    type: 'assistant/message',
    seq,
    time: `2026-11-05T10:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    data: {
      interrupted: false,
      message: { id: `a${seq}`, source: { kind: 'model' }, content: [{ type: 'text', text }] },
    },
  }
}

function toolEvent(seq: number): SessionEventLike {
  return { type: 'tool/call', seq, time: `2026-11-05T10:00:${String(seq % 60).padStart(2, '0')}.000Z`, data: {} }
}

function makeHandle(
  events: SessionEventLike[],
  inherited = 0,
): PersistenceHandleLike & { appended: SessionEventLike[] } {
  const appended: SessionEventLike[] = []
  return {
    appended,
    read(offset: number, length: number) {
      const all = [...events, ...appended]
      return { eventState: 'shared-frozen', events: all.slice(offset, offset + length) }
    },
    close() {},
    inheritedEventCount: inherited,
  }
}

function makeService(sessionId: string, handle: PersistenceHandleLike): PersistenceServiceLike {
  return {
    list() {
      return [{ header: { id: sessionId } }]
    },
    open(id: string) {
      return id === sessionId ? handle : null
    },
  }
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-recovery-scanner-'))
const { db } = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto' })
migrate(db)
const core = new Core({ db, config: {}, logger: {}, dataDir: dir })
const cursors = new CaptureCursorStore({ db, now: () => '2026-11-05T10:00:00.000Z', leaseMs: 60_000 })

function scannerFor(
  sessionId: string,
  handle: PersistenceHandleLike,
  overrides: Record<string, unknown> = {},
): RecoveryScanner {
  return new RecoveryScanner({
    sink: { capture: (input) => core.capture(input) },
    cursors,
    persistence: makeService(sessionId, handle),
    scope: { enabled: true },
    maxText: 8000,
    ...overrides,
  })
}

function identityOf(sessionRef: string) {
  return { platform: 'dsh-session', sessionRef } as const
}

// ── 1. 正常扫描：三条消息全部落库，水位追到 target，租约释放 ─────────────
{
  const handle = makeHandle([userEvent(0, '第一条'), assistantEvent(1, '我回一句'), userEvent(2, '第三条')])
  const scanner = scannerFor('s1', handle)
  const result = await scanner.scanSession('s1')
  eq('正常扫描 status=scanned', result.status, 'scanned')
  eq('targetSeq 取实际 maxSeq', result.targetSeq, 2)
  eq('三条都捕获', result.captured, 3)
  eq('到达终点', result.reachedTarget, true)
  const row = cursors.read(identityOf('s1'))
  eq('水位追到 2', row?.lastScannedSeq, 2)
  eq('recovery_state 回到 idle', row?.recoveryState, 'idle')
  eq('owner 已释放', row?.scanOwner, null)
  const sources = db.all(
    "SELECT capture_key, origin, kind FROM sources WHERE session_ref = 's1' ORDER BY capture_key",
  ) as Array<Record<string, unknown>>
  eq('库里三条 Source', sources.length, 3)
  eq('capture_key 用 seq', sources.map((s) => s.capture_key).join(','), '0,1,2')
  eq('assistant 记为 self', sources[1].origin, 'self')
}

// ── 2. 重扫：水位已到 target，不重复、不认领 ─────────────────────────────
{
  const handle = makeHandle([userEvent(0, '第一条'), assistantEvent(1, '我回一句'), userEvent(2, '第三条')])
  const scanner = scannerFor('s1', handle)
  const result = await scanner.scanSession('s1')
  eq('重扫不重复捕获', result.captured, 0)
  eq('重扫直接判定到达终点', result.reachedTarget, true)
}

// ── 3. 忽略事件：计数与水位同一次提交 ───────────────────────────────────
{
  const handle = makeHandle([userEvent(0, '注入的上下文', 'runtime'), toolEvent(1), userEvent(2, '真正说的话')])
  const scanner = scannerFor('s2', handle)
  const result = await scanner.scanSession('s2')
  eq('只捕获真正的话', result.captured, 1)
  eq('忽略两条', result.ignored, 2)
  const row = cursors.read(identityOf('s2'))
  eq('水位推到 2', row?.lastScannedSeq, 2)
  const summary = JSON.parse(String(row?.ignoredSummary ?? '{}')) as Record<string, Record<string, number>>
  eq('ignored_summary 按类型分组', summary.v1?.['user/message'], 1)
  eq('ignored_summary 记 tool/call', summary.v1?.['tool/call'], 1)
}

// ── 4. 捕获失败：停在失败事件前，水位保留；下次从失败处继续 ───────────────
{
  let failOnce = true
  const handle = makeHandle([userEvent(10, 'a'), userEvent(11, 'b'), userEvent(12, 'c')])
  const scanner = new RecoveryScanner({
    sink: {
      async capture(input) {
        if (failOnce && input.captureKey === '11') {
          failOnce = false
          throw new Error('模拟写库失败')
        }
        return core.capture(input)
      },
    },
    cursors,
    persistence: makeService('s3', handle),
    scope: { enabled: true },
  })
  const first = await scanner.scanSession('s3')
  eq('失败 status=failed', first.status, 'failed')
  eq('失败停在 seq=11', first.failedSeq, 11)
  const rowAfterFail = cursors.read(identityOf('s3'))
  eq('失败时水位只到 10', rowAfterFail?.lastScannedSeq, 10)
  eq('失败后租约已释放', rowAfterFail?.scanOwner, null)

  const second = await scanner.scanSession('s3')
  eq('重试成功', second.status, 'scanned')
  eq('从失败处继续，只补 11 与 12', second.captured, 2)
  eq('最终水位 12', cursors.read(identityOf('s3'))?.lastScannedSeq, 12)
}

// ── 5. 预算上限：处理两条就释放，下次接着扫 ─────────────────────────────
{
  const handle = makeHandle([userEvent(20, '1'), userEvent(21, '2'), userEvent(22, '3'), userEvent(23, '4')])
  const scanner = scannerFor('s4', handle, { maxEventsPerScan: 2, pageSize: 2 })
  const first = await scanner.scanSession('s4')
  eq('预算触发', first.budgetHit, true)
  eq('只处理两条', first.scanned, 2)
  eq('水位 21', cursors.read(identityOf('s4'))?.lastScannedSeq, 21)
  const second = await scanner.scanSession('s4')
  eq('下一轮接着处理', second.scanned, 2)
  eq('最终水位 23', cursors.read(identityOf('s4'))?.lastScannedSeq, 23)
}

// ── 6. 稀疏 seq：不假设连续，按实际 seq 升序处理 ─────────────────────────
{
  const handle = makeHandle([userEvent(30, 'x'), userEvent(33, 'y'), userEvent(37, 'z')])
  const scanner = scannerFor('s5', handle)
  const result = await scanner.scanSession('s5')
  eq('稀疏 seq 全部捕获', result.captured, 3)
  eq('水位推进到实际最大 seq', cursors.read(identityOf('s5'))?.lastScannedSeq, 37)
}

// ── 7. Fork 继承前缀：seq < inherited 不补 ───────────────────────────────
{
  const handle = makeHandle([userEvent(0, '继承 0'), userEvent(1, '继承 1'), userEvent(5, '自己的 5')], 3)
  const scanner = scannerFor('s6', handle)
  const result = await scanner.scanSession('s6')
  eq('Fork 前缀不补', result.captured, 1)
  const keys = (
    db.all("SELECT capture_key FROM sources WHERE session_ref = 's6'") as Array<Record<string, unknown>>
  ).map((row) => String(row.capture_key))
  eq('只落了 5', keys.join(','), '5')
}

// ── 8. 扫描中途出现的新事件：target 固定，不越过 ─────────────────────────
{
  const handle = makeHandle([userEvent(40, '开始'), userEvent(41, '开始 2')])
  let appended = false
  const scanner = new RecoveryScanner({
    sink: {
      async capture(input) {
        // 扫描期间出现的新事件：属于下一轮，本轮 target 仍是 41。
        if (!appended) {
          appended = true
          handle.appended.push(userEvent(42, '后来才出现'))
        }
        return core.capture(input)
      },
    },
    cursors,
    persistence: makeService('s7', handle),
    scope: { enabled: true },
    pageSize: 1,
  })
  const result = await scanner.scanSession('s7')
  eq('target 固定为快照 maxSeq', result.targetSeq, 41)
  eq('本轮只补 40/41', result.captured, 2)
  eq('不越过 target', result.reachedTarget, true)
  const after = await scanner.scanSession('s7')
  eq('下一轮才补新事件', after.captured, 1)
}

// ── 9. busy：已有活租约时返回 busy，不重复扫描 ────────────────────────────
{
  const holder = cursors.claim(identityOf('s8'), { owner: 'other-owner', scanTargetSeq: 999, leaseMs: 60_000 })
  ok('测试前置：拿到租约', holder !== null)
  const handle = makeHandle([userEvent(0, 'x')])
  const scanner = scannerFor('s8', handle)
  const result = await scanner.scanSession('s8')
  eq('被别的扫描器占着就返回 busy', result.status, 'busy')
  if (holder) cursors.release(holder)
}

// ── 10. 没有持久化服务 / 会话不在 list ───────────────────────────────────
{
  const noService = new RecoveryScanner({
    sink: { capture: (input) => core.capture(input) },
    cursors,
    persistence: null,
    scope: { enabled: true },
  })
  const unsupported = await noService.scanSession('s9')
  eq('无持久化服务 → unsupported', unsupported.status, 'unsupported')

  const handle = makeHandle([userEvent(60, 'x')])
  const scanner = scannerFor('s10', handle)
  const skipped = await scanner.scanSession('missing-session')
  eq('会话不在 list → skipped', skipped.status, 'skipped')
}

// ── 11. 空会话：没有可读事件 ─────────────────────────────────────────────
{
  const handle = makeHandle([])
  const scanner = scannerFor('s11', handle)
  const result = await scanner.scanSession('s11')
  eq('空会话 → empty', result.status, 'empty')
}

db.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n[P2-CAP-1c3-C] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
