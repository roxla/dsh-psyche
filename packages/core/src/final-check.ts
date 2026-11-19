/**
 * E5.5-D：`llm/stream` 最终请求完整性检查。
 *
 * 这是「模型实际上会看到什么」的最后一道闸：它不做检索、不重构 Prompt，
 * 只核对两件事——
 * 1. 消息里的 Psyche 注入块是否都登记过（清单存在于宿主内存，模型造不出来）；
 * 2. 登记过的块是否仍与清单一致（正文被追加/替换/截断、Revision 变了、披露变了、
 *    状态不再准入、Scope 不匹配，全部判失败）。
 *
 * 判定失败时调用方必须**同步抛错**，让 Adapter 根本不消费这次请求；
 * 不能删掉问题消息继续、也不能返回空流。
 *
 * 边界（写进报告，不许含糊）：本检查能证明 Psyche 注入块的完整性，
 * 但不能识别任意插件新加的无标记文本是否抄自受限 Artifact——那需要
 * 宿主的插件信任模型，不在本模块职责内。
 */
import type { Db } from './adapter.js'
import { hasRevisionEvidence, isArtifactVisibleInScope, type FtsScope } from './fts.js'
import { hashText, type InjectionManifest, type InjectionManifestStore } from './injection-manifest.js'
import { resolveRoomId } from './recall.js'
import { surfaceOfPlatform, type RuntimeInput } from './runtime-input.js'
import { activeCanonicalOf, latestArchiveAction } from './memory-hygiene.js'
import { revisionHasDeletedExternalSource } from './external-source.js'

/**
 * full：完整性 + 当前准入（head/state/disclosure/scope）。
 *
 * E5.5-D2 收尾（2026-11-07）：压缩与标题不再只做完整性检查。这两种请求确实不注入
 * 新记忆，但历史消息里可能还带着注入块；只验 hash 不验披露，会让「注入后被遗忘/
 * 收紧披露」的记忆借摘要请求再次进入长期上下文。所以所有 purpose 都走 full——
 * 「不注入新记忆」是上游 Composer 的职责，最终检查的职责始终是：这段记忆**现在**
 * 是否仍然允许被模型读到。
 */
export type FinalCheckMode = 'full' | 'integrity-only'


export type FinalCheckViolationKind =
  | 'unregistered-block'
  | 'hash-mismatch'
  | 'duplicate-block'
  | 'session-mismatch'
  | 'surface'
  | 'head-moved'
  | 'state'
  | 'disclosure'
  | 'scope'
  | 'content-changed'
  | 'memory-archived'
  | 'memory-merged'
  | 'source-deleted'

export interface FinalCheckViolation {
  kind: FinalCheckViolationKind
  requestId?: string
  artifactId?: string
  revision?: number
  messageIndex?: number
  detail?: string
}

export interface FinalCheckOptions {
  manifests: InjectionManifestStore
  db: Db
  /** 实际交给模型的 messages（原样传入，只读）。 */
  messages: readonly unknown[]
  sessionId?: string | null
  purpose?: string | null
  /**
   * R6-2.1：当前请求的可信 RuntimeInput 快照。
   *
   * 传入后检查器会确认「请求到达 Provider 时仍是注入时那个可信绑定」：
   * Session 未换、运行表面未变、Contact/Room 未变、每条 Artifact 的来源域仍兼容。
   * 不传时退化为原地检查（兼容旧调用与测试），但生产路径必须传。
   */
  runtimeInput?: RuntimeInput | null
  /** Current Host group whitelist. Never supplied by a message, manifest or model argument. */
  groupAllowed?: (input: RuntimeInput) => boolean
}

export interface FinalCheckResult {
  ok: boolean
  mode: FinalCheckMode
  purpose: string | null
  /** 看到的注入块数量。 */
  blocks: number
  /** 能对上清单的块数量。 */
  trusted: number
  /** 对不上清单的块数量（没有可信块时只审计、不判失败）。 */
  untrusted: number
  /** 本次校验通过、可以释放「活动保护」的清单 id（由调用方标记 verified）。 */
  verifiedRequestIds: string[]
  violations: FinalCheckViolation[]
  /**
   * R6-5 前置：清理掉「不属于本次请求」的注入块之后的 messages。
   *
   * 调用方必须用这一份（而不是原始 messages）去调 Adapter——否则第三方插件在
   * PreStep 清理之后重新插入的历史块仍会进入 Provider。
   */
  messages: unknown[]
  /** 被清理掉的注入块数量（历史块、无 request-id 的块、清单里不存在的块）。 */
  strippedBlocks: number
  /** 因为整条消息都是外来注入块而被整条删除的消息数量。 */
  strippedMessages: number
}

const BLOCK_RE = /<memory-context\s+([^>]*)>([\s\S]*?)<\/memory-context>/g
const ATTR_RE = /([a-z][a-z0-9-]*)\s*=\s*"([^"]*)"/g
const ALLOWED_STATES = new Set(['active', 'challenged'])

/**
 * 所有用途都做完整检查：压缩/标题可以不注入新记忆，但已有注入块必须复核当前
 * 披露与状态（E5.5-D2 收尾，见文件头）。未知用途同样按最严格处理。
 */
export function finalCheckMode(purpose: string | null | undefined): FinalCheckMode {
  void purpose
  return 'full'
}


/** 把消息 content 归一成文本：字符串原样，多段内容只拼 text 块。 */
function messageText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ATTR_RE.exec(raw)) !== null) {
    const key = match[1]
    const value = match[2]
    if (key !== undefined && value !== undefined) attributes[key] = value
  }
  return attributes
}

function rawContactOf(subjectRefs: string | null): string | null {
  if (subjectRefs === null || subjectRefs.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(subjectRefs)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  for (const value of parsed) {
    if (typeof value === 'string' && value.startsWith('ct_')) return value
  }
  return null
}

interface HeadRow {
  revision: number
  state: string
  disclosure: string
  statement: string
  subject_refs: string | null
}

/** R6-2.1：当前请求应有的可信 Scope（由 RuntimeInput 推导，不信任消息里的任何声明）。 */
interface ExpectedScope {
  contactId: string | null
  roomId: string | null
  surface: 'personal' | 'private' | 'group'
}

function expectedScopeOf(db: Db, input: RuntimeInput): { scope: ExpectedScope; roomMissing: boolean } {
  const surface = surfaceOfPlatform(input.platform, input.groupId)
  // 群聊必须能解析出 Room；解析不到就 fail closed——不能在 Room 缺失时退回
  // Contact 或 global 的宽松逻辑，那正是「群消息串到私聊」的来源。
  const roomId = surface === 'group' ? resolveRoomId(db, input.platform, input.groupId ?? null) : null
  return {
    scope: { contactId: input.contactId, roomId, surface },
    roomMissing: surface === 'group' && roomId === null,
  }
}

function checkItems(
  db: Db,
  manifest: InjectionManifest,
  messageIndex: number,
  violations: FinalCheckViolation[],
  expected: ExpectedScope | undefined,
  groupAllowed: boolean,
): void {
  for (const item of manifest.items) {
    const head = db.get<HeadRow>(
      `SELECT r.revision, r.state, r.disclosure, r.statement, r.subject_refs
         FROM artifact_revisions r
        WHERE r.artifact_id = ?
          AND r.revision = (SELECT max(revision) FROM artifact_revisions WHERE artifact_id = ?)`,
      [item.artifactId, item.artifactId],
    )
    if (head === undefined) {
      violations.push({
        kind: 'content-changed',
        requestId: manifest.requestId,
        artifactId: item.artifactId,
        revision: item.revision,
        messageIndex,
        detail: 'injected artifact revision no longer exists',
      })
      continue
    }
    // R6-2.1：注入之后来源域可能变了（同一条结论补了别的渠道的证据、Source 被删）。
    // 这里复用检索时的同一套来源域规则，不再写第二份近似判断。
    let sourceVisible = false
    if (expected !== undefined) {
      const visible = isArtifactVisibleInScope(db, item.artifactId, item.revision, {
        contactId: expected.contactId,
        roomId: expected.roomId,
        surface: expected.surface,
      })
      sourceVisible = visible
      if (!visible) {
        violations.push({
          kind: 'scope',
          requestId: manifest.requestId,
          artifactId: item.artifactId,
          revision: item.revision,
          messageIndex,
          detail: 'artifact source domains no longer match the current trusted scope',
        })
      }
    }
    if (head.revision !== item.revision) {
      violations.push({
        kind: 'head-moved',
        requestId: manifest.requestId,
        artifactId: item.artifactId,
        revision: item.revision,
        messageIndex,
        detail: `head is now r${head.revision}`,
      })
    }
    if (hashText(head.statement) !== item.contentHash) {
      violations.push({
        kind: 'content-changed',
        requestId: manifest.requestId,
        artifactId: item.artifactId,
        revision: item.revision,
        messageIndex,
        detail: 'statement changed after injection',
      })
    }
    if (!ALLOWED_STATES.has(head.state)) {
      violations.push({
        kind: 'state',
        requestId: manifest.requestId,
        artifactId: item.artifactId,
        revision: item.revision,
        messageIndex,
        detail: `state=${head.state}`,
      })
    }
    if (head.disclosure !== 'public') {
      violations.push({
        kind: 'disclosure',
        requestId: manifest.requestId,
        artifactId: item.artifactId,
        revision: item.revision,
        messageIndex,
        detail: `disclosure=${head.disclosure}`,
      })
    }
    // P5-R：P5-5/P5-6 的有效性必须在这道最后闸门复核，不能只在检索入口过滤。
    if (latestArchiveAction(db, item.artifactId) === 'archive') {
      violations.push({ kind: 'memory-archived', requestId: manifest.requestId, artifactId: item.artifactId,
        revision: item.revision, messageIndex, detail: 'artifact archived after injection' })
    }
    const canonical = activeCanonicalOf(db, item.artifactId)
    if (canonical !== null && canonical !== item.artifactId) {
      violations.push({ kind: 'memory-merged', requestId: manifest.requestId, artifactId: item.artifactId,
        revision: item.revision, messageIndex, detail: 'artifact merged into another canonical after injection' })
    }
    if (revisionHasDeletedExternalSource(db, item.artifactId, head.revision)) {
      violations.push({ kind: 'source-deleted', requestId: manifest.requestId, artifactId: item.artifactId,
        revision: item.revision, messageIndex, detail: 'head evidence references a deleted external source' })
    }
    // Corrupt Subject metadata must not be mistaken for an unbound global memory.
    let validSubjects = false
    try { validSubjects = Array.isArray(JSON.parse(head.subject_refs ?? '')) } catch { /* fail closed */ }
    if (!validSubjects) {
      violations.push({ kind: 'scope', requestId: manifest.requestId, artifactId: item.artifactId,
        revision: item.revision, messageIndex, detail: 'invalid subject_refs' })
      continue
    }
    const boundContact = rawContactOf(head.subject_refs)
    const evidencePresent = boundContact !== null && hasRevisionEvidence(db, item.artifactId, head.revision)
    const groupRoomException = boundContact !== null && groupAllowed &&
      expected?.surface === 'group' && expected.roomId !== null &&
      manifest.surface === 'group' && manifest.roomId === expected.roomId && evidencePresent && sourceVisible
    if (expected?.surface === 'group' && boundContact !== null && !evidencePresent) {
      violations.push({ kind: 'scope', requestId: manifest.requestId, artifactId: item.artifactId,
        revision: item.revision, messageIndex, detail: 'group member memory requires revision evidence' })
    }
    if (manifest.contactId === null && boundContact !== null && !groupRoomException) {
      violations.push({
        kind: 'scope',
        requestId: manifest.requestId,
        artifactId: item.artifactId,
        revision: item.revision,
        messageIndex,
        detail: 'anonymous injection carried a contact-bound memory',
      })
    }
    // R6-3A：R3.1 之后「无 Contact 绑定」= 全局记忆，对任何可信 Contact 可见；
    // 只有模板绑定了别的 Contact 才越权（注入给 A 的块里出现 B 的私有记忆）。
    if (manifest.contactId !== null && boundContact !== null && boundContact !== manifest.contactId && !groupRoomException) {
      violations.push({
        kind: 'scope',
        requestId: manifest.requestId,
        artifactId: item.artifactId,
        revision: item.revision,
        messageIndex,
        detail: `memory bound to ${boundContact ?? 'none'}, injected for ${manifest.contactId}`,
      })
    }
  }
}

/**
 * R6-5 前置：最终请求边界只放行「本次请求登记过的」注入块。
 *
 * 为什么不能只看「最后一条 user 消息」：第三方插件可以在 PreStep 清理之后
 * 再把历史块插回 messages——那样块同样出现在最后一条 user 消息里。可信依据
 * 只有一份：宿主内存里的 InjectionManifest。request-id 对不上清单、或者根本
 * 没有 request-id 的块，一律从这次请求里移除。
 *
 * 清理规则：
 * - 块全部是本请求登记的 → 原样保留；
 * - 块全部是外来的 → 整条消息删除（注入块本来就是独立消息，留下空壳没有意义）；
 * - 块与正文混合 → 只在 content 是字符串或单一 text 块时移除块文本；
 *   其他形状整条丢弃（宁可少一条消息，也不做可能改错正文的拼接）；
 * - 有 `<memory-context` 字面量却解析不出完整块 → 整条丢弃（来源不明的注入通道）。
 */
export interface InjectionBoundaryResult {
  messages: unknown[]
  strippedBlocks: number
  strippedMessages: number
}

interface InjectionBlockRange {
  start: number
  end: number
  requestId: string | null
}

function findInjectionBlocks(text: string): InjectionBlockRange[] {
  const ranges: InjectionBlockRange[] = []
  BLOCK_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BLOCK_RE.exec(text)) !== null) {
    const attributes = parseAttributes(match[1] ?? '')
    const rawRequestId = attributes['request-id']
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
      requestId: typeof rawRequestId === 'string' && rawRequestId.length > 0 ? rawRequestId : null,
    })
  }
  return ranges
}

/** 把清理后的文本放回原 content；形状不支持时返回 null（调用方整条丢弃）。 */
function rebuildContent(content: unknown, text: string): unknown | null {
  if (typeof content === 'string') return text
  if (!Array.isArray(content)) return null
  const blocks = content as Array<{ type?: string; text?: string }>
  const textIndexes: number[] = []
  blocks.forEach((block, index) => {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      textIndexes.push(index)
    }
  })
  if (textIndexes.length !== 1) return null
  const only = textIndexes[0] as number
  return blocks.map((block, index) => (index === only ? { ...block, text } : block))
}

export function stripForeignInjectionBlocks(
  messages: readonly unknown[],
  manifests: InjectionManifestStore,
): InjectionBoundaryResult {
  const kept: unknown[] = []
  let strippedBlocks = 0
  let strippedMessages = 0

  for (const message of messages) {
    const record = typeof message === 'object' && message !== null ? (message as { content?: unknown }) : null
    const content = record !== null && 'content' in record ? record.content : message
    const text = messageText(content)
    if (text === null || !text.includes('<memory-context')) {
      kept.push(message)
      continue
    }
    const blocks = findInjectionBlocks(text)
    if (blocks.length === 0) {
      strippedBlocks += 1
      strippedMessages += 1
      continue
    }
    const foreign = blocks.filter(
      (block) => block.requestId === null || manifests.get(block.requestId) === undefined,
    )
    if (foreign.length === 0) {
      kept.push(message)
      continue
    }
    strippedBlocks += foreign.length
    let cleaned = text
    for (const block of [...foreign].reverse()) {
      cleaned = cleaned.slice(0, block.start) + cleaned.slice(block.end)
    }
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()
    if (cleaned.length === 0) {
      strippedMessages += 1
      continue
    }
    const rebuilt = rebuildContent(content, cleaned)
    if (rebuilt === null) {
      strippedMessages += 1
      continue
    }
    kept.push(record === null ? rebuilt : { ...record, content: rebuilt })
  }

  return { messages: kept, strippedBlocks, strippedMessages }
}

/**
 * 校验一次模型调用前的最终消息列表。
 *
 * 只看消息内容；不查询、不改写。调用方拿到 `ok=false` 时应抛
 * `E_FINAL_CHECK` 并让这次请求失败；但 `ok=true` 时**必须**用返回的
 * `messages`（已移除外来注入块）去调 Adapter，而不是原始 messages。
 */
export function validateFinalRequest(options: FinalCheckOptions): FinalCheckResult {
  const mode = finalCheckMode(options.purpose)
  const violations: FinalCheckViolation[] = []
  const pendingUnregistered: FinalCheckViolation[] = []
  const verifiedRequestIds: string[] = []
  const seenRequestIds = new Set<string>()
  const runtimeInput = options.runtimeInput ?? null
  const expected = runtimeInput === null ? undefined : expectedScopeOf(options.db, runtimeInput)
  let groupAllowed = false
  if (runtimeInput !== null && expected?.scope.surface === 'group') {
    try { groupAllowed = options.groupAllowed?.(runtimeInput) === true } catch { /* deny */ }
    // Existing pure callers remain compatible; the Host always supplies the live whitelist.
    if (options.groupAllowed !== undefined && !groupAllowed) violations.push({kind:'scope',detail:'current group is not allowed'})
  }
  let blocks = 0
  let trusted = 0
  let untrusted = 0

  // R6-5 前置：先把「不属于本次请求」的注入块从 messages 里移除。
  // 历史块（上一轮注入、被 agent-loop append 进会话历史）在这里被清掉，
  // 第三方插件事后重新插入的块同样对不上清单——都会被移除。
  // 清理之后还留在消息里的块，只剩本请求登记的，或形状怪异无法解析的；
  // 后者按 untrusted 处理并在本轮块上判失败。
  const boundary = stripForeignInjectionBlocks(options.messages, options.manifests)
  const messages = boundary.messages

  // 兼容旧调用：清理后通常已无历史块，lastUserIndex 仅用于「清理后仍无法解析的块」
  // 是否属于本轮，从而决定 fail closed。
  let lastUserIndex = -1
  messages.forEach((message, index) => {
    const record = typeof message === 'object' && message !== null ? (message as { role?: unknown }) : null
    if (record !== null && record.role === 'user') lastUserIndex = index
  })

  messages.forEach((message, messageIndex) => {
    // DSH 的 messages 是 {role, content} 对象；也兼容直接传文本数组的测试。
    const record = typeof message === 'object' && message !== null ? (message as { content?: unknown }) : null
    const raw = record !== null && 'content' in record ? record.content : message
    const text = messageText(raw)
    if (text === null || !text.includes('<memory-context')) return
    BLOCK_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = BLOCK_RE.exec(text)) !== null) {
      blocks += 1
      const attributes = parseAttributes(match[1] ?? '')
      const requestId = attributes['request-id']
      if (requestId === undefined || requestId.length === 0) {
        untrusted += 1
        if (messageIndex === lastUserIndex) {
          pendingUnregistered.push({ kind: 'unregistered-block', messageIndex, detail: 'block has no request-id' })
        }
        continue
      }
      const manifest = options.manifests.get(requestId)
      if (manifest === undefined) {
        untrusted += 1
        // 历史块（非本轮最后一条 user 消息）放行：见 lastUserIndex 的说明。
        if (messageIndex === lastUserIndex) {
          pendingUnregistered.push({
            kind: 'unregistered-block',
            requestId,
            messageIndex,
            detail: 'no manifest for request-id',
          })
        }
        continue
      }
      trusted += 1
      if (seenRequestIds.has(requestId)) {
        violations.push({ kind: 'duplicate-block', requestId, messageIndex })
      } else {
        seenRequestIds.add(requestId)
        verifiedRequestIds.push(requestId)
      }
      // R6-2.1：可信绑定的一致性。RuntimeInput 缺失时退化为原地检查（旧调用/测试）。
      if (runtimeInput !== null) {
        if (manifest.sessionId !== null && manifest.sessionId !== runtimeInput.sessionId) {
          violations.push({
            kind: 'session-mismatch',
            requestId,
            messageIndex,
            detail: `manifest session ${manifest.sessionId} vs runtime ${runtimeInput.sessionId}`,
          })
        }
        if (
          expected !== undefined &&
          manifest.surface !== undefined &&
          manifest.surface !== null &&
          manifest.surface !== expected.scope.surface
        ) {
          violations.push({
            kind: 'surface',
            requestId,
            messageIndex,
            detail: `injected on ${manifest.surface}, now ${expected.scope.surface}`,
          })
        }
        if (expected !== undefined && manifest.contactId !== expected.scope.contactId) {
          violations.push({
            kind: 'scope',
            requestId,
            messageIndex,
            detail: `manifest contact ${manifest.contactId ?? 'none'} vs trusted ${expected.scope.contactId ?? 'none'}`,
          })
        }
        if (expected !== undefined && (manifest.groupId ?? null) !== (runtimeInput.groupId ?? null)) {
          violations.push({
            kind: 'scope',
            requestId,
            messageIndex,
            detail: `manifest group ${manifest.groupId ?? 'none'} vs trusted ${runtimeInput.groupId ?? 'none'}`,
          })
        }
        if (expected !== undefined && expected.roomMissing) {
          violations.push({
            kind: 'scope',
            requestId,
            messageIndex,
            detail: 'trusted group session has no resolvable room (fail closed)',
          })
        } else if (
          expected !== undefined &&
          manifest.roomId !== undefined &&
          manifest.roomId !== null &&
          manifest.roomId !== expected.scope.roomId
        ) {
          violations.push({
            kind: 'scope',
            requestId,
            messageIndex,
            detail: `manifest room ${manifest.roomId} vs trusted ${expected.scope.roomId ?? 'none'}`,
          })
        }
      }
      if (
        manifest.sessionId !== null &&
        options.sessionId !== undefined &&
        options.sessionId !== null &&
        manifest.sessionId !== options.sessionId
      ) {
        violations.push({
          kind: 'session-mismatch',
          requestId,
          messageIndex,
          detail: `manifest session ${manifest.sessionId} vs request ${options.sessionId}`,
        })
      }
      if (hashText(text) !== manifest.messageHash) {
        violations.push({
          kind: 'hash-mismatch',
          requestId,
          messageIndex,
          detail: 'injected block text changed after registration',
        })
      }
      if (mode === 'full') {
        checkItems(options.db, manifest, messageIndex, violations, expected?.scope, groupAllowed)
      }
    }
  })

  // 没有可信块时，「未登记」只可能是用户自己写的标签：只审计、不判失败。
  if (trusted > 0) violations.push(...pendingUnregistered)

  return {
    ok: violations.length === 0,
    mode,
    purpose: options.purpose ?? null,
    blocks,
    trusted,
    untrusted,
    verifiedRequestIds,
    violations,
    // 调用方必须用这一份去调 Adapter；原始 messages 里可能还带着被移除的历史块。
    messages,
    strippedBlocks: boundary.strippedBlocks,
    strippedMessages: boundary.strippedMessages,
  }
}
