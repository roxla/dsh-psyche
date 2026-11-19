// Mood Schema 测试（P3-A B1）：33 维定义、默认值、校验、归一化。
import assert from 'node:assert/strict'
import {
  MOOD_CONFIG_VERSION,
  MOOD_DIMENSIONS,
  MOOD_KEYS,
  MOOD_LAYER_RANK,
  MOOD_PERSONA_ID,
  defaultMoodValues,
  moodDimensionOf,
  normalizeMoodValues,
  validateMoodDefinition,
  validateMoodValues,
} from '../packages/core/dist/mood-schema.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}

check(MOOD_DIMENSIONS.length === 33, '33 个维度')
check(MOOD_KEYS.length === 33, '33 个 key')
check(new Set(MOOD_KEYS).size === 33, 'key 唯一')
check(MOOD_PERSONA_ID === 'main', 'persona 固定 main')
check(MOOD_CONFIG_VERSION >= 1, '配置版本 >= 1')
check(MOOD_LAYER_RANK.basic === 0 && MOOD_LAYER_RANK.compound === 1 && MOOD_LAYER_RANK.contemporary === 2, '三层顺序')

const layers = MOOD_DIMENSIONS.reduce<Record<string, number>>((acc, item) => {
  acc[item.layer] = (acc[item.layer] ?? 0) + 1
  return acc
}, {})
check(layers.basic === 11, '基础 11 维')
check(layers.compound === 18, '复合 18 维')
check(layers.contemporary === 4, '当代 4 维')

for (const item of MOOD_DIMENSIONS) {
  if (!(item.min === 0 && item.max === 100)) throw new Error(`${item.key} 量纲不是 0–100`)
  if (!(item.halfLifeMs > 0)) throw new Error(`${item.key} 半衰期 <= 0`)
  if (item.decayEnabled !== true) throw new Error(`${item.key} 未启用衰减`)
  if (typeof item.projection !== 'string' || item.projection.length === 0) throw new Error(`${item.key} 缺投影词`)
}
passed += 1

const defaults = defaultMoodValues()
check(Object.keys(defaults).length === 33, '默认值 33 个')
check(defaults.calm === 45, 'calm 默认 45')
check(defaults.hooked === 14, 'hooked 默认 14')
check(moodDimensionOf('calm')?.label === '平静', 'moodDimensionOf 命中')
check(moodDimensionOf('nope') === null, '未知维度返回 null')

// validateMoodValues：返回问题列表（空 = 通过）
check(validateMoodValues({ calm: 50, happy: 0 }).length === 0, '合法值通过')
check(validateMoodValues({ nope: 1 }).length === 1, '未知维度报问题')
check(validateMoodValues({ calm: Number.NaN }).length === 1, 'NaN 报问题')
check(validateMoodValues({ calm: -1 }).length === 1, '下界越界报问题')
check(validateMoodValues({ calm: 101 }).length === 1, '上界越界报问题')
check(validateMoodValues({}).length === 0, '空对象通过')

// normalizeMoodValues：缺失补 baseline，非法抛错
const normalized = normalizeMoodValues({ calm: 70 })
check(Object.keys(normalized).length === 33, 'normalize 补全 33 维')
check(normalized.calm === 70, 'normalize 保留显式值')
check(normalized.happy === 30, 'normalize 缺失补 baseline')

let normalizeThrew = false
try {
  normalizeMoodValues({ calm: 999 })
} catch {
  normalizeThrew = true
}
check(normalizeThrew, 'normalize 越界抛错')

// validateMoodDefinition：当前定义无问题
check(validateMoodDefinition().length === 0, '当前定义自洽')

console.log(`[P3-A B1 mood-schema] ${passed} 通过 0 失败`)
