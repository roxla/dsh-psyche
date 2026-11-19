import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Core,openDatabase,roomPolicy,groupHash} from '../packages/core/dist/index.js'
import {GroupInputBoundary} from '../dist/lib/group-input-boundary.js'
import {GroupHostTurns} from '../dist/lib/group-host-turn.js'
let passed=0,failed=0
const eq=(name,a,b)=>{if(JSON.stringify(a)===JSON.stringify(b)){passed++;console.log(' ok '+name)}else{failed++;console.error(' FAIL '+name,{a,b})}}
const flush=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r))}
const T=Date.parse('2026-11-14T04:00:00Z')
async function env(){
 const dir=mkdtempSync(join(tmpdir(),'psyche-group-host-turn-')),{db}=await openDatabase({file:join(dir,'memory.sqlite3'),logger:{}})
 const core=new Core({db,config:{},logger:{},dataDir:dir}),ownerId='host-fixture',{epoch}=await core.groupSchedule({kind:'start',ownerId,now:T})
 const policy=roomPolicy({externalRoomId:'41001',names:['心灵'],reply:{enabled:true},silence:{timezone:'UTC'}})
 const row=await core.ingestGroupMessage({externalRoomId:'41001',stableUserId:'31001',selfId:'39999',messageId:'m',text:'心灵，真实完成信号',parts:[{type:'text',text:'心灵，真实完成信号'}],policy,captureMode:policy.captureMode,schedulingReady:true,at:new Date(T).toISOString()})
 const cmd=(kind,extra={})=>core.groupSchedule({kind,ownerId,epoch,now:T+2000,...extra})
 const {batchId}=await cmd('seal',{roomId:row.roomId,policy,accountKey:groupHash('39999'),transportId:'qq-onebot',provider:'fixed',model:'m'})
 await cmd('claim',{batchId,policy});const snapshot=core.readGroupBatch(batchId)
 const listeners=new Map(),events=[],calls={followup:0,cancel:0,clear:0,dispose:0,send:0,flush:0,closeRead:0},guards=[]
 let live=true,flushResult=true,flushError=false,omitEnd=false,agent,seq=0
 const idleResolvers=[]
 const host={
  on(name,fn){listeners.set(name,fn);return()=>listeners.delete(name)},
  agents:{get:()=>agent,resume:async()=>{throw Error('not found')},create:async()=>{
   agent={id:snapshot.batch.session_id,status:'idle',session:{id:snapshot.batch.session_id},inbox:{hasPending:true,clear(){calls.clear++;this.hasPending=false}},
    ctx:{tools:{schemas:()=>[{name:'psyche_recall'},{name:'psyche_fetch'},{name:'send_group_msg'}],restrict:()=>()=>{},guard:fn=>{guards.push(fn);return()=>{}},presentAs:()=>()=>{}}},
    followup(message){calls.followup++;this.input=message;this.status='running'},
    cancel(){calls.cancel++;this.idle()},
    whenIdle(){return this.status==='idle'?Promise.resolve():new Promise(r=>idleResolvers.push(r))},
    idle(){this.status='idle';for(const r of idleResolvers.splice(0))r()},
   }
   return {agent,dispose:async()=>{calls.dispose++;agent.idle();agent=undefined}}
  }},
  sessions:{flush:async()=>{calls.flush++;if(flushError)throw Error('flush error');return flushResult}},
  persistence:{open:()=>({read:(offset,length)=>({events:events.filter(e=>!omitEnd||e.type!=='turn/end').slice(offset,offset+length)}),close(){calls.closeRead++}})},
 }
 const boundary=new GroupInputBoundary('fixed','m')
 const turns=new GroupHostTurns(core,host,boundary,{announce(){},bound:()=>true,warn(){},now:()=>T+2000,
  recoveryPolicy:()=>policy,
  send:async(_s,_text,active)=>{if(!active())return {outcome:'cancelled'};await cmd('begin-send',{batchId,policy});calls.send++;return {outcome:'sent',platformMessageId:'real-fixture-id'}},
 })
 const emit=(type,data)=>{const event={type,data,seq:++seq,time:new Date(T).toISOString()};events.push(event);listeners.get('session/event')?.(agent?.session??{id:snapshot.batch.session_id},event);return event}
 const start=async()=>{
  const pending=turns.run(snapshot,{ownerId,epoch,isActive:()=>live});await flush();return {pending}
 }
 const request=async()=>{
  const decision=await listeners.get('agent/pre-step')({agent,messages:[agent.input],turn:1,step:1},async()=>({kind:'enter',messages:[agent.input]}))
  if(decision.kind!=='enter')throw Error('unexpected rejection')
  emit('user/message',agent.input)
  const stream=boundary.wrap(async function*(){yield {type:'finish',reason:{kind:'stop'}}})
  for await(const chunk of stream({sessionId:snapshot.batch.session_id,provider:'fixed',model:'m',messages:[agent.input],tools:[{name:'psyche_recall'}]})){}
  emit('assistant/message',{turn:1,step:1,message:{id:'assistant',role:'assistant',source:{kind:'model'},content:[{type:'text',text:'final text'}]}})
 }
 return {db,core,turns,host,calls,guards,cmd,snapshot,start,request,emit,events,policy,agent:()=>agent,setFlush:v=>{flushResult=v},setFlushError:v=>{flushError=v},setOmitEnd:v=>{omitEnd=v},stopLive:()=>{live=false},close:async()=>{await turns.close();db.close()}}
}
{
 const e=await env(),{pending}=await e.start();let resolved=false;pending.then(()=>{resolved=true})
 eq('followup返回不表示Turn完成',[e.calls.followup,resolved,e.calls.send],[1,false,0])
 await e.request()
 e.emit('step/end',{turn:1,step:1});await flush()
 eq('step结束和模型stop不提前发群回复',e.calls.send,0)
 e.emit('turn-stopping',{turn:1,step:1});await flush();eq('turn-stopping不释放Turn',resolved,false)
 e.emit('turn/end',{turn:99,reason:{kind:'completed'}});await flush();eq('别的Turn结束不匹配',resolved,false)
 e.emit('turn/end',{turn:1,reason:{kind:'completed'}});await flush()
 eq('正常Turn与刷盘后发送一次',e.calls.send,1)
 eq('尚未真正idle不释放Room',resolved,false)
 eq('处理确认已经独立落库',e.db.get('SELECT read_through_seq FROM room_participation_state').read_through_seq,1)
 eq('公共Inbox接口清旧输入',e.calls.clear,1)
 eq('平台发送工具最终守卫拒绝',e.guards[0]({name:'send_group_msg'}),'GROUP_TOOL_DENIED')
 eq('旧fetch最终守卫拒绝',e.guards[0]({name:'psyche_fetch'}),'GROUP_TOOL_DENIED')
 e.agent().idle();eq('真实静止后结束',await pending,true)
 await e.cmd('finish',{batchId:e.snapshot.batch.batch_id});await e.close()
 eq('拥有的AgentHandle在关闭时dispose',e.calls.dispose,1)
}
for(const reason of ['aborted','blocked','error','max-tokens','interrupted']){
 const e=await env(),{pending}=await e.start();await e.request();e.emit('turn/end',{turn:1,reason:{kind:reason}})
 eq(reason+' 可取消并收敛',await pending,true)
 eq(reason+' 不发送',e.calls.send,0)
 eq(reason+' 不确认正文',e.db.get("SELECT COUNT(*) AS n FROM room_seq_confirmations WHERE disposition='model_processed'").n,0)
 await e.close()
}
for(const mode of ['false','throw','missing-end']){
 const e=await env(),{pending}=await e.start();await e.request()
 if(mode==='false')e.setFlush(false);if(mode==='throw')e.setFlushError(true);if(mode==='missing-end')e.setOmitEnd(true)
 e.emit('turn/end',{turn:1,reason:{kind:'completed'}})
 eq(mode+' 完成证据不足时安全结束',await pending,true)
 eq(mode+' 不发消息不推进',[e.calls.send,e.db.get('SELECT read_through_seq FROM room_participation_state').read_through_seq],[0,0])
 await e.close()
}
{
 const e=await env(),{pending}=await e.start();await e.request();e.stopLive();await e.turns.close()
 eq('卸载旧代零迟到发送',e.calls.send,0)
 eq('卸载等待活动收敛',await pending,true)
 e.db.close()
}
{
 const e=await env(),{pending}=await e.start();await e.request()
 // Persist the completed event while the old integration is already fenced, as on a crash.
 e.stopLive();e.emit('turn/end',{turn:1,reason:{kind:'completed'}});await e.turns.close();await pending
 eq('崩溃窗口尚未确认',e.db.get('SELECT read_through_seq FROM room_participation_state').read_through_seq,0)
 const {epoch}=await e.core.groupSchedule({kind:'start',ownerId:'recovery-fixture',now:T+3000})
 const recovery=new GroupHostTurns(e.core,e.host,new GroupInputBoundary('fixed','m'),{announce(){},bound:()=>true,warn(){},now:()=>T+3000,recoveryPolicy:()=>e.policy,send:async()=>{throw Error('recovery must never send')}})
 const before=e.calls.followup
 await recovery.recover({ownerId:'recovery-fixture',epoch,isActive:()=>true})
 eq('Host刷盘与完成日志允许恢复确认',e.db.get('SELECT read_through_seq FROM room_participation_state').read_through_seq,1)
 eq('恢复不再次提交也不发送',[e.calls.followup-before,e.calls.send],[0,0])
 eq('恢复过程使用并关闭持久日志读取句柄',e.calls.closeRead,1)
 await recovery.close();e.db.close()
}
console.log(`[P4-D-2 group-host-turn] ${passed} 通过 ${failed} 失败`)
if(failed)process.exitCode=1
