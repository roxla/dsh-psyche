// P2-Recall R6-5 前置：最终请求边界的注入块清理。
//
// 验收口径：
// - 只放行「本次请求登记过」的注入块（request-id 在宿主内存清单里）；
// - 历史块、无 request-id 的块、清单里不存在的块 → 从 messages 移除；
// - 整条消息只有外来块 → 整条删除；块与正文混合 → 只移除块文本；
// - 调用方必须用 validateFinalRequest 返回的 messages 调 Adapter；
// - 用 fake adapter 收到真实消息数组验证，而不是只看 ok。
//
// 跑法：node test/injection-boundary.ts（需要先 npm run build）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../dist/lib/adapter.js'
import {
  createInjectionManifest,
  hashText,
  InjectionManifestStore,
} from '../dist/lib/injection-manifest.js'

void hashText
import { validateFinalRequest } from '../dist/lib/final-check.js'

let passed = 0
let failed = 0

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

const dir = mkdtempSync(join(tmpdir(), 'psyche-injection-boundary-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const opened = await openDatabase({ file: join(dir, 'memory.sqlite3'), driverPreference: 'auto', logger: log })
const db = opened.db
migrate(db, log)

const SESSION = 'session-injection-boundary'

function block(requestId, statement = '用户喜欢喝乌龙茶。') {
  return (
    `<memory-context request-id="${requestId}" contact-id="" channel-id="" ` +
    'block-type="memory-context" turn="2" step="1">\n' +
    `【记忆】\n- [art_boundary@1] ${statement}\n</memory-context>`
  )
}

function manifestOf(requestId, text) {
  return createInjectionManifest({
    requestId,
    sessionId: SESSION,
    turn: 2,
    step: 1,
    contactId: null,
    channelId: null,
    groupId: null,
    purpose: null,
    items: [],
    messageHash: hashText(text),
  })
}

console.log('\n[R6-5 前置] 最终请求边界的注入块清理')

// ── 1. 历史块被移除，当前块保留 ──────────────────────────────────────
{
  const currentId = 'inj_current'
  const currentText = block(currentId)
  const store = new InjectionManifestStore()
  store.register(manifestOf(currentId, currentText))
  const messages = [
    { role: 'user', content: block('inj_history', '旧的历史结论') },
    { role: 'user', content: currentText },
    { role: 'user', content: '今天喝什么？' },
  ]
  const result = validateFinalRequest({ manifests: store, db, messages, sessionId: SESSION })
  ok('历史块清理后请求通过', result.ok, result.violations)
  eq('移除的块数', result.strippedBlocks, 1)
  eq('整条删除的消息数', result.strippedMessages, 1)
  eq('清理后消息数', result.messages.length, 2)
  ok('历史内容不再出现', !JSON.stringify(result.messages).includes('旧的历史结论'))
  ok('当前块仍在', JSON.stringify(result.messages).includes(currentId))
  ok('原始数组未被修改', messages.length === 3)
}

// ── 2. 清单为空时所有块都被清理 ─────────────────────────────────────
{
  const store = new InjectionManifestStore()
  const messages = [
    { role: 'user', content: block('inj_a', 'A 的记忆') },
    { role: 'user', content: block('inj_b', 'B 的记忆') },
    { role: 'user', content: '问题' },
  ]
  const result = validateFinalRequest({ manifests: store, db, messages, sessionId: SESSION })
  ok('无清单时请求仍可通过（块被移除而不是整轮失败）', result.ok, result.violations)
  eq('移除两个块', result.strippedBlocks, 2)
  eq('移除两条消息', result.strippedMessages, 2)
  eq('只剩用户问题', result.messages.length, 1)
  ok('没有记忆内容泄漏', !JSON.stringify(result.messages).includes('inj_a'))
}

// ── 3. 无 request-id 的块也清理 ─────────────────────────────────────
{
  const store = new InjectionManifestStore()
  const messages = [
    { role: 'user', content: '<memory-context block-type="memory-context">\n【记忆】\n- [art@1] 无来源\n</memory-context>' },
    { role: 'user', content: '问题' },
  ]
  const result = validateFinalRequest({ manifests: store, db, messages, sessionId: SESSION })
  eq('无 request-id 的块被移除', result.strippedBlocks, 1)
  eq('整条删除', result.strippedMessages, 1)
  eq('只剩问题', result.messages.length, 1)
}

// ── 4. 形状怪异（只有开标签）整条丢弃 ───────────────────────────────
{
  const store = new InjectionManifestStore()
  const messages = [
    { role: 'user', content: '残留的注入通道 <memory-context request-id="inj_broken">' },
    { role: 'user', content: '问题' },
  ]
  const result = validateFinalRequest({ manifests: store, db, messages, sessionId: SESSION })
  eq('无法解析的注入痕迹被整条丢弃', result.strippedMessages, 1)
  ok('残留文本不出现', !JSON.stringify(result.messages).includes('inj_broken'))
}

// ── 5. 块与正文混合：只移除块文本 ───────────────────────────────────
{
  const currentId = 'inj_mixed_current'
  const currentText = block(currentId)
  const store = new InjectionManifestStore()
  store.register(manifestOf(currentId, currentText))
  const mixed = `这是用户的正文。\n${block('inj_mixed_history', '历史片段')}\n正文继续。`
  const messages = [
    { role: 'user', content: mixed },
    { role: 'user', content: '问题' },
  ]
  const result = validateFinalRequest({ manifests: store, db, messages, sessionId: SESSION })
  eq('混合消息里的外来块被移除', result.strippedBlocks, 1)
  eq('消息本身保留', result.strippedMessages, 0)
  ok('正文保留', JSON.stringify(result.messages).includes('这是用户的正文。'))
  ok('历史片段不出现', !JSON.stringify(result.messages).includes('历史片段'))
}

// ── 6. 伪装 request-id 但正文被改：保留块后由 hash 检查拒绝 ─────────
{
  const currentId = 'inj_tampered'
  const original = block(currentId, '原始正文')
  const tampered = block(currentId, '被篡改的正文')
  const store = new InjectionManifestStore()
  store.register(manifestOf(currentId, original))
  const messages = [{ role: 'user', content: tampered }]
  const result = validateFinalRequest({ manifests: store, db, messages, sessionId: SESSION })
  eq('块仍在（request-id 匹配）', result.strippedBlocks, 0)
  ok('hash 不匹配导致请求失败', result.ok === false)
  ok(
    '违规类型是 hash-mismatch',
    result.violations.some((violation) => violation.kind === 'hash-mismatch'),
    result.violations,
  )
}

// ── 7. 真实 Adapter 收到的消息数组（模拟守卫流）────────────────────
{
  const currentId = 'inj_adapter'
  const currentText = block(currentId)
  const store = new InjectionManifestStore()
  store.register(manifestOf(currentId, currentText))
  const requestMessages = [
    { role: 'user', content: block('inj_adapter_history', '历史 A 的记忆') },
    { role: 'user', content: currentText },
    { role: 'user', content: '今天喝什么？' },
  ]

  let received = null
  function fakeAdapterStream(messages) {
    return (async function* () {
      received = messages
      yield 'done'
    })()
  }

  const result = validateFinalRequest({
    manifests: store,
    db,
    messages: requestMessages,
    sessionId: SESSION,
  })
  ok('守卫流校验通过', result.ok, result.violations)
  if (result.strippedBlocks > 0 || result.strippedMessages > 0) {
    requestMessages.splice(0, requestMessages.length, ...result.messages)
  }
  for await (const _ of fakeAdapterStream(requestMessages)) {
    void _
  }

  ok('Adapter 收到的数组与清理后一致', JSON.stringify(received) === JSON.stringify(result.messages))
  ok('Adapter 收到的消息不含历史块', !JSON.stringify(received).includes('inj_adapter_history'))
  ok('Adapter 收到当前块', JSON.stringify(received).includes(currentId))
}

db.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n[R6-5 前置] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
