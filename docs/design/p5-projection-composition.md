# P5-0 投影组合与总预算契约

- 状态：P5-0 冻结稿（2026-11-14）
- 定位：Psyche 所有 Prompt 投影的唯一预算与排序协调器；不是新的事实源
- 关联：`p5-persona-runtime-contract.md`、`p5-growth-reflection-contract.md`、`p5-mood-behavior-contract.md`

## 1. 问题

Mood、Relationship、Persona、Growth 若各自声明预算，它们独立执行时无法保证合计上限；Context 追加顺序也不能保证谁的规则优先。必须有一个**单轮、单次、只读**的组合器。

## 2. 唯一协调器

`PsycheProjectionComposer`（概念名）：

- 每轮 `agent/pre-step` 读取一次快照；
- 统一读取 Persona / Memory 注入 / Growth / Mood / Relationship；
- 统一测量、裁剪、序列化；
- 向宿主 Context 提交最终字符串；
- 不写库、不产生候选、不改任何状态。

禁止：

- 各 Context 自行读取配置并独立追加预算；
- 用多个 Context 的“各自上限”冒充总上限；
- 组合器写库或缓存跨轮结果。

## 3. 预算常量

以下为推荐默认值，全部可配置并版本化（`projection.policyVersion`）：

| 项 | 默认 | 说明 |
|---|---|---|
| 总 token 预算 | 6,000 | Persona + Memory + Growth + Mood + Relationship |
| 总字符预算 | 8,000 | 与 token 双闸，先到者生效 |
| 单块字符上限 | 见各契约 | 记忆 Composer 现有 800 字 / 1,500 token 作为**内部**上限保留 |
| token 估算 | `estimateTokensV1` | 固定算法、版本化；所有块同一口径 |

`estimateTokensV1` 只用于预算，不参与事实判断；实现时必须可在测试中用固定样本复现。

## 4. 两层优先级

### 第一层：不可裁剪的必需约束

- 隐私 / Scope / Disclosure 纪律（现有 `PROMPT_SECTION` 中与安全相关的部分）；
- 完整 Persona 核心（`identity.md` 原文）。

两者都必须完整。若两者之和已超总预算：

- 保留隐私纪律；
- 人格块整块省略并告警（失败关闭，不截断）；
- 其余块全部省略；
- 不通过删除隐私规则为人格腾预算。

### 第二层：可降级投影（按此顺序丢弃）

1. 先丢 Relationship 表达补充；
2. 再丢 Mood 行为/语气；
3. 再丢 Growth 已确认变化；
4. 最后才压缩 Memory（仍受其内部 800 字 / 1,500 token 限制）。

即保留优先级：Memory > Growth > Mood > Relationship。

## 5. 组合算法

1. 读取所有块的候选文本与长度；
2. 校验必需层是否完整可容纳；不可容纳则按 §4 处理；
3. 按保留优先级累加，超出总预算时从最低优先级开始丢弃整块（不切半块）；
4. 记录 `dropped`、`reason`、`usedTokens`、`usedChars`；
5. 按固定顺序序列化：Persona → Memory 纪律 → Growth → Mood → Relationship；
6. 提交给宿主。

序列化顺序不代表指令优先级；优先级由各契约的规则与宿主安全层决定。

## 6. 观测与告警

每次组合产生一条只读记录（内存/日志，不写 Schema）：

- `policyVersion`、`usedTokens/usedChars`、各块是否保留、丢弃原因；
- 人格哈希与是否成功注入；
- 总预算超限、必需层冲突必须 `warn`；
- 不记录任何块正文。

## 7. 验收

- 总用量从不超过预算（随机/边界样本）；
- 丢弃顺序严格为 Relationship → Mood → Growth → Memory；
- 人格超限时整块省略、隐私纪律仍在；
- 记忆内部上限仍生效；
- 同一轮只组合一次，不随重试/刷新累积；
- 卸载重载后无重复注册、无缓存人格；
- 关闭任一模块只影响该块。

## 8. 待拍板

- 总 token/字符预算最终值；
- `estimateTokensV1` 的算法与误差边界；
- 必需隐私纪律的具体文本边界（由现有 `PROMPT_SECTION` 固定）。
