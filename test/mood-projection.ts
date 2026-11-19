// 语气投影专测（P3-A B3-1）：正向偏离、阈值、去重、排序、兼容白名单、中性回退、纯函数边界。
import assert from 'node:assert/strict'
import { MOOD_DIMENSIONS, defaultMoodValues } from '../packages/core/dist/mood-schema.js'
import {
  MOOD_COMPATIBLE_TONE_PAIRS,
  MOOD_NEUTRAL_TONE,
  MOOD_PROJECTION_VERSION,
  projectMoodTone,
} from '../packages/core/dist/mood-projection.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}

function values(overrides: Record<string, number> = {}): Record<string, number> {
  return { ...defaultMoodValues(), ...overrides }
}

/** 取能产生指定 strength 的数值（用于构造边界）。 */
function at(key: string, strength: number): number {
  const dimension = MOOD_DIMENSIONS.find((item) => item.key === key)
  assert.ok(dimension, `unknown dimension ${key}`)
  return dimension.baseline + strength * Math.max(1, 100 - dimension.baseline)
}

function throwsValidation(run: () => unknown, label: string): void {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  check(
    caught instanceof Error && (caught as { code?: string }).code === 'E_VALIDATION',
    label,
  )
}

const LABEL_TO_KEY = new Map<string, string>()
for (const dimension of MOOD_DIMENSIONS) {
  if (!LABEL_TO_KEY.has(dimension.projection)) LABEL_TO_KEY.set(dimension.projection, dimension.key)
}
function dimOf(label: string): string {
  const key = LABEL_TO_KEY.get(label)
  assert.ok(key, `未知语气标签 ${label}`)
  return key
}

// ---- 中性回退 ----
const baseline = projectMoodTone(values())
check(baseline.tone === MOOD_NEUTRAL_TONE, '全部等于 baseline → 平稳')
check(baseline.neutral === true, 'neutral=true')
check(baseline.secondary === null, '无辅助语气')
check(baseline.projectionVersion === MOOD_PROJECTION_VERSION, '投影版本固定')

const allBelow = values(
  Object.fromEntries(MOOD_DIMENSIONS.map((item) => [item.key, Math.max(0, item.baseline - 1)])),
)
check(projectMoodTone(allBelow).neutral === true, '全部低于 baseline → 平稳')

check(projectMoodTone(values({ fear: 0 })).neutral === true, 'fear=0 不产生「谨慎」')
check(projectMoodTone(values({ tired: 0 })).neutral === true, 'tired=0 不产生「略疲惫」')
check(projectMoodTone(values({ happy: 0 })).neutral === true, 'happy=0 不产生「轻快」')
check(projectMoodTone(values({ calm: 0 })).neutral === true, 'calm=0 不产生额外语气')

// ---- 阈值：0.149 排除 / 0.150 纳入 / 0.151 纳入 ----
check(projectMoodTone(values({ happy: at('happy', 0.149) })).neutral === true, '0.149 排除')
check(projectMoodTone(values({ happy: at('happy', 0.15) })).tone === '轻快', '0.150 纳入')
check(projectMoodTone(values({ happy: at('happy', 0.151) })).tone === '轻快', '0.151 纳入')
check(projectMoodTone(values({ happy: 29.9 })).neutral === true, '低于 baseline 不投影')
check(projectMoodTone(values({ happy: 30 })).neutral === true, '等于 baseline 不投影')

// ---- 主语气与上限 ----
const only = projectMoodTone(values({ happy: at('happy', 0.5) }))
check(only.tone === '轻快', '单候选为主语气')
check(only.secondary === null, '单候选无辅助')
check(only.neutral === false, '有候选时 neutral=false')

// ---- blendGap：0.099 允许 / 0.100 不允许 ----
const blendBelow = projectMoodTone(
  values({ happy: at('happy', 0.5), curious: at('curious', 0.4005) }),
)
check(blendBelow.tone === '轻快' && blendBelow.secondary === '好奇', '差 0.0995 且在白名单 → 允许辅助')

const blendAt = projectMoodTone(values({ happy: at('happy', 0.5), curious: at('curious', 0.4) }))
check(blendAt.tone === '轻快' && blendAt.secondary === null, '差 0.100 → 不允许辅助')

const blendFar = projectMoodTone(values({ happy: at('happy', 0.5), curious: at('curious', 0.35) }))
check(blendFar.secondary === null, '差 0.150 → 不允许辅助')

// ---- blendGap 数值安全边界：0.099999998 允许 / 0.099999999 与 0.100000000 不允许 ----
const blendSafetyBelow = projectMoodTone(
  values({ happy: at('happy', 0.5), curious: at('curious', 0.4 + 2e-9) }),
)
check(blendSafetyBelow.secondary === '好奇', '差 0.099999998（比 0.10 小 2e-9）→ 允许辅助')

const blendSafetyEdge = projectMoodTone(
  values({ happy: at('happy', 0.5), curious: at('curious', 0.4 + 1e-9) }),
)
check(blendSafetyEdge.secondary === null, '差 0.099999999（比 0.10 小 1e-9）→ 落入安全边界，不辅助')

const blendSafetyExact = projectMoodTone(
  values({ happy: at('happy', 0.5), curious: at('curious', 0.4) }),
)
check(blendSafetyExact.secondary === null, '差 0.100000000 → 不允许辅助')

// ---- strength 整数桶：全序排序（桶内按层级、桶间按桶）----
const sameBucket = projectMoodTone(
  values({ happy: at('happy', 0.5), proud: at('proud', 0.5 + 4e-10) }),
)
check(sameBucket.tone === '轻快', '相差 0.4e-9 → 同一整数桶，按 basic 层级取「轻快」而非「得意」')

const crossBucket = projectMoodTone(
  values({ happy: at('happy', 0.5), proud: at('proud', 0.5 + 4e-9) }),
)
check(crossBucket.tone === '得意', '相差 4e-9 → 跨桶，较高桶优先于层级（compound 胜 basic）')

// ---- 兼容白名单：19 对正反双向 ----
for (const [left, right] of MOOD_COMPATIBLE_TONE_PAIRS) {
  const leftKey = dimOf(left)
  const rightKey = dimOf(right)
  const forward = projectMoodTone(
    values({ [leftKey]: at(leftKey, 0.5), [rightKey]: at(rightKey, 0.45) }),
  )
  check(forward.tone === left && forward.secondary === right, `${left} + ${right} 正向融合`)
  const reverse = projectMoodTone(
    values({ [leftKey]: at(leftKey, 0.45), [rightKey]: at(rightKey, 0.5) }),
  )
  check(reverse.tone === right && reverse.secondary === left, `${right} + ${left} 反向融合`)
}

// ---- 明确不兼容 + 未列入默认拒绝 ----
const rejected: Array<[string, string]> = [
  ['黏一点', '疏离'],
  ['疏离', '黏一点'],
  ['低沉', '雀跃'],
  ['克制', '撒娇'],
  ['温柔', '试探'],
  ['谨慎', '兴奋'],
  ['轻快', '低缓'],
]
for (const [left, right] of rejected) {
  const leftKey = dimOf(left)
  const rightKey = dimOf(right)
  const result = projectMoodTone(
    values({ [leftKey]: at(leftKey, 0.5), [rightKey]: at(rightKey, 0.45) }),
  )
  check(result.tone === left && result.secondary === null, `${left} + ${right} 不融合`)
}

// ---- 同标签去重 ----
const duplicate = projectMoodTone(
  values({ excited: at('excited', 0.6), flutter: at('flutter', 0.55) }),
)
check(duplicate.tone === '雀跃' && duplicate.secondary === null, '同标签不重复输出')

const afterDedupe = projectMoodTone(
  values({
    excited: at('excited', 0.6),
    flutter: at('flutter', 0.55),
    happy: at('happy', 0.58),
  }),
)
check(afterDedupe.tone === '雀跃' && afterDedupe.secondary === '轻快', '去重后新的第二名参与辅助判断')

const noThird = projectMoodTone(
  values({
    lonely: at('lonely', 0.6),
    disgust: at('disgust', 0.59),
    breakdown: at('breakdown', 0.55),
  }),
)
check(noThird.tone === '黏一点' && noThird.secondary === null, '第二候选不兼容时不找第三名补位')

// ---- 平手：层级 → key ----
const layerTie = projectMoodTone(values({ curious: at('curious', 0.5), lonely: at('lonely', 0.5) }))
check(layerTie.tone === '好奇', '同强度时基础层优先于复合层')

const keyTie = projectMoodTone(values({ focused: at('focused', 0.5), happy: at('happy', 0.5) }))
check(keyTie.tone === '专注', '同层同强度按 key 字典序')

const keyTie2 = projectMoodTone(values({ curious: at('curious', 0.5), focused: at('focused', 0.5) }))
check(keyTie2.tone === '好奇', 'curious 先于 focused')

// ---- 极值不改变用词 ----
const high = projectMoodTone(values({ happy: 100 }))
const nearHigh = projectMoodTone(values({ happy: 99 }))
check(high.tone === '轻快' && nearHigh.tone === '轻快', '极值不改变主语气')
check(high.secondary === nearHigh.secondary, '极值不改变辅助语气')

// ---- 输出形状与不泄漏 ----
check(
  JSON.stringify(Object.keys(only).sort()) ===
    JSON.stringify(['neutral', 'projectionVersion', 'secondary', 'tone']),
  '输出字段固定',
)
check(!JSON.stringify(only).includes('happy'), '输出不含维度 key')
check(!JSON.stringify(only).includes('0.5'), '输出不含强度数值')
check(Object.isFrozen(only), '输出不可变')

// ---- 确定性 ----
const input = values({ happy: at('happy', 0.5), curious: at('curious', 0.45) })
assert.deepEqual(projectMoodTone(input), projectMoodTone(input))
passed += 1

// ---- 非法输入：明确失败，不静默转 0 ----
throwsValidation(() => projectMoodTone(null as never), 'null 输入明确失败')
throwsValidation(() => projectMoodTone([] as never), '数组输入明确失败')
throwsValidation(() => projectMoodTone(values({ bogus: 50 })), '未知维度明确失败')
throwsValidation(() => {
  const missing: Record<string, number> = values()
  delete missing.calm
  return projectMoodTone(missing)
}, '缺少维度明确失败')
throwsValidation(() => projectMoodTone(values({ happy: Number.NaN })), 'NaN 明确失败')
throwsValidation(() => projectMoodTone(values({ happy: Number.POSITIVE_INFINITY })), 'Infinity 明确失败')
throwsValidation(
  () => projectMoodTone(values({ happy: '40' as unknown as number })),
  '字符串数值明确失败',
)
throwsValidation(() => projectMoodTone(values({ happy: 120 })), '超过上限明确失败')
throwsValidation(() => projectMoodTone(values({ happy: -1 })), '低于下限明确失败')

console.log(`[P3-A B3 mood-projection] ${passed} 通过 0 失败`)
