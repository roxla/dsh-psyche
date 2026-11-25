/**
 * 把一条 QQ 会话挂进「QQ 聊天」工作区的唯一正确入口。
 *
 * 宿主有两条「把会话放进工作区」的路，语义完全不同（源码依据见
 * `D:\Program Files\DeepSeek Harness\resources\app.asar` 的 workspace 实现）：
 *
 * - `Workspace.attachSession(sessionId)`：会话**不在账目**时，读它的 header cwd、
 *   realpath 归一、要求目录存在且等于工作区路径，通过后加入成员。这是唯一能把
 *   「账外会话」补挂进去的入口——桥接自己造的会话、旧版本留下的会话都走这条。
 * - `workspace/insertSessionBefore`：只调整已登记会话的顺序，会话不在账上直接抛
 *   `the session is not accounted`。它**不能**当补挂失败后的兜底。
 * - `session/create` 带 workspaceId + sessionId 只对**新**会话有效：id 已存在时
 *   宿主抛 `session "<id>" already exists`，同样不能当兜底。
 *
 * 所以顺序是：先 attach（幂等，已登记时是空操作），再按需排序。
 */

/** 工作区实体里本模块用得到的那一小块（宿主 `Workspace` 接口的子集）。 */
export interface QqWorkspaceEntityLike {
  path?: string
  attachSession?: (sessionId: string) => Promise<void>
}

export interface QqWorkspaceAttachInput {
  /** 已经确定的工作区 id；为 null 说明工作区还没建出来。 */
  workspaceId: string | null
  sessionId: string
  /** 解析目标工作区的目录（生产实现是 `workspaceRegistry.resolveByPath`）。 */
  resolveWorkspace?: (path: string) => Promise<QqWorkspaceEntityLike | undefined>
  /** 可选的排序接口；只在会话已登记时才有意义。 */
  insertSessionBefore?: (request: { workspaceId: string; sessionId: string }) => Promise<unknown>
  /** 目标工作区目录，用来解析工作区实体。 */
  cwd: string
}

export type QqWorkspaceAttachStage = 'workspace' | 'registry' | 'attach' | 'order'

export type QqWorkspaceAttachResult =
  | { status: 'attached'; ordered: boolean }
  | { status: 'failed'; stage: QqWorkspaceAttachStage; error: string }

/**
 * 补挂一条会话，返回落到哪一步。
 *
 * 排序失败不算补挂失败：会话已经在成员里，顺序不对只是显示顺序的问题，
 * 不阻塞投递。这个区别要如实反映在返回值里（`ordered: false`）。
 */
export async function attachQqSessionToWorkspace(
  input: QqWorkspaceAttachInput,
): Promise<QqWorkspaceAttachResult> {
  if (input.workspaceId === null) {
    return { status: 'failed', stage: 'workspace', error: '宿主里还没有 QQ 工作区' }
  }
  if (input.resolveWorkspace === undefined) {
    return { status: 'failed', stage: 'registry', error: '宿主没有提供 workspaceRegistry.resolveByPath' }
  }
  let entity: QqWorkspaceEntityLike | undefined
  try {
    entity = await input.resolveWorkspace(input.cwd)
  } catch (error) {
    return { status: 'failed', stage: 'registry', error: `解析工作区失败：${String(error)}` }
  }
  if (entity === undefined) {
    return { status: 'failed', stage: 'registry', error: `宿主里找不到路径为 ${input.cwd} 的工作区` }
  }
  if (entity.attachSession === undefined) {
    return { status: 'failed', stage: 'attach', error: '工作区实体没有 attachSession，无法补挂账外会话' }
  }
  try {
    await entity.attachSession(input.sessionId)
  } catch (error) {
    // 常见原因：会话 header 的 cwd 与工作区路径不一致（历史会话建在别的目录）。
    // 这时不要退到 insertSessionBefore——它只会以 not-accounted 再失败一次。
    return { status: 'failed', stage: 'attach', error: String(error) }
  }
  if (input.insertSessionBefore === undefined) return { status: 'attached', ordered: false }
  try {
    await input.insertSessionBefore({ workspaceId: input.workspaceId, sessionId: input.sessionId })
    return { status: 'attached', ordered: true }
  } catch {
    return { status: 'attached', ordered: false }
  }
}
