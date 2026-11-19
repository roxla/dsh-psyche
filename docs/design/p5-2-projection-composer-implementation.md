# P5-2 投影组合器实施记录（P5-2a）

状态：P5-2a 模块级已实现；P5-2b 生命周期与单 Context 接入未开始。
契约来源：`docs/design/p5-projection-composition.md` + P5-2 与外部评审 5 轮问答（冻结于第 5 轮）。

## 1. 冻结口径

- 6000 token / 8000 字符是**投影预算**，不包含 Recall 正文；Recall 保留自己的独立上限。
- 必需层：隐私/Scope 纪律 + 完整人格，均不截断。
- 人格放不下时整块省略，只保留纪律；其余可选块全部省略（隐私优先）。
- 可选块保留优先级：Growth > Mood > Relationship；丢弃顺序相反。
- 序列化顺序：memoryDiscipline → persona → growth → mood → relationship。
- token 只作估算（CJK 1 字 ≈ 1 token × 1.2），不宣称精确上限；只按实际序列化内容计量。
- 成长只读 `Core.getGrowth()` 持久化阶段，不使用 `deriveGrowthNow()` 预测；首片 ≤120 字、无 bottleneck/闸门/证据。
- P5-2b：`projection.enabled` 只在 apply 时读取一次；true 只注册 `psyche-projections`（order 60），false 只注册 legacy 四件套；切换模式=插件重载。
- 卸载：先 `disposed=true`，回调立即返回空串；`active` 计数归零后才允许新注册；Host 异步迟到不可证时 Host 验收记 PARTIAL。

## 2. 模块

`src/lib/projection-composer.ts`（纯函数，无 I/O）：

- 常量 `PROJECTION_POLICY_VERSION='projection-v1'`、`PROJECTION_MAX_TOKENS=6000`、`PROJECTION_MAX_CHARS=8000`。
- 类型 `ProjectionBlockName`、`ProjectionBlock{text,enabled?}`、`ProjectionInput`、`ProjectionBudget`、`ProjectionResult{text,kept,dropped,usedTokens,usedChars,policyVersion,warnings}`。
- `composeProjections(input, budget?)`：必需层判定 → 可选层按 Growth→Mood→Relationship 累加 → 超限整块丢弃 → 按序列化顺序拼接；输出 kept/dropped 均按契约顺序排列。

## 3. 测试

`test/projection-composer.ts` 10 断言：

| 编号 | 覆盖 |
| --- | --- |
| P1 | 序列化顺序 |
| P2 | 全块容纳、无告警、预算计量 |
| P3 | 超字符预算先丢 relationship |
| P4 | 更紧预算按 relationship→mood→growth 全丢 |
| P5 | 必需层超限时人格整块省略、纪律保留 |
| P6 | 人格关闭只丢人格 |
| P7 | 空可选块 dropped 去重 |
| P8 | token 估算与纪律缺失告警 |
| P9 | 默认预算常量 |
| P10 | 不修改输入块 |

跑法：`npm run build && node test/projection-composer.ts`。

## 4. 未完成

- P5-2b：`ProjectionController`、单 Context 注册、启动模式互斥、legacy 回退、卸载/异步交错测试。
- Host 验收：隔离宿主需可创建工作区/会话，当前 fixture 无入口。
- 全量回归与文档/提交随本记录进行。

## 5. 边界

- 本模块不读库、不注册 Context、不写日志、无缓存。
- 不改变 Recall 注入、Mood/Relationship 既有 Context、人格注入开关。
- 预算内不含 Recall 正文；报告不得宣称全局硬上限已实现。
