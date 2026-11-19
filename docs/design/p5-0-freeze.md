# P5-0 设计冻结索引

- 状态：P5-0 冻结稿（2026-11-14）
- 基线：`eb981d2` / DEV v28.06 / Schema v24 / 5183 断言 / 155 套 / 156 步 / 0
- 范围：只冻结设计与验收，不写代码、不迁移 Schema、不恢复 B-4-2

## 1. 文档

| 文档 | 内容 |
|---|---|
| `p5-persona-runtime-contract.md` | 人格权威来源、初始化准入、运行时投影、soul-md 共存、失败语义 |
| `p5-projection-composition.md` | 统一投影协调器、总预算、必需层与降级顺序 |
| `p5-growth-reflection-contract.md` | 成长定义、可修正/不可改变、成长投影、反思闭环与幂等 |
| `p5-mood-behavior-contract.md` | 三档行为策略、滞回、优先级与禁止项 |
| `p5-external-source-contract.md` | 外界来源分类、溯源、Prompt 隔离与 Scope |

## 2. 核心不变量

1. `identity.md` 是唯一人格内容来源；哈希一致才注入；不摘要、不截断。
2. 成长可以修正表现与认知，但不能根本改变人格；核心变更只能走 Owner 重新锁定。
3. 隐私/Scope 纪律与人格核心都不可裁剪；预算不足时省略人格，不牺牲隐私。
4. 所有 Psyche 投影由一个协调器统一测量与裁剪；保留优先级 Memory > Growth > Mood > Relationship。
5. 成长投影只含已确认内容，不注入 bottleneck，不把阶段当权限。
6. 确认与展示分开授权；`confirmed` 不能跳过 Disclosure/Scope。
7. 反思候选必须有独立证据；模型输出不能证明自身；Trigger/Candidate 键持久幂等。
8. 心情只改变表达与主动性偏好，不改变事实、工具、权限与是否回应。
9. 外界信息只能作为证据/候选，不能进入可信人格指令层。
10. 验收分 A（Context 组装）/ B（隔离 Host + 探针）/ C（真实 Provider 与行为）三层，不互相替代。

## 3. 冻结检查清单

- [ ] 人格唯一来源与字符/token/哈希三重准入
- [ ] 统一投影协调器与总预算、必需层冲突处理
- [ ] 成长投影字段、长度、Scope 与 Disclosure 规则
- [ ] Mood 三档映射、滞回、版本化参数
- [ ] 反思触发预算、Trigger/Candidate 持久幂等、证据独立性
- [ ] 确认后成长经 Core 生效，不直接改人格
- [ ] A/B/C 三层验收矩阵与记录口径
- [ ] 专用 Profile 与 soul-md 共存配方
- [ ] 外界信息来源分类与 Prompt 隔离

## 4. 执行顺序

1. **P5-1** 人格运行时生效（完整 `identity.md`、哈希校验、专用 Profile、预算协调与 Host 验收）
2. **P5-2** 成长只读投影
3. **P5-4** 心情行为化
4. **P5-3a** 反思候选生产（只生成、不生效）
5. **P5-3b** 确认与成长生效
6. **P5-5** 记忆整理与淡忘
7. **P5-6** 外界信息来源与学习

## 5. 当前边界

- B-4-2 暂停；B-4-1 `eb981d2` 保留。
- B-3-3 H05/H10b、B-5-3 功能与 Host 鉴权继续 PARTIAL，不混入 P5。
- P4-D 群回复保持关闭；H-2 独立推进，不作为 P5-1 前置。
- 本阶段提交只包含设计文档，不改代码与测试。

## 6. v1.1 冻结记录（2026-11-14，外部评审 3 轮收敛）

- 过程：第 1 轮提案 → 第 2 轮逐项回应 → 第 3 轮对方「冻结」；未超过 5 轮上限。
- **V1 人格**：6000 字符 / 3000 token 双硬上限；初始化用保守估算（CJK 1 字≈1 token，×1.2，标记 `estimated`）；运行时若 Host 提供 tokenizer 则精确计数，否则沿用估算；计数异常 → 不注入、状态 `unavailable`、聊天继续、不部分注入；P5-1 验收记录 `estimated`，不宣称精确 token 上界。
- **V2 投影**：总 Composer 延至 **P5-2**；P5-1 只新增 Persona Context、保留现有注入链；6000 token / 8000 字符作为目标，P5-1 只观测总量并告警，**不宣称强制达标**；原「总预算硬限制」验收移至 P5-2。
- **V3 成长**：同意，无改动。
- **V4 心情**：`strength=(v-baseline)/(100-baseline)` 截断 0..1；按 `mood-behavior-v1` 固定权重求加权和 `s`；`s<0.35` reserved、`0.35≤s≤0.65` balanced、`s>0.65` expressive；进入 0.35 / 退出 0.25（expressive 进入 0.65 / 退出 0.55），至少停留 1 Turn；按衰减后的有效 Mood 计算，Affect 只做加减修正；参数版本化。
- **P5-1 切片**：模块 `persona-runtime.ts`、`persona-context.ts`；接口 `readPersonaProjection()` 返回 `{status,text,hash,chars,tokens,estimated}`、`registerPersonaContext()` order=90；测试覆盖锁定、哈希漂移、超限、原文完整、单轮注入、卸载、Host 捕获、tokenizer 异常。
- **soul-md**：专用 Profile 移除冲突人格描述，仅保留通用规则；无法排除则告警并记 PARTIAL。
- 风险：保守估算不构成精确 token 上界；P5-1 仅观测总预算；人格异常必须失败关闭且不阻塞聊天；Mood 滞回需边界测试验证。
- 状态：**P5-0 v1.1 冻结**；下一步 **P5-1a**。

## 7. 外部评审全文落定（V1–V9）

| 编号 | 内容 | 阻塞 P5-1 |
|---|---|---|
| V1 | P5-1 只新增 Persona Context；总 Composer 属于 P5-2 | 是 |
| V2 | Persona 异常状态、告警、Owner 修复路径 | 是 |
| V3 | 字符/token 预算、估算标记、15% headroom、阶段性执行边界 | 是 |
| V4 | Psyche 专用 Profile 与 soul-md 冲突处理 | 是 |
| V5 | P5-2 投影快照与事实去重 | 否，P5-2 前冻结 |
| V6 | Mood 阈值、滞回、驻留规则 | 否，P5-4 前冻结 |
| V7 | 反思幂等、触发预算、确认入口及 Schema 评估 | 否，P5-3a 前冻结 |
| V8 | 来源准入、证据可信度与指令隔离 | 否，P5-6 前冻结 |
| V9 | 三层 Host 证据与固定行为评估 rubric | P5-1 需先冻结基本验收口径 |

附加原则：

- P5-1 未接统一协调器时，**不得宣称已强制保证所有 Psyche Context 的总预算**；总 Composer 的硬限制只在 P5-2 通过。
- “同一事实只注入一次”按 Artifact 身份、Revision 与投影类别去重，不能只做文本相同判断；人格原文不参与普通字符串去重。
- P5-2 一次组装固定快照：`personaHash + memoryRevision + growthVersion + moodStateVersion + relationshipStateVersion`（字段可按现有版本标识调整），目的是让一次模型输入对应一组可解释的读取状态，不新增事实源。
- Schema v25 不预设为必需：P5-3a 先审计现有 operations/Proposal/predicate payload 能否满足跨重启幂等、原子性与可审计，只有不足时才新增表或字段。
- 外界来源在准入侧就标记来源身份、权限、Scope 与证据性质；运行时不因外部内容授予新权限或改 Persona/Growth 核心定义（P5-6 实现，原则现已生效）。
- 执行顺序：P5-0 v1.1 → P5-1a（只读投影模块）→ P5-1b（Context 与隔离 Host 验收）→ P5-2 → P5-4 → P5-3a → P5-3b。
