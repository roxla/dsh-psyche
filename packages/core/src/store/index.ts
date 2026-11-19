/**
 * store/ —— 存储抽象与 SQLite 实现（P1-3 落地）。
 *
 * 边界：`DatabaseAdapter` 只属于 Core，**不进 contract**。通道包永远不 import 这里，
 * 也永远不碰 SQLite；它们只通过 `ctx.psyche` / `PsycheCore` 说话。
 *
 * P1-3 计划：
 * - `DatabaseAdapter`：prepare/exec/transaction/backup 的窄接口，node:sqlite 与
 *   better-sqlite3 两个实现共用同一套 migration；
 * - 驱动能力自检：建库 / FTS5 / 外键 / WAL / 备份 API 全过才算 ready；
 * - 损坏库不切换驱动。
 */
export const STORE_MODULE = 'store' as const
