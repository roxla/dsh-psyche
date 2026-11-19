/**
 * 质量闸自检（D1-6）。
 *
 * 验的是三件事：
 * 1) 三档边界与扣分规则（60 / 30）；
 * 2) 极短内容的例外（约束/偏好类不被「过短」打死）；
 * 3) 质量分只给建议、不参与任何排序（这里只验纯函数，排序在 recall 侧不读它）。
 *
 * 跑法：`node test/quality.ts`（要求先 `npm run build`）
 */
import {
  QUALITY_SCORE_START,
  QUALITY_THRESHOLD_HIGH,
  QUALITY_THRESHOLD_MEDIUM,
  assessQuality,
  coreText,
  isWorthRemembering,
} from '../dist/lib/quality/rules.js'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
  }
}

function main(): void {
  // ── 1. 正常内容：高分 ────────────────────────────────────────────────────
  const normal = assessQuality('我最近在准备搬家，下个月中搬去杭州，可能得请两天假')
  check('正常长句是 high', normal.level === 'high', normal)
  check('正常长句没有信号', normal.signals.length === 0, normal.signals)
  check('起点分是 100', QUALITY_SCORE_START === 100)
  check('三档常量是 60 / 30', QUALITY_THRESHOLD_HIGH === 60 && QUALITY_THRESHOLD_MEDIUM === 30)

  // ── 2. 寒暄 / 元信息：扣 45 ─────────────────────────────────────────────
  const meta = assessQuality('好的')
  check('「好的」命中 meta', meta.signals.includes('meta'), meta.signals)
  check('「好的」分数 55 / medium', meta.score === 55 && meta.level === 'medium', meta)

  // ── 3. 纯噪声：去标点后为空 ─────────────────────────────────────────────
  const noise = assessQuality('！！！')
  check('纯标点命中 noise', noise.signals.includes('noise'), noise.signals)
  check('纯标点不判 high', noise.level !== 'high', noise)

  // ── 4. 自指：扣 15 ─────────────────────────────────────────────────────
  const self = assessQuality('作为一个语言模型，我不能确定明天会不会下雨')
  check('自指命中 self_reference', self.signals.includes('self_reference'), self.signals)

  // ── 5. 过短：扣 80 ─────────────────────────────────────────────────────
  const short = assessQuality('今天')
  check('两字命中 too_short', short.signals.includes('too_short'), short.signals)
  check('两字落到 low', short.level === 'low', short)

  // ── 6. 极短例外：约束/偏好类只扣 40 ────────────────────────────────────
  const preference = assessQuality('我不吃辣', { kind: 'preference' })
  check('偏好短句仍命中 too_short', preference.signals.includes('too_short'), preference.signals)
  check('偏好短句不落到 low', preference.level !== 'low', preference)
  const plainShort = assessQuality('我不吃辣')
  check('不给 kind 就按普通过短处理', plainShort.level === 'low', plainShort)

  // ── 7. 复读：连续同字 / 单字占比过高 ───────────────────────────────────
  const repeat = assessQuality('好好好好好好好好好好')
  check('复读命中 duplicate_chars', repeat.signals.includes('duplicate_chars'), repeat.signals)
  check('复读落到 low', repeat.level === 'low', repeat)

  // ── 8. 近重复：相似度由外部传入 ────────────────────────────────────────
  const duplicate = assessQuality('我最近在准备搬家，下个月中搬去杭州', { similarity: 0.92 })
  check('相似度 0.92 命中 near_duplicate', duplicate.signals.includes('near_duplicate'), duplicate.signals)
  check('近重复落到 low', duplicate.level === 'low', duplicate)

  // ── 9. 边界：分数钳在 0–100 ────────────────────────────────────────────
  const worst = assessQuality('好好好好好好好好好好好好', { similarity: 0.99 })
  check('多重扣分下限是 0', worst.score === 0, worst.score)
  check('最差也不会是负数', worst.score >= 0)

  // ── 10. 工具函数 ───────────────────────────────────────────────────────
  check('coreText 去标点', coreText('你好，世界！') === '你好世界')
  check('isWorthRemembering：high 可记', isWorthRemembering(normal))
  check('isWorthRemembering：low 不建议记', !isWorthRemembering(short))

  console.log('')
  console.log(`质量闸自检：${pass} 通过 ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
}

main()
