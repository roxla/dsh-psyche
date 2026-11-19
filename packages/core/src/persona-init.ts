// 人格初始化状态机（v15 §39）：claim 独占 + 两文件原子写 + DB 派生快照。
// 被谁调用：src/index.ts（启动判定 / reconcile / DB 同步 / 三个 HTTP 路由）、tools/psyche-persona.mjs（CLI）。
// 关键不变量：
//   1) 目录是唯一真相：`identity.md` 是预设原文、`persona.json` 是权威记录、`persona.init.lock` 是过程状态，
//      **DB 只是派生快照**——`syncPersonaConfigFromFile()` 从文件修复库，绝不反向覆盖文件；
//   2) 原子性靠 claim：`openSync(..., 'wx')` 抢到一个独占文件才允许动两文件，抢不到就是 `E_INIT_RACE`；
//      任何一步失败都**保留 claim 与已完成文件**，由人用 `finish` / `abort` 收尾（§39.5.2 判据表）；
//   3) 损坏不自动恢复默认（§3.3）：JSON 坏、状态未知、`personaId` 不对一律判 `damaged`，
//      只报告、只允许人工动作，绝不「猜一个默认人格继续跑」；
//   4) 本模块不做 IO 之外的决策：不读模型、不改关系、不碰成长；所有依赖（fs / db / 时钟 / pid）都可注入。
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import type { SqlParam } from './adapter.js'
import { PsycheError, CODE } from './errors.js'
import {
  CORE_COMMITMENTS,
  PRESET_IDS,
  findPreset,
  mergeCommitments,
  type PersonaPreset,
  type PresetCommitment,
  type PresetId,
  type PresetTendency,
} from './presets.js'

/** 单一人格固定 id（与 schema 的 seed 一致）。 */
export const PERSONA_ID = 'main'

/** `identity.md` 的文件名（预设原文，只有初始化与人工编辑写）。 */
export const IDENTITY_FILE = 'identity.md'

/** `persona.json` 的文件名（初始化记录 + 承诺 + 倾向，权威）。 */
export const PERSONA_FILE = 'persona.json'

/** 初始化 claim 的文件名：独占创建即「本轮初始化归我」，删掉即「这次尝试结束」。 */
export const CLAIM_FILE = 'persona.init.lock'

/** `persona.json` 自己的版本号（与库的 `user_version` 无关）。 */
export const PERSONA_SCHEMA_VERSION = 1

/** 五态：只有 `locked` 是「能确定她是谁」，其余四态都在等一个动作（§39.3）。 */
export type InitState = 'uninitialized' | 'initializing' | 'locked' | 'identity-drift' | 'damaged'

/** 当前状态下允许的动作（面板与 CLI 据此渲染按钮；HTTP 只暴露其中的 init/preset 与 accept-drift）。 */
export type InitAction = 'initialize' | 'finish' | 'abort' | 'accept-drift' | 'reset'

/** claim 的正文：谁、什么时候、为什么持有它、期望落盘的原文哈希。 */
export interface InitClaim {
  /** `init` 是首次初始化，`reset` 是重置流程（§39.9.1 用同一个 claim 原语）。 */
  kind: 'init' | 'reset'
  /** 本轮的独占标识：finish/abort 带上它，才能证明「我是这一轮的持有者」。旧 claim 可为 null。 */
  token: string | null
  /** 初始化操作标识（日志/审计用；旧 claim 可能只有 legacy 值）。 */
  opId: string
  pid: number
  startedAt: string
  presetId: string | null
  /** 自定义人格的显示名（预设人格为 null；旧 claim 没有这个字段）。 */
  presetName?: string | null
  pendingIdentityHash: string | null
}

/** `persona.json` 里的初始化记录（字段与 §39.4 一致）。 */
export interface PersonaInitialization {
  status: 'initializing' | 'locked'
  /** 预设 id；自定义人格为 null（不伪造一个不存在的预设）。 */
  presetId: PresetId | null
  presetName: string
  presetVersion: string
  presetDraft: boolean
  initializedAt: string
  lockedAt: string | null
  identityHash: string | null
  identityBytes: number | null
  pendingIdentityHash: string | null
  resetFrom: string | null
}

/** `persona.json` 的完整结构。 */
export interface PersonaDocument {
  schemaVersion: number
  personaId: string
  initialization: PersonaInitialization
  commitments: PresetCommitment[]
  tendencies: PresetTendency[]
  updatedAt: string
}

/** 一次判定的完整结果：只读，不发散成「顺手修一下」。 */
export interface InitSnapshot {
  state: InitState
  personaId: string
  presetId: string | null
  presetName: string | null
  presetVersion: string | null
  draft: boolean
  initializedAt: string | null
  lockedAt: string | null
  identityHash: string | null
  identityBytes: number | null
  /** 原文哈希与记录是否一致；`null` 表示没法判断（缺文件 / 没记哈希）。 */
  hashMatches: boolean | null
  claim: {
    kind: InitClaim['kind']
    pid: number
    startedAt: string
    ownerAlive: boolean
    presetId: string | null
    /** 自定义人格的显示名（预设人格为 null）。 */
    presetName?: string | null
    pendingIdentityHash: string | null
  } | null
  /** 人话状态说明（面板横幅与 CLI 直接显示这句）。 */
  detail: string
  actions: InitAction[]
  files: { identity: boolean; persona: boolean; claim: boolean }
}

/** 初始化产出的结果：文档 + 预设 + 落盘哈希（调用方不需要再读一遍文件）。 */
export interface InitializeResult {
  persona: PersonaDocument
  /** 预设来源；自定义人格为 null（来源写在 persona.json 的 presetName 里）。 */
  preset: PersonaPreset | null
  identityHash: string
  identityBytes: number
  dbSynced: boolean
  /** 本轮 claim 的独占 token：调用方要 finish/abort 时带上它（崩溃残留场景可省略）。 */
  claimToken: string
  snapshot: InitSnapshot
}

/** 自定义人格输入：用户自己写名字与身份正文，不经过预设加载器。 */
export interface CustomPersonaInput {
  /** 身份正文（会成为 identity.md 原文）。 */
  identity: string
  /** 显示名；缺省「自定义人格」。 */
  name?: string
}

/** 可注入的 fs 面（只要这九个方法；测试用包装器在第 N 次写/改名时抛错）。 */
export interface InitFs {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string, options: { encoding: 'utf8'; mode?: number }): void
  renameSync(from: string, to: string): void
  unlinkSync(path: string): void
  openSync(path: string, flags: string, mode?: number): number
  writeSync(fd: number, data: string): void
  closeSync(fd: number): void
  mkdirSync(path: string, options: { recursive: true }): void
  statSync(path: string): { mtimeMs: number; size: number }
}

/** 可注入的数据库面：只要「跑一条语句 / 查一条 / 开事务」三件事。 */
export interface InitDb {
  run(sql: string, params?: readonly SqlParam[]): unknown
  get<T = Record<string, SqlParam>>(sql: string, params?: readonly SqlParam[]): T | undefined
  transaction<T>(fn: () => T): T
}

/** 依赖注入：时钟与进程检查也进来，否则崩溃窗口与 claim 所有权没法测。 */
export interface InitDeps {
  fs?: InitFs
  db?: InitDb | null
  now?: () => Date
  pid?: number
  isProcessAlive?: (pid: number) => boolean
}

/** 数据根里的三个路径。 */
export interface InitPaths {
  dataDir: string
  identity: string
  persona: string
  claim: string
}

/** 拼出三个路径（不创建目录）。 */
export function initPathsOf(dataDir: string): InitPaths {
  return {
    dataDir,
    identity: join(dataDir, IDENTITY_FILE),
    persona: join(dataDir, PERSONA_FILE),
    claim: join(dataDir, CLAIM_FILE),
  }
}

/** 默认依赖：node 的 fs / 真实时钟 / 自己的 pid / `process.kill(pid, 0)` 判活。 */
function resolveDeps(deps: InitDeps = {}): Required<Omit<InitDeps, 'db'>> & { db: InitDb | null } {
  return {
    fs: deps.fs ?? (nodeFs as InitFs),
    db: deps.db ?? null,
    now: deps.now ?? (() => new Date()),
    pid: deps.pid ?? process.pid,
    isProcessAlive: deps.isProcessAlive ?? processAlive,
  }
}

// node:fs 的函数签名比上面的最小面更宽（比如 writeFileSync 允许 string），
// 但结构上兼容；这里只做一次断言，避免每个调用点都写 as。
const nodeFs = {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
  mkdirSync,
  statSync,
}

/** 进程是否还活着：`EPERM` 说明进程在但没权限信号，仍算活。 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 文本的 sha256（十六进制），用于 `identityHash`。 */
export function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 只读判定：不发散、不写盘、不删 claim —— 面板 20s 轮询会反复调它。 */
export function inspectInitialization(options: { dataDir: string } & InitDeps): InitSnapshot {
  const deps = resolveDeps(options)
  const paths = initPathsOf(options.dataDir)
  const hasIdentity = deps.fs.existsSync(paths.identity)
  const hasPersona = deps.fs.existsSync(paths.persona)
  const hasClaim = deps.fs.existsSync(paths.claim)

  const identityText = hasIdentity ? deps.fs.readFileSync(paths.identity, 'utf8') : null
  const identityHash = identityText === null ? null : sha256OfText(identityText)
  const readPersona = hasPersona ? loadPersonaDocument(deps.fs, paths.persona) : null
  const readClaim = hasClaim ? loadClaim(deps.fs, paths.claim) : null

  const base = {
    personaId: PERSONA_ID,
    presetId: null as string | null,
    presetName: null as string | null,
    presetVersion: null as string | null,
    draft: false,
    initializedAt: null as string | null,
    lockedAt: null as string | null,
    identityHash: null as string | null,
    identityBytes: null as number | null,
    hashMatches: null as boolean | null,
    claim: null as InitSnapshot['claim'],
    files: { identity: hasIdentity, persona: hasPersona, claim: hasClaim },
  }

  // claim 读不出来：状态机断了，但人还能 abort（删掉坏 claim 与半成品）
  if (readClaim && readClaim.problem) {
    return finish({
      state: 'damaged',
      detail: `初始化状态文件坏了：${readClaim.problem}。人工确认后可以 abort 清掉它。`,
      actions: ['abort'],
    })
  }

  const claim = readClaim?.claim ?? null
  if (claim) {
    Object.assign(base, {
      claim: {
        kind: claim.kind,
        pid: claim.pid,
        startedAt: claim.startedAt,
        ownerAlive: deps.isProcessAlive(claim.pid),
        presetId: claim.presetId,
        presetName: claim.presetName ?? null,
        pendingIdentityHash: claim.pendingIdentityHash,
      },
    })
  }

  // persona.json 存在但坏了：damaged（绝不当成「没有」去重建）
  if (readPersona && readPersona.problem) {
    return finish({
      state: 'damaged',
      detail: `persona.json 读不出来：${readPersona.problem}。这份记录不会自动重建。`,
      actions: claim ? ['abort'] : [],
    })
  }

  const document = readPersona?.document ?? null
  if (document) {
    const init = document.initialization
    Object.assign(base, {
      presetId: init.presetId,
      presetName: init.presetName,
      presetVersion: init.presetVersion,
      draft: init.presetDraft,
      initializedAt: init.initializedAt,
      lockedAt: init.lockedAt,
      identityHash: init.identityHash ?? init.pendingIdentityHash,
      identityBytes: init.identityBytes,
    })
  }

  // ── 没有 claim 的分支 ────────────────────────────────
  if (!claim) {
    if (!document) {
      if (hasIdentity) {
        return finish({
          state: 'damaged',
          detail: '目录里有 identity.md，却没有人格记录（persona.json）：说不清她是谁，不自动修。',
          actions: [],
        })
      }
      return finish({
        state: 'uninitialized',
        detail: '还没有人格基底：选一套预设开始。',
        actions: ['initialize'],
      })
    }

    const init = document.initialization
    if (init.status === 'initializing') {
      return finish({
        state: 'damaged',
        detail: '人格记录停在「初始化中」，但没有 claim 文件：状态机断了，只能人工 finish 或 abort。',
        actions: ['finish', 'abort'],
      })
    }

    const matches = hasIdentity && identityHash !== null && init.identityHash !== null ? identityHash === init.identityHash : null
    base.hashMatches = matches
    if (!hasIdentity) {
      return finish({
        state: 'damaged',
        detail: '人格已锁定，但 identity.md 不见了：原文丢了就没法确认她是谁。',
        actions: [],
      })
    }
    if (matches === false) {
      return finish({
        state: 'identity-drift',
        detail: 'identity.md 在锁定之后被改过（哈希对不上）。这是人工行为，不会被自动接受。',
        actions: ['accept-drift', 'reset'],
      })
    }
    return finish({
      state: 'locked',
      detail: '人格基底已锁定。',
      actions: ['reset'],
    })
  }

  // ── 有 claim 的分支：这一轮初始化还没收尾 ──────────────
  if (document && document.initialization.status === 'locked') {
    // 现场 D：两文件都好了，只剩 claim 残留（崩在最后一步）
    const matches = hasIdentity && identityHash !== null && document.initialization.identityHash !== null
      ? identityHash === document.initialization.identityHash
      : null
    base.hashMatches = matches
    if (matches === false) {
      return finish({
        state: 'identity-drift',
        detail: '初始化已完成，但 identity.md 的哈希对不上记录（结束时被改过）。',
        actions: ['accept-drift'],
      })
    }
    return finish({
      state: 'locked',
      detail: deps.isProcessAlive(claim.pid) ? '初始化已完成，claim 还没删。' : '初始化已完成，留下了一个失效的 claim（上次进程没来得及删）。',
      actions: [],
    })
  }

  // 现场 A / B / C：没有 locked 记录，claim 还在
  const pending = claim.pendingIdentityHash
  const pendingMatches = pending === null ? null : identityHash !== null && pending === identityHash
  base.hashMatches = pendingMatches
  if (!hasIdentity) {
    return finish({
      state: 'initializing',
      detail: '初始化已经开始，但 identity.md 还没写出来。',
      actions: ['abort'],
    })
  }
  if (pending !== null && pendingMatches === false) {
    return finish({
      state: 'initializing',
      detail: 'identity.md 与 claim 里记的期望哈希不符（半成品被改过）：只能 abort。',
      actions: ['abort'],
    })
  }
  return finish({
    state: 'initializing',
    detail: document ? '初始化写到一半：人格记录还是「初始化中」。' : '初始化写到一半：identity.md 有了，人格记录还没写。',
    actions: ['finish', 'abort'],
  })

  /** 补全可变字段后返回（避免每个分支重复写 personaId / files）。 */
  function finish(partial: Pick<InitSnapshot, 'state' | 'detail' | 'actions'>): InitSnapshot {
    return { ...base, ...partial } as InitSnapshot
  }
}

/**
 * 启动期收尾：只做一件「安全且必然正确」的事 —— 两文件都已 locked、claim 的持有进程已死时删掉 claim。
 *
 * 为什么只做这一件：其余现场（initializing、damaged、drift）都需要判断，而启动期不该替用户判断。
 */
export function reconcileInitialization(
  options: { dataDir: string } & InitDeps,
): { snapshot: InitSnapshot; actions: string[] } {
  const deps = resolveDeps(options)
  const paths = initPathsOf(options.dataDir)
  const before = inspectInitialization(options)
  const actions: string[] = []
  if (before.state === 'locked' && before.claim && !before.claim.ownerAlive) {
    deps.fs.unlinkSync(paths.claim)
    actions.push('cleared-stale-claim')
  }
  return { snapshot: actions.length > 0 ? inspectInitialization(options) : before, actions }
}

/** 自定义身份正文的长度边界：太短当不了身份基底，太长会挤爆注入预算/文件。 */
export const CUSTOM_IDENTITY_MIN_CHARS = 200
export const CUSTOM_IDENTITY_MAX_CHARS = 8000

/** 自定义人格的默认倾向（用户没提供倾向数据时用中立值，不假装有性格数据）。 */
const CUSTOM_DEFAULT_TENDENCIES: PresetTendency[] = [
  { key: 'warmth', initial: 0.5, note: '自定义人格的默认倾向' },
  { key: 'directness', initial: 0.5, note: '自定义人格的默认倾向' },
  { key: 'initiative', initial: 0.5, note: '自定义人格的默认倾向' },
  { key: 'patience', initial: 0.5, note: '自定义人格的默认倾向' },
  { key: 'playfulness', initial: 0.5, note: '自定义人格的默认倾向' },
  { key: 'steadiness', initial: 0.5, note: '自定义人格的默认倾向' },
]

/**
 * 校验并规范化自定义人格输入。
 * 红线：不合格的文本直接拒绝，不悄悄截断/替换——身份原文一旦落盘就是权威。
 */
export function normaliseCustomPersona(input: CustomPersonaInput): { identity: string; name: string } {
  const raw = typeof input?.identity === 'string' ? input.identity : ''
  const identity = raw.replace(/\r\n/g, '\n').trim()
  if (!identity) throw new PsycheError(CODE.validation, '自定义人格缺少身份正文')
  if (identity.length < CUSTOM_IDENTITY_MIN_CHARS) {
    throw new PsycheError(
      CODE.validation,
      `自定义身份太短（${identity.length} 字）：至少 ${CUSTOM_IDENTITY_MIN_CHARS} 字，否则当不了身份基底。`,
      { min: CUSTOM_IDENTITY_MIN_CHARS, actual: identity.length },
    )
  }
  if (identity.length > CUSTOM_IDENTITY_MAX_CHARS) {
    throw new PsycheError(
      CODE.validation,
      `自定义身份太长（${identity.length} 字）：最多 ${CUSTOM_IDENTITY_MAX_CHARS} 字。`,
      { max: CUSTOM_IDENTITY_MAX_CHARS, actual: identity.length },
    )
  }
  if (identity.includes('\u0000')) {
    throw new PsycheError(CODE.validation, '自定义身份里有空字符（\\0），不是合法文本')
  }
  if (/\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/.test(identity)) {
    throw new PsycheError(CODE.validation, '自定义身份里还有没替换的占位符（形如 {{name}}）：先填好再初始化')
  }
  const name = typeof input?.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 40) : '自定义人格'
  return { identity, name }
}

/**
 * 首次初始化：抢 claim → 写 identity.md → 写 persona.json(initializing) → 写(locked) → 同步 DB → 删 claim。
 *
 * 参数：`presetId` 必须是内置五套之一；或者给 `custom` 直接写用户提供的身份正文。
 * `db` 给了才写快照与 `personality_history`。
 * 抛：`E_PRESET_UNKNOWN` / `E_PRESET_INVALID`（预设）、`E_VALIDATION`（自定义正文不合格）、
 *     `E_INIT_LOCKED`（已锁）、`E_INIT_RACE`（另一个写入者持有 claim）、
 *     `E_INIT_STATE`（drift/damaged 不允许初始化）、`E_INTERNAL`（中途 IO 失败，现场保留）。
 */
export function initializePersona(
  options: {
    dataDir: string
    presetId?: PresetId | string
    presetDir?: string | URL
    custom?: CustomPersonaInput
  } & InitDeps,
): InitializeResult {
  const deps = resolveDeps(options)
  const paths = initPathsOf(options.dataDir)
  const custom = options.custom ? normaliseCustomPersona(options.custom) : null
  if (!custom && (typeof options.presetId !== 'string' || !options.presetId)) {
    throw new PsycheError(CODE.validation, '初始化必须选一个预设，或提供自定义身份正文。')
  }
  const preset = custom
    ? null
    : findPreset(options.presetId as PresetId | string, options.presetDir ? { dir: options.presetDir } : {})
  const presetId = preset ? preset.presetId : null
  const presetName = custom ? custom.name : (preset?.presetName ?? '')
  const presetVersion = custom ? 'custom' : (preset?.presetVersion ?? '')
  const presetDraft = custom ? false : preset?.draft === true
  const identitySource = custom ? custom.identity : (preset?.identity ?? '')
  const commitments = custom ? [...CORE_COMMITMENTS] : mergeCommitments(preset as PersonaPreset)
  const tendencies = custom
    ? CUSTOM_DEFAULT_TENDENCIES.map((item) => ({ ...item }))
    : (preset?.tendencies ?? []).map((item) => ({ ...item }))

  const before = inspectInitialization(options)
  if (before.state === 'locked') {
    throw new PsycheError(
      CODE.initLocked,
      `人格基底已经锁定（${before.presetName ?? before.presetId}，${before.lockedAt ?? '时间未知'}）。要换基底只能走人工重置。`,
      { presetId: before.presetId, lockedAt: before.lockedAt },
    )
  }
  if (before.state === 'initializing') {
    throw new PsycheError(CODE.initRace, '已经有一次初始化在进行中：先 finish 或 abort 收尾。', {
      claim: before.claim,
    })
  }
  if (before.state === 'identity-drift') {
    throw new PsycheError(CODE.initState, '人格原文被改过（drift）：先接受这次改动，或走人工重置。', {
      state: before.state,
    })
  }
  if (before.state === 'damaged') {
    throw new PsycheError(CODE.initState, `目录状态不明确，不能初始化：${before.detail}`, { state: before.state })
  }

  deps.fs.mkdirSync(options.dataDir, { recursive: true })
  const startedAt = isoOf(deps.now())
  const claim = claimCreate(deps, paths, {
    kind: 'init',
    pid: deps.pid,
    startedAt,
    presetId,
    presetName: custom ? custom.name : null,
    pendingIdentityHash: null,
  })

  let step = 1
  try {
    // 1–2. identity.md（原文；原子写）
    step = 2
    writeAtomic(deps.fs, deps.pid, paths.identity, identitySource)
    const identityText = deps.fs.readFileSync(paths.identity, 'utf8')
    const identityHash = sha256OfText(identityText)
    const identityBytes = deps.fs.statSync(paths.identity).size

    // 3. persona.json（initializing）：先落下「我要写的是什么」，崩了也能比对
    step = 3
    const now = isoOf(deps.now())
    const doc: PersonaDocument = {
      schemaVersion: PERSONA_SCHEMA_VERSION,
      personaId: PERSONA_ID,
      initialization: {
        status: 'initializing',
        presetId,
        presetName,
        presetVersion,
        presetDraft,
        initializedAt: now,
        lockedAt: null,
        identityHash: null,
        identityBytes,
        pendingIdentityHash: identityHash,
        resetFrom: null,
      },
      commitments,
      tendencies,
      updatedAt: now,
    }
    writeAtomic(deps.fs, deps.pid, paths.persona, JSON.stringify(doc, null, 2) + '\n')

    // 4. persona.json（locked）：哈希取实际落盘字节
    step = 4
    doc.initialization.status = 'locked'
    doc.initialization.lockedAt = isoOf(deps.now())
    doc.initialization.identityHash = identityHash
    // 锁定之后 pending 就没有意义了：留着会让「半成品」和「已完成」看起来一样
    doc.initialization.pendingIdentityHash = null
    doc.updatedAt = doc.initialization.lockedAt
    writeAtomic(deps.fs, deps.pid, paths.persona, JSON.stringify(doc, null, 2) + '\n')

    // 5. DB 派生快照 + 记账（同一事务）
    step = 5
    const dbSynced = writeDbSnapshot(deps, doc, null, 'initialized')

    // 6. claim 必须由写入者自己删（§39.5.1）
    step = 6
    deps.fs.unlinkSync(paths.claim)

    return {
      persona: doc,
      preset,
      identityHash,
      identityBytes,
      dbSynced,
      claimToken: claim.token,
      snapshot: inspectInitialization(options),
    }
  } catch (error) {
    throw new PsycheError(
      CODE.internal,
      `初始化在第 ${step} 步失败，现场已保留：看 ${CLAIM_FILE} 是否存在，用 finish 或 abort 收尾。`,
      { step, cause: errorText(error), claimPath: paths.claim, claimKept: deps.fs.existsSync(paths.claim) },
    )
  }
}

/**
 * 活着的持有者不能被抢：claim 由另一个仍在运行的进程持有时，finish/abort 必须带匹配 token。
 *
 * 崩溃残留（PID 已不存在）不套这条：收尾本来就是人在做，token 无从取得。
 * 同一进程（pid 相同）视为同一执行者的串行调用，不强制 token。
 */
function assertActiveClaimOwner(
  deps: ReturnType<typeof resolveDeps>,
  claimPath: string,
  claimToken: string | undefined,
): void {
  if (!deps.fs.existsSync(claimPath)) return
  const claim = loadClaim(deps.fs, claimPath).claim
  if (!claim) return
  if (claim.pid === deps.pid) return
  if (!deps.isProcessAlive(claim.pid)) return
  if (claim.token && claimToken === claim.token) return
  throw new PsycheError(
    CODE.initRace,
    `初始化锁由进程 ${claim.pid} 持有（仍在运行）：只有持有者能 finish/abort，其他人不能替它收尾。`,
    { pid: claim.pid, opId: claim.opId },
  )
}

/**
 * 收尾半成品（§39.5.2）：claim + 待确认哈希对得上，就把 persona.json 补成 locked。
 *
 * 幂等：已经是 locked 且哈希一致时返回 `alreadyLocked: true`，不写任何文件。
 */
export function finishInitialization(
  options: { dataDir: string; presetDir?: string | URL; claimToken?: string } & InitDeps,
): {
  alreadyLocked: boolean
  dbSync: 'synced' | 'skipped' | 'failed'
  persona: PersonaDocument
  identityHash: string
  snapshot: InitSnapshot
} {
  const deps = resolveDeps(options)
  const paths = initPathsOf(options.dataDir)
  assertActiveClaimOwner(deps, paths.claim, options.claimToken)
  const snapshot = inspectInitialization(options)

  // 现场 D：两文件都好了，只剩 claim 残留 —— 补一次库同步，然后删 claim（幂等）
  if (snapshot.state === 'locked') {
    const document = loadPersonaDocument(deps.fs, paths.persona)
    if (!document.document) throw new PsycheError(CODE.initIncomplete, '已锁定却读不出 persona.json')
    let dbSync: 'synced' | 'skipped' | 'failed' = 'skipped'
    if (deps.db) {
      try {
        // 文件是权威、库是派生：这里只补「文件已锁、库没跟上」的窗口。
        const json = JSON.stringify(document.document)
        const row = deps.db.get<{ persona_json: string }>(
          'SELECT persona_json FROM persona_config WHERE persona_id = ?',
          [PERSONA_ID],
        )
        if (row?.persona_json === json) {
          dbSync = 'synced'
        } else {
          writeDbSnapshot(deps, document.document, null, 'finish-resume')
          dbSync = 'synced'
        }
      } catch {
        // 库同步失败不推翻文件事实：claim 留着，下次还能重试。
        dbSync = 'failed'
      }
    }
    if (snapshot.files.claim && dbSync !== 'failed') deps.fs.unlinkSync(paths.claim)
    return {
      alreadyLocked: true,
      dbSync,
      persona: document.document,
      identityHash: document.document.initialization.identityHash ?? '',
      snapshot: inspectInitialization(options),
    }
  }
  if (snapshot.state !== 'initializing' || !snapshot.claim) {
    throw new PsycheError(CODE.initState, `当前状态是「${snapshot.state}」，只有 initializing 能 finish。`, {
      state: snapshot.state,
    })
  }
  if (!snapshot.files.identity) {
    throw new PsycheError(CODE.initIncomplete, 'identity.md 还没写出来，没有可锁定的原文；只能 abort。')
  }
  if (snapshot.claim.pendingIdentityHash && snapshot.hashMatches === false) {
    throw new PsycheError(CODE.initIncomplete, '半成品的哈希与 claim 里记的对不上：不能替它收尾，只能 abort。', {
      expected: snapshot.claim.pendingIdentityHash,
      actual: snapshot.identityHash,
    })
  }

  const identityText = deps.fs.readFileSync(paths.identity, 'utf8')
  const identityHash = sha256OfText(identityText)
  const identityBytes = deps.fs.statSync(paths.identity).size
  const now = isoOf(deps.now())

  // persona.json 可能还不存在（现场 B）：用 claim 里的 presetId 重建骨架
  const existing = loadPersonaDocument(deps.fs, paths.persona).document
  let document: PersonaDocument
  if (existing) {
    document = {
      ...existing,
      initialization: {
        ...existing.initialization,
        status: 'locked',
        lockedAt: now,
        identityHash,
        identityBytes,
        pendingIdentityHash: null,
      },
      updatedAt: now,
    }
  } else if (!snapshot.claim.presetId) {
    // 现场 B（自定义人格）：没有预设可回查，用 claim 里记的名字 + 已落盘的 identity.md 重建。
    if (!snapshot.claim.presetName) {
      throw new PsycheError(CODE.initIncomplete, 'claim 里既没有预设 id 也没有名字，无法重建人格记录')
    }
    document = {
      schemaVersion: PERSONA_SCHEMA_VERSION,
      personaId: PERSONA_ID,
      initialization: {
        status: 'locked',
        presetId: null,
        presetName: snapshot.claim.presetName,
        presetVersion: 'custom',
        presetDraft: false,
        initializedAt: snapshot.claim.startedAt,
        lockedAt: now,
        identityHash,
        identityBytes,
        pendingIdentityHash: null,
        resetFrom: null,
      },
      commitments: [...CORE_COMMITMENTS],
      tendencies: CUSTOM_DEFAULT_TENDENCIES.map((item) => ({ ...item })),
      updatedAt: now,
    }
  } else {
    const preset = findPreset(snapshot.claim.presetId, options.presetDir ? { dir: options.presetDir } : {})
    document = {
      schemaVersion: PERSONA_SCHEMA_VERSION,
      personaId: PERSONA_ID,
      initialization: {
        status: 'locked',
        presetId: preset.presetId,
        presetName: preset.presetName,
        presetVersion: preset.presetVersion,
        presetDraft: preset.draft,
        initializedAt: snapshot.claim.startedAt,
        lockedAt: now,
        identityHash,
        identityBytes,
        pendingIdentityHash: null,
        resetFrom: null,
      },
      commitments: mergeCommitments(preset),
      tendencies: preset.tendencies.map((item) => ({ ...item })),
      updatedAt: now,
    }
  }

  writeAtomic(deps.fs, deps.pid, paths.persona, JSON.stringify(document, null, 2) + '\n')
  const dbSynced = writeDbSnapshot(deps, document, existing, 'finish')
  deps.fs.unlinkSync(paths.claim)

  return {
    alreadyLocked: false,
    dbSync: dbSynced ? 'synced' : 'skipped',
    persona: document,
    identityHash,
    snapshot: inspectInitialization(options),
  }
}

/**
 * 放弃这次初始化：只删「本轮确实写过」的文件（按 mtime ≥ claim.startedAt 判定）。
 *
 * 为什么按时间判：同目录可能有更早的用户文件；abort 只该收掉自己造出来的半成品。
 */
export function abortInitialization(
  options: { dataDir: string; claimToken?: string } & InitDeps,
): { aborted: boolean; removed: string[]; snapshot: InitSnapshot } {
  const deps = resolveDeps(options)
  const paths = initPathsOf(options.dataDir)
  assertActiveClaimOwner(deps, paths.claim, options.claimToken)
  const snapshot = inspectInitialization(options)
  if (snapshot.state === 'locked' && !snapshot.claim) {
    throw new PsycheError(CODE.initLocked, '人格已锁定：abort 只用于收尾「初始化中」的现场。')
  }
  if (!snapshot.files.claim) {
    // 幂等：没有 claim 说明已经没有可放弃的现场；重复 abort 不当错误。
    if (snapshot.state === 'uninitialized' || snapshot.state === 'damaged') {
      return { aborted: false, removed: [], snapshot }
    }
    throw new PsycheError(CODE.initState, '没有 claim 文件：没有可放弃的初始化。', { state: snapshot.state })
  }

  // claim 还在 = 初始化没走完，identity/persona 都属于这次现场，abort 就是清掉它们。
  // 不按 mtime 与 startedAt 比较：同一毫秒内写入的文件 mtime 可能早于 startedAt，
  // 会把「刚写的 identity」误判成「历史文件」而留下残骸（persona-consistency 曾因此偶发失败）。
  const removed: string[] = []

  for (const file of [paths.identity, paths.persona]) {
    if (!deps.fs.existsSync(file)) continue
    deps.fs.unlinkSync(file)
    removed.push(file)
  }
  deps.fs.unlinkSync(paths.claim)
  removed.push(paths.claim)

  return { aborted: true, removed, snapshot: inspectInitialization(options) }
}

/**
 * 接受人工改过的原文（drift → locked）：把当前字节哈希记为新的 `identityHash`，并记账。
 *
 * 语义（§39.8）：`identityHash` 是**最后一次人工确认**，不是「内容不许变」。
 */
export function acceptIdentityDrift(
  options: { dataDir: string } & InitDeps,
): { persona: PersonaDocument; identityHash: string; snapshot: InitSnapshot } {
  const deps = resolveDeps(options)
  const paths = initPathsOf(options.dataDir)
  const snapshot = inspectInitialization(options)
  if (snapshot.state !== 'identity-drift') {
    throw new PsycheError(CODE.initState, `当前状态是「${snapshot.state}」，只有 identity-drift 需要确认。`, {
      state: snapshot.state,
    })
  }
  const document = loadPersonaDocument(deps.fs, paths.persona).document
  if (!document) throw new PsycheError(CODE.initState, 'persona.json 读不出来，不能确认')

  const identityText = deps.fs.readFileSync(paths.identity, 'utf8')
  const identityHash = sha256OfText(identityText)
  const identityBytes = deps.fs.statSync(paths.identity).size
  const now = isoOf(deps.now())
  const before = document.initialization.identityHash

  document.initialization.identityHash = identityHash
  document.initialization.identityBytes = identityBytes
  document.updatedAt = now
  writeAtomic(deps.fs, deps.pid, paths.persona, JSON.stringify(document, null, 2) + '\n')
  writeDbSnapshot(deps, document, null, `identity-drift accepted: ${before ?? '(none)'} -> ${identityHash}`)

  return { persona: document, identityHash, snapshot: inspectInitialization(options) }
}

/**
 * 文件 → DB 的同步边界（启动时跑一次）：把 `persona.json` 落进 `persona_config.persona_json`。
 *
 * 为什么单独一条：文件是权威，库是派生；这条同步必须能独立测试，所以**不依赖全局 db**，
 * 也不在内部开连接。`db` 缺失时只报告不同步，不抛错。
 */
export function syncPersonaConfigFromFile(
  options: { dataDir: string; db?: InitDb | null } & InitDeps,
): { synced: boolean; reason: string; before: string | null; after: string | null } {
  const deps = resolveDeps(options)
  const paths = initPathsOf(options.dataDir)
  const read = loadPersonaDocument(deps.fs, paths.persona)
  if (!read.document) {
    // 文件根本不存在时别说「读不出来」：那是两个不同的事实
    if (!deps.fs.existsSync(paths.persona)) {
      return { synced: false, reason: '没有 persona.json', before: null, after: null }
    }
    return { synced: false, reason: `persona.json 读不出来：${read.problem ?? '未知原因'}`, before: null, after: null }
  }
  if (read.document.initialization.status !== 'locked') {
    return { synced: false, reason: '人格还在初始化中，等 locked 再同步', before: null, after: null }
  }
  if (!deps.db) {
    return { synced: false, reason: '没有数据库连接', before: null, after: null }
  }

  const json = JSON.stringify(read.document)
  const row = deps.db.get<{ persona_json: string }>(
    'SELECT persona_json FROM persona_config WHERE persona_id = ?',
    [PERSONA_ID],
  )
  const before = row?.persona_json ?? null
  if (before === json) return { synced: false, reason: 'already-in-sync', before, after: json }

  const now = isoOf(deps.now())
  deps.db.transaction(() => {
    deps.db!.run(
      `INSERT INTO persona_config (persona_id, type, identity_path, persona_json, created_at, updated_at)
       VALUES (?, 'preset', ?, ?, ?, ?)
       ON CONFLICT(persona_id) DO UPDATE SET
         persona_json = excluded.persona_json,
         identity_path = excluded.identity_path,
         updated_at = excluded.updated_at`,
      [PERSONA_ID, IDENTITY_FILE, json, now, now],
    )
    deps.db!.run(
      `INSERT INTO personality_history (persona_id, field, before_value, after_value, reason, at)
       VALUES (?, 'persona.sync', ?, ?, 'sync-from-file', ?)`,
      [PERSONA_ID, before, json, now],
    )
  })

  return { synced: true, reason: 'synced', before, after: json }
}

/** 读并校验 persona.json：坏 JSON / 结构不对 / personaId 不对都返回 problem，不抛。 */
export function loadPersonaDocument(
  fs: InitFs,
  file: string,
): { document: PersonaDocument | null; problem: string | null } {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { document: null, problem: `读文件失败：${errorText(error)}` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { document: null, problem: `不是合法 JSON：${errorText(error)}` }
  }
  const problem = validatePersonaDocument(raw)
  if (problem) return { document: null, problem }
  return { document: raw as PersonaDocument, problem: null }
}

/** 结构校验：只认本插件写出来的形状，任何一处不对就判 damaged。 */
export function validatePersonaDocument(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return '顶层不是对象'
  const doc = raw as Record<string, unknown>
  if (doc.schemaVersion !== PERSONA_SCHEMA_VERSION) {
    return `schemaVersion 不认识：${String(doc.schemaVersion)}（支持 ${PERSONA_SCHEMA_VERSION}）`
  }
  if (doc.personaId !== PERSONA_ID) return `personaId 不是 ${PERSONA_ID}：${String(doc.personaId)}`
  const init = doc.initialization
  if (typeof init !== 'object' || init === null) return '缺 initialization'
  const record = init as Record<string, unknown>
  if (record.status !== 'initializing' && record.status !== 'locked') return `status 不认识：${String(record.status)}`
  // presetId 为 null 表示自定义人格（没有预设可回查）；非 null 才要求是内置五套之一。
  if (record.presetId !== null && !(PRESET_IDS as readonly string[]).includes(String(record.presetId))) {
    return `presetId 不认识：${String(record.presetId)}`
  }
  if (typeof record.presetName !== 'string' || !record.presetName) return '缺 presetName'
  if (typeof record.presetVersion !== 'string' || !record.presetVersion) return '缺 presetVersion'
  if (typeof record.initializedAt !== 'string' || !record.initializedAt) return '缺 initializedAt'
  if (record.status === 'locked' && (typeof record.identityHash !== 'string' || !record.identityHash)) {
    return 'status=locked 却没有 identityHash'
  }
  if (!Array.isArray(doc.commitments) || doc.commitments.length < CORE_COMMITMENTS.length) return 'commitments 不完整'
  if (!Array.isArray(doc.tendencies)) return 'tendencies 不是数组'
  if (typeof doc.updatedAt !== 'string' || !doc.updatedAt) return '缺 updatedAt'
  return null
}

/**
 * 独占创建 claim：已存在即 `E_INIT_RACE`（另一个写入者赢）。
 *
 * 生成并写入唯一 owner token 与操作标识：finish/abort 用它证明「我是这一轮的持有者」。
 */
function claimCreate(
  deps: ReturnType<typeof resolveDeps>,
  paths: InitPaths,
  claim: Omit<InitClaim, 'token' | 'opId'>,
): { token: string; opId: string } {
  const token = randomUUID()
  const opId = `${claim.kind}-${Date.now().toString(36)}-${token.slice(0, 8)}`
  let fd: number
  try {
    fd = deps.fs.openSync(paths.claim, 'wx', 0o600)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      throw new PsycheError(CODE.initRace, `另一个初始化正在进行中（${CLAIM_FILE} 已存在）：同一数据根只允许一个写入者。`, {
        claimPath: paths.claim,
      })
    }
    throw new PsycheError(CODE.internal, `建不了初始化 claim：${errorText(error)}`, { claimPath: paths.claim })
  }
  try {
    deps.fs.writeSync(fd, JSON.stringify({ ...claim, token, opId }, null, 2) + '\n')
  } finally {
    deps.fs.closeSync(fd)
  }
  return { token, opId }
}

/** 读 claim：坏文件返回 problem（调用方判 damaged），不抛。 */
function loadClaim(fs: InitFs, file: string): { claim: InitClaim | null; problem: string | null } {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { claim: null, problem: `读 claim 失败：${errorText(error)}` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { claim: null, problem: `claim 不是合法 JSON：${errorText(error)}` }
  }
  if (typeof raw !== 'object' || raw === null) return { claim: null, problem: 'claim 不是对象' }
  const record = raw as Record<string, unknown>
  if (record.kind !== 'init' && record.kind !== 'reset') return { claim: null, problem: `claim.kind 不认识：${String(record.kind)}` }
  if (typeof record.pid !== 'number') return { claim: null, problem: 'claim 缺 pid' }
  if (typeof record.startedAt !== 'string' || !record.startedAt) return { claim: null, problem: 'claim 缺 startedAt' }
  return {
    claim: {
      kind: record.kind,
      token: typeof record.token === 'string' && record.token ? record.token : null,
      opId: typeof record.opId === 'string' && record.opId ? record.opId : `${record.kind}-legacy`,
      pid: record.pid,
      startedAt: record.startedAt,
      presetId: typeof record.presetId === 'string' ? record.presetId : null,
      presetName: typeof record.presetName === 'string' ? record.presetName : null,
      pendingIdentityHash: typeof record.pendingIdentityHash === 'string' ? record.pendingIdentityHash : null,
    },
    problem: null,
  }
}

/** 写文件：临时文件 + 改名；Windows 上目标被占用（EPERM/EBUSY/EACCES）重试三次。 */
function writeAtomic(fs: InitFs, pid: number, file: string, data: string): void {
  const tmp = `${file}.tmp-${pid}`
  fs.writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 })
  try {
    renameWithRetry(fs, tmp, file)
  } catch (error) {
    // 改名失败就把临时文件收掉，别在数据根里留垃圾
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 收不掉也不影响已经抛出的错误 */
    }
    throw error
  }
}

/** 改名重试：目标被别的进程打开时 Windows 会报 EPERM/EBUSY，50ms × 3 次后放弃并保留现场。 */
export function renameWithRetry(fs: InitFs, from: string, to: string, attempt = 0): void {
  try {
    fs.renameSync(from, to)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (attempt < 2 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
      sleepSync(50)
      renameWithRetry(fs, from, to, attempt + 1)
      return
    }
    throw error
  }
}

/** 同步小睡：Atomics.wait 不占 CPU，也不需要 setTimeout 的异步化。 */
function sleepSync(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(buffer, 0, 0, ms)
}

/**
 * 把人格记录落进 DB：`persona_config.persona_json` 快照 + `personality_history` 一条。
 *
 * 幂等：快照按整份 JSON 覆盖，不追加；history 只在给了 `reason` 时写。
 */
function writeDbSnapshot(
  deps: ReturnType<typeof resolveDeps>,
  document: PersonaDocument,
  existing: PersonaDocument | null,
  reason: string,
): boolean {
  if (!deps.db) return false
  const json = JSON.stringify(document)
  const before = existing ? JSON.stringify(existing) : null
  const now = isoOf(deps.now())
  deps.db.transaction(() => {
    deps.db!.run(
      `INSERT INTO persona_config (persona_id, type, identity_path, persona_json, created_at, updated_at)
       VALUES (?, 'preset', ?, ?, ?, ?)
       ON CONFLICT(persona_id) DO UPDATE SET
         persona_json = excluded.persona_json,
         identity_path = excluded.identity_path,
         updated_at = excluded.updated_at`,
      [PERSONA_ID, IDENTITY_FILE, json, now, now],
    )
    deps.db!.run(
      `INSERT INTO personality_history (persona_id, field, before_value, after_value, reason, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [PERSONA_ID, 'initialization', before, json, reason, now],
    )
  })
  return true
}

/** Date → ISO 字符串（注入的时钟可能是假时间）。 */
function isoOf(date: Date): string {
  return date.toISOString()
}

/** 把异常压成一句话（自己不再抛新错）。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
