/**
 * P5-1a：人格只读投影与 Context 注册自检。
 *
 * 跑法：`node test/persona-runtime.ts`（要求先 `npm run build`）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initPathsOf, sha256OfText } from '../dist/lib/persona-init.js'
import { CORE_COMMITMENTS } from '../dist/lib/presets.js'
import {
  estimatePersonaTokens,
  readPersonaProjection,
} from '../dist/lib/persona-runtime.js'
import {
  createPersonaAgentGate,
  PERSONA_CONTEXT_NAME,
  PERSONA_CONTEXT_ORDER,
  registerPersonaContext,
} from '../dist/lib/persona-context.js'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`)
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'psyche-persona-runtime-'))
let caseNo = 0

function makeDir(): { dir: string; paths: ReturnType<typeof initPathsOf> } {
  caseNo += 1
  const dir = join(sandbox, `case-${caseNo}`, 'data')
  mkdirSync(dir, { recursive: true })
  return { dir, paths: initPathsOf(dir) }
}

function writeLocked(dir: string, text: string): void {
  const paths = initPathsOf(dir)
  writeFileSync(paths.identity, text, 'utf8')
  const hash = sha256OfText(text)
  const now = '2026-01-01T00:00:00.000Z'
  const doc = {
    schemaVersion: 1,
    personaId: 'main',
    initialization: {
      status: 'locked',
      presetId: null,
      presetName: '自定义人格',
      presetVersion: 'custom',
      presetDraft: false,
      initializedAt: now,
      lockedAt: now,
      identityHash: hash,
      identityBytes: Buffer.byteLength(text, 'utf8'),
      pendingIdentityHash: null,
      resetFrom: null,
    },
    commitments: CORE_COMMITMENTS.map((commitment) => ({ ...commitment })),
    tendencies: [],
    updatedAt: now,
  }
  writeFileSync(paths.persona, JSON.stringify(doc, null, 2), 'utf8')
}

function cleanup(): void {
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('[P5-1a persona-runtime]')

// A. 状态矩阵
{
  const { dir } = makeDir()
  const text = '我是心灵。\n我会先接住情绪，再一起想办法。'
  writeLocked(dir, text)
  const p = readPersonaProjection({ dataDir: dir })
  check('locked+hash -> ready', p.status === 'ready', p.status)
  check('ready 返回原文逐字一致', p.text === text)
  check('chars 按码点计数', p.chars === [...text].length, p.chars)
  check('无 tokenizer 使用估算', p.estimated === true && p.tokens > 0, { tokens: p.tokens, estimated: p.estimated })
  check('hash 与 persona.json 一致', p.hash === sha256OfText(text))
}

{
  const { dir } = makeDir()
  writeLocked(dir, '第一版人格')
  writeFileSync(initPathsOf(dir).identity, '被偷偷改过的人格', 'utf8')
  const p = readPersonaProjection({ dataDir: dir })
  check('哈希漂移 -> identity_drift', p.status === 'identity_drift', p.status)
  check('漂移不返回原文', p.text === undefined)
}

{
  const { dir } = makeDir()
  writeLocked(dir, '正常人格')
  rmSync(initPathsOf(dir).identity, { force: true })
  const p = readPersonaProjection({ dataDir: dir })
  check('identity 缺失 -> damaged', p.status === 'damaged', p.status)
  check('缺失不返回原文', p.text === undefined)
}

{
  const { dir } = makeDir()
  const p = readPersonaProjection({ dataDir: dir })
  check('空数据根 -> uninitialized', p.status === 'uninitialized', p.status)
  check('未初始化不返回原文', p.text === undefined)
}

{
  const { dir } = makeDir()
  writeLocked(dir, '人格')
  const p = readPersonaProjection({ dataDir: dir, enabled: false })
  check('开关关闭 -> disabled', p.status === 'disabled', p.status)
  check('disabled 不返回原文', p.text === undefined)
}

// B. 预算
{
  const { dir } = makeDir()
  const text = '字'.repeat(6001)
  writeLocked(dir, text)
  const p = readPersonaProjection({ dataDir: dir })
  check('超 6000 字符 -> over_budget/chars', p.status === 'over_budget' && p.reason === 'chars', p)
  check('超限不返回原文', p.text === undefined)
}

{
  const { dir } = makeDir()
  writeLocked(dir, '短人格')
  const p = readPersonaProjection({
    dataDir: dir,
    tokenizer: () => 3001,
  })
  check('tokenizer 超 3000 -> over_budget/tokens', p.status === 'over_budget' && p.reason === 'tokens', p)
  check('超 token 不返回原文', p.text === undefined)
}

{
  const { dir } = makeDir()
  writeLocked(dir, '短人格')
  const p = readPersonaProjection({
    dataDir: dir,
    tokenizer: () => 10,
  })
  check('精确 tokenizer -> ready/estimated=false', p.status === 'ready' && p.tokens === 10 && p.estimated === false, p)
}

{
  const { dir } = makeDir()
  writeLocked(dir, '短人格')
  const p = readPersonaProjection({
    dataDir: dir,
    tokenizer: () => {
      throw new Error('boom')
    },
  })
  check('tokenizer 抛错 -> unavailable', p.status === 'unavailable', p.status)
  check('计数异常不注入', p.text === undefined)
}

// C. Context 注册
{
  const { dir } = makeDir()
  const text = '人格原文：慢一点也没关系。'
  writeLocked(dir, text)
  let registered: { name: string; order: number; text: () => string } | null = null
  let disposed = 0
  const registration = registerPersonaContext({
    api: {
      context(options) {
        registered = options
        return () => {
          disposed += 1
        }
      },
    },
    dataDir: dir,
  })
  check('注册名 psyche-persona', registered?.name === PERSONA_CONTEXT_NAME, registered?.name)
  check('注册 order=90', registered?.order === PERSONA_CONTEXT_ORDER, registered?.order)
  const first = registration?.text()
  const second = registration?.text()
  check('Provider 返回原文', first === text)
  check('连续调用不累积', second === text && second === first)
  registration?.dispose()
  check('dispose 生效', disposed === 1)
}

{
  const { dir } = makeDir()
  writeLocked(dir, '旧人格')
  writeFileSync(initPathsOf(dir).identity, '新人格但未确认', 'utf8')
  let provider: (() => string) | null = null
  registerPersonaContext({
    api: {
      context(options) {
        provider = options.text
        return () => {}
      },
    },
    dataDir: dir,
  })
  check('drift 时 Provider 返回空串', provider?.() === '')
}

{
  const { dir } = makeDir()
  writeLocked(dir, '人格')
  const off = registerPersonaContext({
    api: { context: () => () => {} },
    dataDir: dir,
    enabled: false,
  })
  check('enabled=false 不注册', off === null)
}

// D. 估算函数
check('估算对空串为 0', estimatePersonaTokens('') === 0)
check('估算随长度单调', estimatePersonaTokens('字'.repeat(100)) > estimatePersonaTokens('字'.repeat(10)))

// E. P5-1b：延迟 dataDir、Agent 绑定、收紧上限、热重载
{
  const { dir } = makeDir()
  const text = '我是心灵（P5-1b marker）。'
  writeLocked(dir, text)
  let currentDir = ''
  let provider: ((assembly?: { agent?: { id?: string } }) => string) | null = null
  registerPersonaContext({
    api: {
      context(options) {
        provider = options.text
        return () => {}
      },
    },
    dataDir: () => currentDir,
    resolveAgent: (agent) => agent?.id === 'psyche-main',
  })
  check('dataDir 未解析时 Provider 返回空串', provider?.({ agent: { id: 'psyche-main' } }) === '')
  currentDir = dir
  check('dataDir 延迟解析后返回原文', provider?.({ agent: { id: 'psyche-main' } }) === text)
  check('无绑定 Agent 不注入', provider?.({ agent: { id: 'other-agent' } }) === '')
  check('无 assembly 不注入', provider?.() === '')
}

{
  const { dir } = makeDir()
  writeLocked(dir, '这是一段超过五个字符的人格原文。')
  let provider: ((assembly?: { agent?: { id?: string } }) => string) | null = null
  registerPersonaContext({
    api: {
      context(options) {
        provider = options.text
        return () => {}
      },
    },
    dataDir: dir,
    maxChars: 5,
    maxTokens: 3000,
  })
  check('maxChars 收紧后超限不注入', provider?.() === '')
}

{
  const { dir } = makeDir()
  writeLocked(dir, '热重载人格')
  let registered = 0
  let disposed = 0
  const api = {
    context() {
      registered += 1
      return () => {
        disposed += 1
      }
    },
  }
  const first = registerPersonaContext({ api, dataDir: dir })
  first?.dispose()
  const second = registerPersonaContext({ api, dataDir: dir })
  check('热重载后只保留一个注册', registered === 2 && disposed === 1)
  check('重载后 Provider 仍返回原文', second?.text() === '热重载人格')
  second?.dispose()
  check('全部注销后无残留', disposed === 2)
}

{
  const gate = createPersonaAgentGate((agent) => (agent.id === 'bound' ? { contactId: 'ct_1' } : null))
  check('Agent gate：有绑定放行', gate({ id: 'bound' }) === true)
  check('Agent gate：无绑定拒绝', gate({ id: 'other' }) === false)
  check('Agent gate：无 Agent 拒绝', gate(undefined) === false)
  const throwing = createPersonaAgentGate(() => {
    throw new Error('boom')
  })
  check('Agent gate：读取异常拒绝', throwing({ id: 'bound' }) === false)
}

cleanup()

console.log(`\n${pass} 通过，${fail} 失败`)
if (fail > 0) process.exitCode = 1
