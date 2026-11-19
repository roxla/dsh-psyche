# P3-C 主动联系设计（C-0 冻结候选）

日期：2026-11-12（D-1 修订）
状态：设计已修订，可进入 C-1；不含实现
契约依赖：`p3-b-c-shared-contracts.md`
基线：DEV v27.73、Schema v19、Git `a6705e9`；修订后 DEV v27.74
修订来源：2026-11-12 人工审阅（Consent 单源、时区归属、七/八项资格、Draft 版本、Dispatch unknown、幂等范围）

## 1. 目标与边界

让 Psyche 在**主人批准**的前提下，对明确同意的联系人发起一次主动消息；不是让模型自己决定找谁聊天。

P3-C v1 的硬边界：

- **不自主发送**：任何消息必须先形成候选、生成草稿、经主人审批，才允许 Dispatch。
- **不越过 P4-A**：出站发送复用 QQ 桥的发送路径，但不复用 `allowFrom` 作为主动授权。
- **不影响 P4-A 入站语义**：准入闸、拒绝文案、限频计数保持原样。
- **不把 Mood 当授权**：`persona` / `scheduled` initiator 只说明情绪来源，不说明可以发消息。

## 2. 权限模型（四道独立闸）

```text
Contact 身份有效
   ↓
通道能力可用（QQ 私聊已连接）
   ↓
主动联系同意（outboundConsent.status === 'granted'）
   ↓
候选 → 草稿 → 主人审批
   ↓
Dispatch（单聊）
```

| 闸 | 回答 | 载体 | 缺失时 |
|---|---|---|---|
| 身份 | 这是谁 | `contacts` + `platform/stable_user_id` | 不产生候选 |
| 通道 | 能不能发 | QQ 桥 connected / 私聊能力 | 候选保持 pending |
| 同意 | 允许被主动联系吗 | **`outboundConsent`（唯一权威）** | 不产生草稿 |
| 审批 | 这一条批不批 | Owner 审批记录（绑定 draft revision） | 不发送 |

- `qq.allowFrom` 只用于入站；**`proactive.allow` 只是 `outboundConsent` 的配置表现，不是第二份事实源**；运行时只看 `outboundConsent`。
- **Owner 把某人加入名单 ≠ 对方同意被主动联系**；同意必须有联系人侧来源（明确表达）或可追溯的本地授权记录。
- 群聊、临时群聊、未知类型不进入本流程（沿用 P4-A Fail-closed）。
- 审批人只能是 owner；模型不能自批、不能伪造审批记录。

## 3. 触发器（Trigger）

v1 只允许三类触发，且全部只产生"候选"，不产生"发送"：

| trigger | 来源 | 说明 |
|---|---|---|
| `owner_request` | 主人明确要求"看看最近可以联系谁" | 最高优先级，但不跳过同意/审批 |
| `scheduled_review` | 定时任务（宿主调度器） | 只扫描候选，不发送 |
| `milestone` | 关系里程碑（如约定到期、长期未联系） | 需事件证据 |

- 触发事件必须带 `triggerId` 与可信 `now`；C-1 只保证**同一输入产生同一 `triggerId` / 同一淘汰结果**，不承诺跨重启"只扫描一次"（跨重启去重留给 C-3 持久化阶段）。
- `scheduled_review` 与 Mood 的 `scheduled` initiator 是两件事：前者只读候选，后者只影响当轮情绪；不得互相推导。
- 不做"聊天中插话式主动联系"；不做群聊触发。

## 4. 资格（Eligibility）

候选产生前依次检查，任一不过即淘汰或进入等待；原因码供审计，不落正文：

| # | 检查 | 原因码 | 不过时 |
|---|---|---|---|
| 1 | Contact 存在且属于当前 persona | `contact-not-found` | 淘汰 |
| 2 | 通道可用（QQ 私聊 connected） | `channel-unavailable` | **等待**，不淘汰资格 |
| 3 | `outboundConsent.status === 'granted'` 且未过期 | `no-consent` | 淘汰 |
| 4 | 有可信的收件人 IANA 时区 | `timezone-unknown` | **等待**，不生成可发送草稿 |
| 5 | 距上次主动消息 ≥ 冷却（默认 7 天） | `cooldown` | 淘汰 |
| 6 | 收件人本地时间在允许窗口（默认 09:00–22:00） | `quiet-hours` | 淘汰 |
| 7 | 当日/当周主动消息额度未满 | `quota` | 淘汰 |
| 8 | 无未处理的重复候选 | `duplicate-candidate` | 淘汰 |

- **时区归属冻结**：静默时段按**收件联系人**的可信 IANA 时区计算；没有可信时区 → `timezone-unknown`，保守地不生成可发送草稿，不得由模型猜测或用 Owner 时区代替。
- **v1 不设独立的"联系人停用/拉黑"检查**：`contacts` 没有 active 列，关系 Artifact 也不能当操作状态；资格失效以 `outboundConsent` 撤回/过期为准。将来需要独立停用功能时再定义唯一权威状态源并审查迁移。
- **通道不可用 ≠ 没有资格**：通道离线只让候选保持等待；联系人恢复在线后可继续，不需要重新判定同意。
- 冷却与额度按联系人 + 全局两层；默认每联系人 7 天 1 次、全局每天 3 次、每周 10 次（可配）。
- 所有时间由调用方传入 `now`；纯函数不得读系统时钟。

## 5. 候选与排序（Candidate）

```ts
interface ProactiveCandidate {
  candidateId: string
  contactId: string
  reasonCode: 'reconnect' | 'milestone' | 'owner-request' | 'care'
  score: number            // 只用于排序，不是权限
  evidence: string[]       // source_id / event_id / artifact_id
  createdAt: string
}
```

- 评分输入：Affinity 档位、Trust 档位（未评估按最低权重）、最近互动间隔、未兑现约定、Contact Affect 强度。
- 评分只影响"先看谁"，不改变资格、不改变审批要求。
- 排序稳定：同分按 `contact_id` 字典序；不依赖对象遍历顺序。
- 候选上限：单次扫描最多 20 条；超出截断并记录。
- **C-1 的 `candidateId` / `triggerId` 由输入确定性推导**（同一输入 → 同一 ID），只用于纯函数内部与测试；不承诺跨重启"只出现一次"。

## 6. 草稿（Draft）

```ts
interface ProactiveDraft {
  draftId: string
  revision: number          // 每次编辑 +1；审批必须绑定 revision
  candidateId: string
  text: string
  tone: string              // 来自 P3-A 投影，仅影响措辞
  evidence: string[]
}
```

- 草稿只能引用候选里已有的证据；不得编造事实、承诺或时间。
- 语气可受 Mood 影响，但草稿内容不得因 Mood 改变事实/请求/边界。
- **长度与审批一致**：草稿正文 ≤ 500 字；超过时先生成精确分段预览（每段 ≤ 500 字），Owner 审批看到的分段必须与实际发送完全一致，不允许审批一份文本、发送另一种切分。
- 同一候选只生成一份待审草稿；**编辑产生新 revision，不覆盖旧稿**。

## 7. 审批（Approval）

```ts
interface ProactiveApproval {
  approvalId: string
  draftId: string
  draftRevision: number     // 绑定具体 revision
  decision: 'approved' | 'rejected'
  decidedBy: string         // owner
  decidedAt: string
  note?: string
}
```

- 审批在主人侧完成（Web 面板 / 管理指令）；模型只能读取状态，不能写入 decision。
- **审批只对绑定 revision 有效**：编辑草稿产生新 revision，旧审批自动失效，必须重新审批；发送前复核 `draftRevision` 完全一致。
- `approved` 后 24 小时内未发送则自动失效，需重新审批。
- `rejected` 记录原因码，不反复生成同一候选（至少 7 天内不重复）。
- 审批与发送都必须幂等：同一 `approvalId` 只能产生一次 Dispatch。

## 8. 发送（Dispatch）

```ts
interface DispatchReceipt {
  dispatchId: string
  approvalId: string
  draftId: string
  draftRevision: number
  channel: 'qq-private'
  status: 'dispatching' | 'sent' | 'failed' | 'unknown'
  attemptedAt: string
  sentAt?: string
  messageId?: string
}
```

- 只走 QQ 私聊；群聊不开放。
- 发送前再次检查：审批有效且 revision 一致、联系人仍有同意、额度未满、通道在线。
- **发送结果分四态**：
  - `failed`：明确失败（连接错误 / 平台拒绝），不自动重试，交主人重新处理；
  - `unknown`：超时、ACK 丢失、结果不明，**不得直接回到待发送**；先核验 QQ 端是否已收到（查最近消息 / 回执），确认未收到才允许重新审批发送；
  - `dispatching`：已发出、等待回执；进程重启后按 `unknown` 处理；
  - `sent`：已确认送达，写回执（含 OneBot `message_id` 如有）。
- 回执不进入 Capture 的"用户消息"语义。

## 9. 与 P4-A 的接口

- P4-A 提供：连接状态、私聊发送能力、入站准入、五项拒绝计数。
- P3-C 提供：候选/草稿/审批/回执；**不修改** P4-A 的 allowFrom、拒绝文案、限频计数。
- 出站发送必须使用独立的 `proactive` 配置段，不与 `qq.allowFrom` 共用字段。
- 真实发送联调只在 P4-A 发送链路验收通过后进行（C-3 之后）。

## 10. 阶段拆分

| 阶段 | 内容 | 依赖 |
|---|---|---|
| C-0 | 本冻结稿 + 共享契约 + 测试矩阵 | 人工审阅 |
| C-1 | Trigger / Eligibility 纯函数 + 原因码 + 确定性结果 | 无（可与 P3-B 并行） |
| C-2 | Candidate 排序 / Draft 生成与 revision（Mock Contact + Mock Evidence） | C-1、P3-B Contact 查询契约 |
| C-3 | Approval / Dispatch（Mock OneBot 先行；含 failed/unknown 核验） | P4-A 发送链路验收 + C-1/C-2 |
| C-4 | 真实宿主验收（独立 profile + 专用测试联系人） | C-3 |

- C-1 / C-2 不落库、不发送；C-1 只承诺确定性结果，不承诺跨重启"只扫描一次"。
- C-3 之前不改 Host/Adapter，不新增发送工具。

## 11. 验收要点

- 四道闸任一不过 → 不产生 Draft / 不发送；原因码可审计。
- Mood 变化不能改变资格或跳过审批。
- 同一 trigger / candidate / approval 重放不重复。
- 审批过期、联系人撤同意、通道离线 → 不发送，状态可解释。
- 发送失败不自动重试、不重复扣额度。

## 12. 不做

- 不做无人审批发送、不做群聊主动消息、不做多平台同时发。
- 不做"关系分数越高越免审批"。
- 不在 C 阶段修改 P2 记忆、P3-A Mood、P4-A 入站语义。
