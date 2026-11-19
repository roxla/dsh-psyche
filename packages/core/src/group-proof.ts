// Host-only producer capability. Never registered as a tool, HTTP method or model context.
import { invalid } from './errors.js'
export interface GroupProofData {
  kind: 'input' | 'finish' | 'turn'
  batchId: string; epoch: number; sessionId: string; messageId: string
  turn: number; step: number; attemptId: string; provider: string; model: string
  requestHash: string; projectionHash: string; full: boolean
  finish?: string; endSeq?: number; flush?: boolean; persistenceHash?: string
  assistantMessageId?: string; replyHash?: string
  inputSeq?:number
}
const records=new WeakMap<object,Readonly<GroupProofData>>()
/** The authority belongs only to the configured, trusted Host/Adapter integration. */
export function createGroupProofAuthority(): { issue(data: GroupProofData): object } {
  return Object.freeze({issue(data:GroupProofData) {
    const token=Object.freeze(Object.create(null)) as object
    records.set(token,Object.freeze({...data}))
    return token
  }})
}
export function groupProofData(token: object): Readonly<GroupProofData> {
  const data=records.get(token)
  if(!data)throw invalid('GROUP_PROOF_UNTRUSTED')
  return data
}
