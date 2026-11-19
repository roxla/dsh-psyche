// C 阶段：主 profile 三个记忆功能的默认策略与生效状态（B-01~B-20）。
//
// 背景：capture / injection / finalCheck 过去默认全关，R6 归档把它们列为 C 阶段第一项。
// 冻结后的策略（C1 决议）：
//   - capture 默认开、injection 默认开；
//   - finalCheck 强制执行，从有效配置中移除（旧配置里的 finalCheck 只作为迁移提示）；
//   - 配置唯一可写入口是宿主插件设置页，Psyche 面板只读；
//   - 审计写 `<dataDir>/config-audit.jsonl`，写失败不回滚已生效配置。
// 这份测试盯五类事情：
//   1. 默认值与显式值的解析（非法值不静默变放行/关闭）；
//   2. finalCheck 不能被配置关掉、且旧字段无论 true/false 都只进 legacy；
//   3. 生效状态只有 lib/behavior.ts 一个计算点；
//   4. 审计记录结构（timestamp/event/source/result）与事件类型；
//   5. 审计只追加、写失败不抛、不回滚配置。
//
// 跑法：node test/behavior.ts（需要先 npm run build）
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../dist/index.js'
import { auditConfigLoad, behaviorOf } from '../dist/lib/behavior.js'

let passed = 0
let failed = 0
function ok(label: string, condition: boolean): void {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}`)
  }
}
function eq(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (!same) console.log(`       actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
  ok(label, same)
}

// B-01：空配置按冻结策略全开。
{
  const state = behaviorOf({})
  eq('B-01 空配置 capture 开', state.capture, true)
  eq('B-01 空配置 injection 开', state.injection, true)
  eq('B-01 空配置 finalCheck 强制开', state.finalCheck, true)
  eq('B-01 空配置没有旧配置提示', state.legacy, [])
  eq('B-01 空配置没有非法值告警', state.warnings, [])
  eq('B-01 配置来源固定为宿主插件设置', state.source, 'host-settings')
}

// B-02 / B-03：显式 false 才关，而且互不影响。
{
  const noCapture = behaviorOf({ capture: { enabled: false } })
  eq('B-02 关 capture 不影响 injection', noCapture.injection, true)
  eq('B-02 关 capture 不关 finalCheck', noCapture.finalCheck, true)
  const noInjection = behaviorOf({ injection: { enabled: false } })
  eq('B-03 关 injection 不影响 capture', noInjection.capture, true)
  eq('B-03 关 injection 不关 finalCheck', noInjection.finalCheck, true)
}

// B-04：finalCheck 不能通过配置关掉；旧字段无论值都不生效、只进 legacy。
{
  const off = behaviorOf({ finalCheck: { enabled: false } })
  eq('B-04 finalCheck 配 false 仍生效', off.finalCheck, true)
  eq('B-04 旧配置 false 进 legacy', off.legacy.length, 1)
  ok('B-04 legacy 文案说明强制开启', off.legacy[0].includes('强制开启'))
  const on = behaviorOf({ finalCheck: { enabled: true } })
  eq('B-04b 旧配置 true 也不作为有效配置', on.legacy.length, 1)
  eq('B-04b 旧配置 true 仍然不改变 finalCheck', on.finalCheck, true)
}

// B-05 / B-06：schema 默认值与显式值。
{
  const parsed = Config({})
  eq('B-05 schema 默认 capture.enabled', parsed.capture.enabled, true)
  eq('B-05 schema 默认 injection.enabled', parsed.injection.enabled, true)
  ok('B-05 schema 不再定义 finalCheck.enabled', (parsed as { finalCheck?: unknown }).finalCheck === undefined)
  const explicit = Config({ capture: { enabled: false }, injection: { enabled: false } })
  eq('B-06 显式 capture=false 不被默认覆盖', explicit.capture.enabled, false)
  eq('B-06 显式 injection=false 不被默认覆盖', explicit.injection.enabled, false)
}

// B-07：非法值必须报错，不能静默转成放行。
{
  let threw = false
  try {
    Config({ capture: { enabled: 'yes' } })
  } catch {
    threw = true
  }
  ok('B-07 非法 capture 值被拒绝', threw)
}

// B-07b：走到运行时仍未预期到的非法值，按默认处理并记 warnings（不静默）。
{
  const state = behaviorOf({ capture: { enabled: 'yes' } })
  eq('B-07b 非法值按默认开启', state.capture, true)
  eq('B-07b 非法值进 warnings', state.warnings.length, 1)
}

// B-08：旧配置里写 finalCheck.enabled=false 仍然能解析（不因废弃字段报错）。
{
  const parsed = Config({ finalCheck: { enabled: false } })
  eq('B-08 旧配置可解析', (parsed as { finalCheck?: { enabled?: boolean } }).finalCheck?.enabled, false)
  const state = behaviorOf(parsed)
  eq('B-08 旧配置生效状态仍为开', state.finalCheck, true)
  eq('B-08 旧配置进 legacy', state.legacy.length, 1)
}

// B-09 / B-10：配置审计结构、只追加、写失败不抛。
{
  const dir = mkdtempSync(join(tmpdir(), 'psyche-behavior-'))
  try {
    const first = auditConfigLoad(dir, { capture: { enabled: false } }, '2026-11-08T00:00:00.000Z')
    const second = auditConfigLoad(dir, {}, '2026-11-08T01:00:00.000Z')
    ok('B-09 第一次审计写入成功', first)
    ok('B-09 第二次审计写入成功', second)
    const lines = readFileSync(join(dir, 'config-audit.jsonl'), 'utf8').trim().split('\n')
    eq('B-09 审计是追加而不是覆盖', lines.length, 2)
    const record = JSON.parse(lines[0] as string) as { timestamp: string; event: string; source: string; result: string; detail: string }
    eq('B-09 审计时间', record.timestamp, '2026-11-08T00:00:00.000Z')
    eq('B-09 审计事件类型', record.event, 'config.loaded')
    eq('B-09 审计来源是宿主插件设置', record.source, 'host-settings')
    eq('B-09 审计结果是 applied', record.result, 'applied')
    ok('B-09 审计说明含实际生效值', record.detail.includes('capture=false') && record.detail.includes('finalCheck=true'))

    const denied = auditConfigLoad(dir, {}, '2026-11-08T02:00:00.000Z', () => {
      throw new Error('disk full')
    })
    eq('B-10 写失败返回 false 而不是抛出', denied, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// B-12：旧配置会额外写一条 config.legacy。
{
  const dir = mkdtempSync(join(tmpdir(), 'psyche-behavior-legacy-'))
  try {
    const written = auditConfigLoad(dir, { finalCheck: { enabled: false } }, '2026-11-08T04:00:00.000Z')
    ok('B-12 旧配置审计写入成功', written)
    const lines = readFileSync(join(dir, 'config-audit.jsonl'), 'utf8').trim().split('\n')
    eq('B-12 加载一行 + 迁移提示一行', lines.length, 2)
    const legacy = JSON.parse(lines[1] as string) as { event: string; key: string; result: string }
    eq('B-12 迁移事件类型', legacy.event, 'config.legacy')
    eq('B-12 迁移字段名', legacy.key, 'finalCheck.enabled')
    eq('B-12 迁移结果被忽略', legacy.result, 'ignored')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// B-13：非法值会写一条 config.invalid，且不影响已生效配置。
{
  const dir = mkdtempSync(join(tmpdir(), 'psyche-behavior-invalid-'))
  try {
    auditConfigLoad(dir, { capture: { enabled: 'yes' } }, '2026-11-08T05:00:00.000Z')
    const lines = readFileSync(join(dir, 'config-audit.jsonl'), 'utf8').trim().split('\n')
    const invalid = JSON.parse(lines[1] as string) as { event: string; result: string }
    eq('B-13 非法值事件类型', invalid.event, 'config.invalid')
    eq('B-13 非法值按默认处理', invalid.result, 'defaulted')
    eq('B-13 审计失败/非法值都不改变生效状态', behaviorOf({ capture: { enabled: 'yes' } }).capture, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// B-11：审计文件即使内容是坏行也不影响下一次追加（只追加语义）。
{
  const dir = mkdtempSync(join(tmpdir(), 'psyche-behavior2-'))
  try {
    writeFileSync(join(dir, 'config-audit.jsonl'), 'not-json\n', 'utf8')
    const appended = auditConfigLoad(dir, {}, '2026-11-08T03:00:00.000Z')
    ok('B-11 坏行之后仍可追加', appended)
    const lines = readFileSync(join(dir, 'config-audit.jsonl'), 'utf8').trim().split('\n')
    eq('B-11 旧行保留', lines.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n[C 阶段 行为默认值] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
