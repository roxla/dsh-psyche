/**
 * I-8 CLI 自检：六个命令从真实命令行入口跑，而不是只测内部函数。
 *
 * 为什么用真实子进程：`spawnSync(process.execPath, [CLI, ...])` 才能证明
 * 「参数解析、退出码、stdout/stderr、数据根选择」这些命令行层的约束真的成立；
 * 只调 service 方法只能证明服务可用，证明不了入口能跑。
 *
 * 跑法：`node test/persona-cli.ts`（要求先 `npm run build`）。
 */
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openDatabase } from '../dist/lib/adapter.js'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const CLI = join(ROOT, 'tools', 'psyche-persona.mjs')

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

interface CliResult {
  code: number
  out: string
  err: string
}

function cli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return { code: result.status ?? -1, out: result.stdout ?? '', err: result.stderr ?? '' }
}

const sandbox = mkdtempSync(join(tmpdir(), 'psyche-cli-'))

function makeCase(name: string): string {
  const dir = join(sandbox, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 建一个 v3 库，并放一条「重置后必须还在」的记忆。 */
async function makeDatabase(dataDir: string): Promise<void> {
  const opened = await openDatabase({ file: join(dataDir, 'memory.sqlite3') })
  const at = '2026-11-04T00:00:00.000Z'
  opened.db.run(
    `INSERT OR REPLACE INTO persona_config
       (persona_id, type, identity_path, persona_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['main', 'preset', null, '{}', at, at],
  )
  opened.db.run(
    `INSERT INTO sources
       (source_id, persona_id, platform, channel, origin, kind, text, captured_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['src-cli-1', 'main', 'desktop', 'desktop', 'user', 'message', '这条记忆在重置后必须还在', at, at],
  )
  opened.db.close()
}

async function main(): Promise<void> {
  // ── 1. 参数解析 ──────────────────────────────────────────────────────
  const noData = cli(['status'])
  check('缺 --data → 退出码 1', noData.code === 1, noData.code)
  check('缺 --data → 明确提示', noData.err.includes('需要 --data'), noData.err.trim())

  const emptyDir = makeCase('empty')
  const unknown = cli(['nope', '--data', emptyDir])
  check('未知命令 → 退出码 1', unknown.code === 1, unknown.code)
  check('未知命令 → 明确提示', unknown.err.includes('不认识的命令'), unknown.err.trim())

  const noPreset = cli(['init', '--data', emptyDir])
  check('init 缺 --preset → 退出码 1', noPreset.code === 1, noPreset.code)
  check('init 缺 --preset → 不替调用方选默认', noPreset.err.includes('--preset'), noPreset.err.trim())

  const missing = cli(['status', '--data', join(sandbox, 'does-not-exist')])
  check('不存在的数据目录 → 退出码 1', missing.code === 1, missing.code)
  check('不存在的数据目录 → 不默默建目录', missing.err.includes('数据目录不存在'), missing.err.trim())

  // ── 2. status：空目录 ────────────────────────────────────────────────
  const emptyStatus = cli(['status', '--data', emptyDir])
  check('空目录 status 退出码 0', emptyStatus.code === 0, emptyStatus.code)
  check('空目录 status=uninitialized', emptyStatus.out.includes('uninitialized'), emptyStatus.out)
  check(
    '空目录 status 列出五套预设且标推荐',
    ['gentle-firm', 'direct-sharp', 'quiet-warm', 'clingy-sweet', 'steady-calm'].every((id) =>
      emptyStatus.out.includes(id),
    ) && emptyStatus.out.includes('推荐'),
    emptyStatus.out,
  )
  check('status 是只读，不建 identity.md', !existsSync(join(emptyDir, 'identity.md')))

  // ── 3. init ─────────────────────────────────────────────────────────
  const dir = makeCase('main')
  const init = cli(['init', '--data', dir, '--preset', 'gentle-firm'])
  check('init 退出码 0', init.code === 0, init.err.trim())
  check('init 输出「人格已锁定」', init.out.includes('人格已锁定'), init.out)
  check('init 写出 identity.md', existsSync(join(dir, 'identity.md')))
  const identity = readFileSync(join(dir, 'identity.md'), 'utf8')

  const again = cli(['init', '--data', dir, '--preset', 'gentle-firm'])
  check('重复 init 被拒（E_INIT_LOCKED）', again.code === 1 && again.err.includes('E_INIT_LOCKED'), again.err.trim())

  const other = makeCase('bad-preset')
  const badPreset = cli(['init', '--data', other, '--preset', 'not-a-preset'])
  check('未知预设被拒（E_PRESET_UNKNOWN）', badPreset.code === 1 && badPreset.err.includes('E_PRESET_UNKNOWN'), badPreset.err.trim())
  check('未知预设不落文件', !existsSync(join(other, 'identity.md')))

  // ── 4. status：locked 且不泄漏原文 ──────────────────────────────────
  const lockedStatus = cli(['status', '--data', dir])
  check('locked status 显示 locked', lockedStatus.out.includes('locked'), lockedStatus.out)
  const firstLine = identity
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 8) ?? ''
  check('status 不打印人格原文', firstLine.length > 0 && !lockedStatus.out.includes(firstLine))
  check('status 不打印 claim token', !/claim[_-]?token/i.test(lockedStatus.out))

  // ── 5. finish / abort ────────────────────────────────────────────────
  const finish = cli(['finish', '--data', dir])
  check('locked 后 finish 幂等', finish.code === 0 && finish.out.includes('无需收尾'), finish.out)
  const abort = cli(['abort', '--data', dir])
  check('locked 后 abort 被拒（E_INIT_LOCKED）', abort.code === 1 && abort.err.includes('E_INIT_LOCKED'), abort.err.trim())
  check('abort 被拒不删人格', existsSync(join(dir, 'identity.md')))

  // ── 6. edit ─────────────────────────────────────────────────────────
  const view = cli(['edit', '--data', dir])
  check('edit 显示 identity.md 路径', view.out.includes('identity.md'), view.out)
  const acceptNoYes = cli(['edit', '--data', dir, '--accept'])
  check('edit --accept 缺 --yes 被拒', acceptNoYes.code === 1 && acceptNoYes.err.includes('--yes'), acceptNoYes.err.trim())

  appendFileSync(join(dir, 'identity.md'), '\n（人工补充：这一行是测试加的）\n')
  const drift = cli(['status', '--data', dir])
  check('改文件后 status=identity-drift', drift.out.includes('identity-drift'), drift.out)
  const accepted = cli(['edit', '--data', dir, '--accept', '--yes'])
  check('接受新哈希成功', accepted.code === 0 && accepted.out.includes('已接受新哈希'), accepted.out)
  const relocked = cli(['status', '--data', dir])
  check('接受后 status=locked', relocked.out.includes('locked'), relocked.out)

  // ── 7. reset：先归档、再确认、记忆不删 ──────────────────────────────
  const resetDir = makeCase('reset')
  await makeDatabase(resetDir)
  const resetInit = cli(['init', '--data', resetDir, '--preset', 'direct-sharp'])
  check('reset 前置 init 成功', resetInit.code === 0 && resetInit.out.includes('人格已锁定'), resetInit.err.trim())
  check('reset 前置 init 同步了库快照', resetInit.out.includes('已同步'), resetInit.out)

  const step1 = cli(['reset', '--data', resetDir])
  check('reset 第一步退出码 0', step1.code === 0, step1.err.trim())
  check('reset 第一步已归档并校验', step1.out.includes('已归档并校验'), step1.out)
  const idMatch = /包 ID：(\S+)/.exec(step1.out)
  check('reset 打印包 ID', Boolean(idMatch), step1.out)
  const archiveId = idMatch ? idMatch[1] : ''
  const archiveFile = join(resetDir, 'exports', archiveId)
  check('归档文件存在', existsSync(archiveFile), archiveFile)

  const wrongWord = cli(['reset', '--data', resetDir, '--archive', archiveFile, '--word', 'wrong-id', '--yes'])
  check('确认词错误被拒', wrongWord.code === 1 && wrongWord.err.includes('确认词不对'), wrongWord.err.trim())
  check('确认词错误不重置', existsSync(join(resetDir, 'identity.md')))

  const brokenFile = join(resetDir, 'exports', 'broken.zip')
  copyFileSync(archiveFile, brokenFile)
  const brokenBytes = readFileSync(brokenFile)
  brokenBytes[Math.max(0, brokenBytes.length - 20)] ^= 0xff
  writeFileSync(brokenFile, brokenBytes)
  const broken = cli(['reset', '--data', resetDir, '--archive', brokenFile, '--word', 'broken.zip', '--yes'])
  check('损坏归档被拒', broken.code === 1 && broken.err.includes('归档校验失败'), broken.err.trim())
  check('损坏归档不重置', existsSync(join(resetDir, 'identity.md')))

  const done = cli(['reset', '--data', resetDir, '--archive', archiveFile, '--word', archiveId, '--yes'])
  check('reset 成功', done.code === 0 && done.out.includes('已重置'), done.err.trim())
  check('reset 后记忆库仍在', existsSync(join(resetDir, 'memory.sqlite3')))
  check('reset 删掉 identity.md', !existsSync(join(resetDir, 'identity.md')))
  check('reset 后 status=uninitialized', cli(['status', '--data', resetDir]).out.includes('uninitialized'))

  const verifyDb = await openDatabase({ file: join(resetDir, 'memory.sqlite3') })
  const sourceCount = Number(verifyDb.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sources')?.n ?? -1)
  check('reset 不删记忆（sources 仍 1 条）', sourceCount === 1, sourceCount)
  const historyCount = Number(
    verifyDb.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM personality_history WHERE field = 'initialization' AND after_value = 'uninitialized'`,
    )?.n ?? -1,
  )
  check('reset 在人格历史里留了记录', historyCount >= 1, historyCount)
  verifyDb.db.close()

  const resetAgain = cli(['reset', '--data', resetDir])
  check('已重置后再 reset 被拒', resetAgain.code === 1 && resetAgain.err.includes('没有可重置'), resetAgain.err.trim())

  // ── 8. 锁冲突：活着的初始化现场不能被抢 ─────────────────────────────
  const lockedDir = makeCase('lock-conflict')
  const claimPath = join(lockedDir, 'persona.init.lock')
  writeFileSync(
    claimPath,
    JSON.stringify(
      {
        kind: 'init',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        presetId: 'gentle-firm',
        pendingIdentityHash: null,
        token: 'test-token',
        opId: 'test-op',
      },
      null,
      2,
    ),
  )
  const race = cli(['init', '--data', lockedDir, '--preset', 'gentle-firm'])
  check('活持有者现场 → init 被拒（E_INIT_RACE）', race.code === 1 && race.err.includes('E_INIT_RACE'), race.err.trim())
  check('锁冲突不覆盖现场', existsSync(claimPath))

  console.log(`\npersona-cli: ${pass} 通过, ${fail} 失败`)
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* Windows 句柄延迟：结果已出，不影响结论 */
  }
  process.exitCode = fail === 0 ? 0 : 1
}

await main()
