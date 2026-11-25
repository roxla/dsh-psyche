/**
 * 关系信号的归属判定：四条判据都在这里，不碰数据库。
 *
 * 这条路径上出过一次「看起来在工作、实际一句没记」的缺陷——桌面会话没有
 * Adapter 绑定，取不到 contactId，整段写入被 `if (typeof contactId === 'string')`
 * 静默跳过。判断躲在闭包里时测试摸不到，只能靠真机碰运气。
 */
import { planAffectContact } from '../dist/lib/affect-contact.js'

let passed = 0
let failed = 0

function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label} -> ${JSON.stringify({ actual, expected })}`)
  }
}

// ① 顶层桌面、真人用户消息、没有绑定 → 该落到桌面主人那一支（调用方再去查库）。
eq(
  '顶层桌面真人消息走桌面主人分支',
  planAffectContact({ delegated: false, hasBinding: false, messageKind: 'user' }),
  { kind: 'desktop-owner' },
)

// ② 委派深度大于 0 → 跳过，且不查 Owner（调用方看到 skip 就不会碰 db）。
eq(
  '委派会话不记关系信号',
  planAffectContact({ delegated: true, hasBinding: false, messageKind: 'user' }),
  { kind: 'skip', reason: 'delegated' },
)

// ③ 判不出身份（拿不到可信的宿主 header）→ 同样跳过。
eq(
  '判不出委派身份也不记',
  planAffectContact({ delegated: null, hasBinding: false, messageKind: 'user' }),
  { kind: 'skip', reason: 'delegated' },
)

// ④ QQ 私聊有绑定但绑定里没有 contactId → 跳过，不退回桌面主人。
eq(
  '有绑定但缺 contactId 不退回主人',
  planAffectContact({ delegated: false, hasBinding: true, boundContactId: null, messageKind: 'user' }),
  { kind: 'skip', reason: 'no-contact' },
)

// ⑤ 正常的 QQ 私聊绑定 → 记给那个联系人。
eq(
  'QQ 私聊按绑定里的联系人记',
  planAffectContact({
    delegated: false,
    hasBinding: true,
    boundContactId: 'ct_x',
    messageKind: 'user',
  }),
  { kind: 'bound', contactId: 'ct_x' },
)

// ⑥ 顶层桌面但收到的是代理转来的消息 → 即使正文写着「谢谢」也不记。
eq(
  'agent-message 不是用户说的',
  planAffectContact({ delegated: false, hasBinding: false, messageKind: 'agent-message' }),
  { kind: 'skip', reason: 'not-user' },
)
eq(
  'subagent-settled 不是用户说的',
  planAffectContact({ delegated: false, hasBinding: false, messageKind: 'subagent-settled' }),
  { kind: 'skip', reason: 'not-user' },
)

console.log(`\n[affect-contact] ${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1
