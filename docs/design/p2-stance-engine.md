# P2 阶段 3：StanceEngine 设计冻结（v1.0）

> 阶段 3 不是「给 Stance 新增一张持久化表」，而是补「多个 belief 合成正式立场」的生命周期。
> 现有结构（`artifacts` / `artifact_revisions` / `artifact_evidence` / `artifact_lineage` / `decision_runs`）
> 已能承载立场的正文、版本、证据、派生来源和决策回执；缺的是合成规则与写入口保护。

## 1. 不重复造事实层

| 需要表达的东西 | 已有结构 | 阶段 3 是否新建 |
| --- | --- | --- |
| 立场身份 | `artifacts.kind='stance'` | 否（只加 `stance_key` 身份列，见 §7） |
| 立场版本 | `artifact_revisions`（append-only） | 否 |
| 依据 | `artifact_evidence` + `sources` | 否 |
| 从哪些 belief 派生 | `artifact_lineage`（derivedFrom） | 否 |
| 为什么合成 / 为什么修订 | `decision_runs` + `decision_items`（`kind='stance'`） | 否 |
| 立场自身的冲突状态 | `tension_versions`（既有） | 否 |

## 2. 核心语义（编码前必须固定）

### 2.1 哪些 belief 可以参与合成

只有同时满足以下条件的 belief 才进入候选集：

- `state = 'active'`（`challenged` / `retracted` / `superseded` / `forgotten` 一律不参与）；
- 带 `payload.stanceGroup`（非空字符串，≤100 字）与 `payload.stanceDirection`（`for` / `against` / `neutral`）；
- 该 belief 所在组内没有未解决的 Tension（`tension_versions` 里该 pair 的 head `status ∈ {open, investigating, parked}` 时拒绝合成）；
- 该 belief 与同组其他 belief 之间没有 `contradicts` 关系。

**没有显式标注的 belief 不参与合成。** 阶段 3 v1 不从正文猜方向——「同一个话题可以同时有喜欢和不喜欢」，靠文本关键词判断方向会把反例合成进同一条立场。

### 2.2 什么叫同类同向

`stanceKey = `${stanceGroup}:${stanceDirection}``。分组只看显式 `stanceGroup`，同向只看显式 `stanceDirection`。`subjectRefs` 只作为展示与检索字段，**不参与身份判定**。

### 2.3 稳定身份

- 一个 `stanceKey` 对应且只对应一个 stance Artifact；
- `artifacts.stance_key` 加部分唯一索引（`WHERE stance_key IS NOT NULL`），跨进程并发建同一 key 时第二个插入失败并回读；
- 没有 `stance_key` 的 stance（历史数据）视为「未绑定」，不参与自动修订。

### 2.4 证据去重

不累加各 belief 的 `independent_evidence_count`。合成时的独立证据数 = 所有参与 belief 当前 revision 的 `artifact_evidence.independence_key` 并集大小（跨 belief 去重）。门槛沿用 `checkPromotion('stance')`：独立证据 ≥2 且来源会话 ≥2。

### 2.5 什么时候修订

只有「立场正文发生实质变化」才追加 revision：

- 候选 belief 集合变化（新增 / 移除 / 某条 belief 被 revise 到新 revision）；
- 或跨 belief 去重后的独立证据数变化；
- 或归纳出的 statement 变化（按 §2.6 的确定性规则）。

只多了证据、结论表述不变 → 不生成新版本（回执也不写）。

### 2.6 正文怎么来（确定性，不调模型）

v1 不引入模型调用。stance 的 statement 由模板确定性生成：

```
「关于 {group}，{directionLabel}：{representativeStatement}」
```

- `representativeStatement`：参与 belief 中 `confidence` 最高者；同档取 `updated_at` 最新；再同则取 `artifact_id` 字典序最小（保证可重复）。
- `directionLabel`：`for → 倾向肯定`、`against → 倾向否定`、`neutral → 保持中立`。
- 同输入必须得到同输出（测试用固定夹具验证）。

### 2.7 冲突处理

- 组内存在未解决 Tension → 不合成、不修订（`skip`，原因 `unresolved-tension`）；
- 组内 belief 之间 `contradicts` → 不合成（`skip`，原因 `internal-conflict`）；
- 已存在的 stance 是 `challenged` → 允许修订，但新版本仍保持 `challenged`（不因合成自动「洗白」）。

## 3. 合成计划（纯函数）

```ts
export interface StanceBeliefInput {
  artifactId: string
  revision: number
  state: 'active'
  statement: string
  confidence: 'low' | 'medium' | 'high'
  updatedAt: string
  group: string
  direction: 'for' | 'against' | 'neutral'
  evidenceKeys: string[]
  sessionRefs: string[]
}

export type StancePlan =
  | { action: 'skip'; reason: 'insufficient-beliefs' | 'unresolved-tension' | 'internal-conflict' | 'insufficient-evidence'; key: string }
  | { action: 'create'; key: string; group: string; direction: string; statement: string; basis: { artifactId: string; revision: number }[]; evidenceKeys: string[]; sessionCount: number }
  | { action: 'revise'; key: string; statement: string; basis: { artifactId: string; revision: number }[]; evidenceKeys: string[]; sessionCount: number; changedBecause: 'basis' | 'evidence' | 'statement' }

export function planStanceSynthesis(input: {
  beliefs: StanceBeliefInput[]
  existing: { statement: string; state: 'active' | 'challenged'; basis: { artifactId: string; revision: number }[] } | null
}): StancePlan
```

纯函数：不读库、不写库、不取当前时间。所有输入由调用方（Core）从库里读成快照传进来。

## 4. 持久化（Core 内部，3.3）

`Core.#applyStancePlan(plan, deps)`，只在 `#write` 的事务里调用：

1. `create`：`INSERT artifacts(kind='stance', stance_key=plan.key)` → `#insertRevision`（state=active、statement、subjectRefs=[]、confidence=参与 belief 的最高档、evidence=按 evidenceKeys 建 draft）→ `artifact_lineage(derivedFrom, from=每条 belief 的精确 revision)`；
2. `revise`：`#head(stance)` → 新 revision（保留旧证据 + 新证据，`changedBecause` 写进 payload 便于追溯）；
3. 两种情况都写一条 Decision Receipt：`kind='stance'`、`actor='core'`、items = 参与 belief 的 `artifact@revision`、result = stance artifact + revision。

失败策略：合成 / 回执失败只 `warn`，不回滚触发它的主写入。

## 5. 触发时机（局部，不扫全库）

在以下写入成功后，只对受影响的 `stanceKey` 重新求值：

| 写入 | 触发 |
| --- | --- |
| `remember(kind='belief')` | 用该 belief 的 `stanceGroup/direction` |
| `revise`（belief） | 旧 head 与新 head 的组/方向 |
| `review`（belief 状态变化） | 该 belief 的组/方向 |
| `forget`（belief） | 该 belief 的组/方向 |

同一事务内最多重新求值 3 个 key（防一次写入触发海量重复计算）。

## 6. 写入口保护（3.6，已完成）

| 入口 | 规则 | 状态 |
| --- | --- | --- |
| `remember(kind='stance')` | 拒绝 | ✅ 原有 |
| `revise(supersedes, kind='stance')` | 拒绝 | ✅ 原有 |
| `revise(artifactId=stance)` | 拒绝 | ✅ 本次补 |
| `review(stance, statement)` | 拒绝改正文；允许改状态 | ✅ 本次补 |
| Core 内部 `#applyStancePlan` | 唯一合法写入口 | 待实现 |

`test/stance-guard.ts` 10 断言。

## 7. 是否需要 v17

需要，但只加一列：

- `artifacts.stance_key TEXT`（可空）+ `CREATE UNIQUE INDEX ... ON artifacts(stance_key) WHERE stance_key IS NOT NULL`；
- 理由：稳定身份必须能单条 SQL 查到并受唯一约束保护，`artifact_lineage` 反查会随新 belief 加入而失效；
- 不新建 `stance_versions` / `stance_history` / `stance_evidence`。

## 8. 不做的事

- 不调模型生成立场正文；
- 不把 `checkPromotion` 当合成引擎；
- 不给模型工具加「绕过保护」的参数；
- 不在合成时自动解决 Tension；
- 不为历史无 `stance_key` 的 stance 补造身份。

## 9. 测试计划

| 组 | 覆盖 |
| --- | --- |
| 纯函数 | 同输入同输出、门槛、去重、skip 原因、修订触发条件 |
| 持久化 | create/revise、lineage 精确 revision、evidence 跨 belief 去重、receipt |
| 写入口 | `test/stance-guard.ts` 10 断言 |
| 触发 | remember/revise/review/forget 后各重算一次、失败只 warn |
| 回归 | 全量 2710 基线不下降 |
