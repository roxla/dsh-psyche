/**
 * admission 模块入口（D1-7）。
 *
 * 只导出纯函数与类型；不 import store / adapter / 宿主 —— 它要能在
 * 任何地方被单测，也能被 remember 入口在事务内调用。
 */
export { ADMISSION_POLICY_VERSION, decideAdmission } from './policy.js'
export type { AdmissionDecision, AdmissionInput, AdmissionResult } from './policy.js'
