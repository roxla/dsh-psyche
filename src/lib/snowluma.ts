/**
 * P8-1：SnowLuma 目录发现与只读检测。
 *
 * 只认 `package.json.name === '@snowluma/runtime'`；不执行任何脚本，
 * 不下载、不更新、不改安装目录里的文件。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface SnowlumaInfo {
  dir: string
  valid: boolean
  version: string
  launcher: string
  /** `launcher.bat` 时为 `cmd.exe`，否则为 `bash`。 */
  shell: string
  webuiUrl: string
  error: string
}

const PACKAGE_NAME = '@snowluma/runtime'
const DEFAULT_WEBUI = 'http://127.0.0.1:5099'

/** 候选目录：显式配置优先；其余只做常见的本机位置猜测。 */
export function snowlumaCandidates(configured: string): string[] {
  const list: string[] = []
  const add = (value: string) => {
    const trimmed = value.trim()
    if (trimmed && !list.includes(trimmed)) list.push(trimmed)
  }
  add(configured)
  add(join(homedir(), 'SnowLuma'))
  if (process.platform === 'win32') {
    add('D:\\SnowLuma')
    add('C:\\SnowLuma')
    add(join(homedir(), 'Desktop', 'SnowLuma'))
    add(join(homedir(), 'Downloads', 'SnowLuma'))
  } else {
    add(join(homedir(), 'snowluma'))
  }
  return list
}

function readPackage(dir: string): { name: string; version: string } | null {
  try {
    const raw = readFileSync(join(dir, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown }
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      version: typeof parsed.version === 'string' ? parsed.version : '',
    }
  } catch {
    return null
  }
}

function findLauncher(dir: string): string {
  try {
    const names = readdirSync(dir)
    if (names.includes('launcher.bat')) return 'launcher.bat'
    if (names.includes('launcher.sh')) return 'launcher.sh'
  } catch {
    /* 目录不可读按没有启动脚本处理 */
  }
  return ''
}

/** 只读检测一个目录；失败返回 valid=false + 稳定错误码文案。 */
export function inspectSnowlumaDir(input: string): SnowlumaInfo {
  const dir = resolve(input.trim() || '.')
  const base: SnowlumaInfo = {
    dir,
    valid: false,
    version: '',
    launcher: '',
    shell: '',
    webuiUrl: DEFAULT_WEBUI,
    error: '',
  }
  if (!input.trim()) return { ...base, error: '目录为空' }
  if (!existsSync(dir)) return { ...base, error: '目录不存在' }
  const pkg = readPackage(dir)
  if (pkg === null) return { ...base, error: '缺少 package.json' }
  if (pkg.name !== PACKAGE_NAME) return { ...base, error: '不是 SnowLuma 安装目录' }
  const launcher = findLauncher(dir)
  if (!launcher) return { ...base, valid: false, version: pkg.version, error: '缺少 launcher.bat / launcher.sh' }
  return {
    dir,
    valid: true,
    version: pkg.version,
    launcher,
    shell: launcher === 'launcher.bat' ? 'cmd.exe' : 'bash',
    webuiUrl: DEFAULT_WEBUI,
    error: '',
  }
}

/** 按候选顺序找第一个有效目录。 */
export function discoverSnowluma(configured: string): SnowlumaInfo | null {
  for (const candidate of snowlumaCandidates(configured)) {
    const info = inspectSnowlumaDir(candidate)
    if (info.valid) return info
  }
  return null
}

/** 启动参数：只加载 launcher 脚本本身，不附加用户参数。 */
export function snowlumaLaunchSpec(info: SnowlumaInfo): { command: string; args: string[]; cwd: string } | null {
  if (!info.valid || !info.dir || !info.launcher) return null
  if (info.shell === 'cmd.exe') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', info.launcher], cwd: info.dir }
  }
  return { command: 'bash', args: ['./' + info.launcher], cwd: info.dir }
}
