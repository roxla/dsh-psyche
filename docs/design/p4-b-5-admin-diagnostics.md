# P4-B-5 管理页消息过滤与诊断导出（B-5-1/2/3 冻结稿）

> 状态：**B-5-1/2 已实现（v28.01，44 断言）；B-5-3 页面与隔离 Host 验收完成（v28.02；功能 PARTIAL，H13 匿名可读记 Host 鉴权 PARTIAL）**
> 依据：DEV v28.00 / `c7c1bfc` / Schema v23（57 表、34 触发器）/ 全量 4977 断言 / 151 套 / 152 步。
> 前置：P4-B-1、P4-B-2 模块级 PASS；P4-A-5 Host API 认证 PARTIAL 仍 OPEN。
> 本文只冻结字段、过滤语义、分页与导出鉴权边界；不写页面、不改代码。

## 1. 目标与非目标

目标：

1. 让管理页能按**方向、目标类型、联系人或群（脱敏引用）、时间、处理结果**筛选，并分页查看诊断事件。
2. 展示媒体类型/计数、引用结果、Transport 四态结果的聚合或逐条诊断。
3. 提供**默认关闭、失败关闭**的脱敏 JSON 导出；没有服务端可信鉴权时只返回拒绝，不返回数据。

非目标（本轮明确不做）：

- 不新增 SQLite 表、不改 Schema、不复制业务消息数据库。
- 不把现有未持久化的消息正文、媒体 URL/路径、CQ 原文补写进日志或诊断。
- 不提供重发、补发、编辑、删除、写入或任何管理写入口。
- 不读取 Source/Event/Artifact 正文，不做全文搜索。
- 不顺手修 Host 鉴权架构；Host 认证仍是独立 PARTIAL。
- 不提前实现 B-3 联系人策略或 B-4 离线队列（B-4 仍需单独立项 Schema）。

## 2. 数据源原则：两桶，不混

| 桶 | 内容 | 生命周期 | 是否持久化 |
|---|---|---|---|
| 运行计数 | 现有 `QqBridgeAdminSnapshot.counts`：received / delivered / sendErrors / rejected / rejectReplies / rateLimitedDrops / rejectSendErrors / outOfScopeDrops | 进程启动起，重启归零 | 否 |
| 运行诊断事件 | 新增有界内存环形缓冲（上限 200，FIFO，`seq` 单调递增） | 进程启动起，重启归零 | 否 |

关键边界：

- 诊断事件不是业务消息记录：**没有正文、没有原始 `message`、没有 CQ 字符串、没有媒体 URL/文件名/路径、没有原始 QQ 号、没有 `stable_user_id`、没有 session/数据库内部 id**。
- 事件在**写入缓冲之前**完成脱敏与字段白名单构造；缓冲里不存可还原的原始值。
- 不读取、不回填历史；服务端重启后旧事件不存在，导出也只能导出当前进程内存中的内容。
- 事件只用于诊断展示与脱敏导出，不参与准入、去重、限频、Outbox、发送或记忆写入。

## 3. B-5-1 诊断事件字段白名单

服务端内部可接收的原始输入（仅在构造时短暂存在）：

- `direction: 'in' | 'out'`
- `target: { kind: 'private'; userId: string } | { kind: 'group'; groupId: string }`
- `result: QqDiagnosticResult`（见下）
- `errorCode?: string`（只接受稳定枚举，不接受自由文本）
- `quote?: 'applied' | 'omitted-unbound' | 'omitted-unsupported'`
- `media?: Array<{ type: string; count: number }>`
- `textLength: number`
- `at: Date`

对外 `QqDiagnosticEvent`（缓冲与 API 中只存在这个结构）：

```ts
type QqDiagnosticResult =
  | 'accepted'        // 已交给 Transport / 桥已接受
  | 'delivered'       // 入站已投递给 Agent
  | 'rejected'        // 未授权私聊
  | 'rate_limited'    // 冷却/额度拒绝
  | 'out_of_scope'    // 群聊/未知类型等静默丢弃
  | 'deduplicated'    // 入站去重命中
  | 'failed'          // 明确失败
  | 'unknown'         // 结果未知（超时/断连/ACK 丢失）

interface QqDiagnosticEvent {
  seq: number                          // 进程内单调递增
  at: string                           // ISO-8601
  direction: 'in' | 'out'
  platform: 'qq'
  target: 'private' | 'group'
  contactRef: string | null            // 私聊：maskQqId(userId)；群：null
  roomRef: string | null               // 群：maskQqId(groupId)；私聊：null
  result: QqDiagnosticResult
  errorCode: string | null             // 稳定枚举；无则 null
  quote: 'applied' | 'omitted-unbound' | 'omitted-unsupported' | null
  media: Array<{ type: 'image' | 'mface' | 'face' | 'record' | 'video' | 'file' | 'forward' | 'json' | 'xml' | 'dice' | 'rps' | 'shake' | 'poke'; count: number }>
  textLength: number                   // 0..10000，仅长度
}
```

禁止字段（出现即测试失败，评审按安全缺陷处理）：

- `text` / `message` / `rawMessage` / `content` / `body` / `cq`
- 媒体 `url` / `file` / `path` / `filename`
- 完整 QQ 号、`stableUserId`、`sessionId`、`contactId`、`eventId`、`sourceId`、DB 路径
- 任何令牌、Cookie、Authorization、Host 头
- 堆栈、异常对象原文

脱敏规则：

- `contactRef` 复用 `maskQqId`（长度 ≤5 全星；否则前 3 + `****` + 末 2）。
- `roomRef` 同理；群号与 QQ 号在展示上不可区分，避免泄露群标识。
- `errorCode` 只接受白名单枚举；未知值折叠为 `'other'`，不保留原始字符串。
- `textLength` 仅整数；不存首尾字符、不存摘要。

## 4. 过滤契约（B-5-1）

### 4.1 路由

`GET /api/psyche/qq/diagnostics`

只读；非 GET → 405；`Cache-Control: no-store`；响应 200；错误走统一 `httpErrorBody`。

### 4.2 查询参数

| 参数 | 类型/白名单 | 语义 |
|---|---|---|
| `limit` | 整数 1..100，默认 50 | 本页条数；越界 400，不静默截断 |
| `before` | 整数 ≥1 | 只返回 `seq < before` 的事件（倒序游标） |
| `direction` | `in` / `out` | 精确匹配 |
| `target` | `private` / `group` | 精确匹配 |
| `result` | 见 `QqDiagnosticResult` | 精确匹配，可逗号分隔多个（OR） |
| `contactRef` | 字符串，长度≤32 | 精确匹配 `contactRef`；私聊用 |
| `roomRef` | 字符串，长度≤32 | 精确匹配 `roomRef`；群用 |
| `from` | ISO-8601 时间 | `at >= from` |
| `to` | ISO-8601 时间 | `at < to`（右开） |

规则：

- 所有条件 AND；`result` 内部 OR。
- 未知参数、非法枚举、`limit` 越界、`time` 不可解析、`from >= to` → 400 `E_DIAGNOSTICS_FILTER`，消息只说明哪个参数非法，不回显值。
- 不提供正文搜索、正则、通配符、模糊匹配。
- 服务端过滤后再分页；排序固定 `seq DESC`；`before` 与 `limit` 组合实现游标分页。
- 返回 `{ ok: true, generatedAt, items, nextBefore: number|null, matched: number }`；`matched` 为当前过滤条件下总条数（≤200，内存计数）。
- `contactRef`/`roomRef` 是展示用脱敏引用，不是身份键；不能用于关联 Source/Event 或反查原始 QQ 号。

### 4.3 前端展示

- 筛选条：方向、目标、结果、时间范围（from/to）、脱敏联系人/群引用；不做自由文本搜索。
- 列表列：时间、方向、目标、脱敏引用、结果、错误码、引用结果、媒体类型×计数、文本长度。
- 分页：上一页/下一页 + 当前页范围；空态明确；错误态显示通用错误，不展示内部值。
- 不提供重发、复制原文、跳转 Source 或任何写入按钮。

## 5. B-5-2 导出契约与鉴权边界

### 5.1 路由

`GET /api/psyche/qq/diagnostics/export`

- 与查询共用同一套过滤参数与校验；导出条数上限 200、响应体上限 256 KiB。
- 响应 `application/json; charset=utf-8` + `Content-Disposition: attachment; filename="psyche-qq-diagnostics-<utc>.json"`；`Cache-Control: no-store`。
- 导出结构：

```json
{
  "exportedAt": "...",
  "filter": { "direction": "in", "target": "private", "result": ["delivered"], "from": null, "to": null, "contactRef": "100****01" },
  "counts": { "received": 0, "delivered": 0, "sendErrors": 0, "rejected": 0, "rejectReplies": 0, "rateLimitedDrops": 0, "rejectSendErrors": 0, "outOfScopeDrops": 0 },
  "items": [ /* QqDiagnosticEvent 白名单 */ ]
}
```

- 不导出：正文、原始消息、媒体 URL/路径、完整 QQ 号、`stableUserId`、session/DB id、令牌、Host 头、日志原文、堆栈。
- 不导出 `logs`（现有运行日志可能有自由文本）；只导出结构化诊断事件与聚合计数。

### 5.2 鉴权（失败关闭）

当前 Host 对 `/api/psyche/*` 的匿名可读仍是 **Host 级 PARTIAL**（`docs/audit/dsh-host-plugin-api-auth.md`）。因此：

- 导出接口必须经过**服务端可信鉴权**，不能只靠前端隐藏按钮。
- Psyche 不自行发明可由前端携带的令牌（会被匿名读取），也不信任 `Host`/`Origin`/自定义头作为身份。
- 只有当 Host 提供可验证的管理员身份或已认证路由能力时，`exportAllowed()` 才返回 true。
- 当前实现默认 `exportAllowed() === false`：导出返回 **403** `{ ok:false, error:{ code:'EXPORT_AUTH_UNAVAILABLE', message:'导出需要宿主可信鉴权，当前未启用' } }`，**响应体不含任何事件或计数**。
- 页面在鉴权不可用时隐藏导出按钮，并显示「导出未启用（宿主鉴权缺失）」。隐藏按钮不是访问控制，服务端 403 才是。
- 不把 B-5 的导出描述成已修复 Host 认证；安全登记保持 OPEN，B-5 报告记 **PARTIAL（导出功能禁用）**。

## 6. B-5-3 页面与隔离 Host 验收

模块级测试：

1. 事件构造：每个 result 的字段集合、媒体白名单/计数合并、`textLength`、`contactRef`/`roomRef` 掩码、`errorCode` 白名单折叠。
2. 禁止字段扫描：序列化后不得出现 `text`、`url`、`file`、`path`、完整 QQ 号、`stableUserId`、`sessionId`、`ct_`/`src_`/`evt_` 前缀。
3. 过滤：单条件、组合 AND、`result` OR、时间左闭右开、`before` 游标、`limit` 边界、非法参数 400。
4. 分页：满页/末页/空集/`nextBefore` 正确、`matched` 一致。
5. 导出：无鉴权 403 且无数据；有鉴权（测试注入）时白名单字段、条数上限、`filter` 回显、大小上限。
6. 环形缓冲：200 上限、FIFO、`seq` 单调、重启（新实例）清空。

隔离 Host 验收（复用 P4-A-4 的 profile 思路）：

- H-B5-1 页面渲染筛选条/列表/分页，无 React 错误。
- H-B5-2 筛选组合与时间范围结果正确。
- H-B5-3 分页边界（首/末/空）与 `limit` 400。
- H-B5-4 页面与 API 均无正文/URL/完整 ID；脱敏扫描通过。
- H-B5-5 导出按钮不可用；直接请求导出返回 403 且无数据。
- H-B5-6 卸载/重载后内存事件清空、页面恢复。
- 记录 profile、dataDir、场景编号；模块 Mock 不替代 Host 结果。

## 7. 实现落点（预计）

- `src/lib/qq-diagnostics.ts`：事件类型/白名单构造/环形缓冲/过滤/分页/导出视图。
- `src/lib/qq-admin.ts`：复用 `maskQqId`；不改现有计数与日志语义。
- `src/lib/qq-bridge.ts` / `src/index.ts`：在既有准入、投递、拒绝、发送结果点写入诊断事件；**不改变控制流**。
- `src/index.ts`：新增两条 GET 路由；导出鉴权钩子默认 false。
- `src/client/index.ts`：QQ 页签增加筛选/分页/诊断列表；导出按钮按能力开关。
- `test/qq-diagnostics.ts`：模块测试；`test/qq-admin.ts` 补过滤/导出边界。

## 8. 交付顺序与放行

1. **B-5-1**：字段白名单 + 事件缓冲 + 查询/过滤/分页 + 模块测试。PASS 条件：无新增持久化、无禁止字段、过滤/分页测试全绿。
2. **B-5-2**：导出结构 + 鉴权钩子默认关闭 + 403 测试。PASS 条件：无鉴权不泄露任何数据；导出启用路径仅由测试注入。
3. **B-5-3**：页面 + 隔离 Host 验收 + 报告/DEV/HANDOFF/README + 提交。报告明确「导出 PARTIAL（Host 鉴权缺失）」。
4. H-2 继续并行，不阻塞 B-5；B-3/B-4 保持未开始。

## 9. 待用户确认

1. 是否接受「诊断事件」为**新增内存环形缓冲**（上限 200、重启清零、无正文/无 URL/无原始 ID），而不是只做现有计数的聚合筛选。
2. 导出在 Host 鉴权缺失时**固定 403 且不返回数据**，B-5 报告记 PARTIAL；是否同意不为此修改 Host 鉴权。
3. `contactRef`/`roomRef` 采用 `maskQqId`（前 3 + 后 2）是否足够；不接受则改为不可逆短哈希（如 sha256 前 10 位，进程内盐）。
