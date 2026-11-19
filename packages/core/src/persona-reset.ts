/**
 * 人格重置（I-8 `reset` 的 Core 半边）：把已锁定的人格退回 `uninitialized`，**记忆库一条不动**。
 *
 * 为什么拆到这里而不是写在 CLI 里：
 * - 「删哪些文件、写哪条历史、库快照怎么清」属于 Core 的身份保护规则，CLI 只负责编排
 *   （先归档 → 校验 → 让人输入包 ID），不能让命令行成为绕过 Core 的第二条写入路径。
 * - 归档与人工确认在 CLI；这个函数只做「文件 + 数据库」的原子重置，调用方必须已经完成确认。
 *
 * 边界：
 * - 不删 `memory.sqlite3`，不删 `assets/`、`narrative/`、`exports/`。
 * - 活着的初始化进程还在跑（claim.ownerAlive）时拒绝重置，沿用 I-4 的锁所有权规则。
 * - `uninitialized` 直接返回 `reset:false`，重复调用幂等。
 * - 重置后 `personality_history` 留一条记录（身份材料可以重来，历史不能抹）。
 */
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  closeSync,
} from 'node:fs'
import { PsycheError, CODE } from './errors.js'
import { inspectInitialization, initPathsOf } from './persona-init.js'
import type { InitDb, InitDeps, InitFs, InitSnapshot } from './persona-init.js'

/** node:fs 的最小面（与 persona-init 的 InitFs 同形）。 */
const nodeFs: InitFs = {
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
} as InitFs

export interface ResetPersonaOptions extends InitDeps {
  dataDir: string
  /** 写进 `personality_history.reason`，默认 `reset`。 */
  reason?: string
}

export interface ResetPersonaResult {
  reset: boolean
  /** `not-initialized`：本来就没初始化；`done`：已重置。 */
  reason: 'not-initialized' | 'done'
  removed: string[]
  snapshot: InitSnapshot
}

/**
 * 重置人格基底：删 `identity.md` / `persona.json` / claim，清库里的派生快照并写一条历史。
 *
 * @throws E_INIT_RACE 初始化进程仍活着（不能从一个进程手里抢走锁）
 */
export function resetPersona(options: ResetPersonaOptions): ResetPersonaResult {
  if (!options || typeof options.dataDir !== 'string' || !options.dataDir) {
    throw new PsycheError(CODE.internal, 'resetPersona 需要 dataDir')
  }
  const dataDir = options.dataDir
  const deps: InitDeps = {
    fs: options.fs ?? nodeFs,
    db: options.db ?? null,
    now: options.now,
    pid: options.pid,
    isProcessAlive: options.isProcessAlive,
  }
  const before = inspectInitialization({ dataDir, ...deps })
  if (before.state === 'uninitialized') {
    return { reset: false, reason: 'not-initialized', removed: [], snapshot: before }
  }
  if (before.claim && before.claim.ownerAlive) {
    throw new PsycheError(CODE.initRace, '初始化进程还在运行：不能重置一个正在被写入的人格。', {
      pid: before.claim.pid,
      startedAt: before.claim.startedAt,
    })
  }

  const fs = deps.fs ?? nodeFs
  const paths = initPathsOf(dataDir)
  const at = (deps.now ?? (() => new Date()))().toISOString()
  const reason = typeof options.reason === 'string' && options.reason ? options.reason : 'reset'

  // 1) 库半边：先清派生快照、再追加历史。同一事务里做，失败就整笔回滚。
  if (deps.db) {
    deps.db.transaction(() => {
      deps.db!.run(
        `INSERT INTO persona_config (persona_id, type, identity_path, persona_json, created_at, updated_at)
         VALUES ('main', 'preset', NULL, '{}', ?, ?)
         ON CONFLICT(persona_id) DO UPDATE SET persona_json = '{}', updated_at = excluded.updated_at`,
        [at, at],
      )
      deps.db!.run(
        `INSERT INTO personality_history (persona_id, field, before_value, after_value, reason, at, op_id)
         VALUES ('main', 'initialization', ?, 'uninitialized', ?, ?, NULL)`,
        [before.state, reason, at],
      )
    })
  }

  // 2) 文件半边：claim 先删（避免 inspect 仍看到锁），再删身份文件。
  const removed: string[] = []
  for (const [label, path] of [
    ['claim', paths.claim],
    ['persona', paths.persona],
    ['identity', paths.identity],
  ] as const) {
    if (fs.existsSync(path)) {
      fs.unlinkSync(path)
      removed.push(label)
    }
  }

  const after = inspectInitialization({ dataDir, ...deps })
  return { reset: true, reason: 'done', removed, snapshot: after }
}
