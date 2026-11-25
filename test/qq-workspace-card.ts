// QQ 工作区卡五态判定的单测：只喂事实，断言状态与原因。
// 这一层不碰宿主，所以可以直接把「服务缺失 / 读不到清单 / 上次失败」摆出来。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildQqWorkspaceCard,
  readWorkspaceCardWithRetry,
  type QqWorkspaceCard,
  type QqWorkspaceFacts,
} from '../dist/lib/qq-workspace-card.js'
import { sameOriginWrite } from '../dist/lib/qq-request-origin.js'

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) {
    pass += 1
    console.log(`ok   ${name}`)
  } else {
    fail += 1
    console.log(`FAIL ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
  }
}
const eq = (name: string, actual: unknown, expected: unknown) => {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}

const facts = (patch: Partial<QqWorkspaceFacts> = {}): QqWorkspaceFacts => ({
  cwd: 'D:\\project\\psyche\\QQ 聊天',
  cwdSource: 'default',
  expectedTitle: 'QQ 聊天',
  serviceAvailable: true,
  inFlight: false,
  attempt: null,
  actual: null,
  read: 'ok',
  checkedAt: '2026-11-23T20:10:00.000Z',
  ...patch,
})

// A：服务缺失 / 目录没拿到 → 不可用
eq('A1 服务缺失判不可用', buildQqWorkspaceCard(facts({ serviceAvailable: false })).state, 'unavailable')
eq('A1b 服务缺失给了原因', buildQqWorkspaceCard(facts({ serviceAvailable: false })).reason.includes('workspaceController'), true)
eq('A2 目录为空判不可用', buildQqWorkspaceCard(facts({ cwd: null })).state, 'unavailable')
eq('A2b 目录为空徽标是中文', buildQqWorkspaceCard(facts({ cwd: null })).label, '不可用')

// B：正在登记 → 待登记
eq('B1 登记中判待登记', buildQqWorkspaceCard(facts({ inFlight: true })).state, 'pending')
eq('B1b 登记中有原因', buildQqWorkspaceCard(facts({ inFlight: true })).reason, '正在登记')

// C：上次失败 → 需人工核对（且带上步骤与错误）
{
  const card = buildQqWorkspaceCard(
    facts({ attempt: { at: '2026-11-23T20:00:00.000Z', step: 'workspace/create', ok: false, error: 'invalid-path' } }),
  )
  eq('C1 上次失败判需人工核对', card.state, 'needs-review')
  eq('C1b 原因里带步骤', card.reason.includes('workspace/create'), true)
  eq('C1c 原因里带错误', card.reason.includes('invalid-path'), true)
  eq('C1d 徽标是中文', card.label, '需人工核对')
}

// D：读不到清单 → 未核实（不能当成待登记）
{
  const card = buildQqWorkspaceCard(facts({ read: 'unavailable' }))
  eq('D1 读不到清单判未核实', card.state, 'unverified')
  eq('D1b 成员数未知', card.memberCount, null)
  eq('D1c 原因说明读不到', card.reason.includes('读不到'), true)
}

// E：清单里没有 → 待登记
eq('E1 清单里没有判待登记', buildQqWorkspaceCard(facts()).state, 'pending')
eq('E1b 待登记原因提到下一条消息', buildQqWorkspaceCard(facts()).reason.includes('下一条 QQ 消息'), true)

// F：有工作区但零成员、本进程也没登记过 → 未核实
{
  const card = buildQqWorkspaceCard(
    facts({ actual: { workspaceId: 'ws-1', title: 'QQ 聊天', path: 'D:\\x', memberCount: 0, sessionIds: [] } }),
  )
  eq('F1 零成员未登记判未核实', card.state, 'unverified')
  eq('F1b 成员数是 0 不是未知', card.memberCount, 0)
}

// F2：只有工作区级回执（建工作区/改名）——那不是「这条会话已登记」的证据
{
  const card = buildQqWorkspaceCard(
    facts({
      actual: { workspaceId: 'ws-1', title: 'QQ 聊天', path: 'D:\\x', memberCount: 0, sessionIds: [] },
      attempt: { at: '2026-11-23T20:05:00.000Z', step: 'created', ok: true },
    }),
  )
  eq('F2 工作区级回执不算会话回执', card.state, 'unverified')
  eq('F2b 没有目标会话', card.targetSessionId, null)
}

// G：目标会话在成员里 → 已登记（标题一致 / 不一致各一条）
{
  const card = buildQqWorkspaceCard(
    facts({
      actual: {
        workspaceId: 'ws-1',
        title: 'QQ 聊天',
        path: 'D:\\x',
        memberCount: 1,
        sessionIds: ['qq-private-695115698'],
      },
      attempt: { at: '2026-11-23T20:05:00.000Z', step: 'session/create', ok: true, sessionId: 'qq-private-695115698' },
    }),
  )
  eq('G1 目标在成员里判已登记', card.state, 'registered')
  eq('G1b 原因说标题一致', card.reason.includes('与期望一致'), true)
  eq('G1c 原因里带目标会话 id', card.reason.includes('qq-private-695115698'), true)
  eq('G1d 工作区 id 透传', card.workspaceId, 'ws-1')
  eq('G1e 目标会话透传', card.targetSessionId, 'qq-private-695115698')
  eq('G1f 成员 id 透传', card.memberIds, ['qq-private-695115698'])
}
{
  const card = buildQqWorkspaceCard(
    facts({
      actual: { workspaceId: 'ws-2', title: 'QQ', path: 'D:\\x', memberCount: 1, sessionIds: ['qq-private-1'] },
      attempt: { at: '2026-11-23T20:05:00.000Z', step: 'attached', ok: true, sessionId: 'qq-private-1' },
    }),
  )
  eq('G2 标题不同仍是已登记', card.state, 'registered')
  eq('G2b 原因里带宿主标题', card.reason.includes('「QQ」'), true)
  eq('G2c 实际标题透传', card.actualTitle, 'QQ')
}

// G3：成员里有别的会话、缺目标会话 → 第一次有效读回仍缺：先补读，不下矛盾结论
{
  const card = buildQqWorkspaceCard(
    facts({
      actual: {
        workspaceId: 'ws-3',
        title: 'QQ 聊天',
        path: 'D:\\x',
        memberCount: 1,
        sessionIds: ['qq-private-A'],
      },
      attempt: { at: '2026-11-23T20:00:00.000Z', step: 'attached', ok: true, sessionId: 'qq-private-B' },
      readAt: '2026-11-23T20:01:00.000Z',
    }),
  )
  eq('G3 有 A 缺 B 第一次缺席判未核实', card.state, 'unverified')
  eq('G3b 原因里带缺的那条', card.reason.includes('qq-private-B'), true)
  eq('G3c 要求补读一次', card.pendingReadback, true)
  eq('G3d 成员核验记为缺席', card.memberVerify, 'missing')

  // 第二次有效读回还是缺 → 才报矛盾
  const again = buildQqWorkspaceCard(
    facts({
      actual: {
        workspaceId: 'ws-3',
        title: 'QQ 聊天',
        path: 'D:\\x',
        memberCount: 1,
        sessionIds: ['qq-private-A'],
      },
      attempt: { at: '2026-11-23T20:00:00.000Z', step: 'attached', ok: true, sessionId: 'qq-private-B' },
      readAt: '2026-11-23T20:01:30.000Z',
      priorMisses: 1,
    }),
  )
  eq('G3e 两次都缺才判需人工核对', again.state, 'needs-review')
  eq('G3f 不要求再补读', again.pendingReadback, false)
}

// G4：只能拿到成员个数（拿不到是谁）时，成员再多也不能说已登记
{
  const card = buildQqWorkspaceCard(
    facts({
      actual: { workspaceId: 'ws-4', title: 'QQ 聊天', path: 'D:\\x', memberCount: 3, sessionIds: null },
      attempt: { at: '2026-11-23T20:00:00.000Z', step: 'attached', ok: true, sessionId: 'qq-private-B' },
      readAt: '2026-11-23T20:01:00.000Z',
    }),
  )
  eq('G4 只有计数判未核实', card.state, 'unverified')
  eq('G4b 原因说明只有个数', card.reason.includes('个数'), true)
  eq('G4c 成员数仍透传', card.memberCount, 3)
}

// H：读回早于登记 → 缺不代表矛盾，先补读
{
  const card = buildQqWorkspaceCard(
    facts({
      actual: { workspaceId: 'ws-5', title: 'QQ 聊天', path: 'D:\\x', memberCount: 1, sessionIds: ['qq-private-A'] },
      attempt: { at: '2026-11-23T20:05:00.000Z', step: 'attached', ok: true, sessionId: 'qq-private-B' },
      readAt: '2026-11-23T20:04:59.000Z',
    }),
  )
  eq('H1 旧读回判未核实', card.state, 'unverified')
  eq('H1b 要求补读一次', card.pendingReadback, true)
}

// H2：登记之后的第一次有效读回仍缺 → 要求补读，不下矛盾结论
{
  const card = buildQqWorkspaceCard(
    facts({
      actual: { workspaceId: 'ws-6', title: 'QQ 聊天', path: 'D:\\x', memberCount: 1, sessionIds: ['qq-private-A'] },
      attempt: { at: '2026-11-23T20:05:00.000Z', step: 'attached', ok: true, sessionId: 'qq-private-B' },
      readAt: '2026-11-23T20:05:30.000Z',
    }),
  )
  eq('H2 登记后第一次仍缺判未核实', card.state, 'unverified')
  eq('H2b 要求补读一次', card.pendingReadback, true)
  const again = buildQqWorkspaceCard(
    facts({
      actual: { workspaceId: 'ws-6', title: 'QQ 聊天', path: 'D:\\x', memberCount: 1, sessionIds: ['qq-private-A'] },
      attempt: { at: '2026-11-23T20:05:00.000Z', step: 'attached', ok: true, sessionId: 'qq-private-B' },
      readAt: '2026-11-23T20:05:30.000Z',
      priorMisses: 1,
    }),
  )
  eq('H2c 两次仍缺判需人工核对', again.state, 'needs-review')
  eq('H2d 不要求再补读', again.pendingReadback, false)
}

// H3：登记失败且带会话 id → 仍需人工核对，并透出失败原因
{
  const card = buildQqWorkspaceCard(
    facts({
      actual: { workspaceId: 'ws-7', title: 'QQ 聊天', path: 'D:\\x', memberCount: 0, sessionIds: [] },
      attempt: { at: '2026-11-23T20:00:00.000Z', step: 'attach:attach', ok: false, error: 'cwd 不一致', sessionId: 'qq-private-B' },
    }),
  )
  eq('H3 失败仍判需人工核对', card.state, 'needs-review')
  eq('H3b 原因带真实错误', card.reason.includes('cwd 不一致'), true)
  eq('H3c 目标会话透传', card.targetSessionId, 'qq-private-B')
}

// I：目录来源如实透传
eq('I1 配置来源透传', buildQqWorkspaceCard(facts({ cwdSource: 'config' })).cwdSource, 'config')
eq('I2 未知来源透传', buildQqWorkspaceCard(facts({ cwdSource: 'unknown' })).cwdSource, 'unknown')

// K：整条补读流程（第 32/33 轮）——注入 readOnce，断言「读几次、读到什么才收口」。
const ATTEMPT = { at: '2026-11-23T20:05:00.000Z', step: 'attached', ok: true, sessionId: 'qq-private-B' }
const target = (sessionIds: string[] | null, readAt: string): QqWorkspaceCard =>
  buildQqWorkspaceCard(
    facts({
      actual: { workspaceId: 'ws-k', title: 'QQ 聊天', path: 'D:\\x', memberCount: sessionIds === null ? 2 : sessionIds.length, sessionIds },
      attempt: ATTEMPT,
      readAt,
    }),
  )

{
  // 首读缺 B、补读含 B → registered
  const reads: number[] = []
  const queue: Array<(misses: number) => QqWorkspaceCard> = [
    () => target(['qq-private-A'], '2026-11-23T20:05:10.000Z'),
    () => target(['qq-private-A', 'qq-private-B'], '2026-11-23T20:05:11.000Z'),
  ]
  const card = await readWorkspaceCardWithRetry(async (misses) => {
    reads.push(misses)
    return (queue.shift() as (misses: number) => QqWorkspaceCard)(misses)
  })
  eq('K1 补读命中判已登记', card.state, 'registered')
  eq('K2 只补读一次', reads, [0, 1])
  eq('K3 成员核验为包含', card.memberVerify, 'contains')
}

{
  // 两次有效读回都缺 B → needs-review
  const reads: number[] = []
  const queue: Array<(misses: number) => QqWorkspaceCard> = [
    () => target(['qq-private-A'], '2026-11-23T20:05:10.000Z'),
    (misses) =>
      buildQqWorkspaceCard(
        facts({
          actual: { workspaceId: 'ws-k', title: 'QQ 聊天', path: 'D:\\x', memberCount: 1, sessionIds: ['qq-private-A'] },
          attempt: ATTEMPT,
          readAt: '2026-11-23T20:05:11.000Z',
          priorMisses: misses,
        }),
      ),
  ]
  const card = await readWorkspaceCardWithRetry(async (misses) => {
    reads.push(misses)
    return (queue.shift() as (misses: number) => QqWorkspaceCard)(misses)
  })
  eq('K4 两次都缺判需人工核对', card.state, 'needs-review')
  eq('K5 第二次带上了缺席次数', reads, [0, 1])
}

{
  // 登记完成前发起的读回既不算命中也不计缺席：stale → 新读回仍缺 → 再读一次才报矛盾
  const reads: number[] = []
  const queue: Array<(misses: number) => QqWorkspaceCard> = [
    () => target(['qq-private-A'], '2026-11-23T20:04:59.000Z'),
    (misses) =>
      buildQqWorkspaceCard(
        facts({
          actual: { workspaceId: 'ws-k', title: 'QQ 聊天', path: 'D:\\x', memberCount: 1, sessionIds: ['qq-private-A'] },
          attempt: ATTEMPT,
          readAt: '2026-11-23T20:05:10.000Z',
          priorMisses: misses,
        }),
      ),
    (misses) =>
      buildQqWorkspaceCard(
        facts({
          actual: { workspaceId: 'ws-k', title: 'QQ 聊天', path: 'D:\\x', memberCount: 1, sessionIds: ['qq-private-A'] },
          attempt: ATTEMPT,
          readAt: '2026-11-23T20:05:11.000Z',
          priorMisses: misses,
        }),
      ),
  ]
  const card = await readWorkspaceCardWithRetry(async (misses) => {
    reads.push(misses)
    return (queue.shift() as (misses: number) => QqWorkspaceCard)(misses)
  })
  eq('K6 旧读回不计缺席，第二次仍缺只判未核实', reads, [0, 0, 1])
  eq('K7 第三次才判需人工核对', card.state, 'needs-review')
}

{
  // 读取期间目标 B 换成 C：A 的缺席不算到 C 头上，C 从零次缺席重新核验
  const reads: number[] = []
  const newAttempt = { at: '2026-11-23T20:06:00.000Z', step: 'attached', ok: true, sessionId: 'qq-private-C' }
  const cardOf = (attempt: typeof ATTEMPT, sessionIds: string[], readAt: string, misses: number) =>
    buildQqWorkspaceCard(
      facts({
        actual: { workspaceId: 'ws-k', title: 'QQ 聊天', path: 'D:\\x', memberCount: sessionIds.length, sessionIds },
        attempt,
        readAt,
        priorMisses: misses,
      }),
    )
  const queue: Array<(misses: number) => QqWorkspaceCard> = [
    () => target(['qq-private-A'], '2026-11-23T20:05:10.000Z'),
    () => cardOf(newAttempt, ['qq-private-A'], '2026-11-23T20:06:10.000Z', 0),
    () => cardOf(newAttempt, ['qq-private-A'], '2026-11-23T20:06:11.000Z', 0),
    (misses) => cardOf(newAttempt, ['qq-private-A'], '2026-11-23T20:06:12.000Z', misses),
  ]
  const card = await readWorkspaceCardWithRetry(async (misses) => {
    reads.push(misses)
    return (queue.shift() as (misses: number) => QqWorkspaceCard)(misses)
  })
  eq('K8 换目标后按 C 重新核验', card.targetSessionId, 'qq-private-C')
  eq('K9 C 从零次缺席重新数', reads, [0, 1, 0, 1])
  eq('K10 C 再次有效缺席才判需人工核对', card.state, 'needs-review')
}

{
  // 登记完成前发起的旧读取即使命中目标，也不能判已登记
  const stale = buildQqWorkspaceCard(
    facts({
      actual: { workspaceId: 'ws-k', title: 'QQ 聊天', path: 'D:\\x', memberCount: 1, sessionIds: ['qq-private-B'] },
      attempt: ATTEMPT,
      readAt: '2026-11-23T20:04:59.000Z',
    }),
  )
  eq('K11 旧快照命中也不算已登记', stale.state, 'unverified')
  eq('K12 旧快照命中仍要求补读', stale.pendingReadback, true)
}

{
  // attach 报错、但随后的新读取已经包含目标 → registered，并保留失败的步骤与错误
  const failedAttempt = { at: '2026-11-23T20:05:00.000Z', step: 'attach:attach', ok: false, error: 'cwd 不一致', sessionId: 'qq-private-B' }
  const card = buildQqWorkspaceCard(
    facts({
      actual: { workspaceId: 'ws-k', title: 'QQ 聊天', path: 'D:\\x', memberCount: 2, sessionIds: ['qq-private-A', 'qq-private-B'] },
      attempt: failedAttempt,
      readAt: '2026-11-23T20:05:10.000Z',
    }),
  )
  eq('K13 失败但已包含仍判已登记', card.state, 'registered')
  eq('K14 原因保留失败的步骤与错误', card.reason.includes('cwd 不一致') && card.reason.includes('attach:attach'), true)
}

{
  // 同一会话重新登记（回执换了）→ 缺席次数清零，重新数
  const reads: number[] = []
  const reAttempt = { at: '2026-11-23T20:07:00.000Z', step: 'attached', ok: true, sessionId: 'qq-private-B' }
  const cardOf = (attempt: typeof ATTEMPT, readAt: string, misses: number) =>
    buildQqWorkspaceCard(
      facts({
        actual: { workspaceId: 'ws-k', title: 'QQ 聊天', path: 'D:\\x', memberCount: 1, sessionIds: ['qq-private-A'] },
        attempt,
        readAt,
        priorMisses: misses,
      }),
    )
  const queue: Array<(misses: number) => QqWorkspaceCard> = [
    () => cardOf(ATTEMPT, '2026-11-23T20:05:10.000Z', 0),
    () => cardOf(reAttempt, '2026-11-23T20:07:05.000Z', 0),
    () => cardOf(reAttempt, '2026-11-23T20:07:06.000Z', 0),
    (misses) => cardOf(reAttempt, '2026-11-23T20:07:07.000Z', misses),
  ]
  const card = await readWorkspaceCardWithRetry(async (misses) => {
    reads.push(misses)
    return (queue.shift() as (misses: number) => QqWorkspaceCard)(misses)
  })
  eq('K15 回执换了计数清零', reads, [0, 1, 0, 1])
  eq('K16 新回执仍两次缺席才判需人工核对', card.state, 'needs-review')
}

{
  // 连续换目标 A→C→D：每轮只读一次，C 的命中或缺席都不计入 D；预算读满仍无 D 的有效证据 → 如实未核实
  const reads: number[] = []
  const attempt = (sessionId: string, at: string) => ({ at, step: 'attached', ok: true, sessionId })
  const cardOf = (target: string, at: string, readAt: string, misses: number) =>
    buildQqWorkspaceCard(
      facts({
        actual: { workspaceId: 'ws-k', title: 'QQ 聊天', path: 'D:\\x', memberCount: 1, sessionIds: ['qq-private-A'] },
        attempt: attempt(target, at),
        readAt,
        priorMisses: misses,
      }),
    )
  const queue: Array<(misses: number) => QqWorkspaceCard> = [
    () => cardOf('qq-private-B', '2026-11-23T20:05:00.000Z', '2026-11-23T20:05:10.000Z', 0),
    () => cardOf('qq-private-C', '2026-11-23T20:06:00.000Z', '2026-11-23T20:06:10.000Z', 0),
    () => cardOf('qq-private-D', '2026-11-23T20:07:00.000Z', '2026-11-23T20:07:10.000Z', 0),
    (misses) => cardOf('qq-private-D', '2026-11-23T20:07:00.000Z', '2026-11-23T20:07:11.000Z', misses),
  ]
  const card = await readWorkspaceCardWithRetry(async (misses) => {
    reads.push(misses)
    return (queue.shift() as (misses: number) => QqWorkspaceCard)(misses)
  })
  eq('K17 连续换目标也只读满预算（4 次）', reads.length, 4)
  eq('K18 C 的缺席不计入 D（D 从零次开始）', reads, [0, 1, 0, 0])
  eq('K19 预算耗尽时 D 仍是未核实', card.state, 'unverified')
  eq('K20 最终目标是 D', card.targetSessionId, 'qq-private-D')
}

{
  // 作废读数：结论不得采纳；且最终卡要按「读取结束时的当前回执」生成，不能照抄失效读数的目标
  const attemptOf = (sessionId: string, at: string, seq: number) => ({ at, step: 'attached', ok: true, sessionId, seq })
  const cardOf = (
    target: string,
    at: string,
    readAt: string,
    misses: number,
    seq = 1,
  ) =>
    buildQqWorkspaceCard(
      facts({
        actual: { workspaceId: 'ws-k', title: 'QQ 聊天', path: 'D:\\x', memberCount: 1, sessionIds: ['qq-private-A'] },
        attempt: attemptOf(target, at, seq),
        readAt,
        priorMisses: misses,
      }),
    )

  // K21–K25：读取期间回执已换成 C，第二读拿 C 算出了 needs-review —— 结论必须丢弃，按当前回执 C 生成未核实卡
  {
    const reads: number[] = []
    let current = attemptOf('qq-private-B', '2026-11-23T20:05:00.000Z', 1)
    const queue: Array<() => QqWorkspaceCard> = [
      () => cardOf('qq-private-B', '2026-11-23T20:05:00.000Z', '2026-11-23T20:05:10.000Z', 0),
      () => {
        current = attemptOf('qq-private-C', '2026-11-23T20:06:00.000Z', 2)
        // 这份读数已经拿 C 算成 needs-review（priorMisses: 1）——作废后不得采纳
        return cardOf('qq-private-C', '2026-11-23T20:06:00.000Z', '2026-11-23T20:06:10.000Z', 1, 2)
      },
    ]
    const card = await readWorkspaceCardWithRetry(
      async (misses) => {
        reads.push(misses)
        return (queue.shift() as () => QqWorkspaceCard)()
      },
      () => current,
      2,
    )
    eq('K21 作废读数只读两次就收口', reads.length, 2)
    eq('K22 作废的结论不被采纳（仍是未核实）', card.state, 'unverified')
    eq('K23 最终目标是换过去的 C', card.targetSessionId, 'qq-private-C')
    eq('K24 失效的成员核验被清空', card.memberVerify, 'unknown')
    eq('K25 失效的核验时间被清空', card.readAt, null)
  }

  // K26–K28：最后一次读回返回的仍是 B 的卡片，但当前回执已是 C —— 展示 C，不显示「B 未核实」
  {
    const reads: number[] = []
    let current = attemptOf('qq-private-B', '2026-11-23T20:05:00.000Z', 1)
    const staleB = () => cardOf('qq-private-B', '2026-11-23T20:05:00.000Z', '2026-11-23T20:05:10.000Z', 0)
    const card = await readWorkspaceCardWithRetry(
      async (misses) => {
        reads.push(misses)
        if (reads.length === 1) return staleB()
        current = attemptOf('qq-private-C', '2026-11-23T20:06:00.000Z', 2)
        return staleB() // 回执已换，但这次读回仍是 B 的快照
      },
      () => current,
      2,
    )
    eq('K26 不追加读取（恰好两次）', reads.length, 2)
    eq('K27 展示的是当前回执 C 而不是旧卡片的 B', card.targetSessionId, 'qq-private-C')
    eq('K28 回执与核验都按当前回执重置', card.attempt?.sessionId === 'qq-private-C' && card.memberVerify === 'unknown', true)
  }

  // K29–K31：访问器明确返回 null（此刻没有回执）→ 目标/回执/序号全部清空，不退回失效读数的 B
  {
    const card = await readWorkspaceCardWithRetry(
      async () => cardOf('qq-private-B', '2026-11-23T20:05:00.000Z', '2026-11-23T20:05:10.000Z', 0),
      () => null,
      2,
    )
    eq('K29 当前没有回执时目标为空', card.targetSessionId, null)
    eq('K30 当前没有回执时回执与序号都为空', card.attempt === null && card.attemptSeq === null, true)
  }

  // K31：两端「读回核验」在没有有效读回时显示「未核验」，不能把上一轮的 checkedAt 当成本次核验
  {
    const control = readFileSync(fileURLToPath(new URL('../dist/lib/qq-control-center.js', import.meta.url)), 'utf8')
    eq('K31 控制中心无有效读回时显示未核验', control.includes('未核验'), true)
  }
}

// J：写请求来源校验（GPT 第 1、2 轮第 5 条）——身份交给宿主鉴权，这里只管
// 「协议 + 主机 + 端口完整同源」以及「没有 Origin 时必须另有 CSRF 证明」。
{
  const headers = (patch: Record<string, string> = {}) => ({ host: '127.0.0.1:64955', ...patch })
  const call = (patch: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    sameOriginWrite({ headers: headers(patch), ...extra })

  ok('J1 同源 Origin 放行', call({ origin: 'http://127.0.0.1:64955' }) === true)
  ok('J2 别的站点 Origin 拒绝', call({ origin: 'https://evil.example' }) === false)
  ok('J3 cross-site fetch 拒绝', call({ 'sec-fetch-site': 'cross-site' }) === false)
  ok('J4 端口不同算不同源', call({ origin: 'http://127.0.0.1:64956' }) === false)
  ok('J5 协议不同算不同源', call({ origin: 'https://127.0.0.1:64955' }) === false)
  ok('J6 TSL 请求用 https 比对', call({ origin: 'https://127.0.0.1:64955' }, { protocol: 'https' }) === true)
  ok('J7 坏 Origin 拒绝', call({ origin: 'not-a-url' }) === false)
  // 无 Origin 时：只有浏览器给的 same-origin 事实才放行，其余失败关闭（CSRF）。
  ok('J8 无 Origin 无 Sec-Fetch 失败关闭', call() === false)
  ok('J9 无 Origin 但 same-origin 放行', call({ 'sec-fetch-site': 'same-origin' }) === true)
  ok('J10 没有 headers 也不放行', sameOriginWrite({}) === false)
}

console.log(`\n${pass} 通过 ${fail} 失败`)
process.exitCode = fail === 0 ? 0 : 1
