// P2-FTS5 E3 第二批：真实进程强杀恢复（CRASH-01~09，部分）。
//
// 做法：子进程在写事务的指定阶段写 ready 文件后停住，父进程用 taskkill /F 真杀；
// 重开库后依次检查 integrity_check、foreign_key_check、verifyFtsIndex、head 唯一性，
// 再断言「未提交的改动回滚 / 已提交的改动保留」。
//
// 跑法：node test/crash-recovery.ts（需要先 npm run build）
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../dist/lib/adapter.js'
import { rebuildFtsIndex, upsertFtsRow, verifyFtsIndex } from '../dist/lib/fts.js'

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

const log = { info() {}, debug() {}, warn() {}, error() {} }
const AT = '2026-11-02T00:00:00.000Z'
const childPath = join(process.cwd(), 'test', 'helpers', 'crash-child.mjs')

/** 建一个 v6 库，放一条 source、一条 artifact（r1 active）和对应 FTS 行。 */
async function prepareDb() {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-crash-'))
  const file = join(dir, 'memory.sqlite3')
  const opened = await openDatabase({ file, driverPreference: 'auto', logger: log })
  const db = opened.db
  db.run(
    `INSERT INTO sources (source_id, persona_id, platform, channel, session_ref, origin, kind, text, captured_at, created_at)
     VALUES ('src_crash', 'main', 'dsh', 'desktop', 'crash-s1', 'user', 'message', '崩溃夹具来源。', ?, ?)`,
    [AT, AT],
  )
  db.run(`INSERT INTO artifacts (artifact_id, persona_id, kind, created_at, updated_at) VALUES ('art_crash', 'main', 'fact', ?, ?)`, [
    AT,
    AT,
  ])
  db.run(
    `INSERT INTO artifact_revisions (artifact_id, revision, state, statement, subject_refs, payload, confidence,
       basis_count, independent_evidence_count, salience, temporal, direct_extraction, created_at, updated_at, disclosure, schema_version)
     VALUES ('art_crash', 1, 'active', '崩溃夹具的初始结论。', '["main"]', '{}', 'medium', 1, 1, 0.5, '{}', 0, ?, ?, 'public', '1.0')`,
    [AT, AT],
  )
  // 用生产写入器落索引行，保证 bigram_text 与 statement 真正一致（否则 verify 会报内容不一致）
  upsertFtsRow(db, { artifactId: 'art_crash', kind: 'fact', statement: '崩溃夹具的初始结论。' })
  db.close()
  return { dir, file }
}

function waitForFile(path, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`等 ready 超时：${path}`))
      }
    }, 20)
  })
}

/** 起子进程 → 等 ready → taskkill /F → 等退出。 */
async function crash(mode, dbFile, dir) {
  const ready = join(dir, `ready-${mode}.json`)
  const child = spawn(process.execPath, [childPath, mode, dbFile, ready], { stdio: ['ignore', 'ignore', 'pipe'] })
  await waitForFile(ready)
  const killed = spawnSync('taskkill', ['/F', '/PID', String(child.pid)], { stdio: 'ignore' })
  if (killed.status !== 0) child.kill('SIGKILL')
  await new Promise((resolve) => child.on('exit', resolve))
}

/** 只读检查：完整性、外键、索引与 head 的一致性。 */
async function inspect(dbFile) {
  const raw = new DatabaseSync(dbFile)
  const integrity = raw.prepare('PRAGMA integrity_check').all()
  const fk = raw.prepare('PRAGMA foreign_key_check').all()
  const revisions = raw.prepare(`SELECT revision, state FROM artifact_revisions WHERE artifact_id='art_crash' ORDER BY revision`).all()
  const ftsRows = raw.prepare(`SELECT ref_id FROM fts_index ORDER BY rowid`).all()
  raw.close()
  return {
    integrityOk: integrity.length === 1 && integrity[0].integrity_check === 'ok',
    fkCount: fk.length,
    revisions: revisions.map((row) => `${row.revision}:${row.state}`),
    ftsRefs: ftsRows.map((row) => row.ref_id),
  }
}

console.log('\n[P2-FTS5 E3-2] 真实进程强杀恢复')

const scenarios = [
  { mode: 'after-begin', label: 'BEGIN 之后', expectRevisions: ['1:active'], expectFts: ['art_crash'] },
  { mode: 'after-revision', label: '插 revision 之后', expectRevisions: ['1:active'], expectFts: ['art_crash'] },
  { mode: 'after-fts-delete', label: 'FTS 删旧行之后', expectRevisions: ['1:active'], expectFts: ['art_crash'] },
  { mode: 'after-fts-insert', label: 'FTS 插新行之后', expectRevisions: ['1:active'], expectFts: ['art_crash'] },
  { mode: 'after-superseded', label: '旧版本 superseded 之后', expectRevisions: ['1:active'], expectFts: ['art_crash'] },
  { mode: 'after-commit', label: 'COMMIT 之后', expectRevisions: ['1:active', '2:active'], expectFts: ['art_crash'] },
  { mode: 'rebuild-mid', label: 'rebuild 清理后', expectRevisions: ['1:active'], expectFts: ['art_crash'] },
  { mode: 'forget-mid', label: 'forget 处理中', expectRevisions: ['1:active'], expectFts: ['art_crash'] },
]

for (const scenario of scenarios) {
  console.log(`\n  -- ${scenario.label}（${scenario.mode}）`)
  const { dir, file } = await prepareDb()
  await crash(scenario.mode, file, dir)
  const state = await inspect(file)
  ok('强杀后 integrity_check 通过', state.integrityOk, state)
  eq('强杀后外键无违规', state.fkCount, 0)
  eq('revision 状态符合回滚/提交预期', state.revisions, scenario.expectRevisions)
  eq('FTS 行符合回滚/提交预期', state.ftsRefs, scenario.expectFts)

  const opened = await openDatabase({ file, driverPreference: 'auto', logger: log })
  const report = verifyFtsIndex(opened.db)
  if (scenario.mode === 'after-commit') {
    // 手工事务没走 Core 的 FTS 双写，提交后索引缺新 head 是预期内的；rebuild 后必须一致
    ok(
      'COMMIT 后 verify 明确报出缺失或内容不一致（不静默）',
      report.missing.includes('art_crash') || report.contentMismatch.includes('art_crash'),
      report,
    )
    rebuildFtsIndex(opened.db)
    const rebuilt = verifyFtsIndex(opened.db)
    eq(
      'rebuild 后缺失/重复/内容不一致清零',
      [rebuilt.missing.length, rebuilt.duplicate.length, rebuilt.contentMismatch.length],
      [0, 0, 0],
    )
  } else {
    eq(
      '未提交场景 verify 无缺失/无重复/无内容不一致',
      [report.missing.length, report.duplicate.length, report.contentMismatch.length],
      [0, 0, 0],
    )
  }
  opened.db.close()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

console.log(`\n[crash-recovery] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
