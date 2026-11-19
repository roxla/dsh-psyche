# P4 私聊优先与多 IM 接入预案（v1 讨论稿）

- 日期：2026-11-12
- 状态：**预案，未实施**。只冻结方向与边界，不写代码、不改 schema、不改现有 QQ 桥行为。
- 与既有决策的关系：QQ 群聊**从原 P4 提前项挪到最后**；先做私聊；多 IM 只做抽象与试点评估，不一次性接多个平台。

## 1. 现状盘点（基于当前代码，不凭印象）

| 项 | 现状 |
|---|---|
| 通道实现 | `src/lib/qq-bridge.ts`（OneBot WS，Host 层只做通道，不碰人格/记忆） |
| 会话 id | 私聊 `qq-private-<uid>`；群聊 `qq-group-<gid>`（`qqSessionIdFor` / `qqTargetOf`） |
| 身份 | 由 Host 白名单内 `qq-snowluma` Adapter 声明；`HostChannelRegistry` 固定 platform 与 surface，`personal` 明确禁止 |
| 私聊/群聊 | 同一套代码路径；**群聊未做真机验收** |
| 允许名单 | **没有**。当前任何能私聊到机器人的 QQ 号都会创建一个 Agent 会话（grep 无 allow/owner 判定） |
| 投递 | `send_private_msg` / `send_group_msg`，按 `message_id` 去重、echo 回执 + 超时 `unknown`、指数退避重连 |
| 健康 | WS 已连接 ≠ 能收消息；接收健康看心跳 `status.good`，账号在线看 `bot_status`，两者都缺时保守处理 |
| 媒体 | 未处理（图片/语音/文件） |
| 管理页 | 无；只有配置文件 |
| 配置 | `qq.{enabled, wsUrl, accessToken, snowlumaHome, provider, model, cwd, reconnectMs, maxText, sendTimeoutMs}` |

**结论**：私聊链路已能跑通，但缺少「谁能和它说话」的入口控制、媒体能力与运维可见性；群聊尚未验证。因此先补私聊，群聊延后。

## 2. 目标与边界

### 目标（按顺序）

1. **私聊可用且可控**：只有 owner 与显式允许的人能建立会话；陌生人得到固定拒绝而不是静默建会话。
2. **私聊可靠**：消息不丢、不重复、顺序可解释；断线可恢复；失败有可见提示。
3. **可运维**：只读管理页能回答「连没连上、最近收发了什么、错在哪」。
4. **多 IM 可扩展**：抽出一层 `ChatTransport`，新增平台只需实现适配器，不改记忆/人格/面板核心。
5. **QQ 群聊最后**：等私聊稳定、管理页可用、多 IM 抽象验证后再做。

### 明确不做

- 不自动加好友、不主动私聊陌生人、不群发（主动联系是 P3-C，独立设计）。
- 不绕过平台频率/内容限制，不做协议逆向或账号池。
- 不在群聊里默认启用记忆写入（群聊阶段单独定策略）。
- 不为多 IM 预先改 schema；确实需要投递收据时再单独立项。

## 3. P4-A：QQ 私聊最小可用（第一优先）

### 3.1 入口控制（必须）

配置新增（或扩 `qq`）：

```yaml
qq:
  enabled: true
  # 默认只允许 owner；其他人一律拒绝
  allowFrom:
    owner: "12345678"        # 或从 profile 的 owner 读取
    extra: []                # 显式允许的 QQ 号
  unknownPolicy: reject      # reject（默认）| ignore | allow
```

行为：

- 收到 `message.private` 时先解析 `userId`，命中 owner/extra 才继续；否则按 `unknownPolicy` 处理，**不建 Agent 会话**。
- `reject` 回一条固定短句（不暴露内部信息、不重复刷屏），并记一条审计日志（UID + 时间 + 结果）。
- 允许名单变更即时生效（读内存，不从每条消息读配置）。

### 3.2 会话与身份

- 保持 `qq-private-<uid>`；一个 QQ 号一个会话，重启后恢复。
- 身份仍只由 `qq-snowluma` Adapter 声明，桥不写 `RuntimeInputStore`。
- 多账号/多实例：会话 id 增加实例前缀或 `botUid` 维度（P4-B 再定，避免现在改协议）。

### 3.3 投递可靠性

- 长文本按 `maxText` 切分，切分不破坏代码块/引用；超长消息给出明确截断标记。
- 同一 `message_id` 只投递一次；重试只对「明确失败」进行，`unknown` 不盲目重发。
- 单会话内串行投递，保证顺序；失败回一条「消息没发出去」的简短说明，不静默。
- 断线期间入站消息：有界队列（容量可配），超出丢弃并记日志；重连后按序补投。

### 3.4 健康与可见性

- 状态 = WS 连接 + 心跳 `status.good` + `bot_status` 三者合成，UI 显示「在线 / 连接中 / 接收异常 / 账号离线」。
- 最近一次收发时间、失败计数、重连次数。
- 管理页（只读）：
  - 连接状态、账号、WS 地址（脱敏 token）；
  - 200 条 ring buffer 日志（级别过滤、错误过滤、暂停滚动、清屏、脱敏）；
  - 不做启动/停止/重启、不改 SnowLuma 配置。

### 3.5 P4-A 验收

| 组 | 断言 |
|---|---|
| 入口 | 陌生人被拒且不建会话；owner 放行；extra 生效；拒绝不刷屏 |
| 投递 | 重复 `message_id` 只发一次；长消息切分；失败提示；顺序 |
| 断线 | WS 断开→退避重连→恢复收发；离线队列有界 |
| 重启 | 会话恢复、健康状态重建、不重复投递 |
| 隐私 | 日志不含 token/完整消息体；无跨会话串扰 |

## 4. P4-B：私聊体验与运维补齐

按需排期，不阻塞 P4-C 抽象：

- 媒体：图片/语音/文件进出（先定「收不发/发不收」矩阵）；媒体落盘位置与保留期。
- 消息体验：多行格式、引用回复、已读/发送状态（平台支持时）。
- 多联系人策略：每联系人独立开关、静默时段、频率上限（与 P3-C 共用限流思路，但不做主动联系）。
- 离线队列持久化（进程重启不丢；需要时再评估 schema，不预设新表）。
- 管理页扩展：按会话过滤、导出诊断包（脱敏）。

## 5. P4-C：多 IM 抽象（预案，不先实现）

### 5.1 抽象层

```ts
interface ChatTransport {
  readonly id: string                 // 'qq-onebot' | 'telegram-bot' ...
  readonly platform: string           // 'qq' | 'telegram' ...
  readonly capabilities: ChatCapabilities
  start(): Promise<void>
  stop(): Promise<void>
  send(target: ChatTarget, message: OutboundMessage): Promise<SendResult>
  onInbound(handler: (m: InboundMessage) => void): () => void
  health(): TransportHealth
}

type ChatTarget = { kind: 'private'; id: string } | { kind: 'group'; id: string }
interface InboundMessage { platform; kind; threadId; senderId; text; media?; messageId; at }
interface OutboundMessage { text: string; media?: MediaRef[]; replyTo?: string }
interface SendResult { ok: boolean; messageId?: string; error?: 'unknown' | 'rate-limited' | 'forbidden' | 'transport' }
```

- 会话 id 统一为 `<platform>-private-<uid>` / `<platform>-group-<gid>`；现有 QQ 前缀不变，向后兼容。
- Adapter 注册仍走 `HostChannelRegistry` 白名单：新增平台 = 新增 `HOST_ADAPTER_SPECS` 条目 + `allowedSurfaces`，**不允许插件自注册**。
- 身份映射：每个平台独立 `stableUserId`；跨平台联系人默认**不合并**（隐私与误判风险），需要时用显式 `contact_link` 单独设计。
- 配置演进：`qq` 保留兼容，新增 `chat.transports[]`；两者同时存在时 `chat` 优先，`qq` 视为 `chat.transports` 的一个别名。

### 5.2 能力矩阵（用于选型与 UI）

| 能力 | QQ OneBot | Telegram Bot | Discord Bot | 企业微信/WeCom |
|---|---|---|---|---|
| 私聊 | ✅ | ✅（用户先 /start） | ⚠️（需共同服务器） | ✅（应用内） |
| 群聊 | ✅（后做） | ✅（后做） | ✅（后做） | ✅（后做） |
| 媒体 | ⚠️ 部分 | ✅ | ✅ | ✅ |
| 语音 | ⚠️ | ✅ | ✅ | ✅ |
| 已读回执 | ❌ | ❌ | ❌ | ⚠️ |
| 官方 API | ❌（OneBot 生态） | ✅ | ✅ | ✅ |
| 账号风险 | ⚠️ 中 | 低 | 低 | 低 |
| 部署成本 | 需 SnowLuma | 低（token） | 中（bot + 权限） | 中（企业资质） |
| 合规/ToS | 灰 | 清晰 | 清晰 | 清晰 |

### 5.3 选型建议（待拍板）

1. **第二平台优先 Telegram Bot**：官方 API、私聊简单、媒体完整、无需自建网关；风险最低，适合验证抽象层。
2. **Discord 次之**：适合社区/群，但私聊需要共同服务器，体验不如 Telegram。
3. **微信个人号：不建议**（无官方个人 API，协议逆向与封号风险高）；企业微信仅在明确有企业资质时评估。
4. 其他（Slack/Matrix/飞书）：按实际需求再评估，不预先实现。

## 6. 分阶段与依赖

| 阶段 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| P4-A | QQ 私聊入口控制 + 投递加固 + 只读管理页 | P3-A 关闭 | 第 3.5 节五组 |
| P4-B | 私聊媒体/体验/多联系人 | P4-A | 媒体矩阵 + 队列恢复 |
| P4-C | `ChatTransport` 抽象 + Telegram 试点 | P4-A | 抽象单测 + Telegram 真机私聊 |
| P4-D | QQ 群聊 | P4-A/B/C | 群内策略、防刷屏、记忆写入边界 |
| 并行小项 | 记忆上下文 chip UI（已拍板） | 无 | 默认折叠/可热关/共享 prefs |

## 7. 开放问题（需要拍板）

1. **默认策略**：`allowFrom` 默认 owner-only，还是允许「所有好友」？建议 owner-only。
2. **陌生人处理**：`reject` 回固定句，还是完全静默？建议 reject（可解释），但限频。
3. **媒体范围**：先只做文本，还是第一版就支持图片？建议 P4-A 只文本，P4-B 图片。
4. **多联系人**：是否支持非 owner 的长期联系人？这会影响记忆隔离与隐私表述。
5. **第二平台**：Telegram 是否作为首个试点？还是先只做 QQ 私聊稳定。
6. **群聊准入**：群聊是否只在白名单群、只响应 @，且默认不写长期记忆？留到 P4-D 再冻结。
7. **消息留存**：私聊消息会进 Capture/Source；是否需要单独的保留期与删除入口？需与隐私边界一起定。

## 8. 风险与回滚

| 风险 | 处理 |
|---|---|
| 账号被平台限制/封禁 | 不群发、不刷屏、限频；通道可一键关闭；不承诺规避平台风控 |
| token 泄漏 | 配置只读发现、日志脱敏、管理页不显示完整 token |
| 消息重复/乱序 | message_id 去重 + 单会话串行 + 明确失败才重试 |
| 陌生人骚扰 | 默认拒绝 + 限频 + 审计日志 |
| 多平台身份混淆 | 独立 stableUserId，跨平台不合并 |
| 回滚 | 每个 transport 独立 `enabled` 开关；关闭不影响已存数据；schema 不改，可随时退回 |

## 9. 本预案的交付物

- 本文档（`docs/design/p4-private-chat-and-multi-im.md`）作为 P4 的方向与边界草案；
- DEV 阶段顺序调整为「私聊优先、群聊最后、多 IM 预案先行」；
- 不新增代码/测试，不修改现有 QQ 桥行为；实施前需按本文档再冻结 P4-A 详细设计。
