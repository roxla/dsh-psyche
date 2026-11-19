/**
 * E5.5-D：注入清单（Injection Manifest）。
 *
 * 问题：`agent/pre-step` 注入一段记忆之后，后面的插件/监听器仍可能改 messages；
 * 只看最终文本无法判断「这段记忆是不是 Psyche 自己注入的那一段」。
 *
 * 做法：注入时在宿主进程的私有内存里登记一份清单——谁（requestId / session / turn）、
 * 哪些 Artifact Revision、每条的正文哈希、整条注入消息的哈希。最终检查器在
 * `llm/stream` 里拿实际消息与清单比对：内容被追加/替换/截断、Revision 变了、
 * 披露变了都会对不上，于是 fail closed。
 *
 * 明确边界：
 * - 清单里的 requestId/contactId 只是审计与关联键，**不是可信凭据**；真正的可信度
 *   来自「这份清单只存在于宿主内存，模型与普通消息都创建不了」。
 * - 清单能证明 Psyche 注入块的完整性；**不能**识别任意插件新加的一段无标记文本
 *   是不是抄自某条受限 Artifact——那需要宿主的插件信任模型，不属于本模块。
 */
import { createHash, randomUUID } from 'node:crypto'

/** 稳定的 sha256（导出给注入器与检查器共用，避免两边写法漂移）。 */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 一条被注入的记忆在清单里的样子：Artifact + Revision + 正文哈希。 */
export interface InjectionManifestItem {
  artifactId: string
  revision: number
  contentHash: string
}

/** 一次注入的完整记录。只存在于宿主内存，不落盘、不进 prompt。 */
export interface InjectionManifest {
  /** 注入块里的 `request-id`；最终检查器用它把消息与清单对上。 */
  requestId: string
  sessionId: string | null
  turn: number
  step: number
  contactId: string | null
  channelId: string | null
  groupId: string | null
  /**
   * R6-2.1：注入时的可信运行表面与解析后的 Room。
   *
   * 最终检查要确认「请求到达 Provider 时，这个 Session 仍是注入时那个可信绑定」，
   * 所以 surface / roomId 必须随清单一起记；否则群聊注入的记忆在身份被换掉后
   * 仍然能通过检查。旧清单没有这两个字段（undefined），按「未知」处理。
   */
  surface?: 'personal' | 'private' | 'group' | null
  roomId?: string | null
  /** 注入时的调用用途（普通聊天为 null）。 */
  purpose: string | null
  items: InjectionManifestItem[]
  /** 整条注入消息的 sha256；任何追加/替换都会让它对不上。 */
  messageHash: string
  createdAt: string
  /**
   * 最终检查通过的时间；null/缺省表示「仍活动」。
   *
   * E5.5-D2 收尾（2026-11-07）：清单淘汰不能只看 FIFO——请求 A 刚登记、还没第一次
   * 拉取 Stream 时，如果被 B..Z 的登记挤掉，A 会被误拒绝。所以未通过最终检查的
   * 清单不参与淘汰；校验成功后由调用方 markVerified，释放活动保护。
   */
  verifiedAt?: string | null
}

/** 内存清单表：按 requestId 索引，只保留最近若干条（防长会话无限增长）。 */
export class InjectionManifestStore {
  readonly #byRequestId = new Map<string, InjectionManifest>()
  readonly #order: string[] = []
  readonly #limit: number

  constructor(limit = 200) {
    this.#limit = Number.isInteger(limit) && limit > 0 ? limit : 200
  }

  register(manifest: InjectionManifest): void {
    const previous = this.#byRequestId.get(manifest.requestId)
    if (previous !== undefined) {
      // 同一 requestId 重登记（理论上不该发生）保留活动状态，避免把未校验的清单
      // 借重复登记洗成「可淘汰」。
      this.#byRequestId.set(manifest.requestId, { ...manifest, verifiedAt: previous.verifiedAt ?? null })
      return
    }
    this.#byRequestId.set(manifest.requestId, { ...manifest, verifiedAt: manifest.verifiedAt ?? null })
    this.#order.push(manifest.requestId)
    while (this.#order.length > this.#limit) {
      if (!this.#evictOne()) break
    }
  }

  /**
   * 淘汰一条「已通过最终检查」的清单。
   * 找不到可淘汰项（全部仍在活动）时返回 false，由调用方接受短暂超限——
   * 宁可变大，也不能为了守住容量把正在请求中的清单删掉造成误拒绝。
   */
  #evictOne(): boolean {
    for (let index = 0; index < this.#order.length; index += 1) {
      const requestId = this.#order[index]
      if (requestId === undefined) continue
      const manifest = this.#byRequestId.get(requestId)
      if (manifest === undefined) {
        this.#order.splice(index, 1)
        index -= 1
        continue
      }
      if (manifest.verifiedAt === null || manifest.verifiedAt === undefined) continue
      this.#order.splice(index, 1)
      this.#byRequestId.delete(requestId)
      return true
    }
    return false
  }

  /** 标记该请求已通过最终检查，从此可参与淘汰。 */
  markVerified(requestId: string): boolean {
    const manifest = this.#byRequestId.get(requestId)
    if (manifest === undefined) return false
    this.#byRequestId.set(requestId, { ...manifest, verifiedAt: new Date().toISOString() })
    return true
  }

  get(requestId: string): InjectionManifest | undefined {
    return this.#byRequestId.get(requestId)
  }

  drop(requestId: string): boolean {
    if (!this.#byRequestId.delete(requestId)) return false
    const index = this.#order.indexOf(requestId)
    if (index >= 0) this.#order.splice(index, 1)
    return true
  }

  /** 该会话最近一次登记的清单；检查器在消息里找不到 request-id 时的兜底关联。 */
  latestForSession(sessionId: string | null): InjectionManifest | undefined {
    if (sessionId === null) return undefined
    for (let index = this.#order.length - 1; index >= 0; index -= 1) {
      const manifest = this.#byRequestId.get(this.#order[index] ?? '')
      if (manifest !== undefined && manifest.sessionId === sessionId) return manifest
    }
    return undefined
  }

  size(): number {
    return this.#byRequestId.size
  }

  clear(): void {
    this.#byRequestId.clear()
    this.#order.length = 0
  }
}

/** 生成一个不会与用户文本碰撞的注入请求 id。 */
export function newInjectionRequestId(): string {
  return `inj_${randomUUID().replace(/-/g, '')}`
}

/** 构造清单（补 createdAt），调用方负责 register。 */
export function createInjectionManifest(
  input: Omit<InjectionManifest, 'createdAt'> & { createdAt?: string },
): InjectionManifest {
  return {
    ...input,
    createdAt: input.createdAt ?? new Date().toISOString(),
  }
}
