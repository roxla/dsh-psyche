# P4-B-4-0：QQ 私聊离线回复队列设计冻结

- 日期：2026-11-14
- 状态：**CONDITIONAL PASS（2026-11-14 评审）→ 已按评审补齐实施契约 → B-4-1 已批准开工**；B-4-2 真实 QQ 接线尚未批准。
- 基线：`cf74ea9`（B-4-0 初稿）、DEV v28.05、Schema v23 / 57 表 / 34 触发器、5121 断言 / 154 套 / 155 步 / 0 失败。
- 下游：`qq_reply_outbox` 的 Schema v24、Core 状态机与 Mock（B-4-1）；真实 QQ Bridge 接线（B-4-2）需先满足 §9 的前置条件。
- 上游结论：P4-B-3-3 = PARTIAL（H05 窗口恢复、H10b 热卸载未验）；真实 OneBot = NOT VERIFIED；群回复 = DISABLED。
- 关联：`proactive_outbox`（Schema v21）只服务 Owner 审批的主动消息，本设计不改变其语义；B-5 诊断只读，不承载正文。

## 1. 业务范围与入队前提

### 1.1 只接管「已生成、已授权、尚未确认被 OneBot 接受」的私聊回复

入队对象必须同时满足：

1. 会话来自 QQ 私聊（`qq-private-<userId>`），且当前 Contact 与 `allowFrom` 准入成立；
2. 该轮助手回复已经由模型生成并定稿（`assistant/message` 的文本已确定），不需要再调用模型；
3. 目标为单个 QQ 私聊 Contact，目标 Transport 为 `qq-onebot`；
4. 回复文本非空，引用 ID（如有）来自本会话已绑定的入站消息；
5. 联系人策略允许发送（`enabled` 未关闭、配置未整份失败、当前不在静默窗口）；
6. 尚未得到 OneBot「已接受」回执；
7. 具备可信、跨重放稳定的 Host 源事件标识（`session_seq`）；缺失或非法时 **拒绝入队**，不得用内存递增序号、当前时间或随机数代替。

`session_seq` 只能来自 Host 事件（例如 `session/event` 的稳定事件序号）。B-4-1 先以 Mock 输入验证；若真实 Host 不提供该标识，B-4-2 接入前必须先解决，不能用不稳定 ID 让幂等测试表面通过。

### 1.2 明确不属于 B-4

- **离线收消息**：Bridge 断开期间没有收到的用户消息，属于平台入站补拉/历史同步，不是发送队列。
- **模型失败后的重新生成**：模型执行失败、超时、被取消都不是「待发送回复」；恢复时不得重新调用模型生成另一条回答。
- **主动消息**：Owner 审批的主动联系继续走 `proactive_outbox`，不复用其授权字段。
- **群聊**：群回复保持 DISABLED，群调度另有 D-2 链路，不进入本队列。
- **跨平台降级**：QQ 不可用时不得改投 Telegram 或其他 Transport。

### 1.3 队列只保存「确定内容」

入队时冻结最终文本、引用消息 ID、目标 Contact、Transport 和源事件标识。恢复/重试只重发这份字节内容，不重新渲染、不重新检索、不重新生成。

## 2. 与 `proactive_outbox` 的复用边界

### 2.1 结论：独立业务表，复用可靠性模式

- 新建独立表 `qq_reply_outbox`；不复用 `proactive_outbox` 的行、审批字段或 Consent 语义。
- 可以复用/借鉴的底层模式：`BEGIN IMMEDIATE` 逐条领取、状态迁移守卫、`dispatch_started_at`、重启 `dispatching → unknown`、退避与过期扫描、四态结果映射。
- **不建第二套服务进程**：队列 Worker 仍由插件进程内的显式生命周期管理，与现有 OutboxWorker 一样不随宿主隐式启动；是否抽取共享底层，等 B-4-1 代码审计后决定，不为复用重构已验收的 `proactive_outbox`。

### 2.2 授权基础不同

| 项目 | `proactive_outbox` | `qq_reply_outbox` |
| --- | --- | --- |
| 发起者 | 心灵主动 | 用户先发起，心灵回复 |
| 授权来源 | Owner 审批快照 + Draft Revision + Consent | 入站准入（allowFrom）+ 联系人策略 + 发送前复核 |
| 内容来源 | 已审批草稿 | 已生成的助手回复 |
| 失败重发 | 仅确定未接受；unknown 人工核验 | 同左 |
| 群/跨平台 | 禁止跨平台 | 禁止跨平台、禁止群 |

不得把普通私聊回复写成「Owner 已审批」的主动消息，也不得让本队列成为新的隐式发送权限入口。

## 3. 状态机与崩溃窗口

### 3.1 七态

`pending`、`dispatching`、`sent`、`failed`、`unknown`、`expired`、`cancelled`。

- `sent` 仅表示 **OneBot 已接受请求**，不代表 QQ 用户已收到或已读。
- `failed` 为终态；重发必须由新的模型回复/新流程重新入队，不复用本行。
- `unknown` 为不确定态，**禁止自动重发**，只能人工核验或过期。

### 3.2 合法转换

| 起点 | 终点 | 触发 |
| --- | --- | --- |
| — | `pending` | 入队（幂等） |
| `pending` | `dispatching` | Worker 原子领取，`attempts+1` |
| `dispatching` | `sent` | OneBot 明确接受，记录 `receipt`/`sent_at` |
| `dispatching` | `pending` | 明确可重试（429 且 `retry_at < expires_at`） |
| `dispatching` | `failed` | 明确拒绝且不可恢复 |
| `dispatching` | `unknown` | 超时、断连发生于发送中、ACK 丢失、异常 |
| `pending` | `expired` | TTL 到期 |
| `pending` | `cancelled` | 发送前复核失败（Contact/准入/策略/Transport 绑定失效） |
| `dispatching` | `unknown` | 进程重启恢复（`worker_restart`） |
| `unknown` | `sent` / `failed` | Owner 核验；`failed` 后不得自动重发 |
| `unknown` | `expired` | `expires_at <= now` 仍未核验：`unknown_unresolved_expired`；解除同 Contact 阻塞，不自动重发，不宣称送达或未送达 |

`unknown → expired` 必须保留「到期时发送结果仍不确定」的事实：不允许把该行标成 `failed`（装作未送达），也不允许标成 `sent`（装作已送达）。它只解除本地 FIFO 阻塞并释放容量。

### 3.3 崩溃窗口

| 窗口 | 结果 | 规则 |
| --- | --- | --- |
| 生成后、入队前崩溃 | 回复丢失 | 入队必须在调用发送前同步完成；这是可接受的丢失窗口，不假装可恢复 |
| 入队后、领取前 | `pending` | 重启后继续 |
| 领取后、发送前 | 重启 → `unknown` | 可能从未发出，但无法证明，禁止自动重发 |
| 发送调用中崩溃/超时 | `unknown` | 可能已送达，禁止自动重发 |
| 已接受、标记 `sent` 前崩溃 | `unknown` | 以 OneBot 回执为准，人工核验 |
| 标记 `sent` 后崩溃 | `sent` | 终态 |

**顺序保证的范围**：本队列只保证「本地发起发送的顺序」。`unknown` 行在过期后解除阻塞时，它对应的原先未知发送仍可能已被平台接受并迟到展示；因此不能宣称 QQ 平台最终展示顺序严格一致。若业务要求平台最终顺序严格，只能永久等待人工裁决，不采用到期解锁。本设计选择**有限等待**。

## 4. Schema v24 草案

### 4.1 `qq_reply_outbox`

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| `reply_id` | TEXT PK | `qr_` + `sha256(persona_id + contact_id + session_id + session_seq)` 前 24 hex |
| `persona_id` | TEXT NOT NULL | 单人格 `main`，保留分人格能力 |
| `contact_id` | TEXT NOT NULL REFERENCES contacts(contact_id) ON DELETE CASCADE | 删除联系人即清理正文 |
| `platform` | TEXT NOT NULL CHECK (`platform`='qq') | 仅 QQ |
| `stable_user_id` | TEXT NOT NULL | 发送时再核对 |
| `session_id` | TEXT NOT NULL | `qq-private-*` |
| `session_seq` | INTEGER NOT NULL | Host `assistant/message` 的稳定事件序号；缺失/非法拒绝入队 |
| `turn` / `step` | INTEGER | 可空；用于诊断，不参与幂等 |
| `transport_id` | TEXT NOT NULL | 必须为 `qq-onebot` |
| `target_kind` | TEXT NOT NULL CHECK (`target_kind`='private') | 本表不接群 |
| `payload_text` | TEXT NOT NULL | 定稿正文；**只存本表** |
| `text_hash` | TEXT NOT NULL | sha256 前 32 hex；发送前复核 |
| `quote_message_id` | TEXT | 可空；必须属于同一会话 |
| `status` | TEXT NOT NULL CHECK 七态 | — |
| `attempts` | INTEGER NOT NULL DEFAULT 0 | 重试计数 |
| `last_error_code` | TEXT | 稳定原因码，不含正文 |
| `receipt` | TEXT | OneBot 回执 id（脱敏/不落日志原文） |
| `created_at` / `expires_at` / `retry_at` / `dispatch_started_at` / `sent_at` / `terminal_at` / `updated_at` | TEXT/INTEGER | `terminal_at` 在首次进入 `sent`/`failed`/`cancelled`/`expired` 时写入，之后不可变；清理按它起算，不用会变化的 `updated_at` |

约束与索引：

- `UNIQUE(persona_id, contact_id, session_id, session_seq)`：同一源事件只入队一次；重复入队返回原行，不入第二行。
- `idx_qq_reply_outbox_due(status, retry_at)`、`idx_qq_reply_outbox_expiry(expires_at)`、`idx_qq_reply_outbox_contact(contact_id, status, created_at)`、`idx_qq_reply_outbox_session(session_id)`。
- `BEFORE UPDATE OF` 触发器保护 `persona_id/contact_id/platform/stable_user_id/session_id/session_seq/transport_id/target_kind/payload_text/text_hash/quote_message_id/reply_id` 不可变；状态与计数可更新。`terminal_at` 另用触发器约束为「只允许 NULL → 非 NULL 一次」，不允许改写。
- `terminal_at` 在首次进入终态时写入；终态清理只按 `terminal_at` 计算，不按查询/扫描时间或 `updated_at`。
- 不建正文全文索引；不做 FTS/召回。

### 4.2 迁移预检（v23 → v24）

- 仅新增表、索引、触发器，不回填、不改旧表；`EXPECTED_TABLE_COUNT` 57 → 58。
- 升级前 `PRAGMA user_version = 23` 校验；在单个事务内执行；失败整版回滚。
- 升级前复制数据库副本做迁移审计：核心事实表行数与 SHA-256 前后一致，`PRAGMA integrity_check = ok`。
- 禁止降级；v24 库被 v23 插件打开时必须拒绝并提示升级插件。
- 备份包含本表正文；恢复后仍只在本机使用，不因备份绕过 Host 鉴权。

### 4.3 容量、TTL 与清理

- TTL 默认 **30 分钟**（可配 5–1440 分钟）；`expires_at = created_at + ttl`；到期后不再发送，重试/重启不续期。
- 活跃容量（`pending + dispatching + unknown`）全局 **500**、单 Contact **100**；满时拒绝新入队并告警，**不淘汰旧行、不静默丢弃**。容量判断与入队必须在同一 `BEGIN IMMEDIATE` 内完成，双进程不能突破上限。
- `unknown` 在 `expires_at <= now` 且未核验时转 `expired`（`unknown_unresolved_expired`），解除同 Contact 阻塞并释放容量；不自动重发，不宣称送达/未送达。
- **活动库清理**：终态（`sent`/`failed`/`cancelled`/`expired`）在 `terminal_at + 24h` 后删除行与正文；允许定期任务执行，不承诺精确到秒。
- **历史副本**：WAL、备份包、归档、旧库副本中的正文按独立的备份保留/清理规则管理；活动库清理**不保证**同步清除这些副本中的字节。不得宣称「24 小时后所有副本均无正文」。
- 清理任务先执行到期状态转换（尤其 `unknown → expired`），再删终态行；`unknown` 未到期/未核验时不得被误删。
- `sent` 不代表用户已读；页面/日志文案不得写成「已送达用户」。

### 4.4 隐私

- 正文只存 `qq_reply_outbox.payload_text`，不复制进 Source/Event/诊断事件/普通日志。
- 日志只记录 `reply_id`、`contactRef`（脱敏）、状态、错误码、attempts、时间。
- 不新增匿名可读接口；若后续提供只读管理视图，必须有 Host 可信鉴权，否则失败关闭。
- 备份、导出、迁移包包含本表正文时，按独立的历史副本保留规则处理；活动库的 24 小时清理不承诺清除备份内字节。
- 只读诊断只给计数、状态与哈希前缀；不提供正文读取。

## 5. 发送前授权复核与联系人级顺序

### 5.1 复核时点

- **入队时**：校验基础字段、`session_seq` 与幂等；不因当前连接断开而拒绝。
- **领取时（`BEGIN IMMEDIATE` 内）**：重新读取 Contact、allowFrom、联系人策略、Transport 绑定与代际；不满足则 `cancelled`，不进入发送。
- **发送调用前（即时检查，不在同一个数据库事务内）**：再次读取配置代际、连接代际、目标与 `payload_text` 哈希；若与领取时不一致，放弃本次发送并按当前状态处理（取消或保持 pending），**不声称这是单个原子操作**。
- 网络调用不在事务内；回执单独事务落库。
- 领取事务提交后配置仍可能变化，因此必须保留发送前的即时检查；两者共同降低竞态，但不构成跨数据库/网络的原子性保证。

### 5.2 复核项

| 项 | 失败处理 |
| --- | --- |
| Contact 存在且 `platform/stable_user_id` 一致 | `cancelled` |
| `allowFrom` 当前仍允许（Owner/extra） | `cancelled` |
| 联系人策略未整份失败、该联系人未 `enabled:false` | `cancelled` |
| 当前处于该联系人静默窗口 | `cancelled`（不延期发送，避免静默期后突然收到旧回复） |
| `maxPerHour` | **不二次消耗**：入站准入时已计；队列发送不重复计数。策略被调低只影响新入站 |
| Transport id/platform 匹配 | `cancelled` |
| `payload_text` 哈希一致 | `cancelled`（内容被意外改写） |
| 引用 ID 仍属于本会话且绑定 | 退化为纯文本发送（与 B-2 语义一致），不取消 |

### 5.3 顺序

- 同一 Contact 严格 FIFO（`created_at, reply_id`），同一时刻最多一条 `dispatching`。
- 头部为 `pending`（含等待 `retry_at`）时，后续同 Contact 回复等待，不越过。
- 头部为 `unknown` 时，后续同 Contact 回复**阻塞**，直到 Owner 核验或该行到 `expires_at` 转 `expired`；到期解锁只解除本地排队，不保证平台最终展示顺序。
- 头部为 `failed`/`expired`/`cancelled`/`sent` 时，队列前进。
- 不同 Contact 相互独立，可并行（建议全局并发上限 4，与现有模式一致）。

## 6. 重试、unknown 人工裁决、TTL 与容量

### 6.1 自动重试

- 仅对**明确未接受且明确可恢复**的结果重试：`retryable` + `retryAfterMs`（当前 QQ Transport 仅 429 会给出）。
- 最大 `attempts = 3`；退避 `max(30s, retryAfterMs)`，翻倍，封顶 10 分钟；`retry_at` 不得 ≥ `expires_at`，否则 `expired`。
- 连接未建立（未调用发送）→ 保持 `pending`，等连接恢复后领取；不算 attempt 失败。
- 明确拒绝（permanent）→ `failed`；超时/断连发生于发送中/异常/ACK 丢失 → `unknown`。

### 6.2 unknown 人工裁决

- **绝不自动重发**，也不把 `unknown` 自动降级为 `pending`。
- 裁决入口只在 Owner 本机可信上下文（本地 CLI 或等价机制），不新增匿名 HTTP 写接口；输入 `reply_id` + `received|not-received`。
- `received → sent`（补记回执或标记人工确认）；`not-received → failed`，若要再发必须由新的回复生成/新入队，不能复用旧行。
- 未核验的 `unknown` 到 `expires_at` 后自动转 `expired`（`unknown_unresolved_expired`），保留「结果不确定」语义；不触发重发。
- 裁决结果写审计事件，不写正文；同一行并发裁决只能有一次有效状态改变，审计不得重复。

### 6.3 TTL 与容量

- TTL 从 `created_at` 起算，不随重试/重启重置。
- 过期扫描在领取事务内先执行：`pending` 超期 → `expired`；`unknown` 超期且未核验 → `expired`（`unknown_unresolved_expired`）；`dispatching` 超期仍按重启规则 → `unknown`，不做超时自动发送。
- 容量满拒绝新入队并返回稳定错误码 `E_REPLY_OUTBOX_FULL`；通知/日志不包含正文。

## 7. 验收矩阵

### 7.1 模块级（B-4-1，Mock Transport）

| 组 | 覆盖 |
| --- | --- |
| S 状态机 | 七态合法/非法转换、终态不可复活、`sent` 语义 |
| I 幂等 | 同 `(persona,contact,session,seq)` 重复入队只一行；不同 seq 各自入队 |
| C 崩溃 | `dispatching` 重启 → `unknown`；接受后未标记 → `unknown`；入队前丢失窗口 |
| R 重试 | 429 退避、attempts 上限、`retry_at ≥ expires` → `expired`；连接断开保持 pending |
| A 授权 | allowFrom 撤销、Contact 删除、策略 disabled/blocked/silence、transport 不匹配 → cancelled；哈希不一致 → cancelled |
| O 顺序 | 同 Contact FIFO、unknown 阻塞后续、不同 Contact 并行、并发领取唯一 |
| T 容量/TTL | 500/100 上限拒绝、TTL 过期、终态清理保留期 |
| P 隐私 | 日志/诊断无正文；只读接口只计数与脱敏引用；备份含正文但不新增匿名读取 |

B-4-1 必须额外覆盖的断言（评审补充）：

1. `unknown` 到期转 `expired` 可解除同 Contact 阻塞，但发送结果仍标为未确认，不触发重发。
2. `terminal_at` 在后续查询/清理扫描/重试中不变。
3. 同一 Contact 的 `unknown` 阻塞后续消息，不同 Contact 继续工作。
4. 容量判断与入队处于同一 `BEGIN IMMEDIATE`，双进程不能突破 500/100。
5. `session_seq` 缺失或非法时拒绝入队，不生成临时幂等 ID。
6. 领取后、发送前发生授权撤销/代际变化时，旧任务不能绕过检查（B-4-1 用 Mock 代际验证）。
7. 429 超过三次尝试或下一次重试时间越过 TTL，进入明确终态。
8. 终态清理不误删仍处于 `unknown` 的记录；先完成到期状态转换。
9. Owner 裁决并发执行时只有一次状态改变有效，审计记录不重复。
10. 迁移前后旧事实表逐行一致；v23 版本不得打开 v24 数据库。

### 7.2 隔离 Host（B-4-3）

- 断线前入队、断线中保持、重连后按序发送。
- 发送中杀 Bridge → `unknown`；重启插件 → 不重发。
- 队列等待期间撤销 `qq.contacts[A].enabled` → 取消而非恢复后补发。
- 同 Contact 连发、unknown 阻塞、quote 降级。
- 热卸载/重载、队列容量满、TTL 过期。
- 群消息、主动 Outbox、B-5 诊断不受影响。

### 7.3 真实 OneBot（B-4-4）

- 真实后端发送、引用、ACK 回执与 429 行为单独验收；不复用 Mock 结论。
- 若后端不提供可区分的 accepted/permanent，记录 `unknown` 行为与人工核验流程。

## 8. 评审结论与实施边界

### 8.1 六项决策（2026-11-14 评审）

| 决策 | 结论 |
| --- | --- |
| TTL 默认 30 分钟、5–1440 | 批准；从 `created_at` 起算，重试/重启不续期 |
| 容量 500 / 单 Contact 100 | 批准；`pending + dispatching + unknown`，事务内判断 |
| 静默命中取消 | 批准；`pending → cancelled`，不延期、不自动恢复 |
| `unknown` 阻塞同 Contact | 有条件批准；必须补 `unknown → expired` 与不确定语义（§3.2/§6.2） |
| Owner 本机 CLI 裁决 | 批准；无匿名 HTTP 写入口，必须有可信 Owner 身份 |
| 终态正文 24 小时清理 | 有条件批准；活动库与历史备份分开定义（§4.3） |

### 8.2 B-4-1 允许范围

- Schema v24 新表与迁移、`qq_reply_outbox` 存储模块、七态状态机与过期处理、领取/幂等/容量/TTL/FIFO、Mock Transport 故障注入、Owner CLI 裁决的 Core 接口。
- **不允许**：QQ Bridge 实际接线（B-4-2）、Worker 随插件启动、改写 `proactive_outbox`、群回复/主动联系/Host 鉴权。

## 9. B-4-2 接入前置条件

1. **业务层严格结果归类**：发送前未连接 → 保持 `pending`；明确 429/可恢复 → 重试；发送中无法证明是否已接受 → `unknown`。不得修改现有普通回复或主动 Outbox 的结果语义来适配 B-4；先在 B-4-1 Mock 冻结映射，B-4-2 再检查实际 Transport。
2. **无 echo 回执的关联约束**：只有后端能可靠用 echo 关联 ACK 时，才允许跨 Contact 并发；无法可靠关联的后端使用共享单在途发送（全局同时最多一条），否则不得把无关联回执判为 accepted，进入保守 `unknown`；`unknown` 不因迟到的无关联回执自动改 `sent`。全局并发 4 只是上限。
3. **幂等源标识实测**：`session_seq` 必须来自可信、跨重放稳定的 Host 事件标识；B-4-2 接入前验证真实 Host 是否提供，缺失则先解决。
4. **替代发送分支**：普通私聊回复必须先在可靠入队后才进入发送；接入时替换原有直接发送分支，不允许新旧路径并行发送同一条回复。

## 10. 非阻塞后续

- 补一条入口接线回归断言：`src/index.ts` 创建 `QqBridge` 时必须传入 `contacts`（B-3-3 宿主缺陷防回归）。
- B-3-3 的 H05（真实时间跨度窗口恢复）与 H10b（同进程热卸载）继续挂在 B-3 验收清单，不因 B-4 推进而删除。
