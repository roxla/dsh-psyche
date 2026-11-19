# P5-R-2 Schema v29 冻结记录：成长反思稳定水位与每 Contact 配额

> 状态：已冻结（2026-11-15，GPT 外部评审 4 轮，用户确认开工）。
> 范围：只改 Core 反思调度与 Schema v29；不新增功能，不接真实 Provider。

## 背景

`packages/core/src/growth-reflection.ts` 原实现有两处与冻结契约不符：

1. 水位用 `MAX(finished_at)` 时间比较，Source 的 `created_at` 乱序或与完成时间同刻时会漏处理或重复扫描；
2. `perContactDaily` 实际按 persona 全局 `usedToday` 计数，没有按 Contact/Room 分组。

P5-R-0 审计将这两项列为 Schema v29 阻塞项。

## 冻结决定

### 1. 逐条 Source 账本（替代时间水位）

新表：

```sql
CREATE TABLE growth_reflection_processed_sources (
  persona_id    TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  reflection_id TEXT,
  contact_key   TEXT,
  processed_at  TEXT NOT NULL,
  PRIMARY KEY (persona_id, source_id)
);
CREATE INDEX idx_growth_reflection_processed_contact
  ON growth_reflection_processed_sources(persona_id, contact_key, processed_at);
```

- 只有 `proposed` / `no_change` 终态在同一事务写入；`failed` / `skipped_budget` 不写，保留重试。
- 新 Source = `NOT EXISTS (SELECT 1 FROM growth_reflection_processed_sources ...)`。
- 迁移 v29 把现有 sources 以 `reflection_id=NULL, contact_key=NULL` 回填为 legacy 基线，不回放历史；`countLegacyProcessedSources()` 用于迁移测试核对数量。
- Revision 查询同步移除 `r.created_at > watermark`，只保留「Evidence 的 source_id ∈ 本批 Source」。

### 2. contact_key 与配额

- `private` → `contact:<sender_contact_id>`
- `group` → `room:<room_id>`
- `desktop` / `web` / `system` → `personal`
- 缺绑定 → `unbound`

配额：

- 每个 key 每天最多 1 个成功 reflection（按 processed 行 `DISTINCT reflection_id` 计）；
- 全局每天 3 个成功 reflection；
- 检查、领取、processed 写入全部在同一个 `BEGIN IMMEDIATE` 事务内；
- 超额的 key 本轮排除且不标 processed；
- `unbound` 不进入本批、不计配额、不写 processed，返回 `no_source` + `reason='unbound_identity'`。

### 3. 任务快照

- `growth_reflections` 增 `source_ids TEXT`（排序 JSON 数组），创建时写定，之后只读。
- `trigger_key` 始终对应原始 Source 集合；重试只筛选 `effectiveSourceIds` 求值，不改原集合与 key。
- `skipped_budget` 到期复用原行，只处理原集合；预算窗口内新增 Source 不并入旧任务。
- effective 中已被其他 reflection 处理的 Source 直接排除；空 effective → `no_change`（`sources_consumed`）。
- 失效/缺失 Source 不写 processed。
- 若存在同 trigger 或 Source 重叠的未完成 reflection：保留更早一行继续，另一行显式置 `failed`（`duplicate_task_conflict`），保留审计，不删除。

## 影响面

- Schema v28 → v29：新增 1 表、`growth_reflections` 新增 1 列，66 → 67 表，迁移 28 步。
- 新增回归：乱序 `created_at`、同 Contact 同日第二次跳过、跨 Contact 批次、全局 3 条、failed 不推进 processed、重开 DB 后重试绑定原集合、预算窗口新增 Source 不并入、部分 Source 已处理、失效 Source 不写 processed、legacy 不回放。
- 不改其他模块；`p5r-contract` / `growth-confirmation` / `mood-behavior` 等既有断言保持不变。

## 评审记录

- 第 1/8 轮：提案（账本表、配额、快照、迁移基线）；GPT「改」四项：事务化配额、彻底移除时间水位、skipped_budget 稳定身份、legacy/unbound 失败关闭。
- 第 2/8 轮：接受四项并细化；GPT「改」一项：skipped_budget 必须绑定原始 Source 集合。
- 第 3/8 轮：增 `source_ids` 快照、重试只用原集合；GPT「改」两项：快照不可变、冲突需显式处理。
- 第 4/8 轮：接受并落定；GPT「冻结」。
