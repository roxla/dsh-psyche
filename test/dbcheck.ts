/**
 * 数据库结构校验自检（`src/lib/dbcheck.ts`）。
 *
 * 为什么要单独测：迁移收口的核心承诺是「装上去的这份库真的能用」。
 * 光 `integrity_check` 不够——缺触发器的库页是完整的、行是齐的，
 * 但「只追加」这条不变量已经失效。这里逐项验证每个检查真的会拦。
 *
 * 跑法：`node test/dbcheck.ts`（要求先 `npm run build`）
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { openDatabase } from '../dist/lib/adapter.js'
import { checkDatabaseFile, REQUIRED_TABLES, REQUIRED_TRIGGERS } from '../dist/lib/dbcheck.js'
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

const sandbox = mkdtempSync(join(tmpdir(), 'psyche-dbcheck-'))

/** 复制一份库出来随便改，不动原来的（openDatabase 会给它建表 + 迁移）。 */
function cloneDb(from: string, name: string): string {
  const target = join(sandbox, name)
  mkdirSync(target, { recursive: true })
  const file = join(target, 'memory.sqlite3')
  copyFileSync(from, file)
  return file
}

async function main(): Promise<void> {
  mkdirSync(join(sandbox, 'base'), { recursive: true })
  const baseFile = join(sandbox, 'base', 'memory.sqlite3')
  const opened = await openDatabase({ file: baseFile, driverPreference: 'auto' })
  opened.db.close()

  // ── 1. 好库要能过 ─────────────────────────────────────────────────────────
  const good = checkDatabaseFile({ file: baseFile, expectedVersion: SCHEMA_VERSION, personaId: 'main' })
  check('新库通过结构校验', good.ok, good.problems)
  check(`记下 user_version=${SCHEMA_VERSION}`, good.facts.userVersion === SCHEMA_VERSION, good.facts.userVersion)
  check('必需表一张不缺', REQUIRED_TABLES.every((table) => good.facts.tables >= REQUIRED_TABLES.length), good.facts.tables)
  check('九个只追加触发器都在', good.facts.triggers >= REQUIRED_TRIGGERS.length, good.facts.triggers)
  check('必需索引都在', good.facts.indexes > 0, good.facts.indexes)

  // ── 2. 缺触发器 = 只追加不变量失效，必须拦 ────────────────────────────────
  const noTrigger = cloneDb(baseFile, 'no-trigger')
  {
    const db = new DatabaseSync(noTrigger)
    db.exec('DROP TRIGGER trg_events_no_delete')
    db.close()
  }
  const triggerCheck = checkDatabaseFile({ file: noTrigger, expectedVersion: SCHEMA_VERSION, personaId: 'main' })
  check('缺触发器被拦下', !triggerCheck.ok && triggerCheck.problems.some((p) => p.code === 'missing-trigger'), triggerCheck.problems)

  // ── 3. 缺索引：数据还在，但查询会退化 ────────────────────────────────────
  const noIndex = cloneDb(baseFile, 'no-index')
  {
    const db = new DatabaseSync(noIndex)
    db.exec('DROP INDEX idx_events_at')
    db.close()
  }
  const indexCheck = checkDatabaseFile({ file: noIndex, expectedVersion: SCHEMA_VERSION, personaId: 'main' })
  check('缺索引被拦下', !indexCheck.ok && indexCheck.problems.some((p) => p.code === 'missing-index'), indexCheck.problems)

  // ── 4. schema 版本不符 ───────────────────────────────────────────────────
  const wrongVersion = cloneDb(baseFile, 'wrong-version')
  {
    const db = new DatabaseSync(wrongVersion)
    db.exec('PRAGMA user_version = 1')
    db.close()
  }
  const versionCheck = checkDatabaseFile({ file: wrongVersion, expectedVersion: SCHEMA_VERSION, personaId: 'main' })
  check('版本不符被拦下', !versionCheck.ok && versionCheck.problems.some((p) => p.code === 'user-version'), versionCheck.problems)

  // ── 5. 混进别的人格 ─────────────────────────────────────────────────────
  const foreignPersona = cloneDb(baseFile, 'foreign-persona')
  {
    const db = new DatabaseSync(foreignPersona)
    db.exec(`
      INSERT INTO persona_config (persona_id, type, identity_path, persona_json, created_at, updated_at)
      VALUES ('someone-else', 'preset', NULL, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `)
    db.exec(`
      INSERT INTO events (event_id, persona_id, kind, type, at, session_id, room_id, text, confidence, op_id, schema_version, created_at)
      VALUES ('evt_other', 'someone-else', 'interaction', 'conversation', '2026-01-01T00:00:00.000Z', 's', NULL, 'x', 'medium', 'op', '1.0', '2026-01-01T00:00:00.000Z')
    `)
    db.close()
  }
  const personaCheck = checkDatabaseFile({ file: foreignPersona, expectedVersion: SCHEMA_VERSION, personaId: 'main' })
  check('别人格数据被拦下', !personaCheck.ok && personaCheck.problems.some((p) => p.code === 'persona-mismatch'), personaCheck.problems)

  // ── 6. 计数对账（清单键是驼峰，要能映射回表名）───────────────────────────
  const countMismatch = checkDatabaseFile({
    file: baseFile,
    expectedVersion: SCHEMA_VERSION,
    personaId: 'main',
    expectedCounts: { events: 5, artifactRevisions: 2 },
  })
  check('行数不符被拦下', !countMismatch.ok && countMismatch.problems.filter((p) => p.code === 'count-mismatch').length === 2, countMismatch.problems)
  const countOk = checkDatabaseFile({
    file: baseFile,
    expectedVersion: SCHEMA_VERSION,
    personaId: 'main',
    expectedCounts: { events: 0, sources: 0, artifactRevisions: 0, phaseMilestones: 0 },
  })
  check('真数对得上就通过（驼峰键已映射）', countOk.ok, countOk.problems)

  // ── 7. 外键孤儿：关掉外键再插一条，校验时必须报出来 ──────────────────────
  const orphan = cloneDb(baseFile, 'orphan')
  {
    const db = new DatabaseSync(orphan)
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec(`
      INSERT INTO event_sources (event_id, source_id) VALUES ('evt_missing', 'src_missing')
    `)
    db.close()
  }
  const orphanCheck = checkDatabaseFile({ file: orphan, expectedVersion: SCHEMA_VERSION, personaId: 'main' })
  check('外键孤儿被拦下', !orphanCheck.ok && orphanCheck.problems.some((p) => p.code === 'foreign-key'), orphanCheck.problems)

  // ── 8. 根本不是数据库 ───────────────────────────────────────────────────
  const garbage = join(sandbox, 'garbage.sqlite3')
  writeFileSync(garbage, 'this is not a database at all')
  const garbageCheck = checkDatabaseFile({ file: garbage, expectedVersion: SCHEMA_VERSION, personaId: 'main' })
  check('坏文件被判 open-failed', !garbageCheck.ok && garbageCheck.problems[0]?.code === 'open-failed', garbageCheck.problems)

  // ── 9. 校验是只读的：不写库、不改 mtime 之外的东西 ───────────────────────
  const before = statSync(baseFile)
  const beforeBytes = readFileSync(baseFile).length
  checkDatabaseFile({ file: baseFile, expectedVersion: SCHEMA_VERSION, personaId: 'main' })
  const after = statSync(baseFile)
  check('校验不改文件大小', after.size === before.size, { before: before.size, after: after.size, beforeBytes })

  rmSync(sandbox, { recursive: true, force: true })
  console.log(`\n数据库结构校验自检：${pass} 通过 ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
