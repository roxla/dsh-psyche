// P4-A-2：QQ 全新会话的「宿主正式创建路径」（模块级）。
//
// 覆盖冻结稿第 48–50 轮定的四分支里，能脱离真宿主验证的三条：
// 1. 会话不存在时走 `createSessionThroughControllers`（workspace/create + session/create），
//    不再调 `agents.create`；返回的 id 与请求一致才投递；覆盖层模型补写到新会话上。
// 2. 新建报错但会话其实已经落地（live agent 已存在）→ 接着投递，不重复创建。
// 3. 新建报错且核对不到会话 → 停下报错，**不回退** `agents.create`，也绝不投递。
// 另外验一条：宿主返回了别的 id → 停下报错（投进去等于把消息发到别的会话）。
//
// 跑法：npm run build && node test/qq-create-path.ts
import { QqBridge, looksLikeMissingSession } from '../dist/lib/qq-bridge.js'

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
const flush = async () => {
  await sleep(0)
  await sleep(0)
}

class FakeSocket {
  constructor(url) {
    FakeSocket.last = this
    this.url = url
    this.listeners = new Map()
    this.sent = []
    this.replies = 0
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }
  send(data) {
    const parsed = JSON.parse(data)
    this.sent.push(parsed)
    const echo = parsed.echo
    queueMicrotask(() => {
      this.replies += 1
      this.emit({ status: 'ok', retcode: 0, data: { message_id: `reply-${this.replies}` }, echo })
    })
  }
  close() {}
  emit(event) {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(event) })
  }
  actions() {
    return this.sent.map((item) => item.action)
  }
}

/**
 * 造一套假宿主：
 * - `get` 只认 `live` 表里的会话；
 * - `resume` 一律按「会话不存在」失败（looksLikeMissingSession 的文案）；
 * - `create` 一旦被调用就记下来并抛错——这条路径在生产里不该再被走到。
 */
function makeContext({ createSession, withoutControllers = false, allowLegacyCreate = false } = {}) {
  const calls = { get: 0, resume: 0, create: 0, createSession: 0, followup: 0, select: 0 }
  const logs = []
  const selects = []
  const live = new Map()

  const makeAgent = (sessionId) => ({
    followup() {
      calls.followup += 1
    },
    model: {
      current: () => undefined,
      select(selection) {
        calls.select += 1
        selects.push({ sessionId, ...selection })
      },
    },
  })

  const host = {
    agents: {
      get(sessionId) {
        calls.get += 1
        return live.get(sessionId)
      },
      async resume() {
        calls.resume += 1
        throw new Error('session not found: no such session')
      },
      async create() {
        calls.create += 1
        throw new Error('agents.create 不应该再被调用')
      },
    },
    on() {
      return () => {}
    },
  }

  const createSessionImpl =
    createSession ??
    (async (sessionId) => {
      live.set(sessionId, makeAgent(sessionId))
      return sessionId
    })

  const adapter = {
    announce() {},
    forget() {},
    size() {
      return 0
    },
  }
  const logger = {
    info(message, detail) {
      logs.push({ level: 'info', message, detail })
    },
    warn(message, detail) {
      logs.push({ level: 'warn', message, detail })
    },
    error(message, detail) {
      logs.push({ level: 'error', message, detail })
    },
  }
  const config = {
    enabled: true,
    wsUrl: 'ws://127.0.0.1:1',
    accessToken: '',
    provider: 'test-provider',
    model: 'test-model',
    allowFrom: { owner: '10001', extra: [] },
    unknownPolicy: 'reject',
    rejectCooldownMs: 24 * 60 * 60_000,
    rejectGlobalLimit: 20,
    rejectGlobalWindowMs: 60 * 60_000,
    sendTimeoutMs: 5_000,
  }
  const bridge = new QqBridge(config, {
    host,
    adapter,
    logger,
    webSocket: FakeSocket,
    isSessionBound: () => true,
    // GPT 第 1 轮第 1 条：旧版 agents.create 是测试/一次性脚本专用入口，
    // 必须显式打开；不打开时生产路径会拒绝建会话，而不是悄悄回退。
    ...(allowLegacyCreate ? { allowLegacyAgentCreate: true } : {}),
    ...(withoutControllers
      ? {}
      : {
          createSessionThroughControllers: async (sessionId) => {
            calls.createSession += 1
            return await createSessionImpl(sessionId)
          },
        }),
  })
  bridge.start()
  return { bridge, calls, logs, selects, live, socket: FakeSocket.last, makeAgent }
}

function privateEvent(userId) {
  seq += 1
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: '99999',
    user_id: String(userId),
    message_id: `m-${seq}`,
    raw_message: '你好',
    sender: { user_id: String(userId) },
  }
}
let seq = 0

const ERROR_REPLY = '这边暂时没能接上，稍后再发一次试试。'
const hasErrorLog = (logs, needle) =>
  logs.some(
    (item) =>
      item.level === 'error' &&
      (item.message.includes(needle) || JSON.stringify(item.detail ?? {}).includes(needle)),
  )

// ── A. 全新会话：走两个 controller，不碰 agents.create ─────────────────────
{
  const ctx = makeContext()
  ctx.socket.emit(privateEvent('10001'))
  await flush()
  eq('A1 新建会话走 createSessionThroughControllers 一次', ctx.calls.createSession, 1)
  eq('A2 不再调用 agents.create', ctx.calls.create, 0)
  eq('A3 消息投递一次', ctx.calls.followup, 1)
  eq('A4 覆盖层模型补写到新会话', ctx.selects, [
    { sessionId: 'qq-private-10001', provider: 'test-provider', model: 'test-model' },
  ])
  // A5：会话已经活在 live 表里，第二条消息直接命中 get，不重复创建。
  ctx.socket.emit(privateEvent('10001'))
  await flush()
  eq('A5 后续消息复用同一会话', [ctx.calls.createSession, ctx.calls.followup], [1, 2])
  await ctx.bridge.stop()
}

// ── B. 新建报错但会话已落地：接着投递 ─────────────────────────────────────
{
  const ctx = makeContext({
    createSession: async (sessionId) => {
      // 宿主先建好了会话，响应在回程丢了：桥接拿到的是错误而不是 agent。
      ctx.live.set(sessionId, ctx.makeAgent(sessionId))
      throw new Error('rpc timeout')
    },
  })
  ctx.socket.emit(privateEvent('10001'))
  await flush()
  eq('B1 核对到已建会话后继续投递', ctx.calls.followup, 1)
  eq('B2 不重复创建、不回退 agents.create', [ctx.calls.createSession, ctx.calls.create], [1, 0])
  ok(
    'B3 只记一条「已存在」告警，不记人工核对错误',
    ctx.logs.some((item) => item.level === 'warn' && item.message.includes('会话已经存在')) &&
      !hasErrorLog(ctx.logs, '需要人工核对'),
    ctx.logs,
  )
  await ctx.bridge.stop()
}

// ── C. 新建报错且核对不到：停下，不投递，不回退 ──────────────────────────
{
  const ctx = makeContext({
    createSession: async () => {
      throw new Error('workspace/create failed')
    },
  })
  ctx.socket.emit(privateEvent('10001'))
  await flush()
  eq('C1 不投递', ctx.calls.followup, 0)
  eq('C2 不回退 agents.create', ctx.calls.create, 0)
  ok('C3 记人工核对错误', hasErrorLog(ctx.logs, '需要人工核对'), ctx.logs)
  ok('C4 记投递失败', hasErrorLog(ctx.logs, '投递失败'), ctx.logs)
  eq('C5 给用户一条固定兜底文案', ctx.socket.actions(), ['send_private_msg'])
  ok(
    'C6 兜底文案内容固定',
    JSON.stringify(ctx.socket.sent[0].params.message).includes(ERROR_REPLY),
    ctx.socket.sent[0],
  )
  await ctx.bridge.stop()
}

// ── D. 宿主返回了别的 id：停下，不投递到别的会话 ─────────────────────────
{
  const ctx = makeContext({
    createSession: async (requested) => {
      // `session/create` 只复用「没开始过回合」的命名空会话；否则另铸一个 id。
      const minted = `${requested}-2`
      ctx.live.set(minted, ctx.makeAgent(minted))
      return minted
    },
  })
  ctx.socket.emit(privateEvent('10001'))
  await flush()
  eq('D1 不投递', ctx.calls.followup, 0)
  eq('D2 不写模型选择到别的会话', ctx.calls.select, 0)
  ok('D3 报「没有按指定 id 建会话」', hasErrorLog(ctx.logs, '没有按指定 id 建会话'), ctx.logs)
  await ctx.bridge.stop()
}

// ── E. 没有 controller 注入：生产路径拒绝建会话，不回退 agents.create ─────
{
  const ctx = makeContext({ withoutControllers: true })
  ctx.socket.emit(privateEvent('10001'))
  await flush()
  eq('E1 不回退 agents.create', ctx.calls.create, 0)
  eq('E2 不投递', ctx.calls.followup, 0)
  ok('E3 明确指出缺少 controller 注入', hasErrorLog(ctx.logs, '不在宿主账目内创建会话'), ctx.logs)
  await ctx.bridge.stop()
}

// ── F. 错误归类：结构化 code 优先，宽泛文本不再算「会话不存在」 ──────────
{
  ok('F1 code=session/not-found 命中', looksLikeMissingSession({ code: 'session/not-found' }) === true)
  ok(
    'F2 details.code=SESSION_QUERY_SESSION_NOT_FOUND 命中',
    looksLikeMissingSession({ details: { code: 'SESSION_QUERY_SESSION_NOT_FOUND' } }) === true,
  )
  ok(
    'F3 「session … not found」文本兜底命中',
    looksLikeMissingSession(new Error('resume failed for session "qq-private-1": session not found')) === true,
  )
  ok('F4 裸 not found 不命中', looksLikeMissingSession(new Error('workspace not found')) === false)
  ok(
    'F5 ENOENT 不命中',
    looksLikeMissingSession(new Error('ENOENT: no such file or directory')) === false,
  )
  ok(
    'F6 有 code 时不信文本',
    looksLikeMissingSession({ code: 'session/writer-held', message: 'session not found' }) === false,
  )
}

console.log(`\nqq-create-path: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
