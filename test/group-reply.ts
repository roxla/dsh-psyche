import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Core,openDatabase,roomPolicy,groupPartsText,groupHash,createGroupProofAuthority} from '../packages/core/dist/index.js'
import {createGroupReplyConnection} from '../dist/lib/group-qq-reply.js'
let passed=0,failed=0
const eq=(label,a,b)=>{if(JSON.stringify(a)===JSON.stringify(b)){passed++;console.log(' ok '+label)}else{failed++;console.error(' FAIL '+label,{a,b})}}
const rejects=async(label,fn)=>{let no=false;try{await fn()}catch{no=true}eq(label,no,true)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
class Socket {
 static all=[];static mode='ok';static account='39999'
 listeners=new Map();actions=[]
 constructor(){Socket.all.push(this);queueMicrotask(()=>{this.emit('open');this.message({post_type:'meta_event',meta_event_type:'heartbeat',self_id:Socket.account,status:{good:true,online:true}})})}
 addEventListener(name,fn){this.listeners.set(name,[...(this.listeners.get(name)??[]),fn])}
 emit(name,value){for(const fn of this.listeners.get(name)??[])fn(value)}
 message(value){this.emit('message',{data:JSON.stringify(value)})}
 send(value){
  const rpc=JSON.parse(value);this.actions.push(rpc)
  const mode=Socket.mode,ack={echo:rpc.echo,status:'ok',retcode:0,data:{message_id:'ack-'+Socket.all.length}}
  queueMicrotask(()=>{
   if(mode==='drop')return
   if(mode==='disconnect'){this.emit('close');return}
   if(mode==='deny'||mode==='429'){this.message({...ack,status:'failed',retcode:mode==='429'?429:100,data:null});return}
   if(mode==='no-echo'){delete ack.echo;this.message(ack);return}
   if(mode==='missing-status'){delete ack.status;this.message(ack);return}
   if(mode==='missing-id'){ack.data={};this.message(ack);return}
   if(mode==='contradiction'){this.message({...ack,status:'failed'});return}
   if(mode==='wrong-echo'){this.message({...ack,echo:'foreign',data:{message_id:'wrong'}});setTimeout(()=>this.message(ack),5);return}
   this.message(ack)
  })
 }
 close(){this.emit('close')}
}
const connection=(active=()=>true,timeoutMs=70)=>createGroupReplyConnection({wsUrl:'ws://127.0.0.1:1',token:'fixture',account:'39999',groupId:'41001',active,timeoutMs,webSocket:Socket})
for(const [mode,outcome] of [['ok','sent'],['no-echo','sent'],['wrong-echo','sent'],['deny','failed'],['429','failed'],['drop','unknown'],['missing-status','unknown'],['contradiction','unknown'],['missing-id','sent']]) {
 Socket.mode=mode;const c=connection();eq(mode+' 握手验证账号',await c.connect(),true)
 const s=Socket.all.at(-1),r=await c.send('approved group reply')
 eq(mode+' 正确结果分类',r.outcome,outcome)
 eq(mode+' 一次动作且是群目标',[s.actions.length,s.actions[0]?.action,s.actions[0]?.params.group_id],[1,'send_group_msg',41001])
 eq(mode+' 连接不能复用',(await c.send('duplicate')).outcome,'cancelled')
 if(mode==='wrong-echo')eq('错误echo不能抢占成功ID',r.platformMessageId==='wrong',false)
 if(mode==='missing-id')eq('缺ID不伪造绑定',r.platformMessageId,undefined)
 await c.close()
}
{
 let live=true;Socket.mode='ok';const c=connection(()=>live);await c.connect();const s=Socket.all.at(-1);live=false
 eq('撤销代际后不发送',(await c.send('late')).outcome,'cancelled')
 eq('撤销后零网络动作',s.actions.length,0);await c.close()
}
{
 let sendPhase=false,calls=0
 const c=connection(()=>!sendPhase||++calls===1);await c.connect();const s=Socket.all.at(-1);sendPhase=true
 eq('最后同步围栏阻止竞态发送',(await c.send('race')).outcome,'cancelled')
 eq('最后围栏与socket.send之间无await',s.actions.length,0);await c.close()
}
{
 Socket.account='40000';const c=connection();eq('错发送账号握手失败',await c.connect(),false);await c.close();Socket.account='39999'
}
{
 Socket.mode='disconnect';const first=Socket.all.length,c=connection(()=>true,1200);await c.connect()
 const pending=c.send('one uncertain RPC');await sleep(1080)
 eq('未知发送连接不自动重连',Socket.all.length-first,1)
 eq('发送后断线unknown',(await pending).outcome,'unknown');await c.close()
}
{
 Socket.mode='drop';const old=connection();await old.connect();const oldSocket=Socket.all.at(-1);await old.send('old')
 const next=connection();await next.connect();const nextSocket=Socket.all.at(-1),sending=next.send('new')
 oldSocket.message({retcode:0,status:'ok',data:{message_id:'stale-no-echo'}})
 nextSocket.message({retcode:0,status:'ok',data:{message_id:'current-no-echo'}})
 eq('迟到无echo ACK不能跨连接结算',(await sending).platformMessageId,'current-no-echo');await next.close()
}
{
 const dir=mkdtempSync(join(tmpdir(),'psyche-group-send-')),{db}=await openDatabase({file:join(dir,'memory.sqlite3'),logger:{}})
 const core=new Core({db,config:{},logger:{},dataDir:dir}),authority=createGroupProofAuthority(),T=Date.parse('2026-11-14T04:00:00Z')
 let epoch=Number((await core.groupSchedule({kind:'start',ownerId:'owner',now:T})).epoch),now=T,mid=0
 const policy=roomPolicy({externalRoomId:'41001',names:['心灵'],reply:{enabled:true},silence:{timezone:'UTC'}})
 const cmd=(kind,extra={})=>core.groupSchedule({kind,ownerId:'owner',epoch,now,...extra})
 const incoming=async(parts,extra={})=>core.ingestGroupMessage({externalRoomId:'41001',stableUserId:'31001',selfId:'39999',messageId:'m'+(++mid),parts,text:groupPartsText(parts),policy,captureMode:policy.captureMode,schedulingReady:true,at:new Date(now).toISOString(),...extra})
 const prepare=async(text)=>{
  const r=await incoming([{type:'text',text:'心灵，新请求'}]);now+=2100
  const sealed=await cmd('seal',{roomId:r.roomId,policy,accountKey:groupHash('39999'),transportId:'qq-onebot',provider:'fixed',model:'m'}),id=sealed.batchId
  await cmd('claim',{batchId:id,policy});await cmd('bind-turn',{batchId:id,turn:1,step:1})
  const b=core.readGroupBatch(id).batch,base={batchId:id,epoch,sessionId:b.session_id,messageId:b.message_id,turn:1,step:1,attemptId:'a-'+id,provider:'fixed',model:'m',requestHash:groupHash('input'),projectionHash:b.projection_hash,full:true}
  await cmd('receipt',{batchId:id,proof:authority.issue({...base,kind:'input'})})
  await cmd('receipt',{batchId:id,proof:authority.issue({...base,kind:'finish',finish:'stop'})})
  await cmd('complete',{batchId:id,proof:authority.issue({...base,kind:'turn',finish:'completed',flush:true,endSeq:8,persistenceHash:groupHash('events'),assistantMessageId:'assistant-'+id,replyHash:groupHash(text)})})
  await cmd('prepare-reply',{batchId:id,text,hostMessageId:'assistant-'+id})
  return {id,roomId:r.roomId}
 }
 const first=await prepare('self response')
 await cmd('begin-send',{batchId:first.id,policy});await cmd('settle-send',{batchId:first.id,outcome:'sent',platformMessageId:'-123'});await cmd('finish',{batchId:first.id})
 eq('成功ID绑定引用已有self Source',db.get('SELECT COUNT(*) AS n FROM room_reply_bindings b JOIN sources s ON s.source_id=b.source_id WHERE s.origin=? AND s.message_id IS NULL',['self']).n,1)
 const ref=await incoming([{type:'reply',id:'-123'},{type:'text',text:'请接着回答'}],{replyToMessageId:'-123'})
 eq('可信真实ID引用首次保留且唤醒',[ref.retained,db.get('SELECT state FROM room_triggers WHERE room_id=? AND room_seq=?',[ref.roomId,ref.roomSeq]).state],[true,'armed'])
 eq('他账号同ID不能引用',(await incoming([{type:'reply',id:'-123'},{type:'text',text:'wrong account'}],{replyToMessageId:'-123',selfId:'40000'})).retained,false)
 const foreign=roomPolicy({...policy,policyHash:undefined,externalRoomId:'41002'})
 eq('他群同ID不能引用',(await incoming([{type:'reply',id:'-123'},{type:'text',text:'wrong room'}],{externalRoomId:'41002',replyToMessageId:'-123',policy:foreign})).retained,false)
 await core.capture({platform:'qq',channel:'group',roomId:first.roomId,origin:'self',messageId:'legacy',text:'old fixture'})
 const legacy=await incoming([{type:'reply',id:'legacy'},{type:'text',text:'legacy reference'}],{replyToMessageId:'legacy'})
 eq('旧self引用仅保留采集兼容',legacy.retained,true)
 eq('旧self不能授予唤醒',db.get('SELECT COUNT(*) AS n FROM room_triggers WHERE room_id=? AND room_seq=?',[legacy.roomId,legacy.roomSeq]).n,0)
 await rejects('delivery binding不可改',()=>db.run("UPDATE room_reply_bindings SET platform_message_id='forged'"))
 await rejects('delivery binding不可删',()=>db.run('DELETE FROM room_reply_bindings'))
 await rejects('intent正文hash不可改',()=>db.run("UPDATE room_reply_intents SET text_hash='forged'"))
 await rejects('输入证明不可改',()=>db.run("UPDATE room_input_receipts SET receipt_json='{}'"))
 const crash=await prepare('crash candidate');await cmd('begin-send',{batchId:crash.id,policy})
 epoch=Number((await cmd('start')).epoch)
 eq('崩溃在途恢复unknown',db.get('SELECT state FROM room_reply_intents WHERE batch_id=?',[crash.id]).state,'unknown')
 eq('恢复不产生第二intent',db.get('SELECT COUNT(*) AS n FROM room_reply_intents WHERE batch_id=?',[crash.id]).n,1)
 eq('unknown没有可信self绑定',db.get('SELECT COUNT(*) AS n FROM room_reply_bindings b JOIN room_reply_intents i ON i.intent_id=b.intent_id WHERE i.batch_id=?',[crash.id]).n,0)
 await rejects('unknown不可重新begin-send',()=>cmd('begin-send',{batchId:crash.id,policy}))
 db.close()
}
console.log(`[P4-D-2 group-reply] ${passed} 通过 ${failed} 失败`)
if(failed)process.exitCode=1
