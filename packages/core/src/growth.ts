/**
 * 成长计算层的 DB 侧（设计文档 v14 §21–§22 的 P1 部分）。
 *
 * 分工：`derive.ts` 只算，这里只负责「把库里的行读成 derive 的输入」和
 * 「当一道闸真的过了，把晋级写成里程碑」。
 *
 * 边界（不许越）：
 * - 不写 events / artifacts —— 晋级不制造经历；
 * - 不调模型 —— 判据是 SQL + 纯函数；
 * - 不因为时间流逝升级 —— 这里没有「等了多久」这个变量。
 *
 * 不变量（改代码前先读这三条）：
 * - 阶段单调：只升不降，任何「撤回/脱敏」都不回退 phase_state；
 * - 晋级必须有据：每次 UPDATE phase_state 都同笔写 phase_milestones + phase_evidence；
 * - 人只负责最后一道闸：integration 只能由人确认，且前三道闸仍要按证据过。
 *
 * 谁在调：`core.ts` 的成长入口、`psyche_context`（只要只读派生）、
 * 工具层的 `psyche_propose` / `psyche_review`（走 proposals 分区）、以及测试。
 * 所有写路径都是 `db.transaction(..., { important: true })`。
 */
import { Db, nowIso } from './adapter.js'
import { PREFIX, newId } from './ids.js'
import {
  ALGORITHM_VERSION,
  PHASE_LABELS,
  PHASE_ORDER,
  deriveGrowth,
  nextPhase,
} from './derive.js'
import type { DeriveInput, Gate, GrowthDerivation, Phase } from './derive.js'

/**
 * 派生层的输入快照：完全是 `derive.ts` 里 `DeriveInput` 的字段子集 + 当前阶段。
 *
 * 为什么单独抽一个类型：`loadGrowthInputs` 是唯一的读库入口，
 * 把它读出来的形状固定下来，derive 才能被单测用假数据喂（不起库）。
 * 只读快照：这里的数据在派生过程中不会变，derive 也不该回写。
 */
export interface GrowthInputs {
  /** phase_state 里的当前阶段；行缺失或值非法时按 'trust' 处理。 */
  currentPhase: Phase
  /** 第一条事件的 at，用来算「成长了多久」；库里一条事件都没有时为 null。 */
  firstEventAt: string | null
  /** 每件 belief 的**最新版本**状态 + 支撑它的独立键（已按 revision 归好）。 */
  beliefs: DeriveInput['beliefs']
  /** 拒绝类事件 + 各自的独立键（拿不到来源键时退化到 event id）。 */
  refusals: DeriveInput['refusals']
  /** 只收「新版本带来新独立键」的修订；纯措辞修改不进这个列表。 */
  corrections: DeriveInput['corrections']
  /** 未被脱敏的 integration 里程碑条数（人确认过几次）。 */
  integrationConfirmed: number
}

/**
 * phase_state 的行形状（本文件自用，不外泄）。
 * since = 进入当前阶段的时间；stalled_at 目前只读不写（留给停滞提示）。
 */
interface PhaseRow {
  phase: string
  since: string
  updated_at: string
  stalled_at: string | null
}

/**
 * 按「artifact#revision」聚合独立证据键。
 *
 * 为什么按 revision 分组而不是按 artifact：同一个结论的旧版本可能由 A 证据支撑，
 * 新版本由 A+B 支撑 —— 判「这次修订是否带来新信息」必须能逐版本对比。
 * 只取 `relation='supports'`：反驳/触发类的证据不能当成「支撑」，否则闸门会被反向证据灌满。
 * 空键直接丢弃：没有独立键就无法证明「两次观察互不相关」，留空等于允许重复计数。
 */
function keysByRevision(db: Db): Map<string, string[]> {
  const rows = db.all<{ artifact_id: string; revision: number; independence_key: string | null }>(
    `SELECT artifact_id, revision, independence_key
       FROM artifact_evidence
      WHERE relation = 'supports'`,
  )
  const map = new Map<string, string[]>()
  for (const row of rows) {
    // trim 后会变成空串（全空白），和 NULL 一起被下面的 `if (!key) continue` 统一丢掉
    const key = typeof row.independence_key === 'string' ? row.independence_key.trim() : ''
    if (!key) continue
    const id = `${row.artifact_id}#${row.revision}`
    const list = map.get(id)
    if (list) {
      // 同一条证据可能被重复关联（同一 source 两次写入），去重后才算「独立来源数」
      if (!list.includes(key)) list.push(key)
    } else {
      map.set(id, [key])
    }
  }
  return map
}

/**
 * 把库里的现状读成派生层的输入。只读，不改任何东西。
 *
 * 参数：db 已打开（不要求已迁移，但缺表会抛驱动错误）。
 * 返回：上面 `GrowthInputs`；四块查询各自独立，不做事务 ——
 * 只读快照允许「读到写之间的一致性问题」，因为调用方（advancePhase / decide）
 * 会把整个读取+判定+落库放进同一个事务，那里才是一致性边界。
 * 副作用：无（纯 SELECT）。
 * 抛：驱动层的错误（E_DB / 表不存在），不做业务包装。
 */
export function loadGrowthInputs(db: Db): GrowthInputs {
  // 单人格设计：persona_id 恒为 'main'，所以这里不做「取唯一行」的容错
  const personaId = 'main'
  const phaseRow = db.get<PhaseRow>(`SELECT phase, since, updated_at, stalled_at FROM phase_state WHERE persona_id = ?`, [
    personaId,
  ])
  // 值必须落在已知阶段表里：历史行/手改过的库可能存着旧值，非法值一律当最保守的 trust
  const currentPhase = (PHASE_ORDER as readonly string[]).includes(phaseRow?.phase ?? '')
    ? (phaseRow!.phase as Phase)
    : 'trust'

  const keys = keysByRevision(db)

  // belief 取每个对象的最新版本：只有当前表述才算「现在信什么」，
  // 旧版本是被取代的判断，把它算进闸门会让「改过口」也变成通过条件。
  // 相关子查询 MAX(revision) 不用 GROUP BY：artifact_revisions 主键是 (artifact_id, revision)，
  // 这样写能走主键索引，且不需要在建表时额外造 heads 表。
  const beliefRows = db.all<{ artifact_id: string; revision: number; state: string; confidence: string }>(
    `SELECT a.artifact_id, r.revision, r.state, r.confidence
       FROM artifacts a
       JOIN artifact_revisions r
         ON r.artifact_id = a.artifact_id
        AND r.revision = (SELECT MAX(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)
      WHERE a.kind = 'belief'
      ORDER BY a.updated_at DESC`,
  )
  const beliefs = beliefRows.map((row) => ({
    artifactId: row.artifact_id,
    revision: row.revision,
    state: row.state,
    confidence: row.confidence,
    independenceKeys: keys.get(`${row.artifact_id}#${row.revision}`) ?? [],
    // 会话引用目前不从库里补：这个字段是 derive 的预留位，留空数组而不是 undefined 让下游少判空
    sessionRefs: [] as string[],
  }))

  // 拒绝类证据：一个事件可能有多个来源，取**最早那次捕获**的来源作为它的独立键。
  // 为什么要降级链：independence_key 是显式声明的「这次观察与别的观察不独立」，
  // 没声明时退到 activity_window_key（同一活动窗口内算同一次经历），
  // 再没有就退到 source:<id>（至少不同来源算不同）。
  const refusalRows = db.all<{ event_id: string; at: string; window_key: string | null }>(
    `SELECT ev.event_id,
            ev.at,
            (SELECT COALESCE(s.independence_key, s.activity_window_key, 'source:' || s.source_id)
               FROM event_sources es
               JOIN sources s ON s.source_id = es.source_id
              WHERE es.event_id = ev.event_id
              ORDER BY s.captured_at
              LIMIT 1) AS window_key
       FROM events ev
      WHERE ev.type = 'refusal'
      ORDER BY ev.at`,
  )
  const refusals = refusalRows.map((row) => ({
    eventId: row.event_id,
    at: row.at,
    // 一个来源都没有时用事件自身兜底：宁可少算一个独立键，也不能让这次拒绝凭空消失
    independenceKey: row.window_key ?? `event:${row.event_id}`,
  }))

  // 修订证据只看已提交的历史版本（revision > 1），新旧版本的独立键做差集
  const revisionRows = db.all<{ artifact_id: string; revision: number }>(
    `SELECT artifact_id, revision FROM artifact_revisions WHERE revision > 1 ORDER BY artifact_id, revision`,
  )
  const corrections: DeriveInput['corrections'] = []
  for (const row of revisionRows) {
    const current = keys.get(`${row.artifact_id}#${row.revision}`) ?? []
    const previous = keys.get(`${row.artifact_id}#${row.revision - 1}`) ?? []
    // 新版本里有、旧版本里没有的键 = 这次改口带来的新证据
    const shortage = current.filter((key) => !previous.includes(key))
    // 没有新证据的「修订」只是措辞反复，不计入主动阶段。
    if (shortage.length === 0) continue
    corrections.push({ artifactId: row.artifact_id, revision: row.revision, newIndependenceKeys: shortage })
  }

  // 最早事件时间：derive 用它算「认识多久」，不是「多久没晋级」
  const first = db.get<{ first_at: string | null }>(`SELECT MIN(at) AS first_at FROM events WHERE persona_id = ?
    AND NOT EXISTS (SELECT 1 FROM room_message_seq m WHERE m.event_id=events.event_id)`, [
    personaId,
  ])
  // 只数未脱敏的里程碑：脱敏=撤回该次确认的引用，不能再算作已确认（但阶段本身不回退）
  const confirmed = db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM phase_milestones WHERE persona_id = ? AND gate = 'integration' AND redacted_at IS NULL`,
    [personaId],
  )

  return {
    currentPhase,
    firstEventAt: first?.first_at ?? null,
    beliefs,
    refusals,
    corrections,
    integrationConfirmed: Number(confirmed?.count ?? 0),
  }
}

/**
 * 只读派生：观测台、`psyche_context`、诊断接口都用它，不写库。
 *
 * 参数：now 可注入固定时间（测试/回放用）；默认取当前时刻，格式与全库一致。
 * 返回：{ inputs, derived } —— 两个都给，方便调用方展示「输入什么、算出什么」。
 * 副作用：无；不开事务，也不碰缓存。
 */
export function deriveGrowthNow(db: Db, now = nowIso()): { inputs: GrowthInputs; derived: GrowthDerivation } {
  const inputs = loadGrowthInputs(db)
  const derived = deriveGrowth({ ...inputs, now })
  return { inputs, derived }
}

/**
 * 一次晋级的结果（可多级：一次调用可能连过数闸）。
 * fromPhase→toPhase 是该闸对应的阶段跨度，milestoneId 指向 phase_milestones 里的那行。
 */
export interface PhaseAdvance {
  gate: Gate
  fromPhase: Phase
  toPhase: Phase
  milestoneId: string
  evidenceIds: string[]
}

/** advancePhase 的返回值：derived 是回算后的快照（stage 已被覆写成推进后的实际阶段）。 */
export interface AdvanceResult {
  derived: GrowthDerivation
  advanced: PhaseAdvance[]
}

/**
 * 落进 phase_evidence 的一行证据（写出前的中间形态）。
 * eventId / artifactId 二者取一：拒绝类证据只有事件，belief/修订类证据只有 artifact。
 */
interface GateEvidence {
  eventId: string | null
  artifactId: string | null
  artifactRevision: number | null
  independenceKey: string | null
  evidenceType: string
}

/**
 * 把某道闸的「通过依据」翻译成待写入的证据行。
 *
 * 为什么从 inputs/derived 反查而不是让 derive 直接产出证据行：
 * derive 是纯函数、不认表结构；这里负责把 derived 里的 id 列表还原成可审计的行。
 * integration 返回空数组：它只能由人确认（见 commitIntegration），不自动产出证据。
 */
function evidenceForGate(gate: Gate, inputs: GrowthInputs, derived: GrowthDerivation): GateEvidence[] {
  if (gate === 'trust') {
    // 信任闸的证据是「成熟的 belief」：每个独立键一行，方便事后逐条复核
    return inputs.beliefs
      .filter((belief) => derived.matureBeliefIds.includes(belief.artifactId))
      .flatMap((belief) =>
        belief.independenceKeys.map((key) => ({
          eventId: null,
          artifactId: belief.artifactId,
          artifactRevision: belief.revision,
          independenceKey: key,
          evidenceType: 'mature-belief',
        })),
      )
  }
  if (gate === 'autonomy') {
    // 自治闸的证据是「明确拒绝过」：按事件写行，独立键沿用加载时算好的那个
    return inputs.refusals
      .filter((refusal) => derived.refusalEvidenceIds.includes(refusal.eventId))
      .map((refusal) => ({
        eventId: refusal.eventId,
        artifactId: null,
        artifactRevision: null,
        independenceKey: refusal.independenceKey,
        evidenceType: 'refusal',
      }))
  }
  if (gate === 'initiative') {
    // 主动闸的证据是「有实质新证据的修订」：derived 只给 artifact#revision，
    // 这里展开成每个新增独立键一行，行数=这次改口真正新增的独立证据数
    const wanted = new Set(derived.revisionEvidenceIds)
    return inputs.corrections
      .filter((correction) => wanted.has(`${correction.artifactId}#${correction.revision}`))
      .flatMap((correction) =>
        correction.newIndependenceKeys.map((key) => ({
          eventId: null,
          artifactId: correction.artifactId,
          artifactRevision: correction.revision,
          independenceKey: key,
          evidenceType: 'substantive-correction',
        })),
      )
  }
  // integration 只由人确认，不自动产出证据行。
  return []
}

/**
 * 把已经满足的闸落成里程碑，并把阶段推进到最远的一道。
 *
 * 只推进「连续通过」的闸；每过一道写一个里程碑 + 一组证据（同一 milestone_id）。
 * 整笔在一个事务里，失败回滚，不会出现「阶段升了但没有依据」。
 *
 * 参数：options.now 可注入固定时间；logger 只用于打晋级日志（当前实现未使用，保留接口）。
 * 返回：{ derived, advanced }；advanced 为空表示这次没有可推进的闸（常见路径，不是错误）。
 * 副作用（写表）：phase_milestones、phase_evidence、phase_state、persona_state。
 * 事务边界：整笔 `important: true` —— 晋级属于人格账本，掉电不能丢，也不允许半截。
 * 抛：驱动层错误；派生/写库任何一步抛错都会整笔回滚（阶段保持原样）。
 * 单调性：只往上走，没有任何回退分支；已经比目标阶段靠前时直接跳过该闸（见下面的 continue）。
 */
export function advancePhase(db: Db, options: { now?: string; logger?: { info?(msg: string): void } } = {}): AdvanceResult {
  const now = options.now ?? nowIso()
  const personaId = 'main'

  return db.transaction(
    () => {
      // 读在事务里做：否则「读到证据 → 另一个连接删证据 → 这里晋级」会晋级得没有依据
      const inputs = loadGrowthInputs(db)
      const derived = deriveGrowth({ ...inputs, now })

      let current = inputs.currentPhase
      const advanced: PhaseAdvance[] = []
      // 过一道闸 = 有资格进下一阶段：trust → autonomy → initiative；
      // 最后一道（integration）只能靠人确认，见 confirmIntegration。
      for (let index = 0; index < PHASE_ORDER.length - 1; index += 1) {
        const gate = PHASE_ORDER[index]
        // 必须连续：trust 没过就停在这里，后面即使过了也不算（不能跳级）
        if (!derived.gates[gate].passed) break
        const target = PHASE_ORDER[index + 1]
        // 幂等保护：这个闸对应的阶段早就走过了，跳过而不是再写一条里程碑
        if (PHASE_ORDER.indexOf(current) >= index + 1) continue

        // 里程碑 id 用 history 前缀：它属于不可变的成长账本，前缀要和事件/结论区分开
        const milestoneId = newId(PREFIX.history)
        const evidence = evidenceForGate(gate, inputs, derived)
        db.run(
          `INSERT INTO phase_milestones (milestone_id, persona_id, gate, from_phase, to_phase, algorithm_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          // algorithm_version 一并落库：将来判据变了，能区分「按旧规则晋级」和「按新规则重算」
          [milestoneId, personaId, gate, current, target, ALGORITHM_VERSION, now],
        )
        // 证据逐条写、共用 milestone_id：查一次里程碑就能取全依据，不用再按时间范围猜
        for (const item of evidence) {
          db.run(
            `INSERT INTO phase_evidence
               (persona_id, phase, event_id, artifact_id, note, at,
                milestone_id, gate, evidence_type, artifact_revision,
                independence_key, algorithm_version, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              personaId,
              // phase 写目标阶段：这条依据属于「进入 target 这次晋级」，不是旧阶段
              target,
              item.eventId,
              item.artifactId,
              // note 先放证据类型，人读时不用再查表；真正的人话在 integration 那条里
              item.evidenceType,
              now,
              milestoneId,
              gate,
              item.evidenceType,
              item.artifactRevision,
              item.independenceKey,
              ALGORITHM_VERSION,
              now,
            ],
          )
        }
        // 阶段与里程碑同一笔：任何一步失败都回滚，不会出现「阶段升了但没有里程碑」
        db.run(`UPDATE phase_state SET phase = ?, since = ?, updated_at = ? WHERE persona_id = ?`, [
          target,
          now,
          now,
          personaId,
        ])
        advanced.push({
          gate,
          fromPhase: current,
          toPhase: target,
          milestoneId,
          evidenceIds: derived.gates[gate].evidenceIds,
        })
        current = target
      }

      // 喂料版本自增：派生结果缓存以它为键，成长输入一变就要让下游重算（见 §5 缓存约定）
      db.run(`UPDATE persona_state SET growth_input_version = growth_input_version + 1 WHERE persona_id = ?`, [
        personaId,
      ])
      // 覆写 stage：derived 是按「推进前」的 currentPhase 算的，这里要反映实际落库后的阶段
      return { derived: { ...derived, stage: current, stageLabel: PHASE_LABELS[current] }, advanced }
    },
    { important: true },
  )
}

/**
 * 人确认「整合」：唯一能推进最后一道闸的入口，AI 与 Contact 都不能调用。
 *
 * 这个函数自己开事务，只给明确的人类入口用；如果要和「改提案状态」放进同一笔，
 * 用下面导出的 `commitIntegration()`。
 *
 * 参数：proposalId 用于在证据里留下「依据哪条提案确认」；actor 记确认人（缺省 owner）。
 * 返回：{ advanced, phase }；已经是 integration 时 advanced 为 null（幂等，不重复写里程碑）。
 * 副作用：同 commitIntegration（milestone / evidence / phase_state / persona_state）。
 * 事务边界：自行开 `important: true` 事务；调用方不要再外层包一层（会退化成并入）。
 * 抛：普通 Error —— 前三道闸没过时由 commitIntegration 抛（不是 PsycheError，见那里说明）。
 */
export function confirmIntegration(
  db: Db,
  options: { proposalId?: string; actor?: string; now?: string },
): { advanced: PhaseAdvance | null; phase: Phase } {
  const now = options.now ?? nowIso()
  return db.transaction(() => commitIntegration(db, { ...options, now }), { important: true })
}

/**
 * 「整合」的实际落库动作（假定调用方已在事务里）。
 * 前三道闸没有全过就直接抛错 —— 人的确认不能替代证据。
 *
 * 参数：proposalId / actor 会写进证据行，作为「谁、基于什么确认的」的审计痕迹。
 * 返回：{ advanced, phase }；advanced.milestoneId 是这次写的里程碑，phase 恒为 'integration'。
 * 副作用（写表）：phase_milestones、phase_evidence、phase_state、persona_state。
 * 事务边界：**本函数不开事务**，假定调用方已在 `db.transaction()` 内；
 * 单独调用只会走多条自动提交语句，中途失败会留下半截状态（所以只给 confirmIntegration /
 * decideGrowthProposal 这两个已包事务的地方用）。
 * 抛：普通 Error（不是 PsycheError）：「前三道闸还没过，不能直接确认整合阶段」。
 * 这里没有包成 E_STATE，是因为它属于「人点了一个不该点的按钮」，
 * 上层按 Message 展示即可；若将来要给 UI 做错误码分支，改这里要同步改两处调用方。
 */
export function commitIntegration(
  db: Db,
  options: { proposalId?: string; actor?: string; now?: string },
): { advanced: PhaseAdvance | null; phase: Phase } {
  const now = options.now ?? nowIso()
  const personaId = 'main'

  const row = db.get<PhaseRow>(`SELECT phase, since, updated_at, stalled_at FROM phase_state WHERE persona_id = ?`, [
    personaId,
  ])
  const current = (row?.phase as Phase) ?? 'trust'
  // 已经在 integration：幂等返回，不重复写里程碑（重复点确认不该多一条历史）
  if (current === 'integration') return { advanced: null, phase: current }

  const inputs = loadGrowthInputs(db)
  // 用库里的真实阶段重算，而不是相信调用方传进来的阶段：防止「提案是旧的、阶段已经变了」
  const derived = deriveGrowth({ ...inputs, currentPhase: current, now })
  // 前三道闸（除 integration 外的全部）都过了才允许人确认；缺一道就整笔拒绝
  const earlier = PHASE_ORDER.slice(0, -1).every((gate) => derived.gates[gate].passed)
  if (!earlier) {
    throw new Error('前三道闸还没过，不能直接确认整合阶段')
  }

  const milestoneId = newId(PREFIX.history)
  db.run(
    `INSERT INTO phase_milestones (milestone_id, persona_id, gate, from_phase, to_phase, algorithm_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [milestoneId, personaId, 'integration', current, 'integration', ALGORITHM_VERSION, now],
  )
  db.run(
    `INSERT INTO phase_evidence
       (persona_id, phase, event_id, artifact_id, note, at,
        milestone_id, gate, evidence_type, artifact_revision,
        independence_key, algorithm_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      personaId,
      'integration',
      // 人确认没有事件/结论可指：event_id / artifact_id 留 NULL，把依据写进 note
      null,
      null,
      // note 是唯一一段人话：写清「谁确认的、基于哪条提案」，脱敏时也只动 redacted_at 不删内容
      options.proposalId ? `confirmed by ${options.actor ?? 'owner'} on proposal ${options.proposalId}` : `confirmed by ${options.actor ?? 'owner'}`,
      now,
      milestoneId,
      'integration',
      // 证据类型固定 human-confirmation：自动判据永远不会写出这个值
      'human-confirmation',
      null,
      // 独立键：有提案就用提案 id（同一条提案重复确认算同一证据），没有就退化到人
      options.proposalId ? `proposal:${options.proposalId}` : `human:${options.actor ?? 'owner'}`,
      ALGORITHM_VERSION,
      now,
    ],
  )
  // 阶段落到 integration；不回退，也没有其它写 phase_state 的入口
  db.run(`UPDATE phase_state SET phase = 'integration', since = ?, updated_at = ? WHERE persona_id = ?`, [
    now,
    now,
    personaId,
  ])
  // 喂料版本自增：让下游缓存知道「成长输入变了」
  db.run(`UPDATE persona_state SET growth_input_version = growth_input_version + 1 WHERE persona_id = ?`, [
    personaId,
  ])
  return {
    advanced: {
      gate: 'integration' as Gate,
      fromPhase: current,
      toPhase: 'integration' as Phase,
      milestoneId,
      // 注意：这里回传的是 trust 闸的证据 id（derive 不会为 integration 产出证据），
      // 只作为「这次确认时的整体依据快照」给上层展示，别把它当成整合的判据
      evidenceIds: derived.gates.trust.evidenceIds,
    },
    phase: 'integration' as Phase,
  }
}

/**
 * Core 内部：为「是否进入整合阶段」创建一条 growth 提案。
 *
 * 模型走不到这里 —— `psyche_propose` 对 growth 直接拒绝；工具表里也没有对应工具。
 * 提案只是「给人一个待确认的入口」，批了也不代表自动晋级，仍要前三道闸全过。
 *
 * 参数：statement / rationale 可覆盖默认文案；actor 目前只用于将来记起草人。
 * 返回：{ proposalId, phase, alreadyConfirmed }；
 * - 已有 pending 提案时**复用**同一条（幂等，不制造重复待办）；
 * - 已经是 integration 时返回 alreadyConfirmed=true，此时 proposalId 可能是 ''（库里没有提案）。
 * 副作用（写表）：proposals（仅在需要新建时）。
 * 事务边界：整笔 `important: true`；「查有没有 pending + 插入」在同一笔里，避免并发造出两条。
 * 抛：驱动层错误；不做业务校验（提案本身不改变阶段）。
 */
export function createGrowthProposal(
  db: Db,
  options: { statement?: string; rationale?: string; actor?: string; now?: string },
): { proposalId: string; phase: Phase; alreadyConfirmed: boolean } {
  const now = options.now ?? nowIso()
  const personaId = 'main'
  // 快照在事务外读：只用于写提案文案与「是否已确认」的判断；
  // 真正能不能晋级由 decideGrowthProposal 在同笔事务里重算，所以这里读到旧值也不会写坏数据
  const { derived } = deriveGrowthNow(db, now)

  return db.transaction(
    () => {
      // 只找 pending：已处理的历史提案不该拦住新建
      const existing = db.get<{ proposal_id: string }>(
        `SELECT proposal_id FROM proposals
          WHERE persona_id = ? AND partition = 'growth' AND status = 'pending'
          ORDER BY created_at DESC LIMIT 1`,
        [personaId],
      )
      // 已经整合过了：没有「待确认」可做，返回已确认状态（proposalId 可能为空串，调用方要判空）
      if (derived.stage === 'integration') {
        return { proposalId: existing?.proposal_id ?? '', phase: derived.stage, alreadyConfirmed: true }
      }
      // 已有 pending：直接复用，返回同一条 id —— 幂等语义，不新建也不更新文案
      if (existing) {
        return { proposalId: existing.proposal_id, phase: derived.stage, alreadyConfirmed: false }
      }
      // 把三道闸的状态写进 rationale：人不用去别处查就知道「现在差哪一道」
      const gates = (Object.values(derived.gates) as { gate: Gate; passed: boolean }[])
        .filter((gate) => gate.gate !== 'integration')
        .map((gate) => `${gate.gate}:${gate.passed ? 'passed' : 'open'}`)
        .join(', ')
      const proposalId = newId(PREFIX.proposal)
      db.run(
        `INSERT INTO proposals (proposal_id, persona_id, partition, target, change, rationale, status, created_at)
         VALUES (?, ?, 'growth', 'phase', ?, ?, 'pending', ?)`,
        [
          proposalId,
          personaId,
          options.statement ?? `阶段总结：${derived.stageLabel}（${derived.stage}）`,
          options.rationale ?? `由 Core 生成。当前闸门：${gates}。确认后仍由 Core 校验前三道闸。`,
          now,
        ],
      )
      return { proposalId, phase: derived.stage, alreadyConfirmed: false }
    },
    { important: true },
  )
}

/**
 * 人确认/驳回一条 growth 提案。
 *
 * 接受 = 允许纳入成长流程；能不能真的进整合阶段仍由 Core 按证据判定。
 * 「改提案状态」和「落里程碑」在同一笔事务里，不会出现「批了但没记」。
 *
 * 参数：proposalId 必填；accept=false 只改状态、不碰阶段。
 * 返回：{ proposalId, status, phase, milestoneId }；驳回时 milestoneId 为 null、phase 是当前阶段。
 * 副作用（写表）：proposals；接受时还会经 commitIntegration 写
 * phase_milestones / phase_evidence / phase_state / persona_state。
 * 事务边界：整笔 `important: true`，先改状态再尝试晋级 ——
 * accept 时如果 commitIntegration 抛错（前三闸没过），整笔回滚，提案**留在 pending**，
 * 不会出现「状态 accepted 但阶段没动」的半截结果。
 * 抛：普通 Error（不是 PsycheError）：找不到提案 / 不是 growth 分区 / 已处理过 / 前三闸未过。
 */
export function decideGrowthProposal(
  db: Db,
  options: { proposalId: string; accept: boolean; actor?: string; now?: string },
): { proposalId: string; status: 'accepted' | 'rejected'; phase: Phase; milestoneId: string | null } {
  const now = options.now ?? nowIso()
  const personaId = 'main'
  const proposalId = options.proposalId

  return db.transaction(
    () => {
      const row = db.get<{ partition: string; status: string }>(
        `SELECT partition, status FROM proposals WHERE proposal_id = ? AND persona_id = ?`,
        [proposalId, personaId],
      )
      // 三重前置校验：不存在 / 分区不对 / 已处理。分区校验是这里的关键 ——
      // 别的分区（人格、关系）的提案不能借这个入口拿到「晋级」副作用
      if (!row) throw new Error(`找不到提案：${proposalId}`)
      if (row.partition !== 'growth') throw new Error(`这条提案不是成长分区（${row.partition}），不能从这里确认`)
      if (row.status !== 'pending') throw new Error(`提案已经处理过（${row.status}）`)

      const status = options.accept ? 'accepted' : 'rejected'
      // 先落状态，再尝试晋级：两步同笔，所以顺序不影响最终一致性；
      // accept 失败会整笔回滚，这条 UPDATE 也随之消失，提案仍是 pending
      db.run(`UPDATE proposals SET status = ?, decided_at = ?, decided_by = ? WHERE proposal_id = ?`, [
        status,
        now,
        options.actor ?? 'owner',
        proposalId,
      ])

      let milestoneId: string | null = null
      let phase: Phase = 'trust'
      if (options.accept) {
        // 复用 commitIntegration：它假定已在事务里，这里正好满足（不会再开一层）
        const result = commitIntegration(db, { proposalId, actor: options.actor, now })
        // 已经在 integration 时 advanced 为 null，milestoneId 也如实给 null
        milestoneId = result.advanced?.milestoneId ?? null
        phase = result.phase
      } else {
        // 驳回不动阶段：只读一次当前值回给调用方，避免 UI 猜阶段
        const current = db.get<{ phase: string }>(`SELECT phase FROM phase_state WHERE persona_id = ?`, [personaId])
        phase = (current?.phase as Phase) ?? 'trust'
      }
      return { proposalId, status: status as 'accepted' | 'rejected', phase, milestoneId }
    },
    { important: true },
  )
}

/**
 * 证据撤回：只打 `redacted_at` 标记，里程碑与阶段都保留。
 *
 * §22 的隐私三档里这是第二档：引用脱敏、审计链不断。
 *
 * 参数：milestoneId 指一次晋级；now 可注入固定时间。
 * 返回：{ milestoneId, redacted } —— redacted 是**本次新标记**的行数（已脱敏的不重复计数）。
 * 副作用（写表）：phase_evidence 的 redacted_at 列；**不碰** phase_state / phase_milestones。
 * 事务边界：先数后改放在同一笔 `important: true` 里，计数与更新不会错位。
 * 抛：驱动层错误。
 * 不回退阶段：撤回的是「这条证据还能不能被引用」，不是「这次晋级没发生过」——
 * 阶段单调是硬不变量，删证据只脱敏，见文件头。
 */
export function redactPhaseEvidence(
  db: Db,
  options: { milestoneId: string; now?: string },
): { milestoneId: string; redacted: number } {
  const now = options.now ?? nowIso()
  return db.transaction(
    () => {
      // 先数未脱敏的：UPDATE 之后 redacted_at 全非空，就分不清「本来就这样」和「这次改的」了
      const row = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM phase_evidence WHERE milestone_id = ? AND redacted_at IS NULL`,
        [options.milestoneId],
      )
      // 只更新 redacted_at（不动 note / independence_key）：原文留着审计，只是不再被引用
      db.run(`UPDATE phase_evidence SET redacted_at = ? WHERE milestone_id = ? AND redacted_at IS NULL`, [
        now,
        options.milestoneId,
      ])
      return { milestoneId: options.milestoneId, redacted: Number(row?.n ?? 0) }
    },
    { important: true },
  )
}
