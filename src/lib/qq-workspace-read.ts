// 读一次宿主的 `workspace/follow` baseline。
//
// 这里唯一的重点是把两种「没有工作区」分开：
// - 成功读到一帧有效 baseline，items 是空数组 → 返回 `[]`。首次安装的宿主本来就可能
//   一个工作区都没有，这是**合法状态**，调用方可以据此去创建工作区。
// - follow 不可用、超时、抛错、流在 baseline 之前就结束 → 返回 `null`。这是**读取失败**，
//   调用方不得据此推断「工作区不存在」，更不该去 `workspace/create`。
//
// 混同这两种情况的代价是：首次安装时工作区永远建不出来（空清单被当成失败），
// 或者读取抖动时反复创建重复工作区（失败被当成空清单）。

export interface WorkspaceListItem {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
}

export interface WorkspaceBaselineFrame {
  type: string
  value?: { items?: WorkspaceListItem[] }
}

export type WorkspaceFollow = (signal: AbortSignal) => AsyncIterable<WorkspaceBaselineFrame>

export interface ReadWorkspaceBaselineOptions {
  /** 读不到 baseline 就断开的时间上限；调用方按自己的耐心传（工作区卡是 800ms）。 */
  timeoutMs?: number
  /** 只用于记日志：任何异常都被吞成 `null`，不向上抛。 */
  onError?: (error: unknown) => void
}

export async function readWorkspaceBaseline(
  follow: WorkspaceFollow | undefined,
  options: ReadWorkspaceBaselineOptions = {},
): Promise<WorkspaceListItem[] | null> {
  if (typeof follow !== 'function') return null
  const timeoutMs = options.timeoutMs ?? 800
  const controller = new AbortController()
  const consume = (async (): Promise<WorkspaceListItem[] | null> => {
    for await (const frame of follow(controller.signal)) {
      if (frame.type === 'baseline' || frame.type === 'replace') {
        const items = frame.value?.items
        // 帧到了但 items 形状不对也按「读不到」处理，不拿半个对象去比对路径。
        return Array.isArray(items) ? items : null
      }
    }
    // 流先结束了：没有 baseline，等于没读到。
    return null
  })().catch((error: unknown) => {
    options.onError?.(error)
    return null
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      // 先 abort 再返回：宿主若遵守 signal 会立刻收尾；不遵守也不影响我们按时交差。
      controller.abort()
      resolve(null)
    }, timeoutMs)
  })
  try {
    return await Promise.race([consume, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
  }
}
