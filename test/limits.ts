/**
 * 解包资源上限自检（`ARCHIVE_LIMITS` / `E_ARCHIVE_LIMIT`）。
 *
 * 迁移收口承诺的第一条：能挡住「小包解出几十 GB」的解压炸弹，
 * 而且**超限时不留半成品、不碰正式数据根**。
 * 上限本身是常量（2 GiB 级别），这里用注入的小上限来验逻辑同一条代码路径。
 *
 * 跑法：`node test/limits.ts`（要求先 `npm run build`）
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase } from '../dist/lib/adapter.js'
import { ARCHIVE_LIMITS, createArchive, prepareRestore, verifyArchive } from '../dist/lib/archive.js'
import { SCHEMA_VERSION } from '../dist/lib/schema.js'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'psyche-limits-'))
const cleanup: string[] = [sandbox]

async function main(): Promise<void> {
  // ── 造一个像样的数据根 + 包 ───────────────────────────────────────────────
  const home = join(sandbox, 'home')
  mkdirSync(join(home, 'assets'), { recursive: true })
  cleanup.push(home)
  const opened = await openDatabase({ file: join(home, 'memory.sqlite3'), driverPreference: 'auto' })
  writeFileSync(join(home, 'identity.md'), '# 心灵\n\n' + '深海里的鲸。'.repeat(40), 'utf8')
  writeFileSync(join(home, 'assets', 'pixel.bin'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
  const archive = createArchive({
    db: opened.db,
    dataDir: home,
    counts: { events: 0, sources: 0 },
    version: 'test',
    schemaVersion: SCHEMA_VERSION,
    algorithmVersion: 'grow-1',
  })
  opened.db.close()

  // ── 1. 默认上限：正常包必须过 ─────────────────────────────────────────────
  const normal = verifyArchive(archive.file)
  check('默认上限下正常包通过', normal.ok, normal.problems)
  const plan = prepareRestore({ dataDir: join(sandbox, 'target-normal'), file: archive.file, schemaVersion: SCHEMA_VERSION })
  check('默认上限下预检通过', plan.ok, plan.problems)
  rmSync(plan.stagedDir, { recursive: true, force: true })

  // ── 2. 压缩包本身太大 ────────────────────────────────────────────────────
  const bigArchive = verifyArchive(archive.file, { limits: { ...ARCHIVE_LIMITS, archiveBytes: 16 } })
  check('压缩包超限被拒', !bigArchive.ok && /资源上限/.test(bigArchive.problems[0]?.reason ?? ''), bigArchive.problems)

  // ── 3. 成员数（含目录）超限 ──────────────────────────────────────────────
  const fewMembers = verifyArchive(archive.file, { limits: { ...ARCHIVE_LIMITS, members: 2 } })
  check('成员数超限被拒', !fewMembers.ok && /成员数超过/.test(fewMembers.problems[0]?.reason ?? ''), fewMembers.problems)

  // ── 4. 单成员超限（assets/pixel.bin 8 字节 > 4）─────────────────────────
  const smallMember = verifyArchive(archive.file, { limits: { ...ARCHIVE_LIMITS, memberBytes: 4 } })
  check('单成员超限被拒', !smallMember.ok && /单文件上限/.test(smallMember.problems[0]?.reason ?? ''), smallMember.problems)

  // ── 5. 总解压量超限 ─────────────────────────────────────────────────────
  const smallTotal = verifyArchive(archive.file, { limits: { ...ARCHIVE_LIMITS, totalBytes: 64 } })
  check('总解压量超限被拒', !smallTotal.ok && /总解压量|总上限/.test(smallTotal.problems[0]?.reason ?? ''), smallTotal.problems)

  // ── 6. 超限时不留半成品、不碰数据根 ──────────────────────────────────────
  const target = join(sandbox, 'target-guarded')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'identity.md'), '原样', 'utf8')
  const before = readdirSync(target).sort()
  const guarded = prepareRestore({
    dataDir: target,
    file: archive.file,
    schemaVersion: SCHEMA_VERSION,
    limits: { ...ARCHIVE_LIMITS, members: 2 },
  })
  check('超限时预检失败', !guarded.ok, guarded.problems)
  check('超限时暂存目录被清掉', !existsSync(guarded.stagedDir), guarded.stagedDir)
  check('超限时数据根一个字节没动', JSON.stringify(readdirSync(target).sort()) === JSON.stringify(before), readdirSync(target))

  rmSync(sandbox, { recursive: true, force: true })
  console.log(`\n解包资源上限自检：${pass} 通过 ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
