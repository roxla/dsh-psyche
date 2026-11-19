# P3-A B2 每轮判定契约 · 设计冻结 v1.1

- 状态：**待评审冻结**（契约层），实现层见 §8 差异表
- 日期：2026-11-11
- 上游：`docs/design/p3-a-mood-state-machine.md`（B0 冻结 v1.0）、`docs/design/p3-a-b2-turn-evaluation.md`（B2 数值规则 v1.0）
- 下游：`docs/audit/p3-a-b2-turn-evaluation.md`、`docs/audit/p3-a-design-freeze.md`
- 修订记录：B0-REV-4（本文件）

> 本文只冻结「谁能改 Mood、改之前 Core 校验什么、改不动时怎么办」，不重复 B0 的 33 维语义与衰减公式，也不提前引入 B3 的语气投影。

---

## 0. 与已交付 B2 v1 的关系

B2 v1 已在 v27.57 落地（commit `5c1b950`，18 文件 / 1863 插入；全量 3231 断言 / 109 步 / 0 失败），当时冻结的是 **确定性关键词候选**（`mood-evaluator.ts`，零模型调用、零网络、零随机）。

本文按 2026-11-11 的评审意见把「判定契约」单独冻结，目标是把 B2 从「能算分」收紧为「可审计的判定层」。两份文档不冲突：**v1.0 管数值规则，v1.1 管输入、候选与写入边界**。§8 明确列出 v1 现状与契约的 6 处差距及收敛动作；差距未收敛前，v1 的既有测试仍作为回归基线。

---

## 1. 每轮判定输入

固定数据链：

```
turn/start（宿主事件，轮次开始）
  → 轮次上下文固化（initiator + eligibleEvidence 白名单 + configVersion）
  → 本轮消息完成
  → agent/turn-stopping（只触发提交，不推断来源）
  → Core 校验候选
  → Mood Store 原子写入
```

每轮必须携带：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `turnId` | 宿主 | `sessionRef` + `turn` 整数；DSH 的 `session/event.user/message` 不带 `turn`，因此**禁止**用它推断轮次 |
| `initiator` | 宿主可信元数据 | 轮次开始时固化，turn-stopping 只读 |
| `eligibleEvidence` | 本轮 pre-step 的 `messages` | 只收 `source.kind === 'user'` 的消息，按 message id 建白名单 |
| `configVersion` | 代码常量 | `MOOD_CONFIG_VERSION`，随规则表升级 |
| `ruleVersion` | 本文 §4 | 候选校验与限幅所用规则表版本 |

硬约束：

1. 不能从最后一条消息的 `role` 推断 Initiator。
2. Assistant 回复属于当前轮次，**不得**重新判定或覆盖 Initiator。
3. 模型不得填写、修改 Initiator。
4. 中途取消、报错、未正常完成的轮次不提交情绪变化。
5. `turn-stopping` 只负责触发提交，不负责推断本轮是谁发起的。

---

## 2. Initiator 解析

优先级沿用 B0：`scheduled > persona > user > unknown`。优先级**只用于解析可信宿主元数据之间的冲突**，不得根据消息角色、文本内容或模型判断来决定。

| Initiator | 可信来源 | 是否产生 delta |
| --- | --- | --- |
| `user` | 宿主确认的真实用户输入 | 允许，依据用户输入证据 |
| `persona` | 宿主确认的人格主动行为 | 允许，但必须有明确行为事件 |
| `scheduled` | 宿主调度器的定时事件 | 允许，但必须有明确事件依据 |
| `unknown` | 来源缺失、无法验证或外部注入 | **不允许** |

补充规则：

- 外部插件注入（含 memory-context、delegated review 等）**不得**被当作人格主动行为；归 `unknown`，自身不产生 delta，也不得混入可信用户证据。
- 宿主无法区分可信消息与注入内容时，**整轮降级为无变化**，不猜测。
- 固化时机：一轮的第一个 `pre-step` 解析一次，写入该轮 record；之后不再重算。
- DSH 现状：`user` 与 `unknown` 有真实来源；`persona` / `scheduled` 需要 P3-C 的宿主事件，v1 预留 token 形态但**无生产者**（见 §9）。

---

## 3. 候选与 Core 校验

模型（或规则生产者）只返回候选，**Core 才拥有写入权**。

```
type MoodCandidate = {
  producer: 'rules' | 'model';
  ruleVersion: number;
  deltas: Array<{
    dimension: MoodDimension;      // 必须是冻结的 33 维之一
    delta: number;                 // 有限数值
    evidenceMessageIds: string[];  // 必须落在本轮白名单内
  }>;
};
```

候选**不得**提供：`initiator`、`opId`、`timestamp`、当前 Mood 绝对值、`baseline`、`configVersion`、任何数据库写入参数。

Core 至少校验：

1. `dimension` 属于冻结的 33 维。
2. 当前 `eventType` 允许修改该维度。
3. `delta` 是有限数值，拒绝 `NaN` / `Infinity` / 字符串 / `null`。
4. 方向与最大变化量符合 §4 规则表。
5. 引用的证据属于本轮 `eligibleEvidence`。
6. 同一维度不出现重复或互相冲突的候选。
7. 不能通过候选绕过 baseline、上下限与衰减规则。

失败策略：

- **结构异常整批拒绝**（未知维度、缺证据、方向冲突、超限），不悄悄丢弃异常维度后继续写剩余候选。
- 结构合法但数值超限时，按硬性 `maxDelta` 限幅，并在结果里记 `clamped: true`。
- 拒绝结果可审计（`reason` 区分 `candidate-invalid` / `candidate-out-of-range`），但不写 Mood 历史。

---

## 4. Deltas 规则表

每种事件类型有固定规则，模型不能自由选择可修改的维度。

| 字段 | 作用 |
| --- | --- |
| `eventType` | 本轮事件类型 |
| `allowedDimensions` | 允许变化的维度集合 |
| `allowedDirection` | `increase` / `decrease` / `both` |
| `maxDelta` | 单次最大变化量（默认 8，范围 1–20） |
| `confidenceThreshold` | 候选最低可信阈值（规则生产者按命中数；模型生产者按自报置信度） |
| `configVersion` | 规则版本 |

事件类型（v1 只实现第一类）：

| eventType | 触发来源 | v1 状态 |
| --- | --- | --- |
| `user_message` | 真实用户输入 | 已实现（关键词规则） |
| `persona_action` | 人格主动行为事件 | 预留，无生产者 |
| `scheduled_event` | 调度器事件 | 预留，无生产者 |
| `unknown` | 不可信来源 | 只允许无变化 |

具体维度数值仍以 `p3-a-b2-turn-evaluation.md` §4 为准；本文只冻结「哪些事件能改哪些维度、能改多少、证据从哪来」。

`persona` / `scheduled` **不得**仅因为 Assistant 发出了一段文字就产生情绪变化，必须有明确行为事件与证据，避免「自己说了什么 → 自己产生什么情绪」的自反馈。

---

## 5. 失败降级与幂等

| 情况 | 行为 |
| --- | --- |
| Initiator 不可信 | 无变化 |
| 候选缺失 / 生产者失败 | 无变化 |
| 候选结构异常 | 整批拒绝 |
| Store 写入失败 | 整笔事务回滚，不影响对话本身 |
| 重复 `turnId` | 不得重复累加 |
| 并发提交 | 由 Store 事务 + 唯一约束保证只生效一次 |
| 任意失败 | 不得自动回退到「模型自推 Initiator」或无约束规则 |

**空结果幂等审计**（对应评审意见第 5 条）：

- B1 现有的持久化结构只有 `mood_meta.last_op_id`（单值）与「一次成功写入 = 33 行 history」。**没有**承载「本轮判定过、结果为空」的位置。
- 不新增表（B0-REV-1 已限定 B1 只加 1 表；此处不为空结果再开一张）。新增列也需单独评审，v1.1 暂不做。
- 结论：v1.1 用**进程内 `evaluatedTurns` 集合**去重 + 候选生产的确定性保证重算等价；`take()` 消费本轮文本后，第二次触发拿不到内容，自然返回 `no-content`。
- 崩溃重启后旧轮不会再次触发 `turn-stopping`，因此不做持久化补偿。
- **状态：PARTIAL · 已知限制**（不得写成完全通过）：
  - 同一进程内重复触发：去重；
  - 已成功写入的轮次：B1 持久化幂等（`op_id`）；
  - 无变化轮次：仅进程内去重，重启后允许确定性重算；
  - **不承诺跨重启的空结果 exactly-once**。
- **若将来接入模型候选**（结果不确定）或「宿主无法保证完成轮次不被重放」，必须把空结果收据提升为正式持久化需求（`mood_meta` 增列或按轮记录），届时另行评审；不得用内存 Map 掩盖缺口。

---

## 6. 职责边界

B2 只负责：

```
可信输入 → Initiator → 候选校验 → Global Mood 更新
```

不接入：Contact Affect / Affinity / Trust；语气投影与 Prompt 注入（B3）；Recall / Diary / Stance / Growth；主动联系决策（P3-C）。

出问题时影响范围必须仍局限在 Mood 持久化层。

---

## 7. 验收组

| 验收组 | 必须证明 | 对应测试 |
| --- | --- | --- |
| Initiator | 四类来源正确；Assistant 不覆盖用户轮；来源冲突按规则解析；轮首固化 | `test/mood-initiator.ts`、`test/mood-wiring.ts`、`test/mood-turn.ts` |
| Evidence | 只用可信本轮证据；外部注入不产生 delta；证据 id 越界拒绝 | `test/mood-evaluator.ts`、`test/mood-wiring.ts`、`test/mood-rules.ts` |
| Candidate | 33 维白名单；事件约束；数值边界；证据引用；异常整批拒绝 | `test/mood-rules.ts`、`test/mood-turn.ts` |
| Store | 单轮原子写入；幂等；并发去重；事务回滚 | `test/mood-store.ts`、`test/mood-idempotency.ts`、`test/mood-concurrency.ts` |
| Failure | 模型/来源/存储失败均无意外状态变化 | `test/mood-turn.ts` |
| Isolation | 不写 Artifact / Evidence / FTS；不影响 Recall / Diary / Stance / Growth | `test/mood-isolation.ts`（B2 模块级）、`test/mood-turn.ts` 第 16 组 |

集成级隔离（Mood 生效后其他功能结果不变）仍放 B5。

### 7.1 专项验收（用户 m01052 指定的 8 项）

| # | 验收点 | 覆盖 |
| --- | --- | --- |
| 1 | 同一维度重复候选，整批拒绝 | `test/mood-rules.ts`（duplicate-dimension） |
| 2 | 合法 + 非法维度混合，整批拒绝、不写合法部分 | `test/mood-rules.ts`（mixed）、`test/mood-turn.ts` 第 11 组（拒绝不写历史） |
| 3 | 候选引用其他轮次 Message ID，整批拒绝 | `test/mood-rules.ts`（evidence-not-allowed） |
| 4 | Assistant 回复不能改变已冻结 Initiator | `test/mood-turn.ts` 第 9 组、`test/mood-wiring.ts`（只收 user） |
| 5 | 缺可信来源时，后续模型文本不能补出 user/persona | `test/mood-turn.ts` 第 14 组（untrusted-initiator） |
| 6 | 外部插件注入即使命中关键词也不产生 delta | `test/mood-wiring.ts`（source.psyche 标记 + `msg_psyche_` 前缀） |
| 7 | 配置版本变化不能使已完成轮次获得新变化 | `test/mood-turn.ts` 第 15 组（候选拒绝 + state_version/history 不变） |
| 8 | Recall / Diary / Stance / Growth 不因 B2 v1.1 改变 | `test/mood-isolation.ts`、`test/mood-turn.ts` 第 16 组（Source/Artifact/Event 计数不变） |

---

## 8. 与已交付 v1 的差异与收敛计划

> **实施状态（2026-11-11，v1.1 / DEV v27.58）**：第 1、2（规则生产者）、3、4、6 项已落地；第 5 项为 **PARTIAL · 已知限制**（进程内去重，不承诺跨重启空结果 exactly-once）。整体结论：**确定性判定链完成；空结果跨重启幂等为已知限制**，不标为六项全过。

| # | 契约要求 | v1 现状 | 动作 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 候选带 `evidenceMessageIds`，Core 验白名单 | evaluator 只回维度分数，不记消息 id | 改 `mood-evaluator` 返回每维证据；buffer 存 `{id,text}`；`applyMoodTurn` 校验白名单 | ✅ `evidence` 逐维返回；`evidenceIds` 对齐；无 id 时生成本轮稳定占位 id |
| 2 | 模型候选 + Core 校验 | 确定性关键词规则，无模型调用 | 规则生产者作为 `producer:'rules'`；模型生产者后续可插拔 | ✅ 规则生产者；校验层与生产者解耦 |
| 3 | 显式 `eventType` / `allowedDimensions` / `allowedDirection` / `confidenceThreshold` / `configVersion` | 30 组信号直接映射维度，无事件表 | 新增 `MOOD_RULES` 常量与校验函数 | ✅ `mood-rules.ts`（v1 四条事件规则、`MOOD_RULES_VERSION=1`） |
| 4 | 结构异常整批拒绝 | 未知维度静默丢弃 | 由 Core 拒绝整批，`candidate-rejected` + `violations` | ✅ 7 类校验；合法数值按 `min(规则,调用方)` 限幅 |
| 5 | 空结果持久化标记 | 无标记，仅进程内消费 | 冻结为内存去重，不加表列 | ⚠️ **PARTIAL**：buffer `take()` 消费即清；重复触发→`no-content`；**跨重启不承诺 exactly-once** |
| 6 | Initiator 轮首固化 | turn-stopping 时解析 | buffer 记录 `initiator:'user'`，stopping 只读 | ✅ `snapshot.initiator` 优先；非法值回退解析 |

> 收敛顺序：3 → 1 → 4 → 6 → 5 → 2（实际实施顺序；第 2 项拍板为规则生产者）。

---

## 9. 决策与未决项

1. **候选生产者（已定）**：v1.1 使用确定性规则（零 LLM 成本、可测、fail-closed）；模型生产者留作后续可插拔项，Core 校验层对两者一致。接模型时需补超时/失败预算与持久化收据。
2. **persona / scheduled 的可信来源（已定）**：P3-C 之前没有生产者，v1.1 保持不可达（识别出来也不写）。
3. **空结果持久化（已定，PARTIAL）**：接受进程内去重，不加表/列；跨重启空结果不承诺 exactly-once。若未来接模型候选或宿主无法保证完成轮次不被重放，必须改为持久化收据。

---

## 复现

```powershell
cd <repo>
npm run build
node test/mood-initiator.ts
node test/mood-evaluator.ts
node test/mood-rules.ts
node test/mood-turn.ts
node test/mood-wiring.ts
npm run test
```
