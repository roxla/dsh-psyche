# P5-3a 成长反思候选实现记录（rule-only v1）

状态：实现完成，等待全量与 Host 证据。
上游契约：`docs/design/p5-growth-reflection-contract.md`。
外部问答：P5 阶段协议（单议题 ≤8 轮），本阶段 3 轮冻结。

## 1. 范围

只生成候选：

- 不确认、不生效、不改 `identity.md`、不投影 Prompt；
- 不新建 Proposal / Operations 行，不复用现有写入确认流程；
- 触发位置：`agent/turn-stopping`（每轮一次，失败吞掉，不影响对话）；
- 配置：`growthReflection { enabled=true, perContactDaily=1, globalDaily=3, timeoutMs=120000 }`。

## 2. Schema v25

三张表（表数 58 → 61）：

| 表 | 用途 | 关键约束 |
| --- | --- | --- |
| `growth_reflections` | 一次反思的壳 | `UNIQUE(persona_id, trigger_key)`；状态 `evaluating/proposed/no_change/failed/skipped_budget`；`attempt`、`next_eligible_at` |
| `growth_candidates` | 候选 | `semantic_key` 只约束活动候选：`UNIQUE(persona_id, semantic_key) WHERE status='proposed'`；类型 `new_fact/revise_stance/new_habit/identity_growth` |
| `growth_candidate_sources` | 候选证据 | `(candidate_id, source_id)` 主键 + `independence_key` |

历史候选保留；同一语义只压活动提案，不覆盖历史。

## 3. 触发与水位

- 水位 = 最近一次 `proposed` / `no_change` 的 `finished_at`；
- 只处理 `origin IN ('user','external')` 且 `created_at > 水位` 的 Source；`self`（助手）一律排除；
- `trigger_key = sha256(personaId + 排序后的 sourceId 列表)`；
- 同键：`proposed/no_change` 直接返回既有结果；`failed/skipped_budget` 在 `next_eligible_at` 之后复用原行重试（`attempt+1`），不新建；
- 预算：按 UTC 自然日统计 `proposed/no_change`；`skipped_budget` 不消耗执行额度，写入 `next_eligible_at`（下一个 UTC 日界）。

## 4. 候选规则（v1）

只从 `artifact_revisions` 取：

- `artifact.kind='fact'` 且 revision 有本次新增证据 → `new_fact`；
- `artifact.kind='stance'` 且 `revision > 1` → `revise_stance`；
- 必须有至少一个本次新增、非助手的 Source 绑定到该 revision；仅「Artifact 已存在」不生成候选；
- `new_habit` / `identity_growth` 预留类型，v1 不生成。

## 5. Scope 与独立性

- 可见域：`private → contact:<sender_contact_id>`、`group → room:<room_id>`、`desktop/web/system → personal`；
- 候选 scope = 全部证据可见域交集：`personal` 不约束；`contact` 与 `room` 不同即冲突；
- 空交集 / 无法判定 → `no_change`（`reason=scope_conflict` 或 `scope_undecidable`），不提升 global；
- `external:<host>` 只作 provenance，不参与可见域；
- 独立性按 `sources.independence_key`（缺失回落 `activity_window_key`，再回落 `source:<id>`）归并；不同 `source_id` 不自动增加独立计数。

## 6. 崩溃恢复

- 每次运行先把 `evaluating` 且 `started_at < now - timeoutMs` 的行置 `failed`（`evaluation_timeout`）；
- 失败不推进水位；下一批新 Source 进入时重新计算；
- 事务使用单条 `BEGIN IMMEDIATE`（`db.transaction(..., { important: true })`），候选与反思状态同笔提交。

## 7. 测试

`test/growth-reflection.ts`：22 断言（无来源、fact 候选、重复触发、助手排除、同窗去重、跨群 scope 冲突、每日额度、evaluating 超时恢复）。

## 8. 已知边界

- `perContactDaily` 在 v1 按 persona 计（当前只有 `main` 一个对象）；多 Contact 细化留到 P5-3b 之后；
- 不做语义质量判定：rule-only v1 只保证「有新增证据 + 类型正确」，候选是否值得确认由 P5-3b/用户决定；
- Host 触发依赖 `agent/turn-stopping` 的真实顺序；无法证明时记 PARTIAL。
