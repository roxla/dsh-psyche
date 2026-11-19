/**
 * tools/ —— 十个 `psyche_*` 工具的注册与输入校验（P1-2 起逐个落地）。
 *
 * P1-1 只占位。工具参数一律手写 JSON Schema（宿主无法从 TS 类型推导），
 * 输出用契约里的结果类型收窄，不把 SQLite 行原样丢给模型。
 */
export const TOOLS_MODULE = 'tools' as const
