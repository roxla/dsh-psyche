// deltas 计算测试（P3-A B2）：distress 硬线、关键词映射、maxDelta 截断、确定性与未知 key。
import assert from 'node:assert/strict'
import { MOOD_KEYS } from '../packages/core/dist/mood-schema.js'
import { distillMoodDistress, evaluateMoodDeltas } from '../packages/core/dist/mood-evaluator.js'

let passed = 0
function check(value: unknown, message: string): void {
  assert.ok(value, message)
  passed += 1
}
function has(deltas: Record<string, number>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(deltas, key)
}

// 空文本 / 无命中
check(Object.keys(evaluateMoodDeltas({ texts: [] }).deltas).length === 0, '空文本无 delta')
check(Object.keys(evaluateMoodDeltas({ texts: ['   ', ''] }).deltas).length === 0, '空白文本无 delta')
const noHit = evaluateMoodDeltas({ texts: ['abcxyz 123 456'] })
check(Object.keys(noHit.deltas).length === 0, '无命中无 delta')
check(noHit.signals.length === 0 && noHit.distress === false, '无命中不报信号')

// 正向 / 负向
const positive = evaluateMoodDeltas({ texts: ['谢谢，太好了，厉害'] })
check(positive.deltas.happy > 0, '正向词抬 happy')
check(has(positive.deltas, 'irritated') && positive.deltas.irritated < 0, '正向词压 irritated')
check(positive.signals.includes('positive'), 'positive 信号')

const frustrated = evaluateMoodDeltas({ texts: ['又报错，怎么还没好，到底怎么回事，慢死了，真烦'] })
check(frustrated.deltas.irritated > 0, '挫败抬 irritated')
check(frustrated.deltas.calm < 0, '挫败压 calm')
check(frustrated.signals.includes('frustrated'), 'frustrated 信号')

const question = evaluateMoodDeltas({ texts: ['这个怎么用？为什么不行？'] })
check(question.deltas.curious > 0, '问句抬 curious')

// distress 硬线：只留 sympathy / calm / down，其它信号全部丢弃
const distress = evaluateMoodDeltas({ texts: ['我真的撑不住了，谢谢你一直陪我，你真好'] })
check(distress.distress === true, 'distress 命中')
check(distress.signals.join(',') === 'distress', 'distress 丢弃其它信号')
check(distress.deltas.sympathy === 5, 'distress sympathy=5')
check(distress.deltas.calm === -3, 'distress calm=-3')
check(distress.deltas.down === 1, 'distress down=1')
check(Object.keys(distress.deltas).length === 3, 'distress 只留三项')
check(distillMoodDistress(['我真的想死']) === '想死', 'distill 命中词')
check(distillMoodDistress(['想死我了，你终于来了']) === null, '习语例外「想死我」不触发')
check(distillMoodDistress(['这需求想死了这']) === null, '习语例外「想死了这」不触发')

// maxDelta 截断：每维绝对值不超过配置值
const many = evaluateMoodDeltas({ texts: ['失败失败失败失败，又错了又错了又错了，搞不定搞不定'] })
for (const [key, value] of Object.entries(many.deltas)) {
  check(Math.abs(value) <= 8, `${key} 不超过默认 maxDelta=8`)
}
const tight = evaluateMoodDeltas({ texts: ['失败失败失败失败，又错了又错了又错了'], maxDelta: 2 })
for (const [key, value] of Object.entries(tight.deltas)) {
  check(Math.abs(value) <= 2, `${key} 不超过自定义 maxDelta=2`)
}

// 确定性
const first = evaluateMoodDeltas({ texts: ['有点累，但还行，谢谢你'] })
const second = evaluateMoodDeltas({ texts: ['有点累，但还行，谢谢你'] })
assert.deepEqual(first, second)
passed += 1

// 只写冻结维度
for (const key of Object.keys(many.deltas)) check(MOOD_KEYS.includes(key), `${key} 是冻结维度`)

// 长度规则
const longText = '今天把整个模块从头到尾又看了一遍，顺便把几个边界情况都补上了测试。'.repeat(4)
const longEval = evaluateMoodDeltas({ texts: [longText] })
check(longEval.deltas.focused === 1.2, '长文本加 focused')
check(longEval.deltas.tired === 0.3, '长文本加 tired')

// 多段拼接
const merged = evaluateMoodDeltas({ texts: ['好累', '想摆烂'] })
check(merged.textLength === 2 + 1 + 3, '多段用换行拼接计长度')

// 证据归属：命中文本的 id 跟随维度
const ev = evaluateMoodDeltas({ texts: ['谢谢你', '今天好累'], evidenceIds: ['m1', 'm2'] })
check(ev.evidence.happy?.includes('m1') === true, 'positive 证据指向第一条')
check(ev.evidence.gloomy?.includes('m2') === true, 'gloomy 证据指向第二条')

// distress：全部证据挂到三项
const dist = evaluateMoodDeltas({ texts: ['真的撑不住了'], evidenceIds: ['m9'] })
check(dist.distress === true && dist.evidence.sympathy?.join(',') === 'm9', 'distress 证据')

// 无证据 id：evidence 为空，不影响 deltas
const noId = evaluateMoodDeltas({ texts: ['谢谢你'] })
check(Object.keys(noId.evidence).length === 0, '无 id 不产生证据')

console.log(`[P3-A B2 mood-evaluator] ${passed} 通过 0 失败`)
