// Initiator 判定测试（P3-A B2）：四类优先级、证据门槛、非法输入降级。
import assert from 'node:assert/strict'
import {
  MOOD_INITIATOR_PRIORITY,
  isMoodInitiatorTrusted,
  resolveMoodInitiator,
} from '../packages/core/dist/mood-initiator.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}

check(MOOD_INITIATOR_PRIORITY.join(',') === 'scheduled,persona,user,unknown', '优先级顺序冻结')

// 四类判定
const scheduled = resolveMoodInitiator({
  userMessageCount: 3,
  tokens: { scheduled: { taskId: 'daily-checkin' }, persona: { trigger: 'proactive' } },
})
check(scheduled.initiator === 'scheduled', 'scheduled 压过 persona/user')
check(scheduled.basis === 'scheduled-task', 'scheduled basis')

const persona = resolveMoodInitiator({
  userMessageCount: 3,
  tokens: { persona: { trigger: 'proactive' } },
})
check(persona.initiator === 'persona', 'persona 压过 user')
check(persona.basis === 'core-persona-trigger', 'persona basis')

const user = resolveMoodInitiator({ userMessageCount: 1 })
check(user.initiator === 'user', '有真实用户消息 → user')
check(user.basis === 'user-message', 'user basis')

const nobody = resolveMoodInitiator({ userMessageCount: 0 })
check(nobody.initiator === 'unknown', '没有证据 → unknown')
check(nobody.basis === 'no-trusted-source', 'unknown basis')

// 非法证据不影响判定：空 taskId / 未知 trigger 当作没有 token
check(resolveMoodInitiator({ userMessageCount: 0, tokens: { scheduled: { taskId: '   ' } } }).initiator === 'unknown', '空 taskId 不算 scheduled')
check(resolveMoodInitiator({ userMessageCount: 0, tokens: { persona: { trigger: 'x' as never } } }).initiator === 'unknown', '未知 trigger 不算 persona')
check(resolveMoodInitiator({ userMessageCount: 0, tokens: null }).initiator === 'unknown', 'tokens=null → unknown')

// 数量归一化
check(resolveMoodInitiator({ userMessageCount: -5 }).initiator === 'unknown', '负数按 0')
check(resolveMoodInitiator({ userMessageCount: Number.NaN }).initiator === 'unknown', 'NaN 按 0')
check(resolveMoodInitiator({ userMessageCount: 2.9 }).userMessageCount === 2, '小数向下取整')
check(resolveMoodInitiator({ userMessageCount: 1 }).userMessageCount === 1, '整数原样')

// 判定只依赖证据，不依赖文本/顺序
const a = resolveMoodInitiator({ userMessageCount: 2 })
const b = resolveMoodInitiator({ userMessageCount: 4 })
check(a.initiator === b.initiator && a.initiator === 'user', 'user 判定与消息条数无关（>0 即可）')

// 可信来源
check(isMoodInitiatorTrusted('user') === true, 'user 可信')
check(isMoodInitiatorTrusted('persona') === true, 'persona 可信（v1 只识别不评估）')
check(isMoodInitiatorTrusted('scheduled') === true, 'scheduled 可信（v1 只识别不评估）')
check(isMoodInitiatorTrusted('unknown') === false, 'unknown 不可信')

console.log(`[P3-A B2 mood-initiator] ${passed} 通过 0 失败`)
