/**
 * engines/ —— 认知闭环与关系/心情引擎（P1-5 / P1-6 落地）。
 *
 * P1-1 只占位，不写实现：
 * - `remember`：写 interaction Event + 候选 Artifact；
 * - `clash`：外部冲突 conflict / 内部矛盾 contradiction_detected；
 * - `revise`：同 id revision+1，旧版本保留；
 * - `review`：写入 review_result，必要时提升/推翻。
 *
 * 约束：引擎只接受 Core 内部句柄，不接受通道直接调用。
 */
export const ENGINES_MODULE = 'engines' as const
