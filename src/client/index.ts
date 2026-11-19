// 心灵 · 浏览器半侧（侧栏面板图标 + 主面板页）
//
// 运行环境：脚本式 bundle、不是 ESM。宿主 web app 用 window.__ModuleLoader__.load
// 装载，factory 收到一个 require（react 由宿主提供），所以全文没有 import/export、
// 也不写 JSX：React 用 req('react') 取，元素一律 h = React.createElement 造。
//
// 全局访问统一走 globalThis（下面存成 host / browser），不直接写 window / fetch /
// setInterval——这样不依赖 DOM 类型，Node 侧（无 DOM lib）也能做语法与类型检查。
//
// 宿主契约：apply(ctx) 经 ctx.slots 注册 sidebar.panellist 与 main 两个槽；
// 数据全部来自自家只读路由 /api/psyche/*（panel / usage / ops / prefs / sea）。
//
// 不复用 src/lib/*：那半边是服务端 Node 产物（ESM、可 import 依赖），这个文件是宿主加载
// 的脚本 bundle、类型环境也不同；两侧分别打包，跨侧 import 运行期直接炸，只能各写一份。

// 宿主装载前注入的全局 require；浏览器侧只保证能解析 react，别的一律不碰。
declare function require(id: string): any

/** __ModuleLoader__.load 的参数：id 是插件模块名，factory 返回插件对象。 */
interface ModuleLoaderSpec {
  id: string
  factory: (req: (id: string) => any) => unknown
}
/** 只声明宿主 window 上我们真正用到的那点表面，不跟宿主类型体系耦合。 */
interface LoaderWindow {
  __ModuleLoader__?: { load(spec: ModuleLoaderSpec): void }
  setInterval?: (handler: () => void, timeout?: number) => number
  clearInterval?: (handle: number) => void
}

// 侧栏图标与主面板页面共用同一个 id：宿主据此把「点图标」和「开哪页」对上。
const MODULE_ID = 'dsh-psyche'
const PANEL_ID = 'psyche'
// 侧栏排序值：宿主自带面板占 0 起的一段，32 让心灵排在它们后面但不掉队尾。
const PANEL_ORDER = 32
// 轮询间隔。都是只读快照，20 秒足够；再快只会白刷数据库。
const POLL_MS = 20000

// 不直接写 window / fetch / setInterval：这样这个文件不依赖 DOM 全局类型，
// 也能在 Node 侧（没有 DOM lib）安全地做语法检查。
const host: any = globalThis as any
// 测试/无头环境下没有 window，就退回 globalThis 自己，避免读到 undefined。
const browser: any = host.window ?? host
const loader = browser.__ModuleLoader__ as { load(spec: ModuleLoaderSpec): void } | undefined

// 没有 loader 说明宿主版本不匹配：只报错、不抛异常，别把整个 web app 拖崩。
if (!loader) {
  console.error('[psyche] 宿主没有提供 __ModuleLoader__，侧栏面板无法注册')
} else {
  loader.load({
    id: MODULE_ID,
    factory: (req: (id: string) => any) => {
      const React = req('react')
      const h = React.createElement

      /** 统一读错误体：兼容 `{error:'文案'}` 与 `{ok:false,error:{code,message}}`。 */
      const errorMessageOf = (body: any, fallback: string): string => {
        const raw = body && body.error
        if (typeof raw === 'string' && raw) return raw
        if (raw && typeof raw.message === 'string' && raw.message) return raw.message
        const code = body && typeof body.code === 'string' ? body.code : ''
        return code || fallback
      }

      // ── 类型（只描述我们用到的字段，避免和宿主类型体系耦合）──────────
      // 这些 interface 是「接线图」而非 API 契约：服务端多给字段无所谓，
      // 少给的字段由下面各处的 `?? fallback` 兜住，不做运行时校验。
      /** 设置表单里的一个字段：kind 决定控件形态，apply='restart' 表示改完要重启。 */
      interface FieldView {
        key: string
        label: string
        kind: string
        apply: string
        value: unknown
        unit?: string
        min?: number
        max?: number
        options?: string[]
        help: string
      }
      /** 一组设置字段；设置页按它拆成「热开关」和「只读镜像」两类卡。 */
      interface GroupView {
        id: string
        title: string
        hint?: string
        fields: FieldView[]
      }
      /** 成长阶段的一道闸门。passed 由服务端算，前端只画 ✓ / ·，不参与判定。 */
      interface GateView {
        gate: string
        label: string
        passed: boolean
        need: string
        have: string
      }
      /** 心灵提给自己的设定改动：只排队等人批，面板不提供批准入口。 */
      interface ProposalView {
        proposalId: string
        partition: string
        target: string
        change: string
        rationale: string | null
        status: string
        createdAt: string
      }
      /** 认识的人。bandLabel 只给档位名——好感不暴露分数。 */
      interface ContactView {
        contactId: string
        platform: string
        displayName: string | null
        band: string | null
        bandLabel: string | null
      }
      /** 初始化状态快照（服务端 persona-init 的展示子集；前端不推断，只按 state 渲染）。 */
      interface InitSnapshotView {
        state: 'uninitialized' | 'initializing' | 'locked' | 'identity-drift' | 'damaged'
        personaId: string
        presetId: string | null
        presetName: string | null
        presetVersion: string | null
        draft: boolean
        initializedAt: string | null
        lockedAt: string | null
        identityHash: string | null
        identityBytes: number | null
        hashMatches: boolean | null
        claim: {
          kind: string
          pid: number | null
          startedAt: string | null
          ownerAlive: boolean | null
          presetId: string | null
        } | null
        detail: string
        actions: string[]
        files: { identity: boolean; persona: boolean }
      }
      /** GET /api/psyche/init 返回的预设展示行（不含人设正文）。 */
      interface PresetRow {
        id: string
        name: string
        version: string
        summary: string
        recommended: boolean
        draft: boolean
      }
      /** 记忆规模计数，纯展示，不参与任何逻辑分支。 */
      interface CountsView {
        sources: number
        events: number
        artifacts: number
        revisions: number
        operations: number
        proposals: number
        pendingWrites: number
        activityWindows: number
      }
      /**
       * GET /api/psyche/panel 的整包快照：状态 / 设置 / 提案 / 关系四个页签都吃它。
       * 几乎每块都可能为 null（数据库没就绪、旧服务端），所以消费方必须逐块判空；
       * 只有 prefs 与 notes 是必定存在的。
       */
      interface PanelData {
        ok: boolean
        enabled: boolean
        driver: string | null
        startedAt: string
        error: { code?: string; error?: string; detail?: unknown } | null
        storage: Record<string, any> | null
        selfCheck: {
          ok: boolean
          items: { name: string; ok: boolean; detail: string }[]
          backupMode: string | null
          journalMode: string | null
        } | null
        state: {
          persona: { id: string; type: string; identityPath: string | null }
          self: { view: string; revision: number; updatedAt: string | null }
          phase: { phase: string; since: string | null; stalledAt: string | null }
          counts: CountsView
        } | null
        // 成长阶段与闸门。null = 数据库还没准备好，状态页会整卡跳过。
        growth: {
          stage: string
          stageLabel: string
          since: string | null
          stalledAt: string | null
          bottleneck: string | null
          gates: GateView[]
          algorithmVersion: string
          derivationNote: string
        } | null
        // 人格初始化状态（I-7）：首启横幅据此渲染；locked 时横幅不出现。
        personaInit: InitSnapshotView | null
        personaInitError: string | null
        /**
         * C 阶段：三个记忆功能的运行时生效状态（服务端算好，前端只显示）。
         * finalCheck 恒为 true；source 固定是宿主插件设置页；legacy 是旧配置迁移提示，
         * warnings 是非法配置告警——两者都只展示，不回写配置。
         */
        behavior: {
          capture: boolean
          injection: boolean
          finalCheck: true
          source: 'host-settings'
          legacy: string[]
          warnings: string[]
        } | null
        // 重要度榜：score 只用于排序，前端不拿它做任何判断。
        salience: {
          artifactId: string
          kind: string
          statement: string
          score: number
          solid: boolean
          reasons: string[]
        }[]
        // 现在的上下文折叠预览：lines 是进模型的那几行，foldedLine 是被折叠的统计。
        fold: {
          lines: { id: string; text: string; truncated: boolean }[]
          foldedCount: number
          foldedLine: string | null
          usedChars: number
          usedTokens: number
          budgetChars: number
          budgetTokens: number
        } | null
        proposals: ProposalView[]
        contacts: ContactView[]
        // 设置页的原始分组，和宿主插件设置页是同一份 schema。
        settings: GroupView[]
        // sea 控制意识海页签；promptSection 为 null 表示跟随宿主配置。
        prefs: { sea: boolean; promptSection: boolean | null }
        notes: string[]
      }

      /** 33 维里的一个维度（B4 面板只读展示）。value 是衰减后的有效值。 */
      interface MoodDimensionView {
        key: string
        label: string
        layer: string
        value: number
        baseline: number
        halfLifeHours: number
      }
      /** GET /api/psyche/mood 的快照：当前语气 + 33 维 + 真实写入快照。 */
      interface MoodView {
        ok: boolean
        tone: { tone: string; secondary: string | null; neutral: boolean; projectionVersion: number }
        groups: {
          basic: MoodDimensionView[]
          compound: MoodDimensionView[]
          contemporary: MoodDimensionView[]
        }
        /** 真实写入快照：at 是 UTC，values 是写入当时的原始值（不衰减）。 */
        history: { at: string; values: Record<string, number> }[]
        historyLimit: number
        historyTotal: number
      }

      /** GET /api/psyche/qq 的只读快照：计数全部是本次进程启动以来。 */
      interface QqAdminView {
        ok: boolean
        enabled: boolean
        connection: 'connected' | 'degraded' | 'disconnected' | 'unknown'
        account: { uinMasked: string | null; nickname: string | null; online: boolean | null }
        allowFrom: { ownerConfigured: boolean; ownerMasked: string | null; extraCount: number; extraMasked: string[] }
        counts: {
          received: number
          delivered: number
          sendErrors: number
          rejected: number
          rejectReplies: number
          rateLimitedDrops: number
          rejectSendErrors: number
          outOfScopeDrops: number
          contactSuppressed: number
        }
        activity: { lastHeartbeatAt: string | null; lastMessageAt: string | null; lastSentAt: string | null }
        logs: { seq: number; at: string; level: 'info' | 'warn' | 'error'; message: string }[]
      }

      /** GET /api/psyche/qq/diagnostics 的只读事件；不含正文、URL 与完整身份。 */
      interface QqDiagnosticEventView {
        seq: number
        at: string
        direction: 'in' | 'out'
        platform: 'qq'
        target: 'private' | 'group'
        contactRef: string | null
        roomRef: string | null
        result: 'accepted' | 'delivered' | 'rejected' | 'rate_limited' | 'out_of_scope' | 'deduplicated' | 'failed' | 'unknown'
        errorCode: string | null
        quote: 'applied' | 'omitted-unbound' | 'omitted-unsupported' | null
        media: { type: string; count: number }[]
        textLength: number | null
      }

      interface QqDiagnosticPageView {
        ok: boolean
        items: QqDiagnosticEventView[]
        nextBefore: number | null
        matched: number
      }

      /** 意识海里的一个点。x/y/z 由服务端按 id 与簇心算好，前端只做投影与漂移。 */
      interface SeaNodeView {
        id: string
        kind: string
        label: string
        at: string | null
        // 独立证据数：点的大小与标签优先级都按它加权，不是置信度。
        weight: number
        x: number
        y: number
        z: number
        cluster?: string
        // 簇的显示名（subject 原文截断 / kind 中文 / 「其他」）与具体 subject。
        clusterName?: string
        subject?: string | null
        // 新鲜度 0–1：越新越亮，前端只做乘法。
        recency?: number
        meta: string
      }
      /** 两个点之间的关系线；score 缺省时前端按 0.4 画，只影响透明度。 */
      interface SeaEdgeView {
        a: string
        b: string
        kind: string
        label: string
        score?: number
      }
      /** GET /api/psyche/sea 的快照。truncated 表示点被服务端截断，只影响提示文案。 */
      interface SeaSceneView {
        ok: boolean
        nodes: SeaNodeView[]
        edges: SeaEdgeView[]
        instanceKey?: string | null
        diffAvailable?: boolean
        stats: {
          artifacts: number
          events: number
          edges: number
          byKind: Record<string, number>
          byCluster?: Record<string, number>
          truncated: boolean
          span?: { from: string | null; to: string | null }
          totalArtifacts?: number
          totalEvents?: number
          displayedArtifacts?: number
          displayedEvents?: number
        }
        note: string
      }
      /** 下钻详情（GET /api/psyche/node?id=…）的宽松视图：只为展示，不做严格建模。 */
      interface SeaNodeDetailView {
        ok: boolean
        kind: 'artifact' | 'event'
        id: string
        artifactKind?: string
        head?: { revision: number; state: string; statement: string; confidence: string; createdAt: string } | null
        revisions?: { revision: number; state: string; statement: string; createdAt: string }[]
        evidence?: { revision: number; relation: string; quote: string | null; text: string | null; origin: string; createdAt: string }[]
        triggers?: { eventId: string; type: string; text: string; at: string }[]
        eventKind?: string
        eventType?: string
        text?: string
        at?: string
        sources?: { sourceId: string; text: string | null; origin: string; capturedAt: string }[]
        triggered?: { artifactId: string; statement: string }[]
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
            kicker: 'LINGBAN · OPS CONSOLE',
            title: '运维',
            hint: '引擎、写入记录、动作与迁移包；所有动作都会写进只追加的审计。',
            badge: darkPill('读取失败', '#f0a0a0'),
            children: [card('调试与运维', h('div', { style: { color: BAD, fontSize: 13 } }, `读取失败：${error}`))],
          })
        }
        if (!data) {
          return consolePage({
            kicker: 'LINGBAN · OPS CONSOLE',
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
          kicker: 'LINGBAN · OPS CONSOLE',
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

        const { data, error } = useEndpoint<QqAdminView>('/api/psyche/qq', props.stamp)
        // 暂停只冻结「显示」；数据仍在后台轮询，继续时不丢这段日志。
        const [paused, setPaused] = React.useState(false)
        const [frozen, setFrozen] = React.useState(null as QqAdminView['logs'] | null)
        const [level, setLevel] = React.useState('all' as 'all' | 'info' | 'warn' | 'error')
        // 清屏是纯客户端动作：记下清屏时的最大 seq，只过滤显示，不发请求。
        const [clearedSeq, setClearedSeq] = React.useState(0)
        // 默认只看连接/授权/计数；日志与诊断收进「高级诊断」，避免同屏两份表格。
        const [showAdvanced, setShowAdvanced] = React.useState(false)
        // P8-4：QQ 页四段只读视图——运行管理 / 联系人策略 / 诊断事件 / 运行日志。
        const [qqSection, setQqSection] = React.useState('ops' as 'ops' | 'contacts' | 'events' | 'logs')
        // P8-FINAL：控制中心内嵌在 QQ 页；页面只保存带 fragment 的地址，不展示令牌。
        const [controlMsg, setControlMsg] = React.useState('')
        const [controlBusy, setControlBusy] = React.useState(false)
        const [controlUrl, setControlUrl] = React.useState('')

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

        const qqNav = h(
          'div',
          { className: 'lb-subnav', role: 'tablist', 'aria-label': 'QQ 只读视图', style: { flexWrap: 'wrap' } },
          [
            ['ops', '运行管理'],
            ['contacts', '联系人策略'],
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
                style: { fontSize: 12, padding: '5px 10px', fontWeight: qqSection === id ? 600 : 400 },
              },
              label,
            ),
          ),
        )

        const contactsCard = card(
          '联系人策略',
          h(
            'div',
            null,
            row('Owner 已配置', data?.allowFrom.ownerConfigured ? '是' : '否'),
            row('额外授权人数', String(data?.allowFrom.extraCount ?? 0)),
            row('额外授权（脱敏）', data?.allowFrom.extraMasked.length ? data!.allowFrom.extraMasked.join('、') : '—'),
            row('联系人策略抑制', String(data?.counts.contactSuppressed ?? 0)),
            h(
              'p',
              { className: 'lb-help' },
              '策略由宿主 qq.allowFrom / qq.contacts 决定；此页只读，不提供授权修改或发送入口。',
            ),
          ),
          pill('只读', MUTED),
        )

        const children: any[] = [
          qqNav,
          card(
            '桥接状态',
            h(
              'div',
              null,
              row('连接', h('span', { style: { color: OK } }, connectionLabel)),
              row('最近心跳', fmtTime(data?.activity.lastHeartbeatAt)),
              row('最近收到消息', fmtTime(data?.activity.lastMessageAt)),
              row('最近成功发送', fmtTime(data?.activity.lastSentAt)),
            ),
            pill('只读', MUTED),
          ),
          card(
            '账号与授权',
            h(
              'div',
              null,
              row('QQ 账号', data?.account.uinMasked ?? '—'),
              row('昵称', data?.account.nickname ?? '—'),
              row('账号在线', data?.account.online === null ? '未知' : data?.account.online ? '在线' : '离线'),
              row('Owner 已配置', data?.allowFrom.ownerConfigured ? '是' : '否'),
              row('Owner（脱敏）', data?.allowFrom.ownerMasked ?? '—'),
              row('额外授权人数', String(data?.allowFrom.extraCount ?? 0)),
              row('额外授权（脱敏）', data?.allowFrom.extraMasked.length ? data!.allowFrom.extraMasked.join('、') : '—'),
            ),
            pill('只读', MUTED),
          ),
          card(
            '消息计数',
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
                  title: '心灵 QQ 控制中心',
                  src: controlUrl,
                  style: { width: '100%', height: 720, border: `1px solid ${LINE}`, borderRadius: 10, background: '#f4f4f5' },
                })
              : null,
          ),
        )

        if (error) {
          return consolePage({
            kicker: 'LINGBAN · QQ CONSOLE',
            title: 'QQ',
            hint: 'QQ 桥接的只读状态与日志；这里没有任何发送、授权或进程控制入口。',
            badge: darkPill('读取失败', BAD),
            children: [card('QQ', h('div', { style: { color: BAD, fontSize: 13 } }, `读取失败：${error}`))],
          })
        }
        if (!data) {
          return consolePage({
            kicker: 'LINGBAN · QQ CONSOLE',
            title: 'QQ',
            hint: 'QQ 桥接的只读状态与日志；这里没有任何发送、授权或进程控制入口。',
            badge: darkPill('读取中', FAINT),
            children: [card('QQ', h('div', { style: { color: MUTED, fontSize: 13 } }, '正在读取…'))],
          })
        }
        if (data.enabled === false) {
          return consolePage({
            kicker: 'LINGBAN · QQ CONSOLE',
            title: 'QQ',
            hint: 'QQ 桥接的只读状态与日志；这里没有任何发送、授权或进程控制入口。',
            badge: darkPill('未启用', MUTED),
            children: [card('QQ', empty('QQ 通道没有启用。启用后这里会显示连接状态、计数与日志。'))],
          })
        }

        const bodyChildren = qqSection === 'contacts' ? [qqNav, contactsCard] : [controlCard, ...children]

        return consolePage({
          kicker: 'LINGBAN · QQ CONSOLE',
          title: 'QQ',
          hint: 'QQ 桥接的只读状态与日志；这里没有任何发送、授权或进程控制入口。',
          badge: darkPill(connectionLabel, data.connection === 'connected' ? OK : MUTED),
          children: bodyChildren,
        })
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

      // ── 意识海（最后一个页签，默认关闭）───────────────────────────
      // 布局与主题以 3d-memory-sea 为基准：深海底色 + 浮动 HUD 卡片
      // （左上标题与统计、左下工具、右下详情、底部操作提示），
      // 透视投影 + 星尘背景 + 辉光点，纯 Canvas 2D，不引 WebGL、不引第三方库。
      // 点的位置由服务端按 id 与簇心算好，这里只做投影与漂移动画。
      // 调色板与镜头常量集中在这里：Canvas 里到处是字面量，散开就没法统一调色调。
      const SEA_BG = '#05060b'
      const SEA_TEXT = '#cfd6e4'
      const SEA_FAINT = '#6d7891'
      const SEA_MUTED = '#8e9ab5'
      const SEA_HUD_BG = 'rgba(10,13,22,.72)'
      const SEA_HUD_BORDER = 'rgba(120,160,255,.18)'
      // 焦距：越大越接近长焦（点往中心挤），越小透视越夸张；1100 配 1200 的相机距离手感正好。
      const SEA_FOCAL = 1100
      // 默认机位故意偏一点 yaw/pitch，让点云显出纵深，而不是正对着看成一团。
      const SEA_CAM_DEFAULT = { yaw: 0.45, pitch: -0.3, dist: 1200, panX: 0, panY: 0 }
      type SeaCam = typeof SEA_CAM_DEFAULT
      /** 时间轴播一遍要多久（毫秒）：15 秒够看完，又不至于让人等。 */
      const SEA_PLAY_MS = 15000
      // 单簇超过这个数就折叠：Canvas 2D 一簇画几千颗会糊成一片，也点不中。
      const SEA_FOLD_LIMIT = 60
      // 每种结论一个颜色；后端出现新 kind 时回落到 event 的蓝，不至于画不出来。
      const SEA_COLOR: Record<string, [number, number, number]> = {
        event: [150, 190, 255],
        fact: [130, 230, 200],
        belief: [190, 165, 255],
        impression: [255, 160, 210],
        stance: [255, 210, 140],
        relationship: [255, 150, 170],
        procedure: [160, 190, 220],
      }
      // 簇名直接标中文：图上写「经历 12」比写「event 12」更快读懂。
      const SEA_LABELS: Record<string, string> = {
        event: '经历',
        fact: '事实',
        belief: '看法',
        impression: '印象',
        stance: '立场',
        relationship: '关系',
        procedure: '做法',
      }
      // 簇的固定顺序：同一批点每次打开位置一致，顺序一抖人就认不出同一个簇了。
      const SEA_CLUSTER_ORDER = ['event', 'fact', 'belief', 'impression', 'stance', 'relationship', 'procedure']

      /**
       * FNV-1a 32 位哈希：把任意 id 摊成一个稳定的整数。
       * 为什么不用 Math.random：星尘位置、漂浮相位必须每帧都一样，否则整片海会自己抖。
       */
      function seaHash(text: string): number {
        let value = 2166136261
        for (let index = 0; index < text.length; index += 1) {
          value ^= text.charCodeAt(index)
          value = Math.imul(value, 16777619) >>> 0
        }
        return value >>> 0
      }
      /** 把哈希折成 [0,1) 的小数：同一个 key 永远同一个值，可以放心当「随机数」用。 */
      function seaRand(key: string): number {
        return (seaHash(key) % 100000) / 100000
      }

      /**
       * 意识海页：整块 Canvas 里的 3D 点云（记忆节点 + 关系线 + 簇名），外加四角浮动 HUD。
       * 自己向 /api/psyche/sea 取数、不进 PanelData——面板接口 404 时这一页也得能用。
       * 状态：显示经历层 / 标签 / 只看最近 300 个；副作用：一次 fetch + 一条常驻 rAF 循环。
       */
      // 意识海 V2-1 状态 HUD 的纯映射：只读现有 /mood 与 /panel DTO，缺字段就隐藏。
      // 不把八维加总、不推断授权、不为缺失的成长条目/意愿伪造占位。
      const SEA_HUD_MOOD_DIMS: { key: string; label: string }[] = [
        { key: 'calm', label: '平静' },
        { key: 'happy', label: '开心' },
        { key: 'curious', label: '好奇' },
        { key: 'focused', label: '专注' },
        { key: 'anxious', label: '焦虑' },
        { key: 'irritated', label: '烦躁' },
        { key: 'down', label: '低落' },
        { key: 'tired', label: '疲惫' },
      ]

      function seaRecord(value: any): any {
        return value && typeof value === 'object' ? value : null
      }

      function seaFinite(value: any): number | null {
        return typeof value === 'number' && Number.isFinite(value) ? value : null
      }

      /** Mood DTO → 八维行；缺维度少一行，不补 0。 */
      function seaMoodRows(mood: any): any[] | null {
        const root = seaRecord(mood)
        const groups = seaRecord(root?.groups)
        if (!root || root.ok !== true || !groups) return null
        const all: any[] = []
        for (const group of [groups.basic, groups.compound, groups.contemporary]) {
          if (Array.isArray(group)) all.push(...group)
        }
        const rows: any[] = []
        for (const dim of SEA_HUD_MOOD_DIMS) {
          const item = all.find((entry: any) => seaRecord(entry)?.key === dim.key)
          const value = seaFinite(item?.value)
          const baseline = seaFinite(item?.baseline)
          if (value === null || baseline === null) continue
          rows.push({ key: dim.key, label: dim.label, value, baseline, delta: value - baseline })
        }
        return rows.length > 0 ? rows : null
      }

      /** 关系按 Contact 分行；无 displayName 用中性占位，不回显内部 id。 */
      function seaRelationRows(panel: any): any[] | null {
        const root = seaRecord(panel)
        if (!root || root.ok !== true || !Array.isArray(root.contacts)) return null
        const rows: any[] = []
        for (const item of root.contacts) {
          const contact = seaRecord(item)
          if (!contact || typeof contact.contactId !== 'string' || contact.contactId === '') continue
          const displayName =
            typeof contact.displayName === 'string' && contact.displayName.trim() !== ''
              ? contact.displayName.trim()
              : '未命名联系人'
          const bandLabel =
            typeof contact.bandLabel === 'string' && contact.bandLabel.trim() !== ''
              ? contact.bandLabel.trim()
              : ''
          rows.push({ contactId: contact.contactId, displayName, bandLabel })
        }
        return rows.length > 0 ? rows : null
      }

      /** 成长只展示有效阶段；已确认条目列表不在现有 DTO 里，故不伪造。 */
      function seaGrowth(panel: any): any | null {
        const growth = seaRecord(seaRecord(panel)?.growth)
        if (!growth) return null
        const stage = typeof growth.stage === 'string' ? growth.stage : ''
        const stageLabel = typeof growth.stageLabel === 'string' ? growth.stageLabel : ''
        if (!stage && !stageLabel) return null
        return { stage, stageLabel: stageLabel || stage }
      }

      /** 意愿只在 DTO 明确给出可披露文本时出现；缺字段/无授权一律隐藏。 */
      function seaIntention(panel: any): any | null {
        const intention = seaRecord(seaRecord(panel)?.intention)
        if (!intention || typeof intention.text !== 'string' || intention.text.trim() === '') return null
        return { text: intention.text.trim() }
      }

      function buildSeaHud(input: any = {}): any {
        return {
          mood: seaMoodRows(input.mood),
          relations: seaRelationRows(input.panel),
          growth: seaGrowth(input.panel),
          intention: seaIntention(input.panel),
        }
      }

      // 上次访问快照只存在浏览器；instanceKey 不可靠时不读不写，宁可不标差异。
      const SEA_LAST_VISIT_PREFIX = 'dsh.psyche.sea.lastVisit.'
      function seaSceneFingerprint(body: any): string {
        const totalArtifacts = Number(body?.stats?.totalArtifacts) || 0
        const totalEvents = Number(body?.stats?.totalEvents) || 0
        return `${totalArtifacts}:${totalEvents}:${body?.stats?.span?.to ?? ''}`
      }
      function seaDiffKind(prev: any, node: any): 'new' | 'updated' | null {
        if (!prev) return null
        const seenAt = Date.parse(prev.at)
        if (!Number.isFinite(seenAt)) return null
        const created = node?.createdAt ? Date.parse(node.createdAt) : NaN
        if (Number.isFinite(created) && created > seenAt) return 'new'
        const revised = node?.revisedAt ? Date.parse(node.revisedAt) : NaN
        if (Number.isFinite(revised) && revised > seenAt) return 'updated'
        return null
      }
      function seaVisitShouldReset(prev: any, body: any): boolean {
        if (!body?.diffAvailable || !body?.instanceKey) return true
        if (!prev) return true
        if (prev.instanceKey !== body.instanceKey) return true
        return !/^\d+:\d+:.+$/.test(String(prev.fingerprint ?? ''))
      }

      function SeaTab(): any {
        const [scene, setScene] = React.useState(null as SeaSceneView | null)
        const [failed, setFailed] = React.useState(null as string | null)
        // 状态 HUD 走现有只读接口；两个接口各自失败，不互相拖垮，也不阻塞星海。
        const [stateHud, setStateHud] = React.useState(null as any)
        const [hudFailed, setHudFailed] = React.useState(false)
        // picked 只喂 HUD；Canvas 里读 pickedRef，避免每帧闭包都重建。
        const [picked, setPicked] = React.useState(null as SeaNodeView | null)
        const [showEvents, setShowEvents] = React.useState(true)
        const [showLabels, setShowLabels] = React.useState(true)
        const [recentOnly, setRecentOnly] = React.useState(false)
        // 搜索只压暗不改布局：命中留在原处，才看得出它跟谁挨着。
        const [query, setQuery] = React.useState('')
        const [playing, setPlaying] = React.useState(false)
        // 观察窗口：0 = 全部；默认最近 30 天，只过滤当前可读记录，不声称历史回放。
        const [windowDays, setWindowDays] = React.useState(30)
        const [diffCounts, setDiffCounts] = React.useState({ fresh: 0, updated: 0 })
        const diffRef = React.useRef(new Map<string, 'new' | 'updated'>())
        // 下钻详情：点星之后才去服务端取，取不到就退回节点自带字段。
        const [detail, setDetail] = React.useState(null as SeaNodeDetailView | null)
        const [detailLoading, setDetailLoading] = React.useState(false)
        // 折叠：单簇超过 SEA_FOLD_LIMIT 时只画一部分 + 一颗「+N」。
        // 展开状态放 ref 供每帧读取；expandedVersion 只用来让 draw effect 重建一次。
        const [expandedVersion, setExpandedVersion] = React.useState(0)
        // SEA-V2-3：搜索结果键盘游标；页面隐藏时暂停 rAF。
        const [searchIndex, setSearchIndex] = React.useState(0)
        const [visible, setVisible] = React.useState(true)

        // 下面这些 ref 全部给 rAF 循环读：draw 每帧都跑，走 state 会触发重渲染并让闭包过期。
        const canvasRef = React.useRef(null as any)
        const camRef = React.useRef({ ...SEA_CAM_DEFAULT } as SeaCam)
        const posRef = React.useRef(new Map<string, { x: number; y: number; f: number; depth: number }>())
        const listRef = React.useRef([] as SeaNodeView[])
        const dragRef = React.useRef(
          null as null | { mode: 'orbit' | 'pan'; x: number; y: number; yaw: number; pitch: number; panX: number; panY: number; moved: boolean },
        )
        const hoverRef = React.useRef(null as string | null)
        const pickedRef = React.useRef(null as string | null)
        // 一阶邻居表：scene 变化时重建一次，draw 里只读——每帧扫全部边会把帧率吃光。
        const neighborsRef = React.useRef(new Map<string, Set<string>>())
        // 时间轴播放的游标：{ startedAt: rAF 时间, from/to: 数据时间范围 }；null = 没在播。
        const playRef = React.useRef(null as null | { startedAt: number; from: number; to: number })
        // 已经展开的簇 key：draw 每帧读；点「+N」时增删并 setExpandedVersion。
        const expandedRef = React.useRef(new Set<string>())

        React.useEffect(() => {
          const map = new Map<string, Set<string>>()
          if (scene) {
            for (const edge of scene.edges) {
              let from = map.get(edge.a)
              if (!from) {
                from = new Set()
                map.set(edge.a, from)
              }
              from.add(edge.b)
              let to = map.get(edge.b)
              if (!to) {
                to = new Set()
                map.set(edge.b, to)
              }
              to.add(edge.a)
            }
          }
          neighborsRef.current = map
        }, [scene])


        // 页面隐藏时不画：rAF 在后台仍会被浏览器节流，但没必要保留一整条绘制链。
        React.useEffect(() => {
          const doc = (globalThis as any).document
          if (!doc || !doc.addEventListener) return undefined
          const sync = (): void => setVisible(doc.visibilityState !== 'hidden')
          sync()
          doc.addEventListener('visibilitychange', sync)
          return () => doc.removeEventListener('visibilitychange', sync)
        }, [])

        // 搜索词一变就把键盘游标拉回第一条，避免沿用上一次的越界下标。
        React.useEffect(() => {
          setSearchIndex(0)
        }, [query])

        // 窗口变化才重取；状态 HUD 不跟窗口变，只标「当前」。
        React.useEffect(() => {
          let alive = true
          const url = (() => {
            if (!windowDays) return '/api/psyche/sea'
            const to = new Date()
            const from = new Date(to.getTime() - windowDays * 86400000)
            return `/api/psyche/sea?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`
          })()
          browser.fetch(url, { headers: { accept: 'application/json' } })
            .then((response: any) => {
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              return response.json()
            })
            .then((body: SeaSceneView) => {
              // alive 兜住「已切走页签但请求还在路上」的情况，否则会对卸载的组件 setState。
              if (!alive) return
              const next = new Map<string, 'new' | 'updated'>()
              let prev: any = null
              let key = ''
              const store = (globalThis as any).localStorage
              try {
                if (body.diffAvailable && body.instanceKey && store) {
                  key = `${SEA_LAST_VISIT_PREFIX}${body.instanceKey}`
                  const raw = store.getItem(key)
                  prev = raw ? JSON.parse(raw) : null
                }
              } catch {
                prev = null
              }
              if (!seaVisitShouldReset(prev, body)) {
                for (const node of body.nodes as any[]) {
                  const kind = seaDiffKind(prev, node)
                  if (kind) next.set(node.id, kind)
                }
              }
              diffRef.current = next
              setDiffCounts({
                fresh: Array.from(next.values()).filter((kind) => kind === 'new').length,
                updated: Array.from(next.values()).filter((kind) => kind === 'updated').length,
              })
              if (key && store) {
                try {
                  store.setItem(
                    key,
                    JSON.stringify({ at: new Date().toISOString(), fingerprint: seaSceneFingerprint(body), instanceKey: body.instanceKey }),
                  )
                } catch {
                  // 隐私模式/配额满：只影响下次差异，不影响看星图。
                }
              }
              setScene(body)
              setFailed(null)
            })
            .catch((cause: any) => {
              if (alive) setFailed(cause && cause.message ? cause.message : String(cause))
            })
          return () => {
            alive = false
          }
        }, [windowDays])

        // 状态层只读现有 /mood 与 /panel：任一失败只让对应卡片消失，不影响星海。
        React.useEffect(() => {
          let alive = true
          const read = (url: string): Promise<any> =>
            browser
              .fetch(url, { headers: { accept: 'application/json' } })
              .then((response: any) => (response.ok ? response.json() : null))
              .catch(() => null)
          Promise.all([read('/api/psyche/mood?limit=1'), read('/api/psyche/panel')])
            .then(([mood, panel]) => {
              if (!alive) return
              const next = buildSeaHud({ mood, panel })
              const any = next.mood || next.relations || next.growth || next.intention
              setStateHud(any ? next : null)
              setHudFailed(!any)
            })
            .catch(() => {
              if (alive) setHudFailed(true)
            })
          return () => {
            alive = false
          }
        }, [])

        /**
         * 量画布当前的 CSS 像素尺寸（不含 dpr 缩放）。
         * 给 320×280 的下限：容器刚挂上还没布局时 rect 全是 0，直接拿去算投影会得到 NaN。
         */
        const canvasBox = (): { w: number; h: number } => {
          const canvas = canvasRef.current
          if (!canvas || !canvas.getBoundingClientRect) return { w: 0, h: 0 }
          const rect = canvas.getBoundingClientRect()
          return { w: Math.max(320, Math.round(rect.width || 0)), h: Math.max(280, Math.round(rect.height || 0)) }
        }

        /**
         * 把一个记忆节点投影到屏幕坐标。
         * @param t rAF 时间戳（做轻微漂浮）；@param w/h 画布 CSS 尺寸
         * @returns x/y 屏幕点、f 透视缩放（越远越小越淡）、depth 供深度排序
         * 手写 yaw/pitch 欧拉旋转 + 平移 + 透视除法：这点需求不值得引矩阵库。
         */
        const projectNode = (
          node: SeaNodeView,
          t: number,
          w: number,
          h: number,
        ): { x: number; y: number; f: number; depth: number } => {
          const cam = camRef.current
          const phase = seaRand(`${node.id}p`) * Math.PI * 2
          const wx = node.x + cam.panX + Math.sin(t / 3200 + phase) * 7
          const wy = node.y + cam.panY + Math.cos(t / 4100 + phase) * 5
          const wz = node.z + Math.sin(t / 2700 + phase * 1.3) * 7
          const cy = Math.cos(cam.yaw)
          const sy = Math.sin(cam.yaw)
          const cp = Math.cos(cam.pitch)
          const sp = Math.sin(cam.pitch)
          const x1 = wx * cy - wz * sy
          const z1 = wx * sy + wz * cy
          const y1 = wy * cp - z1 * sp
          const z2 = wy * sp + z1 * cp
          const depth = cam.dist + z2
          const f = SEA_FOCAL / Math.max(140, depth)
          return { x: w / 2 + x1 * f, y: h / 2 + y1 * f, f, depth }
        }

        // 一帧都不能停：点要漂浮、辉光要呼吸，只在 scene 变化时重建 effect、画面本身每帧重绘。
        React.useEffect(() => {
          const canvas = canvasRef.current
          if (!canvas || !scene || !visible) return undefined
          let raf = 0

          const draw = (t: number): void => {
            const box = canvasBox()
            const w = box.w
            const h = box.h
            if (!w || !h) {
              raf = browser.requestAnimationFrame(draw)
              return
            }
            // dpr 封顶 2：4K 屏按 3 倍渲染会让每帧填充的像素翻倍，观感提升却很有限。
            const dpr = Math.min(2, (browser.devicePixelRatio as number) || 1)
            // 只在尺寸真的变了才改 canvas.width：赋值会清空位图，每帧都改等于每帧闪一下。
            if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
              canvas.width = Math.floor(w * dpr)
              canvas.height = Math.floor(h * dpr)
              canvas.style.width = `${w}px`
              canvas.style.height = `${h}px`
            }
            const ctx = canvas.getContext('2d')
            if (!ctx) {
              raf = browser.requestAnimationFrame(draw)
              return
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            ctx.clearRect(0, 0, w, h)

            // 背景星尘
            ctx.save()
            ctx.globalAlpha = 0.5
            for (let index = 0; index < 140; index += 1) {
              // 位置由哈希定死，只让透明度随时间呼吸——这样星尘是"闪"而不是"游"。
              const sx = ((seaHash(`bg${index}`) % 1000) / 1000) * w
              const sy = ((seaHash(`bgy${index}`) % 1000) / 1000) * h
              const alpha = 0.05 + ((Math.sin(t / 2600 + index) + 1) / 2) * 0.12
              ctx.fillStyle = `rgba(150,180,255,${alpha})`
              ctx.fillRect(sx, sy, 1, 1)
            }
            ctx.restore()

            // 先按开关滤一层：经历点通常比别的类型多好几倍，关掉它帧率差别立竿见影。
            let list: SeaNodeView[] = (scene.nodes as SeaNodeView[]).filter(
              (node: SeaNodeView) => showEvents || node.kind !== 'event',
            )
            // 「只看最近」按 at 倒序取 300 个：Canvas 2D 画上万个点会掉到个位数帧。
            if (recentOnly && list.length > 300) {
              list = list
                .slice()
                .sort((a: SeaNodeView, b: SeaNodeView) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
                .slice(0, 300)
            }
            // 搜索词先算：折叠只在没搜索时生效——搜索时把被折叠的点也放出来，
            // 否则「搜到了但看不见」比不搜更让人困惑。
            const needle = query.trim().toLowerCase()
            // 折叠：单簇超过 SEA_FOLD_LIMIT 时只画权重最高的那批 + 一颗「+N」聚合星。
            // 聚合星落在被折叠成员的重心上，点开时整簇在原地散开，不会跳位。
            if (!needle) {
              const byCluster = new Map<string, SeaNodeView[]>()
              for (const node of list) {
                const key = node.cluster || node.kind || 'event'
                const members = byCluster.get(key)
                if (members) members.push(node)
                else byCluster.set(key, [node])
              }
              const next: SeaNodeView[] = []
              for (const [key, members] of byCluster) {
                if (members.length <= SEA_FOLD_LIMIT || expandedRef.current.has(key)) {
                  next.push(...members)
                  continue
                }
                const sorted = members
                  .slice()
                  .sort((a: SeaNodeView, b: SeaNodeView) => {
                    const weight = (Number(b.weight) || 0) - (Number(a.weight) || 0)
                    if (weight) return weight
                    const recency = (Number(b.recency) || 0) - (Number(a.recency) || 0)
                    if (recency) return recency
                    return String(a.id).localeCompare(String(b.id))
                  })
                next.push(...sorted.slice(0, SEA_FOLD_LIMIT))
                const folded = sorted.slice(SEA_FOLD_LIMIT)
                const count = folded.length
                const cx = folded.reduce((sum: number, node: SeaNodeView) => sum + node.x, 0) / count
                const cy = folded.reduce((sum: number, node: SeaNodeView) => sum + node.y, 0) / count
                const cz = folded.reduce((sum: number, node: SeaNodeView) => sum + node.z, 0) / count
                const latest = folded.reduce(
                  (best: string, node: SeaNodeView) =>
                    !best || String(node.at ?? '') > best ? String(node.at ?? '') : best,
                  '',
                )
                next.push({
                  id: `fold:${key}`,
                  kind: 'fold',
                  label: `+${count}`,
                  cluster: key,
                  clusterName: folded[0].clusterName ?? SEA_LABELS[key] ?? key,
                  x: cx,
                  y: cy,
                  z: cz,
                  at: latest || null,
                  weight: 3,
                  meta: '',
                })
              }
              list = next
            }
            const pos = new Map<string, { x: number; y: number; f: number; depth: number }>()
            // 每帧重算一遍投影并写回 ref：hitTest 和悬停读的就是这份，拖动时坐标才不会错位。
            for (const node of list) pos.set(node.id, projectNode(node, t, w, h))
            posRef.current = pos
            listRef.current = list

            // 画家算法：远的先画、近的后画。按 depth 倒序即可，不需要真的做遮挡。
            const order = list.slice().sort((a: SeaNodeView, b: SeaNodeView) => {
              const pa = pos.get(a.id)
              const pb = pos.get(b.id)
              return (pb ? pb.depth : 0) - (pa ? pa.depth : 0)
            })
            const idx = new Set(list.map((node: SeaNodeView) => node.id))
            const byId = new Map(list.map((node: SeaNodeView) => [node.id, node]))

            // 焦点、搜索、时间轴：都在 draw 里就地算——每帧写 state 会触发整页重渲染。
            const focus = hoverRef.current ?? pickedRef.current
            const neighbors = focus ? neighborsRef.current.get(focus) : null
            const play = playRef.current
            let playCut = 0
            if (play) {
              const elapsedMs = Math.max(0, t - play.startedAt)
              playCut = play.from + (play.to - play.from) * Math.min(1, elapsedMs / SEA_PLAY_MS)
              // 播完只收尾一次：再在 draw 里逐帧 setPlaying 会把渲染循环拖死。
              if (elapsedMs >= SEA_PLAY_MS) {
                playRef.current = null
                setTimeout(() => setPlaying(false), 0)
              }
            }
            /** 点是否被搜索命中：空搜索一律算命中，免得把整片海压暗。 */
            const hitBySearch = (node: SeaNodeView): boolean => !needle || node.label.toLowerCase().includes(needle)


            // 线：远淡近亮，relation 偏蓝、lineage 偏紫、trigger/caused 偏灰
            ctx.lineWidth = 1
            for (const edge of scene.edges) {
              if (!idx.has(edge.a) || !idx.has(edge.b)) continue
              const from = pos.get(edge.a)
              const to = pos.get(edge.b)
              if (!from || !to) continue
              const score = typeof edge.score === 'number' ? edge.score : 0.4
              let alpha = Math.min(0.5, (0.03 + score * 0.18) * ((from.f + to.f) / 2) * 1.7)
              // 悬停/选中时只把连着它的线留下，其余压到几乎看不见。
              if (focus) alpha *= edge.a === focus || edge.b === focus ? 1.4 : 0.15
              if (needle) {
                const aNode = byId.get(edge.a)
                const bNode = byId.get(edge.b)
                alpha *= aNode && bNode && (hitBySearch(aNode) || hitBySearch(bNode)) ? 1 : 0.1
              }
              // 时间轴播放：两端都还没「到点」的线先不画。
              if (playCut) {
                const aAt = byId.get(edge.a)?.at
                const bAt = byId.get(edge.b)?.at
                const aMs = aAt ? new Date(aAt).getTime() : 0
                const bMs = bAt ? new Date(bAt).getTime() : 0
                if (aMs > playCut && bMs > playCut) alpha *= 0.1
              }
              if (alpha <= 0.012) continue
              ctx.strokeStyle =
                edge.kind === 'relation'
                  ? `rgba(120,170,255,${alpha})`
                  : edge.kind === 'lineage'
                    ? `rgba(190,165,255,${alpha})`
                    : edge.kind === 'topic'
                      ? `rgba(110,200,190,${alpha * 0.75})`
                      : `rgba(180,200,230,${alpha * 0.8})`
              ctx.beginPath()
              ctx.moveTo(from.x, from.y)
              ctx.lineTo(to.x, to.y)
              ctx.stroke()
            }

            // 簇名：每个簇取成员投影重心，够多的才标；名字优先用服务端的 clusterName
            const groups = new Map<string, { x: number; y: number; n: number; near: number; label: string }>()
            for (const node of list) {
              if (node.kind === 'fold') continue
              const key = node.cluster || node.kind || 'event'
              const at = pos.get(node.id)
              if (!at) continue
              const label = node.clusterName ?? SEA_LABELS[key] ?? key
              const acc = groups.get(key) || { x: 0, y: 0, n: 0, near: 0, label }
              acc.x += at.x
              acc.y += at.y
              acc.n += 1
              acc.near = Math.max(acc.near, at.f)
              groups.set(key, acc)
            }
            ctx.font = '600 13px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
            ctx.textAlign = 'center'
            for (const [, acc] of groups) {
              if (acc.n < 2) continue
              ctx.globalAlpha = 0.5 * Math.min(1, acc.near * 1.5)
              ctx.fillStyle = '#a9c0e6'
              ctx.fillText(`${acc.label} ${acc.n}`, acc.x / acc.n, acc.y / acc.n)
            }
            ctx.globalAlpha = 1
            ctx.textAlign = 'left'

            // 点：远小近大、远淡近亮；悬停/选中给辉光
            for (const node of order) {
              const at = pos.get(node.id)
              if (!at) continue
              if (node.kind === 'fold') {
                // 聚合星：虚线圆 + 中心「+N」，跟普通记忆点区分开，一眼看出还有东西没展开。
                const r = Math.max(3, 7 * at.f * 1.6)
                ctx.globalAlpha = Math.min(1, 0.45 + at.f * 0.5)
                ctx.strokeStyle = 'rgba(190,205,235,.9)'
                ctx.lineWidth = 1.2
                ctx.setLineDash([3, 3])
                ctx.beginPath()
                ctx.arc(at.x, at.y, r, 0, Math.PI * 2)
                ctx.stroke()
                ctx.setLineDash([])
                ctx.fillStyle = 'rgba(225,235,255,.95)'
                ctx.font = '10px system-ui, sans-serif'
                ctx.textAlign = 'center'
                ctx.fillText(node.label, at.x, at.y + 3)
                ctx.textAlign = 'left'
                continue
              }
              const rgb = SEA_COLOR[node.kind] ?? SEA_COLOR.event
              const isPicked = pickedRef.current === node.id
              const isHover = hoverRef.current === node.id
              const weight = Math.max(1, Number(node.weight) || 1)
              const unit = 1.1 + Math.min(2.4, weight * 0.55)
              const base = Math.max(0.8, unit * (isPicked || isHover ? 1.9 : 1) * at.f * 1.75)
              let alpha = node.kind === 'event' ? 0.15 + at.f * 0.5 : 0.22 + at.f * 1.05
              // 越旧越暗：recency 由服务端算成 0.35–1，这里只做乘法。
              alpha *= typeof node.recency === 'number' ? node.recency : 1
              // 悬停/选中：本人最亮、一阶邻居次之，其余压到 18%——但不清零，留个方位感。
              if (focus) alpha *= node.id === focus ? 1.3 : neighbors && neighbors.has(node.id) ? 0.9 : 0.18
              if (needle) alpha *= hitBySearch(node) ? 1.4 : 0.1
              if (playCut) {
                const atMs = node.at ? new Date(node.at).getTime() : 0
                if (atMs > playCut) alpha *= 0.1
              }
              ctx.globalAlpha = Math.min(1, Math.max(0.02, alpha))

              if (isPicked || isHover) {
                const glow = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, base * 7)
                glow.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${isPicked ? 0.55 : 0.35})`)
                glow.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`)
                ctx.fillStyle = glow
                ctx.beginPath()
                ctx.arc(at.x, at.y, base * 7, 0, Math.PI * 2)
                ctx.fill()
                ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.5 + 0.3 * Math.sin(t / 600)})`
                ctx.lineWidth = 1.2
                ctx.beginPath()
                ctx.arc(at.x, at.y, base * 3.2, 0, Math.PI * 2)
                ctx.stroke()
              }

              ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${node.kind === 'event' ? 0.8 : isPicked ? 1 : 0.9})`
              ctx.beginPath()
              ctx.arc(at.x, at.y, Math.max(0.8, base), 0, Math.PI * 2)
              ctx.fill()
              const diff = diffRef.current.get(node.id)
              if (diff) {
                ctx.globalAlpha = 0.9
                ctx.strokeStyle = diff === 'new' ? 'rgba(130,225,160,.95)' : 'rgba(255,205,120,.95)'
                ctx.lineWidth = 1.4
                ctx.beginPath()
                ctx.arc(at.x, at.y, Math.max(2, base + 2.2), 0, Math.PI * 2)
                ctx.stroke()
              }
            }
            ctx.globalAlpha = 1

            // 点旁边的文字：按权重挑、按屏幕格子避让，缩放越大标得越多
            if (showLabels) {
              // 预算随缩放变：拉近了点更散，能多标；拉远了标多了只会糊成一片。
              const budget = Math.max(16, Math.min(200, Math.round(60 * (SEA_CAM_DEFAULT.dist / camRef.current.dist))))
              const rank = (node: SeaNodeView): number =>
                (pickedRef.current === node.id ? 4 : 0) +
                (hoverRef.current === node.id ? 4 : 0) +
                (Number(node.weight) || 0)
              // 先按「选中/悬停/权重」排名取前 N，再逐条试位——顺序本身就是抢占优先级的规则。
              const candidates = list
                .filter((node: SeaNodeView) => {
                  if (!node.label || node.label.length < 2) return false
                  const at = pos.get(node.id)
                  return Boolean(at) && (at as { f: number }).f >= 0.55
                })
                .sort((a: SeaNodeView, b: SeaNodeView) => rank(b) - rank(a))
                .slice(0, budget)
              // 标签避让用粗格子（约 104×14 一格）：精确求矩形交叠太贵，格子够用且相邻帧稳定。
              const occupied = new Set<string>()
              ctx.font = '11px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
              ctx.textAlign = 'left'
              for (const node of candidates) {
                const at = pos.get(node.id)
                if (!at) continue
                const text = node.label.length > 14 ? `${node.label.slice(0, 14)}…` : node.label
                const width = ctx.measureText(text).width
                const x = Math.round(at.x + 7)
                const y = Math.round(at.y - 5)
                // 出屏或贴边的标签直接不画：半个字露在边上比干脆没有更难看。
                if (x + width > w - 4 || x < -2) continue
                const cell = `${Math.floor(x / 104)}:${Math.floor(y / 14)}`
                if (occupied.has(cell)) continue
                occupied.add(cell)
                const hot = node.id === hoverRef.current || node.id === pickedRef.current
                ctx.globalAlpha = hot ? 0.95 : 0.42
                ctx.fillStyle = hot ? '#e6efff' : '#93a3c4'
                ctx.fillText(text, x, y)
                if (hot) {
                  ctx.globalAlpha = 0.4
                  ctx.fillStyle = '#78aaff'
                  ctx.fillRect(x - 3, y - 9, 1.2, 11)
                }
              }
              ctx.globalAlpha = 1
            }

            // 悬停小气泡：画在 Canvas 里而不是插 DOM，DOM 跟随投影会慢一帧、看着发飘。
            const hoveredNode = hoverRef.current
              ? list.find((node: SeaNodeView) => node.id === hoverRef.current)
              : null
            if (hoveredNode) {
              const at = pos.get(hoveredNode.id)
              if (at) {
                const text = hoveredNode.label.length > 24 ? `${hoveredNode.label.slice(0, 24)}…` : hoveredNode.label
                ctx.font = '12px "Microsoft YaHei", sans-serif'
                const width = ctx.measureText(text).width + 14
                ctx.fillStyle = 'rgba(8,11,20,.88)'
                ctx.strokeStyle = 'rgba(120,160,255,.28)'
                ctx.lineWidth = 1
                ctx.beginPath()
                ctx.roundRect(at.x + 10, at.y - 22, width, 22, 6)
                ctx.fill()
                ctx.stroke()
                ctx.fillStyle = '#dfe8ff'
                ctx.fillText(text, at.x + 17, at.y - 7)
              }
            }

            raf = browser.requestAnimationFrame(draw)
          }

          raf = browser.requestAnimationFrame(draw)
          return () => {
            if (browser.cancelAnimationFrame) browser.cancelAnimationFrame(raf)
          }
        }, [scene, showEvents, showLabels, recentOnly, query, expandedVersion, visible])

        /**
         * 命中测试：在上一帧投影出的屏幕坐标里，找离指针最近的节点。
         * @returns 命中的节点；16px 以内没有就 null
         * 阈值固定 16px：再小不好点，再大相邻的点会互相抢。
         */
        const pickAt = (clientX: number, clientY: number): SeaNodeView | null => {
          const canvas = canvasRef.current
          if (!canvas || !canvas.getBoundingClientRect) return null
          const rect = canvas.getBoundingClientRect()
          const pos = posRef.current
          let best: SeaNodeView | null = null
          let bestDistance = 16
          for (const node of listRef.current) {
            const at = pos.get(node.id)
            if (!at) continue
            const distance = Math.sqrt((at.x - (clientX - rect.left)) ** 2 + (at.y - (clientY - rect.top)) ** 2)
            if (distance < bestDistance) {
              bestDistance = distance
              best = node
            }
          }
          return best
        }

        // 直接改 canvas.style.cursor，不走 state：拖拽期间每次移动都会调它。
        const setCursor = (value: string): void => {
          const canvas = canvasRef.current
          if (canvas && canvas.style) canvas.style.cursor = value
        }

        /**
         * 按下：在这一刻就用 button 把「这一拖」定性成旋转（左键）还是平移（右键）。
         * 副作用：写 dragRef、尝试指针捕获、把光标切成抓起。
         */
        const onPointerDown = (event: any): void => {
          // 中键与侧键不参与：避免和宿主的滚动、后退手势打架。
          if (event.button !== 0 && event.button !== 2) return
          dragRef.current = {
            // 关键：左右键必须在 pointerdown 分流；等 pointermove 再判会让旋转顺手触发平移。
            mode: event.button === 2 ? 'pan' : 'orbit',
            x: event.clientX,
            y: event.clientY,
            yaw: camRef.current.yaw,
            pitch: camRef.current.pitch,
            panX: camRef.current.panX,
            panY: camRef.current.panY,
            moved: false,
          }
          // 捕获指针：拖到画布外也继续收到 move，否则在窗外松手会留下一个「卡住」的 drag。
          if (event.currentTarget && event.currentTarget.setPointerCapture && event.pointerId !== undefined) {
            try {
              event.currentTarget.setPointerCapture(event.pointerId)
            } catch {
              // 某些环境不支持指针捕获，忽略
            }
          }
          setCursor('grabbing')
        }

        /**
         * 移动：正在拖就更新相机，没在拖就做悬停命中。
         * 副作用：改 camRef / hoverRef 与光标；刻意不 setState，否则每帧整页重渲染。
         */
        const onPointerMove = (event: any): void => {
          const drag = dragRef.current
          if (drag) {
            const dx = event.clientX - drag.x
            const dy = event.clientY - drag.y
            // 4px 阈值：低于它算点击，松手时才好区分「点选」和「不小心拖了一下」。
            if (Math.hypot(dx, dy) > 4) drag.moved = true
            if (drag.mode === 'orbit') {
              camRef.current.yaw = drag.yaw + (event.clientX - drag.x) * 0.006
              // 俯仰夹在 ±1.35rad：再多就翻过天顶，画面整个倒过来。
              camRef.current.pitch = Math.max(-1.35, Math.min(1.35, drag.pitch - (event.clientY - drag.y) * 0.006))
            } else {
              // 平移量按 dist/focal 换算：拉远时同样的像素拖动要移更多世界单位，手感才一致。
              const ratio = camRef.current.dist / SEA_FOCAL
              camRef.current.panX = drag.panX - (event.clientX - drag.x) * ratio
              camRef.current.panY = drag.panY - (event.clientY - drag.y) * ratio
            }
            return
          }
          const hit = pickAt(event.clientX, event.clientY)
          hoverRef.current = hit ? hit.id : null
          setCursor(hit ? 'pointer' : 'grab')
        }

        /**
         * 抬起：只有「几乎没动」的那一下才算点选，否则一次旋转就会顺手清掉当前选中。
         * 副作用：写 picked 与 pickedRef、恢复光标。
         */
        const onPointerUp = (event: any): void => {
          const drag = dragRef.current
          dragRef.current = null
          if (drag && !drag.moved) {
            const hit = pickAt(event.clientX, event.clientY)
            pickNode(hit)
          }
          setCursor('grab')
        }

        /**
         * 点选一个节点：先本地即时上屏，再去服务端补它的来历（head/版本/证据）。
         * 详情取不到不是错误——退回节点自带字段，不能让右下角空着。
         */
        const pickNode = (node: SeaNodeView | null): void => {
          // 聚合星不是一条记忆：点它是「展开/收起这一簇」，不查详情。
          if (node && node.kind === 'fold') {
            const key = String(node.cluster || '')
            if (key) {
              if (expandedRef.current.has(key)) expandedRef.current.delete(key)
              else expandedRef.current.add(key)
              setExpandedVersion((version: number) => version + 1)
            }
            return
          }
          pickedRef.current = node ? node.id : null
          setPicked(node)
          setDetail(null)
          if (!node) return
          setDetailLoading(true)
          browser
            .fetch(`/api/psyche/node?id=${encodeURIComponent(node.id)}`, { headers: { accept: 'application/json' } })
            .then((response: any) => (response.ok ? response.json() : null))
            .then((body: SeaNodeDetailView | null) => setDetail(body ?? null))
            .catch(() => setDetail(null))
            .finally(() => setDetailLoading(false))
        }

        /** 播一遍时间轴：按 at 从最早亮到最晚；再点一次停。 */
        const togglePlay = (): void => {
          if (playRef.current) {
            playRef.current = null
            setPlaying(false)
            return
          }
          const span = scene?.stats?.span
          const from = span?.from ? new Date(span.from).getTime() : 0
          const to = span?.to ? new Date(span.to).getTime() : 0
          if (!from || !to || to <= from) return
          playRef.current = { startedAt: (globalThis as any).performance?.now?.() ?? Date.now(), from, to }
          setPlaying(true)
        }

        // 离开画布就丢掉拖拽与悬停：否则指针绕回来时还以为手一直按着。
        const onPointerLeave = (): void => {
          dragRef.current = null
          hoverRef.current = null
          setCursor('grab')
        }

        // 滚轮自己吃（preventDefault）并只缩放相机：画布是全屏铺满的，让它滚没有意义，
        // 不拦的话还会把宿主的整页带着一起滚，手感很怪。
        const onWheel = (event: any): void => {
          event.preventDefault()
          const factor = event.deltaY > 0 ? 1.08 : 0.92
          camRef.current.dist = Math.min(3200, Math.max(380, camRef.current.dist * factor))
        }

        // 复位只改 camRef、不碰 state：下一帧自然按默认机位重画。
        const resetCamera = (): void => {
          camRef.current = { ...SEA_CAM_DEFAULT }
        }

        /** 四角 HUD 的公共外壳样式：绝对定位 + 半透明毛玻璃，叠在 canvas 之上。 */
        const hud = (extra: Record<string, unknown>): Record<string, unknown> => ({
          position: 'absolute',
          zIndex: 3,
          background: SEA_HUD_BG,
          border: `1px solid ${SEA_HUD_BORDER}`,
          borderRadius: 12,
          backdropFilter: 'blur(8px)',
          ...extra,
        })

        /**
         * 工具条上的开关按钮。
         * @param active 决定底色与字色；@param title 悬停说明
         * aria-pressed 一起给上，读屏器才知道这是个可切换的开关而不是普通按钮。
         */
        const toolButton = (label: string, active: boolean, onClick: () => void, title: string): any =>
          h(
            'button',
            {
              type: 'button',
              title,
              onClick,
              'aria-pressed': active,
              style: {
                appearance: 'none',
                background: active ? 'rgba(120,160,255,.3)' : 'rgba(120,160,255,.1)',
                color: active ? '#fff' : '#b8c9ee',
                border: '1px solid rgba(120,160,255,.22)',
                borderRadius: 8,
                padding: '5px 10px',
                fontSize: 12,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              },
            },
            label,
          )

        // 顶部徽标串：优先用服务端分好的簇（subject 优先），没有 byCluster 才退回 byKind。
        const stats = scene ? scene.stats : null
        const clusterCounts: Record<string, number> = stats ? (stats.byCluster ?? stats.byKind ?? {}) : {}
        const badgeCounts = stats
          ? Object.entries(clusterCounts)
              .filter(([, count]) => count > 0)
              .sort((left, right) => right[1] - left[1])
              .slice(0, 6)
              .map(([key, count]) => `${SEA_LABELS[key] ?? key} ${count}`)
              .join(' · ')
          : ''
        const hitCount = query.trim()
          ? (scene?.nodes ?? []).filter((node: SeaNodeView) => node.label.toLowerCase().includes(query.trim().toLowerCase())).length
          : 0
        // SEA-V2-3：搜索结果列表（画布左下浮层），最多 8 条；键盘与鼠标共用同一份顺序。
        const searchResults = query.trim()
          ? (scene?.nodes ?? [])
              .filter((node: SeaNodeView) => node.label.toLowerCase().includes(query.trim().toLowerCase()))
              .slice()
              .sort((a: SeaNodeView, b: SeaNodeView) => {
                const weight = (Number(b.weight) || 0) - (Number(a.weight) || 0)
                if (weight) return weight
                return a.label.localeCompare(b.label, 'zh-Hans-CN')
              })
              .slice(0, 8)
          : []
        const activeSearchIndex = searchResults.length ? Math.min(searchIndex, searchResults.length - 1) : 0
        const displayedNodes = stats
          ? (stats.displayedArtifacts ?? stats.artifacts) + (stats.displayedEvents ?? stats.events)
          : 0
        const totalNodes = stats
          ? (stats.totalArtifacts ?? stats.artifacts) + (stats.totalEvents ?? stats.events)
          : 0
        const isTruncated = Boolean(stats?.truncated) || totalNodes > displayedNodes
        // 时间跨度按天取整并至少给 1：同一天内的点否则会显示成「0 天」。
        const spanDays = (() => {
          const from = stats?.span?.from
          const to = stats?.span?.to
          if (!from || !to) return 0
          const diff = new Date(to).getTime() - new Date(from).getTime()
          return Number.isFinite(diff) ? Math.max(1, Math.round(diff / 86400000)) : 0
        })()

        return h(
          'div',
          {
            'data-dsh-part': 'sea',
            style: {
              position: 'relative',
              width: '100%',
              height: '100%',
              minHeight: 280,
              background: SEA_BG,
              color: SEA_TEXT,
              font: '13px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
              overflow: 'hidden',
              borderRadius: 10,
              boxSizing: 'border-box',
            },
          },
          h('canvas', {
            ref: canvasRef,
            'data-dsh-part': 'sea-canvas',
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerLeave,
            onContextMenu: (event: any) => event.preventDefault(),
            onWheel,
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              width: '100%',
              height: '100%',
              display: 'block',
              cursor: 'grab',
              touchAction: 'none',
            },
          }),

          // 左上：标题与统计
          // 数字全读 scene.stats；scene 还没到时一律按 0 显示，避免先闪一版假数据。
          h(
            'div',
            { style: hud({ top: 16, left: 16, padding: '12px 16px', maxWidth: 420 }) },
            h(
              'h1',
              { style: { margin: '0 0 4px', fontSize: 15, fontWeight: 600, letterSpacing: '.12em', color: '#9fc1ff' } },
              '意识海',
            ),
            h('div', { style: { color: SEA_FAINT, fontSize: 12 } }, '她经历过的每一件事，都是一个点'),
            h(
              'div',
              { style: { marginTop: 8, display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: SEA_MUTED } },
              h(
                'span',
                null,
                '点 ',
                h('b', { style: { color: '#dbe6ff', fontWeight: 600 } }, String(stats ? stats.artifacts + stats.events : 0)),
                isTruncated ? `（显示 ${displayedNodes} / 共 ${totalNodes}）` : '',
              ),
              h('span', null, '线 ', h('b', { style: { color: '#dbe6ff', fontWeight: 600 } }, String(stats ? stats.edges : 0))),
              spanDays ? h('span', null, '跨度 ', h('b', { style: { color: '#dbe6ff', fontWeight: 600 } }, String(spanDays)), ' 天') : null,
              diffCounts.fresh + diffCounts.updated > 0
                ? h(
                    'span',
                    { style: { color: '#9fc1ff' } },
                    `新增 ${diffCounts.fresh} · 更新 ${diffCounts.updated}`,
                  )
                : null,
            ),
            badgeCounts ? h('div', { style: { marginTop: 6, fontSize: 11, color: SEA_FAINT } }, badgeCounts) : null,
          ),

          // 右上：状态 HUD（只读、当前状态；不随时间窗口变化）
          // 每块独立：/mood 失败不影响关系卡，反之亦然；没有字段就整块不画。
          h(
            'div',
            {
              'data-dsh-part': 'sea-state-hud',
              style: hud({
                top: 16,
                right: 16,
                width: 300,
                maxHeight: 'calc(100% - 220px)',
                overflow: 'auto',
                padding: '12px 14px',
              }),
            },
            h('div', { style: { color: '#9fc1ff', fontSize: 12, letterSpacing: '.12em', marginBottom: 8 } }, '当前状态'),
            stateHud
              ? [
                  stateHud.mood
                    ? h(
                        'div',
                        { key: 'mood', style: { marginBottom: 10 } },
                        h('div', { style: { color: SEA_MUTED, fontSize: 11, marginBottom: 4 } }, '情绪（对自身基线）'),
                        ...stateHud.mood.map((row: any) =>
                          h(
                            'div',
                            { key: row.key, style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, lineHeight: 1.7 } },
                            h('span', { style: { color: '#b9c6e2' } }, row.label),
                            h(
                              'span',
                              { style: { color: row.delta >= 0 ? '#8fd6a8' : '#f0a0a0', whiteSpace: 'nowrap' } },
                              `${row.value.toFixed(1)} / ${row.baseline.toFixed(1)} (${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(1)})`,
                            ),
                          ),
                        ),
                      )
                    : null,
                  stateHud.relations
                    ? h(
                        'div',
                        { key: 'relations', style: { marginBottom: 10 } },
                        h('div', { style: { color: SEA_MUTED, fontSize: 11, marginBottom: 4 } }, '关系（按人）'),
                        ...stateHud.relations.slice(0, 8).map((row: any) =>
                          h(
                            'div',
                            { key: row.contactId, style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, lineHeight: 1.7 } },
                            h('span', { style: { color: '#b9c6e2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.displayName),
                            h('span', { style: { color: row.bandLabel ? '#9fc1ff' : SEA_FAINT, whiteSpace: 'nowrap' } }, row.bandLabel || '档位未知'),
                          ),
                        ),
                      )
                    : null,
                  stateHud.growth
                    ? h(
                        'div',
                        { key: 'growth', style: { marginBottom: 10 } },
                        h('div', { style: { color: SEA_MUTED, fontSize: 11, marginBottom: 2 } }, '成长阶段'),
                        h('div', { style: { color: '#cfe0ff', fontSize: 12 } }, stateHud.growth.stageLabel),
                      )
                    : null,
                  stateHud.intention
                    ? h(
                        'div',
                        { key: 'intention' },
                        h('div', { style: { color: SEA_MUTED, fontSize: 11, marginBottom: 2 } }, '此刻的念头'),
                        h('div', { style: { color: '#cfe0ff', fontSize: 12, lineHeight: 1.6 } }, stateHud.intention.text),
                      )
                    : null,
                ]
              : h('div', { style: { color: SEA_FAINT, fontSize: 11 } }, hudFailed ? '状态暂不可读。' : '正在读取状态…'),
          ),

          // 左下：搜索结果（画布浮层，键盘与鼠标共用同一份顺序）
          searchResults.length
            ? h(
                'div',
                {
                  'data-dsh-part': 'sea-search-results',
                  role: 'listbox',
                  'aria-label': '意识海搜索结果',
                  style: hud({
                    left: 16,
                    bottom: 64,
                    width: 300,
                    maxHeight: 232,
                    overflowY: 'auto',
                    padding: 6,
                    zIndex: 4,
                  }),
                },
                ...searchResults.map((node: SeaNodeView, index: number) =>
                  h(
                    'div',
                    {
                      key: node.id,
                      role: 'option',
                      'aria-selected': index === activeSearchIndex,
                      onMouseDown: (event: any) => event.preventDefault(),
                      onClick: () => pickNode(node),
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '5px 8px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        background: index === activeSearchIndex ? 'rgba(120,160,255,.18)' : 'transparent',
                        color: index === activeSearchIndex ? '#eaf2ff' : '#b9c6e2',
                        fontSize: 12,
                      },
                    },
                    h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, node.label),
                    h('span', { style: { flex: '0 0 auto', color: SEA_FAINT, fontSize: 11 } }, SEA_LABELS[node.kind] || node.kind),
                  ),
                ),
              )
            : null,

          // 左下：工具
          // 三个开关走 state（HUD 要跟着变），「复位」只改相机 ref，不触发重渲染。
          h(
            'div',
            { style: hud({ left: 16, bottom: 16, padding: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }) },
            h(
              'select',
              {
                value: String(windowDays),
                'data-dsh-part': 'sea-window',
                onChange: (event: any) => setWindowDays(Number(event.target.value) || 0),
                title: '观察窗口：只过滤当前可读记录，不是历史回放',
                style: {
                  appearance: 'none',
                  background: 'rgba(10,14,26,.55)',
                  color: '#dfe8ff',
                  border: '1px solid rgba(120,160,255,.22)',
                  borderRadius: 8,
                  padding: '5px 8px',
                  fontSize: 12,
                  outline: 'none',
                },
              },
              h('option', { value: '7' }, '近 7 天'),
              h('option', { value: '30' }, '近 30 天'),
              h('option', { value: '90' }, '近 90 天'),
              h('option', { value: '0' }, '全部'),
            ),
            h('input', {
              type: 'search',
              value: query,
              placeholder: '搜一颗星…',
              'data-dsh-part': 'sea-search',
              onChange: (event: any) => setQuery(event.target.value ?? ''),
              onKeyDown: (event: any) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  if (searchResults.length) setSearchIndex(Math.min(searchResults.length - 1, activeSearchIndex + 1))
                  return
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  if (searchResults.length) setSearchIndex(Math.max(0, activeSearchIndex - 1))
                  return
                }
                if (event.key === 'Enter') {
                  const node = searchResults[activeSearchIndex]
                  if (!node) return
                  event.preventDefault()
                  pickNode(node)
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setQuery('')
                  setSearchIndex(0)
                  const target = event.currentTarget
                  if (target && typeof target.blur === 'function') target.blur()
                }
              },
              style: {
                appearance: 'none',
                width: 132,
                background: 'rgba(10,14,26,.55)',
                color: '#dfe8ff',
                border: '1px solid rgba(120,160,255,.22)',
                borderRadius: 8,
                padding: '5px 8px',
                fontSize: 12,
                outline: 'none',
              },
            }),
            query.trim()
              ? h('span', { style: { color: hitCount > 0 ? '#9fc1ff' : '#ff9a9a', fontSize: 11, whiteSpace: 'nowrap' } }, `命中 ${hitCount}`)
              : null,
            toolButton(playing ? '暂停' : '播放', playing, togglePlay, '按时间从最早亮到最晚，再点一次停'),
            toolButton('标签', showLabels, () => setShowLabels((value: boolean) => !value), '显示/隐藏每个点旁边的文字'),
            toolButton('最近 300', recentOnly, () => setRecentOnly((value: boolean) => !value), '只看最近 300 个点'),
            toolButton('经历点', showEvents, () => setShowEvents((value: boolean) => !value), '显示/隐藏经历点'),
            toolButton('复位', false, resetCamera, '回到初始视角'),
          ),

          // 右下：详情
          // 只在选中时出现；内容全来自节点自身，不再回服务端查（点选要即时）。
          picked
            ? h(
                'div',
                { 'data-dsh-part': 'sea-detail', style: hud({ right: 16, bottom: 16, width: 320, padding: '12px 14px' }) },
                h(
                  'div',
                  { style: { color: SEA_FAINT, fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' } },
                  picked.kind === 'event'
                    ? `经历 · ${SEA_LABELS.event}`
                    : `${SEA_LABELS[picked.kind] ?? picked.kind} · ${picked.id}`,
                ),
                h(
                  'div',
                  { style: { margin: '6px 0 10px', color: '#e8eeff', fontSize: 14, lineHeight: 1.6, wordBreak: 'break-word' } },
                  picked.label,
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 10, flexWrap: 'wrap', color: '#7f8aa5', fontSize: 12 } },
                  h('span', null, fmtTime(picked.at, '时间未知')),
                  h('span', null, picked.meta),
                  h('span', null, `独立证据 ${picked.weight}`),
                ),
                detailLoading
                  ? h('div', { style: { marginTop: 8, color: SEA_FAINT, fontSize: 11 } }, '正在取它的来历…')
                  : null,
                detail
                  ? h(
                      'div',
                      { style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(120,160,255,.12)' } },
                      detail.kind === 'artifact'
                        ? [
                            h(
                              'div',
                              { style: { color: '#cfe0ff', fontSize: 12, lineHeight: 1.6, maxHeight: 96, overflow: 'hidden' } },
                              detail.head?.statement ?? picked.label,
                            ),
                            h(
                              'div',
                              { style: { marginTop: 4, color: '#7f8aa5', fontSize: 11 } },
                              `版本 ${detail.revisions?.length ?? 0} · 证据 ${detail.evidence?.length ?? 0} 条`,
                            ),
                            ...(detail.evidence ?? []).slice(0, 3).map((entry: any, index: number) =>
                              h(
                                'div',
                                { key: `ev-${index}`, style: { marginTop: 4, color: '#93a3c4', fontSize: 11, lineHeight: 1.5 } },
                                `${entry.relation} · ${(entry.text ?? entry.quote ?? '').slice(0, 70)}`,
                              ),
                            ),
                          ]
                        : [
                            h(
                              'div',
                              { style: { color: '#cfe0ff', fontSize: 12, lineHeight: 1.6, maxHeight: 96, overflow: 'hidden' } },
                              detail.text ?? picked.label,
                            ),
                            h(
                              'div',
                              { style: { marginTop: 4, color: '#7f8aa5', fontSize: 11 } },
                              `来源 ${detail.sources?.length ?? 0} 条 · 触发结论 ${detail.triggered?.length ?? 0} 条`,
                            ),
                          ],
                    )
                  : null,
                picked.kind === 'event' ? null : h('div', { style: { marginTop: 6, color: SEA_FAINT, fontSize: 11 } }, picked.id),
              )
            : null,

          // 底部提示
          // pointerEvents: none —— 它压在画布下沿正中，吃指针的话那块就拖不动了。
          h(
            'div',
            {
              style: {
                position: 'absolute',
                left: '50%',
                bottom: 18,
                transform: 'translateX(-50%)',
                color: '#4d566d',
                fontSize: 12,
                zIndex: 2,
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
              },
            },
            '滚轮拉近拉远 · 左键拖动旋转 · 右键拖动平移 · 点一颗星看来历 · 搜一颗星看它落哪儿',
          ),

          // 失败与加载都整块盖住画布：比在空背景上放一行小字更明确。
          failed
            ? h(
                'div',
                {
                  style: {
                    position: 'absolute',
                    inset: 0,
                    display: 'grid',
                    placeItems: 'center',
                    color: '#ff9a9a',
                    fontSize: 14,
                    zIndex: 5,
                    background: 'rgba(5,6,11,.72)',
                  },
                },
                `读不到意识海：${failed}`,
              )
            : scene
              ? null
              : h(
                  'div',
                  {
                    style: {
                      position: 'absolute',
                      inset: 0,
                      display: 'grid',
                      placeItems: 'center',
                      color: SEA_FAINT,
                      fontSize: 13,
                      zIndex: 4,
                    },
                  },
                  '正在打捞这片海…',
                ),
        )
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



      // 面板出错时不要把整个侧栏带崩
      /**
       * 错误边界：面板内部任一组件抛错，只换掉这一块，不会把宿主的侧栏一起带崩。
       * 只能用 class 写——React 的错误边界至今只有 class 组件支持。
       */
      class PageBoundary extends React.Component {
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
