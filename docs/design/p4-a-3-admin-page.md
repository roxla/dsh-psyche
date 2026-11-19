# P4-A-3 QQ 只读管理页（设计冻结 v1）

> 状态：冻结（2026-11-13）。基线：DEV v27.80 / `922a574` / schema v20 / 3876 断言 / 127 步。
> 上级：`docs/design/p4-a-private-chat-freeze.md`（v2）。本页只读，不新增写接口、不改 Host/Adapter、不改 schema。

## 1. 目标与非目标

**目标**：让 Owner 知道 QQ 桥「是否正常、卡在哪、最近发生了什么」，只读。

**非目标**：发送消息、编辑授权名单、启停 SnowLuma/QQ、扫码登录、修改配置、查看 OneBot Token。

## 2. 数据契约（`GET /api/psyche/qq`）

只允许 GET；非 GET 返回 405。`Cache-Control: no-store`。禁用时返回 `enabled:false` 的空状态而不是错误。

```ts
interface QqAdminPayload {
  ok: true
  enabled: boolean
  connection: 'connected' | 'degraded' | 'disconnected' | 'unknown'
  account: { uinMasked: string | null; nickname: string | null; online: boolean | null }
  allowFrom: { ownerConfigured: boolean; ownerMasked: string | null; extraCount: number; extraMasked: string[] }
  counts: {
    received: number            // 收到的 message 事件（含被拒绝/超范围）
    delivered: number           // 成功交给 Host 的 followup
    sendErrors: number          // 任何发送失败（不含拒绝回复失败）
    rejected: number            // 未授权私聊事件
    rejectReplies: number       // 真正尝试发送的拒绝回复
    rateLimitedDrops: number    // 冷却/全局额度静默丢弃
    rejectSendErrors: number    // 拒绝回复发送失败
    outOfScopeDrops: number     // 群聊/临时群聊/未知类型
  }
  activity: { lastHeartbeatAt: string | null; lastMessageAt: string | null; lastSentAt: string | null }
  logs: Array<{ seq: number; at: string; level: 'info' | 'warn' | 'error'; message: string }>
  // 永远不出现：accessToken、wsUrl 带 token、完整 QQ ID、OneBot 原始 payload
}
```

### 2.1 计数语义

- 全部为**本次进程启动以来**的内存计数，重启归零；UI 必须标注，不得伪装成历史累计。
- `rejected` 是事件数；`rejectReplies` 是实际发送尝试；`rateLimitedDrops` 是静默丢弃；`rejectSendErrors` 是发送失败。四者不得合并。
- `delivered` 与 `sendErrors` 分开；`outOfScopeDrops` 单独列出。

### 2.2 连接状态

- `connected`：WS 已连上且心跳/账号信号未报不健康。
- `degraded`：WS 在线，但 heartbeat `status.good=false` 或 `bot_status=offline`。
- `disconnected`：未连接/正在重连。
- `unknown`：老运行时没有健康信号。
- 只读判定，不触发重连/重启。

### 2.3 日志环形缓冲

- 只保留最近 **200 条**，FIFO 覆盖；`seq` 单调递增。
- **脱敏发生在写入 ring buffer 之前**：`access_token`、`Authorization`、`Cookie`、`api_key`/`secret`、URL 查询参数里的 token、长数字 QQ 号。
- 级别 `info|warn|error`；错误过滤由客户端完成。
- 「清屏」只清客户端显示，不删服务端缓冲、不删任何持久化数据；「暂停滚动」只停止刷新，不停止采集。
- 日志来自桥的 logger 适配；不引入文件日志或不落盘。

## 3. 服务端实现

- `src/lib/qq-admin.ts`：`QqLogBuffer`（200）、`redactQqLog`、`maskQqId`、`buildQqAdminPayload`。
- `QqBridge`：暴露只读 `adminSnapshot()`（连接态、计数、allowFrom 有效性与数量、时间戳、selfId）；所有日志经 `QqLogBuffer` 包装后仍写原 logger。
- `src/index.ts`：`GET /api/psyche/qq`；QQ 未启用/桥未构造 → `enabled:false`；异常只返回安全空态，不抛给客户端。
- 不改 `qq-bridge.ts` 的准入、限频、发送逻辑；只加计数与快照。

## 4. 客户端

- 心灵面板新增「QQ」tab（`QqAdminTab`），独立读 `/api/psyche/qq`。
- 区域：连接/账号、授权名单、计数、活动时间、日志（级别筛选 + 只看错误 + 暂停 + 清屏）。
- 无任何写操作按钮；不可编辑、不可发送、不可启停。
- 空态/禁用态：解释「QQ 桥未启用」。

## 5. 测试矩阵

| 组 | 断言 |
|---|---|
| 脱敏 | token / Bearer / Cookie / api_key / URL token / 长 QQ 号 全部被处理；正常文本不变 |
| 环形缓冲 | 200 条上限、FIFO 覆盖、seq 单调、时间 ISO |
| 快照 | 计数各自独立、allowFrom 只暴露数量与脱敏值、无 accessToken/完整 ID |
| 连接态 | connected/degraded/disconnected/unknown 映射 |
| 空态 | 桥为 null 时 `enabled:false` 且不抛错 |

## 6. 不做

- 不提供写接口、不提供 `POST /api/psyche/qq`、不引入 WebSocket 推送。
- 不把日志落盘、不做跨重启历史、不统计历史累计。
- 不在管理页展示关系/Mood/Candidate 数据；不把 P3-C 候选接进管理页。
