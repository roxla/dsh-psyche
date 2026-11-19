# P2-FTS5 E0：E 阶段实现冻结

- 日期：2026-11-06
- 依据：`p2-fts5-a2b-freeze.md`（v1.4）、`p2-fts5-d-evalset.md`（v1.2）、D4-B 基线、`p2-fts5-d5-summary.md`（D5.4）
- 状态：冻结。实现从 E1 开始，按 E1→E2→E3→E4→E5 推进。

## 1. 边界

| 事项 | 决定 |
|---|---|
| FTS5 生产实现 | GO |
| 真实证据集人工试标 | NO-GO（存量：heads=2、n≥2=0，等数据积累） |
| 生产证据加成 λ | 暂不启用（固定 0） |
| 自定义 BM25 变体（b/k1） | 暂不启用；生产用 SQLite 原生 `bm25()` |
| 索引范围 | 只索引当前 head Artifact；历史 revision 不进；Event 第一版不进 |
| 分词 | 中文 bigram、英文/数字整词小写，**按原文顺序交织** |
| 查询模式 | 单字 `like`；多片段 `and`（片段内 phrase、片段间 AND）；无空白 `phrase` |
| 评分 | `-bm25(fts_index, 0.0, 0.0, 1.0, 0.0)`；同分 `ref_id ASC` |
| 过滤 | head / state 在 SQL 里硬过滤，与评分器解耦 |
| 写入 | 与 Artifact revision 同一事务；失败整笔回滚，operations 另开事务记 failed |
| 维护 | `rebuildFtsIndex` 原子重建；`verifyFtsIndex` 四类差异 + FTS5 `integrity-check` |

## 2. 已知缺口（不在 E1/E2 假装实现）

1. **披露过滤（disclosure）**：生产 schema 没有 `artifact_revisions.disclosure` 字段；D3 评测里的 `disclosure` 是 fixture 字段。E3 需要先做 v6 迁移（或明确「披露等级暂由 payload/来源推导」），再谈过滤。当前不实现、不声称。
2. **Injection Disclosure Leakage / Stale Injection Rate**：需要 Composer 注入层观测，留 E5。
3. **恢复后一致性校验**：`verifyFtsIndex` 已可用，但尚未接进 boot/恢复流程，属 E4。
4. **`deleteFtsRow`**：保留为工具函数；当前「忘记/撤回」走的是 revision 状态变更（review rejected → forgotten/retracted），不物理删索引行，查询侧过滤。

## 3. 验收门槛（E5）

- 用 D3.5 冻结集（160 查询 / 960 文档）在生产实现上跑一遍，与 D4-B 对照：
  - 160 条全部执行；Recall@8、MRR、NDCG@8 记录与参考实现的差异；
  - Stale=0、Duplicate=0、Candidate Disclosure Leakage=0（披露字段可用后）；
  - 八类分别输出；Q011（bigram 交织）必须通过；AND 单字片段规则、类 6 两条过滤路径、类 7/8 分别通过。
- 任何差异必须能解释（同分规则、写入时机、索引内容变化）；不能把差异直接说成性能提升。
