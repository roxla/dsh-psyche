/**
 * 事件名：Core 通过宿主事件总线广播，通道与面板可以订阅，但不允许反过来写库。
 * 名字统一 `psyche:` 前缀；P1-1 只定名字，payload 在 P1-2 收敛。
 */
export const PSYCHE_EVENT_NAMES = [
  /** 一条原始消息（Source）落库。payload: { sourceId, surface, sessionId } */
  'psyche:source-recorded',
  /** 一条 Event 落库。payload: { eventId, kind, type } */
  'psyche:event-committed',
  /** 一个 Artifact 产生新 revision。payload: { artifactId, revision, kind } */
  'psyche:artifact-revised',
  /** 成长阶段变化。payload: { from, to, evidenceIds } */
  'psyche:phase-changed',
  /** 某个联系人的好感档位变化。payload: { contactId, from, to } */
  'psyche:relationship-updated',
  /** 心情/短时情绪变化。payload: { mood, contactAffect } */
  'psyche:mood-updated',
] as const

export type PsycheEventName = (typeof PSYCHE_EVENT_NAMES)[number]

export interface PsycheEventEnvelope<TPayload = unknown> {
  name: PsycheEventName
  /** ISO 时间戳；统一由 Core 生成，通道不自造。 */
  at: string
  /** 事件来自哪个面：desktop / qq / pet / web / ops。 */
  surface: string
  payload: TPayload
}
