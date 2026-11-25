// QQ 会话所在工作区目录的解析。
//
// 为什么单独抽一个纯函数：宿主 `workspace/create` 只接受**全限定路径**，而这里曾经
// 用 `join(dirname(runtime.dataDir), 'QQ 聊天')` 推默认值——`agents` 服务先于 boot
// 完成注入时 `runtime.dataDir` 还是空串，`dirname('')` 就是 `''`，于是推出来的
// 是相对路径 `QQ 聊天`，被宿主直接拒掉：
//   Workspace path is not fully qualified: 'QQ 聊天'
// 工作区建不出来，会话就只能留在「未分组」。
//
// 光把路径改成绝对还不够：绝对路径从哪儿起算，决定了新旧会话能不能归到同一组。
// 宿主按会话 header 的 `cwd` 归属工作区，而历史 QQ 会话的 `cwd` 早就写死成当时解析
// 出来的绝对路径了（本机是 `D:\project\psyche\QQ 聊天`）。插件进程的工作目录以后
// 可能变（本次就是从项目目录换到了 `%USERPROFILE%\.dsh\profiles\<profile>`），
// 所以默认值的优先级是：
//   1. 显式配置 `qq.cwd`（最稳，想钉死就用它）；
//   2. **磁盘上已经存在的 QQ 会话目录**——`~/.dsh/sessions/<编码后的 cwd>/qq-private-*`，
//      解码回来就是宿主当初记下的 cwd，照抄它才能让旧会话挂进同一组；
//   3. 都没有（全新安装）才用 `<宿主工作目录>/QQ 聊天`。
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 默认工作区目录名（也是侧栏里期望的标题）。 */
export const QQ_WORKSPACE_DIR_NAME = 'QQ 聊天'

export interface QqWorkspaceCwdInput {
  /** `qq.cwd` 配置值；空串表示按默认规则推导。 */
  configured: string
  /** 已知的 QQ 会话 cwd（通常由 `findExistingQqSessionCwd` 从磁盘读出来）。 */
  existing?: string | null
  /** 宿主工作目录（默认 `process.cwd()`），用于推默认值与补全相对配置。 */
  cwd?: string
}

/**
 * 算出 QQ 会话所属的工作区目录（绝对路径）。
 *
 * @param input 配置值、已发现的 QQ 会话 cwd 与宿主工作目录。
 * @returns 全限定路径，可直接交给 `workspace/create`。
 */
export function resolveQqWorkspaceCwd(input: QqWorkspaceCwdInput): string {
  const base = (input.cwd ?? process.cwd()).trim() === '' ? process.cwd() : (input.cwd ?? process.cwd())
  const configured = input.configured.trim()
  if (configured !== '') return resolve(base, configured)
  const existing = (input.existing ?? '').trim()
  if (existing !== '') return resolve(existing)
  return resolve(base, QQ_WORKSPACE_DIR_NAME)
}

/** 路径是否已经可以直接交给宿主（全限定）。 */
export function isQualifiedWorkspacePath(path: string): boolean {
  return isAbsolute(path) && path.trim() !== ''
}

/**
 * 把 `~/.dsh/sessions` 下的目录名解码回 cwd。
 *
 * 宿主的编码规则：整段用 `--` 包起来，盘符后的 `:` 与路径分隔符 `\` 都写成 `-`，
 * 空格与非 ASCII 字符写成 `~XXXX`（UTF-16 码元十六进制）。例如
 * `--D-project-psyche-QQ~0020~804A~5929--` → `D:\project\psyche\QQ 聊天`。
 *
 * @param name `sessions` 下的一级目录名。
 * @returns 解码出的绝对路径；不像会话目录时返回 `null`。
 */
export function decodeSessionDirName(name: string): string | null {
  if (!name.startsWith('--') || !name.endsWith('--') || name.length <= 4) return null
  const body = name.slice(2, -2)
  // 先按分隔符切开再还原转义：目录名里的 `-` 会被编码成 `~002D`，先还原再切就分不清了。
  const parts = body.split('-').map((part) =>
    part.replace(/~([0-9A-Fa-f]{4})/g, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
  )
  if (parts.length < 2) return null
  const drive = parts[0]
  if (!/^[A-Za-z]$/.test(drive)) return null
  return `${drive}:\\${parts.slice(1).join('\\')}`
}

export interface FindExistingQqSessionCwdInput {
  /** 候选的 `sessions` 根目录（`~/.dsh/sessions`），按顺序找。 */
  sessionsDirs: readonly string[]
  /** 会话 id 前缀，默认 `qq-private-`。 */
  prefix?: string
}

/**
 * 从磁盘上翻出「已经有 QQ 会话」的那个 cwd。
 *
 * 只看目录名够不够：`sessions/<编码后的 cwd>/qq-private-*` 这一层就说明宿主确实在
 * 那个 cwd 下建过 QQ 会话，取它当工作区路径才能把旧会话挂进来。
 *
 * @param input 候选 sessions 根目录与会话 id 前缀。
 * @returns 解码后且目录仍存在的 cwd；找不到返回 `null`。
 */
export function findExistingQqSessionCwd(input: FindExistingQqSessionCwdInput): string | null {
  const prefix = input.prefix ?? 'qq-private-'
  for (const root of input.sessionsDirs) {
    if (root.trim() === '' || !existsSync(root)) continue
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    // 新会话排在后面，倒着找能先命中最近用过的那一个。
    for (const entry of entries.slice().reverse()) {
      const cwd = decodeSessionDirName(entry)
      if (cwd === null || !existsSync(cwd)) continue
      try {
        if (readdirSync(join(root, entry)).some((child) => child.startsWith(prefix))) return cwd
      } catch {
        continue
      }
    }
  }
  return null
}

/** 宿主默认的 `sessions` 根目录（`~/.dsh/sessions`），配置了别的 home 时由调用方另外传。 */
export function defaultSessionsDirs(dataDir: string): string[] {
  const dirs: string[] = []
  if (dataDir.trim() !== '') dirs.push(join(resolve(dataDir, '..'), 'sessions'))
  dirs.push(join(homedir(), '.dsh', 'sessions'))
  return dirs
}
