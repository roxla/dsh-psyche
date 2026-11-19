# P3-A B2：每轮情绪判定（Turn Evaluation）冻结稿

> 日期：2026-11-11
> 状态：**B2 DESIGN FROZEN**（Initiator 判定 / deltas 规则 / 失败降级 / 写后接线点）
> 上游契约：`docs/design/p3-a-mood-state-machine.md` v1.0（B0）；B1 持久化：`docs/audit/p3-a-b1-mood-store-decay.md`
> 本文只冻结「一轮怎么变成 delta」，不冻结语气投影（B3）、面板（B4）。

---

## 0. 一句话

一轮结束时，用**可信 Initiator + 该轮真实用户文本**算出一小组受限 delta，交给 B1 的 `applyMood` 在**同一个事务**里落库；算不出来、来源不可信、或任何一步失败，就**这一轮不写**，绝不反向影响对话。

---

## 1. 范围与非目标

### 1.1 本阶段做

| 项 | 交付 |
|---|---|
| Initiator 判定 | `resolveMoodInitiator` 纯函数；四类优先级；同 Turn 不变 |
| deltas 规则 | 确定性词表 + 权重 + 上限；零模型调用、零网络、零随机 |
| 每轮编排 | `applyMoodTurn`：校验 → 判定 → 求 delta → `applyMood` → 结构化结果 |
| 写后接线 | `agent/turn-stopping` 落库；`agent/pre-step` 收集用户文本 |
| 失败降级 | 七类可预期失败全部「跳过并记录」，不抛给宿主 |

### 1.2 本阶段不做（留给后续阶段）

- 不做 33 维 → 主/辅语气的投影（B3 §6）。
- 不新增面板/路由/只读工具（B4）；不新增任何**写**工具（B0 §10）。
- 不改 schema（仍 v19 / 46 表）；不碰 `contact_affect_*`（P3-B）。
- 不调用模型。B0 §10「模型只能给候选」是**未来**通道：若将来接入，候选也必须经本文 §4 的 Core 校验与上限，Initiator 仍由 Core 判定。
- 不为 `persona` / `scheduled` 生成 delta（v1 只判定来源、不评估内容；它们的内容规则随 P3-C 单独冻结）。

---

## 2. 输入来源与可信边界

### 2.1 三类输入，各走各的门

| 输入 | 来源 | 可信性 | 用途 |
|---|---|---|---|
| 轮边界 + turn 号 | `agent/turn-stopping` payload `{ agent, turn, signal }` | 宿主事件，可信 | 只在此时写库 |
| 用户文本 | `agent/pre-step` 的 payload `messages` 中 `source.kind === 'user'` 的消息 | 宿主已分类，可信 | 只用于算 delta |
| 外部注入 | `source.kind === 'plugin'`（如 dsh-mnemon delegated review）、system/runtime-context | **不可信** | 不进入文本；该轮若没有真实用户消息 → unknown |

### 2.2 为什么不用 `session/event`

- `session/event` 的 `user/message` **不带 turn 字段**（见 `@deepseek-ai/dsh-session` 类型），只能靠「最近一次 `turn/start`」猜当前轮，多会话/插话时会错轮。
- `agent/turn-stopping` 直接给 `turn`，且是 serial、在轮边界提交前运行，天然满足「同一 Turn 只应用一次」。
- 因此：`session/event` 继续只做 Source 捕获（P2），**Mood 不挂在那里**。

### 2.3 文本收集规则（pre-step 缓冲）

1. 只在 `next()` 返回 `decision.kind === 'enter'` 时收集——被拒的批次没有进入本轮，不能算。
2. 只收 `payload.messages`（claimed 批次）里的 `source.kind === 'user'`；**不收** `decision.messages`，因为注入层可能把记忆块拼进同一条消息。
3. 同 turn 的多个 step **累加**，但总字数受 `maxText`（默认 4000）截断；每个 turn 只保留最近文本。
4. `agent/turn-stopping` 取走即清空；`agent/disposed` 清掉该会话全部缓冲。
5. 缓冲只存在宿主内存：不落盘、不进日志、不写库。

### 2.4 Assistant 消息永不参与

- 不从 `assistant/message` 取任何文本；不用「最后一条消息的 role」推断 Initiator；不用模型回复给本轮改判。
- 这是 B0 §5.2 的硬线，也是本阶段最容易写错的地方。

---

## 3. Initiator 判定

### 3.1 类型与优先级

```ts
type MoodInitiator = 'user' | 'persona' | 'scheduled' | 'unknown'
// 优先级（高 → 低）：scheduled > persona > user > unknown
```

| 判定 | 依据（Core 内部证据） | v1 行为 |
|---|---|---|
| `scheduled` | Core 持有的 Scheduler 任务标识（`taskId` + 类型） | 识别来源，不写 delta |
| `persona` | Core 内部的主动触发标识（主动联系 / 定时自省） | 识别来源，不写 delta |
| `user` | 本轮存在 `source.kind === 'user'` 的真实用户消息 | 参与判定、写库 |
| `unknown` | 没有上述任一可信证据 | 不写 delta（读时衰减照常） |

### 3.2 证据形状（只由 Core 填充）

```ts
interface MoodInitiatorEvidence {
  userMessageCount: number                     // 只数真实用户消息
  tokens?: {                                   // 目前没有生产者；为 P3-C 预留
    scheduled?: { taskId: string; taskType?: string }
    persona?: { trigger: 'proactive' | 'reflection' }
  }
}
```

- 工具参数、模型输出、外部插件**都不能填** `tokens`；v1 的接线只传 `userMessageCount`。
- `userMessageCount <= 0` 且没有 token → `unknown`。
- 同一 Turn 内判定结果不变（缓冲按 `(session, turn)` 固定，turn-stopping 只读一次）。

### 3.3 禁止

1. 不得在工具 schema 里暴露 `initiator` 参数。
2. 不得用 `assistant` 消息反推 `user`。
3. 不得把「有任意一条消息」当作 `user`——必须是 `source.kind === 'user'`。
4. 不得对 `unknown` 算 delta，即使文本里有关键词。

---

## 4. deltas 规则（B2 冻结）

### 4.1 总体

- 纯函数 `evaluateMoodDeltas({ texts, maxDelta })`：输入用户文本数组，输出 `{ deltas, signals, distress, textLength }`。
- 关键词命中计数 → 每组信号给若干维度加/减分 → 每维按 `maxDelta`（默认 8）截断 → 保留两位小数 → 丢掉 0 值。
- 所有维度 key 必须来自冻结的 33 维；命中未知 key 视为实现错误（测试兜底）。
- 没有任何命中 → `deltas` 为空 → **不写库**（不产生「空转」的 33 行历史）。

### 4.2 信号 → delta（每组的基准权重）

符号约定：`+` 表示该维度上升，`−` 表示下降；命中数 `n`，每组先用 `min(cap, n × w)`，cap 见括号。

| 信号 | 词表示例 | delta |
|---|---|---|
| distress（硬线） | 不想活 / 想死 / 自杀 / 撑不住 / 自残 … | **只给** `sympathy +5`、`calm −3`、`down +1`；其余全部丢弃 |
| positive | 谢谢 / 好的 / 不错 / 厉害了 / 哈哈 / 成功 | `happy +min(3,1.5n)`、`irritated −min(2,.8n)`、`down −min(1.5,.6n)`、`calm −min(2.5,.8n)` |
| negative | 不行 / 错了 / 烦 / 无语 / 崩溃 / 垃圾 | `irritated +min(3,1.2n)`、`happy −min(2,.8n)`、`down +min(1.5,.5n)`、`calm −min(3,1n)` |
| frustrated | 还没好 / 搞不定 / 失败 / 报错 / 又这样 | `irritated +min(6,3n)`、`down +min(2.5,1n)`、`happy −min(2,.8n)`、`calm −min(5,4n)` |
| question | ？ / 怎么 / 为什么 / 能不能 | `curious +min(2,.7n)` |
| excited | ！ / 太 / 居然 / 哇 | `excited +min(2,.7n)`、`happy +min(1.2,.4n)` |
| sulk | 随便你 / 算了 / 不用了 / 哦 / 嗯 | `sulking +min(5,2.2n)`、`happy −min(2,1n)`、`irritated −min(1.5,.6n)`、`calm −min(3,1.4n)`、`tired +min(1.5,.5n)` |
| wronged（hurt） | 你怎么这样 / 冤枉 / 都怪 / 明明 | `wronged +min(6,2.6n)`、`calm −min(3,1.2n)`、`happy −min(2,.9n)`、`sulking +min(2.5,1n)` |
| praise | 厉害 / 做得好 / 多亏你 / 靠谱 | `proud +min(5,2n)`、`happy +min(2,.8n)`、`sulking −min(3,1.5n)`、`wronged −min(3,1.5n)` |
| gloomy | 没意思 / 没劲 / 撑不住 / 好累 | `gloomy +min(6,2.6n)`、`happy −min(2.5,1.2n)`、`excited −min(2,1n)`、`irritated −min(1.5,.6n)`、`calm −min(3,1.4n)` |
| anxious | 怕 / 担心 / 万一 / 紧张 | `anxious +min(6,2.6n)`、`calm −min(3.5,1.6n)`、`tired +min(2.5,1n)`、`happy −min(1.5,.7n)` |
| numb | 无所谓 / 没感觉 / 麻木 / 也就那样 | `numb +min(6,2.6n)`、`happy −min(2,1n)`、`irritated −min(2,1n)`、`excited −min(2,1n)`、`gloomy −min(1.5,.6n)`、`calm −min(2,.8n)` |
| lonely | 好久没人 / 没人理 / 一个人 | `lonely +2.2`、`calm −1` |
| flutter | 喜欢你 / 爱你 / 抱抱 / 想你了 | `flutter +min(6,2.4n)`、`happy +min(2,.8n)`、`calm −min(2.5,1.2n)`、`tired −min(1.5,.8n)`、`sulking −min(2,1n)` |
| yearning（love） | 陪着我 / 离不开你 / 只有你 / 最懂我 | `yearning +min(6,2.4n)`、`happy +min(2,.8n)`、`lonely −min(2,.8n)`、`calm −min(2,1n)` |
| jealous | 她比你 / 换一个 / 别的ai / 不用你了 | `jealous +min(6,2.6n)`、`happy −min(2,1n)`、`calm −min(2.5,1.2n)`、`yearning +min(2,.8n)` |
| burnout | 内耗 / 想太多 / emo / 纠结 | `burnout +min(6,2.4n)`、`focused −min(2,1n)`、`calm −min(3,1.4n)`、`tired +min(2,.8n)` |
| breakdown（cracked） | 破防 / 绷不住 / 扎心 / 心态崩 | `breakdown +min(6,2.6n)`、`irritated −min(2,.9n)`、`sulking −min(1.5,.6n)`、`calm −min(3,1.4n)` |
| lyingFlat（checkedout） | 摆烂 / 躺平 / 卷不动 / 爱咋咋 | `lyingFlat +min(6,2.4n)`、`focused −min(2.5,1.2n)`、`anxious −min(2,1n)`、`tired +min(2,.8n)` |
| hooked（hyper） | 上头 / 停不下来 / 入迷 / 上瘾 | `hooked +min(6,2.4n)`、`focused +min(2,.8n)`、`excited +min(2.5,1n)`、`tired −min(2,.9n)` |
| fear | 害怕 / 恐惧 / 吓到 / 心慌 | `fear +min(6,3.4n)`、`calm −min(4,2.6n)`、`anxious −min(1.5,.8n)` |
| disgust | 恶心 / 厌恶 / 反胃 / 变态 | `disgust +min(6,3.4n)`、`calm −min(4,2.6n)`、`irritated +min(2,1n)` |
| surprised | 居然 / 竟然 / 没想到 / 真的假的 | `surprised +min(5,2.8n)`、`calm −min(3,2n)`、`curious −min(1.5,.6n)` |
| ashamed（shame） | 丢人 / 丢脸 / 无地自容 | `ashamed +min(6,3.4n)`、`calm −min(4,2.6n)`、`proud −min(2,1.2n)` |
| guilty（guilt） | 内疚 / 对不起 / 我的错 / 怪我 | `guilty +min(6,3.2n)`、`calm −min(4,2.4n)`、`wronged −min(1.5,.8n)` |
| awkward | 尴尬 / 社死 / 冷场 | `awkward +min(5,2.8n)`、`calm −min(3.5,2.2n)` |
| sympathy | 好可怜 / 心疼 / 太惨了 / 不容易 | `sympathy +min(5,2.6n)`、`calm −min(3,1.8n)` |
| disappointed | 失望 / 落空 / 白期待 / 心凉 | `disappointed +min(6,3.2n)`、`down +min(2.5,1.2n)`、`calm −min(4,2.4n)` |
| nostalgic | 怀旧 / 当年 / 小时候 / 从前 | `nostalgic +min(5,2.6n)`、`calm −min(2.5,1.6n)` |
| coy | 撒娇 / 讨厌啦 / 陪我嘛 / 好不好嘛 | `coy +min(5,2.8n)`、`calm −min(2.5,1.6n)` |
| conflicted | 矛盾 / 进退两难 / 拿不定主意 | `conflicted +min(6,3.2n)`、`calm −min(3.5,2.2n)` |

补两条长度规则（与旧 dsh-mood 一致，避免「长文本被当成聊天」）：

- 总长 ≥ 80 字：`focused +1.2`、`tired +0.3`。
- 总长 ≤ 6 字：`tired +0.4`、`focused −0.2`。
- 总长 ≤ 12 且命中 excited 且未命中 question：`excited +0.6`。

### 4.3 硬线：distress

- 命中 `DISTRESS` 且不在 `DISTRESS_EXCEPT`（想死我 / 想死你 / 想死了这 / 想死这）中 → **丢弃所有其它信号的加减分**，只保留 `sympathy +5 / calm −3 / down +1`，并在结果里置 `distress: true`。
- 目的：不让「我好累，撑不住了」被别的关键词带成「开心」；也让 B3 能在语气层走「停止情绪表演」的硬线。
- `distress` 是**瞬时判定**，不新增表、不持久化；B3/B4 只能读本轮结果，不能从历史里反推。

### 4.4 聚合与上限

- 多条消息累加命中数；每个信号组内 `n` 最多按 4 计（防止刷屏一句话堆满）。
- 每维最终 `clamp(−maxDelta, +maxDelta)`；`maxDelta` 默认 8，配置范围 1–20。
- 结果保留两位小数；四舍五入后为 0 的维度不写。
- 同一轮内不重复应用：靠 op_id 幂等，不靠「调一次少一次」。

### 4.5 确定性

- 无随机、无当前时间参与打分（长度/命中都是文本自身属性）、无模型调用。
- 同一输入同一输出；测试可直接断言字面值。

---

## 5. TurnKey 与幂等

```text
op_id  = mood:<persona>:<sessionRef>:<turn>
turnKey= <sessionRef>:<turn>
reason = turn:<sessionRef>:<turn>
```

- `persona` 固定 `main`（B1 的 `MOOD_PERSONA_ID`）。
- `sessionRef` = `agent.id`（与 `recall_runs.session_ref` 同一套会话身份）。
- `turn` 必须是 ≥1 的整数；缺失/非法 → 跳过（不猜轮号）。
- `op_id` 长度上限 200；超长（异常会话 id）→ 跳过并 warn，不截断（截断会撞键）。
- 重放：`applyMood` 返回 `replayed: true` → 结果记为 `applied:false / reason:'replayed'`，不二次写。

---

## 6. 写入管线与失败降级

### 6.1 每轮顺序

```text
turn-stopping
  → 取 (sessionRef, turn) 的文本快照（取走即清空）
  → resolveMoodInitiator({ userMessageCount })
  → initiator !== 'user' ? 跳过 : 继续
  → 文本为空 ? 跳过 : 继续
  → evaluateMoodDeltas(...) → deltas 为空 ? 跳过 : 继续
  → persona_config 不存在 ? 跳过（未初始化，不建 mood 行）
  → applyMood(op_id, deltas, reason)  // 单事务：33 state + 33 history + 1 meta
  → replayed ? 记 replayed : 记 applied
```

### 6.2 失败降级表（全部不抛给宿主）

| 情况 | 结果 | 日志 |
|---|---|---|
| 插件未启用 / 库未就绪 | 跳过 | debug |
| turn 缺失或非法 | 跳过 | debug |
| 该轮没有真实用户消息 | `unknown-initiator` 跳过 | debug |
| `persona` / `scheduled`（v1） | `initiator-not-user` 跳过 | debug |
| 文本为空 / 全被截断 | `empty-text` 跳过 | debug |
| 没有关键词命中 | `no-signal` 跳过 | debug |
| 人格未初始化（无 `persona_config`） | `persona-not-initialized` 跳过 | debug |
| `op_id` 超长 | `invalid-turn-key` 跳过 | warn |
| `applyMood` 事务失败 | `ok:false` | warn（含错误文本，不含用户原文） |
| 监听器外层任何异常 | 捕获 | warn |

- `agent/turn-stopping` 是 awaited、serial：实现里所有 DB 操作同步完成，不排队列、不 fire-and-forget，避免「轮关了才写」的竞态。
- 任何失败都**不回滚对话、不改 prompt、不抛 error**：Mood 是旁路状态。

---

## 7. 写后接线点

| 位置 | 改动 |
|---|---|
| `src/lib/mood-turn-buffer.ts`（新增） | 按 `(session, turn)` 收集 `source.kind==='user'` 的消息文本；有界（64 会话 / 每会话 4 轮 / 4000 字） |
| `src/index.ts` pre-step effect（现有 injection effect 之后） | 再挂一个 `agent/pre-step` 监听：`await next()`，`kind==='enter'` 时 `buffer.record(...)`，原样返回 decision |
| `src/index.ts` 新 effect `dsh-psyche.mood()` | `ctx.on('agent/turn-stopping', ...)`：取缓冲 → `applyMoodTurn(runtime.db, ...)` → 日志；返回时调 `off()` |
| `agent/disposed` 现有回调 | 追加 `moodTurns.dropSession(sessionId)` |
| Config | `mood.enabled`（默认开）、`maxDelta`（8）、`maxText`（4000）、`excludeSessions` |

- 不新增工具、不新增路由、不改 `PROMPT_SECTION`。
- `cfg.mood.enabled === false` 时监听器直接返回（不收集、不写库）。
- `excludeSessions` 命中时 `record` 直接丢弃。

---

## 8. 配置

| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `mood.enabled` | `true` | bool | 关闭后不收集也不写；已写数据保留 |
| `mood.maxDelta` | `8` | 1–20 | 单维单轮最大改变量（B0 §4.3） |
| `mood.maxText` | `4000` | 100–20000 | 单轮参与判定的用户正文上限 |
| `mood.excludeSessions` | `''` | CSV | 排除会话；空表示不限制 |

默认开的理由：B2 只写 4 张心情表，不改语气、不进记忆链路；关着会让 B3/B4 没有真实数据。B5 真机验收若发现副作用，再把默认值翻回 false。

---

## 9. B1 修订：衰减必须对称（阻塞 B2）

- **问题**：`packages/core/src/mood-decay.ts` 在 `clamped <= baseline` 时直接返回原值，导致低于基线的维度**永不回升**；B2 一旦允许负 delta（`calm`/`happy` 下调），低值会永久卡住。
- **依据**：B0 §4.1 公式 `M(t)=B+(M0−B)·2^(−Δt/H)` 与 §4.2.5「同一方向单调趋近基线」都要求**双向**趋近；B1 的「不自动上抬」超出冻结语义。
- **修订**：去掉 `clamped <= baseline` 的提前返回，统一按公式计算并向 baseline 趋近（不过冲），其余时间规则不变。
- **连带**：`test/mood-decay.ts` 中「低于 baseline 不上抬」的断言改为「低于 baseline 向 baseline 回升、不过冲」；`mood-store.ts` 文件头注释第 13 行同步；在 `docs/audit/p3-a-design-freeze.md` 追加一条修订记录（B1-1）。
- **影响面**：只影响负向偏离的读时值；B1 现有正向衰减测试不变。

---

## 10. 测试矩阵与验收

| 套件 | 覆盖 | 关键断言 |
|---|---|---|
| `test/mood-initiator.ts` | 来源判定 | 四类优先级；无用户消息→unknown；assistant/plugin 不算 user；判定结果与文本无关 |
| `test/mood-evaluator.ts` | deltas | distress 硬线只留三项；关键词映射到正确维度；maxDelta 截断；空文本/无命中为空；确定性（同输入同输出）；未知 key 不出现 |
| `test/mood-turn.ts` | 每轮编排 | op_id/reason 格式；unknown 不写；user 写入且 history 33 行；重放不二次写；未初始化跳过；非法 turn 跳过；失败返回 ok:false 不抛 |
| `test/mood-wiring.ts` | 缓冲 | 只收 user；进决策后收集；跨 step 累加；take 清空；dropSession；会话/轮数/字数上限 |

验收口径：

1. 上述 4 套 + B1 6 套全绿；全量 `npm run test` 断言数与 DEV 记录一致。
2. 同一 `(session, turn)` 重复触发 turn-stopping，`global_mood_history` 不新增。
3. 关闭 `mood.enabled` 后，一轮对话不产生任何 mood 行。
4. 任何失败路径都不向 `agent/turn-stopping` 抛异常（测试直接调 `applyMoodTurn` 断言 `ok:false`）。

---

## 11. 不变量（与 B0 §12 对齐）

1. Mood 不成为事实源：不写 Artifact/Evidence/FTS/Recall/Diary/Stance/Growth。
2. Mood 不改判断、权限、身份、是否联系。
3. 同一 Turn 只应用一次（op_id 幂等 + 缓冲取走即清空）。
4. 判定只信宿主事件，不信模型参数、不信 assistant 回复、不信外部插件注入。
