/**
 * I-4 初始化锁自检：唯一 owner token、并发争抢、锁归属、残留锁与只读 inspect。
 *
 * 为什么单独测：`persona-init` 的 claim 是「一次点击写下不可改原文」的闸门。
 * 并发时只能有一个执行者；活着的持有者不能被别的进程抢走收尾权；
 * 崩溃残留要能由人收尾，但不能被自动当成「初始化成功」。
 *
 * 跑法：`node test/persona-lock.ts`（要求先 `npm run build`）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  abortInitialization,
  finishInitialization,
  initializePersona,
  inspectInitialization,
  initPathsOf,
} from '../dist/lib/persona-init.js'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`)
  }
}

function expectError(fn: () => unknown, code: string): { ok: boolean; message: string } {
  try {
    fn()
    return { ok: false, message: '没有抛错' }
  } catch (error) {
    return { ok: (error as { code?: string }).code === code, message: String((error as Error).message) }
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'psyche-lock-'))
const presetDir = new URL('../packages/core/presets/', import.meta.url)
const moduleUrl = new URL('../dist/lib/persona-init.js', import.meta.url).href

let caseNo = 0

function makeCase(): { dir: string; paths: ReturnType<typeof initPathsOf> } {
  caseNo += 1
  const dir = join(sandbox, `case-${caseNo}`, 'data')
  mkdirSync(dir, { recursive: true })
  return { dir, paths: initPathsOf(dir) }
}

/** 造一个「claim + identity.md、没有 persona.json」的现场（现场 B），可指定持有进程是否活着。 */
function makeClaimed(dir: string, ownerPid: number, token = 'tok-owner'): void {
  const paths = initPathsOf(dir)
  writeFileSync(paths.identity, '# 人格原文\n', 'utf8')
  writeFileSync(
    paths.claim,
    JSON.stringify(
      {
        kind: 'init',
        token,
        opId: 'init-test-owner',
        pid: ownerPid,
        startedAt: new Date().toISOString(),
        presetId: 'gentle-firm',
        pendingIdentityHash: null,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
}

// ── 1. 首次获取：claim 带唯一 token / opId / pid ─────────────────────────────
{
  const { dir, paths } = makeCase()
  const result = initializePersona({ dataDir: dir, presetId: 'gentle-firm', presetDir })
  check('首次获取返回 claimToken', typeof result.claimToken === 'string' && result.claimToken.length >= 16, result.claimToken)
  check('初始化成功后 claim 已删除', !existsSync(paths.claim))
  check('identity.md 已写', existsSync(paths.identity))
  check('persona.json 已锁定', (() => {
    const doc = JSON.parse(readFileSync(paths.persona, 'utf8')) as { initialization?: { status?: string } }
    return doc.initialization?.status === 'locked'
  })())
  const snapshot = inspectInitialization({ dataDir: dir })
  check('inspect 判 locked', snapshot.state === 'locked', snapshot.state)
}

// ── 2. 并发争抢：两个真实进程同时初始化，只有一个成功 ──────────────────────
{
  const { dir, paths } = makeCase()
  const gate = join(dir, '..', 'gate-open')
  const script = join(sandbox, 'child-init.mjs')
  writeFileSync(
    script,
    `
import { existsSync } from 'node:fs'
import { initializePersona } from ${JSON.stringify(moduleUrl)}
const [dataDir, presetDir, gateFile] = process.argv.slice(2)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
while (!existsSync(gateFile)) { await sleep(2) }
try {
  const result = initializePersona({ dataDir, presetId: 'gentle-firm', presetDir })
  process.stdout.write(JSON.stringify({ ok: true, token: result.claimToken }) + '\\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? null, message: String(error?.message ?? error) }) + '\\n')
}
`,
    'utf8',
  )

  const run = (): Promise<{ ok: boolean; token?: string; code?: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [script, dir, presetDir.pathname.replace(/^\/([A-Za-z]:)/, '$1'), gate], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      child.stdout.on('data', (chunk) => {
        out += String(chunk)
      })
      child.stderr.on('data', () => {
        /* 子进程的报错只走 JSON 输出，这里不淹没结果 */
      })
      child.on('close', () => {
        try {
          resolve(JSON.parse(out.trim().split('\n').pop() ?? '{}') as { ok: boolean; token?: string; code?: string })
        } catch {
          resolve({ ok: false, code: 'PARSE' })
        }
      })
    })

  const both = Promise.all([run(), run()])
  setTimeout(() => writeFileSync(gate, 'go'), 150)
  const results = await both

  const succeeded = results.filter((item) => item.ok)
  check('并发争抢只有一个成功', succeeded.length === 1, results)
  const failed = results.filter((item) => !item.ok)
  check(
    '失败者拿到明确的锁错误',
    failed.length === 1 && (failed[0]?.code === 'E_INIT_RACE' || failed[0]?.code === 'E_INIT_LOCKED'),
    failed,
  )
  check('并发后 claim 已清理', !existsSync(paths.claim))
  check('并发后人格完整', (() => {
    const doc = JSON.parse(readFileSync(paths.persona, 'utf8')) as { initialization?: { status?: string } }
    return doc.initialization?.status === 'locked'
  })())
}

// ── 3. 锁归属：活着的持有者不能被抢 ─────────────────────────────────────────
{
  const { dir } = makeCase()
  makeClaimed(dir, 424242, 'tok-alive')
  const deps = { isProcessAlive: (pid: number) => pid === 424242 }

  const noToken = expectError(() => finishInitialization({ dataDir: dir, presetDir, ...deps }), 'E_INIT_RACE')
  check('非持有者不带 token 不能 finish', noToken.ok, noToken.message)

  const wrongToken = expectError(
    () => finishInitialization({ dataDir: dir, presetDir, claimToken: 'tok-wrong', ...deps }),
    'E_INIT_RACE',
  )
  check('非持有者带错误 token 不能 finish', wrongToken.ok, wrongToken.message)

  const abortNoToken = expectError(() => abortInitialization({ dataDir: dir, ...deps }), 'E_INIT_RACE')
  check('非持有者不能 abort', abortNoToken.ok, abortNoToken.message)

  const owned = finishInitialization({ dataDir: dir, presetDir, claimToken: 'tok-alive', ...deps })
  check('持有者带 token 可以 finish', owned.alreadyLocked === false, owned)
  check('finish 后 claim 已删', !existsSync(initPathsOf(dir).claim))
}

// ── 4. 崩溃残留：持有进程已死，人工可收尾 ───────────────────────────────────
{
  const { dir } = makeCase()
  makeClaimed(dir, 99_999, 'tok-dead')
  const deps = { isProcessAlive: () => false }
  const snapshot = inspectInitialization({ dataDir: dir, ...deps })
  check('死亡持有者现场判 initializing', snapshot.state === 'initializing', snapshot.state)
  check('死亡持有者现场保留 claim', existsSync(initPathsOf(dir).claim))

  const finished = finishInitialization({ dataDir: dir, presetDir, ...deps })
  check('崩溃残留可由人 finish', finished.alreadyLocked === false, finished)
  check('finish 后 claim 已删（崩溃残留）', !existsSync(initPathsOf(dir).claim))
}

// ── 5. 残留锁不自动被认定为初始化成功 ───────────────────────────────────────
{
  const { dir } = makeCase()
  makeClaimed(dir, 99_999, 'tok-stale')
  const deps = { isProcessAlive: () => false }

  // initializing + 死持有者：启动期 reconcile 不该动它（保留现场给人收尾）
  const { reconcileInitialization } = await import('../dist/lib/persona-init.js')
  const reconciled = reconcileInitialization({ dataDir: dir, ...deps })
  check('initializing 残留不自动收尾', reconciled.actions.length === 0 && existsSync(initPathsOf(dir).claim), reconciled.actions)
  check('残留锁不会自己变成 locked', inspectInitialization({ dataDir: dir, ...deps }).state === 'initializing')
}

// ── 6. inspect 只读：多次调用不改文件 ───────────────────────────────────────
{
  const { dir, paths } = makeCase()
  makeClaimed(dir, 424242, 'tok-readonly')
  const before = readFileSync(paths.claim, 'utf8')
  inspectInitialization({ dataDir: dir, isProcessAlive: () => true })
  inspectInitialization({ dataDir: dir, isProcessAlive: () => true })
  inspectInitialization({ dataDir: dir, isProcessAlive: () => true })
  check('inspect 不删 claim', existsSync(paths.claim))
  check('inspect 不改 claim 内容', readFileSync(paths.claim, 'utf8') === before)
}

// ── 7. abort 幂等：重复放弃不抛错 ───────────────────────────────────────────
{
  const { dir } = makeCase()
  const first = abortInitialization({ dataDir: dir })
  check('空目录第一次 abort 返回 aborted=false', first.aborted === false && first.removed.length === 0)
  let threw = false
  let second: { aborted: boolean } | null = null
  try {
    second = abortInitialization({ dataDir: dir })
  } catch {
    threw = true
  }
  check('空目录重复 abort 不抛错（幂等）', !threw && second?.aborted === false)
}

console.log(`\npersona-lock: ${pass} 通过, ${fail} 失败`)
try {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
} catch {
  /* Windows 上偶发句柄延迟：测试结果已出，清理失败不影响结论 */
}
process.exitCode = fail === 0 ? 0 : 1
