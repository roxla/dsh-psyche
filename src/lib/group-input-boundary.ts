// An explicit integration for a trusted Provider's own Adapter entry, never an outer llm hook.
import {randomUUID} from 'node:crypto'
import {createGroupProofAuthority,groupCanonical,groupHash,type Core,type GroupProofData} from 'dsh-psyche-core'
type Snapshot=ReturnType<Core['readGroupBatch']>
type Options={sessionId?:string;provider:string;model:string;purpose?:string;messages:unknown[];system?:unknown;tools?:unknown[];[key:string]:unknown}
type Chunk={type:string;reason?:{kind?:string};[key:string]:unknown}
type Entry={snapshot:Snapshot;turn:number;step:number;active():boolean;record(token:object):Promise<void>}
const channels=new WeakSet<object>()
function freeze(value:unknown):void {
  if(!value||typeof value!=='object'||Object.isFrozen(value))return
  for(const child of Object.values(value))freeze(child)
  Object.freeze(value)
}
export class GroupInputBoundary {
  readonly provider:string
  readonly model:string
  readonly #authority=createGroupProofAuthority()
  readonly #expected=new Map<string,Entry>()
  readonly #latest=new Map<string,GroupProofData>()
  #disposed=false
  constructor(provider:string,model:string) {this.provider=provider;this.model=model;channels.add(this)}
  bind(snapshot:Snapshot,turn:number,step:number,active:()=>boolean,record:(token:object)=>Promise<void>):()=>void {
    const entry={snapshot,turn,step,active,record},id=snapshot.batch.session_id
    this.#expected.set(id,entry)
    return ()=>{if(this.#expected.get(id)===entry)this.#expected.delete(id)}
  }
  last(batchId:string):GroupProofData|undefined {const p=this.#latest.get(batchId);return p?{...p}:undefined}
  forget(batchId:string):void {this.#latest.delete(batchId)}
  /** Stop issuing or continuing proofs; used when the runtime is unloaded. */
  close():void {this.#disposed=true}
  /** Install this as the stream method of the Provider that owns the actual request. */
  wrap(stream:(options:any)=>AsyncIterable<any>):(options:any)=>AsyncIterable<any> {
    const boundary=this
    return async function* (options:Options):AsyncGenerator<Chunk> {
      if(boundary.#disposed)throw new Error('GROUP_STALE_EPOCH')
      const entry=typeof options.sessionId==='string'?boundary.#expected.get(options.sessionId):undefined
      if(!entry) {
        if(options.sessionId?.startsWith('qq-group-')&&!options.purpose)throw new Error('GROUP_INPUT_NOT_ARMED')
        yield* stream(options);return
      }
      if(options.purpose) {yield* stream(options);return}
      const {proof,messages,system}=await boundary.#inspect(options,entry)
      yield* boundary.#consume(entry,proof,()=>stream({...options,messages,...(system===undefined?{}:{system})}))
    }
  }
  /**
   * Final Adapter boundary: `options` is the exact object the Adapter will receive and
   * `next()` takes no arguments, so this path never rebuilds or rewrites Provider input.
   */
  async *wrapFinal(options:Options,next:()=>AsyncIterable<any>):AsyncGenerator<Chunk> {
    if(this.#disposed)throw new Error('GROUP_STALE_EPOCH')
    const entry=typeof options.sessionId==='string'?this.#expected.get(options.sessionId):undefined
    if(!entry) {
      if(options.sessionId?.startsWith('qq-group-')&&!options.purpose)throw new Error('GROUP_INPUT_NOT_ARMED')
      yield* next();return
    }
    if(options.purpose) {yield* next();return}
    const {proof}=await this.#inspect(options,entry)
    yield* this.#consume(entry,proof,next)
  }
  async #inspect(options:Options,entry:Entry):Promise<{proof:GroupProofData;messages:unknown[];system:unknown}> {
    const b=entry.snapshot.batch
    const messages=structuredClone(options.messages)
    freeze(messages)
    const expected=messages.filter((m:any)=>m?.id===b.message_id)
    const full=expected.length===1&&(expected[0] as any).role==='user'&&(expected[0] as any).source?.kind==='user'&&Array.isArray((expected[0] as any).content)&&
      (expected[0] as any).content.length===1&&(expected[0] as any).content[0]?.type==='text'&&(expected[0] as any).content[0].text===entry.snapshot.projection
    if(!entry.active()||options.provider!==this.provider||options.model!==this.model||!full)throw new Error('GROUP_INPUT_PROOF_MISMATCH')
    // No platform send, shell, delegation or memory-write tool can enter this group request.
    if(options.tools?.some((t:any)=>t?.name!=='psyche_recall'))throw new Error('GROUP_TOOL_SURFACE_UNAVAILABLE')
    const system=options.system===undefined?undefined:structuredClone(options.system);freeze(system)
    const requestHash=groupHash(groupCanonical(JSON.parse(JSON.stringify({version:1,messages,system:system??null}))))
    const proof:GroupProofData={kind:'input',batchId:b.batch_id,epoch:b.epoch,sessionId:b.session_id,messageId:b.message_id,turn:entry.turn,step:entry.step,attemptId:`ga_${randomUUID()}`,provider:options.provider,model:options.model,requestHash,projectionHash:b.projection_hash,full:true}
    await entry.record(this.#authority.issue(proof))
    return {proof,messages,system}
  }
  async *#consume(entry:Entry,proof:GroupProofData,open:()=>AsyncIterable<Chunk>):AsyncGenerator<Chunk> {
    const batchId=proof.batchId
    let finished=false
    for await(const chunk of open()) {
      if(this.#disposed)throw new Error('GROUP_STALE_EPOCH')
      if(!entry.active())throw new Error('GROUP_STALE_EPOCH')
      if(chunk.type==='finish') {
        if(finished)throw new Error('GROUP_DOUBLE_FINISH')
        finished=true
        const terminal={...proof,kind:'finish' as const,finish:String(chunk.reason?.kind??'missing')}
        await entry.record(this.#authority.issue(terminal))
        this.#latest.set(batchId,terminal)
      }
      yield chunk
    }
    if(!finished)throw new Error('GROUP_REQUEST_INCOMPLETE')
  }
}
export function isGroupInputBoundary(value:unknown,provider:string,model:string):value is GroupInputBoundary {
  return !!value&&typeof value==='object'&&channels.has(value)&&
    (value as GroupInputBoundary).provider===provider&&(value as GroupInputBoundary).model===model
}
