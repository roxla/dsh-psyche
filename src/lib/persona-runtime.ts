/**
 * P5-1a：人格只读投影。
 *
 * 边界（`docs/design/p5-1a-persona-runtime-implementation.md`）：
 * - 只读：不写库、不改 `identity.md` / `persona.json`、不产生成长或反思候选。
 * - 可信读取：每次调用重新读原文并自算 SHA-256，与 locked `identityHash` 比较；
 *   `inspectInitialization` 不提供完整比较结果时按 `unavailable` 处理。
 * - 双硬上限：6000 字符 / 3000 token；估算超限或计数异常一律不注入。
 * - 不是统一 Composer：不测量、不裁剪其他 Context。
 */
import { existsSync, readFileSync } from 'node:fs'
import {
  initPathsOf,
  inspectInitialization,
  sha256OfText,
} from 'dsh-psyche-core'

export type PersonaProjectionStatus =
  | 'ready'
  | 'over_budget'
  | 'identity_drift'
  | 'damaged'
  | 'unavailable'
  | 'uninitialized'
  | 'disabled'

export interface PersonaProjection {
  status: PersonaProjectionStatus
  text?: string
  hash?: string
  chars: number
  tokens: number
  estimated: boolean
  reason?: string
}

export interface PersonaProjectionOptions {
  /** 只接受来自已验证配置的数据根；本函数不校验路径来源。 */
  dataDir: string
  enabled?: boolean
  maxChars?: number
  maxTokens?: number
  /** 可选精确 tokenizer；缺失时使用版本化保守估算。 */
  tokenizer?: (text: string) => number
}

export const PERSONA_DEFAULT_MAX_CHARS = 6_000
export const PERSONA_DEFAULT_MAX_TOKENS = 3_000
/** 估算系数：CJK 1 字≈1 token，再乘 1.2 作为包装/误差预留。 */
export const PERSONA_TOKEN_ESTIMATE_FACTOR = 1.2

/** 版本化保守估算；`estimated=true` 时调用方只能声明估算值。 */
export function estimatePersonaTokens(text: string): number {
  let codePoints = 0
  for (const _ of text) codePoints += 1
  return Math.ceil(codePoints * PERSONA_TOKEN_ESTIMATE_FACTOR)
}

function countCodePoints(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

function empty(status: PersonaProjectionStatus, reason?: string): PersonaProjection {
  return { status, chars: 0, tokens: 0, estimated: false, ...(reason ? { reason } : {}) }
}

/**
 * 读取一次人格投影。同步、只读、无缓存；异常统一收敛为失败状态。
 */
export function readPersonaProjection(options: PersonaProjectionOptions): PersonaProjection {
  if (options.enabled === false) return empty('disabled', 'persona_disabled')
  const maxChars = options.maxChars ?? PERSONA_DEFAULT_MAX_CHARS
  const maxTokens = options.maxTokens ?? PERSONA_DEFAULT_MAX_TOKENS

  let snapshot: ReturnType<typeof inspectInitialization>
  try {
    snapshot = inspectInitialization({ dataDir: options.dataDir })
  } catch {
    return empty('unavailable', 'inspect_failed')
  }

  switch (snapshot.state) {
    case 'uninitialized':
    case 'initializing':
      return empty('uninitialized', snapshot.state)
    case 'damaged':
      return empty('damaged', 'state_damaged')
    case 'identity-drift':
    case 'locked':
      break
    default:
      return empty('unavailable', 'unknown_state')
  }

  if (snapshot.state === 'identity-drift' || snapshot.hashMatches === false) {
    return empty('identity_drift', 'hash_mismatch')
  }
  if (snapshot.state === 'locked' && (snapshot.hashMatches === null || !snapshot.identityHash)) {
    return empty('unavailable', 'hash_unverified')
  }

  let text: string
  try {
    const paths = initPathsOf(options.dataDir)
    if (!existsSync(paths.identity)) return empty('damaged', 'identity_missing')
    text = readFileSync(paths.identity, 'utf8')
  } catch {
    return empty('unavailable', 'identity_read_failed')
  }

  let hash: string
  try {
    hash = sha256OfText(text)
  } catch {
    return empty('unavailable', 'hash_failed')
  }
  if (snapshot.identityHash !== hash || snapshot.hashMatches !== true) {
    return empty('identity_drift', 'hash_mismatch')
  }

  const chars = countCodePoints(text)
  let tokens: number
  let estimated: boolean
  if (options.tokenizer) {
    try {
      tokens = options.tokenizer(text)
    } catch {
      return empty('unavailable', 'tokenizer_failed')
    }
    if (!Number.isFinite(tokens) || tokens < 0) return empty('unavailable', 'tokenizer_invalid')
    estimated = false
  } else {
    tokens = estimatePersonaTokens(text)
    estimated = true
  }

  if (chars > maxChars) {
    return { status: 'over_budget', hash, chars, tokens, estimated, reason: 'chars' }
  }
  if (tokens > maxTokens) {
    return { status: 'over_budget', hash, chars, tokens, estimated, reason: 'tokens' }
  }
  return { status: 'ready', text, hash, chars, tokens, estimated }
}
