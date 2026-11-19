// C 阶段：三个记忆功能的默认策略与「生效状态」的唯一计算点。
//
// 为什么单独一个模块：状态页、面板聚合、启动审计、测试都要回答同一个问题
// 「capture / injection / finalCheck 现在到底是不是开着」，四处各写一遍迟早会漂移；
// 尤其是 finalCheck——它被冻结成强制开启，任何一处按配置判断都会重新打开「可关闭」的口子。
//
// 三个功能的边界（写进代码注释，方便以后回看）：
// - capture：只决定「要不要把会话消息落成 Source」。落成 Source ≠ 自动形成结论。
// - injection：只决定「要不要在 pre-step 把候选写进上下文」。仍受 Scope / 披露 / 预算约束。
// - finalCheck：注入链路的 fail-closed 检查，**不可关闭**，且已从配置 Schema 中移除；
//   旧配置里留下 finalCheck.enabled 只作为迁移提示，无论 true/false 都不再是有效配置。

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 与入口配置的子集兼容；只读这些字段，不依赖完整 PsycheConfig。
 * finalCheck 仅用于识别旧配置，不是有效配置项。
 */
export interface BehaviorConfig {
  capture?: { enabled?: unknown }
  injection?: { enabled?: unknown }
  /** @deprecated 已从有效配置中移除，这里只为识别旧 profile 并提示迁移。 */
  finalCheck?: unknown
}

export interface BehaviorState {
  capture: boolean
  injection: boolean
  /** 恒为 true：类型上就是字面量，防止下游把它当可配置项。 */
  finalCheck: true
  /** 配置唯一可写入口：宿主插件设置页（Psyche 不提供第二套配置源）。 */
  source: 'host-settings'
  /** 已废弃字段的迁移提示（旧配置迁移用）。 */
  legacy: string[]
  /** 非法值告警（非法值不静默转成放行/关闭，按默认值处理并告警）。 */
  warnings: string[]
}

export type ConfigAuditEvent =
  | 'config.loaded'
  | 'config.legacy'
  | 'config.invalid'
  | 'config.changed'
  | 'config.rollback'

export interface ConfigAuditEntry {
  timestamp: string
  event: ConfigAuditEvent
  source: 'host-settings' | 'boot'
  key?: string
  oldValue?: unknown
  newValue?: unknown
  result?: 'applied' | 'ignored' | 'failed' | 'defaulted'
  detail?: string
}

function readEnabled(value: unknown, label: string, warnings: string[]): boolean {
  if (value === undefined) return true
  if (value === false) return false
  if (value === true) return true
  warnings.push(`${label} 的值不是布尔值（${JSON.stringify(value)}），已按默认开启处理`)
  return true
}

/**
 * 计算运行时生效状态。规则：
 * - 缺省（undefined）按默认策略：capture 开、injection 开、finalCheck 开；
 * - 显式 false 才关（capture / injection）；非法值按默认开启并告警；
 * - finalCheck 恒为 true，旧配置里的 finalCheck.enabled 无论值都记入 legacy。
 */
export function behaviorOf(config: BehaviorConfig | null | undefined): BehaviorState {
  const legacy: string[] = []
  const warnings: string[] = []
  if (config != null && Object.prototype.hasOwnProperty.call(config, 'finalCheck') && config.finalCheck !== undefined) {
    legacy.push('finalCheck 已从有效配置中移除（最终完整性检查强制开启），该字段被忽略')
  }
  return {
    capture: readEnabled(config?.capture?.enabled, 'capture.enabled', warnings),
    injection: readEnabled(config?.injection?.enabled, 'injection.enabled', warnings),
    finalCheck: true,
    source: 'host-settings',
    legacy,
    warnings,
  }
}

/**
 * 追加一行配置审计到 `<dataDir>/config-audit.jsonl`。
 * 只追加、不覆盖；写失败返回 false 让调用方告警，绝不抛出、绝不回滚已生效配置。
 * 不记录敏感内容：只记字段名、生效值、结果与说明。
 */
export function appendAuditEntry(
  dataDir: string,
  entry: ConfigAuditEntry,
  append: (file: string, line: string) => void = (file, line) => appendFileSync(file, line, 'utf8'),
): boolean {
  try {
    append(join(dataDir, 'config-audit.jsonl'), `${JSON.stringify(entry)}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * 启动时记录一次配置加载：加载结果 + 生效值 + 旧配置/非法值告警。
 * 审计失败不改变任何配置语义，只返回 false 给调用方打 warn。
 */
export function auditConfigLoad(
  dataDir: string,
  config: BehaviorConfig | null | undefined,
  timestamp: string,
  append?: (file: string, line: string) => void,
): boolean {
  const behavior = behaviorOf(config)
  let ok = appendAuditEntry(
    dataDir,
    {
      timestamp,
      event: 'config.loaded',
      source: 'host-settings',
      result: 'applied',
      detail: `capture=${behavior.capture} injection=${behavior.injection} finalCheck=true`,
    },
    append,
  )
  for (const message of behavior.legacy) {
    ok =
      appendAuditEntry(
        dataDir,
        { timestamp, event: 'config.legacy', source: 'host-settings', key: 'finalCheck.enabled', result: 'ignored', detail: message },
        append,
      ) && ok
  }
  for (const message of behavior.warnings) {
    ok =
      appendAuditEntry(
        dataDir,
        { timestamp, event: 'config.invalid', source: 'host-settings', result: 'defaulted', detail: message },
        append,
      ) && ok
  }
  return ok
}
