// 关系信号入账（v29.18）。
//
// `relationship_signals` / `contact_affect_state` / `contact_affect_history` 三张表
// 从 v20 就在，却一直没有写入路径——真机实测三张表都是 0 行，面板上那个
// 「好感 50 / 中立」只是初始化值。本文件补的是「一次可归属的互动 → 一条带
// 来源的信号 → 按既定规则更新该联系人的情感五维」这段链。
//
// 三条纪律（外部评审第 23 / 24 / 36 轮给的）：
// 1. **归属必须先确认**。写之前要求 contactId 在 `contacts` 里真实存在；
//    空串 / 未登记的联系人一律 `no-contact`，绝不默认记到 Owner 名下——
//    这是「无法归属的互动」和「归属到错的联系人」的分界。
// 2. **重放不叠加**。`independence_key` 是去重键（调用方用 source_id 或
//    「联系人或事件」组合）。同一键已经写过就返回 `replayed`，不新增信号行、
//    不动 state、不写 history——重放和「又说了一次谢谢」必须区分开。
// 3. **单次不超上限**。`AFFECT_PER_SIGNAL_CAP`（10）是既有契约，逐维夹紧。
//
// 与 `relationship.ts` 的分工：那边管**好感（affinity，0–100 七档）**，
// 规则表是 ordinary_interaction / commitment_kept 那六种；这边管**情感五维**
// （warmth / tension / hurt / missing / irritation）。两套状态互不写入，
// 由 `contact-affect.ts` 的文件头契约规定，这里只是把交集的那一步补上。
import { randomUUID } from 'node:crypto'
import {
  AFFECT_PER_SIGNAL_CAP,
  AFFECT_RULE_VERSION,
  defaultAffectValues,
  effectiveAffectValues,
  type AffectDimensionKey,
  type ContactAffectValues,
} from './contact-affect.js'

export type AffectSignalType = 'gratitude' | 'praise' | 'apology' | 'complaint'

export interface AffectSignalRule {
  readonly type: AffectSignalType
  readonly polarity: 'positive' | 'negative' | 'neutral'
  /** 基础增量；实际落库值按维乘权重再夹到 ±AFFECT_PER_SIGNAL_CAP。 */
  readonly baseDelta: number
  readonly keywords: readonly string[]
  readonly dimensions: Partial<Record<AffectDimensionKey, number>>
  /**
   * 是否要求句子里有第二人称指向（「你 / 您」）。负向规则默认要求：
   * 抱怨必须先指向心灵，才谈得上「对这个人不满」。
   */
  readonly requiresAddressee?: boolean
}

/**
 * 首版规则表刻意小：只认「明确表达」的四种，不做整句情绪推断。
 * 加一条之前先问一句：这句话有没有可能是在说别人、说别的事、或者在开玩笑？
 * 答不出来就别加——关系数值写错，用户看到的是一段他并没有的感情。
 */
export const AFFECT_SIGNAL_RULES: readonly AffectSignalRule[] = Object.freeze([
  {
    type: 'gratitude',
    polarity: 'positive',
    baseDelta: 4,
    keywords: ['谢谢你', '谢谢', '感谢你', '感谢', '多谢', 'thank'],
    dimensions: { warmth: 1, tension: -0.5, irritation: -0.5 },
  },
  {
    type: 'praise',
    polarity: 'positive',
    baseDelta: 3,
    // 故意不用裸的「不错 / 厉害 / 挺好」：它们太泛，「今天天气不错」也会命中，
    // 而那句话跟心灵没有关系。夸到心灵头上时，主语几乎总在关键词里。
    keywords: ['做得好', '做得不错', '厉害了', '你真棒', '你厉害', '很靠谱'],
    dimensions: { warmth: 0.8, irritation: -0.3 },
  },
  {
    type: 'apology',
    polarity: 'positive',
    baseDelta: 3,
    keywords: ['对不起', '抱歉', '不好意思', '是我错了'],
    dimensions: { tension: -0.6, hurt: -0.4 },
  },
  {
    type: 'complaint',
    polarity: 'negative',
    baseDelta: 4,
    keywords: ['烦死', '很烦', '生气', '失望', '气死', '不爽'],
    dimensions: { irritation: 1, tension: 0.8 },
    // 第 37 轮外部评审 P1（05）：负向信号必须**指向心灵**才记账。
    // 「编译器又崩了，我很烦」是在说别的事，记成「对心灵不满」是错的——
    // 用户会看到一段他并没有的感情。正向表达（谢谢/夸赞）自带指向，
    // 负向表达必须靠第二人称或明确短语带出来。
    requiresAddressee: true,
  },
])

/** 第二人称指向：有它才算「在说心灵」。 */
const ADDRESSEE = /[你您]/
/** 紧挨关键词之前的否定词：命中就跳过（「我没有生你的气」不是抱怨）。 */
const NEGATION = /(?:没|不|别|无|甭)[^。！？!?；;]{0,6}$/

/** 命中哪条规则；只取第一条命中的（避免「谢谢你，不过我很失望」被算成两笔）。 */
export function detectAffectSignal(text: string): AffectSignalRule | null {
  const normalized = text.toLowerCase()
  for (const rule of AFFECT_SIGNAL_RULES) {
    // 负向规则要求明确指向心灵：整句里得有「你 / 您」。
    if (rule.requiresAddressee === true && !ADDRESSEE.test(normalized)) continue
    for (const keyword of rule.keywords) {
      const at = normalized.indexOf(keyword.toLowerCase())
      if (at < 0) continue
      // 关键词前面紧挨着否定词 → 这句在否认，不是在表达。
      if (NEGATION.test(normalized.slice(Math.max(0, at - 8), at))) continue
      // 负向关键词前面紧挨着「对…软件 / 系统 / 工具」这类宾语 → 说的是东西不是人。
      if (rule.requiresAddressee === true) {
        const before = normalized.slice(Math.max(0, at - 12), at)
        if (/(软件|系统|工具|机器|电脑|代码|程序|项目|编译器|服务器)/.test(before)) continue
      }
      return rule
    }
  }
  return null
}

export type AffectIngestStatus =
  | 'applied'
  | 'replayed'
  | 'no-contact'
  | 'no-signal'
  | 'no-db'

export interface AffectIngestInput {
  contactId?: string | null
  text?: string | null
  /** 去重键：同一来源/同一事件重放时保持不变。 */
  independenceKey?: string | null
  sourceId?: string | null
  eventId?: string | null
  opId?: string | null
  now?: string
  personaId?: string
}

export interface AffectIngestResult {
  status: AffectIngestStatus
  signalId: string | null
  signalType: AffectSignalType | null
  applied: Array<{ dimension: AffectDimensionKey; before: number; delta: number; after: number }>
  values: ContactAffectValues
  ruleVersion: string
}

interface RawDb {
  get<T = unknown>(sql: string, params?: SqlParams): T | undefined
  all<T = unknown>(sql: string, params?: SqlParams): T[]
  run(sql: string, params?: SqlParams): unknown
  /** 与 adapter 的 `transaction()` 同形：回调抛错时整笔回滚。 */
  transaction<T>(fn: () => T): T
}

/** 与 adapter 的 `SqlParams` 同形；这里只用到这几个标量，不引整个 adapter。 */
type SqlParams = readonly (string | number | null)[]

const emptyResult = (status: AffectIngestStatus): AffectIngestResult => ({
  status,
  signalId: null,
  signalType: null,
  applied: [],
  values: defaultAffectValues(),
  ruleVersion: AFFECT_RULE_VERSION,
})

/**
 * 写一条情感信号，并按规则更新该联系人的五维。
 *
 * 调用方负责提供**可信**的 contactId：它应该来自入站绑定（Adapter 声明、
 * Core 解析），而不是从文本里猜出来的名字。
 */
export function ingestAffectSignal(
  db: RawDb | null | undefined,
  input: AffectIngestInput,
): AffectIngestResult {
  if (!db) return emptyResult('no-db')
  const contactId = typeof input.contactId === 'string' ? input.contactId.trim() : ''
  if (contactId.length === 0) return emptyResult('no-contact')
  const contact = db.get<{ contact_id: string }>(
    'SELECT contact_id FROM contacts WHERE contact_id = ?',
    [contactId],
  )
  if (!contact) return emptyResult('no-contact')
  const text = typeof input.text === 'string' ? input.text : ''
  const rule = detectAffectSignal(text)
  if (!rule) return emptyResult('no-signal')

  const personaId = input.personaId ?? 'main'
  const now = input.now ?? new Date().toISOString()
  const independenceKey =
    typeof input.independenceKey === 'string' && input.independenceKey.trim().length > 0
      ? input.independenceKey.trim()
      : `${contactId}:${input.sourceId ?? input.eventId ?? now}`

  const existing = db.get<{ signal_id: string }>(
    'SELECT signal_id FROM relationship_signals WHERE contact_id = ? AND independence_key = ? LIMIT 1',
    [contactId, independenceKey],
  )
  if (existing) {
    return {
      ...emptyResult('replayed'),
      signalId: existing.signal_id,
      signalType: rule.type,
      values: currentAffectValues(db, personaId, contactId, now),
    }
  }

  const signalId = `sig_${randomUUID().replace(/-/g, '').slice(0, 20)}`
  // 第 37 轮外部评审 P1：查重、读取现值与三张表的写入必须在**同一个写事务**里。
  // 故障注入实测过：状态写入失败时会留下 信号 1 / 状态 0 / 历史 0 的半成品，
  // 而同输入重试因为查重命中直接返回 `replayed`，五维再也修不回来。
  //
  // 第 38 轮补充：**现值也必须事务内读**。原先 `before` 在事务外取，
  // 两个合法的并发更新会各自基于同一个旧值算绝对新值，后写者整条覆盖前写者，
  // 前一笔的增量凭空消失。adapter 的 `transaction()` 是 BEGIN IMMEDIATE，
  // 事务内读到的一定是最新值，串行执行不会互相丢。
  const committed = db.transaction(() => {
    const again = db.get<{ signal_id: string }>(
      'SELECT signal_id FROM relationship_signals WHERE contact_id = ? AND independence_key = ? LIMIT 1',
      [contactId, independenceKey],
    )
    if (again) return { replayedSignalId: again.signal_id, applied: null }

    const before = currentAffectValues(db, personaId, contactId, now)
    const applied: AffectIngestResult['applied'] = []
    const after = { ...before }
    for (const [dimension, weight] of Object.entries(rule.dimensions) as Array<
      [AffectDimensionKey, number]
    >) {
      const raw = rule.baseDelta * weight
      const capped = Math.max(-AFFECT_PER_SIGNAL_CAP, Math.min(AFFECT_PER_SIGNAL_CAP, raw))
      const next = Math.max(0, Math.min(100, after[dimension] + capped))
      applied.push({ dimension, before: before[dimension], delta: next - before[dimension], after: next })
      after[dimension] = next
    }
    db.run(
    `INSERT INTO relationship_signals (
       signal_id, persona_id, contact_id, source_id, event_id, independence_key,
       signal_type, polarity, base_delta, confidence, applied_delta, rule_version, created_at, op_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      signalId,
      personaId,
      contactId,
      input.sourceId ?? null,
      input.eventId ?? null,
      independenceKey,
      rule.type,
      rule.polarity,
      rule.baseDelta,
      'medium',
      applied.reduce((sum, item) => sum + item.delta, 0),
      AFFECT_RULE_VERSION,
      now,
      input.opId ?? null,
    ],
  )
  for (const item of applied) {
    db.run(
      `INSERT INTO contact_affect_state (persona_id, contact_id, dimension, value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (persona_id, contact_id, dimension)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [personaId, contactId, item.dimension, item.after, now],
    )
    db.run(
      `INSERT INTO contact_affect_history (persona_id, contact_id, dimension, value, at, op_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [personaId, contactId, item.dimension, item.after, now, input.opId ?? null],
    )
    }
    return { replayedSignalId: null, applied, values: after }
  })
  if (committed.replayedSignalId !== null || committed.applied === null) {
    return {
      ...emptyResult('replayed'),
      signalId: committed.replayedSignalId ?? signalId,
      signalType: rule.type,
      values: currentAffectValues(db, personaId, contactId, now),
    }
  }
  return {
    status: 'applied',
    signalId,
    signalType: rule.type,
    applied: committed.applied,
    values: committed.values,
    ruleVersion: AFFECT_RULE_VERSION,
  }
}

/** 读该联系人当前有效五维（先按各自 updated_at 冷却，再补齐缺省 0）。 */
export function currentAffectValues(
  db: RawDb,
  personaId: string,
  contactId: string,
  now: string,
): ContactAffectValues {
  const rows = db.all<{ dimension: string; value: number; updated_at: string }>(
    'SELECT dimension, value, updated_at FROM contact_affect_state WHERE persona_id = ? AND contact_id = ?',
    [personaId, contactId],
  )
  const raw: Record<string, { value: number; updatedAt: string }> = {}
  for (const row of rows) raw[row.dimension] = { value: row.value, updatedAt: row.updated_at }
  return effectiveAffectValues(raw, now)
}
