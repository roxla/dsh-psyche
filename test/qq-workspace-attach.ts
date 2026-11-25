// 历史 QQ 会话补挂工作区的语义锁（GPT 第 4 轮「改」的要求）。
//
// 只锁三件事：
// 1. 唯一能补挂**账外**会话的是 `Workspace.attachSession`；
// 2. `insertSessionBefore` 不能被当成补挂失败后的兜底（它只做已登记会话的排序）；
// 3. 补挂成功但排序失败，仍然算挂上了（归属 != 顺序）。
// 跑法：npm run build && node test/qq-workspace-attach.ts
import { attachQqSessionToWorkspace } from '../dist/lib/qq-workspace-attach.js'

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

const CWD = 'D:\\project\\psyche\\QQ 聊天'

/** 记录调用次数的最小假件。 */
const spy = () => {
  const calls = []
  const fn = async (arg) => {
    calls.push(arg)
  }
  fn.calls = calls
  return fn
}

async function run() {
  // W1：工作区还没建出来 —— 直接记 workspace 阶段，不去解析工作区。
  {
    const resolve = spy()
    const result = await attachQqSessionToWorkspace({
      workspaceId: null,
      sessionId: 'qq-private-1',
      cwd: CWD,
      resolveWorkspace: resolve,
    })
    ok('W1 没有工作区时记 workspace 阶段', result.status === 'failed' && result.stage === 'workspace', result)
    ok('W1 不去解析工作区', resolve.calls.length === 0, resolve.calls.length)
  }

  // W2：拿不到注册表 —— 不能假装成功。
  {
    const result = await attachQqSessionToWorkspace({
      workspaceId: 'ws1',
      sessionId: 'qq-private-1',
      cwd: CWD,
    })
    ok('W2 没有 registry 时报 registry 阶段', result.status === 'failed' && result.stage === 'registry', result)
  }

  // W3：解析抛错 —— 记原因，不吞。
  {
    const result = await attachQqSessionToWorkspace({
      workspaceId: 'ws1',
      sessionId: 'qq-private-1',
      cwd: CWD,
      resolveWorkspace: async () => {
        throw new Error('registry exploded')
      },
    })
    ok(
      'W3 解析失败带原错误文本',
      result.status === 'failed' && result.stage === 'registry' && result.error.includes('registry exploded'),
      result,
    )
  }

  // W4：路径解析不出来（宿主里没有这个路径的工作区）。
  {
    const result = await attachQqSessionToWorkspace({
      workspaceId: 'ws1',
      sessionId: 'qq-private-1',
      cwd: CWD,
      resolveWorkspace: async () => undefined,
    })
    ok(
      'W4 找不到工作区时报 registry 阶段',
      result.status === 'failed' && result.stage === 'registry' && result.error.includes(CWD),
      result,
    )
  }

  // W5：实体缺 attachSession —— 这是宿主版本不支持补挂，必须报出来。
  {
    const result = await attachQqSessionToWorkspace({
      workspaceId: 'ws1',
      sessionId: 'qq-private-1',
      cwd: CWD,
      resolveWorkspace: async () => ({ path: CWD }),
    })
    ok(
      'W5 实体没有 attachSession 时报 attach 阶段',
      result.status === 'failed' && result.stage === 'attach',
      result,
    )
  }

  // W6：attach 失败（header cwd 与工作区路径不符等）—— 不许退到 insertSessionBefore。
  {
    const order = spy()
    const result = await attachQqSessionToWorkspace({
      workspaceId: 'ws1',
      sessionId: 'qq-private-1',
      cwd: CWD,
      resolveWorkspace: async () => ({
        path: CWD,
        attachSession: async () => {
          throw new Error('its cwd resolves to D:\\elsewhere')
        },
      }),
      insertSessionBefore: order,
    })
    ok(
      'W6 attach 失败要如实报出来',
      result.status === 'failed' && result.stage === 'attach' && result.error.includes('resolves to'),
      result,
    )
    ok('W6 attach 失败时不再调 insertSessionBefore', order.calls.length === 0, order.calls.length)
  }

  // W7：attach 成功、没有排序接口 —— 归属已成立。
  {
    const attach = spy()
    const result = await attachQqSessionToWorkspace({
      workspaceId: 'ws1',
      sessionId: 'qq-private-9',
      cwd: CWD,
      resolveWorkspace: async () => ({ path: CWD, attachSession: attach }),
    })
    ok('W7 attach 成功即算挂上', result.status === 'attached', result)
    ok('W7 没有排序接口时 ordered=false', result.status === 'attached' && result.ordered === false, result)
    ok('W7 attach 收到正确的会话 id', attach.calls[0] === 'qq-private-9', attach.calls)
  }

  // W8：attach + 排序都成功。
  {
    const order = spy()
    const result = await attachQqSessionToWorkspace({
      workspaceId: 'ws1',
      sessionId: 'qq-private-9',
      cwd: CWD,
      resolveWorkspace: async () => ({ path: CWD, attachSession: async () => {} }),
      insertSessionBefore: order,
    })
    ok('W8 attach + 排序都成功时 ordered=true', result.status === 'attached' && result.ordered === true, result)
    ok(
      'W8 排序请求带对了 workspaceId 与会话 id',
      order.calls.length === 1 && order.calls[0].workspaceId === 'ws1' && order.calls[0].sessionId === 'qq-private-9',
      order.calls,
    )
  }

  // W9：attach 成功但排序失败 —— 归属 != 顺序，仍然是挂上了。
  {
    const result = await attachQqSessionToWorkspace({
      workspaceId: 'ws1',
      sessionId: 'qq-private-9',
      cwd: CWD,
      resolveWorkspace: async () => ({ path: CWD, attachSession: async () => {} }),
      insertSessionBefore: async () => {
        throw new Error('the session is not accounted')
      },
    })
    ok('W9 排序失败不影响归属', result.status === 'attached', result)
    ok('W9 排序失败时 ordered=false', result.status === 'attached' && result.ordered === false, result)
  }

  // W10：幂等 —— 已登记会话再挂一次是空操作，不该变成失败。
  {
    let attached = new Set()
    const result1 = await attachQqSessionToWorkspace({
      workspaceId: 'ws1',
      sessionId: 'qq-private-9',
      cwd: CWD,
      resolveWorkspace: async () => ({
        path: CWD,
        attachSession: async (id) => {
          attached.add(id)
        },
      }),
    })
    const result2 = await attachQqSessionToWorkspace({
      workspaceId: 'ws1',
      sessionId: 'qq-private-9',
      cwd: CWD,
      resolveWorkspace: async () => ({
        path: CWD,
        attachSession: async (id) => {
          attached.add(id)
        },
      }),
    })
    ok('W10 连挂两次都成功', result1.status === 'attached' && result2.status === 'attached', [result1, result2])
    ok('W10 成员集合只有一条', attached.size === 1, [...attached])
  }

  console.log(`${passed} 通过 ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

await run()
