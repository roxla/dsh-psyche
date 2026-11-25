// 心灵 · 浏览器半侧：运维页


function OpsTab(props: { stamp: number }): any {
  // 与状态页同一套观感：函数作用域内遮蔽浅色卡片/颜色，不动任何取数或动作逻辑。
  const BAD = '#f0a0a0'
  const OK = SET_GREEN
  const MUTED = SET_FAINT
  const FAINT = SET_FAINT
  const LINE = SET_LINE_SOFT
  const card = consoleCard
  const row = consoleRow
  const pill = darkPill
  const table = consoleTable

  // bump 让本页在动作完成后立即重读，不用等父级 20 秒轮询。
  const [bump, setBump] = React.useState(0)
  const [busy, setBusy] = React.useState(null as string | null)
  const [outcome, setOutcome] = React.useState(null as string | null)
  // stamp + bump 一起当 tick：父级刷新和本页动作共用同一条重读路径。
  const { data, error } = useEndpoint<OpsView>('/api/psyche/ops', props.stamp + bump)
  // 迁移包单独取：它要逐个解包校验 sha256，比 ops 慢，混在一个接口里会拖慢整页首屏。
  const archives = useEndpoint<ArchivesView>('/api/psyche/archives', props.stamp + bump)

  const run = (action: string, label: string) => {
    // 置忙 + 清上一条结果：避免旧的成功提示被当成这次的结果。
    setBusy(action)
    setOutcome(null)
    browser
      .fetch('/api/psyche/ops', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action }),
      })
      .then((response: any) => response.json().then((body: any) => ({ ok: response.ok, body })))
      .then((result: any) => {
        // 服务端用 body.ok 表达业务结果（HTTP 也可能仍是 200），所以看它不看状态码。
        if (result.body && result.body.ok) setOutcome(`${label}：好了`)
        else setOutcome(`${label}：失败（${(result.body && result.body.error) || '未知错误'}）`)
      })
      .catch((cause: any) => setOutcome(`${label}：失败（${cause && cause.message ? cause.message : cause}）`))
      .then(() => {
        // 成功失败都清忙并重读：界面要回到真实状态，而不是只改一行提示。
        setBusy(null)
        setBump((value: number) => value + 1)
      })
  }

  if (error) {
    return consolePage({
      kicker: 'PSYCHE · OPS CONSOLE',
      title: '运维',
      hint: '引擎、写入记录、动作与迁移包；所有动作都会写进只追加的审计。',
      badge: darkPill('读取失败', '#f0a0a0'),
      children: [card('调试与运维', h('div', { style: { color: BAD, fontSize: 13 } }, `读取失败：${error}`))],
    })
  }
  if (!data) {
    return consolePage({
      kicker: 'PSYCHE · OPS CONSOLE',
      title: '运维',
      hint: '引擎、写入记录、动作与迁移包；所有动作都会写进只追加的审计。',
      badge: darkPill('读取中', SET_FAINT),
      children: [card('调试与运维', h('div', { style: { color: MUTED, fontSize: 13 } }, '正在读取…'))],
    })
  }

  // 健康块可能整块为 null（库还没起来），所以先取出来再判，避免每处都 data.health.?
  const health = data.health
  // 引擎一块放最前：真出问题时，人先看的是低层指标而不是业务计数。
  const healthCard = card(
    '引擎',
    health
      ? h(
          React.Fragment,
          null,
          row('驱动', health.driver),
          row('schema', `v${health.userVersion}`, `${health.tables} 张表`),
          row('日志模式', health.journalMode, `synchronous ${health.synchronous}`),
          row('体积', bytesText(health.bytes)),
          row('查询', `${health.queries} 次`, `慢 ${health.slowQueries} 次`),
          row('最慢一次', `${Number(health.maxQueryMs).toFixed(2)} ms`),
        )
      : h('div', { style: { color: BAD } }, '数据库还没准备好'),
    pill(health ? '在跑' : '未就绪', health ? OK : BAD),
  )

  // 计数直接查库，用来确认「刚才那次写进去了没有」，和状态页的记忆规模同源。
  const counterCard = card(
    '记下了多少',
    h(
      React.Fragment,
      null,
      row('来源', `${data.counters.sources}`),
      row('事件', `${data.counters.events}`),
      row('结论', `${data.counters.artifacts}`, `版本 ${data.counters.artifactRevisions}`),
      row('操作记录', `${data.counters.operations}`),
      row('阶段里程碑', `${data.counters.phaseMilestones}`),
    ),
  )

  // 最近操作：审计表只追加、面板删不掉，这里只截前 12 条给个近况。
  const opCard = card(
    '最近的操作',
    data.operations.recent.length === 0
      ? h('div', { style: { color: MUTED, fontSize: 13 } }, '还没有调用记录')
      : table(
          ['时间', '工具', '状态', '耗时'],
          data.operations.recent
            .slice(0, 12)
            .map((item) => [
              fmtTime(item.createdAt),
              item.tool,
              item.status === 'ok'
                ? '成功'
                : h('span', { style: { color: BAD } }, `失败 ${item.error ? `· ${item.error.slice(0, 40)}` : ''}`),
              item.durationMs === null ? '—' : `${item.durationMs} ms`,
            ]),
        ),
    pill(`${data.operations.total} 条`, MUTED),
  )

  // 日志倒序取前 80 行：再多在大屏上也读不完，还容易把页面拖慢。
  const logCard = card(
    '引擎日志',
    data.logs.length === 0
      ? h('div', { style: { color: MUTED, fontSize: 13 } }, '还没有日志')
      : h(
          'div',
          {
            style: {
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              maxHeight: 260,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            },
          },
          data.logs
            .slice()
            .reverse()
            .slice(0, 80)
            .map((entry, index) =>
              h(
                'div',
                {
                  key: `${index}`,
                  style: {
                    color:
                      entry.level === 'error' ? BAD : entry.level === 'warn' ? '#c79a3a' : 'inherit',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  },
                },
                `${fmtTime(entry.at)} [${entry.level}] ${entry.scope} · ${entry.message}`,
              ),
            ),
        ),
    pill(`告警 ${data.logCounts.warn}`, data.logCounts.warn > 0 ? '#c79a3a' : MUTED),
  )

  /**
   * 生成一个动作按钮。busy 非空时全部禁用，避免两个写动作同时压到库上。
   * @param action 发给服务端的动作名；@param label 按钮文案
   * @param danger true 时文字标红（不可逆的动作）
   */
  const actionButton = (action: string, label: string, danger?: boolean): any =>
    h(
      'button',
      {
        key: action,
        type: 'button',
        disabled: busy !== null,
        onClick: () => run(action, label),
        style: {
          fontSize: 12,
          padding: '6px 12px',
          borderRadius: 8,
          border: LINE,
          background: 'transparent',
          color: danger ? BAD : 'inherit',
          cursor: busy ? 'default' : 'pointer',
          opacity: busy && busy !== action ? 0.5 : 1,
        },
      },
      busy === action ? '执行中…' : label,
    )

  // 四个动作里只有「清空引擎日志」不可逆（审计表删不掉），所以唯独它标红。
  // 「导出迁移包」是这组里最重的动作（VACUUM INTO + gzip 全库），所以排在最后。
  const actionCard = card(
    '动作',
    h(
      React.Fragment,
      null,
      h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        actionButton('backup', '备份一份'),
        actionButton('sync-growth', '评估闸门'),
        actionButton('purge-logs', '清空引擎日志', true),
        actionButton('archive', '导出迁移包'),
      ),
      outcome
        ? h('div', { style: { marginTop: 10, fontSize: 12, color: MUTED } }, outcome)
        : null,
      h(
        'div',
        { style: { marginTop: 10, fontSize: 12, color: FAINT, lineHeight: 1.6 } },
        '备份用 VACUUM INTO 写到数据目录的 backups/ 下，不动当前库；操作记录是只追加的审计（删不掉），这里能清的只有内存里的引擎日志。',
      ),
    ),
  )

  // 备份列表只显示最近 6 个：文件名自带时间戳，看趋势够用了。
  const backupCard = card(
    '备份',
    data.backups.length === 0
      ? h('div', { style: { color: MUTED, fontSize: 13 } }, '还没有备份')
      : table(
          ['文件', '大小', '时间'],
          data.backups.slice(0, 6).map((item) => [item.file, bytesText(item.bytes), fmtTime(item.at)]),
        ),
  )

  // 迁移包：搬家用的完整包（库快照 + 人格原文 + 配置 + 偏好 + 素材 + 清单）。
  // 与上面的「备份」不同：备份只用于本机回滚，迁移包用于换电脑，所以带清单与逐文件校验。
  const archiveRows = (archives.data && archives.data.rows) || []
  const archiveCard = card(
    '迁移包',
    h(
      React.Fragment,
      null,
      archiveRows.length === 0
        ? h(
            'div',
            { style: { color: MUTED, fontSize: 13, lineHeight: 1.6 } },
            archives.error
              ? `读取失败：${archives.error}`
              : '还没有迁移包。点上面「导出迁移包」生成一个 tar.gz，拷到新电脑就能恢复人格记忆。',
          )
        : table(
            ['包', '大小', '时间', '校验'],
            archiveRows.slice(0, 6).map((item) => [
              item.name,
              bytesText(item.bytes),
              fmtTime(item.at),
              item.verified === true
                ? `通过（${item.files ?? '?'} 个文件 · v${item.schemaVersion ?? '?'}）`
                : item.verified === false
                  ? '不通过（别用它恢复）'
                  : '未校验',
            ]),
          ),
      h(
        'div',
        { style: { marginTop: 10, fontSize: 12, color: FAINT, lineHeight: 1.6 } },
        '包在数据目录的 exports/ 下，逐文件 sha256；恢复要在 DSH 关掉时做（库文件不能被占用）：' +
          'node tools/psyche-archive.mjs restore <包> --data <数据目录> --yes',
      ),
    ),
    pill(archiveRows.length > 0 ? `${archiveRows.length} 个` : '空', archiveRows.length > 0 ? OK : MUTED),
  )

  // 卡片顺序即阅读顺序：先看引擎与计数，最后才是会动手的动作、备份与恢复。
  return consolePage({
    kicker: 'PSYCHE · OPS CONSOLE',
    title: '运维',
    hint: '引擎、写入记录、动作与迁移包；所有动作都会写进只追加的审计。',
    badge: health ? darkPill('引擎在线', SET_GREEN) : darkPill('未就绪', '#f0a0a0'),
    children: [
      healthCard,
      counterCard,
      opCard,
      logCard,
      actionCard,
      backupCard,
      archiveCard,
      h(RestoreCard, { stamp: props.stamp, archives: archives.data }),
    ],
  })
}

// ── ECharts（状态页图表）──────────────────────────────────────
// 客户端插件没有打包器、不能 ESM import，所以 ECharts 走宿主路由的离线 UMD 脚本：
// `/psyche/echarts.js` 由 src/index.ts 从 assets/echarts.min.js 直出，不依赖 CDN。
// 仅渲染真实情绪快照；未接入的图表不展示。
let echartsLoader: Promise<any> | null = null
