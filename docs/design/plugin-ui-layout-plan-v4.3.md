# 心灵插件 UI 方案 v4.3：DSH 原生优先、分级设置与统一轻量工作台

> **性质**：以已交付的 v4.1 为底稿的**设计修订提案**；经评审后作为 UI-2 和 UI-CONFIG-0 的视觉/信息架构依据。本文**不修改源码、Schema、Host 或已冻结的业务权限**；“参考 Ant Design Vue”只指交互和外观，不意味着将 Ant Design Vue 引入现有客户端包。
>
> **修订日期**：2026-11-16（v4.3）。**当前实现基线**：HEAD `9fbaad9`、DEV v28.33、Schema v30/68 表/38 触发器、5542 断言/168 套件/169 步/0 失败。**历史方案基线**：v4.2 评审时的 `0783838`（v28.32，5527）仅作记录，不代表 v4.3 的实施前提。UI-0.5 独立宿主骨架 24 场景/189 项 PASS；UI-1-CLOSE `97fd366` 已提交，偏好 39/0、真实客户端布局 48 场景/329 项/0、交错故障 11/0。上述历史结论不自动证明本次 v4.2 设计已实现。
>
> **沿用 v4.1 的需求裁决**：**DSH 兼容性优先于外部 UI 风格**；保留五个主要页面与现有 UI-1；只对适合的统计卡提供「图表／数字」填底单选切换；情绪默认采用**8 个现有原生情绪维度**（4 项积极/认知、4 项压力/精力），图表以 ECharts Radar 绘制并提供数字替代视图；窄屏优先数字模式；同行卡片等高、整体视觉统一，低频只读模块默认收起。本文不改变 33 维 Global Mood 底层模型、原始数据、宿主 Config 或业务安全边界。

> **v4.2 新增决策（2026-11-16）**：综合四个开源插件的公开 README、其可访问的设置页实现/说明后，将设置体验进一步收敛为「**一屏少量可操作项 + 分组行式表单 + 条件展开 + 说明按需出现**」。**参考的是信息组织和交互规律，不复制其他插件的 DOM、CSS、独立服务器或保存机制**。当前 DSH 已验的自动配置表单仍是唯一 Host Config 编辑面；Psyche 主工作台仍仅能编辑 `sea`、`promptSection` 两项自有偏好。没有 Host 能力证据的自定义配置页暂不实施。

> **v4.3 修订（2026-11-16）**：仅吸收外部评审的五项阻塞修订——配置入口不承诺深链、token 先取证后设计、补旧页签迁移表、雷达不做跨维比较、UI-2a 拆 2a1/2a2 并明确 `dispose`；不改五页、Switch、填底单选与 ECharts 方案。冻结只锁定设计，不要求先完成实施；UI-CONFIG-0 只阻塞 UI-2a2 采用新增主题样式，不阻塞沿用 UI-1 样式的 UI-2a1；两者实施后分别独立验收。

## 1. 目标与不变量

### 1.1 设计目标

心灵定位为**轻量科技感个人工作台**，而不是把 68 张数据库表和所有功能阶段都展示在首页。打开页面后应迅速知道：**当前能不能用、记住了什么、现在是什么状态、QQ 能不能连接、设置该去哪里改**。科技感来自稳定的网格、宿主深浅主题、清晰数字、克制描边与少量真实图形；不堆叠赛博装饰、霓虹灯、演示数据。

- **少页面**：默认五个一级页签，优先真正有操作意义的内容；只读技术统计退到二级折叠区。
- **可选图表而非强制图表**：情绪雷达与必要的记忆构成/用量趋势可以通过**填底按钮单选「图表 / 数字」**切换；其他运行状态优先数字或文字，不额外造图。
- **宿主优先的统一控件**：优先宿主真实支持的组件、主题 token、输入语义及 Cordis 生命周期。Ant Design Vue 仅供视觉/交互对照；不引入 Vue、不覆盖宿主样式。
- **Switch 二态开关**：真实启用/停用型布尔偏好采用 Switch；视图互斥切换仍用填底单选，三态继承值仍用三选一，不能混用语义。
- **卡片同行等高**：按行成组的左右卡片共享行高、标题/主体/底部对齐；不同内容长度用折叠或摘要，而不是拉成参差不齐的瀑布流。
- **真实状态**：没有可信快照就显示“未接入/读取失败”，不展示虚假的六边形、分数或历史曲线。

### 1.2 不可破坏的既有冻结项

1. UI-1 已交付的 `sidebar.panellist` + `main`、页头 + **单行可横向滚动页签** + **唯一正文纵向滚动**继续沿用；不新增侧栏、顶栏或 iframe。
2. `sea` 布尔与 `promptSection` `true/false/null` 为 Psyche 自有偏好；原 `/api/psyche/prefs` 的逐项提交、服务端确认、旧响应隔离、失败回滚与卸载取消必须保留。
3. Host Config 默认仍在 **DSH Plugins 自动表单**编辑；主工作台只读摘要/跳转，不再实现第二份可编辑表单。自定义 `plugins.bundle.config` page 属独立 UI-CONFIG 评审，不能因想要 AntDV 风格而私自切换。
4. UI 不更改 Memory/Scope/Disclosure、Affinity/Contact Affect、Growth、QQ 白名单、B-4-2 Outbox、Host Worker、H-2/B4 或任何其他权限和发送能力。群回复继续 DISABLED；P5 保持冻结。
5. 原 `plugin-ui-05-host-skeleton.md`、`plugin-ui-1-implementation.md` 及 v2/v3 历史验收不回写为新测试 PASS。
6. **若 v4.2 设计与 DSH 当前 Host 能力、真实 CSS 变量或 Slots 约束冲突，以宿主能力为准**；未验证的 Host 属性只列为候选，不得写作已支持。不为追求科技感添加替代窗口、全局样式或第二份 Config 真值。

## 2. 信息架构：五个主要页面

默认一级页签**只有五个**，统一中文短称、同宽度单行横滚，标签不要写“高级功能大合集”：

```text
[概览] [记忆] [情绪] [QQ] [设置]
```

| 页面 | 首屏保留（建议上限） | 次级详情（默认不展开） | 移出一级导航 |
| --- | --- | --- | --- |
| **概览** | 一行运行状态；记忆摘要；当前成长/表达；待处理问题；确有意义时记忆构成「图表／数字」 | 健康检查报告、完整运行时证据级别 | 完整数据库指标、所有历史操作 |
| **记忆** | 最近 5 条可披露记忆、重要结论、搜索；「意识海」入口（只在偏好开启时） | 版本回链、证据关系、原始记录、提案列表 | 来源/Event/Artifact 全量表各占一页 |
| **情绪** | **八维 ECharts 雷达／数字切换**、当前表达档位；关系摘要、成长阶段 | 33 维明细、全部 Contact Affect 细节、真实历史趋势、成长候选详情 | 独立“关系”“成长”“详细 Mood”页签 |
| **QQ** | 连接、私聊准入状态、发/收摘要；异常告警 | 诊断事件、200 条脱敏日志、完整过滤器 | 独立“诊断事件”“运行日志”一级页 |
| **设置** | `sea`、`promptSection`、Host 配置入口、轻量维护入口 | 参数/只读配置概览、备份/恢复、自检/高级运维、用量与花费（可切图表／数字） | “用量与花费”“运维与诊断”一级页 |

**功能不是删除，而是分级可见**：本次不删除已有路由、数据库表、CLI、API、业务测试或敏感操作校验。将低频模块放进“高级/详情”折叠面板或现有导航目标；需要时可达，不能因隐藏而失去恢复/自检操作。默认不请求隐藏大表及长日志，首次展开后再按原权限读取。

**首页优先级**：初始化或数据库不可用 > 真实安全告警 > 需要处理的任务 > 简要状态。`PARTIAL`、`BLOCKED`、`NOT VERIFIED` 各自显示原文，不并成“运行正常”。

### 2.1 五页不变，但「设置」页面采用三层信息密度

- **常显层**（首屏）：两个**真实可写**的个人偏好（`sea` Switch、`promptSection` 填底三态），和一个「打开 DSH Plugins 页」说明入口（不承诺直达具体插件/bundle）。状态以「当前确认值」为准，不把 Host Config 做成假的第二组 Switch。
- **按需层**：宿主运行配置**只读摘要**、可能影响体验的异常，以及「高级与维护」折叠入口；概要最多 4 条，不将 68 张表或所有配置字段搬到这里。
- **诊断层**：原有健康检查、迁移/备份/恢复、完整日志与用量分析可访问，但默认不加载大数据。敏感操作仍走原权限/确认门禁；后台读权限不可借折叠组件放宽。

这与四个参考插件里「重要开关常显、详细参数延后」「状态与复杂日志分层」的**界面层级**相似，但不改变 Psyche 已冻结的 Config/prefs 数据归属。

### 2.2 旧页签 → 新五页映射（迁移口径）

| 旧页签（UI-1 `BASE_TABS` 7 页） | 新位置 | 默认展示 | 加载时机 |
| --- | --- | --- | --- |
| `status` 概览 | 概览 | 是 | 首屏 |
| `usage` 用量与花费 | 设置 → 高级与维护 → 用量与花费 | 否 | 展开后 |
| `ops` 运维 | 设置 → 高级与维护 | 否 | 展开后 |
| `settings` 设置 | 设置（拆常显/按需/诊断三层） | 是（仅常显层） | 首屏常显；诊断按需 |
| `proposals` 提案 | 记忆 → 提案列表 | 否 | 进入记忆页后按需 |
| `contacts` 联系人 | 情绪 → 关系（联系人列表与信任视图） | 否 | 进入情绪页后按需 |
| `qq` QQ | QQ（含联系人准入与策略） | 是 | 进入 QQ 页 |

要求：QQ 联系人准入与策略仍归 QQ 页；关系视图只读展示联系人/信任，不复制准入编辑入口。每个旧页签都有唯一、可回到的入口；五页精简不得删除路由、数据或敏感操作的复核语义。`sea` / `promptSection` 的保存、失败态与交错故障语义继续沿用 UI-1。

### 2.3 配置入口契约（不承诺深链）

- 主入口文案固定为「打开 DSH Plugins 页」，不是「打开 DSH 插件配置」，也不承诺直达 `dsh-psyche` 详情或某个配置 card。
- 当前无证据证明 Host 提供「直达指定 bundle 配置」的稳定外部 API；未验证的深链能力只列为候选，不写入产品承诺。
- 点击后进入 Plugins 页；若平台只能给出文字说明，则展示「在 Plugins 页找到 dsh-psyche」的指引，不伪造不可用按钮，也不在插件内复制一套 Host 配置表单。
- 插件自有设置页保留 `sea` / `promptSection`；Host 运行配置仍以 Host 自动表单为唯一编辑面，UI-CONFIG-0 取得 token 与表单证据前不实施自定义 Host 配置页。

## 3. 首页与卡片等高布局

### 3.1 统一网格与视觉节奏

- **全局**：最大程度利用 Host `main` 视口的内容宽度；不另加固定宽度居中的窄控制台。容器 `min-width:0`，页面纵向唯一滚动。
- **宽度 ≥900px**：顶部状态条可 3–4 个紧凑指标；主内容区**两列，每行等高**。一张需要完整宽度的卡独占下一行。
- **宽度 <900px**：单列顺序展示，不强制配对等高；页签保留单行横向滚动。
- **成对的卡片**：`grid-template-columns: repeat(2,minmax(0,1fr))`，`align-items:stretch`；每张卡 `height:100%; display:flex; flex-direction:column; min-width:0`，正文 `flex:1`，底部操作 `margin-top:auto`。
- **不使用 Masonry / columns / 多行卡片固定等高**；一行以该行最高卡决定高度，**仅同行对齐**。文字最多摘要两行，长内容经折叠/“查看详情”，不得裁掉权限/错误说明。
- **密度约定**：卡片基础内距 16–20px、间距 16px；同行标题区相同高度/基线，底部按钮相同边距；组件尺度由可用 Host token 决定。

```text
┌ 运行状态条：DB / QQ / 需要处理 ──────────────────────────────────┐
├ 最近记忆（5 条 + 搜索） ──────┬ 当前心情（八维雷达／数字 + 表达） ─┤
│ 标题、摘要                  │ 标题、八项代表指标              │
│ 同一行高度 / 底部动作对齐    │ 同一行高度 / 底部动作对齐       │
├ 成长与关系摘要 ─────────────┬ 快捷操作与提醒 ────────────────┤
│ 信任/自主/主动/整合          │ 设置/诊断/需要处理             │
└─────────────────────────────┴────────────────────────────────┘
```

### 3.2 推荐的 CSS 结构（实现示意，不是产品代码）

```css
.lb-content { container-type: inline-size; }
.lb-card-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: stretch;
}
.lb-card {
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.lb-card__head { flex: none; }
.lb-card__body { flex: 1 1 auto; min-height: 0; }
.lb-card__footer { margin-top: auto; }
.lb-card--full { grid-column: 1 / -1; }
@container (max-width: 899px) {
  .lb-card-grid { grid-template-columns: minmax(0, 1fr); }
}
```

实施时以 **`main` 容器宽度**选择断点；容器查询不可用时使用现有 ResizeObserver 或已验证方式，不按整个浏览器 viewport 推断。雷达容器固定适度图高（参考 240–260px），**外卡不固定截断高度**。卡片过长先减少默认明细，不靠隐藏溢出解决。

## 4. 控件选型与填底单选（**DSH 宿主能力优先**）

**不可将 Ant Design Vue 组件或其全局 CSS 直接注入当前 DSH 客户端。** 选择顺序固定为：**① Host 官方可用组件与行为 → ② 既有已验 Psyche/Host React 组件 → ③ 最小原生 HTML 控件与局部 CSS → ④ 单独评审的新增库**。不能为了仿制 AntDV 把 Vue runtime、AntDV 主题系统、Portal 或全局弹层放入 Host。按钮组参考填底 `Radio.Button` 的视觉，使用 Host 已验的 CSS token；不得以外观覆盖 Host 的焦点、键盘、表单和卸载机制。

| 控件 | 统一设计 | 约定与风险 |
| --- | --- | --- |
| **填底按钮式单选（重点）** | 参考 `Radio.Group` + `Radio.Button` 的 `buttonStyle="solid"`，选中项**填底**、未选中项低强调；保持一行同高 | `role=radiogroup`/原生 radio、键盘左右/Home/End、选中状态文字与 aria；**导航 tabs 不是 radio**。适用于 `图表/数字`、`7/30 天`、`promptSection` 三态，不借用 Host Config 写入口 |
| **Switch（二态开关）** | 参考 AntDV `Switch` 的紧凑滑轨+圆形滑块；与同页输入控件基线对齐、开关宽高统一；宿主现成 Switch 能满足时优先复用 | **仅用于独立、实际可编辑的 boolean 启用/关闭项**（当前 `sea` 即“显示意识海”）；原生 `input type="checkbox"` 可按 `role="switch"` 呈现，需可见名称、`checked`/`aria-checked` 同步、Space 可操作、焦点可见；禁用/提交中/失败明确。不得用 Switch 表达 `promptSection` 的 `null` 继承、`图表/数字` 的互斥切换，或 Host 配置的只读摘要 |
| **输入框** | 单一表面色、细描边、聚焦可见、36px 左右高度；输入提示与错误在行内 | 搜索支持清空；数值区分单位、上下限；敏感字段脱敏，不自动显示 token |
| **选择器** | 与输入框同高、同圆角、同 focus；明确当前值与箭头，可用原生 select | 选择后若写入 Host Config，仍由 Host 保存/校验；不可做无来源的伪选择器 |
| **按钮** | Primary 填底、Secondary 描边、Text 低强调、Danger 受控；每区域最多一个 Primary | loading/disabled/失败反馈明确；危险操作仍二次确认，不使用亮色诱导 |
| **日期时间** | 同一控件高/边框，可使用原生 `datetime-local` 或宿主现成日期时间选择能力 | 日期、时区、时刻分开说明；IANA 时区明确，不把浏览器本地时区默认为联系人时区。仅在真实时间过滤/静默策略编辑需求存在时显示 |

### 4.0 四种控件在设置页内的优先次序

1. **Switch** 表示单一 Boolean 功能的开/关；标签文案明确具体行为（例如“显示意识海”），不要使用只有图标的开关。
2. **填底 Segmented / Radio.Button** 表示互斥模式，尤其 `promptSection` 三态与「图表／数字」切换。可选项 2–4 个时优先按钮组；候选很多时改为 Select，避免横向拥挤。
3. **Select、Input、Date/Time** 仅在真实配置或筛选有对应字段、提交机制和权限时出现；避免为了展示控件种类编造“未来可配置”的假表单。
4. **Button** 执行明确动作：跳转、刷新、检查与审批。危险动作与 Switch 严格分离；编辑行为分为即时确认（本地 prefs）与 Host 配置受控保存（由 Host 提供），没有第三套路径。

说明默认保留一句最重要的后果；较长帮助可采用**可聚焦、可点击的 ⓘ 展开行**，不能只靠 hover tooltip（键盘和触摸用户必须看得到）。

### 4.1 Switch 的状态与保存约束

- **何时使用**：Switch 只回答“这一项是否开启”，例如 Psyche 自有偏好 `sea`（显示意识海）。当前 `promptSection` 允许 `true/false/null`，继续使用三态填底单选或选择器，不得转成 Switch；图表/数字、时间范围等互斥展示选项使用填底单选。
- **是否有权修改**：主工作台只允许 Switch 编辑已批准的 Psyche 本地偏好；`capture.enabled`、`mood.enabled`、QQ 总开关等 Host Config 即使类型为 boolean，也只能在 DSH Plugins 唯一配置入口编辑。主工作台显示文字状态和“打开宿主设置”，**不得摆第二个可点击 Switch**。未接入、不可用、强制开启和权限受限也用文字状态而非假开关。
- **控件契约**：优先实际存在的 Host Switch；否则使用既有 React + 原生 checkbox 的局部外观。整个轨道可点击，标签可见，不靠颜色区分开/关，保留键盘 Space、焦点环、屏幕阅读器开关语义及 `disabled`。不使用第三方 Portal、全局 CSS 或依赖 CDN 的动画。
- **写入契约**：`sea` 按 UI-1 现行 `/api/psyche/prefs` 逐字段保存；提交中只禁用当前 Switch，服务端确认后才呈现为“已保存”，失败回到服务端最后确认值并显示行内错误；保留版本校验、旧响应隔离、切页保持与卸载取消。网络结果不确定时提示核对，不能把点击动画当作写入成功。
- **敏感操作**：删除数据、重置人格、发送/重试、撤销授权等不做“一拨即执行” Switch，仍采用明确动作按钮、身份/权限复核与二次确认；不因外观调整改变原流程。

**Host 降级顺序**：若 Host 不提供可验证的 Switch，优先使用已有 UI-1 Switch/原生 checkbox 组合；日期时间无宿主控件时使用原生输入；当前版本缺少新半径/设置卡 token 时回退 UI-1 已验样式，而非创造独立主题。若宿主提供已验证的焦点/背景 token，以宿主为准；不允许 `!important` 改写全局 Host 控件。

通用尺度：标准控件约 36px，紧凑 32px；同组按钮、输入和选择器高度一致。标题/辅助文字遵循宿主字体和对比度。边距用 4px 网格；圆角先用 **实际可用的** `--dsw-radius-*`，旧 Host 未证实时使用 UI-1 已验的兼容值。状态不得只靠颜色；错误在控件下方就地展示；不依赖 hover 才能操作。控件可以轻微 hover/pressed 变化，但不能引入与 Host 光标、键盘行为冲突的弹层。

**表单真实写入仍分两路**：本地 `sea`/`promptSection` 用既有 `/api/psyche/prefs`，Host 运行配置只在其 Plugins 自动表单（或另行批准的 `plugins.bundle.config` page）编辑。同名设置绝不双入口；`promptSection=null` 文案固定为“跟随配置”。

## 5. ECharts、八维情绪与图表／数字切换

### 5.1 选择图表的条件

当前源码已有离线 `assets/echarts.min.js`、`/psyche/echarts.js`、`ensureEcharts()` / `EChartBox`；在已验证的 Host 中优先复用该路径，不引第二份图表库、不使用 CDN。ECharts 的容器、初始化、主题重绘和资源释放仍由当前 Host React 生命周期管理，Cordis effect 负责插件级注册的回收。

**并非每张卡都要图表**。只在图形能表达构成、变化或多维比较，且有真实数据时提供「图表／数字」切换：

| 模块 | 图表模式 | 数字模式 | 默认与限制 |
| --- | --- | --- | --- |
| **情绪** | 八维雷达 + 极淡的原始 baseline 参考线 | 八行简洁的当前强度，按需展开 baseline/更新时间 | 中宽屏默认雷达；窄屏默认数字，用户可手动切回 |
| **记忆构成（若实际数据可用）** | Source / Event / Artifact 分类型构成图 | 三项分别列数，不造「已记住总数」 | 默认数字；不把三个数量相加当成果指标 |
| **用量与花费（高级）** | 已有真实时间桶的趋势图 | 对应区间的真实数值表 | 按既有 API；没有采样显示空态 |
| **QQ、数据库健康、待处理** | 不引入切换 | 状态、计数或文字 | 永远数字/状态优先，避免多余可视化 |

切换按钮组在**卡片标题右侧**；图表与数字必须使用**同一份已校验数据快照、相同的时间与 Scope**，只改变展示，不新增第二次敏感请求。切换不写宿主 Config、SQLite 或用户偏好；**本轮只记页面会话内状态**，除非以后另行批准跨重启持久偏好。无数据与错误态两种模式保持一致；不能在数字视图显示旧数据而图表显示新数据。

### 5.2 情绪维度评估：推荐八维，不更改 33 维模型

| 候选 | 优点 | 缺点 | 裁决 |
| --- | --- | --- | --- |
| 六维 | 图形最简洁，适合小卡片 | v3 组合只有 4 项积极/认知与 2 项压力/精力，不能直观看到烦躁与低落 | 不采用为默认；可作为未来极窄预设，须另审 |
| **八维** | 4 项积极/认知 + 4 项压力/精力，信息较均衡；雷达标签仍可管理 | 320px 下文本可能拥挤，需要数字默认与手动切换 | **采用** |
| 九维 | 略多一个情绪 | 在小卡片更拥挤，增加的维度难保证独立含义 | 不采用 |
| 12/33 维 | 全面 | 雷达失去概览价值，重叠太多 | 仅高级明细；不进入雷达 |

八个指标均来自 `packages/core/src/mood-schema.ts` 的**原生 key**，不是新建聚合算法；显示顺序固定，避免不同会话变形只是因为排序改变：

| 显示名 | 源 key | 情绪层 | baseline（当前 v1） |
| --- | --- | --- | ---: |
| 平静 | `calm` | basic | 45 |
| 开心 | `happy` | basic | 30 |
| 好奇 | `curious` | basic | 28 |
| 专注 | `focused` | basic | 30 |
| 焦虑 | `anxious` | compound | 10 |
| 烦躁 | `irritated` | basic | 10 |
| 低落 | `down` | basic | 10 |
| 疲惫 | `tired` | basic | 18 |

这八维仅是**情绪状态的代表性观察窗口**；不宣称覆盖全部感受（如同情、委屈、怀旧、恋慕）。所有值为 0–100 的强度，**数值高不等于“更好”**，不能对八项求平均或当作人格/好感度分数。

### 5.3 雷达与数字模式的精确规则

1. 雷达图使用八个当前有效值（一条有轻填充的主轮廓），并以**很淡、无填充的虚线**显示各维独立 baseline 参考值，解决 33 维中 baseline 不同导致的误读；各维只与自身 baseline 比较，不做跨维归一化或综合评分。主数据与 baseline 要有可读图例或注释；背景网格不超过四层，图上不铺八个数值标签。
2. 数字视图展示八个 key 的当前有效值与**相对本维 baseline 的偏差**（同维比较）；不显示跨维综合分、平均分或“情绪总评”。不同维度 baseline 不同，**原始强度不可跨维比较**——雷达只表达各维相对自身 baseline 的方向与幅度，数值必须带本维 baseline 才可读。baseline/更新时间放展开说明或 tooltip。
3. `GET /api/psyche/mood` 必须返回有效衰减值，八个 key **全部存在且数值有限、介于 0–100**才可展示，缺一项就显示“数据暂不可用”，不能用 baseline 悄悄填充；baseline 来自同一份有效配置。历史只绘真实写入时点，不插值。
4. 来源区分：Global Mood 雷达不能代表 Contact Affect；`computeMoodBehavior` 的表达档位依赖可信 Host Agent/Turn。`assembly.agent=null` 时仍须显示 Host 表达观测 **PARTIAL/默认 balanced**，不能因为雷达有数值就声称模型采用该心情。
5. **响应式**：使用 `main` 实际卡片宽度，不用窗口 viewport。卡片可用宽度约 **小于 400px 时初次默认数字**；达到 400px 及以上时初次默认雷达。**用户手动选择之后，不因窗口缩放强制改回**；尺寸太小仍允许自选雷达但应适配边距，绝不裁掉轴标签。超窄无法完整渲染时提示使用数字模式。
6. 切换方式为填底单选 `图表 / 数字`，不使用 toggle switch；切换时不请求新数据。切换数字模式、离开页面、折叠隐藏或卸载时立即 `dispose()` ECharts 实例与监听器；返回时根据当前同一份数据初始化，ResizeObserver/主题监听/异步加载结果遵循代际检查与 dispose。
7. 图表/数字都附一行：**「八项代表维度，数值表示强度，不代表好坏；完整系统共 33 维。」** 允许展开全部 33 维，但不在初始首屏展示长表。

ECharts 只使用现有 `radar.indicator` 和 `series.type='radar'`；下方是字段映射与样式**示意**，不是可直接复制的完整生产 option：

```ts
const keys = [
  'calm', 'happy', 'curious', 'focused',
  'anxious', 'irritated', 'down', 'tired',
] as const
const labels = [
  '平静', '开心', '好奇', '专注',
  '焦虑', '烦躁', '低落', '疲惫',
]
// 必须先从同一份 GET /api/psyche/mood 校验 current 和 baseline
const indicator = labels.map((name) => ({ name, max: 100 }))
const option = {
  radar: { indicator, splitNumber: 4, radius: '60%' },
  series: [{ type: 'radar', data: [
    { name: '当前强度', value: keys.map((k) => current[k]), areaStyle: { opacity: 0.13 } },
    { name: '参考基线', value: keys.map((k) => baseline[k]),
      areaStyle: { opacity: 0 }, lineStyle: { type: 'dashed', width: 1 } },
  ] }],
}
// 线色、文字、分割线和 tooltip 均通过已验 Host token + resolveChartTheme 派生
```

### 5.4 统一切换按钮的行为与验收

- 控件选择状态应存在于拥有该卡片的稳定 React 状态中；刷新/轮询不重置，切到其他页再返回可保持当前会话内选择。必要时 `aria-label` 写为「情绪展示方式」而非重复多余图标。
- 「图表」失败（资源未加载/Canvas 初始化失败）显示原因与**立即可用的数字视图**入口；不把 ECharts 错误当成数据库读取错误。`prefers-reduced-motion` 仅用于减少动画，不用于推断宿主深浅主题。
- 宿主主题由真实 `--dsw-*` CSS token 和 Host 属性决定；图表更新需要重新解析 token，页面卸载及插件卸载都要清理实例、Observer 与监听器。不可重复 `echarts.init()` 于同一 DOM。
- 对图表与数字模式分别测试合法值、无数据、读失败、范围非法、切换中轮询、主题切换、320/736/1024px 宽度、360px 高度及卸载重载；不允许通过截图相似度替代数据一致性断言。

## 6. 页面精简细则与操作入口

### 6.1 概览

一行 3–4 个小状态：数据库、QQ、需要处理、最近更新时间。主区两张并列卡为“最近记忆”和“当前情绪”，下一行“成长/关系”与“提醒/快捷入口”；若展示真实记忆构成，采用同一张卡内「图表/数字」，首屏默认数字。**不要**把 Source、Event、Artifact 相加称为“记忆总数”；只显示少量有意义的真实计数/文字。运行时 Context/Provider 能力不同级，摘要保留受限状态但不铺满探针报告。

### 6.2 记忆

一个搜索输入 + 少量填底单选过滤（如“全部/重要/最近”，仅在真实查询 API 可实现时启用），默认最近 5 条安全可见的结论。详情展开可看版本和 Evidence，原始受限内容不得经 API 提前送到页面。意识海作为**显式入口**，`sea=false` 则隐藏，不在首页持续运行 Canvas。提案/审批维持既有 Owner 边界，不能利用“简化 UI”打开未经认证的写路由。

### 6.3 情绪

首屏只显示：**八维雷达／数字切换卡**、当前表达状态、关系简述、成长阶段；小卡片初始默认数字，桌面宽卡初始默认雷达。33 维长列表改“查看全部维度”；历史趋势按需打开；Contact Affect 不在默认界面显示五维分数。成长确认/撤销仍限既有可信 CLI/审批边界。

### 6.4 QQ

默认只显示连接是否成功、私聊允许与否、简要统计/异常。诊断事件及 200 条运行日志收在“高级诊断”；不在同屏铺两份表格。B-4-2 尚未批准生产接线，不出现“发送队列已启用”“自动重试成功”等按钮或文案；`unknown` 不可展示为 sent。群回复保持 DISABLED，字段未批准前不显示假群配置表。

### 6.5 设置与高级

主区域只保留 `sea` **Switch 二态开关**、`promptSection` **填底三态**和「打开 DSH Plugins 页」说明入口（`sea` 的保存行为继续复用 UI-1；不承诺直达具体 bundle 或配置 card）。低频的只读配置摘要默认折叠。以下能力不做一级导航，但**必须仍能从“高级与维护”找到**：存储健康、自检、备份/恢复、用量与花费（有真实时间桶时可图表/数字切换）、诊断入口、版本与开发信息。备份/恢复/擦除等高风险动作沿用原有复核、Owner/权限与确认语义，不能因为页面精简而消失或简化门槛。

日期时间组件只在有真实业务需要时使用，例如**日志/用量时间筛选**；联系人静默时段若属于 Host Config，应回到宿主唯一编辑面，不能在主面板新建相同字段的可编辑副本。

### 6.6 设置页结构建议（参考四个插件后收敛，**不是已实现 UI**）

```text
┌ 设置 ──────────────────────────────────────┐
│ 个性化                                      │
│ 显示意识海     在记忆页显示可视化入口   [Switch] [即时生效]│
│ 记忆纪律       注入方式               [三态按钮] [保存后生效]│
│                                             │
│ DSH 运行配置                                │
│ 自动采集、QQ、情绪等均由 DSH 配置            │
│ 「查看当前运行状态」  「打开 DSH Plugins 页」   │
│                                             │
│ ▸ 高级与维护                                │
│   [自检] [备份与恢复] [用量与日志]           │
└─────────────────────────────────────────────┘
```

**卡片规则**：一个设置分类使用**一张**清楚的卡片，卡内按「标题 → 设置行 → 分隔线」排列；**不为每个 Switch 再包一张小卡片**。宽屏可让“个性化”和“DSH 运行状态”同排等高，但卡片内部**表单项以单列阅读为主**；高级区打开时在下一行**独占全宽**，不得拉伸另一列形成大片空白。设置卡头部统一 40–48px 区域；紧凑设置行推荐 48–64px（依文字实际换行增长，不截断核心提示），控制在同一基线；卡片底部按钮使用统一边距。

**借鉴 `dsh-computer-use-win`**：分区、字段旁边的短说明/ⓘ、清晰的即时/待保存区别，以及「更多设置」折叠。**借鉴 `dsh-bili-subagent`**：仅在模式需要时显示附加设置，并保留原值而不暗中清除。**借鉴 `DSH-better-sidebar`**：可识别的功能块及启用态，但不要复制它对宿主右侧栏的专用布局。**借鉴 `billion-context`**：概览与日志分离；它的独立 `localhost` 配置页面不是 Psyche 的插件页面授权模型。

#### 条件设置的展示与写入

- **现在可以做的**：本地 `sea=true` 时，记忆页出现意识海入口；关闭时入口隐藏，但不删除任何已有记忆、Canvas 数据或偏好。`promptSection=null` 始终呈现「跟随配置」，不能在刷新时当成 `false`。
- **仅属将来的 Host Config 交互提案**：例如采集模式选为「关闭」时，间隔/范围类附属行可以折叠；但只有实测 Host 自动表单支持该条件显示或已批准独立 Config Page 后才实施。否则保持 Host 原样表单、在 Psyche 主页面只给配置入口，不造第二份可编辑设置。
- 条件行隐藏**不等于删除配置值**。切换模式后若需要重置，必须有既定后端契约与明确用户提示；不能由前端猜测并覆盖存储。
- **依赖规则**：关闭父级功能时，子项只变成不可用/折叠，不自动把下层子开关写为 `false`。实际运行状态始终由服务端重新确认，未获得 Host API 时不虚构预览“已生效”。
- **生效方式必须显式标注**：每条可编辑设置行都要标明 `即时生效` / `保存后生效` / `重启后生效`；卡片标题可汇总，但不得只标卡片而略过具体行。Host 未提供证据的能力标 `未验证`，不做“已生效”预览，也不把“保存成功”写成“已生效”。
- **保存语义**：本地 prefs 继续提交即服务端确认、每字段旧响应隔离；Host Config 由 Plugins 原生表单处理保存/版本冲突，不从主工作台触发 Host `form.mutate`，亦不混成一个“保存全部”。

## 7. DSH 第一优先的主题、样式与布局

### 7.1 冲突裁决表

| 冲突点 | 第一优先做法 | 禁止的替代做法 |
| --- | --- | --- |
| 颜色与主题 | 使用实机已确认的 `--dsw-alias-*` 状态/背景/文字/边框/brand token；局部 `--lb-*` 只别名派生 | 独立 AntDV ThemeProvider、自绘永久深色、覆盖 Host CSS |
| 圆角、卡片填色 | **Host 当前版本已证实的 token 优先**；无证明则回退 UI-1 已验证样式或原生控件 | 假定 `--dsw-radius-*` 或 `--dsw-alias-settings-card-*` 全部已存在，凭文档直接上线 |
| UI 组件 | Host 可用组件优先、已验 React 组件其次、原生 HTML 最后 | 注入 Vue/AntDV 全局组件、覆盖整个 Host 的按钮、选择器或弹层 |
| 布局 | 只绘制 `main` 槽位内内容；保留 `sidebar.panellist`+`main` 与单一正文滚动 | 重新绘制宿主窗口、第二套左侧侧栏或浮动全屏壳 |
| 配置 | Plugins Schema 自动表单作为 Host Config 的唯一编辑入口；本地 prefs 保留独立接口 | 在工作台重复编辑配置，或为了漂亮让前端直接改数据库/Profile |
| 生命周期 | 绑定 Cordis effect 与 Host React 的 mount/unmount；释放实例、监听器、网络请求 | 全局 DOM/计时器/Observer 残留，热重载发生重复注册 |

### 7.2 当前实机可证明的 token 与候选 token

旧 `UI-0.5` 实测的 Host `0.2.1-rc.5` 仅暴露 **14 个颜色 token**（13 个 `--dsw-alias-*` 与一个 `--dsw-specific-sidebar-fill`）；`--dsw-radius-*`、`--dsw-alias-settings-card-fill/stroke`、字号与间距 token 都**没有**在该次 `Theme.listTokens` 中证实。**UI-CONFIG-0 是 UI-2a2 采用新增主题样式的前置，不阻塞沿用 UI-1 样式的 UI-2a1 导航骨架**：必须在目标 Host（当前 0.2.2-rc.3）用 `Theme.listTokens` + 真实 `getComputedStyle` 双证据，列出实际可用的 radius、settings-card、间距、字号 token 与 light/dark 计算值、回退链；未取证的 token 只能作为候选，UI-2a2 一律回退 UI-1 已验收样式或原生控件。Host 版本变化后重做取证，不得用设计文档或别的插件截图替代实机证据。

页面的科技感优先来自**真实状态信息、整齐网格、细分隔线和一个品牌强调色**；如果宿主缺乏玻璃材质所需的可信 CSS 值，就采用普通 Host 卡片而不是额外叠加玻璃、霓虹、阴影。深浅色以 **Host 实际切换**为准，不以系统 `prefers-color-scheme` 判断。

统一文本（正文约 14px、帮助 12px）、状态文字、数字对齐、按钮高度、错误提示和焦点可见性。不同卡片只允许**内容差异，不允许各自定义色板、圆角、阴影和标题尺度**。图表类别颜色不借用“错误红/成功绿”；减少动画偏好必须生效。卡片仍按 §3 同行等高，短窗口不能让雷达把主导航推走。

### 7.3 与四个参考插件的 DSH 兼容性差异

| 参考源（2026-11-16 公共仓库可见内容） | 可以采纳 | **不得直接照搬** | 采用条件 |
| --- | --- | --- | --- |
| [dsh-bili-subagent](https://github.com/Yuuyuko-uu/dsh-bili-subagent) | 模式三选一、模式相关子项条件出现、按主题的行式表单，便捷的「检查」操作 | 它自己的即时写入逻辑、Python 环境安装/扫码登录、公开发帖开关 | Psyche 数据与权限有已批准的写入口；Host Config 不得被本地 prefs 取代 |
| [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) | 分区式设置、ⓘ 帮助、可折叠高级项、状态预览、即时与保存后生效分清 | 它的桌面接管浮窗、鼠标指标、全局 Esc 钩子，以及为截图增加未接入控件 | UI-1 的 Host React + Cordis 生命周期适配；不扩系统操控权限 |
| [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | 一个功能一组设置、短副标题、开关配合更多设置、内容懒加载 | 接管宿主右侧栏、插件底部工作台、拖拽分栏布局；**其最新插件要求更新的 DSH 线** | 以当前 Psyche 已验 `0.2.1-rc.5` 的 Slots/Theme 为准，升级后另行审计 |
| [billion-context](https://github.com/ranxianglei/billion-context) | 概览、会话、日志、配置分层；空闲态与真实指标区分 | `localhost:8787` 独立仪表盘、HTTP 代理配置编辑器、后台远程内容抓取 | 心灵继续只走已批准的 Host Slots/本地 API 和权限门禁，绝不新建独立 UI 服务 |

**证据分层**：README 和可读源码能够支持“交互组织方式”的参考，但不能证明该样式适配 Psyche 当前 Host，也不能证明四个项目都使用相同的 `plugins.bundle.config` API。此表为**设计借鉴**，不是 Host 功能认证。依赖其他插件的截图/页面样式不能用于提升 Psyche 的 UI-4 验收结论。

**版本特别注意**：`DSH-better-sidebar` 的中文 README 对 `0.2.1-rc.1…rc.5` 与 `0.2.2-rc.2+` 分别列出不同兼容版本，因此不能拿它较新版本的卡片和宿主能力，当作 Psyche 曾验过的 0.2.1-rc.5 已支持。目标宿主升级时应重新检查 Tokens、Slots、弹层与配置表单能力。

## 8. DSH 开发规则与最小影响范围

- Client 继续使用现有 `dsh.client` + `exports['./client']` 的脚本式 lazy-CJS factory、Host React 和 Slots。`dsh.client.inject` 静态；所有事件/Observer/定时器/图表与 Cordis effect 和页面卸载生命周期绑定。**不引入 Vue 渲染运行时、AntDV CSS、不全局改变宿主 DOM**。保持本地资源，不访问公网 CDN。
- Host 配置页如要自定义，须先审计 `plugins.bundle.config`/`form.mutate(operations,expectedRevision)`、Secret、实例归属、自动表单替换和 Host API 认证；**本次不实施**。
- 可视化、控件、信息归位只能改 `src/client/index.ts` 及经过评审的 UI 资源/测试；原则上不改 Core/Schema/QQ 传输/Outbox/成长规则。需要新只读字段时先单独审计数据契约，不能先造页面再凑 API。
- 现有 ECharts 离线路由与加载机制复用；若拆组件须维持 bundle 兼容和 `test/check-client.mjs` 的要求。
- Host 认证 PARTIAL、H-2 Provider BLOCKED、B4 Tool Invocation BLOCKED、P5 Runtime PARTIAL 等均原样保留，不因 UI 迭代重标。

## 9. 实施批次（仅规划，不授权混批）

冻结只锁定设计，不要求本表任何批次先完成。UI-2a1 可沿用 UI-1 已验收样式先行；UI-2a2 采用新增主题样式时才依赖 UI-CONFIG-0 的 token 证据；UI-CONFIG-0 是只读审计，不是实施前置。

| 批次 | 内容 | 交付/门槛 |
| --- | --- | --- |
| **UI-2a1（先做）** | 导航骨架：五页路由/页签、`sidebar.panellist` + `main` 注册、同行等高网格、页头与唯一滚动容器；不含设置页重排与新控件 | 导航/键盘/主题回归；旧 7 页签逐项有唯一可达路径（§2.2）；不改 API/Schema；不新增 Host Config 写入 |
| **UI-2a2** | 设置页三层密度与行式卡片、`sea`/`promptSection` 控件统一、按 Host 能力统一 Switch/填底单选/输入 | 依赖 UI-CONFIG-0 token 证据；`sea`/`promptSection` 保留 UI-1 保存语义；图表/设置页隐藏或卸载时立即 dispose 监听器与实例，切页不重复注册 |
| **UI-2b** | 记忆、QQ、设置的信息归位；**ⓘ 帮助与高级折叠**；减少只读表、重复卡片及默认请求 | 每个隐藏项有可达路径；折叠不丢保存值、不绕过认证；默认不加载大表；权限和失败语义不变 |
| **UI-2c** | **ECharts 八维雷达/数字切换**；情绪与关系/成长摘要，33 维默认折叠 | 校验真实 8 key+baseline；窄屏数字默认；同宿主主题；页面切走/隐藏/卸载立即 `dispose()`，返回时按同一份数据重建；不改 Mood 算法 |
| **UI-CONFIG-0（可并行只读）** | 实机审计 Host 的可用控件、主题 token、`plugins.bundle.config` 的条件字段与自定义 page 能力 | **审计先于实施**；缺少原生能力就保留自动表单原样；不为了参考插件外观新增写入端点 |
| **UI-4** | 完整真实 Host 验收 | 见 §10；不复用旧 UI-0.5/UI-1 的 PASS 代替 |

当前主线仍可优先 B-4-2；UI 本轮只修订方案，**不默认把 UI 实施排在 B-4-2 前面**。

## 10. UI-4 重点验收矩阵

| 分组 | 必须通过 | 不可扩大结论 |
| --- | --- | --- |
| **导航精简** | 五个主页面；旧功能从高级入口可达；无第二套 Host Sidebar/配置真源 | 不是删除业务能力/API |
| **卡片对齐** | 320/736/1024px main 宽、720/360px 高、侧栏收放；≥900px 同行双卡等高、标题/底部对齐；窄屏单列不溢出；长文字不压坏 | 截图美观不证明业务链路 |
| **控件/主题** | 布尔 Switch（`sea`）开/关与可访问性、Space/focus/禁用/逐项提交；填底 radio 键盘互斥；输入/选择/按钮/日期时间同尺度；缺失 token 降级；Host 深浅主题与系统反向；`promptSection` 三态回归 | 不用 Switch 代替图表/数字单选或三态继承；不把 Host Config 的只读值做成可写 Switch；不引 Vue/AntDV 全局 CSS |
| **设置分组/条件可见性** | 首屏只显示 `sea`、`promptSection` 两项本地偏好和 Host 配置入口；高级默认收起；帮助可用键盘展开；禁用/失败态不假装保存；条件切换不丢旧值；同组表单行对齐且不套卡 | 不假设 Host 自动表单支持任意条件分组或自定义 save；不因为隐藏功能改变业务启用状态 |
| **参考插件兼容性** | 对照当前 Host 版本单独核验实际 token、slot、控件与卸载；旧版兼容 fallback；不依赖外部插件运行时资源 | 四个仓库的截图/设计不是 Psyche 实测 PASS；独立 Web Dashboard 不等于 DSH Host 插件配置页 |
| **情绪雷达/数字** | 8 key：calm/happy/curious/focused/anxious/irritated/down/tired；各自 baseline；有效值 0–100；数字与图表同源，缺失/非法/DB 失败同空态，宽窄屏、主题、resize/卸载验收 | 八项不代表完整 33 维，不代表评分算法/Provider 实际语气 |
| **图表/数字切换** | 情绪、记忆构成、用量趋势三类按需切换；选中态键盘无障碍、切换不重取、轮询不重置、数值一致、图表失败可回数字 | 不为所有只读模块强行加图表或将视图切换写入 Host Config |
| **偏好保存** | 39 既有断言 + 真 Host 三态/成功/失败/交错/旧轮询/卸载回执回归 | 不扩为 Host Config 编辑 |
| **安全与诊断** | Scope/Disclosure 先于返回、QQ 只读日志脱敏、导出仍禁、群回复关闭、unknown 不判 sent；危险动作门禁不变 | 不表示 B-4-2/H-2/B4 已通过 |
| **证据版本** | 本轮单独日志/截图/构建/全量回归/固定 HEAD、Host 版本、profile，区分设计/模块/Host | 不沿用历史 UI-0.5 189/UI-1 329 结果冒充新版 |

## 11. 变更与参考

### 11.1 相比 v3 的明确修改

1. **DSH 优先级提升为首要不变量**：Host 可用组件、已证 Theme token、Cordis effect 与 Plugins Config 路径始终优先，AntDV 仅为视觉参考；宿主不支持时降级。
2. 雷达从 v3 六维改成**八个真实原生情绪维度**；保留全部 33 维 Core，新增 baseline 淡虚线以避免误读，窄屏默认数字。
3. 只对**情绪、必要的记忆构成、用量趋势**提供填底 `图表 / 数字` 单选；数据与 Scope 共享，不创建第二真值。
4. 确认 UI-0.5 旧 Host 实测仅 14 个颜色 token；扩展半径/设置卡 token 需实机再核对；未确认则回退现行 UI-1 样式。
5. 继续五页导航、卡片同行等高、原有 UI-1 与 P5 冻结；UI-2/4 要按 v4 新增矩阵重新验收。

### 11.2 v4.1 补充：Switch 控件冻结口径

- 添加 **Switch（二态布尔）** 控件规范与可访问性、服务端确认/回滚、Host 配置归属及危险操作限制；`sea` 是现阶段主工作台的实际应用位置。
- 维持 **填底单选负责互斥切换**（图表/数字、时间范围、`promptSection` 三态），不因增加 Switch 而改变原语义。
- 本次仅修订设计文字；既有 UI-1 回归与 Host 验收不自动升级为 v4.1 PASS，不修改 P5/Outbox/Host/Schema。

### 11.3 v4.2 补充：四个参考插件带来的改进

1. 设置卡改成**行式表单**，标题下同组排布，杜绝卡片套卡片；表单单列阅读，左右摘要卡才使用同行等高。
2. 默认只显示**可操作的两个本地偏好 + 一个 Host 配置入口**；低频维护与只读详情折叠并懒加载，不新增假的开关。
3. 新增**条件展开、帮助说明、依赖规则和保存时机**的语义契约；只有真正的 Host Config 能力得到实测才允许在 Host 配置页复现条件表单。
4. 保留八维情绪、图表/数字填底切换、Switch 和五页导航，并明确参考插件的 UI 并不能作为 DSH 能力证明。
5. 参考实现只用于**交互与视觉组织**，拒绝复制 `billion-context` 独立控制台、`better-sidebar` 宿主栏改造或第三方的配置写入协议。

### 11.4 v4.3 修订：外部评审五项阻塞项

1. **配置入口去深链**：主入口改为「打开 DSH Plugins 页」；不承诺直达 bundle 或配置 card；无直达证据时给文字指引，不伪造按钮（§2.3、§6.5）。
2. **token 先取证后设计**：`--dsw-radius-*`、settings-card、字号/间距 token 未经 UI-CONFIG-0 的 `Theme.listTokens` + `getComputedStyle` 双证据不得启用；UI-2a2 默认回退 UI-1 样式，UI-2a1 不依赖 token 取证（§7.2）。
3. **旧页签迁移表**：补 UI-1 `BASE_TABS` 7 页 → 新五页的逐项映射、默认展示与加载时机（§2.2）。
4. **雷达语义**：原始强度不可跨维比较；数字视图显示相对本维 baseline 的偏差；不做综合分/平均分/“情绪总评”（§5.3）。
5. **UI-2a 拆分与生命周期**：拆 UI-2a1（导航骨架）与 UI-2a2（设置页/控件），2a2 依赖 UI-CONFIG-0；页面切走、隐藏或卸载时立即 `dispose()` 图表实例与监听器（§9）。
6. **补生效标签**：每条可编辑设置行标 `即时生效` / `保存后生效` / `重启后生效`，无证据标 `未验证`；卡片标题可汇总（§6.6）。

### 11.5 依据与能力分层

- **本地已提供**：`plugin-ui-layout-plan-v2.md`、`plugin-ui-layout-plan.md`、`plugin-ui-layout-plan-review.md`、`plugin-ui-05-host-skeleton.md`、`plugin-ui-1-implementation.md`、`dsh-plugin-config-ui-guidelines.md`。
- **源码确认（上传 ZIP 静态读取，不是新实测）**：`packages/core/src/mood-schema.ts` 包含 33 维及本方案 8 个 key；`src/client/index.ts` 有 `ensureEcharts`、`EChartBox`、`chartMoodOption`；`package.json` 已将 `assets/echarts.min.js` 列入发布清单。
- **官方 Host 参考**：[DSH Cordis 首插件](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/01-first-plugin)、[DSH 配置与 volatile](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/05-config)、[DSH Cordis effect 生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/02-lifecycle-and-effects)；外观仅参考 [AntDV solid Radio](https://ant-design.antgroup.com/components/radio-cn) 与 [Apache ECharts Radar](https://echarts.apache.org/en/option.html)。

- **四个公开插件参考（2026-11-16 查看）**：[dsh-bili-subagent README](https://github.com/Yuuyuko-uu/dsh-bili-subagent#readme) 与 [`client.js` 条件设置](https://github.com/Yuuyuko-uu/dsh-bili-subagent/blob/main/client.js)；[dsh-computer-use-win README 设置章节](https://github.com/Yu-tao-Li/dsh-computer-use-win#readme)；[DSH-better-sidebar 中文 README](https://github.com/omdsh-dev/DSH-better-sidebar/blob/main/README_ZH.md)；[billion-context README](https://github.com/ranxianglei/billion-context) 的仪表盘与配置层级说明。仅用于设计借鉴，未执行这四个插件的 Host 实测。
- **状态界限**：本文为 UI-2 修订方案，不改变 `P3-C-3b PASS（工程级）`、`B-4-2 前置审计 PARTIAL`、`P5 行政 PARTIAL`、`H-2/B4 BLOCKED` 的既有判定。采用本方案后，必须用新 HEAD 的 Host 测试单独验证。
