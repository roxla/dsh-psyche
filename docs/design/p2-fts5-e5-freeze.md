# P2-FTS5 E5 冻结：模型可见边界与信任边界

- 日期：2026-11-06
- 状态：语义冻结；E5.1 起按本文实现
- 上游：E4 已 PASS（生产 `searchFts()` 在 D3.5 冻结集上 160/160 与 D4-B 一致）
- 本文不改变 D3.5、D4-B、E4 的任何数据与结论

## 1. 三层职责（不能互相替代）

| 层 | 职责 | 不负责 |
|---|---|---|
| 检索层 | 减少错误候选：head/state/disclosure 过滤在 SQL 内、LIMIT 之前 | 不保证模型最终看不到受限内容（上游可能被绕过） |
| Composer 层 | 保证模型看不到不该看的内容：对最终注入做二次校验 | 不负责候选排序质量 |
| 授权层 | 保证模型不能替用户做公开决定：`public` 分类 ≠ 用户授权 | 不负责注入格式 |

E4 证明的是检索层在冻结集上的等价性，不等于 Prompt 注入安全。E5 只处理模型可见边界与信任边界，不调 BM25、证据权重或 D3.5 标注。

## 2. 注入条件（四条件同时满足）

进入模型上下文的内容必须同时满足：

1. 是当前 Artifact Revision（`revision === max(revision)`）；
2. 符合状态准入（默认 `active` / `challenged`）；
3. `disclosure = 'public'`；
4. Scope 与当前 RuntimeInput 匹配。

## 3. Composer 二次校验（不信任候选字段）

上游候选只当作「线索」，所有判定字段一律回库重读：

| 候选字段 | Composer 行为 |
|---|---|
| `revision` | 与库中当前 head 比对；不等 → `stale` 拒绝 |
| `state` | 用库中 head 的 state 判定；不在准入集合 → 拒绝 |
| `disclosure` | 用库中 head 的 disclosure 判定；非 `public` → `disclosure` 拒绝并计泄漏 |
| `statement` | 不采用候选文本，用库中 head 的 statement |
| `contactId` / `channel` | 与当前 RuntimeInput scope 比对；不匹配 → `scope` 拒绝 |

拒绝原因固定为：`stale`（版本已不是 head）、`state`（状态不准入）、`disclosure`（受限/秘密）、`scope`（跨联系人/跨渠道）、`missing`（库中不存在）。

## 4. Scope 规则（共享 Persona ≠ 合并 Contact）

| 数据范围 | 跨渠道 | 跨 Contact |
|---|---|---|
| Persona / 全局记忆 | 按现有共享规则允许 | 不涉及 Contact 私有数据 |
| Contact 记忆 | 仅匹配该 Contact | 禁止 |
| Affinity / Contact Affect | 仅匹配该 Contact | 禁止 |
| Group Context | 按当前群组身份匹配 | 禁止跨群组 |
| Channel / Session 临时上下文 | 仅当前范围 | 禁止 |

身份规则保持 `platform + stable_user_id`：相同显示名不等于同一 Contact；相同 `stable_user_id` 但不同 platform 仍是两个 Contact；未建立明确关联时不自动合并 QQ 用户与 Desktop 用户。

## 5. `public` 的授权语义

区分两件事：

- **分类**：系统依据内容与规则判断 public / restricted / secret。
- **授权**：是否存在可信的用户授权，允许把原本受限的内容提升为 public。

冻结规则：

| 输入 | 预期 |
|---|---|
| 普通非敏感内容，未指定 disclosure | 沿用默认 public 策略 |
| 敏感内容，未指定 disclosure | restricted |
| 敏感内容，模型工具参数显式指定 public | **不得因此自动公开** |
| 敏感内容，存在可信的用户明确授权 | 才允许按授权流程提升为 public |
| 模型自行伪造授权字段或标记 | 拒绝 |

授权凭据由宿主侧可信流程产生（不是模型可填写的布尔字段），必须绑定本次操作与具体内容（artifactId + revision + contentHash + opId），一次性、不可复用、不可跨 Contact；授权前后 disclosure 落审计（谁、在哪个操作、授权了哪条内容、之前的 disclosure）。

E5.3 之前，敏感内容的显式 `public` 只当作「分类请求」，不当作「授权」；实现上先拒绝或以受限落库并标记 `grantRequired`。

## 6. 统计口径（只看最终模型可见上下文）

- **Injection Disclosure Leakage**：restricted/secret 内容出现在最终注入文本中的条数，要求 **0**。分母为所有向 Composer 提供的候选；泄漏路径按 `artifactId + revision + contactId + channel + blockType` 记录，便于反查。
- **Stale Injection Rate**：注入项中 revision 不是当前 head、或 state 不符合准入规则的比例，要求 **0**。
- 与检索层指标分开统计：Candidate Disclosure Leakage 是「检索候选里出现受限」，Injection Disclosure Leakage 是「最终注入里出现受限」。
- 审计字段：`artifactId`、`revision`、`contactId`、`channel`、`blockType`、`decision`、`reason`。

## 7. 测试矩阵

### E5.1 Composer 注入安全

| 场景 | 预期 |
|---|---|
| 当前 head + public + 合法状态 | 允许注入 |
| 当前 head + restricted | 不注入，计入 leakage 候选 |
| 当前 head + secret | 不注入 |
| 旧 revision + public | 不注入（stale） |
| forgotten / retracted / deprecated | 按状态准入拒绝 |
| 上游错误传入 restricted 候选但字段伪造为 public | Composer 回库重读后拦截 |
| 注入文本字符串检查 | 不含受限/秘密原文 |

### E5.2 Contact / Channel 隔离

- Contact A 的私密事项不进入 Contact B 的注入；
- 两个平台相同显示名不合并；
- 相同 stable_user_id 不同 platform 仍是两个 Contact；
- Contact A 的 Affinity/Contact Affect 不注入 Contact B；
- 全局记忆可按设计跨渠道，但不得携带 Contact 私有记忆；
- 未建立明确关联时不自动合并身份。

### E5.3 授权语义

- 普通内容未指定 → public；敏感内容未指定 → restricted；
- 敏感内容显式 public（工具参数）→ 不得自动公开；
- 有效授权只能作用于绑定的目标与操作；
- 伪造授权字段 → 拒绝。

### E5.4 集成回归

| 验收项 | 通过条件 |
|---|---|
| Composer Disclosure | Injection Disclosure Leakage = 0 |
| Revision / State | Stale Injection Rate = 0 |
| Contact Isolation | 跨 Contact 私有信息注入 = 0 |
| Channel Isolation | 不允许共享的 Channel/Session 信息注入 = 0 |
| Authorized Public | 无可信授权时敏感内容不能被显式 public 覆盖 |
| Authorized Public | 有效授权只能作用于绑定目标与操作 |
| E4 Regression | D3.5 冻结集仍 160/160 一致 |

## 8. 执行顺序

E5.0（本文冻结）→ E5.1 Composer（优先解决 Injection Disclosure Leakage）→ E5.2 Contact/Channel → E5.3 授权语义 → E5.4 三组独立报告 + E4 回归。

## 9. 暂不实现（如实标注，不声称）

- Composer 尚未接入真实 Prompt 组装（插件侧注入链路）；E5.1 先验证 Composer 模块本身，接入在 E5.4 后单独评估。
- 物理数据删除（当前只有逻辑遗忘）。
- Injection Disclosure Leakage 的「真实 Prompt」端到端验证需要 Composer 接入后才有；在此之前只证明 Composer 模块的边界。
