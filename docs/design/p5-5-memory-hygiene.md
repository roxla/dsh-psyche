# P5-5 记忆整理：设计记录

> 状态：实现与验收记录；冻结依据 `docs/design/p5-growth-reflection-contract.md`、`docs/design/p5-0-freeze.md` §7 与 2026-11-15 GPT 两轮评审。
> 范围：只做「整理/归档建议 + 可审计操作」，不改 `identity.md`、不自动删除证据、不引入模型判断。

## 1. 目标

- 识别同一结论的重复行（确定性规则），允许 Owner 把 duplicate 合并到 canonical。
- 允许归档低价值旧结论，并从默认召回中排除；可恢复。
- 所有写操作 append-only、可审计、幂等；默认预览，Owner 确认后才写。

## 2. Schema v27

迁移 `V27_MEMORY_HYGIENE` 新增两张 append-only 事件表：

| 表 | 关键列 | 作用 |
| --- | --- | --- |
| `memory_merge_events` | `event_id`、`canonical_id`、`duplicate_id`、`action`(merge/unmerge)、`at`、`by`、`reason` | 合并关系账本；当前关系由最新事件决定 |
| `memory_archive_events` | `event_id`、`artifact_id`、`action`(archive/restore)、`at`、`by`、`reason` | 归档状态账本；不删除 Artifact/Revision/Evidence |

两个索引覆盖 `duplicate_id`/`artifact_id` 查询；`SCHEMA_VERSION=27`、`EXPECTED_TABLE_COUNT=64`。

状态不物化：`latestMergeAction` / `latestArchiveAction` 以 `event_id`（自增主键）排序取当前态；`at` 只是展示字段。

## 3. 合并规则（`mergeArtifacts`）

- `by` 必须是 `os:<SID/UID>`；CLI 与 Core 双重校验。
- 仅允许：duplicate 当前未合并、canonical 不是任意活动 duplicate、不是自合并、不构成链式（`E_MERGE_CHAIN`）。
- 可见域必须完全相等：由双方最新 revision 的 evidence 推导 `personal` / `contact:<id>` / `room:<id>` 集合；不相同或无法判定拒绝（`E_SCOPE_MISMATCH`）。
- disclosure 必须相同（public/restricted/secret 不跨级合并）。
- 只写 `merge` 事件；不搬证据、不改 revision、不改 Artifact 状态。
- `unmergeArtifacts` 追加 `unmerge`；幂等：已合并再 merge / 未合并再 unmerge 直接返回当前态。
- 操作在 `BEGIN IMMEDIATE` 内复核当前态，避免并发把同一 duplicate 指向两个 canonical。

## 4. 归档规则（`archiveArtifact` / `restoreArtifact`）

- 归档只写 archive 事件；默认召回过滤掉。
- canonical 被归档时：不自动恢复 duplicate，不转移 Evidence；duplicate 仍按自己的状态处理。
- `restore` 反向恢复；不重写历史、不删除证据。
- 显式查看归档记录仍走 Scope/Disclosure，不绕过授权。

## 5. 召回统一过滤

`andMemoryActive(alias)` 生成同一谓词：

```sql
NOT EXISTS (SELECT 1 FROM memory_archive_events e
  WHERE e.artifact_id = <alias>.artifact_id
    AND e.event_id = (SELECT MAX(event_id) FROM memory_archive_events WHERE artifact_id = <alias>.artifact_id)
    AND e.action = 'archive')
AND NOT EXISTS (SELECT 1 FROM memory_merge_events m
  WHERE m.duplicate_id = <alias>.artifact_id
    AND m.event_id = (SELECT MAX(event_id) FROM memory_merge_events WHERE duplicate_id = <alias>.artifact_id)
    AND m.action = 'merge')
```

已接入 `fts.ts` 的 `searchFts` / `searchLike`、`recall.ts` 的 `listHeads`；FTS、LIKE、listHeads 与统一 Recall 的可见集合保持一致。

## 6. 重复与陈旧建议（只读）

- `findDuplicateClusters`：按 `kind + 规范化 statement + 排序后的 subjectRefs` 分组；组内先比独立证据数、再比 `created_at`、`artifact_id`；每组第一个为 canonical 建议。
- `findStaleCandidates`：`updated_at` 早于 180 天、低 salience、独立证据 ≤1；排除 `stance`、`relationship` 与受保护认知（仅候选，不自动操作）。

## 7. CLI（Owner 入口）

`tools/psyche-memory.mjs`：

```
duplicates [--persona main]
stale
archived
merge --duplicate art_x --canonical art_y --owner <SID/UID> [--reason ...] [--yes]
unmerge --duplicate art_x --owner <SID/UID> [--yes]
archive --artifact art_x --owner <SID/UID> [--reason ...] [--yes]
restore --artifact art_x --owner <SID/UID> [--yes]
```

- Owner：Windows 解析 `whoami /user` 的 `S-1-5-…`；POSIX 用 `process.getuid()`；与 `--owner` 不一致即拒绝。
- 不带 `--yes` 只预览（内容、scope、disclosure、证据数、当前操作），不写库。
- 通过 `openDatabase` 打开，自动迁移到 v27。

## 8. 非目标

- 不自动合并/归档（Owner 显式确认）。
- 不删除 Artifact、Revision、Evidence、Source。
- 不改 `identity.md`、人格、权限、披露等级。
- 不引入模型判断或语义相似度；v1 只做确定性重复检测。

## 9. 验收口径

- 模块：`test/memory-hygiene.ts` 25 断言；`test/growth-reflection.ts` 22、`test/growth-confirmation.ts` 23 不回归。
- 全量：schema 断言统一到 v27/64/26 步；全绿。
- 边界：Host 侧未做真实 Owner 会话验收，记 NOT VERIFIED；CLI 与 Core 均以 `os:` 身份校验。
