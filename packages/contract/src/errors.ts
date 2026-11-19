/**
 * 错误码（D1-1 冻结：与内核 `src/lib/errors.ts` 的 CODE 一一对齐，共 24 个）。
 * 命名规则：`E_` + 大写下划线；新增一律追加，不复用旧含义。
 *
 * 早期骨架期用过 7 个名字（E_NOT_READY / E_PERSONA_NOT_READY /
 * E_DRIVER_UNAVAILABLE / E_OPERATION_CONFLICT / E_SCOPE_DENIED /
 * E_CONFLICT / E_UNKNOWN），不算正式码：`toPsycheError()` 会把它们
 * 映射到下面的正式码，旧调用方不需要改。
 */
export const PSYCHE_ERROR_CODES = [
  /** 对象不存在。 */
  'E_NOT_FOUND',
  /** 结论没有任何来源，不能落库（防自证）。 */
  'E_NO_SOURCE',
  /** 用自己说的话证明自己：认知事件必须有一条非自身来源。 */
  'E_SELF_PROOF',
  /** 证据数量/独立证据数没到门槛。 */
  'E_THRESHOLD',
  /** 状态机不允许这个转移。 */
  'E_STATE',
  /** 分区越权（life / relationship / safety / growth）。 */
  'E_PARTITION',
  /** 跨人格/跨联系人违反 scope 规则。 */
  'E_SCOPE',
  /** 数据库层错误。 */
  'E_DB',
  /** 数据库文件损坏。 */
  'E_DB_CORRUPT',
  /** 同 opId 换参数重放：这不是重试，是冲突。 */
  'E_IDEMPOTENT_CONFLICT',
  /** 请求体不合法（缺字段、越界、类型不对）。 */
  'E_VALIDATION',
  /** 文本为空/超长/含禁写内容。 */
  'E_TEXT',
  /** 宿主或驱动不支持该能力。 */
  'E_UNSUPPORTED',
  /** 未分类内部错误。 */
  'E_INTERNAL',
  /** 正在等待重启应用恢复，拒绝一切新写入。 */
  'E_RESTORE_PENDING',
  /** DSH 未退出 / 库被占用，恢复不能开始。 */
  'E_RESTORE_BUSY',
  /** 恢复现场不明确，只报告不动目录。 */
  'E_RESTORE_RECOVERY_REQUIRED',
  /** 迁移包超出资源上限（按解压炸弹处理）。 */
  'E_ARCHIVE_LIMIT',
  /** 人格预设 id 不在白名单。 */
  'E_PRESET_UNKNOWN',
  /** 内置预设自身校验不过。 */
  'E_PRESET_INVALID',
  /** 人格基底已锁定：不能再初始化、不能换预设。 */
  'E_INIT_LOCKED',
  /** 另一个写入者正持有初始化 claim。 */
  'E_INIT_RACE',
  /** 当前初始化状态不允许这个动作。 */
  'E_INIT_STATE',
  /** 半成品与 claim 里的待确认哈希不符。 */
  'E_INIT_INCOMPLETE',
] as const

export type PsycheErrorCode = (typeof PSYCHE_ERROR_CODES)[number]

/** 骨架期旧名 → 正式码；只做读取兼容，不再新增。 */
export const PSYCHE_ERROR_ALIASES: Readonly<Record<string, PsycheErrorCode>> = {
  E_NOT_READY: 'E_STATE',
  E_PERSONA_NOT_READY: 'E_INIT_STATE',
  E_DRIVER_UNAVAILABLE: 'E_UNSUPPORTED',
  E_OPERATION_CONFLICT: 'E_IDEMPOTENT_CONFLICT',
  E_SCOPE_DENIED: 'E_SCOPE',
  E_CONFLICT: 'E_DB',
  E_UNKNOWN: 'E_INTERNAL',
}

export interface PsycheError {
  code: PsycheErrorCode
  /** 给人看的一句话；通道可以直接展示，不含密钥与路径。 */
  message: string
  /** 排障用的结构化补充；不要把整段对话正文塞进来。 */
  detail?: Record<string, unknown>
}

function normalizeCode(value: unknown, fallback: PsycheErrorCode): PsycheErrorCode {
  if (typeof value !== 'string') return fallback
  if ((PSYCHE_ERROR_CODES as readonly string[]).includes(value)) return value as PsycheErrorCode
  return PSYCHE_ERROR_ALIASES[value] ?? fallback
}

/** 把任意 catch 到的东西收成契约错误。 */
export function toPsycheError(error: unknown, fallback: PsycheErrorCode = 'E_INTERNAL'): PsycheError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const candidate = error as { code: unknown; message: unknown }
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return { code: normalizeCode(candidate.code, fallback), message: candidate.message }
    }
  }
  return { code: fallback, message: error instanceof Error ? error.message : String(error) }
}
