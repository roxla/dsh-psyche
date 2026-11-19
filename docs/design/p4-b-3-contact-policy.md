# P4-B-3-0 联系人策略契约（冻结）

- 日期：2026-11-14
- 状态：**B-3-0 CONDITIONAL PASS → 按评审修正后冻结；可直接进入 B-3-1**
- 评审：用户 m17474 接受整体方向；要求修正配置错误语义（重复身份必须明确 deny、无法归属身份必须整体失败关闭、滚动窗口与准入占用需写清），三项已并入本稿。
- 基线：HEAD `abe90f3`、DEV v28.02、Schema v23、全量 5022/152/153/0
- 范围：只做 **QQ 私聊的联系人级行为策略**。不碰 Group/Transport/Relationship/Outbox，不改 Schema，不接 B-4，不改 Host 鉴权与 H-2。

## 1. 目标与非目标

目标：

1. 在既有私聊准入通过之后，按 `(platform, stableUserId)` 精确匹配联系人策略。
2. 支持三种联系人级限制：整体关闭、静默时段、每小时消息上限。
3. 无配置、无匹配、配置错误时，行为与 B-2 完成后一致或更严格，绝不扩大权限。
4. 计数与日志可观测，但不复制消息正文，不影响记忆/人格/关系。

非目标：

- 不做第二套准入；`qq.allowFrom` 仍是必要条件。
- 不做主动联系、离线队列、重试、消息转写/翻译/人格切换。
- 不按昵称、群名片、备注或群成员关系匹配。
- 不写入 Memory/Mood/Relationship，不产生 Evidence，不改 Consent。
- 不做热更新；配置生效点与现有 `qq.*` 配置一致（桥重建/插件重载后生效）。

## 2. 配置契约

配置位于 `qq.contacts`，默认空数组：

```ts
export interface QqContactPolicy {
  /** B-3 只允许 'qq'；缺省视为 'qq'。 */
  platform?: 'qq'
  /** 与 allowFrom 相同：纯数字、首位非 0、最长 20 位；精确字符串匹配。 */
  stableUserId: string
  /** 缺省 true；false 时该联系人所有私聊静默丢弃。 */
  enabled?: boolean
  /** 可选静默时段；有该字段时 timezone 必填。 */
  silence?: {
    timezone: string
    /** 1..6 条 "HH:mm-HH:mm"，左闭右开，允许跨午夜。 */
    windows: string[]
  }
  /** 可选滚动 60 分钟上限，整数 1..240；缺省不限。 */
  maxPerHour?: number
}
```

约束：

- 最多 200 条；重复 `(platform, stableUserId)` 视为该身份配置错误，**两条都无效，对应 Contact 强制拒绝**，不能删掉重复项后回退到默认允许（见 §4）。
- 未知字段、错误类型、空窗口、非法 `HH:mm`、非 IANA 时区、`maxPerHour` 越界都属于配置错误。
- `platform` 在 B-3 只接受 `'qq'`；其他值按配置错误处理，不静默忽略。
- `stableUserId` 只做精确比较；昵称、群名片、QQ 号前导零都不参与身份判断。
- `stableUserId` 缺失/非法导致条目无法归属任何真实 Contact 时，**整个 QQ 私聊策略失败关闭**（不是忽略该条）。
- `qq.contacts` 不是数组或超过 200 条 → **整个 QQ 私聊策略失败关闭**。

## 3. 生效点与顺序

私聊消息路径（`src/lib/qq-bridge.ts` 的 `#handleMessage`）：

1. 现有的类型/临时会话/身份 Claim 闸。
2. **既有准入** `#isAllowed(claim.stableUserId)`；不通过时仍走原拒绝逻辑（固定文案 + 冷却 + 全局额度）。
3. **联系人策略解析**：按 `(claim.platform, claim.stableUserId)` 精确查表；解析结果只有三种：`allow(policy)`、`deny(reason)`、`contactsBlocked`（全局失败关闭）。
4. 策略判定：
   - 整体失败关闭 → 抑制（`CONTACT_POLICY_UNAVAILABLE`）；
   - 命中条目且 `enabled === false` → 抑制（`CONTACT_DISABLED`）；
   - 当前时间落在 `silence` 窗口内 → 抑制（`CONTACT_SILENCE`）；
   - 该联系人滚动 60 分钟已占额度 ≥ `maxPerHour` → 抑制（`CONTACT_RATE_LIMIT`）；
   - 否则**原子占用一次额度**后放行。
5. 放行后才执行现有的 announce、`ensureAgent`、`followup`、绑定与投递计数。额度在进入 announce 前占用；即使后续模型失败或回复失败，也不退回额度（该消息已通过准入，视为一次处理）。
6. 抑制时**不 announce、不建 Agent 会话、不回复、不写 Source/Event、不进入串行队列、不占用额度**；只递增 `contactSuppressed` 计数并记一条限频 info 日志（不含正文）。

顺序不变量：

- 策略永远在准入之后，未授权联系人即使配置了策略也不会进入 Agent。
- 策略只影响「是否投递」，不改变投递后的既有行为（引用、多行、媒体占位、捕获、Mood、关系、记忆）。
- 额度在准入通过、announce 之前原子占用；`delivered` 计数仍在 `followup` 成功后递增，两者不是同一个计数。
- 并发到达时，剩余最后一个额度只能有一个请求占用成功；其余请求必须看到 `CONTACT_RATE_LIMIT`，不能同时通过。

## 4. 配置错误的处理

解析在桥构造时完成一次，结果只读。原则是**配置错误不得扩大权限**；无法确定时，宁可在准入后拒绝私聊，也不回退到默认允许。

| 配置情况 | 处理 |
| --- | --- |
| `qq.contacts` 缺失 | 保持 B-2 原有行为（准入后正常投递） |
| 合法身份、字段合法 | 使用其策略 |
| 合法身份、策略字段非法 | 该 Contact 强制 `enabled:false`（`CONTACT_POLICY_INVALID`） |
| 重复 `(platform, stableUserId)` | 两条都无效，对应 Contact 强制拒绝；不能删除后回退默认允许 |
| `stableUserId` 缺失或非法、无法归属身份 | **整个 QQ 私聊策略失败关闭**（`contactsBlocked`） |
| `qq.contacts` 不是数组或超过 200 条 | **整个 QQ 私聊策略失败关闭** |
| 解析器抛异常 | 全部 QQ 私聊抑制，直到修正配置并重新加载 |

- `contactsBlocked` 只影响 QQ 私聊处理：群采集、其他插件与整个 Host 不受影响；群回复本来 DISABLED。
- 整体失败关闭时，准入仍照旧执行；未授权联系人仍走原拒绝路径，不会因为策略层失败而绕过 `allowFrom`。
- 解析错误不写 Schema、不阻断桥启动；只影响上述判定，并记录一次脱敏告警。

## 5. 时区与窗口

- `timezone` 必须是 `Intl.DateTimeFormat` 可接受的 IANA 名称；校验失败按配置错误处理。
- `windows` 每条为 `HH:mm-HH:mm`；`HH` 00–23、`mm` 00–59；起止相同视为非法。
- 判定用「当前时刻在该时区的本地 `HH:mm`」，起点包含、终点不包含；跨午夜窗口（如 `22:00-07:00`）拆成两段比较。
- 夏令时按指定 IANA 时区的**实际本地时间**判断，由 `Intl.DateTimeFormat` 换算；不写死 UTC 偏移，也不做额外 DST 特判。
- 时区或窗口非法时，对应 Contact 失败关闭（`CONTACT_POLICY_INVALID`），不能退化为“全天不静默”。
- 静默判定在消息到达时执行一次，不在队列等待期间重算。

## 6. 频率限制

- `maxPerHour` 为整数，范围 **1..240**；缺省不限。每个 Contact 独立计数，使用**滚动 60 分钟窗口**（不是整点重置的固定小时桶）。
- 额度在联系人策略通过、进入 announce 之前**原子占用一次**；并发到达时最后一个额度只能有一个请求占用成功。
- 消息一旦准入成功即占用额度，即使后续模型调用或回复失败也不退回；被拒绝、被抑制、群消息、主动 Outbox 发送都不占此额度。
- 达到上限后直接抑制（`CONTACT_RATE_LIMIT`），不排队、不延迟、不补发；下一条在窗口滑出后自然恢复。
- 计数为内存实现，进程重启清零。它是**运行期限频**，不保证跨重启严格 60 分钟配额；不得在文档/管理页/报告中描述为持久化限频。
- B-3 不新增 Schema、不落库；若未来需要持久配额，单独立项。

## 7. 计数、日志与隐私

- 管理页计数新增 `contactSuppressed`（本次进程累计，重启清零），只统计**联系人策略产生的抑制**，不包含既有 `allowFrom` 拒绝。
- 抑制日志只含：`contactRef=maskQqId(userId)` 与固定原因码：`CONTACT_DISABLED`、`CONTACT_SILENCE`、`CONTACT_RATE_LIMIT`、`CONTACT_POLICY_INVALID`、`CONTACT_POLICY_UNAVAILABLE`；不含正文、昵称、完整 QQ 号、stableUserId、sessionId、路径、策略配置内容。
- 日志本身限频（同一联系人同一原因每分钟最多一条），避免高频消息造成日志洪泛；计数仍逐条递增。
- 不新增诊断事件 result（保持 B-5 的 8 态枚举不变），避免 UI/契约扩散；如后续需要逐条诊断，单独立项。
- 不新增 Schema、不新增持久化表；`contactSuppressed` 是进程内计数，卸载/重启归零。

## 8. 与既有契约的关系

- `qq.allowFrom`：仍是唯一准入来源，语义不变；`qq.contacts` 不能替代或覆盖它。
- `unknownPolicy`：未授权来源仍走原拒绝文案与限频，不进入联系人策略。
- 群聊：`qq.groups` 与群运行时不受影响；群成员观察不会生成私聊策略。
- Mood/关系/记忆：联系人策略不读写这些数据；被抑制的消息不会成为 Evidence。
- Transport/Outbox：不涉及；`send_private_msg` 与拒绝回复路径不变。
- 卸载/重载：策略实例随桥销毁；重载后重新解析配置，旧实例不得残留监听或计数。

## 9. 测试矩阵（B-3-3）

解析与配置：

- P01 合法条目与默认值（platform 缺省 qq、enabled 缺省 true）。
- P02 未知字段/错误类型/非法 platform → 该身份拒绝。
- P03 非法时区、空窗口、非法 `HH:mm`、起止相同 → 配置错误。
- P04 `maxPerHour` 0、241、小数 → 配置错误。
- P05 重复 `(platform, stableUserId)` → 对应 Contact 明确拒绝，不退回默认允许。
- P06 非法/缺失 `stableUserId` → 整个 QQ 私聊策略失败关闭。
- P07 200 条上限与超限处理；非数组/超限 → 全局失败关闭。
- P08 解析器异常 → `contactsBlocked`，仅私聊抑制，群采集与其他插件不受影响。

判定：

- R01 `enabled:false` → 不建会话、不 announce、不回复、不写库，`contactSuppressed+1`。
- R02 静默窗口起点包含、终点不包含；跨午夜；时区与 UTC 边界。
- R03 `maxPerHour` 达到上限后抑制，窗口滑出恢复；抑制不占额度；并发争抢最后一个额度只成功一条。
- R04 额度在准入时占用，即使后续失败也不退回；被拒绝/抑制/群消息/Outbox 不占额度。

隔离与兼容：

- I01 联系人 A/B 不同策略互不影响。
- I02 昵称变化不改变归属；`stableUserId` 精确匹配。
- I03 未授权联系人即使有策略配置仍被既有准入拒绝。
- I04 群成员观察不授予私聊策略。
- I05 无配置时既有私聊收发、引用、多行、媒体占位全部保持 B-2 行为。
- I06 配置错误不污染其他 Contact 的 Memory/Mood/Relationship。
- I07 重启后计数清零、策略重新解析。
- I08 卸载/重载无重复监听、无旧策略实例。

Host 验收（可选，不阻塞模块 PASS）：

- H01 真实宿主两份不同联系人策略：A 抑制、B 正常；管理页 `contactSuppressed` 增长。
- H02 重启/重载后行为与计数符合预期。
- H03 既有 QQ 管理页与诊断页不受影响。

## 10. 放行口径

- B-3-0：**CONDITIONAL PASS**，按 §11 三项修正并入后冻结（本稿）。
- B-3-1：解析器 + 策略判定纯模块 + 单元测试（P/R 段）PASS。
- B-3-2：私聊接入 + 回归（R/I 段）PASS，确认无配置等价 B-2。
- B-3-3：模块级全绿 + 全量回归；真实宿主验收可选，未做不宣称 Host PASS。
- 真实 OneBot/宿主差异、B-4、Host API 鉴权、H-2、群回复生产均不在本阶段范围。

## 11. 评审结论

2026-11-14 用户评审：**P4-B-3-0 CONDITIONAL PASS**。五项决策结论：

1. `qq.contacts` 键名与字段：**接受**。
2. 静默时完全不回复：**接受**。
3. 配置错误处理：**部分接受，已修正**——重复身份必须明确 deny；无法归属身份的非法配置必须整体失败关闭；不能删除/忽略后回退默认允许。
4. `maxPerHour` 1..240、滚动 60 分钟：**接受**，已明确准入时原子占用、重启重置、非持久化。
5. 只加 `contactSuppressed` 与脱敏日志：**接受**，日志限频，且不计 `allowFrom` 拒绝。

本稿已并入三项修正，可直接作为 B-3-1 的实现依据，不再单独评审。
