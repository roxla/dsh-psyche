/**
 * Composer 注入层（P2-FTS5 E5.1）。
 *
 * 职责：保证最终交给模型的记忆文本里，没有受限内容、过期版本或越权 Scope 的内容。
 * 原则：**不信任候选字段**——凡用于判定的字段（revision / state / disclosure / statement）
 * 一律回库重读当前 head；候选只当作「线索」。
 *
 * 与检索层的关系：检索层（searchFts）负责少给错误候选；Composer 负责最终拦截。
 * 两层都要有，不能互相替代。
 */
import type { Db } from './adapter.js'
import {isArtifactSubjectAllowedInScope,isArtifactVisibleInScope,type RecallSurface} from './fts.js'

export type ComposerRejectReason = 'missing' | 'stale' | 'state' | 'disclosure' | 'scope'

/** 上游候选：只带定位信息；claimed* 字段仅用于模拟不可信上游，Composer 一律忽略。 */
export interface ComposerCandidate {
  artifactId: string
  /** 上游声称的版本；不传视为「不知道」，仍按库中 head 判定 */
  revision?: number | null
  contactId?: string | null
  channel?: string | null
  blockType?: string
  /** 上游伪造的字段（测试用）：Composer 不得采信 */
  claimedState?: string | null
  claimedDisclosure?: string | null
  claimedStatement?: string | null
}

export interface ComposerScope {
  personaId?: string
  /** 当前 RuntimeInput 的 Contact；为空表示没有联系人上下文 */
  contactId?: string | null
  /** 当前 RuntimeInput 的渠道（desktop / qq / web / pet） */
  channel?: string | null
  /** Trusted Room/surface supplied by the injection path, never by a candidate. */
  roomId?: string | null
  surface?: RecallSurface
}

export interface ComposeOptions {
  maxItems?: number
  maxChars?: number
  /** 状态准入集合，默认 active/challenged */
  allowedStates?: string[]
  /** 注入块标题，默认「记忆」 */
  label?: string
}

export interface ComposedItem {
  artifactId: string
  revision: number
  kind: string
  state: string
  disclosure: string
  contactId: string | null
  channel: string | null
  blockType: string
  text: string
}

export interface ComposedRejection {
  artifactId: string
  revision: number | null
  reason: ComposerRejectReason
  contactId: string | null
  channel: string | null
}

export interface ComposedStats {
  candidates: number
  injected: number
  missing: number
  stale: number
  state: number
  disclosure: number
  scope: number
  /** 注入项中非当前 head 或状态不符的数量；要求 0 */
  staleInjected: number
  /** 注入项中非 public 的数量；要求 0（正常情况下恒 0，保留计算以便回归） */
  disclosureLeaked: number
  /** staleInjected / injected；injected=0 时为 0 */
  staleInjectionRate: number
}

export interface ComposedInjection {
  text: string
  items: ComposedItem[]
  rejections: ComposedRejection[]
  stats: ComposedStats
}

const DEFAULT_ALLOWED_STATES = ['active', 'challenged']
const DEFAULT_MAX_ITEMS = 6
const DEFAULT_MAX_CHARS = 800

interface HeadRow {
  artifact_id: string
  kind: string
  revision: number
  state: string
  statement: string
  disclosure: string
  subject_refs: string | null
}

/**
 * 把候选组装成模型可见的记忆块。只读，不写库。
 *
 * @throws 不抛异常：单条候选出问题只记 rejection，不中断整批。
 */
export function composeInjection(
  db: Db,
  candidates: ComposerCandidate[],
  scope: ComposerScope = {},
  options: ComposeOptions = {},
): ComposedInjection {
  const maxItems = Math.max(0, options.maxItems ?? DEFAULT_MAX_ITEMS)
  const maxChars = Math.max(0, options.maxChars ?? DEFAULT_MAX_CHARS)
  const allowed = new Set(options.allowedStates ?? DEFAULT_ALLOWED_STATES)
  const label = options.label ?? '记忆'
  const scopeContact = normalise(scope.contactId)

  const items: ComposedItem[] = []
  const rejections: ComposedRejection[] = []
  const stats: ComposedStats = {
    candidates: candidates.length,
    injected: 0,
    missing: 0,
    stale: 0,
    state: 0,
    disclosure: 0,
    scope: 0,
    staleInjected: 0,
    disclosureLeaked: 0,
    staleInjectionRate: 0,
  }

  let usedChars = 0
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const artifactId = String(candidate.artifactId ?? '').trim()
    const contactId = normalise(candidate.contactId)
    const channel = normalise(candidate.channel)
    const blockType = candidate.blockType ?? 'memory'

    const reject = (reason: ComposerRejectReason, revision: number | null) => {
      rejections.push({ artifactId: artifactId || '(空)', revision, reason, contactId, channel })
      stats[reason] += 1
    }

    if (!artifactId) {
      reject('missing', null)
      continue
    }

    const head = db.get<HeadRow>(
      `SELECT a.artifact_id, a.kind, r.revision, r.state, r.statement, r.disclosure, r.subject_refs
         FROM artifacts a
         JOIN artifact_revisions r ON r.artifact_id = a.artifact_id
        WHERE a.artifact_id = ?
          AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = a.artifact_id)`,
      [artifactId],
    )
    // 候选里声称的 revision 只用于诊断，判定以库为准
    if (!head) {
      reject('missing', candidate.revision ?? null)
      continue
    }

    if (candidate.revision !== undefined && candidate.revision !== null && candidate.revision !== head.revision) {
      reject('stale', candidate.revision)
      continue
    }
    if (!allowed.has(head.state)) {
      reject('state', head.revision)
      continue
    }
    // 披露判定只看库；候选的 claimedDisclosure 一律不采信
    if (head.disclosure !== 'public') {
      reject('disclosure', head.revision)
      continue
    }
    // Scope：**以库里的 subject_refs 为准**——候选即使漏报/谎报 contactId，
    // 只要这条结论在库里绑定了某个 Contact，就必须与当前联系人一致。
    // 全局记忆（没有 ct_ 绑定）可跨渠道，但不能在 Contact 私有记忆上豁免。
    const boundContact = firstContactRef(head.subject_refs)
    const groupScope = scope.surface === 'group'
    if (groupScope && (!normalise(scope.roomId) || !isArtifactSubjectAllowedInScope(db,head.artifact_id,head.revision,scope) || !isArtifactVisibleInScope(db,head.artifact_id,head.revision,scope))) {
      reject('scope',head.revision)
      continue
    }
    if (boundContact !== null && boundContact !== scopeContact && !groupScope) {
      reject('scope', head.revision)
      continue
    }
    // 候选声明的联系人只用于审计，不参与判定（可能缺失，不因此放行私有内容）
    if (contactId !== null && contactId !== scopeContact) {
      reject('scope', head.revision)
      continue
    }
    // R3.1：Channel / Group 准入已由共享 Recall Engine 在 SQL 里（LIMIT 前）完成，
    // Composer 不再做独立 channel 判定——否则会出现「检索端不知道 channel、
    // 注入端拿 null 比较」的假过滤（R3 之前这里就是恒不触发的死代码）。
    // 候选声明的 contactId/channel 只用于审计，不参与可见性判定。

    // 预算：条目与字符双上限，先到先得；超出的不记为拒绝，直接停止
    if (items.length >= maxItems) break
    // 同一个 Artifact 的同一个 revision 只注入一次（上游可能重复给候选）
    const dedupeKey = `${head.artifact_id}@${head.revision}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    const line = `- ${head.statement.trim()}`
    const nextChars = usedChars + line.length + 1
    if (nextChars > maxChars) break

    items.push({
      artifactId: head.artifact_id,
      revision: head.revision,
      kind: head.kind,
      state: head.state,
      disclosure: head.disclosure,
      contactId,
      channel,
      blockType,
      // 文本来自库，不是候选的 claimedStatement
      text: head.statement,
    })
    usedChars = nextChars
  }

  const staleInjected = items.filter((item) => {
    const head = db.get<{ revision: number; state: string }>(
      `SELECT revision, state FROM artifact_revisions
        WHERE artifact_id = ? ORDER BY revision DESC LIMIT 1`,
      [item.artifactId],
    )
    return !head || head.revision !== item.revision || !allowed.has(item.state)
  }).length
  // 注入项非 public：正常路径恒 0；若上游绕过（例如直接构造 item）也应被统计
  const disclosureLeaked = items.filter((item) => item.disclosure !== 'public').length

  stats.injected = items.length
  stats.staleInjected = staleInjected
  stats.disclosureLeaked = disclosureLeaked
  stats.staleInjectionRate = items.length === 0 ? 0 : staleInjected / items.length

  const text = items.length === 0 ? '' : `【${label}】\n${items.map((item) => `- ${item.text.trim()}`).join('\n')}`

  return { text, items, rejections, stats }
}

function normalise(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim()
  return trimmed.length === 0 ? null : trimmed
}

/** 从 subject_refs（JSON 数组文本）里取第一个 Contact 引用（ct_ 前缀）。 */
function firstContactRef(raw: string | null): string | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    for (const item of parsed) {
      const value = String(item ?? '').trim()
      if (value.startsWith('ct_')) return value
    }
    return null
  } catch {
    return null
  }
}
