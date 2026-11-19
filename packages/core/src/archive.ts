// ─────────────────────────────────────────────────────────────────────────────
// 迁移包（archive）：把「一个人格」打成一个可搬走的文件。
//
// 为什么需要它：`backups/memory-*.sqlite3` 只是库的快照，够回滚，不够搬家——
// 换电脑时还要带上人格原文（identity.md）、初始配置（persona.json）、运行参数
// （config.json）、面板偏好（panel-prefs.json）、以及 assets/ 里那些按 sha256
// 命名的原始素材。散着拷容易漏，所以打成一个带清单与逐文件校验的包。
//
// 格式：**tar + gzip**，第一个成员固定是 `manifest.json`。
//   - 为什么不用 zip：Node 没有内置 zip 写入器，引第三方依赖违反「零依赖」约束；
//     tar 是 512 字节定长头，手写 100 行就够，gzip 直接 `node:zlib`。
//   - 为什么不压缩成自定义二进制：tar.gz 用 `tar -tzf` 就能人工检查，
//     出问题时不用装我们的插件也能看里面有什么。
//
// 不变量（改这个文件前先读）：
//   1. 打包只读源目录：绝不移动/删除数据根里的任何文件（DB 快照靠 VACUUM INTO 写临时区）。
//   2. 恢复先解到数据根**同级**的暂存目录，校验全部通过才允许换名——半成品永远不落主目录。
//   3. 任何一个文件 sha256 对不上就整包拒绝，不做「部分恢复」。
//   4. 包里的路径只能是相对路径且不含 `..`，防止解压时写出数据根（zip-slip）。
//
// 谁在用：`src/index.ts` 的运维路由（打包/查看）、`src/lib/ops.ts` 的列表、
// `tools/psyche-archive.mjs` 的命令行（冷恢复：DSH 关掉时最安全）。
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { CODE, PsycheError } from './errors.js'
import { checkDatabaseFile } from './dbcheck.js'

/** 包格式版本：清单结构或成员布局变了就 +1，恢复侧按它决定能不能读。 */
export const ARCHIVE_FORMAT = 'psyche-archive'
export const ARCHIVE_FORMAT_VERSION = 1

/**
 * 解包资源上限（v14 §34.12 P0-2）。
 *
 * 为什么必须有：tar.gz 是压缩流，一个几百 KB 的包可以解出几十 GB（解压炸弹）。
 * 光看 TAR 头里声明的大小不够——头可以撒谎；必须**边读边累计实际字节**。
 *
 * 口径（与设计文档一致，改数字要同时改文档）：
 * - `archiveBytes`：压缩包文件本身的大小上限（先挡住明显异常的输入，避免白白读盘）；
 * - `memberBytes`：单个成员解压后的实际字节数；
 * - `totalBytes`：所有普通文件实际解压字节数之和；
 * - `members`：TAR 里的成员总数，**包括目录成员**（目录不占数据，但占数量：5000 个空目录也是攻击面）。
 */
export const ARCHIVE_LIMITS = {
  archiveBytes: 2 * 1024 * 1024 * 1024,
  memberBytes: 2 * 1024 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024 * 1024,
  members: 5000,
} as const

/** 一套上限。测试会传很小的数字来验「超限就拒绝」，生产永远用 `ARCHIVE_LIMITS`。 */
export interface ArchiveLimits {
  archiveBytes: number
  memberBytes: number
  totalBytes: number
  members: number
}

/** 超限统一抛这个：上层（面板/CLI）按 `E_ARCHIVE_LIMIT` 提示「包太大，已拒绝」。 */
function limitError(detail: string, limits: ArchiveLimits = ARCHIVE_LIMITS): PsycheError {
  return new PsycheError(CODE.archiveLimit, `迁移包超出资源上限：${detail}`, { limits })
}

/** 包内固定成员名：清单必须排第一，方便流式读取时先拿到元信息。 */
const MANIFEST_NAME = 'manifest.json'
/** tar 的块大小；每个成员的数据都补齐到它。 */
const TAR_BLOCK = 512
/** 成员在包里的角色，恢复时用来决定放回哪、要不要校验。 */
export type ArchiveRole = 'database' | 'identity' | 'persona' | 'config' | 'prefs' | 'asset' | 'narrative' | 'other'

/** 清单里的一个文件：路径、字节数、sha256。恢复只认这三样，不再猜。 */
export interface ArchiveFile {
  path: string
  role: ArchiveRole
  bytes: number
  sha256: string
}

/** 包的用途：备份与迁移共用同一格式，靠这个字段区分（旧包缺省按 migration 读）。 */
export type ArchiveKind = 'backup' | 'migration'

/** 数据库快照的生成方式。E6-B1 要求两种驱动分别验收，包要自证用的是哪条路径。 */
export type ArchiveBackupMode = 'vacuum-into' | 'native'

/** 包的元信息。`schemaVersion` 决定老库能不能被新插件接手（只能往上升，不能往下降）。 */
export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT
  formatVersion: number
  kind: ArchiveKind
  /** 一次备份的唯一标识。用它做对账，不依赖文件名。 */
  backupId: string
  createdAt: string
  personaId: string
  schemaVersion: number
  algorithmVersion: string
  plugin: { name: string; version: string }
  runtime: { node: string; platform: string }
  /** 生成快照的驱动（`node:sqlite` / `better-sqlite3`）。恢复端不据此改变行为，只用于审计与故障定位。 */
  driver: string
  backupMode: ArchiveBackupMode
  /** 所有成员解压后的字节数之和（压缩包大小见 ArchiveResult.bytes）。 */
  totalBytes: number
  counts: Record<string, number>
  files: ArchiveFile[]
  notes: string[]
}

/** 一次打包的结果。`bytes` 是最终文件大小，给人判断「是不是空的」。 */
export interface ArchiveResult {
  ok: boolean
  file: string
  bytes: number
  at: string
  durationMs: number
  manifest: ArchiveManifest
}

/** 校验/解包的问题条目：`path` 为空表示整包级问题（格式、版本、gzip 损坏）。 */
export interface ArchiveProblem {
  path: string
  reason: string
}

/** `verifyArchive` 的结果：`ok` 为假时 `problems` 一定非空。 */
export interface ArchiveVerifyResult {
  ok: boolean
  manifest: ArchiveManifest | null
  problems: ArchiveProblem[]
  bytes: number
}

/**
 * 打包时要抓哪些文件。
 *
 * 规则：数据根下**白名单**（人格原文/配置/偏好）+ 整个 `assets/`、`narrative/`；
 * `backups/`、`memory-view/`、`*.tmp`、`*-wal`、`*-shm` 一律不带——
 * 前两个是可再生/可重建的派生物，后三个是 SQLite 的运行期伴随文件（VACUUM INTO
 * 已经把一致性快照冻结进 `memory.sqlite3`，再带 WAL 反而会让恢复端拿到互相矛盾的两份）。
 */
const ROOT_ROLES: Record<string, ArchiveRole> = {
  'identity.md': 'identity',
  'persona.json': 'persona',
  'config.json': 'config',
  'panel-prefs.json': 'prefs'
}

/** 递归收集一个子目录里的文件（只往下走一层到两层，素材本来就不深）。 */
function collectDir(dir: string, base: string, role: ArchiveRole, out: { path: string; role: ArchiveRole; file: string }[]) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    let stat
    try {
      stat = statSync(full)
    } catch {
      // 正在被写/被删：跳过单个文件，不让整包失败
      continue
    }
    if (stat.isDirectory()) {
      // 只允许一层子目录（assets/<sha256>/x 这种未来形态），更深的层级直接跳过并记账
      if (relative(base, full).split(sep).length > 2) continue
      collectDir(full, base, role, out)
      continue
    }
    if (!stat.isFile()) continue
    if (name.endsWith('.tmp')) continue
    out.push({ path: relative(base, full).split(sep).join('/'), role, file: full })
  }
}

/** 计算一个文件的 sha256（十六进制小写），用于清单与恢复期校验。 */
export function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 把数据根打成一个迁移包，写到 `exports/psyche-backup-YYYYMMDD-HHMMSS.tar.gz`。
 *
 * 参数：`db` 已打开的连接（只用来 `VACUUM INTO` 出一致性快照）；`dataDir` 数据根；
 *      `counts` 库里各表计数（由调用方查好传进来，避免这里再摸一次业务语义）；
 *      `version` 插件版本号；`now` 注入时间（测试用）；`keep` 目录里最多留几个包。
 * 返回：`ArchiveResult`，含清单。
 * 失败：直接抛（磁盘满/无权限/路径过长），由调用方转成人能读的提示。
 */
export function createArchive(options: {
  db: { exec: (sql: string) => unknown }
  dataDir: string
  counts: Record<string, number>
  version: string
  schemaVersion: number
  algorithmVersion: string
  personaId?: string
  now?: Date
  keep?: number
  /**
   * 输出目录。默认是 `<数据根>/exports`；**预恢复包必须传数据根之外的目录**
   * （见 §34.8：数据根会被改名，包留在里面会在换名后丢失路径含义）。
   */
  outDir?: string
  /** 文件名前缀。默认 `psyche-backup`；预恢复包用 `psyche-prerestore` 以便区分。 */
  namePrefix?: string
  /** 包用途，默认 migration（保持旧行为）；备份入口显式传 'backup'。 */
  kind?: ArchiveKind
  /** 生成快照的数据库驱动名，写进 manifest 供审计与双驱动对账。 */
  driver?: string
}): ArchiveResult {
  const startedAt = Date.now()
  const now = options.now ?? new Date()
  const exportsDir = options.outDir ? resolve(options.outDir) : join(options.dataDir, 'exports')
  mkdirSync(exportsDir, { recursive: true })

  // 1) 先把库拍成一致性快照：写进 exports 下的临时文件，最后再一起打进包。
  //    VACUUM INTO 的路径是 SQL 字符串字面量，单引号要转义。
  //    快照文件必须 try/finally 清理：VACUUM 失败（磁盘满、库被锁）时不能把
  //    一个半截的 .snapshot.sqlite3 留在 exports 里——它看起来像备份，但不是。
  const snapshot = join(exportsDir, '.snapshot.sqlite3')
  rmSync(snapshot, { force: true })
  try {
    options.db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`)

    // 2) 收集要带的文件：固定白名单 + 两个素材目录。
    const collected: { path: string; role: ArchiveRole; file: string }[] = [
      { path: 'memory.sqlite3', role: 'database', file: snapshot }
    ]
    for (const [name, role] of Object.entries(ROOT_ROLES)) {
      const full = join(options.dataDir, name)
      if (existsSync(full) && statSync(full).isFile()) collected.push({ path: name, role, file: full })
    }
    collectDir(join(options.dataDir, 'assets'), options.dataDir, 'asset', collected)
    collectDir(join(options.dataDir, 'narrative'), options.dataDir, 'narrative', collected)

    // 3) 逐个算 sha256 并组装清单。
    const files: ArchiveFile[] = collected.map((item) => ({
      path: item.path,
      role: item.role,
      bytes: statSync(item.file).size,
      sha256: sha256Of(item.file)
    }))
    const manifest: ArchiveManifest = {
      format: ARCHIVE_FORMAT,
      formatVersion: ARCHIVE_FORMAT_VERSION,
      kind: options.kind ?? 'migration',
      backupId: randomUUID(),
      createdAt: now.toISOString(),
      personaId: options.personaId ?? 'main',
      schemaVersion: options.schemaVersion,
      algorithmVersion: options.algorithmVersion,
      plugin: { name: 'dsh-psyche', version: options.version },
      runtime: { node: process.version, platform: process.platform },
      driver: options.driver ?? 'node:sqlite',
      backupMode: 'vacuum-into',
      totalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
      counts: options.counts,
      files,
      notes: [
        'memory.sqlite3 是 VACUUM INTO 出来的一致性快照，不含 WAL。',
        'backups/ 与 memory-view/ 不进包：前者是可回滚快照、后者是可重建投影。',
        '恢复时逐文件校验 sha256，任一不符整包拒绝。'
      ]
    }

    // 4) 写 tar（manifest 排第一），gzip 之后原子改名。
    const members: TarMember[] = [
      { name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
      ...collected.map((item) => ({ name: item.path, data: readFileSync(item.file) }))
    ]
    const gz = gzipSync(buildTar(members), { level: 9 })

    const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const prefix = options.namePrefix ?? 'psyche-backup'
    const file = join(exportsDir, `${prefix}-${stamp}.tar.gz`)
    const temp = `${file}.tmp`
    writeFileSync(temp, gz)
    renameSync(temp, file)

    // 5) 轮转：只留最近 keep 个包（默认 5），按文件名时间戳排序。
    pruneArchives(exportsDir, options.keep ?? 5)

    return { ok: true, file, bytes: statSync(file).size, at: new Date().toISOString(), durationMs: Date.now() - startedAt, manifest }
  } finally {
    rmSync(snapshot, { force: true })
  }
}

/** 轮转旧包：保留最近 `keep` 个，删掉更早的。删失败只忽略（磁盘上多留一个不影响正确性）。 */
export function pruneArchives(exportsDir: string, keep: number): string[] {
  if (!existsSync(exportsDir)) return []
  const names = readdirSync(exportsDir)
    .filter((name) => /^psyche-backup-\d{8}-\d{6}\.tar\.gz$/.test(name))
    .sort()
    .reverse()
  const removed: string[] = []
  for (const name of names.slice(Math.max(0, keep))) {
    try {
      rmSync(join(exportsDir, name), { force: true })
      removed.push(name)
    } catch {
      // 被占用就留着，下次再删
    }
  }
  return removed
}

/** 列出 `exports/` 里已有的迁移包，最新在前（运维页直接用）。 */
export function listArchives(dataDir: string, limit = 10): { file: string; name: string; bytes: number; at: string }[] {
  const dir = join(dataDir, 'exports')
  if (!existsSync(dir)) return []
  const out: { file: string; name: string; bytes: number; at: string }[] = []
  for (const name of readdirSync(dir)) {
    if (!/^psyche-backup-\d{8}-\d{6}\.tar\.gz$/.test(name)) continue
    const file = join(dir, name)
    try {
      const stat = statSync(file)
      const m = /psyche-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name)
      out.push({
        file,
        name,
        bytes: stat.size,
        at: m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : new Date(stat.mtimeMs).toISOString()
      })
    } catch {
      // 正在被写/删：跳过
    }
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return out.slice(0, limit)
}

// ── tar ──────────────────────────────────────────────────────────────────────
// 只实现我们真正需要的子集：普通文件、ustar 头、无链接、无 pax 扩展。
// 成员路径都在 100 字节以内（assets/<64 hex> 最长 71），所以不做长名拆分；
// 万一将来超了，buildTar 会抛出明确错误而不是写一个坏包。

/** 一个待写入的成员：`name` 是包内相对路径，`data` 是原始字节。 */
interface TarMember {
  name: string
  data: Buffer
}

/** 把八进制数写成 tar 头字段：`width` 位、前导零、以 NUL 结尾。 */
function octal(value: number, width: number): string {
  const text = Math.max(0, Math.floor(value)).toString(8)
  if (text.length > width - 1) throw new Error(`tar 字段溢出：${value} 放不进 ${width} 位八进制`)
  return `${text.padStart(width - 1, '0')}\0`
}

/** 拼一个 512 字节的 ustar 头。 */
function tarHeader(name: string, size: number, mtimeSec: number): Buffer {
  const buf = Buffer.alloc(TAR_BLOCK, 0)
  buf.write(name, 0, 100, 'utf8')
  buf.write(octal(0o644, 8), 100, 8, 'latin1')
  buf.write(octal(0, 8), 108, 8, 'latin1')
  buf.write(octal(0, 8), 116, 8, 'latin1')
  buf.write(octal(size, 12), 124, 12, 'latin1')
  buf.write(octal(mtimeSec, 12), 136, 12, 'latin1')
  // 校验位先写 8 个空格，算完再覆盖
  buf.write('        ', 148, 8, 'latin1')
  buf.write('0', 156, 1, 'latin1')
  buf.write('ustar\0', 257, 6, 'latin1')
  buf.write('00', 263, 2, 'latin1')
  let sum = 0
  for (const byte of buf) sum += byte
  // 校验和是 6 位八进制 + NUL + 空格，这是 GNU/ustar 都认的写法
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
  return buf
}

/** 把若干成员拼成 tar 字节流，末尾补两个全零块表示结束。 */
export function buildTar(members: TarMember[]): Buffer {
  const chunks: Buffer[] = []
  const mtimeSec = Math.floor(Date.now() / 1000)
  for (const member of members) {
    if (Buffer.byteLength(member.name) > 100) throw new Error(`tar 成员路径过长（>100 字节）：${member.name}`)
    chunks.push(tarHeader(member.name, member.data.length, mtimeSec))
    chunks.push(member.data)
    const pad = (TAR_BLOCK - (member.data.length % TAR_BLOCK)) % TAR_BLOCK
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0))
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2, 0))
  return Buffer.concat(chunks)
}

/** 读一个头字段的八进制值（容忍前导空格与结尾 NUL/空格）。 */
function readOctal(buf: Buffer, offset: number, width: number): number {
  const raw = buf.subarray(offset, offset + width).toString('latin1').replace(/\0.*$/, '').trim()
  if (raw === '') return 0
  return Number.parseInt(raw, 8) || 0
}

/**
 * 解析 tar 字节流成成员列表。
 *
 * 只接受普通文件（typeflag `0` 或空）与目录（`5`，目录在包内没有独立数据，跳过）。
 * 遇到别的一律报错：说明这个包不是我们生成的，不要猜。
 *
 * 资源上限在这里逐条落实（细节见 `ARCHIVE_LIMITS` 的注释）：
 * - 成员数按**所有**头计数（含目录），超了立刻停，不看后面还有多少；
 * - 单成员字节数先比头部声明的 size，再在切数据时受 buffer 长度约束；
 * - 总解压字节边读边加，超了立刻抛——不等把整个包解析完。
 */
export function parseTar(buffer: Buffer, limits: ArchiveLimits = ARCHIVE_LIMITS): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = []
  let offset = 0
  let memberCount = 0
  let totalBytes = 0
  while (offset + TAR_BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK)
    // 全零块 = 结束标记
    if (header.every((byte) => byte === 0)) break
    memberCount += 1
    if (memberCount > limits.members) {
      // 目录也算成员：5000 个空目录同样是构造出来的攻击面
      throw limitError(`成员数超过 ${limits.members}（含目录）`, limits)
    }
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const fullName = prefix ? `${prefix}/${name}` : name
    const size = readOctal(header, 124, 12)
    const typeflag = header.subarray(156, 157).toString('latin1') || '0'
    offset += TAR_BLOCK
    if (typeflag === '5') continue // 目录：没有数据块
    if (typeflag !== '0') throw new Error(`不认识的 tar 成员类型「${typeflag}」（${fullName}）：这不是本插件生成的包`)
    if (size > limits.memberBytes) {
      throw limitError(`成员 ${fullName} 声明 ${size} 字节，超过单文件上限 ${limits.memberBytes}`, limits)
    }
    if (offset + size > buffer.length) throw new Error(`tar 成员被截断：${fullName}`)
    totalBytes += size
    if (totalBytes > limits.totalBytes) {
      throw limitError(`总解压量超过 ${limits.totalBytes} 字节`, limits)
    }
    out.push({ name: fullName, data: buffer.subarray(offset, offset + size) })
    offset += size + ((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK)
  }
  return out
}

// ── 校验 / 解包 ──────────────────────────────────────────────────────────────

/**
 * 解压 gzip + 解析 tar，任何一个环节坏了都抛。读包的地方都从这里进。
 *
 * 两道压缩层上限都在这里挡：
 * - 先看压缩包本身多大（`archiveBytes`）；
 * - `gunzipSync` 带 `maxOutputLength`，让 zlib 在解出超过 `totalBytes` 时**自己中断**——
 *   这一步很关键：等解完再查就晚了，炸弹已经进内存了。
 */
function readArchive(file: string, limits: ArchiveLimits = ARCHIVE_LIMITS): {
  manifest: ArchiveManifest
  members: Map<string, Buffer>
  /** 同一个路径出现多次的成员。取后者会静默掩盖前者，必须让校验层看见。 */
  duplicates: string[]
} {
  const compressedBytes = statSync(file).size
  if (compressedBytes > limits.archiveBytes) {
    throw limitError(`压缩包 ${compressedBytes} 字节，超过上限 ${limits.archiveBytes}`, limits)
  }
  const gz = readFileSync(file)
  let tar: Buffer
  try {
    // 多给 1 MiB 余量：tar 的块对齐与结束标记会略多于纯文件字节总和
    tar = gunzipSync(gz, { maxOutputLength: limits.totalBytes + 1024 * 1024 })
  } catch (error) {
    const message = (error as Error).message ?? String(error)
    if (/maxOutputLength|buffer too large|Cannot create a Buffer larger/i.test(message)) {
      throw limitError(`解压后超过总上限 ${limits.totalBytes} 字节（疑似解压炸弹）`, limits)
    }
    throw error
  }
  const parsed = parseTar(tar, limits)
  const manifestMember = parsed.find((member) => member.name === MANIFEST_NAME)
  if (!manifestMember) throw new Error(`包里没有 ${MANIFEST_NAME}：不像是心灵的迁移包`)
  let manifest: ArchiveManifest
  try {
    manifest = JSON.parse(manifestMember.data.toString('utf8')) as ArchiveManifest
  } catch {
    throw new Error('manifest.json 不是合法 JSON：包可能损坏')
  }
  const members = new Map<string, Buffer>()
  const duplicates: string[] = []
  for (const member of parsed) {
    if (member.name === MANIFEST_NAME) continue
    if (members.has(member.name)) duplicates.push(member.name)
    members.set(member.name, member.data)
  }
  return { manifest, members, duplicates }
}

/** Windows 上的保留设备名：这些名字做文件名会被系统解释成设备，写盘行为不可预测。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * 判断包内路径是否安全。
 *
 * 拦的是「包里的路径能把文件写到数据根外面，或者写到不该写的地方」：
 * - 空路径、含 `\0`、绝对路径、盘符、`..`（zip-slip）；
 * - 冒号：Windows 上 `a.txt:evil` 是**备用数据流**（ADS），落盘后主文件看不见、扫不出来；
 * - Windows 保留名（`CON`/`NUL`/`COM1`…）：写进去不会得到普通文件；
 * - 结尾的空格或点：Windows 会静默去掉，两个不同路径落到同一个文件上。
 */
export function isSafeArchivePath(path: string): boolean {
  if (!path || path.includes('\0')) return false
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return false
  if (path.includes(':')) return false
  const parts = path.split(/[\\/]+/)
  if (!parts.every((part) => part !== '' && part !== '.' && part !== '..')) return false
  for (const part of parts) {
    if (WINDOWS_RESERVED.test(part)) return false
    if (part.endsWith(' ') || part.endsWith('.')) return false
  }
  return true
}

/**
 * 只读校验一个包：结构、清单、逐文件 sha256。
 *
 * 参数：`file` 包路径。
 * 返回：`{ok, manifest, problems, bytes}`；`ok` 为假时 `problems` 一定非空。
 * 注意：这里**不解压到磁盘**，只把字节读进内存比哈希（我们的包最多几十 MB）。
 */
export function verifyArchive(file: string, options: { limits?: ArchiveLimits } = {}): ArchiveVerifyResult {
  const limits = options.limits ?? ARCHIVE_LIMITS
  const problems: ArchiveProblem[] = []
  let manifest: ArchiveManifest | null = null
  let bytes = 0
  try {
    bytes = statSync(file).size
  } catch {
    return { ok: false, manifest: null, problems: [{ path: '', reason: `找不到文件：${file}` }], bytes: 0 }
  }
  let members: Map<string, Buffer>
  let duplicates: string[] = []
  try {
    const read = readArchive(file, limits)
    manifest = read.manifest
    members = read.members
    duplicates = read.duplicates
  } catch (error) {
    return { ok: false, manifest, problems: [{ path: '', reason: (error as Error).message }], bytes }
  }
  if (manifest.format !== ARCHIVE_FORMAT) problems.push({ path: '', reason: `不是心灵迁移包（format=${String(manifest.format)}）` })
  if (manifest.formatVersion > ARCHIVE_FORMAT_VERSION) {
    problems.push({ path: '', reason: `包格式版本 ${manifest.formatVersion} 比插件支持的 ${ARCHIVE_FORMAT_VERSION} 新，请先升级插件` })
  }
  for (const name of duplicates) {
    problems.push({ path: name, reason: '同一个路径在包里出现多次：取哪一份都可能掩盖另一份' })
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    problems.push({ path: '', reason: '清单里没有文件列表' })
  }
  // E6-B2：清单自报的总字节数必须与逐文件相加一致。旧包没有这个字段，缺省跳过。
  if (typeof manifest.totalBytes === 'number') {
    const sum = (manifest.files ?? []).reduce((total, entry) => total + (Number(entry.bytes) || 0), 0)
    if (sum !== manifest.totalBytes) {
      problems.push({ path: '', reason: `清单 totalBytes=${manifest.totalBytes} 与逐文件相加 ${sum} 不一致` })
    }
  }
  for (const entry of manifest.files ?? []) {
    if (!isSafeArchivePath(entry.path)) {
      problems.push({ path: entry.path, reason: '路径不安全（绝对路径或含 ..）' })
      continue
    }
    const data = members.get(entry.path)
    if (!data) {
      problems.push({ path: entry.path, reason: '包里缺少这个文件' })
      continue
    }
    if (data.length !== entry.bytes) {
      problems.push({ path: entry.path, reason: `大小不符：清单 ${entry.bytes}，实际 ${data.length}` })
      continue
    }
    const digest = createHash('sha256').update(data).digest('hex')
    if (digest !== entry.sha256) problems.push({ path: entry.path, reason: 'sha256 不符（文件被改过或包损坏）' })
  }
  // 包里多出清单之外的文件也算问题：恢复时不知道该不该落盘，索性拒绝
  for (const name of members.keys()) {
    if (!(manifest.files ?? []).some((entry) => entry.path === name)) {
      problems.push({ path: name, reason: '清单里没有这个文件（多余成员）' })
    }
  }
  return { ok: problems.length === 0, manifest, problems, bytes }
}

/** 解包结果：暂存目录 + 清单 + 已落盘文件数。 */
export interface ArchiveExtractResult {
  manifest: ArchiveManifest
  dir: string
  files: number
}

/**
 * 把包解到 `targetDir`（必须是一个**新建**的空目录），先校验再写盘。
 *
 * 参数：`file` 包；`targetDir` 目标目录；`now` 注入时间（生成目录名/测试用）。
 * 返回：`ArchiveExtractResult`。
 * 失败：校验不过或路径不安全都抛，且会把半成品目录清掉——绝不留下「看起来能用」的暂存区。
 */
export function extractArchive(file: string, targetDir: string, options: { limits?: ArchiveLimits } = {}): ArchiveExtractResult {
  const limits = options.limits ?? ARCHIVE_LIMITS
  const verified = verifyArchive(file, { limits })
  if (!verified.ok || !verified.manifest) {
    const detail = verified.problems.map((item) => `${item.path || '(包)'}: ${item.reason}`).join('；')
    throw new Error(`迁移包校验失败：${detail}`)
  }
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new Error(`暂存目录必须为空：${targetDir}`)
  }
  mkdirSync(targetDir, { recursive: true })
  try {
    const read = readArchive(file, limits)
    let count = 0
    let totalBytes = 0
    for (const entry of read.manifest.files) {
      if (!isSafeArchivePath(entry.path)) throw new Error(`路径不安全：${entry.path}`)
      const data = read.members.get(entry.path)
      if (!data) throw new Error(`包里缺少文件：${entry.path}`)
      // 落盘前再量一次：清单可以撒谎，真正要写多少字节以拿到的 buffer 为准
      if (data.length > limits.memberBytes) {
        throw limitError(`文件 ${entry.path} 有 ${data.length} 字节，超过单文件上限`, limits)
      }
      totalBytes += data.length
      if (totalBytes > limits.totalBytes) {
        throw limitError(`总解压量超过 ${limits.totalBytes} 字节`, limits)
      }
      const dest = join(targetDir, ...entry.path.split('/'))
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, data)
      count += 1
    }
    return { manifest: read.manifest, dir: targetDir, files: count }
  } catch (error) {
    try {
      rmSync(targetDir, { recursive: true, force: true })
    } catch {
      // 清不掉也没关系：这个目录名带时间戳，不会覆盖任何东西
    }
    throw error
  }
}

// ── 恢复 ─────────────────────────────────────────────────────────────────────

/** 恢复前检查的结果：能不能装、装进去之后插件能不能读。 */
export interface RestorePlan {
  ok: boolean
  manifest: ArchiveManifest | null
  problems: ArchiveProblem[]
  stagedDir: string
  /** 数据根里已经存在的东西（恢复会整体替换掉它，界面要如实告诉人）。 */
  existing: { db: boolean; bytes: number }
}

/**
 * 恢复第一步：解包到一个**数据根同级**的暂存目录，并检查能不能装。
 *
 * 参数：`dataDir` 当前数据根；`file` 迁移包；`summary` 用于校验的几个事实
 *      （`schemaVersion` 插件当前版本、`personaId` 当前人格 id）；`now` 注入时间。
 * 返回：`RestorePlan`；`ok` 为假时暂存目录已被清掉，数据根一个字节都没动。
 * 检查项：格式、逐文件哈希、`user_version` 不能高于插件版本、人格 id 一致、
 *        快照能打开且 `PRAGMA integrity_check` 为 ok。
 */
export function prepareRestore(options: {
  dataDir: string
  file: string
  schemaVersion: number
  personaId?: string
  now?: Date
  limits?: ArchiveLimits
}): RestorePlan {
  const problems: ArchiveProblem[] = []
  const stagedDir = join(dirname(resolve(options.dataDir)), `.psyche-restore-${Date.now()}`)
  let manifest: ArchiveManifest | null = null
  let extracted: ArchiveExtractResult | null = null
  try {
    extracted = extractArchive(options.file, stagedDir, { limits: options.limits })
    manifest = extracted.manifest
  } catch (error) {
    return {
      ok: false,
      manifest,
      problems: [{ path: '', reason: (error as Error).message }],
      stagedDir,
      existing: describeExisting(options.dataDir)
    }
  }
  if (manifest.personaId !== (options.personaId ?? 'main')) {
    problems.push({ path: MANIFEST_NAME, reason: `人格 id 不符：包是 ${manifest.personaId}，本机是 ${options.personaId ?? 'main'}` })
  }
  if (manifest.schemaVersion > options.schemaVersion) {
    problems.push({
      path: 'memory.sqlite3',
      reason: `包里的库是 v${manifest.schemaVersion}，当前插件只到 v${options.schemaVersion}：先升级插件再恢复`
    })
  }
  // 快照本身能不能当真用，只有真读一遍才知道：
  // integrity（页完整性）+ 外键 + user_version + 必需表/触发器/索引 + persona 归属 + 表计数对账。
  // 只查 integrity_check 是不够的——缺触发器的库「数据完整」但只追加不变量已经没了。
  const dbFile = join(stagedDir, 'memory.sqlite3')
  if (!existsSync(dbFile)) {
    problems.push({ path: 'memory.sqlite3', reason: '包里没有 memory.sqlite3' })
  } else {
    const check = checkDatabaseFile({
      file: dbFile,
      expectedVersion: manifest.schemaVersion,
      personaId: options.personaId ?? 'main',
      expectedCounts: manifest.counts,
    })
    for (const problem of check.problems) {
      problems.push({ path: 'memory.sqlite3', reason: problem.detail })
    }
  }
  if (problems.length > 0) {
    try {
      rmSync(stagedDir, { recursive: true, force: true })
    } catch {
      // 同上：清不掉也安全
    }
    return { ok: false, manifest, problems, stagedDir, existing: describeExisting(options.dataDir) }
  }
  return { ok: true, manifest, problems, stagedDir, existing: describeExisting(options.dataDir) }
}

/** 看一眼现在的数据根：给人确认「这一步会覆盖什么」。 */
function describeExisting(dataDir: string): { db: boolean; bytes: number } {
  const dbFile = join(dataDir, 'memory.sqlite3')
  if (!existsSync(dbFile)) return { db: false, bytes: 0 }
  try {
    return { db: true, bytes: statSync(dbFile).size }
  } catch {
    return { db: true, bytes: 0 }
  }
}

/** 恢复第二步的结果。`keptDir` 非空表示旧数据被改名保留，随时可以换回去。 */
export interface RestoreApplyResult {
  ok: boolean
  dataDir: string
  keptDir: string | null
  files: number
}

/**
 * 恢复第二步：把暂存目录换成新的数据根，旧目录改名保留。
 *
 * 前置条件：**调用方已经关掉数据库连接**（Windows 上打开着的文件改不了名）。
 * 参数：`dataDir` 当前数据根；`stagedDir` 第一步的暂存目录；`now` 注入时间。
 * 返回：`RestoreApplyResult`；失败会把名字尽量换回来，避免「一半新一半旧」。
 */
export function applyRestore(options: { dataDir: string; stagedDir: string; now?: Date }): RestoreApplyResult {
  const dataDir = resolve(options.dataDir)
  const staged = resolve(options.stagedDir)
  if (!existsSync(staged)) throw new Error(`暂存目录不存在：${staged}`)
  if (dirname(staged) !== dirname(dataDir)) {
    throw new Error('暂存目录必须与数据根同级，否则跨盘移动不是原子操作')
  }
  const stamp = new Date(options.now ?? Date.now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const keptDir = existsSync(dataDir) ? `${dataDir}.old-${stamp}` : null
  let movedOld = false
  try {
    if (keptDir) {
      renameSync(dataDir, keptDir)
      movedOld = true
    }
    renameSync(staged, dataDir)
  } catch (error) {
    // 换名失败：尽量把旧目录放回去，让插件至少还能用原来的库
    if (movedOld && keptDir && !existsSync(dataDir)) {
      try {
        renameSync(keptDir, dataDir)
      } catch {
        // 连回滚都失败：把两个路径都写进错误里，让人手动处理
        throw new Error(`恢复失败且回滚失败。旧数据在：${keptDir}；请手动把它的内容移回 ${dataDir}。原因：${(error as Error).message}`)
      }
    }
    throw error
  }
  const files = countFiles(dataDir)
  return { ok: true, dataDir, keptDir, files }
}

/** 数一下目录里的文件数（只用于回执「恢复进来多少个文件」）。 */
function countFiles(dir: string): number {
  let total = 0
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    try {
      const stat = statSync(full)
      if (stat.isDirectory()) total += countFiles(full)
      else total += 1
    } catch {
      // 单个文件 stat 失败不影响计数
    }
  }
  return total
}

/** 供运维页渲染的一行：包 + 能不能用（`null` 表示还没校验过）。 */
export interface ArchiveRow {
  name: string
  file: string
  bytes: number
  at: string
  verified: boolean | null
  files: number | null
  schemaVersion: number | null
}

/** 列出包并附带「上次校验结论」，运维页一次拿全，不用点一次查一次。 */
export function listArchiveRows(dataDir: string, limit = 10): ArchiveRow[] {
  return listArchives(dataDir, limit).map((item) => {
    const verified = verifyArchive(item.file)
    return {
      name: item.name,
      file: item.file,
      bytes: item.bytes,
      at: item.at,
      verified: verified.ok,
      files: verified.manifest ? verified.manifest.files.length : null,
      schemaVersion: verified.manifest ? verified.manifest.schemaVersion : null
    }
  })
}

/** 便利函数：把 `basename` 之外的东西都抹掉，回执里只给人看文件名。 */
export function displayName(file: string): string {
  return basename(file)
}
