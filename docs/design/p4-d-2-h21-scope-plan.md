# P4-D-2-H21：Subject/Room Scope 修正方案（交 Codex 执行）

状态：初版 `2367689`，首轮 `3481be4`。用户已明确“只有管理页面白名单中的群可以交互”；`b8057d6` 落实白名单/Room-only自动注入，`bde11a4` 收紧群工具；DEV v27.97，最终4858/148套/149步/0。§7保留v27.96历史。
前置提交：`5f325c5`（P4-D-2 模块级实现）。不重做 Schema v23，不开放群回复，不进入 D-3。

---

## 0. 先说结论：当前 H21 夹具不满足方案 A 的前提

用户要求先确认 H21 的 Artifact 当前 head revision 是否满足五条件。我用只读脚本查了
`<work>\.tmp-p4d2-host-20261114\data\memory.sqlite3`，结果如下。

| 检查项 | 结果 |
| --- | --- |
| `subject_refs` 含 `ct_` 成员 | 是：`["ct_mwfryjy30e13152a83"]`（31001） |
| 至少一条有效 `artifact_evidence` | 是：每条 Artifact 2 条 |
| 每条 Evidence 的 Source `channel='group'` | 是 |
| 所有 Source 的 `room_id` 精确等于当前 Room | **否：两条 Source 的 `room_id` 都是 `NULL`** |
| 无缺失/跨群/私聊 Evidence | Source 存在，但 Room 不可解析 |

涉及 Artifact：

- `art_mwfuh8xr9c9fd3aa04`：`D2SCOPE GROUP_A_ONLY 41006`
- `art_mwfuh8xs09d25e11c3`：`D2SCOPE GROUP_B_ONLY 41007`
- `art_mwfuh8xp5f64af09cb`：`D2SCOPE PRIVATE_ONLY_CONTACT private`

根因在夹具，不在检索：`probe/index.mjs` 第 69 行把
`(await core.resolveContact({...})).roomId` 传给 `capture()`，但 `Core.resolveContact()`
的返回类型**不包含 `roomId`**（`store.ts:2546-2584`），所以三组 Source 全是 `room_id=NULL`。
真实群聊入口 `ingestGroupMessage()`（`store.ts:2453`）会写 `room_id`，不受此缺陷影响。

因此按用户自己的裁决：「**如果不满足，则首先应检查 H21 测试夹具和写入流程，而不是放宽检索**」。
H21 目前是 **INVALID**，不是「方案 A 应修复的误拒证据」。

另外需要指出：H21 的发送者与 Subject 是同一个 Contact（31001）。即使修好 `room_id`，
当前 `scopeConditions` 的「contactId 精确匹配」也会放行，它**无法暴露**「群成员甲被乙提问、
结论 Subject=甲」这一真正的过度过滤场景。因此验收必须补一条 **sender ≠ subject** 的用例。

---

## 1. 冻结语义（方案 A）

> Subject 表示结论谈论谁；Evidence 的来源域决定结论可以出现在哪里。

群表面（`surface='group'`、`roomId` 非空）下，`ct_` Subject 的结论只有在满足以下**全部**条件时才可见：

1. 结论当前 head revision 的 `subject_refs` 含 `ct_` 元素；
2. 该 revision **至少有一条** `artifact_evidence`；
3. 该 revision 的**每一条** Evidence 都解析到存在的 Source；
4. 每条 Source 都是 `channel='group'`；
5. 每条 Source 的 `room_id` 都精确等于当前 `scope.roomId`。

交互请求还必须来自当前管理配置白名单。此为 Host 准入条件，不由 Subject、Evidence 或 Room 存在性推导。

其余情况一律按原规则拒绝：

- 无 Evidence 的 `ct_` 结论 → 拒绝（不因进入群聊变成群共享）；
- 私聊 Evidence、混合群/私聊 Evidence、跨群 Evidence → 拒绝；
- Evidence Source 丢失或 Room 不可解析 → 拒绝；
- `subject_refs` 非法 JSON → 拒绝。

`ct_a` 必须精确匹配，不能命中 `ct_aa`。

**实现要点**：条件 3–5 已经由 `visibilityConditions()` 完整实现（`fts.ts:542-615`），
不要在新代码里再写一遍来源域判定，否则两套规则迟早漂移。Subject 例外只负责
「无 Evidence 仍拒绝」和「有 Evidence 才进入可见性判定」。

---

## 2. 生产代码改动

### 2.1 `packages/core/src/fts.ts`

现状：`scopeConditions()`（`:503-527`）在 `contactId` 为空时，排除所有含 `ct_` 的
`subject_refs`；群表面没有 contactId，于是全被排除。

改动：

1. 新增导出函数 `subjectScopeConditions(scope?: FtsScope): { sql, params }`，
   把当前 `scopeConditions` 里的 Subject 片段抽出来；`scopeConditions` 调用它，再加
   `subject` 精确过滤。
2. 群分支只在 `scope?.surface === 'group'` 且 `scope.roomId` 非空时加入；
   `personal` / `private` / 无 surface 保持原样。
3. 把 `value LIKE 'ct_%'` 改为 `value GLOB 'ct_*'`（SQLite 的 `_` 在 LIKE 里是通配符，
   会误匹配；GLOB 里 `_` 是字面量）。
4. SQL 片段：

```sql
AND (
  (CASE
     WHEN json_valid(r.subject_refs) = 0 THEN 0
     WHEN EXISTS (SELECT 1 FROM json_each(r.subject_refs) WHERE value GLOB 'ct_*') THEN 0
     ELSE 1
   END) = 1
  OR (? IS NOT NULL AND json_valid(r.subject_refs) = 1
      AND EXISTS (SELECT 1 FROM json_each(r.subject_refs) WHERE value = ?))
  OR (
    ? IS NOT NULL
    AND json_valid(r.subject_refs) = 1
    AND EXISTS (SELECT 1 FROM json_each(r.subject_refs) WHERE value GLOB 'ct_*')
    AND EXISTS (
      SELECT 1 FROM artifact_evidence ve
       WHERE ve.artifact_id = r.artifact_id AND ve.revision = r.revision
    )
  )
)
```

参数顺序：`contactParam, contactParam, roomParam`（`roomParam` 只在群分支非空，
否则传 `null` 并保持占位）。`roomParam` 必须来自 `scope.roomId`，不能来自模型参数。

实现补强：显式 `surface='group'` 时 `contactParam` 统一为 NULL，避免“发送者恰好等于 Subject”绕过无 Evidence 拒绝；非群原规则保持。实际 SQL 用外层 CASE 保护非法 JSON，再执行 `json_each`，不依赖 AND 的求值顺序。以上片段只表达 Subject 准入，不能单独充当来源域检查。

> 说明：第 3 个 OR 只放行「有 Evidence」的 `ct_` 结论；Evidence 是否全部属于当前 Room
> 由调用方紧随其后的 `visibilityConditions` 判定。两条 SQL 必须同时出现在查询里
> （`fts.ts` 的两个查询与 `recall.ts` 的 `listHeads` 都是这样拼的）。

### 2.2 `packages/core/src/recall.ts`

`listHeads()`（`:264-306`）复制了一份 Subject 过滤 SQL。改为：

```ts
import { subjectScopeConditions, visibilityConditions, ... } from './fts.js'
...
const subjectFilter = subjectScopeConditions(scope)
if (subjectFilter.sql) conditions.push(subjectFilter.sql.replace(/^AND\s+/, ''))
params.push(...subjectFilter.params)
```

删除本地 `contact`/`CASE` 片段，避免第三份实现。

### 2.3 `packages/core/src/final-check.ts`

现状（`:264-286`）：`manifest.contactId === null` 且结论带 `ct_` → 拒绝；
`manifest.contactId !== null` 且与结论 `ct_` 不同 → 拒绝。群聊里发送者是乙、结论 Subject=甲时，
第二条会误杀；只修 FTS 会出现「Recall 通过但最终注入检查拒绝」的不一致。

改动：

1. 从 `fts.ts` 导入 `isArtifactVisibleInScope`，并新增导出
   `hasRevisionEvidence(db, artifactId, revision): boolean`（或等价本地查询）。
2. 在 `checkItems` 中计算：

```ts
const groupRoomException =
  boundContact !== null &&
  groupAllowed === true && // Host 对当前管理配置的校验，不能由 manifest 自报
  expected !== undefined &&
  expected.surface === 'group' &&
  expected.roomId !== null &&
  manifest.surface === 'group' &&
  manifest.roomId === expected.roomId &&
  hasRevisionEvidence(db, item.artifactId, head.revision) &&
  isArtifactVisibleInScope(db, item.artifactId, head.revision, expected)
```

3. 两处判定改为：

```ts
if (manifest.contactId === null && boundContact !== null && !groupRoomException) { ... }
if (manifest.contactId !== null && boundContact !== null &&
    boundContact !== manifest.contactId && !groupRoomException) { ... }
```

4. 不要删除原有检查；非群表面、Room 缺失、无 Evidence、来源不可见时保持原拒绝。
5. `manifest.roomId` 与 `expected.roomId` 的一致性检查保持不变。
6. 无 Evidence 的成员结论在群内一律拒绝，包括 Subject 等于发送者；非法 Subject JSON 也拒绝，不能误作 global。上例当前要求 Host 的有效白名单校验；v27.96 的 NULL 拒绝只作历史记录。

### 2.4 `test/recall-visibility.ts` 与新增测试

在 `test/recall-visibility.ts` 增加：

- 群内 `ct_` 成员结论（sender=乙，Subject=甲，Evidence 全在 Room A）→ A 可见；
- 同一结论在 Room B / 私聊不可见；
- 私聊 Evidence 的 `ct_` 结论 → 群内不可见；
- Room A + Room B 混合 Evidence → 两群与私聊都不可见；
- Room A + 私聊混合 Evidence → 都不可见；
- 无 Evidence 的 `ct_` 结论 → 群内不可见；
- Source 被删除 / `room_id` 为 NULL → 群内不可见；
- `ct_a` 与 `ct_aa` 精确区分；
- 无文本 `listHeads()`（`recallMemory(db,{kind:'fact'}, scope)`）走同一矩阵。

新增 `test/group-recall-final-check.ts`（或扩展现有 final-check 测试）：

- 群 manifest（sender=乙、roomId=A）注入 Subject=甲的结论 → 通过；
- 同结论注入到 Room B → 拒绝；
- 无 Evidence / 私聊 Evidence → 拒绝；
- `manifest.contactId=null`：仅当前白名单内的可信群、显式一致 Room 和完整同 Room Evidence 可例外；非群/无名单校验/未知绑定仍拒绝。实际群 Adapter 有意使用 NULL Contact 隔离私聊授权。

测试直接 seed `fresh DB + Core.capture({externalRoomId})`，不要走 `resolveContact().roomId`。

---

## 3. H21 夹具修正（必须先做）

文件：`<work>\.tmp-p4d2-host-20261114\probe\index.mjs:63-75`

当前：

```js
const roomId = item.externalRoomId
  ? (await core.resolveContact({ ..., channel: 'group', externalRoomId: item.externalRoomId })).roomId
  : undefined
...
core.capture({ ..., roomId, ... })
```

改为：

```js
// resolveContact 只用来建档联系人；room 由 capture 自己按 externalRoomId 解析
const { contactId } = await core.resolveContact({ platform: 'qq', stableUserId: '31001', channel: 'private' })
...
core.capture({
  platform: 'qq',
  channel: item.channel,
  senderContactId: contactId,
  externalRoomId: item.externalRoomId,   // ← 关键：让 capture 写 room_id
  sessionRef: `scope-fixture-${item.scope}-${i}`,
  origin: 'user',
  kind: 'message',
  text: `${text} ${i}`,
  captureKey: `scope-${item.scope}-${i}`,
})
```

同时把 H21 场景改成 **sender ≠ subject**：由 31002 在 41006 发问、`psyche_recall("D2SCOPE")`
期望只看到 `GROUP_A_ONLY`；41007 的发送者看不到 A 群结论。否则 sender==subject 时
现有 Subject 精确匹配会直接放行，测不出方案 A。

修完后先不改生产代码重跑 H21：

- 预期：`GROUP_A_ONLY` 在 41006 **仍失败**（实际群 Adapter 有意使用 NULL Contact，
  没有甲的私聊授权；Subject=甲仍被原 `scopeConditions` 排除）；41007 不可见；
- 这组「有 Room 绑定、sender≠subject」的失敗才是方案 A 的有效基线。

---

## 4. 最小验收矩阵

| 场景 | A 群 Recall | B 群 Recall | 私聊 Recall |
| --- | --- | --- | --- |
| Subject=甲，全部 Evidence 来自 A 群，提问者=乙 | 允许 | 拒绝 | 拒绝 |
| Subject=甲，全部 Evidence 来自甲的私聊 | 拒绝 | 拒绝 | 允许（甲） |
| Subject=甲，A 群 + B 群混合 Evidence | 拒绝 | 拒绝 | 拒绝 |
| Subject=甲，A 群 + 私聊混合 Evidence | 拒绝 | 拒绝 | 拒绝 |
| Subject=甲，无 Evidence | 拒绝 | 拒绝 | 仅按原 Contact 规则 |
| Evidence Source 缺失 / room_id 为空 | 拒绝 | 拒绝 | 拒绝 |
| Subject=`ct_a` vs `ct_aa` | 精确匹配，不串 | 不串 | 不串 |

每条场景都要覆盖：FTS 文本查询、`listHeads()` 无文本列表、最终注入检查（`final-check`）。

---

## 5. 执行顺序与放行

1. 修 H21 夹具（`probe/index.mjs`），重跑 H21，保存新失败证据；
2. 改 `fts.ts` / `recall.ts` / `final-check.ts`；
3. 补测试，`npm run build`；
4. 跑相关测试（`recall-visibility`、`recall`、`channel-isolation`、`group-host-turn`、新增测试）；
5. 全量 `npm run test`，按逐套件「N 通过」累加计数；
6. 重跑 H21，更新 `docs/audit/p4-d-2-module-acceptance.md` 的 H21 状态；
7. DEV/HANDOFF/AGENTS 记 v27.96（或下一版本号），单独提交。

放行口径不变：H21 PASS 只证明**模块级 + Host 探针**的 Subject/Room Scope 语义；
真实 QQ 多群仍为 NOT VERIFIED，群回复保持默认关闭，D-3 另行验收。

---

## 6. 明确不做

- 不新增 Schema 表、不改 v23 迁移；
- 不启用 `reply.enabled`、不触发群发送、不改 Outbox/Worker；
- 不删除 `final-check` 的 Contact 检查，不引入 `LIKE` 等宽匹配；
- 不改 `visibilityConditions` 的既有来源域规则（它已经是方案 A 的 Evidence 部分）。

## 7. v27.96 执行结果与当时保留边界（历史）

实现 `3481be4`：FTS/单字 LIKE 和无文本列表共用 Subject SQL，最终注入复用原来源域检查并保留 Contact 检查。没有修改 Schema v23、生产配置或 Outbox。

- 修正夹具后逐条复核五条件通过；旧的 Room=NULL 记录保留。真实 Host 使用另一位成员提问，修复前两群误拒，修复后两群均只看到自己 Room 的结论；私聊和另一群均不可见，出站动作 0。
- `recall-visibility` 94/0（原 25，新增 69），新增 `group-recall-final-check` 46/0；独立 build 和全量 **4797 断言 /148 个断言套件/149 步/0 失败**。
- 证据为 `<workspace>/.tmp-p4d2-host-20261114/evidence/h21-v2-*`，10 文件 manifest 与只读数据库副本；详情见 [验收报告](../audit/p4-d-2-module-acceptance.md#8-h21-复验3481be4)。

**NULL 分支保留明确拒绝**：初版 §2.3 示意原本会允许有 Room 的 NULL manifest，而 §2.4 明确要求拒绝；本实现保留后者。现有群 Adapter 的 Contact 本来就是 NULL，因此 H21 工具 Recall PASS、非空 Contact 的最终注入模块 PASS，不等于 Room-only 成员结论自动注入的 Host PASS。该例外尚待用户裁决；在此之前保持拒绝、群回复默认关闭，D-2 不标整体 PASS，不进入 D-3。

## 8. v27.97 白名单裁决与自动注入

用户明确：群在管理页面白名单配置，只有白名单群可以交互。名单使用宿主管理页插件配置的 `qq.groups`，不把 Room 存在或成员私聊许可当成准入。入口、注入前、模型请求前均校验当前有效名单；移除/关闭/异常拒绝，校验函数仅由 Host 提供。

`b8057d6` 据此允许白名单中的可信 Room-only/null Contact 群使用同 Room 成员结论。还补齐 Composer 的 Contact 误拒，群场景复用共享 Subject/来源域规则；非群原 Contact 限制保留。白名单不授予私聊或跨群读取权，也不替代触发/回复开关/静默/限额/输入证明。

本专项节点专用测试105/0（+59），全量4856/148套/149步/0；Schema仍v23/57/34。两群自动注入、零发送、移出名单和关闭群总开关5项Host PASS，见[报告](../audit/p4-d-2-whitelist-injection.md)。NULL待裁决项解除；后续追加记录见下段，生产群回复未启用，不进入D-3。

同版已补生命周期14项及群工具/私聊控制3项Host PASS，合计22项；最终全量4858/148套/149步/0。群只保留具备当前Room校验的recall；旧fetch没有该校验，不进入群schema或执行。整体仍待评审/PARTIAL，生产最终输入证明Producer及真实QQ/D-3不扩大放行。
