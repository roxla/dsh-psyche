/**
 * 组装回执：记下「这一轮到底往提示里放了什么」。
 *
 * 为什么要有它：第 28–31 轮的真实宿主验收里，有五项里有两项卡在同一个地方——
 * 插件只能证明「我调了召回、它返回了一段文本」，无法证明「这段文本进了最终提示」。
 * 用户问「昨天聊的还记得吗」时，答不出到底是因为没召回、召回了被预算裁掉、
 * 还是被渠道判定挡住。外部评审（第 30 轮）要求把这个采样点放在
 * `ProjectionController` 拿到 `composeProjections()` 最终结果、即将把文本
 * 返回给宿主的位置——不是放在召回函数里，否则「命中但被裁掉」会被误报成「已组装」。
 *
 * 口径（评审定）：
 * - **只在内存里**，不落库、不升 Schema；重启即清零。
 * - **不保存用户原文、问题和模型回复**，只记标识、块名、字符数与来源 ID。
 * - 每会话保留最近若干条，全局再有上限——按会话区分是必要的，
 *   否则并行跑的主会话和子会话会互相覆盖，看起来像「这一轮什么都没装」。
 */

/**
 * 最终被组装进提示的块。顺序与序列化顺序一致。
 *
 * **不含 `conversationRecall`**：v29.15 起日常召回迁到 `agent/pre-step` 注入，
 * 不再是 Composer 的块。它那一脉的证据走 `recallSourceIds` / `recallSkipped`。
 * 之前留着这个块名，回执里它永远是 `chars: 0 / reason: empty`，读回执的人会
 * 以为「召回了但没装进去」——实际上是它压根不在这条路上。
 */
export const ASSEMBLY_BLOCK_NAMES = [
  'memoryDiscipline',
  'persona',
  'projectBrief',
  'growth',
  'mood',
  'relationship',
  'intention',
] as const

export type AssemblyBlockName = (typeof ASSEMBLY_BLOCK_NAMES)[number]

/** 一个块在这次组装里的结局。 */
export interface AssemblyBlockRecord {
  name: string
  /** 源头文本字符数；空串表示这一块这次没有内容。 */
  chars: number
  /** 是否最终进了返回给宿主的文本。 */
  kept: boolean
  /** 没进的原因：empty（源头为空）/ budget（被预算裁掉）/ over-budget（必需层超限）。 */
  reason: 'kept' | 'empty' | 'budget' | 'over-budget'
}

/** 接收方身份与判定依据。 */
export interface AssemblyReceiver {
  /** 会话属于哪一侧：桌面 / Owner 私聊 / 其他 / 判不出来。 */
  channel: 'desktop' | 'owner-private' | 'other' | 'unknown'
  /** 是否是子代理（委派）会话。 */
  delegated: boolean
  /** 判定依据，便于复核是不是靠猜的。 */
  delegatedBy: 'session.header.depth' | 'session.header.origin' | 'none'
  /** 会话标识；宿主没给就留空。 */
  sessionId: string | null
  /** 宿主实际提供的 turnId；拿不到就留空。 */
  turnId: string | null
}

/** 一条组装回执。 */
export interface AssemblyReceipt {
  assemblyId: string
  at: string
  receiver: AssemblyReceiver
  /** 每块一行，按 ASSEMBLY_BLOCK_NAMES 顺序。 */
  blocks: AssemblyBlockRecord[]
  /** 最终文本的字符数与估算 token。 */
  usedChars: number
  usedTokens: number
  /** composer 给出的告警（如 persona 超预算整块省略）。 */
  warnings: string[]
  /** 召回块实际带进来的 Source ID（按入选顺序）。 */
  recallSourceIds: string[]
  /** 召回块选中的会话；用于确认「找回的是哪一段」。 */
  recallSessionRef: string | null
  /** 召回被跳过时的原因（no-sources / no-match / empty 等）。 */
  recallSkipped: string | null
  /** 项目块读到的 Checkpoint 与修订号。 */
  projectCheckpointId: string | null
  projectRevision: number | null
}

/** 组装回执的采集输入。 */
export interface AssemblyReceiptInput {
  receiver: AssemblyReceiver
  /** composeProjections 的输入块（用来算每块字符数与是否为空）。 */
  inputs: Record<string, string | undefined>
  /** composeProjections 的结果。 */
  kept: string[]
  dropped: string[]
  warnings: string[]
  usedChars: number
  usedTokens: number
  recallSourceIds?: string[]
  recallSessionRef?: string | null
  recallSkipped?: string | null
  projectCheckpointId?: string | null
  projectRevision?: number | null
}

export interface AssemblyReceiptOptions {
  /** 每会话保留条数，默认 20。 */
  perSession?: number
  /** 全局保留条数，默认 200。 */
  total?: number
  /** 时钟注入，测试用。 */
  now?: () => Date
}

/**
 * 有界内存回执表。
 *
 * 容量策略：每会话单独一条环形数组（够看清「这一轮组装了什么」），
 * 全局再记一个插入顺序队列，超出总上限时从最旧的开始丢。
 */
export class AssemblyReceiptStore {
  #perSession: number
  #total: number
  #now: () => Date
  #bySession = new Map<string, AssemblyReceipt[]>()
  #order: string[] = []
  #byId = new Map<string, AssemblyReceipt>()
  #seq = 0

  constructor(options: AssemblyReceiptOptions = {}) {
    this.#perSession = Math.max(1, options.perSession ?? 20)
    this.#total = Math.max(1, options.total ?? 200)
    this.#now = options.now ?? (() => new Date())
  }

  get size(): number {
    return this.#byId.size
  }

  /** 记一条；返回生成的回执。 */
  record(input: AssemblyReceiptInput): AssemblyReceipt {
    this.#seq += 1
    const at = this.#now().toISOString()
    const id = `asm_${this.#seq.toString(36)}_${at.replace(/[-:TZ.]/g, '').slice(8, 20)}`

    const keptSet = new Set(input.kept)
    const blocks: AssemblyBlockRecord[] = Object.keys(input.inputs).map((name) => {
      const text = input.inputs[name] ?? ''
      const chars = text.length
      if (chars === 0) return { name, chars: 0, kept: false, reason: 'empty' }
      if (keptSet.has(name)) return { name, chars, kept: true, reason: 'kept' }
      // 非空但没进最终文本：要么被预算裁掉，要么是必需层超限被整块省略。
      const reason: AssemblyBlockRecord['reason'] = name === 'persona' ? 'over-budget' : 'budget'
      return { name, chars, kept: false, reason }
    })

    const receipt: AssemblyReceipt = {
      assemblyId: id,
      at,
      receiver: input.receiver,
      blocks,
      usedChars: input.usedChars,
      usedTokens: input.usedTokens,
      warnings: [...input.warnings],
      recallSourceIds: [...(input.recallSourceIds ?? [])],
      recallSessionRef: input.recallSessionRef ?? null,
      recallSkipped: input.recallSkipped ?? null,
      projectCheckpointId: input.projectCheckpointId ?? null,
      projectRevision: input.projectRevision ?? null,
    }

    const key = this.#sessionKey(input.receiver)
    const list = this.#bySession.get(key)
    if (list === undefined) this.#bySession.set(key, [receipt])
    else {
      list.push(receipt)
      if (list.length > this.#perSession) list.shift()
    }
    this.#order.push(id)
    this.#byId.set(id, receipt)
    this.#trim()

    return receipt
  }

  /** 最近若干条；给 sessionId 就只看这一侧。 */
  recent(sessionId?: string | null, limit = 20): AssemblyReceipt[] {
    const cap = Math.max(1, Math.min(limit, this.#total))
    if (sessionId !== undefined && sessionId !== null && sessionId.length > 0) {
      const list = this.#bySession.get(sessionId) ?? []
      return list.slice(-cap)
    }
    const out: AssemblyReceipt[] = []
    for (let i = this.#order.length - 1; i >= 0 && out.length < cap; i -= 1) {
      const item = this.#byId.get(this.#order[i]!)
      if (item !== undefined) out.push(item)
    }
    return out
  }

  clear(): void {
    this.#bySession.clear()
    this.#byId.clear()
    this.#order = []
  }

  #sessionKey(receiver: AssemblyReceiver): string {
    if (receiver.sessionId !== null && receiver.sessionId.length > 0) return receiver.sessionId
    return `__unknown__:${receiver.channel}`
  }

  #trim(): void {
    while (this.#order.length > this.#total) {
      const oldest = this.#order.shift()
      if (oldest === undefined) break
      const receipt = this.#byId.get(oldest)
      this.#byId.delete(oldest)
      if (receipt === undefined) continue
      const key = this.#sessionKey(receipt.receiver)
      const list = this.#bySession.get(key)
      if (list === undefined) continue
      const index = list.indexOf(receipt)
      if (index >= 0) list.splice(index, 1)
      if (list.length === 0) this.#bySession.delete(key)
    }
  }
}
