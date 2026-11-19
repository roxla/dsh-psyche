/**
 * FTS5 生产检索（E 阶段，P2-FTS5）。
 *
 * 设计依据（冻结于 v27.4 / p2-fts5-a2b-freeze.md v1.4）：
 * - 只索引「当前 head」的 Artifact；历史 revision 不进索引，Event 第一版不进。
 * - 中文按 bigram（双字）切、英文/数字按整词小写；**必须按原文顺序交织**两种 token——
 *   先扫全部中文再扫英文会让「临时 profile」这类混合文本的 phrase 查询错位（D3 类 1–4 实测）。
 * - 查询语义：无空白 → 整体 phrase；有空白 → 片段内 phrase、片段间 AND；单字 → 受限 LIKE。
 * - 评分用 SQLite 原生 BM25（`-bm25` 越大越相关），列权重固定 `(kind, ref_id, bigram_text, raw_text) = (0,0,1,0)`；
 *   raw_text 仍参与文档长度归一化，属已知限制（D5-A 已量化）。
 * - 证据加成固定为 0；自定义 b/k1 不暴露（D5 只证明「不存在全面最优」，未证明真实收益）。
 * - head / state 硬过滤独立于评分器：FTS 只负责找候选，能不能用由过滤层决定。
 */

import type { Db } from './adapter.js'
import type { SqlParam } from './adapter.js'
import { CODE, PsycheError } from './errors.js'
import { andMemoryActive } from './memory-hygiene.js'
import { andHeadEvidenceSourcesActive } from './external-source.js'

/** 中文段 / 英文数字段：按原文出现顺序切分。 */
const SEGMENT = /[\p{Script=Han}]+|[A-Za-z0-9]+/gu
const HAN_ONLY = /^\p{Script=Han}+$/u

/**
 * 查询文本的长度上限（字符）。
 *
 * A2+B 冻结时定的是「索引 2000 / 查询 200」：查询侧上限不是安全措施，是成本边界——
 * 超长输入会构造出巨大的 MATCH 表达式，对谁都没好处。超限直接拒绝，不静默截断
 * （截断可能恰好切掉否定词或实体名，返回一份「看起来正常、其实不是你要的」结果）。
 */
export const MAX_QUERY_CHARS = 200

/**
 * 查询片段上限：每个单字片段都会展开成一个 LIKE 条件，片段太多会让 SQL 变长、
 * 查询计划退化。超过就明确报 E_QUERY_TOO_COMPLEX，不拼一条超长语句。
 */
export const MAX_QUERY_SEGMENTS = 16
/** 单字 LIKE 条件单独设更小的上限：它们是最贵的那部分。 */
export const MAX_LIKE_SEGMENTS = 8

/**
 * 长句回退的最小查询长度（字符）。
 *
 * 短查询（4–6 字）精确为空通常就是「没有这条记忆」，放宽会捞出假阳性；
 * 回退只服务带寒暄、疑问或子句的长句（E4 abstain 组最长 6 字，阈值取 8）。
 */
export const FALLBACK_MIN_QUERY_CHARS = 8

export type FtsQueryMode = 'like' | 'and' | 'phrase'

export interface FtsQueryAnalysis {
  /** trim 后的原始查询（用于构造整体 phrase） */
  normalizedInput: string
  /** 去重后的 token 序列（构造表达式用） */
  tokens: string[]
  /** 按空白切开的片段（and 模式逐段构造 phrase） */
  segments: string[]
  /**
   * 实际参与 MATCH 表达式的片段：bigram 化之后仍有 ≥2 个字符的片段。
   *
   * 单字片段（「满」「的」）在 bigram 索引里不存在独立 token，拼进 phrase 只会让整条
   * AND 永远不命中。它们**不丢弃**，而是转成 LIKE 条件保留在原查询里——
   * 删除条件会改变语义（`不 喜欢` 不能变成 `喜欢`）。
   */
  ftsSegments: string[]
  /** 单字片段：不进 MATCH，但作为 LIKE 条件与其他片段 AND 组合（保留否定/限定词）。 */
  likeSegments: string[]
  containsChinese: boolean
  containsNonChinese: boolean
  mode: FtsQueryMode
}

/**
 * 把一段文本切成 FTS5 可用的 token 串：中文 bigram、英文/数字整词小写，**按原文顺序交织**。
 *
 * 例：「用临时 profile 测试」→ `用临 临时 profile 测试`
 *     「临时profile」→ `临时 profile`（中文段与英文段各自成 token，顺序保持）
 *     「2026-11-06」→ `2026 11 06`（连字符是分隔符）
 */
export function bigramText(text: string): string {
  const tokens: string[] = []
  for (const match of String(text ?? '').matchAll(SEGMENT)) {
    const segment = match[0]
    if (HAN_ONLY.test(segment)) {
      const chars = Array.from(segment)
      if (chars.length === 1) {
        tokens.push(chars[0])
      } else {
        for (let i = 0; i < chars.length - 1; i += 1) tokens.push(chars[i] + chars[i + 1])
      }
    } else {
      tokens.push(segment.toLowerCase())
    }
  }
  return tokens.join(' ')
}

/**
 * 分析查询：只决定「用哪种检索模式」，不负责去重/转义。
 *
 * 模式判据（A2+B v1.4 §4.7）：
 * - 空串或单字 → `like`（单字不进 MATCH，走受限 LIKE）；
 * - 原始查询含空白 → `and`（片段内 phrase，片段间 AND）；
 * - 无空白且多字 → `phrase`（内部标点仍算分隔，但整体是一个 phrase）。
 */
export function analyzeFtsQuery(text: string): FtsQueryAnalysis {
  const input = String(text ?? '').trim()
  const segments = input.split(/\s+/u).filter((segment) => segment.length > 0)
  const containsChinese = /\p{Script=Han}/u.test(input)
  const containsNonChinese = /[A-Za-z0-9]/.test(input)
  const length = Array.from(input).length

  // 能进 MATCH 的片段 vs 只能走 LIKE 的单字片段（两者都不丢，组合在同一 WHERE 里）。
  const ftsSegments = segments.filter((segment) => compactLength(bigramText(segment)) >= 2)
  const likeSegments = segments.filter((segment) => compactLength(bigramText(segment)) < 2)

  let mode: FtsQueryMode
  if (length === 0) {
    mode = 'like'
  } else if (segments.length === 1) {
    mode = ftsSegments.length === 1 ? 'phrase' : 'like'
  } else {
    // 多片段：只要还有能进 MATCH 的片段就按 and 组合；单字片段由 searchFts 追加 LIKE 条件。
    mode = ftsSegments.length > 0 ? 'and' : 'like'
  }

  const tokens = bigramText(input).split(' ').filter((token) => token.length > 0)
  return {
    normalizedInput: input,
    tokens: [...new Set(tokens)],
    segments,
    ftsSegments,
    likeSegments,
    containsChinese,
    containsNonChinese,
    mode,
  }
}

/** 去掉空白后的字符数（bigram token 串按字符算）。 */
function compactLength(value: string): number {
  return Array.from(value.replace(/\s+/gu, '')).length
}

/** FTS5 字符串字面量：双引号包裹，内部 `"` 转成 `""`（否则 MATCH 会抛 unterminated string）。 */
function quote(segment: string): string {
  const tokens = bigramText(segment).split(' ').filter((token) => token.length > 0)
  return `"${tokens.map((token) => token.replace(/"/g, '""')).join(' ')}"`
}

/**
 * 把分析结果翻译成 FTS5 查询表达式。
 *
 * - `and`：每个空白片段各自一个 phrase，用 `AND` 连接；
 * - `phrase`：整个查询一个 phrase（同一片段内部连续才算命中）；
 * - `like`：不构造 MATCH 表达式（调用方走 LIKE 分支），调用会抛错，避免误用。
 */
export function buildFtsQuery(analysis: FtsQueryAnalysis): string {
  if (analysis.mode === 'like') {
    throw new Error('like 模式不使用 MATCH 表达式')
  }
  if (analysis.mode === 'and') {
    return analysis.ftsSegments.map(quote).join(' AND ')
  }
  return quote(analysis.normalizedInput)
}

/**
 * 长句回退候选：exact 查询为空时再试的更宽松表达式。
 *
 * 背景：`phrase` 模式把整句当成一个连续 bigram 序列，句子里一有寒暄、疑问尾或
 * 与记忆措辞不同的连接词，整句就 0 命中（R5 评测里 alias 0/40 是同一根因）。
 * 这里按「内容子句」重新组织，**只在 exact 结果为空时使用**，不改变排序与安全过滤。
 */
export function fallbackFtsQueries(analysis: FtsQueryAnalysis): string[] {
  const input = analysis.normalizedInput
  if (input.length === 0) return []

  // 按标点与空白切子句；太短的片段（<4 字符）单独检索没有意义。
  const clauses = input
    .split(/[，。！？、；：,.!?;:（）()【】[\]"'“”‘’…—\s]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
  const content = clauses.filter((clause) => !isFillerClause(clause) && compactLength(bigramText(clause)) >= 4)
  const usable = content.length > 0 ? content : clauses.filter((clause) => compactLength(bigramText(clause)) >= 4)
  if (usable.length === 0) return []

  const candidates: string[] = []
  // a. 清洗后整句（去掉寒暄/疑问子句，保留内容）
  candidates.push(quote(usable.join('')))
  // b. 每个内容子句单独 phrase，OR 组合（多子句问句里任一子句能对上即可）
  if (usable.length > 1) candidates.push(usable.map(quote).join(' OR '))
  // c. 每个内容子句取前 8 个 bigram（长句前面通常是实体/事件，后面是语气和疑问）
  for (const clause of usable) {
    const tokens = bigramText(clause).split(' ').filter((token) => token.length > 0)
    if (tokens.length >= 3) candidates.push(quote(tokens.slice(0, 8).join(' ')))
  }

  const exact = quote(input)
  return [...new Set(candidates)]
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate !== '' && candidate !== exact)
    .slice(0, 3)
}

/** 寒暄/疑问整句：不参与回退候选（避免「你还记得吗」单独去匹配）。 */
function isFillerClause(clause: string): boolean {
  const normalized = clause.replace(/[\s，。！？、；：,.!?;:（）()【】[\]"'“”‘’…—]/gu, '')
  if (normalized.length === 0) return true
  if (normalized.length > 12) return false
  return /^(那|那么|然后|你好|您好|请问|帮我|我想|我们|你还记得|你还记得吗|记得吗|还记得|还记得吗|嗯|哦|啊|呀|吧|呢|吗|呢吗|好吧|好的|谢谢)+$/u.test(
    normalized,
  )
}

/**
 * 最后一级回退：整句里实在没有可连续匹配的 bigram 时，用「句尾 2 字 / 句尾 1 字」做 LIKE。
 *
 * 典型场景是「那你平时喝什么茶？」——整句没有一段与记忆措辞连续，但句尾的「茶」能命中
 * 「用户喜欢喝乌龙茶」。这是兜底而不是主路径：只在 exact 与所有 FTS 回退都为 0 时才用，
 * 安全过滤（披露/状态/Scope/来源域）仍然全部生效。
 */
export function fallbackLikeHints(analysis: FtsQueryAnalysis): string[] {
  const text = analysis.normalizedInput.replace(/[^\u4e00-\u9fffA-Za-z0-9]+/gu, '')
  if (text.length === 0) return []
  const tail = text.replace(/[吗呢吧啊呀哦嗯嘛啦哈的了]/gu, '')
  const hints: string[] = []
  if (tail.length >= 2) hints.push(tail.slice(-2))
  if (tail.length >= 1) hints.push(tail.slice(-1))
  return [...new Set(hints)].slice(0, 2)
}

export interface FtsIndexInput {
  artifactId: string
  kind: string
  statement: string
}

/**
 * 写入（或替换）一条 head 的索引行。
 *
 * 旧行定位走 `fts_rowids`（kind/ref_id 上有 B-tree 主键，O(log N)）——直接按
 * `kind`/`ref_id` DELETE 会触发 FTS5 全表扫描，逐行 rebuild 因此是 O(N²)（E6-C1）。
 * 新行显式分配 rowid：FTS5 的 `last_insert_rowid()` 在两种驱动下不保证同一语义，
 * 按 kind/ref_id 回查又是全表扫，所以用「两表最大值 + 1」自己发号（删除后复用号是安全的，
 * 被复用的号同时已从映射表删掉）。
 *
 * 不变量：每一条 fts_index 行恰好对应一条 fts_rowids 行，反之亦然。两边读写必须在同一事务。
 */
export function upsertFtsRow(db: Db, input: FtsIndexInput): void {
  const existing = db.get<{ row_id: number }>(
    'SELECT row_id FROM fts_rowids WHERE kind = ? AND ref_id = ?',
    [input.kind, input.artifactId],
  )
  if (existing) {
    // 删除必须同时校验「这一行确实还是这条记忆」：映射被外部写坏时，只按 rowid 删
    // 会静默删掉别人的索引行（检索看着正常、后续删除错行）。宁可直接失败。
    const removed = db.run('DELETE FROM fts_index WHERE rowid = ? AND kind = ? AND ref_id = ?', [
      existing.row_id,
      input.kind,
      input.artifactId,
    ])
    if (removed.changes !== 1) {
      throw new PsycheError(CODE.ftsMapping, 'FTS 映射与索引不一致：映射指向的行不是这条记忆', {
        kind: input.kind,
        refId: input.artifactId,
        rowId: existing.row_id,
      })
    }
    db.run('DELETE FROM fts_rowids WHERE row_id = ? AND kind = ? AND ref_id = ?', [
      existing.row_id,
      input.kind,
      input.artifactId,
    ])
  }

  // 两边一起取最大：正常库一一对应，脏库（只有 FTS 行没有映射）也能自愈而不会撞 rowid。
  const next = db.get<{ next: number }>(
    `SELECT COALESCE(MAX(value), 0) + 1 AS next FROM (
       SELECT MAX(row_id) AS value FROM fts_rowids
       UNION ALL
       SELECT MAX(rowid) AS value FROM fts_index
     )`,
  )
  const rowId = next?.next ?? 1

  db.run('INSERT INTO fts_index (rowid, kind, ref_id, bigram_text, raw_text) VALUES (?, ?, ?, ?, ?)', [
    rowId,
    input.kind,
    input.artifactId,
    bigramText(input.statement),
    String(input.statement ?? '').slice(0, 2000),
  ])
  db.run('INSERT INTO fts_rowids (kind, ref_id, row_id) VALUES (?, ?, ?)', [
    input.kind,
    input.artifactId,
    rowId,
  ])
}

/** 删除一条 Artifact 的索引行（忘记/撤回头时用；只删除、不写墓碑）。 */
export function deleteFtsRow(db: Db, artifactId: string): void {
  const rows = db.all<{ row_id: number }>('SELECT row_id FROM fts_rowids WHERE ref_id = ?', [artifactId])
  for (const row of rows) {
    const removed = db.run('DELETE FROM fts_index WHERE rowid = ? AND ref_id = ?', [row.row_id, artifactId])
    if (removed.changes !== 1) {
      throw new PsycheError(CODE.ftsMapping, 'FTS 映射与索引不一致：删除时找不到对应的索引行', {
        refId: artifactId,
        rowId: row.row_id,
      })
    }
    db.run('DELETE FROM fts_rowids WHERE row_id = ? AND ref_id = ?', [row.row_id, artifactId])
  }
}

interface HeadRow {
  artifact_id: string
  kind: string
  statement: string
}

/** 取所有 Artifact 的 head（max revision）。只读。 */
function headRows(db: Db): HeadRow[] {
  return db.all<HeadRow>(
    `SELECT a.artifact_id, a.kind, r.statement
       FROM artifacts a
       JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
      WHERE r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)`,
  )
}

/**
 * 原子重建：清空后按 head 全量重写。用于「索引和库不一致」的修复（D4）。
 * 全量重建是幂等的，重复跑结果一致。
 * 两张表一起清、一起写：重建后 rowid 从 1 重新编号，映射表与 FTS 行一一对应。
 */
export function rebuildFtsIndex(db: Db): { indexed: number } {
  return db.transaction(() => {
    db.run('DELETE FROM fts_index')
    db.run('DELETE FROM fts_rowids')
    const rows = headRows(db)
    for (const row of rows) {
      upsertFtsRow(db, { artifactId: row.artifact_id, kind: row.kind, statement: row.statement })
    }
    return { indexed: rows.length }
  })
}

export interface FtsVerifyReport {
  /** 库里有 head、索引里没有 */
  missing: string[]
  /** 索引里有、库里没有对应 head */
  orphan: string[]
  /** 同一 ref_id 出现多行（头索引应唯一） */
  duplicate: string[]
  /** bigram_text 与 head 正文重新计算的结果不一致 */
  contentMismatch: string[]
  /** FTS 行没有对应的 fts_rowids 映射 */
  mapMissing: string[]
  /** fts_rowids 里有映射、FTS 表里没有对应 rowid */
  mapOrphan: string[]
  /** 同一 rowid 上 FTS 行与映射的 kind/ref_id 不一致 */
  mapMismatch: string[]
  /** FTS5 内部结构自检（integrity-check）是否通过 */
  integrityOk: boolean
  /** 参与核对的 head 数量 */
  headCount: number
  /** 索引行数量 */
  rowCount: number
}

/**
 * 只读核对（D4）：四类差异 + 映射表一致性 + FTS5 内部完整性。
 * 只报告不自动修——自动修会把「为什么坏」一起修掉。
 */
export function verifyFtsIndex(db: Db): FtsVerifyReport {
  const heads = headRows(db)
  const rows = db.all<{ ref_id: string; kind: string; bigram_text: string }>(
    'SELECT ref_id, kind, bigram_text FROM fts_index',
  )
  const headMap = new Map(heads.map((row) => [row.artifact_id, row]))
  const seen = new Map<string, number>()
  for (const row of rows) seen.set(row.ref_id, (seen.get(row.ref_id) ?? 0) + 1)

  const missing = heads.filter((row) => !seen.has(row.artifact_id)).map((row) => row.artifact_id)
  const orphan = rows.filter((row) => !headMap.has(row.ref_id)).map((row) => row.ref_id)
  const duplicate = [...seen.entries()].filter(([, count]) => count > 1).map(([refId]) => refId)
  const contentMismatch = rows
    .filter((row) => {
      const head = headMap.get(row.ref_id)
      return head !== undefined && row.bigram_text !== bigramText(head.statement)
    })
    .map((row) => row.ref_id)

  // 映射表一致性：每条 FTS 行恰好一条映射，反之亦然（E6-C1 的不变量）。
  const ftsRowIds = db.all<{ row_id: number; kind: string; ref_id: string }>(
    'SELECT rowid AS row_id, kind, ref_id FROM fts_index',
  )
  const mappingRows = db.all<{ kind: string; ref_id: string; row_id: number }>(
    'SELECT kind, ref_id, row_id FROM fts_rowids',
  )
  const ftsByRowId = new Map(ftsRowIds.map((row) => [row.row_id, row]))
  const mapByRowId = new Map(mappingRows.map((row) => [row.row_id, row]))
  const mapMissing = ftsRowIds.filter((row) => !mapByRowId.has(row.row_id)).map((row) => row.ref_id)
  const mapOrphan = mappingRows.filter((row) => !ftsByRowId.has(row.row_id)).map((row) => row.ref_id)
  const mapMismatch = ftsRowIds
    .filter((row) => {
      const mapped = mapByRowId.get(row.row_id)
      return mapped !== undefined && (mapped.kind !== row.kind || mapped.ref_id !== row.ref_id)
    })
    .map((row) => row.ref_id)

  let integrityOk = true
  try {
    db.run("INSERT INTO fts_index(fts_index) VALUES ('integrity-check')")
  } catch {
    integrityOk = false
  }

  return {
    missing,
    orphan,
    duplicate,
    contentMismatch,
    mapMissing,
    mapOrphan,
    mapMismatch,
    integrityOk,
    headCount: heads.length,
    rowCount: rows.length,
  }
}

export interface FtsHit {
  artifactId: string
  kind: string
  statement: string
  state: string
  /** 当前 head 的版本号；Composer 注入前可据此二次确认（防检索后被 revise） */
  revision: number
  /** 当前 head 的披露等级；正常检索只返回 public，字段用于调用方复核 */
  disclosure: string
  score: number
}

export interface FtsSearchOptions {
  limit?: number
  kind?: string
  /** 默认只召回 active / challenged；superseded / retracted / forgotten 一律排除 */
  states?: string[]
  /**
   * 可信 Scope（R3）。只能来自 RuntimeInput / Owner 授权上下文，绝不能来自模型参数。
   * 缺 Contact 时仅允许全局 Subject；可信 group + Room 可例外召回同 Room 有证据的成员结论。
   */
  scope?: FtsScope
  /** 精确成员匹配的 subject id（ct_xxx / user / topic 名）；不是子串。 */
  subject?: string
}

/**
 * 当前请求落在哪种可信运行表面。可见性由它决定，而不是「请求快照是否存在」：
 * 桌面/Web/System 是个人表面；QQ 私聊是 private；群聊是 group。
 */
export type RecallSurface = 'personal' | 'private' | 'group'

export interface FtsScope {
  /** 当前可信 Contact；群表面可仅绑定 Room，不能据此读取任何成员的私聊域。 */
  contactId?: string | null
  /**
   * 当前可信群（rooms.room_id，稳定主键，不是群名称/群号明文）。
   * 由 platform + 外部群号经 rooms 解析得到；解析不到时为空 → 群来源的结论不可见。
   */
  roomId?: string | null
  /**
   * 可信运行表面（由 Host/Adapter 注入，不由模型参数声明）。
   * - personal：允许 personal 域与当前 Contact 的 private 域；
   * - private：只允许当前 Contact 的 private 域；
   * - group：只允许当前 Room 的 group 域。
   * 未提供时退回到显式的 allowPersonal/allowContact/allowRoom 开关（兼容纯检索调用）。
   */
  surface?: RecallSurface
  /**
   * 是否允许个人域（desktop / web / system 来源）。
   * 仅在 surface 未提供时生效；默认 false——有身份不等于运行表面是个人。
   */
  allowPersonal?: boolean
  /** 是否允许当前 Contact 的 private 域；默认按 contactId 是否存在（surface 未提供时）。 */
  allowContact?: boolean
  /** 是否允许当前 Room 的 group 域；默认按 roomId 是否存在（surface 未提供时）。 */
  allowRoom?: boolean
}

/** 召回默认排除的失效状态（与 A2 §2.2 一致；challenged 可召回、带争议标记）。 */
export const FTS_DEFAULT_STATES = ['active', 'challenged']

/**
 * R3 / H21：Subject 准入。必须与 visibilityConditions 一起用于查询，后者判全部 Evidence 的来源域。
 *
 * - 全局记忆 = `subject_refs` 里没有任何 `ct_` 元素（可以跨渠道，但仍受披露/状态约束）；
 * - Contact 私有 = `ct_` 元素精确等于当前 contactId（不是子串——`ct_a` 不能命中 `ct_aa`）；
 * - 可信 group + Room 只为有 Evidence 的 ct_ Subject 提供例外，不授予任何私聊可见性；
 * - `subject_refs` 不是合法 JSON 的历史脏值按「不安全」处理（既不算全局、也不参与精确匹配）。
 */
export function subjectScopeConditions(scope?: FtsScope): { sql: string; params: SqlParam[] } {
  // A group sender never supplies Contact privileges, including the legacy no-Evidence global case.
  const contact = scope?.surface !== 'group' && typeof scope?.contactId === 'string' ? scope.contactId.trim() : ''
  const room = scope?.surface === 'group' && typeof scope.roomId === 'string' ? scope.roomId.trim() : ''
  // CASE guards json_each even for corrupt historical JSON; do not rely on AND evaluation order.
  return {
    sql: `AND (CASE WHEN json_valid(r.subject_refs) = 0 THEN 0 ELSE (
      NOT EXISTS (SELECT 1 FROM json_each(r.subject_refs) WHERE value GLOB 'ct_*')
      OR (? IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(r.subject_refs) WHERE value = ?))
      OR (? IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(r.subject_refs) WHERE value GLOB 'ct_*')
          AND EXISTS (SELECT 1 FROM artifact_evidence ve
                       WHERE ve.artifact_id = r.artifact_id AND ve.revision = r.revision))
    ) END) = 1`,
    params: [contact || null, contact || null, room || null],
  }
}

export function hasRevisionEvidence(db: Db, artifactId: string, revision: number): boolean {
  return db.get('SELECT 1 FROM artifact_evidence WHERE artifact_id = ? AND revision = ? LIMIT 1', [artifactId, revision]) !== undefined
}

/** Composer rechecks untrusted candidates using exactly the same Subject predicate as retrieval. */
export function isArtifactSubjectAllowedInScope(db: Db, artifactId: string, revision: number, scope: FtsScope): boolean {
  const filter = subjectScopeConditions(scope)
  return db.get(`SELECT 1 FROM artifact_revisions r WHERE r.artifact_id=? AND r.revision=? ${filter.sql}`, [artifactId, revision, ...filter.params]) !== undefined
}

/** Scope 与显式 Subject 的过滤都在 LIMIT 之前。 */
function scopeConditions(options: FtsSearchOptions): { sql: string; params: SqlParam[] } {
  const subject = typeof options.subject === 'string' ? options.subject.trim() : ''
  const filter = subjectScopeConditions(options.scope)
  const parts = [filter.sql]
  const params = [...filter.params]

  if (subject.length > 0) {
    parts.push(
      `AND json_valid(r.subject_refs) = 1 AND EXISTS (SELECT 1 FROM json_each(r.subject_refs) WHERE value = ?)`,
    )
    params.push(subject)
  }
  return { sql: parts.join('\n       '), params }
}

/**
 * R3.1：来源域准入（Channel / Group Scope），同样下推到 SQL、发生在 LIMIT 之前。
 *
 * 规则（用户冻结）：一个 Artifact 的可见范围由它**全部**有效 Evidence 的来源域共同决定，
 * 多来源取最严交集；任何一条来源与当前上下文不兼容，整条结论不可见。
 *
 * - desktop / web / system → personal，仅当 allowPersonal（存在可信身份）时可见；
 * - private → 该 Contact 私聊（sender_contact_id 精确等于当前 contactId）；
 * - group → 该 room（room_id 精确等于解析后的当前 roomId）；
 * - 无 Evidence → global，可跨渠道（仍受 state/disclosure/Contact 约束）；
 * - 有 Evidence 但 Source 丢失/渠道无法解析 → 不安全，拒绝（不能因为脏数据扩大可见范围）；
 * - 多来源来自不同域 → 至少一条不兼容 → 拒绝（mixed 不可见）。
 */
export function visibilityConditions(options: FtsSearchOptions): { sql: string; params: SqlParam[] } {
  // 调用方没有声明 Scope（options.scope === undefined）＝ 纯检索（诊断/评测/单元测试），
  // 不施加来源域准入；一旦声明了 Scope（哪怕是空对象「明确没有身份」），就按严格规则执行。
  if (options.scope === undefined) return { sql: '', params: [] }
  const contact = typeof options.scope?.contactId === 'string' ? options.scope.contactId.trim() : ''
  const room = typeof options.scope?.roomId === 'string' ? options.scope.roomId.trim() : ''
  // 允许域由「运行表面」决定，而不是「有没有身份」：QQ 群聊里发送者也有 contactId，
  // 但发送者的私聊记忆不能因此进入群聊。
  const surface = options.scope?.surface
  let allowPersonal: boolean
  let allowContact: boolean
  let allowRoom: boolean
  if (surface === 'personal') {
    // 个人表面上默认允许 personal 域；显式 allowPersonal:false 仍可收紧（测试/诊断用）。
    allowPersonal = options.scope?.allowPersonal !== false
    allowContact = true
    allowRoom = false
  } else if (surface === 'private') {
    allowPersonal = false
    allowContact = true
    allowRoom = false
  } else if (surface === 'group') {
    allowPersonal = false
    allowContact = false
    allowRoom = true
  } else {
    // 兼容纯检索调用：显式开关优先；没有 surface 时 personal 默认关闭。
    allowPersonal = options.scope?.allowPersonal === true
    allowContact = options.scope?.allowContact ?? contact.length > 0
    allowRoom = options.scope?.allowRoom ?? room.length > 0
  }
  const contactParam = contact.length > 0 ? contact : null
  const roomParam = room.length > 0 ? room : null
  // 1) 全部来源必须属于同一个域（personal / contact:X / room:Y / unknown）；
  //    混域（private + group、Contact A + Contact B 等）一律 mixed，普通 Recall 不可见。
  // 2) 该域必须与当前上下文兼容；任何一条来源不兼容都拒绝整条结论。
  // 3) 无 Evidence 才是 global；有 Evidence 但 Source 丢失 → unknown，拒绝。
  const sql = `AND (
      NOT EXISTS (SELECT 1 FROM artifact_evidence ve0
                   WHERE ve0.artifact_id = r.artifact_id AND ve0.revision = r.revision)
      OR EXISTS (
        SELECT 1
          FROM artifact_evidence ve
          LEFT JOIN sources s2 ON s2.source_id = ve.source_id
         WHERE ve.artifact_id = r.artifact_id AND ve.revision = r.revision
         GROUP BY ve.artifact_id, ve.revision
        HAVING COUNT(DISTINCT (
                 CASE
                   WHEN s2.source_id IS NULL THEN 'unknown'
                   WHEN s2.channel IN ('desktop', 'web', 'system') THEN 'personal'
                   WHEN s2.channel = 'private' THEN 'contact:' || COALESCE(s2.sender_contact_id, '?')
                   WHEN s2.channel = 'group' THEN 'room:' || COALESCE(s2.room_id, '?')
                   ELSE 'unknown'
                 END)) = 1
           AND SUM(CASE WHEN (
                 (s2.channel IN ('desktop', 'web', 'system') AND ? = 1)
                 OR (s2.channel = 'private' AND ? = 1 AND ? IS NOT NULL AND s2.sender_contact_id = ?)
                 OR (s2.channel = 'group' AND ? = 1 AND ? IS NOT NULL AND s2.room_id = ?)
               ) THEN 0 ELSE 1 END) = 0
      )
    )`
  return {
    sql,
    params: [
      allowPersonal ? 1 : 0,
      allowContact ? 1 : 0,
      contactParam,
      contactParam,
      allowRoom ? 1 : 0,
      roomParam,
      roomParam,
    ],
  }
}

/**
 * R6-2.1：单条 Artifact Revision 在当前可信 Scope 下是否仍可见。
 *
 * 最终检查（`llm/stream`）在请求真正发给 Provider 前调用它，复用与检索完全相同的
 * 来源域规则（`visibilityConditions`），不另写一套近似 SQL——两套实现迟早会漂移，
 * 而漂移的那一次就是越权。
 *
 * 说明：这里只判来源域；state / disclosure / head 仍由 `final-check.ts` 逐条复核。
 */
export function isArtifactVisibleInScope(
  db: Db,
  artifactId: string,
  revision: number,
  scope: FtsScope,
): boolean {
  const visible = visibilityConditions({ scope })
  if (visible.sql.length === 0) return true
  const row = db.get<{ one: number }>(
    `SELECT 1 AS one
       FROM artifact_revisions r
      WHERE r.artifact_id = ? AND r.revision = ?
      ${visible.sql}`,
    [artifactId, revision, ...visible.params],
  )
  return row !== undefined
}

/**
 * 生产检索：FTS5 找候选 → 硬过滤 head/state/disclosure → 原生 BM25 排序 → 稳定同分。
 *
 * 过滤条件全部放在 SQL 里（D4 修正：先过滤再截断，避免失效候选占满名额）。
 * 披露过滤硬编码为 `disclosure = 'public'`：没有 includeRestricted 开关，
 * 业务调用方拿不到未过滤结果；受限诊断由测试直接读 fts_index 验证，不经过这个入口。
 */
export function searchFts(db: Db, query: string, options: FtsSearchOptions = {}): FtsHit[] {
  const trimmed = String(query ?? '').trim()
  const length = Array.from(trimmed).length
  if (length > MAX_QUERY_CHARS) {
    // 不静默截断：截断可能恰好切掉否定词、范围限定或实体名，返回一份「看起来正常、
    // 其实不是你要的」结果。调用方要自己决定是重写查询还是拒绝。
    throw new PsycheError(
      CODE.queryTooLong,
      `查询太长：${length} 字符，上限 ${MAX_QUERY_CHARS} 字符`,
      { length, max: MAX_QUERY_CHARS },
    )
  }

  const analysis = analyzeFtsQuery(trimmed)
  const segmentCount = analysis.ftsSegments.length + analysis.likeSegments.length
  if (segmentCount > MAX_QUERY_SEGMENTS || analysis.likeSegments.length > MAX_LIKE_SEGMENTS) {
    throw new PsycheError(
      CODE.queryTooComplex,
      `查询片段太多：${segmentCount} 段（单字 ${analysis.likeSegments.length}），上限 ${MAX_QUERY_SEGMENTS} 段 / ${MAX_LIKE_SEGMENTS} 个单字`,
      { segments: segmentCount, likeSegments: analysis.likeSegments.length, maxSegments: MAX_QUERY_SEGMENTS, maxLikeSegments: MAX_LIKE_SEGMENTS },
    )
  }
  if (analysis.mode === 'like') return searchLike(db, analysis.likeSegments, options)

  const expression = buildFtsQuery(analysis)
  const exact = matchFts(db, expression, analysis.likeSegments, options)
  if (exact.length > 0) return exact

  // 短查询不做回退：4–6 个字的查询（「股票行情」「猫叫什么名字」）精确为空就是没这条记忆，
  // 放宽只会捞出不相关的假阳性。回退只服务长句/问句（含寒暄、疑问、多子句）。
  if (Array.from(trimmed).length < FALLBACK_MIN_QUERY_CHARS) return exact

  // exact 为空才回退：只换 MATCH 表达式，安全过滤、Scope、排序规则全部不变。
  // 回退不带单字 LIKE 条件——长句里的单字片段多半是语气词，带上反而把结果卡回 0。
  for (const candidate of fallbackFtsQueries(analysis)) {
    const relaxed = matchFts(db, candidate, [], options)
    if (relaxed.length > 0) return relaxed
  }
  // 最后一级：句尾短片段 LIKE（典型是「那你平时喝什么茶？」这类整句无连续 bigram 的问句）。
  for (const hint of fallbackLikeHints(analysis)) {
    const relaxed = searchLike(db, [hint], options)
    if (relaxed.length > 0) return relaxed
  }
  return exact
}

/** 执行一次 MATCH 查询（安全过滤/Scope/排序都在这里，回退只换 expression）。 */
function matchFts(
  db: Db,
  expression: string,
  likeSegments: string[],
  options: FtsSearchOptions,
): FtsHit[] {
  const limit = Math.max(1, Math.min(options.limit ?? 8, 50))
  const states = options.states ?? FTS_DEFAULT_STATES
  const placeholders = states.map(() => '?').join(', ')

  // 单字片段保留为 LIKE 条件（不删条件、不改写语义）：`不 喜欢` → MATCH "喜欢" AND LIKE %不%。
  const likeConditions = likeSegments
    .map(() => "AND r.statement LIKE ? ESCAPE '\\'")
    .join('\n       ')
  const scoped = scopeConditions(options)
  const visible = visibilityConditions(options)

  const sql = `
    SELECT fts_index.ref_id AS artifactId, fts_index.kind AS kind, fts_index.raw_text AS statement,
           r.state AS state, r.revision AS revision, r.disclosure AS disclosure,
           -bm25(fts_index, 0.0, 0.0, 1.0, 0.0) AS score
      FROM fts_index
      JOIN artifacts a ON a.artifact_id = fts_index.ref_id
      JOIN artifact_revisions r ON r.artifact_id = fts_index.ref_id
       AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = fts_index.ref_id)
     WHERE fts_index.bigram_text MATCH ?
       AND r.disclosure = 'public'
       AND r.state IN (${placeholders})
       ${likeConditions}
       ${scoped.sql}
       ${visible.sql}
       ${andMemoryActive('a')}
       AND ${andHeadEvidenceSourcesActive('a', 'r.revision')}
       ${options.kind ? 'AND fts_index.kind = ?' : ''}
     ORDER BY score DESC, fts_index.ref_id ASC
     LIMIT ?`

  const params: SqlParam[] = [expression, ...states]
  params.push(...likeSegments.map(likePattern))
  params.push(...scoped.params)
  params.push(...visible.params)
  if (options.kind) params.push(options.kind)
  params.push(limit)
  return db.all<FtsHit>(sql, params)
}

/** LIKE 模式：转义 `%`、`_`、`\` 后包成 `%...%`。 */
function likePattern(value: string): string {
  const escaped = value.replace(/[%_\\]/g, (char) => `\\${char}`)
  return `%${escaped}%`
}

/** 全片段 LIKE 查询：单字条件不进 MATCH，但必须保留（全部片段 AND 组合）。 */
function searchLike(db: Db, segments: string[], options: FtsSearchOptions): FtsHit[] {
  const parts = segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
  if (parts.length === 0) return []
  const limit = Math.max(1, Math.min(options.limit ?? 8, 50))
  const states = options.states ?? FTS_DEFAULT_STATES
  const placeholders = states.map(() => '?').join(', ')
  const conditions = parts.map(() => "AND r.statement LIKE ? ESCAPE '\\'").join('\n       ')
  const scoped = scopeConditions(options)
  const visible = visibilityConditions(options)
  const sql = `
    SELECT a.artifact_id AS artifactId, a.kind AS kind, r.statement AS statement,
           r.state AS state, r.revision AS revision, r.disclosure AS disclosure, 0 AS score
      FROM artifacts a
      JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
       AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
     WHERE r.disclosure = 'public'
       AND r.state IN (${placeholders})
       ${conditions}
       ${scoped.sql}
       ${visible.sql}
       ${andMemoryActive('a')}
       AND ${andHeadEvidenceSourcesActive('a', 'r.revision')}
       ${options.kind ? 'AND a.kind = ?' : ''}
     ORDER BY a.artifact_id ASC
     LIMIT ?`
  const params: SqlParam[] = [...states, ...parts.map(likePattern)]
  params.push(...scoped.params)
  params.push(...visible.params)
  if (options.kind) params.push(options.kind)
  params.push(limit)
  return db.all<FtsHit>(sql, params)
}
