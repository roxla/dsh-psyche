/**
 * D1-7 准入策略自检：只给判定、不拦写入。
 *
 * 跑法：node test/admission.ts（零依赖，失败退出码 1）。
 */
import { decideAdmission, ADMISSION_POLICY_VERSION } from '../dist/lib/admission/index.js'
import { assessQuality } from '../dist/lib/quality/index.js'

let passed = 0
let failed = 0

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label} → ${JSON.stringify(detail)}`)
  }
}

console.log('准入策略自检')

const good = assessQuality('阿岚说她周五晚上一般都在打游戏，周末基本不安排别的事。')
const weak = assessQuality('今天')
const hello = assessQuality('好的')

ok('高质量 → accept', decideAdmission({ quality: good, text: 'x' }).decision === 'accept')
ok('中等质量（寒暄）→ accept', decideAdmission({ quality: hello, text: '好的' }).decision === 'accept')
ok('低质量 → observe（不拦）', decideAdmission({ quality: weak, text: '今天' }).decision === 'observe')

const key = decideAdmission({ quality: good, text: '这是我的 key：sk-1234567890abcdefghij' })
ok('密钥形态 → deny', key.decision === 'deny', key)
ok('密钥判定优先于质量分', decideAdmission({ quality: weak, text: 'sk-1234567890abcdefghij' }).decision === 'deny')

ok(
  '私钥块 → deny',
  decideAdmission({ quality: good, text: '-----BEGIN RSA PRIVATE KEY-----\nAAAA' }).decision === 'deny',
)
ok('18 位身份证形态 → deny', decideAdmission({ quality: good, text: '身份证 110101199003071234' }).decision === 'deny')
ok('普通数字不误判', decideAdmission({ quality: good, text: '今天跑了 3 公里，配速 6 分。' }).decision === 'accept')

ok('策略版本是 1.0.0', ADMISSION_POLICY_VERSION === '1.0.0', ADMISSION_POLICY_VERSION)
ok('判定带版本号', key.policyVersion === ADMISSION_POLICY_VERSION)
ok('判定带人话理由', key.reason.length > 0 && key.reason.includes('密钥'))

console.log(`\n准入策略自检：${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
