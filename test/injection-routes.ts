// C2-C：本轮「记忆上下文」只读回执接口。
//
// 验收口径（用户 m29573）：
// - 只按 session + turn 查 pre-step 回执，不接受 runId；
// - 只返回 completed 且 returned_count>0 且 abstained=0 的回执；
// - 条目只取 selected=1 且 composed=1 的候选，并回库复核当前 head；
// - head 已变、非 public、非 active/challenged 的条目不返回；
// - 不返回 rejectReason / rawRank / queryHash / scope 等内部字段；
// - 无回执、未完成、abstained 都 found:false，不补造数量。
//
// 跑法：node test/injection-routes.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { buildInjectionRoutes } from '../dist/lib/injection-routes.js'
import { createRecallRun, recordRecallCandidates } from '../dist/lib/recall-receipt.js'

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
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-injection-routes-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

interface FakeResponse {
  statusCode: number
  body: string
}
const makeResponse = (): FakeResponse => ({ statusCode: 0, body: '' })
const send = (response: FakeResponse, statusCode: number, body: unknown): void => {
  response.statusCode = statusCode
  response.body = JSON.stringify(body)
}
const sendJson = (response: FakeResponse, body: unknown): void => send(response, 200, body)
const bodyOf = (response: FakeResponse): any => JSON.parse(response.body || '{}')
const makeRequest = (method: string, url: string): any => ({ method, url })

const routes = buildInjectionRoutes({
  ready: Promise.resolve(),
  db: () => db,
  unavailable: () => null,
  send,
  sendJson,
  logger: log,
})
const route = routes[0]
async function call(method: string, url: string): Promise<FakeResponse> {
  const response = makeResponse()
  await route.handler(makeRequest(method, url), response as any)
  return response
}

async function source(sessionRef: string, text: string): Promise<string> {
  const captured = await core.capture({
    platform: 'dsh',
    channel: 'desktop',
    sessionRef,
    origin: 'user',
    kind: 'message',
    text,
  })
  return captured.sourceId
}

async function fact(refs: [string, string], text: string, disclosure: 'public' | 'restricted'): Promise<string> {
  const a = await source(refs[0], text)
  const b = await source(refs[1], `${text}（补充确认）`)
  const result = await core.remember({ text, kind: 'fact', statement: text, sourceIds: [a, b], disclosure })
  if (!result.artifactId) throw new Error(`fact 未升格：${JSON.stringify(result)}`)
  return result.artifactId
}

console.log('\n[C2-C] 注入回执只读接口')

const publicFact = await fact(['i-1', 'i-2'], '用户平时喜欢喝乌龙茶。', 'public')
const restrictedFact = await fact(['i-3', 'i-4'], '用户住在某个不方便公开的地址。', 'restricted')
const oldRevisionFact = await fact(['i-5', 'i-6'], '用户周末会去爬山。', 'public')
await core.revise({ artifactId: oldRevisionFact, statement: '用户周末偶尔会去徒步。', refs: [oldRevisionFact] })

function runAt(runId: string, input: { sessionRef: string; turn: number; status?: string; abstained?: boolean; returned?: number }): void {
  createRecallRun(db, {
    runId,
    requestId: null,
    personaId: 'main',
    queryHash: 'hmac-query-1',
    queryMode: 'pre-step',
    scopeType: 'personal',
    scopeHash: 'hmac-scope-1',
    requestedLimit: 6,
    matchedCount: 1,
    eligibleCount: 1,
    returnedCount: input.returned ?? 1,
    abstained: input.abstained ?? false,
    compositionStatus: (input.status ?? 'completed') as never,
    keyVersion: 1,
    createdAt: '2026-11-08T12:00:00.000Z',
    sessionRef: input.sessionRef,
    turn: input.turn,
  })
}

runAt('run-ok', { sessionRef: 'session-x', turn: 1 })
recordRecallCandidates(db, 'run-ok', [
  { artifactId: publicFact, revision: 1, rawRank: 1, eligible: true, rejectReason: null, finalRank: 1, selected: true, composed: true },
])
runAt('run-abstained', { sessionRef: 'session-x', turn: 2, abstained: true, returned: 0 })
runAt('run-pending', { sessionRef: 'session-x', turn: 3, status: 'pending' })
runAt('run-restricted', { sessionRef: 'session-x', turn: 4 })
recordRecallCandidates(db, 'run-restricted', [
  { artifactId: restrictedFact, revision: 1, rawRank: 1, eligible: true, rejectReason: null, finalRank: 1, selected: true, composed: true },
])
runAt('run-old-revision', { sessionRef: 'session-x', turn: 5 })
recordRecallCandidates(db, 'run-old-revision', [
  { artifactId: oldRevisionFact, revision: 1, rawRank: 1, eligible: true, rejectReason: null, finalRank: 1, selected: true, composed: true },
])

{
  const response = await call('GET', '/api/psyche/injection?session=session-x&turn=1')
  const body = bodyOf(response)
  eq('completed 回执返回 200', response.statusCode, 200)
  eq('found=true', body.found, true)
  eq('runId 正确', body.injection.runId, 'run-ok')
  eq('turn 正确', body.injection.turn, 1)
  eq('returnedCount 正确', body.injection.returnedCount, 1)
  eq('只返回实际注入条目', body.injection.items.length, 1)
  eq('条目字段白名单', Object.keys(body.injection.items[0]).sort(), [
    'artifactId',
    'confidence',
    'kind',
    'revision',
    'state',
    'statement',
    'statusNote',
    'supportEvidenceCount',
  ])
  eq('artifactId 正确', body.injection.items[0].artifactId, publicFact)
  eq('revision 正确', body.injection.items[0].revision, 1)
  eq('statement 正确', body.injection.items[0].statement, '用户平时喜欢喝乌龙茶。')
  eq('state 正确', body.injection.items[0].state, 'active')
  eq('active 无 statusNote', body.injection.items[0].statusNote, null)
  ok('响应不含 rejectReason', !response.body.includes('rejectReason'))
  ok('响应不含 rawRank', !response.body.includes('rawRank'))
  ok('响应不含 queryHash', !response.body.includes('hmac-query-1'))
  ok('响应不含受限正文', !response.body.includes('不方便公开'))
}

{
  const response = await call('GET', '/api/psyche/injection?session=session-x&turn=2')
  eq('abstained 回执 found=false', bodyOf(response).found, false)
}
{
  const response = await call('GET', '/api/psyche/injection?session=session-x&turn=3')
  eq('pending 回执 found=false', bodyOf(response).found, false)
}
{
  const response = await call('GET', '/api/psyche/injection?session=session-x&turn=4')
  eq('受限 head 不返回', bodyOf(response).found, false)
}
{
  const response = await call('GET', '/api/psyche/injection?session=session-x&turn=5')
  eq('旧 revision 不返回', bodyOf(response).found, false)
}
{
  const response = await call('GET', '/api/psyche/injection?session=session-y&turn=1')
  eq('别的会话不串', bodyOf(response).found, false)
}
{
  const response = await call('GET', '/api/psyche/injection?session=session-x&turn=99')
  eq('无回执 found=false', bodyOf(response).found, false)
}
{
  const response = await call('GET', '/api/psyche/injection?session=session-x')
  eq('缺 turn 返回 400', response.statusCode, 400)
}
{
  const response = await call('GET', '/api/psyche/injection?turn=1')
  eq('缺 session 返回 400', response.statusCode, 400)
}
{
  const response = await call('POST', '/api/psyche/injection?session=session-x&turn=1')
  eq('POST 返回 405', response.statusCode, 405)
}
{
  const response = await call('GET', '/api/psyche/injection?session=session-x&turn=1&runId=run-pending')
  eq('忽略额外 runId 参数（仍按 turn 1）', bodyOf(response).injection?.runId, 'run-ok')
}

db.close?.()
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  // Windows 句柄释放慢，清理失败不影响结论。
}

console.log(`\n[C2-C] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
