# P3-C-3a 实施说明（修订版）

- 状态：用户已批准范围；本文件把四项编码前修订同步进实施说明，随后按此实现。
- 上游冻结：`docs/design/p4-qq-transport-outbox-plan.md` §6–§11、`docs/design/p3-c-proactive-contact.md` §7–§8、`docs/design/p3-b-c-shared-contracts.md`。
- 本阶段**不接真实 QQ Dispatch、不由宿主启动 Worker、不做管理 UI**。

## 1. 四项修订（相对初版方案）

1. **`proactive.allow` 独立复核**：`capabilities().proactive` 只表示通道能力，不能代替业务授权。签发 Worker 注入同步 `proactiveAllowReader(contactId): ProactiveAllowResult`，缺失/撤销/未知/异常一律拒绝。
2. **逐条领取并预留速率额度**：`claimBatch` 在同一 `BEGIN IMMEDIATE` 事务内循环「选一条 → 复核 → 速率闸（含本批已领取与在途 dispatching）→ 置 dispatching → 再看下一条」，不允许先取候选快照再统一检查。额度包含 `sent_at` 窗口内成功数 + 已领取未完成的 `dispatching`（按 `dispatch_started_at` 计入）+ 本批已领取。必要时可用 `dispatch_started_at` 标注预留起点。
3. **容量计入 unknown**：容量 = `pending + dispatching + unknown`，达到 200 时拒绝新入队并通知 Owner；unknown 不自动清理、不淘汰。
4. **数据库保护审批绑定不可变**：`approval_id, draft_id, draft_revision, draft_hash, contact_id, platform, stable_user_id, transport_id, payload_text, text_hash, decided_by, approval_decided_at` 入队后禁止 UPDATE；用 SQLite `BEFORE UPDATE ... RAISE(ABORT)` 触发器保护，不只靠 Store API。状态、attempts、receipt、错误码与时间字段仍允许更新。

## 2. 审批与入队

- Approval 与 Enqueue 是一个原子业务操作：只有 Owner 批准且入队成功，才存在持久化审批快照；容量不足、审批过期或 transport 不匹配时入队失败，不产生记录。
- `outbox_id = "ob_" + sha256(approvalId + draftHash)[:16]`。
- `INSERT ... ON CONFLICT(approval_id) DO NOTHING`；若已有同 `approval_id` 行但任一绑定字段不同 → `E_OUTBOX_APPROVAL_CONFLICT`。
- `decidedBy` 与 `ownerId` 必须来自可信本地 Owner 上下文（注入 `ownerId` + 校验），不能由普通调用者传两个相同字符串通过。
- 不可变绑定：`approvalId, draftId, draftRevision, draftHash, contactId, platform, stableUserId, transportId, payloadText, textHash, decidedBy, approvalDecidedAt`。
- TTL：`expires_at = min(now + 10min, approvalDecidedAt + 24h, consent.expiresAt)`；只从入队起算，不因重试重置。

## 3. 状态机

| 当前 | 事件 | 新状态 |
| --- | --- | --- |
| pending | claim 成功 | dispatching |
| pending | 超时（`expires_at`） | expired |
| pending | Owner 取消 | cancelled |
| dispatching | 结果 accepted | sent |
| dispatching | 永久失败 | failed |
| dispatching | 明确可重试失败（429 等）且未过期 | pending（设 `retry_at`，attempts 保留） |
| dispatching | 超时/断线/响应丢失/未知异常 | unknown |
| dispatching | 进程重启恢复 | unknown（`last_error_code='worker_restart'`） |
| unknown | Owner 确认已收到 | sent |
| unknown | Owner 确认未收到 | failed（需重新审批，不回 pending） |
| unknown | 无结论 | 保持 unknown |

- `resolveUnknown` 只接受 Owner 核验结论；禁止任何自动重发。
- `unknown` 计入容量；`expired`/`cancelled`/`sent`/`failed` 不计入待处理容量。

## 4. 发送前六项复核（事务内）

1. Consent：`consentReader(contactId)`；`granted` 且未过期才继续；`revoked / expired / null / 读取异常` → 取消（异常记稳定错误码）。
2. 主动授权：`proactiveAllowReader(contactId)` 独立判断，缺失/撤销/未知/异常 Fail-closed。
3. Approval：仍在 24h 窗口，`approval_id` 绑定一致。
4. Contact 身份：`contact_id + platform + stable_user_id` 一致。
5. 内容绑定：`draft_id + draft_revision + draft_hash + payload_text/text_hash` 一致。
6. Transport：精确 `transport_id`、`platform` 一致，且 `capabilities().proactive === true`（技术能力，与第 2 项业务授权同时满足）。

## 5. 领取与速率

- `BEGIN IMMEDIATE`：先处理过期（pending→expired），再循环领取。
- 单次 `claimBatch(n)`；每轮只取一条满足 `status='pending' AND retry_at<=now` 且该 Contact 无 `dispatching` 的行。
- 速率闸：通道 20 条/分钟、同一 Contact 60 秒、全局 50 条/小时；计数口径 = 窗口内 `sent_at` 成功数 + 窗口内 `dispatching`（`dispatch_started_at` 或领取时 `updated_at`）预留数；本批已领取立即计入。
- 事务内只做校验与状态迁移；`transport.send()` 在事务外；回执 `applyResult` 单独事务并带 `WHERE status='dispatching'` 守卫。

## 6. 发送结果映射

```ts
interface ChatSendResult {
  outcome: 'accepted' | 'permanent' | 'retryable' | 'unknown';
  messageId?: string;
  errorCode?: string;
  retryAfterMs?: number;
}
```

- `accepted`：平台明确接受 → sent。
- `permanent`：明确永久失败 → failed。
- `retryable`：明确未接受且可稍后重试（如 429）→ pending + `retry_at`；`retryAfterMs` 仅此用，clamp 到 30s–10min，越界/非法使用安全默认值；若 `retry_at >= expires_at` 直接 expired。
- 网络超时、连接中断、响应丢失 → **unknown**，不得因存在重试时间归为 retryable。
- `send()` 抛异常 → unknown。

## 7. 恢复与测试

- 原设计要求启动前把 `dispatching → unknown(last_error_code='worker_restart')`，不做任何重发。**C-3b 接入审计发现 C-3a 的 `start()` 实际只调度，旧测试显式调用了恢复，未证明启动入口自动恢复。**v27.91 明确由真实 CLI 启动入口取得同 DB 的内核独占租约，再 `recoverInflight()`、显式 `tickOnce()`；Worker 类不承担无互斥保护的全局恢复。此修订保留 C-3a 历史模块级 PASS，不反写成其当时已完成真实启动验收。
- Worker 默认不启动：模块 import、构造 Service/Worker、插件加载均不产生领取/发送；只有测试显式 `start()`。
- 场景 A：Mock 先记录发送再返回 unknown → Worker 重启不再次发送。
- 场景 B：子进程 claim 后直接退出（未发送）→ 重启后 `dispatching → unknown`、零发送；`resolveUnknown('not-received') → failed`；同 `approval_id` 再入队被唯一约束拒绝。
- 新增测试：`proactive.allow` 撤销/异常、同批多任务额度预留、同 Contact 不得同时 dispatching、unknown 计入容量、直接 SQL 修改绑定字段被拒、未显式启动不发送。

## 8. 安全

- `payload_text` 是已审批正文，不得原样写入普通运行日志；日志只记录 `outbox_id`、状态与错误码。
- 不可变字段由数据库触发器保护；Store 层同样校验。
- `unknown` 只能由 Owner 核验解决，不自动重试、不静默丢弃。

## 9. 实现落点

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/schema.ts` | Schema v21：`proactive_outbox` 表、4 索引、12 字段不可变触发器；`EXPECTED_TABLE_COUNT=47` |
| `packages/core/src/proactive-outbox.ts` | `OutboxStore`、七态常量、TTL/24h/200/速率常量、`outboxIdOf`/`textHashOf`、`OUTBOX_ERROR`、`ConsentReader`/`ProactiveAllowReader` |
| `packages/core/src/proactive-outbound-service.ts` | `OutboundService.approveAndEnqueue/runOnce`、Transport 能力与告警降级 |
| `packages/core/src/proactive-outbox-worker.ts` | `OutboxWorker.start/stop/tickOnce`，默认不启动 |
| `packages/core/src/chat-transport.ts` | `ChatSendResult.retryAfterMs?: number` |
| `test/proactive-outbox.ts` | 80 断言：幂等/绑定/容量/触发器/领取/Consent/allow/身份/hash/通道与 Contact 速率/同批额度预留/retryable/permanent/ACK 丢失/崩溃恢复/取消/过期/Worker 边界/日志脱敏/Owner 守卫 |

审批快照仍存于 `proactive_outbox` 行，未新增 Approval 表。C-3a 历史全量基线见 DEV v27.88；C-3b 对启动恢复的差异发现与修订见 §7 及 `p3-c-3b-integration-proposal.md`。主动发送仅 429 可重试、离线结果分类等接入修订以该 C-3b 说明为准。

## 10. 测试口径

- 模块级：`node test/proactive-outbox.ts` → **80 通过 / 0 失败**。
- 全量：`npm run test` 逐套件累加，基线数见 `main/dsh-psyche-DEV.md` 版本表。
- 未接真实 QQ、未注册宿主启动、未开放主动消息发送；这些留 P3-C-3b。

## 11. 入口依赖守卫

- 文件：`test/outbox-entry-guard.ts`，已接入 `npm run test` 链。
- 范围：`src/index.ts` **不得直接引用** `proactive-outbox`、`proactive-outbound-service`、`proactive-outbox-worker`；检查静态 `import`、`export ... from`、动态 `import()`、`require()` 与 side-effect import。
- 明确边界：这是**直接引用检查，不是传递依赖分析**；测试名与此处都不得表述为「入口依赖图不可达」。
- 自检：4 条注入样例必须被守卫捕获，防止守卫本身失效。
- 当前结果：入口无引用，5 断言通过；全量基线见 DEV v27.89。


