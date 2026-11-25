// 开发收口（Q4-A）的测试：报告生成是纯读取，写库走 G1-A 的 manual 路径。
//
// 这里刻意用一个临时 git 仓库，而不是直接对 DSH 仓库跑——测试不该依赖本机提交历史。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../dist/lib/adapter.js'
import {
  buildCloseoutReport,
  parseTestLog,
  revisionOfReport,
  runCloseout,
} from '../dist/tools/dev-closeout.js'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1
    console.log(`ok - ${name}`)
  } else {
    failed += 1
    console.log(`FAIL ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
  }
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psyche-closeout-'))
  execFileSync('git', ['-C', dir, 'init', '-q'])
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test'])
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', '首次提交'])
  return dir
}

const repo = makeRepo()
const dataDir = mkdtempSync(join(tmpdir(), 'psyche-closeout-db-'))
const base = {
  repo,
  dataDir,
  projectId: 'psyche',
  branchKey: 'main',
  sessionRef: 'desktop:test-session',
  personaId: 'main',
  platform: 'desktop',
}

// ── 1. 报告生成是纯读取 ──────────────────────────────────────────────────────
const report = buildCloseoutReport(base)
check('报告读到了提交 SHA', /^[0-9a-f]{40}$/.test(report.commit), report.commit)
check('报告读到了提交标题', report.commitSubject === '首次提交', report.commitSubject)
check('干净工作树 dirty=false', report.dirty === false)
check('没有日志时 test 为 null', report.test === null)

// ── 2. 日志解析：UTF-16LE（PowerShell 重定向）与 UTF-8 都要认 ─────────────────
const logDir = mkdtempSync(join(tmpdir(), 'psyche-closeout-log-'))
const utf16 = join(logDir, 'a.log')
writeFileSync(utf16, '[1] 3 通过，0 失败\n[2] 5 通过，1 失败\n', { encoding: 'utf16le' })
const parsed16 = parseTestLog(utf16)
check('UTF-16LE 日志套件数', parsed16?.suites === 2, parsed16)
check('UTF-16LE 日志通过数', parsed16?.passed === 8, parsed16)
check('UTF-16LE 日志失败数', parsed16?.failed === 1, parsed16)

const utf8 = join(logDir, 'b.log')
writeFileSync(utf8, '[1] 7 通过 / 0 失败\n', 'utf8')
const parsed8 = parseTestLog(utf8)
check('UTF-8 日志能解析', parsed8?.suites === 1 && parsed8?.passed === 7, parsed8)

const bad = join(logDir, 'c.log')
writeFileSync(bad, '没有任何统计行\n', 'utf8')
check('解析不出统计返回 null', parseTestLog(bad) === null)
check('日志不存在返回 null', parseTestLog(join(logDir, 'missing.log')) === null)

// ── 3. 报告 → 修订：脏工作树要标注，测试有失败要给 medium ─────────────────────
const dirtyReport = { ...report, dirty: true, test: { logPath: utf8, suites: 1, passed: 7, failed: 0 } }
const dirtyRevision = revisionOfReport(dirtyReport, null)
check(
  '脏工作树标注为工作树组合回归',
  dirtyRevision.completed.some((line) => line.includes('该工作树组合回归')),
  dirtyRevision.completed,
)
check(
  '脏工作树进 blockers',
  dirtyRevision.blockers.some((line) => line.includes('未提交改动')),
  dirtyRevision.blockers,
)

const failingReport = { ...report, dirty: false, test: { logPath: utf16, suites: 2, passed: 8, failed: 1 } }
const failingRevision = revisionOfReport(failingReport, null)
check('有失败时 confidence 是 medium', failingRevision.confidence === 'medium', failingRevision.confidence)
check(
  '有失败时进 blockers',
  failingRevision.blockers.some((line) => line.includes('断言失败')),
  failingRevision.blockers,
)
const cleanRevision = revisionOfReport(
  { ...report, dirty: false, test: { logPath: utf8, suites: 1, passed: 7, failed: 0 } },
  null,
)
check('全绿时 confidence 是 high', cleanRevision.confidence === 'high', cleanRevision.confidence)
check(
  '下一步只能从上次继承',
  revisionOfReport(report, { nextSteps: ['接 G1-B 验收'] }).nextSteps.join('|') === '接 G1-B 验收',
)

// ── 4. 写库：首次 saved，同提交重放 replayed ──────────────────────────────────
const file = join(dataDir, 'memory.sqlite3')
const opened = await openDatabase({ file })
try {
  const first = runCloseout(opened.db, { ...base, logPath: utf8 })
  check('首次收口写入了修订 1', first.saved === true && first.revision === 1, first)
  check('请求标识带提交 SHA', first.requestId === `closeout:${report.commit}`, first.requestId)

  const again = runCloseout(opened.db, { ...base, logPath: utf8 })
  check('同一提交重放不再新增', again.replayed === true && again.saved === false, again)
  check('重放返回同一修订', again.checkpointId === first.checkpointId && again.revision === 1, again)

  const rows = opened.db.get('SELECT COUNT(*) AS n FROM checkpoint_revisions') as { n: number }
  check('库里只有一条修订', rows.n === 1, rows)

  const bindings = opened.db.get('SELECT COUNT(*) AS n FROM project_session_bindings') as { n: number }
  check('绑定没有重复插入', bindings.n === 1, bindings)

  const committed = opened.db.get(
    'SELECT committed_to_seq AS seq FROM project_session_bindings WHERE project_id = ?',
    ['psyche'],
  ) as { seq: number }
  check('手动收口不推进水位', committed.seq === 0, committed)

  // 工作树变脏后重新收口：内容变了，走 CAS 出一条新修订
  writeFileSync(join(repo, 'dirty.txt'), '未提交\n')
  const third = runCloseout(opened.db, { ...base, logPath: utf8 })
  check('脏工作树是新的内容指纹', third.revision === 2, third)
  const revisions = opened.db.get('SELECT COUNT(*) AS n FROM checkpoint_revisions') as { n: number }
  check('两次收口共两条修订', revisions.n === 2, revisions)
} finally {
  opened.db.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(logDir, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
}

console.log(`\n${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
