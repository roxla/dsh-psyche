/**
 * P2：成长候选文本质量闸。
 *
 * 跑法：`node test/growth-candidate-filter.ts`（要求先 `npm run build`）。
 */
import { isGrowthCandidateWorthy } from '../dist/lib/growth.js'

let pass = 0
let fail = 0

function check(name: string, ok: boolean): void {
  if (ok) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}`)
  }
}

const accept: Array<[string, 'new_fact' | 'revise_stance' | 'new_habit' | 'identity_growth']> = [
  ['我喜欢在晚上写代码。', 'new_habit'],
  ['我习惯周五晚上打游戏。', 'new_habit'],
  ['我答应周末陪她去看牙。', 'revise_stance'],
  ['我决定以后少熬夜。', 'revise_stance'],
  ['用户的名字是小林。', 'new_fact'],
  ['她的生日是十一月十一日。', 'new_fact'],
]

const reject: Array<[string, 'new_fact' | 'revise_stance' | 'new_habit' | 'identity_growth']> = [
  ['', 'new_fact'],
  ['。', 'new_fact'],
  ['按功能模块来说。', 'new_fact'],
  ['总的来说', 'new_habit'],
  ['先跑测试。', 'new_fact'],
  ['改一下这里。', 'new_fact'],
  ['好的。', 'new_habit'],
  ['功能 模块 接口', 'new_fact'],
  ['啊', 'new_fact'],
]

for (const [text, type] of accept) check(`接受：${text || '(空)'}`, isGrowthCandidateWorthy(text, type))
for (const [text, type] of reject) check(`拒绝：${text || '(空)'}`, !isGrowthCandidateWorthy(text, type))

check('拒绝超长 statement', !isGrowthCandidateWorthy('我'.repeat(600), 'new_fact'))
check('接受带第一人称的短偏好', isGrowthCandidateWorthy('我爱喝茶。', 'new_habit'))

console.log(`\nP2 成长候选过滤：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
