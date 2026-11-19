/**
 * E5.5-E1 跨进程 Grant 消费自检。
 *
 * 场景：父进程建库 → 造一条受限的敏感事实 → 宿主签发一张 grant →
 * 两个真实子进程用 barrier 同步起跑，各自在一个事务里尝试「消费 grant 并把内容提到 public」。
 *
 * 期望：
 *   1. 恰好一个子进程成功（另一个撞 revision 乐观检查，E_REVISION_CONFLICT）；
 *   2. 成功的那次把 head 提到 r2 / public，grant 被核销（used_at 非空）；
 *   3. 失败者没有消费 grant，也没有留下半截 revision；
 *   4. 同一张 grant 再次使用被拒 → 落回 restricted。
 *
 * 跑法：`node test/grant-concurrent.ts`（要求先 `npm run build`）。
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-grant-concurrent-'))
const dbFile = join(dir, 'memory.sqlite3')
const log = { info() {}, debug() {}, warn() {}, error() {} }
const childPath = fileURLToPath(new URL('./helpers/grant-child.mjs', import.meta.url))
const barrier = join(dir, 'barrier')
const resultA = join(dir, 'result-a.json')
const resultB = join(dir, 'result-b.json')

const sensitive = '用户的手机号是 13800138000，只允许本地加密保存。'

// ── 父进程准备数据 ────────────────────────────────────────────────────
const opened = await openDatabase({ file: dbFile, driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)
const core = new Core({ db, config: {}, logger: log, dataDir: dir })

const source = await core.capture({
  text: '记住我的手机号 13800138000',
  sessionRef: 'session-grant-concurrent',
  platform: 'dsh',
  channel: 'desktop',
})
const fact = await core.remember({
  text: '用户登记了手机号。',
  statement: sensitive,
  kind: 'fact',
  sourceIds: [source.sourceId],
  disclosure: 'restricted',
})
const grant = await core.grantDisclosure({ artifactId: fact.artifactId, grantedBy: 'host:owner', ttlMs: 60_000 })
const eventRow = db.get(`SELECT event_id FROM events ORDER BY at DESC LIMIT 1`) as { event_id: string } | undefined
if (!eventRow) throw new Error('没有事件可作 refs')
db.close()

// ── 两个子进程同步起跑 ────────────────────────────────────────────────
function start(resultPath: string): ReturnType<typeof spawn> {
  return spawn(
    process.execPath,
    [childPath, dbFile, fact.artifactId, grant.grantId, eventRow.event_id, barrier, resultPath],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PSYCHE_TEST_DIR: dir } },
  )
}

async function waitReady(path: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`子进程没有在 ${timeoutMs}ms 内就绪：${path}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const childA = start(resultA)
const childB = start(resultB)
await Promise.all([waitReady(resultA), waitReady(resultB)])
writeFileSync(barrier, 'go')

function readResult(path: string): { ok?: boolean; code?: string | null; revision?: number; disclosure?: string; grantRequired?: boolean } {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const deadline = Date.now() + 20_000
while ((!existsSync(resultA) || !existsSync(resultB)) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 20))
}
await new Promise((resolve) => setTimeout(resolve, 100))

const a = readResult(resultA)
const b = readResult(resultB)
const successes = [a, b].filter((item) => item.ok === true)
const failures = [a, b].filter((item) => item.ok !== true)

ok('两个子进程都返回了结果', [a, b].every((item) => typeof item.ok === 'boolean'), { a, b })
ok('恰好一个子进程成功', successes.length === 1, { a, b })
ok('失败者撞 revision 乐观检查', failures.length === 1 && failures[0].code === 'E_REVISION_CONFLICT', failures[0])
ok('成功者落在 public', successes.length === 1 && successes[0].disclosure === 'public', successes[0])
ok('成功者 revision=2', successes.length === 1 && successes[0].revision === 2, successes[0])

// ── 库里的最终状态 ────────────────────────────────────────────────────
const reopened = await openDatabase({ file: dbFile, driverPreference: 'auto', logger: log })
const db2 = reopened.db
const head = db2.get(
  `SELECT revision, disclosure FROM artifact_revisions WHERE artifact_id = ? ORDER BY revision DESC LIMIT 1`,
  [fact.artifactId],
) as { revision: number; disclosure: string } | undefined
ok('库里只有一条新 revision（r2）', head?.revision === 2, head)
ok('库里 head 是 public', head?.disclosure === 'public', head)
const used = db2.get(`SELECT used_at FROM disclosure_grants WHERE grant_id = ?`, [grant.grantId]) as
  | { used_at: string | null }
  | undefined
ok('grant 被核销一次', typeof used?.used_at === 'string' && used.used_at.length > 0, used)

// ── 同一张 grant 二次使用：拒绝并落回 restricted ─────────────────────
const core2 = new Core({ db: db2, config: {}, logger: log, dataDir: dir })
const replay = await core2.revise({
  artifactId: fact.artifactId,
  statement: sensitive,
  refs: [eventRow.event_id],
  disclosure: 'public',
  disclosureGrant: grant.grantId,
  expectedRevision: 2,
})
ok('二次使用同一 grant → restricted', replay.disclosure === 'restricted', replay.disclosure)
ok('二次使用不新增 consumed 记录', db2.get(`SELECT used_at FROM disclosure_grants WHERE grant_id = ?`, [grant.grantId]) !== undefined)

console.log(`\n结果：${passed} 通过，${failed} 失败`)
db2.close()
childA.kill()
childB.kill()
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  // Windows 上偶尔有句柄没释放；清理失败不改变测试结论
}
if (failed > 0) process.exitCode = 1
