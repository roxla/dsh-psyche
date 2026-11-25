// 心灵 · 浏览器半侧：用量与花费页


// ── 用量与花费页 ──────────────────────────────────────────────
/**
 * 用量与花费页（2026-11 需求：合并原「用量」「花费」两页）。
 *
 * 两页原本共用一个接口，只是回答的问题不同——用量答「这一轮花了多少」，
 * 花费答「钱花在哪些小时、哪些会话」。合并后页头切区间与刻度，同屏给：
 * KPI → 逐时走势 → 会话十列明细 → 价目表；一个接口、一次请求。
 * @param props.stamp 父级刷新计数器；变了就重新统计
 * 状态：本地 hours / metric；副作用只有一次 fetch。
 */
function UsageSpendTab(props: { stamp: number }): any {
  // 区间就是原花费页的四个 tag；默认 72 小时能看出日内高峰。
  const RANGES: { hours: number; label: string }[] = [
    { hours: 24, label: '24 小时' },
    { hours: 72, label: '3 天' },
    { hours: 168, label: '7 天' },
    { hours: 720, label: '30 天' },
  ]
  const [hours, setHours] = React.useState(72)
  // React 在这里是 any，泛型参数会报「Untyped function calls may not accept type arguments」，
  // 所以状态类型用 `as` 收窄，而不是给 useState 传类型实参。
  // 图表 / 数字 两个出口；图表是默认（一张图里 token 与花费并排）。
  const [view, setView] = React.useState('chart' as 'chart' | 'number')
  const { data, error } = useEndpoint<UsageView>(`/api/psyche/usage?hours=${hours}`, props.stamp)
  // 先判 error 再判 !data：两者都没有才是真的「还在统计」。
  if (error) {
    return h(
      'div',
      { style: { gridColumn: '1 / -1' } },
      card('用量与花费', h('div', { style: { color: BAD, fontSize: 13 } }, `读取失败：${error}`)),
    )
  }
  if (!data) {
    return h(
      'div',
      { style: { gridColumn: '1 / -1' } },
      card('用量与花费', h('div', { style: { color: MUTED, fontSize: 13 } }, '正在统计…')),
    )
  }

  const totals = data.totals
  const symbol = data.priceTable.symbol
  const buckets = data.byHour
  // 两个系列各自按自身最大值归一（token 与钱不能加在一起算），图例里注明口径。
  const maxTokens = buckets.reduce((max, bucket) => Math.max(max, bucket.tokens), 0)
  const maxCost = buckets.reduce((max, bucket) => Math.max(max, bucket.cost), 0)
  const shownTokens = buckets.reduce((sum, bucket) => sum + bucket.tokens, 0)
  const shownCost = buckets.reduce((sum, bucket) => sum + bucket.cost, 0)

  const legendDot = (color: string, label: string): any =>
    h(
      'span',
      { style: { display: 'flex', alignItems: 'center', gap: 4 } },
      h('span', { style: { width: 8, height: 8, background: color, borderRadius: 2 } }),
      label,
    )

  const header = h(
    'div',
    { style: { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' } },
    h(
      'div',
      { style: { display: 'flex', gap: 6, alignItems: 'center' } },
      h('span', { style: { color: MUTED, fontSize: 12 } }, '区间'),
      RANGES.map((item) => tagButton(item.label, hours === item.hours, () => setHours(item.hours))),
    ),
    viewSwitch('usage-view', view, setView),
    h(
      'span',
      { style: { marginLeft: 'auto', color: MUTED, fontSize: 12 } },
      `图内合计 ${tokensText(shownTokens)} · ${moneyText(shownCost, symbol)}`,
    ),
  )

  // 一行运行摘要：只讲心灵自己的调用。会话数在这里没有意义（账本固定一个会话），
  // 所以换成「插件自身」这个口径说明，避免又被读成整机消耗。
  const overview = h(
    'div',
    { style: { display: 'flex', flexWrap: 'wrap', gap: 14, color: MUTED, fontSize: 12 } },
    h('span', null, `心灵自己的调用 ${totals.calls} 次 · ${totals.turns} 轮 / ${totals.steps} 步`),
    h('span', null, `平均每轮 ${moneyText(totals.avgCostPerTurn, symbol)}`),
    h('span', null, hours > 0 ? `窗口 ${hours} 小时` : '全部'),
    h('span', { style: { color: FAINT } }, '不含对话本身的消耗'),
  )

  // 空账本要解释清楚，否则「0 次调用」看起来像坏了：
  // 这不是「读不到数据」，而是插件到现在确实还没自己调过模型。
  const emptyState =
    totals.calls === 0
      ? card(
          '还没有心灵自己的消耗',
          h(
            'div',
            { style: { color: MUTED, fontSize: 13, lineHeight: 1.7 } },
            '这一页只记插件自己发起的模型调用（日记生成、以后的自述 / 摘要等）。',
            h('br'),
            '你平时对话的消耗不在这里——那属于会话本身，不算这个插件的花费。',
            h('br'),
            '等日记 Writer 接上以后，这里的数字才会开始长。',
          ),
        )
      : null

  // 四张 metric 卡：参考控制台的第一屏，大小两档信息分开（数字给人看，脚注解释口径）。
  const metrics = h(
    'div',
    { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 } },
    metricTile(
      '心灵花费',
      moneyText(totals.cost.total, symbol),
      `高峰 ${moneyText(totals.cost.peak, symbol)} · 空闲 ${moneyText(totals.cost.off, symbol)}`,
    ),
    metricTile(
      '心灵 token',
      tokensText(totals.tokens),
      `命中 ${tokensText(totals.buckets.cacheHit)} · 未命中 ${tokensText(totals.buckets.cacheMiss)}`,
    ),
    metricTile('缓存命中率', percentText(totals.hitRate), '命中的输入占总输入的比例'),
    metricTile(
      '平均每轮',
      moneyText(totals.avgCostPerTurn, symbol),
      `${totals.calls} 次调用 · ${totals.turns} 轮`,
    ),
  )

  // 数字视图只列最近 48 个桶：30 天区间的 720 个桶全铺出来反而难读，
  // 图内合计已经给了整段总量，这里给「最近发生了什么」。
  const chartRows = buckets
    .slice(-48)
    .reverse()
    .map((bucket) => [
      fmtTime(bucket.at),
      tokensText(bucket.tokens),
      moneyText(bucket.cost, symbol),
      `${bucket.calls}`,
      bucket.tier === 'peak' ? '高峰' : '空闲',
    ])

  const chart = card(
    '消耗走势',
    view === 'number'
      ? chartRows.length === 0
        ? h('div', { style: { color: MUTED, fontSize: 13 } }, '这个区间还没有用量')
        : table(['时间', 'token', '花费', '调用', '时段'], chartRows)
      : buckets.length === 0
        ? h('div', { style: { color: MUTED, fontSize: 13 } }, '这个区间还没有用量')
        : h(
            React.Fragment,
            null,
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'flex-end',
                  gap: 2,
                  height: 140,
                  paddingTop: 6,
                  overflowX: 'auto',
                },
              },
              buckets.map((bucket) => {
                // 两个系列各自归一：token 按本区间最大 token，花费按本区间最大花费。
                // 钱和 token 不能加在一起算，所以并排两根柱，图例里写明口径。
                const tokenH =
                  maxTokens > 0 ? Math.max(2, Math.round((bucket.tokens / maxTokens) * 104)) : 2
                const costH = maxCost > 0 ? Math.max(2, Math.round((bucket.cost / maxCost) * 104)) : 2
                return h(
                  'div',
                  {
                    key: `${bucket.at}`,
                    title: `${fmtTime(bucket.at)} · ${tokensText(bucket.tokens)} · ${moneyText(bucket.cost, symbol)} · ${bucket.calls} 次调用 · ${bucket.tier === 'peak' ? '高峰' : '空闲'}`,
                    style: {
                      display: 'flex',
                      alignItems: 'flex-end',
                      gap: 1,
                      flex: '1 0 16px',
                      minWidth: 16,
                      height: '100%',
                    },
                  },
                  h('div', { style: { flex: '1 1 0', height: tokenH, background: OK, opacity: 0.8, borderRadius: 1 } }),
                  h('div', { style: { flex: '1 1 0', height: costH, background: BAD, opacity: 0.6, borderRadius: 1 } }),
                )
              }),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 14, color: MUTED, fontSize: 11, marginTop: 6, flexWrap: 'wrap' } },
              legendDot(OK, 'token（按区间最大 token 归一）'),
              legendDot(BAD, '花费（按区间最大花费归一）'),
              h('span', null, '悬停看该小时的具体数字与时段'),
            ),
          ),
    view === 'number'
      ? pill(`最近 ${chartRows.length} 个桶`, MUTED)
      : pill(hours > 0 ? `最近 ${hours} 小时` : '全部', MUTED),
  )

  // 按用途：花费占比用总量算，命中率用该用途自己的桶算（两者口径不同，不互相换算）。
  // 插件的自用调用全挂在同一个逻辑会话上，所以这里分的是「哪件事花了钱」，不是会话。
  const sessionRows = data.bySession.slice(0, 10).map((item) => [
    item.label,
    `${item.calls}`,
    `${item.turns}`,
    tokensText(item.buckets.cacheMiss),
    tokensText(item.buckets.cacheHit),
    percentText(item.hitRate),
    tokensText(item.buckets.output),
    tokensText(item.tokens),
    moneyText(item.cost.total, symbol),
    percentText(totals.cost.total > 0 ? item.cost.total / totals.cost.total : 0),
  ])
  const sessionCard = card(
    '按用途',
    sessionRows.length === 0
      ? h('div', { style: { color: MUTED, fontSize: 13 } }, '还没有数据')
      : table(
          ['用途', '调用', '轮', '未命中输入', '命中输入', '命中率', '输出', 'token', '花费', '占比'],
          sessionRows,
        ),
    pill(`${data.bySession.length} 类`, MUTED),
  )

  const priceCard = card(
    '价目表',
    h(
      React.Fragment,
      null,
      row('模型', data.priceTable.modelLabel, data.priceTable.estimated ? '估算' : undefined),
      row('当前档位', data.priceTable.tierLabel, `高峰 ×${data.priceTable.peakMultiplier}`),
      row('命中缓存', `${data.priceTable.cacheHit} / 百万 token`),
      row('未命中', `${data.priceTable.cacheMiss} / 百万 token`),
      row('输出', `${data.priceTable.output} / 百万 token`),
      notesBlock(data.notes),
    ),
    pill(`v${data.priceTable.version}`, MUTED),
  )

  // 整页铺满：外框跨满网格，内部自己排（否则 tables 会被挤在 320px 的格子里）。
  return h(
    'div',
    { style: { gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 12 } },
    header,
    overview,
    metrics,
    emptyState,
    chart,
    sessionCard,
    priceCard,
  )
}
