/**
 * 人格初始化自检（`src/lib/persona-init.ts`）。
 *
 * 为什么单独测：初始化是本插件唯一会「凭一次点击就写下不可改原文」的路径，
 * 失败现场（claim 残留、写了一半的 persona.json）必须能被下一个人看懂并收尾。
 * 这里把五种状态、四种崩溃窗口、注入式 IO 失败与文件/数据库一致性逐条钉住。
 *
 * 跑法：`node test/persona-init.ts`（要求先 `npm run build`）。
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../dist/lib/adapter.js'
import {
  CLAIM_FILE,
  IDENTITY_FILE,
  PERSONA_FILE,
  abortInitialization,
  acceptIdentityDrift,
  finishInitialization,
  initPathsOf,
  initializePersona,
  inspectInitialization,
  reconcileInitialization,
  sha256OfText,
  syncPersonaConfigFromFile,
} from '../dist/lib/persona-init.js'
import type { InitDb, InitFs } from '../dist/lib/persona-init.js'
import { findPreset } from '../dist/lib/presets.js'

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

function expectError(fn: () => unknown, code: string): { ok: boolean; message: string; detail?: unknown } {
  try {
    fn()
    return { ok: false, message: '没有抛错' }
  } catch (error) {
    const actual = (error as { code?: string }).code
    return { ok: actual === code, message: String((error as Error).message), detail: (error as { detail?: unknown }).detail }
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'psyche-init-'))
let caseNo = 0

/** 每个用例独占一个数据根：状态文件与 claim 都是目录内文件，不能共用。 */
function makeCase(): { dir: string; paths: ReturnType<typeof initPathsOf> } {
  caseNo += 1
  const dir = join(sandbox, `case-${caseNo}`, 'data')
  mkdirSync(dir, { recursive: true })
  return { dir, paths: initPathsOf(dir) }
}

function writeClaim(
  dir: string,
  claim: { kind?: 'init' | 'reset'; pid?: number; startedAt?: string; presetId?: string | null; pendingIdentityHash?: string | null },
): void {
  const body = {
    kind: claim.kind ?? 'init',
    pid: claim.pid ?? process.pid,
    startedAt: claim.startedAt ?? new Date(Date.now() - 60_000).toISOString(),
    presetId: claim.presetId ?? 'gentle-firm',
    pendingIdentityHash: claim.pendingIdentityHash ?? null,
  }
  writeFileSync(join(dir, CLAIM_FILE), JSON.stringify(body, null, 2) + '\n', 'utf8')
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

function identityHashOf(dir: string): string {
  return sha256OfText(readFileSync(join(dir, IDENTITY_FILE), 'utf8'))
}

/** 注入式 fs：在第 N 次指定操作上抛错，用来复现「写到一半崩了」。 */
function failingFs(failOn: 'rename' | 'write', ordinal = 1): { fs: InitFs; calls: () => number } {
  let renames = 0
  let writes = 0
  const fs: InitFs = {
    existsSync,
    readFileSync: (file, encoding) => readFileSync(file, encoding),
    writeFileSync: (file, data, options) => {
      writes += 1
      if (failOn === 'write' && writes === ordinal) throw new Error('模拟写盘失败')
      writeFileSync(file, data, options)
    },
    renameSync: (from, to) => {
      renames += 1
      if (failOn === 'rename' && renames === ordinal) throw new Error('模拟改名失败')
      renameSync(from, to)
    },
    unlinkSync,
    openSync: (file, flags, mode) => openSync(file, flags, mode),
    writeSync: (fd, data) => writeSync(fd, data),
    closeSync,
    mkdirSync: (file, options) => mkdirSync(file, options),
    statSync: (file) => ({ mtimeMs: statSync(file).mtimeMs, size: statSync(file).size }),
  }
  return { fs, calls: () => renames + writes }
}

async function main(): Promise<void> {
  console.log('人格初始化自检')

  const opened = await openDatabase({ file: join(sandbox, 'db', 'memory.sqlite3') })
  const db = opened.db
  const initDb: InitDb = {
    run: (sql, params) => db.run(sql, params) as unknown,
    get: <T>(sql: string, params?: readonly unknown[]) => db.get<T>(sql, params),
    transaction: <T>(fn: () => T) => db.transaction(fn),
  }

  // ---- 路径与判定矩阵 ----
  const labels = { [IDENTITY_FILE]: 'identity.md', [PERSONA_FILE]: 'persona.json', [CLAIM_FILE]: 'persona.init.lock' }
  check(
    'initPathsOf 三个文件名正确',
    Object.entries(labels).every(([name, label]) => label === name) &&
      initPathsOf('D:/x').identity.endsWith(IDENTITY_FILE) &&
      initPathsOf('D:/x').persona.endsWith(PERSONA_FILE) &&
      initPathsOf('D:/x').claim.endsWith(CLAIM_FILE),
  )
  {
    const { dir } = makeCase()
    const snapshot = inspectInitialization({ dataDir: dir })
    check('空目录 → uninitialized', snapshot.state === 'uninitialized', snapshot)
    check('空目录建议初始化', snapshot.actions.includes('initialize'))
  }
  {
    const { dir } = makeCase()
    writeClaim(dir, {})
    const snapshot = inspectInitialization({ dataDir: dir })
    check('只有 claim → initializing', snapshot.state === 'initializing', snapshot.state)
    check('现场 A 只能 abort', snapshot.actions.join(',') === 'abort', snapshot.actions)
  }
  {
    const { dir } = makeCase()
    const preset = findPreset('quiet-warm')
    writeClaim(dir, { presetId: 'quiet-warm' })
    writeFileSync(join(dir, IDENTITY_FILE), preset.identity, 'utf8')
    const snapshot = inspectInitialization({ dataDir: dir })
    check('claim + identity → initializing，可 finish', snapshot.state === 'initializing' && snapshot.actions.includes('finish'), snapshot.actions)
  }
  {
    const { dir } = makeCase()
    writeFileSync(join(dir, IDENTITY_FILE), 'identity without persona', 'utf8')
    const snapshot = inspectInitialization({ dataDir: dir })
    check('只有 identity（无 persona）→ damaged', snapshot.state === 'damaged', snapshot.state)
  }
  {
    const { dir } = makeCase()
    writeFileSync(join(dir, PERSONA_FILE), '{ 不是 JSON', 'utf8')
    const snapshot = inspectInitialization({ dataDir: dir })
    check('persona.json 坏 → damaged', snapshot.state === 'damaged', snapshot.state)
  }

  // ---- 正常初始化 ----
  const happy = makeCase()
  const preset = findPreset('gentle-firm')
  const result = initializePersona({ dataDir: happy.dir, presetId: 'gentle-firm', db: initDb })
  check('初始化后 → locked', result.snapshot.state === 'locked', result.snapshot.state)
  check('DB 快照已写', result.dbSynced === true)
  check(
    'identity.md 是预设原文（逐字节相同）',
    readFileSync(join(happy.dir, IDENTITY_FILE), 'utf8') === preset.identity,
  )
  check('claim 已删', !existsSync(join(happy.dir, CLAIM_FILE)))
  const lockedDoc = readJson<{
    schemaVersion: number
    personaId: string
    initialization: Record<string, unknown>
    commitments: Array<{ id: string }>
    tendencies: unknown[]
  }>(join(happy.dir, PERSONA_FILE))
  check('persona.json 写的是 locked', lockedDoc.initialization.status === 'locked')
  check('identityHash 等于实际字节哈希', lockedDoc.initialization.identityHash === identityHashOf(happy.dir))
  check('identityBytes 等于实际大小', lockedDoc.initialization.identityBytes === statSync(join(happy.dir, IDENTITY_FILE)).size)
  check('pendingIdentityHash 已清空', lockedDoc.initialization.pendingIdentityHash === null)
  check('正式版标记落到人格记录里', lockedDoc.initialization.presetDraft === false)
  check('schemaVersion=1、personaId=main', lockedDoc.schemaVersion === 1 && lockedDoc.personaId === 'main')
  check(
    '核心承诺四条在前',
    lockedDoc.commitments.slice(0, 4).map((item) => item.id).join(',') ===
      'core-no-substitute-decisions,core-no-fabrication,core-privacy,core-params-readonly',
  )
  check('承诺数 = 4 + 预设自带', lockedDoc.commitments.length === 4 + preset.commitments.length)
  const dbRow = db.get<{ persona_json: string }>('SELECT persona_json FROM persona_config WHERE persona_id = ?', ['main'])
  check('persona_config.persona_json 与文件一致', dbRow?.persona_json === JSON.stringify(result.persona))
  const history = db.get<{ field: string; reason: string }>(
    "SELECT field, reason FROM personality_history WHERE field = 'initialization' ORDER BY at DESC LIMIT 1",
  )
  check('personality_history 记了初始化', history?.field === 'initialization' && history?.reason === 'initialized')

  // ---- 重复初始化与状态拒绝 ----
  const again = expectError(() => initializePersona({ dataDir: happy.dir, presetId: 'gentle-firm', db: initDb }), 'E_INIT_LOCKED')
  check('已锁定再初始化 → E_INIT_LOCKED', again.ok, again.message)
  {
    const { dir } = makeCase()
    writeClaim(dir, {})
    const race = expectError(() => initializePersona({ dataDir: dir, presetId: 'gentle-firm' }), 'E_INIT_RACE')
    check('claim 在别人手里 → E_INIT_RACE', race.ok, race.message)
  }
  {
    const { dir } = makeCase()
    const unknown = expectError(() => initializePersona({ dataDir: dir, presetId: 'no-such' }), 'E_PRESET_UNKNOWN')
    check('未知预设 → E_PRESET_UNKNOWN', unknown.ok, unknown.message)
    check('未知预设不会留下 claim', !existsSync(join(dir, CLAIM_FILE)))
  }

  // ---- 现场 A：claim 建好、什么都没写 ----
  {
    const { dir } = makeCase()
    writeFileSync(join(dir, 'notes.txt'), '更早的用户文件', 'utf8')
    writeClaim(dir, {})
    const aborted = abortInitialization({ dataDir: dir })
    check('现场 A abort 后回 uninitialized', aborted.snapshot.state === 'uninitialized', aborted.snapshot.state)
    check('abort 只删本轮造出来的文件', !existsSync(join(dir, CLAIM_FILE)) && !existsSync(join(dir, IDENTITY_FILE)))
    check('abort 不碰更早的用户文件', existsSync(join(dir, 'notes.txt')))
  }

  // ---- 现场 B：identity 写完、persona 还没写 ----
  {
    const { dir, paths } = makeCase()
    const presetB = findPreset('direct-sharp')
    writeClaim(dir, { presetId: 'direct-sharp' })
    writeFileSync(paths.identity, presetB.identity, 'utf8')
    const finished = finishInitialization({ dataDir: dir, db: initDb })
    check('现场 B finish 用 claim 里的 presetId 重建人格记录', finished.persona.initialization.presetId === 'direct-sharp')
    check('现场 B finish 后 identityHash 对得上', finished.identityHash === identityHashOf(dir))
    check('现场 B finish 后 claim 已删', !existsSync(paths.claim))
    const docB = readJson<{ commitments: unknown[] }>(paths.persona)
    check('现场 B 重建的记录也带上核心承诺', docB.commitments.length === 4 + presetB.commitments.length)
  }

  // ---- 现场 C：persona 停在 initializing，但哈希与 claim 对不上 ----
  {
    const { dir, paths } = makeCase()
    // 先用真初始化造一份**结构合法**的 persona.json，再把它改成「停在 initializing、哈希对不上」
    const scratch = makeCase()
    initializePersona({ dataDir: scratch.dir, presetId: 'steady-calm' })
    const docC = readJson<{
      initialization: Record<string, unknown>
    }>(scratch.paths.persona)
    docC.initialization.status = 'initializing'
    docC.initialization.lockedAt = null
    docC.initialization.identityHash = null
    docC.initialization.pendingIdentityHash = 'deadbeef'
    const presetC = findPreset('steady-calm')
    writeClaim(dir, { presetId: 'steady-calm', pendingIdentityHash: 'deadbeef' })
    writeFileSync(paths.identity, presetC.identity, 'utf8')
    writeFileSync(paths.persona, JSON.stringify(docC, null, 2) + '\n', 'utf8')
    const snapshot = inspectInitialization({ dataDir: dir })
    check('现场 C 判定为 initializing 且哈希不符', snapshot.state === 'initializing' && snapshot.hashMatches === false, snapshot.hashMatches)
    check('现场 C 只能 abort 不能 finish', snapshot.actions.join(',') === 'abort', snapshot.actions)
    const refused = expectError(() => finishInitialization({ dataDir: dir }), 'E_INIT_INCOMPLETE')
    check('哈希对不上时 finish → E_INIT_INCOMPLETE', refused.ok, refused.message)
    const aborted = abortInitialization({ dataDir: dir })
    check('现场 C abort 后清干净', aborted.snapshot.state === 'uninitialized' && !existsSync(paths.identity))
  }

  // ---- 现场 D：两文件都好了，只剩失效 claim ----
  {
    const { dir, paths } = makeCase()
    initializePersona({ dataDir: dir, presetId: 'clingy-sweet' })
    writeClaim(dir, { presetId: 'clingy-sweet', pid: 999_999 })
    const drifted = inspectInitialization({ dataDir: dir })
    check('现场 D 仍判定 locked', drifted.state === 'locked', drifted.state)
    check('现场 D claim 的持有进程已死', drifted.claim?.ownerAlive === false)
    const reconciled = reconcileInitialization({ dataDir: dir, isProcessAlive: () => false })
    check('reconcile 清掉失效 claim', reconciled.actions.join(',') === 'cleared-stale-claim', reconciled.actions)
    check('reconcile 后不再有 claim', !existsSync(paths.claim))
    check('reconcile 不碰两个已完成的文件', existsSync(paths.identity) && existsSync(paths.persona))
  }

  // ---- finish 幂等 ----
  {
    const { dir, paths } = makeCase()
    initializePersona({ dataDir: dir, presetId: 'gentle-firm' })
    const before = statSync(paths.persona).mtimeMs
    const idempotent = finishInitialization({ dataDir: dir })
    check('已锁定再 finish → alreadyLocked', idempotent.alreadyLocked === true)
    check('幂等 finish 不重写文件', statSync(paths.persona).mtimeMs === before)
  }

  // ---- 状态机拒绝 ----
  {
    const { dir } = makeCase()
    const finishEmpty = expectError(() => finishInitialization({ dataDir: dir }), 'E_INIT_STATE')
    check('空目录 finish → E_INIT_STATE', finishEmpty.ok, finishEmpty.message)
    const abortEmpty = abortInitialization({ dataDir: dir })
    check('空目录 abort 幂等（没有可放弃的现场）', abortEmpty.aborted === false && abortEmpty.removed.length === 0)
    const lockedAbort = expectError(() => abortInitialization({ dataDir: happy.dir }), 'E_INIT_LOCKED')
    check('已锁定 abort → E_INIT_LOCKED', lockedAbort.ok, lockedAbort.message)
  }

  // ---- drift：人工改过原文 ----
  {
    const { dir, paths } = makeCase()
    initializePersona({ dataDir: dir, presetId: 'gentle-firm', db: initDb })
    writeFileSync(paths.identity, readFileSync(paths.identity, 'utf8') + '\n\n（我改了一句）\n', 'utf8')
    const drifted = inspectInitialization({ dataDir: dir })
    check('原文被改 → identity-drift', drifted.state === 'identity-drift', drifted.state)
    check('drift 时 hashMatches=false', drifted.hashMatches === false)
    check('drift 允许 accept-drift / reset', drifted.actions.includes('accept-drift') && drifted.actions.includes('reset'))
    const refused = expectError(() => initializePersona({ dataDir: dir, presetId: 'gentle-firm' }), 'E_INIT_STATE')
    check('drift 不允许重新初始化', refused.ok, refused.message)
    const accepted = acceptIdentityDrift({ dataDir: dir, db: initDb })
    check('accept-drift 后回到 locked', accepted.snapshot.state === 'locked', accepted.snapshot.state)
    check('accept-drift 把新哈希写进人格记录', accepted.persona.initialization.identityHash === identityHashOf(dir))
    const row = db.get<{ persona_json: string }>('SELECT persona_json FROM persona_config WHERE persona_id = ?', ['main'])
    check('accept-drift 同步了 DB 快照', row?.persona_json === JSON.stringify(accepted.persona))
    const notDrift = expectError(() => acceptIdentityDrift({ dataDir: dir }), 'E_INIT_STATE')
    check('没有 drift 时 accept → E_INIT_STATE', notDrift.ok, notDrift.message)
  }

  // ---- damaged 不自愈 ----
  {
    const { dir, paths } = makeCase()
    writeFileSync(paths.persona, '{ 坏掉的 JSON', 'utf8')
    const bytesBefore = readFileSync(paths.persona)
    const snapshot = inspectInitialization({ dataDir: dir })
    check('坏人格记录 → damaged', snapshot.state === 'damaged', snapshot.state)
    check('damaged 只给 abort / reset', snapshot.actions.every((action) => action === 'abort' || action === 'reset'), snapshot.actions)
    const refused = expectError(() => initializePersona({ dataDir: dir, presetId: 'gentle-firm' }), 'E_INIT_STATE')
    check('damaged 不允许初始化', refused.ok, refused.message)
    check('damaged 前后字节一致（什么都不写）', Buffer.compare(bytesBefore, readFileSync(paths.persona)) === 0)
  }
  {
    const { dir, paths } = makeCase()
    initializePersona({ dataDir: dir, presetId: 'quiet-warm' })
    unlinkSync(paths.identity)
    const snapshot = inspectInitialization({ dataDir: dir })
    check('locked 但原文被删 → damaged', snapshot.state === 'damaged', snapshot.state)
  }
  {
    const { dir, paths } = makeCase()
    initializePersona({ dataDir: dir, presetId: 'quiet-warm' })
    const doc = readJson<Record<string, unknown>>(paths.persona)
    doc.personaId = 'someone-else'
    writeFileSync(paths.persona, JSON.stringify(doc), 'utf8')
    const snapshot = inspectInitialization({ dataDir: dir })
    check('personaId 不是 main → damaged', snapshot.state === 'damaged', snapshot.state)
  }

  // ---- 注入式 IO 失败：第 2 步改名失败 ----
  {
    const { dir } = makeCase()
    const injected = failingFs('rename', 1)
    const failed = expectError(
      () => initializePersona({ dataDir: dir, presetId: 'gentle-firm', fs: injected.fs }),
      'E_INTERNAL',
    )
    check('第 2 步失败 → E_INTERNAL', failed.ok, failed.message)
    const detail = failed.detail as { step?: number; claimKept?: boolean } | undefined
    check('错误里写明失败在第几步', detail?.step === 2, detail)
    check('失败时保留 claim 供人收尾', existsSync(join(dir, CLAIM_FILE)) && detail?.claimKept === true)
    check('失败时没有写出 identity.md', !existsSync(join(dir, IDENTITY_FILE)))
    check(
      '失败时不留下临时文件',
      readdirSync(dir).filter((name) => name.includes('.tmp-')).length === 0,
      readdirSync(dir),
    )
    const after = inspectInitialization({ dataDir: dir })
    check('失败后现场是 initializing（可 abort）', after.state === 'initializing' && after.actions.join(',') === 'abort', after.actions)
    const aborted = abortInitialization({ dataDir: dir })
    check('abort 收尾后回到 uninitialized', aborted.snapshot.state === 'uninitialized', aborted.snapshot.state)
  }

  // ---- 文件 → DB 同步 ----
  {
    const { dir } = makeCase()
    initializePersona({ dataDir: dir, presetId: 'steady-calm', db: initDb })
    db.run('UPDATE persona_config SET persona_json = ? WHERE persona_id = ?', ['{"stale":true}', 'main'])
    const synced = syncPersonaConfigFromFile({ dataDir: dir, db: initDb })
    check('sync 把文件写回 DB', synced.synced === true && synced.reason === 'synced', synced.reason)
    check('sync 记下 before', synced.before === '{"stale":true}')
    const row = db.get<{ persona_json: string }>('SELECT persona_json FROM persona_config WHERE persona_id = ?', ['main'])
    check('sync 后 DB 与文件一致', row?.persona_json === synced.after)
    const history = db.get<{ reason: string }>(
      "SELECT reason FROM personality_history WHERE field = 'persona.sync' ORDER BY at DESC LIMIT 1",
    )
    check('sync 写了一条 history', history?.reason === 'sync-from-file')
    const againSync = syncPersonaConfigFromFile({ dataDir: dir, db: initDb })
    check('再 sync → already-in-sync', againSync.synced === false && againSync.reason === 'already-in-sync')
    const noDb = syncPersonaConfigFromFile({ dataDir: dir })
    check('没有 db 时只报告不同步', noDb.synced === false && /数据库/.test(noDb.reason), noDb.reason)
  }
  {
    const { dir } = makeCase()
    const nothing = syncPersonaConfigFromFile({ dataDir: dir, db: initDb })
    check('没有 persona.json 时不同步', nothing.synced === false && nothing.reason === '没有 persona.json', nothing.reason)
  }

  console.log(`\n人格初始化自检：${pass} 通过 ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
  db.close()
  rmSync(sandbox, { recursive: true, force: true })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
