# P4-D-2 群聊调度、水位与输入证明契约

> **D-2-0 v1冻结（历史v27.94）；当前v27.97，2026-11-14。** D-2 `5f325c5`、H21 `3481be4`、白名单/Room-only注入 `b8057d6`、群工具隔离 `bde11a4`；模块与22项新增隔离Host检查PASS，整体仍待评审/PARTIAL，不启用真实群回复。详见[汇总](../audit/p4-d-2-module-acceptance.md)。
> D-2-0当时基线v22/49表/16触发器、4396/141/0；当前 **v23/57表/34触发器、4858断言/148个断言套件/149步/0失败**。
> 本文精化并修订 [D-0](p4-d-group-chat-freeze.md) §4–11；D-1 的最小记录、不可升级重放及历史验收保持。未经相应 D-2-4 实测的能力不得据本文件宣布可上线，真实 QQ 多群仍待 D-3。

## 1. 范围与冻结决策

目标是回答四个可核查的问题：什么事件触发了本批，哪些正文完整进入了哪次模型请求，哪次 Turn 正常且持久地结束，以及哪条回复获得了什么发送结果。

| 编号 | 冻结决策 | 实施位置 |
| --- | --- | --- |
| C1 | `read_through_seq` 是连续处理确认水位；省略记录与真实模型展示分别记证据 | §3、§6 |
| C2 | @、可信 self reply、精确点名在第一次保留决定前识别；重放不得补采正文 | §2 |
| C3 | 真实 Adapter 输入回执、正常 Turn、持久化检查点三者齐备才确认保留正文 | §5 |
| C4 | `followup()`、入口串行、`whenIdle()`、`turn-stopping` 都不能单独证明某批完成 | §7 |
| C5 | 同 Room 单飞覆盖提交、Turn、完成落库及出站结果结算；跨 Room 上限 4 | §4、§7 |
| C6 | 成功群回复的实际平台消息 ID 绑定到同 Room 的 self Source，才能成为后续引用触发证据 | §8 |
| C7 | 入站去重不保证出站 exactly-once；出站 unknown 不自动重发 | §8、§9 |
| C8 | 群作用域、来源 Transport、账号和运行代际全程绑定；群成员的私聊身份不参与授权或 Recall | §5、§7 |

不做 P4-E、概率唤醒、主动开话题、Outbox 扩容/宿主注册、HTTP 写入口或 Host 认证整改。不重构私聊与记忆内核。D-3 才做真实 QQ 多群验收。

## 2. 首次采集、触发与完整 Room 策略（D-2-1）

### 2.1 配置

以下为 **D-2-0 冻结、v27.95 已实现的格式**。`groups.enabled` 控制采集，`reply.enabled` 独立控制调度；两者默认 false。打开采集不等于打开回复；缺受信最终输入证明时仍只采集。

```jsonc
{
  "qq": {
    "groups": {
      "enabled": false,
      "allowed": [{
        "externalRoomId": "123456789",
        "captureMode": "mentioned_only",
        "names": ["心灵"],
        "triggers": { "at": true, "reply": true, "name": true },
        "reply": { "enabled": false },
        "merge": { "quietMs": 2000, "maxWaitMs": 8000, "maxMessages": 20, "maxChars": 4000 },
        "silence": { "mode": "all", "timezone": "Asia/Shanghai", "windows": ["23:00-08:00"] },
        "maxTurnsPerHour": 6
      }]
    }
  }
}
```

严格校验，不转换字符串数字/布尔值，不忽略未知字段：根配置非法则全拒；条目任一字段非法则该群整项失效；重复群号的所有条目失效。保留 D-1 字段及默认值：`captureMode=mentioned_only`、`silence.mode=all`、`windows=[]`；时区始终必须显式提供且经 IANA 校验。

新增缺省值：`names=[]`，三个 trigger 开关均 true，`reply.enabled=false`，merge 使用上例初值，小时限额 6。限额整数 1..6；`quietMs` 整数 1..2000，`maxWaitMs` 整数 quietMs..8000，`maxMessages` 整数 1..20，`maxChars` 整数 1..4000。并发 1/4、等待队列 50 是本版固定上限，不开放配置。名称最多 16 个，每个 NFC 后 1..32 个 Unicode 码点，只含 Unicode 字母、数字或 `_`，精确区分大小写，规范化后重复/空名称非法；不从账号昵称自动导入。

静默窗口为 `HH:mm-HH:mm`、左闭右开，支持跨午夜；起止相等非法（不用它表示全天），多个窗口取并集。按可信当前时刻转换到该 IANA 时区判断，DST 重复时刻均适用，跳过时刻不补执行。时区错误不回退宿主时区。

解析器返回不可变的完整 `RoomPolicy`（含规范化策略摘要 `policyHash`），不再只返回 `Map<群号, captureMode>`。模型、普通工具、HTTP 无权构造或修改可信策略。每次采集、领取和发送重新确认当前策略；策略摘要改变使旧的待回复批次失效，不让旧批次继承新权限。

### 2.2 首次保留与独立 token

桥接先验证普通群事件、白名单、来源账号和结构化消息段，再生成判定材料；Core 在首次 `#write` 中按可信策略复核，**不能只相信调用方给的 `mentioned=true`**。

| 判定 | 可接受材料 | 不接受 |
| --- | --- | --- |
| at | 当前顶层 OneBot `at` 段的 qq 精确等于当前已验证 self_id | raw_message 中的 CQ 字符串、@all、昵称文本 |
| self reply（唤醒） | 顶层 reply.id 命中同平台、同账号、同 Room 的可信成功发送绑定，且关联 Source.origin=self | 跨群 ID、模型给的 sourceId、仅有 origin=self 的未发送输出 |
| name | 当前顶层 text 段的完整独立 token 等于 names 中一项 | 模糊包含、旧引用/转发原文、检索内容、自动展开的 quote |

相邻 text 段先拼接再切 token，不能用人为分段把「小心灵」切成「小」+「心灵」伪造边界。token 是连续的 Unicode 字母/数字/组合标记/下划线；空白、标点和真实非 text 段形成边界。NFC 后精确比较，偏移同时映射回原文。例：`心灵，你觉得呢？` 命中；`小心灵`、`心灵2`、`心灵你觉得呢` 不命中。独立名称出现在当前用户自己键入的普通文本中时按此词法规则处理；不增加自然语言意图猜测。

只解析当前消息顶层段；reply/forward/node 内的历史内容不拼进 name 输入，也不因引用正文有问号/昵称而唤醒。问句标志只作已被 at/reply/name 叫到后的说明，**没有独立 question 触发开关**；D-0 草案的 `question:true` 被本节取代，单独问号永不触发。

保留规则为：`all_visible_messages OR atMatch OR captureSelfReplyMatch OR nameMatch`。`captureSelfReplyMatch` 保留 D-1 已验收的同 Room self Source 引用采集规则（可信成功 binding 也满足）；但**采集选择不等于唤醒资格**，`triggerSelfReplyMatch` 必须满足上表的发送绑定。旧 Source 的引用可保留正文而不获准唤醒，不能用源于模型的 self 声明推导已发送。v23 已有 binding 存储；缺可信成功绑定时调度资格仍不可用，原 D-1 采集测试语义不改。

三个 triggers 开关只控制是否唤醒，不授予更大的采集范围；有效名称可在 reply 关闭时用于采集。对保留 Source 的 metadata 记录判定版本、策略摘要、理由和所需段/偏移引用，区分仅采集的 legacy self 引用，不复制正文。Source/Event/序号与首次决定仍原子写入；未保留记录只存 D-1 的最小字段，不另存正文、逐消息发件人或触发候选。

当前 Source 写入会 trim 文本；D-2-1 的匹配偏移须映射到实际保存的 Source.text，不能拿未 trim 的偏移冒充可重建证据。完整展示以保存的文本为基准，不声称还原平台消息的所有空白、图片或其他非文本载体。

同一 message_id 重放保持原决定，不能把 source_id=null 升级成 Source。历史 D-1 保留消息可作同 Room 上下文，但没有可信首次触发材料的历史记录不反推新唤醒理由；已有 self Source 的旧平台 ID 若缺可信发送来源，不据此伪造 D-2 发送绑定。必须有新收到且首次验证的触发事件，才启动一轮新调度。

## 3. 三种事实与连续水位（D-2-2）

保持 `room_message_seq` append-only，不增写它的 source_id，不把调度状态塞回历史 Source。每个位置可以有以下处理依据：

| 位置状态 | 条件 | 可跨过该位置推进水位 | 表示模型读到正文 |
| --- | --- | --- | --- |
| `policy_omitted` | 原映射 source_id 和 event_id 均为空，源于已通过的最小采集策略 | 是 | 否 |
| `model_processed` | 可信 Source/Event 完整且同 Room；§5 全输入与正常完成证明齐备 | 是 | 仅证明其文本投影完整交给受信 Adapter，不证明模型理解 |
| `deferred` | 保留正文尚未展示、超长、预算未选中、静默、限频、队列满或断线 | 否 | 否 |
| `incomplete` | 部分/截断、取消、异常、超 token、证明缺失或刷盘失败 | 否 | 不得宣称完整处理 |
| `invalid` | Source 丢失/隔离、引用损坏、跨 Room、证据不一致 | 否；停止该位置确认并报警 | 否 |

`deferred/incomplete/invalid` 是可复核的运行处置，**不是允许跳过保留正文的终结确认**。不得把“静默忽略”“限频拒绝”“模型说已读”记成 model_processed。无 Source 的有效最小记录才是 policy_omitted；Source 曾存在后丢失不能降格为 policy_omitted。

定义 `ack(seq)` 为存在有效的 policy_omitted 或 model_processed 证据。一次 `BEGIN IMMEDIATE` 内验证证据并追加确认，然后从旧水位向后逐项检查，取连续满足 ack 的最大序号；不得超过 last_seq，不得回退。Source-null 前缀可在不创建 Agent 的情况下确认。确认写入走 Core `#write` 的 opId/参数 hash/重放契约，不给模型水位工具。

| seq | 事实 | 本例确认 |
| --- | --- | --- |
| 1 | 未保留正文 | policy_omitted |
| 2 | 保留正文，完整输入且 Turn 正常结束 | model_processed |
| 3 | 未保留正文 | policy_omitted |
| 4 | 保留正文，完整输入且 Turn 正常结束 | model_processed |

此时水位为 4，模型展示证据集合只为 `{2,4}`；不能说模型读过 1/3。若 2 部分展示而 4 成功，则水位停在 1，4 的确认单独保留；后来补齐 2 才能连续推进到 4。水位落后不禁止后续合法触发，但不能导致重复回复已处理的 4。

UI/报告称其“连续处理水位”；同时分别给出 omitted、processed、pending、invalid 数量。`last_seq-read_through_seq` 是连续确认滞后量，不是实际尚未展示正文数。

**模型处理确认与发送是两条独立轴**：完整处理的 Turn 即使回复发送失败/unknown，仍可推进该批的处理确认；发送成功不能弥补缺失输入证明，也不表示用户阅读了回复。

## 4. 合并、快照与有界调度（D-2-2/3）

### 4.1 选取与展示预算

第一次合格触发开启窗口；同 Room 后续已准入的新入站位置重置安静计时，包括不保留正文的位置，但不把其正文留在内存持久缓冲。到 `lastArrival+quietMs` 或 `firstTrigger+maxWaitMs` 较早者封批。去重重放不重置计时；封批之后的消息进入下一窗口。计时使用可注入时钟，序号按落库顺序，不用平台时间戳重新排序。

8 秒约束的是合并窗口，不是排队或完整 Turn 的响应时限；排队等待与模型/发送耗时分别观测。

封批在只读一致快照中固定 `snapshotLastSeq`、未完成的保留 Source 引用和触发集合。只选当前 Room 的保留文本，按 seq 升序；无 Source 的位置不伪造占位正文。展示上限 **20 条、4000 个 Unicode 码点**，包含消息分隔和发件人局部代号的固定包装，不含 system prompt；它不是整个 LLM token 上限。

本版**整条选入或不选入，不截断正文**。至少有一条本窗口合格触发必须完整选入，否则不开 Turn，标记 `oversize` 等原因。先给最早的、能够完整容纳的触发预留预算，再从旧到新填入能容纳的未处理上下文；输出最终仍按 seq 排序。未容纳条目保留 deferred，不因有较新 seq 被展示而确认。超过单批上限的历史上下文只能依附尚未消费的触发或新的明确触发继续处理，不能自行唤醒一个“清积压”Turn。

文本投影算法版本固定：完整复制 Source.text 的文本内容，外加明确的不可信用户内容边界和本批局部发件人代号；结构化 at/reply 的显示形式须可由首次材料重建。只证明文本，不证明图片/语音内容被理解。正文缺失、投影不能重建或单条超预算时不标完整。模型文本不出现内部 Room/Contact/Source ID、完整 QQ ID、操作句柄或私聊授权；局部代号仅本 Room 内关联。

快照只存引用、版本、顺序、长度和 hash；正文仍从原 Source 读取。快照一旦封存不可追加/替换；已封批不合并，不用 UPDATE 历史正文修复预算或触发决定。

### 4.2 领取、静默、限频和背压

每 Room 最多一个活动批；全局最多 4 个持有执行槽的批；待执行封批队列最多 50 个（不含 4 个活动批）。每 Room 按封批顺序，Room 之间轮转公平领取。queued 至 finalizing 的成员/触发均有排他领取约束，后续快照不能同时消费它们；终态后才释放未确认成员。先确认当前代际、Room active、策略、来源连接、预算和可用槽，再以事务领取；事务外提交 Host 和发送。

静默 mode=all 时不启动 Turn；direct-only 只允许本版 at/reply/name，因没有普通聊天唤醒，本版两种模式均不授权普通消息发言。静默结束不补发；被静默挡住的触发消费为“本次不执行”，正文仍 deferred，等待新的明确触发重新带入。小时限额以 Room 为键、滚动 60 分钟，预留与领取同事务；提交 Host 后即保守计一次，失败/unknown 不退额度，提交前确定取消才释放预留。达到限额的触发同样不在整点自动补发。

保存最近调度决策的可信墙钟时间；若检测墙钟回拨，停止新领取并告警，直到时间恢复，不用回拨清空配额或提前到期。窗口计时使用单调时钟，持久恢复以记录的绝对边界重新校验；不把进程启动时间当配额窗口起点。

队列满增加 queueOverflow，保留已落库正文及待调度触发引用，不新建无限 Promise/内存队列或无限封批行。容量释放可按 Room 公平扫描这些引用，重新复核策略/静默/限额；未过闸的旧触发不能靠恢复扫描绕过“须新触发”规则。窗口打开时只保留边界/计时引用，不复制正文。D-1 入库前的入口队列上限 8 与此处 50 批不同：入库前拒绝仍须单独计数，不能承诺平台会重投已经丢失的事件。

queueOverflow 按同一窗口首次封批被容量拒绝计一次；对同一窗口的恢复扫描或事件重放不反复累加。

连接中断时不领取新 Turn。排队批次先暂停，恢复连接后重验；未提交、同代际、未受静默/限额拒绝的批次可继续。已提交批次按 §9 恢复，不能仅凭水位落后重新 followup。

## 5. 实际模型输入与正常完成证明（D-2-2/4）

### 5.1 证明链

完整证明必须能从 SQLite 元数据与 Host 的持久会话事件重建以下链路：

1. **封存快照**：batchId、内部 roomId、persona=main、platform=qq、来源 transportId/账号指纹、policyHash、运行 epoch、snapshotLastSeq、按 seq 排列的 sourceId/eventId、原文 hash、投影版本/hash/码点长度。每个成员整条展示，不能用首尾 seq 冒充成员全集。
2. **可信输入身份**：创建不可变 Host UserMessage，用其隐藏 message.id 关联本批；batchId 等操作标识不写到模型正文。按 scoped `agent/pre-step` 确认该 message.id 由本次 Host 真正领取并绑定具体 sessionId/agent/turn/step。单靠 role=user 或可见标记不可信。
3. **最终 Adapter 输入回执**：受信 Adapter 的实际 stream 入口（或 Host 等价的不可变最终边界）为每个请求 attempt 出具私有回执；含会话/Turn/step/attempt、实际 provider/model、普通对话用途、输入消息身份及最终 messages/system 的规范化 hash，并逐项记录本批投影在最终输入中的完整匹配。原文片段、内部 ID 或模型自报不能制造此回执。
4. **请求结果**：与回执同一次请求对应的终结结果；仅 stop 可作为最终文本步骤的成功，tool-calls 只允许作为同一 Turn 的中间步骤。max-tokens、aborted、error 或无终结均不算完整处理。模型重试每次独立记 attempt，不能把几次部分展示拼成一次完整展示。
5. **正常且持久的 Turn 结束**：同 session/agent/turn 的 `turn/end.reason.kind=completed`；调用 Host `SessionStore.flush(session)` 并得到 true、所有监听器成功，随后可从持久会话日志定位本次输入、步骤和 completed 结束。false（无持久化参与者）或抛错都不确认。
6. **Core 确认**：在事务内再次核对身份、同 Room 引用、epoch、封存 hash 与完整回执，追加 model_processed，并计算连续水位。只存证明引用/hash/状态，不复制请求正文到调度表。

中间工具步骤也必须保持 group Scope；最终用于回复的成功步骤必须再次完整含有本批投影及对应回执。任一步发现跨域、投影替换或不受信请求，即使后一步正常完成，本批仍 incomplete，不发送。正常的请求失败重试本身不授权发送，只有后续独立完整成功且整 Turn 正常结束才可确认。

规范化 hash 使用 SHA-256，UTF-8 编码，版本化的固定键序 JSON，保留数组顺序、完整文本及角色/内容块；不 trim、拼接丢字段或用 JSON 的非确定键序。Source 原文 hash 与模型投影 hash 分开，receipt 还须包含完整最终请求摘要。hash 证明一致性，**回执权威来自进程内不可伪造的生产者能力与调用边界**，不是“知道 hash 就有权限”。

### 5.2 已核对的 Host 能力及待验证边界

本机依赖的 `@deepseek-ai/dsh-agent`（0.0.1-rc.5）、dsh-session、dsh-llm 的公开类型/实现提供了以下语义；D-2-4 必须对实际宿主复验，不能只据类型判定通过。

| 接口/事件 | 可证明的内容 | 不能替代的证据 |
| --- | --- | --- |
| `agent.followup()` 返回 void | 消息已提交入口 | 模型处理/Turn 完成 |
| `agent/pre-step` | agent、turn、step、待领取消息身份 | 最后给 Adapter 的输入 |
| `agent/request` | 带 turn/step 的请求配置边界 | GenerateOptions 自动具有 turn/step/requestId |
| `request/context` | provider/model/contextWindow 等路由元数据 | 正文或展示范围 |
| Psyche 现有 FinalCheck/manifest | 守卫所在位置的注入检查 | 更内层异步流未修改输入、最终请求不可变 |
| `agent/turn-stopping` | 即将尝试结束；之后仍可能有下一步 | Turn 已终结 |
| `turn/end` | 具体 Turn 的结束原因已提交给会话 | 会话日志已经刷盘 |
| `whenIdle()` | Agent 驱动/维护任务已静止 | 某条输入对应的 Turn 正常结束 |
| `SessionStore.flush(session)` | 有持久化参与者且全部成功时为 true | 仅监听 turn/end 就足够持久 |

`GenerateOptions` 只有 sessionId 等字段，没有 turn/step/requestId。实现必须把 pre-step 的确切 message.id 与受信请求闭包、attempt 关联；禁止猜“该 Session 最近的一轮”。purpose 为 compaction/session-title 的调用不能确认本批。关联不唯一就拒绝本批。

**最终输入证明是启用闸，而非假定已有的 Host 能力。** 本地固定 Provider 可以在其真正 Adapter 入口生成回执并作为 D-2-4 证据；生产 Provider 也必须具有经验证的同等边界。只在外层 llm/stream 取快照、注册一个普通 Context 或设置 verified 标志均不满足此要求。若生产 Host 无法提供，不擅自替换其他插件 Provider、不伪造宿主接口：保持只采集，记录 proof-unavailable，另报 Host 能力缺口。

既有 [R6 多插件报告](../audit/p2-r6-5-multi-plugin.md) 的流消费时改写/消息元数据可篡改等 Host 级 NO-GO 继续存在。本契约的输入证据限于受信执行链的实际入口，不声称防御任意同进程恶意插件，也不证明上游模型服务内部如何处理请求。

## 6. 持久化边界与未来迁移（D-2-2）

本次不改 v22 SQL、SCHEMA_VERSION、表数或触发器。D-2-1 的首次判定材料可写入新 Source 的既有 metadata；实际调度/确认/回复启用前，D-2-2 必须提交独立递增迁移，按当前顺序拟用 **v23**（若被其他已批准迁移占用则重新核版本）。不把 E-1 表并入该迁移。

以下是必须持久化的逻辑记录及约束；允许在迁移评审中合并物理表，但不得删掉所列证据或改成第二套可改正文库：

| 记录 | 必需字段/约束 |
| --- | --- |
| 调度所有者 | 规范化 DB 的唯一运行所有者、持久 epoch、账号/transport 绑定；复用现有内核独占租约方法，拒绝两个宿主同时调度同一库 |
| 首次触发处置 | Room+seq+策略摘要、理由、armed/claimed/suppressed/consumed、稳定原因码；只引用保留 Source，唯一领取同一触发 |
| batch / members | 不可变身份/策略/快照范围/投影摘要、显式成员序号和 Source/Event 引用；可变生命周期及 Host 输入/Turn 定位；活动成员排他领取 |
| request receipts | 每个 attempt 的调用身份、输入 hash、成员完整匹配、路由、finish、结束/flush 引用；不复制请求正文；终结证据 append-only |
| seq confirmations | `(room_id, room_seq)` 唯一最终确认；policy_omitted 或 model_processed 的对应证据、版本、时间；不能 UPDATE 变造结论 |
| reply intents | 每批唯一 responseSlot=0、回复 Source 引用/hash、来源账号/Room/transport/epoch、处理证明引用、prepared/dispatching/sent/failed/unknown/cancelled、receipt/稳定错误码 |
| reply bindings | `(platform, account_key, room_id, platform_message_id)` 唯一；只由成功回执关联 self Source 与 intent；append-only，不从文本推导 |
| quota reservations | Room、batch、预留/提交时间，滚动窗口计数；同批幂等，事务内预留，不能用进程计数绕过重启 |

数据预检覆盖 v22 映射/Source/Event 同 Room、已有水位是否有证明、重复 ID、有效旧 self 来源及 epoch。v22 的零水位不反推任何 model_processed。升级有冲突整版回滚，不能清库、补造正文/回执或把历史水位直接对齐 last_seq。补升级/幂等/冲突回滚/双驱动及跨进程领取测试。

v22 历史回填允许 `source_id!=null,event_id=null`；它不属于 policy_omitted。可经既有 event_sources 找到可信同 Room Event 后，把该 Event 引用写入新的证明记录，不改映射；没有合法 Event 则该位置 invalid，不补造过去已经处理的事实。新鲜触发仍可处理其他合法位置，连续水位保留该缺口。

SQLite 与 Host 日志不能跨库原子提交：先 durable receipt 与 Host flush，再以 Core 事务确认。崩溃后若证明链完整，可仅补确认和终态；证明不完整则 incomplete。任何恢复都不得因补写确认而重新发送。持久化不可用时不提交新 Host 输入或发送，不用空快照伪装成功。

## 7. 批次与 Room Turn 状态转换（D-2-3/4）

| 当前状态 | 事件与前提 | 下一状态/动作 |
| --- | --- | --- |
| collecting | 合格触发后窗口结束、快照含完整触发、队列有容量 | queued；封存成员和触发 |
| collecting/queued | 静默/限额拒绝、Room 停用或策略变化 | suppressed；保留未确认正文，撤销本次唤醒，不定时补发 |
| queued | 独占所有者有效、连接/策略/配额/Room 槽/全局槽均通过 | submitting；原子领取并记录确切 Host message.id |
| submitting | Host pre-step 确认领取该 message.id、唯一 turn | running；持有 Room 与全局槽 |
| submitting | 不确定是否已进入 Host，或跟踪/关联失败 | interrupted；取消并等待旧活动静止，禁止第二次 followup 同批 |
| running | 正常 completed，最终输入完整且 Host flush 成功 | finalizing；Core 确认，选择最多一条最终回复 |
| running | aborted/blocked/error/max-tokens/interrupted、输入异常或 flush 失败 | incomplete；不确认正文、不发缓存回复 |
| finalizing | 无有效最终文本，或出站前当前策略/epoch/静默等不再允许 | completed；send=none/cancelled，处理证据与发送处置分开记 |
| finalizing | 出站意图及结果已落库，必要的成功 ID 绑定已完成 | completed；send=sent/failed/unknown |
| 活动态 | 卸载、所有者丢失、崩溃 | interrupted；关闭出站闸；发送中的 intent 恢复为 unknown |
| 任一终态 | 相同事件、回执或恢复再次到达 | 幂等重放，不新建 Turn/intent、不重复确认 |

`suppressed`、`incomplete`、`interrupted` 为该批的终态，不重新激活同批；新的明确触发可以创建新批处理仍未确认的正文，但不得把旧回复 intent 带过去。`completed` 不等于 sent。过时 queued 快照不能原地改成员，须记录原批终结并从仍可用触发建立新快照。

Room 锁从 submitting 开始，直到对应 Host 活动确已结束/静止、Core 结算及一次出站结算均完成；不能在 followup 返回、assistant/message、某个 step/end 或 turn-stopping 就释放。每个提交的 message.id 必须唯一绑定一个 Room/batch/epoch；发现陌生 steering/混入其他普通输入则拒绝本批。只用受控群 Agent 路径，不能把批次追加到私聊 Agent。

卸载先使旧 epoch 无发送权，再取消受控群活动、移除监听器并关闭其连接，最后等待静止。重载取得独占所有者并增加持久 epoch；旧排队输入必须被受控 pre-step 拒绝或通过已验证的 Host 接口清除。无法证实旧 Agent 静止/旧 inbox 已隔离时，该 Room 不再提交新批，记 lifecycle-unresolved，不能靠重新构造内存锁宣布恢复。D-2-4 必须直接覆盖 Host 队列中尚未执行的 followup。

所有异步回调在写库、接受模型输出、创建 intent、真正调用发送前再次核对 epoch/Room/batch；不能让旧代监听器看到新代 Session 就恢复发送能力。槽有超时观测但不靠超时强行解锁仍活跃的 Agent；取消不能收敛时保持该 Room 阻塞并告警，不重叠运行。

最终代际检查与实际 socket.send 之间不能再 await；连接/账号验证等等待完成后须重验。此围栏阻止失效后才发起的网络动作，已经到达平台的动作无法撤回，迟到送达按发送结果的不确定性报告。

## 8. 群回复意图、ACK 与 self ID 闭环（D-2-4）

### 8.1 一批最多一次出站动作

现有 `assistant/message` 是每步通知，不能直接用通用监听器发送群文本。群路径先缓存本批候选；完整输入、正常 completed、持久化成功后，选择该 Turn 最后一个成功文本步骤的最终 assistant 文本。工具步骤/中间 assistant、不完整输出、空文本不发送；本版不拆多条，不向群 Agent 暴露直接发送工具。私聊原路径不随之改写。

发送前重新检查来源 Transport/账号、Room active、reply.enabled、policyHash、epoch、静默、已领取批身份及证明；不跨平台或切换账号。文本超过来源 Transport 的单消息上限则取消并记录 oversize，不偷偷截断/拆分。每批持久 intent 唯一，只发送其精确快照，不能取可变的最后一条 Session 回复替换。

回复文本先存一条同 Room 的 `origin=self` Source（未送出候选，message_id=null，metadata 明确 output stage/Host 引用），intent 只引用它及 hash；正文不在调度表再维护一份。该 Source 的 self 身份不表示已经发送，不能单独授权引用触发。发送成功后**追加 delivery binding**，不 UPDATE 该 Source 或 room_message_seq 补平台 ID；出站 Source 不插入入站序号流。通用 Capture 必须按相同 Host 消息身份复用/排除这条群输出，防止同一正文另写一份事实来源。

### 8.2 出站状态表

| 状态 | 转换条件 | 后续 |
| --- | --- | --- |
| prepared | Source+intent 已提交，尚未调用平台发送 | 当前闸失败可 cancelled；不因此认定已发 |
| dispatching | 事务记录发送意图后，事务外开始唯一网络动作 | 不允许并发第二次动作 |
| sent | 关联成功的合法 ACK：数字 retcode=0，status=ok | 有 message_id 则同事务追加可信 binding；sent 仅表示平台受理 |
| failed | 可信且明确的拒绝 ACK，或确定网络动作未发生 | 含 429；本版群回复也不自动重试 |
| unknown | 动作可能已发生后超时/断连/ACK 丢失、矛盾回执或崩溃 | 不自动重发、不因新实例恢复而重发 |
| cancelled | 发送前策略/epoch/Room/静默等不再允许且确定未调用发送 | 不自动恢复旧 intent |

主动 Outbox 的 group 拒绝保持；本路径是来源消息的确定性回复，不能借 purpose=proactive 绕过它。群回复的结果分类单独明确：普通私聊 Transport 的 retryable/send-failed 映射不能证明某次群动作一定未发生。发送前确定离线与发送后的未知断连必须区分。

为避免缺 echo 的迟到 ACK 在共享 FIFO 中错配，本版群回复使用**同一逻辑来源 Transport 的单次出站连接**：验证相同 OneBot 端点/账号，每连接最多一个发送 RPC，结算后关闭；不建立第二个入站采集器，不故障转移。显式错 echo 忽略；无 echo 仅能在此专用单次连接上关联唯一 RPC；严格 ACK 逐条设置，不改变普通私聊 retcode-only 兼容契约。十秒未结算落 unknown，关闭连接，后来的 ACK 不匹配下一批。

成功 ACK 缺 message_id 时可记 sent，但必须记 `binding=unavailable`，不能生成虚构平台 ID或允许 self reply 命中。收到 ACK 但持久化失败时停止新发送，恢复只允许核验/补写，不能再调用发送。平台受理后本地崩溃可能落 unknown；因此不承诺出站 exactly-once 或 unknown 一定没送达。

### 8.3 必须真实走通的引用验证

固定 Provider 产生一条群最终回复 → 真正通过 OneBot send_group_msg → 获得端点返回的 message_id → 落 sent intent/binding/self Source 引用 → 同群新入站 reply.id 命中且首次保留正文/触发。跨 Room、跨账号、另一平台同 ID 均不命中。必须统计实际 action 数及目标；预先插入 self Source 的单测只能证明查找规则，不能代替此闭环。D-2-4 用本地端点完成，D-3 再用真实 QQ 验证。

## 9. 故障与恢复处置

| 故障点 | 恢复动作 | 禁止 |
| --- | --- | --- |
| 入站重复 | 复用持久 seq/首次保留决定 | 新 Source、窗口延期、重复唤醒 |
| 快照已封存、确定未提交 Host | 旧 epoch 批终结；有未消费触发时新 epoch 可重新封批并过闸 | 修改原快照/沿用旧 epoch |
| 已记录 submitting，但无法确认是否提交 | 标 interrupted、隔离旧 inbox；仅新明确触发可另建批 | 自动再 followup 同批 |
| Host running 时重启/卸载 | 取消/隔离旧活动，未完整证明的不确认 | whenIdle 或新锁替代具体 Turn 证据 |
| completed+flush+receipt 已持久，Core 未确认 | 校验后仅补确认；若无已持久回复意图，不在恢复时补发旧回复 | 再跑模型/凭水位差发旧消息 |
| prepared 时重启 | 取消旧 intent；不自动补发 | 把重启当新发送许可 |
| dispatching 时重启 | unknown，保留原 intent 与证据 | 归 pending 或自动重试 |
| sent、但 ID 绑定未完成 | 按已有可信 ACK 幂等补绑定；证据不足则保持 unavailable | 构造 ID/重发取得新 ID |
| 重连不能补拉平台消息 | 记录可观测入站缺口 | 伪造遗漏消息/假装全量同步 |
| Source 隔离或缺失 | invalid，阻止该位置确认 | 把它改成 policy_omitted |

unknown 在本版没有新增 HTTP/模型/自动核验入口。人工外部核对可作为审计材料，不能复用原 intent 重发；如需再次回应，必须有新的群内明确请求并形成新批与新 intent。这也不能保证用户从未收到两条语义相近的回复，应在报告如实区分新的响应与重试。

## 10. 观测与最小披露

至少区分：intakeRejectedBeforePersist、dedupeDropped、triggerAt/Reply/Name、suppressedSilence/Quota、queueOverflow、queued/active、proofUnavailable/Partial、turnIncomplete、policyOmitted、modelProcessed、pendingRetained、invalidEvidence、readWatermarkLag、sendSent/Failed/Unknown、replyBindingUnavailable、staleEpochBlocked、lifecycleUnresolved、inboundGap。

普通日志只输出稳定码、计数和脱敏关联标识，不输出正文、Source 正文 hash、完整账号/群号、私聊授权或请求快照。审计所需内部映射/hash 保存在本机受控证据中；模型仅见当前 Room 合法的文本投影。后续只读管理界面单独接入，不在 D-2-0 增加路由或修改 Host 认证结论。

## 11. 实施顺序与测试矩阵

| 阶段 | 交付/文件范围 | 放行条件 |
| --- | --- | --- |
| D-2-0（本次） | 本契约、D-0 修订、矩阵及评审记录 | 文档自洽、基线复跑；只表示契约冻结 |
| D-2-1 | Core 触发纯规则/首次采集校验；qq-group-ingress 的完整严格 RoomPolicy；新 group-trigger 测试 | names 首次留正文、历史不可升级；D-1 self 引用只保留采集兼容，真实唤醒绑定待后续；reply 默认关闭，无 Turn/发送 |
| D-2-2 | Core 引用快照、确认/输入证明记录；独立递增 migration；group-input-proof/schema/concurrency 测试 | 水位与展示集合分离、跨进程领取、升级/回滚；真实发送仍关闭 |
| D-2-3 | 群调度模块、时钟、限频/单飞/队列/代际恢复；group-scheduler 测试 | 确定状态机与故障处置，模块级 PASS；不能称 Host PASS |
| D-2-4 | 最小 Host 适配、受信 Provider 输入回执、群出站/绑定；group-reply 及隔离 Host 探针 | 固定 Provider + 本地 OneBot 的真实 Turn/输入/生命周期闭环；无真实 QQ 多群结论 |
| D-3 | 另行指定真实测试群与权限后，真实 QQ 多群场景 | 真实 Scope/并发/静默/重连/引用验收后，才排 E-1 |

下列为**冻结的验收用例**，不能整表视为已运行测试或新增断言数；已验证范围与未覆盖的真实 Host 场景以当前验收报告为准。纯规则用 FakeClock/固定 now；Core 写入对比前后快照；发送必须记录 action 数、目标、receipt 与状态；并发领取至少跨 SQLite 进程验证。

| 编号 | 场景 | 必须结果 | 阶段 |
| --- | --- | --- | --- |
| T01 | 普通群文本/独立问号 | 不创建 Agent、不唤醒、不回复 | 1 |
| T02 | 结构化 @self / @all / CQ 字符串 | 仅 @self 合格，后两者不伪装 at | 1 |
| T03 | `心灵，你好`；前后字母/数字/中文；Unicode NFC | 按独立 token 精确判定，大小写不模糊 | 1 |
| T04 | 相邻 text 人为分段；真实非 text 段 | 拼接后判断，不能伪造 token 边界 | 1 |
| T05 | 旧 reply/forward 正文含昵称/问号 | 仅当前顶层消息可触发 | 1 |
| T06 | names 命中 mentioned_only 首次消息 | 同事务留 Source/Event/判定材料 | 1 |
| T07 | 重放 D-1 未保留消息/修改配置后重放 | source_id 保持空，不追加正文/触发 | 1 |
| T08 | 非法、未知字段、重复群、名称碰撞、时区缺失 | 对应整项失效，根非法全拒 | 1 |
| T09 | trigger 开关与 reply.enabled=false | 不唤醒；采集与调度开关不混用 | 1 |
| T10 | 非白名单/临时群/发送者不一致 | 零 Agent/Source/回复，拒绝可观测 | 1 |
| T11 | 仅有D-1旧self Source，尚无可信发送binding | 保持旧采集选择，不授予self reply唤醒资格 | 1 |
| P01 | seq1/3 omitted，2/4 完整处理 | 水位4，展示集合仅2/4 | 2 |
| P02 | seq2 缺口、4先确认、后补2 | 水位先1后4，4不重复处理/回复 | 2 |
| P03 | 20条/4000码点/包装预算边界、emoji | 整条选入；预算含包装，未选中不确认 | 2 |
| P04 | 超长触发、旧上下文挤占预算 | 不能完整放触发则不执行；预留规则可重现 | 2 |
| P05 | 部分展示/被裁剪/被替换/hash不符 | 不确认、不发送，保留具体缺口 | 2 |
| P06 | 只存在 pre-step、FinalCheck 或模型“已读” | 不成为最终 Adapter 输入证明 | 2 |
| P07 | 原文hash、投影hash、完整请求hash重建 | 顺序/版本固定，非ASCII无歧义 | 2 |
| P08 | 另Room/另账号/旧epoch/伪造receipt | Core拒绝，不跨域确认 | 2 |
| P09 | compaction/title、缺attempt关联、并发请求 | 不误认本批；独立 attempt，不拼接部分证明 | 2 |
| P10 | Source被隔离/丢失或引用损坏 | invalid，不能改记omitted | 2 |
| P11 | opId重放与不同参数冲突 | 同参幂等，异参明确冲突 | 2 |
| P12 | v22升级、冲突回滚、双驱动、旧水位 | 不改旧事实、不补造确认，迁移整版原子 | 2 |
| P13 | 双进程同Room/同成员领取与水位推进 | 一个所有者、无重复领取/确认，无越界/回退 | 2 |
| S01 | 2秒安静、8秒上限；重放与封批后到达 | 定时可复现；旧快照不可追加 | 3 |
| S02 | 同Room前一轮模型延迟、多次assistant/step | 下一批不重叠，不提前释放锁 | 3 |
| S03 | 多Room同时触发、单Room积压 | 全局最多4，Room轮转，无串群饥饿 | 3 |
| S04 | 50待批满载/释放/入口8任务满载 | 区分两类背压；已落库未决有记录和计数 | 3 |
| S05 | IANA午夜/DST、all/direct-only、窗口边界 | 静默不违规，结束不自动补发 | 3 |
| S06 | 小时第6/7次、并发预留、重启/时钟回拨 | 不超过滚动限额；不因重启/回拨重置额度 | 3 |
| S07 | 断线前未提交/已提交/发送中 | 各按§9恢复，未知结果不重发 | 3 |
| S08 | 源消息只保留引用、DB失败、Room停用/策略变 | 不复制正文、不伪成功，不借旧策略发言 | 3 |
| S09 | 失败/中断后只有普通新消息 | 不自动重跑；新明确触发才可新批 | 3 |
| S10 | 跨进程第二Host与旧epoch迟到回调 | 拒绝第二所有者，迟到写入/发送被围栏阻止 | 3 |
| H01 | 真实Host普通群消息 | 零Agent/模型/发送，与采集策略一致 | 4 |
| H02 | 固定Provider实际Adapter输入 | 实际文本/顺序与sealed manifest一致，完整receipt | 4 |
| H03 | 外层快照后内层异步删改输入 | 最终回执发现不符，不能确认/发群回复 | 4 |
| H04 | followup返回/whenIdle/turn-stopping/turn.end | 仅确切completed+完整输入+flush(true)可确认 | 4 |
| H05 | aborted/blocked/error/max-tokens/flush false或失败 | 无成功确认、无中间/缓存回复 | 4 |
| H06 | 多步工具与请求重试 | 每步Scope一致；仅最终完整成功文本一次出站 | 4 |
| H07 | 真send_group_msg→ACK→引用该message_id | action数1；真实成功binding触发下一轮 | 4 |
| H08 | sent缺ID/跨Room同ID/未发送self Source | 不伪造binding，不允许错引用触发 | 4 |
| H09 | 明确拒绝/429/错echo/无echo/超时/断连 | 分别结算；独立单次连接；unknown不重发 | 4 |
| H10 | dispatching崩溃、ACK后写库失败、重启重投 | 不自动重发；恢复终态/绑定可幂等 | 4 |
| H11 | 同Room双触发、不同Room同时触发 | 真实Turn单飞与全局上限成立，input不混 | 4 |
| H12 | 热卸载/重载，含Host inbox已排队输入 | 旧epoch无迟到回复；不能隔离时该Room停机 | 4 |
| H13 | 成员同时是QQ好友，含私聊哨兵证据 | group RuntimeInput/contact隔离，私聊正文/授权不入模型 | 4 |
| H14 | 成功处理但发送unknown/failed | 处理确认与发送结果分离，不以水位触发重发 | 4 |
| H15 | 实际生产Provider缺最终输入回执能力 | 只采集，明确proof-unavailable，不用Mock冒充 | 4 |
| Q01 | 真实QQ多群、引用、静默/限额/并发/重连 | 另留真实平台证据；本地协议测试不等于平台验证 | D-3 |

每阶段按实际代码范围 build、相关独立测试、全量回归；涉及消息入口、Host/发送的变更增加真实隔离 Host/本地 OneBot 探针。D-2-1 只验入口与零 Turn，不提前做真实群回复。D-2-4 报告注明 profile、数据根、固定模型版本、Host版本、场景号、Adapter实收与action证据；D-3 未完成前，真实多群能力保持 NOT VERIFIED。

## 12. 放行口径

**D-2-0 契约冻结**仅表示本文行为与测试依据确定。D-2 模块级 PASS、D-2-4 隔离 Host PASS、D-3 真实 QQ PASS 是三次不同结论，不提前合并。

以下任一项阻止群回复启用：无法取得最终输入回执；批次与真实 Turn 关联不唯一；Host 完成/持久化缺证据；旧代 inbox/活动无法隔离；跨群/私聊泄漏；静默失效；unknown 自动重发。Host 缺能力单独报告责任边界，不在 Psyche 仿造调度服务或扩大既有验收结论。
