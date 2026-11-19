# P4-D-1 存储与受控接入实施说明

- 开工基线：`362aa0c`、DEV v27.92、Schema v21、4288 / 137 / 0。
- D-0 §3 的正文保留冲突已由用户确认：采用最小记录方案；mentioned_only 下未选中消息不保存正文。
- 本批只完成采集及持久化基础；不创建群 Agent、不启动 Turn、不回复，D-2 才接参与调度与水位推进。
- 实现 `5fe73ea`；DEV v27.93，Schema v22/49表/16触发器；四套新增108断言，全量4396/141/0；11项真实隔离Host/本地OneBot检查通过。报告 `docs/audit/p4-d-1-storage-intake.md`。
- 后续契约：2026-11-14 的 [D-2-0 冻结稿](p4-d-2-scheduling-freeze.md) 已定义 policy_omitted、模型输入证明与真实 Turn/发送闭环；只修改设计，不改变本文件 D-1 的历史实现或验收结论。下一步 D-2-1，仍不启用群回复。

## 1. v22 迁移方案

选择 D-0 允许的序号映射表形式，避免改写 append-only Source：

- `room_message_seq`：内部 room_id、platform、message_id、room_seq、received_at、可空 source_id/event_id。普通未选中消息只保留这些最小字段，不存正文、正文副本或发送者逐消息映射。
- `room_participation_state`：每 Room 的 last_seq、read_through_seq、participation_state 与更新时间。D-1 只初始化 idle / read_through_seq=0，不提供模型可调用的推进方法。
- 唯一约束：群 Room 身份、映射表 `(platform, room_id, message_id)` 与 `(room_id, room_seq)`；映射 append-only，水位不回退。
- 升级先检查重复群身份/有效群消息键；冲突则整版回滚，不删除/合并历史。有效历史群 Source 按已有行插入顺序初始化序号，不按 captured_at 排序；缺可信 Room/消息 ID 的历史不伪造序号，仍保留原 Source。
- 主数据根与三份近期证据库已只读预检：均 v21，群 Room/Source=0，冲突=0；原库不直接升级，迁移验证用独立库/副本。

## 2. 受控接入

- `qq.groups.enabled` 默认 false。D-1 白名单条目只开放 externalRoomId、captureMode、silence（显式 IANA 时区）；D-2 调度字段暂不开放，不假装已生效。
- 只接受白名单内、normal 群消息及合法群/发送者/消息身份；private+group 临时会话、非白名单与非法条目静默拒绝，零 Agent/Source。
- Core 按内部 Room 解析，在同一 #write 事务中去重、分配序号、维护成员观察、按策略写 Source/Event 和关联；成员观察不能授予私聊权限。
- D-1 mentioned_only 的选择来源为真实 at 段和同 Room 已有 self Source 的真实 reply id，不从 raw_message 的伪造 CQ 字符串推断。点名/问句判定留 D-2；all_visible_messages 保留全部被准入消息。
- 未选中消息没有 Source/Event，不将正文写到日志、operations 结果或别的持久化缓冲；D-2 必须处理这类“未保留原文”的位置，不能宣称模型读过。静默合并、水位推进与重启展示语义在 D-2 再验，不提前推进。
- 新采集 Event 不进入无 Room 的默认 Diary/Growth 起始互动推导；不自动生成 Artifact、Diary、Relationship 或 Mood。

## 3. 文件与验证

Core：schema.ts、store.ts、room-intake.ts；QQ 集成：qq-group-ingress.ts、qq-bridge.ts、index.ts。无模型工具、HTTP 授权或主动群发入口，Outbox group 拒绝保持。

新增独立测试覆盖 v21→v22/幂等/冲突回滚/双驱动兼容、Room 内序号与跨进程重复投递、保留策略与正文最小化、停用与隔离。原测试只同步必要的最新 Schema/表数断言，不修改历史业务验收语义。完成后 build、相关测试、全量和真实隔离 Host/本地 OneBot 探针，按实跑结果更新报告/DEV/HANDOFF。
