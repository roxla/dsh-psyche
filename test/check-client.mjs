// 检查浏览器半侧产物：必须是 UTF-8、无替换字符、无 ESM import/export 语句。
// 另外盯住几个「界面上必须存在」的锚点，防止重构时把入口悄悄丢掉。
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? 'dist/client/index.js'
const text = readFileSync(file, 'utf8')
const bad = text.includes('\uFFFD')
const hasEsm = /^\s*(import|export)\s/m.test(text)
const loads = text.includes('__ModuleLoader__')
const marks = {
  sidebarPanellist: text.includes('sidebar.panellist'),
  settingsAnchors: text.includes('settings-page'),
  seaCanvas: text.includes('sea-canvas'),
  usageEndpoint: text.includes('/api/psyche/usage'),
  opsEndpoint: text.includes('/api/psyche/ops'),
  archiveEndpoint: text.includes('/api/psyche/archives'),
  // 恢复流程是「在线准备 + 下次启动应用」两段，界面上必须能看状态、能准备、能确认
  restoreStatusEndpoint: text.includes('/api/psyche/restore/status'),
  restorePrepareEndpoint: text.includes('/api/psyche/restore/prepare'),
  restoreConfirmEndpoint: text.includes('/api/psyche/restore/confirm'),
  // 花费页（参考 dsh-qq-main 控制台）：区间标签与走势图标题必须在，否则等于页签是空的
  spendTab: text.includes('消耗走势'),
  spendRange: text.includes('30 天'),
  // 口径必须是「心灵自己花的钱」：空态卡与「不含对话」的说明是这条口径的可见证据
  spendSelfScope: text.includes('不含对话本身的消耗'),
  spendSelfEmpty: text.includes('还没有心灵自己的消耗'),
  // C2-D：每轮末尾的记忆标签必须注册到 turnTail，并只读 injection 回执接口
  memoryChip: text.includes('conversation.chat.turnTail'),
  memoryChipLabel: text.includes('记忆上下文'),
  injectionEndpoint: text.includes('/api/psyche/injection'),
  // B4：情绪区必须是真实数据入口（只读 mood 路由 + 当前语气 + 趋势卡），
  // 防止退回硬编码占位图或把整块情绪区弄丢。
  moodEndpoint: text.includes('/api/psyche/mood'),
  moodTone: text.includes('当前情绪'),
  moodTrend: text.includes('情绪趋势'),
  moodNoFakeChart: !text.includes('11/01'),
  // P4-A-3：QQ 只读页必须有独立取数入口、计数区与日志区；不出现发送/进程控制入口。
  qqEndpoint: text.includes('/api/psyche/qq'),
  qqTab: text.includes("'qq'"),
  qqCounts: text.includes('未授权私聊'),
  qqLogs: text.includes('运行日志'),
  qqReadonly: !text.includes('send_private_msg') && !text.includes('启动 SnowLuma'),
}
console.log(JSON.stringify({ file, bytes: Buffer.byteLength(text), bad, hasEsm, loads, marks }, null, 2))
if (bad || hasEsm || !loads || Object.values(marks).some((ok) => !ok)) process.exitCode = 1
