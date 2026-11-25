// ReminderTicker：定时器只负责「何时扫」，不碰 Core（第 52 轮外部评审的分层）。
import { ReminderTicker } from '../dist/lib/reminder-ticker.js'

let passed = 0
let failed = 0
function ok(label: string, good: boolean, detail?: unknown) {
  if (good) { passed += 1; console.log('  ok ' + label) }
  else { failed += 1; console.error('  FAIL ' + label, detail) }
}

// 可控定时器：把待执行的回调攒起来，由测试手动触发。
type Pending = { fn: () => void }
const pending: Pending[] = []
const fakeSetTimeout = (fn: () => void): unknown => {
  const entry: Pending = { fn }
  pending.push(entry)
  return entry
}
const fakeClearTimeout = (handle: unknown): void => {
  const i = pending.findIndex((entry) => entry === handle)
  if (i >= 0) pending.splice(i, 1)
}

async function main() {
  // T1 start 立刻扫一次
  {
    let calls = 0
    const ticker = new ReminderTicker({
      tick: async () => { calls += 1; return 1 },
      intervalMs: 1000,
      setTimeoutImpl: fakeSetTimeout,
      clearTimeoutImpl: fakeClearTimeout,
    })
    ok('未启用时 running 为 false', ticker.running === false)
    ticker.start()
    ok('start() 后立刻为 running', ticker.running === true)
    await Promise.resolve()
    await new Promise((r) => setImmediate(r))
    ok('start() 立刻扫了一次', calls === 1, calls)
    ok('扫完排了一次下一次', pending.length === 1, pending.length)

    // T2 递归：触发待执行的定时器会再扫一次并再排一次
    const first = pending[0]
    pending.length = 0
    first.fn()
    await new Promise((r) => setImmediate(r))
    ok('定时器触发后再扫一次', calls === 2, calls)
    ok('并且又排了一次', pending.length === 1, pending.length)

    // T3 stop 清掉待执行的定时器
    ticker.stop()
    ok('stop() 后 running 为 false', ticker.running === false)
    ok('stop() 清掉了待执行的定时器', pending.length === 0, pending.length)
    const callsAfterStop = calls
    await new Promise((r) => setImmediate(r))
    ok('stop() 后不再扫', calls === callsAfterStop, calls)
  }

  // T4 在途 tick 结束时若已 stop，不再排下一次
  {
    let release: (() => void) | null = null
    let calls = 0
    const ticker = new ReminderTicker({
      tick: async () => {
        calls += 1
        await new Promise<void>((resolve) => { release = resolve })
        return 0
      },
      intervalMs: 1000,
      setTimeoutImpl: fakeSetTimeout,
      clearTimeoutImpl: fakeClearTimeout,
    })
    const running = ticker.runOnce()
    await new Promise((r) => setImmediate(r))
    ticker.stop()
    release?.()
    await running
    ok('停止期间正在跑的那一轮照常结束', calls === 1, calls)
    ok('结束后没有排下一次', pending.length === 0, pending.length)
  }

  // T5 tick 抛错不终止循环
  {
    let calls = 0
    const errors: unknown[] = []
    const ticker = new ReminderTicker({
      tick: async () => { calls += 1; throw new Error('boom') },
      intervalMs: 1000,
      onError: (e) => errors.push(e),
      setTimeoutImpl: fakeSetTimeout,
      clearTimeoutImpl: fakeClearTimeout,
    })
    ticker.start()
    await new Promise((r) => setImmediate(r))
    ok('抛错被 onError 收到', errors.length === 1, errors.length)
    ok('抛错后仍排了下一次', pending.length === 1, pending.length)
    ticker.stop()
  }

  // T6 手动 runOnce 不依赖 start
  {
    let calls = 0
    const ticker = new ReminderTicker({
      tick: async () => { calls += 1; return 3 },
      intervalMs: 1000,
      setTimeoutImpl: fakeSetTimeout,
      clearTimeoutImpl: fakeClearTimeout,
    })
    const handled = await ticker.runOnce()
    ok('runOnce 返回值来自 tick()', handled === 3, handled)
    ok('未 start 时 runOnce 不排定时器', pending.length === 0, pending.length)
    ok('runOnce 调用了一次 tick', calls === 1, calls)
  }

  console.log(`[reminder-ticker] ${passed} 通过 ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

await main()
