# P5-R-4 四条核心运行时链路端到端验收

状态：FROZEN（2026-11-15）
基线：`bc6f1df` / DEV v28.22 / Schema v30 / 5481 断言 / 165 套 / 166 步 / 0
范围：只验收，不改 Schema、不新增功能、不绕过 Host、不伪造 Provider 输入。

## 1. 环境

| 项 | 值 |
|---|---|
| DSH_HOME | `D:/project/psyche/.tmp-r4-host` |
| profile | `psyche-r4`（由 b33 复制，独立 dataDir） |
| 宿主端口 | 62091 |
| OneBot mock | 62092（仅 R-4b/R-4d 需要） |
| 测试身份 | QQ 10001 / 群 20001，fake token |
| 真实数据 | 不读写；不碰 `<DSH_HOME>/psyche` |

## 2. 证据模型

三层，任何一层不能替代另一层：

1. **模块测试**：`npm run test` 中的相关套件。
2. **Host 注入**：当前轮 `runtime-context` 快照；每次记录必须绑定
   `agentId`、`sessionId`、`turn`、`assemblyId`、正文哈希。
3. **Provider 最终输入**：H-2 未解，统一记 `PARTIAL`；不得用模拟 Adapter 冒充。

判定只看**当前轮**快照：取该轮最后一条 `runtime-context`，不累计历史。

## 3. 验收矩阵

### R-4a 人格

| ID | 场景 | 通过条件 |
|---|---|---|
| A1 | 可信绑定 Agent | persona 块恰 1 次；正文与 `identity.md` 做字符级 SHA-256 一致 |
| A2 | 未绑定 Agent | persona 块 0 次 |
| A3 | 漂移阻断 | 改 identity.md 后下一轮 persona 0；恢复一致后重现 |
| A4 | 同轮多次 assemble | 只出现 1 次 |
| A5 | 卸载/重载 | 无重复、无残留 |

### R-4b 记忆

| ID | 场景 | 通过条件 |
|---|---|---|
| B1 | 全链 | 目标 Evidence 的正文/ID 出现在当前轮 Context；Source→Artifact→Recall 可追溯 |
| B2 | 跨 Contact/Room | 另一 Contact/Room 的 Source 不召回 |
| B3 | 归档 | archive 后 recall 0；restore 后恢复 |
| B4 | 外部来源删除 | delete 后 recall 0 |
| B5 | 多轮 | 同一 Evidence 不重复追加 |

### R-4c 心情

| ID | 场景 | 通过条件 |
|---|---|---|
| C1 | 进入档位 | 用 `computeMoodBehavior` 按固定 mood/Affect/previousBand/turn 算预期，快照与预期一致；不预设具体档位 |
| C2 | 逐轮回落 | 每 Turn 最多变化一档，验证衰减轨迹，不要求立即 balanced |
| C3 | 同 Turn 多次 assemble | 档位不推进 |
| C4 | Turn 递增 | 按预期推进 |
| C5 | 不改变事实/权限 | 人格、记忆块仍在；无权限文本 |

### R-4d 成长

| ID | 场景 | 通过条件 |
|---|---|---|
| D1 | 规则内候选 | 新增独立 Evidence 的 fact revision 或 stance revision>1，生成候选 |
| D1b | 反例 | 助手 Source / 重复 trigger / 无新增 Evidence → no_change，无候选 |
| D2 | 未确认 | 候选不投影 |
| D3 | Owner confirm | 下一轮出现该候选的 statement 与 scope（不只标题） |
| D4 | withdraw | 下一轮消失 |

### R-4e 联合

| ID | 场景 | 通过条件 |
|---|---|---|
| E1 | 同一会话 | persona、memory、mood、growth 各 1 次共存 |
| E2 | 预算/去重 | 超预算按冻结顺序丢弃；无重复块 |
| E3 | 生命周期 | 卸载/重载无残留 |
| E4 | DB 不可用 | 聊天不中断；Memory/Growth/Mood 安全降级；无回执泄漏；Persona/纪律按独立条件判断，不关闭纪律 |
| E5 | 证据版本化 | 每轮记录含五元组，可复算 |

## 4. 判定

- 每项 `PASS` / `PARTIAL` / `BLOCKED`；模块测试通过不等于 Host PASS。
- 真实 Provider 输入被 H-2 阻塞：相关项最多 `PARTIAL`，理由必须写 `BLOCKED_BY_HOST_CAPABILITY`。
- 发现缺陷：先保留复现证据（日志、快照、哈希），再最小修复；修复另开提交，不顺带扩 Schema/功能。

## 5. 非目标

- 不改 `app.asar`、不绕过 Host 安全边界。
- 不新增 Schema、不新增模型调用、不做备份/擦除新功能。
- 不用探针 Adapter 的结果代替真实 Provider 最终输入。

## 6. 冻结记录

- 第 1 轮：提交上述矩阵；GPT 提四项修正（心情按评分规则算预期、成长需满足 P5-3a 规则并加 no_change 反例、DB 故障不得要求全部投影消失、Host PASS 必须验证内容而非 marker 并绑定 Agent/Session/Turn/Assembly ID）。
- 第 2 轮：逐项接受并写入矩阵；GPT 回「冻结」。
- 未决：真实 Provider 输入（H-2）保持 `PARTIAL`，不在本阶段解决。
