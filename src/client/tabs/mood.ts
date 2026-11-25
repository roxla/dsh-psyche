// 心灵 · 浏览器半侧：情绪页（雷达卡、趋势图、维度切换）
//
// 图表能力由 assets/echarts.min.js 提供，这里只负责按主题组装 option。

function ensureEcharts(): Promise<any> {
  if (echartsLoader) return echartsLoader
  // 根 tsconfig 不带 DOM lib（这份客户端文件也会被它编到），所以 DOM 一律从 globalThis 取。
  const globalAny = globalThis as any
  const win = globalAny.window
  const doc = globalAny.document
  echartsLoader = new Promise((resolveChart, rejectChart) => {
    const existing = win ? win.echarts : null
    if (existing) {
      resolveChart(existing)
      return
    }
    if (!doc || !doc.createElement) {
      rejectChart(new Error('当前环境没有 document，无法加载图表脚本'))
      return
    }
    const script = doc.createElement('script')
    script.src = '/psyche/echarts.js'
    script.async = true
    script.onload = () => {
      const loaded = win ? win.echarts : null
      if (loaded) resolveChart(loaded)
      else rejectChart(new Error('echarts 已加载但没有挂到 window'))
    }
    script.onerror = () => rejectChart(new Error('加载 /psyche/echarts.js 失败'))
    doc.head.appendChild(script)
  })
  return echartsLoader
}

/**
 * 一张 ECharts 画布卡：挂载时惰性加载 ECharts，容器尺寸变化时 resize。
 * @param option  ECharts option（占位数据由调用方给）
 * @param height  画布高度（px）
 * @param hint    图下方的一行说明（例如「P3 后接真实数据」）
 */
function EChartBox(props: { option: any; height?: number; hint?: string }): any {
  const ref = React.useRef(null as any)
  const optionKey = JSON.stringify(props.option)
  const [failed, setFailed] = React.useState(false)
  const chartRef = React.useRef(null as any)
  const latestOption = React.useRef(props.option)
  latestOption.current = props.option

  React.useEffect(() => {
    let disposed = false
    let observer: any = null
    let themeObserver: any = null
    let frame: any = null
    const redraw = (): void => {
      if (!disposed && chartRef.current && ref.current) {
        chartRef.current.setOption(resolveChartTheme(latestOption.current, ref.current), true)
      }
    }
    void ensureEcharts()
      .then((echarts) => {
        if (disposed || !ref.current) return
        const chart = echarts.init(ref.current, null, { renderer: 'canvas' })
        chartRef.current = chart
        redraw()
        const ResizeObserverCtor = (globalThis as any).ResizeObserver
        if (typeof ResizeObserverCtor === 'function') {
          observer = new ResizeObserverCtor(() => {
            try {
              chart.resize()
            } catch {
              // 容器已被卸载时忽略
            }
          })
          observer.observe(ref.current)
        }
        if (browser.MutationObserver && browser.document?.documentElement) {
          themeObserver = new browser.MutationObserver(() => {
            if (frame !== null) browser.cancelAnimationFrame(frame)
            frame = browser.requestAnimationFrame(() => { frame = null; redraw() })
          })
          themeObserver.observe(browser.document.documentElement, { attributes: true })
        }
      })
      .catch(() => {
        if (!disposed) setFailed(true)
      })
    return () => {
      disposed = true
      if (observer) observer.disconnect()
      if (themeObserver) themeObserver.disconnect()
      if (frame !== null) browser.cancelAnimationFrame(frame)
      if (chartRef.current) {
        try {
          chartRef.current.dispose()
        } catch {
          // 已销毁
        }
        chartRef.current = null
      }
    }
  }, [])

  // option 变化时只更新数据，不重建实例：重建会丢动画、也会闪。
  React.useEffect(() => {
    if (chartRef.current) {
      try {
        chartRef.current.setOption(resolveChartTheme(props.option, ref.current), true)
      } catch {
        // 图表已卸载
      }
    }
  }, [optionKey])

  return h(
    'div',
    null,
    failed
      ? h(
          'div',
          {
            style: {
              height: `${props.height ?? 180}px`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              color: SET_FAINT,
            },
          },
          '图表加载失败（宿主没有出 /psyche/echarts.js）',
        )
      : h('div', { ref, style: { width: '100%', height: `${props.height ?? 180}px` } }),
    props.hint
      ? h('div', { style: { marginTop: 6, fontSize: 11, color: SET_FAINT } }, props.hint)
      : null,
  )
}

/** Canvas 不解析 CSS 变量；按当前宿主主题解析后交给 ECharts。 */
function resolveChartTheme(option: any, element: any): any {
  const style = browser.getComputedStyle(element)
  const walk = (value: any): any => {
    if (typeof value === 'string' && /^var\(--lb-[a-z-]+\)$/.test(value)) {
      return style.getPropertyValue(value.slice(4, -1)).trim()
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
    return value
  }
  return walk(option)
}

/** 图表与页面共用宿主主题。 */
function chartTheme(extra?: any): any {
  return {
    backgroundColor: 'transparent',
    textStyle: { color: 'var(--lb-muted)', fontSize: 12 },
    ...extra,
  }
}

/**
 * 情绪趋势：只画真实写入快照（一次 applyMood = 一个点），不做插值、不补时间点。
 * 时间轴用 time 类型，快照之间不均匀的时间间隔按真实时间呈现。
 * @param history 服务端按 op_id 还原好的快照（旧→新）；@param dimension 当前选中的维度 key
 */
function chartMoodOption(
  history: { at: string; values: Record<string, number> }[],
  dimension: string,
): any {
  const points: [number, number][] = []
  for (const snapshot of history) {
    const value = snapshot.values[dimension]
    const at = Date.parse(snapshot.at)
    if (!Number.isFinite(value) || !Number.isFinite(at)) continue
    points.push([at, value])
  }
  return chartTheme({
    grid: { left: 34, right: 14, top: 18, bottom: 26 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: 'var(--lb-line)' } },
      axisLabel: { color: 'var(--lb-muted)', hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      splitLine: { lineStyle: { color: 'var(--lb-line)' } },
      axisLabel: { color: 'var(--lb-muted)' },
    },
    series: [
      {
        type: 'line',
        smooth: false,
        symbol: 'circle',
        symbolSize: 6,
        connectNulls: false,
        data: points,
        lineStyle: { color: 'var(--lb-accent)', width: 2 },
        itemStyle: { color: 'var(--lb-accent)' },
      },
    ],
  })
}

/**
 * B4 情绪区：当前语气 + 33 维衰减值 + 真实写入趋势。
 *
 * 只读：只打 GET /api/psyche/mood；接口失败显示空态，不渲染假数字。
 * 数据每轮随 stamp（面板轮询）刷新，不单独起定时器。
 */
function MoodSection(props: { stamp: number }): any {
  const { data, error } = useEndpoint<MoodView>('/api/psyche/mood?limit=60', props.stamp)
  const [dimension, setDimension] = React.useState('happy')
  const card = consoleCard

  if (error) {
    return card('情绪状态', h('div', { style: { color: BAD, fontSize: 12 } }, '暂时读不到情绪状态，稍后自动重试'), null, true)
  }
  if (!data) {
    return card('情绪状态', h('div', { style: { color: MUTED, fontSize: 12 } }, '读取中…'), null, true)
  }

  const tone = data.tone
  const allDimensions = [...data.groups.basic, ...data.groups.compound, ...data.groups.contemporary]
  const selected = allDimensions.find((item) => item.key === dimension) ?? allDimensions[0]

  const toneBlock = h(
    'div',
    { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
    h('span', { style: { fontSize: 30, fontWeight: 700 } }, tone.tone),
    tone.secondary ? h('span', { style: { color: MUTED, fontSize: 13 } }, `略带${tone.secondary}`) : null,
    h('span', { style: { color: FAINT, fontSize: 12 } }, '由当前有效值实时投影；只影响措辞，不改变事实与权限'),
  )

  const dimensionRow = (item: MoodDimensionView): any =>
    h(
      'div',
      {
        key: item.key,
        title: `${item.key} · 基线 ${item.baseline} · 半衰期 ${item.halfLifeHours}h`,
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          gap: 8,
          padding: '3px 0',
          borderBottom: LINE,
          fontSize: 12,
        },
      },
      h('span', { style: { color: MUTED } }, item.label),
      h('span', null, item.value.toFixed(1)),
    )

  const groupBlock = (title: string, items: MoodDimensionView[]): any =>
    h(
      'div',
      { key: title, style: { minWidth: 0 } },
      h('div', { style: { color: FAINT, fontSize: 11, marginBottom: 4 } }, `${title} · ${items.length}`),
      h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(110px,1fr))', columnGap: 14 } },
        items.map(dimensionRow),
      ),
    )

  const options = allDimensions.map((item) =>
    h('option', { key: item.key, value: item.key }, `${item.label} ${item.key}`),
  )
  const chart = data.history.length
    // 用 h(EChartBox) 而不是直接调用：EChartBox 内部有 hooks，
    // 这里的分支会让 hook 数量随数据变化，直接调用会触发 React #310。
    ? h(EChartBox, { key: 'mood-chart', option: chartMoodOption(data.history, dimension), height: 200 })
    : h(
        'div',
        { style: { color: FAINT, fontSize: 12, padding: '18px 0' } },
        '还没有情绪写入记录；不补造过去的时间点。',
      )

  return h(
    React.Fragment,
    null,
    card('当前情绪', toneBlock, darkPill('实时投影', SET_GREEN)),
    card(
      '情绪维度',
      h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,230px),1fr))', gap: 14 } },
        groupBlock('基础', data.groups.basic),
        groupBlock('复合', data.groups.compound),
        groupBlock('当代', data.groups.contemporary),
      ),
      null,
      true,
    ),
    card(
      '情绪趋势',
      h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
          h(
            'span',
            { style: { color: FAINT, fontSize: 12 } },
            selected ? `当前 ${selected.label} ${selected.value.toFixed(1)}` : '',
          ),
          h('span', { style: { flex: '1 1 auto' } }),
          h(
            'select',
            {
              value: dimension,
              onChange: (event: any) => setDimension(event.target.value),
              style: {
                appearance: 'none',
                background: 'transparent',
                border: LINE,
                borderRadius: 6,
                color: 'inherit',
                padding: '3px 8px',
                fontSize: 12,
              },
            },
            options,
          ),
        ),
        chart,
        h(
          'div',
          { style: { color: FAINT, fontSize: 11, marginTop: 6 } },
          `只画真实写入快照（${data.history.length}/${data.historyTotal} 次），不插值、不补时间点；时间按本地时区显示。`,
        ),
      ),
      darkPill('只读', SET_FAINT),
      true,
    ),
  )
}

/**
 * 关系页：列出已建档的联系人、平台与好感档位。
 * @param props.data 面板快照；contacts 缺省时按空列表处理
 * 纯展示、无副作用。
 */
/**
 * 情绪页（UI-2b）：八维雷达/数字切换 + 当前表达 + 关系与成长摘要。
 * 八维只与各自 baseline 比较；原始 0–100 值不在同一个尺度上，不跨维相加。
 */
const MOOD_RADAR_DIMS: { key: string; label: string }[] = [
  { key: 'calm', label: '平静' },
  { key: 'happy', label: '开心' },
  { key: 'curious', label: '好奇' },
  { key: 'focused', label: '专注' },
  { key: 'anxious', label: '焦虑' },
  { key: 'irritated', label: '烦躁' },
  { key: 'down', label: '低落' },
  { key: 'tired', label: '疲惫' },
]

function radarPoint(index: number, total: number, ratio: number, radius: number): { x: number; y: number } {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / total
  return { x: 120 + Math.cos(angle) * radius * ratio, y: 120 + Math.sin(angle) * radius * ratio }
}

function MoodRadarCard(props: { stamp: number }): any {
  const { data, error } = useEndpoint<MoodView>('/api/psyche/mood?limit=1', props.stamp)
  const [mode, setMode] = React.useState(() => {
    try { return (globalThis as any).innerWidth >= 900 ? 'radar' : 'number' } catch { return 'number' }
  })
  if (error) return card('情绪八维', h('div', { className: 'lb-help' }, '暂时读不到情绪状态，稍后自动重试。'))
  if (!data) return card('情绪八维', h('div', { className: 'lb-help' }, '读取中…'))
  const all = [...data.groups.basic, ...data.groups.compound, ...data.groups.contemporary]
  const rows = MOOD_RADAR_DIMS.map((dim) => {
    const item = all.find((entry) => entry.key === dim.key)
    const value = item ? item.value : 0
    const baseline = item ? item.baseline : 0
    const ratio = Math.max(0, Math.min(1, 0.5 + 0.5 * ((value - baseline) / Math.max(1, baseline || 1))))
    return { ...dim, value, baseline, ratio }
  })
  const grid = [0.33, 0.66, 1].map((ratio) =>
    h('polygon', {
      key: 'ring-' + ratio,
      points: rows.map((_, index) => { const point = radarPoint(index, rows.length, ratio, 78); return `${point.x},${point.y}` }).join(' '),
      fill: 'none', stroke: 'rgba(127,127,127,0.28)', 'stroke-width': 1,
    }))
  const axis = rows.map((_, index) => {
    const edge = radarPoint(index, rows.length, 1, 78)
    return h('line', { key: 'axis-' + index, x1: 120, y1: 120, x2: edge.x, y2: edge.y, stroke: 'rgba(127,127,127,0.22)', 'stroke-width': 1 })
  })
  const shape = h('polygon', {
    points: rows.map((row, index) => { const point = radarPoint(index, rows.length, row.ratio, 78); return `${point.x},${point.y}` }).join(' '),
    fill: 'rgba(127,170,255,0.22)', stroke: 'rgba(127,170,255,0.9)', 'stroke-width': 2,
  })
  const labels = rows.map((row, index) => {
    const point = radarPoint(index, rows.length, 1.2, 78)
    return h('text', { key: 'label-' + row.key, x: point.x, y: point.y, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 11, fill: MUTED }, row.label)
  })
  const radar = h('svg', { viewBox: '0 0 240 240', width: '100%', style: { maxWidth: 300, display: 'block', margin: '0 auto' }, role: 'img', 'aria-label': '八维情绪雷达（相对各自基线）' },
    grid, axis, shape, labels)
  const numbers = h('div', { className: 'lb-radar-numbers' }, rows.map((row) => {
    const delta = row.value - row.baseline
    const sign = delta > 0 ? '+' : ''
    return h('div', { key: row.key, className: 'lb-radar-row' },
      h('span', { className: 'lb-help' }, row.label),
      h('span', null, `${row.value.toFixed(1)}（基线 ${row.baseline.toFixed(0)}，${sign}${delta.toFixed(1)}）`))
  }))
  const toggle = h('div', { className: 'lb-seg' },
    uiButton('雷达', () => setMode('radar'), { 'aria-pressed': mode === 'radar' }),
    uiButton('数字', () => setMode('number'), { 'aria-pressed': mode === 'number' }))
  return card('情绪八维', h('div', null, toggle,
    h('div', { className: 'lb-help', style: { margin: '6px 0 8px' } }, '每个维度只与自身基线比较；不跨维相加，也不输出综合分。'),
    mode === 'radar' ? radar : numbers), darkPill('实时投影', SET_GREEN))
}

function MoodTab(props: { data: PanelData; stamp: number }): any {
  const growth = props.data.growth
  const growthCard = growth
    ? card('成长阶段', h('div', null,
        h('div', { style: { fontSize: 15, fontWeight: 600 } }, `${growth.stageLabel}（${growth.stage}）`),
        h('div', { className: 'lb-help', style: { marginTop: 4 } }, `阶段自 ${fmtTime(growth.since, '未知')}；瓶颈：${growth.bottleneck || '暂无'}。`),
        h('div', { className: 'lb-help', style: { marginTop: 4 } }, '成长确认仍走既有 CLI/审批；本页只读。')))
    : card('成长阶段', h('div', { className: 'lb-help' }, '数据库未就绪，暂不显示成长阶段。'))
  return h(React.Fragment, null,
    h(MoodRadarCard, { stamp: props.stamp }),
    h(MoodSection, { stamp: props.stamp }),
    growthCard,
    h(ContactsTab, { data: props.data }))
}
