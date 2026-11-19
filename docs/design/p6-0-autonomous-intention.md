# P6-0 自主意愿层：契约与边界（冻结）

状态：**冻结**（2026-11-16，经外部评审 2 轮收敛）。
来源：《让大肥鱼自己起念头：从「能感知」到「会想事」》（B 站 `BV1f3W269EEE`）的方案与验收标准。

## 1. 定位

Psyche 已有 Mood/Affect、Memory/Recall、Growth、Proactive（审批制外发）、Projection。缺的是把状态与记忆收束成「自己的下一步」的中间层。

P6 只做这件事：**从真实状态与记忆里形成一个可解释的内部关注，再决定是否暂存、延后或放弃。形成意愿不等于获得行动权，更不等于允许自主外发。**

P6-0 只交付只读契约与纯函数模块；P6-1 才在可信 Host 数据上做只读运行与可选投影，P6-2 才评审持久化。

## 2. 五类关注源（唯一口径）

1. **情绪与关系变化**：Mood 单维持续偏离基线（`|value-baseline| ≥ 10` 且 `sustainedTurns ≥ 3`）；Contact Affect 的 tension/hurt/missing/irritation `≥ 40`。
2. **空闲时段**：只有可信的最近互动时间与安静起点同时存在，安静 ≥ 2h 且距上次互动 ≥ 12h 才算；不得据此推断「无聊」。
3. **未完成承诺**：`status='open'` 且超过 24h 未更新，带证据。
4. **未完成计划**：`status='open'` 且超过 24h 未更新，带证据；与承诺分开展示。
5. **反复出现的主题**：窗口 14 天内出现 ≥ 3 次，且带证据。

任何一项都必须有 Scope、证据引用与可信度；证据为空、时间非法、作用域非法一律跳过并记录原因，不静默伪造。

## 3. 数据结构

`packages/core/src/intention-attention.ts`

- `AttentionScope = { kind: 'personal' | 'contact' | 'room', id? }`
- `AttentionItem = { attentionId, kind, scope, title, evidenceIds, confidence, detectedAt }`
- `scanAttention(input)` → `{ items, skipped, truncated }`；上限 20，稳定排序（类型顺序 → 可信度降序 → id）。

`packages/core/src/intention-candidate.ts`

- `IntentionCandidate = { intentionId, attentionId, kind, scope, title, score, evidenceIds, createdAt, expiresAt }`
- 每 Persona 最多 3 条，TTL 固定 24h；`intentionId = sha256(personaId|attentionId)` 稳定键。
- score 只用于排序：类型基分 + 可信度 × 0.2；承诺基分最高。

`packages/core/src/intention-choice.ts`

- 只有三种结果：`internal`（仅保留为内部关注，不执行任何动作）、`defer`（延后评估，必须附原因与下次允许评估的条件）、`abandon`（放弃当前候选；没有实质新证据不立即重生成）。
- 同一 Persona 同时最多 1 条 `internal`；其余按分数降序 `defer`。
- 同一证据键（排序后的证据 id 哈希）在 prior 中已 internal/defer → 直接 abandon，避免每轮重复生成「新意愿」。
- 不提供 action 能力；即使传入 `allowAction` 也不会产生动作。

`packages/core/src/intention-projection.ts`

- 只读产物 `{ version, observeOnly: true, line, intentionId, evidenceIds, truncated }`。
- 最多 1 条、≤120 字；没有 internal 时 `line=null`，不伪造念头。
- 不出现「检测到」「内部触发」「系统播报」这类播报式措辞；长标题截断并标记。

## 4. 五条不可越过的边界

1. **不注册独立 Context、不向生产模型注入**：P6-0 只产出只读投影；后续只能经 `PsycheProjectionComposer` 的可选分段接入，必要投影优先，预算不足先舍弃意愿段。
2. **不写账本**：不写 Source/Event/Artifact/Growth，不建 Draft/Approval/Outbox，不调用工具、不发 QQ、不改 `identity.md`。
3. **不调模型**：P6-0 只规则；措辞由现有角色层决定。
4. **不越 Scope**：Contact Affect、记忆证据、意愿候选都必须过同一可信 Scope/Disclosure 校验；`personal` 不等于某个 Contact 的私有内容。
5. **不承诺长期连续性**：P6-0 是运行期临时状态，重启不保证恢复、不保证跨会话连续、不声称长期独立偏好；不把用户无回应当负面，不因 TTL 自动触发模型或外发。

## 5. 六项验收的分阶段口径

| 指标 | P6-0 能证明什么 | 判定 |
| --- | --- | --- |
| 自主产生 | 规则可在无主人请求时生成内部候选 | PASS（模块级） |
| 记忆联想 | 候选带真实、可回溯的证据引用 | PASS（模块级；Host 数据绑定后复验） |
| 独立偏好 | 只能证稳定规则遵守既有 Persona 约束，不足以证明真正独立偏好 | 部分 / 不宣称 |
| 意愿连续 | 只证运行期内稳定、去重与延后；跨重启不保证 | 部分（P6-2 持久化后复验） |
| 经验改变 | 未接反馈闭环 | NOT VERIFIED（P6-2） |
| 表达自然 | 可做静态文案验收；真实模型表达需 Host | 部分 / Host 验 |

## 6. 实施顺序

1. **P6-0**：本契约 + 四个纯函数模块 + 确定性测试；不接线、不注入、不写库。
2. **P6-1**：在可信 Host 数据绑定后做只读运行；经 Composer 可选分段投影；Host 快照只证投影出现，不等于 H-2。
3. **P6-2**：单独评审 Schema v31（`intentions` + `intention_events`）、反馈与长期连续性；不得绕过 Owner 审批。

## 7. 明确不做

- 不做自主外发、不做自主工具调用、不做后台定时生成、不做 UI 之外的行动。
- 不把「意愿」当权限、不把「状态」当命令、不把「没有执行」当意愿无效。
- 不改变 P5 冻结、B-4-2 生产未批准、B4/H-2 BLOCKED 的既有结论。
