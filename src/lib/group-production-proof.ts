// Production seam for the final Adapter call boundary (H-1 contract). No Host implementation
// is assumed: without `registerCallBoundary` this module fails closed and keeps collection-only.
import {GroupInputBoundary} from './group-input-boundary.js'

export const PRODUCTION_PROOF_CODES={
  configMissing:'GROUP_PROOF_CONFIG_MISSING',
  hostCapabilityMissing:'GROUP_PROOF_HOST_CAPABILITY_MISSING',
  registerFailed:'GROUP_PROOF_REGISTER_FAILED'
} as const
export type ProductionProofUnavailableCode=(typeof PRODUCTION_PROOF_CODES)[keyof typeof PRODUCTION_PROOF_CODES]

/** Structural mirror of the frozen H-1 `LlmCallBoundary`; intentionally not imported from dsh-llm. */
export interface LlmCallBoundary {
  readonly id: string
  stream(options:unknown,next:()=>AsyncIterable<unknown>):AsyncIterable<unknown>
}
/** Structural mirror of the H-1 `registerCallBoundary` capability. */
export interface LlmCallBoundaryHost {
  registerCallBoundary(providers:string[],boundary:LlmCallBoundary):unknown
}
export interface ProductionProofOptions {
  llm:unknown
  provider?:string
  model?:string
  onUnavailable?:(code:ProductionProofUnavailableCode)=>void
}
export interface ProductionGroupInputProof {
  boundary:GroupInputBoundary|null
  dispose:()=>void
}
const noop=()=>{}
/** Capability detection is structural and fail-closed. Never falls back to hooks or Adapter replacement. */
export function detectCallBoundaryHost(llm:unknown):LlmCallBoundaryHost|null {
  if(!llm||typeof llm!=='object')return null
  try {
    const candidate=llm as {registerCallBoundary?:unknown}
    return typeof candidate.registerCallBoundary==='function'?llm as LlmCallBoundaryHost:null
  } catch {return null}
}
export function createProductionGroupInputProof(options:ProductionProofOptions):ProductionGroupInputProof {
  const unavailable=options.onUnavailable??noop
  const provider=typeof options.provider==='string'?options.provider.trim():''
  const model=typeof options.model==='string'?options.model.trim():''
  if(!provider||!model) {
    unavailable(PRODUCTION_PROOF_CODES.configMissing)
    return {boundary:null,dispose:noop}
  }
  const host=detectCallBoundaryHost(options.llm)
  if(!host) {
    unavailable(PRODUCTION_PROOF_CODES.hostCapabilityMissing)
    return {boundary:null,dispose:noop}
  }
  const boundary=new GroupInputBoundary(provider,model)
  const adapter:LlmCallBoundary={
    id:'psyche-group-input-proof',
    stream:(input,next)=>boundary.wrapFinal(input as Parameters<GroupInputBoundary['wrapFinal']>[0],next as ()=>AsyncIterable<never>)
  }
  let registered:unknown
  try {registered=host.registerCallBoundary([provider],adapter)} catch {
    boundary.close()
    unavailable(PRODUCTION_PROOF_CODES.registerFailed)
    return {boundary:null,dispose:noop}
  }
  if(typeof registered!=='function') {
    // The H-1 contract promises an idempotent disposer; anything else cannot be safely unloaded.
    boundary.close()
    unavailable(PRODUCTION_PROOF_CODES.registerFailed)
    return {boundary:null,dispose:noop}
  }
  const unregister=registered as ()=>void
  let disposed=false
  return {
    boundary,
    dispose:()=>{
      if(disposed)return
      disposed=true
      // Stop new proofs first, then detach the Host registration.
      boundary.close()
      try {unregister()} catch {}
    }
  }
}
