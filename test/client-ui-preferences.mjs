// Exercise the shipped script bundle through its registered page and real handlers.
// The small hook runner supplies scheduling only; no production source is rewritten.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
let passed = 0
const failures = []
function ok(name, value) { if (value) passed++; else failures.push(name); console.log(`  ${value ? 'ok' : 'FAIL'} ${name}`) }
function eq(name, actual, expected) { ok(name, JSON.stringify(actual) === JSON.stringify(expected)) }
let active
const React = {
  Component: class {}, Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) { return { type, props: { ...props, children } } },
  useState(initial) { const r = active, i = r.cursor++; if (!(i in r.slots)) r.slots[i] = typeof initial === 'function' ? initial() : initial; return [r.slots[i], next => { r.slots[i] = typeof next === 'function' ? next(r.slots[i]) : next; r.dirty = true }] },
  useRef(initial) { const r = active, i = r.cursor++; return r.slots[i] ??= { current: initial } },
  useEffect(fn, deps) { const r = active, i = r.cursor++, old = r.slots[i]; if (!old || deps.some((d, j) => d !== old.deps[j])) { r.slots[i] = { deps, cleanup: old?.cleanup }; r.effects.push(() => { r.slots[i].cleanup?.(); r.slots[i].cleanup = fn() }) } },
  useMemo(fn, deps) { const r = active, i = r.cursor++, old = r.slots[i]; if (!old || deps.some((d, j) => d !== old.deps[j])) r.slots[i] = { deps, value: fn() }; return r.slots[i].value },
}
function mount(fn, props = {}) {
  const r = { slots: [], cursor: 0, effects: [], dirty: true, tree: null, props,
    render() { let loops = 0; do { if (++loops > 20) throw Error('render loop'); this.dirty = false; this.cursor = 0; active = this; this.tree = fn(this.props); const effects = this.effects.splice(0); for (const f of effects) f() } while (this.dirty); return this.tree },
    unmount() { for (const s of this.slots) if (s?.cleanup) s.cleanup() },
  }; r.render(); return r
}
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null
  if (Array.isArray(tree)) { for (const n of tree) { const result = find(n, predicate); if (result) return result } return null }
  if (predicate(tree)) return tree
  return find(tree.props?.children, predicate)
}
function collect(tree, predicate, out = []) {
  if (!tree || typeof tree !== 'object') return out
  if (Array.isArray(tree)) { for (const n of tree) collect(n, predicate, out); return out }
  if (predicate(tree)) out.push(tree)
  collect(tree.props?.children, predicate, out)
  return out
}
const textOf = node => { const text = node?.props?.children; return Array.isArray(text) ? text.join('') : text }
function createPage() {
  const requests = [], intervals = new Map(), timers = new Map()
  let next = 0, plugin, Page
  const context = {
    console, AbortController, URLSearchParams,
    setInterval(fn) { intervals.set(++next, fn); return next }, clearInterval(id) { intervals.delete(id) },
    setTimeout(fn) { timers.set(++next, fn); return next }, clearTimeout(id) { timers.delete(id) },
    fetch(url, options = {}) { return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) },
    __ModuleLoader__: { load(spec) { plugin = spec.factory(() => React) } },
  }
  vm.runInNewContext(readFileSync('dist/client/index.js', 'utf8'), context)
  plugin.apply({ slots: { inject(_name, cb) { return cb() }, register(meta, component) { if (meta.name === 'main') Page = component; return () => {} } } })
  const child = Page({}).props.children[0]
  const page = mount(child.type)
  const settings = () => find(page.render(), n => n.type?.name === 'SettingsTab')
  const open = id => { find(page.render(), n => n.props?.id === 'lb-tab-' + id).props.onClick(); page.render() }
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); page.render() }
  const reply = async (request, body, status = 200) => { request.resolve({ ok: status >= 200 && status < 300, status, json: async () => body }); await settle() }
  const poll = () => { [...intervals.values()][0](); page.render(); return requests.at(-1) }
  return { page, requests, intervals, timers, settings, open, settle, reply, poll }
}
const snapshot = (sea = false, promptSection = null) => ({ ok: true, enabled: true, prefs: { sea, promptSection }, settings: [], personaInit: null, notes: [], state: null, proposals: [], behavior: null })
const ack = (sea, promptSection) => ({ ok: true, prefs: { sea, promptSection } })
const p = createPage()
p.open('settings')
let node = p.settings(), settingsUi = mount(node.type, node.props)
eq('initial controls disabled until panel arrives', ['sea', 'promptSection'].map(k => find(settingsUi.tree, n => n.props?.id === 'lb-pref-' + k).props.disabled), [true, true])
ok('no default preference is presented as confirmed', find(settingsUi.tree, n => n.props?.value === 'unavailable'))
await p.reply(p.requests[0], snapshot())
eq('reads raw null inheritance state', p.settings().props.data.prefs, { sea: false, promptSection: null })
settingsUi.unmount(); node = p.settings(); settingsUi = mount(node.type, node.props)
const select = find(settingsUi.tree, n => n.props?.id === 'lb-pref-promptSection')
eq('three-state selector preserves inherit', select.props.value, 'inherit')
eq('three-state selector offers all options', select.props.children.filter(Boolean).map(n => n.props.value), ['inherit', 'true', 'false'])
select.props.onChange({ target: { value: 'true' } }); p.page.render()
eq('true written as boolean', JSON.parse(p.requests.at(-1).options.body), { promptSection: true })
eq('does not update before server confirmation', p.settings().props.data.prefs.promptSection, null)
ok('only changed field locked', p.settings().props.prefs.promptSection.pending && !p.settings().props.prefs.sea.pending)
const write1 = p.requests.at(-1), length = p.requests.length
p.settings().props.onPref('promptSection', false)
eq('rapid second action on locked field does not send', p.requests.length, length)
p.settings().props.onPref('sea', true)
const write2 = p.requests.at(-1)
ok('other field can save concurrently', write2 !== write1)
const oldRead = p.poll()
await p.reply(write2, ack(true, true))
eq('ack applies only its own field', p.settings().props.data.prefs, { sea: true, promptSection: null })
await p.reply(write1, ack(false, true))
eq('reverse complete responses cannot overwrite newer other field', p.settings().props.data.prefs, { sea: true, promptSection: true })
await p.reply(oldRead, snapshot(false, null))
eq('panel read started during writes cannot revert confirmed fields', p.settings().props.data.prefs, { sea: true, promptSection: true })
ok('both fields unlock and show saved', Object.values(p.settings().props.prefs).every(s => !s.pending && s.saved))
p.settings().props.onPref('promptSection', false)
eq('false written as boolean', JSON.parse(p.requests.at(-1).options.body), { promptSection: false })
await p.reply(p.requests.at(-1), ack(true, false))
eq('false confirmed', p.settings().props.data.prefs.promptSection, false)
p.settings().props.onPref('promptSection', null)
eq('inherit written as JSON null', JSON.parse(p.requests.at(-1).options.body), { promptSection: null })
await p.reply(p.requests.at(-1), ack(true, null))
eq('null confirmed', p.settings().props.data.prefs.promptSection, null)
const beforeWriteRead = p.poll()
p.settings().props.onPref('sea', false)
await p.reply(p.requests.at(-1), ack(false, null))
await p.reply(beforeWriteRead, snapshot(true, true))
eq('read predating write cannot revert that field', p.settings().props.data.prefs.sea, false)
eq('unmodified field accepts newer read', p.settings().props.data.prefs.promptSection, true)
p.settings().props.onPref('sea', true)
const failedWrite = p.requests.at(-1)
p.open('overview'); p.open('settings')
ok('switching tabs preserves pending state', p.settings().props.prefs.sea.pending)
await p.reply(failedWrite, { ok: false, error: { code: 'E_IO', message: 'sensitive/path' } }, 503)
eq('HTTP failure keeps last confirmed value', p.settings().props.data.prefs.sea, false)
ok('failure unlocks only its row with stable status/code', !p.settings().props.prefs.sea.pending && /503.*E_IO/.test(p.settings().props.prefs.sea.error))
ok('server raw details not echoed', !p.settings().props.prefs.sea.error.includes('sensitive'))
node = p.settings(); settingsUi.unmount(); settingsUi = mount(node.type, node.props)
ok('save failure is visible inline alert', find(settingsUi.tree, n => n.props?.role === 'alert' && n.props?.id === 'lb-pref-status-sea'))
p.settings().props.onPref('sea', true)
await p.reply(p.requests.at(-1), { ok: true, prefs: { sea: 'true', promptSection: null } })
eq('malformed success response cannot update preference', p.settings().props.data.prefs.sea, false)
ok('malformed success reported as unconfirmed', /SAVE_UNCONFIRMED/.test(p.settings().props.prefs.sea.error))
p.settings().props.onPref('sea', true)
p.requests.at(-1).reject(Error('offline')); await p.settle()
ok('network failure unlocks with reconciliation guidance', !p.settings().props.prefs.sea.pending && /刷新核对/.test(p.settings().props.prefs.sea.error))
await p.reply(p.poll(), { error: 'unavailable' }, 500)
node = p.settings(); settingsUi.unmount(); settingsUi = mount(node.type, node.props)
eq('panel read failure disables both controls', ['sea', 'promptSection'].map(k => find(settingsUi.tree, n => n.props?.id === 'lb-pref-' + k).props.disabled), [true, true])
const countBefore = p.requests.length
p.settings().props.onPref('sea', true)
eq('handler also refuses writes while read failed', p.requests.length, countBefore)
ok('read failure retains last successful snapshot', p.settings().props.data !== null)
ok('read failure displays retry action', find(settingsUi.tree, n => n.type === 'button' && n.props.children.includes('重试读取')))
await p.reply(p.poll(), snapshot(true, null))
ok('successful retry clears read error', p.settings().props.error === null)
eq('successful later read can reconcile external changes', p.settings().props.data.prefs, { sea: true, promptSection: null })
p.settings().props.onPref('sea', false)
const lateWrite = p.requests.at(-1)
p.page.unmount(); settingsUi.unmount()
ok('unmount aborts pending request', lateWrite.options.signal.aborted)
eq('unmount removes polling', p.intervals.size, 0)
const oldData = p.settings().props.data
// A late response from a transport ignoring AbortSignal must also be harmless.
await p.reply(lateWrite, ack(false, false))
eq('late response after unmount does not replace snapshot', p.settings().props.data, oldData)
eq('settled requests release timeout handles', p.timers.size, 0)

const q = createPage(); q.open('settings')
await q.reply(q.requests[0], { ok: true })
ok('missing prefs never treated as defaults', q.settings().props.data === null && q.settings().props.error === 'PREFS_UNAVAILABLE')
q.page.unmount()

// UI-2a1：五页导航 + 隐藏路由可达性（不改页面内容，只验导航骨架）。
const nav = createPage()
nav.open('overview')
const headingOf = tree => { const node = find(tree, n => n.type === 'h1'); return textOf(node) }
const tabLabels = tree => collect(tree, n => n.props?.role === 'tab').map(textOf)
eq('UI-2a1 five top-level tabs', tabLabels(nav.page.render()).slice(0, 5), ['概览', '记忆', '情绪', 'QQ', '设置'])
eq('UI-2a1 exactly five visible tabs', nav.page.render() && tabLabels(nav.page.render()).length, 5)
eq('UI-2a1 overview is default route', headingOf(nav.page.render()), '概览')
nav.open('settings')
const usageEntry = find(nav.page.render(), n => n.type === 'button' && textOf(n) === '用量与花费')
const opsEntry = find(nav.page.render(), n => n.type === 'button' && textOf(n) === '运维')
ok('UI-2a1 settings exposes usage/ops entries', Boolean(usageEntry) && Boolean(opsEntry))
usageEntry.props.onClick()
let navTree = nav.page.render()
eq('UI-2a1 hidden usage route keeps title', headingOf(navTree), '用量与花费')
const backToSettings = find(navTree, n => n.type === 'button' && textOf(n) === '返回设置')
ok('UI-2a1 hidden route can return to parent', Boolean(backToSettings))
const settingsTab = find(navTree, n => n.props?.role === 'tab' && textOf(n) === '设置')
ok('UI-2a1 parent tab stays highlighted on hidden route', settingsTab.props['aria-selected'] === true)
backToSettings.props.onClick()
nav.page.render()
eq('UI-2a1 back returns to settings', headingOf(nav.page.render()), '设置')
const settingsComponent = find(nav.page.render(), n => typeof n.type === 'function')
const settingsUi2 = mount(settingsComponent.type, settingsComponent.props)
const settingsTree = settingsUi2.tree
const sectionTitles = collect(settingsTree, n => n.type === 'h2').map(textOf)
eq('UI-2a2 settings has three stacked sections', sectionTitles.filter(t => ['个性化', 'DSH 运行配置', '高级与维护'].includes(t)), ['个性化', 'DSH 运行配置', '高级与维护'])
ok('UI-2a2 settings links to DSH Plugins page', Boolean(find(settingsTree, n => n.type === 'button' && textOf(n) === '打开 DSH Plugins 页')))
ok('UI-2a2 settings drops category filter', !find(settingsTree, n => n.props?.['aria-label'] === '设置分类'))
const effectTexts = collect(settingsTree, n => typeof n.type === 'string').map(textOf).filter(t => typeof t === 'string')
eq('UI-2a2 settings marks immediate effects', effectTexts.filter(t => t === '即时').length, 2)
ok('UI-2a2 settings marks restart effects', effectTexts.includes('重启后') || effectTexts.some(t => /暂不可用/.test(t)))
settingsUi2.unmount()
// UI-2b：记忆页结论检索 + 情绪页八维卡（只验结构，不造真实数据结论）。
const memData = {
  ...snapshot(true, null),
  salience: ['喜欢雨天', '习惯晚间整理笔记', '重视承诺', '最近在学 SQLite', '怕吵'].map((statement, index) => ({
    artifactId: 'a' + index, kind: 'fact', statement, score: 10 - index, solid: index === 0, reasons: index === 0 ? ['独立来源 2'] : [],
  })),
  contacts: [],
  growth: null,
}
await nav.reply(nav.requests[0], memData)
nav.open('memory')
const memTree = nav.page.render()
const memNode = find(memTree, n => n.type?.name === 'MemoryTab')
const memUi = mount(memNode.type, memNode.props)
ok('UI-2b memory exposes conclusion search', Boolean(find(memUi.tree, n => n.props?.['aria-label'] === '搜索记忆结论')))
eq('UI-2b memory defaults to five conclusions', collect(memUi.tree, n => n.props?.className === 'lb-memory-item').length, 5)
ok('UI-2b memory keeps proposal owner boundary', Boolean(find(memUi.tree, n => n.type?.name === 'ProposalsTab')))
const search = find(memUi.tree, n => n.props?.['aria-label'] === '搜索记忆结论')
search.props.onChange({ target: { value: 'SQLite' } })
memUi.render()
eq('UI-2b memory search filters conclusions', collect(memUi.tree, n => n.props?.className === 'lb-memory-item').length, 1)
search.props.onChange({ target: { value: '不存在的词' } })
memUi.render()
ok('UI-4 memory search no-match empty state', collect(memUi.tree, n => typeof n.type === 'string').some(n => textOf(n) === '没有匹配的结论。'))
memUi.unmount()
const emptyMemory = mount(memNode.type, { ...memNode.props, data: { ...memData, salience: [] } })
ok('UI-4 memory empty state', collect(emptyMemory.tree, n => typeof n.type === 'string').some(n => textOf(n) === '还没有可展示的记忆结论。'))
emptyMemory.unmount()
nav.open('mood')
const moodNode = find(nav.page.render(), n => n.type?.name === 'MoodTab')
const moodUi = mount(moodNode.type, moodNode.props)
const radarNode = find(moodUi.tree, n => n.type?.name === 'MoodRadarCard')
const radarUi = mount(radarNode.type, radarNode.props)
const moodRead = nav.requests.at(-1)
await nav.reply(moodRead, {
  ok: true,
  tone: { tone: '平稳', secondary: null, neutral: true, projectionVersion: 3 },
  groups: { basic: [{ key: 'calm', label: '平静', layer: 'basic', value: 50, baseline: 45, halfLifeHours: 2 }], compound: [], contemporary: [] },
  history: [], historyLimit: 60, historyTotal: 0,
})
radarUi.render()
const radarTree = radarUi.tree
ok('UI-2b mood shows radar card', collect(radarTree, n => typeof n.type === 'string').some(n => textOf(n) === '情绪八维'))
ok('UI-2b mood offers radar/number toggle', ['雷达', '数字'].every(label => Boolean(find(radarTree, n => n.type === 'button' && textOf(n) === label))))
radarUi.unmount(); moodUi.unmount(); nav.page.unmount()

// UI-2c：QQ 页默认只看状态/授权/计数，日志与诊断收进「高级诊断」。
const qq = createPage()
qq.open('qq')
const qqData = {
  ok: true,
  enabled: true,
  connection: 'connected',
  account: { uinMasked: '1***9', nickname: '心灵', online: true },
  allowFrom: { ownerConfigured: true, ownerMasked: '1***9', extraCount: 0, extraMasked: [] },
  counts: {
    received: 1, delivered: 1, sendErrors: 0, rejected: 0, rejectReplies: 0,
    rateLimitedDrops: 0, rejectSendErrors: 0, outOfScopeDrops: 0, contactSuppressed: 0,
  },
  activity: { lastHeartbeatAt: null, lastMessageAt: null, lastSentAt: null },
  logs: [],
}
// v29.49：工作区卡的五态数据由宿主现算，这里只按形状回放。
const qqWorkspace = {
  ok: true,
  state: 'registered',
  label: '已登记',
  reason: 'QQ 聊天',
  expectedTitle: 'QQ 聊天',
  cwd: 'C:\\ws\\QQ 聊天',
  cwdSource: 'default',
  workspaceId: 'ws-1',
  actualTitle: 'QQ 聊天',
  memberCount: 2,
  attempt: { at: '2026-11-23T00:00:00.000Z', step: 'created', ok: true },
  checkedAt: '2026-11-23T00:00:01.000Z',
}
const qqNode = find(qq.page.tree, n => n.type?.name === 'QqAdminTab')
const qqUi = mount(qqNode.type, qqNode.props)
let qqHandled = 0
for (let round = 0; round < 3; round += 1) {
  qqUi.render()
  await qq.settle()
  while (qqHandled < qq.requests.length) {
    const request = qq.requests[qqHandled++]
    if (request.url.includes('/qq/diagnostics')) await qq.reply(request, { ok: true, items: [], matched: 0, nextBefore: null })
    else if (request.url.includes('/qq/workspace')) await qq.reply(request, qqWorkspace)
    else if (request.url.includes('/api/psyche/qq')) await qq.reply(request, qqData)
    else await qq.reply(request, snapshot())
  }
}
qqUi.render()
const qqToggle = find(qqUi.tree, n => n.props?.['aria-label'] === '高级诊断')
ok('UI-2c QQ offers advanced diagnostics toggle', Boolean(qqToggle))
eq('UI-2c QQ advanced is collapsed by default', qqToggle?.props?.['aria-expanded'], 'false')
// P8-FINAL：控制中心在 QQ 页内以 iframe 加载，不打开外部浏览器。
const controlButton = find(qqUi.tree, n => n.type === 'button' && String(textOf(n) ?? '').includes('打开控制中心'))
ok('P8-FINAL QQ control center button exists', Boolean(controlButton))
controlButton.props.onClick()
qqUi.render()
await qq.settle()
const embedRequest = qq.requests.find(request => request.url.includes('/api/psyche/qq/control/embed'))
ok('P8-FINAL QQ control center posts embed request', Boolean(embedRequest) && embedRequest.options?.method === 'POST')
await qq.reply(embedRequest, { ok: true, url: 'http://127.0.0.1:62000/#t=abc' })
qqUi.render()
const embeddedFrame = find(qqUi.tree, n => n.type === 'iframe')
eq('P8-FINAL QQ control center renders inline iframe', embeddedFrame?.props?.src, 'http://127.0.0.1:62000/#t=abc')
const qqToggleAfterEmbed = find(qqUi.tree, n => n.props?.['aria-label'] === '高级诊断')
qqToggleAfterEmbed.props.onClick()
qqUi.render()
const qqExpanded = find(qqUi.tree, n => n.props?.['aria-label'] === '高级诊断')
eq('UI-2c QQ advanced expands on demand', qqExpanded?.props?.['aria-expanded'], 'true')
// v29.49：运行管理段有工作区五态卡，读的是宿主现算的状态；编辑入口在内嵌控制中心。
const wsTexts = collect(qqUi.tree, n => typeof n.type === 'string').map(textOf).filter(text => typeof text === 'string')
ok('v2949 QQ 工作区卡出现', wsTexts.some(text => text.includes('QQ 工作区')))
ok('v2949 QQ 工作区卡显示五态标签', wsTexts.some(text => text.includes('已登记')))
ok('v2949 QQ 工作区卡透传成员数', wsTexts.some(text => text === '2'))
ok('v2949 QQ 工作区卡标明目录来源', wsTexts.some(text => text.includes('默认（数据目录同级）')))
ok('v2949 QQ 工作区卡有编辑入口', Boolean(find(qqUi.tree, n => n.type === 'button' && String(textOf(n) ?? '').includes('编辑工作区'))))
// P8-4：QQ 页五段只读视图（运行管理/联系人策略/模型与推理/诊断事件/运行日志）。
for (const label of ['运行管理', '联系人策略', '模型与推理', '诊断事件', '运行日志']) {
  ok('P8-4 QQ nav ' + label, Boolean(find(qqUi.tree, n => n.type === 'button' && n.props?.['aria-label'] === label)))
}
const contactsNav = find(qqUi.tree, n => n.type === 'button' && n.props?.['aria-label'] === '联系人策略')
contactsNav.props.onClick()
qqUi.render()
ok('P8-4 QQ contacts policy card', collect(qqUi.tree, n => typeof n.type === 'string').map(textOf).some(text => typeof text === 'string' && text.includes('这里只读展示生效中的名单')))
// Q1：只读卡上必须有跳去控制中心改名单的入口，否则用户看得到却改不了。
ok('Q1 QQ contacts policy 有管理入口', collect(qqUi.tree, n => typeof n.type === 'string').map(textOf).some(text => typeof text === 'string' && text.includes('管理 Owner 与白名单')))
// v29.48：模型与推理段只放内嵌控制中心，不再重复父页那几张只读卡片。
const modelNav = find(qqUi.tree, n => n.type === 'button' && n.props?.['aria-label'] === '模型与推理')
modelNav.props.onClick()
qqUi.render()
const modelTexts = collect(qqUi.tree, n => typeof n.type === 'string').map(textOf).filter(text => typeof text === 'string')
ok('v2948 QQ model 段仍保留控制中心入口', modelTexts.some(text => text.includes('控制中心')))
ok('v2948 QQ model 段不重复启动顺序卡', !modelTexts.some(text => text.includes('QQ 通道按下面顺序启动')))
qqUi.unmount()

// UI-4：概览读取失败态（组件级；真实宿主视觉仍 NOT VERIFIED）。
const errPage = createPage()
await errPage.reply(errPage.requests[0], { error: 'boom' }, 500)
await errPage.settle()
errPage.page.render()
ok('UI-4 overview read failure state', collect(errPage.page.tree, n => typeof n.type === 'string').some(n => textOf(n) === '暂时无法读取数据，请重试。'))
errPage.page.unmount()

console.log(`client-ui-preferences: ${passed} 通过 / ${failures.length} 失败`)
if (failures.length) process.exitCode = 1
