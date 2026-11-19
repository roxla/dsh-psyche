/**
 * 折叠与上下文组织（设计文档 v14 §21.2 / §10.1，P2 第一批）。
 *
 * 职责：预算就这么点，先放哪几条、剩下的怎么一句话带过。
 * 为什么纯函数：只吃「候选条目 + 预算」，不读库、不调模型、不看时间，同输入同输出。
 * 被谁调用：`panel.ts`（拼回忆段时把候选塞进预算）。
 * 关键不变量：
 *   1. 候选按「固化优先 → 分数 → id」排序，与 `rankSalience` 同一套口径；
 *   2. 单条超长按 `perItemChars` 截断（带省略号），塞不下的折叠成一句而不是丢掉；
 *   3. 折叠句自己也占预算，预算连折叠句都放不下就不放——宁可少一句也不超限。
 */

export interface FoldCandidate {
  id: string
  kind: string
  text: string
  /** 显著度分数；没有就传 0。 */
  score: number
  /** 是否已固化（固化优先）。 */
  solid: boolean
}

/** 折叠预算：字符与 token 两道上限要同时满足，任一超了就停（不四舍五入放宽）。 */
export interface FoldOptions {
  /** 字符上限（中文按字数算）。 */
  maxChars: number
  /** token 上限（按 estimateTokens 估）。 */
  maxTokens: number
  /** 单条最多留多少字，超出截断；默认 60。 */
  perItemChars?: number
  /** 低于这个分数就不进上下文（但会算进「还有 N 条」）。默认 0，即不设门槛。 */
  minScore?: number
}

/** 折叠后真正进上下文的一行（已按 perItemChars 截断，`truncated` 标记它被切过）。 */
export interface FoldLine {
  id: string
  kind: string
  text: string
  score: number
  solid: boolean
  /** 是否因为超长被截断。 */
  truncated: boolean
}

/** 折叠结果：放进去了什么、掉了多少、实际用量与预算。 */
export interface FoldResult {
  lines: FoldLine[]
  /** 被折叠掉的条数。 */
  foldedCount: number
  /** 折叠句；没有被折叠就是 null。 */
  foldedLine: string | null
  usedChars: number
  usedTokens: number
  budgetChars: number
  budgetTokens: number
  /** 是否还有东西没放进去（给观测台显示「还有 N 条」）。 */
  truncated: boolean
}

/**
 * 单条默认最多留多少字。
 *
 * 60 是「一条结论说清楚」的经验值；再长说明这句话塞了太多细节，
 * 该拆成多条结论，而不是在上下文里铺开。
 */
export const FOLD_DEFAULT_PER_ITEM_CHARS = 60

/**
 * 粗估 token：汉字按 1 个算，其他字符 4 个算 1 个。
 *
 * 这是保守口径（比真实分词偏大），用来保证不超预算，不追求精确。
 * 参数 `text`：任意字符串；返回 ≥ 0 的整数（向上取整）；空串返回 0。
 * 覆盖范围：CJK + 全角标点算 1 token，其余（含 emoji、拉丁字母）4 个算 1。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/**
 * 按「字符」截断（不是按字节），保留 `limit` 个字符以内，超出时留一个省略号。
 *
 * 用 `Array.from` 拆，避免把 emoji / 代理对截成乱码。
 * 边界：`limit` 至少按 1 个字符处理，`limit - 1` 不会变成负数。
 */
function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  const chars = Array.from(text)
  if (chars.length <= limit) return { text, truncated: false }
  return { text: `${chars.slice(0, Math.max(0, limit - 1)).join('')}…`, truncated: true }
}

/**
 * 与 `rankSalience` 同一套排序：固化优先 → 分数 → id。
 * 返回新数组；同分时按 id 兜底，保证同一批候选每次折叠出同样的结果。
 */
export function rankFoldCandidates(candidates: readonly FoldCandidate[]): FoldCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.solid !== b.solid) return a.solid ? -1 : 1
    if (b.score !== a.score) return b.score - a.score
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    return 0
  })
}

/**
 * 折叠句的固定文案。
 *
 * 「你记不清原话了」是故意写给模型看的：让它知道自己确实有过这段记忆，
 * 只是此刻展不开细节，而不是「这件事没发生过」。条数进文案，方便它判断要不要追问。
 */
export function foldedLineOf(count: number): string {
  return `（还有 ${count} 条更早的，你记不清原话了）`
}

/**
 * 把候选塞进预算。
 *
 * 参数 `candidates`：候选条目（顺序无所谓，进来先排序）；`options`：本段预算与单条上限。
 * 返回：放进去的行、被折叠条数、折叠句、实际用量与预算。
 * 注意：`maxChars` / `maxTokens` 是**这一段**的预算，不是全局；
 * 调用方要把地板段先扣掉（§10.1：地板 410 token 不参与竞争）。
 * 边界：`maxChars` / `maxTokens` 取整并夹到 ≥ 0——预算为 0 时一条都不放，但函数本身不报错。
 */
export function foldWithinBudget(
  candidates: readonly FoldCandidate[],
  options: FoldOptions,
): FoldResult {
  // 预算先整数化再夹到 0：负数预算当作 0，避免「负负得正」把条目放进去。
  const budgetChars = Math.max(0, Math.trunc(options.maxChars))
  const budgetTokens = Math.max(0, Math.trunc(options.maxTokens))
  // 单条下限 8 字：再短就只剩省略号，等于放了一条「…」，不如不放。
  const perItemChars = Math.max(8, Math.trunc(options.perItemChars ?? FOLD_DEFAULT_PER_ITEM_CHARS))
  const minScore = options.minScore ?? 0

  const queue = rankFoldCandidates(candidates).filter((item) => item.score >= minScore)
  const lines: FoldLine[] = []
  let usedChars = 0
  let usedTokens = 0
  // rest 初值是「排完序之后的总条数」，每放进一条减 1，剩下的就是被折叠的条数。
  let rest = queue.length

  // 两个预算**同时**满足才放：字符和 token 各算各的，任一超限都算放不下。
  const roomFor = (text: string): boolean => {
    const chars = Array.from(text).length
    const tokens = estimateTokens(text)
    return usedChars + chars <= budgetChars && usedTokens + tokens <= budgetTokens
  }

  // 一旦塞不下就 break，不 continue：队列是按重要性排好的，
  // 跳过大的去塞后面的小的，会让「重不重要」和「在不在上下文里」脱钩。
  for (const item of queue) {
    const sliced = truncate(item.text, perItemChars)
    if (!roomFor(sliced.text)) break
    lines.push({
      id: item.id,
      kind: item.kind,
      text: sliced.text,
      score: item.score,
      solid: item.solid,
      truncated: sliced.truncated,
    })
    usedChars += Array.from(sliced.text).length
    usedTokens += estimateTokens(sliced.text)
    rest -= 1
  }

  let foldedLine: string | null = null
  if (rest > 0) {
    // 折叠句也走同一个 roomFor：它自己占预算，放不下就不放（正文里不留半句）。
    const candidate = foldedLineOf(rest)
    if (roomFor(candidate)) {
      foldedLine = candidate
      usedChars += Array.from(candidate).length
      usedTokens += estimateTokens(candidate)
    }
  }

  return {
    lines,
    foldedCount: rest,
    foldedLine,
    usedChars,
    usedTokens,
    budgetChars,
    budgetTokens,
    // 有东西没放进去就为 true（哪怕折叠句本身也没放下——那更要提示「还有」）。
    truncated: rest > 0,
  }
}
