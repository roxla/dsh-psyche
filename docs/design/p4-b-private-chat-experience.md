# P4-B 私聊体验与运维补齐：实施方案（提案）

> 状态：**提案，待用户确认后冻结**。
> 基线：DEV v27.98，Schema v23，4913 断言 / 149 套 / 150 步 / 0。
> 范围：只做插件本体私聊体验；**不启动群聊生产接入（H-2/L-2/I-1/D-3）与群黑话词库（P4-E）**；群回复保持 DISABLED。
> 契约来源：`p4-private-chat-and-multi-im.md` §4；`p4-a-private-chat-freeze.md` 的准入、去重、串行、限频不变量不变。

## 1. 现状（按代码，不凭印象）

- 入站：`src/lib/qq-bridge.ts:242` `oneBotText()` **先取 `raw_message`**，数组消息只拼 `text` 段。图片/表情/语音/文件/引用/at 段被丢弃；旧式 CQ 字符串会原样进入模型，可能带文件路径或 URL。
- 出站：`#sendText()` 只发 `{ message: text }`，无引用、无多行结构；`send_private_msg` / `send_group_msg` 同一路径。
- 串行与去重：每会话内存队列（上限 8）与入站去重已有；**进程重启后队列丢失**，离线消息不补发。
- 配置：`qq.allowFrom`（owner + extra）、`qq.groups`（enabled + allowed）、`qq.provider/model`、`sendTimeoutMs`；**没有按联系人策略**。
- 管理页：`/api/psyche/qq` 只读，含计数与 200 条脱敏 ring buffer；无按会话过滤、无诊断导出。
- 资产：`assets/` 已存在且有 `asset_sha256` 字段，但私聊路径尚未落盘媒体。

## 2. 目标与非目标

目标（按顺序）：

1. 入站消息不再因媒体/引用段而丢内容或把原始 CQ 码塞给模型。
2. 出站支持引用回复与多行文本，不改变既有准入/去重/串行/回执语义。
3. 管理页可定位到单个会话，导出脱敏诊断包。
4. 按联系人开关、静默与频率上限（本地配置，不做主动联系）。
5. 离线队列持久化单独立项，先评估 Schema 影响，不预设新表。

非目标：

- 不发送图片/语音/文件；不做媒体矩阵的「发」方向。
- 不下载远端媒体、不自动转存 URL、不做 OCR/ASR。
- 不开放群聊生产调度与回复；不实现黑话词库。
- 不改 `allowFrom` 的入站授权语义，不把 Owner 名单当主动联系同意。
- 不引入新依赖或 UI 框架。

## 3. 阶段拆分

### B-1 入站媒体与引用识别（无 Schema 变更）

- 解析优先使用结构化 `message` 数组；`raw_message` 只作为**结构化缺失时的受限兜底**。
- 段类型白名单：`text`、`at`、`reply`、`face`、`image`、`record`、`video`、`file`、`forward`；未知段只记类型计数。
- 文本映射：图片 `[图片]`、表情按 `summary`/`[表情]`、语音 `[语音]`、视频 `[视频]`、文件 `[文件]`、转发 `[转发消息]`；同条内多段按原顺序拼接，保留换行。
- 引用：`reply` 段提取 `id` → `Source.reply_to_message_id`；不加载被引用正文。
- 媒体元数据写入 `Source.metadata.media`：`{ type, count, sha256? }`；**不写 URL、file 路径、文件名**。`asset_sha256` 仅在已落盘时填。
- CQ 字符串兜底：只识别白名单标签，`file`/`url` 一律替换为 `[图片]` 等占位；解析失败退化为纯文本并截断，绝不把原始 CQ 串交给模型。
- 安全：不访问远端；日志只记段类型与数量；空文本且有媒体时仍产生占位文本，避免空消息被丢弃。
- 测试：纯文本、混合段、图片-only、引用+图片、at、未知段、CQ 字符串、超长截断、URL/路径不出现在模型文本与日志。
- 验收：模块级 PASS；真实宿主可选（本地 OneBot 发送 mock 媒体段）。

### B-2 出站引用与多行格式（无 Schema 变更）

- `sendOutgoingText()` 增加可选 `replyToMessageId`；仅当来源消息 id 属于当前会话且在有效窗口内才附加。
- OneBot 消息体：`[{type:'reply',data:{id}},{type:'text',data:{text}}]`；无引用时保持纯字符串，兼容旧端。
- 多行原样保留；长文本切分沿用现有策略，不改变重试与 unknown 语义。
- 测试：有/无引用、跨会话拒绝、回执超时 unknown、多行与切分、legacy 后端不接受数组时回退纯文本。
- 验收：模块级 PASS + 本地 mock 回执断言。

### B-3 按联系人策略（本地配置）

- 配置草案（待冻结）：`qq.contacts: [{ stableUserId, enabled?, silence?: {timezone, windows}, maxPerHour? }]`。
- 生效点：准入之后、建 Agent 之前；关闭/静默/超限时**不建会话、不回复、计数**；`allowFrom` 仍是必要条件。
- 计数新增 `contactSuppressed`；不改主动联系 Consent。
- 测试：关闭、静默跨午夜、限额、未知联系人、配置非法 fail-closed、与 allowFrom 叠加。
- 验收：模块级 PASS；真实宿主可选。

### B-4 离线队列持久化（需单独评审 Schema）

- 目标：进程重启后未投递的**普通回复**不丢；不承诺 exactly-once。
- 先给方案：候选表 `qq_pending_replies`（id、session_id、target、text_hash、payload、status、attempts、created/expires）或复用现有 outbox（后者语义是主动联系，**不复用**）。
- 必须先评审：Schema v24、保留期、脱敏、容量、与 C-3a Outbox 的边界。
- 本阶段不直接实现。

### B-5 管理页过滤与诊断导出

- `GET /api/psyche/qq?session=<id>` 过滤计数与日志；未知会话返回空态，不枚举联系人。
- 导出：`GET /api/psyche/qq/diagnostics`（POST 更合适，暂定 POST）返回脱敏 JSON：版本、Schema、配置摘要（无路径/账号）、计数、最近错误码、健康快照；不含正文、Token、完整 QQ 号。
- 测试：过滤、脱敏、空态、超限、无写权限。
- 验收：模块级 + 真实宿主只读检查。

## 4. 顺序与门禁

B-1 → B-2 → B-5 → B-3 → B-4（B-4 单独评审）。

每阶段：`npm run build`、本阶段测试、全量回归、DEV/HANDOFF/README 更新、工作树干净；模块 PASS 不等于宿主 PASS。

## 5. 待确认

1. 媒体「只收不发、只占位不下载」是否接受。
2. B-1 是否保留 `raw_message` 兜底（建议保留但受限）。
3. B-3 配置键与默认拒绝策略。
4. B-4 是否进入本轮，还是先完成 B-1/B-2/B-5/B-3。
