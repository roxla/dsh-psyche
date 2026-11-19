# P5-2b 投影 Context 接入：实施记录（冻结口径）

- 状态：实现完成，模块级待验收；Host 组装验收待补。
- 契约来源：P5-2 GPT 问答第 1–5 轮（2026-11-15），第 5 轮冻结；P5-2a 第 6 轮冻结后进入本实现。
- 基线：`a4b1730`，DEV v28.10，Schema v24/58/36，全量 5234/157/158/0。

## 1. 冻结口径

1. 投影预算 6000 token / 8000 字符，不含 Recall 正文；Recall 保留独立上限，报告只称「投影预算」。
2. 必需层：隐私/Scope 纪律 + 完整人格，均不可截断；人格放不下时整块省略、只保留纪律，其余可选层全部丢弃。
3. 可选层保留顺序 Growth > Mood > Relationship；超预算按 Relationship → Mood → Growth 整块丢弃，不切半块。
4. 序列化顺序：discipline → persona → growth → mood → relationship。
5. 成长只读 `getGrowth()` 对应的持久化阶段（`phase_state`），不把 `deriveGrowthNow()` 的预测当确认；输出 ≤120 字，不含 bottleneck、闸门、证据。
6. 启动模式互斥：`projection.enabled=true` 只注册 `psyche-projections`（order 60），不再注册 `psyche-memory` Section、persona/mood/relationship Context；`false` 只注册 legacy 四件套。
7. 切换模式 = 插件重载，不提供运行时热切换；注册失败回退 legacy，不能留下部分迁移状态。
8. 卸载：先置 disposed，所有回调返回空串；只有 active===0 才允许新注册。Host 异步迟到回调无法证明时，Host 验收记 PARTIAL。

## 2. 实现

- `src/lib/projection-context.ts`：`ProjectionController`、`ProjectionContextSources`、`readPersistedGrowthLine()`。
- `src/index.ts`：`projection.enabled` 配置（默认 true）；统一模式组装五源；legacy 回退；cleanup 释放。
- 复用：`readPersonaProjection` + `createPersonaAgentGate`、`projectMoodTone` + `renderMoodToneText`、`createRelationshipContextProvider`、`composeProjections`。
- 不新增 Schema、不写库、不改 Recall。

## 3. 测试与 Host

- 模块测试 `test/projection-context.ts` 20 断言（A–E）。
- Host 必须证明：两种模式严格互斥、每轮 discipline 恰好一次、卸载后无迟到旧内容、注册失败回退 legacy、旧 Section/Context 不残留。
- Host 无法证明异步迟到边界时：模块级 PASS，Host 该子项 PARTIAL，整体不得标 PASS。

## 4. 未完成

- 真实 Host 组装证据（隔离 fixture 需可创建会话）。
- 全量回归计数回填、DEV/HANDOFF/README/AGENTS 同步。
