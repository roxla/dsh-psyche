# P5-R-3 分层删除与物理擦除设计（DRAFT，待评审）

> 状态：FROZEN（2026-11-15，GPT 3 轮评审，见 §11）。本文只冻结设计与验收，不改 Schema、不改源码。
> 背景：P5-6 外部来源删除当前只有逻辑过滤，`sources.content` 原文仍在；P5-6 冻结稿「删除后脱敏为占位」因 `sources` append-only 触发器无法直接 UPDATE，尚未完全满足。用户已选「方案 3：分层删除」。

## 1. 目标

1. 默认逻辑删除：立即阻断召回与投影，保留审计关联。
2. Owner 显式物理擦除：清理主库中指定 Source 的原文，不删除 Source 身份与审计事件。
3. 备份独立治理：明确哪些备份可能仍含原文，不宣称主库擦除等于全部副本销毁。
4. SQLite 安全处理：覆盖 WAL、FTS、空闲页、旧页、文件系统残留与恢复过程，不把 `UPDATE sources SET content=''` 当成彻底擦除。
5. 失败关闭：擦除失败不得恢复召回权限，保留失败记录与可重试状态。

## 2. 非目标

- 本轮不改 Schema、不写实现代码、不跑擦除。
- 不承诺物理介质/备份/快照层面的不可恢复性。
- 不改变 P5-6 的 source 身份、审计事件、artifact/evidence 关系。
- 不引入第三方擦除库或数据库加密（另立议题）。

## 3. 删除状态机

事件 append-only，当前态按自增 event_id 取最新；状态不原地改。R-3a 新增独立表 `external_source_erase_events(erase_event_id INTEGER PRIMARY KEY, source_id, action, stage, error_code, at, by, proof_digest)`，action 取 `erase_request|erase_started|erase_failed|erased`；现有 `external_source_deletion_events` 的 `delete|purge` 保持删除阶段语义，不复用 `reason` 伪装状态机。

```
active
  --(owner logical_delete)--> logical_deleted
  --(owner erase_request)--> erase_pending
  --(erase success)--> erased
  --(erase failure)--> erase_failed --(owner retry)--> erase_pending
```

约束：

- `logical_delete` 幂等；重复只返回当前态。
- `erase_request` 只允许从 `logical_deleted` 进入，必须先逻辑下线。
- `erase_pending` 不允许召回；失败进 `erase_failed`，仍不可召回。
- `erased` 为终态；同 Source 再次 erase 幂等返回。
- 状态事件与 Source 身份分离：Source 行保留，审计链不断。

## 4. 逻辑删除（默认）

- 立即生效于：FTS/LIKE、recall/listHeads、final-check、Growth 投影、工具读取、任何未来外部注入层。
- 保留：Source 身份、来源元数据（不含正文）、Evidence 关联、删除事件与操作者。
- 不宣称原文已擦除；面板/CLI 必须显示「逻辑下线，主库原文仍在」。
- 备份不受逻辑删除影响（见 §6）。

## 5. 物理擦除（Owner 显式）

- 授权：Windows SID / POSIX UID 必须匹配配置的 Owner；CLI 二次确认需手工输入 `source_id`，不接受 `--yes` 单独授权。
- 范围：只处理指定 Source 的主库原文字段；不删 Source 行、不删 Evidence、不删审计事件。
- 主库处理步骤（同一独占锁内）：
  1. 校验状态为 `logical_deleted`，否则拒绝。
  2. 写 `erase_pending` 事件。
  3. 受控绕过 append-only：Owner 维护进程独占连接；事务内记录 `sqlite_master` 中 `sources` 三支触发器的 DDL 哈希 → `DROP TRIGGER` → `UPDATE` 正文为占位并记录 `content_sha256` → 原样重建触发器 → 校验 DDL 哈希一致；任一步失败整体回滚，触发器保持原样；擦除结束必须验证触发器仍在，否则不得记录 `erased`。
  4. `PRAGMA wal_checkpoint(TRUNCATE)`，确保 WAL 不保留旧页。
  5. `VACUUM` 重建主库文件，降低旧页/空闲页残留；执行前后记录文件大小与页统计。
  6. 再次 `PRAGMA wal_checkpoint(TRUNCATE)`（VACUUM 自身会产生新的 WAL），任一次 BUSY 退避重试上限 5 次；第二次失败记 `erase_failed(stage='post_vacuum_checkpoint')`。
  7. 验证：正文读回为占位、FTS/recall 不可见、审计事件仍可查、WAL 文件为 0 或仅当前事务。
  8. 写 `erased` 事件（含验证结果摘要 `proof_digest`）。
- 失败：任一步失败写 `erase_failed`（错误码、阶段、时间），保持不可召回，允许 Owner 重试。
- 边界：`VACUUM` 后的文件系统残留、SSD 磨损均衡、快照、备份副本不在本设计保证范围；不得对外宣称「已彻底销毁」。

## 6. SQLite 安全处理

- WAL：擦除事务提交后 `wal_checkpoint(TRUNCATE)`；验证 WAL 文件归零或仅剩当前事务。
- 空闲页/旧页：`secure_delete=ON` + `VACUUM`；报告必须写明「主库文件内旧页已尽量覆盖，但不保证物理介质」。
- FTS：R-3a 必须维护 FTS 表清单（`fts_index` 及影子表）。擦除时按 rowid 删除命中行并重建索引段；执行 `INSERT INTO fts_index(fts_index) VALUES('integrity-check')`；再对原文按配置 tokenizer（unicode61/trigram）分词逐 token 查询，确认删除 Source 的 doc 不再命中；同时验证 Recall 与直接索引读取拿不到正文。发现未登记的正文副本 → `erase_failed(stage='unregistered_copy')`。
- 擦除对象清单：可擦除 = `sources.content` + 任何已登记的外部正文副本表；不可擦除 = Source 身份、channel、时间、哈希、审计事件、artifact/revision/evidence。仅覆盖 `sources.content` 时不得宣称「整个主库原文已擦除」。
- 临时文件/日志：擦除过程不得把原文写入普通日志、面板、审计输出；只记录哈希与长度。
- 恢复/迁移：擦除后的库仍可正常 migrate、备份、恢复；恢复旧备份会带回原文，必须明确告知。
- 失败关闭：擦除失败不得回滚到可召回；只能保持逻辑下线并重试。

## 7. 备份治理

- 维护备份清单：路径/时间/大小/是否可能含被擦除 Source（按擦除时间与备份时间判断）。
- 主库擦除不传播到备份；不得宣称备份已擦除。
- 备份保留期由 Owner 决定；到期删除走独立维护流程，不在本设计自动执行。
- 面板/CLI 显示「主库已擦除；备份可能仍含原文」的明确文案。

## 8. 契约修订（P5-6）

- 原 P5-6 要求「删除后将 `sources.content` 脱敏为占位」；因 `sources` append-only，当前实现未满足。
- 修订为：默认逻辑下线（不改正文）；Owner 显式物理擦除才把主库正文替换为占位。两者是不同操作，验收分别记录。
- P5-6 报告与 DEV 中「删除只逻辑下线」保留为历史事实；新契约以本文为准，P5-6 状态改为「逻辑删除 PASS / 物理擦除按 P5-R-3 设计」。

## 9. 验收标准

1. 状态机：各转移、幂等、非法转移拒绝、终态幂等。
2. 逻辑删除：召回/FTS/final-check/Growth/工具均不可见；审计事件与 Evidence 仍在。
3. 物理擦除：SID/UID + 二次确认；擦除后正文读回占位、`content_sha256` 记录、审计事件仍在、FTS/recall 不可见。
4. SQLite：擦除前后 `secure_delete`、WAL checkpoint、VACUUM、文件大小/页统计；失败注入（VACUUM 失败/磁盘满）→ `erase_failed` 且仍不可召回。
5. 备份：备份清单记录与「备份可能仍含原文」文案；备份 URL/路径不写入普通日志。
6. 失败关闭：擦除失败不恢复召回权限；重试成功后才进 `erased`。
7. 契约：P5-6 原文修订记录、报告/DEV 状态一致。

## 10. 范围与后续

- 本轮只冻结设计；实现另立 P5-R-3a（Schema/事件表）与 P5-R-3b（CLI/擦除执行），需用户确认后再动 Schema。
- 真实多 Contact Host 验收仍为 PARTIAL（P5-R-2 遗留），与本文独立。
- 未决项：是否需要备份清单表（新 Schema）；是否引入 `PRAGMA secure_delete` 持久化配置；是否需要擦除证明文件（哈希+时间戳）导出。

## 11. 冻结记录（2026-11-15，GPT 3 轮）

- 第 1 轮「改」四项：状态机须独立持久化（不能复用 delete|purge 或 reason）；append-only 触发器须有受控绕过并保证擦除后恢复；擦除范围须覆盖 FTS/其他正文副本；跨事务维护须定义崩溃恢复与重试。
- 第 2 轮「改」两项：FTS 验证不能只靠原文哈希，须重建/完整性检查/分词查询；`VACUUM` 后须再次 `wal_checkpoint(TRUNCATE)` 并验证。
- 第 3 轮接受后 GPT 回「**冻结**」。
- 冻结结论：本设计作为 P5-R-3 的唯一契约；R-3a 新增 `external_source_erase_events`（Schema v30）与受控维护流程，R-3b 实现 CLI/擦除；在 R-3a/R-3b 完成前，P5-6 状态保持「逻辑删除 PASS / 物理擦除按 R-3 设计」，不得标记物理擦除 PASS。
- 失效触发：若实现阶段需要改变状态机、擦除范围或 SQLite 处理顺序，必须重开本议题，不得静默修改契约。
