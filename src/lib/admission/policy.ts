// D1-2c：写入准入策略的唯一实现在 `packages/core/src/admission/policy.ts`。
// 这里只保留 re-export 壳，避免根包出现第二套判定规则。
export * from 'dsh-psyche-core'
