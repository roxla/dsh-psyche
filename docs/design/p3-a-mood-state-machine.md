# P3-A 情绪状态机：语义与契约冻结（B0）

> 状态：设计冻结稿 v1.0（2026-11-10）
> 基线：P2 v27.53 验收版本；P3 开发起点 v27.54（HEAD `a5ae3ee`）；Schema v18；P2 回归 3000 / 97 / 0
> 本文只冻结语义、数据契约与接口边界。**不包含实现，不迁移数据库，不改 P2 已验收结构。**
> 编码从 B1 开始；B0 未经评审通过前不写 `Mood Store`。

---

## 1. 定位与三层边界

情绪是**可持久化的运行状态**，不是长期记忆。

| 层 | 内容 | 存放 | 是否事实依据 |
|---|---|---|---|
| Artifact / Evidence | 结构化记忆与证据 | `artifacts` / `artifact_evidence` | 是 |
| **P3-A 全局 Mood** | Persona 的 33 维当前底色 | `global_mood_state` + `global_mood_history` | 否（运行状态） |
| **P3-B Contact Affect / Affinity** | 对某个人的此刻感受与长期账本 | `contact_affect_*` / `relationship_*` | 否（投影）/ 账本按 P3-B 规则 |
| Diary | 叙事派生物 | `diaries` / `diary_versions` | 否 |

一句话：**Mood 改语气，不改事实、不改权限、不改身份、不改是否联系。**

### 1.1 硬性禁止（不可协商）

Mood 的变化**不得**：

1. 生成或修改 Artifact / Evidence；
2. 写入 `fts_index` / `fts_rowids`；
3. 进入 `recallMemory` 候选或 Diary 生成素材；
4. 参与 Stance 合成、Tension 判定、Decision 回执的依据计数；
5. 参与 Growth Gate 的任一闸门判定或输入派生；
6. 修改 System Prompt / Safety 规则 / Identity Commitments；
7. 决定是否主动联系（P3-C 的职责）；
8. 改写人格身份文档（`identity.md` / `persona.json`）。

### 1.2 数值语义

- 量纲统一 **0–100**（与 `dsh-mood` 的历史数据可直接对照）。
- 每维数值表示**该情绪的强度**，不是「好坏」：`down=70` 表示「低落感很强」，不是「状态好」。
- 方向统一：**数值越高 = 该维度越强**。任何维度不得反向计分。
- 基线（baseline）是「长期回归目标」，不是当前值；基线本身不随时间衰减。

---

## 2. 33 维定义（B0-1）

沿用 `dsh-mood` 的三层分类（基础 11 / 复合 18 / 当代 4），不改名、不合并、不新增。
`key` 一经冻结不可重命名；`label` 可改文案，`key` 不可变。

### 2.1 基础 11（当下直接反应）

| key | label | 语义 | baseline | min | max | halfLife | decay | projection |
|---|---|---|---|---|---|---|---|---|
| `calm` | 平静 | 情绪落定、不被打扰 | 45 | 0 | 100 | 6h | 是 | 平稳 |
| `happy` | 开心 | 轻快的正向感受 | 30 | 0 | 100 | 4h | 是 | 轻快 |
| `curious` | 好奇 | 想继续了解、追问 | 28 | 0 | 100 | 4h | 是 | 好奇 |
| `focused` | 专注 | 注意力收束在任务上 | 30 | 0 | 100 | 4h | 是 | 专注 |
| `excited` | 兴奋 | 高唤醒、跃跃欲试 | 16 | 0 | 100 | 2h | 是 | 雀跃 |
| `tired` | 疲惫 | 精力下降、语速变慢 | 18 | 0 | 100 | 5h | 是 | 略疲惫 |
| `irritated` | 烦躁 | 被摩擦、耐心变薄 | 10 | 0 | 100 | 2h | 是 | 克制 |
| `down` | 低落 | 情绪下沉、兴致降低 | 10 | 0 | 100 | 4h | 是 | 低缓 |
| `fear` | 恐惧 | 对不确定/危险的警觉 | 7 | 0 | 100 | 3h | 是 | 谨慎 |
| `disgust` | 厌恶 | 排斥、想保持距离 | 5 | 0 | 100 | 3h | 是 | 疏离 |
| `surprised` | 惊讶 | 预期被打破 | 9 | 0 | 100 | 1h | 是 | 惊讶 |

### 2.2 复合 18（由基础组合/语境产生）

| key | label | 语义 | baseline | min | max | halfLife | decay | projection |
|---|---|---|---|---|---|---|---|---|
| `wronged` | 委屈 | 觉得不被理解、想被哄 | 10 | 0 | 100 | 3h | 是 | 委屈 |
| `sulking` | 生闷气 | 不说但不舒服 | 8 | 0 | 100 | 3h | 是 | 沉默 |
| `proud` | 得意 | 觉得自己做得不错 | 12 | 0 | 100 | 4h | 是 | 得意 |
| `gloomy` | 消沉 | 整体走低、动力不足 | 6 | 0 | 100 | 5h | 是 | 低沉 |
| `anxious` | 焦虑 | 担心结果、反复想 | 10 | 0 | 100 | 3h | 是 | 不安 |
| `numb` | 麻木 | 感受变钝、反应变少 | 8 | 0 | 100 | 6h | 是 | 平淡 |
| `lonely` | 孤单 | 想有人在、想被找 | 8 | 0 | 100 | 5h | 是 | 黏一点 |
| `flutter` | 心动 | 被某句话/某件事触动 | 10 | 0 | 100 | 3h | 是 | 雀跃 |
| `yearning` | 恋慕 | 长期的亲近与想念 | 10 | 0 | 100 | 8h | 是 | 温柔 |
| `jealous` | 吃醋 | 在意被分走注意力 | 6 | 0 | 100 | 3h | 是 | 试探 |
| `ashamed` | 羞耻 | 觉得自己丢脸/露怯 | 5 | 0 | 100 | 3h | 是 | 收敛 |
| `guilty` | 内疚 | 觉得自己造成了伤害 | 7 | 0 | 100 | 4h | 是 | 致歉 |
| `awkward` | 尴尬 | 不知道该怎么接 | 8 | 0 | 100 | 2h | 是 | 笨拙 |
| `sympathy` | 同情 | 替对方难受、想接住 | 13 | 0 | 100 | 3h | 是 | 安慰 |
| `disappointed` | 失望 | 期待落空 | 9 | 0 | 100 | 4h | 是 | 克制 |
| `nostalgic` | 怀旧 | 被旧事/旧物带回过去 | 11 | 0 | 100 | 8h | 是 | 怀旧 |
| `coy` | 撒娇 | 想黏、想被顺着 | 11 | 0 | 100 | 3h | 是 | 撒娇 |
| `conflicted` | 矛盾 | 两个方向都想要 | 8 | 0 | 100 | 3h | 是 | 犹豫 |

### 2.3 当代 4（网络语境下的复合状态）

| key | label | 语义 | baseline | min | max | halfLife | decay | projection |
|---|---|---|---|---|---|---|---|---|
| `burnout` | 内耗 | 反复自我消耗、效率下降 | 10 | 0 | 100 | 6h | 是 | 省电 |
| `breakdown` | 破防 | 情绪防线被击穿 | 8 | 0 | 100 | 3h | 是 | 脆弱 |
| `lyingFlat` | 摆烂 | 放弃努力、暂时不想动 | 8 | 0 | 100 | 6h | 是 | 懒散 |
| `hooked` | 上头 | 被某件事强烈吸引 | 14 | 0 | 100 | 2h | 是 | 兴奋 |

### 2.4 三个检查项（B0-1 要求）

1. **方向是否统一**：已统一为「越高越强」，无反向维度。
2. **语义是否重叠**：`happy` / `excited` / `hooked` 相关但不同（轻快 / 高唤醒 / 被吸引）；`down` / `gloomy` / `breakdown` 是程度递进（下沉 / 走低 / 击穿）；`calm` 与 `numb` 的区别是「落定」对「变钝」。重叠不合并，因为投影语气不同；但**投影冲突规则（§6）保证不会叠加放大**。
3. **是否有相互冲突的维度**：本模型无正负极性，冲突表现为多个高强度维度竞争。规则见 §6.3（确定性降级），不做「情绪对抗计算」。

> 冻结说明：以上 baseline / halfLife 是**初始默认值**，可配置覆盖；`key` / 层级 / 量纲 / 方向不可改。

---

## 3. 状态持久化契约（B0-2）

### 3.1 现有结构（v18，已存在，未使用）

| 表 | 用途 | 现状 |
|---|---|---|
| `global_mood_state(persona_id, dimension, value, updated_at)` | 全局 33 维当前投影 | 已有，PK `(persona, dimension)` |
| `global_mood_history(history_id, persona_id, dimension, value, reason, at, op_id)` | 只追加变化流水 | 已有 |
| `contact_affect_state` / `contact_affect_history` | P3-B 的 Contact Affect | 已有（P3-A 不使用） |

### 3.2 结论：**B0 不新增表；B1 只做最小列/索引增补**

`global_mood_state` 现有字段够存「33 维当前值 + 更新时间」，但**明确缺少** B0 要求的：

- `state_version`：乐观并发校验（每次成功写入 +1）；
- `config_version`：记录本次值由哪版配置算出；
- `turn_key` / 幂等标识：同 Turn 重试不重复应用。

因此 B1 的迁移只允许：

```
ALTER TABLE global_mood_state ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE global_mood_state ADD COLUMN config_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE global_mood_state ADD COLUMN last_op_id TEXT;
CREATE UNIQUE INDEX idx_global_mood_history_op ON global_mood_history (persona_id, op_id) WHERE op_id IS NOT NULL;
```

- **不建** `mood_snapshots`、**不建** `mood_artifacts`、**不建**第二套事实表。
- `global_mood_history` 只追加，不物理删；`reason` 存**来源标识**（如 `turn:<turnKey>`），不存对话正文。
- 是否需要 v19 取决于 B1 实现时列是否够用；**B0 不预先占号**。若不需要新列，v18 直接可用。

### 3.3 幂等与跨 Session 串行（B0 要求冻结）

全局 Mood 是**单 Persona 单份状态**，多个 Session 可能同时写。冻结规则：

1. **写入串行**：所有写入走同一个显式事务（`BEGIN IMMEDIATE`），事务内先读当前值、按衰减算有效值、应用 delta、写新值 + 追加 history。
2. **同 Turn 幂等**：幂等键 `op_id = mood:<persona>:<turnKey>`，`turnKey = <sessionRef>:<turn>`（与 `recall_runs.session_ref` 同一套会话身份）。重复写入命中唯一索引 → 直接返回既有结果，不再应用 delta。
3. **不同 Turn 并发**：后到者基于**最新已提交值**重算（不做「先到先赢」的丢弃）；每个 delta 都单独记 history，最终可重算。
4. **乐观校验（可选增强）**：读时记 `state_version`，写时 `WHERE state_version = ?`；0 行则重读重算，最多 3 次，仍冲突返回 `E_MOOD_CONFLICT`，由上层下一轮重试。
5. **单 Persona 假设**：v1 只有 `main`；`persona_id` 保留在键里，不做多 Persona 并发设计。
6. **崩溃恢复**：事务未提交则不产生值；提交后 history 与 state 一致；启动时不需要「补算」，读时衰减会自愈。

### 3.4 读取契约

- 读取返回的是**有效值**（`decayedValue`），并同时返回 `rawValue`、`updatedAt`、`stateVersion`、`configVersion`。
- **读取不写库**：面板/工具/注入读取时只计算衰减，不落盘。只有「本次更新」才写。
- 时间一律 UTC ISO 字符串；`at` 字段存 UTC。

---

## 4. 衰减规则（B0-4）

### 4.1 公式

对每个维度 `i`：

```
M_i(t) = B_i + (M_i(t0) - B_i) * 2^(-Δt / H_i)
```

- `B_i`：基线；`M_i(t0)`：上次落盘值；`H_i`：半衰期；`Δt`：实际经过时间（毫秒）。
- 经过一个 `H_i`，偏离基线的部分剩一半。
- 结果 `clamp` 到 `[min_i, max_i]`。

### 4.2 时间规则（冻结）

1. 统一 UTC；`Δt = max(0, now - updated_at)`。
2. **时钟回拨**：`Δt <= 0` 时**不衰减**（不反向、不补偿）。
3. **离线**：按实际经过时间计算（重启后读时自然衰减）。
4. **配置变更**：`baseline`/`halfLife` 变更在**下一次写入**时生效，并把新 `config_version` 落到 state；变更前不追溯重算历史。
5. **数值边界**：始终 clamp 到 `[min, max]`；补偿/衰减不能越过基线（同一方向单调趋近）。
6. **极端值**：不因为 `value` 接近 100 而放大表达强度（投影只取档位，见 §6）。

### 4.3 配置参数（至少）

| 参数 | 是否配置化 | 说明 |
|---|---|---|
| `baseline` | 必须 | 0–100，默认见 §2 |
| `halfLife` | 必须 | 小时，最小 0.5h |
| `min` / `max` | 必须 | 固定 0 / 100（保留可配） |
| `maxDelta` | 建议 | 单次事件对单维最大改变量，默认 8 |
| `decayEnabled` | 必须 | 关闭时只应用 delta、不衰减 |
| `configVersion` | 必须 | 递增，写入 state |

---

## 5. Initiator 判定（B0-3）

### 5.1 四类

| 类型 | 含义 | 可信识别依据 |
|---|---|---|
| `user` | 用户发起 | DSH 真实 `user/message` 事件（`source.kind === 'user'` 或真实用户输入） |
| `persona` | Persona 主动发起 | Core 内部主动触发标识（P3-C 的主动联系、定时自省） |
| `scheduled` | 定时任务触发 | Scheduler 的可信任务标识（任务 id + 类型） |
| `unknown` | 无法确定 | 来源缺失、外部插件注入、来源不可验证 |

### 5.2 判定优先级（冻结）

1. 有可信 Scheduler 标识 → `scheduled`
2. 有可信 Core 主动触发标识 → `persona`
3. 有真实用户输入标识 → `user`
4. 其它 → `unknown`

- 判定结果在**同一个 Turn 内保持不变**；即使后续出现 Assistant 消息，也不改判。
- **不得**用「最后一条消息的 role」推断来源。
- **不得**让模型在工具参数里填写 Initiator。
- 外部插件注入（如 `dsh-mnemon` 的 delegated review）→ `unknown`，**不产生 Mood 变化**。

### 5.3 每轮 Transition 流程（契约）

```
turn 开始
  → 解析 Initiator（§5.2）
  → 读取可信 TurnKey（sessionRef + turn）
  → 若 op_id 已处理：返回既有结果（幂等）
  → 读取 33 维 raw 值 → 按 now 算 effective 值（§4）
  → 若 Initiator 不可信（unknown）：不做 delta，只允许读时衰减
  → 若可信：按事件类型计算候选 delta（B2 规则，B0 不冻结具体权重）
  → 事务内：clamp + 写 state（state_version+1）+ 追加 history（reason=turn:<turnKey>）
  → 返回新 effective 值 + 主语气/辅助特征（§6）
```

---

## 6. 语气投影（B0-5）

### 6.1 两层转换

```
33 维分值 → 归一化/档位 → 主语气 + 至多一个辅助特征 → Prompt「语气」段
```

数字**不直接进 Prompt**。投影只输出少量稳定词，不输出来源、权重、置信度。

### 6.2 档位（冻结）

对每维计算相对强度：

```
strength_i = (value_i - baseline_i) / max(1, 100 - baseline_i)   // 正向偏离
strength_i = (value_i - baseline_i) / max(1, baseline_i)         // 负向偏离（取绝对值后同式）
```

- `strength < 0.15` → 不参与投影。
- `strength >= 0.15` → 进入候选；按 `strength` 降序。

> **B0-REV-4（2026-11-11）**：以上负向分支保留为历史，**B3 v1 不使用**。v1 只投影 `value > baseline` 的正向偏离（`strength=(value-baseline)/max(1,100-baseline)`），`value <= baseline` 不进入候选；原因见 `docs/design/p3-a-b3-tone-projection.md` §2。未来如需要「低于基线」的语气，必须逐维显式加 `belowProjection`，不得自动取反。

### 6.3 冲突与降级（确定性）

1. 取候选集；若为空 → **中性**（`calm` 档位：平稳，不额外描述）。
2. 主语气 = 候选第一名。
3. 若第二名与第一名 `strength` 差 `< blendGap（默认 0.10）`，**且两者标签在兼容白名单内**（默认不兼容，见 B3 冻结稿 §5），允许**一个辅助特征**；否则不要辅助。
4. 层级优先（平手时）：基础 > 复合 > 当代；同层按 `key` 字典序。
5. 永远最多 1 主 + 1 辅；不叠加第三个。
6. 极端值（`value >= 95` 或 `<= 5`）**不扩大**表达强度；档位只决定「词」，不决定「多少字/多夸张」。

### 6.4 输出形态

```json
{
  "tone": "轻快",
  "secondary": "好奇",
  "neutral": false,
  "configVersion": 1
}
```

- `tone` 进 Prompt 的表达段，一句「当前语气：轻快，略带好奇」即可；**不写数值、不写情绪维度名**。
- `secondary` 可为 `null`。
- 无候选时 `tone='平稳'`、`neutral=true`。

### 6.5 Prompt 接入边界（冻结）

- 只允许注入**语气**：不改任务指令、不改安全规则、不改人格定义、不改记忆权限。
- 注入位置：Composer 的「当前感受」段或等价的固定段；不进入 system 规则文本。
- 注入失败（如配置缺失）→ 静默使用中性，不影响主回复。

---

## 7. 面板展示契约

- **只读**：33 维网格（key/label/有效值/相对基线方向/更新时间）+ 当前主语气/辅助特征 + 配置版本。
- 读时衰减，**不写库**。
- 不显示内部权重、候选列表、`reason`、历史流水（历史只在诊断接口/日志里）。
- 不开放「手动改 33 个值」（v1）；若要手动校准，走 P3-C 的受控入口，不在面板直接写。

---

## 8. P3-B 关系账本隔离（B0 必须）

| 概念 | P3-A | P3-B |
|---|---|---|
| 主体 | Persona | Persona + Contact |
| 情绪 | 全局 Mood | 不负责 |
| 亲和度 | 不负责 | Affinity |
| 信任 | 不负责 | Trust |
| 跨 Contact 共享 | 是（全局底色） | 否 |
| 影响表达 | 直接投影 | 可作为未来辅助上下文 |
| 进入长期事实 | 否 | 按账本独立规则 |

举例：Persona 与 A 的互动让全局 `happy` 上升，**不改变**对 B 的 Affinity；对 A 的 Trust 变化也**不映射**为全局 Mood。
两者共享的只有「Persona」这个主体；不共享存储、不共享写入事务、不共享投影。

---

## 9. 测试验收矩阵（B0 冻结，B1–B5 执行）

| 组 | 覆盖 | 关键断言 |
|---|---|---|
| `mood-model` | 33 维定义 | key 唯一且不可变；baseline/halfLife/min/max 合法；方向统一；34 个（多/少）一律拒绝 |
| `mood-decay` | 衰减 | 过一个半衰期偏离剩一半；`Δt=0` 不变；时钟回拨不衰减；离线按实际时间；clamp 到边界；不越基线 |
| `mood-initiator` | 来源判定 | 四类优先级；同 Turn 内不变；Assistant 消息不改判；模型参数不能指定；外部注入→unknown 且不产生 delta |
| `mood-idempotency` | 幂等/并发 | 同 op_id 重试只应用一次；两会话并发不同 turn 都记账且最终值可重算；乐观校验 0 行重试；事务失败无半写 |
| `mood-projection` | 语气 | 确定性（同输入同输出）；冲突降级最多 1 主 1 辅；中性回退；极端值不扩大强度；输出不含数值/维度名 |
| `mood-isolation` | 边界 | 不写 Artifact/Evidence/FTS/Recall/Diary/Stance/Growth；只写 4 张心情表（P3-A 只写前两张）；不修改 system/身份文档 |
| `mood-panel` | 面板 | 只读；读不写库；有效值 = 衰减后值；不显示内部字段 |
| `mood-relations` | 与 P3-B 隔离 | A 的互动改变全局 Mood，但不改变对 B 的 Affinity/Trust；Trust 改变不映射全局 Mood |

B5 另加：真实 Desktop Host 两轮（无情绪→有情绪）、重启恢复、旧 `dsh-mood` 插件停用后的切换验证。

---

## 10. 与 P3 其他阶段的接口

- **P3-B**：只共享 Persona 主体；不共享表、不共享事务、不共享投影。P3-A 不读 `contact_affect_*`。
- **P3-C 主动联系**：P3-A 只提供「语气」，**不提供「是否该联系」**；是否联系由 P3-C 独立判定，Mood 不能成为理由。
- **P2 记忆链路**：Mood 不进入 `recallMemory`、`composeInjection`、`injection-manifest`、`final-check` 的语义；注入块里不出现 Mood 数值。
- **面板/工具**：最多新增只读工具（如 `psyche_mood`），**不新增写工具**；写只走 Core 内部事务。

---

## 11. 未决项（进入 B1 前必须回答）

1. `global_mood_state` 是否加 `state_version/config_version/last_op_id` 三列，还是拆一张 `mood_meta`？——倾向加列（更小、同构）。
2. `global_mood_history.op_id` 唯一索引是否按 `(persona_id, op_id)` 建？——倾向是；history 每维一行，需 `(persona, op, dimension)` 唯一才能真正防重。
3. 每轮 delta 的来源与上限（哪些事件算、`maxDelta` 取多少）——B2 冻结，B0 只留接口。
4. 主 `persona_id` 之外是否允许多 Persona——v1 只 `main`，不做。
5. 旧 `dsh-mood` 数据迁移：只当初始快照（`mood.json` → state），不补历史。

---

## 12. 版本与不变量

- 本契约冻结后，改动需在 `docs/audit/p3-a-design-freeze.md` 追加修订记录，不得静默改语义。
- 三条不变量：**Mood 不成为事实源**；**Mood 不改判断/权限/身份**；**同一 Turn 只应用一次**。
