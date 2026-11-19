// P3-C-1 Eligibility 专测：八项资格检查、等待/拒绝语义、时区与静默、确定性。
import assert from 'node:assert/strict'
import { proactiveTriggerOf } from '../packages/core/dist/proactive-trigger.js'
import {
  evaluateProactiveEligibility,
  localClockOf,
  type EligibilityInput,
} from '../packages/core/dist/proactive-eligibility.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}

function eq<T>(actual: T, expected: T, message: string): void {
  assert.deepEqual(actual, expected, message)
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

const NOW = '2026-11-12T02:00:00.000Z' // Asia/Shanghai 10:00

function base(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    contact: {
      contactId: 'ct_10001',
      personaId: 'main',
      platform: 'qq',
      stableUserId: '10001',
      timezone: 'Asia/Shanghai',
    },
    channel: { platform: 'qq', kind: 'private', status: 'connected' },
    consent: { status: 'granted', source: 'contact-explicit' },
    policy: { proactiveEnabled: true },
    trigger: proactiveTriggerOf({ kind: 'owner_request', now: NOW, contactId: 'ct_10001' }),
    now: NOW,
    usage: { contactToday: 0, globalToday: 0, globalWeek: 0 },
    ...overrides,
  }
}

// 1. 基础资格
const okResult = evaluateProactiveEligibility(base())
check(okResult.eligible === true, '全部满足时 eligible')
eq(okResult.status, 'eligible', '状态 eligible')
eq(okResult.reasonCodes, [], '无原因码')
check(okResult.retryAt === undefined, '合格时无 retryAt')

// 2. 身份缺失 → 拒绝
const noContact = evaluateProactiveEligibility(base({ contact: null }))
eq(noContact.reasonCodes, ['contact-not-found'], '缺联系人只报 contact-not-found')
eq(noContact.status, 'rejected', '缺联系人拒绝')

// 3. 通道离线 → 等待，不淘汰
const offline = evaluateProactiveEligibility(
  base({ channel: { platform: 'qq', kind: 'private', status: 'disconnected' } }),
)
eq(offline.reasonCodes, ['channel-unavailable'], '通道离线原因码')
eq(offline.status, 'waiting', '通道离线是等待')
check(offline.eligible === false, '通道离线不合格')

// 4. 同意
for (const status of ['revoked', 'expired', 'missing'] as const) {
  const result = evaluateProactiveEligibility(base({ consent: { status } }))
  eq(result.reasonCodes, ['no-consent'], `同意 ${status} 拒绝`)
  eq(result.status, 'rejected', `同意 ${status} 为拒绝`)
}
const expired = evaluateProactiveEligibility(
  base({ consent: { status: 'granted', expiresAt: '2026-11-12T01:00:00.000Z' } }),
)
eq(expired.reasonCodes, ['no-consent'], '同意已过期视为无同意')
const expiring = evaluateProactiveEligibility(
  base({ consent: { status: 'granted', expiresAt: '2026-11-12T03:00:00.000Z' } }),
)
eq(expiring.status, 'eligible', '同意未过期仍合格')

// 5. 策略关闭 → 拒绝
eq(
  evaluateProactiveEligibility(base({ policy: { proactiveEnabled: false } })).reasonCodes,
  ['proactive-disabled'],
  '主动联系策略关闭拒绝',
)

// 6. 冷却 → 等待，带 retryAt
const cooling = evaluateProactiveEligibility(
  base({ usage: { lastContactedAt: '2026-11-06T02:00:00.000Z', contactToday: 0 } }),
)
eq(cooling.reasonCodes, ['cooldown'], '冷却原因码')
eq(cooling.status, 'waiting', '冷却是等待')
eq(cooling.retryAt, '2026-11-13T02:00:00.000Z', '冷却 retryAt = 上次 + 7 天')

// 7. 联系人额度
eq(
  evaluateProactiveEligibility(
    base({ usage: { contactToday: 1 }, limits: { contactDailyLimit: 1 } }),
  ).reasonCodes,
  ['contact-quota'],
  '联系人日额度',
)

// 8. 全局限额
eq(
  evaluateProactiveEligibility(base({ usage: { globalToday: 3 } })).reasonCodes,
  ['quota'],
  '全局日额度',
)
eq(
  evaluateProactiveEligibility(base({ usage: { globalWeek: 10 } })).reasonCodes,
  ['quota'],
  '全局周额度',
)

// 9. 时区未知 → 等待，不猜
eq(
  evaluateProactiveEligibility(
    base({ contact: { contactId: 'ct_1', personaId: 'main', platform: 'qq', stableUserId: '1' } }),
  ).reasonCodes,
  ['timezone-unknown'],
  '缺时区等待',
)
eq(
  evaluateProactiveEligibility(
    base({
      contact: {
        contactId: 'ct_1',
        personaId: 'main',
        platform: 'qq',
        stableUserId: '1',
        timezone: 'Mars/Base',
      },
    }),
  ).reasonCodes,
  ['timezone-unknown'],
  '非法时区等待',
)

// 10. 静默时段
const quiet = evaluateProactiveEligibility(base({ now: '2026-11-12T15:00:00.000Z' })) // 23:00
eq(quiet.reasonCodes, ['quiet-hours'], '静默时段原因码')
eq(quiet.status, 'waiting', '静默为等待')
check(typeof quiet.retryAt === 'string', '静默给 retryAt')
const retryClock = quiet.retryAt ? localClockOf(quiet.retryAt, 'Asia/Shanghai') : null
check(retryClock?.hour === 9 && retryClock?.minute === 0, '静默 retryAt 落在本地 09:00')

// 11. 边界
eq(
  evaluateProactiveEligibility(base({ now: '2026-11-12T01:00:00.000Z' })).status,
  'eligible',
  '本地 09:00 合格',
)
eq(
  evaluateProactiveEligibility(base({ now: '2026-11-12T14:00:00.000Z' })).reasonCodes,
  ['quiet-hours'],
  '本地 22:00 进入静默',
)
eq(
  evaluateProactiveEligibility(base({ now: '2026-11-12T00:59:00.000Z' })).reasonCodes,
  ['quiet-hours'],
  '本地 08:59 仍在静默',
)

// 12. 关系分数不参与资格
eq(
  evaluateProactiveEligibility(base({ relationship: { affinity: 99, trust: 'high' } })).status,
  'eligible',
  '高好感/高信任不改变资格',
)
eq(
  evaluateProactiveEligibility(base({ relationship: { affinity: 0, trust: 'unassessed' } })).status,
  'eligible',
  '低好感也不淘汰',
)

// 13. 重复候选 → 拒绝
eq(
  evaluateProactiveEligibility(base({ duplicateCandidate: true })).reasonCodes,
  ['duplicate-candidate'],
  '重复候选拒绝',
)

// 14. 多原因稳定顺序
const multi = evaluateProactiveEligibility(
  base({
    channel: { platform: 'qq', kind: 'private', status: 'degraded' },
    consent: { status: 'missing' },
    policy: { proactiveEnabled: false },
  }),
)
eq(
  multi.reasonCodes,
  ['channel-unavailable', 'no-consent', 'proactive-disabled'],
  '多原因按固定顺序累积',
)
eq(multi.status, 'rejected', '含拒绝原因时整体拒绝')

// 15. 确定性
eq(evaluateProactiveEligibility(base()), evaluateProactiveEligibility(base()), '同输入同输出')

// 16. 非法输入
throwsValidation(() => evaluateProactiveEligibility(base({ now: 'bad' })), '非法 now 拒绝')
throwsValidation(
  () => evaluateProactiveEligibility(base({ channel: { platform: 'qq', kind: 'private', status: 'nope' as never } })),
  '未知通道状态拒绝',
)
throwsValidation(
  () => evaluateProactiveEligibility(base({ relationship: { affinity: Number.NaN, trust: 'low' } })),
  '非法 affinity 拒绝',
)

console.log(`[P3-C proactive-eligibility] ${passed} 通过 0 失败`)
