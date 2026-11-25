// 开发收口自动记账（外部评审 Q4-A）。
//
// 设计要点（与方案一致，改动前先看这里）：
//   - **零模型调用**。只读 git 与测试日志，用模板写成结构化记录，不读会话、不做总结。
//   - **不推进水位**。走 G1-A 的 `mode:'manual'`，requestId 用 commit SHA，
//     同一提交重复收口命中重放，不会多出一条修订。
//   - **测试必须对应被登记的代码**。工作树脏时只标注「该工作树组合回归」，
//     不把结果写成「这个提交通过了」——两者能证明的东西不一样。
//   - 写入失败可以重跑，不需要重做 commit。
//
// 用法：node dist/tools/dev-closeout.js --session <会话> [--repo <仓库>] [--log <测试日志>]
// 退出码 0 表示记录已写入或已存在（重放）。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDatabase } from '../lib/adapter.js'
import type { Db } from '../lib/adapter.js'
import {
  bindSession,
  ensureProject,
  readCheckpoint,
  saveCheckpoint,
} from '../lib/project-handoff-store.js'

export interface CloseoutOptions {
  repo: string
  dataDir: string
  projectId: string
  branchKey: string
  sessionRef: string
  personaId: string
  platform: string
  logPath?: string
  evidencePaths?: readonly string[]
  now?: string
}

export interface CloseoutReport {
  schemaVersion: 1
  kind: 'dev-closeout'
  repo: string
  /** 存储用的分支键（空串 = 项目通用进度，Brief 默认读它）。 */
  branchKey: string
  /** git 里的真实分支名，只用于展示与记录。 */
  gitBranch: string
  commit: string
  commitSubject: string
  dirty: boolean
  test: { logPath: string | null; suites: number; passed: number; failed: number } | null
  evidence: { path: string; sha256: string; bytes: number }[]
  at: string
}

export interface CloseoutResult {
  report: CloseoutReport
  checkpointId: string
  revision: number
  saved: boolean
  replayed: boolean
  requestId: string
  payloadHash: string
}

/** git 命令统一走这里：失败就抛，不吞——收口记录写错比写不出来更糟。 */
function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

/** 解析 `npm run test:all` 的日志。UTF-16LE 与 UTF-8 都要认（PowerShell 重定向是前者）。 */
export function parseTestLog(path: string): { suites: number; passed: number; failed: number } | null {
  if (!existsSync(path)) return null
  const buffer = readFileSync(path)
  const text = buffer.includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8')
  const pattern = /(\d+)\s*通过[\s,，/]*(\d+)\s*失败/g
  let suites = 0
  let passed = 0
  let failed = 0
  for (const match of text.matchAll(pattern)) {
    suites += 1
    passed += Number(match[1])
    failed += Number(match[2])
  }
  if (suites === 0) return null
  return { suites, passed, failed }
}

function digestOfFile(path: string): { path: string; sha256: string; bytes: number } {
  const bytes = readFileSync(path)
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength }
}

/**
 * 生成收口报告。**纯读取**：不写库、不改 git、不调模型。
 *
 * `at` 取的是**提交时间**而不是当前时间——同一个提交重复收口必须得到同一个报告
 * （内容指纹相同才会被识别成重放，否则会被当成「同一请求换了内容」拒掉）。
 */
export function buildCloseoutReport(options: CloseoutOptions): CloseoutReport {
  const repo = resolve(options.repo)
  const commit = git(repo, ['rev-parse', 'HEAD'])
  const commitSubject = git(repo, ['log', '-1', '--format=%s'])
  const committedAt = git(repo, ['log', '-1', '--format=%cI'])
  const gitBranch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const dirty = git(repo, ['status', '--porcelain']).length > 0
  const logPath = options.logPath === undefined ? undefined : resolve(options.logPath)
  const parsed = logPath === undefined ? null : parseTestLog(logPath)
  const test =
    parsed === null
      ? null
      : { logPath: logPath ?? null, suites: parsed.suites, passed: parsed.passed, failed: parsed.failed }
  const evidence = (options.evidencePaths ?? [])
    .map((path) => resolve(path))
    .filter((path) => existsSync(path) && statSync(path).isFile())
    .map(digestOfFile)
  return {
    schemaVersion: 1,
    kind: 'dev-closeout',
    repo,
    branchKey: options.branchKey,
    gitBranch,
    commit,
    commitSubject,
    dirty,
    test,
    evidence,
    at: options.now ?? committedAt,
  }
}

/** 把报告翻成 Checkpoint 修订。字段取舍见每个注释。 */
export function revisionOfReport(
  report: CloseoutReport,
  inherited: { nextSteps: readonly string[] } | null,
): {
  repoRef: string | null
  lastActiveAt: string
  currentGoal: string
  completed: string[]
  blockers: string[]
  nextSteps: string[]
  dependencies: string[]
  decisions: string[]
  confidence: 'medium' | 'high'
  generator: string
} {
  const short = report.commit.slice(0, 7)
  const completed: string[] = [`提交 ${short}：${report.commitSubject}`]
  if (report.test !== null) {
    const label = report.dirty ? '该工作树组合回归' : '该提交'
    completed.push(
      `${label} test:all ${report.test.passed} 断言 / ${report.test.suites} 套件 / ${report.test.failed} 失败`,
    )
  }
  const blockers: string[] = []
  if (report.dirty) blockers.push('工作树有未提交改动：本次记录只代表该工作树组合，不代表该提交本身')
  if (report.test !== null && report.test.failed > 0) blockers.push(`${report.test.failed} 条断言失败`)
  return {
    repoRef: report.commit,
    lastActiveAt: report.at,
    currentGoal: `在 ${report.gitBranch} 上推进到 ${short}`,
    completed,
    blockers,
    // 下一步没有证据支持，只能继承上一次人写过的内容；不凭空生成。
    nextSteps: inherited === null ? [] : [...inherited.nextSteps],
    dependencies: [],
    decisions: [],
    // 测试全绿且有失败数为 0 的证据才给 high；否则 medium。
    confidence: report.test !== null && report.test.failed === 0 ? 'high' : 'medium',
    generator: `dev-closeout/${short}`,
  }
}

export function runCloseout(db: Db, options: CloseoutOptions): CloseoutResult {
  const report = buildCloseoutReport(options)
  const deps = { personaId: options.personaId }
  ensureProject(db, {
    projectId: options.projectId,
    canonicalName: options.projectId,
    workspaceKey: report.repo,
    deps,
  })
  const binding = bindSession(db, {
    bindingId: `bnd_closeout_${options.projectId}`,
    projectId: options.projectId,
    platform: options.platform,
    sessionRef: options.sessionRef,
    grantGeneration: 'closeout',
    deps,
  })

  const head = readCheckpoint(db, { projectId: options.projectId, branchKey: options.branchKey })
  const inherited =
    head === null || head.revision === null ? null : { nextSteps: head.revision.nextSteps }
  const revision = revisionOfReport(report, inherited)
  const requestId = `closeout:${report.commit}`
  const payloadHash = createHash('sha256').update(JSON.stringify(report)).digest('hex')
  // 工作树脏时，同一个提交可能有很多种「组合」：拿内容指纹做区分，
  // 否则第二次脏收口会撞上第一次的 requestId、被当成「同一请求换了内容」拒掉。
  const effectiveRequestId = report.dirty ? `${requestId}:${payloadHash.slice(0, 8)}` : requestId
  const anchor = binding.committedToSeq + 1
  const result = saveCheckpoint(db, {
    projectId: options.projectId,
    branchKey: options.branchKey,
    bindingId: binding.bindingId,
    mode: 'manual',
    requestId: effectiveRequestId,
    payloadHash,
    // manual 不推进水位，区间只是占位（G1-A 要求 fromSeq === toSeq）。
    fromSeq: anchor,
    toSeq: anchor,
    algorithmVersion: 'dev-closeout-v1',
    digest: { bodyJson: JSON.stringify(report) },
    revision,
    expectedRevision: head === null ? undefined : head.headRevision,
  })
  return {
    report,
    checkpointId: result.checkpointId,
    revision: result.revision,
    saved: result.saved,
    replayed: result.replayed,
    requestId,
    payloadHash,
  }
}

function argOf(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

async function main(argv: readonly string[]): Promise<number> {
  const sessionRef = argOf(argv, 'session')
  if (sessionRef === undefined) {
    console.error('缺少 --session：首次收口必须显式选定目标会话，否则之后的 Brief 找不到这批记录。')
    return 2
  }
  const dataDir = argOf(argv, 'dir') ?? join(homedir(), '.dsh', 'psyche')
  const options: CloseoutOptions = {
    repo: argOf(argv, 'repo') ?? process.cwd(),
    dataDir,
    projectId: argOf(argv, 'project') ?? 'psyche',
    // 默认写「项目通用进度」分支（空串）：`buildProjectBrief` 不带 branchKey 时读的就是它，
    // 收口记录因此能被任何会话读到。按分支细分才显式传 --branch。
    branchKey: argOf(argv, 'branch') ?? '',
    sessionRef,
    personaId: argOf(argv, 'persona') ?? 'main',
    platform: argOf(argv, 'platform') ?? 'desktop',
  }
  const logPath = argOf(argv, 'log')
  if (logPath !== undefined) options.logPath = logPath
  const evidence = argv.filter((value) => value.startsWith('docs/') || value.startsWith('docs\\'))
  if (evidence.length > 0) options.evidencePaths = evidence

  const file = join(dataDir, 'memory.sqlite3')
  const opened = await openDatabase({ file })
  try {
    const result = runCloseout(opened.db, options)
    console.log(
      JSON.stringify(
        {
          ok: true,
          saved: result.saved,
          replayed: result.replayed,
          checkpointId: result.checkpointId,
          revision: result.revision,
          requestId: result.requestId,
          commit: result.report.commit,
          test: result.report.test,
          dirty: result.report.dirty,
        },
        null,
        2,
      ),
    )
    return 0
  } finally {
    opened.db.close()
  }
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('dev-closeout.js')
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
