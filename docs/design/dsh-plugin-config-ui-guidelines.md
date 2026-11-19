# DSH 桌面版插件配置 UI 规则与规划

- 日期：2026-11-16
- 适用：DeepSeek Harness 0.2 桌面版（当前客户端）中的本地插件 Web UI
- 依据：`dsh-plugin-guide` 知识库、官方文档 `docs/subsystems/settings.md`、`docs/subsystems/slots.md`、`docs/subsystems/sidebar-right.md`、`docs/ui-radius.md`、实机 `cordis_inspect_query`（Slots/Theme）与 psyche 现有实现
- 性质：设计规则与布局规划，不是宿主 API 文档；与宿主版本相关，升级后需重新核对

## 1. 结论先行

1. 插件配置 UI 有两条合法路径：**宿主自动表单**（推荐默认）与**插件自定义配置页**（`plugins.bundle.config` 的 `view: 'page'`）。二者只能选一条作为编辑入口，不能双写。
2. 插件主页面（`main` slot）负责数据与运行状态；配置页负责“改什么、何时生效、失败怎么办”。同一配置项只在一处可编辑。
3. 视觉一律使用 `--dsw-alias-*` / `--dsw-radius-*` / `--dsw-specific-*` token；禁止自造色值、圆角、阴影。设置卡使用 `--dsw-alias-settings-card-fill` 与 `--dsw-alias-settings-card-stroke`。
4. 组件只渲染 slot 内容：不接管窗口、不画宿主顶栏/侧栏、不用 iframe 托管整页、不在组件外写 DOM、不 `require` Harness Client 包。
5. 写入以 Host 的 revision 校验为准；插件本地不得声称“已保存”而没有服务端确认。

## 2. 配置界面型态

### 2.1 宿主自动表单（默认）

- 来源：插件 Config schema 被 `ctx.settings` 投影为 Plugins 页中的配置区。
- 适合：字段能用 schema 完整表达、无跨字段联动、无需自定义可视化。
- 规则：
  - 字段标题用用户语言；`description` 写清单位、默认值、生效时机。
  - 敏感字段标 `role('secret')`；远程读取一律脱敏，不把密钥回显到页面。
  - 需要热更新的字段用 `Volatile<T>` / `.volatile()`，并在描述中写“保存后立即生效”。
  - 需要重启的字段在描述中写“重启后生效”，不得在插件页面另做一套“保存并重启”按钮。

### 2.2 插件自定义配置页

- 挂载：`plugins.bundle.config`（keyed，bundle 包名），ownerProps 提供 `view: 'summary' | 'page'` 与 `form?: ConfigPageForm`。
- `summary`：bundle 卡片内的摘要，只读展示关键生效值与状态，最多一个“打开配置”入口。
- `page`：完整表单；由插件自己渲染字段、校验、保存状态。
- 规则：
  - 页面只管理本 bundle 的配置，不展示其他插件的字段。
  - 保存必须调用 `form.mutate(operations, expectedRevision)`；revision 冲突时重新读取并提示“配置已被其他窗口修改”，不得静默覆盖。
  - 关闭自动表单（`configure({ auto: false }, owner)`）后，摘要页仍需能让用户找到全部字段，不能留下“文档里有、界面里没有”的配置。
  - 页面标题、说明、字段文案与自动表单保持同一套术语；切换实现方式不改变用户可见名称。

### 2.3 其他可贡献面

| 面 | 用途 | 约束 |
| --- | --- | --- |
| `plugins.detail.actions` | 单插件操作（检查、修复、导出） | 只放与当前插件相关的动作；破坏性操作二次确认 |
| `plugins.detail.badge` | 状态徽标（运行中/需配置/异常） | 只用状态 token；不写长文案 |
| `plugins.detail.section` | 详情补充信息（版本、数据目录摘要） | 路径默认折叠或脱敏；不堆日志 |
| `settings.section` | 全局设置分区 | 只放跨插件通用项 |
| `settings.general.item` | 通用设置行 | 单个开关/选择，不嵌入复杂表单 |
| `sidebar.panellist` + `main` | 插件主页面 | 负责数据、诊断、历史；配置编辑回到配置页 |
| `sidebar.right.*` | 会话内辅助面板 | 每 Session 一个 dock；不复制主页面全量内容 |

## 3. 注册与运行规则

- `package.json` 的 `dsh.client` 固定为 `{ entry: './dist/client/index.js', platform: 'web' }`；产物为 lazy-CJS factory。
- `dsh.client.inject` 必须是静态字符串数组；运行时拼装不会被宿主接受。
- 组件从 props 取 `runtime`、`slots`、`store`、`inject`、`t`；不注入 `ctx`，不直接访问宿主服务。
- slot 注册必须绑定到 Cordis effect 生命周期；插件卸载/重载时注册自动销毁，不能残留监听器或计时器。
- 需要子 slot 时先在注册项声明，父组件才能 `renderSlot`；未声明的 slot 不会被渲染。
- 会话级数据用 `scope: 'session'` 的 slot；全局配置页用 `root`；不要把会话状态放进全局页缓存。

## 4. 表单交互规则

### 4.1 每行的固定结构

从左到右：**名称 + 一行帮助** ｜ **值/控件 + 生效标签**。

- 名称：名词短语，不加句号。
- 帮助：一句话说明影响；涉及隐私、外部请求、不可逆操作必须写明。
- 控件：宽度稳定，不因值长短跳动；数值带单位。
- 生效标签：`立即生效` / `重启后生效` / `只读` / `强制开启`，用文字，不靠颜色。
- 只读项用文本值，不画画了却不能点的开关。
- 强制项说明规则，不提供关闭控件。

### 4.2 保存与错误

1. 提交中只锁定当前行；其他行仍可操作。
2. 成功以服务端返回的新状态为准，再解除锁定并显示“已保存”。
3. 失败回到提交前的值，在行内显示可读错误（HTTP 状态或稳定错误码），不只写控制台。
4. 连续快速切换、切页返回、轮询覆盖时，以较新的本地提交为准；旧响应不得覆盖新意图。
5. 数据未到达或读取失败时，控件禁用并给出重试；不得把默认值当作已确认值。
6. 破坏性操作（清空、删除、撤销授权）必须二次确认，并写清影响范围。

### 4.3 校验

- 前端做格式/范围提示，最终以 Host 校验为准；不得绕过 Host 直接写库。
- 跨字段约束（如“上限 ≥ 下限”）在页面内即时提示，错误定位到具体字段。
- 空值、非法值、超范围值分别提示；不要统一成“保存失败”。

## 5. 布局规则

### 5.1 页面骨架

```text
页面标题（可选一句话说明）                     右侧：至多一个主操作
──────────────────────────────────────────────
[分区 1]  标题 + 说明
  行 / 行 / 行
[分区 2]  标题 + 说明
  行 / 行 / 行
```

- 插件配置页渲染在宿主 Plugins 页内部，不重复画品牌、窗口边框、宿主侧栏。
- 页面只保留一个主标题；分区标题用 h2（14px/500），说明用 12px 次级色。
- 分区之间 24–32px；行与行之间用 0.5px 分隔线，不用卡片套卡片。
- 内容宽度 <900px 时保持单列；设置行不换成两行堆叠，控件允许占满剩余宽度。

### 5.2 卡片与材质

- 需要独立边界的内容（设置卡、摘要卡）：
  - `border-radius: var(--dsw-radius-xl)`
  - `border: 0.5px solid var(--dsw-alias-settings-card-stroke)`
  - `background: var(--dsw-alias-settings-card-fill)`
  - `padding: 20px`（紧凑场景 16px）
- 卡片内不再嵌第二层卡片；需要分组用标题 + 分隔线。
- 悬浮、选中、聚焦只改颜色/描边，不改圆角，不改变布局尺寸。

### 5.3 圆角与间距

| 用途 | Token | 像素 |
| --- | --- | --- |
| 细节、标签、徽标 | `--dsw-radius-xs` | 4 |
| 紧凑控件（H20–28） | `--dsw-radius-sm` | 8 |
| 标准控件/输入（H32–40） | `--dsw-radius-md` | 12 |
| 大控件、嵌套表单组 | `--dsw-radius-lg` | 16 |
| 独立设置卡/内容卡 | `--dsw-radius-xl` | 20 |
| Composer/对话框/主面板 | `--dsw-radius-panel` | 28 |

- 不写 10/14/18/24px 等中间值；嵌套同心圆角 `内 = max(0, 外 − inset)`。
- 间距用 4 的倍数：行内 8/12，行间 0/14（分隔线），分区 24/32，页面上下 32。

## 6. 颜色与排版

### 6.1 可覆盖 alias（14 个）

`--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1`、`--dsw-alias-bg-layer-2`、`--dsw-alias-bg-overlay`、`--dsw-alias-border-l1`、`--dsw-alias-border-l2`、`--dsw-alias-brand-primary`、`--dsw-alias-label-primary`、`--dsw-alias-label-secondary`、`--dsw-alias-state-error-primary`、`--dsw-alias-state-idle-primary`、`--dsw-alias-state-success-primary`、`--dsw-alias-state-warn-primary`、`--dsw-specific-sidebar-fill`。

- 浅色/深色各给一组；不在组件里写死 hex。
- 正文主色 `label-primary`，说明/次要信息 `label-secondary`；描边用 `border-l1/l2`；状态只用于状态。
- 焦点环用宿主 focus token，不自定义高亮色。
- 注意：`--dsw-radius-*` 与 `--dsw-alias-settings-card-fill/stroke` 存在于 DSH 样式表，但**不在 `Theme.listTokens` 契约内**；使用时必须带规范值回退（见 `docs/audit/ui-config-0-token-evidence.md`）。

### 6.2 排版

| 元素 | 字号/字重 |
| --- | --- |
| 页面标题 | 16–18px / 600 |
| 分区标题（h2） | 14px / 500 |
| 行名称 | 13–14px / 500 |
| 帮助与描述 | 12px / 400，次级色 |
| 值文本 | 12–13px，等宽用于路径/ID |
| 徽标 | 11px / 500 |

- 中英文混排不换字体；行高 1.5；长路径/ID 中间省略，悬停或展开显示完整值。

## 7. 反模式

1. 用 iframe 或全屏覆盖层托管整套页面。
2. 自绘宿主顶栏、侧栏、窗口阴影或第二套品牌。
3. 用 raw hex、任意圆角、任意阴影替代 token。
4. 同一个配置项在两处可编辑，且两处写入语义不同。
5. 只在前端“保存成功”，没有 Host revision 校验。
6. 把密钥、完整本地路径、数据目录默认铺在摘要页。
7. 组件卸载后仍保留定时器、监听器或 DOM 节点。
8. 空数据页用假示例、假分数或 0 代替“读取失败”。
9. 所有字段堆成一张长表单，没有分区和生效标签。
10. 以“重启后生效”为借口，不在界面写清何时生效。

## 8. psyche 映射建议

现状：psyche 在 `main` slot 用一个整页承载“状态/记忆/情绪/QQ/用量/设置/提案/关系”等页签（`src/client/index.ts` 约 :5752–5804；布局方案 `docs/design/plugin-ui-layout-plan.md`，UI-1 已实现外壳与设置页）。

建议拆分为两层，避免“主页面里再做一个设置系统”：

- **插件配置页（`plugins.bundle.config`，`view: 'page'`）**：只放 Host 拥有的运行配置——数据目录、自动采集、注入开关、QQ 网关地址与准入名单摘要、情绪/关系功能开关、日志级别。字段与 Config schema 一一对应，保存走 `form.mutate`。
- **摘要（`view: 'summary'`）**：显示“数据库：正常 / 自动采集：开 / QQ：已连接 / 待处理提案：N”，最多一个“打开配置”。
- **插件主页面（`main`）**：只读数据与操作——概览、记忆、情绪与关系、QQ 通道（连接/诊断/日志）、用量、运维。原“设置”页签收缩为“运行配置摘要 + 打开配置”，不再重复可编辑控件。
- **会话内**：`conversation.chat.assistant-actions` / `turnTail` 保持轻量入口，不承载配置表单。

落地顺序建议：先做配置页的 schema 映射与保存链路（含 revision 冲突与失败回滚），再把主页面“设置”页签改为只读摘要，最后统一卡片/行样式与主题 token 回归；每一步单独验收，不与记忆/情绪功能改动混在一起。

## 9. 验收清单

- [ ] 配置项只在一处可编辑；主页面摘要与配置页值一致。
- [ ] 每个字段有名称、帮助、控件、生效标签。
- [ ] 保存成功以 Host 确认值为准；失败回滚且行内可见。
- [ ] revision 冲突有提示，不静默覆盖。
- [ ] 密钥不回显；路径默认不铺开。
- [ ] 只使用 token；无 raw hex、无自造圆角。
- [ ] 卸载/重载后无残留监听器、定时器、DOM。
- [ ] 900px 以下单列可读，控件不溢出。
- [ ] 键盘可达，焦点可见；状态不只靠颜色表达。
- [ ] 读取失败、空数据、未接入分别有明确文案，不用假数据。
