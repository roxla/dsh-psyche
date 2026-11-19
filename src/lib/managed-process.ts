/**
 * P8-2：只管理「心灵自己启动的」子进程。
 *
 * 约束：
 * - 只有这里能 spawn；命令与参数由调用方内部构造，绝不接受用户自由输入。
 * - 停止只杀自己记录的 PID（Windows 用 `taskkill /T /F` 杀进程树）；
 *   没记录到 PID 就返回 not-running，不猜、不按名字杀。
 * - 输出只保留最近 N 行，页面/日志不落盘。
 */
import { spawn, type ChildProcess } from 'node:child_process'

export interface ManagedProcessSpec {
  /** 展示名，如 `snowluma`。 */
  name: string
  /** 完整可执行文件；不经过 shell 解释。 */
  command: string
  /** 固定参数；不允许从 HTTP 透传。 */
  args: string[]
  /** 工作目录。 */
  cwd: string
  /** 额外环境变量。 */
  env?: Record<string, string>
  /** 最多保留多少行输出（默认 200）。 */
  maxLines?: number
}

export interface ManagedProcessState {
  name: string
  running: boolean
  pid: number | null
  startedAt: number | null
  exitCode: number | null
  lastError: string
}

export interface ManagedProcessLogLine {
  at: number
  stream: 'stdout' | 'stderr' | 'system'
  text: string
}

const DEFAULT_MAX_LINES = 200
const STOP_WAIT_MS = 1500

export class ManagedProcess {
  readonly #name: string
  readonly #maxLines: number
  #child: ChildProcess | null = null
  #pid: number | null = null
  #startedAt: number | null = null
  #exitCode: number | null = null
  #lastError = ''
  #lines: ManagedProcessLogLine[] = []
  #stopping = false

  constructor(name: string, maxLines = DEFAULT_MAX_LINES) {
    this.#name = name
    this.#maxLines = Math.max(20, Math.min(1000, Math.trunc(maxLines)))
  }

  get running(): boolean {
    return this.#child !== null
  }

  snapshot(): ManagedProcessState {
    return {
      name: this.#name,
      running: this.running,
      pid: this.#pid,
      startedAt: this.#startedAt,
      exitCode: this.#exitCode,
      lastError: this.#lastError,
    }
  }

  logs(limit = this.#maxLines): ManagedProcessLogLine[] {
    const take = Math.max(1, Math.min(this.#maxLines, Math.trunc(limit)))
    return this.#lines.slice(-take)
  }

  /** 启动；已在运行时不重复启动。 */
  start(spec: ManagedProcessSpec): { ok: boolean; error?: string } {
    if (this.#child !== null) return { ok: false, error: 'already-running' }
    if (!spec.command || !spec.cwd) return { ok: false, error: 'invalid-spec' }
    this.#lastError = ''
    this.#exitCode = null
    this.#stopping = false
    try {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.#child = child
      this.#pid = typeof child.pid === 'number' ? child.pid : null
      this.#startedAt = Date.now()
      this.#append('system', `start ${spec.command} ${spec.args.join(' ')}`)
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => this.#ingest('stdout', chunk))
      child.stderr?.on('data', (chunk: string) => this.#ingest('stderr', chunk))
      child.on('error', (error) => {
        this.#lastError = error instanceof Error ? error.message : String(error)
        this.#append('system', `spawn error: ${this.#lastError}`)
      })
      child.on('exit', (code, signal) => {
        this.#exitCode = typeof code === 'number' ? code : null
        this.#append('system', `exit code=${String(code)} signal=${String(signal)}`)
        this.#child = null
        this.#pid = null
      })
      return { ok: true }
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error)
      this.#append('system', `start failed: ${this.#lastError}`)
      this.#child = null
      this.#pid = null
      return { ok: false, error: 'spawn-failed' }
    }
  }

  /** 停止自己启动的进程树；没有进程时返回 not-running。 */
  async stop(): Promise<{ ok: boolean; error?: string }> {
    const child = this.#child
    const pid = this.#pid
    if (child === null || pid === null) return { ok: false, error: 'not-running' }
    this.#stopping = true
    this.#append('system', `stop pid=${pid}`)
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => resolve(), STOP_WAIT_MS)
          killer.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
          killer.once('error', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      } else {
        child.kill('SIGTERM')
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (this.#child !== null) {
            try {
              child.kill('SIGKILL')
            } catch {
              /* 已被回收 */
            }
          }
          resolve()
        }, STOP_WAIT_MS)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      return { ok: true }
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error)
      return { ok: false, error: 'stop-failed' }
    } finally {
      this.#stopping = false
    }
  }

  async restart(spec: ManagedProcessSpec): Promise<{ ok: boolean; error?: string }> {
    if (this.#child !== null) {
      const stopped = await this.stop()
      if (!stopped.ok) return stopped
    }
    return this.start(spec)
  }

  /** 只给内部用：当前是否正在执行 stop（页面可显示 transitioning）。 */
  get stopping(): boolean {
    return this.#stopping
  }

  #ingest(stream: 'stdout' | 'stderr', chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trimEnd()
      if (text !== '') this.#append(stream, text)
    }
  }

  #append(stream: ManagedProcessLogLine['stream'], text: string): void {
    this.#lines.push({ at: Date.now(), stream, text: text.slice(0, 500) })
    if (this.#lines.length > this.#maxLines) this.#lines.splice(0, this.#lines.length - this.#maxLines)
  }
}
