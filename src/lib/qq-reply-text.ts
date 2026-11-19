/**
 * QQ 回复文本的最小清洗。
 *
 * 真实联调里模型偶发把工具调用写成了正文 `{"<psyche_recall\">"}`：
 * 没有 `tool/call`，助手消息只有这个标记，QQ 桥会原样发给用户（R8）。
 * 这里只拦「整条回复就是一个 psyche 工具标记」的情况，不改写任何
 * 正常正文，也不猜模型意图；真正的工具调用仍由宿主协议处理。
 */

/** 整条内容只是一个 psyche 工具标记（允许自闭合/关闭写法与引号）。 */
const PURE_PSYCHE_TOOL_MARKUP = /^<\/?psyche_[a-z0-9_]+["']?\s*>$/i

export function isPurePsycheToolMarkup(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  return PURE_PSYCHE_TOOL_MARKUP.test(trimmed)
}
