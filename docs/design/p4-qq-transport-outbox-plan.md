# P4 QQ 传输层与主动消息发件箱方案（v2，已批准）

- 状态：**已批准**（2026-11-13，用户 m12043 拍板）
- 基线：DEV v27.83 / Git `09fc25a` / Schema v20（目标 v21）
- 适用范围：P4-C-0（抽象）、P3-C-3a/3b（Outbox 与真实链路）、P4-C-1（Telegram）
- 非目标：P4-D QQ 群聊、自动蒸馏、人格/关系权限模型改造

## 0. 决策摘要

| 事项 | 决定 |
| --- | --- |
| 发件箱存储 | Schema **v21** 新表 `proactive_outbox`（非 operations、非 JSON 文件） |
| 待发 TTL | 入队起 **10 分钟**，不因重试/重启延长；`unknown` 保留核验 |
| 第一条额外通道 | **Telegram**（独立平台身份，不作为 QQ 备用通道） |
| 三项修正 | 不跨平台自动切换；发件箱绑定不可变审批内容；`unknown` 绝不自动重试 |

ArkBot 只借「业务/路由/协议解耦」与通道健康、能力描述、等待连接等机制；不借 Python 框架、盲目补发、CRC32 身份、跨通道自动降级。

## 1. ArkBot 审查结论（摘）

- Adapter 契约（connect/disconnect/call_api/is_connected/wait_connected/send_reply）干净，事件保留来源通道——适合 Psyche。
- `Bot.reply()` 先来源通道、再健康通道；`call_api` 全失败且 `send_*` 入发件箱；`OUTBOX_TTL=600`、上限 200、3s flush、SQLite KV——**不可直接搬**：没有逐条状态机，超时重复发送，持久化失败静默退化，所有 send 都可能入队。
- 官方 QQ 适配器：WS+HTTP、token 提前刷新、30 条/分钟限速、openid↔CRC32 伪 ID——**伪 ID 不能作为 Contact 身份**。
- `plugins/ai_chat.py` 的会话锁只保护模型请求，并发时丢弃而非排队，不保证多段发送顺序——不能当作「消息顺序已解决」。

## 2. 与 Psyche 的边界差异

| 维度 | ArkBot | Psyche |
| --- | --- | --- |
| 运行形态 | 独立进程/Python 框架 | DSH 插件（Host 生命周期） |
| 通道 | 多协议并列 | 当前 QQ 单通道，P4-C 才扩展 |
| 发送权限 | 任意插件可发 | 普通回复走 qq-bridge；主动发送仅 Owner 审批后 Dispatch |
| 持久化 | 尽力而为 | 主动消息必须可审计、可核验 |

## 3. 目标架构

```
P3-C Approval（Consent + 单次审批 + Draft Revision/Hash）
        │
        ▼
OutboundService（主动消息唯一写入口：幂等入队 + 事务）
        │
        ▼
OutboxWorker（领取、发送前复核、发送、回执、崩溃恢复）
        │
        ▼
ChannelRouter（只按审批绑定的 transportId 选择通道）
        │
        ├── qq-onebot（现有 QQ 桥包装）
        └── telegram（P4-C-1）
```

**语义修正**：`OutboundService` 只接主动消息，不是所有回复的统一入口。普通 Agent 回复继续走现有 qq-bridge 的「来源会话回复」，不进持久化队列。

## 4. ChatTransport 契约

```ts
interface ChatTransport {
  readonly id: string;        // 通道实例，如 "qq-onebot"
  readonly platform: string;  // 平台，如 "qq"
  status(): TransportStatus;
  waitConnected(timeoutMs?: number): Promise<boolean>;
  capabilities(): TransportCapabilities;
  send(target: TransportTarget, payload: ApprovedMessage): Promise<TransportSendResult>;
  close(): Promise<void>;
}
```

- 传输层**不判权限**、不读 Consent、不重试、不跨平台转发。
- `TransportSendResult` 必须类型化：`accepted` / `permanent-failure` / `retryable-failure` / `unknown`（timeout、断线、ACK 丢失）。
- 发送内容是不可变快照（`ApprovedMessage`），不是 candidateId 引用。

## 5. 路由规则（冻结）

| 场景 | 规则 |
| --- | --- |
| 普通消息回复 | 只走来源 Transport；来源不可用则等待/失败，不跨平台 |
| 已审批主动消息 | 只走审批时绑定的 `transportId` |
| 通道离线 | 等待或失败；不自动改写通道 |
| 同平台多实现 | 仅在身份映射与消息语义被验证等价后，才允许同平台故障切换 |

审批 QQ 消息，不得自动改由 Telegram 发送。

## 6. 审批与不可变内容

审批记录绑定：

```
approvalId + draftId + draftRevision + draftHash
          + contactId + platform + transportId
```

- 入队时保存审批时的精确文本快照（`payload_text`）与 `text_hash`；后续草稿编辑不得改变已批准内容。
- `outbox_id = "ob_" + sha256(approvalId + draftHash)[:16]`，前提是 approvalId 已唯一绑定上述字段。
- 审批本身有效期 24 小时；Outbox TTL 另算 10 分钟。

## 7. Schema v21：`proactive_outbox`

| 字段 | 说明 |
| --- | --- |
| `outbox_id` TEXT PK | 确定性幂等 ID |
| `approval_id` TEXT NOT NULL UNIQUE | 唯一审批引用 |
| `draft_id` / `draft_revision` / `draft_hash` | 草稿与版本绑定 |
| `contact_id` / `platform` / `stable_user_id` | 目标身份 |
| `transport_id` | 已审批通道 |
| `target_kind` | private / group（v1 仅 private） |
| `payload_text` / `text_hash` | 不可变发送内容 |
| `status` | 状态机 |
| `attempts` / `last_error_code` / `receipt` | 尝试与回执摘要 |
| `created_at` / `expires_at` / `retry_at` / `sent_at` / `updated_at` | 时间 |

索引：`approval_id` 唯一；`(status, retry_at)` 供领取；`expires_at` 供过期扫描。队列上限 200，满时拒绝新入队并通知 Owner，不静默淘汰。

## 8. 状态机与时间规则

```
pending ──claim──▶ dispatching ──ok──▶ sent
   │                    │
   │                    ├──permanent──▶ failed
   │                    ├──retryable──▶ pending (retry_at)
   │                    └──unknown────▶ unknown
   ├──TTL 到期──────▶ expired
   └──Consent 撤回/取消──▶ cancelled
```

- 重启时 `dispatching` → `unknown`（可能已发出）。
- `unknown` 不自动重试；`resolveUnknown`：确认已收到→`sent`；确认未收到→`failed`（需 Owner 重新审批，不自动回 pending）；无结论→保持 `unknown`，进管理页待核验。
- TTL：入队起算；重试/重启不重置；`expires_at` 不得超过审批或 Consent 剩余有效期；`unknown` 不因超时删除。
- `sent` 仅表示平台确认接受，不代表用户已阅读。

## 9. 发送前复核（R4）

Worker 在真正发送前必须重新检查：

1. Consent 仍有效且未撤回；
2. 主动联系授权仍允许；
3. 审批仍有效（24h 内、未取消）；
4. Contact 的平台身份与审批一致；
5. Draft revision 与 hash 一致；
6. `transport_id` 与审批绑定一致。

未开始发送而 Consent 被撤回 → `cancelled`；已 `dispatching` 的任务可能已发出，转核验，不能假装撤回能阻止平台发送。

## 10. 领取与并发

- 领取用 `BEGIN IMMEDIATE` 抢占，逐条置 `dispatching` 并提交事务。
- 出站网络请求**不放在 SQLite 事务内**。
- 发送回执后单独事务更新状态；同一 `outbox_id` 不会被两个 Worker 同时领取。
- 速率闸：通道 20 条/分钟、同联系人 60 秒、全局 50 条/小时；429 只设置 `retry_at`，不计永久失败。

## 11. R1–R4 落点

| 编号 | 落点 |
| --- | --- |
| R1 审批内容绑定 | `approval_id + draft_id + revision + hash + contact + platform + transport` |
| R2 结果类型化 | `TransportSendResult` 四态，Outbox 状态由结果映射 |
| R3 不跨平台降级 | ChannelRouter 只认审批绑定的 transportId |
| R4 发送前复核 | Worker 发送前六项检查（§9） |

## 12. 分阶段

| 顺序 | 阶段 | 交付 | 关闭条件 |
| --- | --- | --- | --- |
| 1 | P4-A-5 | QQ 私聊阶段总结 | 已关闭（Host API 认证 PARTIAL 保留） |
| 2 | P4-C-0 | ChatTransport + QQ 包装 | 旧行为等价 |
| 3 | P3-C-3a | Schema v21 + OutboundService + OutboxWorker | Mock Transport、崩溃恢复通过 |
| 4 | P3-C-3b | Approval → Dispatch 真实链路 | 专用联系人端到端通过 |
| 5 | P4-C-1 | Telegram Transport | 身份、Consent、发送、回执通过 |
| 6 | P4-D | QQ 群聊 | 独立设计与授权验收 |

### P4-C-0 范围（冻结）

只做：`qq-onebot` Transport、连接状态与 `waitConnected()`、消息收/发接口、原 qq-bridge 兼容包装、来源消息回复语义、会话串行化、Mock Transport。

不做：Telegram、多通道自动故障转移、Outbox、主动发送、QQ 群聊、修改现有入站准入策略。

## 13. 测试矩阵

- Contract：状态/能力/超时/断线/unknown 分类；
- 路由：来源回复、审批绑定、跨平台拒绝；
- Outbox：幂等、事务领取、并发、重启 `dispatching→unknown`、TTL、取消、队满；
- 复核：Consent 撤回、审批过期、身份/hash 漂移；
- Worker：429 retry、永久失败、unknown 核验、回执；
- 阶段回归：P4-C-0 前后 QQ 私聊行为等价（同一剧本、结构化对比）。

## 14. 未决与风险

- Telegram 送达回执的粒度（accepted 是否等价 sent）需在 P4-C-1 用真实 Bot API 验收。
- 同一联系人跨平台身份关联仍要求显式证据，不做自动合并。
- `unknown` 的长期保留策略与人工核验入口在 P3-C-3 实现时定。
- QQ 官方通道可作为后续 QQ 生态备用通道重新评估，不作为 P4-C-1 试点。

## 15. 一句话

借 ArkBot 的「传输层与业务解耦」，不借它的可靠性近似；主动消息必须有不可变审批、逐条状态机、发送前复核和 `unknown` 人工核验。
