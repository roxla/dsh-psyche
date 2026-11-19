/**
 * 人格初始化的协调服务（I-6）：把五个底层函数收成一个入口。
 *
 * 边界：
 * - 只供 Owner 层（桌面面板 / CLI / 本地管理接口）调用，不挂进 Contract、不暴露给聊天工具或 QQ 群成员。
 * - `status()` 只读；`start()` 必须显式给 presetId，绝不替调用方偷偷选默认预设。
 * - 错误码沿用 persona-init：E_INIT_RACE（锁）、E_INIT_STATE / E_INIT_LOCKED（状态）、
 *   E_INIT_INCOMPLETE（文件不完整）、E_INTERNAL（存储）、E_PRESET_UNKNOWN（预设）。
 */
import { PsycheError, CODE } from './errors.js'
import {
  abortInitialization,
  acceptIdentityDrift,
  finishInitialization,
  initializePersona,
  inspectInitialization,
  reconcileInitialization,
  syncPersonaConfigFromFile,
} from './persona-init.js'
import type {
  CustomPersonaInput,
  InitDb,
  InitFs,
  InitSnapshot,
  InitializeResult,
  PersonaDocument,
} from './persona-init.js'

export interface PersonaInitServiceOptions {
  dataDir: string
  presetDir?: string | URL
  /** 派生快照用的数据库；不传则只处理文件。 */
  db?: InitDb | null
  fs?: InitFs
  now?: () => Date
  pid?: number
  isProcessAlive?: (pid: number) => boolean
}

/** 一次 `status()` 的返回值：快照 + 人话说明，面板/CLI 都直接显示。 */
export interface PersonaInitStatus {
  snapshot: InitSnapshot
}

/**
 * 初始化协调服务：状态检查 / 开始 / 完成 / 取消 / 接受原文漂移 / 文件→库同步 / 启动期收尾。
 *
 * 为什么要有这一层：底层五个函数各自需要 dataDir / db / deps，调用方每次自己拼容易漏；
 * 服务把「同一数据根、同一 db、同一时钟」定死，错误码也在这一层保持稳定。
 */
export class PersonaInitService {
  readonly #options: PersonaInitServiceOptions

  constructor(options: PersonaInitServiceOptions) {
    if (!options || typeof options.dataDir !== 'string' || !options.dataDir) {
      throw new PsycheError(CODE.internal, 'PersonaInitService 需要 dataDir')
    }
    this.#options = { ...options }
  }

  /** 只读：判定当前处于哪一种状态（不创建、不删除、不修补）。 */
  status(): PersonaInitStatus {
    return { snapshot: inspectInitialization(this.#deps()) }
  }

  /** 开始一次初始化：状态必须允许，且必须显式给预设 id。 */
  start(presetId: string): InitializeResult {
    if (typeof presetId !== 'string' || !presetId) {
      throw new PsycheError(CODE.presetUnknown, '初始化必须显式选择一个预设：不替调用方偷偷套默认人格。', {
        presetIds: undefined,
      })
    }
    return initializePersona({ ...this.#deps(), presetId })
  }

  /** 开始一次自定义人格初始化：不经过预设加载器，但走同一套 claim / 落盘 / 校验。 */
  startCustom(input: CustomPersonaInput): InitializeResult {
    return initializePersona({ ...this.#deps(), custom: input })
  }

  /** 收尾半成品：带 claimToken 时要求是这一轮的持有者（活着的持有者不能被抢）。 */
  finish(claimToken?: string): {
    alreadyLocked: boolean
    dbSync: 'synced' | 'skipped' | 'failed'
    persona: PersonaDocument
    identityHash: string
    snapshot: InitSnapshot
  } {
    return finishInitialization({ ...this.#deps(), claimToken })
  }

  /** 放弃半成品：重复调用幂等（没有现场时返回 aborted=false）。 */
  abort(claimToken?: string): { aborted: boolean; removed: string[]; snapshot: InitSnapshot } {
    return abortInitialization({ ...this.#deps(), claimToken })
  }

  /** 人工确认原文漂移：只更新哈希，不改原文。 */
  acceptDrift(): { persona: PersonaDocument; identityHash: string; snapshot: InitSnapshot } {
    return acceptIdentityDrift(this.#deps())
  }

  /** 文件 → 库的派生同步；库不可用或文件未锁定时返回原因，不抛。 */
  sync(): { synced: boolean; reason: string; before: string | null; after: string | null } {
    return syncPersonaConfigFromFile(this.#deps())
  }

  /** 启动期安全收尾：只清「已锁定 + 持有者已死」的残留 claim，其余现场保持原样。 */
  reconcile(): { snapshot: InitSnapshot; actions: string[] } {
    return reconcileInitialization(this.#deps())
  }

  #deps(): {
    dataDir: string
    presetDir?: string | URL
    db?: InitDb | null
    fs?: InitFs
    now?: () => Date
    pid?: number
    isProcessAlive?: (pid: number) => boolean
  } {
    const { dataDir, presetDir, db, fs, now, pid, isProcessAlive } = this.#options
    const deps: {
      dataDir: string
      presetDir?: string | URL
      db?: InitDb | null
      fs?: InitFs
      now?: () => Date
      pid?: number
      isProcessAlive?: (pid: number) => boolean
    } = { dataDir }
    if (presetDir !== undefined) deps.presetDir = presetDir
    if (db !== undefined) deps.db = db
    if (fs !== undefined) deps.fs = fs
    if (now !== undefined) deps.now = now
    if (pid !== undefined) deps.pid = pid
    if (isProcessAlive !== undefined) deps.isProcessAlive = isProcessAlive
    return deps
  }
}

/** 创建服务（与 `new PersonaInitService(options)` 等价，方便调用方按函数式写法使用）。 */
export function createPersonaInitService(options: PersonaInitServiceOptions): PersonaInitService {
  return new PersonaInitService(options)
}
