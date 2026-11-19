# P5-1b 人格注入接线实施记录

- 状态：冻结（2026-11-14，外部问答 2/8 轮；实现后评审 1 轮）
- 依据：P5-1a 记录（`docs/design/p5-1a-persona-runtime-implementation.md`）与 P5-0 契约
- 范围：只做宿主接线与模块级验证；Host 场景单列 P5-1b-H
- 基线：`24bda02` / Schema v24 / 5212 断言 / 156 套 / 157 步

## 1. 接线

- 配置：`persona.enabled`（默认 true）、`persona.maxChars`（≤6000）、`persona.maxTokens`（≤3000）；非法值由 Host 配置校验拒绝，不静默截断。
- 注册：systemPrompt 服务可用时注册一次 `psyche-persona`（order 90）；effect cleanup 注销；`persona.enabled=false` 不注册。
- 读取：Provider 每轮用当前 `runtime.dataDir` 调 `readPersonaProjection`；dataDir 未解析时返回空串，ready 后自然生效。
- Agent 隔离：新增 `createPersonaAgentGate`，只有 RuntimeInputStore 存在可信绑定的 Agent 才注入；无绑定/其他 Profile 返回空串。
- 失败：Provider 任何异常收敛为空串，不阻断 Prompt Assembly。

## 2. 外部评审约束（已落实）

1. 上限只能收紧（zod max 6000/3000），非法配置失败关闭。
2. 共享注册点必须按 Agent 绑定过滤；热重载先 dispose 再注册，单测断言单注册、无残留。
3. 探针 Adapter 只证明隔离 Host 输入；真实 Provider 最终输入与 soul-md 冲突仍单独记 PARTIAL。

## 3. 验收

- 模块：`persona-runtime` 41 断言 0 失败；全量 exit 0。
- Host：**NOT VERIFIED**。fixture 已起，但无工作区无法创建会话；P5-1b-H 用脚本创建 Agent/Session 补齐。
- 不得标记 P5-1b 整体 PASS。
