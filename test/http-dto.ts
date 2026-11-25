// P4-A-5 安全整改：HTTP 出口 DTO（模块级）。
//
// 覆盖：
// 1. 路径脱敏与末段展示；
// 2. 用户 ID 掩码；
// 3. 500 错误体（已知 code 保留、未知异常泛化、绝无 stack）；
// 4. 状态视图（去 file、去 stack、attempts.reason 打码）；
// 5. 面板视图（显式字段、联系人掩码、settings 路径打码）。
//
// 跑法：npm run build && node test/http-dto.ts
import { PsycheError } from '../dist/lib/errors.js'
import {
  HTTP_GENERIC_ERROR_MESSAGE,
  httpErrorBody,
  maskStableUserId,
  pathLabel,
  redactAbsolutePaths,
  safeErrorPayload,
  storageView,
  toPanelView,
  toStatusView,
} from '../dist/lib/http-dto.js'

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

function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(label, same, same ? undefined : { actual, expected })
}

// A 路径脱敏
eq('A1 Windows 路径换成 <path>', redactAbsolutePaths('打开 D:\\project\\psyche\\data 失败'), '打开 <path> 失败')
eq('A2 POSIX 路径换成 <path>', redactAbsolutePaths('cannot open /home/roxla/.dsh/x.db'), 'cannot open <path>')
eq('A3 普通文本不变', redactAbsolutePaths('数据库还没准备好'), '数据库还没准备好')
eq('A4 末段展示', pathLabel('D:\\project\\psyche\\.tmp-p4a4-data'), '.tmp-p4a4-data')
eq('A5 空路径返回空串', pathLabel(''), '')

// B 用户 ID 掩码
eq('B1 5 位 ID 全掩码', maskStableUserId('10001'), '*****')
eq('B2 长 ID 保前缀后缀', maskStableUserId('desktop-user-abcdef'), 'des****ef')
eq('B3 空 ID 返回空串', maskStableUserId(''), '')

// C 500 错误体
const known = httpErrorBody(new PsycheError('E_VALIDATION', '参数 D:\\secret\\x 不合法'))
eq('C1 已知错误保留 code', known.error.code, 'E_VALIDATION')
eq('C2 已知错误路径打码', known.error.message, '参数 <path> 不合法')
const boom = new Error('SQLITE_CANTOPEN: D:\\secret\\db.sqlite3')
boom.stack = 'Error: boom\n    at D:\\secret\\db.sqlite3:1:1'
const generic = httpErrorBody(boom)
eq('C3 未知异常统一 INTERNAL_ERROR', generic.error.code, 'INTERNAL_ERROR')
eq('C4 未知异常只给普通说明', generic.error.message, HTTP_GENERIC_ERROR_MESSAGE)
ok('C5 响应体没有 stack', !('stack' in generic.error) && !('stack' in generic))

// D 错误载荷
const payload = safeErrorPayload({ ok: false, code: 'E_INTERNAL', error: 'D:\\a\\b 坏了', stack: 'at x', detail: { path: 'D:\\a' } })
eq('D1 去 stack/detail 且路径打码', payload, { ok: false, code: 'E_INTERNAL', error: '<path> 坏了' })
eq('D2 null 透传 null', safeErrorPayload(null), null)

// E 数据库健康视图
const health = {
  driver: 'better-sqlite3',
  file: 'D:\\project\\psyche\\.tmp\\memory.sqlite3',
  userVersion: 21,
  tables: 47,
  journalMode: 'wal',
  synchronous: 'normal',
  foreignKeys: 1,
  bytes: 1024,
  queries: 10,
  slowQueries: 0,
  slowWarnings: 0,
  maxQueryMs: 3,
}
const storage = storageView(health)
ok('E1 健康视图不含 file', storage && !('file' in storage))
eq('E2 其余字段保留', storage && storage.userVersion, 21)
eq('E3 null 透传 null', storageView(null), null)

// F 状态视图
const status = toStatusView({
  ok: false,
  enabled: true,
  driver: null,
  dataDir: 'D:\\project\\psyche\\.tmp-p4a4-data',
  startedAt: '2026-11-13T00:00:00.000Z',
  selfCheck: null,
  attempts: [{ driver: 'better-sqlite3', ok: false, stage: 'open', reason: 'unable to open D:\\project\\psyche\\x.db' }],
  error: { ok: false, code: 'E_DB', error: '打开 D:\\project\\psyche\\x.db 失败', stack: 'at boot' },
  storage: null,
  personaInit: { identityPath: 'D:\\project\\psyche\\persona\\identity.md' },
  behavior: { autoRemember: true, dataDir: 'D:\\project\\psyche\\.tmp-p4a4-data' },
})
ok('F1 状态视图无 dataDir', !('dataDir' in status))
eq('F2 error 去 stack', status.error, { ok: false, code: 'E_DB', error: '打开 <path> 失败' })
eq('F3 attempts.reason 受控文案', status.attempts[0].reason, '尝试失败')
ok('F4 视图无 storage.file', status.storage === null)
eq('F5 嵌套 personaInit 路径打码', (status.personaInit as { identityPath: string }).identityPath, '<path>')
ok('F6 嵌套 dataDir 字段剔除', !('dataDir' in (status.behavior as Record<string, unknown>)))

// G 面板视图
const panel = toPanelView({
  ok: true,
  enabled: true,
  driver: 'better-sqlite3',
  dataDir: 'D:\\project\\psyche\\.tmp-p4a4-data',
  startedAt: '2026-11-13T00:00:00.000Z',
  selfCheck: null,
  attempts: [],
  error: null,
  storage: health,
  state: null,
  growth: null,
  personaInit: null,
  personaInitError: '读取 D:\\project\\psyche\\persona 失败',
  salience: [],
  fold: null,
  proposals: [],
  contacts: [
    { contactId: 'ct_1', platform: 'qq', stableUserId: '10001', displayName: '小A', band: 'friendly', bandLabel: '友好' },
  ],
  settings: [
    {
      id: 'storage',
      title: '存储',
      fields: [
        { key: 'dataDir', label: '数据目录', kind: 'text', apply: 'restart', value: 'D:\\project\\psyche\\.tmp-p4a4-data', help: '' },
        { key: 'driver', label: '驱动', kind: 'text', apply: 'restart', value: 'auto', help: '' },
      ],
    },
  ],
  prefs: { memoryChip: true },
  behavior: { autoRemember: true },
  notes: [],
})
ok('G1 联系人视图无 stableUserId', !('stableUserId' in panel.contacts[0]))
eq('G2 联系人其它字段保留', panel.contacts[0].displayName, '小A')
eq('G3 settings 路径只留末段', panel.settings[0].fields[0].value, '.tmp-p4a4-data')
eq('G4 settings 普通值不变', panel.settings[0].fields[1].value, 'auto')
ok('G5 panel storage 不含 file', Boolean(panel.storage && !('file' in panel.storage)))
eq('G6 personaInitError 受控文案', panel.personaInitError, '初始化失败')
ok('G7 面板视图无 dataDir', !('dataDir' in panel))
eq('G8 prefs 保留', panel.prefs.memoryChip, true)

// H 坏 DB 的 200 降级：错误对象里残留 stack/detail 也不能出网
const degraded = toPanelView({
  ...panel,
  error: {
    ok: false,
    code: 'E_DB',
    error: '打开 D:\\project\\psyche\\x.db 失败',
    detail: { file: 'D:\\project\\psyche\\x.db' },
    stack: 'at boot (D:\\project\\psyche\\src\\index.ts:1:1)',
  } as never,
  personaInitError: '读取 D:\\project\\psyche\\persona 失败\n    at boot',
})
const degradedText = JSON.stringify(degraded)
ok('H1 200 降级无 stack', !degradedText.includes('at boot'))
ok('H2 200 降级无绝对路径', !degradedText.includes('D:'))

console.log(`\n[P4-A-5 http-dto] ${passed} 通过 ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
