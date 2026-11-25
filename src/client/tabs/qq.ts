// 心灵 · 浏览器半侧：QQ 只读页（计数、联系人、模型、事件、日志）


/**
 * QQ 只读管理页：连接/账号/授权/计数/活动/日志。
 * 全部数据来自 GET /api/psyche/qq；本页不发任何写请求，「清屏」也只清本地显示。
 */
function QqAdminTab(props: { stamp: number }): any {
  const BAD = '#f0a0a0'
  const OK = SET_GREEN
  const MUTED = SET_FAINT
  const FAINT = SET_FAINT
  const LINE = SET_LINE_SOFT
  const card = consoleCard
  const row = consoleRow
  const pill = darkPill
  // 第 45 轮之后的布局收整：卡片统一成「头 / 体 / 底」三段，头的右侧放状态胶囊或「查看全部」，
  // 底部只放动作按钮——这样两列卡等高、行首尾对齐，不再是「按钮混在数据行里」。
  const qqCard = (title: string, body: any, extra?: any, foot?: any): any =>
    h(
      'section',
      { className: 'lb-qq-card' },
      h('div', { className: 'lb-qq-card-head' }, h('h3', null, title), extra ?? null),
      h('div', { className: 'lb-qq-card-body' }, body),
      foot ? h('div', { className: 'lb-qq-card-foot' }, foot) : null,
    )

  const { data, error } = useEndpoint<QqAdminView>('/api/psyche/qq', props.stamp)
  // 暂停只冻结「显示」；数据仍在后台轮询，继续时不丢这段日志。
  const [paused, setPaused] = React.useState(false)
  const [frozen, setFrozen] = React.useState(null as QqAdminView['logs'] | null)
  const [level, setLevel] = React.useState('all' as 'all' | 'info' | 'warn' | 'error')
  // 清屏是纯客户端动作：记下清屏时的最大 seq，只过滤显示，不发请求。
  const [clearedSeq, setClearedSeq] = React.useState(0)
  // 默认只看连接/授权/计数；日志与诊断收进「高级诊断」，避免同屏两份表格。
  const [showAdvanced, setShowAdvanced] = React.useState(false)
  // 启动指南默认收起：它是排障时才看的分步说明，不是首屏该占位的内容。
  const [showGuide, setShowGuide] = React.useState(false)
  // P8-4：QQ 页五段只读视图——运行管理 / 联系人策略 / 模型与推理 / 诊断事件 / 运行日志。
  // 段名与内嵌控制中心的 view 一一对应（见 SECTION_VIEW），横向子导航同时驱动 iframe。
  const [qqSection, setQqSection] = React.useState('ops' as 'ops' | 'contacts' | 'model' | 'events' | 'logs')
  // P8-FINAL：控制中心内嵌在 QQ 页；页面只保存带 fragment 的地址，不展示令牌。
  const [controlMsg, setControlMsg] = React.useState('')
  const [controlBusy, setControlBusy] = React.useState(false)
  const [controlUrl, setControlUrl] = React.useState('')
  // 握手与尺寸：iframe 发 ready 前不投递视图（消息会丢），高度由内部页面回传，避免写死 720。
  const [controlReady, setControlReady] = React.useState(false)
  const [controlHeight, setControlHeight] = React.useState(720)
  const controlFrame = React.useRef(null as any)
  // 工作区卡（第一批 · 五态）：只读展示宿主实际状态；改名字表单位于内嵌控制中心。
  const [workspaceCard, setWorkspaceCard] = React.useState(null as QqWorkspaceCardView | null)
  const [workspaceError, setWorkspaceError] = React.useState(null as string | null)
  const workspaceFetchedAt = React.useRef(0)

  // 诊断事件：只读内存环，seq 游标分页；筛选参数直接交给服务端严格校验。
  const [diag, setDiag] = React.useState(null as QqDiagnosticPageView | null)
  const [diagError, setDiagError] = React.useState(null as string | null)
  const [diagLoading, setDiagLoading] = React.useState(false)
  const [filterDirection, setFilterDirection] = React.useState('all')
  const [filterTarget, setFilterTarget] = React.useState('all')
  const [filterResult, setFilterResult] = React.useState('all')
  const [filterContact, setFilterContact] = React.useState('')
  const [filterRoom, setFilterRoom] = React.useState('')
  const [filterFrom, setFilterFrom] = React.useState('')
  const [filterTo, setFilterTo] = React.useState('')

  const diagnosticParams = (before?: number | null): string => {
    const params = new URLSearchParams()
    params.set('limit', '50')
    if (before !== null && before !== undefined) params.set('before', String(before))
    if (filterDirection !== 'all') params.set('direction', filterDirection)
    if (filterTarget !== 'all') params.set('target', filterTarget)
    if (filterResult !== 'all') params.set('result', filterResult)
    if (filterContact.trim()) params.set('contactRef', filterContact.trim())
    if (filterRoom.trim()) params.set('roomRef', filterRoom.trim())
    const from = filterFrom ? new Date(filterFrom) : null
    const to = filterTo ? new Date(filterTo) : null
    if (from && Number.isFinite(from.getTime())) params.set('from', from.toISOString())
    if (to && Number.isFinite(to.getTime())) params.set('to', to.toISOString())
    return params.toString()
  }

  React.useEffect(() => {
    let alive = true
    setDiagLoading(true)
    browser
      .fetch(`/api/psyche/qq/diagnostics?${diagnosticParams()}`, { headers: { accept: 'application/json' } })
      .then(async (response: any) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(errorMessageOf(body, `HTTP ${response.status}`))
        return body as QqDiagnosticPageView
      })
      .then((body: QqDiagnosticPageView) => {
        if (!alive) return
        setDiag(body)
        setDiagError(null)
      })
      .catch((cause: any) => {
        if (!alive) return
        setDiagError(cause && cause.message ? cause.message : String(cause))
      })
      .finally(() => {
        if (alive) setDiagLoading(false)
      })
    return () => {
      alive = false
    }
  }, [props.stamp, filterDirection, filterTarget, filterResult, filterContact, filterRoom, filterFrom, filterTo])

  const loadMoreDiagnostics = () => {
    if (!diag || diag.nextBefore === null || diagLoading) return
    setDiagLoading(true)
    browser
      .fetch(`/api/psyche/qq/diagnostics?${diagnosticParams(diag.nextBefore)}`, { headers: { accept: 'application/json' } })
      .then(async (response: any) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(errorMessageOf(body, `HTTP ${response.status}`))
        return body as QqDiagnosticPageView
      })
      .then((body: QqDiagnosticPageView) => {
        setDiag((previous: QqDiagnosticPageView | null) => {
          if (!previous) return body
          const seen = new Set(previous.items.map((item: QqDiagnosticEventView) => item.seq))
          return {
            ...body,
            items: previous.items.concat(body.items.filter((item: QqDiagnosticEventView) => !seen.has(item.seq))),
          }
        })
        setDiagError(null)
      })
      .catch((cause: any) => setDiagError(cause && cause.message ? cause.message : String(cause)))
      .finally(() => setDiagLoading(false))
  }

  const RESULT_LABEL: Record<string, string> = {
    accepted: '已接受',
    delivered: '已投递',
    rejected: '已拒绝',
    rate_limited: '限频丢弃',
    out_of_scope: '超范围丢弃',
    deduplicated: '重复丢弃',
    failed: '发送失败',
    unknown: '结果未知',
  }
  const QUOTE_LABEL: Record<string, string> = {
    applied: '引用成功',
    'omitted-unbound': '引用未绑定',
    'omitted-unsupported': '引用不支持',
  }

  const logs: QqAdminView['logs'] = frozen ?? data?.logs ?? []
  const visible = logs
    .filter((item: QqAdminView['logs'][number]) => item.seq > clearedSeq)
    .filter((item: QqAdminView['logs'][number]) => level === 'all' || item.level === level)
    .slice(-200)
    .reverse()

  const togglePause = () => {
    if (paused) {
      setPaused(false)
      setFrozen(null)
    } else {
      setPaused(true)
      setFrozen(data?.logs ?? [])
    }
  }

  const connectionLabel =
    data === null
      ? '读取中'
      : data.enabled === false
        ? '未启用'
        : data.connection === 'connected'
          ? '已连接'
          : data.connection === 'degraded'
            ? '连接异常'
            : data.connection === 'disconnected'
              ? '未连接'
              : '状态未知'

  const openControl = () => {
    if (controlBusy) return
    setControlBusy(true)
    setControlMsg('')
    browser
      .fetch('/api/psyche/qq/control/embed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(async (response: any) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(errorMessageOf(body, `HTTP ${response.status}`))
        if (!body || typeof body.url !== 'string' || !body.url) throw new Error('控制中心没有返回地址')
        setControlUrl(body.url)
        setControlMsg('控制中心已加载')
      })
      .catch((cause: any) => setControlMsg(`打开失败：${cause && cause.message ? cause.message : String(cause)}`))
      .finally(() => setControlBusy(false))
  }

  // 段名 → 控制中心视图。五个值在两边都是固定集合，不把用户输入拼进去。
  const SECTION_VIEW: Record<string, string> = {
    ops: 'status',
    contacts: 'access',
    model: 'model',
    events: 'events',
    logs: 'logs',
  }
  // 父页只向已校验的控制中心 URL 的精确 origin 发消息；解析失败才退回 '*'（不该发生）。
  const controlOrigin = (() => {
    if (!controlUrl) return null
    try {
      return new URL(controlUrl).origin
    } catch {
      return null
    }
  })()

  // 新地址等于新页面：握手状态与高度都要重置，否则会拿旧页面的 ready 投递视图。
  React.useEffect(() => {
    setControlReady(false)
    setControlHeight(720)
  }, [controlUrl])

  // 子页消息：只认当前 iframe 这一源（source + origin 双校验），只处理三种已知类型。
  React.useEffect(() => {
    // 组件测试的假宿主没有 addEventListener，没有就当作收不到消息，不抛。
    const hub = browser && typeof browser.addEventListener === 'function' ? browser : null
    if (!hub) return undefined
    const onMessage = (event: any): void => {
      const frame = controlFrame.current
      if (!frame || !event || event.source !== frame.contentWindow) return
      if (controlOrigin !== null && event.origin !== controlOrigin) return
      const payload = event.data
      if (!payload || typeof payload !== 'object') return
      if (payload.type === 'psyche:qq:ready') {
        setControlReady(true)
        return
      }
      if (payload.type === 'psyche:qq:height') {
        const height = Number(payload.height)
        if (!Number.isFinite(height) || height <= 0) return
        setControlHeight(Math.max(320, Math.min(2400, Math.round(height))))
      }
    }
    hub.addEventListener('message', onMessage)
    return () => hub.removeEventListener('message', onMessage)
  }, [controlUrl, controlOrigin])

  // 视图下发：不依赖 ready——子页加载完先把当前视图推过去，子页据此学宿主 origin
  // 再回 ready；ready 之后同样会推一次，加载期间的点击以最后一次为准。
  // origin 只接受精确值，解析不出来就不发（GPT 第 1 轮第 3 条：禁止 '*'）。
  React.useEffect(() => {
    if (controlOrigin === null) return
    const frame = controlFrame.current
    const target = frame && frame.contentWindow
    if (!target) return
    target.postMessage({ type: 'psyche:qq:view', view: SECTION_VIEW[qqSection] ?? 'status' }, controlOrigin)
  }, [qqSection, controlReady, controlUrl, controlOrigin])

  // 工作区卡：宿主读的是 workspace/follow 的 baseline（800ms 超时），比 /api/status 重，
  // 所以只在「运行管理」段读，并且 10 秒内不重复读——轮询戳变化不等于用户在看这张卡。
  React.useEffect(() => {
    if (qqSection !== 'ops') return undefined
    const now = Date.now()
    if (now - workspaceFetchedAt.current < 10000) return undefined
    workspaceFetchedAt.current = now
    let alive = true
    browser
      .fetch('/api/psyche/qq/workspace', { headers: { accept: 'application/json' } })
      .then(async (response: any) => {
        const body = await response.json().catch(() => null)
        if (!response.ok || !body || body.ok !== true) {
          throw new Error(errorMessageOf(body, `HTTP ${response.status}`))
        }
        return body as QqWorkspaceCardView
      })
      .then((body: QqWorkspaceCardView) => {
        if (!alive) return
        setWorkspaceCard(body)
        setWorkspaceError(null)
      })
      .catch((cause: any) => {
        if (!alive) return
        setWorkspaceCard(null)
        setWorkspaceError(cause && cause.message ? cause.message : String(cause))
      })
    return () => {
      alive = false
    }
  }, [qqSection, props.stamp])

  // 「编辑工作区」不在这里写：表单在受保护的内嵌控制中心里，这里只负责把
  // 视图切到运行管理并请内嵌页展开表单（不重签令牌、不重建 iframe）。
  const editWorkspaceInControl = () => {
    const frame = controlFrame.current
    const target = frame && frame.contentWindow
    if (!target) {
      setControlMsg('先打开控制中心；编辑工作区在那张受保护的页面里')
      return
    }
    // 只往精确 origin 发；解析出来了才发，绝不退回 '*'。
    if (controlOrigin === null) {
      setControlMsg('控制中心地址异常，先重新打开一次')
      return
    }
    target.postMessage({ type: 'psyche:qq:action', action: 'workspace-edit' }, controlOrigin)
    browser.setTimeout(() => {
      browser.document.getElementById('qq-control-center')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    }, 120)
  }

  const guideCard = qqCard(
    '启动指南',
    showGuide
      ? h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      h(
        'div',
        { style: { fontSize: 12, color: MUTED } },
        'QQ 通道按下面顺序启动；SnowLuma 晚于桥接启动时，桥接可能已耗尽重连并熔断，需要手动重连。',
      ),
      h(
        'ol',
        { style: { margin: '2px 0 0 18px', padding: 0, fontSize: 12, lineHeight: 1.8, color: MUTED } },
        h('li', { key: 'snowluma' }, '先打开 SnowLuma 并登录 QQ；确认 OneBot WS 在 127.0.0.1:3001 监听。'),
        h('li', { key: 'reconnect' }, '打开控制中心，点「连接」或「重连」；仍失败则重启 DSH。'),
        h('li', { key: 'allow' }, `把要聊天的 QQ 加入宿主 qq.allowFrom.extra；当前额外授权 ${data?.allowFrom.extraCount ?? 0} 人，owner 已授权。`),
        h('li', { key: 'chat' }, '用该 QQ 私聊；群聊还需要 qq.contacts 配置。'),
      ),
      data?.connection === 'disconnected'
        ? h(
            'div',
            { style: { fontSize: 12, color: BAD, lineHeight: 1.7 } },
            (data.reconnect?.attempts ?? 0) > 0
              ? `当前桥接未连接：插件正在自动重试（第 ${data.reconnect?.attempts} 次，${data.reconnect?.mode === 'slow' ? '每 5 分钟一次' : '指数退避'}${
                  data.reconnect?.lastAttemptAt
                    ? `，上次 ${new Date(data.reconnect.lastAttemptAt).toLocaleTimeString('zh-CN')}`
                    : ''
                }）。一直连不上通常说明 SnowLuma 的 OneBot WS 没在监听——去 SnowLuma 里开启服务即可，插件会自己连上，不用点重连。`
              : '当前桥接未连接，且还没有重试记录：先确认 SnowLuma 已启动、OneBot WS 在 127.0.0.1:3001 监听。',
          )
        : null,
      h(
        'button',
        {
          type: 'button',
          disabled: controlBusy,
          onClick: () => {
            openControl()
            browser.setTimeout(() => {
              browser.document.getElementById('qq-control-center')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
            }, 200)
          },
          style: { alignSelf: 'flex-start', marginTop: 4, fontSize: 12, padding: '6px 10px', cursor: controlBusy ? 'default' : 'pointer' },
        },
        controlBusy ? '正在打开控制中心…' : '打开控制中心（手动重连）',
      ),
    )
      : h(
          'div',
          { style: { fontSize: 12, color: MUTED, lineHeight: 1.7 } },
          'QQ 通道按下面顺序启动。SnowLuma 晚于桥接启动时，桥接可能已耗尽重连并熔断，需要手动重连；展开看四步。',
        ),
    h(
      'button',
      {
        type: 'button',
        'data-dsh-part': 'qq-guide-toggle',
        'aria-label': '启动指南',
        'aria-expanded': showGuide ? 'true' : 'false',
        onClick: () => setShowGuide(!showGuide),
        style: { fontSize: 12, padding: '4px 10px' },
      },
      showGuide ? '收起' : '展开',
    ),
  )

  // ── 运行管理首屏（第 45 轮 UI 收整）──────────────────────────────
  // 布局照效果图：状态带 → 两列卡 → 四数字条 → 日志预览 → 启动指南。
  // 颜色全部走 --lb-* 别名（跟随宿主主题），不自绘背景、不加发光。
  const connectionTitle =
    data?.connection === 'connected'
      ? 'QQ 桥接已连接'
      : data?.connection === 'degraded'
        ? 'QQ 桥接不稳定'
        : data?.connection === 'disconnected'
          ? 'QQ 桥接未连接'
          : '连接状态未知'
  // 重连信息统一取一次：`data` 在这里可能还是 null（下面的早返回在更后面），
  // 直接写 `data.reconnect` 会触发 TS18047，取值都走可选链。
  const reconnectAttempts = data?.reconnect?.attempts ?? 0
  const reconnectMode = data?.reconnect?.mode ?? null
  const connectionSubtitle =
    data?.connection === 'connected'
      ? `最近心跳 ${fmtTime(data?.activity.lastHeartbeatAt)}；最近收到消息 ${fmtTime(data?.activity.lastMessageAt)}`
      : reconnectAttempts > 0
        ? `插件正在自动重试（第 ${reconnectAttempts} 次，${reconnectMode === 'slow' ? '每 5 分钟一次' : '指数退避'}）；SnowLuma 的 OneBot WS 起来后会自动连上。`
        : '还没有重试记录：先确认 SnowLuma 已启动、OneBot WS 在监听，再打开控制中心手动重连。'
  const connectionTone = data?.connection === 'connected' ? OK : SET_AMBER

  const flowNode = (label: string, state: string, tone: string): any =>
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 92 } },
      h('div', { style: { fontSize: 11, color: FAINT } }, label),
      darkPill(state, tone),
    )
  const flowLink = (live: boolean): any =>
    h('div', { style: { flex: '0 0 26px', height: 2, background: live ? OK : 'var(--lb-line)', marginBottom: 18 } })

  const statusBand = h(
    'section',
    { 'data-dsh-part': 'qq-status-band', className: 'lb-qq-band' },
    h(
      'div',
      { className: 'lb-qq-band-main' },
      h('span', {
        style: { width: 8, height: 8, borderRadius: 999, background: connectionTone, flex: '0 0 auto' },
      }),
      h(
        'div',
        { style: { minWidth: 0 } },
        h('div', { style: { fontSize: 15, fontWeight: 600, color: SET_TITLE } }, connectionTitle),
        h('div', { style: { fontSize: 11, color: MUTED, marginTop: 3, lineHeight: 1.6 } }, connectionSubtitle),
      ),
    ),
    h(
      'div',
      { className: 'lb-qq-band-flow' },
      flowNode('SnowLuma', data?.connection === 'connected' ? '运行中' : '待确认', data?.connection === 'connected' ? OK : MUTED),
      flowLink(data?.connection === 'connected'),
      flowNode('OneBot WS', data?.connection === 'connected' ? '已连接' : '未连接', data?.connection === 'connected' ? OK : MUTED),
      flowLink(data?.connection === 'connected'),
      flowNode('QQ 桥接', connectionLabel, connectionTone),
    ),
    h(
      'div',
      { className: 'lb-qq-band-action' },
      h(
        'button',
        {
          type: 'button',
          onClick: openControl,
          disabled: controlBusy,
          style: { fontSize: 12, padding: '7px 14px', cursor: controlBusy ? 'default' : 'pointer' },
        },
        controlBusy ? '正在打开…' : controlUrl ? '回到控制中心' : '打开控制中心',
      ),
    ),
  )

  const reconnectText =
    reconnectAttempts === 0
      ? '暂无重试'
      : `第 ${reconnectAttempts} 次 · ${reconnectMode === 'slow' ? '慢速（5 分钟）' : '指数退避'}`
  const bridgeCard = qqCard(
    '桥接与运行',
    h(
      'div',
      null,
      row('连接', h('span', { style: { color: connectionTone } }, connectionLabel)),
      row('重连', reconnectText),
      row('最近心跳', fmtTime(data?.activity.lastHeartbeatAt)),
      row('最近收到消息', fmtTime(data?.activity.lastMessageAt)),
      row('最近成功发送', fmtTime(data?.activity.lastSentAt)),
    ),
    pill('只读', MUTED),
  )

  const accountCard = qqCard(
    '账号与授权',
    h(
      'div',
      null,
      row('QQ 账号', data?.account.uinMasked ?? '—'),
      row('账号在线', data?.account.online === null ? '未知' : data?.account.online ? '在线' : '离线'),
      row(
        // 第 45 轮评委：首屏要能直接看出「哪些私聊允许回复」，不能只给人数。
        '私聊准入',
        data?.allowFrom.ownerConfigured === true
          ? `仅名单内：主人 + 额外 ${data?.allowFrom.extraCount ?? 0} 人`
          : '未配置主人，私聊一律不回复',
      ),
      row('Owner（脱敏）', data?.allowFrom.ownerMasked ?? (data?.allowFrom.ownerConfigured ? '已配置' : '—')),
      row('额外授权', `${data?.allowFrom.extraCount ?? 0} 人`),
      row('群白名单', `${data?.allowFrom.groupsCount ?? 0} 个`),
      row(
        '群回复',
        (data?.allowFrom.groupsCount ?? 0) === 0 ? '没有群配置（缺样本）' : '按已授权群生效',
      ),
    ),
    pill('只读', MUTED),
    h(
      'button',
      {
        type: 'button',
        disabled: controlBusy,
        onClick: openControl,
        style: { fontSize: 12, padding: '6px 10px', cursor: controlBusy ? 'default' : 'pointer' },
      },
      controlBusy ? '正在打开…' : '管理名单',
    ),
  )

  // 四数字条：只放首屏要看的四个数，明细（限频/超范围/拒绝回复）在「高级诊断」里。
  const statCells: [string, number][] = [
    ['收到', data?.counts.received ?? 0],
    ['已投递', data?.counts.delivered ?? 0],
    ['发送失败', data?.counts.sendErrors ?? 0],
    ['未授权私聊', data?.counts.rejected ?? 0],
  ]
  const statStrip = h(
    'section',
    { 'data-dsh-part': 'qq-stat-strip', className: 'lb-qq-stats' },
    ...statCells.map(([label, value]) =>
      h(
        'div',
        { key: label, className: 'lb-qq-stat' },
        h('div', { className: 'lb-qq-stat-label' }, label),
        h('div', { className: 'lb-qq-stat-value', style: { color: SET_TITLE } }, String(value)),
      ),
    ),
  )

  // 日志预览：最近 4 条，按时间倒序；「查看全部」跳到运行日志段并展开高级诊断。
  const previewLogs = (data?.logs ?? []).slice(-4).reverse()
  const logPreviewCard = qqCard(
    '最近运行日志',
    previewLogs.length === 0
      ? empty('还没有日志。')
      : h(
          'div',
          null,
          h(
            'div',
            { className: 'lb-qq-log-head' },
            h('span', null, '时间'),
            h('span', null, '级别'),
            h('span', null, '消息'),
          ),
          previewLogs.map((item: QqAdminView['logs'][number]) =>
            h(
              'div',
              {
                key: item.seq,
                className: 'lb-qq-log-row',
                style: { color: item.level === 'error' ? BAD : item.level === 'warn' ? SET_AMBER : MUTED },
              },
              h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, fmtTime(item.at)),
              h('span', { style: { textTransform: 'uppercase' } }, item.level),
              h('span', { className: 'lb-qq-log-msg' }, item.message),
            ),
          ),
          h(
            'div',
            { style: { fontSize: 11, color: FAINT, paddingTop: 8 } },
            '只显示最近 4 条；完整日志与诊断事件在「高级诊断」里，清屏只影响本地显示。',
          ),
        ),
    h(
      'button',
      {
        type: 'button',
        'data-dsh-part': 'qq-log-more',
        onClick: () => {
          setQqSection('logs')
          setShowAdvanced(true)
        },
        style: { fontSize: 11, padding: '3px 8px' },
      },
      '查看全部',
    ),
  )

  const qqNav = h(
    'div',
    { className: 'lb-qq-tabs', role: 'tablist', 'aria-label': 'QQ 只读视图', style: { gridColumn: '1 / -1' } },
    [
      ['ops', '运行管理'],
      ['contacts', '联系人策略'],
      ['model', '模型与推理'],
      ['events', '诊断事件'],
      ['logs', '运行日志'],
    ].map(([id, label]) =>
      h(
        'button',
        {
          key: id,
          type: 'button',
          role: 'tab',
          'aria-label': label,
          'aria-selected': qqSection === id,
          onClick: () => {
            setQqSection(id as any)
            if (id === 'events' || id === 'logs') setShowAdvanced(true)
            if (id === 'ops') setShowAdvanced(false)
          },
        },
        label,
      ),
    ),
  )

  const contactsCard = card(
    '授权对象',
    h(
      'div',
      null,
      // 私聊与群放在同一张列表里：都是「允许谁说话」，只是通道不同。
      // 只读展示当前生效值；真正的修改走控制中心（那里有令牌与来源校验）。
      row('私聊 · Owner', data?.allowFrom.ownerMasked ?? (data?.allowFrom.ownerConfigured ? '已配置' : '—')),
      ...(data?.allowFrom.extraMasked ?? []).map((masked: string, index: number) =>
        row(`私聊 · 白名单 ${index + 1}`, masked),
      ),
      ...(data?.allowFrom.groupsMasked ?? []).map((masked: string, index: number) =>
        row(`群 · 白名单 ${index + 1}`, masked),
      ),
      (data?.allowFrom.extraCount ?? 0) === 0 && (data?.allowFrom.groupsCount ?? 0) === 0
        ? row('白名单', '—')
        : null,
      row('联系人策略抑制', String(data?.counts.contactSuppressed ?? 0)),
      h(
        'p',
        { className: 'lb-help' },
        '这里只读展示生效中的名单。修改 Owner、私聊与群白名单在控制中心里做——那里有独立的本机令牌与来源校验。',
      ),
      h(
        'button',
        {
          type: 'button',
          disabled: controlBusy,
          onClick: () => {
            openControl()
            browser.setTimeout(() => {
              browser.document.getElementById('qq-control-center')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
            }, 200)
          },
          style: { alignSelf: 'flex-start', marginTop: 6, fontSize: 12, padding: '6px 10px', cursor: controlBusy ? 'default' : 'pointer' },
        },
        controlBusy ? '正在打开控制中心…' : '管理 Owner 与白名单',
      ),
    ),
    pill('只读', MUTED),
  )

  const children: any[] = [
    h(
      'button',
      {
        type: 'button',
        'data-dsh-part': 'qq-advanced-toggle',
        'aria-label': '高级诊断',
        'aria-expanded': showAdvanced ? 'true' : 'false',
        onClick: () => setShowAdvanced(!showAdvanced),
        style: { alignSelf: 'flex-start', padding: '6px 10px' },
      },
      showAdvanced ? '收起高级诊断' : '高级诊断（运行日志 / 诊断事件）',
    ),
    ...(showAdvanced
      ? [
    card(
      '计数明细',
      h(
        'div',
        null,
        row('收到', String(data?.counts.received ?? 0)),
        row('已投递', String(data?.counts.delivered ?? 0)),
        row('发送失败', String(data?.counts.sendErrors ?? 0)),
        row('未授权私聊', String(data?.counts.rejected ?? 0)),
        row('拒绝回复', `${data?.counts.rejectReplies ?? 0} 条`),
        row('限频丢弃', String(data?.counts.rateLimitedDrops ?? 0)),
        row('拒绝回复失败', String(data?.counts.rejectSendErrors ?? 0)),
        row('超范围丢弃', String(data?.counts.outOfScopeDrops ?? 0)),
        row('联系人策略抑制', String(data?.counts.contactSuppressed ?? 0)),
      ),
      pill('本次进程', MUTED),
    ),
    card(
      '运行日志',
      h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' } },
          h(
            'select',
            {
              value: level,
              onChange: (event: any) => setLevel(event.target.value),
              style: { fontSize: 12, padding: '2px 6px' },
            },
            h('option', { value: 'all' }, '全部级别'),
            h('option', { value: 'info' }, 'info'),
            h('option', { value: 'warn' }, 'warn'),
            h('option', { value: 'error' }, 'error'),
          ),
          h('button', { type: 'button', onClick: togglePause }, paused ? '继续' : '暂停滚动'),
          h(
            'button',
            {
              type: 'button',
              onClick: () => setClearedSeq(logs.reduce((max: number, item: QqAdminView['logs'][number]) => Math.max(max, item.seq), 0)),
            },
            '清屏',
          ),
          h('span', { style: { fontSize: 11, color: FAINT } }, `仅显示最近 ${visible.length} / 200 条`),
        ),
        visible.length === 0
          ? empty('还没有日志。')
          : h(
              'div',
              {
                style: {
                  maxHeight: 260,
                  overflowY: 'auto',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 11,
                  lineHeight: 1.5,
                  borderTop: `1px solid ${LINE}`,
                  paddingTop: 6,
                },
              },
              visible.map((item: QqAdminView['logs'][number]) =>
                h(
                  'div',
                  {
                    key: item.seq,
                    style: { color: item.level === 'error' ? BAD : item.level === 'warn' ? '#e6c07a' : MUTED },
                  },
                  `${fmtTime(item.at)} [${item.level}] ${item.message}`,
                ),
              ),
            ),
        h(
          'div',
          { style: { fontSize: 11, color: FAINT, marginTop: 8 } },
          '计数都是本次进程启动以来，重启会归零；日志脱敏发生在写入缓冲区之前，清屏不影响任何持久化数据。',
        ),
      ),
      pill('只读', MUTED),
    ),
    card(
      '诊断事件',
      h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', fontSize: 12 } },
          h(
            'select',
            { value: filterDirection, onChange: (event: any) => setFilterDirection(event.target.value), style: { fontSize: 12, padding: '2px 6px' } },
            h('option', { value: 'all' }, '全部方向'),
            h('option', { value: 'in' }, '入站'),
            h('option', { value: 'out' }, '出站'),
          ),
          h(
            'select',
            { value: filterTarget, onChange: (event: any) => setFilterTarget(event.target.value), style: { fontSize: 12, padding: '2px 6px' } },
            h('option', { value: 'all' }, '全部目标'),
            h('option', { value: 'private' }, '私聊'),
            h('option', { value: 'group' }, '群聊'),
          ),
          h(
            'select',
            { value: filterResult, onChange: (event: any) => setFilterResult(event.target.value), style: { fontSize: 12, padding: '2px 6px' } },
            h('option', { value: 'all' }, '全部结果'),
            h('option', { value: 'accepted' }, '已接受'),
            h('option', { value: 'delivered' }, '已投递'),
            h('option', { value: 'rejected' }, '已拒绝'),
            h('option', { value: 'rate_limited' }, '限频丢弃'),
            h('option', { value: 'out_of_scope' }, '超范围丢弃'),
            h('option', { value: 'deduplicated' }, '重复丢弃'),
            h('option', { value: 'failed' }, '发送失败'),
            h('option', { value: 'unknown' }, '结果未知'),
          ),
          h('input', {
            value: filterContact,
            onChange: (event: any) => setFilterContact(event.target.value),
            placeholder: 'Contact 脱敏号',
            style: { fontSize: 12, padding: '2px 6px', width: 120 },
          }),
          h('input', {
            value: filterRoom,
            onChange: (event: any) => setFilterRoom(event.target.value),
            placeholder: 'Room 脱敏号',
            style: { fontSize: 12, padding: '2px 6px', width: 120 },
          }),
          h('input', {
            type: 'datetime-local',
            value: filterFrom,
            onChange: (event: any) => setFilterFrom(event.target.value),
            title: '起始时间（含）',
            style: { fontSize: 11, padding: '2px 4px' },
          }),
          h('input', {
            type: 'datetime-local',
            value: filterTo,
            onChange: (event: any) => setFilterTo(event.target.value),
            title: '结束时间（不含）',
            style: { fontSize: 11, padding: '2px 4px' },
          }),
          h(
            'button',
            { type: 'button', disabled: true, title: '导出需要宿主可信鉴权，当前未启用' },
            '导出（禁用）',
          ),
          h('span', { style: { fontSize: 11, color: FAINT } }, diagLoading ? '读取中…' : diag ? `匹配 ${diag.matched} 条` : '—'),
        ),
        diagError
          ? h('div', { style: { color: BAD, fontSize: 12 } }, `诊断读取失败：${diagError}`)
          : !diag || diag.items.length === 0
            ? empty('还没有诊断事件。')
            : h(
                'div',
                {
                  style: {
                    maxHeight: 260,
                    overflowY: 'auto',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 11,
                    lineHeight: 1.5,
                    borderTop: `1px solid ${LINE}`,
                    paddingTop: 6,
                  },
                },
                diag.items.map((item: QqDiagnosticEventView) =>
                  h(
                    'div',
                    { key: item.seq, style: { color: item.result === 'failed' || item.result === 'unknown' ? BAD : item.result === 'rejected' || item.result === 'rate_limited' || item.result === 'out_of_scope' ? '#e6c07a' : MUTED } },
                    [
                      `${item.seq}`,
                      fmtTime(item.at),
                      item.direction === 'in' ? '入站' : '出站',
                      item.target === 'private' ? '私聊' : '群聊',
                      item.contactRef ?? item.roomRef ?? '—',
                      RESULT_LABEL[item.result] ?? item.result,
                      item.quote ? QUOTE_LABEL[item.quote] ?? item.quote : null,
                      item.media.length ? item.media.map((media) => `${media.type}×${media.count}`).join('、') : null,
                      item.textLength === null ? null : `正文 ${item.textLength} 字`,
                      item.errorCode ? item.errorCode : null,
                    ]
                      .filter((part) => part !== null)
                      .join(' · '),
                  ),
                ),
              ),
        diag && diag.nextBefore !== null && diag.items.length > 0
          ? h('button', { type: 'button', onClick: loadMoreDiagnostics, disabled: diagLoading, style: { marginTop: 8 } }, '加载更早的 50 条')
          : null,
        h(
          'div',
          { style: { fontSize: 11, color: FAINT, marginTop: 8 } },
          '诊断事件只驻留内存（最多 200 条），重启或插件卸载后清空；不含消息正文、媒体 URL、文件路径或完整 QQ 号。查询接口的访问控制由宿主 API 边界决定；导出在宿主可信鉴权可用前固定禁用。',
        ),
      ),
      pill('运行期诊断', MUTED),
    ),
        ]
      : []),
  ]

  const controlCard = card(
    '控制中心',
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
        h(
          'div',
          { style: { fontSize: 12, color: MUTED, flex: '1 1 280px' } },
          'SnowLuma 启停、WebUI、桥接重连与实时日志都在本页内操作；令牌只在该内嵌页的 URL fragment 中，父页面不展示。',
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: openControl,
            disabled: controlBusy,
            style: { fontSize: 12, padding: '6px 10px', cursor: controlBusy ? 'default' : 'pointer' },
          },
          controlBusy ? '正在加载…' : controlUrl ? '重新加载控制中心' : '打开控制中心',
        ),
        controlUrl
          ? h(
              'button',
              { type: 'button', onClick: () => { setControlUrl(''); setControlMsg('') }, style: { fontSize: 12, padding: '6px 10px' } },
              '收起',
            )
          : null,
        controlMsg ? h('span', { style: { fontSize: 12, color: controlMsg.startsWith('打开失败') ? BAD : OK } }, controlMsg) : null,
      ),
      controlUrl
        ? h('iframe', {
            key: controlUrl,
            ref: controlFrame,
            title: '心灵 QQ 控制中心',
            src: controlUrl,
            // 重新加载/首次加载后补推一次当前视图：子页要靠这条消息先认清宿主 origin，
            // 再回 ready；否则只等 ready 会双向死等。
            onLoad: () => {
              const frame = controlFrame.current
              const target = frame && frame.contentWindow
              if (!target || controlOrigin === null) return
              target.postMessage({ type: 'psyche:qq:view', view: SECTION_VIEW[qqSection] ?? 'status' }, controlOrigin)
            },
            style: { width: '100%', height: controlHeight, border: `1px solid ${LINE}`, borderRadius: 10, background: '#f4f4f5' },
          })
        : null,
    ),
  )

  // 工作区卡：五态与判定全由宿主算好（`buildQqWorkspaceCard`），这里只负责显示。
  // 成员数读不到时显示「未知」——0 是「确实没有会话」，两者不能混。
  const workspaceBlock = card(
    'QQ 工作区',
    (() => {
      if (workspaceError !== null) {
        return h('div', { style: { color: BAD, fontSize: 12 } }, `读工作区状态失败：${workspaceError}`)
      }
      if (!workspaceCard) {
        return h('div', { style: { color: MUTED, fontSize: 12 } }, '正在读取工作区…')
      }
      const state = workspaceCard.state
      const tone = state === 'registered' ? OK : state === 'needs-review' ? BAD : state === 'unverified' ? '#e6c07a' : MUTED
      const source = workspaceCard.cwdSource === 'config'
        ? '配置 qq.cwd'
        : workspaceCard.cwdSource === 'default'
          ? '默认（数据目录同级）'
          : '未知'
      const attempt = workspaceCard.attempt
        ? `${workspaceCard.attempt.ok ? '成功' : '失败'} · ${workspaceCard.attempt.step} · ${fmtTime(workspaceCard.attempt.at)}`
        : '还没有登记记录'
      // 目标会话单独一行：成员数是「这个工作区里有几条会话」，回答不了「这条消息的会话进去了没有」。
      const target = workspaceCard.targetSessionId ?? '本进程未登记过会话'
      // 回执（我们做过什么）与核验（清单里到底有没有）分开显示，别让一个数字同时冒充两件事。
      const verify =
        workspaceCard.memberVerify === 'contains'
          ? '清单里已包含它'
          : workspaceCard.memberVerify === 'missing'
            ? '清单里还没有它'
            : '读不到成员 id，无法核对'
      return h(
        'div',
        null,
        row('状态', h('span', { style: { color: tone } }, workspaceCard.label)),
        row('目录', workspaceCard.cwd || '—'),
        row('目录来源', source),
        row('期望名', workspaceCard.expectedTitle),
        row('宿主实际名', workspaceCard.actualTitle ?? '—'),
        row('会话成员', workspaceCard.memberCount === null ? '未知' : String(workspaceCard.memberCount)),
        row('目标会话', target),
        row('登记回执', attempt),
        row('成员核验', verify),
        row('读回核验', workspaceCard.readAt === null ? '未核验' : fmtTime(workspaceCard.checkedAt)),
        workspaceCard.reason
          ? h('p', { style: { fontSize: 12, color: MUTED, margin: '6px 0 0' } }, workspaceCard.reason)
          : null,
        h(
          'button',
          {
            type: 'button',
            onClick: editWorkspaceInControl,
            disabled: !controlUrl || !controlReady,
            style: { fontSize: 12, padding: '6px 10px', marginTop: 8, cursor: !controlUrl || !controlReady ? 'default' : 'pointer' },
          },
          '编辑工作区',
        ),
        !controlUrl || !controlReady
          ? h('span', { style: { fontSize: 11, color: FAINT, marginLeft: 8 } }, '打开控制中心后可在内嵌页里改名')
          : null,
        h(
          'div',
          { style: { fontSize: 11, color: FAINT, marginTop: 8 } },
          '目录与配置来源只读：工作区目录决定下一条 QQ 消息落到哪里，改名之外不从这里改。',
        ),
      )
    })(),
    pill('五态', MUTED),
  )

  if (error) {
    return consolePage({
      kicker: 'PSYCHE · QQ CONSOLE',
      title: 'QQ',
      hint: 'QQ 桥接的只读状态与日志；这里没有任何发送、授权或进程控制入口。',
      badge: darkPill('读取失败', BAD),
      children: [card('QQ', h('div', { style: { color: BAD, fontSize: 13 } }, `读取失败：${error}`))],
    })
  }
  if (!data) {
    return consolePage({
      kicker: 'PSYCHE · QQ CONSOLE',
      title: 'QQ',
      hint: 'QQ 桥接的只读状态与日志；这里没有任何发送、授权或进程控制入口。',
      badge: darkPill('读取中', FAINT),
      children: [card('QQ', h('div', { style: { color: MUTED, fontSize: 13 } }, '正在读取…'))],
    })
  }
  if (data.enabled === false) {
    // `enabled: false` 有两种原因：配置没开（正常），和桥接启动失败（故障）。
    // 以前两者都只显示「QQ 通道没有启用」，用户会按「没开」去翻配置，
    // 永远看不到真正的报错。
    const startError = typeof data.startError === 'string' && data.startError ? data.startError : null
    return consolePage({
      kicker: 'PSYCHE · QQ CONSOLE',
      title: 'QQ',
      hint: 'QQ 桥接的只读状态与日志；这里没有任何发送、授权或进程控制入口。',
      badge: startError === null ? darkPill('未启用', MUTED) : darkPill('启动失败', BAD),
      children: [
        card(
          'QQ',
          startError === null
            ? empty('QQ 通道没有启用。启用后这里会显示连接状态、计数与日志。')
            : empty(`QQ 桥接启动失败：${startError}`),
        ),
      ],
    })
  }

  // 控制中心卡片两页都放：联系人策略页那个「管理 Owner 与白名单」按钮调的就是
  // openControl()，卡片不在这一页时按钮点了没反应（用户会以为入口没了）。
  const controlSlot = h(
    'div',
    { id: 'qq-control-center', style: { gridColumn: '1 / -1', minWidth: 0 } },
    controlCard,
  )
  // 待投递提醒（第 12 轮评审）：只读一块，让「已延后」看得见。
  // 展示的预计时间由服务端算好——已入队取队列行的 retry_at，未入队才退回提醒行；
  // 这里不自己推算，免得给用户看旧时间。
  const pendingReminders = data.pendingReminders
  const reminderStateLabel = (state: 'due' | 'queued' | 'waiting' | 'paused'): string => {
    // 第 13 轮：`due`/`queued` 只说「等待调度 / 已入队」，不对未发生的投递做承诺。
    if (state === 'due') return '等待调度'
    if (state === 'queued') return '已入队，等待发送'
    if (state === 'waiting') return '已延后'
    return '规则暂停'
  }
  const pendingTotal = pendingReminders?.total ?? 0
  const verdictCount = pendingReminders?.awaitingVerdict ?? 0
  // 结果不确定的提醒不进列表也不进总数；单独一行说清「有 N 条要你自己确认」。
  const verdictNote = verdictCount > 0
    ? h(
        'div',
        { style: { fontSize: 11, color: '#e6c07a', marginTop: 6 } },
        `另有 ${verdictCount} 条结果不确定（待裁决）：用 psyche_list_reminders 查看，再用 psyche_resolve_delivery 裁决 received / not-received；两种裁决都不会重发。`,
      )
    : null
  const pendingBlock = card(
    '待投递提醒',
    pendingReminders === undefined
      ? empty('这个版本没有返回待投递提醒。')
      : pendingReminders.items.length === 0
        ? h('div', null, empty('没有等待投递的提醒。'), verdictNote)
        : h(
            'div',
            null,
            h(
              'div',
              { style: { fontSize: 11, color: FAINT, marginBottom: 6 } },
              `共 ${pendingTotal} 条等待投递${pendingTotal > pendingReminders.items.length ? `，这里显示最早的 ${pendingReminders.items.length} 条` : ''}。`,
            ),
            pendingReminders.items.map((item) =>
              row(
                `${item.reminderId.slice(0, 12)}…`,
                h(
                  'span',
                  null,
                  `${fmtTime(item.dueAt)} 定 · `,
                  item.state === 'paused'
                    ? '暂无可用发送时段'
                    : item.scheduledAt === null
                      ? '等待下一轮扫描'
                      : `预计最早 ${fmtTime(item.scheduledAt)}`,
                  ` · ${reminderStateLabel(item.state)}`,
                ),
              ),
            ),
            h(
              'div',
              { style: { fontSize: 11, color: FAINT, marginTop: 8 } },
              '只读：这里只说明什么时候可能发出，发送仍由后台按允许回复时段决定。',
            ),
            verdictNote,
          ),
    pill('只读', MUTED),
  )

  // 模型与推理只看内嵌页：这一段的内容全由控制中心承载，父页不再重复一份只读卡片。
  // 运行管理页（第 45 轮）：状态带 → 两列卡 → 四数字条 → 日志预览 → 启动指南，
  // 其余（工作区、待投递提醒、完整日志、诊断事件、计数明细）都收进「高级诊断」。
  const bodyChildren = qqSection === 'contacts'
    ? [qqNav, contactsCard, controlSlot]
    : qqSection === 'model'
      ? [qqNav, controlSlot]
      : qqSection === 'ops'
        ? [
            qqNav,
            // 整页是一个纵向 flex 栈：状态带 / 两列卡 / 数字条 / 日志 / 指南 / 高级诊断，
            // 间距统一由 .lb-qq-ops 的 gap 决定，窄屏折列也由容器查询处理。
            h(
              'div',
              { className: 'lb-qq-ops', style: { gridColumn: '1 / -1' } },
              statusBand,
              h('div', { className: 'lb-qq-pair' }, bridgeCard, accountCard),
              statStrip,
              logPreviewCard,
              guideCard,
              ...children,
              ...(showAdvanced ? [workspaceBlock, pendingBlock] : []),
              ...(controlUrl ? [controlSlot] : []),
            ),
          ]
        : [qqNav, ...children]

  return consolePage({
    kicker: 'PSYCHE · QQ',
    title: 'QQ 控制台',
    hint: `只读状态与日志；修改授权、模型与重连在控制中心里做。更新于 ${new Date(props.stamp || Date.now()).toLocaleTimeString('zh-CN')}`,
    badge: darkPill(connectionLabel, data.connection === 'connected' ? OK : MUTED),
    children: bodyChildren,
  })
}
