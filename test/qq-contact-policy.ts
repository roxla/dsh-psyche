/**
 * P4-B-3-1：QQ 私聊联系人策略的解析、判定与滚动限频。
 * 纯模块测试；不含 QQ Bridge 集成与 Host 验收。
 */
import { strict as assert } from 'node:assert'
import {
  ContactRateLimiter,
  QQ_CONTACT_MAX_ENTRIES,
  decideQqContact,
  inSilenceWindow,
  localMinuteOfDay,
  parseQqContactPolicies,
} from '../dist/lib/qq-contact-policy.js'

let passed = 0
function eq(label: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, label)
  passed += 1
}
function ok(label: string, value: unknown): void {
  assert.ok(value, label)
  passed += 1
}

const t0 = Date.UTC(2026, 0, 1, 22, 0, 0)

// A. 解析基础
{
  const empty = parseQqContactPolicies(undefined)
  eq('A1 undefined → ok 空表', empty.kind === 'ok' && empty.entries.size === 0, true)

  const parsed = parseQqContactPolicies([{
    stableUserId: '10001',
    enabled: false,
    silence: { timezone: 'Asia/Shanghai', windows: ['22:00-07:00', '12:00-13:00'] },
    maxPerHour: 5,
  }])
  ok('A2 合法条目', parsed.kind === 'ok')
  if (parsed.kind === 'ok') {
    const policy = parsed.entries.get('10001')
    eq('A3 默认 platform', policy?.platform, 'qq')
    eq('A4 enabled', policy?.enabled, false)
    eq('A5 maxPerHour', policy?.maxPerHour, 5)
    eq('A6 窗口数', policy?.silence?.windows.length, 2)
    eq('A7 无 denied', parsed.denied.size, 0)
  }

  const defaults = parseQqContactPolicies([{ stableUserId: '10002', platform: 'qq' }])
  ok('A8 platform qq 合法', defaults.kind === 'ok')
  if (defaults.kind === 'ok') eq('A9 enabled 缺省 true', defaults.entries.get('10002')?.enabled, true)
}

// B. 整份配置失败关闭
{
  eq('B1 非数组', (parseQqContactPolicies({}) as { kind: string }).kind, 'blocked')
  eq('B2 null', (parseQqContactPolicies(null) as { kind: string }).kind, 'blocked')
  const many = Array.from({ length: QQ_CONTACT_MAX_ENTRIES + 1 }, (_, index) => ({ stableUserId: String(10000 + index) }))
  eq('B3 超过 200 条', (parseQqContactPolicies(many) as { kind: string }).kind, 'blocked')
  eq('B4 非对象条目', (parseQqContactPolicies(['10001']) as { kind: string }).kind, 'blocked')
  for (const bad of ['', '010001', 'abc', '1'.repeat(21), 10001]) {
    eq(`B5 非法身份 ${String(bad)}`, (parseQqContactPolicies([{ stableUserId: bad }]) as { kind: string }).kind, 'blocked')
  }
  const mixed = parseQqContactPolicies([{ stableUserId: '10001' }, { stableUserId: 'bad' }])
  eq('B6 一条非法身份使整份 blocked', mixed.kind, 'blocked')
}

// C. 单条字段非法 → 该 Contact 明确 deny
{
  const cases: Array<Record<string, unknown>> = [
    { stableUserId: '20001', unknownField: true },
    { stableUserId: '20001', platform: 'telegram' },
    { stableUserId: '20001', enabled: 'yes' },
    { stableUserId: '20001', maxPerHour: 0 },
    { stableUserId: '20001', maxPerHour: 241 },
    { stableUserId: '20001', maxPerHour: 1.5 },
    { stableUserId: '20001', silence: { timezone: 'Mars/Olympus', windows: ['22:00-07:00'] } },
    { stableUserId: '20001', silence: { timezone: 'UTC', windows: [] } },
    { stableUserId: '20001', silence: { timezone: 'UTC', windows: ['25:00-07:00'] } },
    { stableUserId: '20001', silence: { timezone: 'UTC', windows: ['07:00-07:00'] } },
    { stableUserId: '20001', silence: { timezone: 'UTC', windows: ['22:00-07:00', '07:00-07:00'] } },
  ]
  for (const entry of cases) {
    const parsed = parseQqContactPolicies([entry])
    ok(`C 非法字段 ${JSON.stringify(entry)} not blocked`, parsed.kind === 'ok')
    if (parsed.kind === 'ok') {
      eq(`C deny ${JSON.stringify(entry)}`, parsed.denied.get('20001'), 'CONTACT_POLICY_INVALID')
      eq(`C no entry ${JSON.stringify(entry)}`, parsed.entries.has('20001'), false)
    }
  }
}

// D. 重复身份必须显式 deny，不能回退默认允许
{
  const parsed = parseQqContactPolicies([
    { stableUserId: '30001', enabled: true },
    { stableUserId: '30001', enabled: false },
    { stableUserId: '30002' },
  ])
  ok('D1 重复不使整份 blocked', parsed.kind === 'ok')
  if (parsed.kind === 'ok') {
    eq('D2 重复身份不进入 entries', parsed.entries.has('30001'), false)
    eq('D3 重复身份 denied', parsed.denied.get('30001'), 'CONTACT_POLICY_INVALID')
    eq('D4 其他身份正常', parsed.entries.get('30002')?.enabled, true)
    const decision = decideQqContact(parsed, '30001', t0, new ContactRateLimiter())
    eq('D5 重复身份判定拒绝', decision, { action: 'deny', reason: 'CONTACT_POLICY_INVALID' })
  }
}

// E. 判定顺序
{
  const blocked = decideQqContact({ kind: 'blocked', reason: 'x' }, '10001', t0, new ContactRateLimiter())
  eq('E1 blocked → POLICY_UNAVAILABLE', blocked, { action: 'deny', reason: 'CONTACT_POLICY_UNAVAILABLE' })

  const empty = parseQqContactPolicies([])
  eq('E2 无配置 → allow（B-2 行为）', decideQqContact(empty, '10001', t0, new ContactRateLimiter()), { action: 'allow' })

  const disabled = parseQqContactPolicies([{ stableUserId: '10001', enabled: false }])
  eq('E3 disabled → CONTACT_DISABLED', decideQqContact(disabled, '10001', t0, new ContactRateLimiter()), { action: 'deny', reason: 'CONTACT_DISABLED' })

  const both = parseQqContactPolicies([{
    stableUserId: '10001',
    enabled: false,
    silence: { timezone: 'UTC', windows: ['00:00-23:59'] },
    maxPerHour: 1,
  }])
  eq('E4 disabled 优先于 silence', decideQqContact(both, '10001', t0, new ContactRateLimiter()), { action: 'deny', reason: 'CONTACT_DISABLED' })
}

// F. 静默窗口与 DST
{
  eq('F1 起点包含', inSilenceWindow([{ start: 22 * 60, end: 7 * 60 }], 22 * 60), true)
  eq('F2 终点不包含', inSilenceWindow([{ start: 22 * 60, end: 7 * 60 }], 7 * 60), false)
  eq('F3 跨午夜内', inSilenceWindow([{ start: 22 * 60, end: 7 * 60 }], 3 * 60), true)
  eq('F4 白天不在', inSilenceWindow([{ start: 22 * 60, end: 7 * 60 }], 12 * 60), false)

  const silence = parseQqContactPolicies([{
    stableUserId: '40001',
    silence: { timezone: 'UTC', windows: ['22:00-07:00'] },
  }])
  eq('F5 22:00 拒绝', decideQqContact(silence, '40001', Date.UTC(2026, 0, 1, 22, 0), new ContactRateLimiter()), { action: 'deny', reason: 'CONTACT_SILENCE' })
  eq('F6 07:00 放行', decideQqContact(silence, '40001', Date.UTC(2026, 0, 1, 7, 0), new ContactRateLimiter()), { action: 'allow' })

  const winter = localMinuteOfDay(Date.UTC(2026, 0, 15, 12, 0), 'America/New_York')
  const summer = localMinuteOfDay(Date.UTC(2026, 6, 15, 12, 0), 'America/New_York')
  ok('F7 DST 按实际本地时间（冬夏不同）', winter !== summer)
}

// G. 滚动限频与原子占用
{
  const limiter = new ContactRateLimiter()
  eq('G1 第一次占用', limiter.reserve('50001', 2, t0), true)
  eq('G2 第二次占用', limiter.reserve('50001', 2, t0 + 1000), true)
  eq('G3 第三次拒绝', limiter.reserve('50001', 2, t0 + 2000), false)
  eq('G4 窗口内计数', limiter.count('50001', t0 + 3000), 2)
  eq('G5 滑出窗口恢复', limiter.reserve('50001', 2, t0 + 60 * 60 * 1000), true)

  const last = new ContactRateLimiter()
  eq('G6 并发最后额度只成功一条', [last.reserve('50002', 1, t0), last.reserve('50002', 1, t0)], [true, false])

  const capped = parseQqContactPolicies([{ stableUserId: '50003', maxPerHour: 1 }])
  const cappedLimiter = new ContactRateLimiter()
  eq('G7 策略放行占用额度', decideQqContact(capped, '50003', t0, cappedLimiter), { action: 'allow' })
  eq('G8 第二条达上限', decideQqContact(capped, '50003', t0 + 1, cappedLimiter), { action: 'deny', reason: 'CONTACT_RATE_LIMIT' })
  eq('G9 被抑制不占额度', cappedLimiter.count('50003', t0 + 2), 1)
}

// H. 账号隔离
{
  const limiter = new ContactRateLimiter()
  const policies = parseQqContactPolicies([
    { stableUserId: '60001', maxPerHour: 1 },
    { stableUserId: '60002', maxPerHour: 1 },
  ])
  eq('H1 A 占用', decideQqContact(policies, '60001', t0, limiter), { action: 'allow' })
  eq('H2 A 达上限', decideQqContact(policies, '60001', t0 + 1, limiter), { action: 'deny', reason: 'CONTACT_RATE_LIMIT' })
  eq('H3 B 不受影响', decideQqContact(policies, '60002', t0 + 2, limiter), { action: 'allow' })
}

process.stdout.write(`[P4-B-3-1 qq-contact-policy] ${passed} 通过 0 失败\n`)
