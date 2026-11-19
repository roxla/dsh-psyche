# dsh-llm Call Boundary 契约（H-1 冻结稿）

> 状态：**H-1 冻结，待 Host 实现与验证（H-2）**。本文件是 Psyche 与 Host 的共同接口基准，不是已实现能力。
> 上游：`@deepseek-ai/dsh-llm`（本机 0.0.1-rc.x，`lib/index.js` / `lib/types/index.d.ts`）。
> 关联：[P4-D-2 生产输入证明接入方案](p4-d-2-production-input-proof-plan.md) §4、[D-2-0 契约](p4-d-2-scheduling-freeze.md) §5.1/§5.2。

## 1. 目的

在**真正的 Adapter 调用点**提供一个受信观察边界，使受信插件能够：

1. 证明 Adapter 实际收到的最终输入（不是外层 `llm/stream` 快照，也不是远端网络字节）；
2. 为每次 Adapter attempt 记录不可伪造的输入/完成回执；
3. 在无法满足证明条件时失败关闭，而不是产生「看起来成功」的回执。

该边界只服务于输入证明与审计，不改变路由、重试策略、Provider 选择或消息语义。

## 2. 接口

```ts
/** 已冻结的最终请求；由 Host 生成并保证在证明与 Adapter 调用之间不被改写。 */
export interface LlmCallBoundary {
  /** 稳定标识；注册后不可变。 */
  readonly id: string

  /**
   * 在 Adapter stream 之前调用，每个 attempt 恰好一次。
   * - options：Host 将交给 Adapter 的同一冻结对象（含 provider/model 最终解析结果）。
   * - next()：返回该 Adapter 的原始 chunk 流；只能调用一次。
   * - 必须返回一个 async iterable；不得自行伪造 finish。
   */
  stream(
    options: Readonly<GenerateOptions>,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk>
}

export interface LlmRuntime {
  /**
   * 为给定 provider 注册最终调用边界。
   * - 同 provider 重复注册抛 `DUPLICATE_CALL_BOUNDARY`；
   * - providers 为空或含重复项抛 `INVALID_CALL_BOUNDARY`；
   * - 多 provider 全成功或全失败；
   * - 返回幂等 disposer；dispose 只影响之后的新调用。
   */
  registerCallBoundary(providers: string[], boundary: LlmCallBoundary): () => void
}
```

`GenerateOptions` / `StreamChunk` 使用 `@deepseek-ai/dsh-llm` 现有公开类型，不新增字段。`turn/step` 不在 `GenerateOptions` 中，证明关联由调用方通过 `agent/pre-step` 的 `message.id` 建立。

## 3. 调用位置与顺序

```text
LlmRuntime.stream(options)
  → ctx.waterfall("llm/stream", options, …)        // 现有外层中间件，保持原样
      → adapterStream(options, prepared)
          → resolvedOptions = resolveCallFor(...)   // provider/model 最终解析
          → actual = forAdapter(resolvedOptions, adapter)
          → boundary.stream(actual, next)           // ← 新增边界
              → next() → adapter.stream(actual)
```

硬性顺序：

1. boundary 在 `forAdapter` **之后**调用，看到的 `actual` 必须与 Adapter 收到的完全一致（含 replay-state 裁剪）。
2. 外层 `llm/stream` 可以继续存在，但**不构成输入证明**；其修改后的结果正是 boundary 应看到的最终对象。
3. boundary 不参与路由选择；`actual.provider/model` 必须是最终选定的路由，不接受「配置值等于路由值」的假设。
4. 非群调用同样经过 boundary；boundary 必须无副作用地放行，不得记录正文或增加可观察延迟。

## 4. 运行时契约

### 4.1 输入一致性（A）

- Host 只计算一次 `actual`；boundary 与 Adapter 使用同一对象引用（或同一不可变快照）。
- Host 保证在 boundary 返回后、调用 Adapter 前不再修改 `actual`；`next()` 内部只调用捕获的 `adapter.stream(actual)`，不重新查 adapter、不重新组装。
- 若对 `actual` 做深冻结会影响现有 Adapter（例如 Adapter 写入缓存字段），Host 必须先评估兼容性并给出替代的不可变边界；**不得默默退回可变对象**。
- 证明范围准确表述为「Adapter 收到的输入」；Adapter 之后再转换成的网络请求不在本契约内。

### 4.2 单次调用与单次消费（B）

- 同一 boundary invocation 中 `next()` 最多一次；Host 用一个一次性闭包实现，第二次调用抛 `INVALID_CALL_BOUNDARY`。
- `next()` 返回的流只能被订阅一次；Host 不提供可重复订阅的共享流。
- `next()` 未被调用 → 不得签发「已到达 Adapter」的输入回执。
- Adapter 抛错、流提前中断、没有 `finish` 块 → 不得生成成功完成回执；由调用方（Psyche）按 error/aborted/incomplete 处理。

### 4.3 最终 Provider/Model（C）

- boundary 收到的是最终解析后的 `provider/model`；Host 不得把配置别名或请求前的候选值当作最终值。
- 若 Provider 存在别名、模型重定向、内部 fallback，Host 必须让 `actual.provider/model` 反映 Adapter 实际使用的路由；无法反映时，boundary 必须能检测并失败关闭。
- 群请求与普通请求的区分由受信的调用关联信息（session/agent/message 绑定）决定，不能只依赖普通调用方可填写的 `purpose` 字段；boundary 仍应把 `purpose` 作为辅助信号，不得作为授权依据。

### 4.4 生命周期（D）

- `registerCallBoundary` 返回幂等 `dispose()`；重复 dispose 无副作用。
- 同 provider 重复注册拒绝；多 provider 注册要么全部成功，要么全部失败。
- dispose 只影响之后的新调用；已在途的调用：
  - 若继续运行，其回执必须能被调用方识别为「已撤销边界后的迟到回执」并拒绝；
  - 若 Host 选择终止，必须通过正常的 aborted/error finish 表达，不得静默吞掉。
- Host 若不能感知插件作用域，不得声称自动卸载；调用方必须持有 disposer，并在停用顺序中先停新 Turn、使 epoch 失效，再 dispose。
- 插件重载/HMR：旧 disposer 必须先执行；新注册不得与旧注册并存。

### 4.5 异常与回执

- boundary 自身抛错：与 Adapter 抛错一致，归一化为 terminal `finish{kind:'error'|'aborted'}`；不得产生成功 finish。
- boundary 返回的流缺少 finish：Host 不补造成功；调用方按 incomplete 处理。
- boundary 的日志/错误不得包含消息正文、system 文本或完整 options；只允许 id/哈希/错误码。

## 5. Host 实现落点（参考）

- `node_modules/@deepseek-ai/dsh-llm/lib/index.js`
  - `LlmRuntime.adapterStream()`（当前约 1327-1341 行）：在 `forAdapter` 之后、`adapter.stream()` 之前插入 boundary 调用；`next()` 闭包持有 `actual`。
  - `LlmRuntime` 增加 `callBoundaries = new Map()` 与 `registerCallBoundary()`；注册走 `ctx.effect()` 或调用方 disposer（二选一，文档必须明确）。
  - `streamWithRegistration()`（约 1388-1390 行）保持不变；不得把 boundary 放进 `llm/stream`。
- `node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts`：导出 `LlmCallBoundary` 与 `registerCallBoundary` 类型。
- 兼容性：无 boundary 时 `adapterStream` 行为必须逐 chunk 等价；boundary 调用不得增加额外 await 或改变 abort 传播。

## 6. H-1/H-2 验收（H-01～H-06）

| 编号 | 用例 | 期望 |
| --- | --- | --- |
| H-01 | 注册 boundary 后发起请求 | boundary 先于 Adapter 调用；Adapter 收到的对象与 boundary 收到的一致；chunk 与非 boundary 路径逐项一致 |
| H-02 | 同 provider 重复注册；多 provider 含冲突 | `DUPLICATE_CALL_BOUNDARY` / `INVALID_CALL_BOUNDARY`；失败不改变现有注册 |
| H-03 | 外层 `llm/stream` 改写 messages/system | boundary 看到改写后的最终对象；证明 hash 与 Adapter 实际输入一致 |
| H-04 | boundary 抛错 / abort / 返回空流 | terminal error/aborted；不产生成功回执；无进程崩溃 |
| H-05 | `next()` 二次调用；同一流重复订阅 | `INVALID_CALL_BOUNDARY`；无重复 Adapter 调用 |
| H-06 | dispose / 重载；在途流 | 新调用回退无 boundary 路径；在途流按 4.4 明确继续或终止；迟到回执不被接受 |

通过条件：H-01～H-06 全过；现有 Provider/Adapter 回归测试（至少 `dsh-llm` 自身全部测试与一个真实 Provider 冒烟）通过；无 boundary 时性能与行为无回归。

## 7. 与 Psyche 的边界

- Host 只提供「最终 Adapter 边界 + 一次性流 + 生命周期」；不包含任何群聊、记忆或业务语义。
- Psyche 侧（L-1）负责：`GroupInputBoundary` 校验、`requestHash`、`attemptId`、`receipt`、epoch/Room/Turn 绑定。
- 任何一侧都不以「hash 相同」代替调用身份；跨批次/跨 Room 复用必须被拒绝。
- 若 Host 无法实现本契约，D-2 生产回复保持关闭，状态记为 `BLOCKED_BY_HOST_CAPABILITY`。

## 8. 待 Host 维护方确认

1. 注册是否走 `ctx.effect()` 自动释放，还是仅返回 disposer 由调用方管理；若两者都支持，优先级与冲突语义。
2. `actual` 是否可安全深冻结；若不能，Host 提供何种「等价不可变快照」保证。
3. 在途流在 dispose 后的默认行为（继续/终止），以及迟到回执的识别方式（epoch/registration token）。
4. 真实 Adapter 是否内部重试同一 `stream()`；Host 是否需要在 `GenerateOptions` 之外提供 attempt 标识，或由 boundary 自行计数。
5. 多 provider 注册的原子性实现细节，以及与 `registerAdapter` 的加载顺序约束。
