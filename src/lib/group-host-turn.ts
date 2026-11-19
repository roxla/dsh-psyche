// D-2: actual Host message/turn/flush correlation. This does not implement an agent loop.
import {createGroupProofAuthority,groupProofData,groupCanonical,groupHash,type Core,type GroupProofData} from 'dsh-psyche-core'
import type {GroupInputBoundary} from './group-input-boundary.js'
import {messageText} from './qq-bridge.js'
type Snapshot=ReturnType<Core['readGroupBatch']>
interface Agent {
  id:string;status?:string;session:any;ctx?:any
  inbox:{hasPending:boolean;clear():void}
  followup(message:unknown):void
  cancel(cause:unknown,options?:unknown):void
  whenIdle():Promise<void>
}
interface Host {
  agents:{get(id:string):Agent|undefined;create(options:any):Promise<{agent:Agent;dispose():Promise<void>}>;resume(options:any):Promise<{agent:Agent;dispose():Promise<void>}>}
  on(name:string,listener:(...args:any[])=>any,options?:unknown):(()=>void)|undefined
  sessions:{flush(session:unknown):Promise<boolean>}
  persistence:{open(id:string,mode:'read'):Promise<any>|any}
}
interface Active {
  snapshot:Snapshot;context:{ownerId:string;epoch:number;isActive():boolean};agent:Agent
  turn:number|null;lastStep:number;finalMessage:{id:string;text:string;step:number}|null
  inputSeq:number|null
  offProof:(()=>void)|null;resolve:(value:boolean)=>void;timer:ReturnType<typeof setTimeout>;closing:boolean
}
const eventList=(value:any):any[]=>Array.isArray(value)?value:Array.isArray(value?.events)?value.events:Array.isArray(value?.items)?value.items:[]
interface GroupHostDeps {
  announce(snapshot:Snapshot):void
  bound(sessionId:string,roomId:string):boolean
  send(snapshot:Snapshot,text:string,active:()=>boolean):Promise<{outcome:'sent'|'failed'|'unknown'|'cancelled';platformMessageId?:string;reason?:string}>
  cwd?:string
  warn(code:string):void
  timeoutMs?:number
  now?:()=>number
  recoveryPolicy?(snapshot:Snapshot):unknown
}
export class GroupHostTurns {
  readonly core:Core
  readonly host:Host
  readonly boundary:GroupInputBoundary
  readonly deps:GroupHostDeps
  readonly #active=new Map<string,Active>()
  readonly #owned=new Map<string,{agent:Agent;dispose():Promise<void>}>()
  readonly #creating=new Set<Promise<{agent:Agent;dispose():Promise<void>}|undefined>>()
  readonly #listeners:Array<()=>void>=[]
  readonly #authority=createGroupProofAuthority()
  readonly #guarded=new WeakSet<object>()
  readonly #toolDisposers:Array<()=>void>=[]
  #closed=false
  constructor(core:Core,host:Host,boundary:GroupInputBoundary,deps:GroupHostDeps) {
    this.core=core;this.host=host;this.boundary=boundary;this.deps=deps
    const pre=host.on('agent/pre-step',async(payload:any,next:()=>Promise<any>)=>{
      const id=payload.agent?.id
      if(typeof id!=='string'||!id.startsWith('qq-group-'))return next()
      const a=this.#active.get(id)
      if(this.#closed||!a||!a.context.isActive())return {kind:'reject'}
      const decision=await next()
      if(decision?.kind!=='enter')return decision
      const ordinary=(decision.messages??[]).filter((m:any)=>m?.source?.kind==='user')
      const own=ordinary.find((m:any)=>m.id===a.snapshot.batch.message_id)
      if(a.turn===null&&!own||ordinary.some((m:any)=>m.id!==a.snapshot.batch.message_id)||a.turn!==null&&a.turn!==payload.turn)return {kind:'reject'}
      if(own&&JSON.stringify(own.content)!==JSON.stringify([{type:'text',text:a.snapshot.projection}]))return {kind:'reject'}
      if(!this.deps.bound(id,a.snapshot.batch.room_id))return {kind:'reject'}
      a.turn=payload.turn;a.lastStep=payload.step
      await this.core.groupSchedule({kind:'bind-turn',ownerId:a.context.ownerId,epoch:a.context.epoch,now:this.#now(),batchId:a.snapshot.batch.batch_id,turn:payload.turn,step:payload.step})
      a.offProof?.()
      a.offProof=this.boundary.bind(a.snapshot,payload.turn,payload.step,()=>this.#live(a),async proof=>{
        if(!this.#live(a))throw new Error('GROUP_STALE_EPOCH')
        const data=groupProofData(proof)
        const anchored=a.inputSeq===null?proof:this.#authority.issue({...data,inputSeq:a.inputSeq})
        await this.core.groupSchedule({kind:'receipt',ownerId:a.context.ownerId,epoch:a.context.epoch,now:this.#now(),batchId:a.snapshot.batch.batch_id,proof:anchored})
      })
      return decision
    },{prepend:true})
    if(pre)this.#listeners.push(pre)
    const events=host.on('session/event',(session:any,event:any)=>{
      const a=this.#active.get(session?.id)
      if(!a||this.#closed||!a.context.isActive())return
      if(event.type==='user/message'&&event.data?.id===a.snapshot.batch.message_id&&Number.isSafeInteger(event.seq))a.inputSeq=event.seq
      if(event.type==='assistant/message'&&event.data?.turn===a.turn) {
        const text=messageText(event.data.message)
        if(text&&typeof event.data.message?.id==='string')a.finalMessage={id:event.data.message.id,text,step:event.data.step}
      }
      if(event.type==='turn/end'&&event.data?.turn===a.turn&&!a.closing) {
        a.closing=true
        void this.#end(a,event).catch(()=>{this.deps.warn('GROUP_TURN_SETTLEMENT_FAILED');void this.#abort(a)})
      }
    })
    if(events)this.#listeners.push(events)
  }
  async run(snapshot:Snapshot,context:Active['context']):Promise<boolean> {
    if(this.#closed||!context.isActive())return true
    const id=snapshot.batch.session_id
    this.deps.announce(snapshot)
    const owned=await this.#ensureOwned(snapshot,context.isActive)
    if(!owned)return this.#closed||!context.isActive()
    const agent=owned.agent
    if(!context.isActive()||this.#closed){await owned.dispose();this.#owned.delete(id);return true}
    // Clear a previous generation's activity and queued input before admitting a new batch.
    if(agent.status!=='idle') {
      agent.cancel({kind:'hook',reason:'group_generation_recovery'},{keepInbox:false})
      if(!await this.#idle(agent))return false
    }
    if(!agent.inbox||typeof agent.inbox.clear!=='function')throw new Error('GROUP_INBOX_GATE_UNAVAILABLE')
    agent.inbox.clear()
    if(agent.inbox.hasPending||!await this.host.sessions.flush(agent.session))throw new Error('GROUP_INBOX_NOT_DURABLE')
    if(!this.#guarded.has(agent)) {
      const tools=agent.ctx?.tools
      if(!tools||typeof tools.restrict!=='function'||typeof tools.guard!=='function')throw new Error('GROUP_TOOL_GATE_UNAVAILABLE')
      const allowed=['psyche_recall'].filter(name=>tools.schemas().some((s:any)=>s.name===name))
      // A read-only subset, plus a final monotonic execution guard for scoped/local tools.
      if(!allowed.length)throw new Error('GROUP_READ_TOOLS_UNAVAILABLE')
      this.#toolDisposers.push(tools.restrict({allow:allowed}))
      this.#toolDisposers.push(tools.guard((exec:any)=>exec.name!=='psyche_recall'||!this.#active.get(id)?.context.isActive()?'GROUP_TOOL_DENIED':undefined))
      const offPresentation=tools.presentAs?.('native');if(typeof offPresentation==='function')this.#toolDisposers.push(offPresentation)
      this.#guarded.add(agent)
    }
    for(let i=0;i<80&&!this.deps.bound(id,snapshot.batch.room_id);i++)await new Promise(resolve=>setTimeout(resolve,25))
    if(!context.isActive()||!this.deps.bound(id,snapshot.batch.room_id))throw new Error('GROUP_BINDING_UNAVAILABLE')
    const selected=agent
    return await new Promise<boolean>((resolve,reject)=>{
      const timer=setTimeout(()=>{const a=this.#active.get(id);if(a)void this.#abort(a)},this.deps.timeoutMs??120000)
      const a:Active={snapshot,context,agent:selected,turn:null,lastStep:0,finalMessage:null,inputSeq:null,offProof:null,resolve,timer,closing:false}
      this.#active.set(id,a)
      try{selected.followup(Object.freeze({id:snapshot.batch.message_id,role:'user',content:Object.freeze([Object.freeze({type:'text',text:snapshot.projection})]),source:Object.freeze({kind:'user'})}))}
      catch{void this.#abort(a)}
    })
  }
  async #idle(agent:Agent):Promise<boolean> {
    let timer:ReturnType<typeof setTimeout>|undefined
    try{return await Promise.race([agent.whenIdle().then(()=>agent.status==='idle'),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),5000)})])}catch{return false}finally{if(timer)clearTimeout(timer)}
  }
  async #ensureOwned(snapshot:Snapshot,live:()=>boolean):Promise<{agent:Agent;dispose():Promise<void>}|undefined> {
    const id=snapshot.batch.session_id,existing=this.#owned.get(id)
    if(existing)return existing
    if(this.host.agents.get(id))return undefined
    const pending=(async()=>{
      let owned
      try{owned=await this.host.agents.resume({resumeSessionId:id,agentOptions:{provider:snapshot.batch.provider,model:snapshot.batch.model}})}
      catch{owned=await this.host.agents.create({sessionId:id,agentOptions:{provider:snapshot.batch.provider,model:snapshot.batch.model},...(this.deps.cwd?{meta:{cwd:this.deps.cwd}}:{})})}
      if(typeof owned.dispose!=='function')throw new Error('GROUP_AGENT_OWNER_UNAVAILABLE')
      if(this.#closed||!live()){await owned.dispose();return undefined}
      this.#owned.set(id,owned);return owned
    })()
    this.#creating.add(pending)
    try{return await pending}finally{this.#creating.delete(pending)}
  }
  async #history(sessionId:string,fromSeq?:number,throughSeq?:number):Promise<any[]> {
    const handle=await this.host.persistence.open(sessionId,'read')
    if(!handle||typeof handle.read!=='function')throw new Error('GROUP_PERSISTENCE_UNAVAILABLE')
    const events:any[]=[],start=Math.max(0,(fromSeq??1)-1)
    try {
      let offset=start
      while(true) {
        const page=eventList(await handle.read(offset,500));events.push(...page);offset+=page.length
        if(page.length<500||throughSeq!==undefined&&page.some(e=>Number(e.seq)>=throughSeq))break
        if(offset-start>1000000)throw new Error('GROUP_HISTORY_LIMIT')
      }
      return events
    }finally{await handle.close()}
  }
  /** Reconcile durable completed work only. No followup, reply intent or network send here. */
  async recover(context:{ownerId:string;epoch:number;isActive():boolean}):Promise<void> {
    const rows=this.core.db.all<{batch_id:string}>("SELECT batch_id FROM room_batches WHERE state='interrupted' AND reason='worker_restart' AND epoch<? ORDER BY created_ms",[context.epoch])
    for(const row of rows) {
      if(this.#closed||!context.isActive())return
      try {
        const snapshot=this.core.readGroupBatch(row.batch_id),b=snapshot.batch
        const policy=this.deps.recoveryPolicy?.(snapshot)
        if(!policy)continue
        const receipt=this.core.db.get<{receipt_json:string}>("SELECT receipt_json FROM room_input_receipts WHERE batch_id=? AND kind='finish' ORDER BY rowid DESC LIMIT 1",[b.batch_id])
        const last=receipt?JSON.parse(receipt.receipt_json) as GroupProofData:null
        if(!last||!last.full||last.finish!=='stop'||last.step!==b.last_step)continue
        this.deps.announce(snapshot)
        const owned=await this.#ensureOwned(snapshot,context.isActive)
        if(!owned)continue
        if(owned.agent.status!=='idle')owned.agent.cancel({kind:'hook',reason:'group_recovery_read'},{keepInbox:false})
        if(!await this.#idle(owned.agent)||this.#closed||!context.isActive())continue
        owned.agent.inbox.clear()
        if(owned.agent.inbox.hasPending||!await this.host.sessions.flush(owned.agent.session))continue
        const durable=await this.#history(b.session_id,last.inputSeq)
        const input=durable.find(e=>e.type==='user/message'&&e.data?.id===b.message_id)
        const end=durable.find(e=>e.type==='turn/end'&&e.data?.turn===b.host_turn&&e.data?.reason?.kind==='completed')
        const candidate=durable.filter(e=>e.type==='assistant/message'&&e.data?.turn===b.host_turn&&e.data?.step===last.step).at(-1)
        const assistant=messageText(candidate?.data?.message)?candidate:null
        if(!input||!end||JSON.stringify(input.data.content)!==JSON.stringify([{type:'text',text:snapshot.projection}]))continue
        const reply=messageText(assistant?.data?.message)
        const data:GroupProofData={...last,kind:'turn',finish:'completed',endSeq:end.seq,flush:true,persistenceHash:groupHash(groupCanonical(JSON.parse(JSON.stringify({input,end,assistant})))),...(reply?{assistantMessageId:assistant.data.message.id,replyHash:groupHash(reply.trim())}:{})}
        if(this.#closed||!context.isActive())return
        await this.core.groupSchedule({kind:'reconcile',ownerId:context.ownerId,epoch:context.epoch,now:this.#now(),batchId:b.batch_id,policy:policy as any,proof:this.#authority.issue(data)})
      }catch{this.deps.warn('GROUP_RECOVERY_UNPROVED')}
    }
  }
  #done(a:Active,quiet:boolean) {
    clearTimeout(a.timer);a.offProof?.();this.boundary.forget(a.snapshot.batch.batch_id)
    if(quiet&&this.#active.get(a.snapshot.batch.session_id)===a)this.#active.delete(a.snapshot.batch.session_id)
    a.resolve(quiet)
  }
  async #abort(a:Active):Promise<void> {
    if(this.#active.get(a.snapshot.batch.session_id)!==a)return
    try{a.agent.cancel({kind:'hook',reason:'group_turn_incomplete'},{keepInbox:false})}catch{this.#done(a,false);return}
    this.#done(a,await this.#idle(a.agent))
  }
  async #end(a:Active,event:any) {
    if(!this.#live(a))return
    if(event.data.reason?.kind!=='completed'){await this.#abort(a);return}
    const last=this.boundary.last(a.snapshot.batch.batch_id)
    if(!last||last.finish!=='stop'||a.finalMessage&&a.finalMessage.step!==last.step){await this.#abort(a);return}
    if(!await this.host.sessions.flush(a.agent.session))throw new Error('GROUP_PERSISTENCE_UNAVAILABLE')
    const durable=await this.#history(a.snapshot.batch.session_id,a.inputSeq??undefined,event.seq)
    const input=durable.find(e=>e.type==='user/message'&&e.data?.id===a.snapshot.batch.message_id)
    const end=durable.find(e=>e.type==='turn/end'&&e.seq===event.seq&&e.data?.turn===a.turn&&e.data?.reason?.kind==='completed')
    const assistant=a.finalMessage?durable.find(e=>e.type==='assistant/message'&&e.data?.turn===a.turn&&e.data?.step===last.step&&e.data?.message?.id===a.finalMessage!.id):null
    if(!input||!end||a.finalMessage&&(!assistant||messageText(assistant.data.message)!==a.finalMessage.text))throw new Error('GROUP_DURABLE_TURN_MISSING')
    if(!this.#live(a)){return}
    const proof=this.#authority.issue({...last,kind:'turn',finish:'completed',endSeq:end.seq,flush:true,persistenceHash:groupHash(groupCanonical(JSON.parse(JSON.stringify({input,end,assistant})))),...(a.inputSeq===null?{}:{inputSeq:a.inputSeq}),...(a.finalMessage?{assistantMessageId:a.finalMessage.id,replyHash:groupHash(a.finalMessage.text.trim())}:{})})
    await this.core.groupSchedule({kind:'complete',ownerId:a.context.ownerId,epoch:a.context.epoch,now:this.#now(),batchId:a.snapshot.batch.batch_id,proof})
    if(!a.finalMessage){this.#done(a,await this.#idle(a.agent));return}
    await this.core.groupSchedule({kind:'prepare-reply',ownerId:a.context.ownerId,epoch:a.context.epoch,now:this.#now(),batchId:a.snapshot.batch.batch_id,text:a.finalMessage.text,hostMessageId:a.finalMessage.id})
    if(!this.#live(a))return
    const outcome=await this.deps.send(a.snapshot,a.finalMessage.text,()=>this.#live(a))
    if(this.#live(a))await this.core.groupSchedule({kind:'settle-send',ownerId:a.context.ownerId,epoch:a.context.epoch,now:this.#now(),batchId:a.snapshot.batch.batch_id,...outcome})
    this.#done(a,await this.#idle(a.agent))
  }
  async close():Promise<boolean> {
    this.#closed=true
    for(const off of this.#listeners.splice(0))off()
    await Promise.allSettled([...this.#creating])
    const active=[...this.#active.values()]
    for(const a of active)try{a.agent.cancel({kind:'hook',reason:'group_plugin_unload'},{keepInbox:false})}catch{this.deps.warn('GROUP_CANCEL_FAILED')}
    const quiet=await Promise.all(active.map(async a=>{const ok=await this.#idle(a.agent);this.#done(a,ok);return ok}))
    const ok=quiet.every(Boolean)
    if(ok) {
      for(const off of this.#toolDisposers.splice(0))try{off()}catch{ /* scope may already have unwound */ }
      await Promise.all([...this.#owned.values()].map(async owned=>{try{await owned.dispose()}catch(error){if(this.host.agents.get(owned.agent.id)===owned.agent)throw error}}))
      this.#owned.clear()
    }
    return ok
  }
  #live(a:Active):boolean {return !this.#closed&&a.context.isActive()&&this.#active.get(a.snapshot.batch.session_id)===a}
  #now():number {return this.deps.now?.()??Date.now()}
}
