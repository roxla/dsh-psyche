/**
 * 写入准入策略（D1-7 纯函数）。
 *
 * 定位：**只给判定，不执行拦截**。P1 阶段 remember 入口把判定结果落成一行
 * `admission_observations`，用来校准阈值；真正按 decision 拒写是 P2 的事。
 *
 * 三个判定：
 * - `accept`：正常写入；
 * - `observe`：内容偏弱（低质量/寒暄/重复），照写但留观测，供后续统计；
 * - `deny`：命中密钥/隐私形态，P2 会拒写；P1 仍照写，只把判定记下来。
 *
 * 为什么不在这里拦：P1 的阈值是估的，没有真实分布；先观测 200 条再定。
 */
import type { QualityAssessment } from '../quality/index.js'

/** 策略版本：判定规则改了要升它，观测行里存版本，事后能区分「按哪版判的」。 */
export const ADMISSION_POLICY_VERSION = '1.0.0'

export type AdmissionDecision = 'accept' | 'observe' | 'deny'

export interface AdmissionInput {
  quality: QualityAssessment
  text: string
  /** 记忆类型（constraint/preference 等）；只用于解释，不改变判定。 */
  kind?: string
}

export interface AdmissionResult {
  decision: AdmissionDecision
  /** 一句人话，写进观测表给面板/排障看。 */
  reason: string
  policyVersion: string
}

/** 密钥/隐私形态：宁可误判也不放过（P1 只记 deny，P2 才真拦）。 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/, // OpenAI 风格
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub token
  /\bAKIA[0-9A-Z]{16}\b/, // AWS Access Key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // 私钥块
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/, // Bearer 令牌
  /\b\d{18}\b/, // 18 位身份证号形态
]

function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * 判定一次写入尝试。
 *
 * 顺序：密钥/隐私优先（deny 不管质量分），再看质量档位。
 * 低质量不是拒绝理由——那只说明「不值得记」，不是「不合法」。
 */
export function decideAdmission(input: AdmissionInput): AdmissionResult {
  const { quality, text } = input

  if (looksSecret(text)) {
    return {
      decision: 'deny',
      reason: '命中密钥/隐私形态，P1 只记录判定，P2 起拒写',
      policyVersion: ADMISSION_POLICY_VERSION,
    }
  }

  if (quality.level === 'low') {
    return {
      decision: 'observe',
      reason: `质量 ${quality.score} 分（low），照写但留观测${quality.signals.length ? `；信号 ${quality.signals.join(', ')}` : ''}`,
      policyVersion: ADMISSION_POLICY_VERSION,
    }
  }

  if (quality.level === 'medium') {
    return {
      decision: 'accept',
      reason: `质量 ${quality.score} 分（medium），正常写入`,
      policyVersion: ADMISSION_POLICY_VERSION,
    }
  }

  return {
    decision: 'accept',
    reason: `质量 ${quality.score} 分（high），正常写入`,
    policyVersion: ADMISSION_POLICY_VERSION,
  }
}
