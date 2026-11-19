# P2-FTS5 D 阶段：160 条评测集结构（v1.2 冻结）

> 日期：2026-11-06
> 状态：**D3 已完成并冻结（v1.2，2026-11-06）**。这份文档定义「评测集长什么样、怎么标注、怎么判分」；160 条样本与 960 篇语料在 `docs/eval/fts5/`，哈希见 `SHA256SUMS`。
> 上游：`docs/design/p2-fts5-a2b-freeze.md`（v1.4）、`docs/design/p2-fts5-c-scoring.md`（v1.1）、`docs/audit/p2-fts5-d-smoke.md`
> 依据：m09314 审查（8 类 × 20、相关性分级、交叉标签） + m09366 审查（披露与相关性分离、head/revision 表达、基线变量隔离、expectedMode、D8 文档清理） + m09391 审查（类 8 拆 10+10、D3.1/D3.2 职责分离）。

## 1. 为什么要两套东西

D smoke 只有 18 条文档、20 条查询，`Recall@8 = 1.0` 只能证明流程正确，不能推断真实规模下的检索质量。完整集必须拆成两个独立文件：

- **查询集**（`queries.jsonl`）：160 条固定查询 + 人工标注；
- **文档语料**（`corpus.jsonl`）：每条查询对应的正确文档、相关文档、顺带提及的干扰文档、无关文档、失效状态文档、不可披露文档。

**不允许**「只有一批正确文档 + 大量空结果当负样本」——那测不出 BM25 的长度偏差，也测不出状态过滤与披露过滤。

## 2. 相关性与可披露性是两个独立维度

这是评测集最重要的规则。一条记忆可以**语义高度相关**，同时**不允许返回**。

| 场景 | 相关性标注 | 是否允许返回 |
|---|---|---|
| 可披露的专题记忆 | 3 | 是 |
| 可披露的实质相关 | 2 | 是 |
| 可披露的顺带提及 | 1 | 是（NDCG 增益低） |
| 不可披露的相关记忆（`restricted` / `secret`） | 3 | **否** |
| 不存在的记忆 | 无相关文档 | 否 |

因此：

- **Recall@8 的分母只算「符合当前披露权限（`public`）且 `grade >= 2`」的文档**；`restricted` / `secret` 的相关记忆**不算漏召回**，只算披露泄漏（如果它出现在结果里）。
- **`no-memory` 样本不允许人为制造正确文档**：`judgments` 必须为空，只能有 `hardNegatives`。
- **Abstention Accuracy 覆盖两类**：`no-memory`（本来就没有）与 `not-disclosable`（有但无权看）。
- **安全指标拆成两项**：
  - `Candidate Disclosure Leakage`：受限内容是否越过检索层过滤（top8 出现 `restricted` / `secret`）；
  - `Injection Disclosure Leakage`：受限内容是否真正进入 Composer 注入上下文。
  - 两项都必须为 0；后者需要注入层观测，不能只跑 FTS SQL。

## 3. 八类 × 20 条

| # | 类别 | 数量 | 主要验证 |
|---|---|---|---|
| 1 | 精确关键词 | 20 | 精确词命中、连续 bigram |
| 2 | 自然语言与同义表达 | 20 | 换一种说法还能否找到 |
| 3 | 中英文混合与标识符 | 20 | 中英组合、日期、BV 号、自定义 ID |
| 4 | 短词与单字 | 20 | 单字 LIKE、短词 FTS、特殊字符 |
| 5 | 专题讨论与顺带提及 | 20 | 真正相关的排在偶然提及之前 |
| 6 | 观点修订与失效状态 | 20 | 当前 head、历史版本、superseded、retracted |
| 7 | 争议与披露状态 | 20 | challenged 标记、争议限定语、披露限制 |
| 8 | 无结果与不可披露 | 20（10 + 10） | 不存在的记忆（`no-memory`）与仅存在受限记忆（`not-disclosable`）两类各自 abstain |

类别是主要评测维度，但不是唯一维度。下面这些作为独立标签，允许与类别交叉：

| 标签 | 取值 | 用途 |
|---|---|---|
| `lang` | `zh` / `en` / `mixed` | 检查某一语言是否系统性退化 |
| `length` | `short` / `medium` / `long` | 检查 BM25 长度偏差 |
| `state` | `active` / `challenged` / `superseded` / `retracted` / `forgotten` | 检查状态过滤与争议标记 |
| `disclosure` | `public` / `restricted` / `secret` | 检查不可披露是否正确 abstain |
| `entity` | `person` / `topic` / `time` | 检查按 subject 的召回 |
| `difficulty` | `easy` / `medium` / `hard` | 便于分层看指标，不参与门槛 |

## 4. 相关性分级（四档）

| 等级 | 含义 | 例子（查询「周五晚上」） |
|---|---|---|
| 3 | 直接回答查询，专题高度相关 | 「用户喜欢在周五晚上打游戏」 |
| 2 | 内容相关，有实质信息 | 「周五晚上通常是用户的休息时间」 |
| 1 | 仅顺带提及关键词 | 「上周五晚上下了雨」 |
| 0 | 不相关或错误内容 | 「用户喜欢早起」 |

`grade >= 2` 且 `disclosure = public` 才算 Recall 命中；`grade = 1` 是 hard negative，参与 NDCG 增益但不算命中；`grade >= 2` 但 `disclosure != public` 只用于披露泄漏判定。

## 5. 单条查询与文档的结构

```jsonc
// queries.jsonl
{
  "id": "Q001",
  "category": "exact",              // 1–8 类
  "query": "周五晚上",
  "lang": "zh",
  "length": "short",
  "difficulty": "easy",
  "expectedMode": "phrase",         // 严格断言 analyzeFtsQuery 的模式选择
  "modeHint": "phrase",             // 可选：仅用于看类型分布，不参与判分
  "expectAbstain": false,
  "abstainReason": null,            // "no-memory" | "not-disclosable" | null
  "judgments": [
    { "docId": "doc_001", "grade": 3 },
    { "docId": "doc_007", "grade": 2 }
  ],
  "hardNegatives": ["doc_004", "doc_012"],
  "tags": ["short-query", "time"]
}
```

```jsonc
// corpus.jsonl
{
  "id": "doc_001",
  "artifactId": "art_001",          // 同一 Artifact 的多个 revision 共享
  "revision": 2,
  "isHead": true,                   // 每条 Artifact 恰好一个 true
  "indexEligible": true,            // 旧 revision 必须 false（S1：只索引 head）
  "kind": "fact",
  "state": "active",
  "disclosure": "public",
  "lang": "zh",
  "length": "short",
  "text": "用户喜欢在周五晚上打游戏"
}
```

历史版本示例：

```jsonc
{
  "id": "doc_001_r1",
  "artifactId": "art_001",
  "revision": 1,
  "isHead": false,
  "indexEligible": false,
  "kind": "fact",
  "state": "superseded",
  "disclosure": "public",
  "lang": "zh",
  "length": "short",
  "text": "用户以前喜欢在周六晚上打游戏"
}
```

约束：

- **D3.1 只冻结查询意图与检索模式**：查询阶段的 `queries.jsonl` 不写 `docId` / `judgments` / `hardNegatives` / `grade`（语料还没造，写出来就是虚构引用）；只写 `id / category / query / expectedMode / abstain / intent / targetMemory / hardNegativeDirection / tags`。D3.2 造完语料、分配 `docId` 后再补 `judgments`、`hardNegatives`、`grade`。
- **D3.1 → D3.2 字段映射**：`abstain: null` → `expectAbstain: false, abstainReason: null`；`abstain: "no-memory"` → `expectAbstain: true, abstainReason: "no-memory"`；`abstain: "not-disclosable"` → `expectAbstain: true, abstainReason: "not-disclosable"`。最终评测集**不保留 `abstain`**，并补 `lang / length / difficulty`，避免评测脚本同时兼容两套字段。
- `expectedMode` 取值只有三个：`phrase`（无空白单片段）、`and`（有空白多片段）、`like`（单字，不走 FTS，走受限 LIKE）。
- `judgments` 只放 `grade > 0` 的文档；`grade = 1` 的也要标出来（NDCG 需要）。
- `hardNegatives` 必须与查询共享关键词或主题，不能是随机无关文档；D3.1 阶段只写 `hardNegativeDirection`（设计方向，如「同含 FTS5 但讲别的项目」）。
- 每条查询至少 1 条 `grade >= 2` 的公开文档；类 8 除外（应 abstain）。
- 类 6 / 7 的样本必须显式带 `state` / `disclosure` 标签。

查询阶段示例（D3.1）：

```jsonc
{
  "id": "Q001",
  "category": "exact",
  "query": "FTS5",
  "expectedMode": "phrase",
  "abstain": null,
  "intent": "查项目里关于 FTS5 检索的决策",
  "targetMemory": "记过「FTS5 用 bigram、只索引当前 head」",
  "hardNegativeDirection": "同样含 FTS5 但讲的是另一个项目或通用介绍",
  "tags": ["tech"]
}
```

## 6. 状态语义必须按代码，不虚构

写入时 `KIND_STATES` 会校验 kind 与 state 的组合（`packages/core/src/store.ts:113-120`）。造样本时必须遵守：

| kind | 允许的状态 |
|---|---|
| `fact` | `active` / `superseded` / `forgotten` |
| `belief` / `impression` / `stance` / `relationship` | `active` / `challenged` / `superseded` / `retracted` / `forgotten` |
| `procedure` | 按 `KIND_STATES` 实际定义（实现前核对） |

语义：

- **`superseded`**：`revise` 带 `supersedes` 时，旧 Artifact 置 `superseded`，新 id 指向旧的（`store.ts:2148-2225`）。
- **`retracted`**：非 fact 被 `rejected` 时（撤回，历史仍在）。
- **`forgotten`**：`fact` 被 `rejected` 或遗忘（不再当作事实）。**fact 没有 `retracted` 状态**，造数据时不能写。
- **`challenged`**：只用于非 fact（被质疑但未推翻）；`fact` 没有 `challenged`。
- **head 不按 state 过滤**：head 由 `max(revision)` 派生（`store.ts:1539`），challenged/superseded 的 head 仍可能是当前版本；检索侧再按 state 过滤。

## 7. 指标与门槛

| 指标 | 定义 | 门槛 |
|---|---|---|
| Recall@8 | 分母 = `disclosure = public` 且 `grade >= 2` 的文档；按查询平均 | **≥ 0.85** |
| 单类 Recall@8 | 同上，按八类分别算 | **≥ 0.70**（类 8 看 abstention，不适用） |
| MRR | 第一个 `public` 且 `grade >= 2` 的倒数排名 | **≥ 0.60** |
| NDCG@8 | `gain = 2^grade - 1`，`DCG = Σ gain / log2(rank+1)`；只对公开文档计入 | **≥ 0.70**（首版集校准后定） |
| Stale Injection Rate | 注入结果里含 superseded / retracted / forgotten / 非 head 的比例 | **= 0** |
| Duplicate | 同一 artifact 在 top8 出现两次 | **= 0** |
| Abstention Accuracy | `no-memory` 与 `not-disclosable` 两类分别统计 | **≥ 0.90**（两类各自） |
| Candidate Disclosure Leakage | top8 出现 `restricted` / `secret` 的比例 | **= 0** |
| Injection Disclosure Leakage | Composer 注入里出现受限内容的条数 | **= 0** |

NDCG 是核心新增指标：两套排序 Recall 都是 100% 时，它区分「专题讨论排第一」和「顺带提及排第一」。

## 8. 四组基线：变量必须隔离

| 组 | 检索与评分 | 同分排序 | 证据加成 |
|---|---|---|---|
| A | P1 当前 `instr` 召回（**仅 Artifact**） | 旧方案排序 | 不适用 |
| B | FTS5 + 纯 BM25 | 稳定 ID（`ref_id ASC`） | 0 |
| C | FTS5 + BM25 | 稳定 ID（`ref_id ASC`） | 开启（系数待 D5） |
| D | FTS5 + BM25 | `updated_at DESC` 同分排序 | 0 |

- **B vs D** 只差时间 tiebreak；**B vs C** 只差证据加成；**A vs B** 回答「FTS5 相比 LIKE 改善了什麼」。
- P1 的 `recall()` 还包含 Event 召回，而 FTS5 第一版不索引 Event：**主对照只限定 Artifact 检索，Event 召回作为单独报告**，避免数据范围不同导致误判。
- 四组跑同一份 queries + corpus，输出八项指标 + 按类/标签切片。

## 9. 语料造法（D3）

**D3.1 与 D3.2 的边界**：D3.1 只定查询——`docs/eval/fts5/queries.jsonl` 写 `id / category / query / expectedMode / abstain / intent / targetMemory / hardNegativeDirection / tags`，**不写** `docId / judgments / hardNegatives / grade`；校验器 `docs/eval/fts5/query-validation.mjs` 会拒绝提前伪造的文档引用。D3.2 造完语料、分配 `docId` 后，再回填 `judgments`、`hardNegatives`、`grade`，并补语料侧 `state / disclosure`。

1. **围绕查询造文档**：先定 160 条查询，再为每条造 4–8 条候选文档（约 640–1280 条，允许跨查询共享）。
2. **每条查询至少一条 hard negative**：共享关键词、`grade = 1`（顺带提及）或 `grade = 0`（同主题不同结论）。
3. **长度对照**：类 5 每条都要有「短文本专题」与「长文本顺带提及」各一条，用于 NDCG。
4. **head/revision**：类 6 每条至少一条 `isHead=false, indexEligible=false` 的旧 revision；`state` 遵守第 6 节。
5. **披露样本**：类 7 每条拆两条独立 Artifact（见 5.1）；类 8 的 `not-disclosable` 子类**仅含**受限文档，`no-memory` 子类**不得含任何相关文档（含受限）**——这两类不能混造。

### 5.1 类 7 必须两条独立 Artifact

公开策略与受限内容不能写进同一个 Artifact，否则披露等级无法隔离：

| 属性 | 公开策略文档 | 受限实际内容文档 |
|---|---|---|
| Artifact | 独立 Artifact | 独立 Artifact |
| kind | `stance` / `belief` 等允许 challenged 的类型 | 按内容选（可 `fact` / `belief`） |
| state | `challenged` | `active` |
| disclosure | `public` | `restricted` / `secret` |
| grade | 2 或 3 | 3 |
| 允许返回 | 是 | 否 |

两条限制：公开策略不能用 `kind=fact` + `state=challenged`（`KIND_STATES` 不允许）；受限文档必须 `indexEligible=true`、作为当前 head 进入 FTS 索引，再由检索侧披露过滤拦在 top8 之外——提前设 `indexEligible=false` 测到的只是索引准入，不是披露过滤。

公开策略必须包含查询的词项锚点（`and` 的每个片段、`phrase` 的连续 bigram），否则 D3.2 造出的公开文档根本匹配不到查询，会得到一个虚假的零泄漏结果。

### 5.2 评分标注关系

`judgments` 与 `hardNegatives` 不能互相遗漏：

| 文档类型 | grade | judgments | hardNegatives | Recall 分母 |
|---|---|---|---|---|
| 公开专题记忆 | 3 | 是 | 否 | 是 |
| 公开实质相关 | 2 | 是 | 否 | 是 |
| 公开顺带提及 | 1 | 是 | 是 | 否 |
| 公开无关干扰 | 0 | 否 | 是 | 否 |
| 受限相关记忆 | 3 | 是 | 否 | 否 |

`grade=1` 同时进 `judgments` 和 `hardNegatives`（参与 NDCG、不进 Recall 分母）；受限 `grade=3` 进相关性标注、不进公开内容的 Recall 分母。

### 5.3 执行顺序

1. 类 1–4：基础检索语料，每条至少目标文档 + hard negative；phrase 连续 bigram、and 每片段出现。
2. 类 5：专题 vs 顺带，每条同时有短专题文本与长顺带文本。
3. 类 6：旧新版本同 `artifactId`，旧版 `isHead=false / indexEligible=false / state=superseded`。
4. 类 7：每条独立创建公开 challenged 策略 + 受限实际内容两个 Artifact，保留可匹配词项。
5. 类 8：`no-memory` 无任何相关文档；`not-disclosable` 只有受限相关文档。
6. 跑 D3.3 校验并人工复核，最后冻结 SHA-256。

### 5.4 已完成产物（2026-11-06）

- 类 1–4：`queries-part1-4.jsonl`（80 条）、`corpus-part1-4.jsonl`（640 篇：每查询 8 篇，含专题 / 实质相关 / 顺带 / 主题干扰 / 词面干扰 / 受限 / 旧 revision / 废弃状态）。
- 类 5：`queries-part5.jsonl`（20 条）、`corpus-part5.jsonl`（80 篇：短专题 / 长顺带 / 主题干扰 / 词面干扰）。
- 类 6：`queries-part6.jsonl`（20 条）、`corpus-part6.jsonl`（80 篇：当前 head rev2 / 旧 revision rev1 / 失效状态 head / 相似主题干扰）；对齐报告 [p2-fts5-part6-align.md](../../audit/p2-fts5-part6-align.md)：**20/20 当前版本命中、旧 revision 进索引 0、失效状态文档 20 篇写入索引且进结果 0**——路径 A（head/revision 不写入）与路径 B（写入但被 state 过滤）分开验证。
- 类 7：`queries-part7.jsonl`（20 条）、`corpus-part7.jsonl`（80 篇：公开 challenged 策略 / 受限实际内容 / 公开顺带 / 公开主题干扰）；对齐报告 [p2-fts5-part7-align.md](../../audit/p2-fts5-part7-align.md)：**公开策略命中 20/20（排第一 17/20）、受限进索引 20/20、受限在诊断副本中可 MATCH 20/20、正式 top8 拦截 20/20**；Injection Disclosure Leakage 未验证（Composer 注入层属 E 阶段）。
- 类 8：`queries-part8.jsonl`（20 条，10 no-memory + 10 not-disclosable）、`corpus-part8.jsonl`（80 篇：no-memory 全为公开 grade 0 干扰、不含相关文档；not-disclosable 每查询 1 篇受限 grade 3 + 3 篇公开 grade 0）；对齐报告 [p2-fts5-part8-align.md](../../audit/p2-fts5-part8-align.md)：**no-memory 10/10 judgments 为空、相关受限 0；not-disclosable 受限进索引 10/10、诊断 MATCH 10/10、正式拦截 10/10、公开 grade≥2 为 0；存在性诊断分类 20/20**（仅评测侧能力，运行时未实现，留 E 验证）。
- 对齐报告：[p2-fts5-part1-4-align.md](../../audit/p2-fts5-part1-4-align.md)（80/80 命中、0 过滤违规、专题排第一 58/80）、[p2-fts5-part5-align.md](../../audit/p2-fts5-part5-align.md)（20/20 命中、0 违规、专题排第一 20/20）。

对齐检查用与本节冻结规则一致的参考实现（`bigramText / analyzeFtsQuery / buildFtsQuery`），**不是生产代码**——E 阶段实现后必须回归。检查中发现一条分词陷阱：**中英文混合必须按原文顺序交织输出 token**；若先扫完所有中文再扫英文，「临时 profile」的 `临时` / `profile` 不再相邻，phrase 会漏。这条要写进 E 的实现约束。

**类 5 长度观察**：长顺带（grade 1）都进了 top8，但没有一条排到短专题前面（20/20 专题第一），说明当前语料长度下 BM25 长度归一化没有反超；完整集仍要 NDCG 与长短对照复核。
6. **不复用 D smoke 的 18 条文档**：smoke 是流程验证，完整集要独立。
7. **数据校验器（D3.3）**：检查条数、类别分布、ID 引用、`grade` 合法性、hard negative 存在、每条 Artifact 恰好一个 head、`indexEligible` 与 `isHead` 一致、`fact` 不出现 `retracted`/`challenged`。
8. **人工复核（D3.4）**：优先复核同义查询、专题/顺带、观点修订、不可披露。
9. **冻结（D3.5）**：生成文件 SHA-256、版本号与摘要；此后改样本必须记录原因，不能悄悄改答案。

## 10. 验收与不变量

- 160 条全部有 `judgments` 或显式 `expectAbstain`；无空标注。
- 每条查询有且仅有一个 `expectedMode`；`modeHint` 可选。
- 评测脚本可重复：固定语料 + 固定查询 + 固定排序（tiebreak 明确，不依赖随机）。
- 任何指标不达标时，先看单类切片，再看 hard negative 分布，最后才调参；**不允许用调参把门槛压过去**。
- 安全指标（Stale / Duplicate / Candidate Disclosure / Injection Disclosure）不参与「调参改善」，必须始终为 0。
- **D8 已关闭**（2026-11-06 源码审计：`store.ts:1698-1722` 失败记账在 catch 分支另开事务、原业务事务已回滚、记账失败只 warn）；E 阶段保持此结构，T-A2-8 回归。
- 只有 D 完整集通过，才允许进入 E 实现。

## 11. 待办

- [x] D2 结构冻结（v1.0）
- [x] D2.1 披露/相关性分离、head/revision、基线隔离、expectedMode、D8 清理（v1.1）
- [x] D3.1 查询集 160 条 + 校验器（2026-11-06，`docs/eval/fts5/queries.jsonl`）
- [x] D3.2 类 1–5 语料（80 + 20 条查询 / 640 + 80 篇文档，真实 FTS5 对齐检查通过）
- [x] D3.2 类 6 语料（20 条 / 80 篇，head 过滤与 state 过滤分开验证通过）
- [x] D3.2 类 7 语料（20 条 / 80 篇，披露过滤三层验证通过；注入层留 E 阶段）
- [x] D3.2 类 8 语料（20 条 / 80 篇，两类 abstain 分开验证通过）
- [x] D3.3 全量校验（2026-11-06：`merge-d3.mjs` 合并 160 条 / 960 篇，`validate-d3.mjs` 六组 40 项检查全过；报告 `docs/eval/fts5/validation-report.md`）
- [x] D3.4 人工复核（每类 2 条抽样，通过；四类已知限制见 `docs/eval/fts5/manual-review-report.md`）
- [x] D3.5 SHA-256 冻结（2026-11-06：版本 1.0.0，`docs/eval/fts5/SHA256SUMS`）
- [ ] D4 跑四组基线并写报告（含 Injection 观测层）
- [ ] D5 校准评分参数（证据加成保持 0，除非 D4 证明有改善）
