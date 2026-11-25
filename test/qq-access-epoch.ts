// 12a：授权代次——撤销后再加回来，也要拦住上一段授权下开工的回复（模块级）。
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

function harness() {
  return new QqBridge(
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
    },
  )
}

async function main(): Promise<void> {
  const bridge = harness()
  await bridge.start()
  const b = { kind: 'private', userId: '10002' } as const

  eq('初始代次是 0', bridge.accessEpochOf(b), 0)

  bridge.applyAccess({ owner: '10001', extra: [] })
  eq('撤销后代次前进到 1', bridge.accessEpochOf(b), 1)
  eq(
    '撤销后即使带着当前代次，也进不了发送',
    (await bridge.sendOutgoingText(b, 'x', { accessEpoch: 1 })).error,
    'access-revoked',
  )

  bridge.applyAccess({ owner: '10001', extra: ['10002'] })
  eq('撤销再加回来，代次前进到 2', bridge.accessEpochOf(b), 2)
  eq(
    '旧代次的任务被丢弃（不是 access-revoked，是已被取代）',
    (await bridge.sendOutgoingText(b, 'x', { accessEpoch: 0 })).error,
    'access-superseded',
  )
  eq(
    '新代次放行（用 isActive 造一个不发送的出口，只为证明没被授权挡下）',
    (await bridge.sendOutgoingText(b, 'x', { accessEpoch: 2, isActive: () => false })).error,
    'inactive-before-send',
  )

  bridge.applyAccess({ owner: '10001', extra: ['10002'] })
  eq('重复保存同一份配置不换代次', bridge.accessEpochOf(b), 2)

  bridge.applyAccess({ owner: '10001', extra: ['10002', '10003'] })
  eq('加别的联系人不动 B 的代次', bridge.accessEpochOf(b), 2)
  eq('新加进来的联系人自己从 1 开始', bridge.accessEpochOf({ kind: 'private', userId: '10003' }), 1)

  bridge.applyAccess(null)
  eq('恢复宿主配置也按真实差异换代次（B 仍在名单里，不动）', bridge.accessEpochOf(b), 2)

  console.log(`\n[qq-access-epoch] ${passed} 通过 / ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

await main()
