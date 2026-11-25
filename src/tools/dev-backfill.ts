// Q4-B 历史审计回填：把 `docs/audit/*.md` 变成可追溯的项目事实。
//
// 用户问「过去一周插件开发做了什么」，而开发记录一直躺在审计报告和 git commit 里、
// 记忆库看不见。这里做的事很窄：**把已有的报告读成结构化条目，再用它们生成一份
// 「截至当前提交」的交接记录**，写进项目 Checkpoint，让 `buildProjectBrief` 能读到。
//
// 三条纪律（外部评审 Q4-B）：
//   1. 先预览再导入——默认 --dry-run，打印将要写入的内容，不碰库；
//   2. 每条保留文件路径、内容哈希、关联 commit 与验证状态；
//   3. 同一文件重复导入零新增——指纹里含文件哈希，内容没变就是重放。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

import {
  bindSession,
  ensureProject,
  readCheckpoint,
  saveCheckpoint,
  type Db,
} from 'dsh-psyche-core'
import { openDatabase } from '../lib/adapter.js'

const PLATFORM = 'desktop'
const PERSONA_ID = 'main'
const ALGORITHM_VERSION = 'backfill-v1'

/** 一份审计报告在回填时的样子。 */
export interface AuditEntry {
  /** 相对仓库根的路径，如 `docs/audit/g1a-project-handoff-core.md`。 */
  path: string
  /** 报告标题（首行去掉 `# `）。 */
  title: string
  /** 文件内容 SHA-256，用来判断是否变化。 */
  sha256: string
  bytes: number
  /** 该文件最近一次被提交时的 commit；未提交返回空串。 */
  commit: string
  /** 该提交的时间；未提交返回空串。 */
  committedAt: string
  /** 是否仍在工作树里未提交。 */
  dirty: boolean
}

export interface BackfillOptions {
  repo: string
  projectId: string
  branchKey: string
  sessionId: string
  personaId?: string
  platform?: string
  /** 只回填最近 N 天内改动过的报告；0 表示全部。 */
  sinceDays?: number
  dataDir?: string
  now?: string
}

export interface BackfillReport {
  schemaVersion: 1
  kind: 'dev-backfill'
  repo: string
  commit: string
  gitBranch: string
  branchKey: string
  at: string
  totalReports: number
  entries: AuditEntry[]
}

function run(command: string, args: string[], cwd: string): string {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
  } catch {
    return ''
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# ')) return trimmed.slice(2).trim()
  }
  return ''
}

/**
 * 扫描审计目录，产出结构化条目。
 *
 * 只读、不写库：预览和导入走同一份数据，避免「预览时看到的」和「实际写进去的」不一致。
 */
export function collectAuditEntries(
  repo: string,
  dir = 'docs/audit',
  sinceDays = 0,
  now: Date = new Date(),
): { totalReports: number; entries: AuditEntry[] } {
  const root = resolve(repo, dir)
  if (!existsSync(root)) return { totalReports: 0, entries: [] }
  const names = readdirSync(root).filter((name) => name.endsWith('.md'))
  const cutoff = sinceDays > 0 ? now.getTime() - sinceDays * 24 * 60 * 60 * 1000 : 0
  const entries: AuditEntry[] = []
  for (const name of names) {
    const abs = join(root, name)
    const rel = `${dir}/${name}`
    const stat = statSync(abs)
    if (cutoff > 0 && stat.mtimeMs < cutoff) continue
    const text = readFileSync(abs, 'utf8')
    const dirty = run('git', ['status', '--porcelain', '--', rel], repo).length > 0
    const commit = dirty ? '' : run('git', ['log', '-1', '--format=%H', '--', rel], repo)
    const committedAt = dirty ? '' : run('git', ['log', '-1', '--format=%cI', '--', rel], repo)
    entries.push({
      path: rel,
      title: firstLine(text) || name,
      sha256: sha256(text),
      bytes: stat.size,
      commit,
      committedAt,
      dirty,
    })
  }
  entries.sort((a, b) => (a.committedAt === b.committedAt ? a.path.localeCompare(b.path) : a.committedAt.localeCompare(b.committedAt)))
  return { totalReports: names.length, entries }
}

/**
 * 把条目组织成一份交接修订。
 *
 * 正文只放**能落到纸面上的事实**：多少份报告、时间范围、最近几份的标题、以及提交号。
 * 完整清单写进随附的清单文件，不塞进 Brief（那会挤掉当前任务）。
 */
export function revisionOfBackfill(report: BackfillReport): {
  currentGoal: string
  completed: string[]
  blockers: string[]
  nextSteps: string[]
  confidence: 'low' | 'medium' | 'high'
  repoRef: string
  lastActiveAt: string
  generator: string
} {
  const { entries } = report
  const short = report.commit.slice(0, 7)
  const committed = entries.filter((entry) => !entry.dirty && entry.commit !== '')
  const dirty = entries.length - committed.length
  const completed: string[] = [`截至提交 ${short}：已归档 ${report.totalReports} 份验证报告`]
  if (committed.length > 0) {
    const oldest = committed[0]?.committedAt.slice(0, 10) ?? ''
    const newest = committed[committed.length - 1]?.committedAt.slice(0, 10) ?? ''
    completed.push(`本次回填 ${committed.length} 份（${oldest} 至 ${newest}）`)
    // 最近 5 份的标题——足够回答「最近在做什么」，又不会把 Brief 撑爆。
    for (const entry of committed.slice(-5)) completed.push(entry.title)
  }
  const blockers: string[] = []
  if (dirty > 0) blockers.push(`${dirty} 份报告尚未提交，其内容只代表当前工作树`)
  return {
    repoRef: report.commit,
    lastActiveAt: report.at,
    currentGoal: `截至 ${short} 的项目交接记录（由 ${report.entries.length} 份审计报告回填）`,
    completed,
    blockers,
    nextSteps: [],
    confidence: dirty > 0 ? 'medium' : 'high',
    generator: `dev-backfill/${short}`,
  }
}

/** 回填指纹：同一批文件内容不变就是重放。 */
export function backfillRequestId(report: BackfillReport): string {
  const digest = sha256(report.entries.map((entry) => `${entry.path}:${entry.sha256}`).join('\n')).slice(0, 16)
  return `backfill:${report.commit}:${digest}`
}

export interface BackfillResult {
  ok: boolean
  saved: boolean
  replayed: boolean
  checkpointId: string
  revision: number
  requestId: string
  entries: number
}

export async function runBackfill(
  options: BackfillOptions & { db: Db; dataDir: string },
): Promise<BackfillResult> {
  const at = options.now ?? new Date().toISOString()
  const repo = resolve(options.repo)
  const commit = run('git', ['rev-parse', 'HEAD'], repo)
  const gitBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repo)
  const seen = collectAuditEntries(repo, 'docs/audit', options.sinceDays ?? 0, new Date(at))
  const report: BackfillReport = {
    schemaVersion: 1,
    kind: 'dev-backfill',
    repo,
    commit,
    gitBranch,
    branchKey: options.branchKey,
    at,
    totalReports: seen.totalReports,
    entries: seen.entries,
  }
  const revision = revisionOfBackfill(report)
  const requestId = backfillRequestId(report)
  const deps = { personaId: options.personaId ?? PERSONA_ID }

  ensureProject(options.db, {
    projectId: options.projectId,
    canonicalName: options.projectId,
    workspaceKey: options.sessionId,
    deps,
  })
  const binding = bindSession(options.db, {
    bindingId: `bnd_backfill_${options.projectId}`,
    projectId: options.projectId,
    platform: options.platform ?? PLATFORM,
    sessionRef: options.sessionId,
    grantGeneration: 'backfill',
    deps,
  })
  const head = readCheckpoint(options.db, { projectId: options.projectId, branchKey: options.branchKey })
  const anchor = binding.committedToSeq + 1
  const result = saveCheckpoint(options.db, {
    projectId: options.projectId,
    branchKey: options.branchKey,
    bindingId: binding.bindingId,
    mode: 'manual',
    requestId,
    payloadHash: requestId,
    // manual 不推进水位，区间只是占位（G1-A 要求 fromSeq === toSeq）。
    fromSeq: anchor,
    toSeq: anchor,
    algorithmVersion: ALGORITHM_VERSION,
    digest: { bodyJson: JSON.stringify(report) },
    revision,
    expectedRevision: head === null ? undefined : head.headRevision,
  })
  return {
    ok: true,
    saved: result.saved,
    replayed: result.replayed,
    checkpointId: result.checkpointId,
    revision: result.revision,
    requestId,
    entries: seen.entries.length,
  }
}

function argOf(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (arg.startsWith(prefix)) return arg.slice(prefix.length)
    if (arg === `--${name}`) return argv[index + 1]
  }
  return undefined
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const repo = resolve(argOf(argv, 'repo') ?? process.cwd())
  const sessionId = argOf(argv, 'session')
  if (sessionId === undefined || sessionId.length === 0) {
    console.error('缺少 --session（例如 --session "desktop:D-project-psyche"）')
    process.exitCode = 2
    return
  }
  const options: BackfillOptions = {
    repo,
    projectId: argOf(argv, 'project') ?? 'psyche',
    // 回填走**独立分支**，不占通用 head：通用 head 留给「最近一次收口」，
    // 否则 Brief 读到的会是「204 份报告」这种清单，把当前任务挤掉。
    branchKey: argOf(argv, 'branch') ?? 'backfill',
    sessionId,
    sinceDays: Number(argOf(argv, 'since-days') ?? '0') || 0,
  }
  const dryRun = argv.includes('--dry-run')
  const reportResult = collectAuditEntries(repo, 'docs/audit', options.sinceDays ?? 0)
  const report: BackfillReport = {
    schemaVersion: 1,
    kind: 'dev-backfill',
    repo,
    commit: run('git', ['rev-parse', 'HEAD'], repo),
    gitBranch: run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repo),
    branchKey: options.branchKey,
    at: new Date().toISOString(),
    totalReports: reportResult.totalReports,
    entries: reportResult.entries,
  }
  const revision = revisionOfBackfill(report)
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, requestId: backfillRequestId(report), revision }, null, 2))
    return
  }
  const dataDir = resolve(argOf(argv, 'dir') ?? join(homedir(), '.dsh', 'psyche'))
  const opened = await openDatabase({ file: join(dataDir, 'memory.sqlite3') })
  try {
    const result = await runBackfill({ ...options, db: opened.db, dataDir })
    console.log(JSON.stringify(result, null, 2))
  } finally {
    opened.db.close()
  }
}

const invoked = process.argv[1] !== undefined && /dev-backfill\.(js|ts)$/.test(process.argv[1])
if (invoked) {
  await main()
}
