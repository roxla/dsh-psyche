# P3-C-3b 真实链路接入说明（首版已实现）

- 日期：2026-11-13。
- 状态：**D1/D2 首版已实现并完成工程验收；实现 `1e8dd40`，待用户阶段评审**。真实同意、人工审批、一次 QQ 发送、收件确认与撤回后拒绝均通过；Worker 不注册宿主。
- 原提案基线：DEV v27.89、Schema v21、Git `2bc9b26`、4082 / 132 / 0；C0 后实施基线 v27.90 / `3ac44f9` / 4099 / 133 / 0。
- 首版结果：DEV v27.91、Schema v21（47 表 / 12 触发器）、4226 / 136 / 0；报告 `docs/audit/p3-c-3b-real-dispatch.md`。
- 兼容性复核：DEV v27.92，修复 `2bc2f24`，4288 / 137 / 0；普通回复兼容数字 retcode 但省略 status，主动入口逐条保持严格 ACK。见 `docs/audit/qq-ack-compatibility.md`。
- C-3a `9371d52` 与入口直接引用守卫 `9ea615d` 的 PASS 保留；守卫不覆盖传递依赖。
- 上游：`p3-b-c-shared-contracts.md`、`p3-c-proactive-contact.md`、`p4-qq-transport-outbox-plan.md`、`p3-c-3a-outbox-implementation.md`。

## 1. 先完成的前置批次

C0 同 Session 双消息、队满与卸载重载单独复验、单独报告。旧 Session 无回复目前只在全新隔离 Session 下排除；不宣称修好了 Host 调度，也不修改旧 a2 的历史结论。

QQ Bridge 已通过独立反例定位到卸载后迟到投递及重复 start 的生命周期缺陷，本批只修该缺陷。Worker 仍不注册宿主，不从 `src/index.ts` 直接引用 Outbox。

## 2. 已确认的两个首版入口

### D1：联系人同意的权威来源

已确认：首版只接受联系人本人从真实 QQ 好友私聊发来的**完整、明确的测试同意指令**，包含有效期与撤回方式。以 Host 已验证 Contact 绑定的 Source 为证据，不从 allowFrom、Owner 测试名单、关系分数或转述推导。

测试版授予格式固定为 `同意心灵主动测试至 <带时区的 ISO 时间>；时区 <IANA>`，例如 `同意心灵主动测试至 2026-11-13T18:30:00+08:00；时区 Asia/Shanghai`；撤回固定为 `撤回心灵主动测试`。授予有效期最多为捕获时刻起 24 小时，必须明确收件人的 IANA 时区和未来截止时间，不接受自然语言猜测或引用转述。

以该 Contact 最新的授予/撤回控制 Source 派生 `outboundConsent`。最新授予非法或过期也不回退旧授权。读取必须核实 user 角色、QQ/private、Contact、捕获时间、隔离状态；引用缺损或读取异常一律拒绝。此格式与 24 小时上限已由用户确认用于测试版。

- 原始 Source 持久化并保留，重启后重新派生；不复制聊天正文到配置或新增可改真值文件。
- 不把授权记录做成会被 Recall 注入的普通 public Fact。
- 撤回立即影响尚未开始发送的任务；已发出的请求保留真实结果。
- `proactive.allow` 只作为同一同意/策略的受控查询表现，不建立第二份联系人同意。
- 若采用专用 Consent 表而非上述派生方式，必须先另批递增 Schema 迁移；本提案不预先建表。

### D2：Owner 审批的可信入口

已确认：首版采用**本机人工 CLI**，展示完整草稿、revision、hash、目标与 transport 后确认一次发送；调用者身份由本机受控入口确定，不接收模型自报 ownerId/decidedBy。

- 不在目前匿名可达的 Host 插件 API 上新增审批、发送或核验写路由。
- 模型不持有审批入口、Owner 句柄或发送权限。
- CLI 核验 unknown 为未收到时只落 failed；新发送必须新审批，不能回 pending。
- 首版 Worker 由该人工入口显式运行；宿主自动注册最后单独评审。
- CLI 认证边界为本机 OS 身份与访问权限；Windows 使用 SID，非 Windows 使用 UID。审批/派发/核验必须交互终端逐条确认，无 `--yes` 或自报 Owner 参数；审批审计载体仍为 Outbox 不可变行。
- 本方案仅信任本机受控操作者与 OS 访问边界；交互输入本身不构成“防同一 OS 用户下恶意进程”的身份认证，不以两个相同字符串证明 Owner。实现评审须确认既有本机权限边界是否足够，若不足先补受信入口，不降级到匿名 HTTP。

## 3. 接入差异与首版处理

| 项目 | C0 后发现的差异 | C-3b 已实现处理 |
| --- | --- | --- |
| 启动恢复 | `OutboxWorker.start()` 只调度；恢复方法由旧测试手工调用 | CLI 取得同 DB 独占租约后先恢复，再显式 tick；三进程互斥及崩溃恢复已测 |
| 可重试范围 | 通用 QQ 包装把离线归 retryable；Service 领取后离线也写 retryable | 主动专用分类仅 429 可重试；领取前离线不领取，领取后发送前离线落 failed |
| 网络/发送错误 | 通用包装把 send-failed 等归 permanent | 主动专用分类将超时、断连、丢 ACK、未知异常落 unknown；普通回复映射保留 |
| 回执关联 | 桥对缺失或不匹配 echo 采用 FIFO | 显式不匹配 echo 忽略；无 echo 仍兼容。人工任务独占一连接且只发一条，结果后关闭，避免跨任务迟到 ACK |
| 群聊 | 通用目标类型含 group | 主动入队、领取复核、主动 Transport 三处拒绝 group，Schema 保留原枚举 |

上述差异已由独立测试覆盖；首版没有把 Worker 挂到宿主启动。

## 4. 验收层次与真实账号范围

1. C0 的真实 DSH Host + 本地 OneBot 复验负责宿主调度隔离、队满及卸载重载，见独立前置报告。C-3b 的真实 QQ Bridge/Transport + 本地 OneBot 故障端负责成功、明确拒绝、429、超时、ACK 丢失；独立 OS 子进程负责互斥与崩溃恢复。这些是传输/进程级证据，不扩大为真实 QQ 平台故障证据或 Host 内 Outbox Worker 验收。
2. SnowLuma v2.4.2 + 用户指定的唯一发送账号及专用收件联系人：验证真实身份、联系人同意、Owner 审批、一次发送与平台回执。账号及凭证只留本地私有配置，不写入仓库报告。
3. 不通过故意刷真实 QQ 来制造 429，也不把本地故障端结果写成真实 QQ 平台故障证据。
4. 用户确认具体测试正文与审批快照后才发真实主动消息；普通回复可通过真实收件联系人入站消息验证。

### 4.1 首版实施细化（2026-11-13）

- 同意指令同时携带可信收件人 IANA 时区：`同意心灵主动测试至 <ISO时间>；时区 <IANA>`。示例：`同意心灵主动测试至 2026-11-13T18:30:00+08:00；时区 Asia/Shanghai`。这是落实既有“无可信时区不生成草稿”的冻结约束，不由 Owner 时区或 UTC offset 猜测 IANA。
- Owner ID 从本机 OS 用户身份推导，无 ownerId/decidedBy 命令行参数；审批/核验要求交互终端及逐条确认，不提供 `--yes`。信任边界为本机 OS 访问权，不声称防御同一 OS 用户下的恶意进程。
- CLI 用内核持有的 loopback 独占监听取得运行租约；端口由规范化 DB 路径确定，冲突即拒绝、不换随机端口。进程崩溃由内核释放，不建立可修改的授权/业务真值文件。恢复在租约内、首次领取前执行，避免活动 Worker 互相执行崩溃恢复。
- 每次 CLI Worker 只领取指定 outbox_id 的一条记录，使用独立、只出站的 QQ Bridge/Transport 连接。取得结果即关闭连接；不复用普通回复的 socket，不在同一连接开始第二条发送，避免无 echo 的迟到 ACK 结算其他审批任务。
- 通用回复 Transport 既有结果映射保留；主动发送显式采用严格映射：明确平台拒绝→failed，429→retryable，超时/断连/send 异常/未知错误→unknown。显式 echo 不匹配时忽略，不回退 FIFO。
- 回执解析策略保存在单条 pending：普通回复兼容省略 status 的数字 retcode；主动入口显式 `strictAck:true`，必须数字 retcode + 明确 ok/failed。缺失/字符串 retcode、显式非法或矛盾结果不因普通兼容而当成功；没有全局开关或配置面板入口。
- 领取前离线不领取；领取后且尚未调用 send 时离线，按明确未发送失败终止并要求重新审批，不将离线归为可自动重试。Outbox 对不带明确 429 分类的 retryable 保守落 unknown。
- 主动 v1 入口和领取复核均拒绝 group；不修改 Schema 中为将来保留的 target_kind 枚举。
- Owner 核验为 sent 但缺平台 sent_at 的历史行，以 updated_at 保守计入频率/额度，不伪造平台确切发送时间。
- Worker 类本身不成为任意调用者可触发的全局恢复器；C-3b 的真实启动入口在租约内恢复后显式 tickOnce，宿主生命周期注册仍未开放。
- CLI 的 `proactive.allow` 受控查询重新计算同意、身份、通道、静默时段、冷却、额度与重复任务资格；不另存授权开关。全局日/周额度保守使用滚动 24h/7d，同一联系人默认 7 天冷却。

### 4.2 实现入口

- `packages/core/src/proactive-consent.ts`：只读解析可信 Capture Source；最新控制记录无效也不回退。
- `src/lib/proactive-owner-runtime.ts`：本机身份、运行租约、指定发送账号的本地 OneBot 配置。
- `src/lib/proactive-qq-runtime.ts`：验证心跳账号、绑定发送账号的 transportId、出站专用单次连接。
- `tools/psyche-outbound.mjs`：`consent/status` 只读，`approve/approve-send/send/resolve` 交互人工入口；运行前 build，帮助见 `node tools/psyche-outbound.mjs --help`。
- `test/proactive-consent.ts` 29、`test/proactive-qq-dispatch.ts` 69、`test/proactive-owner.ts` 29，共 127 项新增断言。

## 5. 非目标与下一步

不修 Host 调度、Host API 认证，不重开 P2/P3-A，不做群聊/Telegram/UI 发送按钮/无人审批发送。

首版工程验收已通过，供用户阶段评审。按既有交接顺序，后续可进入 P4-D-1；Worker 宿主生命周期注册仍须单独设计/评审，不属于本次完成范围。真实 QQ 的 429、ACK 丢失与崩溃后送达状态未人为制造；现有故障证据来自本地协议端，不宣称平台故障验收完成。
