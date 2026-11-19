# P4-D QQ 群聊参与机制（D-0 设计冻结）

> 状态：**D-0 冻结，D-2-0 精化修订（2026-11-14）**。依据用户 m13139 的拍板：借鉴 dsh-qq 的消息调度、未读水位与合并窗口；不引入二代仿真；第一版只做确定性触发、消息合并、静默与单飞。
> D-0 当时只冻结设计，不改代码/Schema。后续 **D-1 已实现**（`5fe73ea`，DEV v27.93，Schema v22/49表/16触发器，4396/141/0），只采集、无群 Agent/回复；见 `p4-d-1-storage-intake.md` 与对应审计报告。**D-2-0 契约已冻结**，详见 [调度、水位与输入证明契约](p4-d-2-scheduling-freeze.md)（DEV v27.94）；本轮只改文档，D-2-1..4/D-3 尚未实现。
> 基线：DEV v27.86 / head `d339acb` / Schema v20 / 3997 断言 / 130 步 / 0 失败。
> 原 D-0 顺序已推进至 D-1；当前下一步 **D-2-1**，以 D-2-0 契约为实现依据。P4-D 不得早于 C-3b；群聊主动开口不属于本阶段，现有 P3-C/Outbox 仍拒绝 group。

## 0. 目标与非目标

**目标**：让 Psyche 在 QQ 群里做到「被明确叫到时可靠回应」，而不是成为全天候自主群友。

**非目标（第一版明确不做）**：

- 概率唤醒、随机发言、自主 poke、定时开话题；
- AI 自主设置下一次唤醒、无限潜水、自行切换活跃/静默；
- 独立仿真人格卡、人格替换、拟人化分条节奏；
- AI 直接调用平台发送工具决定是否发言；
- 冷场主动开口（若将来要做，必须走 P3-C 的 Room 级授权 → 候选 → Owner 审批 → Outbox，不能用一个概率参数绕过）；
- 群聊自动写入长期记忆（仍按 P3/Remember 的显式路径）。

## 1. 原 D-0 的 Schema v20 现状审计

已有结构可直接复用，**不需要为 Room 身份新建表**：

| 结构 | 关键字段 | 用途 |
|---|---|---|
| `rooms` | `room_id` PK、`persona_id`、`platform`、`channel`、`external_room_id`、`title`、`capture_mode`、`active` | 内部 Room 标识与采集策略 |
| `room_members` | `(room_id, contact_id)` PK、`first_seen_at`、`last_seen_at` | 只记「谁在这个群出现过」，不作身份合并 |
| `sources` | `source_id`、`platform`、`channel`、`room_id`、`session_ref`、`sender_contact_id`、`message_id`、`reply_to_message_id`、`mentions`、`quoted_source_refs`、`origin`、`kind`、`text` | 原始消息证据 |
| `events` | `event_id`、`kind`、`type`、`room_id`、`subject_refs`、`text`、`caused_by` | 事件记录 |
| `event_sources` | `(event_id, source_id)` | Source ↔ Event |

两条已冻结的规则继续有效：

1. **内部 `rooms.room_id` 与外部群号 `rooms.external_room_id` 不是一回事**。群事件先按 `(platform, channel='group', external_room_id)` 解析到内部 `room_id`；任何表都不得把外部群号当 `room_id` 写。
2. **R3.1 群聊 Scope 已实现**：`surface='group'` 时只允许该 Room 的域，发送者的 `contactId` 不会带出私聊记忆。P4-D 复用这套准入，不另做一套可见性。

D-1 才需要的 v22 增量（本文件不建表）：

- Room 内单调递增的**消息序号**（用于未读/已读水位）；
- 每 Room 的**读水位**与参与状态；
- `(platform, room_id, message_id)` 去重索引。

实现形式在 D-1 做一次迁移审计后二选一：给 `sources` 加 `room_seq` 列，或建 `room_message_seq` 映射表。**不得用 `captured_at` 排序代替序号**（同一秒多条会乱序）。

D-1 已选择映射表方案，v22 另加 room_participation_state；旧 Source 不改写。迁移预检、双驱动/回滚与实际副本升级结果见 D-1 报告。

## 2. Room 身份与授权

- **默认全拒**：`qq.groups.enabled=false` 时，所有群事件只计数并丢弃，**不建 Agent 会话、不写 Source/Event、不回复**（Fail-closed 静默，沿用 P4-A 的 `outOfScopeDrops` 语义）。
- 开启后只接受**显式白名单**内的 `external_room_id`；白名单外静默丢弃。
- Room 首次出现时创建 `rooms` 行（`channel='group'`、`platform='qq'`、`active=1`、`capture_mode` 取该群配置，默认 `mentioned_only`）；后续按 `(platform, external_room_id)` 复用。
- 发送者按 `platform+stable_user_id` 解析 Contact；解析失败仍记 Source（`sender_contact_id` 为空），但不升级任何权限。`room_members` 只 UPSERT 观察记录。
- 只接受 `post_type='message'`、`message_type='group'`、`sub_type` 为普通群消息；临时会话群、未知类型、缺 `group_id`/`user_id` 一律拒绝。
- 群聊**不得回退成私聊权限**：群内 `contactId` 只作来源归因；Recall/注入按 `surface='group'`。

## 3. 消息接入与去重

每条群消息按顺序：

1. 白名单与 Room 解析（失败即拒绝）；
2. 在同一事务中按持久化 `(platform, room_id, message_id)` 去重并分配 Room 内序号；
3. **用户确认的 D-1 修订**：mentioned_only 只为被明确叫到的消息保存 Source 正文及 Event；其他白名单群消息只保存最小去重/序号记录，source_id/event_id 为空，不把正文转存到其他持久化缓冲。all_visible_messages 才保存全部已准入消息；
4. 保留的 Source 必须带 `channel='group'`、内部 room_id、message_id、mentions/reply 引用，原子关联 Event；成员观察不授予私聊权限；
5. 未读调度在 D-2 接入；**不因去重或窗口已满删除已落库 Source**。D-1 不启动 Turn、不推进已读水位。

群聊 Capture 的默认边界：

- 不自动晋升 Artifact；不自动写 Diary/Relationship；
- `capture_mode` 只决定「保留哪些原始证据」，不能授予回复权限；唤醒与回复另过 D-2 的触发/调度/证明闸；
- 群消息永远带 `room_id`，禁止以 `room_id=null` 的 group Source 进入 Recall（视为 unknown 拒绝）。

## 4. 确定性触发

| 群消息情形 | 第一版行为 | 判定依据 |
|---|---|---|
| 明确 @ 机器人 | 触发 | OneBot `message` 段 `type='at'` 且 `qq=self_id`，不只匹配文本 |
| 引用/回复机器人自己的消息 | 触发 | 当前 reply.id 命中同账号、同 Room 的可信成功发送绑定，关联 self Source；仅有 origin=self/quoted_source_refs 不足以授权 |
| 明确点名机器人 | 触发 | 当前消息文本的**精确 token** 命中配置昵称；不使用 `text.includes(botName)` |
| 明确向机器人提问 | 触发 | 必须先满足 @/点名/引用，再叠加问句特征；不单独按问号触发 |
| 普通群友聊天 | 不唤醒 | — |
| 加入/退出/群公告 | 只记录事件 | 第一版不自动欢迎 |
| 冷场、长时间无人说话 | 不唤醒 | 不主动开口 |
| 私聊 | 仍走 P4-A 私聊流程 | 不受群聊策略影响 |

细节：

- 引用判定必须区分「当前消息」与「引用原文」，旧引用里的昵称/问句不能触发。
- 点名匹配按分词后的独立 token，中文名允许前后为标点/空白/消息段边界；不做模糊包含。
- 触发只看事件本身，不调用模型做「是否在叫我」的判断。
- D-2-0 精化：相邻 text 段先拼接，真实非 text 段才形成边界；名称按每群显式 names 配置，首次持久化前判定，重放不补采。触发开关只有 at/reply/name，问句只依附明确叫到，不另设 question 开关。

## 5. 合并窗口

第一版试验值（可由配置覆盖，不是宣称 dsh-qq 的实测值）：

| 参数 | 初值 |
|---|---|
| 安静合并窗口 `quietMs` | 2000 |
| 最大等待 `maxWaitMs` | 8000 |
| 单批最大消息 `maxMessages` | 20 |
| 单批最大文本 `maxChars` | 4000 |
| 同 Room 并行 Turn | 1 |
| 跨 Room 并行 | 允许（全局上限另设） |

算法：

1. 首个触发消息到达后开始计时；
2. 每来一条新消息重置安静计时；总时长到达 `maxWaitMs` 立即封批；
3. 封批时仅从已保留 Source 选最多 20 条 / 4000 Unicode 码点（含固定包装），整条展示；为一条能够完整容纳的合格触发预留预算，再按 seq 选上下文，输出按 seq 排序；
4. 超出上限的消息**保留未确认**，须依附尚未消费的触发或新的明确触发进入后续批次，不自行唤醒清积压 Turn；
5. 同一批内若包含未触发消息，允许作为上下文一起给模型，但它们本身不构成新的唤醒理由。

## 6. 静默时段

- 每 Room 独立配置，必须带**显式 IANA 时区**（如 `Asia/Shanghai`）；禁止用模型推测群成员当地时间，也禁止跟随宿主系统时区漂移。
- 两种模式：
  - `all`：静默时段内不唤醒任何群消息（默认）；
  - `direct-only`：静默时段内只允许 @、引用回复、明确点名触发；普通聊天不唤醒。
- 静默控制是否启动 Turn，并在发送前再次检查；跨入静默的既有 Turn 可按证据结算处理确认，但不得在 mode=all 时发出迟到回复。消息仍按 capture_mode 保存 Source 或最小记录，不扩大采集；静默结束不补发，须用户随后再次触发。
- 模型不能读取/修改静默配置，也不能自行把群从静默切到活跃。

## 7. 单飞与队列

- 同一 Room 同时最多 1 个活动批；锁覆盖提交、真实 Host Turn 完成/静止、证明落库和出站结算，不以 followup 返回或入口任务串行替代。Turn 进行中到达的触发进入该 Room 的待处理队列。
- 不同 Room 允许并行；全局并发上限（初值 4）由桥接控制。
- 待执行封批队列上限 50（不含最多 4 个活动批）；满载时**保留未确认正文及触发引用、增加 `queueOverflow` 计数并告警**，不静默丢弃、不无限创建封批行或内存任务。D-1 入库前入口队列另计。
- 队列按 Room 隔离，A 群积压不得阻塞 B 群。
- Turn 结束后按顺序处理下一批，不合并已封批的快照。

## 8. 未读与已读水位

- 每条群消息在接入时获得 Room 内单调序号；未读缓冲按序号排序。
- **D-2-0 修订**：`read_through_seq` / `readThroughSeq` 是连续处理确认水位，不表示所有位置的正文均被模型阅读。无正文的有效最小记录记 policy_omitted；保留正文只有完整 Adapter 输入证明、正常 completed Turn 和成功持久化后才记 model_processed；两类确认均可跨过，分别计数。
- 部分展示/截断/中断/证明缺失/损坏引用不得确认保留正文，水位停在连续缺口前；较新位置的成功确认单独保留。模型自报“已读”、last_seq、首尾展示范围都不能替代成员级证据。
- 崩溃/重启按批次及发送意图状态恢复；入站 message_id 仅防重复采集，不保证出站 exactly-once。已提交 Host 的未知批次不自动再 followup；发送 unknown 不自动重发，已确认水位不回退。
- 重连后只恢复仍可执行且重新过闸的未提交任务；不按水位差自动重发或声称“未确认可重放一次”。实际展示集合、批次完成与发送结果分别留证，详见 D-2 契约 §3/5/9。
- 模型无工具可直接修改水位。

## 9. D-2 目标配置（当前运行版只支持 D-1 采集字段）

```jsonc
{
  "qq": {
    "groups": {
      "enabled": false,
      "allowed": [
        {
          "externalRoomId": "123456789",
          "captureMode": "mentioned_only",
          "names": ["心灵"],
          "triggers": { "at": true, "reply": true, "name": true },
          "reply": { "enabled": false },
          "merge": { "quietMs": 2000, "maxWaitMs": 8000, "maxMessages": 20, "maxChars": 4000 },
          "silence": { "mode": "all", "timezone": "Asia/Shanghai", "windows": ["23:00-08:00"] },
          "maxTurnsPerHour": 6
        }
      ]
    }
  }
}
```

约束：白名单条目任一字段非法 → 该条目整份失效（fail-closed），不部分生效；`timezone` 缺失或非法 → 拒绝启用该群。重复群号全项失效；完整默认值、边界和版本兼容见 D-2 契约 §2，不能把此目标配置误当当前 v27.93 已支持。

## 10. 安全不变量

1. 群聊每条知识都归属明确 `room_id`；禁止全局共享。
2. 模型不能控制群聊准入、参与调度、静默切换或主动发言。
3. 本阶段只开放被明确叫到后的普通群聊回复；主动群聊仍未设计/启用，现有 P3-C/Outbox 拒绝 group，不能绕过该限制。
4. 群聊不因发送者身份召回其私聊记忆（R3.1 已保证，D 不削弱）。
5. 未授权群、临时群、未知类型一律 Fail-closed 静默，零会话。
6. 去重、水位、队列都不得以「清理」为名删除已落库 Source。
7. 群聊回复只能走来源 Transport，不得跨平台降级。
8. 静默/限频/队列溢出都必须可观测（计数 + 日志），不能静默失效。

## 11. 故障与重连

- WS 断开：停止新 Turn，保留引用快照、水位和任务状态；重连后按批次状态重新过闸，不仅凭水位决定执行。
- 重连期间的消息若平台支持补拉则按 `message_id` 去重后入缓冲；不支持则记缺口指标，不假装已读。
- 发送失败：群回复均不自动重试，sent/failed/unknown 分开记录；发送后超时/断连/崩溃保守 unknown，不以新进程补发。平台无幂等保证时不宣称出站恰好一次。
- 插件卸载/重载：先使旧 epoch 无发送权，再取消/隔离旧 Agent 和 inbox；不能证实静止则阻止该 Room 新提交，不允许迟到回复。细则见 D-2 契约 §7–9。
- Room `active=0`：停止接入与唤醒，历史仍可查。

## 12. 观测

管理页/状态接口（后续阶段）：`connected`、`roomsActive`、`unreadByRoom`、`batchCreated`、`turnStarted`、`turnSkippedSilence`、`queueOverflow`、`dedupeDropped`、`deliveryFailed`、`readWatermarkLag`。日志不得包含群消息原文。

## 13. 实施拆分与测试矩阵

**D-1 存储与接入**（v22 迁移审计在此完成）：Room 解析/白名单/去重/Source+Event/未读序号/水位表；测试覆盖跨平台同名群、external≠internal、临时群拒绝、重复投递、capture_mode、Room 停用。

D-1 当前结论：模块级与真实隔离 Host/本地 OneBot 采集 PASS；采用序号映射表 + 水位表，只初始化零水位。D-2-0 已明确最小记录与处理确认、实际输入证明的关系，不能按 last_seq 直接清空未读。D-1 当前选择来源为真实 at 和同 Room 已有 self Source 的 reply；点名/调度尚未落代码。

**D-2 参与调度**：依 [D-2-0 契约](p4-d-2-scheduling-freeze.md) §11 顺序推进 D-2-1 触发/配置 → D-2-2 引用快照/输入证明/递增迁移 → D-2-3 状态机 → D-2-4 隔离 Host/本地 OneBot。测试分开证明处理水位、实际输入、Turn 完成和出站意图；不能用入站去重推导无重复群回复。

**D-3 真实宿主验收**：多群隔离、并发、限频、静默、断线重连、上下文隔离、零私聊泄漏；宿主级 PASS 才允许进入 P4-E。

判定：模块级与宿主级分开写；未取得宿主证据的项一律 PARTIAL，不得写成 PASS。

## 14. PASS / PARTIAL / NO-GO

- **PASS**：白名单群内被 @/引用/点名时可靠回应；消息合并、单飞、水位、静默、去重、故障恢复均有模块级 + 宿主级证据；跨群零串。
- **PARTIAL**：只完成模块级；或真实宿主缺多群/重连/队列证据。
- **NO-GO**：任何概率唤醒、模型自主控制参与、跨群共享、群聊泄私聊、静默失效或静默丢消息。
