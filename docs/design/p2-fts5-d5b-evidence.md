# P2-FTS5 · D5-B 证据加成（Independent Evidence Unit）设计冻结

- 状态：D5-B.0 定义冻结（2026-11-06）
- 输入：D3.5 冻结评测集（`queries.jsonl` 160 / `corpus.jsonl` 960）
- 基线：D4-B 原生 FTS5 BM25，不覆盖原始结果
- 实现：实验脚本，不写进生产 FTS5、不改 schema、不改 D3.5

## 1. 问题

词面相关性相近时，一条被多个**真正独立**的经历支持的结论，是否应获得更高的召回优先级？

不是「被记录次数最多的记忆加分」——那会奖励重复采集与桥接去重失败。

## 2. Independent Evidence Unit（独立证据单元）

一条证据只有同时满足以下条件，才计入独立证据数量：

1. **支持**当前 Artifact 的结论（`relation = 'supports'`）；
2. 绑定在**当前 revision** 上（`artifact_evidence` 的复合主键含 `revision`）；
3. 对应一个独立观察/独立来源（由写侧推导的 `independence_key` 标识）；
4. 不是已有证据的重复采集、转述、切块或副本（同一 `independence_key` 出现多次只算一个单元）；
5. 已经被规则验证（fixture 中用 `validated: true` 表达）。

计数：

```
n_d = COUNT(DISTINCT independence_key)
      WHERE artifact_id = d AND revision = d.head_revision
        AND relation = 'supports' AND validated = 1
```

明确不计入：

- `contradicts`：矛盾证据进入冲突与修订机制，不增加支持强度；
- `qualifies` / `contextualizes`：限定与背景不是独立支持；
- 同一 Source 被多个 Event 引用、同一消息被 Desktop/QQ 双通道采集、同一 Event 被切成多个文本块——都共用一个独立单元。

## 3. 数量归一化

```
E(d) = ln(1 + min(n_d, C)) / ln(1 + C)
```

- `C = 5`（第一轮实验候选值，不是生产参数）
- `E ∈ [0, 1]`；n=1 → 0.387、n=2 → 0.613、n=3 → 0.774、n=4 → 0.898、n≥5 → 1.000

对数曲线让前几份独立证据贡献明显、之后饱和，避免重复记录无限加分。

## 4. 与 BM25 的组合

FTS5 的 `bm25()` 返回负数（越小越相关）；实验脚本统一取 `x(d) = -bm25(...)`（越大越相关）。先把同一查询的完整 MATCH 候选集映射到 [0,1]：

```
B(d) = (x(d) - xMin) / (xMax - xMin)
```

- `x(d)`：该候选的 `-bm25(fts_index, 0.0, 0.0, 1.0, 0.0)`；
- `xMin` / `xMax` 来自**同一查询的完整 MATCH 候选集**，不是 top8；
- 若 `xMax == xMin`（全部同分），令 `B(d) = 0`，交给证据分数与稳定 ID 排序。

最终分数越大越优：

```
Score(d) = B(d) + λ · E(d)
```

λ 扫描（固定 C=5）：**0 / 0.02 / 0.05 / 0.10 / 0.20 / 0.40**。这些是实验取值，不是推荐参数。

## 5. 管线（顺序不可交换）

```
FTS5 MATCH（完整候选，不截断）
  → JOIN head / state / disclosure / indexEligible 硬过滤
  → 计算 B(d)（在过滤后的完整候选集上取 m_min/m_max）
  → 加 λ·E(d)
  → Score DESC, docId ASC
  → top8
```

安全过滤永远在评分之前，评分参数不得改变过滤结果。

## 6. Evidence Fixture 场景（F1–F10）

| 场景 | 基础 BM25 | 独立证据 | 预期 |
| --- | --- | --- | --- |
| F1 | 同分 | 0 vs 1 | 1 份证据优先 |
| F2 | 同分 | 1 vs 3 | 3 份优先 |
| F3 | 同分 | 3 vs 5 | 5 份优先 |
| F4 | 同分 | 5 vs 10 | 饱和，E 均为 1，按 docId 稳定排序 |
| F5 | 同分 | 1 vs 1（重复采集） | 排序不变 |
| F6a | 不同分 | 0 vs 5（分差大） | λ=0.40 仍不改原始相关性 |
| F6b | 不同分 | 0 vs 5（分差小） | λ=0.40 时证据反超 |
| F7 | 同分 | 同一 Source 的两个 Event vs 两个独立 Source | 前者算 1，后者算 2 |
| F8 | 任意 | 旧 revision 证据 10 | 不进 top8（head 硬过滤） |
| F9 | 任意 | challenged 证据 10 | 不因证据加成绕过状态过滤规则 |
| F10 | 任意 | restricted 证据 10 | 不进 public top8（披露硬过滤） |

强制断言：

- `λ=0` 的排序与「无证据加成」逐条一致；
- 同一 `independenceGroupId` 重复出现不增加 n_d；
- n_d > C 时 E 不再增加（F4）。

## 7. 报告口径

- 机制验证（fixture）：数量去重、归一化、λ 边界、安全不变量——**可以**下结论；
- 真实记忆检索质量收益：D3.5 没有可信的独立证据标注，**不能**由 fixture 推断；
- 后续需要「有来源链的人工标注数据」才能评估真实收益。

## 8. 不做什么

- 不改 `artifact_evidence` 表结构（`independence_key` 已存在且 NOT NULL）；
- 不把合成语料的重复内容伪造成独立证据；
- 不因为证据多就放宽 head/state/disclosure 过滤；
- 不把 λ 写进生产配置；
- 不在 D5-B 阶段引入时间权重或 head 权重。
