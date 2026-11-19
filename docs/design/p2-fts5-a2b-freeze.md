# P2-FTS5 · A2 + B 设计冻结稿

> 版本：v1.5（2026-11-06，E3 生产查询扩展：单字片段保留为 LIKE 条件、超长查询报错；多片段规则仍按 v1.4）
> 状态：**A2 索引范围与事务双写冻结；B 主体规则冻结；日期/ID、查询模式、失败记账均已闭合，D3 造样本中**。
> 依据：`docs/audit/p2-fts5-baseline.md`（A 阶段审计，已关闭）+ 2026-11-06 的六条决策 + v1.1 审查意见（m09046）+ D smoke 报告（`docs/audit/p2-fts5-d-smoke.md`）+ v1.3 审查意见（m09314）+ v1.4 审查意见（m09366）。
> 不变量：不新增 Migration、不改 `fts_index` DDL、不引向量库、不动 Source/Event/Artifact 的事实关系、不回退 Capture/Recovery Scanner/Cursor。

---

## 0. 决策摘要（D1–D6）

| 编号 | 决策 | 说明 |
|---|---|---|
| D1 | **S1 索引范围** | 每个 Artifact 只索引当前 head Revision；历史 Revision 不索引；Event 第一版不索引 |
| D2 | **`raw_text` 保留原 Schema** | 不改成 UNINDEXED、不重建虚拟表；保留原文回显；查询必须限定 `bigram_text` 列 |
| D3 | **`#insertRevision` 同事务双写** | FTS 写入与事实写入同一 SQLite 连接、同一事务；失败整笔回滚 |
| D4 | **重建从事实表生成，校验比对内容** | `rebuildFtsIndex()` 原子重建；`verifyFtsIndex()` 报告 Missing/Orphan/Duplicate/Content Mismatch 四类差异，只报告不自动修 |
| D5 | **分词与查询共用 `bigramText()`** | 中文 2 字滑窗、英文整词小写、数字/日期/标识符按规范处理；单字查询走受限 LIKE |
| D6 | **challenged 可召回但带争议标记** | 状态先过滤再排序；`superseded`/`retracted`/非 head 不得作为当前事实注入 |

**v1.1 补充冻结**（来源：m09046 审查）：

| 编号 | 决策 | 说明 |
|---|---|---|
| D7 | **查询表达式必须经独立构造层** | `buildFtsQuery(tokens, mode)` 负责 FTS5 语法转义与 AND/phrase 选择；`bigramText()` 只产 token，不拼查询 |
| D8 | **失败记账不得随业务事务回滚消失** | `operations.failed` 的写入位置需确认在业务事务之外；测试必须能抓「回滚把 failed 行也删了」这种缺陷 |
| D9 | **2000 / 200 字符限制作用于规范化前的输入文本** | 不是截断 bigram 输出串；索引侧 2000、查询侧 200，调用方不得各自截断 |

---

## 1. 索引范围（A2）

### 1.1 S1 精确定义

> `fts_index` 保存每个 Artifact 当前 head Revision 的文本投影，每个 Artifact 最多一行。索引仅负责候选检索，不负责判断记忆是否有效。

补充事实（与代码一致）：**head 由 `max(revision)` 派生，没有独立的 head 指针行**。所谓「更新当前 head」在实现里是「插入更高 revision + 更新 `artifacts.updated_at`」（`packages/core/src/store.ts:1462`），不是 UPDATE 旧 revision。

### 1.2 对象范围表

| 对象 | 第一版是否索引 | 处理方式 |
|---|---|---|
| 当前 Artifact head | 是 | 每个 Artifact 一条索引行 |
| 历史 Revision | 否 | 用 `fetch(id@N)` 访问 |
| Event 文本 | 否 | 保留现有独立召回逻辑（`recall()` 的事件栏） |
| superseded 旧版本 | 不单独索引 | 历史版本不参与默认召回 |
| retracted（head） | head 可留在索引中 | 查询阶段按状态排除 |
| challenged（head） | 可以索引 | 召回时携带争议标记，注入时不得用已确认口吻 |

### 1.3 边界语义

1. `superseded` 与 `retracted` 的排除发生在**查询侧的结构化过滤**，不是索引侧；索引里允许存在，防止「索引删了但状态回滚」导致不一致。
2. `challenged` 允许出现在候选里，但结果必须带 `state`，Composer 注入时必须加限定语（例如「这条目前还有争议」）。
3. `Stale Injection Rate = 0` 的检查范围包括：`superseded`、`retracted`、非当前 head 的文本——不只是 FTS 返回结果是否重复。

---

## 2. 写入路径（A2）

### 2.1 写入位置与顺序

唯一写入位置：`packages/core/src/store.ts` 的 `#insertRevision()`（`store.ts:1350`）。

```
创建新 Revision（insert artifact_revisions）
        ↓
更新 artifacts.updated_at（current head 派生自 max(revision)）
        ↓
写证据 / 触发事件 / 血统 / 关系
        ↓
生成规范化 bigram_text
        ↓
DELETE FROM fts_index WHERE kind = 'artifact' AND ref_id = ?
        ↓
INSERT INTO fts_index (kind, ref_id, bigram_text, raw_text) VALUES ('artifact', ?, ?, ?)
        ↓
调用方提交 SQLite 事务
```

SQL 冻结形式：

```sql
DELETE FROM fts_index
 WHERE kind = 'artifact' AND ref_id = ?;

INSERT INTO fts_index (kind, ref_id, bigram_text, raw_text)
VALUES ('artifact', ?, ?, ?);
```

### 2.2 事务约束（必须全部满足）

1. FTS 写入使用与事实写入**相同的 SQLite 连接**。
2. 不允许在独立事务中维护 FTS。
3. FTS 写入失败时，Revision 与 Artifact 的变更必须一起回滚。
4. 不允许外围插件直接写 `fts_index`。
5. 所有能改变当前 head 的路径（`remember` / `revise` / `review` / 任何内部调用 `#insertRevision` 的地方）都必须经过这一同步入口。

### 2.3 现有事务边界（证据）

| 路径 | 事务 |
|---|---|
| `#write()` | `store.ts:1653-1691`，`db.transaction(...)`，幂等 + 记账同事务 |
| `capture()` / `perceive()` | `store.ts:1806-1823`，`db.transaction(() => this.#insertSource(input))` |
| `remember()` / `revise()` / `review()` | 都走 `#write()` |
| `#insertRevision()` | 不开事务（`store.ts:1343` 注释），由调用方提供 |

结论：**不需要新增事务层**，把 FTS 双写放进 `#insertRevision` 即可。

### 2.4 故障注入测试（必须）

| 用例 | 期望 |
|---|---|
| 让 FTS INSERT 抛错 | 事实行（revision/证据/触发/关系）与 FTS 行都不存在；`operations` 记 failed |
| FTS DELETE 成功、INSERT 失败 | 旧索引行也被回滚（同一事务） |
| 同一 artifact 重复写同一 revision 内容 | 索引只有一行，不重复 |
| 并发两个写事务 | SQLite busy/重试语义不产生半行索引 |
| **失败记账不回滚**（D8） | 业务写失败后 `operations` 仍有 `failed` 行；若记账写在已回滚事务内，该行消失——测试必须能抓到 |

> **D8 实现事实（2026-11-06 已确认，读 `store.ts:1698-1722`）**：失败记账在 `#write` 的 catch 分支里，**另开 `this.db.transaction(...)`**——原业务事务已经整笔回滚，failed 行在外层事务提交，因此能持久化；记账再失败只 warn，不覆盖原业务错误。E 阶段实现 FTS 双写时必须保持这个结构：**不得把记账挪进业务事务**，也不得为此引入第二个连接。T-A2-8 负责回归「回滚把 failed 行也删了」这种缺陷。

---

## 3. 重建与校验（A2）

### 3.1 `rebuildFtsIndex()`

- 从 `artifacts` + `artifact_revisions` 读取每个 Artifact 的当前 head（`max(revision)`）。
- 重新生成 `bigramText(head.statement)`。
- 清空 `fts_index` 中 `kind='artifact'` 的行，再批量写入。
- **整个操作单事务**；失败回滚；不得修改事实表。
- 触发方式：显式维护操作（CLI/诊断接口），不自动跑。

### 3.2 `verifyFtsIndex()`

至少报告四类差异：

| 检查 | 判定 | 说明 |
|---|---|---|
| Missing | 有 head 事实，无 FTS 行 | 漏写/重建失败 |
| Orphan | FTS 有行，找不到对应 Artifact | 删除/改 id 残留 |
| Duplicate | 同一 Artifact 多行 | 双写未先删 |
| Content Mismatch | `bigram_text` 或 `raw_text` 与事实表 head 不一致 | **只比行数不够**——这正是本项存在的原因 |

- 只报告，不自动修复；修复由 `rebuildFtsIndex()` 显式触发。
- 校验返回结构化结果（计数 + 前 N 条差异 id），供诊断接口/测试断言。

### 3.3 FTS5 内部完整性检查（v1.1 新增，D4 补充）

四类差异检查的是「应用层内容是否一致」，不检查 FTS5 内部索引结构。必须再加一项：

```sql
INSERT INTO fts_index(fts_index) VALUES ('integrity-check');
```

- 正常返回无输出；损坏时报错。
- 与 §3.2 是**互补**关系，不是替代：integrity-check 管 FTS 内部 B-tree/段，四类差异管「和业务表对不对得上」。
- `verifyFtsIndex()` 应先跑 integrity-check，再做四类差异；integrity-check 失败时直接返回错误，不再做后续比对（避免在坏索引上得出误导结论）。

---

## 4. 分词规范（B）

### 4.1 核心函数

索引侧与查询侧共用同一个函数：

```ts
bigramText(text: string): string
```

输出为「空格分隔的 token 串」，供 `fts_index.bigram_text` 存储，或作为 `MATCH` 的查询串。

### 4.2 规则表（冻结）

| 内容 | 规则 |
|---|---|
| 连续中文 | 按相邻两个汉字滑窗生成 bigram，**token 之间用空格分隔** |
| 英文 | 小写化，连续字母作为完整词保留 |
| 数字 | 保留连续数字；日期按 4.3 单独处理 |
| 日期 | 索引侧与查询侧采用同一规范；分隔符处理见 4.3 |
| 常见标识符 | 保留字母数字主体；`-`、`_` 等分隔符按 4.3 处理 |
| 标点 | 统一视为分隔符（转空格） |
| 空白 | 连续空白折叠为一个空格；首尾裁剪 |
| 空结果 | 返回空串；调用方不得构造 `MATCH ''` 查询，直接按「无结果/abstain」处理 |
| 长度 | 索引侧 ≤**2000 字符（规范化前的原文）**；查询侧 ≤**200 字符/词（同样在规范化前截断）**，与 `recall` 的 `cleanText` 一致；不得截断 bigram 输出串 |

### 4.3 日期与标识符（**已按实测冻结，2026-11-06**）

> 依据：`docs/audit/p2-fts5-b-probe.md`。实测事实：`unicode61` 把 `2026-11-06` 切成 `2026` / `11` / `06` 三个 token；纯数字 `20261106` 是单个 token，两者不等价。

`unicode61` 会把标点当分隔符，所以 `2026-11-06` 不会天然是一个 token。冻结规则：

| 输入 | 冻结规则 |
|---|---|
| `2026-11-06` | 按标点切，产出 `2026 11 06`；**不整体保留** |
| `20261106` | 单个 token `20261106`；与带横线形式**不等价**（v1.3 明确：第一版不做日期互通） |
| `BV1ZfxS6KETF` | 小写整词 `bv1zfxS6KETF`；查询侧同样小写 |
| `abc-def-123` | 按标点切 `abc def 123`；不拼回整体 |
| `user_name_01` | 下划线也是分隔符 → `user name 01`（`fts5vocab` 只有 `user`/`name`/`01` 三个 term，已实测） |
| 原始形态 | 只保存在 `raw_text`，不参与匹配 |

**第一版等价性（v1.3 冻结，与 T19 一致）**：

| 索引内容 | 查询 | 预期 |
|---|---|---|
| `2026-11-06`（索引为 `2026 11 06`） | `2026-11-06` | 命中 |
| `20261106` | `20261106` | 命中 |
| `2026-11-06` | `20261106` | **不命中** |
| `20261106` | `2026-11-06` | **不命中** |

**为什么删除辅助 token**（v1.3 变更来源：m09314 审查）：v1.2 曾写「索引侧额外写 `20261106` 作为辅助 token」来实现日期互通，这与 T19「两种写法不等价」直接矛盾——一旦索引里出现 `20261106`，查询 `20261106` 就会命中带横线的日期记录。日期、数字编号、业务标识符可能碰撞，**不应隐式把不同原始格式归一成同一检索语义**。第一版保留非等价行为；将来确实需要日期互通时，在 Query Builder 里做**显式多分支查询**（`2026 11 06 OR 20261106` 这类受控分支），并用双向测试验证，不允许靠追加辅助 token 绕过查询语义。

**冻结判据**：同一字符串在索引侧与查询侧必须产生完全相同的 token 序列；决定后不允许实现侧各写一套。

### 4.4 单字与短词

| 查询类型 | 检索方式 |
|---|---|
| 一个汉字 | 回退受限 LIKE（见 4.5） |
| 两个汉字 | 一个 bigram |
| 三个及以上汉字 | 连续 bigram |
| 英文单词 | 完整词检索 |
| 中英文混合 | 共用规范化管线 |

### 4.5 单字 LIKE 的范围限制（必须全部满足）

1. 仅用于「单个汉字」查询。
2. 只搜当前 head 的文本（`artifacts` + 最新 revision）。
3. 仍执行状态与结构化过滤（kind / subject）。
4. 对 `%`、`_`、`\` 等 LIKE 特殊字符转义。
5. 限制返回数量（复用 `clampLimit`），不得成为一般查询未命中后的无限制全表回退。

### 4.6 查询形式（冻结）

只用列限定匹配，禁止默认全列 `MATCH`：

```sql
SELECT ref_id, raw_text
  FROM fts_index
 WHERE fts_index.bigram_text MATCH ?;
```

- `raw_text` 保留原 Schema、保留原文回显、保留索引空间开销；**不把它改成 UNINDEXED，不为此重建虚拟表**。
- 回归测试：构造一行只有 `raw_text` 含某词、`bigram_text` 不含，查询该词必须**不命中**。

### 4.7 查询表达式语义（v1.1 新增，v1.3 改为 `analyzeFtsQuery`，D7）

`bigramText()` 只负责「把文本切成 token 串」，不负责「这些 token 在 FTS5 里怎么组合」。必须增加独立构造层：

```ts
type FtsQueryMode = 'and' | 'phrase'

// 查询分析的完整结果：保留原文分段，避免模式选择依赖已经丢失的信息
interface FtsQueryAnalysis {
  normalizedInput: string   // 规范化前的原文（只截断，不做其它改写）
  tokens: string[]          // bigramText() 的产物
  segments: string[]        // 按空白/标点切出的原始片段（决定 phrase 还是 AND）
  containsChinese: boolean
  containsNonChinese: boolean
  mode: FtsQueryMode
}

// 唯一入口：内部分词、选模式、构造 MATCH 表达式
function analyzeFtsQuery(text: string): FtsQueryAnalysis

// 把 token 数组构造成安全的 FTS5 MATCH 表达式（去重、转义）
function buildFtsQuery(tokens: string[], mode: FtsQueryMode): string
```

**为什么输入必须是原文而不是 tokens（v1.3 修订，来源 m09314）**：`bigramText()` 清洗后，「你好世界」和「你好 世界」都可能变成同一串 token，原文是否存在分隔边界已经丢失。而这两者的查询语义不同：

- 连续中文（`你好世界`）→ phrase，要求 token 相邻；
- 空格分出的独立词组（`你好 世界`）→ AND，两者都出现即可。

所以 `chooseFtsMode()` 不能只接收 `tokens: string[]`；它接收 `FtsQueryAnalysis`（含 `segments`），由 `analyzeFtsQuery()` 统一负责调用顺序：截断原文 → `bigramText()` → 记录 segments / 中英文标记 → `chooseFtsMode()` → `buildFtsQuery()`。

选择规则（v1.4 冻结，消除「段内 phrase 还是整体 AND」的歧义）：

| 查询形态 | 模式 | 构造 | 例 |
|---|---|---|---|
| 无空白的单个片段（内部标点也算该片段的分隔） | phrase | 该片段的全部 token 按序放进一个 phrase | `周五晚上` → `"周五 晚上"`；`2026-11-06` → `"2026 11 06"`；`user_name_01` → `"user name 01"` |
| 被空白分隔的多个片段 | and | 每个片段内部先 phrase，片段之间用 `AND` 连接 | `你好 世界` → `"你好" AND "世界"`；`大雁塔 老城区` → `"大雁 雁塔" AND "老城 城区"` |
| 跨语言 / 含英文数字的片段 | and（按片段） | 同上 | `sqlite 记忆` → `"sqlite" AND "记忆"` |
| 单字 | 不走 FTS | 受限 LIKE | `猫` |
| 重复 token | 去重后按上述规则 | 片段内按出现顺序去重 | `大雁塔 大雁塔` → `"大雁 雁塔"` |

判据只看**原始查询里有没有空白**：有空白就是多片段（AND），没有空白就是单片段（phrase）。原始形态必须保留在 `FtsQueryAnalysis.segments` 里，`chooseFtsMode(analysis)` 据此返回 `and` / `phrase`；这与评测集的 `expectedMode` 字段一一对应（`你好 世界` → `and`，`你好世界` → `phrase`）。

两种模式的事实差异（SQLite FTS5）：

| 模式 | 表达式 | 语义 |
|---|---|---|
| and | `喜欢 欢你` | 隐式 AND：两个 token 都出现即可，**不要求相邻** |
| phrase | `"喜欢 欢你"` | 短语：两个 token 必须按顺序相邻出现 |

对「喜欢你」的索引 `你喜 喜欢 欢你`：

- 文档 A：`我喜 喜欢 欢你` → AND 命中、phrase 命中；
- 文档 B：`我喜 喜欢 其他内容 欢你` → AND 命中、phrase **不**命中。

**决策（v1.2 修订，2026-11-06，依据 D 阶段 smoke）**：默认 phrase，但**按查询形态选模式**——单段连续中文用 phrase；跨语言 / 多词混合用 AND。依据：

- `sqlite 记忆` 的索引序列是 `sqlite 存记 记忆`，phrase `"sqlite 记忆"` 要求两 token 相邻，实际被「存记」隔开 → 0 命中（`docs/audit/p2-fts5-d-smoke.md` T3）；
- 单段中文仍必须 phrase：`喜欢 欢你` 的 AND 会命中「喜欢……其他……欢你」，phrase 只命中连续那篇（`docs/audit/p2-fts5-b-probe.md`）。

规则集中在一个 `chooseFtsMode(analysis)` 里（输入是原文分析结果，不是 token 数组；见上），不允许不同调用点各用一套；选择结果要记进 recall receipt（`matchMode`），便于评测时归因。

无论选哪种，`buildFtsQuery()` 必须：

1. 对每个 token 做 FTS5 语法转义：**双引号转义成 `""`**（实测 `a"b` 会抛 `unterminated string`）；`* - : ( )` 与 `NEAR` 在引号内安全，但控制字符要过滤；
2. 按出现顺序**去重** token（T17：`大雁塔 大雁塔` 会生成 `"大雁 雁塔 大雁 雁塔"`，要求连续出现两遍，0 命中）；去重只作用于查询，不作用于索引；
3. 空 token 数组返回 `''`，调用方据此跳过查询、按 abstain 处理；
4. 单 token 时 phrase 退化为 `"token"`，与 and 等价。

**生产查询扩展（E3 补强，2026-11-06）**——不改变 D3.5 冻结的查询集，只收紧生产入口的兜底行为：

| 情形 | 处理 |
|---|---|
| 多片段里有单字片段（`不 喜欢`、`满 100 减 20%`） | 单字片段**不丢弃**，转成 `LIKE %片段% ESCAPE '\'` 条件，与 MATCH 条件用 `AND` 组合：`MATCH "喜欢" AND LIKE %不%` |
| 全部是单字片段（`不 未 没`） | 整条走 LIKE 分支，所有片段 AND 组合；不退化成一个字 |
| 无空白单片段但 bigram 后不足 2 字（单个字） | 走 LIKE |
| 查询长度超过 200 码点 | 抛 `E_QUERY_TOO_LONG`，**不静默截断**（截断可能切掉否定词/实体名）；长度按 `Array.from()` 的码点算，不拆代理对 |

为什么不能删单字：删除查询条件会改变语义——`不 喜欢` 删成 `喜欢` 会召回相反结论，`非 工作时间` 删成 `工作 AND 时间` 会丢掉范围限定。宁可多一个 LIKE 条件，也不静默改写用户的检索意图。

D3.5 冻结的 and 查询已禁止单字片段（`query-validation.mjs` 硬规则「and 每片段 ≥2 字」），所以这套兜底只影响生产入口，不重新打开评测集。

---

## 5. 查询与状态过滤（A2/C 交界，先冻结接口约定）

1. FTS 只产出候选（`ref_id` + 文本），不产出最终结果。
2. 候选回到结构化表：join `artifact_revisions` 的 head，按 `kind`、`subject_refs`、`state` 过滤。
3. 默认召回状态：`active`、`challenged`；排除 `superseded`、`retracted`。
4. 结果必须携带 `state`；`challenged` 额外带争议标记，供 Composer 加限定语。
5. 排序规则留给 C：文本相关性为主，证据数量为辅，时间只做 tiebreak。

---

## 6. C / D 阶段提前冻结的原则

### 6.1 C：评分原则

| 项目 | 约束 |
|---|---|
| 文本相关性 | 主要排序依据 |
| 证据数量 | 辅助因素，不能取代文本相关性 |
| 时间 | 不做主衰减，只做同分 tiebreak |
| Artifact 状态 | 先过滤，再排序 |
| 关系好感度 | 不参与评分 |
| Contact Affect | 不参与评分 |
| Global Mood | 不参与评分 |
| 稳定排序 | 同分按 `updated_at DESC, artifact_id ASC` |

若使用 FTS5 `bm25()`：其数值**越小越好**，必须转换（取负或 `1/(1+rank)`）后再与「正向分数 DESC」的约定混用，不能直接当正分。

### 6.2 D：评测顺序

| 阶段 | 规模 | 目的 |
|---|---|---|
| Smoke | 20 条 | 验证检索流程与测试设施 |
| 完整 | 8 类 × 20 条 = 160 条 | 检查各类查询质量 |
| 回归 | 完整固定集 | 防止后续修改退化 |

- DEV.md §28.3 的 Recall@8≥0.85、单类≥0.70、MRR≥0.60、Stale Injection=0、Duplicate=0 保留为**目标值**，不是基线。
- 先跑一次基线（当前接近 0），再逐项达标。
- Abstention 单独评估。

---

## 7. 测试与验收（A2 + B 交付时必须新增）

### 7.1 A2 写入/维护

| 编号 | 用例 | 断言 |
|---|---|---|
| T-A2-1 | 写入一条新 Artifact | `fts_index` 恰一行，`ref_id` 对应 head |
| T-A2-2 | 同一 Artifact 追加 revision | 仍只有一行，内容是**新 head** |
| T-A2-3 | FTS INSERT 故障注入 | 事实与索引都不落盘，`operations` 记 failed |
| T-A2-4 | `rebuildFtsIndex` | 清空后重建，行数与 head 数一致；事实表不变 |
| T-A2-5 | `verifyFtsIndex` | 能分别报出 Missing / Orphan / Duplicate / Content Mismatch |
| T-A2-6 | 只存在于 `raw_text` 的词 | 不命中 |
| T-A2-7 | 四类历史状态 | `superseded`/`retracted` 不进默认召回；`challenged` 进且带 state |
| T-A2-8 | **失败记账不回滚**（D8） | 业务写失败后 `operations` 仍有 `failed` 行；若记账在回滚事务内必须失败 |
| T-A2-9 | **integrity-check**（D4 补充） | 正常索引通过；故意破坏 FTS 内部结构时报错，`verifyFtsIndex` 先报 integrity 错误 |

### 7.2 B 分词

| 编号 | 用例 | 断言 |
|---|---|---|
| T-B-1 | 中文长句 | bigram token 序列与手算一致 |
| T-B-2 | 中英混合 | 英文整词小写 + 中文 bigram |
| T-B-3 | 单字查询 | 走受限 LIKE，结果正确、数量受限 |
| T-B-4 | 两字/三字查询 | bigram / 连续 bigram 命中 |
| T-B-5 | `%`、`_` 查询 | LIKE 转义生效，不变成通配 |
| T-B-6 | 日期三种写法 | 与冻结规则一致，索引/查询同 token |
| T-B-7 | BV 号与自定义 ID | 与冻结规则一致 |
| T-B-8 | 空串/纯标点 | 不构造 `MATCH ''`，返回空结果 |
| T-B-9 | 索引侧与查询侧 | 同一输入产出同一 token 序列 |
| T-B-10 | **连续 bigram**（实测） | phrase 命中相邻出现的文档；记为基线 |
| T-B-11 | **非连续 bigram**（实测） | phrase 不命中「分开出现」的文档；AND 命中（对照，用于最终 mode 决策） |
| T-B-12 | **多中文 bigram 组合**（实测） | 多 token 的 and/phrase 召回差异符合预期 |
| T-B-13 | **中英混合 + 特殊字符**（实测） | 引号/`*`/`-`/`:`/`(` 等不破坏查询、不抛语法错误 |
| T-B-14 | **查询分析结构**（v1.3） | `analyzeFtsQuery()` 保留 `segments`/中英标记：连续中文→phrase、空格分开的中文词组→AND、标点分隔多词组按规则、中英混合→AND；`matchMode` 与选择一致 |
| T-B-15 | **重复 token 去重**（v1.2，D smoke 回写） | `大雁塔 大雁塔` 去重后 phrase 命中；不去重时 0 命中（回归）；去重保持出现顺序 |
| T-B-16 | **日期非等价**（v1.3） | 索引 `2026-11-06` 查询 `20261106` 不命中、反向也不命中、同形命中；不允许靠辅助 token 互通 |

---

## 8. 交付顺序与不变量

1. **A2 + B**：本冻结稿 → 实现写入/分词/查询 → 上述测试 → 回归 1148。
2. **C**：评分规范（bm25 转换、状态过滤、tiebreak）→ 单测。
3. **D**：20 条 smoke → 160 条完整集 → 基线 → 目标对照。
4. **E**：实现收口 + Capture/Recovery/Cursor 回归 + 一次真实宿主验证。

不变量：

- 不新增 Migration；`fts_index` DDL 不变。
- 事实表（sources/events/artifacts/artifact_revisions）语义不变。
- 记忆检索可信度与好感度、Contact Affect、Global Mood 无关。
- 任何写入路径都必须经过 `#insertRevision`；外围插件不得直接操作 FTS。

---

## 9. 未决项（留给 C / D，不在本稿冻结）

| 项 | 归属 | 说明 |
|---|---|---|
| 具体相关性模型（bm25 参数 / 字段权重） | C | 需要 D 的评测集校准 |
| 证据数量在排序里的权重 | C | 不能压过文本相关性 |
| 日期互通（别名查询） | 第一版不做 | v1.3 明确：`2026-11-06` 与 `20261106` 不互通；将来用受控多分支查询实现，不用辅助 token |
| and / phrase 的最终选择（4.7） | v1.2 已定规则，待实现验证 | 单段连续中文 phrase、跨语言/多词 AND；由 `chooseFtsMode(analysis)` 统一，T-B-14 验证 |
| 失败记账事务边界（D8） | 已关闭（2026-11-06） | 源码审计确认：`store.ts:1698-1722` 在业务事务回滚后另开事务记账，不引入第二连接；E 阶段保持，T-A2-8 回归 |
| 事件是否入 FTS | D 之后 | 看「找旧事」类 Recall |
| abstain 阈值 | D | 无结果/低分/不可披露分别统计 |
