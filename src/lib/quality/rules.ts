// D1-2c：质量规则的唯一实现在 `packages/core/src/quality/rules.ts`。
// 这里只保留 re-export 壳；测试仍从 `dist/lib/quality/rules.js` 读取。
export * from 'dsh-psyche-core'
