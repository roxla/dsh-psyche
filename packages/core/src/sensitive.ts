/**
 * 敏感内容分类（E3 REM-ACL / E5.3 授权语义共用）。
 *
 * 这里只回答「这段话看起来像不像不该默认公开的东西」，不回答「能不能公开」。
 * 能不能公开由披露等级与授权流程决定：
 * - 分类：敏感内容默认 restricted；
 * - 授权：模型工具参数里的 `disclosure: 'public'` 只是分类请求，不是授权凭据。
 *
 * 两类规则：
 * 1. 高置信模式：身份证、银行卡、手机号、私钥/Token、病历、收入、住址——命中即敏感。
 * 2. 上下文模式：「密码/口令」单独出现不一定是敏感（「公开活动折扣口令」），
 *    只有当附近出现账号/登录/支付/银行/交易/系统/后台/验证码等凭据语境时才判敏感；
 *    窗口里同时出现「公开/活动/优惠/折扣/示例」等公开语境且没有凭据语境时，不判敏感。
 *
 * 宁可少放行，不可误放行；但也不把公开业务文案一律降级——过度保守会让安全默认失去意义。
 */

/** 高置信模式：命中即敏感。 */
const STRONG_PATTERNS: RegExp[] = [
  /\b\d{17}[\dXx]\b/, // 身份证号
  /\b\d{16,19}\b/, // 银行卡号
  /\b1[3-9]\d{9}\b/, // 手机号
  /(私钥|密钥|api[_\s-]?key|access[_\s-]?token|secret)/i,
  /(验证码|校验码|动态码)/,
  /(病历|诊断|处方|用药|病史|medical)/i,
  /(工资|薪资|收入|存款|余额)/,
  /(住址|家庭地址|身份证号|护照号)/,
]

/** 需要看上下文的词。 */
const CREDENTIAL_TERM = /(密码|口令)/

/** 凭据语境词：说明「密码/口令」是账号或支付凭据。 */
const CREDENTIAL_CONTEXT = /(账号|帐号|登录|登陆|支付|银行|交易|系统|后台|管理|私钥|密钥|验证码|认证|绑定)/

/** 公开语境词：说明「密码/口令」只是公开活动文案。 */
const PUBLIC_CONTEXT = /(公开|活动|优惠|折扣|兑换|促销|宣传|示例|样例|格式|规则)/

/** 「密码/口令」按附近窗口判断，避免「公开活动折扣口令」被误判。 */
function credentialLooksSensitive(text: string): boolean {
  const matches = [...text.matchAll(new RegExp(CREDENTIAL_TERM, 'gu'))]
  if (matches.length === 0) return false
  return matches.some((match) => {
    const index = match.index ?? 0
    const start = Math.max(0, index - 12)
    const end = Math.min(text.length, index + match[0].length + 12)
    const window = text.slice(start, end)
    const hasCredential = CREDENTIAL_CONTEXT.test(window)
    const hasPublic = PUBLIC_CONTEXT.test(window)
    if (hasCredential) return true
    if (hasPublic) return false
    // 没有任何语境线索时保守：默认敏感（口令本身就不该默认公开）。
    return true
  })
}

/** 一句话里有没有「明显不该默认公开」的东西。 */
export function looksSensitive(statement: unknown): boolean {
  const text = String(statement ?? '')
  if (STRONG_PATTERNS.some((pattern) => pattern.test(text))) return true
  return credentialLooksSensitive(text)
}

/**
 * 显式 public 什么时候需要授权凭据：
 * 只有「敏感内容 + 请求 public」这一种组合需要；普通内容不需要，restricted/secret 也不需要。
 */
export function requiresDisclosureGrant(disclosure: string, statement: unknown): boolean {
  return disclosure === 'public' && looksSensitive(statement)
}
