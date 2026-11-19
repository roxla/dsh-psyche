import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Core,openDatabase,roomPolicy,groupPartsText,groupHash,createGroupProofAuthority} from '../packages/core/dist/index.js'
import {GroupInputBoundary} from '../dist/lib/group-input-boundary.js'
let passed=0,failed=0
const eq=(name,a,b)=>{if(JSON.stringify(a)===JSON.stringify(b)){passed++;console.log(' ok '+name)}else{failed++;console.error(' FAIL '+name,{a,b})}}
const rejects=async(name,fn)=>{let no=false;try{await fn()}catch{no=true}eq(name,no,true)}
const T=Date.parse('2026-11-14T04:00:00Z')
const p=roomPolicy({externalRoomId:'41001',silence:{timezone:'UTC'},names:['心灵'],reply:{enabled:true}})
const authority=createGroupProofAuthority()
async function env(policy=p){
 const dir=mkdtempSync(join(tmpdir(),'psyche-group-proof-')),{db}=await openDatabase({file:join(dir,'memory.sqlite3'),logger:{}})
 const core=new Core({db,config:{},logger:{},dataDir:dir}),ownerId='fixture-owner'
 const {epoch}=await core.groupSchedule({kind:'start',ownerId,now:T})
 let now=T,serial=0
 const cmd=(kind,extra={})=>core.groupSchedule({kind,ownerId,epoch,now,...extra})
 const ingest=async(text,extra={})=>core.ingestGroupMessage({externalRoomId:policy.externalRoomId,stableUserId:'31001',messageId:'m'+(++serial),selfId:'39999',parts:[{type:'text',text}],text,policy,captureMode:policy.captureMode,schedulingReady:true,at:new Date(now).toISOString(),...extra})
 const seal=async(roomId,override=policy)=>{now+=2100;const r=await cmd('seal',{roomId,policy:override,accountKey:groupHash('39999'),transportId:'qq-onebot',provider:'fixed',model:'test'});return r.batchId}
 const claim=async(batchId,override=policy)=>{await cmd('claim',{batchId,policy:override});await cmd('bind-turn',{batchId,turn:1,step:0});return core.readGroupBatch(batchId)}
 return {core,db,cmd,ingest,seal,claim,epoch,ownerId,now:()=>now}
}
async function request(e,s,overrides={},finish='stop'){
 const boundary=new GroupInputBoundary('fixed','test')
 const off=boundary.bind(s,1,0,()=>true,async proof=>{await e.cmd('receipt',{batchId:s.batch.batch_id,proof})})
 let saw=null
 const stream=boundary.wrap(async function*(options){saw=options;yield {type:'finish',reason:{kind:finish}}})
 const opts={sessionId:s.batch.session_id,provider:'fixed',model:'test',messages:[{id:s.batch.message_id,role:'user',source:{kind:'user'},content:[{type:'text',text:s.projection}]}],...overrides}
 for await(const ignored of stream(opts)){}
 off()
 return {last:boundary.last(s.batch.batch_id),saw,opts}
}
const complete=(e,s,last,extra={})=>e.cmd('complete',{batchId:s.batch.batch_id,proof:authority.issue({...last,kind:'turn',finish:'completed',flush:true,endSeq:8,persistenceHash:groupHash('durable-events'),...extra})})
{
 const e=await env()
 const one=await e.ingest('普通群聊：不保留'),two=await e.ingest('心灵，第二条'),three=await e.ingest('第三条普通'),four=await e.ingest('心灵，第四条')
 const id=await e.seal(one.roomId),s=await e.claim(id)
 eq('mixed seq只投影2/4',s.members.map(m=>m.room_seq),[2,4])
 eq('不伪造省略正文',[s.projection.includes('不保留'),s.projection.includes('第三条普通')],[false,false])
 eq('omitted前缀先确认',e.core.readGroupIntake(one.roomId).state.read_through_seq,1)
 await rejects('普通对象伪造已读证明被拒',()=>e.cmd('complete',{batchId:id,proof:{full:true,finish:'completed',flush:true}}))
 eq('拒绝写入记账',e.db.get("SELECT COUNT(*) AS n FROM operations WHERE status='failed'").n,1)
 await rejects('投影截断无回执',()=>request(e,s,{messages:[{id:s.batch.message_id,role:'user',content:[{type:'text',text:s.projection.slice(0,-1)}]}]}))
 eq('截断不推进',e.core.readGroupIntake(one.roomId).state.read_through_seq,1)
 await rejects('别的provider拒绝',()=>request(e,s,{provider:'other'}))
 await rejects('不允许平台发送工具进入请求',()=>request(e,s,{tools:[{name:'send_group_msg'}]}))
 await rejects('缺少Room校验的旧fetch不进入群请求',()=>request(e,s,{tools:[{name:'psyche_fetch'}]}))
 const q=await request(e,s)
 eq('实际Adapter输入深冻结',[Object.isFrozen(q.saw.messages),Object.isFrozen(q.saw.messages[0].content)],[true,true])
 q.opts.messages[0].content[0].text='后来篡改外层原数组'
 eq('外层迟改不改变实收',q.saw.messages[0].content[0].text,s.projection)
 await rejects('没有持久化参与者不确认',()=>complete(e,s,q.last,{flush:false}))
 await rejects('异常结束不确认',()=>complete(e,s,q.last,{finish:'max-tokens'}))
 await rejects('换Room/批次的证明不确认',()=>complete(e,s,q.last,{batchId:'foreign'}))
 await complete(e,s,q.last,{assistantMessageId:'a1',replyHash:groupHash('回复正文')})
 eq('完整后连续水位4',e.core.readGroupIntake(one.roomId).state.read_through_seq,4)
 eq('省略与展示分别留证',e.db.all('SELECT room_seq,disposition FROM room_seq_confirmations ORDER BY room_seq'),[{room_seq:1,disposition:'policy_omitted'},{room_seq:2,disposition:'model_processed'},{room_seq:3,disposition:'policy_omitted'},{room_seq:4,disposition:'model_processed'}])
 eq('调度表无原文副本',JSON.stringify(e.db.all('SELECT * FROM room_input_receipts')).includes('第二条'),false)
 await rejects('改回复正文不能继承证明',()=>e.cmd('prepare-reply',{batchId:id,text:'改过正文',hostMessageId:'a1'}))
 const intent=await e.cmd('prepare-reply',{batchId:id,text:'回复正文',hostMessageId:'a1'})
 eq('只存一条self正文',e.db.get("SELECT COUNT(*) AS n FROM sources WHERE origin='self'").n,1)
 eq('候选还不是成功self绑定',e.db.get('SELECT COUNT(*) AS n FROM room_reply_bindings').n,0)
 await e.cmd('begin-send',{batchId:id,policy:p})
 await rejects('同批不能再次调用发送',()=>e.cmd('begin-send',{batchId:id,policy:p}))
 await e.cmd('settle-send',{batchId:id,outcome:'unknown',reason:'ack_lost'})
 await e.cmd('finish',{batchId:id})
 eq('unknown不妨碍已处理水位',e.core.readGroupIntake(one.roomId).state.read_through_seq,4)
 eq('unknown保持独立终态',e.db.get('SELECT state FROM room_reply_intents WHERE intent_id=?',[intent.intentId]).state,'unknown')
 eq('运营结果不含回复正文',JSON.stringify(e.db.all('SELECT result FROM operations')).includes('回复正文'),false)
 await e.cmd('start')
 eq('重启不把unknown变pending',e.db.get('SELECT state FROM room_reply_intents').state,'unknown')
 await rejects('旧代迟到写入被拒',()=>e.cmd('finish',{batchId:id}))
 e.db.close()
}
{
 const short=roomPolicy({...p,policyHash:undefined,merge:{...p.merge,maxMessages:1}}),e=await env(short)
 const one=await e.ingest('一'),two=await e.ingest('心灵，缺口2'),three=await e.ingest('三')
 const a=await e.seal(one.roomId),sa=await e.claim(a)
 await request(e,sa,{},'max-tokens')
 await e.cmd('finish',{batchId:a,reason:'max_tokens'})
 const four=await e.ingest('心灵，先处理4'),b=await e.seal(one.roomId),sb=await e.claim(b)
 eq('失败成员不抢占新触发预算',sb.members.map(m=>m.room_seq),[4])
 const rb=await request(e,sb);await complete(e,sb,rb.last);await e.cmd('finish',{batchId:b})
 eq('4成功但水位停1',e.core.readGroupIntake(one.roomId).state.read_through_seq,1)
 eq('实际4的独立证明存在',e.db.get("SELECT COUNT(*) AS n FROM room_seq_confirmations WHERE room_seq=4 AND disposition='model_processed'").n,1)
 const long=roomPolicy({...p,policyHash:undefined,merge:{...p.merge,maxMessages:2}})
 await e.ingest('心灵，新触发带入旧缺口',{policy:long})
 const c=await e.seal(one.roomId,long),sc=await e.claim(c,long)
 eq('新触发可带旧缺口且不重选已确认4',sc.members.map(m=>m.room_seq),[2,5])
 const rc=await request(e,sc);await complete(e,sc,rc.last);await e.cmd('finish',{batchId:c})
 eq('补齐后水位5',e.core.readGroupIntake(one.roomId).state.read_through_seq,5)
 e.db.close()
}
{
 const e=await env(),inbound=await e.ingest('心灵，有证据'),id=await e.seal(inbound.roomId),s=await e.claim(id)
 e.db.run('INSERT INTO quarantined_sources(source_id,reason,quarantined_at) VALUES(?,?,?)',[inbound.sourceId,'test',new Date(T).toISOString()])
 await rejects('隔离Source不冒充omitted/processed',()=>request(e,s))
 eq('隔离证据水位不推进',e.core.readGroupIntake(inbound.roomId).state.read_through_seq,0)
 e.db.close()
}
{
 const policy=roomPolicy({...p,policyHash:undefined,captureMode:'all_visible_messages'}),e=await env(policy)
 let roomId
 for(let i=0;i<21;i++)roomId=(await e.ingest('心灵，第'+i+'条')).roomId
 const id=await e.seal(roomId),s=e.core.readGroupBatch(id)
 eq('单批最多20整条消息',s.members.length,20)
 eq('snapshotLastSeq不冒充实际展示',s.batch.snapshot_last_seq,21)
 eq('第21条仍是未消费触发',e.db.get("SELECT state FROM room_triggers WHERE room_id=? AND room_seq=21",[roomId]).state,'armed')
 eq('所有已选正文完整保留',s.members.every(m=>s.projection.includes(m.text)),true)
 e.db.close()
}
{
 const e=await env(),text='心灵，'+'😀'.repeat(3000),r=await e.ingest(text),id=await e.seal(r.roomId),s=e.core.readGroupBatch(id)
 eq('码点预算不按UTF16误截emoji',[s.projection.length>4000,[...s.projection].length<=4000],[true,true])
 eq('emoji原文完整一致',s.members[0].text,text)
 e.db.close()
}
{
 const e=await env(),r=await e.ingest('心灵，'+'x'.repeat(5000));await e.seal(r.roomId)
 eq('单条超预算不启动空快照',e.core.readGroupSchedule().queued.length,0)
 eq('超长触发明确处置',e.db.get('SELECT reason FROM room_triggers').reason,'oversize')
 eq('超长仍保留Source不误确认',[e.db.get('SELECT COUNT(*) AS n FROM sources').n,e.core.readGroupIntake(r.roomId).state.read_through_seq],[1,0])
 e.db.close()
}
{
 const policy=roomPolicy({...p,policyHash:undefined,captureMode:'all_visible_messages'}),e=await env(policy)
 const old=await e.ingest('x'.repeat(3990));await e.ingest('心灵，必须放入的新触发')
 const id=await e.seal(old.roomId),s=await e.claim(id)
 eq('为触发预留包装预算，旧大上下文未展示',s.members.map(m=>m.room_seq),[2])
 const q=await request(e,s);await complete(e,s,q.last)
 eq('未展示的旧正文不推进水位',e.core.readGroupIntake(old.roomId).state.read_through_seq,0)
 e.db.close()
}
{
 const e=await env(),r=await e.ingest('心灵，完成已刷盘但未确认'),id=await e.seal(r.roomId),s=await e.claim(id)
 const q=await request(e,s)
 const {epoch}=await e.core.groupSchedule({kind:'start',ownerId:'recovered-owner',now:e.now()+1})
 const proof=authority.issue({...q.last,kind:'turn',finish:'completed',flush:true,endSeq:10,persistenceHash:groupHash('persisted-completed-turn')})
 const reconcile=(extra={})=>e.core.groupSchedule({kind:'reconcile',ownerId:'recovered-owner',epoch,now:e.now()+2,batchId:id,policy:p,proof,...extra})
 await rejects('恢复不能用普通对象冒充Host证据',()=>reconcile({proof:{...q.last,finish:'completed'}}))
 await rejects('恢复不能改审批过的群策略',()=>reconcile({policy:roomPolicy({...p,policyHash:undefined,names:['另一个名字']})}))
 await reconcile()
 eq('跨代仅凭完整持久证据补确认',e.core.readGroupIntake(r.roomId).state.read_through_seq,1)
 eq('恢复已完成批次不重新排队',e.db.get('SELECT state FROM room_batches WHERE batch_id=?',[id]).state,'completed')
 eq('补确认不生成回复意图',e.db.get('SELECT COUNT(*) AS n FROM room_reply_intents').n,0)
 await rejects('补确认后的旧代仍不能发送',()=>e.cmd('prepare-reply',{batchId:id,text:'迟到发送',hostMessageId:'late'}))
 e.db.close()
}
console.log(`[P4-D-2 group-input-proof] ${passed} 通过 ${failed} 失败`)
if(failed)process.exitCode=1
