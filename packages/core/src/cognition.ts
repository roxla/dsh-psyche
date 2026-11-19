/**
 * 认知派生层的 DB 侧（v14 §21.2 的 P2 部分）：把库里的行读成纯函数的输入。
 *
 * 职责：只读地把 artifacts / revisions / evidence / trigger events 拼成 salience 的入参。
 * 为什么单独一层：`salience.ts` 要保持零 IO，SQL 必须待在外面；这里不写库、不回填 `salience` 列、不调模型。
 * 被谁调用：`panel.ts`（面板显著度）、`sea.ts`（意识海亮度）。
 * 关键不变量：
 *   1. 只读——不改 events / artifacts / revisions，全部结果都能重算；
 *   2. 只看 head revision 的证据——旧版本的证据属于旧结论，不重复计分；
 *   3. 任何一条 SQL 失败都由调用方 try/catch 兜（本文件不吞异常）。
 */
import { Db, nowIso } from './adapter.js'
import { deriveSalience } from './salience.js'
import type { SalienceEntry, SalienceEvidenceInput, SalienceInput } from './salience.js'

/** 显著度只看 head revision 的证据——旧版本的证据属于旧结论，不重复计分。 */
interface HeadRow {
  artifact_id: string
  kind: string
  revision: number
  state: string
  confidence: string
  statement: string
  created_at: string
  updated_at: string
}

/** `artifact_evidence` 的一行；`independence_key` 由 Capture 生成，模型填不了。 */
interface EvidenceRow {
  artifact_id: string
  revision: number
  relation: string
  independence_key: string
}

/** `GROUP BY artifact_id` 的结果行：artifact → 条数。 */
interface CountRow {
  artifact_id: string
  amount: number
}

/** 最后一次被提到的时间；一条触发事件都没有的结论是 null。 */
interface SeenRow {
  artifact_id: string
  last_at: string | null
}

/** 读显著度输入的过滤条件：取多少条、只看哪几种 kind。 */
export interface SalienceLoadOptions {
  /** 最多看多少条结论（按 updated_at 倒序）。默认 300。 */
  limit?: number
  /** 只看某几种 kind；默认全部。 */
  kinds?: readonly string[]
}

/**
 * 读显著度输入，只读。
 *
 * 参数 `db`：适配器（同步 better-sqlite3 风格）；`options`：条数上限与 kind 过滤。
 * 返回：按 `updated_at` 倒序的 `SalienceInput[]`；库里没有结论时返回空数组（不抛错）。
 *
 * 计分只认三件事（评审第 5 点）：独立经历、验证次数、实际后果。
 * 这里的三条 SQL 分别对应它们，任何一条失败都让调用方自己兜（上层已 try/catch）。
 */
export function loadSalienceInputs(db: Db, options: SalienceLoadOptions = {}): SalienceInput[] {
  // 上限整数化并夹到 ≥ 1：LIMIT 0 会让面板看起来「一条结论都没有」，比慢更误导。
  const limit = Math.max(1, Math.trunc(options.limit ?? 300))
  // kinds 只在非空时生效；空数组等于「不过滤」，不是「一条都不要」。
  const kinds = options.kinds && options.kinds.length > 0 ? options.kinds : null
  // 占位符按 kinds 个数生成，值走参数绑定——kind 是字符串，绝不拼进 SQL。
  const kindFilter = kinds ? `AND a.kind IN (${kinds.map(() => '?').join(', ')})` : ''

  // 每条约结论只取 head revision：关联条件里的 MAX(revision) 子查询保证「一个 artifact 一行」，
  // 否则同一结论的历史版本会各算一次，把显著度和条数都撑大。
  const heads = db.all<HeadRow>(
    `SELECT a.artifact_id, a.kind, r.revision, r.state, r.confidence, r.statement, r.created_at, r.updated_at
       FROM artifacts a
       JOIN artifact_revisions r
         ON r.artifact_id = a.artifact_id
        AND r.revision = (SELECT MAX(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
      WHERE 1 = 1 ${kindFilter}
      ORDER BY r.updated_at DESC
      LIMIT ?`,
    kinds ? [...kinds, limit] : [limit],
  )
  if (heads.length === 0) return []

  const evidenceByKey = new Map<string, SalienceEvidenceInput[]>()
  // 证据表整表扫一次再在内存里按 `artifact_id#revision` 分组：
  // 表很小，分页取反而要多写一条 `IN (...)` 的动态占位符，得不偿失。
  const evidenceRows = db.all<EvidenceRow>(
    `SELECT artifact_id, revision, relation, independence_key FROM artifact_evidence`,
  )
  for (const row of evidenceRows) {
    const key = `${row.artifact_id}#${row.revision}`
    const list = evidenceByKey.get(key) ?? []
    list.push({
      relation: row.relation as SalienceEvidenceInput['relation'],
      independenceKey: row.independence_key,
    })
    evidenceByKey.set(key, list)
  }

  /** 复核次数：`review_result` 触发事件，`COUNT(DISTINCT e.event_id)` 按事件去重。 */
  const verifyByArtifact = new Map<string, number>()
  for (const row of db.all<CountRow>(
    `SELECT t.artifact_id, COUNT(DISTINCT e.event_id) AS amount
       FROM artifact_trigger_events t
       JOIN events e ON e.event_id = t.event_id
      WHERE e.type = 'review_result'
      GROUP BY t.artifact_id`,
  )) {
    verifyByArtifact.set(row.artifact_id, Number(row.amount ?? 0))
  }

  /** 实际后果：撞上反驳 / 行动结果事件。 */
  const consequenceByArtifact = new Map<string, number>()
  for (const row of db.all<CountRow>(
    `SELECT t.artifact_id, COUNT(DISTINCT e.event_id) AS amount
       FROM artifact_trigger_events t
       JOIN events e ON e.event_id = t.event_id
      WHERE e.type IN ('conflict', 'action_result')
      GROUP BY t.artifact_id`,
  )) {
    consequenceByArtifact.set(row.artifact_id, Number(row.amount ?? 0))
  }

  /** 明确矛盾关系也算后果（tensionWith / contradicts 指出去的那一边）。 */
  // 注意这里是**累加**到事件计数上，不是覆盖：同一条结论既可能有冲突事件、也可能有矛盾关系。
  for (const row of db.all<CountRow>(
    `SELECT artifact_id, COUNT(*) AS amount
       FROM artifact_relations
      WHERE relation IN ('contradicts', 'tensionWith')
      GROUP BY artifact_id`,
  )) {
    const current = consequenceByArtifact.get(row.artifact_id) ?? 0
    consequenceByArtifact.set(row.artifact_id, current + Number(row.amount ?? 0))
  }

  /** 最后一次被提到的时间。 */
  const seenByArtifact = new Map<string, string | null>()
  for (const row of db.all<SeenRow>(
    `SELECT t.artifact_id, MAX(e.at) AS last_at
       FROM artifact_trigger_events t
       JOIN events e ON e.event_id = t.event_id
      GROUP BY t.artifact_id`,
  )) {
    seenByArtifact.set(row.artifact_id, row.last_at ?? null)
  }

  return heads.map((head) => ({
    artifactId: head.artifact_id,
    kind: head.kind,
    // 数据库里是 INTEGER，这里统一转成 number，避免驱动给出 BigInt 时参与运算报错。
    revision: Number(head.revision),
    state: head.state,
    confidence: head.confidence,
    statement: head.statement,
    createdAt: head.created_at,
    updatedAt: head.updated_at,
    // 从没被触发事件提到过 → 用 updated_at 兜底，等价于「刚更新过」，不会被当成极冷。
    lastSeenAt: seenByArtifact.get(head.artifact_id) ?? head.updated_at,
    // 证据只取 head revision 那一组（`artifact_id#revision`），旧版本不参与计分。
    evidence: evidenceByKey.get(`${head.artifact_id}#${head.revision}`) ?? [],
    verificationCount: verifyByArtifact.get(head.artifact_id) ?? 0,
    consequenceCount: consequenceByArtifact.get(head.artifact_id) ?? 0,
  }))
}

/**
 * 只读派生：面板、意识海亮度、将来的 fold 都从这里拿。
 *
 * 参数 `db`：适配器；`options`：条数 / kind 过滤，外加可注入的 `now`（测试用）。
 * 返回：排好序的显著度条目；`now` 缺省取 `nowIso()`，所以同一次请求内所有条目共用同一时刻。
 */
export function deriveSalienceNow(
  db: Db,
  options: SalienceLoadOptions & { now?: string } = {},
): SalienceEntry[] {
  const inputs = loadSalienceInputs(db, options)
  return deriveSalience(inputs, options.now ?? nowIso())
}
