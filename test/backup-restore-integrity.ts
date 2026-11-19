// E6-B4 恢复后数据完整性：恢复成功不等于「库能打开」。
//
// 验收点（用户 E6-B4）：
// 1. integrity_check ok、foreign_key_check 0；
// 2. Artifact head 唯一、Revision 历史完整、Evidence 引用正确；
// 3. Source / Event 数量与关联完整；
// 4. FTS missing / orphan / duplicate / contentMismatch 全 0；
// 5. Grant 的已消费 / 已撤销状态保持不变；
// 6. disclosure 与 disclosure_source 逐条不变；
// 7. 已遗忘的结论不因恢复而复活。
//
// 直接对着构建产物跑：node test/backup-restore-integrity.ts（需先 npm run build）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../dist/lib/adapter.js'
import { Core } from '../dist/lib/store.js'
import { SCHEMA_VERSION } from '../dist/lib/schema.js'
import { createArchive } from '../dist/lib/archive.js'
import { applyPendingRestore, confirmRestore, prepareRestorePackage } from '../dist/lib/restore.js'
import { verifyFtsIndex } from '../dist/lib/fts.js'

let passed = 0
let failed = 0

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

const sandbox = mkdtempSync(join(tmpdir(), 'psyche-b4-'))

function query(file, sql, params = []) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

function snapshot(file) {
  const heads = query(
    file,
    `SELECT a.artifact_id, r.revision, r.state, r.disclosure, r.disclosure_source
       FROM artifacts a
       JOIN artifact_revisions r ON r.artifact_id = a.artifact_id AND r.revision = (
         SELECT MAX(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id
       )
      ORDER BY a.artifact_id`,
  )
  return {
    artifacts: query(file, 'SELECT COUNT(*) AS n FROM artifacts')[0].n,
    revisions: query(file, 'SELECT COUNT(*) AS n FROM artifact_revisions')[0].n,
    evidence: query(file, 'SELECT COUNT(*) AS n FROM artifact_evidence')[0].n,
    sources: query(file, 'SELECT COUNT(*) AS n FROM sources')[0].n,
    events: query(file, 'SELECT COUNT(*) AS n FROM events')[0].n,
    heads,
    grants: query(file, 'SELECT grant_id, used_at, revoked_at FROM disclosure_grants ORDER BY grant_id'),
  }
}

async function seed(dir) {
  const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'node:sqlite' })
  const db = opened.db
  const core = new Core({ db, config: {}, logger: { info() {}, debug() {}, warn() {}, error() {} }, dataDir: dir })

  const src = await core.capture({
    platform: 'desktop',
    channel: 'desktop',
    externalRoomId: 'local',
    stableUserId: 'owner',
    displayName: '主人',
    origin: 'user',
    kind: 'message',
    text: '我住在城东，喜欢喝美式。',
    sessionRef: 'sess-b4',
  })

  // 普通 public + 多 revision
  const publicFact = await core.remember({
    text: '主人喜欢喝美式。',
    kind: 'fact',
    statement: '主人喜欢喝美式。',
    sourceIds: src.sourceId,
    disclosure: 'public',
  })
  await core.revise({
    artifactId: publicFact.artifactId,
    statement: '主人喜欢喝美式，不加糖。',
    refs: [src.sourceId],
    disclosure: 'public',
  })

  // restricted / secret
  await core.remember({ text: '主人住在城东某小区。', kind: 'fact', statement: '主人住在城东某小区。', disclosure: 'restricted' })
  await core.remember({ text: '主人的银行卡尾号 8899。', kind: 'fact', statement: '主人的银行卡尾号 8899。', disclosure: 'secret' })

  // 敏感内容 + grant 提升为 public（消费一张 grant）
  const sensitive = await core.remember({
    text: '主人的身份证号是 110101199001011234。',
    kind: 'fact',
    statement: '主人的身份证号是 110101199001011234。',
    disclosure: 'restricted',
  })
  const grant = await core.grantDisclosure({ artifactId: sensitive.artifactId, grantedBy: 'host:owner' })
  await core.revise({
    artifactId: sensitive.artifactId,
    statement: '主人的身份证号是 110101199001011234。',
    refs: [sensitive.artifactId],
    disclosure: 'public',
    disclosureGrant: grant.grantId,
  })

  // 已撤销的 grant：另签一张再撤销
  const revokable = await core.remember({
    text: '主人的手机号是 13800001234。',
    kind: 'fact',
    statement: '主人的手机号是 13800001234。',
    disclosure: 'restricted',
  })
  const grant2 = await core.grantDisclosure({ artifactId: revokable.artifactId, grantedBy: 'host:owner' })
  await core.revokeDisclosureGrant({ grantId: grant2.grantId, revokedBy: 'host:owner' })

  // 已遗忘的结论
  const forgotten = await core.remember({
    text: '主人以前养过一只叫团子的猫。',
    kind: 'fact',
    statement: '主人以前养过一只叫团子的猫。',
    disclosure: 'public',
  })
  await core.forget({ artifactId: forgotten.artifactId })

  return { opened, db, src }
}

async function main() {
  const sourceDir = join(sandbox, 'source', 'data')
  mkdirSync(sourceDir, { recursive: true })
  const { opened, src } = await seed(sourceDir)
  const db = opened.db

  // 备份前快照
  const before = snapshot(join(sourceDir, 'memory.sqlite3'))
  ok('备份前有 6 条 artifact', before.artifacts === 6, before.artifacts)
  ok('备份前有已消费 grant', before.grants.some((row) => row.used_at !== null))
  ok('备份前有已撤销 grant', before.grants.some((row) => row.revoked_at !== null))
  const forgottenHead = before.heads.find((row) => row.state === 'forgotten')
  ok('备份前遗忘状态在', forgottenHead !== undefined, before.heads)

  writeFileSync(join(sourceDir, 'identity.md'), '# 心灵\n\n她是深海里的鲸。\n', 'utf8')
  const archive = createArchive({
    db,
    dataDir: sourceDir,
    counts: {},
    version: 'test',
    schemaVersion: SCHEMA_VERSION,
    algorithmVersion: 'grow-1',
    kind: 'backup',
    driver: 'node:sqlite',
  })

  // 目标：空库 → prepare（adopt）→ confirm
  const targetDir = join(sandbox, 'target', 'data')
  mkdirSync(targetDir, { recursive: true })
  const target = await openDatabase({ file: join(targetDir, 'memory.sqlite3'), driverPreference: 'node:sqlite' })
  const plan = prepareRestorePackage({ dataDir: targetDir, file: archive.file, schemaVersion: SCHEMA_VERSION, db: target.db })
  confirmRestore({ dataDir: targetDir, restoreId: plan.restoreId, db: target.db, version: 'test', schemaVersion: SCHEMA_VERSION, algorithmVersion: 'grow-1' })
  target.db.close()
  db.close()

  // 真实启动门禁：在 openDatabase 之前应用
  const applied = applyPendingRestore({ dataDir: targetDir })
  ok('恢复应用成功', applied.applied === true, applied.reason)

  // 恢复后逐项检查
  const restoredFile = join(targetDir, 'memory.sqlite3')
  const integrity = query(restoredFile, 'PRAGMA integrity_check')
  eq('integrity_check ok', integrity.map((row) => Object.values(row)[0]), ['ok'])
  eq('foreign_key_check 为空', query(restoredFile, 'PRAGMA foreign_key_check').length, 0)

  const after = snapshot(restoredFile)
  eq('artifact 数不变', after.artifacts, before.artifacts)
  eq('revision 数不变', after.revisions, before.revisions)
  eq('evidence 数不变', after.evidence, before.evidence)
  eq('source 数不变', after.sources, before.sources)
  eq('event 数不变', after.events, before.events)
  eq('每个 artifact 的 head 逐条不变', after.heads, before.heads)
  eq('grant 状态逐条不变', after.grants, before.grants)

  const restoredForgotten = after.heads.find((row) => row.artifact_id === forgottenHead.artifact_id)
  eq('遗忘结论没有复活', restoredForgotten?.state, 'forgotten')
  const grantHead = after.heads.find((row) => row.disclosure_source === 'grant')
  eq('grant 来源的 disclosure_source 保持', grantHead?.disclosure_source, 'grant')
  eq('grant 来源的 disclosure 保持 public', grantHead?.disclosure, 'public')

  // 用真实适配器打开恢复后的库（会跑一次幂等迁移），再验 FTS
  const restored = await openDatabase({ file: restoredFile, driverPreference: 'node:sqlite' })
  const fts = verifyFtsIndex(restored.db)
  restored.db.close()
  eq('FTS missing=0', fts.missing.length, 0)
  eq('FTS orphan=0', fts.orphan.length, 0)
  eq('FTS duplicate=0', fts.duplicate.length, 0)
  eq('FTS contentMismatch=0', fts.contentMismatch.length, 0)
  ok('FTS integrity ok', fts.integrityOk === true)

  ok('恢复后的库能正常打开', (() => {
    try {
      const probe = new DatabaseSync(restoredFile, { readOnly: true })
      probe.prepare('SELECT COUNT(*) AS n FROM artifacts').get()
      probe.close()
      return true
    } catch {
      return false
    }
  })())

  console.log(`[E6-B4] ${passed} 通过 ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    failed += 1
    console.log(`  FAIL 场景抛错 — ${error?.message ?? error}`)
    process.exitCode = 1
  })
  .finally(() => {
    try {
      rmSync(sandbox, { recursive: true, force: true })
    } catch {
      // Windows 句柄未释放时忽略
    }
  })
