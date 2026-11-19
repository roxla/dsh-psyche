# P2-Recall R5：Recall 专用评测设计（冻结稿 v1.0）

> 日期：2026-11-07 · 状态：待用户确认后实施
> 前置：R3 / R3.1 / R4-A / R4-B / R4-C 已完成（模块级）
> 边界：本设计只证明 Recall 本身可靠；真实 Agent / Adapter / QQ / 多插件 E2E 属 R6，不在 R5 范围

## 0. R5 要回答的四个问题

1. 正确的运行表面能不能召回应该看到的记忆？
2. 不应该看到的记忆能不能被可靠排除？
3. 没有合格记忆时能不能正确 abstain？
4. 从 Recall 到 Composer 的决策能不能通过 Receipt 还原？

**不做**：不重新证明 FTS 排序与 D4-B 一致（E4/E5.5-E2 已做）；不追求单一综合分；不为让成绩变好修改 Gold Labels。

## 1. 数据集划分

三份独立数据，共用一份 Corpus：

| 文件 | 内容 | 规模（目标） |
|---|---|---|
| `docs/eval/recall/corpus.jsonl` | 事实族（fact family）种子：Artifact / Revision / Evidence / Source / Event / Contact / Room | 60 族 |
| `docs/eval/recall/queries-quality.jsonl` | 召回质量查询 | 60 条（48 dev / 12 holdout） |
| `docs/eval/recall/queries-safety.jsonl` | Scope / Disclosure / State / Revision / Abstention 安全查询 | 40 条 |
| `docs/eval/recall/evidence-cases.jsonl` | Evidence 口径组合 | 12 组 |

**事实族（fact family）**：同一事实的所有表达、修订、证据、干扰项归为一族。Holdout 按**族**划分（不是随机拆查询），避免同一事实的不同问法同时进调参集和验收集。

冻结：Corpus、Queries、Gold Labels 各自的 SHA-256 写入 `docs/eval/recall/SHA256SUMS`；修改任何一条都要升版本号（`goldVersion`）。

## 2. 质量集字段

| 字段 | 含义 |
|---|---|
| `queryId` | 稳定 ID（`Q-xxx`） |
| `familyId` | 事实族 ID（`F-xxx`），决定 holdout 划分 |
| `query` | 召回文本（自然语言、别名、改写） |
| `surface` | `personal` / `private` / `group` / `global` |
| `contactId` / `roomId` | 可信请求身份（对应 Corpus 中的 Contact / Room） |
| `expectedArtifactIds` | 期望进入结果的当前 head |
| `expectedAbstained` | 是否应 abstain |
| `relevanceGrades` | `{artifactId: 0-3}`，用于 MRR / nDCG |
| `evidenceExpectations` | `{artifactId: 期望 supportEvidenceCount}`（可空） |
| `notes` | 该条为什么存在（覆盖哪类情况） |

覆盖类别：直接表达 / 别名 / 自然语言改写 / 内容相近但不同事实 / 同 Artifact 多 Revision / 多独立 Evidence / 重复来源 / 高相关但 Scope 不符的干扰项 / 有记忆但无权读取。

## 3. 安全集字段

与质量集同结构，另加 `expectation`：`{allowedArtifactIds?, forbiddenArtifactIds?, expectedAbstained, reason}`。

必须覆盖：

| 维度 | 场景 | 验收 |
|---|---|---|
| Personal | personal 表面、本人 private | 只出现允许来源域 |
| Private | QQ 私聊、不同 Contact | 不跨 Contact |
| Group | QQ 群、不同 Room | 不出现成员私聊 / 其他群记忆 |
| Mixed | Private+Group、两个 Contact、两个 Room | 全部拒绝 |
| Unknown | Evidence 存在但 Source 丢失/异常 | 拒绝 |
| Global | 真正没有 Evidence | 按 global 规则准入 |
| Disclosure | restricted / secret | 不进用户可见结果 |
| State | active / challenged / forgotten | 遵守冻结状态规则（challenged 可见带 statusNote；forgotten 不可见） |
| Revision | 历史 Revision vs 当前 Head | 只按当前 Head 判断 |

**安全指标零容忍**：

- `scopeLeakage`：返回集中不属于允许来源域的条数，必须 **0**；
- `disclosureLeakage`：restricted / secret 进入用户可见结果的条数，必须 **0**；
- `headLeakage`：非当前 Head 被召回的条数，必须 **0**；
- `falseAbstention`：有合格 Gold 结果却 abstain 的条数——**单独统计**，不能被安全过滤的成功掩盖。

## 4. Abstention 指标

- `abstentionPrecision = 正确 abstain 数 / 所有 abstain 数`
- `abstentionRecall = 正确 abstain 数 / 应该 abstain 的总数`
- 逐条判定表（queryId / expected / actual / reason）必须保留，不只给百分比。

## 5. Evidence 口径（`supportEvidenceCount` 精确率）

| 组合 | 期望 |
|---|---|
| 同一 `independence_key` 两条 supports | 1 |
| 两个独立 `independence_key` 的 supports | 2 |
| supports + contradicts | 只计 supports |
| 旧 Revision 有支持、新 Head 没有 | 0 |
| 同一来源重复采集 | 1 |
| 多个来源独立支持当前 Head | 按独立 key 计数 |

精确率 = 命中期望的条数 / 总组数；任何一条退回旧 `independent_evidence_count` 口径都记为失败。

## 6. Receipt 链路（10 场景）

| 场景 | 期望 |
|---|---|
| 主动 Recall 有结果 | 有 run；`composition_status=not_applicable` |
| 主动 Recall abstained | 有 run；`abstained=1`；无伪造 Composer 注入 |
| 自动注入有内容 | `pending → completed`；候选回填完整 |
| 自动注入无内容 | `completed`；无虚假 Manifest |
| Composer 预算截断 | `truncated=true` 语义准确 |
| Composer 二次校验拒绝 | 记 `reject_reason`，不冒充 truncated |
| pending 时进程退出 | 下次启动变 `interrupted` |
| 批量回填中途失败 | 整笔回滚；`pending` 保留 |
| HMAC 密钥损坏 | Recall 继续；回执不落库；有警告 |
| 到期清理 | 30 天 run 删除；候选级联 |

另验 HMAC 属性：同密钥同输入同 Hash；查询与 Scope 域前缀不同；轮换后 `keyVersion` 区分；库中无查询/Scope 明文。

**两个状态必须分开报告**：
- Recall 成功但 Receipt 未写入（密钥问题）；
- Recall 本身失败（SQLite 查询异常）。

## 7. 指标与报告格式

| 类别 | 指标 | 是否设门槛 |
|---|---|---|
| 召回质量 | Recall@8、MRR、nDCG@8（dev / holdout 分开） | 先基线，后定门槛 |
| 准入安全 | Scope / Disclosure / Head Leakage | **零容忍** |
| Abstention | Precision、Recall、逐条误判 | 先基线 |
| Evidence | `supportEvidenceCount` 精确率 | 先基线 |
| Receipt | Run 完整率、候选回填完整率、状态一致性 | 先基线 |
| 稳定性 | 回填回滚、pending 恢复、密钥异常 | **必须全过** |

报告 `docs/audit/p2-recall-r5-evaluation.md`：四类分节，不合并成综合分；每节给逐条明细文件路径。

## 8. 实施步骤

1. `docs/eval/recall/build-r5.mjs`：生成 Corpus / Queries / Evidence cases；写入 SHA256SUMS；幂等。
2. `docs/eval/recall/run-r5.mjs`：建临时库 → 灌 Corpus（走 `Core.capture/remember/revise/forget/grantDisclosure`）→ 逐条跑 `Core.recall(query, scope)` 与 `PreStepInjector` → 计算指标 → 输出 `results/r5-quality.json`、`results/r5-safety.json`、`results/r5-evidence.json`、`results/r5-receipt.json`、`results/r5-summary.json`。
3. `test/recall-r5.ts`：把关键不变量（泄漏 0、falseAbstention 0、Evidence 精确率 100%、Receipt 10 场景）做成回归断言，接入 test 串。
4. 报告 + DEV/README。

## 9. R5 / R6 边界

- R5 冻结：评测数据、Gold Labels、Scope 安全结果、Abstention、Evidence 口径、Receipt 链路。
- R6 才验：真实 Agent、真实 Adapter、会话切换、QQ 私聊 / QQ 群、Desktop/Web 表面、多插件共同改消息。
- **R5 通过不等于真实 Agent E2E 通过**；R6 保留「真实 Agent E2E 未验证」独立项。
