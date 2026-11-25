// 心灵 · 浏览器半侧：共享工具（样式、UI 原语、格式化、取数钩子）
//
// 页签组件共同依赖的底座：PANEL_CSS 一次注入、ui*/card/row/pill 等原语、fmt* 格式化、
// usePanel（20 秒轮询面板快照）与 useEndpoint（按 tick 重取只读路由）。


/** 统一读错误体：兼容 `{error:'文案'}` 与 `{ok:false,error:{code,message}}`。 */
const errorMessageOf = (body: any, fallback: string): string => {
  const raw = body && body.error
  if (typeof raw === 'string' && raw) return raw
  if (raw && typeof raw.message === 'string' && raw.message) return raw.message
  const code = body && typeof body.code === 'string' ? body.code : ''
  return code || fallback
}

// UI-1：所有样式限定在 main 内；宿主 token 决定颜色，容器宽度决定布局。
const PANEL_CSS = `
  .lb-panel {
    --lb-bg:var(--dsw-alias-bg-base,#f4f6f9); --lb-panel:var(--dsw-alias-bg-layer-1,#fff);
    --lb-raised:var(--dsw-alias-bg-layer-2,#eef1f5); --lb-text:var(--dsw-alias-label-primary,#182338);
    --lb-muted:var(--dsw-alias-label-secondary,#526078); --lb-line:var(--dsw-alias-border-l1,#dce1e8);
    --lb-line-strong:var(--dsw-alias-border-l2,#aab4c2); --lb-accent:var(--dsw-alias-brand-primary,#4263c7);
    --lb-ok:var(--dsw-alias-state-success-primary,#247547); --lb-warn:var(--dsw-alias-state-warn-primary,#946000);
    --lb-error:var(--dsw-alias-state-error-primary,#b63131);
    --lb-soft:color-mix(in srgb,var(--lb-text) 4%,var(--lb-panel));
    --lb-accent-soft:color-mix(in srgb,var(--lb-accent) 14%,var(--lb-panel));
    --lb-ok-bg:color-mix(in srgb,var(--lb-ok) 12%,var(--lb-panel));
    --lb-warn-bg:color-mix(in srgb,var(--lb-warn) 12%,var(--lb-panel));
    --lb-error-bg:color-mix(in srgb,var(--lb-error) 12%,var(--lb-panel));
    display:flex; flex-direction:column; width:100%; height:100%; min-width:0; min-height:0;
    overflow:hidden; color:var(--lb-text); background:var(--lb-bg); font-size:14px; line-height:1.6;
    container-type:inline-size; container-name:psyche;
  }
  .lb-panel,.lb-panel * { box-sizing:border-box }
  .lb-panel button,.lb-panel select { font:inherit }
  .lb-panel :focus-visible { outline:2px solid var(--lb-accent); outline-offset:3px }
  .lb-header { flex:none; display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:20px 24px 16px; }
  .lb-title-row { display:flex; align-items:center; gap:10px; min-width:0 }
  .lb-header h1 { font-size:20px; font-weight:650; margin:0; line-height:1.3 }
  .lb-header-actions { margin-left:auto; display:flex; flex-wrap:wrap; align-items:center; gap:12px }
  .lb-updated,.lb-help { font-size:12px; color:var(--lb-muted) }
  .lb-tabs { display:flex; flex:none; gap:4px; padding:0 24px; overflow-x:auto; border-bottom:1px solid var(--lb-line); }
  .lb-subnav { display:flex; flex:none; flex-wrap:wrap; gap:8px; padding:10px 24px 0; }
  .lb-subnav button { padding:6px 10px; border:1px solid var(--lb-line); border-radius:8px; background:transparent; color:var(--lb-muted); cursor:pointer; font-size:12px }
  .lb-subnav button:hover { color:var(--lb-text); border-color:var(--lb-accent) }
  /* QQ 运行管理页（v29.65）：状态带 → 两列卡 → 数字条 → 日志 → 指南，都按效果图的排布走，
     但只用宿主 token，不自绘深色与发光。窄屏靠容器查询折成一列，不靠 JS 测量。 */
  .lb-qq-ops { display:flex; flex-direction:column; gap:16px; min-width:0 }
  .lb-qq-band { display:flex; align-items:stretch; flex-wrap:wrap; border:1px solid var(--lb-line); border-radius:10px; background:var(--lb-panel); overflow:hidden }
  .lb-qq-band-main { flex:1 1 300px; display:flex; align-items:center; gap:12px; padding:18px 20px; min-width:0 }
  .lb-qq-band-flow { flex:0 0 auto; display:flex; align-items:center; gap:6px; padding:18px 20px; border-left:1px solid var(--lb-line) }
  .lb-qq-band-action { flex:0 0 auto; display:flex; align-items:center; padding:18px 20px; border-left:1px solid var(--lb-line) }
  .lb-qq-pair { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; align-items:stretch }
  .lb-qq-stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border:1px solid var(--lb-line); border-radius:10px; background:var(--lb-panel); overflow:hidden }
  .lb-qq-stat { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 18px; border-left:1px solid var(--lb-line); min-width:0 }
  .lb-qq-stat:first-child { border-left:0 }
  .lb-qq-stat-label { font-size:11px; color:var(--lb-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
  .lb-qq-stat-value { font-size:22px; font-weight:600; line-height:1.2; font-variant-numeric:tabular-nums }
  .lb-qq-card { display:flex; flex-direction:column; border:1px solid var(--lb-line); border-radius:10px; background:var(--lb-panel); min-width:0 }
  .lb-qq-card-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:14px 18px; border-bottom:1px solid var(--lb-line) }
  .lb-qq-card-head h3 { margin:0; font-size:14px; font-weight:600 }
  .lb-qq-card-body { padding:6px 18px 14px; min-width:0; flex:1 1 auto }
  .lb-qq-card-body > div:first-child > div:first-child { border-top:0 }
  .lb-qq-card-foot { display:flex; align-items:center; gap:8px; padding:12px 18px; border-top:1px solid var(--lb-line) }
  .lb-qq-tabs { display:flex; gap:28px; border-bottom:1px solid var(--lb-line); overflow-x:auto }
  .lb-qq-tabs button { appearance:none; background:transparent; border:0; border-bottom:2px solid transparent; margin-bottom:-1px; padding:10px 2px; color:var(--lb-muted); font-size:13px; cursor:pointer; white-space:nowrap }
  .lb-qq-tabs button:hover { color:var(--lb-text) }
  .lb-qq-tabs button[aria-selected=true] { color:var(--lb-text); border-bottom-color:var(--lb-accent); font-weight:600 }
  .lb-qq-log-head, .lb-qq-log-row { display:grid; grid-template-columns:84px 52px minmax(0,1fr); gap:12px; align-items:baseline }
  .lb-qq-log-head { font-size:11px; color:var(--lb-muted); padding:0 0 8px; border-bottom:1px solid var(--lb-line) }
  .lb-qq-log-row { font-size:11px; padding:7px 0; border-bottom:1px dashed color-mix(in srgb,var(--lb-line) 70%,transparent) }
  .lb-qq-log-row:last-child { border-bottom:0 }
  .lb-qq-log-msg { min-width:0; overflow-wrap:anywhere }
  @container psyche (max-width: 860px) {
    .lb-qq-pair { grid-template-columns:minmax(0,1fr) }
    .lb-qq-band-flow, .lb-qq-band-action { width:100%; border-left:0; border-top:1px solid var(--lb-line) }
    .lb-qq-stats { grid-template-columns:repeat(2,minmax(0,1fr)) }
    .lb-qq-stat:nth-child(3) { border-left:0 }
    .lb-qq-stat:nth-child(n+3) { border-top:1px solid var(--lb-line) }
  }
  .lb-tab { flex:none; appearance:none; background:transparent; border:0; border-bottom:2px solid transparent; color:var(--lb-muted); padding:10px 14px; white-space:nowrap; cursor:pointer; }
  .lb-tab[aria-selected=true] { color:var(--lb-text); background:var(--lb-accent-soft); border-bottom-color:var(--lb-accent); font-weight:600 }
  .lb-canvas { flex:1 1 auto; min-width:0; min-height:0; overflow:auto; overflow-x:hidden; padding:24px; }
  .lb-canvas-sea { padding:0; overflow:hidden; position:relative }
  .lb-stack { display:flex; flex-direction:column; gap:16px; min-width:0 }
  .lb-memory-search { width:100%; box-sizing:border-box; margin:6px 0 4px; }
  .lb-memory-item { padding:8px 0; border-top:1px dashed rgba(127,127,127,0.2); }
  .lb-memory-head { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; font-size:13px; }
  .lb-memory-statement { min-width:0; overflow-wrap:anywhere; }
  .lb-seg { display:inline-flex; gap:4px; flex-wrap:wrap; }
  .lb-seg button[aria-pressed=true] { border-color:var(--lb-accent); color:var(--lb-text); }
  .lb-radar-numbers { display:flex; flex-direction:column; gap:4px; }
  .lb-radar-row { display:flex; justify-content:space-between; gap:10px; font-size:12px; padding:3px 0; border-bottom:1px solid var(--lb-line); }
  .lb-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; align-items:start; min-width:0; }
  .lb-grid > *, .lb-stack > * { min-width:0 }
  .lb-section { padding:20px; border:1px solid var(--lb-line); border-radius:10px; background:var(--lb-panel); overflow-wrap:anywhere; }
  .lb-section-head { display:flex; align-items:center; flex-wrap:wrap; justify-content:space-between; gap:8px; margin-bottom:16px; }
  .lb-section h2,.lb-section h3 { margin:0; font-size:15px; font-weight:600 }
  .lb-metrics { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
  .lb-metric { background:var(--lb-panel); padding:20px; border:1px solid var(--lb-line); border-radius:10px; min-width:0; }
  .lb-metric strong { display:block; margin:8px 0 4px; font-size:28px; line-height:1.2; font-weight:600; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
  .lb-button { appearance:none; display:inline-flex; align-items:center; justify-content:center; gap:8px; min-height:36px; padding:6px 12px; border:1px solid var(--lb-line); border-radius:6px; background:var(--lb-panel); color:var(--lb-text); cursor:pointer; text-decoration:none; }
  .lb-button:hover:not(:disabled), .lb-tab:hover { background:var(--lb-soft) }
  .lb-button-primary { background:var(--lb-accent-soft); border-color:var(--lb-accent); }
  .lb-button:disabled,.lb-select:disabled { opacity:.6; cursor:not-allowed }
  .lb-badge { display:inline-flex; align-items:center; gap:6px; font-size:12px; border-radius:4px; padding:2px 8px; background:var(--lb-soft); color:var(--lb-muted); white-space:nowrap; }
  .lb-badge-ok { color:var(--lb-ok); background:var(--lb-ok-bg) }
  .lb-badge-warn { color:var(--lb-warn); background:var(--lb-warn-bg) }
  .lb-badge-error { color:var(--lb-error); background:var(--lb-error-bg) }
  .lb-alert { padding:12px 16px; border:1px solid var(--lb-line); border-radius:6px; background:var(--lb-error-bg); color:var(--lb-error); overflow-wrap:anywhere; }
  .lb-row { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; padding:16px 0; border-top:1px solid var(--lb-line); }
  .lb-row:first-child { border-top:0; padding-top:0 }
  .lb-row:last-child { padding-bottom:0 }
  .lb-row-label { flex:1; min-width:0 }
  .lb-row-title { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:4px }
  .lb-row-title label { font-weight:500; display:block; margin-bottom:0 }
  .lb-row-value { flex:0 1 48%; min-width:0; text-align:right; overflow-wrap:anywhere; }
  .lb-select { appearance:auto; min-height:36px; max-width:100%; border:1px solid var(--lb-line-strong); border-radius:6px; padding:6px 10px; background:var(--lb-panel); color:var(--lb-text); }
  .lb-save { min-height:20px; font-size:12px; margin-top:4px; color:var(--lb-muted); }
  .lb-save-error { color:var(--lb-error) }
  .lb-filter { display:flex; flex-wrap:wrap; gap:8px }
  .lb-filter [aria-pressed=true] { border-color:var(--lb-accent); background:var(--lb-accent-soft) }
  .lb-links { display:flex; gap:8px; flex-wrap:wrap; margin-top:16px }
  .lb-details > summary { cursor:pointer; padding:12px 0; font-weight:500; }
  .lb-details[open] > summary { margin-bottom:12px }
  .lb-detail-grid > section { box-shadow:none!important; }
  .lb-detail-grid h3 > span:first-child { display:none }
  @container psyche (max-width:899px) {
    .lb-grid,.lb-metrics { grid-template-columns:minmax(0,1fr) }
    .lb-row { flex-direction:column; gap:12px }
    .lb-row-value { flex:auto; width:100%; text-align:left }
    .lb-header { padding:16px; gap:10px }
    .lb-tabs { padding:0 16px }
    .lb-canvas { padding:16px }
    .lb-canvas-sea { padding:0 }
    .lb-section,.lb-metric { padding:16px }
    .lb-updated { display:none }
  }
  @media (pointer:coarse) { .lb-button,.lb-select,.lb-tab { min-height:44px } }
  @media (prefers-reduced-motion:no-preference) { .lb-button,.lb-tab { transition:background-color 150ms,color 150ms } }
`
function uiBadge(label: string, kind = ''): any {
  return h('span', { className: 'lb-badge' + (kind ? ' lb-badge-' + kind : '') }, label)
}
function uiButton(label: string, action: () => void, extra: any = {}): any {
  return h('button', { type: 'button', className: 'lb-button', onClick: action, ...extra }, label)
}
function uiSection(title: string, body: any, extra?: any): any {
  return h('section', { className: 'lb-section' },
    h('div', { className: 'lb-section-head' }, h('h2', null, title), extra), body)
}
function uiRow(label: string, value: any, help?: string): any {
  return h('div', { className: 'lb-row', key: label },
    h('div', { className: 'lb-row-label' }, h('div', null, label), help ? h('div', { className: 'lb-help' }, help) : null),
    h('div', { className: 'lb-row-value' }, value))
}

// 调色板只用半透明灰 + 一绿一红：不判断宿主深浅主题，靠 rgba 灰自适应。
const MUTED = 'var(--lb-muted, var(--dsw-alias-label-secondary))'
const FAINT = MUTED
const LINE = '1px solid var(--lb-line, var(--dsw-alias-border-l1))'
const OK = 'var(--lb-ok, var(--dsw-alias-state-success-primary))'
const BAD = 'var(--lb-error, var(--dsw-alias-state-error-primary))'

/**
 * 通用卡片：标题行（左标题 / 右 extra 插槽）+ 正文，纯展示、无副作用。
 * @param title 标题；@param body 正文节点；@param extra 右侧插槽，常放 pill
 */
function card(title: string, body: any, extra?: any): any {
  return h(
    'section',
    {
      style: {
        border: LINE,
        borderRadius: 10,
        padding: '14px 16px',
        marginBottom: 0,
        background: 'transparent',
        minWidth: 0,
      },
    },
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 8,
          gap: 12,
        },
      },
      h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, title),
      extra ?? null,
    ),
    body,
  )
}

/**
 * 一行键值对：左灰标签 + 右值（可带灰色小字 hint），值允许断行。
 * @param label 左标签；@param value 值节点或文本；@param hint 值后的小字
 */
function row(label: string, value: any, hint?: string): any {
  return h(
    'div',
    {
      key: `${label}`,
      style: {
        display: 'flex',
        gap: 12,
        alignItems: 'baseline',
        justifyContent: 'space-between',
        padding: '4px 0',
        fontSize: 13,
      },
    },
    h('span', { style: { color: MUTED, flex: '0 0 auto' } }, label),
    h(
      'span',
      { style: { textAlign: 'right', wordBreak: 'break-all' } },
      value,
      hint
        ? h('span', { style: { color: FAINT, marginLeft: 6, fontSize: 12 } }, hint)
        : null,
    ),
  )
}

/**
 * 小胶囊徽章。颜色由调用方给（OK / BAD / MUTED 或主题色），纯展示。
 * @param text 徽章文字；@param color 边框与文字同色
 */
function pill(text: string, color: string): any {
  return h(
    'span',
    {
      style: {
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 999,
        border: `1px solid ${color}`,
        color,
        whiteSpace: 'nowrap',
      },
    },
    text,
  )
}

/**
 * 空态占位：一行灰字。所有「还没有数据」都走它，保证空态样式一致。
 * @param text 提示文案
 */
function empty(text: string): any {
  return h(
    'div',
    { style: { color: FAINT, fontSize: 13, padding: '10px 0' } },
    text,
  )
}

/**
 * 开关：checked 严格等于 true 才算开；onToggle 传 null 表示只读（去插件设置页改）。
 * 禁用时保留形状并置灰而不藏起来——让人看得见「这项存在，只是这里改不了」。
 * @param title 悬停说明，常用来解释为什么禁用
 */
function switchBox(checked: boolean, onToggle: (() => void) | null, title?: string): any {
  const on = checked === true
  // 用「有没有传函数」判断可点，不另传 disabled 参数：调用点多，少一个开关少一处错。
  const clickable = typeof onToggle === 'function'
  return h(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': on,
      title: title ?? undefined,
      disabled: !clickable,
      onClick: clickable ? onToggle : undefined,
      style: {
        appearance: 'none',
        flex: '0 0 auto',
        width: 38,
        height: 22,
        padding: 2,
        borderRadius: 999,
        border: `1px solid ${on ? OK : 'rgba(127,127,127,0.45)'}`,
        background: on ? OK : 'transparent',
        cursor: clickable ? 'pointer' : 'not-allowed',
        opacity: clickable ? 1 : 0.45,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: on ? 'flex-end' : 'flex-start',
        transition: 'background 120ms ease, justify-content 120ms ease',
      },
    },
    h('span', {
      style: {
        display: 'block',
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: on ? '#fff' : 'rgba(127,127,127,0.75)',
      },
    }),
  )
}

/**
 * 字节数转人读单位（B / KB / MB，到 MB 封顶）。状态页与运维页共用。
 * @param bytes 任意值；非数字按 0 处理，避免 NaN 直接出现在界面上
 */
function fmtBytes(bytes: any): string {
  const n = typeof bytes === 'number' ? bytes : 0
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/**
 * 把设置字段的原始值转成展示文本：布尔给「开 / 关」，空值给「（空）」。
 * @param field 设置字段；带 unit 时把单位拼在值后面
 */
function fmtValue(field: FieldView): string {
  const value = field.value
  if (typeof value === 'boolean') return value ? '开' : '关'
  if (value === null || value === undefined || value === '') return '（空）'
  const text = String(value)
  return field.unit ? `${text} ${field.unit}` : text
}

// 时间只给两种格式：2026-11-01 20:12:33 / 2026-11-01（本地时区）
/** 两位补零。手写而不用 toLocaleString：不同宿主内核的默认格式并不一致。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * 宽松解析时间：null / 空串 / 非法日期一律返回 null，由调用方统一走 fallback。
 * @param value Date 实例或任意可被 new Date 解析的值
 */
function toDate(value: any): any {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return isNaN(date.getTime()) ? null : date
}

/**
 * 完整时间：2026-11-01 20:12:33（本地时区）。解析失败退回 fallback，再不行给「—」。
 * @param value 原始时间；@param fallback 自定义兜底文案
 */
function fmtTime(value: any, fallback?: string): string {
  const date = toDate(value)
  if (!date) return fallback ?? '—'
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  )
}

/**
 * 只到天：2026-11-01（本地时区）。用于跨度、备份日期这类不需要秒的地方。
 * @param value 原始时间；@param fallback 自定义兜底文案
 */
function fmtDate(value: any, fallback?: string): string {
  const date = toDate(value)
  if (!date) return fallback ?? '—'
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

// ── 数据 ──────────────────────────────────────────────────────
/**
 * 取整包面板快照，并自己管轮询：每 POLL_MS 秒把 tick 推一格，tick 变就重新 fetch。
 * @returns data / error / reload；reload 只是推 tick，不直接发请求
 * 副作用：一个 setInterval + 每 tick 一次 fetch；卸载时两者都收干净。
 */
type PrefKey = 'sea' | 'promptSection'
type PrefState = { pending: boolean; error: string | null; saved: boolean }
const PREF_KEYS: PrefKey[] = ['sea', 'promptSection']
function validPrefs(value: any): value is PanelData['prefs'] {
  return value && typeof value.sea === 'boolean' &&
    (value.promptSection === null || typeof value.promptSection === 'boolean')
}

/** 同一页面生命周期内保留逐项写状态；旧 panel/完整 POST 响应不能覆盖其他项。 */
function usePanel(): {
  data: PanelData | null; error: string | null; loading: boolean; updatedAt: number
  prefs: Record<PrefKey, PrefState>; reload: () => void
  savePref: (key: PrefKey, value: boolean | null) => void
} {
  const [data, setData] = React.useState(null as PanelData | null)
  const [error, setError] = React.useState(null as string | null)
  const [loading, setLoading] = React.useState(true)
  const [updatedAt, setUpdatedAt] = React.useState(0)
  const [tick, setTick] = React.useState(0)
  const [, redraw] = React.useState(0)
  const state = React.useRef({
    data: null as PanelData | null, readable: false, generation: 0,
    versions: { sea: 0, promptSection: 0 },
    prefs: {
      sea: { pending: false, error: null, saved: false },
      promptSection: { pending: false, error: null, saved: false },
    } as Record<PrefKey, PrefState>,
    controllers: new Set<any>(),
  }).current
  const publish = (next: PanelData): void => { state.data = next; setData(next) }
  const reload = (): void => setTick((n: number) => n + 1)

  React.useEffect(() => {
    state.generation++
    return () => { state.generation++; for (const c of state.controllers) c.abort(); state.controllers.clear() }
  }, [])
  React.useEffect(() => {
    let alive = true
    const controller = new browser.AbortController()
    const versions = { ...state.versions }
    state.controllers.add(controller)
    setLoading(true)
    browser.fetch('/api/psyche/panel', { headers: { accept: 'application/json' }, cache: 'no-store', signal: controller.signal })
      .then(async (response: any) => {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const body = await response.json()
        if (!validPrefs(body?.prefs)) throw new Error('PREFS_UNAVAILABLE')
        if (!alive) return
        const prefs = { ...body.prefs }
        for (const key of PREF_KEYS) {
          if (state.data && (state.prefs[key].pending || versions[key] !== state.versions[key])) {
            prefs[key] = state.data.prefs[key]
          }
        }
        publish({ ...body, prefs }); state.readable = true
        setUpdatedAt(Date.now()); setError(null)
      })
      .catch((cause: any) => {
        if (!alive) return
        state.readable = false
        setError(/^HTTP \d+$|^PREFS_UNAVAILABLE$/.test(cause?.message) ? cause.message : '连接失败，请重试')
      })
      .finally(() => { state.controllers.delete(controller); if (alive) setLoading(false) })
    return () => { alive = false; controller.abort(); state.controllers.delete(controller) }
  }, [tick])
  React.useEffect(() => {
    const timer = browser.setInterval(reload, POLL_MS)
    return () => browser.clearInterval(timer)
  }, [])

  const savePref = (key: PrefKey, value: boolean | null): void => {
    if (!PREF_KEYS.includes(key) || !(typeof value === 'boolean' || key === 'promptSection' && value === null)) return
    if (!state.readable || !state.data || state.prefs[key].pending) return
    const generation = state.generation
    const version = ++state.versions[key]
    state.prefs[key] = { pending: true, error: null, saved: false }
    redraw((n: number) => n + 1)
    const controller = new browser.AbortController()
    state.controllers.add(controller)
    const timeout = browser.setTimeout(() => controller.abort(), 15000)
    browser.fetch('/api/psyche/prefs', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ [key]: value }), signal: controller.signal,
    }).then(async (response: any) => {
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.ok !== true || !validPrefs(body?.prefs)) {
        const code = body?.error?.code ?? body?.code
        throw new Error('HTTP ' + response.status + (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ' · ' + code : ' · SAVE_UNCONFIRMED'))
      }
      if (generation !== state.generation || version !== state.versions[key]) return
      // 完整响应中的其他字段可能先于另一个在途写入，只采纳当前字段。
      publish({ ...state.data!, prefs: { ...state.data!.prefs, [key]: body.prefs[key] } })
      state.prefs[key].saved = true
    }).catch((cause: any) => {
      if (generation !== state.generation || version !== state.versions[key]) return
      state.prefs[key].error = /^HTTP \d+/.test(cause?.message)
        ? '保存失败（' + cause.message + '），请重试。'
        : '保存结果未确认，请刷新核对后重试。'
    }).finally(() => {
      browser.clearTimeout(timeout); state.controllers.delete(controller)
      if (generation !== state.generation || version !== state.versions[key]) return
      state.versions[key]++; state.prefs[key].pending = false
      redraw((n: number) => n + 1)
    })
  }
  return { data, error, loading, updatedAt, prefs: state.prefs, reload, savePref }
}

// ── 读数：任意只读接口 ────────────────────────────────────────
// 用量与运维都不在 panel 载荷里（它们各自会扫活会话/扫库），
// 所以单独取、单独刷新——某个接口坏了不影响状态页。
/**
 * 通用只读取数：path 或 tick 一变就重新 fetch，不轮询、不自带定时器。
 * @param path 只读路由（含查询串）；@param tick 外部推动的刷新计数器
 * @returns data / error 各自独立更新；失败时保留旧 data，由调用方决定怎么显示
 */
function useEndpoint<T>(path: string, tick: number): { data: T | null; error: string | null } {
  const [data, setData] = React.useState(null as T | null)
  const [error, setError] = React.useState(null as string | null)
  React.useEffect(() => {
    // 和 usePanel 同样的 alive 守卫：这个 hook 没有定时器，只需防这一处。
    let alive = true
    browser
      .fetch(path, { headers: { accept: 'application/json' } })
      .then((response: any) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
      .then((body: T) => {
        if (!alive) return
        setData(body)
        setError(null)
      })
      .catch((cause: any) => {
        if (!alive) return
        // 只置 error、不 reset data：刷新失败时页面上还有上一次的数字可看。
        setError(cause && cause.message ? cause.message : String(cause))
      })
    return () => {
      alive = false
    }
  }, [path, tick])
  return { data, error }
}

/**
 * 发一个 JSON POST 并拿回解析后的响应体。
 *
 * 与 `useEndpoint` 的分工：那个是「只读取数、自动轮询」，这个是「点了才写」。
 * 失败时抛 Error，调用方负责把 message 显示出来——不要静默吞掉，
 * 恢复流程的每一步都必须让用户看见成功还是失败。
 */
async function postJson(path: string, body: unknown): Promise<any> {
  const response = await browser.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  let payload: any = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok || (payload && payload.ok === false)) {
    const message = payload && (payload.error || payload.message)
    throw new Error(message ? String(message) : `HTTP ${response.status}`)
  }
  return payload
}

/** 恢复状态（`GET /api/psyche/restore/status`）：是否有待恢复任务 + 当前数据是空还是非空。 */
interface RestoreStatusView {
  ok: boolean
  pending: boolean
  note: string
  journal:
    | {
        restoreId: string
        packageId: string
        phase: string
        stagingPath: string
        oldPath: string
        preRestoreArchive: string
        mode: 'adopt' | 'overwrite'
        requestedAt: string
      }
    | null
  target: {
    state: 'empty' | 'used' | 'unknown'
    totalRows: number
    reasons: string[]
  } | null
  boot?: { restoreError: string | null; bootError: string | null }
}

/** 金额拆分：total = peak + off；estimatedCount 是其中被估算的调用次数。 */
interface UsageCostView {
  total: number
  currency: string
  symbol: string
  peak: number
  off: number
  estimatedCount: number
}
/** 单个会话的累计用量。label 由服务端给，可能只是 id 的前缀。 */
interface UsageSessionView {
  sessionId: string
  label: string
  calls: number
  turns: number
  steps: number
  tokens: number
  hitRate: number
  buckets: {
    cacheMiss: number
    cacheHit: number
    cacheWrite: number
    output: number
    reasoning: number
  }
  cost: UsageCostView
  lastAt: number
}
/** 一小时的用量桶；at 是这一小时的起始毫秒时间戳，tier 是这一小时所属的计价档位。 */
interface UsageHourView {
  at: number
  tokens: number
  cost: number
  calls: number
  tier: 'peak' | 'off'
}
/**
 * GET /api/psyche/usage 的快照。priceTable 是「每百万 token 单价」，
 * 只用来把 token 折算成钱给人看，不参与任何调度或判据。
 */
interface UsageView {
  ok: boolean
  at: number
  windowHours: number
  priceTable: {
    version: number
    currency: string
    symbol: string
    peakMultiplier: number
    tier: string
    tierLabel: string
    model: string
    modelLabel: string
    estimated: boolean
    cacheHit: number
    cacheMiss: number
    output: number
  }
  totals: {
    calls: number
    sessions: number
    turns: number
    steps: number
    buckets: {
      cacheMiss: number
      cacheHit: number
      cacheWrite: number
      output: number
      reasoning: number
    }
    tokens: number
    hitRate: number
    cost: UsageCostView
    avgCostPerTurn: number
  }
  bySession: UsageSessionView[]
  byHour: UsageHourView[]
  notes: string[]
}
/** 一次工具调用的审计记录（只追加，面板删不掉）。 */
interface OpsOperationView {
  opId: string
  tool: string
  status: string
  durationMs: number | null
  error: string | null
  createdAt: string
}
/** 引擎日志一行。它活在内存里，所以「清空日志」是唯一能真删的东西。 */
interface OpsLogView {
  at: string
  level: string
  scope: string
  message: string
}
/** 一个备份文件：由 VACUUM INTO 产出，不动当前正在用的库。 */
interface OpsBackupView {
  file: string
  bytes: number
  at: string
}
/** GET /api/psyche/ops 的快照：健康、计数、最近操作、日志、备份五块。 */
interface OpsView {
  ok: boolean
  at: number
  health: {
    driver: string
    userVersion: number
    tables: number
    journalMode: string
    synchronous: number
    bytes: number
    queries: number
    slowQueries: number
    maxQueryMs: number
  } | null
  counters: {
    sources: number
    events: number
    artifacts: number
    artifactRevisions: number
    operations: number
    phaseMilestones: number
  }
  operations: {
    recent: OpsOperationView[]
    total: number
    failed: number
    slowCount: number
  }
  logs: OpsLogView[]
  logCounts: { total: number; warn: number; error: number }
  backups: OpsBackupView[]
  note: string
}

/**
 * 迁移包列表（`GET /api/psyche/archives`）。
 * `verified` 为 null 表示服务端还没验过；false 说明这个包打不开或被改过，不能拿去恢复。
 */
interface ArchivesView {
  ok: boolean
  rows: {
    name: string
    file: string
    bytes: number
    at: string
    verified: boolean | null
    files: number | null
    schemaVersion: number | null
  }[]
  note?: string
  error?: string
  schemaVersion: number | null
  pluginVersion: string
}

/**
 * 金额文案：一律两位小数（保留到分）。
 *
 * 为什么不再按大小换精度：页面上同时出现总额、单会话、单小时三种金额，
 * 小数位不一致会让人误以为「这一项比那一项精确」。金额只到分，多的位数没人看，
 * 还会把窄栏撑破；真要看更细的差别，去看 token 数。
 * @param value 金额；@param symbol 货币符号，缺省 ¥
 */
function moneyText(value: any, symbol?: string): string {
  const unit = symbol || '¥'
  const n = Number(value) || 0
  return `${unit}${n.toFixed(2)}`
}

/** token 数折成「万 / 亿」，否则一长串数字会把右栏撑破。 */
function tokensText(value: any): string {
  const n = Number(value) || 0
  if (n >= 100000000) return `${(n / 100000000).toFixed(2)} 亿`
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`
  return String(n)
}

/** 字节数到 GB。和 fmtBytes 分开写：运维页要 GB 这一档，状态页到 MB 就够。 */
function bytesText(value: any): string {
  const n = Number(value) || 0
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/** 0~1 的比率转百分比文本，默认 1 位小数。 */
function percentText(value: any, digits?: number): string {
  const n = Number(value) || 0
  return `${(n * 100).toFixed(digits ?? 1)}%`
}

/**
 * 迷你条形图：宽度是相对 max 的百分比，用来看「哪一小时最费 token」。
 * @param value 当前值；@param max 参照最大值；@param color 条的颜色
 */
function miniBar(value: number, max: number, color: string): any {
  // max<=0 时画空条而不是除零；下限 2% 保证非零值仍然看得见一条细线。
  const pct = max > 0 ? Math.max(2, Math.min(100, Math.round((value / max) * 100))) : 0
  return h(
    'div',
    {
      style: {
        height: 5,
        borderRadius: 3,
        background: 'rgba(127,127,127,0.16)',
        overflow: 'hidden',
        marginTop: 3,
      },
    },
    h('div', { style: { width: `${pct}%`, height: '100%', background: color } }),
  )
}

/**
 * 极简表格：headers 一行、rows 若干行。不做排序、不做虚拟滚动——行数由调用方先截好。
 * @param headers 表头文案；@param rows 每格是节点或文本
 */
function table(headers: string[], rows: any[][]): any {
  return h(
    'div',
    // 横向滚动只发生在表格自己身上，不把整页撑宽。
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
          headers.map((label) =>
            h(
              'th',
              {
                key: label,
                style: {
                  textAlign: 'left',
                  padding: '6px 8px',
                  color: MUTED,
                  fontWeight: 500,
                  borderBottom: LINE,
                  whiteSpace: 'nowrap',
                },
              },
              label,
            ),
          ),
        ),
      ),
      h(
        'tbody',
        null,
        rows.map((cells, index) =>
          h(
            'tr',
            { key: `${index}` },
            cells.map((cell, column) =>
              h(
                'td',
                {
                  key: `${column}`,
                  style: {
                    padding: '6px 8px',
                    borderBottom: '1px solid rgba(127,127,127,0.12)',
                    whiteSpace: 'nowrap',
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

/**
 * 接口返回的 notes 列表，每条一行「· 」。空数组时返回 null 让 JSX 直接跳过。
 * @param notes 备注文案；可以是 undefined（旧服务端不给这个字段）
 */
function notesBlock(notes: string[] | undefined): any {
  if (!notes || notes.length === 0) return null
  return h(
    'div',
    { style: { marginTop: 10, fontSize: 12, color: FAINT, lineHeight: 1.6 } },
    notes.map((note, index) => h('div', { key: `${index}` }, `· ${note}`)),
  )
}
