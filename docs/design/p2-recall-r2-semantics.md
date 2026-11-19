# P2 Recall · R2 语义冻结（设计稿）

- 日期：2026-11-07
- 性质：**只写设计，不改代码**（R3 才统一召回内核）
- 输入：`docs/audit/p2-recall-r1-audit.md`（R1）、用户 m18374 的五项决定
- 冻结口径：R2-01～R2-15，见 §9

## 1. 一句话原则

**主动 Recall 和自动注入是同一套记忆检索能力的两种消费方式，不是两套不同的记忆系统。**

主动 Recall 是模型在需要时主动查询；自动注入是系统在每轮对话开始时提前提供。
二者可以有不同的数量/Token 预算和输出格式，但必须具有相同的记忆可见性、Contact/Channel Scope、Revision 状态准入、Disclosure 规则和相关性排序基础。

这样以后无论 QQ、Desktop、Web 还是桌宠，都不会出现「主动问能查到、自动注入查不到」或反过来的语义分裂。

## 2. 统一召回内核

```
                  Recall Engine（唯一候选生成与准入）
                            │
                    Query Normalize
                            │
                       searchFts
                            │
                     候选准入（state / disclosure / scope）
                            │
              ┌─────────────┴─────────────┐
        Core.recall                 PreStepInjector
         主动回忆                      自动注入
              │                           │
        Tool Result                   Composer（二次回库复核）
              │                           │
           Model                  InjectionManifest / FinalCheck
```

### 2.1 统一的部分

- `analyzeFtsQuery` / `buildFtsQuery`（phrase / and / like 分段）。
- `searchFts` 的 FTS5 匹配与**原生 BM25 排序**。
- 稳定的 tie-break（同分时按 `artifact_id` 字典序，保证可复现）。
- head-only（`revision = max(revision)`）。
- 状态准入、Disclosure 准入、Scope 准入。
- 候选准入规则与拒绝原因枚举。

### 2.2 保留不同的部分

- 主动 Recall 的返回格式（`artifacts` + 关联摘要 + 证据计数）。
- 自动注入的 `Composer` 渲染（`<memory-context>` 块）。
- 两者各自的数量与字符/Token 预算（见 §8）。

### 2.3 不保留子串兜底

不保留 `instr(lower(statement), lower(?))` 隐式兜底。理由：

1. 会重新引入两套匹配语义；
2. `instr` 排序与 BM25 不一致，无法解释「为什么命中」；
3. 单字符查询已由 `likeSegments` 的 LIKE 扩展覆盖；
4. 未来无法明确解释模型通过哪条路径找到某条记忆。

以后若发现某类查询 FTS 覆盖不足，只允许增加**明确的独立召回模式**（单独评测、结果标记来源），不允许悄悄回退到全表子串搜索。

## 3. 状态准入

| Artifact State | 普通 Recall |
|---|---|
| `active` | 允许 |
| `challenged` | 允许，但必须标记争议 |
| `superseded` | 禁止 |
| `draft` | 禁止 |
| `forgotten` | 禁止 |
| `retracted` | 禁止 |
| `deprecated` | 禁止 |
| 其他非准入状态 | 默认禁止 |

`challenged` 的返回必须带：

```json
{
  "artifactId": "art_001",
  "revision": 3,
  "statement": "当前观点内容",
  "state": "challenged",
  "statusNote": "该观点存在争议，不能作为确定事实"
}
```

**顺序约束**：状态过滤必须在候选 `LIMIT` 之前执行，不能先取 TopK 再过滤（否则会出现「有公开有效结果却返回空集」）。

## 4. Scope 准入

Scope 只能来自可信 `RuntimeInput`（宿主绑定），**模型不能通过传入 `contactId` / `channelId` / `groupId` 改变自己的访问范围**。

| 当前 RuntimeInput | 允许访问 |
|---|---|
| 有可信 Contact + Channel | 全局公开记忆 + 当前匹配的 Contact / Channel 记忆 |
| 有 Contact、无 Channel | 全局记忆 + 当前 Contact 允许共享的记忆 |
| `contactId = null` | 仅全局公开记忆 |
| 无 RuntimeInput | 仅全局公开记忆 |
| 身份绑定失败 | 仅全局公开记忆 |

补充：

- Group Context 必须匹配当前 Group。
- 不同 Platform 的 Contact 不自动合并。
- 同一用户不同 Channel 遵守已冻结的身份规则。
- **Owner 管理路径是独立授权主体**：Owner 面板可以保留管理视图需要的查询能力，但必须使用 Owner 权限上下文，不能把 Owner 的全库查询权限复用给模型工具。

**顺序约束**：Scope 过滤尽量下推到 SQL，并发生在 `LIMIT` 之前。

### 4.1 Subject 精确匹配

`instr(r.subject_refs, ?)` 会把 `ct_a` 命中 `ct_aa`，这是明确的匹配错误。

冻结：Subject 必须按结构化标识**精确成员匹配**——解析 `subject_refs` JSON 数组后做严格数组成员判断，或使用 SQLite JSON 精确元素匹配；暂不新增独立 Subject 表。

## 5. Event 与证据

普通 Recall 的 Event 栏收窄：

**返回**：

- 允许访问的当前 Artifact 结论；
- Artifact 与 Event 的关联摘要（非敏感）；
- 按 D5-B 规则计算的**支持证据数量**；
- 必要的非敏感时间信息。

**不返回**：

- Event 原始正文；
- Source 原文；
- Source ID；
- 原始 Event 摘要或可反查的来源标识。

示例：

```json
{
  "artifactId": "art_001",
  "revision": 3,
  "statement": "项目采用 SQLite 作为结构化记忆存储",
  "state": "active",
  "supportEvidenceCount": 3
}
```

### 5.1 支持证据数不能直接改名

当前 `independent_evidence_count` **把 `contradicts` 也计算在内**，在修复前不能直接改名当 `supportEvidenceCount` 使用。

新的支持证据数必须按 D5-B 定义计算：

- 只统计 `supports`；
- 按独立 `independence_key` 去重；
- 只计算适用的当前 Revision；
- 不把重复采集或同一 Source 的多个关联误算成独立证据。

原始 Event / Source 将来通过 `fetch` 查看，但必须先有**来源级 Disclosure 与权限规则**；不能把「从 Recall 移除」变成「换一个没有披露约束的接口继续读」。

## 6. Abstention（结构化拒答）

```json
{
  "results": [],
  "abstained": true,
  "abstainReason": "no_eligible_results",
  "guidance": "当前对话范围内没有找到可用的公开记忆证据。不要编造或推测已记住的内容，应明确说明没有找到相关记忆。"
}
```

- 不区分 `no-memory` 与 `not-disclosable`：向模型暴露「有 3 条受限记忆但无权读取」本身就是信息泄漏。
- 模型只看到统一的 `no_eligible_results`；内部 Recall 审计可以区分「无匹配 / Scope 不符 / Disclosure 拦截 / State 拦截」，但内部诊断信息**不得进入模型工具返回内容**。
- `abstained` 不等于模型不能回答其他知识问题；它只表示「没有可引用的心灵个人记忆依据，不能谎称自己记得」。

## 7. Recall Receipt（内部可追踪回执）

现状：只有注入后的 `InjectionManifest`，没有候选生成阶段的记录，回答不了「某条记忆为什么没有出现在最终注入中」。

建议两层记录：

| 记录 | 内容 |
|---|---|
| `recall_runs` | `runId`、`requestId`、`queryHash`、`queryMode`、Scope、时间、最终状态 |
| `recall_candidates` | `artifactId`、`revision`、原始 rank、准入/拒绝结果、拒绝原因、最终 rank |

并在内部记录「是否进入结果 / 是否进入 Composer / 是否被预算截断」。

**隐私约束**：不默认把原始 Query 和记忆正文复制进长期审计表；优先记录 Hash、模式、长度和结构化决策，避免召回审计又制造一个新的敏感数据仓库。

`runId` 可以关联后续 `InjectionManifest.requestId`，但要区分「一次 Recall」与「一次模型请求」的生命周期。

## 8. 两种消费方式的预算

| 项目 | 主动 Recall | 自动注入 |
|---|---|---|
| 检索内核 | `searchFts` | `searchFts` |
| 状态规则 | 相同 | 相同 |
| Disclosure | 相同 | 相同 |
| Scope | 相同 | 相同 |
| 排序 | 相同 | 相同 |
| 输出 | 模型工具结果 | Context Block |
| 最大数量 | 保留既有 8 / 20 配置 | 6 |
| 字符预算 | 新增硬限制 | 800 字 |
| Token 上限 | 不超出工具调用预算 | 1500 Token |

不为了统一代码把两种场景强行做成同一种输出——统一的是安全规则和记忆候选，不是调用体验。

## 9. R2 冻结表（R2-01～R2-15）

| 编号 | 事项 | 冻结决定 |
|---|---|---|
| R2-01 | 主动 Recall 匹配 | 使用 `searchFts` |
| R2-02 | 子串兜底 | 不保留隐式 `instr` 路径 |
| R2-03 | 排序 | BM25 + 稳定 tie-break |
| R2-04 | 状态 | `active` / `challenged`（后者带 `statusNote`） |
| R2-05 | Disclosure | 只允许当前 Revision `public` |
| R2-06 | Scope | 全局 + 当前可信 Contact / Channel / Group |
| R2-07 | 身份缺失 | 仅全局记忆 |
| R2-08 | Subject | 精确成员匹配 |
| R2-09 | Event | 不返回原始正文 / Source ID |
| R2-10 | Evidence | 按 D5-B 独立 `supports` 语义 |
| R2-11 | Abstention | `abstained: true` + 通用原因 |
| R2-12 | Recall Receipt | 增加内部可追踪回执 |
| R2-13 | Composer | 保留二次回库复核 |
| R2-14 | Recall / Injection | 共用候选生成与准入内核 |
| R2-15 | 原始 Source / Event | 等待来源级 Disclosure，不直接进入模型上下文 |

## 10. 后续开发顺序

| 阶段 | 内容 | 边界 |
|---|---|---|
| **R2（本轮）** | 语义冻结 | 只完成设计文档，不改代码 |
| R3 | 统一召回内核 | `Core.recall` 从 `instr` 迁移到 `searchFts`；统一准入与排序；补 Scope 精确匹配与状态过滤 |
| R4 | Abstention 与 Recall Receipt | 结构化无命中语义 + 召回审计回执；内部拒绝信息不进模型输出 |
| R5 | Recall 专用评测 | 精确 / 模糊描述 / 跨 Contact / 状态冲突 / 受限记忆 / 无命中 / 证据追溯 / 预算约束 |
| R6 | 集成回归 | 主动 Recall 与自动注入同一套检索语义、各自输出预算；Composer / FinalCheck 无回归 |

## 11. 不做什么

- 不把 `Core.recall` 与自动注入合成同一种输出。
- 不把 Event 原文继续塞进 Recall。
- 不把「有受限记忆」暴露给模型。
- 不预设 Recall 指标目标值（R5 先取基线再定门槛）。
- 不改 BM25 / Evidence Boost / Disclosure / Composer 预算 / Growth Gate。
