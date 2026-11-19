# 「记住这条」一键收录方案（v1 设计稿）

日期：2026-11-08
状态：**设计稿，未落代码**（等确认后实现）
范围：仅 DSH 面板内 assistant 回复下方的按钮；不含 QQ（QQ 没有 UI 按钮）

## 1. 目标与非目标

### 目标

- 在每条 assistant 回复下方放一个「记住这条」按钮，点一下就把这轮对话中值得记的结论写进记忆库；
- 不弹确认卡、不打断对话，只回一行结果（toast）；
- 写入必须走现有 `remember` / 证据链 / 版本 / 披露规则，不新增旁路事实源。

### 非目标

- 不做「把回复原文存成一条记忆」（原文已由 capture 自动进 `sources`）；
- 不做模型自动判断「该不该记」——判断权交给点击的人；
- 不做一键公开（披露固定 `restricted`）；
- 不做群聊场景（`contactId=null`，按钮禁用）。

## 2. 交互

### 2.1 位置

assistant 消息气泡下方的操作行，与「复制 / 好 / 差 / 分支」并列：

```
[复制] [👍] [👎] [记住这条] [在新对话中分支]   用量 27.3K tok
```

### 2.2 状态

| 状态 | 表现 |
| --- | --- |
| 可点 | 正常按钮 |
| 写入中 | 按钮转圈，禁用 |
| 已记过 | 显示「已记住」勾选态，可再点（幂等，不报错） |
| 禁用 | 群聊会话；这条回复属于注入块/系统消息；会话采集未开 |

### 2.3 结果反馈（toast，四种）

```
已记住：用户喜欢喝乌龙茶 · art_mw69ilej24f1c7e8f8@1        [查看]
已追加证据：这条原来就有                                    [查看]
和已有结论冲突，已记为矛盾                                  [查看]
这条没有可存的结论（或：消息还没进记忆库，请先开启会话采集）
```

## 3. 数据流

```
点击按钮
  ↓
POST /api/psyche/remember-message
  body: { sessionId, assistantMessageId }
  ↓
① 定位本轮消息：从 sessionPersistence 读该 session 的事件，
   找到 assistantMessageId 对应的事件；再找它之前最近一条真实 user 消息
  ↓
② 定位来源：sources WHERE session_ref = sessionId
                      AND capture_key IN (userSeq, assistantSeq)
   （capture_key 就是 DSH 事件 seq；缺任何一条 → 失败，不猜）
  ↓
③ 提炼：extractStatement(assistantText, userText)
   → statement / kind / 是否寒暄 / 是否可存
  ↓
④ 去重：searchFts(statement, limit 5) + 否定判定
   → created / appended / clash / duplicate
  ↓
⑤ 写入（单事务，opId 幂等）：
   created  → Core.remember
   appended → Core.appendEvidence（新增）
   clash    → Core.clash
   duplicate→ 直接返回
  ↓
⑥ 返回 { action, artifactId, revision, state }
```

## 4. 提炼规则（纯规则，零模型调用）

`extractStatement(assistantText, userText)`：

1. **清理**：去掉 markdown 代码块、行内代码、链接 URL、`**`/`*`/`#`/`>` 标记、表情短码；
2. **切句**：按 `。！？!?；;\n` 切，去首尾空白；
3. **寒暄表**：`对|好|好的|收到|嗯|是的|可以|没问题|知道了|行|OK|记得了|记下了`（整句 ≤6 字或完全匹配时视为寒暄）；
4. **选句**：
   - 找第一句「≥8 字且不是寒暄」的句子；
   - 若没有，找含「你/我/他/她」且有动词（喜欢/讨厌/是/有/在/要/会/能/想/觉得）的最长句；
   - 若仍没有，取 `userText` 去语气词（「请」「帮我」「能不能」开头）后的内容；
   - 任一句超过 120 字：截到 120 字并在末尾加「…」；
   - 全部不满足 → `null`。
5. **归一**：句尾去掉「——」后的补充；连续空白压成一个空格。

示例：

| 输入（assistant 回复） | 输出 |
| --- | --- |
| 「对，乌龙茶——这条记录我一直记着。」 | 「这条记录我一直记着」（若判为寒暄则回退到 user 文本「乌龙茶」） |
| 「用户喜欢喝乌龙茶。它耐泡，值得一遍遍说。」 | 「用户喜欢喝乌龙茶」 |
| 「记下了，乌龙茶——这回记得比上次还牢。」 | 寒暄 → 回退 user 文本「乌龙茶」 |
| 「好的。」 | 寒暄 → user 文本；user 也寒暄 → null |

## 5. kind 判定

| 规则 | kind |
| --- | --- |
| 默认 | `fact` |
| 含「我觉得 / 我认为 / 我感觉 / 建议 / 最好 / 偏好」 | `belief` |
| 含「我认为应该 / 建议不要」等价值判断 | `belief` |

只在这两类里选，不自动生成 `stance`（立场必须经 `review`）、不生成 `procedure`/`relationship`（需要结构化信息）。

## 6. 归属（subjectRefs）

| 会话类型 | subjectRefs |
| --- | --- |
| Desktop 个人（有 contactId） | `[contactId]` |
| QQ 私聊（有 contactId） | 按钮不存在（QQ 无面板） |
| 群聊（contactId=null） | **按钮禁用**，不写 |
| 无 contactId 的桌面会话 | 按钮禁用（避免写成全局） |

不提供「改成全局」的入口——全局结论只能由 `remember` 工具在无 Evidence 的场景下写。

## 7. 来源绑定

- `sourceIds = [userSourceId, assistantSourceId]`；
- 两条都必须存在且未被 `quarantined_sources` 隔离；
- 任一条缺失 → `E_SOURCE_MISSING`，toast「这条消息还没进记忆库，请先开启会话采集」；
- 任一条被隔离 → `E_SOURCE_QUARANTINED`，toast「来源已被隔离，不能作为证据」。

## 8. 去重与冲突

写入前用 FTS 查相似结论（`searchFts(statement, {limit:5})`，与召回同一套过滤：head、active/challenged、public 含 restricted 自身可见、当前 Contact）。

| 条件 | 动作 |
| --- | --- |
| 同 statement（归一后完全相同） | `duplicate`：不写，返回已有 artifactId |
| bigram Jaccard ≥ 0.8 且 kind 相同 | `appended`：追加证据到已有 head |
| 否定冲突：两句都命中同一主体，且一句含否定词（不/没/从不/绝不/并非）另一句不含 | `clash`：写 `contradiction_detected` 事件，不新建结论 |
| 其他 | `created`：新建 |

阈值 0.8 先固定，不做配置。

## 9. 写入语义

### created

```ts
core.remember({
  kind,                      // fact | belief
  statement,
  subjectRefs: [contactId],
  sourceIds,
  disclosure: 'restricted',  // 固定
  opId: `btn:${sessionId}:${assistantMessageId}`,
})
```

### appended（新增能力）

`Core.appendEvidence(artifactId, { sourceIds, relation: 'supports', opId })`：

- 取当前 head revision；
- 写 `artifact_evidence(revision=head.revision, relation='supports', independence_key=...)`；
- 重算 `basis_count` / `independent_evidence_count`；
- 同一 (artifactId, revision, source_id) 已存在时幂等返回；
- 记 `operations`。

### clash

```ts
core.clash({
  artifactId,                // 被撞的结论
  statement,                 // 这次的相反结论
  sourceIds,
  opId,
})
```

### duplicate

不写任何东西，返回已有 `artifactId@revision`。

## 10. 幂等

- `opId = btn:<sessionId>:<assistantMessageId>`；
- 重复点击返回第一次的结果，不再写；
- 刷新页面后按钮状态从「该 assistant 消息是否已有对应 operation」恢复（查 `operations`）。

## 11. 安全与审计

- 披露固定 `restricted`，不可通过参数改；
- 群聊禁用；
- 隔离来源拒绝；
- 敏感内容（`looksSensitive`）照常写 restricted，但**永远不因按钮变成 public**；
- 每次点击写一条 `operations`（audit），面板「运维 → 操作」可见；
- 写入后可撤回：面板「记忆」里改口/遗忘，按钮不提供删除。

## 12. 失败处理

| 情况 | 错误码 | toast |
| --- | --- | --- |
| sessionPersistence 不可用 | `E_UNSUPPORTED` | 「当前环境不支持这条消息收录」 |
| 找不到 assistant 消息 | `E_NOT_FOUND` | 「找不到这条消息」 |
| 来源缺失 | `E_SOURCE_MISSING` | 「消息还没进记忆库，请先开启会话采集」 |
| 来源被隔离 | `E_SOURCE_QUARANTINED` | 「来源已被隔离」 |
| 提炼为空 | `E_EMPTY_STATEMENT` | 「这条没有可存的结论」 |
| 群聊 | `E_DISABLED` | 按钮置灰，不请求 |
| 写入冲突（opId 重放） | — | 幂等返回旧结果 |

所有失败不写半截数据：service 侧先校验、再单事务写。

## 13. 性能与成本

- 零模型调用；
- 一次点按 = 1 次 sessionPersistence 读 + 1 次 FTS 查 + 1 个事务；
- 预期 p95 < 50ms（与 `remember` 同量级）；
- 不新增表，不新增索引（复用 `sources.capture_key` 与 `fts_index`）。

## 14. 测试矩阵

| 组 | 用例 |
| --- | --- |
| T1 提炼 | 寒暄回退、长句截断、markdown 清理、纯寒暄返回 null、user 回退 |
| T2 kind | 陈述句 fact、我觉得 belief、建议 belief |
| T3 来源 | 两条齐全、缺 user、缺 assistant、隔离来源、capture 关闭 |
| T4 去重 | 同句 duplicate、高相似 appended、否定 clash、无关 created |
| T5 幂等 | 连点两次只写一次、刷新后状态恢复 |
| T6 归属 | Desktop 绑 Contact、无 Contact 禁用、群聊禁用 |
| T7 披露 | 固定 restricted，参数传 public 被忽略/校验失败 |
| T8 失败 | 每种错误码的 toast 与无半截写入 |

预计新增 35–45 条断言（`test/remember-button.ts`）。

## 15. 与现有模块的接点

| 位置 | 改动 |
| --- | --- |
| `src/client/index.ts` | assistant 消息操作行加按钮；点击调路由；toast |
| `src/index.ts` | 新增 `POST /api/psyche/remember-message`（Owner 路由，鉴权同其他） |
| `src/lib/remember-button.ts`（新） | 定位消息、提炼、去重、调用 Core |
| `packages/core/src/store.ts` | 新增 `appendEvidence`（若不存在） |
| `packages/core/src/recall.ts` | 复用 `searchFts` 做去重查询 |
| `docs/audit` | 实现后补报告 |

## 16. 边界（不做的事）

- 不提炼多句、不总结整段回复；
- 不自动写 `stance`/`procedure`/`relationship`；
- 不把 assistant 的话直接当事实（提炼句仍需经过按钮这一下人工确认）；
- 不做「自动记住所有回复」；
- 不写公开披露；
- QQ 无此按钮。

## 17. 分期

| 版本 | 内容 |
| --- | --- |
| v1（本方案） | 纯规则提炼 + 去重/冲突 + 固定 restricted |
| v2（可选） | 如果规则提炼太粗糙，加一个「用当前模型提炼」开关，走一次小模型调用，仍不弹卡 |
| v3（可选） | 面板里加「最近收录」列表，支持撤回 |

## 18. 验收标准

- 点一下，1 秒内出现 toast，且库里有对应 Artifact/证据；
- 重复点击不产生第二条；
- 群聊按钮不可用；
- 披露永远是 restricted；
- 所有失败都有明确 toast 且库无半截数据；
- 全量测试通过，新增断言纳入基线。
