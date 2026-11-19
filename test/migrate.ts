/**
 * 完整人格迁移演练（迁移收口第三条，v15 §34.14 P0-3）。
 *
 * 这一份测的不是「文件哈希对得上」，而是**四层都对得上**：
 *   1. 文件层：每个文件（含 assets 里的多类型素材）sha256 与源一致；
 *   2. 数据库层：结构校验通过、表计数与清单对账；
 *   3. 应用层：恢复后插件能正常打开这个库、读到人格与阶段；
 *   4. 行为层：恢复后的数据真的能被心灵用起来（recall / context / growth 都读得到）。
 *
 * 第 4 层是关键：恢复成功 ≠ 恢复后的记忆能被用。
 *
 * 跑法：`node test/migrate.ts`（要求先 `npm run build`）
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { openDatabase } from '../dist/lib/adapter.js'
import { createArchive } from '../dist/lib/archive.js'
import { checkDatabaseFile } from '../dist/lib/dbcheck.js'
import { applyPendingRestore, confirmRestore, prepareRestorePackage, readRestoreJournal } from '../dist/lib/restore.js'
import { SCHEMA_VERSION } from '../dist/lib/schema.js'
import { Core } from '../dist/lib/store.js'

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

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

const sandbox = mkdtempSync(join(tmpdir(), 'psyche-migrate-'))

/** 把一个目录下的所有文件按相对路径收成 {路径: sha256}。 */
function digestTree(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else out[full.slice(base.length + 1).split('\\').join('/')] = sha256(full)
    }
  }
  walk(dir)
  return out
}

async function main(): Promise<void> {
  // ── 造一个「有内容的人格」：文件 + 多类型素材 + 库里的记忆 ────────────────
  const home = join(sandbox, 'home')
  mkdirSync(join(home, 'assets', 'images'), { recursive: true })
  mkdirSync(join(home, 'assets', 'audio'), { recursive: true })
  mkdirSync(join(home, 'assets', 'documents'), { recursive: true })
  const opened = await openDatabase({ file: join(home, 'memory.sqlite3'), driverPreference: 'auto' })
  const db = opened.db
  const core = new Core({ db, config: {}, dataDir: home })

  await core.capture({ text: '主人说他想去看鲸，从深海开始。', channel: 'desktop', sessionRef: 'sess-migrate-1', origin: 'user' })
  const remembered = await core.remember({
    text: '主人说过最喜欢深海里的鲸鱼。',
    kind: 'fact',
    statement: '主人喜欢深海里的鲸鱼。',
    confidence: 'high',
    sessionRef: 'sess-migrate-1',
    // E5.1：recall 只返回 public；恢复演练要验证「恢复后仍能被普通检索找回」
    disclosure: 'public',
  })
  check('源数据里长出了一条结论', Boolean(remembered.artifactId), remembered)

  writeFileSync(join(home, 'identity.md'), '# 心灵\n\n她住在深海里，是一只鲸。\n', 'utf8')
  writeFileSync(join(home, 'persona.json'), JSON.stringify({ name: '心灵', tone: 'quiet' }, null, 2), 'utf8')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ affinity: { neutral: 50 } }, null, 2), 'utf8')
  writeFileSync(join(home, 'panel-prefs.json'), JSON.stringify({ sea: true, promptSection: null }), 'utf8')
  writeFileSync(join(home, 'assets', 'images', 'sample.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]))
  writeFileSync(join(home, 'assets', 'audio', 'sample.wav'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(64, 7)]))
  writeFileSync(join(home, 'assets', 'documents', 'sample.pdf'), Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'))

  const counts: Record<string, number> = {}
  for (const table of ['sources', 'events', 'artifacts', 'artifact_revisions', 'artifact_evidence']) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    counts[table] = Number(row.n)
  }
  const archive = createArchive({
    db,
    dataDir: home,
    counts,
    version: 'test',
    schemaVersion: SCHEMA_VERSION,
    algorithmVersion: 'grow-1',
  })
  const sourceDigests = digestTree(home)
  db.close()

  // ── 阶段 A：在线准备（空人格直接进）──────────────────────────────────────
  const target = join(sandbox, 'target')
  mkdirSync(target, { recursive: true })
  const plan = prepareRestorePackage({ dataDir: target, file: archive.file, schemaVersion: SCHEMA_VERSION, personaId: 'main' })
  check('预检通过并给出包 ID', plan.ok && plan.packageId.length > 0, plan)
  check('空人格判定为 adopt', plan.mode === 'adopt', plan.mode)
  check('没有动目标数据根', !existsSync(join(target, 'memory.sqlite3')))

  const confirmed = confirmRestore({
    dataDir: target,
    restoreId: plan.restoreId,
    version: 'test',
    schemaVersion: SCHEMA_VERSION,
    algorithmVersion: 'grow-1',
  })
  check('确认后进入待应用', confirmed.phase === 'pending', confirmed)

  // ── 阶段 B：下次启动应用（这里直接调）────────────────────────────────────
  const applied = applyPendingRestore({ dataDir: target })
  check('启动时应用成功', applied.ok && applied.applied, applied)
  check('旧目录被保留', applied.keptDir === null || existsSync(applied.keptDir), applied.keptDir)

  // ── 第 1 层：文件层 ──────────────────────────────────────────────────────
  const restoredDigests = digestTree(target)
  // 库文件不比 sha256：VACUUM INTO + WAL checkpoint 会合法改写它（第 2 层校验才是它的判据）
  const expectedFiles = Object.keys(sourceDigests).filter(
    (path) => !path.startsWith('exports/') && !path.startsWith('backups/') && !path.startsWith('memory.sqlite3'),
  )
  const mismatched = expectedFiles.filter((path) => restoredDigests[path] !== sourceDigests[path])
  check('用户文件逐个 sha256 与源一致', mismatched.length === 0, mismatched)
  check('素材目录整棵搬过来', ['assets/images/sample.png', 'assets/audio/sample.wav', 'assets/documents/sample.pdf'].every((path) => restoredDigests[path] === sourceDigests[path]))
  check('人格原文是恢复后的', readFileSync(join(target, 'identity.md'), 'utf8').includes('深海'))

  // ── 第 2 层：数据库层 ────────────────────────────────────────────────────
  const structure = checkDatabaseFile({
    file: join(target, 'memory.sqlite3'),
    expectedVersion: SCHEMA_VERSION,
    personaId: 'main',
    expectedCounts: counts,
  })
  check('恢复后的库结构校验通过', structure.ok, structure.problems)
  check(
    '表计数与清单对账一致',
    Object.entries(counts).every(([table, expected]) => structure.facts.counts[table] === expected),
    { expected: counts, actual: structure.facts.counts },
  )
  check('清单里的计数也是真数', archive.manifest.counts.events === counts.events && archive.manifest.counts.sources === counts.sources, archive.manifest.counts)

  // ── 第 3 层：应用层（插件能正常打开这份人格）─────────────────────────────
  const reopened = await openDatabase({ file: join(target, 'memory.sqlite3'), driverPreference: 'auto' })
  const restoredCore = new Core({ db: reopened.db, config: {}, dataDir: target })
  const state = await restoredCore.getState()
  check('人格 id 是 main', state.persona.id === 'main', state.persona)
  check('阶段在四个合法值里', ['trust', 'autonomy', 'initiative', 'integration'].includes(state.phase.phase), state.phase)
  const prefs = JSON.parse(readFileSync(join(target, 'panel-prefs.json'), 'utf8')) as { sea?: boolean }
  check('面板偏好原样保留', prefs.sea === true, prefs)

  // ── 第 4 层：行为层（恢复后的记忆真的能被用起来）────────────────────────
  const recalled = await restoredCore.recall({ text: '鲸鱼' }, { surface: 'personal' })
  check('recall 能找回恢复后的结论', recalled.results.length > 0, recalled.results)
  const stances = await restoredCore.stances({ kind: 'fact' })
  check('stances 能读出恢复后的结论', stances.items.length > 0, stances.items)
  const context = await restoredCore.context()
  check('context 能给出最小上下文', context.persona.id === 'main' && typeof context.note === 'string', context)
  const growth = await restoredCore.getGrowth()
  check('成长派生在恢复后的库上能算', growth.algorithmVersion === 'grow-1', growth.algorithmVersion)
  const fetched = await restoredCore.fetch([remembered.artifactId as string], 400)
  check('fetch 能按 id 取回原文', fetched.items.length > 0, fetched.items)
  const sources = reopened.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM sources')[0]
  check('恢复后的库里有来源（不只是空壳）', Number(sources?.n ?? 0) >= 1, sources)
  reopened.db.close()

  // ── 收尾：状态文件保留成 completed（这是「这次恢复发生过」的证据，不删）──
  const finalJournal = readRestoreJournal(target)
  check('状态文件保留成 completed', finalJournal?.phase === 'completed', finalJournal)

  rmSync(sandbox, { recursive: true, force: true })
  console.log(`\n完整人格迁移演练：${pass} 通过 ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
