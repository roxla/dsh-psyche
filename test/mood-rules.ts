// 情绪候选 Core 校验测试（P3-A B2）：规则表、维度/方向/上限、证据归属、整批拒绝。
import assert from 'node:assert/strict'
import {
  MOOD_RULES,
  MOOD_RULES_VERSION,
  describeMoodViolations,
  moodRuleOf,
  validateMoodCandidate,
} from '../packages/core/dist/mood-rules.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}

const ctx = { eventType: 'user_message' as const, allowedEvidenceIds: ['m1', 'm2'] }

function candidate(deltas: unknown[]): { deltas: unknown[] } {
  return { deltas }
}

function codeOf(result: { ok: boolean; violations?: Array<{ code: string }> }): string {
  return result.ok ? 'ok' : (result.violations?.[0]?.code ?? 'none')
}

// ---- 规则表 ----
check(MOOD_RULES.length === 4, '四种事件类型各一条规则')
check(MOOD_RULES_VERSION === 1, '规则表版本 v1')
check(moodRuleOf('user_message').allowedDimensions.length === 33, 'user_message 允许全部 33 维')
check(moodRuleOf('persona_action').allowedDimensions.length === 0, 'persona_action 暂无写入维度')
check(moodRuleOf('scheduled_event').allowedDimensions.length === 0, 'scheduled_event 暂无写入维度')
check(moodRuleOf('unknown').maxDelta === 0, 'unknown 不产生变化')
check(moodRuleOf('unknown').configVersion === MOOD_RULES_VERSION, '规则版本一致')
check(Object.isFrozen(MOOD_RULES), '规则表冻结')

// ---- 合法候选 ----
const ok = validateMoodCandidate(
  candidate([{ dimension: 'happy', delta: 3, evidenceMessageIds: ['m1'] }]),
  ctx,
)
check(ok.ok, '合法候选通过')
if (ok.ok) {
  check(ok.deltas.happy === 3, 'delta 原样保留')
  check(ok.evidence.happy?.join(',') === 'm1', '证据随维度返回')
}

const multi = validateMoodCandidate(
  candidate([
    { dimension: 'happy', delta: 2, evidenceMessageIds: ['m1'] },
    { dimension: 'calm', delta: -2, evidenceMessageIds: ['m2'] },
  ]),
  ctx,
)
check(multi.ok && multi.deltas.calm === -2, '多维度候选通过')

// ---- 维度 ----
check(
  codeOf(validateMoodCandidate(candidate([{ dimension: 'notAKey', delta: 1, evidenceMessageIds: ['m1'] }]), ctx)) ===
    'unknown-dimension',
  '未知维度拒绝',
)
check(
  codeOf(
    validateMoodCandidate(candidate([{ dimension: 'happy', delta: 1, evidenceMessageIds: ['m1'] }]), {
      eventType: 'unknown',
      allowedEvidenceIds: ['m1'],
    }),
  ) === 'dimension-not-allowed',
  '事件类型不允许该维度拒绝',
)

// ---- 数值 / 方向 / 上限 ----
check(
  codeOf(validateMoodCandidate(candidate([{ dimension: 'happy', delta: Number.NaN, evidenceMessageIds: ['m1'] }]), ctx)) ===
    'delta-not-finite',
  'NaN 拒绝',
)
check(
  codeOf(validateMoodCandidate(candidate([{ dimension: 'happy', delta: 0, evidenceMessageIds: ['m1'] }]), ctx)) ===
    'delta-not-finite',
  '零变化拒绝',
)
check(
  codeOf(validateMoodCandidate(candidate([{ dimension: 'happy', delta: 9, evidenceMessageIds: ['m1'] }]), ctx)) ===
    'delta-too-large',
  '超过规则 8 拒绝',
)
check(
  codeOf(
    validateMoodCandidate(candidate([{ dimension: 'happy', delta: 5, evidenceMessageIds: ['m1'] }]), {
      ...ctx,
      maxDelta: 4,
    }),
  ) === 'delta-too-large',
  '调用方更严上限生效',
)

// ---- 证据 ----
check(
  codeOf(validateMoodCandidate(candidate([{ dimension: 'happy', delta: 1, evidenceMessageIds: [] }]), ctx)) ===
    'evidence-missing',
  '缺证据拒绝',
)
check(
  codeOf(validateMoodCandidate(candidate([{ dimension: 'happy', delta: 1, evidenceMessageIds: ['m9'] }]), ctx)) ===
    'evidence-not-allowed',
  '证据不在本轮允许集合拒绝',
)
check(
  codeOf(validateMoodCandidate(candidate([{ dimension: 'happy', delta: 1, evidenceMessageIds: ['m1', 'm2'] }]), ctx)) ===
    'ok',
  '多条证据允许',
)

// ---- 结构与重复 ----
check(
  validateMoodCandidate(candidate([{ dimension: 'happy', delta: 0.5, evidenceMessageIds: ['m1'] }]), ctx).ok ===
    true,
  '0.5 是合法数值（限幅在别处）',
)
check(
  codeOf(
    validateMoodCandidate(
      candidate([
        { dimension: 'happy', delta: 1, evidenceMessageIds: ['m1'] },
        { dimension: 'happy', delta: 1, evidenceMessageIds: ['m2'] },
      ]),
      ctx,
    ),
  ) === 'duplicate-dimension',
  '同维重复整批拒绝',
)
check(
  codeOf(validateMoodCandidate({ deltas: [], initiator: 'user' } as never, ctx)) === 'forbidden-field',
  '顶层禁止字段拒绝',
)
check(
  codeOf(
    validateMoodCandidate(candidate([{ dimension: 'happy', delta: 1, evidenceMessageIds: ['m1'], opId: 'x' }]), ctx),
  ) === 'forbidden-field',
  '条目禁止字段拒绝',
)
check(
  codeOf(validateMoodCandidate({ deltas: 'x' } as never, ctx)) === 'candidate-shape',
  'deltas 非数组拒绝',
)
check(codeOf(validateMoodCandidate(candidate([]), ctx)) === 'empty-candidate', '空候选拒绝')
check(codeOf(validateMoodCandidate(null, ctx)) === 'candidate-shape', 'null 拒绝')

// ---- 版本 / 置信度 ----
check(
  codeOf(
    validateMoodCandidate(candidate([{ dimension: 'happy', delta: 1, evidenceMessageIds: ['m1'] }]), {
      ...ctx,
      configVersion: 2,
    }),
  ) === 'config-version-mismatch',
  '配置版本漂移整批拒绝',
)
check(
  codeOf(
    validateMoodCandidate(candidate([{ dimension: 'happy', delta: 1, evidenceMessageIds: ['m1'] }]), {
      ...ctx,
      confidence: 0.3,
    }),
  ) === 'confidence-too-low',
  '低置信整批拒绝',
)
check(
  validateMoodCandidate(candidate([{ dimension: 'happy', delta: 1, evidenceMessageIds: ['m1'] }]), {
    ...ctx,
    confidence: 0.8,
  }).ok === true,
  '高置信通过',
)

// ---- 整批拒绝：好维度 + 坏维度一起被拒 ----
const mixed = validateMoodCandidate(
  candidate([
    { dimension: 'happy', delta: 2, evidenceMessageIds: ['m1'] },
    { dimension: 'notAKey', delta: 1, evidenceMessageIds: ['m1'] },
  ]),
  ctx,
)
check(!mixed.ok, '含坏维度的候选整批拒绝')
check(mixed.ok === false && describeMoodViolations(mixed.violations).includes('unknown-dimension'), '违反项摘要可读')

console.log(`[P3-A B2 mood-rules] ${passed} 通过 0 失败`)
