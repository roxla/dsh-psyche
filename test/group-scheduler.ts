import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Core,openDatabase,roomPolicy} from '../packages/core/dist/index.js'
import {GroupScheduler} from '../dist/lib/group-scheduler.js'
let passed=0,failed=0
const eq=(label,a,b)=>{if(JSON.stringify(a)===JSON.stringify(b)){passed++;console.log(' ok '+label)}else{failed++;console.error(' FAIL '+label,{a,b})}}
const T=Date.parse('2026-11-14T04:00:00Z')
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r))}
async function env(extra={},roomCount=1){
 const dir=mkdtempSync(join(tmpdir(),'psyche-group-scheduler-')),{db}=await openDatabase({file:join(dir,'memory.sqlite3'),logger:{}})
 const core=new Core({db,config:{},logger:{},dataDir:dir}),runs=[],warnings=[],timers=new Map()
 let wall=T,mono=0,seq=0,connected=true,available=true,tid=0
 const policies=new Map(Array.from({length:roomCount},(_,i)=>{const p=roomPolicy({externalRoomId:String(41001+i),names:['心灵'],silence:{timezone:'UTC'},reply:{enabled:true},...extra});return [p.externalRoomId,p]}))
 const scheduler=new GroupScheduler(core,{policies:()=>policies,account:()=> '39999',connected:()=>connected,available:()=>available,provider:'fixed',model:'test',warn:code=>warnings.push(code),lease:async()=>({release:async()=>{}}),
  clock:{now:()=>wall,monotonic:()=>mono,setTimeout:(fn,delay)=>{timers.set(++tid,{fn,delay});return tid},clearTimeout:id=>timers.delete(id)},
  run:(snapshot,ctx)=>new Promise(resolve=>{runs.push({snapshot,ctx,release:()=>resolve(true)})}),
  cancel:async()=>{for(const r of runs)r.release();return true},
 })
 await scheduler.start()
 const ingest=async(text='心灵，你好',index=0)=>{
  const policy=policies.get(String(41001+index))
  const result=await core.ingestGroupMessage({externalRoomId:policy.externalRoomId,stableUserId:'31001',selfId:'39999',messageId:'m'+(++seq),parts:[{type:'text',text}],text,policy,captureMode:policy.captureMode,schedulingReady:true,at:new Date(wall).toISOString()})
  await scheduler.notify(result.roomId);return result
 }
 const advance=async(ms)=>{wall+=ms;mono+=ms;await scheduler.kick();await flush()}
 return {db,core,scheduler,policies,runs,warnings,ingest,advance,setClock:(w,m)=>{wall=w;mono=m},wall:()=>wall,mono:()=>mono,connect:v=>{connected=v},available:v=>{available=v},close:async()=>{await scheduler.stop();db.close()}}
}
{
 const e=await env()
 await e.ingest();await e.advance(1000);await e.ingest();await e.advance(1000)
 eq('新消息重置2秒安静',e.runs.length,0)
 await e.advance(1000)
 eq('合并成一个Turn',e.runs.length,1)
 eq('快照按seq排列两条',e.runs[0].snapshot.members.map(m=>m.room_seq),[1,2])
 await e.ingest();await e.advance(2000)
 eq('前批未结束同Room不重叠',e.runs.length,1)
 eq('后批已封存排队',e.core.readGroupSchedule().queued.length,1)
 e.runs[0].release();await flush()
 eq('前批结算后顺序启动',e.runs.length,2)
 eq('后批不复用前批活动成员',e.runs[1].snapshot.members.map(m=>m.room_seq),[3])
 await e.close()
}
{
 const e=await env()
 await e.ingest()
 for(let i=0;i<5;i++){await e.advance(1500);await e.ingest('普通群聊，不保留')}
 eq('持续到7.5秒仍等待',e.runs.length,0)
 await e.advance(500)
 eq('8秒强制封批',e.runs.length,1)
 eq('Source-null不伪造展示',e.runs[0].snapshot.members.map(m=>m.room_seq),[1])
 await e.close()
}
{
 const e=await env({},6)
 for(let r=0;r<6;r++)await e.ingest('心灵，独立群'+r,r)
 await e.advance(2000)
 eq('跨Room最多4在途',e.runs.length,4)
 eq('4个输入Room不同',new Set(e.runs.map(r=>r.snapshot.batch.room_id)).size,4)
 eq('其余2批有界排队',e.core.readGroupSchedule().queued.length,2)
 e.runs[0].release();await flush()
 eq('释放后第五Room获得执行槽',e.runs.length,5)
 eq('没有Room串上下文',e.runs.every(r=>e.runs.filter(other=>other!==r).every(other=>other.snapshot.members.every(m=>!r.snapshot.projection.includes(m.text)))),true)
 await e.close()
}
{
 const e=await env({maxTurnsPerHour:1})
 await e.ingest();await e.advance(2000);e.runs[0].release();await flush()
 await e.ingest();await e.advance(2000)
 eq('达到小时限额不执行第二批',e.runs.length,1)
 eq('限额拒绝有持久原因',e.db.get("SELECT COUNT(*) AS n FROM room_batches WHERE state='suppressed' AND reason='quota'").n,1)
 await e.advance(3600000)
 eq('限额释放不补旧触发',e.runs.length,1)
 await e.ingest();await e.advance(2000)
 eq('新明确触发才再执行',e.runs.length,2)
 await e.close()
}
{
 const e=await env({silence:{timezone:'UTC',mode:'all',windows:['04:00-05:00']}})
 await e.ingest();await e.advance(2000)
 eq('静默不创建Turn',e.runs.length,0)
 eq('静默保留正文但不确认',e.db.get('SELECT read_through_seq FROM room_participation_state').read_through_seq,0)
 eq('静默处置有原因',e.db.get('SELECT reason FROM room_triggers').reason,'silence')
 await e.advance(3600000)
 eq('静默结束不补发',e.runs.length,0)
 await e.ingest();await e.advance(2000)
 eq('静默后新触发可带入历史',e.runs[0].snapshot.members.length,2)
 await e.close()
}
{
 const e=await env({merge:{quietMs:1,maxWaitMs:1,maxMessages:1,maxChars:4000}})
 await e.ingest();await e.advance(1)
 for(let i=0;i<51;i++){await e.ingest();await e.advance(1)}
 eq('队列上限50不含一个活动批',e.core.readGroupSchedule().queued.length,50)
 eq('满载时未封触发保留',e.db.get("SELECT COUNT(*) AS n FROM room_triggers WHERE state='armed'").n,1)
 eq('首次溢出计一次',e.scheduler.counts.queueOverflow,1)
 for(let i=0;i<3;i++)await e.scheduler.kick()
 eq('恢复扫描不重复计溢出',e.scheduler.counts.queueOverflow,1)
 e.runs[0].release();await flush();await e.advance(1)
 eq('容量释放后未决触发可封批',e.db.get("SELECT COUNT(*) AS n FROM room_triggers WHERE state='armed'").n,0)
 eq('恢复仍不超过50',e.core.readGroupSchedule().queued.length<=50,true)
 await e.close()
}
{
 const e=await env()
 e.connect(false);await e.ingest();await e.advance(3000)
 eq('离线不启动Turn',e.runs.length,0)
 e.connect(true);await e.scheduler.kick();await flush()
 eq('已知未提交批次重连可恢复',e.runs.length,1)
 await e.close()
}
{
 const e=await env()
 await e.ingest();e.setClock(T+61000,1000);await e.scheduler.kick()
 eq('墙钟前跳不能提前结束安静窗口',e.runs.length,0)
 e.setClock(T+62000,2000);await e.scheduler.kick();await flush()
 eq('实际单调2秒后可启动',e.runs.length,1)
 e.runs[0].release();await flush()
 await e.ingest();e.setClock(T+61000,4000);await e.scheduler.kick()
 eq('墙钟回拨不新启动',e.runs.length,1)
 eq('回拨告警可观测',e.warnings.includes('GROUP_CLOCK_REGRESSION'),true)
 await e.close()
}
{
 const e=await env()
 await e.ingest();await e.advance(2000)
 const active=e.runs[0].ctx.isActive
 const stopping=e.scheduler.stop()
 eq('卸载立即关闭旧代能力',active(),false)
 await stopping
 eq('卸载清除owner',e.db.get('SELECT owner_id FROM room_schedule_owner').owner_id,'')
 e.db.close()
}
console.log(`[P4-D-2 group-scheduler] ${passed} 通过 ${failed} 失败`)
if(failed)process.exitCode=1
