# P3-A B5 —— 跨模块集成验收（B5-0 契约冻结）

- 版本：v1.0（2026-11-12）
- 基线：DEV v27.63、Git `2a8cfe2`、schema v19 / 46 表、全量 3492 断言 / 114 步 / 0 失败
- 上游依据：`docs/design/p3-a-mood-state-machine.md`（B0）、`p3-a-b2-turn-judgment.md`、`p3-a-b3-tone-projection.md`、`p3-a-b4-mood-panel.md`
- 本阶段定位：**验收与隔离证明**，不新增 Mood 能力，不改 B1–B4 语义，不扩 P3-A 范围。

## 0. 一句话目标

证明 Mood 的引入只改变「语气」，不改变 Recall / Diary / Stance / Growth 的事实、记忆与治理结果；并证明它在真实宿主里与其它 Context、数据库、插件生命周期互不污染。

## 1. 判定原则

### 1.1 允许的变化（不算失败）

- Assistant 自然语言的措辞、节奏、语气词：Mood 注入 Prompt 的目的就是影响这一层。
- 因语气变化导致的「同一事实的不同说法」：只要事实、引用、数值、状态不变。

### 1.2 禁止的变化（必须逐项证明不变）

| 层 | 结构化结果 |
|---|---|
| Recall | 候选集合、排序、分数、证据引用、访问范围（scope/session 过滤） |
| Diary | 提取出的记录、生成的 Artifact、准入/拒绝结果、幂等键 |
| Stance | 立场数据、证据列表、承诺状态、冲突/复核状态 |
| Growth | 成长阶段、提案、准入结果、已接受/已拒绝记录 |
| 数据库 | 非 Mood 表的行集合与关键字段；Mood 只写 `global_mood_state` / `global_mood_history` / `mood_meta` |

### 1.3 比较方法（冻结）

1. **同一初始快照**：从同一份数据库副本出发（复制 `memory.sqlite3` 到临时目录），两条分支只在 `mood.enabled` 上不同。
2. **同一输入**：相同 sessionRef、相同消息 id、相同文本、相同顺序。
3. **固定时间**：所有可传 `now` 的调用传同一个固定 UTC 时间；无法传 `now` 的路径记录调用时刻并只比较与时间无关的结构（集合、顺序、键、状态枚举）。
4. **结构化比较**：比较表行集合（按主键排序）、返回对象的稳定字段；自由文本只记录、不参与 diff。
5. **双跑顺序**：先 `mood=off` 跑一遍，再 `mood=on` 跑一遍（或反过来），两次各自使用**独立的库副本**，避免相互影响。
6. **差异归因**：任何 diff 必须能归因到「Mood 表」或「已声明的语气层」；不能归因的 diff 记为失败。

## 2. B5-1 模块隔离回归

### 2.1 输入剧本（固定）

1. 写入 2 个联系人与 1 个会话；
2. 写入 3 条 Source（其中 1 条含明确偏好、1 条含承诺、1 条普通闲聊）；
3. 调 `remember` 形成 1 条 fact Artifact + 1 条 commitment 事件；
4. 调 `recall` 查询 3 个不同关键词；
5. 触发一次 Diary 提取；
6. 触发一次 Stance 评估；
7. 触发一次 Growth 检查。

### 2.2 比较项

- 表级：`sources`、`artifacts`、`events`、`fts_index`/`fts_rowids`、`recall_runs`、`diary_*`、`stance_*`、`growth_*` 的行数与主键集合（按表定义排序）。
- 返回级：`Core.recall()` 的候选 id 序列与分数（两位小数）、`Core.remember()` 的 Artifact id 与状态、`Diary`/`Stance`/`Growth` 服务返回的稳定字段。
- 不比较：`messages` 之外的自由文本、时间戳里的毫秒级抖动（统一截断到秒）。

### 2.3 通过条件

所有比较项逐项相等；差异只允许出现在 Mood 三表与自然语言文本。

## 3. B5-2 数据库隔离与只读

### 3.1 Mood 写入边界

- `applyMood` 事务只写：33 行 `global_mood_state`、33 行 `global_mood_history`、1 行 `mood_meta`。
- 允许的连带：`persona_config` 的初始化行（仅在首次 `ensureMoodInitialized`）。
- 禁止：`sources`/`artifacts`/`events`/`fts_*`/`recall_runs`/`diary_*`/`stance_*`/`growth_*`/`contact_affect_*` 的任何写入。

### 3.2 只读证明

- `GET /api/psyche/mood` 前后：全部表行数与 `mood_meta.state_version` 不变；`last_seen` 不变。
- `loadMood()` + `projectMoodTone()` 前后：同上。
- `Prompt Assembly`（含 Context 渲染）前后：同上。

### 3.3 开关切换

- `mood.enabled=false`：不写 Mood、不注册 Context；已有 Mood 数据、其他模块数据保留。
- 重新开启：按原 `updated_at` 衰减，不重置 baseline，不补写关闭期间的历史。
- 开关切换不改变 Recall/Diary/Stance/Growth 的任何行。

## 4. B5-3 跨插件 Context 隔离

范围从 B3 的单个 Sentinel 扩大到**本机实际安装且注册 Context 的插件**（先探测清单，至少包含 `test-context-sentinel` 与 1 个真实插件 Context；没有第二个真实 Context 时如实记录「样本=1」）。

| 场景 | 预期 |
|---|---|
| 多个 Context 同时注册 | 全部出现在 assembly，内容互不覆盖 |
| 顺序变化（order 调换） | 只影响排序，不改变各自内容 |
| 卸载 Mood 插件 | 只移除 `psyche-mood-tone`，其它 Context 保留 |
| 卸载其它插件 | Mood Context 保留，其它正常移除 |
| Mood 读取失败 | 其它 Context 正常注入，Mood 降级「平稳」 |
| 重载/重启 | 各自恢复，不重复注册 |

## 5. B5-4 真实宿主端到端

### 5.1 完整链路

`真实 User 消息 → Recall/Diary/Stance/Growth 照常运行 → B2 判定与持久化 → Prompt Assembly（多 Context 共存）→ Assistant 响应`

验收点：

- 响应语气可变化；
- 响应引用的记忆/事实必须能在 Recall 结果中找到；
- 同一轮的 Mood 写入只有一次；
- 下一轮 Assembly 读取到更新后的 Mood。

### 5.2 故障场景

| 场景 | 预期 |
|---|---|
| DB 不可用 | 对话继续，Mood 降级「平稳」，其它模块按既有降级逻辑 |
| Mood 插件卸载 | 无 Mood Context、无 Mood 写入，其它模块照常 |
| 重载 | 恢复且不重复注册，数据不重置 |
| 重启 | 从 SQLite 恢复，衰减正确 |
| 开关切换 | 行为如 §3.3 |

## 6. 证据与判定

- 每次执行记录：commit、DEV 版本、schema 版本、输入剧本摘要、固定 now、库副本路径、比较结果。
- 判定：B5-1/2/3/4 全部通过 → B5 PASS；任一关键项未验证 → PARTIAL，并写明未验证原因。
- 遗留问题单独列出，不阻塞已通过项。

## 7. 不做

- 不改 B1/B2/B3/B4 的语义与实现（除非验收发现真实污染，且先补测试再改）。
- 不新增 Mood 功能、不新增表、不改 schema v19。
- 不接 Contact Affect / Affinity / Trust，不做主动联系，不做自动蒸馏。
- 不扩 P3-A 之外的面板能力。
