// 心灵错误：稳定的错误码给工具层与通道插件判分支，message 给人看（纯数据，零 IO）。
// 被谁调用：tools.ts / panel.ts / store.ts / adapter.ts / index.ts——凡是可能失败的地方都抛它。
// 关键不变量：错误码是**契约**，只增不改（外部按字符串比对）；message 可以随时改；
// 交回宿主的 detail 必须先过 `jsonSafe`，否则「无损 JSON」校验会直接判失败。
/** 稳定错误码：工具层与通道插件按它判分支，message 只给人看。 */
export const CODE = Object.freeze({
  validation: 'E_VALIDATION',
  notFound: 'E_NOT_FOUND',
  noSource: 'E_NO_SOURCE',
  selfProof: 'E_SELF_PROOF',
  threshold: 'E_THRESHOLD',
  state: 'E_STATE',
  partition: 'E_PARTITION',
  scope: 'E_SCOPE',
  db: 'E_DB',
  dbCorrupt: 'E_DB_CORRUPT',
  idempotent: 'E_IDEMPOTENT_CONFLICT',
  text: 'E_TEXT',
  unsupported: 'E_UNSUPPORTED',
  internal: 'E_INTERNAL',
  /** 正在等待重启应用恢复：这期间拒绝一切新的记忆写入（§34.14 提交前冻结）。 */
  restorePending: 'E_RESTORE_PENDING',
  /** DSH 未退出 / 库或目录被占用：恢复不能开始。 */
  restoreBusy: 'E_RESTORE_BUSY',
  /** 恢复现场（多个候选目录）不明确：只报告，不动任何目录。 */
  restoreRecovery: 'E_RESTORE_RECOVERY_REQUIRED',
  /** 迁移包超出资源上限（单文件/总解压量/成员数/压缩包本身）：按解压炸弹处理，整包拒绝。 */
  archiveLimit: 'E_ARCHIVE_LIMIT',
  /** 人格预设 id 不在内置白名单（§39.2）：调用方传错，可纠正。 */
  presetUnknown: 'E_PRESET_UNKNOWN',
  /** 内置预设自身校验不过（缺字段/草案未标记/core 覆盖…）：安装包坏了，只能重装。 */
  presetInvalid: 'E_PRESET_INVALID',
  /** 人格基底已锁定：不能再初始化、不能换预设（§39.5）。 */
  initLocked: 'E_INIT_LOCKED',
  /** 另一个写入者正持有初始化 claim（§39.5.1）：同一数据根只允许一个赢家。 */
  initRace: 'E_INIT_RACE',
  /** 当前初始化状态不允许这个动作（如 damaged 上初始化、drift 上 finish）。 */
  initState: 'E_INIT_STATE',
  /** 半成品与 claim 里的待确认哈希不符：finish 不能替它收尾。 */
  initIncomplete: 'E_INIT_INCOMPLETE',
  /**
   * 同一条外部身份（platform + session_ref + capture_key）被重复投递、但内容不一致：
   * 原 Source 不覆盖、不新建，把冲突交给调用方处理（§P2-CAP-1a）。
   */
  captureConflict: 'E_CAPTURE_CONFLICT',
  /**
   * 乐观并发检查失败：调用方以为改的是 r3，实际当前 head 已经不是 r3。
   * 另一个写入者先提交了，这次改口不能悄悄盖掉对方（§E3 并发 revise）。
   */
  revisionConflict: 'E_REVISION_CONFLICT',
  /**
   * 查询文本超过上限：不静默截断——截断可能切掉否定词/实体名，
   * 返回一份「看起来正常、其实不是你要的」结果（§E3 查询语义补强）。
   */
  queryTooLong: 'E_QUERY_TOO_LONG',
  /**
   * 查询片段太多：每个单字片段都会展开成一个 LIKE 条件，片段数失控会让 SQL 膨胀、
   * 查询计划退化。宁可明确拒绝，也不拼一条「看起来能跑」的超长语句（§E3 查询语义补强）。
   */
  queryTooComplex: 'E_QUERY_TOO_COMPLEX',
  /**
   * 最终请求完整性检查失败：Psyche 登记的注入块被篡改、越权或其中一条记忆
   * 在注入之后不再是当前 head / 不再是 public。**必须拒绝这次模型调用**，
   * 不能删掉问题消息后继续（§E5.5-D）。
   */
  finalCheck: 'E_FINAL_CHECK',
  /**
   * FTS 映射与索引不一致：`fts_rowids` 指向的 rowid 在 `fts_index` 里找不到同 kind/ref_id 的行，
   * 或映射行本身与索引行对不上。**不允许静默跳过**——继续按错误映射删除就会删错别人的记忆；
   * 明确失败，交给 `verifyFtsIndex` 报告 + `rebuildFtsIndex` 重建（§E6-C1 维护回归）。
   */
  ftsMapping: 'E_FTS_MAPPING',
} as const)

/** 30 个错误码的联合类型（从 `CODE` 推导，别手写，否则两边会漂）。 */
export type ErrorCode = (typeof CODE)[keyof typeof CODE]

/**
 * 带稳定错误码的异常。
 *
 * 参数：`code` 见 `CODE`；`message` 给人读的一句话；`detail` 可选的结构化补充（调用方负责先清洗）。
 * 行为：`name` 固定为 `PsycheError`，便于宿主日志里一眼看出是插件抛的。
 * 注意：`detail` 只在非 undefined 时才挂上去，避免留下 `detail: undefined` 这种键。
 */
export class PsycheError extends Error {
  readonly code: ErrorCode
  readonly detail?: unknown

  constructor(code: ErrorCode, message: string, detail?: unknown) {
    super(message)
    this.name = 'PsycheError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

/**
 * 工具返回值里表示「这次没做成」的形状（宿主校验的是无损 JSON）。
 *
 * `ok: false` 是判别位；`code` 给程序，`error` 给人，`detail` / `stack` 只在有值时出现。
 */
export interface ErrorPayload {
  ok: false
  code: ErrorCode
  error: string
  detail?: unknown
  stack?: string
}

/**
 * 造一个「参数不合法」错误（最常用的一条）。
 *
 * 参数：`message` 给人看的原因；`detail` 可选补充（如哪个字段错了）。
 * 返回：`PsycheError`（code = `E_VALIDATION`），由调用方 throw。
 */
export function invalid(message: string, detail?: unknown): PsycheError {
  return new PsycheError(CODE.validation, message, detail)
}

/** 清洗后能安全 JSON 序列化的值（不含 undefined / 函数 / 循环引用）。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * 宿主按「无损 JSON」校验工具返回值：undefined 键、NaN、Date、BigInt、函数都会直接判失败。
 * 这里做一次深拷贝清洗，保证 execute() 交出去的一定是干净 JSON。
 *
 * 参数 `value`：任意 JS 值。返回：干净的 `JsonValue`，或 `undefined`（表示「这个键整个丢掉」）。
 * 逐类规则：
 * - 非有限数（NaN / ±Infinity）→ `null`（JSON 里没有它们的位置）；
 * - BigInt → 十进制字符串（丢了类型，但至少不炸；金额/ID 通常本来就是字符串）；
 * - `Date` → ISO 串（无效日期 → null）；
 * - undefined / 函数 / symbol → `undefined`（对象里丢键，数组里变 null）；
 * - 数组空洞由 `map` 跳过、返回 undefined，这里统一补成 null，保证长度不变。
 */
export function jsonSafe(value: unknown): JsonValue | undefined {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value as string | boolean
  if (type === 'number') return Number.isFinite(value as number) ? (value as number) : null
  if (type === 'bigint') return (value as bigint).toString()
  if (type === 'function' || type === 'symbol' || type === 'undefined') return undefined
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (Array.isArray(value)) {
    return value.map((item) => {
      const cleaned = jsonSafe(item)
      // 数组里不能丢元素（否则下标错位），undefined 一律补成 null。
      return cleaned === undefined ? null : cleaned
    })
  }
  const out: { [key: string]: JsonValue } = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const cleaned = jsonSafe(item)
    // 对象里则相反：清洗成 undefined 的键整个不写进结果。
    if (cleaned !== undefined) out[key] = cleaned
  }
  return out
}

/**
 * 任意异常 → 可交给宿主的错误载荷。
 *
 * 参数 `error`：`PsycheError`、普通 `Error`、或任何被 throw 出来的值。
 * 返回：`ErrorPayload`。边界：
 * - `PsycheError` 保留原 code，不带 stack（预期内的失败，栈没有诊断价值）；
 * - 其他异常统一成 `E_INTERNAL`，并带上 stack（真正要排查的东西）；
 * - 非 Error 的 throw（字符串/对象）用 `String()` 兜成 message。
 */
export function toErrorPayload(error: unknown): ErrorPayload {
  // 只写有值的字段：宿主按「无损 JSON」校验工具返回值，undefined 键会直接判失败。
  if (error instanceof PsycheError) {
    const payload: ErrorPayload = { ok: false, code: error.code, error: error.message }
    if (error.detail !== undefined) payload.detail = error.detail
    return payload
  }
  const message = error instanceof Error ? error.message : String(error)
  const payload: ErrorPayload = { ok: false, code: CODE.internal, error: message }
  if (error instanceof Error && error.stack) payload.stack = String(error.stack)
  return payload
}
