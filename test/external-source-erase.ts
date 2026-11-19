// P5-R-3a 外部来源物理擦除测试。
//
// 验收口径（docs/design/p5-r3-layered-deletion.md）：
// - 状态机 active/logical_deleted/erase_pending/erase_failed/erased；
// - 物理擦除必须先逻辑下线，Owner 必须 os:<SID/UID>；
// - 绕过 append-only 触发器时 DROP → UPDATE → 重建，并校验 DDL 哈希；
// - 擦除后正文为占位、审计事件仍在、FTS 无正文命中、触发器仍在；
// - 失败保持 erase_failed 且不可召回；重开数据库后可从 pending 幂等继续；
// - 两种驱动（node:sqlite / better-sqlite3）都要通过。
//
// 跑法：node test/external-source-erase.ts（需要先 npm run build）
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '../packages/core/dist/adapter.js'
import { recordExternalSource, requestExternalSourceDeletion } from '../packages/core/dist/external-source.js'
import {
  beginErase,
  completeErase,
  eraseProofDigest,
  eraseSourceContent,
  eraseStatusOf,
  eraseTriggerDdl,
  failErase,
  latestEraseEvent,
  requestErase,
  triggerDdlHash,
} from '../packages/core/dist/external-source-erase.js'

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
function eq(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}
function throws(label: string, fn: () => unknown, code: string): void {
  try {
    fn()
    ok(label, false, { thrown: 'none' })
  } catch (error) {
    eq(label, (error as Error).message, code)
  }
}

const log = { info() {}, debug() {}, warn() {}, error() {} }
const OWNER = 'os:S-1-5-21-1000'
const dirs: string[] = []
let seq = 0

async function freshDb(driver: string): Promise<{ db: any; file: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-erase-'))
  dirs.push(dir)
  const file = join(dir, 'memory.sqlite3')
  const opened = await openDatabase({ file, driverPreference: driver, logger: log })
  migrate(opened.db, log)
  return { db: opened.db, file }
}

function addSource(db: any, text: string): string {
  seq += 1
  const id = `src_erase_${seq}`
  db.prepare(
    `INSERT INTO sources (source_id, persona_id, platform, channel, origin, kind, text, captured_at, created_at)
     VALUES (?, 'main', 'test', 'web', 'external', 'page', ?, '2026-11-15T02:00:00.000Z', '2026-11-15T02:00:00.000Z')`,
  ).run(id, text)
  recordExternalSource(db, {
    sourceId: id,
    kind: 'web',
    provenance: 'test://erase',
    content: text,
    scope: 'personal',
    disclosure: 'public',
    createdBy: OWNER,
  })
  return id
}

function logicalDelete(db: any, sourceId: string): void {
  requestExternalSourceDeletion(db, { sourceId, by: OWNER, action: 'delete', reason: 'test' })
}

async function scenario(driver: string): Promise<void> {
  const { db, file } = await freshDb(driver)
  const text = '这是一段外部正文，包含唯一标记 ERASE-MARKER-7731。'
  const sourceId = addSource(db, text)
  eq(`${driver}: initially active`, eraseStatusOf(db, sourceId), 'not_logically_deleted')
  throws(`${driver}: erase before logical delete`, () => requestErase(db, { sourceId, by: OWNER }), 'E_ERASE_REQUIRES_LOGICAL_DELETE')

  logicalDelete(db, sourceId)
  eq(`${driver}: logical deleted`, eraseStatusOf(db, sourceId), 'logical_deleted')
  throws(`${driver}: bad owner`, () => requestErase(db, { sourceId, by: 'user:test' }), 'E_OWNER_UNVERIFIED')
  const requested = requestErase(db, { sourceId, by: OWNER })
  eq(`${driver}: pending`, eraseStatusOf(db, sourceId), 'erase_pending')
  eq(`${driver}: request event`, requested.action, 'erase_request')
  eq(`${driver}: request stores original hash`, requested.proofDigest, createHash('sha256').update(text, 'utf8').digest('hex'))

  beginErase(db, { sourceId, by: OWNER })
  const ddlBefore = eraseTriggerDdl(db)
  ok(`${driver}: sources trigger present`, ddlBefore.length >= 1)
  const proof = eraseSourceContent(db, { sourceId, by: OWNER })
  ok(`${driver}: proof hash`, /^[0-9a-f]{64}$/.test(proof.contentSha256))
  eq(`${driver}: fts zero hits`, proof.ftsHits, 0)
  ok(`${driver}: fts integrity`, proof.ftsIntegrity)
  const row = db.prepare('SELECT text FROM sources WHERE source_id = ?').get(sourceId) as { text: string }
  eq(`${driver}: text placeholder`, row.text, '[erased]')
  eq(`${driver}: trigger restored`, triggerDdlHash(eraseTriggerDdl(db)), triggerDdlHash(ddlBefore))
  ok(`${driver}: metadata still there`, !!db.prepare('SELECT source_id FROM external_sources WHERE source_id = ?').get(sourceId))

  const digest = eraseProofDigest(proof)
  completeErase(db, { sourceId, by: OWNER, proofDigest: digest })
  eq(`${driver}: erased`, eraseStatusOf(db, sourceId), 'erased')
  eq(`${driver}: latest event`, latestEraseEvent(db, sourceId)?.action, 'erased')
  throws(`${driver}: erase again`, () => requestErase(db, { sourceId, by: OWNER }), 'E_ALREADY_ERASED')
  throws(`${driver}: erase event append-only`, () => {
    db.prepare("UPDATE external_source_erase_events SET stage = 'x' WHERE source_id = ?").run(sourceId)
  }, 'external source erase events are append-only')

  // 失败路径 + 重试：erase_failed 仍不可召回，重试后可 erased。
  const text2 = '第二段外部正文，唯一标记 ERASE-MARKER-8822。'
  const source2 = addSource(db, text2)
  logicalDelete(db, source2)
  requestErase(db, { sourceId: source2, by: OWNER })
  beginErase(db, { sourceId: source2, by: OWNER })
  const partial = eraseSourceContent(db, { sourceId: source2, by: OWNER })
  failErase(db, { sourceId: source2, by: OWNER, stage: 'vacuum', errorCode: 'E_TEST_FAIL' })
  eq(`${driver}: failed status`, eraseStatusOf(db, source2), 'erase_failed')
  ok(`${driver}: failed still hidden`, !db.prepare(
    "SELECT 1 FROM external_sources WHERE source_id = ? AND NOT EXISTS (SELECT 1 FROM external_source_deletion_events d WHERE d.source_id = external_sources.source_id AND d.action IN ('delete','purge'))",
  ).get(source2))
  const req2 = requestErase(db, { sourceId: source2, by: OWNER })
  eq(`${driver}: retry reuses request`, req2.sourceId, source2)
  beginErase(db, { sourceId: source2, by: OWNER })
  const proof2 = eraseSourceContent(db, { sourceId: source2, by: OWNER })
  eq(`${driver}: retry preserves original hash`, proof2.contentSha256, partial.contentSha256)
  completeErase(db, { sourceId: source2, by: OWNER, proofDigest: eraseProofDigest(proof2) })
  eq(`${driver}: retry erased`, eraseStatusOf(db, source2), 'erased')

  // 崩溃恢复：pending 状态下重开数据库，仍可继续。
  const text3 = '第三段外部正文，唯一标记 ERASE-MARKER-9933。'
  const source3 = addSource(db, text3)
  logicalDelete(db, source3)
  requestErase(db, { sourceId: source3, by: OWNER })
  await db.close()
  const reopened = await openDatabase({ file, driverPreference: driver, logger: log })
  migrate(reopened.db, log)
  eq(`${driver}: pending survives reopen`, eraseStatusOf(reopened.db, source3), 'erase_pending')
  beginErase(reopened.db, { sourceId: source3, by: OWNER })
  const proof3 = eraseSourceContent(reopened.db, { sourceId: source3, by: OWNER })
  completeErase(reopened.db, { sourceId: source3, by: OWNER, proofDigest: eraseProofDigest(proof3) })
  eq(`${driver}: recovered erased`, eraseStatusOf(reopened.db, source3), 'erased')
  await reopened.db.close()
}

async function main(): Promise<void> {
  const drivers = ['node:sqlite', 'better-sqlite3']
  for (const driver of drivers) {
    try {
      await scenario(driver)
    } catch (error) {
      failed += 1
      console.log(`  FAIL ${driver} scenario crashed -> ${(error as Error).message}`)
    }
  }
}

main().then(() => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 句柄延迟释放 */ }
  }
  console.log(`[P5-R-3a external-source-erase] ${passed} 通过 ${failed} 失败`)
  process.exit(failed === 0 ? 0 : 1)
}).catch(error => {
  console.error(error)
  process.exit(1)
})
