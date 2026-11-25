// 心灵 · 浏览器半侧：意识海页（3D 场景、HUD、检索与详情）


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
