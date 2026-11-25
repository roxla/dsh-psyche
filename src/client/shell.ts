// 心灵 · 浏览器半侧：面板外壳（页签条、画布、错误边界、侧栏图标）
//
// PsychePage 决定「哪个 route 渲染哪个页签组件」，是各 tabs/* 的唯一汇合点。




// ── 页签顺序规则（UI-2a1 五页导航） ───────────────────────────
// 顶层只保留五个面：概览 / 记忆 / 情绪 / QQ / 设置。
// 旧页签（status/usage/ops/proposals/contacts/sea）保留为隐藏路由：
// 由父页面入口进入，页签高亮父级，并提供返回入口，避免删除已有能力。
const BASE_TABS: { id: string; label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'memory', label: '记忆' },
  { id: 'mood', label: '情绪' },
  { id: 'qq', label: 'QQ' },
  { id: 'settings', label: '设置' },
]
const SEA_TAB = { id: 'sea', label: '意识海' }
/** 隐藏路由 → 顶层父页面；父页面自身不在表里。 */
const LEGACY_ROUTE_PARENT: Record<string, string> = {
  status: 'overview',
  usage: 'settings',
  ops: 'settings',
  proposals: 'memory',
  contacts: 'mood',
  sea: 'memory',
}
function parentOfTab(id: string): string {
  return LEGACY_ROUTE_PARENT[id] ?? id
}
/**
 * 顶层导航固定五项；意识海等旧页签只作为隐藏路由存在。
 * @param data 面板快照（保留参数以兼容既有调用）
 * @returns 新数组，避免调用方改到模块级常量
 */
function tabsFor(_data: PanelData | null): { id: string; label: string }[] {
  return BASE_TABS.slice()
}

// ── 主面板页（参考 dsh-mnemon 的 workbench 骨架）──────────────────
// 结构：根 flex 列铺满 main 槽 → 固定页头（sticky）→ 页签条 → 可滚动画布。
// 画布自己管滚动，绝不改宿主的滚动容器；卡片用 auto-fit 网格铺满宽度。
const PAD_X = 22

/**
 * 主面板：页头（固定）+ 页签条 + 可滚动画布，自己管取数与当前页签。
 * 副作用：usePanel 每 20 秒轮询一次；写偏好时 POST /api/psyche/prefs 再 reload。
 * 布局约束：根节点是 flex 列 + overflow hidden，真正滚动的只有下面那层画布。
 */
function PsychePage(): any {
  const [route, setRoute] = React.useState('overview')
  const panel = usePanel()
  const { data, error, loading, updatedAt: stamp, reload, savePref, prefs } = panel
  const tabs = tabsFor(data)
  const canvas = React.useRef(null as any)
  const tabRefs = React.useRef({} as Record<string, any>)
  const active = parentOfTab(route)
  const hidden = active !== route
  const allowedRoutes = React.useMemo(() => {
    const ids = new Set(tabs.map((item) => item.id))
    Object.keys(LEGACY_ROUTE_PARENT).forEach((id) => ids.add(id))
    return ids
  }, [tabs])
  React.useEffect(() => {
    if (!allowedRoutes.has(route)) setRoute('overview')
  }, [allowedRoutes, route])
  React.useEffect(() => { if (canvas.current) canvas.current.scrollTop = 0 }, [route])
  const title = tabs.find((item) => item.id === active)?.label ?? '概览'
  const routeLabel = route === 'sea' ? '意识海' : route === 'usage' ? '用量与花费' : route === 'ops' ? '运维' : title
  const navigate = (id: string): void => {
    setRoute(id)
    const element = tabRefs.current[parentOfTab(id)]
    element?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }
  const keyNav = (event: any, index: number): void => {
    let next = index
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
    else return
    event.preventDefault(); navigate(tabs[next]!.id); tabRefs.current[tabs[next]!.id]?.focus()
  }
  let body: any
  if (route === 'usage') body = h(UsageSpendTab, { stamp })
  else if (route === 'ops') body = h(OpsTab, { stamp })
  else if (route === 'qq') body = h(QqAdminTab, { stamp })
  else if (route === 'settings') body = h(SettingsTab, { data, error, loading, onPref: savePref, prefs, onReload: reload, onNavigate: navigate })
  else if (!data) body = uiSection('运行快照', h('p', { className: 'lb-help' }, error ? '暂时无法读取数据，请重试。' : '正在读取…'))
  else if (route === 'overview' || route === 'status') body = h(StatusTab, { data, stamp, stale: Boolean(error), onNavigate: navigate })
  else if (route === 'memory' || route === 'proposals') body = h(MemoryTab, { data, stamp, onNavigate: navigate, onDecided: reload })
  else if (route === 'sea') body = h(SeaTab)
  else if (route === 'mood' || route === 'contacts') body = h(MoodTab, { data, stamp })
  else body = h(ContactsTab, { data })
  return h('div', { className: 'lb-panel', 'data-dsh-plugin': 'dsh-psyche', 'data-dsh-part': 'panel' },
    h('style', { 'data-psyche-style': 'ui1' }, PANEL_CSS),
    h('header', { className: 'lb-header', 'data-dsh-part': 'page-header' },
      h('div', { className: 'lb-title-row' },
        hidden ? uiButton('返回' + title, () => setRoute(active), { 'aria-label': '返回' + title }) : null,
        h('h1', null, hidden ? routeLabel : title)),
      h('div', { className: 'lb-header-actions' },
        stamp ? h('span', { className: 'lb-updated' }, '更新于 ' + fmtTime(stamp)) : null,
        error ? uiBadge('读取失败', 'error') : data ? uiBadge(data.ok ? '运行中' : '启动未完成', data.ok ? 'ok' : 'warn') : uiBadge('读取中'),
        uiButton(loading ? '刷新中…' : '刷新', reload, { disabled: loading, 'aria-label': '刷新面板' }))),
    h('div', { className: 'lb-tabs', role: 'tablist', 'aria-label': '心灵页面', 'data-dsh-part': 'tabs' },
      tabs.map((item, index) => h('button', {
        key: item.id, id: 'lb-tab-' + item.id, type: 'button', className: 'lb-tab', role: 'tab',
        'aria-selected': active === item.id, 'aria-controls': 'lb-page-body', tabIndex: active === item.id ? 0 : -1,
        ref: (element: any) => { tabRefs.current[item.id] = element },
        onClick: () => navigate(item.id), onKeyDown: (event: any) => keyNav(event, index),
      }, item.label))),
    h('div', { className: 'lb-subnav', 'data-dsh-part': 'subnav' },
      active === 'memory' ? uiButton('意识海', () => navigate('sea'), { 'aria-label': '打开意识海' }) : null,
      active === 'settings' ? uiButton('用量与花费', () => navigate('usage'), { 'aria-label': '打开用量与花费' }) : null,
      active === 'settings' ? uiButton('运维', () => navigate('ops'), { 'aria-label': '打开运维' }) : null),
    h('div', { ref: canvas, id: 'lb-page-body', role: 'tabpanel', 'aria-labelledby': 'lb-tab-' + active,
      tabIndex: 0, className: 'lb-canvas' + (route === 'sea' ? ' lb-canvas-sea' : ''),
      'data-dsh-part': 'canvas', 'data-testid': 'psyche-canvas' },
      h('div', { className: route === 'sea' ? '' : 'lb-stack', style: route === 'sea' ? { height: '100%', minHeight: 0 } : undefined },
        error ? h('div', { className: 'lb-alert', role: 'alert' },
          '读取面板失败：' + error + (stamp ? '；最近成功快照：' + fmtTime(stamp) : '；尚无可用快照。')) : null,
        data ? h(InitBanner, { data, onChanged: reload }) : null,
        body)))
}



/**
 * 错误边界：面板内部任一组件抛错，只换掉这一块，不会把宿主的侧栏一起带崩。
 * 只能用 class 写——React 的错误边界至今只有 class 组件支持。
 *
 * 为什么包一层工厂：`class X extends React.Component` 的 extends 在**装载时**求值，
 * 而 React 要等宿主 factory 里 `req('react')` 才到位。装载阶段直接建类会
 * `Class extends value undefined` 直接炸掉整个 bundle，所以这里只声明工厂，调用时才建类。
 */
function createPageBoundary(): any {
  return class PageBoundary extends React.Component {
    constructor(props: any) {
      super(props)
      this.state = { failed: false }
    }
    static getDerivedStateFromError(): any {
      return { failed: true }
    }
    componentDidCatch(error: any): void {
      // 只往控制台记一笔、不往上抛：插件面板的一条渲染错误不值得让宿主弹全局报错。
      console.error('[psyche] 面板渲染失败', error)
    }
    render(): any {
      // failed 一旦置真就停在这个兜底页：想重试得让用户把面板重新打开。
      if (this.state.failed) {
        return h(
          'div',
          { style: { padding: 16, fontSize: 13, color: BAD } },
          '心灵面板渲染失败，看看控制台。',
        )
      }
      return this.props.children
    }
  }
}

/** 槽位入口：宿主只认这个组件，外面再包一层错误边界当保险。 */
function PanelHost(props: any): any {
  return h(PageBoundary, null, h(PsychePage, props))
}

// 侧栏图标：一只简单的鲸鱼轮廓 + 记忆点
/** 侧栏图标：鲸鱼轮廓加一颗记忆点；尺寸由宿主通过 props.size 给，默认 18。 */
function PsycheIcon(props: any): any {
  const size = (props && props.size) || 18
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      'aria-hidden': 'true',
      'data-dsh-plugin': 'dsh-psyche',
      'data-dsh-part': 'sidebar-icon',
    },
    h('path', { d: 'M3 13c3.2 0 4.6-2 6.6-4.4C11.4 6.5 13 5.5 15 6c2.4.6 3 3.2 6 3-.4 1.6-1.7 2.6-3.2 2.8.3 3.4-2 6.2-5.6 6.2H8' }),
    h('path', { d: 'M6.2 10.6C4.9 10 4.2 9 4 8c1.6.1 2.6.7 3.2 1.6' }),
    h('circle', { cx: 15.2, cy: 9.6, r: 0.7, fill: 'currentColor', stroke: 'none' }),
  )
}
