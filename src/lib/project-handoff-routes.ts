// G1-A 手动交接的三条 Owner 路由。
//
// 闭环（模型调用为零）：
//   预览 POST /preview  —— 读当前会话的候选证据与既有修订，生成草稿，**不写库**；
//   保存 POST /save     —— 用草稿里的区间与证据写一条 Checkpoint 修订；
//   读取 GET  /         —— 按项目+分支读 head，或按 checkpointId+revision 定点读回。
//
// 三条不变量（对应验收三点）：
//   1. 取消 = 客户端不调 /save，因此整条链路不产生任何行；
//   2. 同一 draftKey 重复提交走 Core 的 job 重放（唯一索引命中），第二次不新增行；
//   3. /save 返回的 checkpointId + revision 可用 GET 定点读回，重启后同样成立。
//
// 边界：不做身份认证（与 init/grant/remember 路由一致，只挂本机 Web 服务）；
// 不接收正文与联系人；不写 artifacts / events / fts，因此不影响 Recall。
import type { HttpRequest, HttpRoute, HttpResponse } from '@deepseek-ai/cordis'

import type { Db } from './adapter.js'
import {
  bindSession,
  ensureProject,
  readCheckpoint,
  readCheckpointRevision,
  saveCheckpoint,
  type CheckpointReferenceInput,
} from './project-handoff-store.js'

const PERSONA_ID = 'main'
const PLATFORM = 'desktop'
const ALGORITHM_VERSION = 'manual-v1'
/** 草稿只活在进程内：预览本来就不该持久化，重启后必须重新预览。 */
const DRAFT_TTL_MS = 30 * 60 * 1000
// 同时存活的草稿上限。到期清理管时间，这个管容量——只有时间维度时，
// 一次快速点很多次预览就能把内存推到不受控。
const MAX_DRAFTS = 32
const MAX_CANDIDATES = 20

interface Draft {
  sessionId: string
  fromSeq: number
  toSeq: number
  sourceIds: string[]
  // 草稿绑定「预览时看到的那条分支」。保存时若请求体没给 branchKey 就用它，
  // 避免预览 main、保存却落到最近更新的 feature 上。
  branchKey: string
  createdAt: number
}

export interface ProjectHandoffRouteDeps {
  ready: Promise<unknown>
  /** 每次请求现取：boot 未完成或引擎失败时返回 null。 */
  db: () => Db | null
  unavailable: () => string | null
  logger: { warn?: (message: string, detail?: unknown) => void }
  send: (response: HttpResponse, statusCode: number, body: unknown) => void
  sendJson: (response: HttpResponse, body: unknown) => void
  readJsonBody: (request: HttpRequest) => Promise<Record<string, unknown>>
}

interface SourceRow {
  sourceId: string
  kind: string
  text: string | null
  capturedAt: string
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const line = text(item, max)
    if (line !== '' && !out.includes(line)) out.push(line)
    if (out.length >= 20) break
  }
  return out
}

function newId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  const raw = typeof uuid === 'string' ? uuid.replaceAll('-', '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  return `${prefix}${raw.slice(0, 24)}`
}

/**
 * 内容指纹：目标分支 + 规范正文 + 去重后的证据引用。
 *
 * 它只用来回答「同一个 requestId 前后两次的内容是不是同一份」，不承担去重职责——
 * 去重靠 requestId。反过来也不行：用内容哈希当唯一键时，两次独立提交只要内容相同就会被
 * 误判成重放，而同一个请求因为前端错误带上不同内容时又会被当成新任务。
 */
function digestOf(payload: {
  branchKey: string
  currentGoal: string
  completed: string[]
  blockers: string[]
  nextSteps: string[]
  itemKey: string
  sourceIds: string[]
}): string {
  const canonical = JSON.stringify([
    payload.branchKey,
    payload.currentGoal,
    payload.completed,
    payload.blockers,
    payload.nextSteps,
    payload.itemKey,
    [...payload.sourceIds].sort(),
  ])
  let hash = 0x811c9dc5
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `h${hash.toString(16).padStart(8, '0')}`
}

/** 草稿仓库：只存映射，不存正文；过期自动清。 */
const drafts = new Map<string, Draft>()

// 第 37 轮外部评审 P2（09）：清理此前只在新建预览时发生。
// 后果有两个：①草稿进了内存就再没人回收，只要不再预览就一直留着；
// ②过期判定只发生在 prunDrafts，保存时只查「在不在 Map 里」——
// 于是超过 TTL、期间又没有任何其他请求的草稿，仍然能被保存成功。
// 现在改成：每次交接请求入口都先 prune，保存时再对目标草稿单判一次 TTL。
function pruneDrafts(now: number): void {
  for (const [key, draft] of drafts) {
    if (now - draft.createdAt > DRAFT_TTL_MS) drafts.delete(key)
  }
  // 时间上还有效、但数量超限时，从最旧的开始淘汰（Map 保持插入顺序）。
  // 这是纯内存上限，不写库：草稿本来就随进程生灭，够用即可。
  while (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next()
    if (oldest.done === true) break
    drafts.delete(oldest.value)
  }
}

function candidatesFor(db: Db, sessionId: string): SourceRow[] {
  // 第 37 轮外部评审 P1（07）：绑定键（规范值 desktop）与来源平台别名是两件事。
  // 真实 Desktop 会话的 Source 记的是 `dsh-session`（实测 486+301 条），只有
  // 少数是 `desktop`。此前这里也用 `platform='desktop'` 查证据，于是出现
  // 「项目已经绑定、聊天也落库了，预览却找不到证据」——用户会以为插件没记住。
  const aliases = ['dsh-session', 'dsh', 'desktop']
  return db.all<SourceRow>(
    `SELECT source_id AS sourceId, kind, text, captured_at AS capturedAt FROM sources
     WHERE persona_id = ? AND platform IN (${aliases.map(() => '?').join(', ')}) AND session_ref = ?
     ORDER BY created_at DESC, source_id ASC LIMIT ?`,
    [PERSONA_ID, ...aliases, sessionId, MAX_CANDIDATES],
  )
}

function activeBinding(db: Db, sessionId: string): { bindingId: string; projectId: string; committedToSeq: number } | null {
  const row = db.get<{ bindingId: string; projectId: string; committedToSeq: number }>(
    'SELECT binding_id AS bindingId, project_id AS projectId, committed_to_seq AS committedToSeq ' +
      'FROM project_session_bindings ' +
      'WHERE persona_id = ? AND platform = ? AND session_ref = ? AND unbound_at IS NULL',
    [PERSONA_ID, PLATFORM, sessionId],
  )
  return row ?? null
}

function projectRow(db: Db, projectId: string): { canonicalName: string; workspaceKey: string | null } | null {
  const row = db.get<{ canonicalName: string; workspaceKey: string | null }>(
    'SELECT canonical_name AS canonicalName, workspace_key AS workspaceKey FROM projects ' +
      'WHERE persona_id = ? AND project_id = ?',
    [PERSONA_ID, projectId],
  )
  return row ?? null
}

function errorStatus(code: string | null): number {
  if (code === 'E_VALIDATION' || code === 'E_EMPTY_STATEMENT' || code === 'E_ARGUMENT') return 400
  if (code === 'E_NOT_FOUND') return 404
  if (code === 'E_REVISION_CONFLICT' || code === 'E_STATE' || code === 'E_IDEMPOTENT') return 409
  return 500
}

export function registerProjectHandoffRoutes(deps: ProjectHandoffRouteDeps): HttpRoute[] {
  const preview: HttpRoute = {
    kind: 'exact',
    path: '/api/psyche/project-handoff/preview',
    async handler(request: HttpRequest, response: HttpResponse) {
      if (request.method !== 'POST') {
        deps.send(response, 405, { ok: false, code: 'E_METHOD', error: '只接受 POST' })
        return
      }
      await deps.ready
      const unavailable = deps.unavailable()
      const db = deps.db()
      if (unavailable !== null || db === null) {
        deps.send(response, 503, { ok: false, code: 'E_UNAVAILABLE', error: unavailable ?? '记忆引擎还没就绪' })
        return
      }
      const body = await deps.readJsonBody(request)
      const sessionId = text(body.sessionId, 200)
      if (sessionId === '') {
        deps.send(response, 400, { ok: false, code: 'E_VALIDATION', error: '需要 sessionId' })
        return
      }

      const now = Date.now()
      pruneDrafts(now)
      // 第 37 轮外部评审 P2（09）边界修正：容量满了要拒绝新预览，不能淘汰仍有效的草稿。
      // 淘汰会让另一个窗口里正在编辑的那份凭空消失（用户点保存才发现草稿没了）。
      if (drafts.size >= MAX_DRAFTS) {
        deps.send(response, 429, {
          ok: false,
          code: 'E_DRAFT_FULL',
          error: `草稿已达上限 ${MAX_DRAFTS} 份，请先保存或取消其中一份`,
        })
        return
      }

      const binding = activeBinding(db, sessionId)
      const sources = candidatesFor(db, sessionId)
      const sourceIds = sources.map((row) => row.sourceId)
      // 手动保存没有可重放的区间：fromSeq/toSeq 只记录保存时刻的水位位置，
      // 不推进 committed_to_seq。用「证据条数」推算区间会在零证据、重复选同一来源、
      // 跳选非连续来源三种情况下都得出错误的位置（见 docs/audit/g1a-manual-range-semantics.md）。
      const anchor = (binding?.committedToSeq ?? 0) + 1
      const fromSeq = anchor
      const toSeq = anchor

      const project = binding ? projectRow(db, binding.projectId) : null
      // 第 37 轮外部评审 P1（06）顺带挖出的真缺陷：这里原先调
      // `readCheckpoint(db, { projectId })` 没给分支，而 Core 缺省读的是
      // 通用分支；保存写的却是用户填的分支（通常是 main）。两者永不相等，
      // 于是 `base` 恒为 null——「重开表单」看不到上一版内容，
      // 表面症状就是 completed / blockers 每次都被清空。
      // 第 37 轮追加边界：最近更新的分支未必是用户要编辑的那条。
      // 显式给 branchKey 就用它；没给才拿最近分支作默认值，并在回包里告诉客户端用的是哪条。
      const requestedBranch = text(body.branchKey, 120)
      const latestBranch =
        binding === null
          ? null
          : (db.get<{ branchKey: string }>(
              'SELECT branch_key AS branchKey FROM project_checkpoints ' +
                'WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1',
              [binding.projectId],
            ) ?? null)
      const effectiveBranch = requestedBranch !== '' ? requestedBranch : (latestBranch?.branchKey ?? '')
      const draftKey = newId('drf_')
      drafts.set(draftKey, { sessionId, fromSeq, toSeq, sourceIds, branchKey: effectiveBranch, createdAt: now })
      const checkpoint =
        binding !== null && project !== null && effectiveBranch !== ''
          ? readCheckpoint(db, { projectId: binding.projectId, branchKey: effectiveBranch })
          : null
      // 上一版真实用过的事项标识。客户端此前把它写死成 'u-017'，
      // 结果每次保存都把证据挂到一个跟本次工作无关的事项上。
      // 这里只作默认值回传，用户仍然可以改。
      const lastItemKey =
        checkpoint === null
          ? ''
          : (db.get<{ itemKey: string }>(
              'SELECT item_key AS itemKey FROM checkpoint_references ' +
                'WHERE checkpoint_id = ? AND revision = ? ORDER BY rowid DESC LIMIT 1',
              [checkpoint.checkpointId, checkpoint.headRevision],
            )?.itemKey ?? '')

      deps.sendJson(response, {
        ok: true,
        draftKey,
        bound: binding !== null,
        project: binding && project
          ? { projectId: binding.projectId, canonicalName: project.canonicalName, workspaceKey: project.workspaceKey }
          : null,
        branchKey: effectiveBranch,
        candidates: sources.map((row) => ({
          sourceId: row.sourceId,
          kind: row.kind,
          capturedAt: row.capturedAt,
          preview: (row.text ?? '').slice(0, 80),
        })),
        base: checkpoint
          ? {
              checkpointId: checkpoint.checkpointId,
              headRevision: checkpoint.headRevision,
              updatedAt: checkpoint.updatedAt,
              currentGoal: checkpoint.revision?.currentGoal ?? null,
              completed: checkpoint.revision?.completed ?? [],
              blockers: checkpoint.revision?.blockers ?? [],
              nextSteps: checkpoint.revision?.nextSteps ?? [],
              // 第 37 轮外部评审 P1（06）：此前客户端把事项标识写死成 'u-017'，
              // 于是每次保存都把证据挂到一个跟本次工作无关的事项上。
              // 这里回传上一版真实用过的事项标识，客户端只做默认值，用户可改。
              itemKey: lastItemKey,
            }
          : null,
        range: { fromSeq, toSeq },
        algorithmVersion: ALGORITHM_VERSION,
      })
    },
  }

  const save: HttpRoute = {
    kind: 'exact',
    path: '/api/psyche/project-handoff/save',
    async handler(request: HttpRequest, response: HttpResponse) {
      if (request.method !== 'POST') {
        deps.send(response, 405, { ok: false, code: 'E_METHOD', error: '只接受 POST' })
        return
      }
      await deps.ready
      const unavailable = deps.unavailable()
      const db = deps.db()
      if (unavailable !== null || db === null) {
        deps.send(response, 503, { ok: false, code: 'E_UNAVAILABLE', error: unavailable ?? '记忆引擎还没就绪' })
        return
      }
      const body = await deps.readJsonBody(request)
      const draftKey = text(body.draftKey, 120)
      const saveNow = Date.now()
      pruneDrafts(saveNow)
      const draft = drafts.get(draftKey)
      if (!draft) {
        deps.send(response, 409, { ok: false, code: 'E_STATE', error: '草稿已过期，请重新预览' })
        return
      }
      // 期间没有任何其他请求时，pruneDrafts 不会替这里判过期。
      // 保存是唯一的落库入口，TTL 必须在这里再确认一次。
      if (saveNow - draft.createdAt > DRAFT_TTL_MS) {
        drafts.delete(draftKey)
        deps.send(response, 409, { ok: false, code: 'E_STATE', error: '草稿已过期，请重新预览' })
        return
      }

      const canonicalName = text(body.canonicalName, 200)
      const workspaceKey = text(body.workspaceKey, 200)
      // 请求体没给分支时用预览时看到的那条：否则「预览 main、保存落到 feature」。
      const branchKey = text(body.branchKey, 120) || draft.branchKey
      const currentGoal = text(body.currentGoal, 2000)
      const completed = stringList(body.completed, 500)
      const blockers = stringList(body.blockers, 500)
      const nextSteps = stringList(body.nextSteps, 500)
      const itemKey = text(body.itemKey, 120) || 'manual'
      const expectedRevision = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
      const references: CheckpointReferenceInput[] = draft.sourceIds.map((sourceId) => ({ itemKey, sourceId }))

      // 正文与证据都空：没有可保存的东西，直接拒绝（避免造一条空修订）。
      const bodyJson = JSON.stringify({ goal: currentGoal, completed, blockers, nextSteps, itemKey })
      if (currentGoal === '' && completed.length === 0 && blockers.length === 0 && nextSteps.length === 0) {
        deps.send(response, 400, {
          ok: false,
          code: 'E_VALIDATION',
          error: '至少填一项内容再保存（目标 / 已完成 / 阻塞 / 下一步）',
        })
        return
      }
      // 同一 requestId 的重复提交必须给出同一份内容，否则拒绝——不能悄悄写第二条。
      const payloadHash = digestOf({ branchKey, currentGoal, completed, blockers, nextSteps, itemKey, sourceIds: draft.sourceIds })

      try {
        const projectId = text(body.projectId, 120)
        const resolvedProjectId = projectId !== ''
          ? projectId
          : (activeBinding(db, draft.sessionId)?.projectId ?? newId('prj_'))

        if (projectId === '') {
          ensureProject(db, {
            projectId: resolvedProjectId,
            canonicalName: canonicalName !== '' ? canonicalName : '未命名项目',
            workspaceKey: workspaceKey !== '' ? workspaceKey : null,
          })
        }

        const binding = activeBinding(db, draft.sessionId) ?? bindSession(db, {
          bindingId: newId('bdg_'),
          projectId: resolvedProjectId,
          platform: PLATFORM,
          sessionRef: draft.sessionId,
          // G1-A 手动保存不校验授权代次；接 Host 权限模型时换成真实 generation。
          grantGeneration: 'manual',
        })

        const result = saveCheckpoint(db, {
          projectId: resolvedProjectId,
          branchKey,
          bindingId: binding.bindingId,
          // 手动任务：唯一性按 requestId，区间只记水位位置，不推进水位。
          mode: 'manual',
          requestId: draftKey,
          payloadHash,
          fromSeq: draft.fromSeq,
          toSeq: draft.toSeq,
          algorithmVersion: ALGORITHM_VERSION,
          digest: {
            bodyJson,
            sourceIds: draft.sourceIds,
          },
          revision: {
            currentGoal: currentGoal !== '' ? currentGoal : null,
            completed,
            blockers,
            nextSteps,
            confidence: 'medium',
            generator: ALGORITHM_VERSION,
          },
          references,
          expectedRevision,
        })

        // 成功一次就把草稿销掉：重复提交同一 draftKey 会退化成 409，而不是无提示重放。
        // 双击场景里客户端两次请求共用一个 draftKey，第一次成功后若立刻删除，
        // 第二次会拿到 E_STATE 而不是原结果，因此这里**不删**，只保留到 TTL。
        deps.sendJson(response, {
          ok: true,
          saved: result.saved,
          replayed: result.replayed,
          noChange: result.noChange,
          projectId: resolvedProjectId,
          bindingId: binding.bindingId,
          jobId: result.jobId,
          digestId: result.digestId,
          checkpointId: result.checkpointId,
          revision: result.revision,
          committedToSeq: result.committedToSeq,
        })
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        const message = error instanceof Error ? error.message : String(error)
        const status = errorStatus(typeof code === 'string' ? code : null)
        if (status >= 500) {
          deps.logger.warn?.('[psyche] 保存开发进度失败', { code: String(code ?? 'unknown'), message })
        }
        deps.send(response, status, {
          ok: false,
          code: typeof code === 'string' ? code : 'E_INTERNAL',
          error: message,
        })
      }
    },
  }

  const read: HttpRoute = {
    kind: 'exact',
    path: '/api/psyche/project-handoff',
    async handler(request: HttpRequest, response: HttpResponse) {
      if (request.method !== 'GET') {
        deps.send(response, 405, { ok: false, code: 'E_METHOD', error: '只接受 GET' })
        return
      }
      await deps.ready
      const unavailable = deps.unavailable()
      const db = deps.db()
      if (unavailable !== null || db === null) {
        deps.send(response, 503, { ok: false, code: 'E_UNAVAILABLE', error: unavailable ?? '记忆引擎还没就绪' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      // 读路由也过一遍清理：它是频率最高的一条（面板每次刷新都会打），
      // 让它顺带回收过期草稿，比另起定时器便宜。
      pruneDrafts(Date.now())
      const checkpointId = text(url.searchParams.get('checkpointId'), 120)
      const revisionRaw = url.searchParams.get('revision')
      const sessionId = text(url.searchParams.get('sessionId'), 200)
      const branchKey = text(url.searchParams.get('branchKey'), 120)

      // 定点读取优先：验收要求「重启后按原 Checkpoint ID 和 revision 读回」。
      if (checkpointId !== '') {
        const revision = Number(revisionRaw)
        if (!Number.isInteger(revision) || revision < 1) {
          deps.send(response, 400, { ok: false, code: 'E_VALIDATION', error: 'revision 必须是 >= 1 的整数' })
          return
        }
        const view = readCheckpointRevision(db, { checkpointId, revision })
        if (!view) {
          deps.send(response, 404, { ok: false, code: 'E_NOT_FOUND', error: '找不到该修订' })
          return
        }
        deps.sendJson(response, { ok: true, view })
        return
      }

      const binding = sessionId !== '' ? activeBinding(db, sessionId) : null
      if (!binding) {
        deps.sendJson(response, { ok: true, bound: false, view: null })
        return
      }
      const view = readCheckpoint(db, { projectId: binding.projectId, branchKey })
      deps.sendJson(response, { ok: true, bound: true, projectId: binding.projectId, view })
    },
  }

  return [preview, save, read]
}
