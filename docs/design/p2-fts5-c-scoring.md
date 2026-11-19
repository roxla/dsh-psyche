# P2-FTS5 · C 阶段：评分规范冻结稿

> 版本：v1.1（2026-11-06）
> 状态：**排序管线冻结；证据加成默认关闭（D 前不启用）；BM25 列权重与长度副作用已明确；参数待 D 校准**。
> 上游：`docs/design/p2-fts5-a2b-freeze.md`（A2+B v1.1）、`docs/audit/p2-fts5-baseline.md`（A 审计）。
> 不变量：不新增 Migration；好感度 / Contact Affect / Global Mood 不参与评分；状态先过滤再排序；时间不做主衰减。
> v1.1 变更来源：m09046 审查（BM25 IDF 下限 1e-6、raw_text 长度归一化、候选上限位置）。

---

## 0. 冻结摘要

| 编号 | 规则 | 状态 |
|---|---|---|
| S1 | 候选来自 FTS `bigram_text` 匹配，**结构化过滤之后**再取 `limit × 4`（上限 80） | 冻结（v1.1 修正顺序） |
| S2 | 过滤顺序：状态 → kind → subject → 去重 | 冻结 |
| S3 | 文本分数用 `-bm25(fts_index, 0.0, 0.0, 1.0, 0.0)` 转正 | 冻结（v1.1 加列权重） |
| S4 | **证据加成默认 0**；D 阶段分别评测「无加成/有加成」，证明不破坏文本优先后再启用 | v1.1 修正 |
| S5 | 时间只做同分 tiebreak，不做衰减 | 冻结 |
| S6 | 稳定排序：`finalScore DESC, updated_at DESC, artifact_id ASC` | 冻结 |
| S7 | `challenged` 可返回，但必须带争议标记；`superseded`/`retracted` 不返回 | 冻结 |
| S8 | BM25 列权重显式写死，禁止默认全列 | 冻结（v1.1） |
| S9 | `raw_text` 仍参与文档长度归一化，是已知限制，不通过改 Schema 解决 | 冻结（v1.1） |

---

## 1. 排序管线（v1.1：过滤放进 SQL，候选上限只数有效候选）

```
① FTS5 MATCH（bigram_text 列，phrase/and 由 buildFtsQuery 决定）
        ↓
② JOIN 当前 head（artifact_revisions.max(revision)）
        ↓
③ 过滤 state ∈ {active, challenged}
        ↓
④ 过滤 kind / subject
        ↓
⑤ 按 BM25 排序
        ↓
⑥ LIMIT limit × 4（上限 80）——只有有效候选占名额
        ↓
⑦ 应用层算最终分（textScore + evidenceBoost，默认 boost=0）
        ↓
⑧ 稳定排序并截断到 limit
```

### 1.1 为什么候选上限必须放在过滤之后

`retracted` 的 head 仍留在 FTS 索引里（A2 的决定：查询侧过滤，不删索引行）。如果先取 80 条再过滤，高相关度的 `retracted`/`superseded` 行会先占满名额，被过滤后有效记忆进不来——上限控制的是「原始命中」，不是「有效候选」。

如果某次实现无法把全部过滤放进 SQL（例如 subject 过滤要解析 JSON），必须补一个「分页补充候选」的机制：当前页过滤后不足 `limit` 时继续取下一页，直到凑够或耗尽；不能只取一页就返回空。

### 1.2 为什么时间只做 tiebreak

「旧但重要」的记忆不能因为时间沉底。旧结论是否还算数，由 `state` 回答，不由时间回答。时间只在两条分数完全相同时决定先后。

---

## 2. 打分公式

### 2.1 文本分（v1.1：显式列权重）

SQLite FTS5 的 `bm25()` 返回的是**负数**，数值越小（越负）匹配越好。因此取负转正，并显式指定列权重：

```sql
SELECT ref_id, raw_text,
       -bm25(fts_index, 0.0, 0.0, 1.0, 0.0) AS text_score
  FROM fts_index
 WHERE fts_index.bigram_text MATCH ?;
```

四个权重依次对应 `kind / ref_id / bigram_text / raw_text` → `0 / 0 / 1 / 0`。

- **为什么要显式写**：查询虽然只 `MATCH bigram_text`，但 BM25 的列权重默认是每列 1.0；显式把其他列权重设 0，能明确「词频贡献只来自 bigram_text」。
- **已知限制**：FTS5 用 `xColumnSize(pFts, -1)` / `xColumnTotalSize(pFts, -1)` 取**全行** token 数做文档长度归一化，所以 `raw_text`（原文）的 token 数仍会影响长度分母。权重 0 不能排除这个影响。这是 A2 冻结「不改 Schema」带来的已知副作用，接受它，不通过改表解决。
- **实测依据**（`docs/audit/p2-fts5-b-probe.md`）：同一查询词下，短文本 `-bm25(f,0,0,1,0)=3.3560`，加 50 段无关英文的长文本只有 `0.1959`——约 **1/17**。这不是理论风险。
- **应对**：D 阶段必须增加「长短文本」与「中英文混合」的对照样本（T-C-9），量化排序偏差；若偏差明显，再讨论是否在 C 侧做分数补偿（而不是改表）。

`textScore = -bm25(...)` 是正数，越大越好；与「`finalScore DESC`」的约定一致。

**禁止**直接把 `bm25()` 当正分用（会变成越差越靠前）。若将来换别的 ranker，必须同样确认方向后再接入。

### 2.2 证据加成（v1.1：默认关闭）

```ts
// v1.1 默认：EVIDENCE_BOOST_COEF = 0（D 阶段之前不启用）
const evidenceBoost = EVIDENCE_BOOST_COEF * Math.log(1 + independentEvidenceCount)
```

**为什么默认 0**：SQLite FTS5 的 BM25 用查询词 IDF 计算相关性，且把非正 IDF 下限设为 **1e-6**。实测（`docs/audit/p2-fts5-b-probe.md`）：50 条文档都含的常见词，`-bm25(f,0,0,1,0)` 只有约 **1.28e-6**；而 `0.05·ln(1+1)=0.034657`、`0.05·ln(1+2)=0.054931`——**一条证据加成 ≈ 常见词文本分的 27000 倍**。系数「看起来小」不等于量纲安全，必须在 D 阶段测过 BM25 分布后才能定。

- 用 `independent_evidence_count`（独立来源数），不用 `basis_count`（被提次数）。
- D 阶段分别评测「无加成（coef=0）」与「有加成」的 Recall/MRR/Stale；
- 只有证明加**不破坏「文本相关性优先」**（T-C-2 用显著更相关的文本对照）才允许启用；
- 启用后系数在 0.02 / 0.05 / 0.1 中选使指标不降的最大值；不保留「开一半」「只在某类查询开」。

### 2.3 最终分数

```ts
const finalScore = textScore + evidenceBoost; // v1.1：evidenceBoost 默认为 0
```

在 D 阶段启用加成前，排序实际等价于「纯文本相关性」；这样基线（当前 FTS 为空，接近 0）与后续调参可以分开观察，不会把「加成带了点效果」误当成「检索质量提升」。

排序：

```sql
ORDER BY final_score DESC, updated_at DESC, artifact_id ASC
```

---

## 3. 过滤规则

| 规则 | 说明 |
|---|---|
| 状态 | 只保留 `active`、`challenged`；`superseded`、`retracted` 不进入默认召回 |
| head | 只查 `artifact_revisions` 里 `revision = max(revision)` 的那一行（与 S1 一致） |
| kind | 有 `kind` 参数时过滤 |
| subject | 有 `subject` 参数时按 `subject_refs` JSON 数组元素匹配。**v1.1 注意**：现有 `instr` 方式会因字符串包含产生误匹配（`user` 命中 `superuser`、`u1` 命中 `u10`），必须用「JSON 数组元素精确比较」或加边界再过滤；测试见 T-C-10 |
| 去重 | 同一 `artifact_id` 只保留一条（S1 下天然一行，防御性保留） |
| 争议标记 | `challenged` 结果必须带 `state: 'challenged'`，并在返回体里标记 `disputed: true`；Composer 注入时必须加限定语 |

---

## 4. 与单字回退的关系

- FTS 命中为空且查询是**单个汉字** → 走受限 LIKE（A2 冻结的 4.5 节）。
- LIKE 回退的结果同样经过第 3 节的过滤与第 2 节的排序；证据加成按 v1.1 默认 0，时间仍只 tiebreak。
- 单字查询不得因为「FTS 没命中」而无限扩大范围。

---

## 5. 测试（C 冻结时必须新增）

| 编号 | 用例 | 断言 |
|---|---|---|
| T-C-1 | bm25 方向 | 更匹配的文本 `textScore` 更大；不会颠倒 |
| T-C-2 | 证据加成 | 文本明显更相关的短证据条目仍排在前面（加成不压文本） |
| T-C-3 | 同分 tiebreak | 分数相同按 `updated_at DESC`，再按 `artifact_id ASC`，顺序稳定 |
| T-C-4 | 状态过滤 | `superseded`/`retracted` 不出现；`challenged` 出现且带 `disputed: true` |
| T-C-5 | 候选不足 | 过滤后不足 `limit` 时不报错、返回实际条数 |
| T-C-6 | 好感/心情隔离 | 修改好感、Contact Affect、Global Mood 不改变召回顺序 |
| T-C-7 | 单字回退 | 单字 LIKE 结果同样按 C 的排序规则输出 |
| T-C-8 | **BM25 列权重**（v1.1） | 只在 `raw_text` 出现的词不命中；列权重显式生效 |
| T-C-9 | **长度归一化偏差**（v1.1） | 同一查询下，长短文本、中英混合文本不出现明显倒挂；记录对照数据供 D 校准 |
| T-C-10 | **subject 包含误匹配**（v1.1） | 查 `user` 不命中 `superuser`；查 `u1` 不命中 `u10` |

---

## 6. 待 D 校准的参数

| 参数 | 当前值 | 校准方式 |
|---|---|---|
| 候选倍数 | 4 | 看 Recall@8 是否因候选不足掉；注意候选已在状态过滤之后 |
| 候选上限 | 80 | 看延迟与 Recall 的平衡；若过滤后仍不足，用分页补充而不是提高上限 |
| 证据加成系数 | **0（默认关闭）** | D 分别跑 0 / 0.02 / 0.05 / 0.1，取 Recall/MRR 不降的最大值 |
| 是否启用证据加成 | 关 | 必须证明「文本更相关者仍排前」才允许打开 |
| BM25 列权重 | `(0,0,1,0)` | 不校准；固定写死 |
| abstain 阈值 | 未定 | D 阶段用「无结果 / 低分 / 不可披露」三类样本定 |

---

## 7. 与 D 的接口

D 的评测集固定后，C 的参数只允许在「不降低基线指标」的范围内调整；每次调整必须记录：

1. 改了哪个参数；
2. 指标变化（Recall@8 / 单类 Recall / MRR / Stale Injection / Duplicate）；
3. 是否回退。

不允许为了单个用例好看而调参——评测集是固定的，调参记录要能复现。
