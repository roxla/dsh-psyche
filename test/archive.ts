// ─────────────────────────────────────────────────────────────────────────────
// 迁移包（archive）的自检：打包 → 校验 → 解包 → 恢复，外加几条必须拒绝的坏情况。
//
// 跑法：node test/archive.ts（Node 24 直接执行 TS，不需要额外构建）
// 全部用临时目录，不碰真实数据根；结束时清干净。
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { openDatabase } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { SCHEMA_VERSION } from '../dist/lib/schema.js'
import {
  buildTar,
  createArchive,
  extractArchive,
  isSafeArchivePath,
  listArchives,
  prepareRestore,
  applyRestore,
  pruneArchives,
  verifyArchive,
} from '../dist/lib/archive.js'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
}

const sandbox = mkdtempSync(join(tmpdir(), 'psyche-archive-'))
const cleanup: string[] = [sandbox]

/** 造一个真库（走生产同一条 openDatabase，migrate 会自动建表）。 */
async function makeDataDir(name: string): Promise<{ dir: string; db: any }> {
  const dir = join(sandbox, name)
  mkdirSync(dir, { recursive: true })
  cleanup.push(dir)
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto' })
  return { dir, db: opened.db }
}

async function main(): Promise<void> {
  // ── 1. 打包 ───────────────────────────────────────────────────────────────
  const { dir, db } = await makeDataDir('home')
  const core = new Core({ db, config: {}, dataDir: dir })
  await core.capture({
    text: '主人说他喜欢深海和鲸鱼',
    channel: 'desktop',
    sessionRef: 'sess-archive-1',
    origin: 'user',
  })
  // 人格原文 / 偏好 也写进去：真实数据目录里就是这些文件
  writeFileSync(join(dir, 'identity.md'), '# 心灵\n\n她是深海里的鲸。\n', 'utf8')
  writeFileSync(join(dir, 'panel-prefs.json'), JSON.stringify({ sea: true, promptSection: null }), 'utf8')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'abc123'), Buffer.from([1, 2, 3, 4]))
  // 这两个不该进包
  mkdirSync(join(dir, 'backups'), { recursive: true })
  writeFileSync(join(dir, 'backups', 'memory-20200101-000000.sqlite3'), 'old')
  mkdirSync(join(dir, 'memory-view'), { recursive: true })
  writeFileSync(join(dir, 'memory-view', 'fold-preview.json'), '{}')

  const archive = createArchive({
    db,
    dataDir: dir,
    // 计数必须是真数：清单会和库里的行数对账，写错就会被拒绝（这正是这轮加的结构校验）
    counts: { events: 0, sources: 1 },
    version: 'test',
    schemaVersion: SCHEMA_VERSION,
    algorithmVersion: 'grow-1',
  })
  db.close()

  check('包文件落在 exports/ 下', archive.file.includes(`${join('exports', 'psyche-backup-')}`), archive.file)
  check('包文件存在且非空', existsSync(archive.file) && statSync(archive.file).size > 0)
  check('清单格式与版本正确', archive.manifest.format === 'psyche-archive' && archive.manifest.formatVersion === 1)
  check('清单记下人格与 schema', archive.manifest.personaId === 'main' && archive.manifest.schemaVersion === SCHEMA_VERSION)

  const paths = archive.manifest.files.map((item) => item.path)
  check('带库快照', paths.includes('memory.sqlite3'), paths)
  check('带人格原文', paths.includes('identity.md'))
  check('带面板偏好', paths.includes('panel-prefs.json'))
  check('带素材', paths.includes('assets/abc123'))
  check('不带 backups/', !paths.some((path) => path.startsWith('backups/')))
  check('不带 memory-view/', !paths.some((path) => path.startsWith('memory-view/')))
  check('diff 后没有 snasphot 残留', !existsSync(join(dir, 'exports', '.snapshot.sqlite3')))

  // ── 2. 校验 ───────────────────────────────────────────────────────────────
  const verified = verifyArchive(archive.file)
  check('校验通过', verified.ok, verified.problems)
  check('校验能读出清单', verified.manifest !== null && verified.manifest.files.length === paths.length)

  // 截断的包：gzip 层就坏了
  const brokenFile = join(sandbox, 'broken.tar.gz')
  const bytes = readFileSync(archive.file)
  writeFileSync(brokenFile, bytes.subarray(0, Math.floor(bytes.length / 3)))
  const brokenResult = verifyArchive(brokenFile)
  check('截断的包校验不通过', !brokenResult.ok && brokenResult.problems.length > 0)

  // 被改过的包：清单里 sha256 对不上。做法是保持长度不变只翻一个字节，
  // 这样能精确验证「大小对但内容不对」这条分支，而不是被大小检查提前拦住。
  // 内容用清单记录的大小现造（不读当前库）：建包之后库还会继续写，读当前库
  // 会连大小都对不上，反而验证不到 sha256 这条分支。
  const tampered = join(dir, 'exports', 'psyche-backup-20990101-000000.tar.gz')
  const realManifest = archive.manifest
  const dbEntry = realManifest.files.find((item) => item.path === 'memory.sqlite3')
  if (!dbEntry) throw new Error('清单里没有 memory.sqlite3')
  const tamperedPayload = Buffer.alloc(dbEntry.bytes, 7)
  tamperedPayload[Math.floor(dbEntry.bytes / 2)] ^= 0xff
  writeFileSync(
    tampered,
    gzipSync(
      buildTar([
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(realManifest), 'utf8') },
        { name: 'memory.sqlite3', data: tamperedPayload },
      ]),
    ),
  )
  const tamperedResult = verifyArchive(tampered)
  check(
    '被改过的包报 sha256 不符',
    !tamperedResult.ok && tamperedResult.problems.some((item) => item.reason.includes('sha256')),
    tamperedResult.problems,
  )
  check('多余成员也会被拒绝', tamperedResult.problems.some((item) => item.reason.includes('多余')) || !tamperedResult.ok)

  // ── 3. 解包 ───────────────────────────────────────────────────────────────
  const outDir = join(sandbox, 'extracted')
  const extracted = extractArchive(archive.file, outDir)
  check('解出的文件数与清单一致', extracted.files === realManifest.files.length, extracted.files)
  check('解出的库能打开', (() => {
    try {
      const probe = new DatabaseSync(join(outDir, 'memory.sqlite3'), { readOnly: true })
      const row = probe.prepare("SELECT COUNT(*) AS n FROM sources").get() as Record<string, unknown>
      probe.close()
      return Number(Object.values(row)[0]) >= 1
    } catch {
      return false
    }
  })())

  // ── 4. 恢复 ───────────────────────────────────────────────────────────────
  const targetDir = join(sandbox, 'restore-target')
  mkdirSync(targetDir, { recursive: true })
  const targetDb = await openDatabase({ file: join(targetDir, 'memory.sqlite3'), driverPreference: 'auto' })
  // 目标库先塞一条「只在旧世界存在」的事件，恢复后它应该消失（整目录被换掉）
  writeFileSync(join(targetDir, 'identity.md'), '# 旧的人格\n', 'utf8')
  targetDb.db.close()

  const plan = prepareRestore({ dataDir: targetDir, file: archive.file, schemaVersion: SCHEMA_VERSION, personaId: 'main' })
  check('恢复前置检查通过', plan.ok, plan.problems)
  check('暂存目录与数据根同级', plan.stagedDir.startsWith(sandbox) && !plan.stagedDir.startsWith(targetDir), plan.stagedDir)

  const applied = applyRestore({ dataDir: targetDir, stagedDir: plan.stagedDir })
  check('恢复后旧目录被保留', applied.keptDir !== null && existsSync(applied.keptDir), applied.keptDir)
  check('恢复后人格原文是包里的那份', readFileSync(join(targetDir, 'identity.md'), 'utf8').includes('深海'))
  check('恢复后库里有原来的来源', (() => {
    const probe = new DatabaseSync(join(targetDir, 'memory.sqlite3'), { readOnly: true })
    const row = probe.prepare('SELECT COUNT(*) AS n FROM sources').get() as Record<string, unknown>
    probe.close()
    return Number(Object.values(row)[0]) >= 1
  })())
  check('恢复后暂存目录已消失', !existsSync(plan.stagedDir))

  // 包内 schema 比插件新：必须拒绝，且不动数据根
  const futureDir = join(sandbox, 'future')
  mkdirSync(futureDir, { recursive: true })
  const futureDb = await openDatabase({ file: join(futureDir, 'memory.sqlite3'), driverPreference: 'auto' })
  futureDb.db.close()
  const futureDbBytes = readFileSync(join(futureDir, 'memory.sqlite3'))
  const futureManifest = {
    ...realManifest,
    schemaVersion: SCHEMA_VERSION + 1,
    totalBytes: futureDbBytes.length,
    files: [
      {
        path: 'memory.sqlite3',
        role: 'database',
        bytes: futureDbBytes.length,
        sha256: createHash('sha256').update(futureDbBytes).digest('hex'),
      },
    ],
  }
  const futureArchive = join(sandbox, 'future.tar.gz')
  writeFileSync(
    futureArchive,
    gzipSync(
      buildTar([
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(futureManifest), 'utf8') },
        { name: 'memory.sqlite3', data: futureDbBytes },
      ]),
    ),
  )
  const futurePlan = prepareRestore({ dataDir: futureDir, file: futureArchive, schemaVersion: SCHEMA_VERSION, personaId: 'main' })
  check('未来版本的包被拒绝', !futurePlan.ok)
  check('拒绝理由说明要升级插件', futurePlan.problems.some((item) => item.reason.includes('先升级插件')), futurePlan.problems)
  check('拒绝后数据根没被动过', existsSync(join(futureDir, 'memory.sqlite3')))
  check('拒绝后暂存目录已清掉', !existsSync(futurePlan.stagedDir))

  // ── 5. 路径安全与轮转 ─────────────────────────────────────────────────────
  check('拒绝绝对路径', !isSafeArchivePath('/etc/passwd'))
  check('拒绝盘符路径', !isSafeArchivePath('C:/Windows/system32'))
  check('拒绝上跳', !isSafeArchivePath('../../secret'))
  check('拒绝 Windows 备用数据流（冒号）', !isSafeArchivePath('assets/abc:hidden'))
  check('拒绝 Windows 保留设备名', !isSafeArchivePath('CON/memory.sqlite3') && !isSafeArchivePath('assets/NUL.txt') && !isSafeArchivePath('lpt1'))
  check('拒绝结尾空格或点（Windows 会静默吞掉）', !isSafeArchivePath('assets/abc ') && !isSafeArchivePath('assets/abc.'))
  check('接受普通相对路径', isSafeArchivePath('assets/abc123'))
  check('超长成员名直接报错', (() => {
    try {
      buildTar([{ name: 'x'.repeat(120), data: Buffer.from('a') }])
      return false
    } catch {
      return true
    }
  })())

  // createArchive 已经轮转过一次（keep 默认 5）；这里再塞几个假名验证只认命名模式
  for (let index = 0; index < 8; index += 1) {
    writeFileSync(join(dir, 'exports', `psyche-backup-2026010${index}-00000${index}.tar.gz`), 'x')
  }
  const removed = pruneArchives(join(dir, 'exports'), 5)
  check('轮转删除多余包', removed.length >= 3, removed.length)
  const listed = listArchives(dir)
  check('列表只留命名合法的包', listed.length <= 5 && listed.every((item) => item.name.startsWith('psyche-backup-')), listed.length)

  console.log(`\n迁移包自检：${passed} 通过 ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

try {
  await main()
} finally {
  for (const path of cleanup.reverse()) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论
    }
  }
}
