# P3-A B3：语气投影语义冻结（B3-0）

- 版本：v1.0（2026-11-11）
- 状态：**B3-0 已冻结；B3-1 已实现（92 断言，全量 3387/111/0）；B3-2 模块级已实现（3450/113/0）；B3-3 真实宿主 ✅ PASS（接受多轮累积；33 维单轮不可翻档）**
- 上游：`docs/design/p3-a-mood-state-machine.md`（B0，§6 投影）；`docs/design/p3-a-b2-turn-judgment.md`（B2 输入与判定）
- 下游：B3-1 `packages/core/src/mood-projection.ts`；B3-2 `src/index.ts` SystemPrompt Context；B3-3 测试
- 基线：v27.59 / Git `609f948` / schema v19 / 3295 断言 / 110 步 / 0 失败；B3-1 落地 v27.60 / 3382 断言 / 111 步

---

## 0. 本稿解决什么

B0 §6 的投影公式与「一维一个投影标签」组合后存在一处语义反转：

| 维度 | baseline | 当前值 | B0 负向公式 strength | 现标签 | 结果 |
|---|---|---|---|---|---|
| fear | 7 | 0 | 1.00 | 谨慎 | 恐惧消失 → 更谨慎（错） |
| tired | 18 | 0 | 1.00 | 略疲惫 | 不疲惫 → 更疲惫（错） |
| happy | 30 | 0 | 1.00 | 轻快 | 不开心 → 更轻快（错） |

同时 B0 §6.3 只用 `blendGap` 判断辅助语气，**强度接近不等于语气兼容**（「黏一点 + 疏离」「低沉 + 雀跃」不能拼在一起）。

B3-0 只做两件事：修订正向/负向偏离的语义；补一份确定性的辅助语气兼容白名单。B3-1 起才写代码。

---

## 1. 定位与不变量

B3 是**纯投影层**，不是第二套 Mood Engine。

| 项 | 冻结 |
|---|---|
| 输入 | `loadMood()` 返回的 `values`（已按各维 `updated_at` 读时衰减） |
| 输出 | 少量稳定语气词：1 主 + 至多 1 辅 + 中性标记 |
| 计算 | 确定性纯函数；同输入同输出；无随机、无模型、无网络 |
| 数据库 | **只读**；不写 `global_mood_state` / `global_mood_history` / `mood_meta`；不新增表/列 |
| Prompt | B3-0/B3-1 不接 Prompt；B3-2 只接动态 Context，不改 `psyche-memory` Section |
| 事实/权限 | 不进入 Artifact / Evidence / FTS / Recall / Diary / Stance / Growth；不改身份、权限、是否主动联系 |
| 输出内容 | 不出现维度 key、数值、权重、候选列表、`reason` |

---

## 2. 偏离强度（修订 B0 §6.2）

### 2.1 v1 只投影正向偏离

对每一维：

```
若 value <= baseline：不进入候选（strength 不存在）
若 value >  baseline：strength = (value - baseline) / max(1, 100 - baseline)
```

- `strength` 落在 `[0, 1]`；不四舍五入，比较用 `1e-9` 容差。
- 维度数值语义是「该情绪自身的强度」，不是极性。低于 baseline 表示「这种情绪比平时少」，**不是**「相反情绪」。
- v1 不为任何维度自动反转标签。

### 2.2 为什么不保留负向分支

B0 §6.2 的负向式 `|value - baseline| / max(1, baseline)` 在 `value=0` 时恒为 `1.0`，与单一 `projection` 标签组合必然反转语义。删除不是「悄悄改公式」，而是明确本条修订；B0 原文保留作为历史，修订记录见 `docs/audit/p3-a-design-freeze.md` 的 B0-REV-4。

### 2.3 未来扩展（预留，不在 v1）

若要表达「不再疲惫」「比平常更轻松」，必须为具体维度显式增加 `belowProjection` 字段并逐项人工定义，**不得**由现有 `projection` 自动取反、不得批量套用。v1 不实现。

---

## 3. 候选、阈值与排序

### 3.1 候选

1. 对 33 维逐一算 `strength`（只有 `value > baseline` 才有）。
2. `strength < 0.15` → 丢弃；`strength >= 0.15` → 候选。
3. 每个候选携带 `{ key, projection, layer, strength }`。

### 3.2 标签去重

同一 `projection` 可能出现多次（`excited` 与 `flutter` 都是「雀跃」；`irritated` 与 `disappointed` 都是「克制」）。

- 按标签分组，只保留 `strength` 最大的那条；强度完全相等时按 §3.3 排序规则取前者。
- 去重发生在排序之前；之后不再输出重复标签。

### 3.3 排序（确定性）

1. 每个候选先算整数桶：`bucket = Math.round(strength * 1e9)`；按 `bucket` 降序。
2. 同桶（强度差落在同一 1e-9 刻度内）：层级 `basic > compound > contemporary`。
3. 仍相同：`key` 字典序升序。

层级**只用于同桶**，不得覆盖实际桶差。

**为什么用整数桶而不是二元容差**：`|a.strength - b.strength| <= 1e-9` 这类容差比较不满足传递性（a≈b、b≈c 但 a≉c），排序结果会依赖比较顺序与调用顺序，属于边界测试容易漏掉的确定性问题。整数桶把强度先量化成整数键，比较器在桶、层级、key 三段上都是全序，因此传递、反对称、自反；同输入必然同输出。strength 取值在 (0, 1)，`strength * 1e9 <= 1e9`，不超出安全整数范围。

---

## 4. 主语气与辅助语气

1. 候选为空 → 中性（§6）。
2. 主语气 = 排序后第一名。
3. 辅助语气需**同时**满足：
   - 存在第二名；
   - `primary.strength - second.strength < 0.10`（严格小于，`blendGap` 默认 0.10），并留 **1e-9 数值安全边界**：实现按 1e-9 粒度取整比较，要求 `gapNanos < 100000000 - 1`（`gapNanos = Math.round(gap * 1e9)`），等价于差值至少比 0.10 小 2e-9；
   - 两者标签对在 §5 兼容白名单内（无序对）。
4. 边界口径（已冻结，专测覆盖）：差 `0.099999998` 允许；差 `0.099999999` 不允许；差 `0.100000000` 不允许。安全边界的作用是：数学上恰好 0.10、但浮点减法得到 `0.09999999999999998` 的组合不被误放行。
5. 不满足任一条 → 只要主语气，`secondary=null`。
6. 永远最多 1 主 + 1 辅；不取第三名、不叠加多辅。

---

## 5. 辅助语气兼容白名单（冻结）

**默认不兼容**；只有下表列出的标签对允许融合（无序）。

| # | 对 | # | 对 |
|---|---|---|---|
| 1 | 轻快 ↔ 好奇 | 11 | 得意 ↔ 雀跃 |
| 2 | 轻快 ↔ 雀跃 | 12 | 致歉 ↔ 收敛 |
| 3 | 好奇 ↔ 专注 | 13 | 笨拙 ↔ 收敛 |
| 4 | 好奇 ↔ 惊讶 | 14 | 省电 ↔ 平淡 |
| 5 | 温柔 ↔ 安慰 | 15 | 懒散 ↔ 平淡 |
| 6 | 温柔 ↔ 怀旧 | 16 | 脆弱 ↔ 黏一点 |
| 7 | 委屈 ↔ 撒娇 | 17 | 犹豫 ↔ 试探 |
| 8 | 委屈 ↔ 黏一点 | 18 | 兴奋 ↔ 雀跃 |
| 9 | 沉默 ↔ 低缓 | 19 | 专注 ↔ 克制 |
| 10 | 低沉 ↔ 平淡 | | |

明确**不兼容**的例子（防止「两个最强维度直接拼」）：

- 黏一点 + 疏离
- 低沉 + 雀跃
- 克制 + 撒娇
- 温柔 + 试探
- 谨慎 + 兴奋

白名单是封闭集合：新增/删除任何一对都要提升 `MOOD_PROJECTION_VERSION` 并补测试。

---

## 6. 中性回退

以下情况一律返回中性：

- 没有候选（全部 `value <= baseline`，或全部 `strength < 0.15`）；
- 输入为空 / 维度缺失（缺省按 baseline 处理，不报错）；
- 调用方读取 Mood 失败（B3-2 捕获异常后也用中性，不阻塞回复）。

中性输出：`tone="平稳"`、`secondary=null`、`neutral=true`。

---

## 7. 输出结构与版本

```ts
export interface MoodProjection {
  tone: string
  secondary: string | null
  neutral: boolean
  projectionVersion: number
}

export const MOOD_PROJECTION_VERSION = 1
```

- `tone` / `secondary` 只放标签，不放维度 key、数值、强度。
- `projectionVersion` 独立于 `MOOD_CONFIG_VERSION` 与 `MOOD_RULES_VERSION`：改语气标签/白名单只升投影版本，**不触发** Mood 状态配置升级，不改数据库。
- `neutral=true` 时 `tone` 固定「平稳」，`secondary` 固定 `null`。

### 7.1 输入契约（B3-1 实现）

```ts
export function projectMoodTone(values: Record<string, number>): MoodProjection
```

- 只接受完整 33 维的 Mood 有效值；未知维度、缺少任一维、非有限数（`NaN` / `Infinity`）、越界（不在 0–100）一律抛 `E_VALIDATION`，**不静默转 0**，由调用方降级为中性。
- 不接收时间戳、不重算衰减：输入必须是 `loadMood()` 已衰减后的 `values`。
- 不接收 `initiator`、`configVersion`、`MOOD_RULES_VERSION`：投影只依赖当前有效值与冻结的投影规则。
- 纯函数：不读文件、不读库、不调模型、不依赖时钟与宿主环境；同输入同输出。

---

## 8. Prompt 文本与安全边界（B3-2 使用）

动态 Context 固定两行：

```
当前语气：{tone}。                      // 或：当前语气：{tone}，略带{secondary}。
语气只用于轻微调整措辞与表达节奏；不改变事实判断、任务目标、安全边界、
身份定义、记忆写入权限或是否主动联系的决策；不声称拥有真实的人类情感，
不诱导、操控或施压。
```

- 只注册一个 `Context`（建议名 `psyche-mood-tone`），不修改 `psyche-memory` Section，不写 system 规则。
- 关系色彩标签只渲染为措辞倾向，不生成行为指令：

| 标签 | 允许的表达倾向 | 禁止 |
|---|---|---|
| 黏一点 | 句子更短、措辞更靠近对方 | 要求对方回应、追问行踪 |
| 试探 | 表达留有余地 | 设陷阱、逼问、反讽施压 |
| 撒娇 | 语气放软、带一点请求感 | 命令式索取、情绪勒索 |
| 温柔 | 语速放缓、用词更软 | 承诺关系、越界亲密 |
| 怀旧 | 提及旧事时更留白 | 编造共同经历 |

- 出现任何标签都不得新增：工具调用、记忆写入、权限判断、主动联系理由、身份/关系声明。

---

## 9. B3 v1 不做

- 不做负向投影 / `belowProjection`。
- 不做第三名、多辅助、跨轮平滑、随机扰动。
- 不写库、不写 History、不碰 `mood_meta`。
- 不接 Prompt（B3-2）、不做面板（B4）、不做关系账本（P3-B）。
- 不新增写工具；如后续需要只读工具，另立提案。

---

## 10. 测试矩阵（B3-3）

| 组 | 断言 |
|---|---|
| 阈值 | 0.149 排除 / 0.150 纳入 / 0.151 纳入；等于 baseline 排除；低于 baseline 排除 |
| 语义 | fear=0、tired=0、happy=0 均不产生「谨慎/略疲惫/轻快」 |
| 排序 | strength 降序；平手按层级；同层按 key 字典序；层级不覆盖强度差 |
| 融合边界 | 差 0.099 允许（且白名单内）；差 0.100 不允许；差 >0.10 不允许 |
| 白名单 | 允许对（轻快+好奇）出辅；禁止对（黏一点+疏离）不出辅；未知对默认不出辅 |
| 去重 | excited + flutter 只保留最强一条；不输出两个「雀跃」 |
| 上限 | 任何输入最多 1 主 1 辅；不取第三名 |
| 输出 | 不含维度 key、数值、强度、权重；`projectionVersion` 固定 |
| 确定性 | 同输入连续两次结果完全相同 |
| 极值 | value=100 与 99 只影响是否入选，不改变词的选择规则；不加长文本 |
| 只读 | 投影前后 `global_mood_state` / `global_mood_history` / `mood_meta` 行数与内容不变 |

**实施状态（2026-11-11，v27.60）**：`test/mood-projection.ts` **92 断言**全部通过，覆盖上表全部 11 组并额外覆盖 19 对白名单双向 38 条、去重后第二名参与、第二候选不兼容不补位、同强度平手、多次执行完全一致、9 类非法输入抛 `E_VALIDATION`，以及复核加固（整数桶排序、blendGap 0.099999998/0.099999999/0.100000000 边界）。全量 **3387 / 111 步 / 0 失败**；投影前后数据库文件与三张表内容不变由纯函数边界与专测「不依赖数据库」保证。

---

## 12. B3-2 实施状态（2026-11-11，v27.61）

- 注册：`systemPrompt.context()`，唯一名 `psyche-mood-tone`，`order=100`，独立 disposer；`psyche-memory` Section 不动。
- Provider：同步；`runtime.db` 不可用 → 「平稳」；否则 `loadMood(db)` → `projectMoodTone` → 两行文本；读取/投影异常 → 中性 + 诊断，不阻断回复。
- 总开关：`mood.enabled` 同时控制 B2 更新与 B3 注入；关闭保留库中状态、重开按时间衰减。
- 测试：`test/mood-tone.ts` 35 + `test/mood-tone-wiring.ts` 28；全量 **3450 / 113 步 / 0 失败**。
- 未验证：真实宿主两轮、服务卸载/重注入、多 Context 并存（B3-3，见 `docs/audit/p3-a-b3-prompt-context.md` §4）。

## 12.1 B3-3 真实宿主验收（2026-11-11，v27.62）

- 报告：`docs/audit/p3-a-b3-3-host-acceptance.md`；本阶段无代码/测试改动，基线仍 3450/113/0。
- 六组：注册/生命周期 ✅、真实两轮 ✅（修订契约：接受多轮累积）、Context 共存 ✅、总开关 ✅、故障降级 ✅、只读/Section 隔离 ✅。
- 原 PARTIAL 保留：第②组原始判据「第二轮立即出现语气」不成立；根因是 `happy` 阈值需 ≥40.5（+10.5）、单轮规则上限约 +6.2，`calm` 需 +8.25 > `maxDelta` 8。
- 2026-11-12 拍板：接受多轮累积，不改阈值/`blendGap`/`maxDelta`/白名单，不加弱信号通道；口径改为「每次装配读取最新有效 Mood，低于阈值保持中性，累积跨阈值后在后续装配体现语气」。
- 全维度审计：`Δmin = 0.15 × max(1, 100−baseline)` 在 33 维全部 > `maxDelta=8`（最小 `calm` 8.25），从 baseline 出发单轮不可能翻档；已高于 baseline 的状态只差剩余阈值。

---

## 11. 版本与文档同步

- 本稿冻结 B0 §6.2 / §6.3 的语义；B0 原文不改写，修订记录追加 B0-REV-4。
- B3-1 落地时：新增 `packages/core/src/mood-projection.ts`、`test/mood-projection.ts`，core `index.ts` re-export；DEV 升 v27.60 并补条目与版本表行；HANDOFF 进度改 B3-1。
- B3-2 落地时单独升一版，只接线、不改投影规则。
