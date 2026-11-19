# P4-A QQ 私聊准入与安全边界：详细设计冻结稿（v1）

- 日期：2026-11-12
- 状态：**已冻结（文档）**。本稿只冻结设计与验收契约，不写代码、不改 schema、不改现有 QQ 桥行为；实施从 P4-A-1 开始。
- 上游：`docs/design/p4-private-chat-and-multi-im.md`（方向稿）；本稿取代其中 P4-A 的 §3.1–3.5 细节，方向不变。
- 基线：`390df24` / DEV v27.69 / schema v19（46 表）/ 3511 断言 / 115 步 / 0 失败。
- v2 补充（2026-11-12）：限频数值定稿（单用户 24 小时、全局 20 条 / 滚动 60 分钟）；群聊、临时群聊、未知消息类型在本阶段 **Fail-closed 静默拒绝**；新增 `outOfScopeDrops` 计数与 T13；P4-A-1 实施范围包含群聊入口保护。

## 1. 目标与非目标

### 1.1 目标（按验收顺序）

1. 只有 `allowFrom` 命中的 QQ 私聊能进入 Agent；陌生人在 **Agent Session 创建之前** 被拒绝。
2. 拒绝路径不产生任何业务副作用：零会话、零 Prompt、零 Capture、零 Mood、零工具、零模型请求。
3. 拒绝可解释但不刷屏：固定文案 + 单用户冷却 + 全局限额，超限静默。
4. 授权变更只来自本地可信配置；QQ 消息、Prompt、工具都不能改授权。
5. 提供只读管理页：能回答「连没连上、授权了谁、拒了多少、错在哪」。
6. 不提前引入多 IM 抽象；`ChatTransport` 留到 P4-C。

### 1.2 非目标

- 不做 QQ 群聊准入（P4-D）；本阶段群聊路径不纳入验收，也不对外启用。
- 不做媒体、语音、文件（P4-B）。
- 不做发送、增删授权、启停进程、扫码登录等管理页写操作。
- 不做通用限流框架；限频是 QQ 桥内的轻量实现。
- 不因管理页统计新增持久化表；统计是运行时计数器。

## 2. 职责边界（Host / Bridge / Adapter / Agent）

| 层 | 代码 | 职责 | P4-A 是否改 |
|---|---|---|---|
| QQ 协议端 | SnowLuma（外部） | OneBot v11 WS，收发与账号态 | 否 |
| Host 通道包装 | `packages/qq`（adapterId `qq-snowluma`，platform `qq`，surfaces `private/group`） | 把 OneBot 事件转成 `ChannelIdentityClaim`；只声明身份 | 否 |
| 通道桥 | `src/lib/qq-bridge.ts` | WS 连接、自发过滤、去重、**准入闸**、拒绝限频、会话创建/恢复、投递、回执、重连、健康 | **是** |
| Agent 生命周期 | DSH Host `ctx.agents` | 创建/恢复 Session、执行轮次 | 否 |
| 业务层 | Psyche 插件 | Capture / Recall / Mood / Prompt / 面板 | 否（只读复用） |

关键点：P4-A 只改桥的入口判定，不新增 Host 能力，不让插件自注册平台，也不改 `RuntimeInputStore` 绑定。

## 3. Contact 身份与 Scope

- 身份 = `platform + stable_user_id`；platform 固定为 `qq`（与 `HostChannelRegistry` 声明的平台一致），`stableUserId` 是 QQ 号字符串。
- 禁止用昵称、备注、消息文本、`user_id` 之外的字段认定联系人；跨平台默认不合并。
- QQ 私聊映射 `private` surface，只读当前联系人的 private 数据；群聊（P4-D）单独定 Room 范围。
- 群临时会话（`private` + `sub_type=group`）沿用现有 `toIdentityClaim` 规则：不生成 Claim、不建会话。P4-A 不放开这条。

## 4. QQ 专属 allowFrom 配置契约

```ts
interface QqAllowFrom {
  owner: string        // 主授权 QQ，字符串
  extra: string[]      // 额外授权 QQ，字符串数组
}

interface QqConfig {
  // 新增
  allowFrom: QqAllowFrom
  unknownPolicy: 'reject'          // P4-A 只允许这一个值
  rejectCooldownMs: number         // 单用户拒绝冷却
  rejectGlobalLimit: number        // 全局窗口内拒绝回复上限
  rejectGlobalWindowMs: number     // 全局窗口长度
}
```

冻结规则：

1. QQ 号一律字符串，禁止转 Number；比较前只做 trim，不做其他归一化。
2. 空字符串、非数字、重复项、含 `*` 的配置都视为无效；**无效即全拒**，并在启动日志与只读管理页标出配置错误。
3. `owner` 为空且 `extra` 为空 = 不授权任何人（fail closed），不表示「全部允许」。
4. 不支持 `*`、正则、昵称匹配；不做前缀/后缀匹配。
5. 授权只从本地配置文件（profile 的 `cordis.patch.yml` / 插件配置）读取；QQ 消息、Prompt、工具、Web 面板的写接口都不能修改它。
6. 配置在桥启动时读入内存；运行中变更按「重启生效」处理（P4-A 不承诺热更新）。

注：数值已定稿（2026-11-12 补充决定）：`rejectCooldownMs` = **24 小时**（单用户 24 小时内最多回一次），`rejectGlobalLimit` = **20 条**，`rejectGlobalWindowMs` = **3600000**（滚动 60 分钟，不是自然小时）。计数只在内存，重启清零；管理页标注「本次进程启动以来」。单用户键为 `platform + stable_user_id`（QQ 即 QQ 号），不使用昵称；额度在发送前预留，避免并发超发；拒绝发送失败不重试。

## 5. 私聊准入流程与拒绝策略

### 5.1 执行顺序（冻结）

```
OneBot message 事件
  → 1. 事件合法性：post_type=message
  → 2. 自发消息过滤（self_id / sender 自己）
  → 3. 重复事件去重（message_id，TTL 10 分钟 / 上限 1000）
  → 4. 范围闸：message_type=private 且 sub_type 允许；群聊/临时群聊/未知类型 → 静默丢弃
  → 5. 身份 Claim（platform=qq, stableUserId=QQ 号；失败即丢弃）
  → 6. allowFrom 判定（owner / extra）
  → 7. 拒绝限频判定（单用户冷却 → 全局额度）
  → 8. 命中：进入 ensureAgent；未命中：固定拒绝 / 静默
```

落点（现有代码行号，实施时对照）：

| 步骤 | 现状 | P4-A 动作 |
|---|---|---|
| 2 自发过滤 | `qq-bridge.ts:397-400` | 不动 |
| 3 去重 | `qq-bridge.ts:410-415` + `#markSeen:430-444` | 不动；必须排在拒绝回复限频之前 |
| 4 范围闸 | `#handleMessage:446` 的 kind 判断 | 群聊/临时群聊/未知类型在此静默丢弃并计 `outOfScopeDrops`，不回复、不建会话 |
| 5 Claim | `qq-bridge.ts:452-460` | 不动 |
| 6 allowFrom | 无 | 在 `adapter.announce`（470）与 `ensureAgent`（481）**之前**插入 |
| 7 限频 | 无 | 桥内轻量计数器 |
| 8 投递 | `ensureAgent:498` → `waitBinding:485` → `followup:490` | 命中才执行 |

### 5.2 拒绝文案

固定：`当前暂不接受未授权的私聊消息。`

- 不调用模型、不拼接对方文本、不暴露 allowFrom 内容、不暴露 Agent/内部路径/配置。
- 限频内只回这一条；超限静默丢弃，不再回复。

### 5.3 群聊路径（本阶段 Fail-closed）

P4-A 只支持已授权的 QQ 好友私聊。群聊消息、临时群聊会话与无法识别的消息类型 **在 Agent 会话创建之前静默拒绝**：不创建 Agent Session、不触发 Prompt Assembly、Capture、Mood、工具调用及模型请求。**不发送**陌生人私聊的固定文案（避免机器人在群里主动回复），只增加 `outOfScopeDrops` 运行时计数和最小审计日志。

这不是提前实现 P4-D，而是阻止 P4-D 尚未验收的入口提前暴露；群聊能力仍留待 P4-D 单独设计、授权和验收。

## 6. 拒绝限频机制

两层，均为桥内内存实现：

| 层级 | 目的 | 行为 |
|---|---|---|
| 单用户冷却 | 同一个陌生人反复发消息时只回一次 | 冷却期内静默；冷却结束后的下一条可再回一次 |
| 全局额度 | 大量陌生人请求时保护发送队列 | 窗口内拒绝回复达到上限后，后续静默丢弃 |

冻结细节：

- 计数键只用 `stableUserId` 与全局计数，不保存消息正文、不落库。
- 计数器生命周期 = 进程生命周期；重启清零。管理页明确标注「本次进程启动以来」。
- 超过全局额度只停止**回复**，拒绝判定与审计计数继续（仍不建会话）。
- 限频不影响已授权用户；授权用户不进入拒绝路径。
- 具体数值（已定稿）：`rejectCooldownMs` = 24 小时（单用户 24 小时内最多回复一次）；`rejectGlobalLimit` = 20 条 / `rejectGlobalWindowMs` = 滚动 60 分钟；额度在发送动作执行前预留；拒绝消息发送失败不自动重试。
- 计数分四项：`rejected`（未授权私聊事件数）、`rejectReplies`（实际尝试发送的拒绝回复数）、`rateLimitedDrops`（限频静默丢弃数）、`rejectSendErrors`（拒绝回复发送失败数）；群聊/未知类型另计 `outOfScopeDrops`。管理页不能把 `rejected` 当成实际发送数。
- 重复 `message_id` 在限频检查之前去重；限频状态只存在内存。

## 7. Agent 会话前置准入不变量（不可协商）

陌生人消息在准入闸失败后，以下动作发生次数必须为 0：

```
ensureAgent            0
Agent Session 新建     0
Prompt Assembly        0
Capture / Source / Event 0
Recall / Diary / Stance / Growth 0
Mood 更新              0
工具调用               0
模型请求               0
```

允许的唯一业务外动作：

1. 限频允许时，经 QQ 桥发送固定拒绝文案；
2. 写一条最小安全审计日志（platform、脱敏 UID、时间、结果、限频计数），**不保存消息正文**。

即使陌生人消息里包含「请记住……」「执行工具……」「你是……」等看似合法的指令，也必须在准入阶段结束。

## 8. Capture / Mood / Evidence 边界

- 拒绝路径不进入 Capture：不产生 Source、Event、Artifact、Evidence；不触发 Recall/Diary/Stance/Growth；不触发 Mood 更新。
- 授权私聊：维持现有链路——消息进入 Capture → Source → Event；Mood 由 B2 在轮末判定；语气由 B3 Context 注入。P4-A 不改变这些语义。
- 拒绝审计日志不是 Source，不参与记忆、检索或关系计算。
- 不在拒绝路径调用 `remember` / `recall` / 任何工具。

## 9. 管理页只读契约

- 路由：`GET /api/psyche/qq`（只读，非 GET → 405）。
- 数据来源：桥的运行时快照 + 进程内 ring buffer；不查业务表、不写任何表。
- 字段：

| 区域 | 字段 |
|---|---|
| 连接状态 | `connected / degraded / disconnected / unknown`、最近心跳时间、`botStatus`（online/offline/unknown） |
| 登录账号 | 脱敏昵称、脱敏 QQ 号 |
| 授权 | owner 是否已配置、extra 人数、脱敏名单 |
| 策略 | 当前 `unknownPolicy`、限频参数、配置是否有效 |
| 统计 | 接收、发送、拒绝、限频静默丢弃、错误数量（均标注「本次进程启动以来」） |
| 时间 | 最近收到消息、最近成功发送 |
| 日志 | 最近 200 条内存日志（级别/错误过滤、暂停滚动、清屏、脱敏） |
| 错误 | 错误类别、时间、脱敏摘要 |

- 连接状态判定：WS 未连接 = `disconnected`；WS 连接但心跳过期或 `bot_status=offline` = `degraded`；三项都健康 = `connected`；信号不足 = `unknown`，不误报正常。
- 禁止：发送消息、增删授权、启停/重启进程、扫码登录、改配置。
- 清屏只清 ring buffer，不删除持久化日志或业务记录。

## 10. 日志脱敏与隐私

必须脱敏：完整 QQ 号（保留前 3 后 2 或等价规则）、消息正文（拒绝路径完全不记录）、OneBot token、`Authorization`、`Cookie`、URL 查询参数、绝对路径与附件名。

不得记录：被拒绝消息的全文、完整配置对象、Agent 会话内容、模型输入输出。

## 11. 故障处理与生命周期

| 场景 | 行为 |
|---|---|
| WS 断开 | 状态 `disconnected`，指数退避重连；断线期间不建新会话 |
| 心跳 stale / 账号离线 | 状态 `degraded`；仍按消息处理（现有语义），但管理页标黄 |
| 配置无效 | 全拒 + 启动日志 + 管理页配置错误；不阻挡 Psyche 其他功能 |
| DB 不可用 | 准入闸仍生效（只依赖配置）；授权消息的 Agent 链路按现有降级处理 |
| 插件卸载/重载 | 桥停止后不再建会话；重载恢复，状态计数从零开始 |
| 进程重启 | 会话从磁盘恢复；限频计数清零；ring buffer 清空 |

## 12. 测试矩阵（T1–T13）

| 组 | 场景 | 预期 | 证据 |
|---|---|---|---|
| T1 身份匹配 | 稳定 ID、昵称变化、跨平台同昵称 | 只按 QQ 号命中；昵称变化不影响；不同平台不合并 | 模块 + 真实宿主 |
| T2 授权准入 | owner 命中、extra 命中、不命中、缺失、空、含 `*` | 命中放行；缺失/空/非法全拒 | 模块 |
| T3 陌生人拒绝 | 固定文案、单用户冷却、全局额度 | 冷却内只回一次；超额度静默；文案不随消息变化 | 模块 + 真实宿主 |
| T4-A 业务零副作用 | 拒绝路径运行时探针 | 第 7 节九项全部 0 | 真实宿主 |
| T4-B 允许的拒绝动作 | 限频内拒绝消息 + 最小审计日志 | 恰好一条拒绝消息；日志无正文 | 真实宿主 |
| T5 正常私聊 | owner 完整对话 | 进入 Agent、Capture、Mood、Recall 正常 | 真实宿主 |
| T6 消息安全 | 自发消息、重复事件、异常事件 | 不成环、不重复处理、不重复拒绝 | 模块 + 真实宿主 |
| T7 管理页 | 状态、统计、日志、脱敏 | 只读、字段完整、无敏感数据 | 模块 + 真实宿主 |
| T8 故障恢复 | 断线重连、DB 不可用、重启 | 不错误放行、不重复建会话 | 真实宿主 |
| T9 跨插件回归 | 记忆、Mood、Context | 不改变已关闭阶段的行为 | 模块回归 |
| T10 自发消息 | 机器人自己的消息进入 WS | 不建会话、不成环、不计数为拒绝 | 模块 |
| T11 重复陌生人事件 | 同一 message_id 重投 | 只回一次；拒绝计数不重复 | 模块 |
| T12 授权配置异常 | 缺字段、错类型、未知策略 | fail-closed，全拒 | 模块 |
| T13 群聊入口 Fail-closed | 群聊、临时群聊、未知消息类型 | 不进入 `ensureAgent`；不建 Session/Prompt/Capture/Mood/工具/模型请求；静默丢弃并计 `outOfScopeDrops` | 模块 + 真实宿主 |

T4-A 的探针不只看数据库行数，还要在桥/宿主边界计数：`ensureAgent`、`agents.create/resume`、`adapter.announce`、`applyMoodTurn`、`capture`、工具调用、LLM 请求、Session 新建。

## 13. 判定标准

| 结果 | 条件 |
|---|---|
| **PASS** | T1–T13 全过；T4-A 九项全 0；T4-B 拒绝消息与审计日志符合；管理页只读且脱敏；真实宿主私聊链路正常；群聊入口静默拒绝 |
| **PARTIAL** | 安全不变量全部满足，但个别场景未在真实宿主复现、或管理页部分字段缺失 |
| **NO-GO** | 任一 T4-A 非 0；allowFrom 可被绕过；拒绝路径创建会话；拒绝路径写记忆/Mood；授权可从 QQ 消息或 Prompt 修改；群聊/未知类型进入 `ensureAgent` |

## 14. Schema 影响审计与实现拆分

### 14.1 Schema

- 不新增表、不加列、不改迁移版本（仍 v19 / 46 表）。
- `allowFrom`、限频参数进入 `PsycheConfig.qq` 与 `ConfigSchema`，属于配置不是数据库。
- 统计与日志全部为进程内状态，不落库；拒绝消息正文不持久化。
- 若 P4-B 需要离线队列持久化，另行设计，不在 P4-A。

### 14.2 实现拆分

| 阶段 | 内容 | 交付 |
|---|---|---|
| P4-A-0 | 本冻结稿（已完成） | 设计契约 |
| P4-A-1 | 配置字段 + 桥内 allowFrom 闸 + 固定拒绝 + 双层限频 + 群聊入口保护 + 模块测试 | 代码 + 模块测试 |
| P4-A-2 | 真实宿主导入探针（T4-A/T4-B/T13） | 证据 |
| P4-A-3 | `GET /api/psyche/qq` 只读快照 + 管理页区块 | 代码 + 测试 |
| P4-A-4 | 真实宿主 T5/T7/T8 验收 | 报告 |
| P4-A-5 | 报告与 DEV/HANDOFF 回填 | 文档 + 提交 |

### 14.3 实施约束

- 准入闸放在 `adapter.announce` 与 `ensureAgent` 之前；不改 Host、不改 qq adapter、不改 Capture/Mood。
- 拒绝路径不得吞掉异常后继续投递；异常一律按拒绝处理并计数。
- 任何新增配置字段都必须有安全默认值（缺失 = 拒绝）。
- 每次改动跑 `npm run build`、相关测试、全量 `npm run test`，并更新 DEV/README/报告。

## 15. 与 M1–M6 的对应

| 项 | 冻结位置 |
|---|---|
| M1 自发消息优先级 | §5.1 第 2 步（现有 397-400 先于去重与准入） |
| M2 去重先于拒绝限频 | §5.1 第 3 步（现有 410-415 先于限频） |
| M3 授权变更只走本地配置 | §4 规则 5、§11 配置无效 |
| M4 拒绝路径唯一允许副作用 | §7 末尾（拒绝消息 + 最小审计日志） |
| M5 限频计数与日志生命周期 | §6、§11（进程内，重启清零） |
| M6 平台标识一致性 | §3（platform 固定 `qq`，与 Adapter 声明一致） |
