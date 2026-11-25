// 心灵 · 浏览器半侧：设置页（字段表单、插件设置跳转、控制台式布局）




/**
 * 按字符数截断长文本，超出补一个「…」。
 * @param text 原文，空值直接返回空串；@param max 保留的最大字符数
 * 只做按字符切：中文按字最直观，按词/按字节切会把结论切得读不懂。
 */
function truncate(text: string, max: number): string {
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// ── 设置页（热开关 + 只读镜像）────────────────────────────────
// 边界（v14 §32.3）：
//   面板只管「拨了就生效」的热开关（panel.sea / prompt.section），
//   需要重启才读到的 Config（驱动、数据目录、活动窗口、慢查询阈值）
//   一律留在宿主「设置 → 插件 → 心灵」——一处权威，面板不重复编辑。
// 字段 key → prefs 里的字段名：只登记「拨了就生效」的两项，加别的这里也不会生效。
const INTERACTIVE_SWITCHES: Record<string, string> = {
  'panel.sea': 'sea',
  'prompt.section': 'promptSection',
}

/** 宿主上下文：apply 时记下来，按钮要用它跳插件设置页。 */
let hostContext: any = null

/**
 * 尝试跳宿主「设置 → 插件 → 心灵」。
 * @returns true = 宿主提供了 pluginNavigation 且已跳转；false = 只能退回文字指引
 * 副作用：调用宿主导航服务；宿主没这个服务时静默失败，不弹错误、不影响页面。
 */
function openPluginSettings(): boolean {
  try {
    const nav = hostContext && hostContext.get ? hostContext.get('pluginNavigation') : null
    if (nav && typeof nav.openBundle === 'function') {
      nav.openBundle('dsh-psyche')
      return true
    }
  } catch {
    // 宿主没这个服务，退回纯文字指引
  }
  return false
}

// ── 旧页面共用的主题别名：布局留 UI-2，颜色统一跟随宿主。────────
const SET_BG = 'var(--lb-bg)'
const SET_CARD = 'var(--lb-panel)'
const SET_CARD_GLOW = 'none'
const SET_CARD_SOFT = 'var(--lb-soft)'
const SET_LINE = '1px solid var(--lb-line)'
const SET_LINE_SOFT = '1px solid var(--lb-line)'
const SET_TITLE = 'var(--lb-text)'
const SET_TEXT = 'var(--lb-text)'
const SET_FAINT = 'var(--lb-muted)'
const SET_CYAN = 'var(--lb-accent)'
const SET_PURPLE = 'var(--lb-accent)'
const SET_GREEN = 'var(--lb-ok)'
const SET_AMBER = 'var(--lb-warn)'

/** 设置页专用胶囊：同色边框 + 同色文字，深色底上比全局 pill 更清晰。 */
function darkPill(text: string, color: string): any {
  return h(
    'span',
    {
      style: {
        fontSize: 11,
        padding: '2px 9px',
        borderRadius: 999,
        border: `1px solid ${color}`,
        color,
        whiteSpace: 'nowrap',
      },
    },
    text,
  )
}

/** 设置页空态：一行低饱和蓝灰，避免在深色底上用灰色透明字看不清。 */
function darkEmpty(text: string): any {
  return h('div', { style: { color: SET_FAINT, fontSize: 13, padding: '8px 0' } }, text)
}

// ── 深色控制台（状态 / 运维共用）──────────────────────────────
// 状态页与运维页的数据结构不同，但视觉语言一致：深蓝页 + 玻璃卡 + 等宽数字。
// 这些组件只负责「长什么样」，不碰任何取数与写操作。

/** 深色页容器：自己铺满一行，内部再按卡片网格排。 */
function consolePage(props: {
  kicker: string
  title: string
  hint: string
  badge?: any
  children: any[]
}): any {
  return h(
    'div',
    {
      'data-dsh-part': 'console-page',
      style: {
        gridColumn: '1 / -1',
        background: SET_BG,
        borderRadius: 16,
        padding: 24,
        color: SET_TEXT,
        boxShadow: '0 18px 48px rgba(2,8,20,0.42)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        minWidth: 0,
      },
    },
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        },
      },
      h(
        'div',
        null,
        h(
          'div',
          { style: { fontSize: 10, letterSpacing: '0.18em', color: SET_CYAN, textTransform: 'uppercase' } },
          props.kicker,
        ),
        h('h2', { style: { margin: '3px 0 0', fontSize: 20, fontWeight: 600, color: SET_TITLE } }, props.title),
        h('div', { style: { fontSize: 12, color: SET_FAINT, marginTop: 4, lineHeight: 1.6 } }, props.hint),
      ),
      props.badge ?? null,
    ),
    h(
      'div',
      {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',
          gap: 14,
          alignItems: 'start',
        },
      },
      ...props.children,
    ),
  )
}

/** 深色玻璃卡：标题行带发光星标，与设置页同一套观感。 */
function consoleCard(title: string, body: any, extra?: any, full?: boolean): any {
  return h(
    'section',
    {
      style: {
        border: SET_LINE,
        borderRadius: 10,
        padding: '20px',
        background: SET_CARD,
        backgroundImage: SET_CARD_GLOW,
        boxShadow: 'none',
        minWidth: 0,
        gridColumn: full === true ? '1 / -1' : undefined,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 } },
      h(
        'h3',
        {
          style: {
            margin: 0,
            fontSize: 15,
            fontWeight: 600,
            color: SET_TITLE,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          },
        },
        h(
          'span',
          { style: { color: SET_CYAN, fontSize: 11, textShadow: '0 0 10px rgba(79,209,224,0.5)' } },
          '✦',
        ),
        title,
      ),
      extra ?? null,
    ),
    body,
  )
}

/** 深色行：左标签右值，数值用等宽数字，方便纵向扫读。 */
function consoleRow(label: string, value: any, hint?: string): any {
  return h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        fontSize: 12,
        padding: '7px 0',
        borderTop: SET_LINE_SOFT,
      },
    },
    h('span', { style: { color: SET_FAINT, flex: '0 0 auto' } }, label),
    h(
      'span',
      { style: { color: SET_TEXT, textAlign: 'right', wordBreak: 'break-word', fontVariantNumeric: 'tabular-nums' } },
      value,
      hint ? h('span', { style: { color: SET_FAINT, marginLeft: 6, fontSize: 11 } }, hint) : null,
    ),
  )
}

/** 深色指标块：数字大、标签小，用于仪表盘一栏。 */
function consoleTile(label: string, value: any, hint?: string): any {
  return h(
    'div',
    {
      style: {
        border: SET_LINE_SOFT,
        borderRadius: 10,
        padding: '10px 12px',
        background: SET_CARD_SOFT,
        minWidth: 0,
      },
    },
    h('div', { style: { fontSize: 11, color: SET_FAINT } }, label),
    h(
      'div',
      {
        style: {
          fontSize: 22,
          fontWeight: 600,
          color: SET_TITLE,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.3,
        },
      },
      value,
    ),
    hint ? h('div', { style: { fontSize: 11, color: SET_FAINT } }, hint) : null,
  )
}

/** 深色表格：只给单元格加下边框，避免整张表在深色底上像一块白板。 */
function consoleTable(headers: string[], rows: any[][]): any {
  return h(
    'div',
    { style: { overflowX: 'auto' } },
    h(
      'table',
      { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          ...headers.map((head) =>
            h(
              'th',
              {
                key: head,
                style: {
                  textAlign: 'left',
                  padding: '6px 8px',
                  color: SET_FAINT,
                  fontWeight: 500,
                  borderBottom: SET_LINE_SOFT,
                  whiteSpace: 'nowrap',
                },
              },
              head,
            ),
          ),
        ),
      ),
      h(
        'tbody',
        null,
        ...rows.map((cells, rowIndex) =>
          h(
            'tr',
            { key: `${rowIndex}` },
            ...cells.map((cell, cellIndex) =>
              h(
                'td',
                {
                  key: `${cellIndex}`,
                  style: {
                    padding: '6px 8px',
                    borderBottom: SET_LINE_SOFT,
                    color: SET_TEXT,
                    verticalAlign: 'top',
                  },
                },
                cell,
              ),
            ),
          ),
        ),
      ),
    ),
  )
}

/** 深色按钮：默认青色描边；danger 用途红描边（不可逆动作）。 */
function consoleButton(label: string, onClick: () => void, danger?: boolean, disabled?: boolean): any {
  const blocked = disabled === true
  return h(
    'button',
    {
      type: 'button',
      onClick,
      disabled: blocked,
      style: {
        fontSize: 12,
        padding: '6px 12px',
        borderRadius: 8,
        border: `1px solid ${danger === true ? 'rgba(229,120,120,0.6)' : 'rgba(92,173,224,0.4)'}`,
        background: danger === true ? 'rgba(229,120,120,0.12)' : 'rgba(79,209,224,0.10)',
        color: danger === true ? '#f0a0a0' : SET_CYAN,
        cursor: blocked ? 'default' : 'pointer',
        opacity: blocked ? 0.5 : 1,
      },
    },
    label,
  )
}

/**
 * 设置页：上半是「现在就能改」的热开关，下半每个分组一张只读镜像卡，顶部一条锚点。
 * @param props.data 面板快照（settings 分组；prefs 已由服务端合进各 field.value）
 * @param props.onPref 拨开关时把 { prefKey: 新值 } 交给父级去 POST
 * @param props.saving 写入中，用于显示「正在写入…」与置灰
 * 状态：本地 active（锚点高亮）+ refs（各分组 DOM，供 scrollIntoView 用）。
 */
function SettingsTab(props: {
  data: PanelData | null; error: string | null; loading: boolean
  onPref: (key: PrefKey, value: boolean | null) => void
  prefs: Record<PrefKey, PrefState>; onReload: () => void; onNavigate: (tab: string) => void
}): any {
  const [navError, setNavError] = React.useState('')
  const ready = Boolean(props.data && !props.error)
  const effectBadge = (effect: string): any => uiBadge(effect, effect === '未验证' ? undefined : 'ok')
  const prefRow = (key: PrefKey, label: string, help: string, effect: string): any => {
    const state = props.prefs[key]
    const value = props.data?.prefs[key]
    const disabled = !ready || state.pending
    const message = state.pending ? '保存中…' : state.error ?? (state.saved ? '已保存' : '')
    return h('div', { className: 'lb-row', key, 'data-pref-row': key },
      h('div', { className: 'lb-row-label' },
        h('div', { className: 'lb-row-title' }, h('label', { htmlFor: 'lb-pref-' + key }, label), effectBadge(effect)),
        h('div', { className: 'lb-help', id: 'lb-pref-help-' + key }, help)),
      h('div', { className: 'lb-row-value' },
        h('select', {
          id: 'lb-pref-' + key, className: 'lb-select', disabled,
          'aria-busy': state.pending, 'aria-describedby': 'lb-pref-help-' + key + ' lb-pref-status-' + key,
          value: value === undefined ? 'unavailable' : value === null ? 'inherit' : String(value),
          onChange: (event: any) => props.onPref(key, event.target.value === 'inherit' ? null : event.target.value === 'true'),
        }, value === undefined ? h('option', { value: 'unavailable' }, '等待读取') : null,
        key === 'promptSection' ? h('option', { value: 'inherit' }, '跟随配置') : null,
        h('option', { value: 'true' }, '开启'), h('option', { value: 'false' }, '关闭')),
        message ? h('div', { id: 'lb-pref-status-' + key, className: 'lb-save' + (state.error ? ' lb-save-error' : ''), role: state.error ? 'alert' : 'status' }, message) : null))
  }
  const groups = props.data?.settings ?? []
  // 仅使用已有字段；未确认的 apply 描述符不等于热改能力。
  const fields = groups.flatMap((group) => group.fields).filter((field) => !INTERACTIVE_SWITCHES[field.key])
  const fieldRows = (selected: FieldView[], effect: string): any => selected.length
    ? selected.map((field) => uiRow(field.label, h(React.Fragment, null,
        h('div', null, fmtValue(field)), uiBadge('只读'), effectBadge(effect)), field.help))
    : h('p', { className: 'lb-help' }, '当前接口尚未提供这些配置的摘要，请在宿主插件设置中查看。')
  const behavior = props.data?.behavior
  const basic = fields.filter((f) => f.key === 'storage.driver' || f.key === 'storage.db')
  const advanced = fields.filter((f) => !basic.includes(f) && !f.key.startsWith('independence.') && f.key !== 'enabled')
  const individualized = uiSection('个性化', h('div', null,
    prefRow('sea', '显示意识海', '开启后增加意识海入口，按需查看记忆图景。', '即时'),
    prefRow('promptSection', '记忆写入纪律', '跟随配置使用宿主设置；开启或关闭会覆盖该项配置。', '即时'),
    uiRow('插件加载状态', uiBadge('已加载', 'ok'), '此页面仅在插件已加载时可见；启停状态在宿主插件列表中管理。')))
  const runtimeConfig = uiSection('DSH 运行配置', h('div', null,
    behavior ? h(React.Fragment, null,
      uiRow('自动采集', h(React.Fragment, null, behavior.capture ? '开启' : '关闭', effectBadge('重启后')), '启动时加载，修改后重启生效。'),
      uiRow('自动注入', h(React.Fragment, null, behavior.injection ? '开启' : '关闭', effectBadge('重启后')), '按当前上下文的可见范围与预算决定注入内容。'),
      uiRow('最终完整性检查', h(React.Fragment, null, uiBadge('始终开启'), effectBadge('固定')), '这是固定规则，无关闭控件。'))
      : h('p', { className: 'lb-help' }, '运行状态暂不可用。'),
    h('div', { className: 'lb-links' }, uiButton('查看关系', () => props.onNavigate('mood')),
      uiButton('查看 QQ', () => props.onNavigate('qq')))))
  const advancedSection = uiSection('高级与维护', h('div', null,
    fieldRows(basic, '重启后'),
    h('details', { className: 'lb-details' }, h('summary', null, '高级配置摘要'),
      h('p', { className: 'lb-help' }, '这些字段只读展示，不会在这里直接修改；需要改动请进宿主插件设置。'),
      fieldRows(advanced, '未验证'))))
  const hostSection = uiSection('宿主配置', h('div', null,
    h('p', { className: 'lb-help', style: { marginTop: 0 } }, '采集、注入、情绪、QQ 与存储参数在宿主「插件 → 心灵」中修改；保存与重启生效提示由宿主提供。'),
    uiButton('打开 DSH Plugins 页', () => {
      if (!openPluginSettings()) setNavError('请从宿主侧栏打开「插件」，选择「心灵」查看设置。')
    }),
    navError ? h('p', { className: 'lb-help', role: 'status' }, navError) : null), uiBadge('配置摘要只读'))
  return h('div', { className: 'lb-stack', 'data-dsh-part': 'settings-page' },
    !ready ? h('div', { className: 'lb-alert', role: 'status' },
      props.error ? '偏好读取失败，已暂停编辑。' : '正在读取已保存的偏好…', ' ',
      uiButton('重试读取', props.onReload, { disabled: props.loading })) : null,
    individualized, runtimeConfig, advancedSection, hostSection)
}
