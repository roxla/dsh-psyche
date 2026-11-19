import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Core,openDatabase,roomPolicy,groupCanonical,groupHash,createGroupProofAuthority} from '../packages/core/dist/index.js'
import {GroupInputBoundary} from '../dist/lib/group-input-boundary.js'
import {createProductionGroupInputProof,detectCallBoundaryHost} from '../dist/lib/group-production-proof.js'
let passed=0,failed=0
const eq=(name,a,b)=>{if(JSON.stringify(a)===JSON.stringify(b)){passed++;console.log(' ok '+name)}else{failed++;console.error(' FAIL '+name,{a,b})}}
async function rejects(name,fn,code){let msg='';try{await fn()}catch(e){msg=String((e as Error).message)}eq(name,msg,code)}
async function collect(iterable){const out=[];for await(const chunk of iterable)out.push(chunk);return out}
const T=Date.parse('2026-11-14T04:00:00Z')
const policy=roomPolicy({externalRoomId:'41021',silence:{timezone:'UTC'},names:['心灵'],reply:{enabled:true}})
const authority=createGroupProofAuthority()
async function env(){
 const dir=mkdtempSync(join(tmpdir(),'psyche-proof-prod-')),{db}=await openDatabase({file:join(dir,'memory.sqlite3'),logger:{}})
 const core=new Core({db,config:{},logger:{},dataDir:dir}),ownerId='fixture-owner'
 const {epoch}=await core.groupSchedule({kind:'start',ownerId,now:T})
 let now=T,serial=0
 const cmd=(kind,extra={})=>core.groupSchedule({kind,ownerId,epoch,now,...extra})
 const ingest=async(text)=>core.ingestGroupMessage({externalRoomId:policy.externalRoomId,stableUserId:'31001',messageId:'m'+(++serial),selfId:'39999',parts:[{type:'text',text}],text,policy,captureMode:policy.captureMode,schedulingReady:true,at:new Date(now).toISOString()})
 const seal=async(roomId)=>{now+=2100;const r=await cmd('seal',{roomId,policy,accountKey:groupHash('39999'),transportId:'qq-onebot',provider:'fixed',model:'test'});return r.batchId}
 const claim=async(batchId)=>{await cmd('claim',{batchId,policy});await cmd('bind-turn',{batchId,turn:1,step:0});return core.readGroupBatch(batchId)}
 return {core,db,cmd,ingest,seal,claim,epoch}
}
function hostFixture(){
 const calls=[];let disposals=0
 const host={registerCallBoundary(providers,boundary){calls.push({providers,boundary});return ()=>{disposals++}}}
 return {host,calls,disposals:()=>disposals}
}
const boundary=()=>new GroupInputBoundary('fixed','test')
const optsFor=(s,extra={})=>({sessionId:s.batch.session_id,provider:'fixed',model:'test',messages:[{id:s.batch.message_id,role:'user',source:{kind:'user'},content:[{type:'text',text:s.projection}]}],...extra})
function bind(boundary,e,s,active=()=>true,turn=1,step=0){
 return boundary.bind(s,turn,step,active,async(proof)=>{await e.cmd('receipt',{batchId:s.batch.batch_id,proof})})
}
function* finishStream(kind='stop'){yield {type:'text',text:'ignored'};yield {type:'finish',reason:{kind}}}
async function drive(boundary,opts,stream){return collect(boundary.wrapFinal(opts,()=>stream))}
const receipts=(e,kind)=>e.db.get('SELECT COUNT(*) AS n FROM room_input_receipts WHERE kind=?',[kind]).n
const receiptOf=(e,kind)=>JSON.parse(e.db.get('SELECT receipt_json FROM room_input_receipts WHERE kind=?',[kind]).receipt_json)
const expectedHash=(opts)=>{const messages=structuredClone(opts.messages);return groupHash(groupCanonical(JSON.parse(JSON.stringify({version:1,messages,system:opts.system??null}))))}

// P-01 非群请求：原样放行，不产生回执。
{
 const e=await env(),f=hostFixture()
 const created=createProductionGroupInputProof({llm:f.host,provider:'fixed',model:'test'})
 let calls=0
 const adapter=f.calls[0].boundary
 const chunks=await collect(adapter.stream({sessionId:'qq-private-10001',provider:'fixed',model:'test',messages:[{role:'user',content:[{type:'text',text:'hi'}]}]},()=>{calls++;return finishStream()}))
 eq('P01 非群请求原样放行',chunks.map(c=>c.type),['text','finish'])
 eq('P01 next 调用一次',calls,1)
 eq('P01 无回执',[receipts(e,'input'),receipts(e,'finish')],[0,0])
 eq('P01 boundary 存在',created.boundary!==null,true)
 e.db.close()
}

// P-02 群 Session 未绑定：拒绝且不调用 Adapter。
{
 const e=await env(),b=boundary()
 await rejects('P02 群Session未绑定拒绝',()=>drive(b,{sessionId:'qq-group-unknown',provider:'fixed',model:'test',messages:[]},finishStream()),'GROUP_INPUT_NOT_ARMED')
 eq('P02 无回执',receipts(e,'input'),0)
 e.db.close()
}

// P-03 已绑定的辅助调用（compaction/session-title）：放行且不产生回执。
{
 const e=await env(),r=await e.ingest('心灵，第三条'),id=await e.seal(r.roomId),s=await e.claim(id),b=boundary()
 bind(b,e,s)
 const chunks=await drive(b,optsFor(s,{purpose:'compaction'}),finishStream())
 eq('P03 辅助调用放行',chunks.map(c=>c.type),['text','finish'])
 eq('P03 辅助调用不产生回执',[receipts(e,'input'),receipts(e,'finish')],[0,0])
 eq('P03 批次仍 running',e.db.get('SELECT state FROM room_batches WHERE batch_id=?',[id]).state,'running')
 e.db.close()
}

// P-04 精确投影：生成 input 回执，hash 与 canonical 一致，next 单次无参。
{
 const e=await env(),r=await e.ingest('心灵，第四条'),id=await e.seal(r.roomId),s=await e.claim(id)
 const f=hostFixture(),created=createProductionGroupInputProof({llm:f.host,provider:'fixed',model:'test'})
 bind(created.boundary,e,s)
 const opts=optsFor(s),adapter=f.calls[0].boundary
 let calls=0,args=-1
 const chunks=await collect(adapter.stream(opts,function(){calls++;args=arguments.length;return finishStream()}))
 const input=receiptOf(e,'input')
 eq('P04 注册 provider',f.calls[0].providers,['fixed'])
 eq('P04 boundary id',f.calls[0].boundary.id,'psyche-group-input-proof')
 eq('P04 流内容透传',chunks.map(c=>c.type),['text','finish'])
 eq('P04 next 单次无参',[calls,args],[1,0])
 eq('P04 attemptId 前缀',String(input.attemptId).startsWith('ga_'),true)
 eq('P04 input 绑定批次',[input.batchId,input.turn,input.step],[id,1,0])
 eq('P04 requestHash 与 canonical 一致',input.requestHash,expectedHash(opts))
 eq('P04 原始消息对象未被冻结',Object.isFrozen(opts.messages),false)
 eq('P04 finish 回执复用 attemptId',created.boundary.last(id).attemptId,input.attemptId)
 e.db.close()
}

// P-05 投影不匹配：截断/多一条 user 消息都拒绝。
{
 const e=await env(),r=await e.ingest('心灵，第五条'),id=await e.seal(r.roomId),s=await e.claim(id),b=boundary()
 bind(b,e,s)
 await rejects('P05 截断投影拒绝',()=>drive(b,optsFor(s,{messages:[{id:s.batch.message_id,role:'user',source:{kind:'user'},content:[{type:'text',text:s.projection.slice(0,-1)}]}]}),finishStream()),'GROUP_INPUT_PROOF_MISMATCH')
 await rejects('P05 重复批次消息拒绝',()=>drive(b,optsFor(s,{messages:[{id:s.batch.message_id,role:'user',source:{kind:'user'},content:[{type:'text',text:s.projection}]},{id:s.batch.message_id,role:'user',source:{kind:'user'},content:[{type:'text',text:'重复'}]}]}),finishStream()),'GROUP_INPUT_PROOF_MISMATCH')
 eq('P05 未产生 input 回执',receipts(e,'input'),0)
 e.db.close()
}

// P-06 工具面：除 Room-scoped recall 之外全部拒绝。
{
 const e=await env(),r=await e.ingest('心灵，第六条'),id=await e.seal(r.roomId),s=await e.claim(id),b=boundary()
 bind(b,e,s)
 await rejects('P06 发送工具拒绝',()=>drive(b,optsFor(s,{tools:[{name:'send_group_msg'}]}),finishStream()),'GROUP_TOOL_SURFACE_UNAVAILABLE')
 await rejects('P06 旧 fetch 拒绝',()=>drive(b,optsFor(s,{tools:[{name:'psyche_fetch'}]}),finishStream()),'GROUP_TOOL_SURFACE_UNAVAILABLE')
 eq('P06 未产生回执',receipts(e,'input'),0)
 e.db.close()
}

// P-07 最终 Provider/Model：别名或不匹配的路由必须失败关闭。
{
 const e=await env(),r=await e.ingest('心灵，第七条'),id=await e.seal(r.roomId),s=await e.claim(id),b=boundary()
 bind(b,e,s)
 await rejects('P07 provider 不匹配拒绝',()=>drive(b,optsFor(s,{provider:'alias'}),finishStream()),'GROUP_INPUT_PROOF_MISMATCH')
 await rejects('P07 model 不匹配拒绝',()=>drive(b,optsFor(s,{model:'other'}),finishStream()),'GROUP_INPUT_PROOF_MISMATCH')
 eq('P07 未产生回执',receipts(e,'input'),0)
 e.db.close()
}

// P-08 finish 协议：双 finish / 无 finish 都不产生成功完成。
{
 const e=await env(),r=await e.ingest('心灵，第八条'),id=await e.seal(r.roomId),s=await e.claim(id),b=boundary()
 bind(b,e,s)
 const double=function*(){yield {type:'text',text:'a'};yield {type:'finish',reason:{kind:'stop'}};yield {type:'finish',reason:{kind:'stop'}}}
 await rejects('P08 双 finish 拒绝',()=>drive(b,optsFor(s),double()),'GROUP_DOUBLE_FINISH')
 eq('P08 双 finish 只记一条',receipts(e,'finish'),1)
 const missing=function*(){yield {type:'text',text:'no finish'}}
 await rejects('P08 无 finish 拒绝',()=>drive(b,optsFor(s),missing()),'GROUP_REQUEST_INCOMPLETE')
 eq('P08 无 finish 不新增回执',receipts(e,'finish'),1)
 e.db.close()
}

// P-09 attempt 隔离：失败 attempt 不能确认，只有最终 stop attempt 可以。
{
 const e=await env(),r=await e.ingest('心灵，第九条'),id=await e.seal(r.roomId),s=await e.claim(id),b=boundary()
 bind(b,e,s)
 await drive(b,optsFor(s),finishStream('error'))
 const first=b.last(id)
 await drive(b,optsFor(s),finishStream('stop'))
 const last=b.last(id)
 eq('P09 两次 attempt 各自回执',[receipts(e,'input'),receipts(e,'finish')],[2,2])
 eq('P09 attemptId 独立',first.attemptId===last.attemptId,false)
 const completeWith=async(proof)=>e.cmd('complete',{batchId:id,proof:authority.issue({...proof,kind:'turn',finish:'completed',flush:true,endSeq:8,persistenceHash:groupHash('durable')})})
 await rejects('P09 error attempt 不能 complete',()=>completeWith(first),'GROUP_COMPLETION_MISSING_INPUT')
 await completeWith(last)
 eq('P09 stop attempt 可 complete',e.db.get('SELECT state FROM room_batches WHERE batch_id=?',[id]).state,'finalizing')
 e.db.close()
}

// P-10 运行代际/active 中途失效：迟到块被拒且不记成功 finish。
{
 const e=await env(),r=await e.ingest('心灵，第十条'),id=await e.seal(r.roomId),s=await e.claim(id),b=boundary()
 let active=true
 bind(b,e,s,()=>active)
 const stream=function*(){yield {type:'text',text:'a'};active=false;yield {type:'finish',reason:{kind:'stop'}}}
 await rejects('P10 中途失效拒绝',()=>drive(b,optsFor(s),stream()),'GROUP_STALE_EPOCH')
 eq('P10 无成功 finish 回执',receipts(e,'finish'),0)
 e.db.close()
}

// P-11 最终边界不重建输入：next 单次无参，原始对象不被改写。
{
 const e=await env(),r=await e.ingest('心灵，第十一条'),id=await e.seal(r.roomId),s=await e.claim(id)
 const f=hostFixture(),created=createProductionGroupInputProof({llm:f.host,provider:'fixed',model:'test'})
 bind(created.boundary,e,s)
 const opts=optsFor(s),snapshot=JSON.stringify(opts),adapter=f.calls[0].boundary
 let callCount=0,argCount=-1
 const chunks=await collect(adapter.stream(opts,function(){callCount++;argCount=arguments.length;return finishStream()}))
 eq('P11 Adapter 输入对象未被重建',JSON.stringify(opts),snapshot)
 eq('P11 next 仅一次且无参',[callCount,argCount],[1,0])
 eq('P11 流内容透传',chunks.map(c=>c.type),['text','finish'])
 eq('P11 输入回执 hash 一致',receiptOf(e,'input').requestHash,expectedHash(opts))
 e.db.close()
}

// P-12 能力检测：配置缺失、无 Host seam、注册异常都失败关闭，不走 hook 回退。
{
 const codes=[]
 const missing=createProductionGroupInputProof({llm:{},provider:'',model:'test',onUnavailable:c=>codes.push(c)})
 eq('P12 配置缺失失败关闭',[missing.boundary,codes.at(-1)],[null,'GROUP_PROOF_CONFIG_MISSING'])
 let called=0
 const fake={stream(){called++},on(){called++},registerCallBoundary:undefined}
 const noHost=createProductionGroupInputProof({llm:fake,provider:'fixed',model:'test',onUnavailable:c=>codes.push(c)})
 eq('P12 无 Host 接口失败关闭',[noHost.boundary,codes.at(-1),called],[null,'GROUP_PROOF_HOST_CAPABILITY_MISSING',0])
 eq('P12 detect 返回 null',detectCallBoundaryHost(fake),null)
 const throwing={registerCallBoundary(){throw new Error('boom')}}
 const failed=createProductionGroupInputProof({llm:throwing,provider:'fixed',model:'test',onUnavailable:c=>codes.push(c)})
 eq('P12 注册异常失败关闭',[failed.boundary,codes.at(-1)],[null,'GROUP_PROOF_REGISTER_FAILED'])
 const nonDisposer={registerCallBoundary(){return 42}}
 const bad=createProductionGroupInputProof({llm:nonDisposer,provider:'fixed',model:'test',onUnavailable:c=>codes.push(c)})
 eq('P12 非 disposer 失败关闭',[bad.boundary,codes.at(-1)],[null,'GROUP_PROOF_REGISTER_FAILED'])
 const f=hostFixture(),ok=createProductionGroupInputProof({llm:f.host,provider:'fixed',model:'test',onUnavailable:c=>codes.push(c)})
 eq('P12 成功注册',ok.boundary!==null,true)
 eq('P12 注册 provider 列表',f.calls[0].providers,['fixed'])
 ok.dispose()
 eq('P12 dispose 只解绑一次',f.disposals(),1)
}

// P-13 dispose：卸载后不再签发，在途流不能产生迟到成功回执。
{
 const e=await env(),r=await e.ingest('心灵，第十三条'),id=await e.seal(r.roomId),s=await e.claim(id)
 const f=hostFixture(),created=createProductionGroupInputProof({llm:f.host,provider:'fixed',model:'test'})
 bind(created.boundary,e,s)
 created.dispose();created.dispose()
 eq('P13 dispose 幂等',f.disposals(),1)
 await rejects('P13 卸载后不再签发',()=>drive(created.boundary,optsFor(s),finishStream()),'GROUP_STALE_EPOCH')
 eq('P13 卸载后无回执',receipts(e,'input'),0)
 const f2=hostFixture(),created2=createProductionGroupInputProof({llm:f2.host,provider:'fixed',model:'test'})
 bind(created2.boundary,e,s)
 const slow=function*(){yield {type:'text',text:'first'};created2.dispose();yield {type:'finish',reason:{kind:'stop'}}}
 const it=created2.boundary.wrapFinal(optsFor(s),()=>slow())
 const first=await it.next()
 eq('P13 在途首块可读',first.done,false)
 await rejects('P13 卸载后在途流拒绝',()=>it.next(),'GROUP_STALE_EPOCH')
 eq('P13 在途流无成功 finish',receipts(e,'finish'),0)
 e.db.close()
}

console.log(`[P4-D-2 group-production-proof] ${passed} 通过 ${failed} 失败`)
if(failed)process.exitCode=1
