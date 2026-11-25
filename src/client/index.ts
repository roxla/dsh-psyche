// 心灵 · 浏览器半侧：入口（装配）
//
// 本文件在 tsconfig.client.json 的 files 里排最后：装载时把 React/h 装进共享作用域，
// 再交出 { name, inject, apply }。其余片段都是它前面的普通声明。
//
// 宿主契约：apply(ctx) 经 ctx.slots 注册 sidebar.panellist 与 main 两个槽；
// 数据全部来自自家只读路由 /api/psyche/*。

if (!loader) {
  console.error('[psyche] 宿主没有提供 __ModuleLoader__，侧栏面板无法注册')
} else {
  loader.load({
    id: MODULE_ID,
    factory: (req: (id: string) => any) => {
      React = req('react')
      h = React.createElement
      // 错误边界是 class 组件，必须等 React 到位再建。
      PageBoundary = createPageBoundary()

      /**
       * 插件入口：用 ctx.slots 注册两个槽——侧栏条目（图标）与主区页面。
       * @param ctx 宿主上下文；顺手存进 hostContext，给「打开插件设置页」按钮用
       * 副作用：注册槽位；返回的组合 dispose 负责按注册的逆序拆掉它们。
       */
      function apply(ctx: any): void {
        hostContext = ctx
        const slots = ctx && ctx.slots
        // 没有 slots 就直接放弃注册：UI 是可选能力，不该因为它把插件本体也拖垮。
        if (!slots || typeof slots.inject !== 'function') {
          console.warn('[psyche] 宿主没有 slots 服务，跳过侧栏注册')
          return
        }
        const label = () => '心灵'
        /**
         * 「记住这条」：挂在每条已定稿 assistant 消息的操作行。
         *
         * 只把 messageId 交给服务端；身份（Contact）由 Host 的 RuntimeInput 决定，
         * 正文由服务端从会话事件里读——客户端不传、也拿不到能篡改写入范围的东西。
         */
        // 「记住这条」：一个书签形状的图标按钮 + 自绘提示条。
        // 参照 dsh-mnemon 的「回复下加一个动作图标 + 悬浮说明」的形式，但做三处有意区分：
        // 1) 图标是书签（mnemon 是记忆/大脑），含义是「钉住这一条」；
        // 2) 提示条在按钮上方、青蓝描边、带小三角（mnemon 用宿主统一 Tooltip，在下方）；
        // 3) 点击直接写，不弹对话框；写完图标变成对勾，失败变成感叹号。
        function RememberAction(props: any): any {
          const [state, setState] = React.useState('idle')
          const [note, setNote] = React.useState('')
          const [hover, setHover] = React.useState(false)
          // 提示条浮层的锚点坐标（按钮中心 → 按钮下沿）；null 表示不显示。
          const [tipPos, setTipPos] = React.useState(null)
          const messageId = typeof props?.messageId === 'string' ? props.messageId : ''
          const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
          const ready = messageId !== '' && sessionId !== ''
          const done = state === 'created' || state === 'duplicate' || state === 'appended'
          // 颜色不写死：直接用宿主消息操作行的主题 token（见 style 里的
          // --dsw-alias-label-tertiary / -secondary / interactive-bg-hover），
          // 这样深浅主题切换时和复制 / 点赞 / 分支按钮同步。
          // 悬浮提示只留一句最短说明：按钮已经在「助手回复的操作行」里，
          // 不需要再解释它是什么。状态变化后的文案也压到四个字左右。
          const hint = note !== '' ? note : state === 'busy' ? '记录中…' : state === 'conflict' ? '冲突，已记为矛盾' : done ? (state === 'appended' ? '已追加' : '已记住') : '记住这条回复'
          const onClick = () => {
            if (!ready || state === 'busy' || done) return
            setState('busy')
            setNote('')
            fetch('/api/psyche/remember-message', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId, assistantMessageId: messageId }),
            })
              .then(async (response) => {
                const body = (await response.json().catch(() => null)) as
                  | { ok?: boolean; action?: string; error?: string; code?: string }
                  | null
                if (response.ok && body?.ok === true) {
                  const action = typeof body.action === 'string' ? body.action : 'created'
                  setState(action)
                  setNote(action === 'appended' ? '已把这条回复追加为证据' : '')
                  return
                }
                const text = errorMessageOf(body, `HTTP ${response.status}`)
                setState('error')
                setNote(text.length > 72 ? `${text.slice(0, 72)}…` : text)
              })
              .catch((error: unknown) => {
                setState('error')
                setNote(String(error))
              })
          }
          const icon = state === 'busy'
            ? [h('circle', { key: 'c', cx: 12, cy: 12, r: 7, strokeDasharray: '22 12', opacity: 0.9 })]
            : state === 'error'
              ? [h('circle', { key: 'c', cx: 12, cy: 12, r: 8 }), h('path', { key: 'p', d: 'M12 8v4.6' }), h('path', { key: 'd', d: 'M12 16h.01' })]
              : done
                ? [h('path', { key: 'p', d: 'M5.5 12.5l4.2 4.2L18.8 7.6' })]
                : [h('path', { key: 'b', d: 'M7.5 4.5h9a1 1 0 0 1 1 1v14l-5.5-3.4-5.5 3.4v-14a1 1 0 0 1 1-1z' })]
          const button = h(
            'button',
            {
              type: 'button',
              'aria-label': '记住这条回复',
              'aria-busy': state === 'busy' ? true : undefined,
              disabled: !ready,
              onClick,
              onMouseEnter: (event: any) => {
                setHover(true)
                const rect = event?.currentTarget?.getBoundingClientRect?.()
                if (rect) setTipPos({ left: rect.left + rect.width / 2, top: rect.bottom + 8 })
              },
              onMouseLeave: () => {
                setHover(false)
                setTipPos(null)
              },
              onFocus: (event: any) => {
                setHover(true)
                const rect = event?.currentTarget?.getBoundingClientRect?.()
                if (rect) setTipPos({ left: rect.left + rect.width / 2, top: rect.bottom + 8 })
              },
              onBlur: () => {
                setHover(false)
                setTipPos(null)
              },
              style: {
                // 与 dsh-client-ui-chat 的 MessageIconActions 完全对齐：
                // 28px 方形、6px padding、radius-sm、label-tertiary 文字色、
                // hover 用 interactive-bg-hover + label-secondary。
                width: 28,
                height: 28,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 6,
                borderRadius: 'var(--dsw-radius-sm, 6px)',
                border: 'none',
                background: hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(229,232,236,0.10))' : 'transparent',
                color: state === 'error'
                  ? 'var(--dsw-alias-label-danger, rgba(252,165,165,0.95))'
                  : hover && !done
                    ? 'var(--dsw-alias-label-secondary, rgba(229,232,236,0.92))'
                    : 'var(--dsw-alias-label-tertiary, rgba(229,232,236,0.62))',
                cursor: ready ? (done ? 'default' : 'pointer') : 'not-allowed',
                opacity: ready ? (state === 'busy' ? 0.65 : 1) : 0.4,
                transition: 'background 120ms ease, color 120ms ease',
              },
            },
            h(
              'svg',
              { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
              icon,
            ),
          )
          // 提示条不再放在按钮旁边的 span 里：消息操作行所在的容器有自己的 overflow 与
          // 层级，absolute + z-index 再大也会被裁掉。改成挂到 document.body 顶层的浮层，
          // 由按钮位置算出坐标——这一层不受任何容器裁剪。
          React.useEffect(() => {
            const doc = (globalThis as any).document
            if (!hover || tipPos === null || doc === undefined) return undefined
            const node = doc.createElement('div')
            node.textContent = hint
            node.style.cssText =
              'position:fixed;z-index:2147483000;padding:5px 9px;border-radius:6px;' +
              'border:1px solid rgba(255,255,255,0.08);background:rgba(38,44,54,0.98);' +
              'color:#fff;font-size:12px;line-height:1.5;white-space:nowrap;max-width:320px;' +
              'overflow:hidden;text-overflow:ellipsis;box-shadow:0 6px 16px rgba(0,0,0,0.4);' +
              'pointer-events:none;transform:translateX(-50%);'
            node.style.left = `${tipPos.left}px`
            node.style.top = `${tipPos.top}px`
            doc.body.appendChild(node)
            return () => {
              node.remove()
            }
          }, [hover, tipPos, hint])
          return h('span', { style: { display: 'inline-flex' } }, button)
        }

        // G1-A 手动交接：「保存开发进度」。
        //
        // 和「记住这条」同一行、不同的语义：记住这条写的是记忆证据，这个写的是
        // 「项目做到哪一步」。三步走——预览（只读）→ 编辑 → 取消或保存；取消不发
        // 保存请求，因此整条链路零写入。保存后把 checkpointId/revision 显示出来，
        // 便于「重启后按原 ID 与 revision 读回」这条验收人工核对。
        function SaveProgressAction(props: any): any {
          const [phase, setPhase] = React.useState('idle')
          const [draft, setDraft] = React.useState(null)
          const [note, setNote] = React.useState('')
          const [result, setResult] = React.useState(null)
          const [form, setForm] = React.useState({
            canonicalName: '',
            branchKey: '',
            currentGoal: '',
            completed: '',
            blockers: '',
            nextSteps: '',
            // 第 37 轮外部评审 P1（06）：事项标识原本写死成 'u-017'。
            // 它决定证据挂到哪个事项上，写死就会把每次保存都算到同一个无关事项。
            // 现在由预览回传上一版用的值，用户可以改。
            itemKey: '',
          })
          const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
          const ready = sessionId !== '' && phase !== 'saving'

          const field = (key: string) => (event: any) => {
            const value = event?.target?.value
            setForm((prev: any) => ({ ...prev, [key]: typeof value === 'string' ? value : '' }))
          }
          const lines = (raw: string) => raw.split('\n').map((line) => line.trim()).filter((line) => line !== '')

          const openPreview = () => {
            if (!ready) return
            setPhase('loading')
            setNote('')
            setResult(null)
            fetch('/api/psyche/project-handoff/preview', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            })
              .then(async (response) => {
                const body = (await response.json().catch(() => null)) as any
                if (!response.ok || body?.ok !== true) {
                  setPhase('idle')
                  setNote(errorMessageOf(body, `HTTP ${response.status}`))
                  return
                }
                setDraft(body)
                setForm({
                  canonicalName: body?.project?.canonicalName ?? '',
                  branchKey: body?.branchKey ?? '',
                  currentGoal: body?.base?.currentGoal ?? '',
                  // 重开表单要读回上一版已经写下的内容，不能清空——
                  // 清了之后用户只改目标再保存，已完成项和阻塞项会被静默抹掉。
                  completed: (body?.base?.completed ?? []).join('\n'),
                  blockers: (body?.base?.blockers ?? []).join('\n'),
                  nextSteps: (body?.base?.nextSteps ?? []).join('\n'),
                  itemKey: body?.base?.itemKey ?? '',
                })
                setPhase('ready')
              })
              .catch((error: unknown) => {
                setPhase('idle')
                setNote(String(error))
              })
          }

          const cancel = () => {
            // 取消 = 丢掉草稿，不发保存请求：整条链路零写入。
            setDraft(null)
            setResult(null)
            setNote('')
            setPhase('idle')
          }

          const save = () => {
            if (!ready || draft === null) return
            setPhase('saving')
            setNote('')
            fetch('/api/psyche/project-handoff/save', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                draftKey: draft.draftKey,
                projectId: draft?.project?.projectId ?? '',
                canonicalName: form.canonicalName,
                workspaceKey: draft?.project?.workspaceKey ?? '',
                branchKey: form.branchKey,
                currentGoal: form.currentGoal,
                completed: lines(form.completed),
                blockers: lines(form.blockers),
                nextSteps: lines(form.nextSteps),
                itemKey: form.itemKey.trim(),
                expectedRevision: draft?.base?.headRevision,
              }),
            })
              .then(async (response) => {
                const body = (await response.json().catch(() => null)) as any
                if (!response.ok || body?.ok !== true) {
                  setPhase('ready')
                  setNote(errorMessageOf(body, `HTTP ${response.status}`))
                  return
                }
                setResult(body)
                setPhase('saved')
              })
              .catch((error: unknown) => {
                setPhase('ready')
                setNote(String(error))
              })
          }

          const inputStyle = {
            width: '100%',
            boxSizing: 'border-box',
            padding: '5px 7px',
            borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,0.14))',
            background: 'var(--dsw-alias-bg-secondary, rgba(255,255,255,0.04))',
            color: 'inherit',
            fontSize: 12,
            lineHeight: 1.5,
          }
          const labelStyle = { fontSize: 11, opacity: 0.72, marginBottom: 2, display: 'block' }

          const panel = phase === 'ready' || phase === 'saving' || phase === 'saved'
            ? h(
                'div',
                {
                  role: 'dialog',
                  'aria-label': '保存开发进度',
                  style: {
                    position: 'fixed',
                    right: 24,
                    bottom: 96,
                    zIndex: 2147482600,
                    width: 360,
                    maxHeight: '70vh',
                    overflow: 'auto',
                    padding: 12,
                    borderRadius: 10,
                    border: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,0.14))',
                    background: 'var(--dsw-alias-bg-elevated, rgba(32,37,45,0.98))',
                    color: 'inherit',
                    boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
                    fontSize: 12,
                  },
                },
                [
                  h('div', { key: 'title', style: { fontWeight: 600, marginBottom: 6 } }, '保存开发进度'),
                  h('div', { key: 'meta', style: { opacity: 0.72, marginBottom: 8, lineHeight: 1.6 } }, [
                    h('div', { key: 'p' }, `项目：${draft?.project?.canonicalName ?? '未绑定（保存时新建）'}`),
                    h('div', { key: 'r' }, `区间：${draft?.range?.fromSeq ?? '?'} → ${draft?.range?.toSeq ?? '?'} · 证据 ${draft?.candidates?.length ?? 0} 条`),
                  ]),
                  h('label', { key: 'n', style: labelStyle }, '项目名'),
                  h('input', { key: 'ni', value: form.canonicalName, onChange: field('canonicalName'), style: inputStyle, disabled: phase !== 'ready' }),
                  h('label', { key: 'b', style: { ...labelStyle, marginTop: 6 } }, '分支'),
                  h('input', { key: 'bi', value: form.branchKey, onChange: field('branchKey'), style: inputStyle, disabled: phase !== 'ready', placeholder: '留空 = 通用进度' }),
                  h('label', { key: 'g', style: { ...labelStyle, marginTop: 6 } }, '当前目标'),
                  h('input', { key: 'gi', value: form.currentGoal, onChange: field('currentGoal'), style: inputStyle, disabled: phase !== 'ready' }),
                  h('label', { key: 'c', style: { ...labelStyle, marginTop: 6 } }, '已完成（每行一条）'),
                  h('textarea', { key: 'ci', value: form.completed, onChange: field('completed'), rows: 2, style: inputStyle, disabled: phase !== 'ready' }),
                  h('label', { key: 'k', style: { ...labelStyle, marginTop: 6 } }, '阻塞（每行一条）'),
                  h('textarea', { key: 'ki', value: form.blockers, onChange: field('blockers'), rows: 2, style: inputStyle, disabled: phase !== 'ready' }),
                  h('label', { key: 's', style: { ...labelStyle, marginTop: 6 } }, '下一步（每行一条）'),
                  h('textarea', { key: 'si', value: form.nextSteps, onChange: field('nextSteps'), rows: 3, style: inputStyle, disabled: phase !== 'ready' }),
                  h('label', { key: 'ik-l', style: { ...labelStyle, marginTop: 6 } }, '事项标识（证据挂在这一项下，留空则记为 manual）'),
                  h('input', { key: 'ik', value: form.itemKey, onChange: field('itemKey'), style: inputStyle, disabled: phase !== 'ready', placeholder: 'manual' }),
                  h('div', { key: 'ev', style: { marginTop: 8, opacity: 0.72, lineHeight: 1.6 } }, `证据：${(draft?.candidates ?? []).length} 条将被一并登记`),
                  note !== ''
                    ? h('div', { key: 'note', style: { marginTop: 6, color: 'var(--dsw-alias-label-danger, rgba(252,165,165,0.95))' } }, note)
                    : null,
                  result !== null
                    ? h(
                        'div',
                        { key: 'ok', style: { marginTop: 6, color: 'var(--dsw-alias-label-positive, rgba(134,239,172,0.95))', lineHeight: 1.6 } },
                        `已保存 ${result.checkpointId} r${result.revision}${result.replayed ? '（重放，未新增）' : ''}`,
                      )
                    : null,
                  h('div', { key: 'actions', style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 } }, [
                    h(
                      'button',
                      { key: 'cancel', type: 'button', onClick: cancel, style: { padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.14)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 } },
                      '取消',
                    ),
                    h(
                      'button',
                      {
                        key: 'save',
                        type: 'button',
                        onClick: save,
                        disabled: phase !== 'ready',
                        style: {
                          padding: '4px 12px',
                          borderRadius: 6,
                          border: 'none',
                          background: 'var(--dsw-alias-interactive-bg-hover, rgba(229,232,236,0.14))',
                          color: 'inherit',
                          cursor: phase === 'ready' ? 'pointer' : 'not-allowed',
                          opacity: phase === 'ready' ? 1 : 0.6,
                          fontSize: 12,
                        },
                      },
                      phase === 'saving' ? '保存中…' : '保存',
                    ),
                  ]),
                ],
              )
            : null

          const button = h(
            'button',
            {
              type: 'button',
              'aria-label': '保存开发进度',
              'aria-busy': phase === 'loading' ? true : undefined,
              disabled: sessionId === '',
              onClick: openPreview,
              style: {
                width: 28,
                height: 28,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 6,
                borderRadius: 'var(--dsw-radius-sm, 6px)',
                border: 'none',
                background: 'transparent',
                color: 'var(--dsw-alias-label-tertiary, rgba(229,232,236,0.62))',
                cursor: sessionId !== '' ? 'pointer' : 'not-allowed',
                opacity: sessionId !== '' ? 1 : 0.4,
                transition: 'background 120ms ease, color 120ms ease',
              },
            },
            h(
              'svg',
              { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
              [
                h('path', { key: 'a', d: 'M5 5.5h11.5L19 8v11.5H5z' }),
                h('path', { key: 'b', d: 'M8.5 5.5v5h7v-5' }),
                h('path', { key: 'c', d: 'M8.5 19v-5h7v5' }),
              ],
            ),
          )

          return h('span', { style: { display: 'inline-flex' } }, [button, panel])
        }

        // C2-D：本轮「记忆上下文」标签。
        //
        // 数据只来自 C2-C 的只读回执接口（session + turn 定位），不解析正文、不重新
        // Recall、不写任何东西；无回执 / 接口失败 / 条目全失效时整块不渲染，
        // 绝不显示一个凭空的条数。展开只是本地 UI 状态，DSH 消息对象与 Provider
        // 请求都不受影响。
        function MemoryContextChip(props: any): any {
          // DSH 传给 turnTail 的 turn 是 { turn: number, status: 'closed'|... }，
          // 不是裸数字；只有已关闭的轮次才有完整的 pre-step 回执。
          const turnBox = props?.turn && typeof props.turn === 'object' ? (props.turn as any) : null
          const turn = turnBox && typeof turnBox.turn === 'number' && Number.isFinite(turnBox.turn) ? (turnBox.turn as number) : null
          const closed = turnBox?.status === 'closed'
          const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
          const [open, setOpen] = React.useState(false)
          const [state, setState] = React.useState('idle') // idle | loading | ready | error
          const [view, setView] = React.useState(null)
          const [attempt, setAttempt] = React.useState(0)
          React.useEffect(() => {
            if (turn === null || sessionId === '' || !closed) return undefined
            let cancelled = false
            setState('loading')
            setView(null)
            fetch(`/api/psyche/injection?session=${encodeURIComponent(sessionId)}&turn=${turn}`)
              .then(async (response) => {
                const body = (await response.json().catch(() => null)) as
                  | { ok?: boolean; found?: boolean; injection?: unknown }
                  | null
                if (cancelled) return
                if (!response.ok || body?.ok !== true) {
                  setState('error')
                  return
                }
                const raw = body.found === true && body.injection && typeof body.injection === 'object' ? (body.injection as any) : null
                const items = Array.isArray(raw?.items) ? raw.items.filter((item: unknown) => item && typeof item === 'object') : []
                if (raw === null || items.length === 0) {
                  setView(null)
                  setState('ready')
                  return
                }
                setView({
                  runId: typeof raw.runId === 'string' ? raw.runId : '',
                  turn: typeof raw.turn === 'number' ? raw.turn : turn,
                  items,
                })
                setState('ready')
              })
              .catch(() => {
                if (!cancelled) setState('error')
              })
            return () => {
              cancelled = true
            }
          }, [sessionId, turn, closed, attempt])
          const chip = (text: string, onClick: (() => void) | null, key?: string): any =>
            h(
              'button',
              {
                key,
                type: 'button',
                onClick: onClick ?? undefined,
                style: {
                  appearance: 'none',
                  background: 'transparent',
                  border: '1px solid rgba(127,127,127,0.28)',
                  borderRadius: 999,
                  color: 'var(--dsw-alias-label-tertiary, #7a7a7a)',
                  padding: '3px 10px',
                  fontSize: 12,
                  lineHeight: 1.4,
                  cursor: onClick === null ? 'default' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  whiteSpace: 'nowrap',
                },
              },
              text,
            )
          if (turn === null || sessionId === '' || !closed) return null
          if (state === 'error') {
            // 失败不显示任何数量，只给一次轻量重试。
            return h('div', { style: { marginTop: 4 } }, [
              chip('🧠 记忆上下文读取失败 · 点此重试', () => setAttempt((value: number) => value + 1), 'retry'),
            ])
          }
          if (state !== 'ready' || view === null) return null
          const items: any[] = view.items
          const head = chip(`🧠 记忆上下文 · ${items.length} 条 ${open ? '▾' : '▸'}`, () => setOpen((value: boolean) => !value), 'head')
          if (!open) return h('div', { style: { marginTop: 4 } }, [head])
          const rows = items.map((item: any, index: number) =>
            h(
              'div',
              {
                key: `${typeof item.artifactId === 'string' ? item.artifactId : 'item'}:${index}`,
                style: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, lineHeight: 1.55 },
              },
              [
                h('span', { key: 'kind', style: { flex: '0 0 auto', opacity: 0.65, fontSize: 11 } }, typeof item.kind === 'string' ? item.kind : ''),
                h(
                  'span',
                  { key: 'statement', style: { flex: '1 1 auto', opacity: 0.88, wordBreak: 'break-word' } },
                  typeof item.statement === 'string' ? item.statement : '',
                ),
                item.state === 'challenged'
                  ? h('span', { key: 'doubt', style: { flex: '0 0 auto', opacity: 0.6, fontSize: 11 } }, '有争议')
                  : null,
                typeof item.supportEvidenceCount === 'number'
                  ? h('span', { key: 'ev', style: { flex: '0 0 auto', opacity: 0.55, fontSize: 11 } }, `证据 ${item.supportEvidenceCount}`)
                  : null,
              ],
            ),
          )
          return h('div', { style: { marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 } }, [
            head,
            h(
              'div',
              {
                key: 'body',
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: '2px 0 2px 10px',
                  borderLeft: '2px solid rgba(127,127,127,0.22)',
                  marginLeft: 6,
                },
              },
              rows,
            ),
          ])
        }

        try {
          // 外层 inject 包着：等 sidebar.panellist 这个槽真的存在了再注册，避免和宿主启动顺序抢跑。
          slots.inject('sidebar.panellist', () => {
            const disposeIcon = slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: PANEL_ORDER,
                label,
              },
              PsycheIcon,
            )
            // 主区页面必须和图标同进同退，所以嵌在同一个 inject 回调里注册，一次拿两个 dispose。
            const disposePage = slots.inject('main', () =>
              slots.register(
                {
                  name: 'main',
                  key: PANEL_ID,
                  inject: () => ({}),
                },
                PanelHost,
              ),
            )
            return () => {
              // dispose 有两种形态（函数本身 / { dispose() }），都兜住，别让卸载过程抛错。
              try {
                if (typeof disposePage === 'function') disposePage()
                else if (disposePage && typeof disposePage.dispose === 'function') disposePage.dispose()
              } catch {
                // 宿主可能已经拆了
              }
              try {
                if (typeof disposeIcon === 'function') disposeIcon()
                else if (disposeIcon && typeof disposeIcon.dispose === 'function') disposeIcon.dispose()
              } catch {
                // 同上
              }
            }
          })
          // 「记住这条」：assistant 消息操作行的一个附加动作。
          // 槽不存在（旧宿主）就跳过，不影响侧栏面板与工具。
          slots.inject('conversation.chat.assistant-actions', () =>
            slots.register(
              {
                name: 'conversation.chat.assistant-actions',
                id: 'psyche-remember',
                order: 95,
                label: () => '记住',
              },
              RememberAction,
            ),
          )
          // G1-A 手动交接：「保存开发进度」。与「记住这条」并列（order 94 在前），
          // 写的是项目进度而不是记忆证据；槽不存在（旧宿主）同样只跳过。
          slots.inject('conversation.chat.assistant-actions', () =>
            slots.register(
              {
                name: 'conversation.chat.assistant-actions',
                id: 'psyche-save-progress',
                order: 94,
                label: () => '保存进度',
              },
              SaveProgressAction,
            ),
          )
          // C2-D：每轮末尾的「记忆上下文」标签。sessionId 由宿主经 inject 回调
          // 传进来——不猜、不从 DOM/正文解析；拿不到就整块不渲染。
          slots.inject('conversation.chat.turnTail', () =>
            slots.register(
              {
                name: 'conversation.chat.turnTail',
                id: 'psyche-memory-context',
                order: 90,
                inject: (sessionId: unknown) =>
                  typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {},
              },
              MemoryContextChip,
            ),
          )
        } catch (error) {
          // 宿主版本不支持 sidebar.panellist 时走到这里：只告警，插件其余能力（工具等）照常。
          console.warn('[psyche] 侧栏注册失败（宿主可能不支持 sidebar.panellist）', error)
        }
      }

      // 交给 ModuleLoader 的模块形状：名字即模块 id，inject 声明依赖 slots 服务。
      // `__seaHud` 是给 test/sea-state.ts 的只读探针：不注册工具、不扩大宿主 API。
      return { name: MODULE_ID, inject: ['slots'], apply, __seaHud: buildSeaHud }
    },
  })
}
