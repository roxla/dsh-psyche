# P2-Recall R4：Abstention + Recall Receipt（冻结稿）

> 日期：2026-11-07  
> 性质：**语义冻结，待确认后再编码**。R3 已 PASS（2,082 断言，已知边界见 `p2-recall-r3.1-channel-scope.md`）。  
> 路线：R3.1 Channel/Group Scope 语义记录 → **R4-A Abstention → R4-B Recall Receipt → R4-C Composer 联动** → R5 专用评测 → R6 集成回归。

## 0. 目标

建立一条可解释的召回链：不仅知道模型最终看到了什么，还能回答：

1. 候选为什么入选；
2. 候选为什么被拒绝（state / disclosure / scope / subject / 预算）；
3. 一次召回为什么是「拒绝召回」而不是「没有记忆」。

R4 不改变 R3 的检索排序、索引结构、disclosure 规则和 Composer 预算。

## 1. R4-A：Abstention 返回契约

### 1.1 返回结构

```ts
interface RecallResult {
  results: RecallItem[]
  abstained: boolean
  abstainReason?: 'no_eligible_results'
  guidance?: string
  runId?: string
}
```

- `abstained: true` 时 `results` 必为 `[]`。
- `abstainReason` 目前只有一个值：`no_eligible_results`。**内部**可以记录具体拒绝原因（缺失 / staled / state / disclosure / scope / subject），但**不返回给模型**。
- `guidance` 只在 `abstained: true` 时出现，固定文案：

> 当前可访问的记忆中没有找到相关依据。不要声称记得具体内容，也不要编造历史经历。

禁止返回「存在某条受限记忆」这类信息——这会泄露受限记忆的存在，也会诱导模型追问。

### 1.2 四条规则

| 情况 | 返回 |
|---|---|
| 有可用记忆 | `abstained: false`，`results` 非空 |
| 完全无匹配（FTS 无候选 / 无 head） | `abstained: true`，`results: []` |
| 有匹配但全部受限（state / disclosure） | `abstained: true`，`results: []` |
| 有匹配但 Scope / Subject 不符 | `abstained: true`，`results: []` |

对模型统一表现为 `no_eligible_results`；内部 `rejected` 计数只进 Receipt 与诊断日志。

### 1.3 自动注入的 abstention

- `PreStepInjector` 在 `recallMemory` 返回 `abstained: true` 时**不生成空的 `<memory-context>`**，也不追加消息；只保留内部回执（R4-C）。
- `no-query` / `query-too-long` 仍是 `PreStepSkipReason`，不属于 abstention（它们不是「没有可用记忆」，而是「这一轮没有可检索输入」）。

### 1.4 工具层

- `psyche_recall` 返回结构同步加 `abstained` / `abstainReason` / `guidance`；render 在 `abstained` 时显示「没有可用依据」而不是空列表。
- `guidance` 原文进工具结果，模型不能改写（它是契约的一部分，不是建议）。

## 2. R4-B：Recall Receipt

### 2.1 两张表的职责

```
recall_runs        一次完整的召回执行（聚合层）
  └── recall_candidates   本次执行里每个候选的准入过程（明细层）
```

- `recall_runs` 一行 = 一次 `recallMemory` 调用（主动或自动）。
- `recall_candidates` 一行 = 一个候选在一个 run 里的完整旅程。
- 候选记录**不保存正文**，只保存 Artifact ID / revision / 排名与决策。

### 2.2 `recall_runs` 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `run_id` | TEXT PK | 本次 Recall 唯一标识（`rr_` + ULID/UUID） |
| `request_id` | TEXT NULL | 关联的模型请求（自动注入时与 InjectionManifest 的 requestId 相同；主动工具调用通常为空） |
| `persona_id` | TEXT NOT NULL | Persona |
| `query_hash` | TEXT NOT NULL | 归一化查询的本地密钥 HMAC-SHA256（hex） |
| `hmac_key_version` | INTEGER NOT NULL | 本地密钥版本（支持轮换） |
| `query_mode` | TEXT NOT NULL | `phrase` / `and` / `like` / `none`（无 text 的结构化列表） |
| `scope_type` | TEXT NOT NULL | `global` / `contact` / `group` / `mixed`（R3.1 落地后的域；当前先记 `contact`/`global`） |
| `scope_hash` | TEXT NOT NULL | Scope 的 HMAC 指纹（不含原始 contactId） |
| `requested_limit` | INTEGER NOT NULL | 请求上限 |
| `matched_count` | INTEGER NOT NULL | FTS 原始匹配数（LIMIT 前） |
| `eligible_count` | INTEGER NOT NULL | 通过准入的候选数 |
| `returned_count` | INTEGER NOT NULL | 最终返回数 |
| `abstained` | INTEGER NOT NULL | 0/1 |
| `created_at` | TEXT NOT NULL | ISO 时间 |

### 2.3 `recall_candidates` 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `run_id` | TEXT NOT NULL REFERENCES recall_runs | 关联执行 |
| `artifact_id` | TEXT NOT NULL | 候选 |
| `revision` | INTEGER NOT NULL | 候选 revision |
| `raw_rank` | INTEGER NOT NULL | FTS/结构化列表里的原始排名（1 起） |
| `eligible` | INTEGER NOT NULL | 是否通过准入（0/1） |
| `reject_reason` | TEXT NULL | `missing` / `stale` / `state` / `disclosure` / `scope` / `subject` / `channel`（R3.1 后） |
| `final_rank` | INTEGER NULL | 通过准入后的最终排名（1 起） |
| `selected` | INTEGER NOT NULL | 是否进入结果（0/1，受 LIMIT 影响） |
| `composed` | INTEGER NOT NULL | 是否进入 Composer（仅自动注入，0/1） |
| `truncated` | INTEGER NOT NULL | 是否被预算截断（0/1） |
| PRIMARY KEY | `(run_id, artifact_id, revision)` | 同一 run 内同一版本只记一行 |

**`raw_rank` 与 `final_rank` 必须分开**：这样能回答「一条相关性很高的记忆为什么没进最终上下文」——可能是 state/disclosure/scope 拒绝，也可能只是预算截断。

### 2.4 三个存储约束

1. **不保存原始 Query 和正文**：
   - `query_hash = HMAC-SHA256(local_key, normalize(query))`，不是无密钥 SHA256（防字典反推）；
   - 记录 `hmac_key_version`，支持轮换；
   - 本地密钥文件：`$DSH_HOME/psyche/secret/recall-hmac.key`（0600，绝不进导出包、绝不进模型上下文）。
2. **Receipt 是内部审计数据**：
   - 不注册为模型工具；
   - 不出现在 `psyche_recall` 结果里；
   - 面板里也不做普通条目展示（最多在「运维」页给出聚合计数与受控诊断入口）。
3. **生命周期**：
   - `recall_runs` 默认保留 30 天，`recall_candidates` 随 run 级联删除；
   - 清理在打开数据库后的维护阶段执行（同 FTS verify 的时机），按 `created_at` 批量删；
   - 受限 Artifact ID 属于敏感元数据，导出/备份时默认排除这两张表（或只导出 `recall_runs` 的聚合行）。

### 2.5 诊断不能靠「反推」

R3 的 SQL 在 LIMIT 前过滤，最终结果里查不到被拒绝的候选。R4 需要在**同一次执行内**产出：

- 原始排名（FTS 返回的全部候选，含被准入拒绝的）；
- 准入判定（每条候选的 reject_reason）；
- 最终排名与是否被截断。

实现上给 `recallMemory` 一个内部 option `diagnostics: true`（只由 Receipt 写入路径使用），返回 `candidates: RecallCandidateTrace[]`；**不对模型开放**。这样回执与真实输出同源，不用从结果反推。

### 2.6 schema

- `SCHEMA_VERSION = 11`；
- 新增 `recall_runs`、`recall_candidates`（业务表 37 → 39；`sqlite_master` 统计口径同步）；
- 迁移只建表 + 两个索引（`recall_runs(created_at)`、`recall_candidates(run_id)`），不回填历史；
- 清理：`DELETE FROM recall_runs WHERE created_at < ?`（候选级联）。

## 3. R4-C：Recall 与 Composer 联动

### 3.1 三个概念不能混

| 概念 | 粒度 | 生命周期 |
|---|---|---|
| Recall Run | 一次 `recallMemory` 调用 | 一次请求内（可多次） |
| `requestId` | 一次模型请求 | 一次 `agent/pre-step` 或一次工具调用 |
| InjectionManifest | 进入自动注入的最终内容 | 一次 `llm/stream` 请求 |

- 一个请求可以触发多次 Recall（工具多轮、pre-step 重试）。
- 一次 Recall 可以产生多个候选。
- 只有进入自动注入的内容才进 Manifest。
- **主动 Recall 的结果不写 InjectionManifest**，也不伪装成 PreStepInjector 的注入记录。

### 3.2 写入点

- `recallMemory` 执行完写 `recall_runs` + `recall_candidates`（同一事务，与召回同源）。
- 主动路径：`run.request_id = null`，候选 `composed = 0`。
- 自动注入路径：`run.request_id = 当前 requestId`；Composer 之后回填 `composed` / `truncated`（同一 run 的候选行 UPDATE，或写入时先记 0、Composer 返回后补写——需在实现时二选一并写清）。
- 写入失败不能影响召回本身（Receipt 是旁路；失败只记 `diag`，不抛给模型）。

### 3.3 面板与审计

- 运维页只显示聚合：最近 N 次召回、abstained 比例、拒绝原因分布；
- 单次 run 的候选明细只通过受控 Owner 路由读取（`/api/psyche/recall-runs/:id`），且不返回 query 原文（只有 hash）；
- 导出包默认排除 Receipt。

## 4. 测试矩阵（编码时落地）

| 组 | 场景 |
|---|---|
| A 契约 | 有结果 → `abstained:false`；无匹配/全受限/全 scope 不符 → `abstained:true` + `no_eligible_results` + 固定 guidance |
| B 泄露 | 受限候选存在时，模型可见结果里不出现「存在受限记忆」的任何提示 |
| C 自动注入 | `abstained` 时不追加空 `<memory-context>`、不追加消息、只记内部回执 |
| D Receipt 写入 | 一次召回 = 一行 run + N 行候选；`raw_rank`/`final_rank` 分离；被拒绝候选的 `reject_reason` 正确 |
| E 存储约束 | 库里没有 query 原文；`query_hash` 为 HMAC；`hmac_key_version` 落库；密钥文件权限 0600 |
| F 隔离 | Receipt 不出现在 `psyche_recall` 结果、不出现在普通面板条目 |
| G 生命周期 | 超过保留期的 run 被清理，候选级联删除；清理不影响召回 |
| H 三概念 | 同一 request 两次 Recall 产生两个 run；主动 Recall 不产生 Manifest；自动注入的 run 带 requestId |
| I 幂等/失败 | Receipt 写入失败不影响召回结果；重复执行同一 opId 不产生重复 run（如引入 opId） |
| J 回归 | R3 的 25 断言、D4-B 160/160、E5.5-E2 安全全 0 不变 |

## 5. 验收标准（不设毫秒门槛）

- 模型可见结果里永远不出现内部拒绝原因、受限记忆的存在、原始 Query；
- 任意一次「没召回」都能在 Receipt 里被判成「无匹配 / 全受限 / 全 Scope 不符」之一；
- 任意一条未进入最终上下文的候选，都能在 Receipt 里找到 `raw_rank`、`reject_reason` 或 `truncated`；
- Receipt 不成为第二套事实源：删掉两张表，召回结果与安全语义不变。

## 6. 实施顺序

1. 用户确认本冻结稿（尤其 R3.1 的 Channel 规则走 A 还是其他）；
2. schema v11 + `recall-runs.ts`（写入/清理/诊断读取）；
3. `RecallResult` 契约 + `psyche_recall` 工具层；
4. `PreStepInjector` abstention 分支；
5. `Composer` 回填 `composed`/`truncated`；
6. 测试矩阵 A–J；
7. DEV/README 更新与汇报。

## 7. 明确不做

- 不改变 BM25 / 索引 / 排序；
- 不改变 disclosure 规则；
- 不在 R4 做 Channel SQL 准入（那是 R3.1，先确认规则再编码）；
- 不做「按候选反推拒绝原因」的诊断。
