# P5-3b 成长确认生效 · 实施记录（v1）

> 冻结来源：P5-3b 三轮 GPT 问答（2026-11-15）最终「冻结」。
> 范围：只做候选确认/否决/撤回与已确认变化投影；不改 `identity.md`，不自动扩权，不改已有 Artifact Revision。

## 1. 数据模型（Schema v26）

新增 append-only `growth_confirmations`（唯一事实源）：

| 列 | 说明 |
| --- | --- |
| `confirmation_id` | `gcf_…` |
| `candidate_id` / `persona_id` | 指向候选 |
| `decision` | `confirm` / `reject` / `withdraw` |
| `decided_by` | 必须 `os:<SID/UID>` |
| `decided_at` | UTC ISO |
| `content_hash` | 确认时 canonical JSON 哈希 |
| `statement` / `scope` / `evidence_count` | 快照 |
| `sources_hash` | 排序后证据身份哈希 |

同迁移重建 `growth_candidates`：status 扩为 `proposed/superseded/rejected/confirmed/withdrawn`；活动唯一索引仍只约束 `status='proposed'` 且无决策行。

## 2. 决策语义

- **confirm**：候选必须 `proposed` 且无任何决策；必须提供内容哈希；同事务写 `status='confirmed'` + 一条 confirm。
- **reject**：只对未确认候选；同事务写 `status='rejected'` + 一条 reject。失败关闭，不可再确认。
- **withdraw**：只对最新决策为 confirm 的候选；同事务写 `status='withdrawn'` + 一条 withdraw；不删除历史。
- 幂等：相同内容哈希的重复 confirm/reject 返回原结果；内容变化后的旧哈希返回 `E_CONFIRM_HASH_MISMATCH`。

## 3. Owner 身份

- 本机 CLI 不等于 Owner 授权：`decided_by` 必须来自操作系统账户身份（Windows SID / POSIX UID），用户名只用于展示。
- 无法确定身份或与配置不符时拒绝（`E_OWNER_UNVERIFIED`）。

## 4. 投影

- `readConfirmedGrowthChanges(db,{limit:3})` 只返回：最新 confirm、无后续 withdraw、`scope='personal'`。
- `contact:*` / `room:*` 的已确认变化本版不跨域投影；每次投影重新读库，不依赖快照。
- 单行 `最近确认的成长：<statement>（YYYY-MM-DD）`，≤120 字。

## 5. CLI

`node tools/psyche-growth.mjs list --data-dir <DSH_DATA_DIR>`

`node tools/psyche-growth.mjs confirm|reject|withdraw --data-dir <dir> --candidate gca_… --owner <SID/UID> [--hash <sha256>] [--yes]`

- 未给 `--yes` 只预览候选内容、范围、证据数与哈希，不写库。
- `--owner` 必须与当前进程 OS 身份一致；`--hash` 不传时使用预览时计算的哈希。

## 6. 测试

`test/growth-confirmation.ts` 23 断言：confirm/reject/withdraw、幂等、哈希绑定、已确认候选不再被 P5-3a 合并、withdraw 后投影移除、contact scope 不跨域、Owner 标识校验、list 过滤。

## 7. 边界

- 不自动写 Artifact Revision、不改人格核心；后续若要把已确认成长固化为认知，另走既有 Proposal/Revision 流程。
- Host 侧尚无确认入口（面板只读）；CLI 是 P5-3b 唯一写口。
