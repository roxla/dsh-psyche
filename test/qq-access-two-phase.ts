// 迁移 37：两阶段提交在桥接这一层的四个故障点（模块级，不依赖真实 QQ）。
//
// 外部评审第 41 轮把故障点划定成四行，这里一行一条。重点是第 2 行：
// 「覆盖文件已写、commit 失败、进程还活着」——只靠重启时读 pending 覆盖不到这个窗口。
import { QqBridge } from '../dist/lib/qq-bridge.js'

let passed = 0
let failed = 0
function eq(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label} ${JSON.stringify({ actual, expected })}`)
  }
}

class QuietSocket {
  addEventListener(): void {}
  send(): void {}
  close(): void {}
}

interface Faults {
  beginThrows?: boolean
  commitThrows?: boolean
  loadPendingThrows?: boolean
  initialPending?: Map<string, number>
}

function harness(faults: Faults = {}) {
  const epochs = new Map<string, number>()
  const pending = new Map<string, number>(faults.initialPending ?? [])
  const calls = { begin: 0, commit: 0 }
  const bridge = new QqBridge(
    {
      enabled: true,
      wsUrl: 'ws://127.0.0.1:1',
      accessToken: '',
      provider: 'probe',
      model: 'probe',
      allowFrom: { owner: '10001', extra: ['10002'] },
    },
    {
      host: {
        agents: {
          get: () => undefined,
          resume: async () => {
            throw new Error('session not found: qq-private-10001')
          },
          create: async () => ({ agent: { followup() {} } }),
        },
        on: () => () => {},
      },
      adapter: { announce() {}, forget() {}, size: () => 0 },
      logger: { info() {}, error() {}, warn() {} },
      webSocket: QuietSocket as never,
      allowLegacyAgentCreate: true,
      isSessionBound: () => true,
      accessEpochStore: {
        load: () => epochs,
        save: (next) => {
          for (const [k, v] of next) epochs.set(k, v)
        },
        begin: (targets) => {
          calls.begin += 1
          if (faults.beginThrows === true) throw new Error('begin failed')
          for (const [k, v] of targets) pending.set(k, v)
        },
        commit: (next) => {
          calls.commit += 1
          if (faults.commitThrows === true) throw new Error('commit failed')
          for (const [k, v] of next) epochs.set(k, v)
          for (const k of next.keys()) pending.delete(k)
        },
        loadPending: () => {
          if (faults.loadPendingThrows === true) throw new Error('loadPending failed')
          return new Map(pending)
        },
      },
    },
  )
  return { bridge, epochs, pending, calls }
}

async function main(): Promise<void> {
  const b = { kind: 'private', userId: '10002' } as const

  // 故障点 1：begin 失败 → 内存名单不变、代次不变、抛错。
  {
    const { bridge } = harness({ beginThrows: true })
    await bridge.start()
    let threw = false
    try {
      bridge.applyAccess({ owner: '10001', extra: [] })
    } catch {
      threw = true
    }
    eq('F1 begin 失败要抛错', threw, true)
    eq('F1 代次没动', bridge.accessEpochOf(b), 0)
    eq(
      'F1 名单也没动（10002 仍可发）',
      (await bridge.sendOutgoingText(b, 'x', { accessEpoch: 0, isActive: () => false })).error,
      'inactive-before-send',
    )
    await bridge.stop()
  }

  // 故障点 2：begin 成功、commit 失败 → 当前进程立即暂停，不等重启。
  {
    const { bridge, calls } = harness({ commitThrows: true })
    await bridge.start()
    bridge.applyAccess({ owner: '10001', extra: [] })
    eq('F2 begin/commit 各调用一次', calls, { begin: 1, commit: 1 })
    eq(
      'F2 commit 失败后这个 peer 立刻被暂停（不是等到重启）',
      (await bridge.sendOutgoingText(b, 'x', { accessEpoch: 1 })).error,
      'access-pending',
    )
    await bridge.stop()
  }

  // 故障点 3：重启时读 pending 失败 → 保守地全部暂停。
  {
    const { bridge } = harness({ loadPendingThrows: true })
    await bridge.start()
    eq(
      'F3 读不出未完成变更时，已授权对象一律暂停',
      (await bridge.sendOutgoingText(b, 'x', { accessEpoch: 0 })).error,
      'access-pending',
    )
    await bridge.stop()
  }

  // 故障点 4：commit 成功 → 暂停解除、新代次可发、pending 清空。
  {
    const { bridge, pending, epochs } = harness()
    await bridge.start()
    bridge.applyAccess({ owner: '10001', extra: [] })
    bridge.applyAccess({ owner: '10001', extra: ['10002'] })
    eq('F4 pending 已清空', pending.size, 0)
    eq('F4 代次落库为 2', epochs.get('private:10002'), 2)
    eq(
      'F4 新代次可发（未被 pending 拦）',
      (await bridge.sendOutgoingText(b, 'x', { accessEpoch: 2, isActive: () => false })).error,
      'inactive-before-send',
    )
    await bridge.stop()
  }

  // 恢复入口：名单内容没变，但上一次变更没走完——必须重新校验、强制换代、清 pending。
  {
    const target = new Map([['private:10002', 1]])
    const { bridge, pending, epochs } = harness({ initialPending: target })
    await bridge.start()
    // 启动时读到 pending，这个对象应该处于暂停态。
    eq(
      'F5 启动读到 pending 时先暂停',
      (await bridge.sendOutgoingText(b, 'x', { accessEpoch: 0 })).error,
      'access-pending',
    )
    const result = bridge.reapplyAccess()
    eq('F5 恢复报告成功', result.ok, true)
    eq('F5 恢复的是那个 peer', result.peers, ['private:10002'])
    eq('F5 pending 已清空', pending.size, 0)
    // 新代次必须同时大于「已提交值（0）」和「当初打算涨到的值（1）」。
    eq('F5 新代次严格大于两者的较大值', epochs.get('private:10002'), 2)
    eq(
      'F5 恢复后这个 peer 不再被暂停',
      (await bridge.sendOutgoingText(b, 'x', { accessEpoch: 2, isActive: () => false })).error,
      'inactive-before-send',
    )
    await bridge.stop()
  }

  console.log(`\n[qq-access-two-phase] ${passed} 通过 / ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

await main()
