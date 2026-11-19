# DSH 工具调用边界契约（草案）

- 状态：FROZEN（2026-11-15，两轮外部评审后冻结）
- 日期：2026-11-15
- 适用：DSH Host 与插件；本文件只定义接口与验收，不实施 Host 或 Psyche 生产代码
- 当前状态：P5-R-4b B4 = `BLOCKED_BY_HOST_CAPABILITY`；H-2 仍为 BLOCKED

## 0. 目的

给 Host 维护方一份可实现的契约：让“在一个真实 Agent/Session/Turn 里执行一次已注册工具调用，并把结果作为 Tool 内容写回会话，随后由下一次 Context Assembly 消费”这件事可被验证。

非目标：

- 不替代 H-1/H-2 的“生产 Provider 最终输入证明”。
- 不新增 Psyche Schema，不改 Psyche 生产代码。
- 不提供绕过工具授权、Scope、Disclosure、审批或 guard 的特权通道。
- 不允许把工具结果伪装成 System、Persona 或其他可信指令。

## 1. 现有实现核对

以下均来自当前仓库 `node_modules` 的实际类型与实现，不是推测。

| 能力 | 位置 | 现状 |
|---|---|---|
| 工具注册 | `@deepseek-ai/dsh-tools/lib/types/index.d.ts:577` `register(definition)` | 已有 |
| 按 Agent/Scope 可见性 | 同文件 `:631` `get(name, scope?)`；注册层按 scope 分层 | 已有 |
| 同进程执行 | 同文件 `:675` `execute(exec: ToolExecutionInput)` | 已有；返回 `ToolExecutionResult`，不写会话 |
| 调用输入 | 同文件 `:196-216` `ToolExecutionInput { callId, rootCallId?, name, arguments, agent?, parent?, signal }` | 已有；`agent` 由 agent loop 填入 |
| 调用结果 | 同文件 `:379-401` `ToolExecutionSuccess/Failure` | 已有 |
| 模型 tool-call 块 | `dsh-llm/lib/types/types.d.ts:60-67` `{ type:'tool-call', id, name, arguments: string }` | 已有 |
| tool-result 块 | 同文件 `:68-74` `{ type:'tool-result', toolCallId, content, isError? }` | 已有 |
| tool-result 消息 | `dsh-llm/lib/types/message.d.ts:22-25,140-143,185-195`：`role='user'`、`source={kind:'tool',callId}`、`content=[ToolResultBlock]`、`createToolResultMessage()` | 已有 |
| 会话事件 | `dsh-session/lib/types/types.d.ts:286-312` `'tool/call'{turn,step,callId,name,arguments}`、`'tool/result'{turn,step,message,error?,meta?}` | 已有 |
| 会话写入 | `dsh-session/lib/index.js:1458` `append(type, data, ...)`，JSON 快照、事件日志为事实源 | 已有 |
| tool-result 重写限制 | `dsh-session/lib/types/surface.js:221` `assertToolResultRewrite` | 已有；只允许受限替换 |
| 中断恢复 | `dsh-session/lib/types/repair.js:105` `interrupted-tool-result-*` | 已有 |
| Context Assembly | `dsh-system-prompt` 只处理 Context/Section；工具结果是会话消息，不进入 system prompt | 已有 |
| **会话内工具调用入口** | 无 | **缺失**：没有“以某个 Agent/Session/Turn 身份调用工具并写回 transcript”的正式 API |
| **写入回执** | 无 | **缺失**：调用方无法确认 `tool/result` 已持久化 |
| **Assembly 关联** | 无 | **缺失**：无法把一次工具结果与后续 `assemblyId` 关联 |
| **verification 审计** | 无 | **缺失**：没有 `reason='verification'` 的调用记录与权限边界 |

结论：工具分发和消息模型都已存在；缺的是 Host 侧一条受信的“调用 → 持久化 → 组装回执”链路。

## 2. 目标契约

Host 新增一个会话内工具调用服务（命名可调整），语义固定如下：

```ts
type ToolInvocationReason = 'verification'

interface ToolInvocationRequest {
  /** Host 从当前受信上下文注入，调用方不得自报 */
  agentId: string
  sessionId: string
  turn: number
  step: number
  reason: ToolInvocationReason
  name: string
  arguments: Record<string, unknown>
  /** Host 计算：sha256(sessionId|turn|step|name|canonicalArgs) */
  idempotencyKey?: string
}

interface ToolInvocationResult {
  status: 'ok' | 'tool_error' | 'denied' | 'timeout' | 'unloaded' | 'db_unavailable'
  callId: string
  /** `tool/result` 持久化后的会话序号；未写入则为 null */
  resultSeq: number | null
  content: ContentBlock[]
  isError: boolean
  /** 仅当结果确实进入某个后续 Assembly 时返回 */
  assemblyId: string | null
  /** 该 Assembly 的轮次/步骤，必须与请求一致 */
  consumedAt: { turn: number; step: number } | null
}
```

Host 侧实现应复用，而不是重造：

1. `ToolRegistry.execute({ callId, name, arguments, agent, signal })` 走完整 `tools/pre-execute` → guard → 审批 → 执行 → `tools/post-execute` 管线。
2. 成功后用 `createToolResultMessage({ callId, content, isError })` 生成消息。
3. 以 `session.append('tool/result', { turn, step, message, error?, meta? })` 持久化；返回 `resultSeq`。
4. 下一次 step 的 Assembly 完成后，用 `assemblyId` 与 `consumedAt` 回填；不得提前返回 `injectedIntoContext=true` 或等价字段。

### 2.1 信任边界

- `agentId`、`sessionId`、`turn`、`step` 只能由 Host 的受信运行时提供；请求体不接收调用方自报的这四个字段。
- `reason='verification'` 不是权限：不得跳过 `tools/pre-execute`、guard、Scope/Disclosure、审批、速率限制或工具自身的授权检查。
- verification 入口仅在隔离测试 Profile 开启，且只允许显式白名单中的只读工具（首期仅 `psyche_recall`）；不得暴露给 HTTP、普通插件、用户消息或远程管理 API。`reason='verification'` 仅作为审计标识，不表示模型自主发起。
- 工具结果必须以 `role='user'` + `source.kind='tool'` + `ToolResultBlock` 进入会话；不得写入 system prompt、persona Context 或 `psyche-memory` Section。
- 工具名必须属于当前 Agent 可见工具集；不可见工具返回 `denied`，不泄露其存在。
- 跨 Agent/Session 调用一律拒绝；卸载中的插件工具返回 `unloaded`。

### 2.2 生命周期

```
request
  → 校验受信 agent/session/turn/step（失败 denied；中途 turn 变化则拒绝且不写结果）
  → 校验工具可见性与参数 schema（失败 denied / tool_error）
  → append('tool/call',{turn,step,callId,name,arguments})
  → ToolRegistry.execute（含审批/guard；超时 abort）
  → createToolResultMessage
  → session.append('tool/result')（失败 db_unavailable，不返回 ok）
  → 下一次 Assembly
  → 回填 assemblyId / consumedAt
```

- `callId` 由 Host 生成并与 `sessionId` 绑定；同一 `idempotencyKey` 重放返回既有 `callId/resultSeq`，不重复执行；同会话调用串行裁决。
- 如果 Assembly 异步发生，先返回 `status='ok'`、`assemblyId=null`、`consumedAt=null`，查询态为 `pending`；调用方订阅或轮询回执，不得把“已写入”等同“已消费”。
- 重启时发现未配对的 `tool/call`，进入 `recovery_pending`；明确无法恢复则 `failed`。不自动重放可能产生副作用的工具。
- 工具结果只在当轮或后续轮被真实组装时才算进入模型输入；历史快照中的重复计数不算消费；`injectedIntoContext` 在消费确认前必须为 `false`。

### 2.3 失败语义

| 场景 | 结果 | 约束 |
|---|---|---|
| 工具不可见 / 越权 | `denied` | 不写 `tool/call`、不写 `tool/result` |
| guard/审批拒绝 | `denied` | 不写结果；原因可审计但不含敏感正文 |
| 工具抛错 | `tool_error` | 写 `tool/result` 且 `isError=true`，正文按工具契约脱敏 |
| 超时/取消 | `timeout` | 不写成功结果；迟到结果不得覆盖已终结状态 |
| 重复 `idempotencyKey` | 返回既有结果 | 不重复执行、不重复写事件 |
| 跨 Session 调用 | `denied` | 不泄露目标会话存在性 |
| 插件卸载/重载 | `unloaded` | 不写结果；重载后旧 callId 不可复用 |
| 数据库不可用 | `db_unavailable` | 不返回 `ok`；不得把未持久化结果当作成功 |
| 迟到结果（Abort 后到达） | 丢弃或标记 `late` | 不写入会话，不改变已有结果 |

任何失败都不得把未授权内容写入会话；`tool/result` 只能是已通过管线的内容。

## 3. B4 验收矩阵

| 编号 | 验证 | 预期 |
|---|---|---|
| B4-01 | 同一 Agent/Session/Turn 调用 `psyche_recall`，查询命中种子证据 | `status='ok'`，`content` 含目标正文与 `source_id`，`resultSeq` 非空 |
| B4-02 | 读取该会话 `tool/call` / `tool/result` 事件 | `turn/step/callId` 与请求一致，消息 `source.kind='tool'` |
| B4-03 | 下一次 Assembly 快照 | 目标正文/`source_id` 恰出现一次；`assemblyId`/`consumedAt` 与请求一致 |
| B4-04 | 跨 Contact / 跨 Room 调用 | `denied` 或空结果；快照不出现目标内容 |
| B4-05 | 重复 `idempotencyKey` | 返回同一 `callId/resultSeq`，事件数不增加 |
| B4-06 | 工具不可见/卸载 | `denied`/`unloaded`，无 `tool/result` |
| B4-07 | DB 不可用或 append 失败 | `db_unavailable`，不返回 `ok`，不污染会话 |
| B4-08 | 宿主重启后 | 已完成调用不重复执行；未消费结果仍可在后续轮被组装一次 |
| B4-09 | 结果内容检查 | 不出现 System/Persona/`psyche-memory` 伪装；只在 tool 消息与工具结果块中 |
| B4-10 | 迟到/超时 | 不写入会话，不覆盖既有结果 |
| B4-11 | verification 入口请求非白名单工具或非隔离 Profile | `denied`；不执行、不写 tool/result；审计仅记 reason/工具名 |

B4 只有在 B4-01..B4-11 全过时才可标 PASS；测试 Provider 路线只能证明 B4-01..B4-10 的工具循环，不能替代 H-2 的生产 Provider 最终输入证明。

## 4. 现有接口与目标契约差异表

| 目标能力 | 现有 | 差异 | 需要谁做 |
|---|---|---|---|
| 受信 Agent/Session/Turn 绑定 | `ToolExecutionInput.agent?` 由 loop 填 | 外部没有正式入口 | Host |
| 执行工具 | `ToolRegistry.execute` | 已具备，无需重写 | 复用 |
| tool 消息构造 | `createToolResultMessage` | 已具备 | 复用 |
| transcript 持久化 | `session.append('tool/result')` | 已具备 | 复用 |
| 写入回执 | 无 | 需返回 `resultSeq` | Host |
| Assembly 关联 | 无 | 需 `assemblyId`/`consumedAt` | Host |
| 幂等键 | 无 | 需 `idempotencyKey` 绑定 | Host |
| verification 审计 | 无 | 需记录 reason、调用者、结果摘要（不含正文） | Host |
| 失败关闭 | 分散 | 需统一状态码与不写会话约束 | Host |

## 5. Host 最小改动清单

1. 新增 Host 服务 `ToolInvocationBoundary`（或等价命名），仅在受信运行时内可用，不暴露 HTTP/工具/模型入口。
2. 实现 §2 的请求校验、`ToolRegistry.execute` 调用、`createToolResultMessage`、`session.append('tool/result')`，并返回 `resultSeq`。
3. 在下一次 step Assembly 完成后回填 `assemblyId/consumedAt`；提供只读查询。
4. 增加 `idempotencyKey` 幂等表（Host 内存或持久化均可，需跨重启）。
5. 统一失败状态与审计日志；日志不含工具结果正文。
6. 保持现有 `tools/pre-execute`、guard、审批、Scope/Disclosure 不变。

## 6. 证据等级

- 模块级：Psyche 的 `test/p5r-contract.ts`、`test/persona-runtime.ts` 等，只证明 Core 行为。
- Host 工具循环：本契约的 B4-01..B4-09，证明真实 registry + session + assembly。
- 生产 Provider 最终输入：H-2；本契约不提供，仍 BLOCKED。
- 法证级：与 B4 无关。

## 7. 非目标

- 不改变工具授权模型、不新增工具、不改变 Psyche Schema。
- 不允许 `reason='verification'` 绕过审批或 Scope。
- 不把测试 Provider 的最终输入当作生产证明。
- 不实施 Host 接口，只提交契约与差异清单。

## 8. 冻结记录

- 2026-11-15：两轮外部评审后冻结。评审方要求并已纳入：
  1. 工具调用必须对应当前有效 Turn；先写 `tool/call`，再执行，再写 `tool/result`；中途 Turn 变化拒绝且不写结果。
  2. `reason='verification'` 仅审计；入口只允许隔离测试 Profile + 白名单只读工具（首期 `psyche_recall`），不向 HTTP/普通插件/用户/远程 API 暴露。
  3. `idempotencyKey` 绑定 Session/Turn/Step/工具/规范化参数哈希；同会话串行；重启未配对 `tool/call` 进入 `recovery_pending`，不自动重放副作用工具。
  4. 回执必须证明实际消费：`resultSeq` 来自成功 append；`assemblyId/consumedAt` 只由真实 Assembly 消费钩子回填；文本匹配不算消费；未消费为 `pending`，`injectedIntoContext=false`；仍不等于 H-2。
- 本契约不改变 B4 当前状态：`BLOCKED_BY_HOST_CAPABILITY`；H-2 仍 `BLOCKED`。
