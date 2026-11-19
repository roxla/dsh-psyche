// E6-B2 备份包完整性：能解压不等于安全、完整、可恢复。
//
// 验收点（用户 E6-B2）：
// 1. 逐文件 sha256 不符 → 整包拒绝；
// 2. 缺必要成员 → 拒绝；
// 3. 同一路径出现多次 → 拒绝（不能静默取后者）；
// 4. 绝对路径 / `..` / 符号链接 / 未知成员类型 → 拒绝；
// 5. 伪造清单（format、未来 formatVersion、空 files、totalBytes 不一致）→ 拒绝；
// 6. 超大小上限 → 拒绝；
// 7. 旧包（没有 backupId/driver/totalBytes）仍可校验通过，不因新字段缺失误拒。
//
// 直接对着构建产物跑：node test/backup-integrity.ts（需先 npm run build）
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { buildTar, verifyArchive, ARCHIVE_FORMAT, ARCHIVE_LIMITS } from '../dist/lib/archive.js'

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

const dir = mkdtempSync(join(tmpdir(), 'psyche-backup-integrity-'))
const sha = (data) => createHash('sha256').update(data).digest('hex')

function writePackage(name, members, mutateManifest) {
  const manifest = {
    format: ARCHIVE_FORMAT,
    formatVersion: 1,
    kind: 'backup',
    backupId: 'bkp-test-0001',
    createdAt: '2026-11-07T00:00:00.000Z',
    personaId: 'main',
    schemaVersion: 9,
    algorithmVersion: 'test',
    plugin: { name: 'dsh-psyche', version: '0.0.0-test' },
    runtime: { node: process.version, platform: process.platform },
    driver: 'node:sqlite',
    backupMode: 'vacuum-into',
    totalBytes: members.reduce((sum, member) => sum + member.data.length, 0),
    counts: {},
    files: members.map((member) => ({
      path: member.name,
      role: 'other',
      bytes: member.data.length,
      sha256: sha(member.data),
    })),
    notes: [],
  }
  if (mutateManifest) mutateManifest(manifest)
  const payload = buildTar([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    ...members,
  ])
  const file = join(dir, name)
  writeFileSync(file, gzipSync(payload))
  return file
}

function verify(file, limits) {
  return verifyArchive(file, limits ? { limits } : {})
}

function run() {
  console.log('[E6-B2] 备份包完整性')

  const db = { name: 'memory.sqlite3', data: Buffer.from('sqlite-bytes') }
  const identity = { name: 'identity.md', data: Buffer.from('人格原文') }

  // 0) 正常包
  const good = writePackage('good.tar.gz', [db, identity])
  ok('正常包校验通过', verify(good).ok, verify(good).problems)

  // 1) sha256 不符：改成员内容但保留旧清单
  const manifestForTamper = {
    format: ARCHIVE_FORMAT,
    formatVersion: 1,
    kind: 'backup',
    backupId: 'bkp-tamper',
    createdAt: '2026-11-07T00:00:00.000Z',
    personaId: 'main',
    schemaVersion: 9,
    algorithmVersion: 'test',
    plugin: { name: 'dsh-psyche', version: '0.0.0-test' },
    runtime: { node: process.version, platform: process.platform },
    driver: 'node:sqlite',
    backupMode: 'vacuum-into',
    totalBytes: db.data.length + identity.data.length,
    counts: {},
    files: [
      { path: db.name, role: 'database', bytes: db.data.length, sha256: sha(db.data) },
      { path: identity.name, role: 'identity', bytes: identity.data.length, sha256: sha(identity.data) },
    ],
    notes: [],
  }
  const tampered = join(dir, 'tampered.tar.gz')
  writeFileSync(
    tampered,
    gzipSync(
      buildTar([
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifestForTamper), 'utf8') },
        { name: db.name, data: Buffer.from('sqlite-BYTES') },
        identity,
      ]),
    ),
  )
  const tamperedResult = verify(tampered)
  ok('内容被改后拒绝', tamperedResult.ok === false)
  ok(
    '拒绝理由指出 sha256',
    tamperedResult.problems.some((problem) => problem.reason.includes('sha256')),
    tamperedResult.problems,
  )

  // 2) 缺成员：清单列了 identity.md，但包里只有 memory.sqlite3
  const missing = join(dir, 'missing.tar.gz')
  writeFileSync(
    missing,
    gzipSync(
      buildTar([
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifestForTamper), 'utf8') },
        db,
      ]),
    ),
  )
  const missingResult = verify(missing)
  ok('缺成员拒绝', missingResult.ok === false)
  ok(
    '拒绝理由指出缺少文件',
    missingResult.problems.some((problem) => problem.reason.includes('缺少')),
    missingResult.problems,
  )

  // 3) 重复成员
  const duplicated = writePackage('duplicated.tar.gz', [db, db, identity])
  const duplicatedResult = verify(duplicated)
  ok('重复成员拒绝', duplicatedResult.ok === false)
  ok(
    '拒绝理由指出重复',
    duplicatedResult.problems.some((problem) => problem.reason.includes('出现多次')),
    duplicatedResult.problems,
  )

  // 4) 路径穿越 / 绝对路径（清单层面）
  const traversal = writePackage('traversal.tar.gz', [db, identity], (manifest) => {
    manifest.files[1].path = '../outside.md'
  })
  ok('清单里 ../ 路径拒绝', verify(traversal).ok === false)
  const absolute = writePackage('absolute.tar.gz', [db, identity], (manifest) => {
    manifest.files[1].path = 'C:/Windows/system32/evil.dll'
  })
  ok('清单里绝对路径拒绝', verify(absolute).ok === false)

  // 5) 伪造清单
  const wrongFormat = writePackage('wrong-format.tar.gz', [db], (manifest) => {
    manifest.format = 'not-psyche'
  })
  ok('format 不符拒绝', verify(wrongFormat).ok === false)
  const future = writePackage('future.tar.gz', [db], (manifest) => {
    manifest.formatVersion = 99
  })
  ok('未来格式版本拒绝', verify(future).ok === false)
  const emptyFiles = writePackage('empty-files.tar.gz', [db], (manifest) => {
    manifest.files = []
  })
  ok('空文件清单拒绝', verify(emptyFiles).ok === false)
  const badTotal = writePackage('bad-total.tar.gz', [db], (manifest) => {
    manifest.totalBytes = 999999
  })
  const badTotalResult = verify(badTotal)
  ok('totalBytes 不一致拒绝', badTotalResult.ok === false)
  ok(
    '拒绝理由指出 totalBytes',
    badTotalResult.problems.some((problem) => problem.reason.includes('totalBytes')),
    badTotalResult.problems,
  )

  // 6) 超大小上限
  const oversized = verify(good, { ...ARCHIVE_LIMITS, archiveBytes: 16 })
  ok('压缩包超上限拒绝', oversized.ok === false)
  const smallMember = verify(good, { ...ARCHIVE_LIMITS, memberBytes: 4 })
  ok('成员超上限拒绝', smallMember.ok === false)

  // 7) 旧包兼容：没有 backupId / driver / totalBytes / kind
  const legacy = writePackage('legacy.tar.gz', [db], (manifest) => {
    delete manifest.backupId
    delete manifest.driver
    delete manifest.totalBytes
    delete manifest.kind
  })
  ok('旧包（缺新字段）仍校验通过', verify(legacy).ok, verify(legacy).problems)

  console.log(`[E6-B2] ${passed} 通过 ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

run()

try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  // Windows 句柄未释放时忽略
}
