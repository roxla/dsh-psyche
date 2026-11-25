// 工作区清单读取的语义锁（GPT 第 3 轮 ① 要求）。
//
// 只锁一件事：**成功读到空清单** 与 **没读到有效帧** 必须分开。
// 前者是首次安装的合法状态（调用方可以去创建），后者是读取失败（不许据此建）。
// 跑法：npm run build && node test/qq-workspace-read.ts
import { readWorkspaceBaseline } from '../dist/lib/qq-workspace-read.js'

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

const item = (id, path) => ({
  workspaceId: id,
  path,
  title: id,
  sessionIds: [],
  createdAt: '2026-11-23T00:00:00.000Z',
  updatedAt: '2026-11-23T00:00:00.000Z',
})

// follow 的假实现：按给定帧序列产出，或按行为（抛错 / 空流 / 挂起）结束。
const frames = (...list) => (signal) =>
  (async function* () {
    for (const frame of list) {
      if (signal.aborted) return
      yield frame
    }
  })()

async function run() {
  // L1：有效但为空 —— 首次安装的合法状态，必须是 [] 而不是 null。
  const empty = await readWorkspaceBaseline(frames({ type: 'baseline', value: { items: [] } }), { timeoutMs: 200 })
  ok('L1 有效空 baseline 返回空数组', Array.isArray(empty) && empty.length === 0, empty)

  // L2：有效且有内容 —— 原样返回条目。
  const one = await readWorkspaceBaseline(
    frames({ type: 'baseline', value: { items: [item('w1', 'D:\\project\\psyche\\QQ 聊天')] } }),
    { timeoutMs: 200 },
  )
  ok('L2 有效 baseline 返回条目', Array.isArray(one) && one.length === 1 && one[0].workspaceId === 'w1', one)

  // L3：宿主没有 follow 服务 —— 读不到，不是空清单。
  const missing = await readWorkspaceBaseline(undefined, { timeoutMs: 200 })
  ok('L3 没有 follow 服务返回 null', missing === null, missing)

  // L4：流在 baseline 之前就结束 —— 读不到。
  const ended = await readWorkspaceBaseline(frames(), { timeoutMs: 200 })
  ok('L4 流先结束返回 null', ended === null, ended)

  // L5：读的过程中抛错 —— 读不到，并且错误交给 onError 记日志。
  let seen = null
  const broken = await readWorkspaceBaseline(
    async function* () {
      throw new Error('follow 挂了')
    },
    {
      timeoutMs: 200,
      onError: (error) => {
        seen = String(error)
      },
    },
  )
  ok('L5 抛错返回 null 并回调 onError', broken === null && String(seen).includes('follow 挂了'), [broken, seen])

  // L6：一直不给帧 —— 超时后按读取失败处理，不挂死调用方。
  const started = Date.now()
  const stuck = await readWorkspaceBaseline(
    async function* (signal) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      if (signal.aborted) return
      yield { type: 'baseline', value: { items: [] } }
    },
    { timeoutMs: 30 },
  )
  ok('L6 超时返回 null', stuck === null, stuck)
  ok('L6b 超时在时限附近返回', Date.now() - started < 500, Date.now() - started)

  // L7：帧到了但 items 形状不对 —— 按读不到处理，不拿半个对象去比对路径。
  const malformed = await readWorkspaceBaseline(frames({ type: 'baseline', value: {} }), { timeoutMs: 200 })
  ok('L7 items 形状不对返回 null', malformed === null, malformed)

  // L8：replace 帧也算有效清单（宿主重连时先 replace 再增量）。
  const replaced = await readWorkspaceBaseline(
    frames({ type: 'replace', value: { items: [item('w2', 'D:\\x')] } }),
    { timeoutMs: 200 },
  )
  ok('L8 replace 帧也算有效清单', Array.isArray(replaced) && replaced.length === 1, replaced)

  console.log(`${passed} 通过 ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

await run()
