/**
 * I-6 初始化服务自检：状态检查 / start 显式预设 / finish / abort / sync / acceptDrift / reconcile。
 *
 * 为什么单独测：服务是 Owner 层唯一入口，必须证明「不替调用方偷偷选默认人格」，
 * 且初始化能力没有泄漏进公开 Contract。
 *
 * 跑法：`node test/persona-service.ts`（要求先 `npm run build`）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase } from '../dist/lib/adapter.js'
import { PSYCHE_API_METHODS } from '../packages/contract/dist/api.js'
import { createPersonaInitService } from '../dist/lib/persona-init-service.js'
import type { InitDb } from '../dist/lib/persona-init.js'

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

const sandbox = mkdtempSync(join(tmpdir(), 'psyche-service-'))
const presetDir = new URL('../packages/core/presets/', import.meta.url)
let caseNo = 0

function makeCase(): string {
  caseNo += 1
  const dir = join(sandbox, `case-${caseNo}`, 'data')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function main(): Promise<void> {
  const opened = await openDatabase({ file: join(sandbox, 'db', 'memory.sqlite3') })
  const db = opened.db
  const initDb: InitDb = {
    run: (sql, params) => db.run(sql, params) as unknown,
    get: <T>(sql: string, params?: readonly unknown[]) => db.get<T>(sql, params),
    transaction: <T>(fn: () => T) => db.transaction(fn),
  }

  // ── 1. 状态检查只读 ──────────────────────────────────────────────────
  {
    const dir = makeCase()
    const service = createPersonaInitService({ dataDir: dir, presetDir, db: initDb })
    const first = service.status()
    check('空目录 status 判 uninitialized', first.snapshot.state === 'uninitialized', first.snapshot.state)
    const second = service.status()
    check('status 连续调用不变', second.snapshot.state === 'uninitialized')
    check('status 不创建文件', !existsSync(join(dir, 'identity.md')) && !existsSync(join(dir, 'persona.json')))
  }

  // ── 2. start 必须显式预设 ────────────────────────────────────────────
  {
    const dir = makeCase()
    const service = createPersonaInitService({ dataDir: dir, presetDir, db: initDb })
    const missing = expectError(() => service.start(''), 'E_PRESET_UNKNOWN')
    check('start 空 presetId 被拒绝（不偷偷套默认）', missing.ok, missing.message)
    const unknown = expectError(() => service.start('no-such-preset'), 'E_PRESET_UNKNOWN')
    check('start 未知 presetId 被拒绝', unknown.ok, unknown.message)
    check('被拒绝后仍是 uninitialized', service.status().snapshot.state === 'uninitialized')
  }

  // ── 3. 完整流程：start → locked → finish 幂等 → abort 拒绝 ────────────
  {
    const dir = makeCase()
    const service = createPersonaInitService({ dataDir: dir, presetDir, db: initDb })
    const started = service.start('gentle-firm')
    check('start 返回 claimToken', typeof started.claimToken === 'string' && started.claimToken.length > 0)
    check('start 后状态 locked', service.status().snapshot.state === 'locked')
    check('start 返回值 dbSynced=true', started.dbSynced === true)

    const again = service.finish(started.claimToken)
    check('已锁 finish 幂等（alreadyLocked）', again.alreadyLocked === true)
    check('已锁 finish 库已同步', again.dbSync === 'synced', again.dbSync)

    const abort = expectError(() => service.abort(started.claimToken), 'E_INIT_LOCKED')
    check('已锁 abort 被拒绝', abort.ok, abort.message)
  }

  // ── 4. 中途失败 → claim 保留 → abort 收尾 ────────────────────────────
  {
    const dir = makeCase()
    let renames = 0
    const realFs = await import('node:fs')
    const flakyFs = {
      existsSync: (path: string) => realFs.existsSync(path),
      readFileSync: (path: string, encoding: 'utf8') => realFs.readFileSync(path, encoding),
      writeFileSync: (path: string, data: string, options: { encoding: 'utf8'; mode?: number }) =>
        realFs.writeFileSync(path, data, options),
      renameSync: (from: string, to: string) => {
        renames += 1
        if (renames === 2) throw new Error('I-6 注入：改名失败')
        realFs.renameSync(from, to)
      },
      unlinkSync: (path: string) => realFs.unlinkSync(path),
      openSync: (path: string, flags: string, mode?: number) => realFs.openSync(path, flags, mode),
      writeSync: (fd: number, data: string) => realFs.writeSync(fd, data),
      closeSync: (fd: number) => realFs.closeSync(fd),
      mkdirSync: (path: string, options: { recursive: true }) => realFs.mkdirSync(path, options),
      statSync: (path: string) => realFs.statSync(path),
    }
    const service = createPersonaInitService({ dataDir: dir, presetDir, db: initDb, fs: flakyFs })
    const error = expectError(() => service.start('gentle-firm'), 'E_INTERNAL')
    check('start 中途失败抛 E_INTERNAL', error.ok, error.message)
    check('失败后 claim 保留', existsSync(join(dir, 'persona.init.lock')))
    check('失败后状态 initializing', service.status().snapshot.state === 'initializing')
    const aborted = service.abort()
    check('abort 收尾成功', aborted.aborted === true, aborted)
    check('abort 后回到 uninitialized', service.status().snapshot.state === 'uninitialized')
  }

  // ── 5. sync：库快照被改坏后可从文件修复 ──────────────────────────────
  {
    const dir = makeCase()
    const service = createPersonaInitService({ dataDir: dir, presetDir, db: initDb })
    service.start('steady-calm')
    initDb.run('UPDATE persona_config SET persona_json = ? WHERE persona_id = ?', ['{"broken":true}', 'main'])
    const synced = service.sync()
    check('sync 从文件修复不一致快照', synced.synced === true, synced)
    const row = initDb.get<{ persona_json: string }>(
      'SELECT persona_json FROM persona_config WHERE persona_id = ?',
      ['main'],
    )
    check('修复后库里有完整人格', typeof row?.persona_json === 'string' && row.persona_json.includes('steady-calm'))
    const again = service.sync()
    check('再 sync 报告 already-in-sync', again.synced === false && again.reason === 'already-in-sync', again)
  }

  // ── 6. acceptDrift：只更新哈希，不改原文 ─────────────────────────────
  {
    const dir = makeCase()
    const service = createPersonaInitService({ dataDir: dir, presetDir, db: initDb })
    service.start('gentle-firm')
    const identityPath = join(dir, 'identity.md')
    const original = readFileSync(identityPath, 'utf8')
    const edited = `${original}\n（我加了一句）\n`
    writeFileSync(identityPath, edited, 'utf8')
    check('改原文后判 identity-drift', service.status().snapshot.state === 'identity-drift')
    const accepted = service.acceptDrift()
    check('acceptDrift 后回到 locked', accepted.snapshot.state === 'locked')
    check('acceptDrift 不改原文', readFileSync(identityPath, 'utf8') === edited)
  }

  // ── 7. reconcile：只清已锁 + 死持有者的 claim ────────────────────────
  {
    const dir = makeCase()
    const service = createPersonaInitService({ dataDir: dir, presetDir, db: initDb })
    service.start('gentle-firm')
    writeFileSync(
      join(dir, 'persona.init.lock'),
      JSON.stringify({
        kind: 'init',
        token: 'tok-stale',
        opId: 'init-stale',
        pid: 99_999,
        startedAt: new Date().toISOString(),
        presetId: 'gentle-firm',
        pendingIdentityHash: null,
      }) + '\n',
      'utf8',
    )
    const deadService = createPersonaInitService({
      dataDir: dir,
      presetDir,
      db: initDb,
      isProcessAlive: () => false,
    })
    const { actions } = deadService.reconcile()
    check('reconcile 清掉死持有者的残留 claim', actions.includes('cleared-stale-claim'), actions)
    check('reconcile 后 claim 不存在', !existsSync(join(dir, 'persona.init.lock')))
  }

  // ── 7.5 自定义人格：走同一套 claim/落盘/校验，不经过预设 ────────────
  {
    const dir = makeCase()
    const service = createPersonaInitService({ dataDir: dir, presetDir, db: initDb })
    const short = expectError(() => service.startCustom({ identity: '太短' }), 'E_VALIDATION')
    check('自定义身份太短被拒绝', short.ok, short.message)
    const blank = expectError(() => service.startCustom({ identity: '   ' }), 'E_VALIDATION')
    check('自定义身份空白被拒绝', blank.ok, blank.message)
    const placeholder = expectError(
      () => service.startCustom({ identity: `${'她是谁。'.repeat(60)}{{name}}` }),
      'E_VALIDATION',
    )
    check('自定义身份含未替换占位符被拒绝', placeholder.ok, placeholder.message)
    check('被拒绝后仍是 uninitialized', service.status().snapshot.state === 'uninitialized')

    const identity = `她是林间的一只小鹿，说话轻，记性很好。\n${'她记得每一次被认真对待的瞬间。'.repeat(12)}`
    const started = service.startCustom({ identity, name: '小鹿' })
    check('自定义人格初始化成功', started.snapshot.state === 'locked', started.snapshot.state)
    check('自定义人格 presetId 为 null', started.snapshot.presetId === null, started.snapshot.presetId)
    check('自定义人格名字落到记录', started.persona.initialization.presetName === '小鹿')
    check('自定义人格版本是 custom', started.persona.initialization.presetVersion === 'custom')
    check('自定义人格正文原样落盘', readFileSync(join(dir, 'identity.md'), 'utf8') === identity)
    const locked = expectError(() => service.startCustom({ identity }), 'E_INIT_LOCKED')
    check('锁定后不能再用自定义初始化', locked.ok, locked.message)
  }

  // ── 8. 能力边界：初始化没有进公开 Contract ───────────────────────────
  check(
    'Contract 方法里没有 initialize/finish/abort',
    !PSYCHE_API_METHODS.some((method) => ['initialize', 'finish', 'abort', 'initializePersona'].includes(method)),
    PSYCHE_API_METHODS,
  )

  console.log(`\npersona-service: ${pass} 通过, ${fail} 失败`)
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
