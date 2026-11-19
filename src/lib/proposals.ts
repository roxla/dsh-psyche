// D1-2c：提案审批的唯一实现在 `packages/core/src/proposals.ts`。
// 这里只保留 re-export 壳，避免根包出现第二套审批逻辑。
export * from 'dsh-psyche-core'
