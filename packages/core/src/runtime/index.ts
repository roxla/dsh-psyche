/**
 * runtime/ —— 运行时编排：capture → perceive → commit 的调度、活动窗口、
 * 幂等键与 scope 校验（P1-2 / P1-4 落地）。
 *
 * P1-1 只占位，不实现任何业务：这里将来持有 per-persona 的写队列与
 * 「同 Persona 同时只有一个写入者」的约定，通道不得绕过它直接写库。
 */
export const RUNTIME_MODULE = 'runtime' as const
