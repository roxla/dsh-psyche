# P4-D-2 生产 Provider 最终输入证明接入方案

> 状态：**设计有条件批准（2026-11-14），Host 接口待实现验证**。只设计接入边界，不启用真实群回复、不改 Schema、不进入 D-3。
> 基线：DEV v27.97，head `70cf275`，Schema v23 / 57 表 / 34 触发器，4858 断言 / 148 套 / 149 步 / 0 失败。
> 关联：`docs/design/p4-d-2-scheduling-freeze.md` §5.1/§5.2、`docs/audit/p4-d-2-module-acceptance.md`、`docs/audit/p4-d-2-host-lifecycle.md`。
> 阶段状态：`P4-D-2 module = PASS`；`P4-D-2 production proof = BLOCKED_BY_HOST_CAPABILITY`；`Group reply = DISABLED`；`P4-D-3 real QQ groups = NOT VERIFIED`；`Schema = v23`；`Regression baseline = 4858 / 149 / 0`。
> Host 契约：见 [dsh-llm call boundary 契约](dsh-llm-call-boundary-contract.md)（H-1 冻结稿）。

## 1. 目标与非目标

### 1.1 目标

把「群批次消息确实完整进入真实 Provider 的最终模型请求」从**本地探针能力**变成**生产能力**：

1. 定位真实 Provider 的最终请求边界：所有 `llm/stream` 中间件、注入、压缩、重试之后，真正交给 Adapter 的冻结 `GenerateOptions`。
2. 在该边界为每次请求 attempt 生成进程内不可伪造的 input / finish 回执。
3. 证明三件事：本批投影完整进入请求；该请求以 `finish.stop` 结束；对应 Turn 以 `completed` 结束且 Host 刷盘成功。
4. 任一条不成立时，批次 incomplete：不推进 `model_processed`、不产生回复。

### 1.2 非目标

- 不打开群回复（`reply.enabled` 仍默认 `false`，生产发送仍关闭）。
- 不进入 D-3，不接真实 QQ 多群，不发送任何群消息。
- 不修 Host API 认证 PARTIAL，不注册 Outbox Worker，不改群工具面。
- 不替换、不代理、不伪造任何第三方 Provider Adapter。
- 不防御同进程任意恶意插件；只证明受信执行链的实际入口（与 D-2-0 的边界一致）。

## 2. 现状与缺口

### 2.1 已经成立的部分

- `GroupInputBoundary`（`src/lib/group-input-boundary.ts`）已在真正的 Provider `stream` 外面做校验：
  - 必须恰好一条本批 `message.id`、`role=user`、`source.kind='user'`、单个 text 等于投影；
  - provider/model 必须匹配；tools 只允许 `psyche_recall`；
  - 记录 `requestHash=sha256(canonical({version:1,messages,system}))`；
  - 观察 `finish` 块并记录 finish 回执；无 finish、双 finish、epoch 失效均抛错。
- `GroupHostTurns` 在 `agent/pre-step` 用 Host 真正领取的 `message.id` 绑定 batch/turn/step（`src/lib/group-host-turn.ts:51-73`），并在 `turn/end` 后核对 `finish==='stop'`、`sessions.flush()`、持久历史 hash，再 `complete` / `prepare-reply`。
- 调度入口已有双重闸：默认 `reply.enabled=false` 不启动；缺 `psycheGroupInputProof` 时 `GROUP_PROOF_UNAVAILABLE` 退回只采集（`src/lib/qq-group-runtime.ts:18-24`）。

### 2.2 生产缺口

- 仓库里没有生产 `psycheGroupInputProof` Producer；只有 D-2 探针通过注册自有 Adapter（`group-fixed`）实现。
- Host 目前的 `LlmRuntime.adapterStream()`（`dsh-llm/lib/index.js:1327-1341`）直接调用 `adapter.stream(this.forAdapter(resolvedOptions, adapter))`，**在 Adapter 边界没有任何可注册的观察/证明钩子**。
- 唯一现成钩子是外层 `llm/stream` waterfall（`streamWithRegistration`，`lib/index.js:1388-1390`）。D-2-0 已明确：**只在外层取快照不满足要求**（`p4-d-2-scheduling-freeze.md:174`），因为后续 listener 仍可修改 `options`，且无法证明 Adapter 实际收到的就是被哈希的内容。
- `GenerateOptions` 没有 `turn/step/requestId`（`lib/types/types.d.ts`），因此证明必须依赖 `agent/pre-step` 的 `message.id` 与进程内绑定，不能猜「最近一轮」。

结论：**要接生产 Provider，Host 必须新增一个 Adapter 边界的受信钩子；仅靠 Psyche 侧无法在不替换 Adapter 的前提下满足契约。**

## 3. 设计原则

1. **边界必须在 Adapter 调用点**：位于所有 `llm/stream` 中间件之后、`adapter.stream()` 之前，且看到的是 Adapter 实际收到的冻结对象。
2. **证明者不能改写请求**：Host 传给 boundary 的 `next()` 固定使用同一个冻结 `options`；boundary 只能校验、记录、包裹流，不能替换 messages/system/tools/provider/model。
3. **每次 attempt 独立**：Host/Adapter 的每次重试都重新进入 boundary，生成新的 `attemptId`；最终回复只认与 `finish.stop` 同一 attempt 的 input/finish 对。
4. **Fail-closed**：配置缺失、注册失败、未绑定、投影不一致、工具面异常、无 finish、双 finish、epoch 失效、刷盘失败，全部不确认、不发送。
5. **不新增正文副本**：证明只存 hash、身份、状态；`payload_text`/正文不进日志。
6. **Host 缺失即只采集**：Psyche 必须 feature-detect；Host 不提供边界时记录 `GROUP_PROOF_UNAVAILABLE`，行为与今天一致。

## 4. Host 改动范围（`@deepseek-ai/dsh-llm`）

> 本机 DSH 为打包产物；以下为上游源码改动清单，版本号由 Host 维护者决定。
> 若 Host 不接受该能力，D-2 生产回复继续保持关闭——不采用外层 hook 或 Adapter 替换的变通。

### 4.1 新接口

`LlmRuntime`（`lib/index.js`，类型 `lib/types/index.d.ts`）新增：

```ts
export interface LlmCallBoundary {
  /** 稳定标识；注册后不可变。 */
  readonly id: string
  /**
   * 在真正 Adapter stream 之前调用一次。
   * - options 是 Adapter 将收到的同一冻结对象；不得修改。
   * - next() 只能调用一次，返回 Adapter 的原始 chunk 流。
   * - 必须返回一个会正常结束的 async iterable；finish 语义由 Adapter 产生。
   */
  stream(
    options: Readonly<GenerateOptions>,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk>
}

registerCallBoundary(providers: string[], boundary: LlmCallBoundary): () => void
```

语义：

- 每个 provider 最多一个 boundary；重复注册抛 `LlmError('DUPLICATE_CALL_BOUNDARY')`，整批 all-or-nothing。
- 注册是 `ctx.effect()` 作用域，插件卸载/重载自动释放；重复注册同一 provider 必须先 dispose。
- 不暴露给 tools/HTTP/模型上下文；只给已加载插件代码使用，信任级别与 `registerAdapter` 相同。
- boundary 不参与路由选择，不改变 retry policy，不做能力协商。

### 4.2 调用点

`adapterStream()`（`lib/index.js:1327-1341`）改为：

```js
const adapter = registration.adapter
const actual = this.forAdapter(resolvedOptions, adapter)
const boundary = this.callBoundaries.get(actual.provider)
let iterator
if (boundary) {
  let called = false
  const next = () => {
    if (called) throw new LlmError('boundary called next() twice', 'INVALID_CALL_BOUNDARY')
    called = true
    return adapter.stream(actual)
  }
  iterator = boundary.stream(deepFreeze(actual), next)[Symbol.asyncIterator]()
} else {
  iterator = adapter.stream(actual)[Symbol.asyncIterator]()
}
```

- `actual` 必须与 Adapter 收到的完全一致（含 `forAdapter` 的 replay-state 裁剪），boundary 的 hash 才等于真实请求。
- boundary 自身抛错 → 与 Adapter 抛错一样归一为 terminal `finish{kind:'error'|'aborted'}`；不向调用方泄露正文。
- 外层 `llm/stream` 不变；boundary 在其内侧。
- `next()` 二次调用直接抛错，避免一个请求产生两段真实流。

### 4.3 Host 测试

- 注册校验：空 providers、重复 provider、dispose 后重注册。
- boundary 收到的是 `forAdapter` 之后的冻结对象；`next()` 返回的流与不装 boundary 时逐 chunk 一致。
- 外层 `llm/stream` 修改 options（模拟现有截断演练）后，boundary 看到的是被修改后的最终对象——用于证明「外层 hook 不能替代内层证明」。
- boundary 抛错/abort、`next()` 二次调用、boundary 返回空流的行为。
- 卸载/HMR replace 后 boundary 消失，请求回到无 boundary 路径。

## 5. Psyche 改动范围

### 5.1 新文件 `src/lib/group-production-proof.ts`

职责：把现有 `GroupInputBoundary` 接到 Host 的 Adapter 边界，并作为 `psycheGroupInputProof` 服务提供。

```ts
createProductionGroupInputProof(input: {
  llm: LlmBoundaryHost        // registerCallBoundary 的宿主服务
  provider: string
  model: string
  onUnavailable(code: string): void
}): {
  boundary: GroupInputBoundary | null
  dispose(): void
}
```

行为：

1. 校验 `provider`/`model` 非空；缺失 → `onUnavailable('GROUP_PROOF_CONFIG_MISSING')`，返回 `boundary:null`。
2. Host 无 `registerCallBoundary` → `onUnavailable('GROUP_PROOF_HOST_CAPABILITY_MISSING')`，保持只采集。
3. 构造 `GroupInputBoundary(provider, model)`，调用 `registerCallBoundary([provider], {id:'psyche-group-input-proof', stream:(options,next)=>boundary.wrapFinal(options,next)})`。
4. 注册成功后才 `ctx.provide('psycheGroupInputProof', boundary)`；dispose 先解绑 Host 再撤销服务。
5. 不修改 options、不缓存正文、不写日志正文；只允许记录 batchId/outboxId/attemptId/状态码。

### 5.2 `GroupInputBoundary` 增量

新增 `wrapFinal(options, next)`（或让 `wrap` 接受 `() => AsyncIterable`）：

- 与 `wrap` 相同的校验；
- `requestHash` 对 `options` 做冻结深拷贝后计算；
- 调用 `next()`（不带参数），不得调用 `boundary.wrap` 现有的「以改写后 options 重新调用 stream」路径；
- finish/attempt 逻辑复用；错误码保持不变。

### 5.3 `src/index.ts` 接线

- `inject` 增加 `llm`（当前只有 `tools`）。
- 插件启动、`ensureGroupRuntime` 之前创建 proof；仅在 `qq.provider && qq.model` 时注册。
- 将 `boundary` 通过 `ctx.provide('psycheGroupInputProof', boundary)` 暴露给 `startQqGroupRuntime`。
- 卸载 effect：先停群运行时，再 dispose proof（解绑 Host、撤销服务），最后停桥/关库。
- 配置变更走插件重载；不实现运行中热切换 provider/model（避免正在进行的 Turn 使用旧 provider 却被新 boundary 判定不匹配）。

### 5.4 不改动

- `qq-group-runtime.ts`：现有 `host.get('psycheGroupInputProof')` + `isGroupInputBoundary` + `available()` 身份检查保持。
- `group-host-turn.ts`：`bind` / `receipt` / `complete` 逻辑保持；仅新增错误码告警映射。
- `group-scheduling.ts` / Schema v23：不改。
- 发送路径：不改；`reply.enabled` 仍默认 false，D-3 前不打开。

## 6. 证明链（生产）

```text
GroupScheduler.claim
  → agent.followup(message{id=batch.message_id})
  → agent/pre-step: 确认 message.id 被领取
      → boundary.bind(snapshot, turn, step)
      → groupSchedule(bind-turn)
  → agent loop → llm.stream(options)
      → llm/stream middleware（注入/压缩/截断等）
      → Host adapterStream
          → boundary.wrapFinal(最终冻结 options, next)
              → 校验本批 message/投影/tools/provider/model
              → groupSchedule(receipt: input, attemptId, requestHash)
              → next() → Adapter 真实流
              → finish 块 → groupSchedule(receipt: finish)
  → agent/turn end → turn/end.reason.kind=completed
  → GroupHostTurns.#end: latest finish=stop + sessions.flush=true + 持久历史 hash
      → groupSchedule(complete) → model_processed
      → groupSchedule(prepare-reply)（仅当 reply.enabled，仍受发送闸）
```

- attempt 失败后重试：新 attempt 新 `attemptId`；只有最终成功 attempt 的 input/finish 对参与 `complete`。
- compaction/session-title 调用：boundary 直接放行，不产生 input/finish 回执，也不能满足批次。
- 非群 Session：直接放行，不记录。

## 7. 失败与降级矩阵

| 场景 | 行为 | 批次/回复 | 证据 |
| --- | --- | --- | --- |
| 未配置 provider/model | `GROUP_PROOF_CONFIG_MISSING`，不注册 | 只采集，不启动群运行时 | warn + status |
| Host 无 `registerCallBoundary` | `GROUP_PROOF_HOST_CAPABILITY_MISSING` | 只采集 | warn |
| 注册冲突/异常 | `GROUP_PROOF_REGISTER_FAILED` | 只采集 | warn |
| 群 Session 请求未绑定 | `GROUP_INPUT_NOT_ARMED` | 请求失败，incomplete | 事件/错误 |
| 投影/消息/tools/路由不匹配 | `GROUP_INPUT_PROOF_MISMATCH` / `GROUP_TOOL_SURFACE_UNAVAILABLE` | 请求失败，incomplete，不发送 | 错误码 |
| 外层中间件截断投影 | 同上（boundary 看到截断后的最终对象） | incomplete | 错误码 |
| Adapter error/abort | finish=error/aborted，无 stop | incomplete | finish 回执 |
| 无 finish / 双 finish | `GROUP_REQUEST_INCOMPLETE` / `GROUP_DOUBLE_FINISH` | incomplete | 错误码 |
| 重试后成功 | 仅最后成功 attempt 参与 complete | 可确认 | 两 attempt 回执 |
| Turn 未 completed / flush false | `GROUP_TURN_NOT_COMPLETED` / `GROUP_PERSISTENCE_UNAVAILABLE` | incomplete | 事件 |
| epoch 失效/卸载 | `GROUP_STALE_EPOCH` / 服务消失 | 中断，不发送 | 事件 |
| 重启后 dispatching | 既有恢复：`dispatching→unknown` | unknown，不重发 | 既有逻辑 |
| 白名单撤销 | 发送前门禁拒绝 | 不发送；处理证明可保留 | 既有门禁 |
| 跨 Room/旧绑定 | 不匹配，拒绝 | incomplete | 错误码 |
| 群回复未开启 | 不启动群运行时，无需证明 | 只采集 | 配置 |

## 8. 测试矩阵

### 8.1 模块测试（无 Host，新 `test/group-production-proof.ts`）

| 编号 | 用例 | 期望 |
| --- | --- | --- |
| P-01 | 非群 session 请求 | 原样放行，无回执 |
| P-02 | `qq-group-*` 未绑定、普通对话 | `GROUP_INPUT_NOT_ARMED` |
| P-03 | 已绑定但 `purpose=compaction/session-title` | 放行，不产生回执，不满足批次 |
| P-04 | 精确投影/消息/tools/provider/model | 产生 input 回执；hash 与 canonical 一致 |
| P-05 | 投影被截断/替换/多一条 user 消息 | `GROUP_INPUT_PROOF_MISMATCH` |
| P-06 | tools 含 recall 之外工具 | `GROUP_TOOL_SURFACE_UNAVAILABLE` |
| P-07 | provider/model 不匹配 | `GROUP_INPUT_PROOF_MISMATCH` |
| P-08 | 双 finish / 无 finish | `GROUP_DOUBLE_FINISH` / `GROUP_REQUEST_INCOMPLETE` |
| P-09 | 首次 attempt error、二次 stop | 两条 input、两条 finish；仅 stop 可 complete |
| P-10 | epoch 在流中途失效 | `GROUP_STALE_EPOCH` |
| P-11 | 冻结 options 下 `next()` 只调用一次 | Adapter 收到的对象/hash 与 boundary 一致 |

### 8.2 Host seam 测试（`dsh-llm` 自身测试）

| 编号 | 用例 | 期望 |
| --- | --- | --- |
| H-01 | 注册 boundary 后请求 | boundary 先于 Adapter 调用，chunk 与非 boundary 一致 |
| H-02 | 重复注册同 provider | `DUPLICATE_CALL_BOUNDARY` |
| H-03 | 外层 `llm/stream` 改写 options | boundary 看到改写后的最终对象（证明外层不能替代） |
| H-04 | boundary 抛错/abort | terminal finish error/aborted |
| H-05 | `next()` 二次调用 | `INVALID_CALL_BOUNDARY` |
| H-06 | dispose/HMR reload | boundary 移除，后续请求走原路径 |

### 8.3 隔离 Host 集成（现有 `.tmp-p4d2-host-*` 框架扩展）

| 编号 | 场景 | 期望 |
| --- | --- | --- |
| I-01 | Psyche 注册生产 boundary + 固定 Provider（同名路由） | input/finish 回执、turn/end completed、flush true、model_processed 推进 |
| I-02 | 不注册 boundary | 群运行时不启动，只采集 |
| I-03 | 流中途卸载插件 | 请求中断，无发送，batch interrupted/unknown |
| I-04 | claim 后杀宿主重启 | `dispatching→unknown`，不重发，不补造回执 |
| I-05 | Turn 中途撤销白名单 | 不发送；处理证明保留 |
| I-06 | 旧 Room/跨群绑定 | 拒绝，不产生回执 |
| I-07 | 外层截断投影后进入 Adapter | 证明 mismatch，incomplete，不发送 |
| I-08 | Adapter error / 无 finish | incomplete，不发送 |
| I-09 | compaction 辅助调用 | 不产生回执，不影响批次 |

### 8.4 真实 Provider 冒烟（可选，不阻塞 D-2）

- 使用真实 Provider，在专用测试群、`reply.enabled=false` 以外的最小配置下只验证「input/finish 回执 + completed + flush」；
- 不发送、不打开真实 QQ 群回复；
- 若 Provider 重试/代理行为不可控，记录差异并保持 D-2 PARTIAL。

## 9. 完成判据与放行

- 模块 P-01..P-11、Host H-01..H-06、隔离集成 I-01..I-09 全过；
- 全量测试保持 0 失败；Schema 不变（仍 v23/57/34）；
- 报告 `docs/audit/p4-d-2-production-proof.md` 记录证据与未覆盖项；
- **D-2 仍不标整体 PASS**：生产群回复保持关闭，真实 QQ 群 NOT VERIFIED，D-3 另行评审。

## 10. 待确认（交 Host/用户）

1. Host 是否接受 `registerCallBoundary` 这一最小接口；是否愿意在 `dsh-llm` 上游补测试与版本。
2. boundary 是否需要携带 provider 级 `id` 供审计；是否需要拒绝同一进程内两个插件争抢同一 provider。
3. 生产配置中 `qq.provider/model` 为空时的行为：维持只采集（本方案）还是拒绝启动群采集。
4. 真实 Provider 的 Adapter 是否会重试同一请求；重试时 attempt 计数与 `maxTurnsPerHour` 的关系是否需要在 D-2 报告里单列。

## 11. 评审后冻结的补充约束（2026-11-14）

用户评审结论：**设计有条件批准，Host 接口待实现验证**；三项决策按以下条件批准。

### 11.1 Host 接口四项运行时契约

A. **`Readonly` 不等于运行时冻结**：证明范围是 Adapter 实际接收的输入，不是 Provider 发往远端的网络字节。Host 必须让证明与 Adapter 使用同一个 `resolvedOptions`（同一对象引用或等价不可变快照），且验证与 Adapter 调用之间不得重新选择 Provider、重新组装参数；`next()` 只能调用捕获的 `adapter.stream(actual)`。若深冻结破坏现有 Provider，必须评估兼容性，不能默默退回可变对象。

B. **单次调用 + 单次消费**：同一 boundary invocation 中 `next()` 最多一次；不允许同一结果流被重复订阅导致重复 Adapter 调用；`next()` 未执行不能签发「已到达 Adapter」的输入证明；Adapter 异常、流中断、无正常完成信号不能生成成功完成回执。这些由 Host 执行，不能只靠 Psyche 约定。

C. **绑定最终解析的 Provider/Model**：`qq.provider/model` 是配置值，可能与实际路由不一致（别名/重定向/fallback）。群 Turn 的证明必须核对最终选定的 Provider 和模型，无法核对时失败关闭；非群请求正常通过。群请求与普通请求的区分必须由受信调用关联信息确定，不能只信普通调用方可填的 `purpose` 字符串。

D. **注册生命周期**：`registerCallBoundary` 返回幂等 `dispose()`；同 Provider 重复注册直接拒绝；多 Provider 要么全成功要么全失败；卸载时先停止接受新群 Turn、使旧 epoch 失效，再撤销服务与注册；已在途的 Adapter 流必须明确继续正常结束还是被终止，不能产生迟到成功回执。Host 接口若不知道插件作用域，调用方必须自行管理 disposer，不能声称自动卸载。

### 11.2 配置缺失行为（冻结）

| 情况 | 行为 |
| --- | --- |
| `reply.enabled=false` | 正常采集，不要求 Provider 配置 |
| `reply.enabled=true`，Provider/model 缺失 | 禁用群回复，记录 `GROUP_PROOF_CONFIG_MISSING` |
| Provider/model 有效，但 Host 无注册接口 | 禁用群回复，记录 `GROUP_PROOF_HOST_CAPABILITY_MISSING` |
| 注册冲突、接口异常 | 禁用群回复，保留原有群采集功能 |
| 注册成功且证明能力验证通过 | 才允许创建可回复的群运行时 |

禁用发生在群回复运行时层面，不是让整个 Psyche 插件启动失败。

### 11.3 Turn 与 Attempt 分开计数（冻结）

- `maxTurnsPerHour` 按**逻辑群 Turn** 计 1 次；内部 Adapter 重试不额外占额度。
- 每次 Adapter attempt 单独产生输入证明，不得复用其他 attempt 的证明。
- 截断、消息更换、模型重路由后必须重新校验。
- 只有最终有效 attempt 正常完成，才能支持该 Turn 的成功回执。
- 如果已向 QQ 发出回复但回执未知，不能因模型重试再次发送；这是出站不确定性，独立于 LLM attempt 计数。

### 11.4 证明回执绑定（生产验收必加）

回执必须精确绑定：`room_id + batch_id + turn + step + attempt_id + epoch + provider/model + request_hash`。仅内容 hash 相同不得跨批次复用。需覆盖：A 群证明不得被 B 群使用；上一次 attempt 证明不得被重试 attempt 复用；插件卸载后旧异步流不得产生迟到回执；同 Provider 的普通私聊调用不得被错误关联到群批次。

### 11.5 交付顺序（冻结）

| 阶段 | 交付物 | 通过条件 |
| --- | --- | --- |
| H-1 | Host API 契约与类型定义 | 明确冻结、调用一次、dispose、异常与 Provider 选择语义 |
| H-2 | `dsh-llm` 最小实现 | H-01～H-06 通过，真实 Provider 既有行为无回归 |
| L-1 | `group-production-proof.ts` | P-01～P-11 通过，缺少 Host 接口时只采集 |
| L-2 | `src/index.ts` 能力检测及生命周期接入 | 不影响 QQ 私聊、D-1 采集及未开启群回复的部署 |
| I-1 | 真实隔离 Host 验收 | I-01～I-09 全部通过 |
| D-3 | 真实 QQ 多群验收 | 另行判断，不用隔离 Host 结果代替 |

L-1 可与 H-2 并行，但必须基于同一份冻结接口，并保留无 Host API 的失败关闭路径。若 Host 无法提供可信的最终 Adapter 输入边界，继续保持只采集，不接受外层 hook 或替换真实 Adapter 作为生产替代方案。
