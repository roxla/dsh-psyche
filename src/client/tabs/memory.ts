// 心灵 · 浏览器半侧：记忆页（记忆条目、成长候选、联系人）




// ── 提案 / 关系 ───────────────────────────────────────────────
/**
 * 提案页：列出心灵排队等批的改设定建议（分区 / 目标 / 改成什么 / 为什么）。
 * @param props.data 面板快照；proposals 缺省时按空列表处理
 * 纯展示、无副作用——批准只在宿主或命令侧做，面板不提供「通过」按钮（权限边界）。
 */
/**
 * 提案页：待批的在这里决定。
 * @param props.data 面板快照；`props.onDecided` 由页面传入，决定成功后触发重取
 *
 * 为什么批准按钮只对 `pending` 出现：`decideProposal()` 对已处理过的提案会抛 `E_STATE`，
 * 界面上就不该给出一个必然失败的按钮。`life` 的批准不会改配置——文案里写清楚，
 * 免得以为点完参数就变了（真正的机制见 `src/lib/proposals.ts` 文件头）。
 */
/**
 * 记忆页（UI-2b）：最近的高显著度结论 + 待批提案 + 意识海入口。
 * 只展示面板已经算好的安全字段：不展开原始证据、不做跨 Scope 查询。
 */
function MemoryTab(props: { data: PanelData; stamp: number; onNavigate: (tab: string) => void; onDecided?: () => void }): any {
  const [query, setQuery] = React.useState('')
  const keyword = query.trim()
  const all = props.data.salience ?? []
  const matched = keyword
    ? all.filter((item) => item.statement.includes(keyword) || item.kind.includes(keyword))
    : all
  const shown = matched.slice(0, 5)
  const sea = props.data.prefs && props.data.prefs.sea
    ? uiButton('打开意识海', () => props.onNavigate('sea'), { 'aria-label': '打开意识海' })
    : null
  const list = shown.length === 0
    ? empty(keyword ? '没有匹配的结论。' : '还没有可展示的记忆结论。')
    : h('div', null, shown.map((item) =>
        h('div', { key: item.artifactId, className: 'lb-memory-item' },
          h('div', { className: 'lb-memory-head' },
            pill(item.kind, MUTED),
            h('span', { className: 'lb-memory-statement' }, item.statement)),
          h('div', { className: 'lb-help' },
            item.solid ? '候选证据已成型' : '候选证据尚不完整',
            item.reasons.length ? ' · ' + item.reasons.join(' / ') : ''))))
  return h(React.Fragment, null,
    card('记忆结论', h('div', null,
      h('input', {
        className: 'lb-input lb-memory-search', type: 'search', value: query,
        placeholder: '搜索结论或类型', 'aria-label': '搜索记忆结论',
        onChange: (event: any) => setQuery(String(event.target.value || '')),
      }),
      h('div', { className: 'lb-help' }, '默认显示最近 5 条高显著度结论；完整证据仍只在高级与维护里查看。'),
      list), sea),
    h(ProposalsTab, { data: props.data, onDecided: props.onDecided }))
}

function ProposalsTab(props: { data: PanelData; onDecided?: () => void }): any {
  const items = props.data.proposals ?? []
  const [busy, setBusy] = React.useState('')
  const [note, setNote] = React.useState(null as string | null)
  const [failure, setFailure] = React.useState(null as string | null)

  const decide = (proposalId: string, accept: boolean): void => {
    setBusy(proposalId)
    setFailure(null)
    setNote(null)
    postJson('/api/psyche/proposals/decide', { proposalId, accept })
      .then((payload: any) => {
        setNote(payload && payload.note ? String(payload.note) : '已记录你的决定。')
        if (props.onDecided) props.onDecided()
      })
      .catch((cause: any) => {
        setFailure(`${accept ? '批准' : '驳回'}失败：${cause && cause.message ? cause.message : String(cause)}`)
      })
      .finally(() => setBusy(''))
  }

  const actionButton = (label: string, onClick: () => void, tone: string, disabled: boolean): any =>
    h(
      'button',
      {
        type: 'button',
        onClick,
        disabled,
        style: {
          padding: '3px 10px',
          borderRadius: 5,
          border: `1px solid ${tone}`,
          background: 'transparent',
          color: disabled ? FAINT : tone,
          cursor: disabled ? 'default' : 'pointer',
          fontSize: 12,
        },
      },
      label,
    )

  return card(
    '待批提案',
    items.length === 0
      ? empty('没有提案。心灵想改自己的设定时会先在这里排队等你批。')
      : h(
          'div',
          null,
          items.map((item) =>
            h(
              'div',
              { key: item.proposalId, style: { padding: '8px 0', borderTop: '1px dashed rgba(127,127,127,0.2)' } },
              h(
                'div',
                { style: { display: 'flex', gap: 8, justifyContent: 'space-between', fontSize: 13 } },
                h('span', null, `${item.partition} · ${item.target}`),
                pill(item.status, item.status === 'pending' ? '#c08a2e' : FAINT),
              ),
              h('div', { style: { fontSize: 12, color: MUTED, marginTop: 2 } }, item.change),
              item.rationale
                ? h('div', { style: { fontSize: 12, color: FAINT, marginTop: 2 } }, item.rationale)
                : null,
              h('div', { style: { fontSize: 12, color: FAINT, marginTop: 2 } }, fmtTime(item.createdAt, '时间未知')),
              item.status === 'pending'
                ? h(
                    'div',
                    { style: { display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' } },
                    actionButton('批准', () => decide(item.proposalId, true), OK, busy === item.proposalId),
                    actionButton('驳回', () => decide(item.proposalId, false), BAD, busy === item.proposalId),
                    busy === item.proposalId
                      ? h('span', { style: { fontSize: 12, color: FAINT } }, '正在写入…')
                      : null,
                  )
                : null,
            ),
          ),
          note ? h('div', { style: { fontSize: 12, color: OK, marginTop: 8 } }, note) : null,
          failure ? h('div', { style: { fontSize: 12, color: BAD, marginTop: 8 } }, failure) : null,
        ),
  )
}

function ContactsTab(props: { data: PanelData }): any {
  const items = props.data.contacts ?? []
  return card(
    '认识的人',
    items.length === 0
      ? empty('还没有记下的人。第一次有互动时会自动建档。')
      : h(
          'div',
          null,
          // 没有 displayName 时退回 contactId（不暴露平台原始身份标识）。
          items.map((item) =>
            h(
              'div',
              {
                key: item.contactId,
                style: {
                  display: 'flex',
                  gap: 8,
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  padding: '6px 0',
                  borderTop: '1px dashed rgba(127,127,127,0.2)',
                  fontSize: 13,
                },
              },
              h(
                'span',
                null,
                item.displayName ?? item.contactId,
                h('span', { style: { color: FAINT, fontSize: 12, marginLeft: 6 } }, item.platform),
              ),
              h('span', { style: { color: MUTED, fontSize: 12 } }, item.bandLabel ?? '未建档'),
            ),
          ),
        ),
    // 只给档位不给分数：好感是主观量，报出数字就变成考核指标了。
    h('div', { style: { fontSize: 11, color: FAINT, marginTop: 8 } }, '好感只显示档位，不显示分数。'),
  )
}
