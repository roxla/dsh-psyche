// Mood 衰减测试（P3-A B1）：半衰期、回落 baseline、不越界、时钟回拨。
import assert from 'node:assert/strict'
import { clampMood, decayMoodValue, effectiveMoodValues } from '../packages/core/dist/mood-decay.js'
import { moodDimensionOf } from '../packages/core/dist/mood-schema.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}
function near(actual: number, expected: number, tolerance: number, message: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}（actual=${actual} expected=${expected}）`)
  passed += 1
}

check(clampMood(150) === 100, 'clamp 上界')
check(clampMood(-5) === 0, 'clamp 下界')
check(clampMood(Number.NaN) === 0, 'NaN 归到下界')
check(clampMood(50, 10, 90) === 50, '自定义范围')

const happy = moodDimensionOf('happy')
if (!happy) throw new Error('happy 维度缺失')
// happy: baseline 30, halfLife 4h
near(decayMoodValue('happy', 30, 4 * 3600_000), 30, 1e-9, '等于 baseline 时不动')
near(decayMoodValue('happy', 80, 0), 80, 1e-9, 'elapsed=0 原值')
near(decayMoodValue('happy', 80, 4 * 3600_000), 55, 1e-6, '一个半衰期：80→55')
near(decayMoodValue('happy', 80, 8 * 3600_000), 42.5, 1e-6, '两个半衰期：80→42.5')
near(decayMoodValue('happy', 10, 4 * 3600_000), 20, 1e-6, '低于 baseline：一个半衰期 10→20')
near(decayMoodValue('happy', 10, 8 * 3600_000), 25, 1e-6, '低于 baseline：两个半衰期 10→25')
check(decayMoodValue('happy', 10, 1000 * 3600_000) <= 30, '回升不过冲 baseline')
near(decayMoodValue('happy', 80, -1000), 80, 1e-9, '时钟回拨不算')

let threw = false
try {
  decayMoodValue('nope', 50, 1000)
} catch {
  threw = true
}
check(threw, '未知维度抛错')

// effectiveMoodValues：整体视角
const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString()
const now = Date.UTC(2026, 0, 1, 4, 0, 0)
const decayed = effectiveMoodValues({ happy: 80, calm: 45, nope: 99 }, updatedAt, { now })
near(decayed.happy, 55, 1e-6, 'effective 一个半衰期')
near(decayed.calm, 45, 1e-9, 'effective baseline 不动')
check(decayed.nope === undefined, 'effective 丢弃未知维度')

const noUpdate = effectiveMoodValues({ happy: 80 }, null, { now })
near(noUpdate.happy, 80, 1e-9, 'updatedAt 为空返回原值')

const future = effectiveMoodValues({ happy: 80 }, new Date(now + 3600_000).toISOString(), { now })
near(future.happy, 80, 1e-9, '记录时间晚于 now 返回原值')

const original = { happy: 80 }
effectiveMoodValues(original, updatedAt, { now })
check(original.happy === 80, 'effective 不修改入参')

console.log(`[P3-A B1 mood-decay] ${passed} 通过 0 失败`)
