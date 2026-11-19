// B3-3 全维度单轮可达性审计（只读）。
// 用法：node tools/b3-3-reachability.mjs
// 结论：Δmin = 0.15 × max(1, 100 − baseline) 与 B2 单维单轮上限 maxDelta 比较。
import { MOOD_DIMENSIONS } from '../packages/core/dist/mood-schema.js'
import { MOOD_STRENGTH_THRESHOLD } from '../packages/core/dist/mood-projection.js'

const MAX_DELTA = 8 // B2 evaluator 每维 clamp ±maxDelta

const rows = MOOD_DIMENSIONS.map((d) => {
  const need = MOOD_STRENGTH_THRESHOLD * Math.max(1, 100 - d.baseline)
  return { key: d.key, layer: d.layer, baseline: d.baseline, need: Math.round(need * 100) / 100, ok: need <= MAX_DELTA }
})

console.log('| 维度 | 层 | baseline | Δmin（到 0.15） | 单轮可翻档 |')
console.log('| --- | --- | ---: | ---: | --- |')
for (const r of rows) console.log(`| ${r.key} | ${r.layer} | ${r.baseline} | ${r.need.toFixed(2)} | ${r.ok ? '是' : '否'} |`)
console.log(`\n总数 ${rows.length}；单轮可达 ${rows.filter((r) => r.ok).length}；最小 Δmin ${Math.min(...rows.map((r) => r.need))}；maxDelta ${MAX_DELTA}`)
