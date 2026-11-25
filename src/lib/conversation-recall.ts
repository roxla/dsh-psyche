/**
 * Q5-A：日常对话的原话召回（只读、零模型调用）。
 *
 * 口径（第 25–26 轮外部评审冻结）：
 * - 只有读，不写库，不产生任何模型调用；摘要层未接入前，先用原文兜底。
 * - 范围：同一 persona、同一平台、近 N 天；默认只覆盖「昨天」这个最常问的跨度。
 * - 按会话归组，同一轮的用户消息与助手回复配成一条，保留归属，不把两句话缝到一起。
 * - 用户这一轮在问什么就按什么检索：给出关键词时按关键词命中排，
 *   给不出关键词时（「接着上次说」）取最近一个有实质内容的会话。
 * - 只输出少量有出处的片段；找不到就明确返回 null，绝不编。
 */

import type { Db } from 'dsh-psyche-core'

/** 召回软上限：与 projectBrief 合计 500 中文字，这里自己先裁到 200。 */
export const CONVERSATION_RECALL_SOFT_CHARS = 200
/** 默认回溯天数：2 天覆盖「昨天」且留出时区与跨午夜的余量。 */
export const CONVERSATION_RECALL_DAYS = 2
/** 一次最多给两个事项，多了会挤掉当轮任务。 */
export const CONVERSATION_RECALL_MAX_ITEMS = 2

export type ConversationRecallSkipReason =
  | 'no-db'
  | 'no-persona'
  | 'no-sources'
  | 'no-match'
  | 'empty'

export interface ConversationRecallItem {
  /** 这一轮发生在什么时候（本地时间的可读形式）。 */
  at: string
  sessionRef: string | null
  channel: string | null
  userText: string
  assistantText: string | null
  /** 参与这一轮的全部 Source ID，供审计与「能指回原文」的断言使用。 */
  sourceIds: string[]
  /** 关键词命中数，用于排序；无关键词时为 0。 */
  hits: number
}

export interface ConversationRecallResult {
  text: string | null
  skipped: ConversationRecallSkipReason | null
  items: ConversationRecallItem[]
  /** 被裁掉的条数，供「为什么只看到一个事项」的解释。 */
  dropped: number
}

export interface ConversationRecallInput {
  db: BriefDatabase
  personaId: string
  /**
   * 平台边界。真实库里的 desktop 会话不只有一个 platform 值
   * （实测有 `dsh-session` / `dsh` / `desktop` 三种），所以允许传多个；
   * 只传一个时行为不变。QQ 私聊是 `qq`，与 desktop 互不可见。
   */
  platform: string | string[]
  /** 当前会话：结果里排除自己，避免把这一轮刚说的话当成「上次」。 */
  currentSessionRef?: string | null
  /** 当前轮的用户原文，用来抽关键词。 */
  query?: string | null
  /**
   * 只读某一个 channel 的源（例如 QQ 私聊只读 `private`，不把群聊内容带进来）。
   * 不传表示不额外限制；调用方按渠道判定结果决定。
   */
  sourceChannel?: string | null
  /**
   * 只读这些会话的源。第 37 轮外部评审的 P0：QQ 私聊此前只按
   * `platform='qq' AND channel='private'` 过滤，B 私聊独有的 Source 会出现在
   * A 的查询结果里——同 platform 同 channel 不等于同一联系人。
   *
   * 调用方按渠道给出可读会话范围：Owner 私聊只给「自己那个私聊会话」，
   * 桌面会话给全部桌面别名。不传表示不额外限制（只有单测会这样用）。
   */
  allowedSessionRefs?: string[]
  /**
   * 私聊场景的**联系人**范围。
   *
   * 原先用 `allowedSessionRefs: [当前会话]` 表达「只读自己这一侧」，
   * 但它和 `currentSessionRef` 叠在一起会互相抵消：唯一允许的会话正好是
   * 要被排除的那一个，于是本人以前说过的话一条都召回不到（`no-match`、0 条）。
   * 正确的作用域是「这个联系人说过的话」，跨他自己的多个会话都算数。
   */
  allowedContactId?: string
  now?: string
  days?: number
  maxItems?: number
  softChars?: number
}

type BriefDatabase = Pick<Db, 'get' | 'all'>

interface SourceRow {
  sourceId: string
  sessionRef: string | null
  channel: string | null
  kind: string
  text: string
  createdAt: string
}

function skipped(reason: ConversationRecallSkipReason): ConversationRecallResult {
  return { text: null, skipped: reason, items: [], dropped: 0 }
}

/** 把一句话压到可注入的长度，保留开头（开头通常已经说清是什么事）。 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * 抽关键词：中文按二元组切，英文与数字按整词。
 * 停用词只挡最常见的几个，宁可多召回几条再让排序和裁剪兜住。
 */
export function keywordsOf(query: string): string[] {
  const text = query.trim()
  if (text.length === 0) return []
  const found = new Set<string>()
  for (const word of text.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) ?? []) {
    found.add(word.toLowerCase())
  }
  const cjk = text.replace(/[^\u4e00-\u9fa5]/g, ' ')
  for (const run of cjk.split(/\s+/)) {
    if (run.length < 2) continue
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const gram = run.slice(i, i + 2)
      if (STOP_GRAMS.has(gram)) continue
      if (FILLER.test(gram)) continue
      found.add(gram)
    }
  }
  return [...found]
}

/**
 * 跨词边界产生的虚二元组。
 *
 * 「杏黄六号是什么」切成「杏黄/黄六/六号/号是/是什/什么」，后三个是纯语法碎片；
 * 而「靛青九号是什么」也切出「号是/是什/什么」，于是两条**毫不相关**的话因为这三个
 * 碎片打平，再按时间降序把新的那条（问句）排到真正写着答案的陈述句前面。
 * 真实库上就这么错过一次：问「杏黄六号」召回到了「靛青九号」。
 *
 * 挡的是**含虚词/疑问字**的二元组，不是含实词的。「甲是」这种整词里带「是」的
 * 口语表达会一起被挡，代价是这类词不能单独作线索——比召回错标记小得多。
 */
const FILLER = /[是什么的了吗呢吧啊呀怎哪谁么着过就都也还和跟对把被给让]/

const STOP_GRAMS = new Set([
  '什么', '这个', '那个', '我们', '你们', '现在', '还是', '就是', '可以', '记得',
  '上次', '接着', '昨天', '今天', '明天', '之前', '以后', '一个', '没有', '不是',
  '怎么', '为什', '么样', '有没有',
])

/**
 * 疑问分句的特征。整句都在问的句子只能用来「定位当时在谈什么」，
 * 不能作为「答案是什么」的证据——否则问句会靠逐字重复关键词拿最高分，
 * 把真正写着答案的那条陈述挤出去（真实库上已经发生过）。
 */
const QUESTION_MARKERS = /[？?]|什么|怎么|为什么|哪[个里儿次天些]|谁|多少|几[个点]|是不是|有没有|能不能|要不要|行不行/
/** 句末语气词也是疑问标志——分句时「？」被当分隔符吃掉了，只剩「…灰蓝吗」。 */
const QUESTION_TAIL = /[吗呢吧嘛]\s*$/

/** 按标点切分句：前半句陈述、后半句提问的句子要分开算（逗号也算分隔）。 */
function clausesOf(text: string): string[] {
  return text
    .split(/[。！？!?；;，,\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
}

function isQuestionClause(clause: string): boolean {
  if (QUESTION_MARKERS.test(clause)) return true
  return QUESTION_TAIL.test(clause)
}

/**
 * 关键词命中数，但跳过疑问分句。
 * 「之前蓝盒子的标签叫什么」整句是提问，命中记为 0；
 * 「蓝盒子的标签是松针七号」是陈述，命中记为满。
 */
function keywordHits(text: string, keywords: string[]): number {
  if (keywords.length === 0 || text.length === 0) return 0
  let hits = 0
  for (const clause of clausesOf(text)) {
    if (isQuestionClause(clause)) continue
    const lower = clause.toLowerCase()
    for (const keyword of keywords) {
      if (lower.includes(keyword)) hits += 1
    }
  }
  return hits
}

/**
 * 只统计疑问分句里的命中——它不能当答案，但能说明「那一轮在谈这件事」。
 * 「删除确认怎么处理？」里带着主题词「删除确认」，配上助手的短答案就是一条完整记录。
 */
function questionHits(text: string, keywords: string[]): number {
  if (keywords.length === 0 || text.length === 0) return 0
  let hits = 0
  for (const clause of clausesOf(text)) {
    if (!isQuestionClause(clause)) continue
    const lower = clause.toLowerCase()
    for (const keyword of keywords) {
      if (lower.includes(keyword)) hits += 1
    }
  }
  return hits
}

/** 纯确认回复：即使关键词命中，也不构成答案。 */
const ACK_ONLY = /^(?:收到|好的?|嗯+|哦+|记住了?|知道了?|明白|行的?|ok|okay|了解)[。！!~～\s]*$/i
/** 否认式开头：整段是在说「没有这条」，不能当答案证据。 */
const NEGATIVE_ANSWER = /^(?:不知道|不清楚|不确定|没找到|没有找到|查不到|找不到|无法确认|抱歉)/
/** 明确的续聊意图。只有这类问题才允许退到「最近一轮」，事实查询不许硬凑。 */
const CONTINUE_INTENT = /接着|上次|继续|然后|刚才|之前说|还没说完|说到哪/

/**
 * 助手那段有没有实质内容——纯确认、否认和过短回复都不能当答案证据。
 * 有一个例外：短回答配上同轮提出的问题就是完整记录（「删除确认怎么处理？」→「返回空页。」）。
 */
function hasSubstantiveAnswer(text: string | null, userText = ''): boolean {
  if (text === null) return false
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return false
  if (ACK_ONLY.test(flat)) return false
  if (NEGATIVE_ANSWER.test(flat)) {
    // 「不知道旧配色，新配色是赭石三号」——否认之后还有断言，不能整段丢掉。
    const afterNegation = flat.replace(NEGATIVE_ANSWER, '').trim()
    const hasAssertion =
      afterNegation.length >= 8 && !/没有|没找到|查不到|找不到|不确定/.test(afterNegation)
    if (!hasAssertion) return false
  }
  if (flat.length >= 12) return true
  // 短回答：只有同轮问题确实在问，才算有内容（否则「行」这种也会过关）。
  return clausesOf(userText).some((clause) => isQuestionClause(clause))
}

/** 本地时间的「MM-DD HH:mm」，不依赖运行环境时区之外的假设。 */
function readableTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace('T', ' ')
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 找出近 N 天的消息，按会话切成「一轮一轮」。
 * 配对规则：同一会话内，一条 message 后面紧跟的 model 归属这一轮；
 * 没有跟随回复的 message 也算一轮（用户问了但我还没来得及答，或答了但没落库）。
 */
function turnsOf(rows: SourceRow[]): Array<Omit<ConversationRecallItem, 'hits'>> {
  const bySession = new Map<string, SourceRow[]>()
  for (const row of rows) {
    const key = row.sessionRef ?? `__no_session__:${row.channel ?? ''}`
    const list = bySession.get(key)
    if (list === undefined) bySession.set(key, [row])
    else list.push(row)
  }

  const turns: Array<Omit<ConversationRecallItem, 'hits'>> = []
  for (const list of bySession.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    let pending: SourceRow | null = null
    for (const row of list) {
      if (row.kind === 'message') {
        if (pending !== null) {
          turns.push(turnOf(pending, null))
        }
        pending = row
        continue
      }
      if (pending !== null) {
        turns.push(turnOf(pending, row))
        pending = null
      }
    }
    if (pending !== null) turns.push(turnOf(pending, null))
  }
  return turns
}

function turnOf(user: SourceRow, assistant: SourceRow | null): Omit<ConversationRecallItem, 'hits'> {
  return {
    at: readableTime(user.createdAt),
    sessionRef: user.sessionRef,
    channel: user.channel,
    userText: clip(user.text, 120),
    assistantText: assistant === null ? null : clip(assistant.text, 160),
    sourceIds: assistant === null ? [user.sourceId] : [user.sourceId, assistant.sourceId],
  }
}

function render(items: ConversationRecallItem[]): string {
  const lines = ['以下是最近的实际对话记录（原文摘录，用于接上话）：']
  for (const item of items) {
    lines.push(`- ${item.at} 你说：${item.userText}`)
    if (item.assistantText !== null) lines.push(`  我当时答：${item.assistantText}`)
  }
  return lines.join('\n')
}

/**
 * 生成一段可注入投影的「上次聊到哪」。
 * 零模型调用、不写库；找不到就返回 `skipped`，不返回占位文本。
 */
export function buildConversationRecall(input: ConversationRecallInput): ConversationRecallResult {
  if (input.db === undefined || input.db === null) return skipped('no-db')
  if (typeof input.personaId !== 'string' || input.personaId.length === 0) return skipped('no-persona')

  const now = input.now ?? new Date().toISOString()
  const days = input.days ?? CONVERSATION_RECALL_DAYS
  const maxItems = input.maxItems ?? CONVERSATION_RECALL_MAX_ITEMS
  const softChars = input.softChars ?? CONVERSATION_RECALL_SOFT_CHARS
  const since = new Date(new Date(now).getTime() - days * 24 * 60 * 60 * 1000).toISOString()
  const platforms = Array.isArray(input.platform) ? input.platform : [input.platform]
  if (platforms.length === 0) return skipped('no-persona')
  const placeholders = platforms.map(() => '?').join(', ')
  // 渠道内再收一道：QQ 私聊只读 private 的源，避免把群聊内容带进私聊上下文。
  const sourceChannel = (input.sourceChannel ?? '').trim()
  const channelFilter = sourceChannel.length > 0 ? 'AND channel = ?' : ''
  const channelParams: string[] = sourceChannel.length > 0 ? [sourceChannel] : []
  // 会话范围：在 SQL 取候选**之前**收窄，而不是取回 400 行再筛。
  // P0 的修复点就在这儿——同 platform 同 channel 不等于同一联系人。
  const allowed = (input.allowedSessionRefs ?? []).filter((ref) => ref.length > 0)
  if (allowed.length === 0 && input.allowedSessionRefs !== undefined) return skipped('no-persona')
  const sessionFilter = allowed.length > 0 ? `AND session_ref IN (${allowed.map(() => '?').join(', ')})` : ''
  const sessionParams: string[] = allowed

  // 私聊的作用域是「这个联系人」，不是「这一个会话」——见 allowedContactId 的注释。
  const contactId = (input.allowedContactId ?? '').trim()
  const contactFilter = contactId.length > 0 ? 'AND sender_contact_id = ?' : ''
  const contactParams: string[] = contactId.length > 0 ? [contactId] : []

  // 过滤系统注入的伪消息（实测有 `[dsh-mnemon:delegated skill] …` 这种写进
  // sources 的调度指令，它不是一个「用户说过的话」，召回它只会污染上下文）。
  const rows = input.db.all<SourceRow>(
    `SELECT source_id AS sourceId, session_ref AS sessionRef, channel,
            kind, text, created_at AS createdAt
     FROM sources
     WHERE persona_id = ? AND platform IN (${placeholders}) AND created_at >= ?
       AND kind IN ('message', 'model')
       AND text NOT LIKE '[dsh-%'
       ${channelFilter}
       ${sessionFilter}
       ${contactFilter}
     ORDER BY created_at DESC
     LIMIT 400`,
    [input.personaId, ...platforms, since, ...channelParams, ...sessionParams, ...contactParams],
  )
  if (rows.length === 0) return skipped('no-sources')

  const keywords = keywordsOf(input.query ?? '')
  const turns = turnsOf(rows).filter((turn) => {
    if (input.currentSessionRef == null || input.currentSessionRef.length === 0) return true
    return turn.sessionRef !== input.currentSessionRef
  })

  // 第 29 轮外部评审：把「用来找到话题的文本」和「有资格作为答案证据的文本」分开。
  //
  // 真实库上暴露的缺陷是「问句自匹配」：问「蓝盒子的标签叫什么」时，
  // 别人问过同一句话的那一轮命中数最高（因为整句都是关键词），
  // 真正写着答案的那条陈述反而被挤出前二。
  //
  // 三条规则：
  // 1. 用户原始陈述优先——历史用户说「标签是松针七号」，助手只回「收到」也算直接来源；
  // 2. 有实质内容的历史回答可以入选——用户问「标签叫什么」、助手答「松针七号」仍有用；
  // 3. 纯提问、复述问题、通用确认和无答案回复不独立入选——只靠重复词得分的轮次淘汰。
  const scored = turns.map((turn) => {
    const userHits = keywordHits(turn.userText, keywords)
    const hasAnswer = hasSubstantiveAnswer(turn.assistantText, turn.userText)
    const assistantHits = hasAnswer ? keywordHits(turn.assistantText ?? '', keywords) : 0
    // 问句本身不能当答案，但它能确定「这一轮在谈什么」：
    // 有实质回答时，把问句里的主题命中折算成 1 分的基础分，让它排得进候选，
    // 但仍低于「用户亲口陈述」（×2）和「助手答出主题」（直接累加）。
    const topicHits = hasAnswer ? Math.min(questionHits(turn.userText, keywords), 1) : 0
    return {
      ...turn,
      hits: userHits * 2 + assistantHits + topicHits,
      userHits,
      assistantHits,
    }
  })

  // 有关键词：命中多的优先，命中为 0 的**不再无条件回退到「最近一轮」**——
  // 事实查询若只赚到「问句 + 不知道」这类候选，就该返回空（规则 3）。
  // 只有明确的续聊意图（「接着上次说」）才允许退到最近一轮，那是用户本意。
  let pool: typeof scored
  if (keywords.length === 0) {
    pool = scored
  } else {
    pool = scored.filter((item) => item.hits > 0)
    if (pool.length === 0) {
      if (!CONTINUE_INTENT.test(input.query ?? '')) return skipped('no-match')
      // 续聊兜底也要排除「问了但没答出东西」的轮次，否则会把「上次问过什么」
      // 当成「上次聊了什么」。
      pool = scored.filter((item) => hasSubstantiveAnswer(item.assistantText) || item.userText.length >= 8)
    }
  }
  if (pool.length === 0) return skipped('no-match')

  // 同分时：有用户原始陈述的优先（规则 1），再按时间倒序。
  pool.sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits
    if (a.userHits !== b.userHits) return b.userHits - a.userHits
    return b.at.localeCompare(a.at)
  })

  const kept: ConversationRecallItem[] = []
  let budget = softChars
  for (const item of pool) {
    if (kept.length >= maxItems) break
    const cost = item.userText.length + (item.assistantText?.length ?? 0)
    if (kept.length > 0 && cost > budget) break
    kept.push(item)
    budget -= cost
  }
  if (kept.length === 0) return skipped('empty')

  return {
    text: render(kept),
    skipped: null,
    items: kept,
    dropped: pool.length - kept.length,
  }
}
