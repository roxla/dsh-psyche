// HTTP 出口 DTO：管理接口返回给浏览器的字段在这里**显式挑选与脱敏**。
//
// 背景（P4-A-4/P4-A-5 安全核查）：`/api/psyche/*` 由 DSH Host 直接暴露，
// 插件内部对象里的绝对路径、异常栈、完整 stableUserId 不该原样出网。
// 这里不做「黑名单清洗整个对象」，而是：
//   - 状态/面板：按显式字段构造视图（paths → basename、storage.file 丢弃、联系人 ID 掩码）；
//   - 500：只回稳定错误码 + 普通说明，详细异常只进服务端日志。
//
// 注意：这里只负责 HTTP 出口；工具返回值仍走 `toErrorPayload`，两者不要混用。

import type { DbHealth } from 'dsh-psyche-core'
import type { ErrorPayload } from './errors.js'
import { PsycheError } from './errors.js'
import type { PanelPayload, ContactRow } from './panel.js'
import { maskQqId } from './qq-admin.js'

/** 500 的统一响应体：稳定 code + 普通说明（不含 detail/stack/路径）。 */
export interface HttpErrorBody {
  ok: false
  error: { code: string; message: string }
}

/** 非预期异常的固定说明（内部细节只写日志）。 */
export const HTTP_GENERIC_ERROR_MESSAGE = '服务暂时不可用'

/** Windows 盘符路径 / UNC / 常见 POSIX 绝对路径 → `<path>`。 */
export function redactAbsolutePaths(text: string): string {
  return String(text ?? '')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>|]*/g, '<path>')
    .replace(/\\\\[^\s"'<>|]+/g, '<path>')
    .replace(/\/(?:home|Users|tmp|var|etc|opt)\/[^\s"'<>|]*/g, '<path>')
}

/** 绝对路径的末段（只用于展示，如 `...\.tmp-p4a4-data` → `.tmp-p4a4-data`）。 */
export function pathLabel(value: string): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const parts = raw.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : raw
}

/** 对外展示的稳定用户 ID：保留可辨认前缀，中间掩码。 */
export function maskStableUserId(value: string): string {
  return maskQqId(value) ?? ''
}

/** 任意异常 → 500 响应体。已知 PsycheError 保留 code，其余统一 INTERNAL_ERROR。 */
export function httpErrorBody(error: unknown): HttpErrorBody {
  if (error instanceof PsycheError) {
    return {
      ok: false,
      error: { code: error.code, message: redactAbsolutePaths(error.message) },
    }
  }
  return {
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: HTTP_GENERIC_ERROR_MESSAGE },
  }
}

/** 面板/状态里出现的错误载荷：去掉 stack/detail，路径打码。 */
export function safeErrorPayload(error: ErrorPayload | null): ErrorPayload | null {
  if (!error) return null
  return {
    ok: false,
    code: error.code,
    error: redactAbsolutePaths(error.error),
  }
}

/** 数据库健康视图：丢弃 `file`（绝对路径），其余数值原样保留。 */
export type StorageView = Omit<DbHealth, 'file'>

export function storageView(health: DbHealth | null): StorageView | null {
  if (!health) return null
  const { file: _file, ...rest } = health
  return rest
}

/** 面板视图里的联系人：不返回平台原始身份标识。 */
export type PanelContactView = Omit<ContactRow, 'stableUserId'>

/** 面板视图类型：除 storage 少一个 file、contacts 少一个 stableUserId 外侧边与 PanelPayload 一致。 */
export type PanelView = Omit<PanelPayload, 'storage' | 'dataDir' | 'contacts'> & {
  storage: StorageView | null
  contacts: PanelContactView[]
}

/**
 * 异常文本一律换成受控文案：不返回原始异常首行。
 * 原始细节只进脱敏日志，不进面板/状态响应。
 */
function controlledErrorText(value: string | null | undefined, fallback: string): string {
  return value && value.trim().length > 0 ? fallback : ''
}

/** 递归清洗：剔除路径/平台身份字段，并对字符串做绝对路径脱敏。 */
function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactAbsolutePaths(value)
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'dataDir' || key === 'stableUserId') continue
      out[key] = scrubDeep(child)
    }
    return out
  }
  return value
}

/** 状态接口视图：去掉绝对路径与异常栈，attempts.reason 打码。 */
export function toStatusView(input: {
  ok: boolean
  enabled: boolean
  driver: string | null
  dataDir: string
  startedAt: string
  selfCheck: unknown
  attempts: { driver: string; ok: boolean; stage: string; reason: string }[]
  error: ErrorPayload | null
  storage: DbHealth | null
  personaInit: unknown
  behavior: unknown
}): Record<string, unknown> {
  return scrubDeep({
    ok: input.ok,
    enabled: input.enabled,
    driver: input.driver,
    startedAt: input.startedAt,
    selfCheck: input.selfCheck,
    attempts: input.attempts.map((attempt) => ({
      driver: attempt.driver,
      ok: attempt.ok,
      stage: attempt.stage,
      reason: controlledErrorText(attempt.reason, '尝试失败'),
    })),
    error: safeErrorPayload(input.error),
    storage: storageView(input.storage),
    personaInit: input.personaInit,
    behavior: input.behavior,
  }) as Record<string, unknown>
}

/** 设置项里的字符串值若像绝对路径，只留末段。 */
function safeSettingValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\/(?:home|Users|tmp|var|etc|opt)\//.test(value)) {
    return pathLabel(value)
  }
  return value
}

/**
 * 面板接口视图：**显式 allowlist**。
 * 联系人只给掩码 ID；设置值里的路径只留末段；storage 去 file；error 去 stack。
 */
export function toPanelView(payload: PanelPayload): PanelView {
  const view = {
    ...payload,
    storage: storageView(payload.storage),
    error: safeErrorPayload(payload.error),
    contacts: (payload.contacts ?? []).map((contact) => {
      const { stableUserId: _stableUserId, ...rest } = contact
      return rest
    }),
    settings: (payload.settings ?? []).map((group) => ({
      ...group,
      fields: (group.fields ?? []).map((field) => ({
        ...field,
        value: safeSettingValue(field.value),
      })),
    })),
    attempts: (payload.attempts ?? []).map((attempt) => ({
      ...attempt,
      reason: controlledErrorText(attempt.reason, '尝试失败'),
    })),
    personaInitError: controlledErrorText(payload.personaInitError, '初始化失败'),
  }
  return scrubDeep(view) as PanelView
}
