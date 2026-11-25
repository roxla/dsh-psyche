// 心灵 · 浏览器半侧：概览页（状态卡、初始化横幅、备份恢复、状态详情）


// ── 面板通用件 ────────────────────────────────────────────────

/**
 * 图表 / 数字 的单选切换（按钮样式的 radio）。
 * @param name 这一组的可访问名；@param view 当前视图；@param onChange 切换回调
 * 只负责「怎么显示」，不碰数据——同一份数据两个出口，数字视图方便核对。
 */
function viewSwitch(
  name: string,
  view: 'chart' | 'number',
  onChange: (next: 'chart' | 'number') => void,
): any {
  const item = (value: 'chart' | 'number', label: string): any => {
    const active = view === value
    return h(
      'button',
      {
        key: value,
        type: 'button',
        role: 'radio',
        'aria-checked': active,
        onClick: () => onChange(value),
        style: {
          padding: '2px 10px',
          fontSize: 12,
          lineHeight: '18px',
          cursor: 'pointer',
          borderRadius: 999,
          border: LINE,
          background: active ? 'rgba(127,127,127,.18)' : 'transparent',
          color: active ? undefined : MUTED,
          fontWeight: active ? 600 : 400,
        },
      },
      label,
    )
  }
  return h(
    'span',
    {
      role: 'radiogroup',
      'aria-label': name,
      style: { display: 'inline-flex', alignItems: 'center', gap: 4 },
    },
    item('chart', '图表'),
    item('number', '数字'),
  )
}

/**
 * 一张 metric 卡：小标题 + 大数字 + 可选脚注。
 * @param label 标题；@param value 值（节点或文本）；@param hint 脚注
 */
function metricTile(label: string, value: any, hint?: string): any {
  return h(
    'div',
    {
      key: label,
      style: {
        border: LINE,
        borderRadius: 10,
        padding: '10px 12px',
        minWidth: 0,
        background: 'rgba(127,127,127,0.04)',
      },
    },
    h('div', { style: { color: MUTED, fontSize: 12 } }, label),
    h('div', { style: { fontSize: 20, fontWeight: 600, marginTop: 2, wordBreak: 'break-all' } }, value),
    hint ? h('div', { style: { color: FAINT, fontSize: 11, marginTop: 2 } }, hint) : null,
  )
}

/**
 * 一个可切换的 tag（时间范围 / 刻度）。
 * @param label 文案；@param active 是否选中；@param onClick 点击回调
 */
function tagButton(label: string, active: boolean, onClick: () => void): any {
  return h(
    'button',
    {
      key: label,
      type: 'button',
      onClick,
      'aria-pressed': active,
      style: {
        appearance: 'none',
        border: LINE,
        borderRadius: 999,
        padding: '3px 10px',
        fontSize: 12,
        cursor: 'pointer',
        color: active ? 'inherit' : MUTED,
        background: active ? 'rgba(127,127,127,0.16)' : 'transparent',
        fontWeight: active ? 600 : 400,
      },
    },
    label,
  )
}

/**
 * 环形图：把「记忆由什么构成」摊成一个环。
 * @param segments 每段 label / value / color；@param size 外径像素
 * 用 SVG stroke-dasharray 画，不引图表库；颜色跟着面板的灰阶 + 一绿一红走。
 */
function donut(segments: { label: string; value: number; color: string }[], size: number): any {
  const total = segments.reduce((sum, seg) => sum + seg.value, 0)
  const radius = size / 2 - 10
  const circumference = 2 * Math.PI * radius
  let offset = 0
  return h(
    'div',
    { style: { position: 'relative', width: size, height: size, flex: '0 0 auto' } },
    h(
      'svg',
      { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': '记忆构成' },
      h('circle', {
        cx: size / 2,
        cy: size / 2,
        r: radius,
        fill: 'none',
        stroke: 'rgba(127,127,127,0.18)',
        strokeWidth: 12,
      }),
      segments.map((seg) => {
        const length = total > 0 ? (seg.value / total) * circumference : 0
        const dash = `${length} ${circumference - length}`
        const dashOffset = -offset
        offset += length
        return h('circle', {
          key: seg.label,
          cx: size / 2,
          cy: size / 2,
          r: radius,
          fill: 'none',
          stroke: seg.color,
          strokeWidth: 12,
          strokeDasharray: dash,
          strokeDashoffset: dashOffset,
          transform: `rotate(-90 ${size / 2} ${size / 2})`,
        })
      }),
    ),
    h(
      'div',
      {
        style: {
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        },
      },
      h('div', { style: { fontSize: 20, fontWeight: 600 } }, String(total)),
      h('div', { style: { fontSize: 11, color: FAINT } }, '条记忆'),
    ),
  )
}

/**
 * 阶段条：四段串行，已过的实心、当前的描边、后面的灰。
 * @param labels 阶段中文名（按顺序）；@param index 当前阶段下标（越界按 0）
 */
function stageTrack(labels: string[], index: number): any {
  const current = Math.max(0, Math.min(labels.length - 1, index))
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', margin: '8px 0 2px' } },
    labels.map((label, i) =>
      h(
        React.Fragment,
        { key: label },
        i > 0
          ? h('div', {
              style: {
                flex: '1 1 auto',
                height: 2,
                background: i <= current ? OK : 'rgba(127,127,127,0.25)',
              },
            })
          : null,
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', width: 40 } },
          h(
            'div',
            {
              style: {
                width: 16,
                height: 16,
                borderRadius: '50%',
                boxSizing: 'border-box',
                border: `2px solid ${i <= current ? OK : 'rgba(127,127,127,0.4)'}`,
                background: i < current ? OK : 'transparent',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 10,
                color: i < current ? '#fff' : OK,
              },
            },
            i < current ? '✓' : '',
          ),
          h('div', { style: { fontSize: 10, color: i === current ? MUTED : FAINT, marginTop: 2 } }, label),
        ),
      ),
    ),
  )
}

/**
 * 预算条：已用 / 上限的一条横条，超过九成转红。
 * @param used 已用；@param budget 上限；@param hint 条下说明
 */
function budgetBar(used: number, budget: number, hint: string): any {
  const ratio = budget > 0 ? Math.min(1, Math.max(0, used / budget)) : 0
  return h(
    'div',
    { style: { marginTop: 8 } },
    h(
      'div',
      { style: { height: 6, background: 'rgba(127,127,127,0.18)', borderRadius: 3, overflow: 'hidden' } },
      h('div', {
        style: { width: `${Math.round(ratio * 100)}%`, height: '100%', background: ratio > 0.9 ? BAD : OK },
      }),
    ),
    h('div', { style: { fontSize: 11, color: FAINT, marginTop: 2 } }, hint),
  )
}

// ── 首启横幅（I-7）────────────────────────────────────────────
/**
 * 人格初始化横幅：放在页头与页签之间，按服务端快照的五种状态渲染。
 *
 * 设计约束（I-7）：
 *   - 只调 Owner 路由（GET /init、POST /init/preset、POST /init/accept-drift），
 *     不自己拼 claim、不直接改文件；写动作全部由 PersonaInitService 完成。
 *   - 预设选择必须二次确认；请求期间禁用重复提交；成功后让父级 reload，
 *     显示以服务端重新读取的状态为准（不拿 POST 返回值直接改本地状态）。
 *   - locked 完全不渲染；damaged 只给诊断与人工处理路径，不出现「自动修复」按钮。
 * @param props.data 面板快照（personaInit 字段决定显示哪一态）
 * @param props.onChanged 成功后触发父级刷新（重新读 /panel）
 */
function InitBanner(props: { data: PanelData; onChanged: () => void }): any {
  const snapshot = props.data ? props.data.personaInit : null
  const state = snapshot ? snapshot.state : 'uninitialized'
  const [presets, setPresets] = React.useState([] as PresetRow[])
  const [chosen, setChosen] = React.useState('')
  // 二次确认：'' 表示没有待确认的动作；'init' / 'drift' 对应两种写操作。
  const [confirming, setConfirming] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null as string | null)
  // 初始化的两个入口：选预设 / 自定义（导入读完后也落到自定义表单）。
  const [mode, setMode] = React.useState('preset' as 'preset' | 'custom' | 'import')
  const [customName, setCustomName] = React.useState('')
  const [customIdentity, setCustomIdentity] = React.useState('')
  const [importedFrom, setImportedFrom] = React.useState('')

  // 只有未初始化时才需要预设列表；其它状态不必多打一次接口。
  const needPresets = state === 'uninitialized'
  React.useEffect(() => {
    if (!needPresets) return undefined
    let alive = true
    browser
      .fetch('/api/psyche/init', { headers: { accept: 'application/json' } })
      .then((response: any) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((body: any) => {
        if (!alive) return
        const rows: PresetRow[] = Array.isArray(body && body.presets) ? body.presets : []
        setPresets(rows)
        // 默认选中「推荐」的那套，但初始化仍然要人自己点确认——预选不等于替人拍板。
        const recommended = rows.filter((row: PresetRow) => row.recommended)
        if (recommended.length > 0) setChosen((current: string) => current || recommended[0].id)
      })
      .catch(() => {
        if (alive) setPresets([])
      })
    return () => {
      alive = false
    }
  }, [needPresets])

  if (state === 'locked') return null
  if (!snapshot && props.data && props.data.personaInitError) {
    // 判定失败也要让人看见原因，而不是把横幅整块吞掉。
    return bannerShell('bad', '人格状态读不出来', props.data.personaInitError, null, null)
  }

  /** 发一个初始化写请求：成功清确认态并让父级重读；失败把服务端错误留在横幅里。 */
  const send = (path: string, payload: Record<string, unknown>): void => {
    setBusy(true)
    setError(null)
    browser
      .fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      .then((response: any) =>
        response.json().then((body: any) => {
          if (!response.ok || (body && body.ok === false)) {
            throw new Error(errorMessageOf(body, `HTTP ${response.status}`))
          }
          return body
        }),
      )
      .then(() => {
        setConfirming('')
        props.onChanged()
      })
      .catch((cause: any) => setError(cause && cause.message ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  if (state === 'uninitialized') {
    const selected = presets.find((row: PresetRow) => row.id === chosen) || null
    const identityLength = customIdentity.trim().length
    const identityPlaceholder = /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/.test(customIdentity)
    const customReady = identityLength >= 200 && identityLength <= 8000 && !identityPlaceholder
    const switchMode = (value: 'preset' | 'custom' | 'import'): void => {
      setMode(value)
      setConfirming('')
      setError(null)
    }
    const tab = (value: 'preset' | 'custom' | 'import', label: string): any =>
      h(
        'button',
        {
          type: 'button',
          key: value,
          disabled: busy,
          onClick: () => switchMode(value),
          style: { ...buttonStyle(mode === value ? OK : undefined), padding: '4px 12px' },
        },
        label,
      )
    // 二次确认块：预设/自定义共用，避免两处各写一遍确认文案。
    const confirmBlock = (text: string, onConfirm: () => void): any =>
      h(
        'div',
        { style: { display: 'grid', gap: 6, padding: '8px 10px', border: `1px solid ${BAD}`, borderRadius: 8 } },
        h('div', { style: { fontSize: 12 } }, text),
        h(
          'div',
          { style: { display: 'flex', gap: 8 } },
          h('button', { type: 'button', disabled: busy, onClick: onConfirm, style: buttonStyle(BAD) }, busy ? '正在初始化…' : '确认初始化'),
          h('button', { type: 'button', disabled: busy, onClick: () => setConfirming(''), style: buttonStyle() }, '取消'),
        ),
      )
    // 导入：读纯文本/JSON 后填进自定义表单，最后仍走同一次确认。
    const onImport = (event: any): void => {
      const file = event.target.files && event.target.files[0]
      if (!file) return
      const reader = new (globalThis as any).FileReader()
      reader.onload = () => {
        const text = String(reader.result || '')
        let name = ''
        let identity = text
        if (/\.json$/i.test(String(file.name))) {
          try {
            const parsed = JSON.parse(text)
            if (parsed && typeof parsed === 'object') {
              if (typeof parsed.identity === 'string') identity = parsed.identity
              if (typeof parsed.name === 'string') name = parsed.name
            }
          } catch {
            setError('这个 JSON 读不出来：检查它是不是 { "name": "...", "identity": "..." } 结构')
            return
          }
        }
        setCustomName(name)
        setCustomIdentity(identity)
        setImportedFrom(String(file.name))
        switchMode('custom')
      }
      reader.onerror = () => setError('文件读取失败')
      reader.readAsText(file)
    }

    const presetPanel = h(
      'div',
      { style: { display: 'grid', gap: 8 } },
      presets.length === 0
        ? h('div', { style: { fontSize: 12, color: FAINT } }, '预设列表暂时读不到（检查 packages/core/presets/ 是否完整）。')
        : h(
            'div',
            { role: 'radiogroup', 'aria-label': '初始人格预设', style: { display: 'grid', gap: 6 } },
            presets.map((row: PresetRow) =>
              h(
                'label',
                {
                  key: row.id,
                  style: {
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-start',
                    padding: '8px 10px',
                    border: `1px solid ${row.id === chosen ? OK : 'rgba(127,127,127,.25)'}`,
                    borderRadius: 8,
                    cursor: busy ? 'not-allowed' : 'pointer',
                    opacity: busy ? 0.6 : 1,
                  },
                },
                h('input', {
                  type: 'radio',
                  name: 'psyche-init-preset',
                  checked: row.id === chosen,
                  disabled: busy || confirming === 'init',
                  onChange: () => setChosen(row.id),
                  style: { marginTop: 2 },
                }),
                h(
                  'span',
                  { style: { display: 'grid', gap: 2, minWidth: 0 } },
                  h(
                    'span',
                    { style: { fontSize: 13, fontWeight: 600 } },
                    row.name,
                    row.recommended ? h('span', { style: { marginLeft: 6, fontSize: 11, color: OK } }, '推荐') : null,
                    row.draft ? h('span', { style: { marginLeft: 6, fontSize: 11, color: FAINT } }, '草稿') : null,
                  ),
                  h('span', { style: { fontSize: 12, color: MUTED } }, row.summary),
                  h('span', { style: { fontSize: 11, color: FAINT } }, `${row.id} · ${row.version}`),
                ),
              ),
            ),
          ),
      confirming === 'init'
        ? confirmBlock(`确认把人格锁定到「${selected ? selected.name : chosen}」？锁定后只能走显式的重开流程。`, () =>
            send('/api/psyche/init/preset', { presetId: chosen }),
          )
        : h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('button', { type: 'button', disabled: busy || !chosen, onClick: () => setConfirming('init'), style: buttonStyle(OK) }, '初始化这个人格'),
          ),
    )

    const customPanel = h(
      'div',
      { style: { display: 'grid', gap: 8 } },
      h(
        'div',
        { style: { fontSize: 12, color: MUTED } },
        '自己写身份正文：200–8000 字，会原样写入 identity.md。不要留没替换的 {{name}} 这类占位符；可以从「她是谁、怎么说话、在意什么、不会做什么」写起。',
      ),
      importedFrom ? h('div', { style: { fontSize: 12, color: FAINT } }, `已从 ${importedFrom} 读入，确认前可以继续改。`) : null,
      h('input', {
        type: 'text',
        value: customName,
        disabled: busy,
        placeholder: '名字（可选，缺省「自定义人格」）',
        onChange: (event: any) => setCustomName(event.target.value),
        style: { padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit' },
      }),
      h('textarea', {
        value: customIdentity,
        disabled: busy,
        rows: 10,
        placeholder: '身份正文…',
        onChange: (event: any) => setCustomIdentity(event.target.value),
        style: {
          padding: '6px 8px',
          borderRadius: 6,
          border: '1px solid rgba(127,127,127,.35)',
          background: 'transparent',
          color: 'inherit',
          resize: 'vertical',
          fontFamily: 'inherit',
          lineHeight: 1.6,
        },
      }),
      h(
        'div',
        { style: { fontSize: 11, color: identityPlaceholder || identityLength > 8000 ? BAD : identityLength >= 200 ? OK : FAINT } },
        identityPlaceholder
          ? '还有没替换的占位符（形如 {{name}}），先填好再初始化。'
          : `字数 ${identityLength} / 200–8000`,
      ),
      confirming === 'custom'
        ? confirmBlock(`确认把人格锁定到「${customName.trim() || '自定义人格'}」？锁定后只能走显式的重开流程。`, () =>
            send(
              '/api/psyche/init/custom',
              customName.trim()
                ? { name: customName.trim(), identity: customIdentity.trim() }
                : { identity: customIdentity.trim() },
            ),
          )
        : h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('button', { type: 'button', disabled: busy || !customReady, onClick: () => setConfirming('custom'), style: buttonStyle(OK) }, '用这段正文初始化'),
          ),
    )

    const importPanel = h(
      'div',
      { style: { display: 'grid', gap: 8 } },
      h(
        'div',
        { style: { fontSize: 12, color: MUTED } },
        '从本地文件导入：.md / .txt 整体当身份正文；.json 读 { "name": "...", "identity": "..." }。读进来后会填到「自定义」表单，确认前可以改。',
      ),
      h('input', { type: 'file', accept: '.md,.txt,.json', disabled: busy, onChange: onImport }),
      importedFrom ? h('div', { style: { fontSize: 12, color: FAINT } }, `上次读入：${importedFrom}`) : null,
    )

    const body = h(
      'div',
      { style: { display: 'grid', gap: 10 } },
      h(
        'div',
        { style: { fontSize: 12, color: MUTED } },
        '选一套初始人格，或者自己写 / 从文件导入。初始化后 identity.md 就是原文权威，之后只能用显式流程重开——不会自动回退默认预设。',
      ),
      h('div', { role: 'tablist', style: { display: 'flex', gap: 6 } }, tab('preset', '选预设'), tab('custom', '自定义'), tab('import', '导入')),
      mode === 'preset' ? presetPanel : mode === 'custom' ? customPanel : importPanel,
      error ? h('span', { style: { fontSize: 12, color: BAD } }, error) : null,
    )
    return bannerShell('warn', '人格还没有初始化', '现在只有记忆与工具；人格要由你选一套预设、自己写，或从文件导入并确认后才锁定。', body, null)
  }

  if (state === 'initializing') {
    const claim = snapshot ? snapshot.claim : null
    const when = claim && claim.startedAt ? fmtTime(claim.startedAt) : '未知时间'
    const who = claim && claim.pid !== null && claim.pid !== undefined ? `PID ${claim.pid}` : '未知进程'
    const alive = claim && claim.ownerAlive === true
    return bannerShell(
      'warn',
      '初始化没有走完',
      `上次初始化停在半路（${when}，${who}${alive ? '，进程还活着' : ''}）。数据不会被自动改写，也不会被当成已锁定；请等进程结束后人工收尾（CLI 收尾命令在 I-8 提供），不要重复点初始化。`,
      null,
      null,
    )
  }

  if (state === 'identity-drift') {
    const body = h(
      'div',
      { style: { display: 'grid', gap: 6 } },
      h('div', { style: { fontSize: 12, color: MUTED } }, 'identity.md 在插件外被改过：当前文件的哈希与锁定记录不一致。原文仍然是权威，这里只决定要不要把「新原文」记成当前身份。'),
      confirming === 'drift'
        ? h(
            'div',
            { style: { display: 'flex', gap: 8 } },
            h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => send('/api/psyche/init/accept-drift', {}),
                style: buttonStyle(BAD),
              },
              busy ? '正在记录…' : '确认接受新原文',
            ),
            h('button', { type: 'button', disabled: busy, onClick: () => setConfirming(''), style: buttonStyle() }, '取消'),
          )
        : h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('button', { type: 'button', disabled: busy, onClick: () => setConfirming('drift'), style: buttonStyle(OK) }, '我确认接受新原文'),
            error ? h('span', { style: { fontSize: 12, color: BAD } }, error) : null,
          ),
    )
    return bannerShell('warn', '人格原文被改过', snapshot ? snapshot.detail : '', body, null)
  }

  // damaged：只给原因与人工路径，不提供任何「自动修复/恢复默认」按钮。
  return bannerShell(
    'bad',
    '初始化状态异常',
    snapshot ? snapshot.detail : '身份文件或初始化记录无法安全解释。',
    h(
      'div',
      { style: { fontSize: 12, color: MUTED } },
      '先备份整个数据根，再人工检查 identity.md 与 persona.json；确认原因后再决定是恢复备份还是显式重开。插件不会自动把它修成默认人格。',
    ),
    null,
  )
}

/** 横幅外壳：左色条 + 标题 + 说明 + 内容。tone 只用三种：warn/bad/ok。 */
function bannerShell(tone: string, title: string, detail: string, content: any, extra: any): any {
  const color = tone === 'bad' ? BAD : tone === 'ok' ? OK : 'rgba(234,170,60,.9)'
  return h(
    'div',
    {
      'data-dsh-part': 'init-banner',
      style: {
        flex: '0 0 auto',
        margin: `10px ${PAD_X}px 0`,
        border: `1px solid ${color}`,
        borderLeft: `4px solid ${color}`,
        borderRadius: 8,
        padding: '10px 12px',
        display: 'grid',
        gap: 6,
        wordBreak: 'break-word',
      },
    },
    h('div', { style: { fontSize: 13, fontWeight: 600 } }, title),
    detail ? h('div', { style: { fontSize: 12, color: MUTED } }, detail) : null,
    content,
    extra,
  )
}

/** 横幅里的小按钮：统一外观，颜色只表达主次，不做危险动作的视觉误导。 */
function buttonStyle(color?: string): Record<string, any> {
  return {
    appearance: 'none',
    background: 'transparent',
    border: `1px solid ${color || 'rgba(127,127,127,.35)'}`,
    color: color || 'inherit',
    borderRadius: 6,
    padding: '4px 12px',
    fontSize: 12,
    cursor: 'pointer',
  }
}

// ── 运维页 ────────────────────────────────────────────────────
/**
 * 运维页：读 /api/psyche/ops，并能发三个写动作（备份 / 评估闸门 / 清日志）。
 * @param props.stamp 父级刷新计数器
 * 副作用：GET 一次 + 点击时 POST；POST 是面板里仅有的写操作，所以按钮要置忙。
 */
/**
 * 恢复卡片：把「导入一个迁移包」做成明确的两阶段交互（§34.14）。
 *
 * 阶段 A（本卡片）：选包 → 准备（服务端只解到数据根**同级**暂存区）→
 *   非空时打对包 ID → 确认（此时才冻结写入并导预恢复包）。
 * 阶段 B（下次启动）：插件在开库之前自动换目录；本卡片只负责提示「关掉 DSH 重开」。
 *
 * 为什么不在按钮里直接换目录：Windows 上库文件被插件自己打开着就改不了名，
 * 所以恢复必须「在线准备、离线应用」两段，面板只做前半段。
 */
function RestoreCard(props: { stamp: number; archives: ArchivesView | null }): any {
  // 恢复块嵌在运维页里，跟着深色控制台走；逻辑与取数完全不动。
  const BAD = '#f0a0a0'
  const OK = SET_GREEN
  const MUTED = SET_FAINT
  const FAINT = SET_FAINT
  const LINE = SET_LINE_SOFT
  const card = consoleCard
  const row = consoleRow
  const pill = darkPill
  const table = consoleTable
  const empty = darkEmpty

  const status = useEndpoint<RestoreStatusView>('/api/psyche/restore/status', props.stamp)
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState(null as string | null)
  const [failure, setFailure] = React.useState(null as string | null)
  const [file, setFile] = React.useState('')
  const [word, setWord] = React.useState('')

  const view = status.data
  const journal = view && view.journal ? view.journal : null
  const target = view && view.target ? view.target : null
  const rows = (props.archives && props.archives.rows) || []
  // 默认选中最新一个（列表本身按时间倒序），用户不选也能一键准备。
  const chosen = file || (rows[0] ? rows[0].file : '')

  const run = (label: string, path: string, body: any): void => {
    setBusy(true)
    setFailure(null)
    setNote(null)
    postJson(path, body)
      .then((payload: any) => {
        const lines: string[] = []
        if (payload && typeof payload.note === 'string' && payload.note) lines.push(payload.note)
        if (payload && Array.isArray(payload.notes)) {
          for (const item of payload.notes) lines.push(String(item))
        }
        setNote(lines.join('\n') || `${label}完成`)
      })
      .catch((cause: any) => {
        setFailure(`${label}失败：${cause && cause.message ? cause.message : String(cause)}`)
      })
      .finally(() => setBusy(false))
  }

  const btn = (label: string, onClick: () => void, disabled?: boolean): any =>
    h(
      'button',
      {
        type: 'button',
        onClick,
        disabled: disabled === true || busy,
        style: {
          padding: '5px 12px',
          borderRadius: 6,
          border: LINE,
          background: 'transparent',
          color: disabled === true || busy ? FAINT : 'inherit',
          cursor: disabled === true || busy ? 'default' : 'pointer',
          fontSize: 13,
        },
      },
      label,
    )

  const line = (text: string, color?: string): any =>
    h(
      'div',
      { style: { fontSize: 13, lineHeight: 1.7, color: color || MUTED, whiteSpace: 'pre-wrap' } },
      text,
    )

  const stateText =
    target == null
      ? '读不到当前数据状态'
      : target.state === 'empty'
        ? '空人格：可以直接导入，不用确认词'
        : target.state === 'used'
          ? `已有内容（用户表共 ${target.totalRows} 行）：导入会整体覆盖，不能合并`
          : '判定不出来：导入会被拒绝（先修好库再来）'

  const children: any[] = [line(`当前数据：${stateText}`)]
  if (status.error) children.push(line(`读恢复状态失败：${status.error}`, BAD))
  if (view && view.boot && view.boot.restoreError) {
    children.push(line(`上次启动的恢复门禁没通过：${view.boot.restoreError}`, BAD))
  }

  if (journal) {
    children.push(
      line(
        `待恢复任务：${journal.restoreId} · 包 ${journal.packageId} · 阶段 ${journal.phase}`,
        journal.phase === 'pending' ? OK : MUTED,
      ),
    )
    if (journal.phase === 'prepared') {
      if (journal.mode === 'overwrite') {
        children.push(
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } },
            h('input', {
              value: word,
              onChange: (event: any) => setWord(event.target.value),
              placeholder: `输入完整包 ID：${journal.packageId}`,
              style: {
                flex: '1 1 260px',
                minWidth: 200,
                padding: '5px 8px',
                borderRadius: 6,
                border: LINE,
                background: 'transparent',
                color: 'inherit',
                fontSize: 13,
              },
            }),
            btn('确认覆盖', () =>
              run('确认', '/api/psyche/restore/confirm', {
                restoreId: journal.restoreId,
                confirmation: word,
              }),
            ),
          ),
        )
      } else {
        children.push(
          h(
            'div',
            { style: { marginTop: 8 } },
            btn('确认导入', () =>
              run('确认', '/api/psyche/restore/confirm', { restoreId: journal.restoreId }),
            ),
          ),
        )
      }
      children.push(
        h(
          'div',
          { style: { marginTop: 8 } },
          btn('取消这次恢复', () =>
            run('取消', '/api/psyche/restore/cancel', { restoreId: journal.restoreId }),
          ),
        ),
      )
    }
    if (journal.phase === 'pending') {
      children.push(
        line(
          '已锁定：请**完全关闭 DSH 再重新打开**，插件会在开库之前替换数据目录（当前目录还没动）。',
          OK,
        ),
      )
    }
    if (journal.phase === 'completed') {
      children.push(line('这次恢复已经完成，旧目录与预恢复包都保留着，确认没问题可以自行清理。'))
    }
    if (journal.phase === 'recovery_required') {
      children.push(
        line(
          `恢复中断在现场不明确的状态，需要人工核对（插件不会自动删任何目录）：\n  旧目录 ${journal.oldPath}`,
          BAD,
        ),
      )
    }
  } else {
    children.push(
      h(
        'div',
        { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } },
        rows.length > 0
          ? h(
              'select',
              {
                value: chosen,
                onChange: (event: any) => setFile(event.target.value),
                style: {
                  flex: '1 1 260px',
                  minWidth: 200,
                  padding: '5px 8px',
                  borderRadius: 6,
                  border: LINE,
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: 13,
                },
              },
              rows.map((row) => h('option', { key: row.file, value: row.file }, row.name)),
            )
          : line('还没有可用的迁移包：先在下面「迁移包」卡片里导出一个。'),
        btn(
          '准备导入',
          () => run('准备', '/api/psyche/restore/prepare', { file: chosen }),
          rows.length === 0 || target == null || target.state === 'unknown',
        ),
      ),
    )
  }

  if (note) children.push(line(note, OK))
  if (failure) children.push(line(failure, BAD))

  const badge =
    journal == null
      ? pill('空闲', MUTED)
      : journal.phase === 'pending'
        ? pill('待重启应用', OK)
        : journal.phase === 'prepared'
          ? pill('已准备', MUTED)
          : journal.phase === 'completed'
            ? pill('已完成', OK)
            : pill(journal.phase, BAD)

  return card('恢复（导入迁移包）', h(React.Fragment, null, ...children), badge)
}

// ── 状态页 ────────────────────────────────────────────────────
// 阶段顺序与 src/lib/derive.ts 的 PHASE_ORDER 一致：只用来画进度条，不参与判定。
const STAGE_KEYS = ['trust', 'autonomy', 'initiative', 'integration']
const STAGE_LABELS = ['信任', '自主', '主动', '整合']

/**
 * 状态页：把 panel 快照摊成一叠卡片（仪表盘 / 自我 / 成长 / 重要度 / 折叠 / 存储 / 自检）。
 * @param props.data 面板快照。本组件不做空判——调用方保证有 data 才挂载它
 * 状态：纯渲染，无本地 state、无副作用；卡片顺序由 children 数组决定。
 */
function StatusDetails(props: { data: PanelData; stamp: number }): any {
  // 深色控制台里复用同一套卡片/行/胶囊：在函数作用域内遮蔽全局浅色实现，
  // 数据与结构完全不动，只换观感。
  const BAD = 'var(--lb-error)'
  const OK = SET_GREEN
  const MUTED = SET_FAINT
  const FAINT = SET_FAINT
  const LINE = SET_LINE_SOFT
  const card = consoleCard
  const row = consoleRow
  const pill = darkPill
  const table = consoleTable
  const empty = darkEmpty
  const metricTile = consoleTile

  const data = props.data
  const state = data.state
  const storage = data.storage as any
  // counts 挂在 state 下面：state 为 null 时整块跳过，而不是渲染一排 0。
  const counts = state ? state.counts : null
  const growth = data.growth
  // 用数组 push 而不是写一长串 Fragment：每块都可能是可选的，增删排序更直观。
  const children: any[] = []

  // 四块可视图各自的显示方式：图表是默认，数字视图给核对用。
  // 状态放在组件顶层（hooks 不能进条件分支）；数据本身不变，只是换一个出口。
  const [memoryView, setMemoryView] = React.useState('chart' as 'chart' | 'number')

  // 启动失败放最前：它通常就解释了后面为什么全是「未就绪」。
  if (data.error) {
    children.push(
      card(
        '启动有问题',
        h(
          'div',
          { style: { fontSize: 13, color: BAD, wordBreak: 'break-word' } },
          `${data.error.code ?? 'E_UNKNOWN'} — ${data.error.error ?? '未知错误'}`,
        ),
      ),
    )
  }

  // 「自我」永远占一格：库没起来也显示一行「数据库还没准备好」，比整页空白诚实。
  children.push(
    card(
      '自我',
      state
        ? h(
            'div',
            null,
            row('人格', `${state.persona.id}（${state.persona.type}）`),
            row('阶段', growth ? `${growth.stageLabel}（${growth.stage}）` : state.phase.phase),
            row(
              '自我认知',
              state.self.view ? truncate(state.self.view, 120) : '还没写过',
              `v${state.self.revision}`,
            ),
            row('上次更新', fmtTime(state.self.updatedAt,'还没更新过')),
            row('阶段自', fmtTime(state.phase.since,'未知')),
          )
        : empty('数据库还没准备好'),
      data.ok ? pill('就绪', OK) : pill('未就绪', BAD),
    ),
  )

  // 仪表盘：先给一眼能读的总量，再往下才是明细。
  // 数据同源自 state.counts；库没起来时整块跳过，不渲染一排 0。
  if (counts) {
    const dashRows: [string, string, string][] = [
      ['来源', String(counts.sources), 'Source'],
      ['事件', String(counts.events), 'Event'],
      ['结论', String(counts.artifacts), `版本 ${counts.revisions}`],
      ['操作', String(counts.operations), 'Operation'],
      ['活动窗', String(counts.activityWindows), '10 分钟组'],
      ['待批提案', String(counts.proposals), '等人批'],
      ['QQ 待处理', String(counts.pendingWrites), 'pending'],
    ]
    children.push(
      card(
        '仪表盘',
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))', gap: 10 } },
          ...dashRows.map(([label, value, hint]) => metricTile(label, value, hint)),
        ),
      ),
    )

    // 记忆构成：三段的占比比三个数字更容易看出「哪一层在长」。
    const total = counts.sources + counts.events + counts.artifacts
    const pct = (value: number): string => (total > 0 ? `${Math.round((value / total) * 100)}%` : '—')
    const memoryRows: [string, string, string][] = [
      ['来源', String(counts.sources), pct(counts.sources)],
      ['事件', String(counts.events), pct(counts.events)],
      ['结论', String(counts.artifacts), pct(counts.artifacts)],
    ]
    const legend = (label: string, value: number, color: string): any =>
      h(
        'div',
        { key: label, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
        h('span', { style: { width: 8, height: 8, borderRadius: 2, background: color } }),
        h('span', { style: { color: MUTED, width: 34 } }, label),
        h('span', null, String(value)),
        h('span', { style: { color: FAINT } }, total > 0 ? ` · ${Math.round((value / total) * 100)}%` : ''),
      )
    children.push(
      card(
        '记忆构成',
        memoryView === 'number'
          ? h(
              React.Fragment,
              null,
              table(['类型', '数量', '占比'], memoryRows),
              h(
                'div',
                { style: { color: FAINT, fontSize: 11, marginTop: 6 } },
                '只统计当前活库；数字不分高低',
              ),
            )
          : h(
              'div',
              { style: { display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' } },
              donut(
                [
                  { label: '来源', value: counts.sources, color: MUTED },
                  { label: '事件', value: counts.events, color: OK },
                  { label: '结论', value: counts.artifacts, color: BAD },
                ],
                132,
              ),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                legend('来源', counts.sources, MUTED),
                legend('事件', counts.events, OK),
                legend('结论', counts.artifacts, BAD),
                h('div', { style: { color: FAINT, fontSize: 11, marginTop: 2 } }, '只统计当前活库；数字不分高低'),
              ),
            ),
        viewSwitch('status-memory', memoryView, setMemoryView),
      ),
    )
  }

  // 未接入的雷达、亲密环与网络不作为真实状态展示。

  // B4：真实 Mood 区（当前语气 / 33 维 / 真实写入趋势）。数据走只读 GET，不掺占位值。
  children.push(h(MoodSection, { key: 'status-mood', stamp: props.stamp }))

  // C 阶段：三个记忆功能的运行时生效状态。这里只读——开关在宿主的插件设置页改，
  // 面板不回显「配置文件里写了什么」，只显示「现在实际是不是开着」。
  const behavior = data.behavior
  if (behavior) {
    const both = behavior.capture && behavior.injection
    children.push(
      card(
        '记忆行为',
        h(
          'div',
          null,
          row('自动采集会话', behavior.capture ? '开启' : '关闭'),
          row('自动注入记忆', behavior.injection ? '开启' : '关闭'),
          row('最终安全检查', '强制开启'),
          row('配置来源', '宿主插件设置'),
          row('配置加载', '启动时读取，重启生效'),
          h(
            'div',
            { style: { color: MUTED, fontSize: 12, marginTop: 6, lineHeight: 1.5 } },
            '采集只产生 Source，不会自动形成结论；注入仍受 Scope、披露与预算约束；最终安全检查是注入链路的 fail-closed 边界，不能通过普通配置关闭。开关在「插件 → 心灵」设置页修改，重启后生效——本面板只读，不提供第二套配置入口。',
          ),
          behavior.legacy.length > 0
            ? h('div', { style: { color: '#e5c07b', fontSize: 12, marginTop: 6 } }, behavior.legacy.join('；'))
            : null,
          behavior.warnings.length > 0
            ? h('div', { style: { color: '#e5c07b', fontSize: 12, marginTop: 6 } }, behavior.warnings.join('；'))
            : null,
        ),
        pill(both ? '运行中' : '部分关闭', both ? OK : MUTED),
      ),
    )
  }

  // 成长块只在服务端给出 growth 时出现（旧服务端/库未就绪时没有这块）。
  if (growth) {
    children.push(
      card(
        '成长',
        h(
          'div',
          null,
          row('算法版本', growth.algorithmVersion),
          row('瓶颈', growth.bottleneck ? growth.bottleneck : '暂无'),
          row('阶段自', fmtTime(growth.since, '未知')),
          // 阶段条：四段串行，一眼看出现在卡在哪一段；判定仍由服务端做。
          h(
            'div',
            { style: { marginTop: 4 } },
            stageTrack(STAGE_LABELS, STAGE_KEYS.indexOf(growth.stage)),
          ),
          growth.stalledAt ? row('停滞', fmtTime(growth.stalledAt)) : null,
          h(
            'div',
            { style: { marginTop: 6 } },
            // 闸门逐条列：✓ 已满足，'·' 还差着，右侧 have 是当前值，方便对差距。
            growth.gates.map((gate) =>
              h(
                'div',
                {
                  key: gate.gate,
                  style: {
                    display: 'flex',
                    gap: 8,
                    alignItems: 'baseline',
                    fontSize: 13,
                    padding: '3px 0',
                  },
                },
                h(
                  'span',
                  { style: { color: gate.passed ? OK : FAINT, width: 14 } },
                  gate.passed ? '✓' : '·',
                ),
                h('span', { style: { flex: '1 1 auto' } }, gate.label),
                h('span', { style: { color: FAINT, fontSize: 12 } }, gate.have),
              ),
            ),
          ),
          h('div', { style: { color: FAINT, fontSize: 12, marginTop: 6 } }, growth.derivationNote),
        ),
      ),
    )
  }

  // 重要度榜：分数只用于排序（服务端明确不注入模型），这里列出来供人工核对排序是否合理。
  if (data.salience && data.salience.length > 0) {
    children.push(
      card(
        '重要度',
        h(
          'div',
          null,
          // ● 实心 = 已攒够独立经历或反复验证；分数留两位，便于两条之间肉眼比对。
          data.salience.map((item) =>
            h(
              'div',
              {
                key: item.artifactId,
                style: { padding: '4px 0', borderBottom: `1px solid ${LINE}` },
              },
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                h(
                  'span',
                  { style: { color: item.solid ? OK : FAINT, width: 14, fontSize: 13 } },
                  item.solid ? '●' : '○',
                ),
                h(
                  'span',
                  { style: { flex: '1 1 auto', fontSize: 13, wordBreak: 'break-word' } },
                  truncate(item.statement, 44),
                ),
                h('span', { style: { color: FAINT, fontSize: 12 } }, item.score.toFixed(2)),
              ),
              h(
                'div',
                { style: { color: FAINT, fontSize: 11, marginLeft: 22, marginTop: 2 } },
                `${item.kind} · ${item.reasons.join(' · ')}`,
              ),
            ),
          ),
          h(
            'div',
            { style: { color: FAINT, fontSize: 12, marginTop: 6 } },
            '分数只用来排序，不注入模型、不进任何判据；● 表示已经攒够独立经历或反复验证。',
          ),
        ),
      ),
    )
  }

  // 折叠预览：这一块就是「此刻真会注入给模型的那几行」，用来核对裁剪与预算是否合理。
  if (data.fold) {
    const fold = data.fold
    children.push(
      card(
        '如果现在注入',
        h(
          'div',
          null,
          fold.lines.length === 0
            ? empty('还没有能进上下文的内容')
            : fold.lines.map((line) =>
                h(
                  'div',
                  {
                    key: line.id,
                    style: { fontSize: 13, padding: '2px 0', wordBreak: 'break-word' },
                  },
                  `· ${line.text}${line.truncated ? '' : ''}`,
                ),
              ),
          fold.foldedLine
            ? h('div', { style: { color: FAINT, fontSize: 12, marginTop: 4 } }, fold.foldedLine)
            : null,
          // 预算条：token 已用 / 上限，超九成转红。
          budgetBar(
            fold.usedTokens,
            fold.budgetTokens,
            `token ${fold.usedTokens}/${fold.budgetTokens} · 字 ${fold.usedChars}/${fold.budgetChars}（已先扣掉 410 token 地板）`,
          ),
        ),
      ),
    )
  }

  // 存储的键名是服务端透传的原始字段，这里照抄不改名，方便对着后端 / PRAGMA 结果排查。
  if (storage) {
    children.push(
      card(
        '存储',
        h(
          'div',
          null,
          row('驱动', String(storage.driver ?? data.driver ?? '—')),
          row('user_version', String(storage.userVersion ?? '—')),
          row('表', String(storage.tables ?? '—')),
          row('journal', String(storage.journalMode ?? '—')),
          row('synchronous', String(storage.synchronous ?? '—')),
          row('体积', fmtBytes(storage.bytes)),
          row(
            '慢查询',
            `${storage.slowQueries ?? 0} 次`,
            `最慢 ${storage.maxQueryMs ?? 0} ms`,
          ),
        ),
      ),
    )
  }

  // 能力自检：启动时跑一次的静态检查，有失败项时右上角那颗药丸转红提醒。
  if (data.selfCheck) {
    children.push(
      card(
        '能力自检',
        h(
          'div',
          null,
          data.selfCheck.items.map((item) =>
            h(
              'div',
              {
                key: item.name,
                style: { display: 'flex', gap: 8, fontSize: 12, padding: '2px 0' },
              },
              h('span', { style: { color: item.ok ? OK : BAD, width: 14 } }, item.ok ? '✓' : '✗'),
              h('span', { style: { width: 96, color: MUTED } }, item.name),
              h('span', { style: { flex: '1 1 auto', color: FAINT, wordBreak: 'break-all' } }, item.detail),
            ),
          ),
          row('备份方式', data.selfCheck.backupMode ?? '—'),
        ),
        data.selfCheck.ok ? pill('通过', OK) : pill('有失败项', BAD),
      ),
    )
  }

  // 说明放最后：都是服务端建议的操作提示，看完前面几张卡再决定要不要照做。
  if (data.notes.length > 0) {
    children.push(
      card(
        '说明',
        h(
          'ul',
          { style: { margin: 0, paddingLeft: 18, fontSize: 12, color: MUTED } },
          data.notes.map((note) => h('li', { key: note }, note)),
        ),
      ),
    )
  }

  // 一次性交出去，由调用方的网格容器决定每张卡落在哪一格。
  return h('div', { className: 'lb-grid lb-detail-grid' }, ...children)
}

function StatusTab(props: { data: PanelData; stamp: number; stale: boolean; onNavigate: (tab: string) => void }): any {
  const data = props.data
  const [details, setDetails] = React.useState(false)
  const qq = useEndpoint<QqAdminView>('/api/psyche/qq', props.stamp)
  const mood = useEndpoint<MoodView>('/api/psyche/mood?limit=1', props.stamp)
  const counts = data.state?.counts
  const pending = data.proposals?.filter((p) => p.status === 'pending').length ?? 0
  const metric = (label: string, value: number | undefined, hint: string): any => h('div', { className: 'lb-metric', key: label },
    h('div', { className: 'lb-help' }, label), h('strong', null, value === undefined ? '—' : value.toLocaleString()), h('div', { className: 'lb-help' }, hint))
  const runtime = props.stale ? uiBadge('状态待核对', 'warn') : uiBadge(data.ok ? '已就绪' : '启动未完成', data.ok ? 'ok' : 'warn')
  const qqState = qq.error ? '读取失败' : !qq.data ? '读取中…' : !qq.data.enabled ? '未启用' :
    ({ connected: '已连接', degraded: '连接受限', disconnected: '已断开', unknown: '状态未知' })[qq.data.connection]
  return h('div', { className: 'lb-stack', 'data-dsh-part': 'overview-page' },
    data.error ? h('div', { className: 'lb-alert', role: 'alert' }, '启动未完成：', data.error.code ?? 'UNKNOWN', ' · ', data.error.error ?? '请到运维页查看') : null,
    h('div', { className: 'lb-metrics' }, metric('来源', counts?.sources, '保存的原始来源'), metric('事件', counts?.events, '已记录的事件'), metric('结论', counts?.artifacts, '当前活库中的结论')),
    h('div', { className: 'lb-grid' },
      uiSection('运行状态', h('div', null,
        uiRow('插件与数据库', runtime, props.stale ? '显示最近成功读取的快照。' : '来自当前运行快照。'),
        uiRow('数据库自检', data.selfCheck ? uiBadge(data.selfCheck.ok ? '通过' : '有失败项', props.stale ? 'warn' : data.selfCheck.ok ? 'ok' : 'error') : '未取得结果'),
        uiRow('QQ 通道', qqState),
        h('div', { className: 'lb-links' }, uiButton('打开运维', () => props.onNavigate('ops')), uiButton('打开 QQ', () => props.onNavigate('qq'))))),
      uiSection('需要处理', h('div', null,
        uiRow('待审批提案', String(pending), '审批请查看具体提案与证据。'),
        uiRow('待处理写入', counts ? String(counts.pendingWrites) : '未取得数据'),
        data.behavior?.warnings?.length ? h('div', { className: 'lb-alert' }, data.behavior.warnings.join('；')) : null,
        h('div', { className: 'lb-links' }, uiButton('查看提案', () => props.onNavigate('proposals')), uiButton('调整设置', () => props.onNavigate('settings'))))),
      uiSection('当前语气', h('div', null,
        h('p', { style: { marginTop: 0 } }, mood.error ? '语气读取失败，请刷新重试。' : mood.data ? mood.data.tone.tone : '正在读取语气…'),
        h('p', { className: 'lb-help' }, '来自真实情绪快照，仅影响表达语气。'))),
      uiSection('记忆行为', h('div', null,
        uiRow('自动采集', data.behavior ? data.behavior.capture ? '开启' : '关闭' : '未取得数据'),
        uiRow('自动注入', data.behavior ? data.behavior.injection ? '开启' : '关闭' : '未取得数据'),
        uiRow('最终完整性检查', '始终开启')))),
    h('details', { className: 'lb-details', onToggle: (event: any) => setDetails(event.currentTarget.open) },
      h('summary', null, '查看详细数据'),
      details ? h(StatusDetails, { data, stamp: props.stamp }) : null))
}
