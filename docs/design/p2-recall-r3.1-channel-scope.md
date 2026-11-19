# P2-Recall R3.1：Channel / Group Scope 语义记录

> 日期：2026-11-07（2026-11-07 更新：**已冻结并实现**）  
> 性质：**设计记录 + 实现记录**。用户 m19206 已拍板「多来源最严交集（方案 A）」；代码已按第 4 节落地，`test/recall-visibility.ts` 21 断言、全量 2103 断言 0 失败。  
> 关联：`docs/design/p2-recall-r2-semantics.md`、`docs/audit/p2-recall-r3-implementation.md`

## 1. 现状（事实，不含判断）

- R3 后，召回准入在 SQL 内完成：head → state → disclosure → **Contact/Global Scope** → Subject → BM25 → LIMIT。
- **Channel / Group 没有进入 SQL 准入**。`artifact_revisions` 表没有 channel 列；channel 只存在于 `sources`（以及 `rooms`）。
- Composer 里保留了 `channel` 二次校验（`packages/core/src/composer.ts:194`），但它的输入 `candidate.channel` 来自候选对象；R3 的 `FtsHit`（`packages/core/src/fts.ts:360`）**没有 channel 字段**，自动注入链路上该值恒为 `null`，因此 `channel !== null && scopeChannel !== null` 的条件不会触发。
  - 结论：**R3 链路里 Composer 的 channel 检查实际不生效**。R2 文档里「Scope 只来自 RuntimeInput（全局 + 当前 Contact/Channel/Group）」的完整语义尚未落地。
- 这不影响已通过的 160/160 FTS 回归（它只验证检索结果集），但它是一个真实的语义缺口。

## 2. 数据关系（决定规则前必须先看）

```
artifact_revisions (artifact_id, revision, state, disclosure, subject_refs)
        │
        ├── artifact_evidence (artifact_id, revision, source_id, relation, independence_key)
        │        │
        │        └── sources (source_id, platform, channel, room_id, sender_contact_id, ...)
        │                 │
        │                 └── rooms (room_id, platform, channel, external_room_id)
        │
        └── artifact_trigger_events (artifact_id, revision, event_id) → events
```

要点：

1. **channel 是来源属性，不是结论属性**。同一条结论（Artifact）的多个 revision 可能由不同 channel 的证据支撑；head revision 的 evidence 集合才是当前判断依据。
2. `sources.channel` 取值只有 `private | group | desktop | web | system`；具体「哪个群」在 `rooms.external_room_id`，不在 `sources`。
3. `sources.sender_contact_id` 可空；群消息里的发送者不一定是「记忆归属人」。
4. 一条 Artifact 的 head revision 可能有多条 evidence，来自不同 channel、不同 platform、不同 room。
5. 没有 evidence 的 Artifact 也可能存在（例如系统写入的种子结论、或来自 grant/demo 的数据）。

## 3. 待拍板的五个问题

### 3.1 Channel 绑定记忆是否只能在原 Channel 使用？

候选规则：

| 来源 channel | 建议可见域 | 理由 |
|---|---|---|
| `desktop` / `web` / `system` | 同 Contact 的私域（所有渠道） | 是「本人操作」产生的，不是某个群的语境 |
| `private` | 该 Contact 的私聊（`channel=private` + 同 platform） | 一对一语境，默认不搬到群里 |
| `group` | 该 Room（`channel=group` + 同 `room_id`） | 群语境里的内容默认只在群内可用 |
| 无 evidence | 全局（本人所有渠道） | 没有渠道归属，只能按最宽处理，但受 disclosure 约束 |

### 3.2 一个 Artifact 关联多个 Source、来自不同 Channel 时，如何确定可见范围？

用户明确否决的方案：「只要有一个 Source 来自当前 Channel，就允许整个 Artifact 公开使用」——这会让不同渠道的证据和内容发生越权关联。

候选规则（按严格度排序）：

- **A. 取交集（最严）**：只有当「当前上下文同时满足全部来源的可见域」时才可见。混了 private 与 group 的结论，实际几乎不可见。
- **B. 取最高域（最宽）**：只要有一条来源允许，就整条可见——**不建议**，等于回到用户否决的方案。
- **C. 分域拆分**：把一条结论拆成「按来源域可见的片段」——超出 R4 范围，不做。

**建议 A**，并把「混合域」单独标记为 `mixed`（诊断里记 `scope_channel`，不返回给模型）。代价是跨渠道归纳出的结论很难被召回，但这符合「宁可少召回，不越权」。

### 3.3 没有 Channel 信息的 Artifact 是否允许跨 Channel 使用？

- 无 evidence → 视为 `global`，可在本人所有渠道召回（仍受 disclosure / state / Contact 约束）。
- 有 evidence 但 source 的 channel 为 `system` → 视为 `personal`（系统写入，不分渠道）。

### 3.4 Group Context 如何与当前 Group 身份匹配？

- RuntimeInput 提供 `platform` + `groupId`（群号）。
- 需要把 `(platform, 'group', groupId)` 解析到 `rooms.room_id`：查 `rooms WHERE platform=? AND channel='group' AND external_room_id=?`（`rooms.external_room_id` 是外部群号）。
- 解析不到 → 当前上下文只有 `global`，group 结论一律不召回（不猜）。
- 群成员身份（`room_members`）**不参与**召回准入：在群里不代表能看这个群的所有记忆，只代表「这个群是可见域」。

### 3.5 主动 Recall 与自动注入是否采用完全相同的最终准入判断？

目标是**完全相同**，实现位置在共享 Recall Engine 的第二层（LIMIT 前），不留给 Composer 单独决定。

- `searchFts` 负责人：MATCH、head、state、disclosure、Contact/Global、Subject、排序。
- Channel/Group 的判定需要 join `artifact_evidence` + `sources` + `rooms`，且是「head revision 全量来源的合取」——SQL 代价比 Contact 高。
- 两个实现选项：
  - **选项 1（推荐）**：`searchFts` 内加 `EXISTS`/`NOT EXISTS` 子查询（按 head revision 聚合来源域），完全在 LIMIT 前。
  - **选项 2**：`recallMemory` 先 overFetch（×3），再批量查候选的来源域，在内存里过滤后截断。仍在 LIMIT 前，但需要更大的 overFetch 上限，且顺序与 FTS 分数一致。
- 无论哪个选项，**Composer 不再承担 Channel 判定**（保留的是「回库重读 head」的二次确认，不是第二套准入）。

## 4. 实现形态（已落地）

1. `packages/core/src/fts.ts`：
   - 新增 `visibilityConditions(options)`：`NOT EXISTS(evidence) → global`；否则要求全部 effective Evidence 同域（`COUNT(DISTINCT 域)=1`）且每条来源与当前上下文兼容（`SUM(不兼容)=0`）。
   - 域定义：`desktop/web/system`→personal、`private`→`contact:<sender_contact_id>`、`group`→`room:<room_id>`、`sources` 缺失→`unknown`；`unknown`/混域一律拒绝。
   - `FtsScope` 增加 `roomId`/`allowPersonal`；`searchFts`/`searchLike` 在 LIMIT 前拼接条件。
   - **调用方未声明 scope 时不施加来源域准入**（纯检索/诊断/单测）；生产路径 `recallMemory`/`PreStepInjector` 始终显式传 scope。
2. `packages/core/src/recall.ts`：`resolveRoomId(db, platform, groupId)` 查 `rooms.external_room_id`；`ftsScopeOf(scope, roomId)`（`allowPersonal` 缺省＝有可信 Contact 身份）；`recallMemory`/`listHeads` 都走同一套条件。
3. `packages/core/src/pre-step-injection.ts`：自动注入传 `{contactId, roomId, allowPersonal: request !== null}`。
4. `packages/core/src/composer.ts`：删除 `candidate.channel` 二次判定（R3 链路上恒 `null` 的死代码），Composer 只做 head/state/disclosure 回库复核。
5. `src/index.ts`：`recallScope` 返回 `{contactId, channel: platform, platform, groupId}`。
6. 测试矩阵（`test/recall-visibility.ts` 21 断言）：
   - private 结论不进群、群结论不进私聊；
   - 多来源同域 → 该域可见；
   - 多来源混域 → 两条路径都不可见；
   - 无 Evidence → 全局可见；有 Evidence 但 Source 丢失 → 拒绝；
   - group 群号解析不到 → 群来源不可见；
   - 主动 Recall 与自动注入对同一 RuntimeInput 的最终准入一致；
   - Composer 不再因 channel 拒绝（不留第二套判定）。

## 5. 明确不做的

- 不实现「按渠道拆分同一条结论」；
- 不把群成员身份用于召回准入；
- 不改 R2 已冻结的 disclosure / state / Subject 规则；
- 不在 R3.1 里动 Receipt（R4-B）。

## 6. 结论

R3.1 已把 Channel / Group 纳入统一准入：来源域聚合与兼容判断全部在共享召回内核的 SQL 里、LIMIT 之前完成，主动 Recall 与自动注入使用同一套可见性规则；Composer 的 `channel` 二次校验已删除（死代码），不再存在「第二套判定」。

### 6.1 边界补强（2026-11-07，用户 m19725 核对项）

- **运行表面决定允许域**：新增 `FtsScope.surface = 'personal' | 'private' | 'group'`，由可信 Host/Adapter 注入。`personal` 允许 personal 域 + 本人 private；`private` 只允许本人 private；`group` 只允许该 Room。`allowPersonal` 不再由「请求快照是否存在」推导——QQ 群/私聊同样有非空请求，但不会被当作个人表面。
- **群聊不泄私聊**：群聊里发送者也有 `contactId`，但 `visibilityConditions` 的兼容判断拆成 `allowPersonal` / `allowContact` / `allowRoom` 三个独立开关，`surface='group'` 时 `allowContact=false`，发送者的私聊记忆不会进入群聊。
- 测试：`test/recall-visibility.ts` 21→25（个人表面可见本人私聊、QQ 私聊看不到 personal、群聊不因发送者 contactId 召回私聊、群聊 personal 不可见）。

仍保留的边界：真实 Agent 端到端未验证（宿主探针级）；群身份依赖 `rooms` 已落库；跨 platform 同名 room 由 `room_id` 区分；Abstention/Receipt 属 R4。
