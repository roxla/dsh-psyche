/**
 * dsh-psyche-contract —— 心灵套装唯一的公共契约包。
 *
 * 硬边界（P1-1 起长期有效）：
 * - 零运行时依赖：不 import `@deepseek-ai/*`、不 import `node:fs` / `node:sqlite`；
 * - 不出现 SQLite、文件路径、宿主 Context 这类实现细节——`DatabaseAdapter` 归 Core 内部；
 * - 只放「通道与 Core 都要同意」的东西：类型、事件名、服务接口、错误码。
 *
 * D1-1 起冻结：19 个正式方法（CoreApi 10 + ChannelApi 2 + OwnerApi 5 + SharedApi 2）、
 * 24 个正式错误码、契约版本 1.0.0；此后的改动只追加、不破坏。
 */

export * from './errors.js'
export * from './events.js'
export * from './runtime.js'
export * from './types.js'
export * from './api.js'
export * from './service.js'
export * from './channel.js'

/** 契约版本。通道与 Core 对不上时，用它给出可读的失败原因。 */
export const PSYCHE_CONTRACT_VERSION = '1.0.0' as const
