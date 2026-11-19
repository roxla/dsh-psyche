# 意识海 v2 开发方案（SEA-V2-0 ~ SEA-V2-3）

状态：与 GPT 评审冻结（2026-11-19，5 轮）。本文是实施前的设计契约，不是验收报告。
范围：`<repo>` 的意识海页面；不新增 Schema、不写库、不新增模型调用、不进模型上下文。

## 1. 定位

意识海是 Owner 的「内在状态视图」，不是模型上下文，也不是记忆编辑器：

- **记忆层**：现有 `artifacts` + `events` 的点、边、簇，保持只读。
- **状态层**：Mood / Relationship / Growth / Intention 的当前有效状态，只读展示，不创建虚拟记忆节点。
- **时间层**：只过滤「当前可读记录」的观察窗口；不声称还原历史人格、情绪或完整记忆。

目标不是让页面更花，而是让 Owner 看见：现在有什么、这次和上次有什么不同、哪些状态不能混为一谈。

## 2. 数据契约

### 2.1 `GET /api/psyche/sea`

保留现有参数，新增可选 `from` / `to`（ISO 8601）：

```ts
interface SeaScene {
  ok: true
  instanceKey: string | null   // 不透明；null 表示无法可靠识别
  diffAvailable: boolean       // false 时前端不显示新增/更新
  nodes: SeaNode[]
  edges: SeaEdge[]
  stats: {
    artifacts: number
    events: number
    edges: number
    byKind: Record<string, number>
    byCluster: Record<string, number>
    truncated: boolean
    totalArtifacts: number     // 权限+时间过滤后、截断前
    totalEvents: number        // 权限+时间过滤后、截断前
    displayedArtifacts: number
    displayedEvents: number
    span: { from: string | null; to: string | null }
  }
  note: string
}
```

`SeaNode` 增加两个只读字段（不增加正文/身份/证据）：

```ts
interface SeaNode {
  // ...现有字段...
  createdAt: string | null   // artifact: artifacts.created_at；event: events.at
  revisedAt: string | null   // artifact: head revision 的 created_at；event: events.at
}
```

约定：

- `at` 仍是显示/新鲜度用的时间；artifact 取 head revision 的 `created_at`，event 取 `at`。
- `createdAt` 只用于「新增」判断；`revisedAt` 只用于「更新」判断；两者都有时「新增」优先。
- 时间窗口按 `timeBasis = revisedAt ?? createdAt` 过滤节点；只有两端都在窗口内的边才返回。
- `totalArtifacts/totalEvents` 在权限与时间窗口内、截断前统计；不得统计不可见记录。
- 非法 `from`/`to` 返回 400 `{ok:false,error}`，不静默忽略。

### 2.2 `instanceKey`

```text
sha256(realpath(db) + dev + ino + birthtimeMs + identityHash).slice(0,16)
```

- 不返回路径，不写日志，不进入页面文案。
- 同一文件身份 + 同一人格身份内保持稳定。
- `stat` 失败、`ino/dev` 为 0、`identityHash` 缺失/不匹配时返回 `null`，同时 `diffAvailable:false`。
- 不为了识别恢复/替换新增持久化字段；识别不可靠时宁可关闭差异，不回退到路径哈希或任何猜测值。

### 2.3 状态层数据来源

不新增状态 API。意识海页在 `/sea` 成功后并发读取：

- `GET /api/psyche/mood` → Mood 当前值与八维；
- `GET /api/psyche/panel` → Growth 已确认项、Relationship 联系人行、可能存在的 Intention 摘要。

只读现有 DTO 字段：字段缺失就隐藏对应卡片，不把状态字段塞进 `/sea`，不扩大匿名暴露面。HUD 不因展示而提权：无法验证授权时，Intention 等敏感项直接隐藏。

## 3. UI

### 3.1 布局

```text
┌───────────────────────────────────────────────┐
│ 顶部：标题 / 当前状态标签「当前」 / 时间窗口控件 │
├───────────────────────────────┬───────────────┤
│                               │ 状态 HUD      │
│        Canvas 2D 星海          │  - Mood 八维  │
│                               │  - 关系（按人）│
│                               │  - 成长       │
│                               │  - 意愿       │
├───────────────────────────────┴───────────────┤
│ 时间滑杆 / 播放 / 暂停 / 重置窗口              │
└───────────────────────────────────────────────┘
```

- HUD 宽 280–320，窄屏（< 900px）折叠为抽屉；不遮星空主体。
- 搜索/结果列表放在画布左下的浮层，键盘可达。
- 状态层固定标「当前」，不随时间窗口变化；时间窗口标签写「观察窗口（当前可读记录）」，不写「历史回放」。

### 3.2 状态 HUD

- **Mood**：八维只与自身 baseline 比较；显示维度名、当前值、基线；不把八维加总成「综合情绪分」。
- **Relationship**：一行一个 Contact，显示 `displayName` 与档位；不计算综合好感，不合并不同联系人。
- **Growth**：只显示已确认（confirmed）的成长条目，最多 3 条；候选不展示。
- **Intention**：只显示 effective 且允许披露的意愿；没有就隐藏整块，不显示「暂无」占位。
- 每块有独立失败态：`/mood` 失败不影响 `/panel` 卡；反之亦然。

### 3.3 差异标记

- localStorage key：`dsh.psyche.sea.lastVisit.<instanceKey>`，值 `{ at: ISO, fingerprint: string }`。
- `fingerprint = totalArtifacts:totalEvents:span.to`。
- 只有 `/sea` 成功渲染后才写入 `lastVisit`。
- `diffAvailable:false` 时不读不写、不显示标记。
- 首次访问（无 `lastVisit`）不标任何差异。
- `createdAt > lastVisit.at` → `new`；否则 `revisedAt > lastVisit.at` → `updated`。
- `new` 优先于 `updated`；不标删除，不检测新增关系。
- fingerprint 回退或结构不一致时，清空 `lastVisit` 按首次访问处理。

### 3.4 时间窗口

- 控件：`from`/`to` 滑杆、播放/暂停、重置（最近 30 天）。
- 播放只推进 `to`（窗口长度固定），暂停保留当前窗口；拖动只改过滤条件。
- 窗口变化只过滤节点/边，不重新计算世界坐标，不触发节点重排。

### 3.5 交互

- 搜索：输入过滤 + 结果列表，`↑/↓` 选择、`Enter` 聚焦、`Esc` 退出聚焦。
- 点星：沿用现有 `/node` 下钻。
- 邻居压暗、簇图例、时间轴保留。
- HUD 开关仍由 `panel.sea` 显示偏好控制；默认关闭。

## 4. 性能与降级

- 节点上限沿用现有 `DEFAULT_ARTIFACT_LIMIT=420`、`DEFAULT_EVENT_LIMIT=600`；V2-3 可调，但必须先保证语义。
- 截断排序确定性：先按 `recency` 降序，再按 `id` 升序；不随机。
- `stats.totalArtifacts/totalEvents` 必须与 `displayed` 同时出现，页面显示「显示 X / 共 Y」。
- LOD 只改变绘制精度（标签、边透明度、采样），不改变节点存在与语义。
- 搜索、选中、HUD 刷新不触发节点重排；只有数据窗口/数据版本变化才允许重算布局。
- `requestAnimationFrame` 只在 dirty 时运行；页面隐藏时暂停。

## 5. 分期与验收

### SEA-V2-0 契约与测试（不碰 UI）

改动：

- `src/lib/sea.ts`：`SeaNode.createdAt/revisedAt`、`SeaScene.instanceKey/diffAvailable`、stats 总计字段、`from/to` 过滤、`instanceKey` 计算（fail-closed）。
- `src/index.ts`：`/api/psyche/sea` 解析 `from/to`，透传失败状态。
- `test/sea.ts`：时间戳、窗口过滤、统计、instanceKey 为 null 时 diffAvailable false、非法参数 400。

验收：`npm run build`；`node test/sea.ts` 全过；全量 `npm run test` 0 失败；无 Schema 变化。

### SEA-V2-1 状态 HUD

改动：

- `src/client/index.ts`：`SeaTab` 增加 HUD，并发读取 `/mood`、`/panel`；缺失字段隐藏。
- 新样式限定在意识海容器内。
- `test/sea-state.ts`：DTO → HUD 模型；mood baseline 映射；关系按 Contact 分行；intention 无授权/无字段时隐藏。

验收：构建 + 新套件 + 全量；真实页面截图（Mood/关系/成长/意愿各一张）。

### SEA-V2-2 时间窗口与差异

改动：

- `src/lib/sea-diff.ts`（纯函数）：`classifyDiff(prev, node)`、`fingerprint(scene)`、`shouldReset(prev, scene)`。
- `src/client/index.ts`：时间滑杆/播放/暂停；localStorage 读写；`new/updated` 标记；窗口标签。
- `test/sea-diff.ts`：首次访问、新增、更新、new 优先、fingerprint 回退、diffAvailable false。

验收：构建 + 新套件 + 全量；真实页面播放/暂停/拖动截图；刷新后差异标记正确。

### SEA-V2-3 交互、性能与真实宿主

改动：

- 搜索结果列表 + 键盘；聚焦/退出；HUD 抽屉窄屏。
- 确定性截断、`显示 X / 共 Y`、LOD、隐藏时暂停 rAF。
- `test/sea-lod.ts`（如需要）与客户端构建检查。
- `docs/audit/sea-v2-host.md`：真实宿主截图、窗口行为、窄屏、刷新差异。

验收：构建 + 全量；真实宿主逐项截图；无控制台错误；`panel.sea` 关闭时页面不加载 Heavy 逻辑。

## 6. 风险与回滚

- **最大风险**：把客户端可见性误当成服务端授权，通过状态层/时间层/统计数间接泄露受限记忆。对策：不新增路由字段；状态层复用现有披露边界；无法验证时隐藏而非降级。
- **差异误标**：instanceKey 不可靠时可能把恢复后的库当同一实例。对策：`diffAvailable:false` + fingerprint 回退，宁可不标。
- **性能**：节点多时 HUD 与搜索卡顿。对策：确定性截断、LOD、rAF 暂停。
- 回滚：所有新增字段为可选，旧客户端忽略即可；`panel.sea` 默认 false，出问题关闭入口即可，不影响 Core。

## 7. 评审记录

- 第 1 轮：三层架构与 v2 定位；GPT 要求六项约束（状态分离、差异依据、时间语义、权限、性能、分期）。
- 第 2 轮：具体化状态来源、差异、时间、权限、性能、四期；GPT 要求统一 API 扩面口径、实例隔离、时间语义、权限不复用、性能验收。
- 第 3 轮：改为不新增路由，仅 `/sea` 增加只读元数据；`instanceKey` 隔离 localStorage；四期。
- 第 4 轮：`instanceKey` 改为文件身份 + identityHash，并加 fingerprint 回退。
- 第 5 轮：明确 `instanceKey` 只是辅助、不可靠时 `diffAvailable:false`；GPT 回复「冻结」。

冻结范围：只批准 SEA-V2-0 ~ SEA-V2-3 的设计与实施顺序，不代表代码已实现或 Host 已验证。
