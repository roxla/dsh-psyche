// 群白名单只授采集，不授回复。
//
// 第 50 轮外部评审 Q1 选 (a)：覆盖层只存群号，精细 RoomPolicy 仍归 config.groups。
// 这个夹具验的是「白名单群能生成采集输入、非白名单群一条都不生成、群消息永远不成 reply」。
import { groupRoomPolicies, groupMessageForCapture, resolveGroupCaptureMode } from '../dist/lib/qq-group-ingress.js'

let passed = 0
let failed = 0
function eq(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed += 1; console.log('  ok ' + label) }
  else { failed += 1; console.error('  FAIL ' + label, { actual, expected }) }
}
function ok(label: string, good: boolean, detail?: unknown) {
  if (good) { passed += 1; console.log('  ok ' + label) }
  else { failed += 1; console.error('  FAIL ' + label, detail) }
}

const event = (groupId: number, userId: number, text: string) => ({
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  group_id: groupId,
  user_id: userId,
  self_id: 90000,
  message_id: 5001,
  sender: { user_id: userId },
  message: [{ type: 'text', data: { text } }],
})

// ① 白名单群（没有精细策略）按 all_visible_messages 采集
{
  const mode = resolveGroupCaptureMode(new Map(), '70001', ['70001'])
  eq('策略是字符串模式', mode, 'all_visible_messages')
  // 字符串模式走简化分支：正文由调用方（bridge 里的 oneBotText）算好传进来。
  const input = groupMessageForCapture(event(70001, 20001, '今天下午三点开会'), new Map([['70001', mode as never]]), '今天下午三点开会', '')
  ok('生成了采集输入', input !== null, input)
  eq('群号正确', input?.externalRoomId, '70001')
  eq('发言人是这条消息的发送者', input?.stableUserId, '20001')
  eq('正文取到了', input?.text, '今天下午三点开会')
}

// ② 非白名单群生成不了采集输入
{
  eq('没有策略', resolveGroupCaptureMode(new Map(), '79999', ['70001']), null)
  const input = groupMessageForCapture(event(79999, 20001, '这个群不在名单里'), new Map(), '', '')
  eq('没有输入', input, null)
}

// ③ 精细策略优先于白名单默认值
{
  const policies = groupRoomPolicies({
    enabled: true,
    allowed: [{ externalRoomId: '70001', captureMode: 'mentioned_only', silence: { timezone: 'Asia/Shanghai' } }],
  })
  eq('取到精细策略', policies.size, 1)
  const mode = resolveGroupCaptureMode(policies, '70001', ['70001'])
  eq('用的是精细策略而不是默认值', typeof mode, 'object')
}

// ④ 群号为空时一律不给策略
eq('空群号', resolveGroupCaptureMode(new Map(), '', ['']), null)

// ⑤ 白名单默认策略不带 reply 概念
{
  const mode = resolveGroupCaptureMode(new Map(), '70001', ['70001'])
  ok('是字符串模式，不是 RoomPolicy', typeof mode === 'string', mode)
}

// ⑥ 显式空名单能撤销采集（即使宿主配了精细策略）
{
  const policies = groupRoomPolicies({
    enabled: true,
    allowed: [{ externalRoomId: '70001', silence: { timezone: 'Asia/Shanghai' } }],
  })
  eq('宿主确实配了这个群', policies.size, 1)
  eq('显式名单为空 → 不采集', resolveGroupCaptureMode(policies, '70001', [], true), null)
  eq('没显式名单 → 仍按宿主配置采集', typeof resolveGroupCaptureMode(policies, '70001', [], false), 'object')
}

// ⑦ 显式名单里有这个群、宿主也配了，取精细策略
{
  const policies = groupRoomPolicies({
    enabled: true,
    allowed: [{ externalRoomId: '70001', silence: { timezone: 'Asia/Shanghai' } }],
  })
  eq('两者都在 → 精细策略', typeof resolveGroupCaptureMode(policies, '70001', ['70001'], true), 'object')
}

console.log(`[qq-group-access] ${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
