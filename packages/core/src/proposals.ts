/**
 * 提案审批：把「待批」这件事收成**一个入口**。
 *
 * 为什么需要单独一个文件：
 *   `growth` 分区的提案背后有阶段晋级副作用（走 `decideGrowthProposal`），
 *   而 `life` 分区只是记录「人同意了这条自我调整」。两条路前置校验相同、
 *   事务边界要求相同，如果各写一份，迟早出现「成长提案能被重复批准」「人格提案没人校验状态」。
 *   这里做成唯一的 `decideProposal()`，面板与 CLI 都只调它。
 *
 * 三条不变量：
 *   1. 只有 `pending` 能改（重复批准抛 `E_STATE`，不静默成功）。
 *   2. `safety` / `relationship` 分区**没有**可批准的内容 —— 它们连提案都不该存在
 *      （`Core.propose()` 早就挡掉了），所以这里再挡一次，防止历史脏行被误放行。
 *   3. `growth` 分区的接受仍由 Core 校验前三道闸；本文件只负责把决定记下来，
 *      不代替 Core 判定「够不够格进整合阶段」。
 *
 * 批准之后到底发生什么：
 *   - `growth`：同一笔事务里落里程碑 + 阶段推进（见 `growth.ts`）。
 *   - `life`：改成 `accepted` 并把决定写进 `decided_at/decided_by`。**参数本身不会被自动改写** ——
 *     一条「希望你别这么客气」的自然语言提案没法机械落成配置字段；它的作用是被记录，
 *     并经 `recentApprovedAdjustments()` 重新进入模型的最小上下文，由模型在行为里照做。
 *     这是有意的：把「批准」变成「她知道了」，而不是「配置被偷偷改了」。
 *
 * 事务边界：整个决定（含 growth 的里程碑）在一笔 `important: true` 里。
 * 内层 `decideGrowthProposal` 自带事务，届时会降级并入外层（adapter 的 `#inTx`），
 * 所以取消/回滚是整笔生效的，不会留下「状态 accepted 但没落里程碑」。
 */
import { nowIso } from './adapter.js'
import type { Db } from './adapter.js'
import { CODE, PsycheError } from './errors.js'
import { decideGrowthProposal } from './growth.js'
import type { Phase } from './derive.js'

/** 提案分区：与 schema 的 CHECK 一致，`growth` 由 v2 迁移加进来。 */
export type ProposalPartition = 'life' | 'relationship' | 'safety' | 'growth'

/** 一条待批提案的原始行（只有审批需要的那几列）。 */
interface ProposalRow {
  proposal_id: string
  partition: ProposalPartition
  target: string
  change: string
  status: string
}

export interface DecideProposalInput {
  proposalId: string
  /** true = 批准，false = 驳回。两者都必须显式给，不给默认值以免「误点空参就批准」。 */
  accept: boolean
  /** 谁做的决定；默认 `owner`（面板与 CLI 都是本人操作）。 */
  actor?: string
  now?: string
}

export interface DecideProposalResult {
  proposalId: string
  partition: ProposalPartition
  status: 'accepted' | 'rejected'
  /** growth 提案才有：决定之后的阶段。 */
  phase: Phase | null
  /** growth 提案且批准了晋级时才有。 */
  milestoneId: string | null
  /**
   * 决定是否改变了什么「除了状态以外」的东西。
   * growth 批准 = true（阶段可能推进）；life = false（参数不自动改写）。
   */
  applied: boolean
  note: string
}

/**
 * 批准或驳回一条提案。
 *
 * 参数：`proposalId` 必填；`accept` 必填；`actor/now` 可注入（测试要固定时间）。
 * 返回：决定结果 + 一句给人看的说明（面板直接显示）。
 * 副作用（写表）：`proposals` 的 status/decided_at/decided_by；
 *   `growth` 批准时还会经 `decideGrowthProposal` 写 phase_milestones / phase_evidence / phase_state。
 * 事务边界：整笔 `important: true`。
 * 抛：`E_NOT_FOUND`（查无此提案）/ `E_STATE`（已处理过）/
 *   `E_PARTITION`（关系或安全分区不接受这里批准）/ 其余来自 Core 的校验错误。
 */
export function decideProposal(db: Db, input: DecideProposalInput): DecideProposalResult {
  const now = input.now ?? nowIso()
  const actor = input.actor ?? 'owner'
  const proposalId = String(input.proposalId ?? '').trim()
  // 空 id 先挡：否则会走成「查不到」，错误文案会误导成「提案不存在」而不是「你没给 id」
  if (!proposalId) throw new PsycheError(CODE.validation, 'proposalId 必填')

  return db.transaction(
    () => {
      const row = db.get<ProposalRow>(
        `SELECT proposal_id, partition, target, change, status
           FROM proposals WHERE proposal_id = ?`,
        [proposalId],
      )
      if (!row) throw new PsycheError(CODE.notFound, `找不到提案：${proposalId}`)
      if (row.status !== 'pending') {
        // 重复点击是最常见的误用：明确说「已经处理过」，别让调用方以为刚才那次没生效
        throw new PsycheError(
          CODE.state,
          `提案已经处理过（${row.status}），不能重复决定；要改主意请重新提一条`,
        )
      }

      if (row.partition === 'growth') {
        // 交给 Core：它自己会校验「是不是 growth 分区」「前三闸过没过」，并落里程碑
        const decided = decideGrowthProposal(db, { proposalId, accept: input.accept, actor, now })
        return {
          proposalId,
          partition: 'growth' as const,
          status: decided.status,
          phase: decided.phase,
          milestoneId: decided.milestoneId,
          applied: decided.milestoneId !== null,
          note: input.accept
            ? decided.milestoneId
              ? `已确认整合阶段（里程碑 ${decided.milestoneId}）。`
              : '已记下你的确认；当前已经在整合阶段，没有再推进。'
            : '已驳回这条成长提案，阶段不变。',
        }
      }

      if (row.partition === 'relationship' || row.partition === 'safety') {
        // 这两个分区的改动只能由人直接改参数，不能借「批准一条提案」绕过去（v13 §12.1/§12.2）
        throw new PsycheError(
          CODE.partition,
          `${row.partition} 分区的提案没有可批准的内容：关系参数与安全参数只能由你本人直接修改`,
        )
      }

      const status = input.accept ? 'accepted' : 'rejected'
      db.run(`UPDATE proposals SET status = ?, decided_at = ?, decided_by = ? WHERE proposal_id = ?`, [
        status,
        now,
        actor,
        proposalId,
      ])
      return {
        proposalId,
        partition: 'life' as const,
        status,
        phase: null,
        milestoneId: null,
        applied: false,
        note: input.accept
          ? '已批准。参数不会被自动改写——这条调整会进入她下次读到的「最近批准的自我调整」，由她在行为里照做。'
          : '已驳回。她不会主动往这个方向调整。',
      }
    },
    { important: true },
  )
}

/** 最近被批准的自助调整：只取 life 分区，最多 limit 条。 */
export interface ApprovedAdjustment {
  proposalId: string
  target: string
  change: string
  decidedAt: string
}

/**
 * 读最近批准过的 life 提案，喂给 `psyche_context`。
 *
 * 为什么存在：批准一条自然语言提案不会改配置，如果什么都不做，
 * 「批准」就只是个勾选。让它重新进入模型的最小上下文，批准才有下文。
 *
 * 参数：limit 默认 3（最小上下文里只留最近几条，多了就是噪声）。
 * 返回：新→旧的数组；表缺失或库异常时返回 []（读失败不该让工具报错）。
 * 副作用：只读。
 */
export function recentApprovedAdjustments(db: Db, limit = 3): ApprovedAdjustment[] {
  try {
    return db
      .all<{ proposal_id: string; target: string; change: string; decided_at: string | null }>(
        `SELECT proposal_id, target, change, decided_at
           FROM proposals
          WHERE partition = 'life' AND status = 'accepted'
          ORDER BY decided_at DESC, rowid DESC
          LIMIT ?`,
        [limit],
      )
      .filter((row) => typeof row.decided_at === 'string' && row.decided_at.length > 0)
      .map((row) => ({
        proposalId: row.proposal_id,
        target: row.target,
        change: row.change,
        decidedAt: row.decided_at as string,
      }))
  } catch {
    return []
  }
}
