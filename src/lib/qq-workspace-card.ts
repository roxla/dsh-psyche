/**
 * QQ 工作区卡的五态判定（纯函数，不碰宿主、不读环境）。
 *
 * 交接单冻结了五个状态：`registered` / `unverified` / `unavailable` / `pending` /
 * `needs-review`。这里只做「拿到事实之后怎么判」，采集事实留在 `src/index.ts`——
 * 那样要么宿主在、要么临时脚本在，判定本身永远可测。
 *
 * 判定只依赖真实能读到的东西：服务是否注入、目录是否拿到、`workspace/follow`
 * 的 baseline 有没有读到、本进程最后一次登记的结果。读不到就如实说读不到，
 * 不用「大概齐」把状态算成已登记——那会让用户以为会话已经归好类。
 */

/** 本进程里最后一次登记尝试（谁触发的、成没成）。 */
export interface QqWorkspaceAttempt {
  at: string
  /** `workspace/create`、`rename`、`session/create` 之类的步骤名。 */
  step: string
  ok: boolean
  error?: string
  /**
   * 会话级动作才有：这次动作针对的是哪条会话。
   *
   * 建工作区、改名这类动作不针对具体会话，所以留空——拿它们当「这条会话已登记」
   * 的回执就是第 31 轮要修的那个错。只有 `session/create`、`attachSession` 这类
   * 真正把某条会话放进工作区的动作才记这个字段。
   */
  sessionId?: string
  /**
   * 进程内递增的回执序号（每次登记 +1）。
   *
   * `at` 只有毫秒精度：同一会话在同一毫秒里重新登记，两次回执的 `at` 完全相同，
   * 单看时间戳会把新回执误认成旧的那一份，缺席次数就不会清零。
   */
  seq?: number
}

/** 宿主里按路径找到的那个工作区条目。 */
export interface QqWorkspaceActual {
  workspaceId: string
  title: string
  path: string
  memberCount: number
  /**
   * 成员会话 id；`null` 表示只拿到了个数、拿不到是谁。
   *
   * 这两种情况不能混：有 id 才能核对「这条会话在不在里面」，只有个数就只能说
   * 「里面有几条会话」，说不了是不是这一条。
   */
  sessionIds: string[] | null
}

export type QqWorkspaceState =
  | 'registered'
  | 'unverified'
  | 'unavailable'
  | 'pending'
  | 'needs-review'

export interface QqWorkspaceFacts {
  /** `qq.cwd` 实际生效的目录（留空时优先沿用磁盘上已有 QQ 会话的目录，没有才是 `<宿主工作目录>/QQ 聊天`）。 */
  cwd: string | null
  /** 目录从哪来：配置文件里显式写了，还是按默认规则推出来的。 */
  cwdSource: 'config' | 'default' | 'unknown'
  /** 期望的工作区标题，目前固定「QQ 聊天」。 */
  expectedTitle: string
  /** 宿主有没有注入 `workspaceController`（没注入就完全没法登记）。 */
  serviceAvailable: boolean
  /** 此刻有没有一次登记正在进行。 */
  inFlight: boolean
  attempt: QqWorkspaceAttempt | null
  /** 按路径匹配到的宿主工作区；没有就是 null。 */
  actual: QqWorkspaceActual | null
  /** `workspace/follow` 的 baseline 读没读到。读不到时 actual 一定是 null，但那不代表不存在。 */
  read: 'ok' | 'unavailable'
  /**
   * 这次读回**发起**的时间（不是拿到结果的时间）。
   *
   * 用来和 `attempt.at` 比先后：登记是异步的，读回很可能在登记动作完成前就发出去了，
   * 那时成员清单里当然还没有它。这种「缺」不能当矛盾，只能算「还没读到」。
   */
  readAt?: string
  /**
   * 这次读回之前，已经有过几次「登记之后发起的有效读回、且都没看到目标会话」。
   *
   * 第 32 轮：第一次有效读回缺席只算「还没看到」，第二次仍缺席才是矛盾——
   * 宿主的 baseline 快照可能滞后于 `attachSession`，一次缺席就报红是误报。
   */
  priorMisses?: number
  checkedAt: string
}

export interface QqWorkspaceCard {
  ok: true
  state: QqWorkspaceState
  /** 界面上直接显示的中文徽标。 */
  label: string
  /** 一句话解释这个状态是怎么来的。 */
  reason: string
  expectedTitle: string
  cwd: string | null
  cwdSource: 'config' | 'default' | 'unknown'
  workspaceId: string | null
  actualTitle: string | null
  /** null 表示读不到成员数，界面显示「未知」。 */
  memberCount: number | null
  /** 成员会话 id；`null` 表示只拿到个数。界面据此决定能不能说「这条会话在里面」。 */
  memberIds: string[] | null
  /**
   * 本进程最近一次**会话级**登记针对的会话 id（建工作区、改名不算）。
   * 界面用它显示「目标会话」那一行；`null` 表示本进程没登记过任何会话。
   */
  targetSessionId: string | null
  /** 当前回执的进程内序号；读回核对用它判断「还是不是同一份回执」。 */
  attemptSeq: number | null
  /**
   * 这次的「缺」还可能是读回早于登记、或只是第一次有效读回没看到——调用方应补读，
   * 别直接报矛盾（第 32 轮：登记成功后的**第一次**有效读回缺席要补读，第二次仍缺席才报）。
   */
  pendingReadback: boolean
  /**
   * 成员核验结论，与「登记回执」分开：回执说挂过，核验说清单里在不在。
   * `unknown` = 读不到清单或只有个数，没法核对。
   */
  memberVerify: 'contains' | 'missing' | 'unknown'
  /** 这次读回的发起时间（没有传就是 null）；调用方据此判断能否计入「缺席次数」。 */
  readAt: string | null
  attempt: QqWorkspaceAttempt | null
  checkedAt: string
}

export const QQ_WORKSPACE_LABELS: Record<QqWorkspaceState, string> = {
  registered: '已登记',
  unverified: '未核实',
  unavailable: '不可用',
  pending: '待登记',
  'needs-review': '需人工核对',
}

function describeAttempt(attempt: QqWorkspaceAttempt): string {
  const at = attempt.at.replace('T', ' ').replace(/\..*$/, '')
  const detail = attempt.error === undefined ? '' : `（${attempt.error}）`
  return `${at} ${attempt.step}${detail}`
}

/**
 * 判五态。
 *
 * 顺序即优先级：不可用最硬（什么也做不了）→ 正在登记 → 上次失败要人看 →
 * 读不到清单不敢下结论 → 清单里没有 → 有但没有成员佐证 → 已登记。
 */
export function buildQqWorkspaceCard(facts: QqWorkspaceFacts): QqWorkspaceCard {
  const base = {
    ok: true as const,
    expectedTitle: facts.expectedTitle,
    cwd: facts.cwd,
    cwdSource: facts.cwdSource,
    attempt: facts.attempt,
    checkedAt: facts.checkedAt,
  }
  const targetSessionId = facts.attempt?.sessionId ?? null
  const priorMisses = facts.priorMisses ?? 0
  const judge = (
    state: QqWorkspaceState,
    reason: string,
    extra: { pendingReadback?: boolean; memberVerify?: QqWorkspaceCard['memberVerify'] } = {},
  ): QqWorkspaceCard => ({
    ...base,
    state,
    label: QQ_WORKSPACE_LABELS[state],
    reason,
    workspaceId: facts.actual?.workspaceId ?? null,
    actualTitle: facts.actual?.title ?? null,
    memberCount: facts.actual === null ? null : facts.actual.memberCount,
    memberIds: facts.actual === null ? null : facts.actual.sessionIds,
    targetSessionId,
    attemptSeq: facts.attempt?.seq ?? null,
    pendingReadback: extra.pendingReadback === true,
    memberVerify: extra.memberVerify ?? 'unknown',
    readAt: facts.readAt ?? null,
  })

  if (!facts.serviceAvailable || facts.cwd === null) {
    const reason = !facts.serviceAvailable
      ? '宿主没有注入 workspaceController，现在没法把 QQ 会话登记进工作区'
      : '还没拿到 QQ 会话目录（插件可能尚未完成启动）'
    return judge('unavailable', reason)
  }
  if (facts.inFlight) return judge('pending', '正在登记')
  // 失败不再提前返回：回执失败但清单里已经有这条会话，成员状态就是已登记，
  // 失败原因照样在 `attempt` 里显示（第 32 轮）。
  const failed = facts.attempt !== null && !facts.attempt.ok
  if (facts.read !== 'ok') {
    return judge('unverified', '读不到宿主的工作区清单，无法核对是否已登记')
  }
  if (facts.actual === null) {
    if (failed) {
      return judge(
        'needs-review',
        `最近一次登记失败：${describeAttempt(facts.attempt as QqWorkspaceAttempt)}；宿主里也还没有这个工作区`,
      )
    }
    return judge('pending', '宿主里还没有这个工作区，下一条 QQ 消息会自动创建')
  }

  // 读回是否早于登记动作：早于就等于「还没轮到它出现」，不是矛盾。
  const staleRead =
    facts.readAt !== undefined && facts.attempt !== null && facts.readAt < facts.attempt.at

  // 没有「这条会话」的回执时，成员再多也证明不了它是哪一条。
  if (targetSessionId === null) {
    const reason =
      facts.actual.memberCount === 0
        ? '工作区存在但还没有会话成员，本进程也没登记过，无法确认归属'
        : `工作区里已有 ${facts.actual.memberCount} 个会话，但本进程没有这条消息的登记回执，无法确认是本会话`
    return judge('unverified', reason)
  }

  // 只能拿到个数时，核对不了「是不是这条」。
  if (facts.actual.sessionIds === null) {
    return judge(
      'unverified',
      staleRead
        ? '读回发生在登记完成前，且这次只拿到成员个数，无法核对是哪条会话'
        : '这份清单只给了成员个数，核对不了这条会话在不在里面',
      { pendingReadback: staleRead },
    )
  }

  const attemptText = describeAttempt(facts.attempt as QqWorkspaceAttempt)

  if (facts.actual.sessionIds.includes(targetSessionId)) {
    // 命中也要看时序：这份快照早于登记，就证明不了「这次登记把它放进去了」。
    if (staleRead) {
      return judge(
        'unverified',
        `读回发生在登记完成前（${attemptText}）；这份快照里虽然看到它，但早于这次登记，不能当证据`,
        { pendingReadback: true, memberVerify: 'contains' },
      )
    }
    const titleReason =
      facts.actual.title === facts.expectedTitle
        ? '标题与期望一致'
        : `宿主标题是「${facts.actual.title}」`
    const note = failed
      ? `（上一次登记报了错：${attemptText}，但清单里已经有它）`
      : ''
    return judge(
      'registered',
      `这条会话已在工作区里（${targetSessionId}），${titleReason}${note}`,
      { memberVerify: 'contains' },
    )
  }

  // 缺席分三种：读回早于登记、第一次有效读回、第二次仍缺席（才是矛盾）。
  if (staleRead) {
    return judge(
      'unverified',
      `读回发生在登记完成前（${attemptText}），成员清单里暂时还没有它`,
      { pendingReadback: true, memberVerify: 'missing' },
    )
  }
  if (failed) {
    return judge(
      'needs-review',
      `最近一次登记失败：${attemptText}；成员清单里也没有 ${targetSessionId}`,
      { memberVerify: 'missing' },
    )
  }
  if (priorMisses < 1) {
    return judge(
      'unverified',
      `登记回执是 ${attemptText}，但这次读回还没看到 ${targetSessionId}，需要再读一次`,
      { pendingReadback: true, memberVerify: 'missing' },
    )
  }
  return judge(
    'needs-review',
    `登记回执是 ${attemptText}，两次读回都没有 ${targetSessionId}`,
    { memberVerify: 'missing' },
  )
}

/**
 * 带补读的工作区卡（第 32/33 轮）。
 *
 * 「缺」本身不是矛盾，要先排除「读回比登记早」这一种。规则：
 * - 读回早于登记 → 记 `unverified`，补读一次；这一次**不计**缺席次数（它根本看不到）。
 * - 登记之后的第一次有效读回仍缺 → 记 `unverified` 并要求再读一次，缺席次数记成 1。
 * - 第二次有效读回还缺 → `needs-review`。
 * - 一次「有效缺席」只对**同一份回执**计数：回执换了（重新登记）或目标会话换了，计数清零重来，
 *   免得把 A 的缺席算到 C 头上。
 * - 读满上限还拿不到「当前回执 + 当前目标」的有效证据，就如实返回 `unverified`，不硬凑结论。
 *
 * 读回是副作用，所以由调用方注入；这里只负责「读到什么之后还要不要再读」。
 */
export async function readWorkspaceCardWithRetry(
  readOnce: (priorMisses: number) => Promise<QqWorkspaceCard>,
  currentAttempt?: () => QqWorkspaceAttempt | null,
  maxReads = 4,
): Promise<QqWorkspaceCard> {
  /**
   * 这一次读数针对的是哪份证据：目标会话 + 回执版本。
   *
   * 回执版本优先用进程内递增序号（`attempt.seq`）——同一会话在同一毫秒里重新登记时，
   * 单看 `attempt.at` 会把两次登记认成同一次。
   */
  const versionOf = (card: QqWorkspaceCard): string =>
    `${card.targetSessionId ?? ''}#${card.attemptSeq ?? card.attempt?.at ?? ''}`
  const keyOf = (attempt: QqWorkspaceAttempt | null): string =>
    `${attempt?.sessionId ?? ''}#${attempt?.seq ?? attempt?.at ?? ''}`
  const currentKey = (): string => keyOf(currentAttempt?.() ?? null)
  /** 这次读回早于当前回执 → 它看不到目标，既不能算命中也不算缺席。 */
  const isStale = (card: QqWorkspaceCard): boolean =>
    card.readAt !== null && card.attempt !== null && card.readAt < card.attempt.at
  /** 这份读数算不算一次「有效缺席」。 */
  const countsAsMiss = (card: QqWorkspaceCard): boolean =>
    card.memberVerify === 'missing' && !isStale(card)
  /**
   * 作废读数：整份结论都不能用，只能按**读取结束时的当前回执**重新给一张未核实的卡。
   *
   * 不能拿失效读数里的目标/回执来拼：第 36 轮的反例是「当前回执已从 B 换成 C，最后一次
   * 读回返回的仍是 B 的卡片」，照抄就会显示「B 未核实」。成员清单与核验时间也一并清掉，
   * 因为它们是针对旧目标的。
   */
  const unverifiedForCurrent = (fallback: QqWorkspaceCard, reason: string): QqWorkspaceCard => {
    // 「没提供访问器」≠「访问器说当前没有回执」：后者要清成 null，不能退回失效读数的 B。
    const hasAccessor = currentAttempt !== undefined
    const attempt = hasAccessor ? (currentAttempt() ?? null) : null
    return {
      ...fallback,
      state: 'unverified',
      label: QQ_WORKSPACE_LABELS.unverified,
      reason,
      attempt: hasAccessor ? attempt : fallback.attempt,
      attemptSeq: hasAccessor ? (attempt?.seq ?? null) : fallback.attemptSeq,
      targetSessionId: hasAccessor ? (attempt?.sessionId ?? null) : fallback.targetSessionId,
      memberCount: null,
      memberIds: null,
      memberVerify: 'unknown',
      readAt: null,
      pendingReadback: true,
    }
  }

  // 每轮只读一次：首读、重读走同一条路径。读取前先记下回执版本，读回来再核一次；
  // 版本变了就整份作废、按新目标从零次缺席重来。
  let misses = 0
  let last: QqWorkspaceCard | null = null
  for (let read = 0; read < maxReads; read += 1) {
    const before = currentAttempt === undefined ? null : currentKey()
    const next = await readOnce(misses)
    const receiptChanged = before !== null && currentKey() !== before
    const targetChanged = last !== null && versionOf(next) !== versionOf(last)
    if (receiptChanged || targetChanged) {
      last = unverifiedForCurrent(
        next,
        '读取期间登记回执或目标会话变了，这份快照不能用来判断，需要按当前目标重新核验',
      )
      misses = 0
      continue
    }
    last = next
    misses = countsAsMiss(next) ? misses + 1 : 0
    if (!next.pendingReadback) return next
  }
  // 预算耗尽仍拿不到「当前回执」的有效证据：用读取结束时的当前回执给一张未核实的卡。
  if (last === null) return unverifiedForCurrent(await readOnce(0), '没能读到工作区清单，无法核对会话归属')
  if (currentAttempt !== undefined && versionOf(last) !== currentKey()) {
    return unverifiedForCurrent(last, '读取预算用尽，仍没有针对当前登记回执的有效证据，需要再核验')
  }
  return last
}
