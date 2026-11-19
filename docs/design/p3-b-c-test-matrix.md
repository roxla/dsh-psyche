# P3-B / P3-C 测试矩阵（B-0 / C-0 冻结候选）

日期：2026-11-12（D-1 修订）
状态：设计已修订，可进入 B-1 / C-1；只定义验收，不含实现
关联：共享契约、P3-B、P3-C 三份设计稿
基线：DEV v27.73、Schema v19、Git `a6705e9`；修订后 DEV v27.74

## 1. 测试分层

| 层 | 证明什么 | 何时 |
|---|---|---|
| 模块级 | 纯规则、Store 事务、幂等、隔离 | B-1/B-2、C-1/C-2 |
| 投影级 | Context 只读、不泄漏、失败不注入 | B-3 |
| 宿主级 | 真实 DSH 生命周期、注册/注销/重启 | B-3、C-4 |
| 端到端 | 审批 → 发送 → 回执（Mock OneBot 先行） | C-3/C-4 |

## 2. 共享测试设施（一次建设，两个阶段复用）

| 设施 | 用途 |
|---|---|
| `FakeClock` | 固定 `now`，验证冷却、衰减、窗口、静默时段 |
| `ContactFactory` | 建 Contact / 身份 / 展示名，不碰真实数据 |
| `EvidenceFactory` | 构造 Source→Event→Artifact 链与独立证据键 |
| `ScopeGuard` | 断言跨 Contact / 跨会话不串 |
| `IdempotencyHarness` | 同 `op_id` / `independence_key` 重放 |
| `DBSnapshot` | 写前后非目标表零变化 |
| `MockOneBot` | P3-C 发送链路（沿用 P4-A-2 的本地 OneBot 端） |
| `ContextProbe` | 真实 Assembly 的 Context 内容与顺序 |

## 3. P3-B 模块级

### 3.1 身份（B-T1）

- 同一 `(platform, stable_user_id)` 只产生一个 `contact_id`。
- 同昵称不同平台不合并。
- 未确认的 `contact_identifiers` 不参与身份合并。
- 空/非法 identity 拒绝，不造 Contact。

### 3.2 账本与好感（B-T2）

- 信号写入：极性符号与规则表不一致整笔拒绝；未知 `signal_type` 拒绝。
- **调用方不提交 `base_delta` / `confidence`**：实现必须从 `signalType` + `ruleVersion` 推导；若接口仍暴露这些字段，测试应失败。
- 同一 `op_id` 重放：不新增信号、不重复改投影。
- 同一 `independence_key` 重复事件只计一次；`BEGIN IMMEDIATE` 内查重（当前无唯一索引）；补跨进程并发测试。
- 单次 `|applied_delta| ≤ 4`，规则置信折扣正确，24h 净变化 ≤ 8。
- `manual_override=1` 时重算不覆盖；`band` 与 `affinity` 同事务一致。
- 账本行 UPDATE / DELETE 被触发器拒绝。

### 3.3 信任（B-T3）

- 无 active 结论 → `unassessed`（不是 0、不是 50）。
- **只有 `payload.type='contact_trust_assessment'` 的 active head 才算 Trust**；普通 `kind='relationship'` Artifact 即使带 `payload.trust` 也不能被读取（回归测试覆盖）。
- `subject_refs` 必须是 JSON 数组成员精确匹配；字符串包含匹配不得通过。
- 复核需 ≥2 条独立证据；单次变化 ≤ 20。
- 改口产生新 revision（旧 `superseded`）；推翻记 `retracted`，之后读为 `unassessed`。
- 信任不随时间衰减；读取只取 active head。
- 模型不能调用 Trust 写入口；非 owner / 非受控流程的 `reviewer` 拒绝。

### 3.4 Contact Affect（B-T4）

- 5 维初始 0；冷却按半衰期回 0，不回 50。
- 只由该 Contact 事件更新；不读写全局 Mood。
- 历史只追加；同 `op_id` 幂等。

### 3.5 隔离（B-T5）

- 两个 Contact 的 affinity / affect / trust 互不影响。
- 群聊上下文不把 A 的关系注入给 B。
- 删除联系人后投影不残留、其他 Contact 数据不变。
- 关系写入不改 `sources/events/artifacts`（除 relationship 结论本身）与其他模块表。

## 4. P3-B 投影级（B-T6）

- 只注入当前 Contact；无 Contact 不注入。
- 内容只有档位标签 + 信任档位 + 最多一条感受；无数值、无内部 key、无证据。
- 未评估/读取失败 → 不注入，不显示"中立"。
- 每轮 Assembly 现算，前后 DB 零写入。
- 与 `psyche-memory` Section、`psyche-mood-tone` Context 共存，互不覆盖。

## 5. P3-C 逻辑（C-T1 ~ C-T4）

### 5.1 触发（C-T1）

- 三类 trigger 只产生候选，不直接发送。
- 同一输入（含 `now` / trigger 参数）→ 同一 `triggerId` 与同一淘汰结果（确定性），**不测跨重启只扫描一次**。
- `scheduled_review` 不因 Mood 的 `scheduled` initiator 自动获得发送资格。

### 5.2 资格（C-T2，八项）

- 逐项负向：Contact 不存在、通道离线、无 `outboundConsent`、时区未知、冷却、静默时段、额度满、重复候选。
- 通道离线与时区未知 → **等待**，不是资格淘汰；恢复后可继续，不要求重新判定同意。
- 静默时段按**收件联系人**的可信 IANA 时区；无时区 → `timezone-unknown`，不生成可发送草稿。
- 被淘汰候选有原因码，不生成草稿。
- `allowFrom` 命中但 `outboundConsent` 未授权 → `no-consent`。
- Affinity/Trust 再高也不能绕过同意与审批。
- v1 不测"联系人停用"（无 active 列）；资格失效只由 consent 撤回/过期驱动。

### 5.3 候选与草稿（C-T3）

- 评分只排序；同分按 `contact_id` 稳定排序。
- 候选 ≤20；超限截断可解释。
- 草稿只引用已有证据；不得编造事实/承诺。
- 草稿 ≤500 字；超长必须先生成精确分段预览，审批看到的分段与实际发送一致。
- 同一候选只有一份待审草稿；编辑产生新 revision，旧审批失效。
- Mood 语气只改措辞，不改事实与请求。

### 5.4 审批（C-T4）

- 非 owner 不能写入 decision。
- 审批只绑定 `draftRevision`；revision 变化后旧审批失效。
- 审批 24h 过期失效。
- `rejected` 后 7 天内不重复生成同一候选。
- 同 `approvalId` 只能 Dispatch 一次。

## 6. P3-C 发送（C-T5，Mock OneBot）

- 发送前四道闸复核；任一不过不发送。
- 发送结果四态：`sent` / `failed` / `unknown` / `dispatching`；`failed` 不自动重试；`unknown` 先核验是否已送达，未确认前不得重发。
- 回执含 `dispatchId` / `approvalId` / `draftRevision` / `status`；不进入用户消息 Capture 语义。
- 群聊目标直接拒绝。

## 7. 宿主级（H 组）

| 编号 | 场景 | 期望 |
|---|---|---|
| H-B1 | 关系 Context 注册/卸载/重载/重启 | 只出现一份，卸载即消失 |
| H-B2 | 无 Contact 的桌面会话 | 不注入关系 Context |
| H-C1 | 审批后发送（Mock OneBot） | 一条私聊、一次回执、无重复 |
| H-C2 | 审批过期/撤同意/通道离线 | 不发送，状态可解释 |
| H-C3 | 重启后候选/审批状态 | 持久化正确（C-3 后） |

## 8. 证据与判定

- 模块级：逐套件自报「N 通过 0 失败」，断言数并入全量基线。
- 投影级：Context 内容 + DB 前后快照。
- 宿主级：运行时探针（agent/created、llm/stream）+ 数据库快照 + 发送动作记录。
- PASS：本阶段所有必测项通过，且未破坏既有模块结构化结果。
- PARTIAL：仅宿主能力缺口或未覆盖场景，需写明原因与是否阻塞下一阶段。
- NO-GO：关系状态越权（影响发送/审批/权限）、跨 Contact 串数据、未审批发送。

## 9. 与现有测试的关系

- 不修改已通过的 P2/P3-A 测试来"制造全绿"。
- 每个阶段独立测试文件，挂 `npm run test` 链尾，不合并成大套件：
  - B-1：`test/relationship-identity.ts`、`test/relationship-signal.ts`、`test/relationship-affinity.ts`、`test/relationship-concurrency.ts`；
  - B-2：`test/relationship-affect.ts`、`test/relationship-trust.ts`；
  - B-3：`test/relationship-projection.ts`；
  - C-1：`test/proactive-trigger.ts`、`test/proactive-eligibility.ts`；
  - C-2：`test/proactive-candidate.ts`、`test/proactive-draft.ts`；
  - C-3：`test/proactive-approval.ts`、`test/proactive-dispatch.ts`。
- 共享夹具先用测试内辅助函数（`test/helpers/` 下的本地模块即可），同一设施出现两处以上稳定复用再抽公共模块，不提前建包。
- B-1 的 Trust 读取回归测试可先写进 `relationship-identity` 或单独 `relationship-trust-read.ts`，但读取实现随 B-2 交付。
