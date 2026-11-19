/**
 * I-5 初始化状态转换自检：finish/abort 幂等、锁归属不改状态、跨存储一致性。
 *
 * 为什么单独测：identity.md / persona.json 是权威，SQLite 是派生快照。
 * 两套存储不是一个原子事务——文件写成了、库没跟上时，系统必须能识别并重试，
 * 而不是「重新生成一份默认人格」把原文覆盖掉。
 *
 * 跑法：`node test/persona-consistency.ts`（要求先 `npm run build`）。
 */
import * as realFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase } from '../dist/lib/adapter.js'
import {
  abortInitialization,
  finishInitialization,
  initializePersona,
  inspectInitialization,
  initPathsOf,
} from '../dist/lib/persona-init.js'
import type { InitDb, InitFs } from '../dist/lib/persona-init.js'

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

const sandbox = mkdtempSync(join(tmpdir(), 'psyche-consistency-'))
const presetDir = new URL('../packages/core/presets/', import.meta.url)
let caseNo = 0

function makeCase(): { dir: string; paths: ReturnType<typeof initPathsOf> } {
  caseNo += 1
  const dir = join(sandbox, `case-${caseNo}`, 'data')
  mkdirSync(dir, { recursive: true })
  return { dir, paths: initPathsOf(dir) }
}

function writeClaim(dir: string, pid: number, token: string): void {
  const paths = initPathsOf(dir)
  writeFileSync(
    paths.claim,
    JSON.stringify(
      {
        kind: 'init',
        token,
        opId: `init-test-${token}`,
        pid,
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

async function main(): Promise<void> {
  const opened = await openDatabase({ file: join(sandbox, 'db', 'memory.sqlite3') })
  const db = opened.db
  const initDb: InitDb = {
    run: (sql, params) => db.run(sql, params) as unknown,
    get: <T>(sql: string, params?: readonly unknown[]) => db.get<T>(sql, params),
    transaction: <T>(fn: () => T) => db.transaction(fn),
  }

  // ── 1. 正常初始化：文件 locked + 库有快照 ─────────────────────────────
  {
    const { dir } = makeCase()
    const result = initializePersona({ dataDir: dir, presetId: 'gentle-firm', presetDir, db: initDb })
    check('初始化返回 dbSynced=true', result.dbSynced === true)
    const row = initDb.get<{ persona_json: string }>(
      'SELECT persona_json FROM persona_config WHERE persona_id = ?',
      ['main'],
    )
    check('库里有 persona 快照', typeof row?.persona_json === 'string' && row.persona_json.includes('gentle-firm'))
  }

  // ── 2. 文件已锁 + claim 残留 + 库同步失败 → 不覆盖文件，保留 claim ─────
  {
    const { dir, paths } = makeCase()
    initializePersona({ dataDir: dir, presetId: 'gentle-firm', presetDir })
    const beforeIdentity = readFileSync(paths.identity, 'utf8')
    const beforePersona = readFileSync(paths.persona, 'utf8')
    writeClaim(dir, 99_999, 'tok-con')

    const failingDb: InitDb = {
      run: () => {
        throw new Error('I-5 注入：库写入失败')
      },
      get: () => undefined,
      transaction: (fn) => fn(),
    }
    const failed = finishInitialization({ dataDir: dir, presetDir, db: failingDb, isProcessAlive: () => false })
    check('库同步失败时 finish 返回 failed', failed.dbSync === 'failed', failed.dbSync)
    check('库同步失败时 claim 保留', existsSync(paths.claim))
    check('库同步失败不重写 identity.md', readFileSync(paths.identity, 'utf8') === beforeIdentity)
    check('库同步失败不重写 persona.json', readFileSync(paths.persona, 'utf8') === beforePersona)

    // ── 3. 好库重试 → synced + claim 删除 + 快照落库，且人格不被重建 ──
    const retried = finishInitialization({ dataDir: dir, presetDir, db: initDb, isProcessAlive: () => false })
    check('重试 finish 同步成功', retried.dbSync === 'synced', retried.dbSync)
    check('重试 finish 后 claim 删除', !existsSync(paths.claim))
    const row = initDb.get<{ persona_json: string }>(
      'SELECT persona_json FROM persona_config WHERE persona_id = ?',
      ['main'],
    )
    check('重试后库里有快照', typeof row?.persona_json === 'string')
    check('重试不重建人格（identity 字节不变）', readFileSync(paths.identity, 'utf8') === beforeIdentity)
    const persona = JSON.parse(readFileSync(paths.persona, 'utf8')) as {
      initialization?: { presetId?: string; status?: string }
    }
    check(
      '重试不重建人格（preset 与状态不变）',
      persona.initialization?.presetId === 'gentle-firm' && persona.initialization?.status === 'locked',
      persona.initialization,
    )
  }

  // ── 4. 重复 finish 幂等：不新增初始化结果 ─────────────────────────────
  {
    const { dir } = makeCase()
    initializePersona({ dataDir: dir, presetId: 'gentle-firm', presetDir, db: initDb })
    const countBefore =
      initDb.get<{ n: number }>('SELECT COUNT(*) AS n FROM personality_history')?.n ?? 0
    const again = finishInitialization({ dataDir: dir, presetDir, db: initDb })
    const countAfter =
      initDb.get<{ n: number }>('SELECT COUNT(*) AS n FROM personality_history')?.n ?? 0
    check('已锁再 finish 返回 alreadyLocked', again.alreadyLocked === true)
    check('已锁再 finish 不新增历史', countAfter === countBefore, { countBefore, countAfter })
  }

  // ── 5. locked 后 abort 被拒且不改文件 ─────────────────────────────────
  {
    const { dir, paths } = makeCase()
    initializePersona({ dataDir: dir, presetId: 'gentle-firm', presetDir })
    const before = readFileSync(paths.identity, 'utf8')
    const error = expectError(() => abortInitialization({ dataDir: dir }), 'E_INIT_LOCKED')
    check('已锁定 abort 被拒绝', error.ok, error.message)
    check('已锁定 abort 不改原文', readFileSync(paths.identity, 'utf8') === before)
  }

  // ── 6. 非持有者不能改状态（字节级）───────────────────────────────────
  {
    const { dir, paths } = makeCase()
    writeClaim(dir, 424242, 'tok-owner')
    writeFileSync(paths.identity, '# 原文\n', 'utf8')
    const before = readFileSync(paths.identity, 'utf8')
    const deps = { isProcessAlive: (pid: number) => pid === 424242 }
    const error = expectError(() => finishInitialization({ dataDir: dir, presetDir, ...deps }), 'E_INIT_RACE')
    check('非持有者 finish 被拒绝', error.ok, error.message)
    check('非持有者 finish 不改原文', readFileSync(paths.identity, 'utf8') === before)
    check('非持有者 finish 不删 claim', existsSync(paths.claim))
  }

  // ── 7. 中途失败不生成表面 locked 的人格 ──────────────────────────────
  {
    const { dir, paths } = makeCase()
    let renames = 0
    const flakyFs: InitFs = {
      existsSync: (path) => realFs.existsSync(path),
      readFileSync: (path, encoding) => realFs.readFileSync(path, encoding),
      writeFileSync: (path, data, options) => realFs.writeFileSync(path, data, options),
      renameSync: (from, to) => {
        renames += 1
        if (renames === 2) throw new Error('I-5 注入：改名失败')
        realFs.renameSync(from, to)
      },
      unlinkSync: (path) => realFs.unlinkSync(path),
      openSync: (path, flags, mode) => realFs.openSync(path, flags, mode),
      writeSync: (fd, data) => realFs.writeSync(fd, data),
      closeSync: (fd) => realFs.closeSync(fd),
      mkdirSync: (path, options) => realFs.mkdirSync(path, options),
      statSync: (path) => realFs.statSync(path),
    }
    const error = expectError(
      () => initializePersona({ dataDir: dir, presetId: 'gentle-firm', presetDir, fs: flakyFs }),
      'E_INTERNAL',
    )
    check('中途失败抛 E_INTERNAL', error.ok, error.message)
    check('中途失败不是 locked', inspectInitialization({ dataDir: dir }).state !== 'locked')
    check('中途失败保留 claim 供收尾', existsSync(paths.claim))
    check('中途失败 identity.md 已写（现场可读）', existsSync(paths.identity))

    const aborted = abortInitialization({ dataDir: dir })
    check('abort 收尾成功', aborted.aborted === true, aborted)
    check('abort 后回到 uninitialized', inspectInitialization({ dataDir: dir }).state === 'uninitialized')
    check('abort 后不残留 claim', !existsSync(paths.claim))
  }

  console.log(`\npersona-consistency: ${pass} 通过, ${fail} 失败`)
  try {
    db.close()
  } catch {
    /* 句柄已关也不影响结论 */
  }
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* Windows 句柄延迟：结果已出，不影响结论 */
  }
  process.exitCode = fail === 0 ? 0 : 1
}

await main()
