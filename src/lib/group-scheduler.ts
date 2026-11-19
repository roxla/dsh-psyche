// D-2 Room scheduler. It owns neither the Host agent loop nor the proactive Outbox Worker.
import {createHash,randomUUID} from 'node:crypto'
import {realpathSync} from 'node:fs'
import {createServer} from 'node:net'
import {groupHash,type Core,type GroupBatch,type RoomPolicy} from 'dsh-psyche-core'
export interface GroupClock {
  now():number
  monotonic?():number
  setTimeout(fn:()=>void,ms:number):unknown
  clearTimeout(timer:unknown):void
}
export const groupSystemClock:GroupClock={now:()=>Date.now(),monotonic:()=>performance.now(),setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:timer=>clearTimeout(timer as ReturnType<typeof setTimeout>)}
/** Same kernel-owned, canonical-path lease pattern as the Owner CLI, separate job namespace. */
export async function acquireGroupLease(file:string):Promise<{release():Promise<void>}> {
  const real=realpathSync(file),canonical=process.platform==='win32'?real.toLowerCase():real
  // Stay below Windows' dynamic port range and separate from the Owner CLI namespace.
  const port=36000+createHash('sha256').update('psyche-group:'+canonical).digest().readUInt32BE(0)%6000
  const server=createServer(socket=>socket.destroy())
  await new Promise<void>((resolve,reject)=>{server.once('error',(error:NodeJS.ErrnoException)=>reject(new Error(error.code==='EADDRINUSE'?'GROUP_OWNER_BUSY':'GROUP_OWNER_LEASE_UNAVAILABLE')));server.listen({host:'127.0.0.1',port,exclusive:true},resolve)})
  server.unref()
  let closed=false
  return {release:async()=>{if(closed)return;closed=true;await new Promise<void>(resolve=>server.close(()=>resolve()))}}
}
export interface GroupSchedulerDeps {
  policies():ReadonlyMap<string,RoomPolicy>
  account():string|null
  connected():boolean
  available?():boolean
  provider:string;model:string
  run(snapshot:ReturnType<Core['readGroupBatch']>,context:{epoch:number;ownerId:string;isActive():boolean}):Promise<boolean|void>
  cancel():Promise<boolean>
  recover?(context:{epoch:number;ownerId:string;isActive():boolean}):Promise<void>
  warn(code:string):void
  clock?:GroupClock
  lease?:()=>Promise<{release():Promise<void>}>
}
export class GroupScheduler {
  readonly core:Core
  readonly deps:GroupSchedulerDeps
  readonly ownerId=`group_${randomUUID()}`
  epoch=0
  readonly counts={batchCreated:0,turnStarted:0,queueOverflow:0,turnIncomplete:0,staleEpochBlocked:0,lifecycleUnresolved:0,invalidEvidence:0,inboundGap:0}
  #active=false
  #pumping:Promise<void>|null=null
  #stopping:Promise<void>|null=null
  #again=false
  #timer:unknown=null
  #lease:{release():Promise<void>}|null=null
  #running=new Map<string,Promise<void>>()
  #lastRoom=''
  #windows=new Map<string,{firstSeq:number;firstMono:number;lastMono:number;lastWall:number}>()
  readonly #clock:GroupClock
  constructor(core:Core,deps:GroupSchedulerDeps) {this.core=core;this.deps=deps;this.#clock=deps.clock??groupSystemClock}
  get active(){return this.#active}
  get ready(){return this.#active&&(this.deps.available?.()??true)}
  noteInboundGap():void {if(this.#active){this.counts.inboundGap++;this.deps.warn('GROUP_INBOUND_GAP')}}
  async notify(roomId:string):Promise<void> {
    const room=this.core.readGroupSchedule().rooms.find(r=>r.room_id===roomId)
    if(room)this.#window(room,true)
    await this.kick()
  }
  #window(room:ReturnType<Core['readGroupSchedule']>['rooms'][number],notified=false) {
    const mono=this.#clock.monotonic?.()??this.#clock.now(),now=this.#clock.now()
    let window=this.#windows.get(room.room_id)
    if(!window||window.firstSeq!==room.first_seq){window={firstSeq:room.first_seq,firstMono:mono-Math.max(0,now-room.first_ms),lastMono:mono-Math.max(0,now-room.last_ms),lastWall:room.last_ms};this.#windows.set(room.room_id,window)}
    if(notified||window.lastWall!==room.last_ms){window.lastMono=mono;window.lastWall=room.last_ms}
    return window
  }
  async start():Promise<void> {
    if(this.#active)return
    this.#lease=await (this.deps.lease?.()??acquireGroupLease(this.core.db.file))
    try {
      const result=await this.core.groupSchedule({kind:'start',ownerId:this.ownerId,now:this.#clock.now()})
      this.epoch=Number(result.epoch);this.#active=true
      await this.deps.recover?.({epoch:this.epoch,ownerId:this.ownerId,isActive:()=>this.ready})
      await this.kick()
    }catch(error){await this.#lease.release();this.#lease=null;throw error}
  }
  async kick():Promise<void> {
    if(!this.#active)return
    if(this.#pumping){this.#again=true;return this.#pumping}
    this.#pumping=(async()=>{do{this.#again=false;await this.#pump()}while(this.#again&&this.#active)})()
    try{await this.#pumping}finally{this.#pumping=null}
  }
  #wake(delay:number) {
    if(!this.#active)return
    if(this.#timer!==null)this.#clock.clearTimeout(this.#timer)
    this.#timer=this.#clock.setTimeout(()=>{this.#timer=null;void this.kick().catch(()=>this.deps.warn('GROUP_PUMP_FAILED'))},Math.max(1,delay))
  }
  async #pump() {
    if(!this.#active)return
    if(this.deps.available&&!this.deps.available()){this.deps.warn('GROUP_PROOF_UNAVAILABLE');queueMicrotask(()=>void this.stop().catch(()=>this.deps.warn('GROUP_STOP_FAILED')));return}
    const now=this.#clock.now(),account=this.deps.account()
    if(!account||!this.deps.connected()){this.#wake(1000);return}
    const policies=this.deps.policies(),base={ownerId:this.ownerId,epoch:this.epoch,now}
    let nextDelay=1000
    for(const room of this.core.readGroupSchedule().rooms) {
      const policy=policies.get(room.external_room_id)
      if(!policy)continue
      const window=this.#window(room),mono=this.#clock.monotonic?.()??this.#clock.now()
      const monoDue=Math.min(window.firstMono+policy.merge.maxWaitMs,window.lastMono+policy.merge.quietMs)
      if(monoDue>mono){nextDelay=Math.min(nextDelay,monoDue-mono);continue}
      const result=await this.core.groupSchedule({...base,kind:'seal',roomId:room.room_id,policy,accountKey:groupHash(account),transportId:'qq-onebot',provider:this.deps.provider,model:this.deps.model})
      if(result.status==='queued')this.counts.batchCreated++
      if(result.status==='overflow'&&result.counted){this.counts.queueOverflow++;this.deps.warn('GROUP_QUEUE_FULL')}
      if(result.status==='collecting')nextDelay=Math.min(nextDelay,Math.max(1,Number(result.due)-now))
      else if(result.status!=='overflow'&&result.status!=='deferred')this.#windows.delete(room.room_id)
      if(result.reason==='clock_regression')this.deps.warn('GROUP_CLOCK_REGRESSION')
      if(result.reason==='invalid_evidence'){this.counts.invalidEvidence++;this.deps.warn('GROUP_EVIDENCE_INVALID')}
    }
    const queue=this.core.readGroupSchedule().queued
    const rooms=[...new Set(queue.map(b=>b.room_id))].sort()
    const ordered=[...rooms.filter(r=>r>this.#lastRoom),...rooms.filter(r=>r<=this.#lastRoom)]
    for(const roomId of ordered) {
      if(!this.#active||this.#running.size>=4)break
      if(this.#running.has(roomId))continue
      const b=queue.find(item=>item.room_id===roomId)!
      let snapshot:ReturnType<Core['readGroupBatch']>
      try {
        const policy=policies.get(JSON.parse(b.policy_json).externalRoomId)
        if(!policy)continue
        const result=await this.core.groupSchedule({...base,kind:'claim',batchId:b.batch_id,policy})
        if(result.status!=='submitting'||result.claimed!==true||result.replayed)continue
        snapshot=this.core.readGroupBatch(b.batch_id)
      }catch{
        this.counts.invalidEvidence++;this.deps.warn('GROUP_EVIDENCE_INVALID')
        try{await this.core.groupSchedule({...base,kind:'finish',batchId:b.batch_id,reason:'invalid_evidence'})}catch{this.deps.warn('GROUP_SETTLEMENT_FAILED')}
        continue
      }
      this.#lastRoom=roomId;this.counts.turnStarted++
      const epoch=this.epoch
      const task=(async()=>{
        let quiescent=true
        try {quiescent=await this.deps.run(snapshot,{epoch,ownerId:this.ownerId,isActive:()=>this.ready&&this.epoch===epoch})!==false}
        catch {this.counts.turnIncomplete++;this.deps.warn('GROUP_TURN_FAILED')}
        if(!quiescent){this.counts.lifecycleUnresolved++;this.deps.warn('GROUP_LIFECYCLE_UNRESOLVED');return}
        if(this.#active&&this.epoch===epoch) {
          try {
            const intent=this.core.db.get<{state:string}>('SELECT state FROM room_reply_intents WHERE batch_id=?',[b.batch_id])
            if(intent?.state==='dispatching'||intent?.state==='prepared')await this.core.groupSchedule({...base,now:this.#clock.now(),kind:'settle-send',batchId:b.batch_id,outcome:intent.state==='dispatching'?'unknown':'cancelled',reason:'unsettled_turn'})
            await this.core.groupSchedule({...base,now:this.#clock.now(),kind:'finish',batchId:b.batch_id})
          }catch{quiescent=false;this.deps.warn('GROUP_SETTLEMENT_FAILED')}
        }
        if(quiescent)this.#running.delete(roomId)
        if(this.#active)void this.kick().catch(()=>this.deps.warn('GROUP_PUMP_FAILED'))
      })()
      this.#running.set(roomId,task)
    }
    if(this.#active)this.#wake(nextDelay)
  }
  stop():Promise<void> {
    if(this.#stopping)return this.#stopping
    if(!this.#active)return Promise.resolve()
    this.#active=false
    this.#stopping=(async()=>{
      if(this.#timer!==null){this.#clock.clearTimeout(this.#timer);this.#timer=null}
      // Close the durable epoch gate before awaiting any Host cancellation/teardown.
      try{await this.core.groupSchedule({kind:'stop',ownerId:this.ownerId,epoch:this.epoch,now:this.#clock.now()})}catch{this.deps.warn('GROUP_STOP_STATE_FAILED')}
      const quiet=await this.deps.cancel()
      if(!quiet){this.counts.lifecycleUnresolved++;this.deps.warn('GROUP_LIFECYCLE_UNRESOLVED');return} // retain the kernel lease
      await this.#pumping?.catch(()=>undefined)
      await Promise.allSettled([...this.#running.values()])
      await this.#lease?.release();this.#lease=null
    })()
    return this.#stopping
  }
}
