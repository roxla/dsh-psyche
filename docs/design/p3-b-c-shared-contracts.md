# P3-B / P3-C 共享契约（B-0 / C-0 冻结候选）

日期：2026-11-12（D-1 修订；同日审阅通过）
状态：**已确认**，可进入 B-1 / C-1；本文件只冻结契约，不含实现
关联：`p3-b-relationship-ledger.md`、`p3-c-proactive-contact.md`、`p3-b-c-test-matrix.md`
基线：DEV v27.74、Schema v19（46 表）、Git `bda90e0`（D-1 提交）；修订后附加 `decidedBy` 与三项收尾说明
修订来源：2026-11-12 人工审阅（Trust 识别、Consent 单源、时区、幂等范围、B-1/B-2 拆分、完整性约束）；同日审阅通过

## 1. 适用范围

本文件冻结 P3-B（关系账本）与 P3-C（主动联系）共用的身份、证据、权限、存储、时间与幂等契约。两份阶段文档只引用这里的定义，不各自另立一套。

## 2. 核心原则

1. **关系状态管"怎么相处"，不管"能不能做"。** Trust / Affinity / Affect 都不得绕过审批、权限或 Scope。
2. **不建第二套事实源。** 关系事实（谁是谁、发生过什么）仍只来自 `contacts` / `contact_identifiers` / `sources` / `events`；关系判断走 `artifacts(kind='relationship')`。
3. **可重算、可追溯。** 数值投影必须能由 append-only 账本重算；不能重算的东西不落投影表。
4. **模型只给候选，Core 才写。** 与 B2 相同：候选结构 + 规则校验 + 事务写入，拒绝整批而不是静默丢字段。
5. **默认不授权。** 缺失、非法、未评估一律按"不可"处理，不做乐观默认。

## 3. Contact 身份契约

- 身份键：`(platform, stable_user_id)`，见 `contacts.UNIQUE`。
- `contact_id` 是内部稳定主键；跨平台合并只能由人确认（`contact_identifiers.merged_by_user = 1`），模型不得自行合并。
- 展示名 `display_name` 只是快照，可过期；不得用于身份判定。
- 新建联系人只能由真实入站安全事件触发（Capture / QQ 准入通过后的消息），不得凭空造 Contact。
- Contact 删除走软删除/停用语义（`contacts` 目前无 active 列，P3-B 不新增）。**v1 不设独立的"联系人停用/拉黑"判定**：P3-C 的资格失效以 `outboundConsent` 的撤回/过期作为权威来源；将来需要真正的独立停用功能时，再定义唯一权威状态源并审查是否迁移，不得用关系 Artifact 反推。关系结论里可以记录"停用建议"，但不作为操作状态。

## 4. Evidence 契约

- 证据链固定为 `Source → Event → Artifact Revision`；关系信号可引用 `source_id` / `event_id`，但不得只引用模型自述。
- `independence_key` 由写侧从来源推导（同一活动窗口 / 同一消息只算一次），模型不得填写。
- 拒绝"助手说记住了"作为用户授权或关系证据；只有真实用户消息或宿主确认的行为事件可作证据。
- 关系结论的证据必须落在 `artifact_evidence`，并且 `artifact_trigger_events` 可反查触发事件。

## 5. Scope 契约

- `Scope` 至少包含 `persona_id`、`contact_id?`、`room_id?`、`session_ref?`。
- 读取关系投影时只能读当前 Scope 内的 Contact；群聊上下文里不得把 A 的关系注入给 B。
- 关系 Context 只对"当前对话联系人"生效；无 Contact 的会话（桌面/网页）不注入关系语气。
- `disclosure` 沿用现有枚举：关系结论默认 `public`，敏感内容 `restricted`/`secret`，投影只读 `public`。

## 6. 权限契约（关键）

三层权限**互相独立**，任何一层不通过都不能发生动作：

| 层 | 回答的问题 | 载体 |
|---|---|---|
| 通道准入 | 这个平台会话是否允许进入 Agent | `qq.allowFrom`（P4-A，入站） |
| 主动联系同意 | 这个人是否允许被主动发消息 | **`outboundConsent`（唯一权威）** |
| 行为审批 | 这一次具体消息是否批准发送 | Owner 审批记录（P3-C） |

- **`qq.allowFrom` 不是主动联系授权。** 在 allowFrom 中只代表"可以回复他"，不代表"可以主动找他"。
- **`proactive.allow` 只是 `outboundConsent` 的配置/查询表现**，不得成为第二份事实源；运行时判定只看 `outboundConsent` 的状态与有效期。
- **Owner 把联系人加入名单，不等于联系人本人同意被主动联系。** 同意必须来自联系人侧的可信事件（明确表达）或有来源的本地授权记录，并写入 `outboundConsent`。
- **Trust / Affinity 不是权限。** 数值再高也不能替代上面三层。
- Mood 的 `persona` / `scheduled` initiator 只表示"这轮情绪来源"，不授予任何发送权限。
- 群聊、临时群聊、未知类型沿用 P4-A 的 Fail-closed，不进入本契约。

```ts
interface OutboundConsent {
  contactId: string
  status: 'granted' | 'revoked' | 'expired'
  grantedAt: string
  sourceId: string        // 同意来自哪条真实证据
  eventId?: string
  expiresAt?: string
  revokedAt?: string
}
```

- 无 `outboundConsent`、状态非 `granted`、已过期 → 一律视为无同意，不产生草稿。
- 撤回只追加状态，不删除历史；同意不能由模型推断或由 Owner 单方面代填。

## 7. 存储契约（现有表，不预设新表）

| 数据 | 载体 | 写语义 |
|---|---|---|
| Contact | `contacts` + `contact_identifiers` | 入站安全事件创建；合并需人工 |
| 关系信号账本 | `relationship_signals` | append-only（库层触发器禁改禁删）；`base_delta` 与 `applied_delta` 都记；`rule_version` 固定 |
| 好感投影 | `relationship_affinity_state` | 由账本重算；`manual_override=1` 时跳过重算；`band` 与 `affinity` 同事务更新 |
| 联系人情绪 | `contact_affect_state` / `contact_affect_history` | 5 维、默认 0、按规则更新、冷却回 0；历史 append-only（**v20 已补库层 no-update / no-delete 触发器**） |
| 信任 | `artifacts(kind='relationship')` + `artifact_revisions.payload` | **必须带 `payload.type='contact_trust_assessment'` 判别**；`payload.trust={state,value,band,basis}`；每 Contact 唯一 active head；无则 `unassessed` |

- Schema 差异审计结论：**B-1 / B-2 不需要新表**。`payload` 是 JSON，可承载 Trust 专用结构。
- 完整性约束现状：`relationship_signals` 有 no-update / no-delete 触发器，但**没有 `independence_key` 唯一索引**；`contact_affect_history` 在 **v20** 已补 no-update / no-delete 触发器（迁移 `affect-history-append-only`），DELETE 触发器的 `WHEN` 条件放行 `contacts` 外键级联（否则删联系人会被挡）。
  - B-1：先用 `BEGIN IMMEDIATE` + 事务内查重 + 跨进程并发测试保证 `(contact_id, independence_key)` 不重复；唯一索引留到历史数据预检后，不修改已发布迁移。
  - B-2：v20 触发器已落地（2026-11-12，Schema v20 / 表数仍 46 / 触发器 9→11）。
- P3-C 的候选 / 草稿 / 审批 / 发送回执是否需要新表，留到 C-3 前做差异审计；C-1 / C-2 纯逻辑不落库。

## 8. 时间与幂等契约

- 时间一律 UTC ISO 字符串；所有"今天/多久没联系"由调用方传入 `now`，纯函数不读系统时钟。
- 写操作必须带 `op_id`；同一 `op_id` 重放返回原结果，不重复计分、不重复写历史。
- 关系信号另需 `independence_key`：同一事件重复触发只算一条证据。
- 并发：写入使用事务；投影重算以账本为准，最后写入者不覆盖 `manual_override`。
- 衰减：Affinity 不自动衰减；Trust 不衰减；Contact Affect 冷却回 0。
- **幂等边界**：本阶段只承诺单进程 / 事务内幂等与已落库轮次的重放幂等。纯函数（C-1/C-2）只承诺"同一输入 → 同一输出（含稳定 ID）"，**不承诺跨重启"只扫描一次"**；跨重启去重必须等候选/审批持久化阶段实现，不得在注释或报告里写成 exactly-once。

## 9. 共享接口（冻结签名）

```ts
// 身份与快照
interface ContactRef { contactId: string; platform: string; stableUserId: string }
interface RelationshipSnapshot {
  contact: ContactRef
  affinity: { band: AffinityBand; label: string; internalValue: number; manualOverride: boolean }
  trust: { state: 'unassessed' | 'assessed'; value: number | null; artifactId: string | null; revision: number | null }
  affect: Array<{ dimension: ContactAffectDimension; value: number; updatedAt: string }>
  signals: { total: number; recent: RelationshipSignalView[] }
}

// 写入（Core 内部，不对模型暴露）
interface RelationshipSignalInput {
  opId: string; contactId: string; signalType: string; polarity: 'positive'|'negative'|'neutral'
  evidenceRefs: string[]; independenceKey: string
  sourceId?: string; eventId?: string; now?: string
}
// 注意：调用方不提交 baseDelta / confidence；由 Core 按 signalType + ruleVersion 推导。
// 调用方也不提交 Trust 的 value；Trust 只能走专用入口：
interface ContactTrustReviewInput {
  opId: string; contactId: string
  proposedValue: number            // 0–100；首次评估从 unassessed 进入
  evidenceRefs: string[]           // ≥2 条独立证据
  decidedBy: 'owner' | 'persona'   // v1 只接受 owner；persona 保留但返回 E_VALIDATION，待后续阶段单独评审
  now?: string
}
// 说明：decidedBy 记录"谁做了这次信任判定"，不等于权限授予；owner 判定也必须走 Core 校验，
// 不得由模型在工具参数里自行填写绕过。v1 不开放 persona 判定，避免自评闭环。

// 主动联系（P3-C）
interface ProactiveCandidate {
  candidateId: string; contactId: string; reasonCode: string; score: number
  evidence: string[]; createdAt: string
}
interface ProactiveDraft { draftId: string; revision: number; candidateId: string; text: string; tone: string; evidence: string[] }
interface ProactiveApproval { approvalId: string; draftId: string; draftRevision: number; decision: 'approved'|'rejected'; decidedBy: string; decidedAt: string }
interface DispatchReceipt {
  dispatchId: string; approvalId: string; draftId: string; draftRevision: number
  channel: 'qq-private'; status: 'dispatching'|'sent'|'failed'|'unknown'
  attemptedAt: string; sentAt?: string; messageId?: string
}
```

## 10. 错误与降级

- 身份无效 / Contact 不存在 → 不产生信号、不产生候选；不得静默造 Contact。
- 账本写入失败 → 整笔回滚，不写投影。
- 关系投影读取失败 → 不注入关系 Context；不得用"中立"伪装成功。
- 候选/草稿/审批任一步失败 → 状态保持上一步，可重试但不得自动跨越审批。
- `manual_override` 存在时，重算跳过该 Contact 的 affinity，并记录跳过原因。

## 11. 不做

- 不做跨平台自动合并、不做关系分数对用户展示、不做群聊关系、不做自动发送。
- 不修改 P2 记忆链路、P3-A Mood 语义、P4-A 入站准入语义。
