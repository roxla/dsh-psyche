# P2 记忆治理设计稿（§31 P0 落地规格）

- 版本：0.1（设计完成，**实现未开始**）
- 日期：2026-11-06
- 来源：`dsh-memory-brain`（main 分支，2026-11-06 已 clone 核实）的工程机制（见 DEV.md §31）
- 适用范围：E 阶段首批，排在 Recall 之前；D5 不动本稿任何内容
- 红线：不建第二套 pending 队列、不建第二套衰减、不建第二套状态机、单一事实源不变

本稿把 §31 的 P0 四项写成可实现的规格：提议式记忆写入、遗忘闭环、影子模式、检索提取度。所有对象都映射到现有表与状态机，不新增平行事实源。

---

## 1. 提议式记忆写入

### 1.1 目标

模型从对话里提炼出的内容，先成为**候选**，经证据校验、去重、过期和审核后，才成为当前认知。候选不是新对象：它就是一条 `state='proposed'` 的 Artifact。

### 1.2 状态机

```
proposed ──accept──▶ active
    │                   │
    ├──reject──▶ retracted
    ├──expire──▶ expired
    └──supersede──▶ superseded（被新候选取代）
```

- `proposed` 不参与注入、不计入 Growth、不进入 stances 默认查询。
- 接受时复用 `review(verdict='confirmed')` 的语义；拒绝走 `rejected`，写入 operations 审计。
- 过期由 Core 定时判断（`expiresAt < now`），只改状态，不产生正文、不删除证据。

### 1.3 字段（追加到 Artifact / operations，不新建表）

| 字段 | 存在位置 | 约束 |
|---|---|---|
| `proposalId` | 等于 `artifactId` | 与 Artifact 一一对应 |
| `evidenceIds` | `artifact_trigger_events` + `source_ids` | 至少 1 条非自身来源；空则拒绝 |
| `confidence` | 现有 `confidence` 列 | low / medium / high |
| `importance` | `salience` 列（0–1） | 只排序，不参与事实判断 |
| `status` | `state='proposed'` | 四值：proposed / active / retracted / expired |
| `expiresAt` | `payload.expiresAt` 或 operations 行 | 默认 7 天；核心约定类不设过期 |
| `dedupKey` | `independent_key` 或 operations 行 | 同 key 只保留一条 pending；冲突走 `E_IDEMPOTENT_CONFLICT` |

**不新增 `memory_proposals` 表**：这是本稿与外部方案最大的差别。理由：双写两张表就多一个一致性来源；Artifact 已有 revision / evidence / operations，候选只是它的一个状态。

**参考实现的候选/建议参数（已核实，第一版照抄）**

- 建议（suggestion）不是候选（proposal）：`perWake` 3（1–10）、`maxShows` 2（1–10）、`ttlHours` 72（1–720）、`mode: off|on`；同一条被展示满 `maxShows` 次或超 TTL → 作废；账本里已有相似条目 → 标 duplicate，不重复建议。
- 展示与采纳分开记账（`suggest.shown` / `suggest.adopted`），控制台看采用率——这是判断「建议有没有用」的唯一证据，不靠感觉。
- 候选自身：`expiresAt` 默认 7 天，核心约定类不设过期；`dedupKey` 命中同 key 且 statement 不同 → `E_IDEMPOTENT_CONFLICT`。

### 1.4 错误码

- `E_NO_SOURCE`：证据为空或全部为模型自述。
- `E_IDEMPOTENT_CONFLICT`：dedupKey 命中已有 pending 且 statement 不同。
- `E_STATE`：对非 proposed 的候选做 accept/reject。
- `E_VALIDATION`：statement 为空、importance 越界、expiresAt 非法。

### 1.5 测试清单（E 阶段）

1. 无证据的提议被拒，且不落 Artifact。
2. 同 dedupKey 的第二条提议被拒（或合并），不产生两条 pending。
3. 过期提议变 expired，不进入注入与 stances。
4. 接受后 `state=active`，且 visible 于 stances/recall。
5. 拒绝后 `state=retracted`，证据保留、operations 有记录。
6. proposed 不出现在 `psyche_stances` 默认结果。

---

## 2. 遗忘闭环

### 2.1 两种模式，不许混用

| 模式 | 语义 | 保留什么 | 用户可见结果 |
|---|---|---|---|
| `cognitive` | 不再当作当前认知 | 证据与修订历史 | 「已不再使用这条结论」 |
| `erase` | 删除原始内容与可恢复派生副本 | 只留墓碑与审计 | 「已删除这段内容」 |

**自动冻结不是遗忘**：冻结只影响自动注入，`erase` 才清内容。

### 2.2 状态机

```
requested → resolving → canonical-done → derived-done → verified
                 │              │               │
                 └──── failed ◀─┴───────────────┘
```

- `requested`：写 `forget_requests`（新表，v10 预留）与 operations 审计；立即返回 requestId。
- `resolving`：解析依赖（Source → Event → Artifact → Revision → Narrative → FTS → 缓存/未来向量），列出影响面。
- `canonical-done`：主记录墓碑化或删除；等长墓碑只在 source 原文场景使用。
- `derived-done`：派生面清理（见 2.3）。
- `verified`：逐项复核无残留（`residual=[]`）；有残留 → failed + 列表，可重试。
- 任何一步失败不自动回滚已完成的删除；进入 `failed`，保留残留清单，由人决定重试或接受。

### 2.3 派生清理清单

| 派生面 | 清理动作 |
|---|---|
| FTS（`fts_index`） | 按 ref_id 删除；必要时 `rebuildFtsIndex()`；全量重建时 `wal_checkpoint(TRUNCATE)` + `VACUUM`（参考实现已核实） |
| Narrative | 标记 stale，重生成或删除对应段落 |
| Memory View（`memory-view/`） | 下次重建；不保留旧文件 |
| 缓存（appraisal / recall cache） | 按 key 失效 |
| 未来向量索引 | 按 artifactId/sourceId 删除（实现时加） |
| 备份 | 若配置了备份，遗忘请求被消费时同步清理对应备份（参考实现的做法）；轮转之前的历史备份与外部副本不承诺 |

### 2.4 删除保证边界（必须写进 UI 与文档）

- 能做：逻辑删除、派生失效、FTS 重建、SQLite WAL checkpoint、VACUUM。
- 不做：SSD 取证级擦除、文件系统历史快照、云备份/同步副本、用户自己导出的副本。
- 文案禁止说「彻底无法恢复」；只能说「已从心灵的数据目录与索引中移除」。

### 2.5 测试清单（E 阶段）

1. `cognitive` 遗忘后，证据与 revision 仍在，注入与 recall 不再返回。
2. `erase` 后 FTS 查不到、Narrative 不残留、memory view 重建后无该内容。
3. 中途强杀后重启：request 仍在，状态可继续推进，不重复删除。
4. 残留检测能报出四类：fts / narrative / cache / vector。
5. 失败请求可重试，且不会误删其他 Artifact。
6. 备份目录不参与自动清理，UI 明确提示。

---

## 3. 影子模式

### 3.1 模式

`appraisalMode: 'off' | 'shadow' | 'live'`，存 settings，不写 `persona.json`。

- `off`：不判读、不记录。
- `shadow`：判读、记录，**引擎状态照常更新**，但 Composer 不注入——所以回复不变。面板可查看判读结果。
- `live`：同样更新状态，并把人格 / 关系 / 情绪注入提示词；可随时退回 `shadow`，不需要改数据。

已核实（`docs/FORK_FEATURES.md` 31–32 行 + `src/persona-appraisal.js`）：参考实现的影子模式是「判读照写、注入开关」，不是「不写状态」。模型只判断「发生了什么」，变化幅度由代码决定；模型失败/超时/超日限时规则表兜底，状态照样会动。

### 3.2 记录

`appraisals`（新表，v10 预留；或先写 operations 的 `appraisal` 类型）：

```
appraisalId, engine(memory|relationship|mood|growth),
sourceIds[], judgement JSON, confidence, applied, reason, mode, createdAt
```

- 只追加，不修改。
- 记录模型判读、规则结果、实际写入状态、注入与否、不一致原因五样。
- 不记录对话正文（隐私）。

### 3.3 生效判定

沿用现有裁判模型：模型提候选 → 规则门槛（证据、置信度、范围）→ 人批或自动阈值。
shadow 与 live 都写入引擎状态，差别只在最后一步「是否注入唤醒提示」；判定逻辑完全共用。

### 3.4 测试清单（E 阶段）

1. off 不产生 appraisal 行。
2. shadow 产生行、引擎状态照常更新，但 Composer 注入为空、回复不变。
3. live 在门槛内生效，越界被拒并记录 reason。
4. live → shadow 回退后，后续判读不再生效。
5. 影子期数据可用于评估误判率（按 engine 统计）。

---

## 4. 检索提取度（RetrievalState）

### 4.1 定位

只回答「这条记忆现在还有多容易被想起、要不要自动注入」。**不回答**「这条记忆是否真实」「是否仍是当前结论」。

### 4.2 公式（第一版，按已核实的参考实现）

- 可提取度：`R(t) = (1 + F·t / S)^-0.5`，`F = 19/81`（`t = S` 时 R = 0.9），`t` 为距上次回忆的天数，`S` 为稳定性。**不是标准 FSRS 的 `(1 + t/(9S))^-1`**。
- 稳定性更新：`S' = S · (1 + e^w8 · (11 − D) · S^(−w9) · (e^(w10·(1−R)) − 1) · (费劲 ? w15 : 1))`，夹到 `[0.5, 3650]`；`R = 1` 时不增长。
- 难度更新：`good`（G=3）基本不动，`hard`（G=2）变大，并向 `D0_EASY ≈ 3.2245` 轻微回归，夹到 `[1, 10]`；**没有 again/easy 两档**。
- 冻结：`R < 0.5` 且非豁免 → `frozen=true`，不再自动注入；主动 recall / fetch 仍可找回，找回后按 `good` 解冻；同一小时内重复想起只算一次（冷却）。
- 状态只存 `{S, D, last, reps, hard}`，不存原文；阈值与默认参数**不照搬**，必须在影子期用真实检索数据标定。

### 4.3 豁免

`exemption`：`core`（人工 pin，每人 ≤8 条）、`open-commitment`（未完成约定）、`manual`。自动冻结不得覆盖。

参考实现已核实：豁免就是两类——`item.core === true`，或 `cat === 'pending'` 且 `status` 缺省/`open`。人工 pin 在语义上就是 `core`，不额外造第三类；人工豁免只能用 `manual` 覆盖单条，且必须留审计记录。

### 4.4 与现有对象的关系

- 与 `salience`：salience 是「重要程度」，RetrievalState 是「回忆概率」；两者分开算、分开存。
- 与 Artifact `state`：完全分离；`superseded/forgotten` 由认知流程决定，不由 R 决定。
- 与 Affinity：完全分离；好感不自动衰减。
- 与注入：Composer 读 `frozen` 决定是否跳过；`frozen` 不进长期记忆正文。

---

## 5. 不实现清单

- 不新增 `memory_proposals` / `retrieval_states` 主表之外的平行事实源（`forget_requests` 与 `appraisals` 是审计/请求队列，不是记忆本身）。
- 不引入 Chroma、Embedding、RRF、实体图（等有语义评测集）。
- 不把 `people.json`、`private|public` 二态搬进来。
- 不做自动冻结即遗忘。
- 不在 D5 前改任何 schema 或注入行为。

## 6. 阶段门槛

1. E 阶段先做提议 + 遗忘闭环（各自独立测试通过）。
2. 再做影子模式，先 shadow 跑一周真实对话，统计误判率。
3. RetrievalState 最后开，默认 off，用 shadow 数据标定参数。
4. 四项全部过 §30.6 八条接入检查后，才允许进入 P3 的 Recall 与 Composer。
