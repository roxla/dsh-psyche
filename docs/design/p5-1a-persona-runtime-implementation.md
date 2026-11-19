# P5-1a 人格只读投影实施记录

- 状态：冻结（2026-11-14，外部问答 2/8 轮）
- 依据：P5-0 v1.1（`docs/design/p5-persona-runtime-contract.md` §10）
- 范围：只做模块与 Context 注册；不接统一 Composer，不改 Mood/Growth/DB，不做 Host 验收（留 P5-1b）
- 基线：head `9c12448` / Schema v24 / 5183 断言 / 155 套 / 156 步 / 0

## 1. 文件

| 文件 | 职责 |
|---|---|
| `src/lib/persona-runtime.ts` | 读取并校验人格状态，返回投影对象；不写库、不改初始化 |
| `src/lib/persona-context.ts` | 注册 `psyche-persona`（order 90），每轮一次快照 |

复用 `packages/core/src/persona-init.ts` 的 `inspectInitialization` 与 SHA-256 结果；不修改初始化流程。

## 2. 接口

```ts
readPersonaProjection(options: {
  dataDir: string
  enabled: boolean
  maxChars: number
  maxTokens: number
  tokenizer?: (text: string) => number
}): {
  status: 'ready' | 'over_budget' | 'identity_drift' | 'damaged' |
          'unavailable' | 'uninitialized' | 'disabled'
  text?: string
  hash?: string
  chars: number
  tokens: number
  estimated: boolean
  reason?: string
}
```

- `ready` 才返回 `text`；其余状态一律不带正文。
- 日志只记录 `status`、`hash`、`chars`、`tokens`，不记录正文。

## 3. 可信读取

1. `dataDir` 只来自已验证配置；不读取调用方传入的任意路径。
2. 每次调用重新读取 `identity.md` 原始字节并计算 SHA-256，与 `persona.json` 的 locked `identityHash` 比较。
3. 不信任缓存或上层快照；`inspectInitialization` 未返回完整哈希比较结果时按 `unavailable` 处理，不得判 `ready`。
4. 哈希一致且状态 locked 才判 `ready`；漂移判 `identity_drift`；读取/解码异常判 `damaged` 或 `unavailable`。

## 4. 预算

- 字数上限：6000 字符（硬上限）。
- token 上限：3000（精确或估算均按此判定）。
- 有 tokenizer：精确计数，`estimated=false`。
- 无 tokenizer：CJK 1 字≈1 token、×1.2 保守估算，`estimated=true`。
- 估算超限、计数异常、字符超限：一律不注入，宁可误拒。

## 5. 注入

- Context 名称 `psyche-persona`，order 90。
- 每轮组装读取一次；同一轮不重复、不累积。
- 只有 `ready` 返回原文整段；异常时不返回任何旧文本，也不返回修改后的内容。
- `persona.enabled=false` 时返回 `disabled`，不注册内容。

## 6. 测试（P5-1a）

- 状态矩阵：未初始化、locked+匹配、哈希漂移、超字符、超 token、估算超限、读取异常、开关关闭。
- 原文逐字一致；不截断。
- 单轮一次、多轮不累积。
- 卸载/重载无残留、无重复注册。
- tokenizer 抛错 → `unavailable` 且无注入。

## 7. P5-1b 阻塞项（Host）

- 验证 `psyche-persona` 在每轮组装使用正确 Agent/Profile。
- 多轮对话与热重载后不累积、不残留旧人格。
- Context 注册成功不等于绑定成功；必须在隔离 Host 探针中确认。

## 8. 验收口径

- P5-1a：模块级 PASS（A 层）。
- Host 组装：NOT VERIFIED，留 P5-1b。
- 不宣称总预算已强制；总 Composer 属 P5-2。
