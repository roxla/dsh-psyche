// 入口依赖守卫（直接引用检查，不是传递依赖分析）。
// 目标：src/index.ts 不得把 Outbox/Service/Worker 拉进插件启动路径。
// 跑法：node test/outbox-entry-guard.ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0
function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    pass += 1
    console.log(`  ok   ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'src/index.ts')
const OUTBOX_MODULES = [
  'proactive-outbox',
  'proactive-outbound-service',
  'proactive-outbox-worker',
]
const OUTBOX_RE = OUTBOX_MODULES.join('|')

interface Finding {
  line: number
  text: string
}

/** 找出直接引用 Outbox 模块的行：静态 import / export-from / 动态 import() / require()。 */
function findDirectReferences(source: string): Finding[] {
  const findings: Finding[] = []
  const lines = source.split('\n')
  const patterns = [
    // import ... from '...'
    new RegExp(`^\\s*import\\s[^\\n]*from\\s*['"][^'"]*(?:${OUTBOX_RE})[^'"]*['"]`),
    // export ... from '...'
    new RegExp(`^\\s*export\\s[^\\n]*from\\s*['"][^'"]*(?:${OUTBOX_RE})[^'"]*['"]`),
    // import('...') / require('...')
    new RegExp(`(?:import|require)\\s*\\(\\s*['"][^'"]*(?:${OUTBOX_RE})[^'"]*['"]\\s*\\)`),
    // side-effect import '...'
    new RegExp(`^\\s*import\\s*['"][^'"]*(?:${OUTBOX_RE})[^'"]*['"]`),
  ]
  lines.forEach((text, index) => {
    if (patterns.some((pattern) => pattern.test(text))) {
      findings.push({ line: index + 1, text: text.trim() })
    }
  })
  return findings
}

console.log('[P3-C-3a] 入口依赖守卫')

const entrySource = readFileSync(ENTRY, 'utf8')
const entryFindings = findDirectReferences(entrySource)
ok(
  'src/index.ts 不直接引用 Outbox 模块（直接引用检查，不覆盖传递依赖）',
  entryFindings.length === 0,
  entryFindings,
)

const samples = [
  ["import { OutboxWorker } from '../packages/core/src/proactive-outbox-worker'", '静态 import'],
  ["export { OutboxStore } from '../packages/core/src/proactive-outbox'", 'export-from'],
  ["const m = await import('../packages/core/src/proactive-outbound-service')", '动态 import()'],
  ["const s = require('./proactive-outbox')", 'require()'],
]
for (const [sample, label] of samples) {
  const caught = findDirectReferences(sample)
  ok(`守卫自检能捕获${label}`, caught.length === 1, caught)
}

console.log(`\n[P3-C-3a 入口守卫] ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
