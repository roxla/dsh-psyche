// E5.3 敏感规则正反例：衡量「漏判」（该拦没拦）与「误判」（不该拦却拦）。
//
// 背景：FTS 测试夹具曾因「折扣口令是满 100 减 20%」被整条降级为 restricted 而失败。
// 这说明闸门在生效，但不能说明分类正确——「公开活动折扣口令」不是账号凭据。
// 本套件不测数据库，只测分类函数本身。
//
// 跑法：node test/sensitive.ts（需要先 npm run build）
import { looksSensitive, requiresDisclosureGrant } from '../dist/lib/sensitive.js'

let passed = 0
let failed = 0

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

const sensitive = (label, text) => ok(label, looksSensitive(text), text)
const notSensitive = (label, text) => ok(label, !looksSensitive(text), text)

// ── 1. 高置信：必须拦住（漏判 = 0） ─────────────────────────────────────────
sensitive('身份证号', '她的身份证号是 110101199003071234。')
sensitive('银行卡号', '工资卡号 6222020200112233445，别泄露。')
sensitive('手机号', '联系她可以打 13812345678。')
sensitive('API Token', '接口用的 access_token 是 sk-live-abc123。')
sensitive('私钥', '把私钥放在本地，不要进仓库。')
sensitive('病历', '病历上写着她对青霉素过敏。')
sensitive('工资', '这个月工资 18000，别对别人说。')
sensitive('家庭住址', '家庭地址在朝阳区某小区 3 号楼。')

// ── 2. 上下文依赖：凭据语境 → 敏感 ──────────────────────────────────────────
sensitive('账号登录口令', '账号登录口令是 Xy9#2026')
sensitive('银行卡支付密码', '银行卡支付密码别记在聊天里')
sensitive('管理系统后台密码', '管理系统后台密码每月轮换')
sensitive('绑定验证码', '绑定账号的验证码是一次性的')

// ── 3. 公开语境：不应误判 ───────────────────────────────────────────────────
notSensitive('公开活动折扣口令', '公开活动折扣口令是 SPRING2026，可以直接发给客户。')
notSensitive('示例口令格式', '示例口令格式：ABC-123，仅用于说明。')
notSensitive('促销兑换规则', '促销兑换规则：下单时输入活动口令。')
notSensitive('普通偏好', '她喜欢在下午散步。')
notSensitive('金额与折扣', '活动规则是满 100 减 20%。')
notSensitive('目录结构', '这本书的目录结构分三部分。')

// ── 4. 默认保守：没有语境线索时按敏感处理 ───────────────────────────────────
sensitive('无语境的口令', '口令是蓝色的那个。')

// ── 5. requiresDisclosureGrant 组合 ────────────────────────────────────────
ok('public + 敏感 → 需要授权', requiresDisclosureGrant('public', '账号登录口令是 Xy9#2026'))
ok('public + 普通 → 不需要授权', !requiresDisclosureGrant('public', '她喜欢在下午散步。'))
ok('restricted + 敏感 → 不需要（本来就不公开）', !requiresDisclosureGrant('restricted', '工资 18000'))
ok('secret + 敏感 → 不需要', !requiresDisclosureGrant('secret', '身份证号 110101199003071234'))

console.log(`\n[SENSITIVE] 敏感规则正反例：${passed} 通过 ${failed} 失败`)
if (failed > 0) process.exitCode = 1
