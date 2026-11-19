import {groupHash,groupRoomPolicies,groupSilenced,type Core,type RoomPolicy} from 'dsh-psyche-core'
import {GroupScheduler} from './group-scheduler.js'
import {GroupHostTurns} from './group-host-turn.js'
import {isGroupInputBoundary} from './group-input-boundary.js'
import {createGroupReplyConnection} from './group-qq-reply.js'
import type {QqBridge} from './qq-bridge.js'

export interface QqGroupRuntimeOptions {
  core:Core;host:any;bridge:QqBridge
  groups:unknown;provider:string;model:string;cwd?:string
  announce(snapshot:ReturnType<Core['readGroupBatch']>):void
  bound(sessionId:string,roomId:string):boolean
  forget(sessionId:string):void
  warn(code:string):void
  active?():boolean
}
/** Absent/foreign proof Producer means capture-only, before any Agent is created. */
export async function startQqGroupRuntime(options:QqGroupRuntimeOptions):Promise<GroupScheduler|null> {
  const {core,host,bridge}=options
  const get=(name:string)=>typeof host.get==='function'?host.get(name,true):host[name]
  const boundary=get('psycheGroupInputProof')
  const agents=get('agents'),sessionsApi=get('sessions'),persistence=get('sessionPersistence')
  if(![...groupRoomPolicies(options.groups).values()].some(p=>p.reply.enabled))return null
  if(!isGroupInputBoundary(boundary,options.provider,options.model)||!agents||!sessionsApi?.flush||!persistence){options.warn('GROUP_PROOF_UNAVAILABLE');return null}
  const connections=new Set<ReturnType<typeof createGroupReplyConnection>>()
  const sessions=new Set<string>()
  const policies=()=>groupRoomPolicies(options.groups)
  let scheduler:GroupScheduler
  const turns=new GroupHostTurns(core,{agents,on:host.on.bind(host),sessions:sessionsApi,persistence},boundary,{
    announce(snapshot){sessions.add(snapshot.batch.session_id);options.announce(snapshot)},
    bound:options.bound,cwd:options.cwd,warn:options.warn,
    recoveryPolicy(snapshot){
      const p=policies().get(JSON.parse(snapshot.batch.policy_json).externalRoomId)
      return p?.reply.enabled&&p.policyHash===snapshot.batch.policy_hash&&core.db.get('SELECT 1 FROM rooms WHERE room_id=? AND active=1',[snapshot.batch.room_id])?p:null
    },
    async send(snapshot,text,live) {
      const b=snapshot.batch,account=bridge.adminSnapshot().selfId,endpoint=bridge.replyEndpoint()
      const policy=policies().get(JSON.parse(b.policy_json).externalRoomId)
      const active=()=>live()&&scheduler.active&&bridge.transportStatus()==='connected'&&bridge.adminSnapshot().selfId===account&&!!account&&groupHash(account)===b.account_key&&
        !!policy&&policies().get(policy.externalRoomId)?.policyHash===b.policy_hash&&!groupSilenced(policy,Date.now())&&!!core.db.get('SELECT 1 FROM rooms WHERE room_id=? AND active=1',[b.room_id])
      if(!account||!endpoint||!policy||!active()||text.length>8000)return {outcome:'cancelled',reason:'send_gate_or_oversize'}
      const connection=createGroupReplyConnection({...endpoint,account,groupId:policy.externalRoomId,active})
      connections.add(connection)
      try {
        if(!await connection.connect())return {outcome:'cancelled',reason:'connection_not_ready'}
        if(!active())return {outcome:'cancelled',reason:'stale_epoch'}
        await core.groupSchedule({kind:'begin-send',ownerId:scheduler.ownerId,epoch:scheduler.epoch,now:Date.now(),batchId:b.batch_id,policy})
        return await connection.send(text)
      }finally{connections.delete(connection);await connection.close()}
    },
  })
  scheduler=new GroupScheduler(core,{
    policies,account:()=>bridge.adminSnapshot().selfId,connected:()=>bridge.transportStatus()==='connected',available:()=>options.active?.()!==false&&get('psycheGroupInputProof')===boundary,provider:options.provider,model:options.model,
    recover:context=>turns.recover(context),
    run:(snapshot,context)=>turns.run(snapshot,context),warn:options.warn,
    async cancel(){
      await Promise.allSettled([...connections].map(c=>c.close()))
      const quiet=await turns.close()
      if(quiet)for(const id of sessions)options.forget(id)
      return quiet
    },
  })
  try{await scheduler.start();return scheduler}catch(error){await turns.close();throw error}
}
