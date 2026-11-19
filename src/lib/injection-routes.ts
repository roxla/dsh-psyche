// C2-C：本轮「记忆上下文」的只读回执接口。
//
// 用途：客户端 turnTail 标签展开时，按「会话 + 轮次」读回本轮 pre-step 注入的
// 实际内容。只读，不写任何东西。
//
// 边界（本文件最重要的约束）：
//   - 只接受 session + turn 两个参数，按它们查 query_mode='pre-step' 的回执；
//     不接受 runId 参数——回执里有受限 Artifact 的 id 与拒绝原因，
//     能按 runId 任意读就等于开了诊断口子。
//   - 只返回 composition_status='completed' 且 returned_count>0 且 abstained=0
//     的回执；pending/interrupted/failed/abstained 一律 found:false。
//   - 条目只取 recall_candidates 里 selected=1 AND composed=1 的行（真正写进
//     注入文本的那些），再回库读当前 head；head 已变、已非 public、已非
//     active/challenged 的条目不返回（披露/状态在注入后可能变化）。
//   - 不返回 rejectReason、rawRank、queryHash、scope、原文 Source 等内部字段。
//   - 历史无回执（旧会话）返回 found:false，不补造数量。
import type { HttpRequest, HttpRoute, HttpResponse } from '@deepseek-ai/cordis'
import type { Db } from 'dsh-psyche-core'
import { findPreStepRun, listRecallCandidates } from 'dsh-psyche-core'

/** 单条展示项：只放 UI 需要的字段。 */
export interface InjectionItem {
  artifactId: string
  kind: string
  revision: number
  statement: string
  state: 'active' | 'challenged'
  statusNote: string | null
  confidence: number | null
  supportEvidenceCount: number
}

export interface InjectionView {
  runId: string
  turn: number
  returnedCount: number
  items: InjectionItem[]
}

export interface InjectionRouteDeps {
  ready: Promise<unknown>
  db: () => Db | null
  unavailable: () => string | null
  send: (response: HttpResponse, statusCode: number, body: unknown) => void
  sendJson: (response: HttpResponse, body: unknown) => void
  logger: { warn?: (message: string) => void }
}

const MAX_ITEMS = 8
const STATUS_NOTE = '该观点存在争议，不能作为确定事实'

function queryOf(request: HttpRequest): URLSearchParams {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/** 读 head 且仍可展示时返回展示项；否则返回 null。 */
function readItem(db: Db, artifactId: string, revision: number): InjectionItem | null {
  const head = db.get(
    'SELECT MAX(revision) AS revision FROM artifact_revisions WHERE artifact_id = ?',
    [artifactId],
  )
  if (head === undefined || Number(head.revision) !== revision) return null
  const row = db.get(
    `SELECT a.kind AS kind, r.revision AS revision, r.statement AS statement, r.state AS state,
            r.disclosure AS disclosure, r.confidence AS confidence,
            r.independent_evidence_count AS evidence
       FROM artifact_revisions r
       JOIN artifacts a ON a.artifact_id = r.artifact_id
      WHERE r.artifact_id = ? AND r.revision = ?`,
    [artifactId, revision],
  )
  if (row === undefined) return null
  if (String(row.disclosure) !== 'public') return null
  const state = String(row.state)
  if (state !== 'active' && state !== 'challenged') return null
  return {
    artifactId,
    kind: String(row.kind),
    revision: Number(row.revision),
    statement: String(row.statement),
    state: state as 'active' | 'challenged',
    statusNote: state === 'challenged' ? STATUS_NOTE : null,
    confidence: row.confidence === null ? null : Number(row.confidence),
    supportEvidenceCount: Number(row.evidence ?? 0),
  }
}

/** 构建一条只读路由：GET /api/psyche/injection?session=<ref>&turn=<n>。 */
export function buildInjectionRoutes(deps: InjectionRouteDeps): HttpRoute[] {
  return [
    {
      kind: 'exact',
      path: '/api/psyche/injection',
      handler: async (request, response) => {
        if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
          deps.send(response, 405, { ok: false, error: '只接受 GET' })
          return
        }
        await deps.ready
        const db = deps.db()
        if (db === null) {
          deps.send(response, 503, { ok: false, error: deps.unavailable() ?? '心灵还没准备好' })
          return
        }
        const params = queryOf(request)
        const session = (params.get('session') ?? '').trim()
        const turnText = (params.get('turn') ?? '').trim()
        const turn = Number(turnText)
        if (!session || turnText === '' || !Number.isInteger(turn) || turn < 0) {
          deps.send(response, 400, { ok: false, error: '需要 session 与合法的 turn' })
          return
        }

        const run = findPreStepRun(db, session, turn)
        if (run === null || run.compositionStatus !== 'completed' || run.abstained || run.returnedCount <= 0) {
          deps.sendJson(response, { ok: true, found: false })
          return
        }

        const items: InjectionItem[] = []
        for (const candidate of listRecallCandidates(db, run.runId)) {
          if (!candidate.selected || !candidate.composed) continue
          const item = readItem(db, candidate.artifactId, candidate.revision)
          if (item !== null) items.push(item)
          if (items.length >= MAX_ITEMS) break
        }
        if (items.length === 0) {
          deps.sendJson(response, { ok: true, found: false })
          return
        }
        const view: InjectionView = {
          runId: run.runId,
          turn,
          returnedCount: run.returnedCount,
          items,
        }
        deps.sendJson(response, { ok: true, found: true, injection: view })
      },
    },
  ]
}
