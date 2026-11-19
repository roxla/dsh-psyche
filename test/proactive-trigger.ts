// P3-C-1 Trigger 专测：确定性 id、冻结、引用规范化、输入校验。
import assert from 'node:assert/strict'
import {
  MAX_TRIGGER_REFS,
  PROACTIVE_TRIGGER_KINDS,
  deriveCandidateId,
  deriveTriggerId,
  normaliseTriggerRefs,
  proactiveTriggerOf,
} from '../packages/core/dist/proactive-trigger.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}

function throwsValidation(run: () => unknown, label: string): void {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  check(caught instanceof Error && (caught as { code?: string }).code === 'E_VALIDATION', label)
}

const base = {
  kind: 'owner_request' as const,
  now: '2026-11-12T02:00:00.000Z',
  contactId: 'ct_10001',
  evidenceRefs: ['evt_1', 'src_2'],
}

// 1. 确定性
check(deriveTriggerId(base) === deriveTriggerId({ ...base }), '同输入 triggerId 相同')
check(deriveTriggerId(base) !== deriveTriggerId({ ...base, now: '2026-11-12T03:00:00.000Z' }), '时间变化 id 变化')
check(deriveTriggerId(base) !== deriveTriggerId({ ...base, kind: 'milestone' }), '类型变化 id 变化')
check(deriveTriggerId(base) !== deriveTriggerId({ ...base, contactId: 'ct_20002' }), '联系人变化 id 变化')
check(deriveTriggerId(base) !== deriveTriggerId({ ...base, evidenceRefs: ['src_2', 'evt_1'] }), '证据顺序变化 id 变化')

// 2. 显式 id / 冻结 / 字段
const explicit = proactiveTriggerOf({ ...base, triggerId: 'trg_manual' })
check(explicit.triggerId === 'trg_manual', '显式 triggerId 原样保留')
check(explicit.createdAt === base.now, 'createdAt 取 now')
check(Object.isFrozen(explicit), '返回对象冻结')
check(explicit.contactId === 'ct_10001', 'contactId 保留')

// 3. 引用规范化
check(JSON.stringify(normaliseTriggerRefs([' a ', 'a', '', undefined, 'b'])) === '["a","b"]', '去空去重保序')
check(normaliseTriggerRefs(undefined).length === 0, '缺省为空数组')
throwsValidation(() => normaliseTriggerRefs('x'), '非数组拒绝')
throwsValidation(() => normaliseTriggerRefs([1]), '非字符串拒绝')
throwsValidation(() => normaliseTriggerRefs(['x'.repeat(201)]), '超长引用拒绝')
throwsValidation(
  () => normaliseTriggerRefs(Array.from({ length: MAX_TRIGGER_REFS + 1 }, (_, i) => `e${i}`)),
  '超过条数上限拒绝',
)

// 4. 输入校验
throwsValidation(() => proactiveTriggerOf({ ...base, kind: 'nope' as never }), '未知类型拒绝')
throwsValidation(() => proactiveTriggerOf({ ...base, now: 'not-a-time' }), '非法时间拒绝')
throwsValidation(() => proactiveTriggerOf({ ...base, contactId: '  ' }), '空 contactId 拒绝')
check(PROACTIVE_TRIGGER_KINDS.length === 3, '冻结三类触发')

// 5. 候选 id
check(deriveCandidateId('ct_1', 'trg_1') === deriveCandidateId('ct_1', 'trg_1'), '候选 id 确定性')
check(deriveCandidateId('ct_1', 'trg_1') !== deriveCandidateId('ct_2', 'trg_1'), '候选 id 随联系人变化')

console.log(`[P3-C proactive-trigger] ${passed} 通过 0 失败`)
