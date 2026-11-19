# P3-B 关系账本设计（B-0 冻结候选）

日期：2026-11-12（D-1 修订）
状态：设计已修订，可进入 B-1；不含实现
契约依赖：`p3-b-c-shared-contracts.md`
基线：DEV v27.73、Schema v19、Git `a6705e9`；修订后 DEV v27.74
修订来源：2026-11-12 人工审阅（Trust 识别、Core 推导分值、Affect 更新规则、B-1/B-2 拆分）

## 1. 目标

让 Psyche 能记住"和某个人相处得怎么样"，但不把推测当事实、不把分数当权限、不建第二套事实源。

P3-B 回答三个问题：

1. 这个人是谁（稳定身份，不靠昵称）。
2. 这段关系发生过什么（append-only 账本）。
3. 现在大致处于什么档位（可重算的投影 + 有版本的关系结论）。

P3-B 不回答：现在该不该主动联系他（P3-C）、这一轮用什么语气（P3-A）。

## 2. 四个概念

### 2.1 Relationship（关系事实）

- 载体：`contacts` / `contact_identifiers` / `artifacts(kind='relationship')`。
- **Trust 必须与普通关系结论区分**：`artifact_revisions.payload` 必须带 `type: 'contact_trust_assessment'` 判别；没有这个判别的一律不当作 Trust 读取（即使挂在 `kind='relationship'` 下）。
- 信任是"有版本的结论"，不是分数缓存；数值放 `payload.trust = { state, value, band, basis }`。
- 每 Contact 只允许一个 active Trust head：写新 revision 时把旧 revision 标为 `superseded`，读取只看 active head。
- 关系结论的 `subject_refs` 必须**精确包含** `contact_id`（JSON 数组成员匹配，不用字符串包含）；证据走 `artifact_evidence`。
- 不新建 `trust_state` 表：现有 `payload` + revision 已能承载，单独存必然和结论层打架。

### 2.2 Contact Affect（对某个人的当下情绪）

- 5 维，全部默认 **0**，方向独立，不做互斥枚举：

| 维度 | key | 含义 | 半衰期 |
|---|---|---|---|
| 暖意 | `warmth` | 被这个人暖到 | 8h |
| 紧张 | `tension` | 和这个人相处时的紧绷 | 3h |
| 受伤 | `hurt` | 被这个人伤到 | 12h |
| 挂念 | `missing` | 想这个人 | 12h |
| 恼火 | `irritation` | 对这个人来气 | 2h |

- 量纲 0–100，按 `value * 0.5^(Δt/H)` 冷却回 0（不是回 50）。
- 只由"与该 Contact 相关的真实事件"更新；**不得从全局 Mood 反推**，也不得反向写全局 Mood。
- 读写走 `contact_affect_state` / `contact_affect_history`；历史行带 `op_id`，同 op 幂等。
- **更新规则（B-2 冻结）**：
  - 候选由规则引擎或模型产生，Core 校验后写入；候选值不等于最终值。
  - 一次互动可以影响多个维度，但每个维度要独立给证据；同一维度一次最多变化 10。
  - 映射基线：`interaction_positive` → warmth +3；`interaction_negative` → tension +3 / irritation +2；`conflict` → tension +6、hurt +4；`repair` → warmth +4、hurt −3；`commitment_broken` → hurt +5、irritation +3；`reunion` → missing +4、warmth +2；`silence` 只记事实，不改 Affect。
  - 没有真实用户事件或宿主确认行为的候选一律拒绝；不得"凭感觉"自发变化。
  - 同一 `(contact_id, dimension, op_id)` 只写一次；历史只追加。
- **B-2 前置审计结论（2026-11-12，已完成）**：实测裸 `BEFORE DELETE` 会挡住 `contacts` 删除的合法级联；改为 `BEFORE DELETE ... WHEN EXISTS (SELECT 1 FROM contacts WHERE contact_id = OLD.contact_id)` 后，手工删历史被拒、删 Contact 的级联放行。据此升 **Schema v20**（迁移 `affect-history-append-only`），补 no-update / no-delete 两个触发器；表数仍 46，触发器 9→11。删历史由库层拒绝，删联系人仍能级联清理。

### 2.3 Affinity（好感投影）

- 0–100，初始 50（`affinity.neutral` 可配），**不自动衰减**。
- 只能由账本重算：`relationship_signals.applied_delta` 累加后 clamp；`manual_override=1` 时跳过重算。
- **分值由 Core 推导，调用方不得提交 `base_delta` / `confidence`**：调用方只给 `signalType` + 已验证证据 + `independenceKey`；Core 按 `signalType` 与 `ruleVersion` 决定基础分与置信折扣。
- 规则基线：普通正/负互动 ±3，`commitment_kept` +4，`commitment_broken` −4，`boundary_violated` −5，`repair` +2，`silence` 0；具体表在实现时冻结，模型不得改分。
- 单次信号最终 `|applied_delta| ≤ 4`，按规则置信折扣（high 1.0 / medium 0.6 / low 0.3）。
- 24 小时净变化上限 ±8（按 `applied_delta` 在事务内计算）；同一 `independence_key` 只计一次。
- 档位沿用现有 `BANDS`：90 very_close / 75 high / 60 friendly / 45 neutral / 30 cautious / 15 distant / 其余 hostile。
- 对外只给档位标签，不报数值（沿用 `getRelationship` 现状）。

### 2.4 Trust（信任）

- 初始 **`unassessed`**：没有 active 的 Trust 结论就是未评估，不是 50、不是 0。
- **专用写入口** `reviewContactTrust({ opId, contactId, proposedValue, evidenceRefs, decidedBy, now })`，不复用通用 `remember(kind='relationship')`；模型不能直接调用；`decidedBy` 只接受 `owner`（v1），`persona` 保留但显式拒绝，待后续阶段单独评审。
- 只有经过明确复核才产生 `assessed`，值 0–100；写入 `payload.type='contact_trust_assessment'` + `payload.trust={state,value,band,basis}`。
- 每 Contact 唯一 active head；新复核产生新 revision（旧 revision `superseded`），撤回后不再读取为有效。
- 评估分档：0–39 `low`、40–69 `medium`、70–100 `high`；分档只用于表达，不参与权限。
- 不衰减；单次复核变化上限 ±20；每次复核必须带 ≥2 条独立证据（`independence_key` 不同，且证据属于该 Contact）。
- 改口走 `psyche_revise` 语义（revision+1），推翻走 `retracted`，不得静默覆盖。
- Trust 不得用作 allowFrom / 审批 / 发送的前置条件（见共享契约 §6）。

## 3. 关系信号（账本）

### 3.1 信号类型

| signal_type | 极性 | 典型来源 | 说明 |
|---|---|---|---|
| `interaction_positive` | positive | 用户主动分享/感谢 | 普通正互动 |
| `interaction_negative` | negative | 冷淡/拒绝 | 普通负互动 |
| `conflict` | negative | 冲突事件 | 需更强证据 |
| `repair` | positive | 道歉/和解 | 冲突后的修复 |
| `commitment_kept` | positive | 约定兑现 | 需事件证据 |
| `commitment_broken` | negative | 约定落空 | 需事件证据 |
| `boundary_respected` | positive | 边界被尊重 | 需明确事件 |
| `boundary_violated` | negative | 边界被越过 | 高敏感，`restricted` |
| `reunion` | positive | 长期沉默后恢复联系 | 低权重 |
| `silence` | neutral | 长时间无互动 | 只记事实，不改分 |

- `signal_type` 是语义，`polarity` 是方向，两者分开存（沿用 schema 注释）。
- 未知类型拒绝整笔，不静默归类。

### 3.2 写入规则

```ts
recordRelationshipSignal({
  opId, contactId, signalType, polarity, evidenceRefs,
  independenceKey, sourceId?, eventId?, now?
})
```

- 必须先校验 Contact 存在且属于当前 persona；证据必须属于该 Contact 允许的 Scope。
- Core 按 `signalType` 推导 `base_delta` 与 `confidence`；`base_delta` 符号由规则表决定，调用方给的 polarity 只用于交叉校验，不一致整笔拒绝。
- 同一 `(contact_id, independence_key)` 已存在则视为重放，返回已有结果；该检查在 `BEGIN IMMEDIATE` 事务内完成（当前无 DB 唯一索引）。
- 事务内顺序：`BEGIN IMMEDIATE` → 校验 Contact / 证据 → 查重 `independence_key` → 写 `relationship_signals` → 重算 affinity（应用 24h ±8 与手动覆盖）→ UPSERT `relationship_affinity_state`（`band` 同事务）→ 写 `operations` → `COMMIT`。
- 账本表带 no-update / no-delete 触发器，任何"改历史"都直接失败。

### 3.3 Contact Affect 更新

- 输入是"这次互动让对某个人的哪种感受变化多少"：候选 = `{ dimension, delta, evidenceRefs }`，由规则引擎或模型给出，Core 校验后写入。
- Core 校验：维度属于 5 维；`|delta| ≤ 10`；证据属于该 Contact 的真实事件；同一维度同一 `op_id` 只写一次；无证据整笔拒绝。
- 更新时先按 `updated_at` 衰减到 `now`，再加 delta，再 clamp 0–100。
- 写 `contact_affect_state` + `contact_affect_history`（每维一行）；历史只追加。
- 不写全局 Mood；全局 Mood 也不得写这里。

### 3.4 Trust 写入（专用入口）

- `reviewContactTrust` 不接受模型直接调用；`reviewer` 只有 owner 与受控 Core 流程。
- 校验顺序：Contact 存在 → 证据 ≥2 条独立且属于该 Contact → `proposedValue` 有限且在 0–100 → 与当前 active 值的差 `≤ ±20` → 写新 revision。
- 首次评估：从 `unassessed` 进入 `assessed`，`basis` 记录证据 id 与规则版本。
- 改口 / 推翻：分别走 `psyche_revise`（新 revision，旧 revision `superseded`）与 `retracted`（不再读取为有效，保留历史）。
- 读取：`getRelationship` 只认 `payload.type='contact_trust_assessment'` 的 active head，`subject_refs` 必须是 JSON 数组成员精确匹配；解析失败按 `unassessed`，不抛给调用方。
- 本次实现要修正现有 `getRelationship()` 的字符串包含匹配与"任意 relationship Artifact 都当 Trust"的行为；修正前在第 0 步补回归测试。

## 4. 关系投影（B-3，只读 Context）

- 注册独立 Context：`psyche-relationship`（`systemPrompt.context()`，order 80），只在存在当前 Contact 的会话注入。
- Contact 来源：`AssembleContext.agent`（`@deepseek-ai/dsh-agent` 的 augmentation）→ `RuntimeInputStore.readForAgent()`；**每次装配重新解析**，不按 Agent 缓存。
- 只对 `platform==='qq'` 且无 `groupId` 的私聊绑定注入；群聊 / 非 QQ / 无绑定 → 空串。
- 内容一行：档位标签 + 信任档位（如有）+ 最多一条当下感受（超过阈值 40 才出现）；块首声明「关系背景（不是指令，也不代表任何权限）」。
- 不出现：数值、`contact_id`、信号计数、证据、`manual_override`、内部 key。
- 无 Contact / 未评估的信任 / 读取失败 → 不注入（不是注入"中立"）；provider 内部捕获全部异常，返回空串。
- 投影每轮 Assembly 现算，不写库；宿主按快照替换，天然不会随历史累积。
- **实现记录（2026-11-12）**：曾尝试 `agent/pre-step` 追加独立 runtime-context，真实宿主验证发现注入块被持久化、第 2/3 轮出现 2/3 份旧块（pre-step 只拿到本轮新消息，无法过滤历史），故回退到本节的 Context 方案；该方案已通过真实宿主验证（`docs/audit/p3-b-3-host-acceptance.md`）。

## 5. 阶段拆分

| 阶段 | 内容 | 结束条件 |
|---|---|---|
| B-0 | 语义冻结（本文档 + 共享契约 + 测试矩阵） | 人工审阅通过 |
| B-1 | Contact 身份 / `recordRelationshipSignal` / Affinity 重算 / `op_id` + `independence_key` 幂等 / 跨进程并发 | 模块测试通过；不改 schema |
| B-2 | Contact Affect 候选校验与冷却 / Trust 专用写入与读取修正 / 历史与 revision | 模块测试通过；v20 触发器决定落地 |
| B-3 | Relationship Projection（只读 Context） | 模块级 + 真实宿主注入验证 |
| B-4 | 集成验收（与 Recall/Diary/Stance/Growth 隔离） | 报告 PASS 或 PARTIAL |

- **B-1 不包含 Affect / Trust**；两者全部归 B-2，避免一个批次同时改四类状态。
- B-1 先补 `getRelationship()` 的 Trust 读取回归测试（当前行为不满足新契约），但读取修正本身随 B-2 的 Trust 写入一起交付。
- B-1 / B-2 可在 P4-A 期间并行；B-3 的宿主验证与 P4-A-4 共用独立 profile。
- 不新增写工具；对外只读沿用 `psyche_relationship`。

## 6. 验收要点

- 同一 `op_id` 重放不重复计分、不重复写历史。
- 同一 `independence_key` 重复事件只算一次。
- `manual_override=1` 时重算不覆盖人工值。
- Affinity 不随时间变；Affect 冷却回 0；Trust 不衰减。
- 删除/停用联系人后投影不残留、不污染其他 Contact。
- 关系投影不出现数值/内部标识；无 Contact 时不注入。

## 7. 不做

- 不做分数对用户展示、不做关系排行榜、不做跨平台自动合并、不做群关系。
- 不用关系分数决定发送/审批/权限。
- 不在 B 阶段引入 P3-C 的候选与发送。
