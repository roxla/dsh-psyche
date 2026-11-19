import {mkdtempSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {Core,openDatabase,roomPolicy,groupHash} from '../packages/core/dist/index.js'
import {acquireGroupLease} from '../dist/lib/group-scheduler.js'
if(process.argv[2]==='child') {
 const {file,command,lease}=JSON.parse(Buffer.from(process.argv[3],'base64url').toString())
 const opened=lease?null:await openDatabase({file,logger:{}})
 const core=opened?new Core({db:opened.db,config:{},logger:{},dataDir:tmpdir()}):null
 process.stdout.write('ready\n')
 await new Promise(resolve=>process.stdin.once('data',resolve))
 try {
  if(lease){const lock=await acquireGroupLease(file);await lock.release();console.log(JSON.stringify({acquired:true}))}
  else console.log(JSON.stringify(await core.groupSchedule(command)))
 }catch(error){console.log(JSON.stringify({error:error.message,code:error.code}))}
 finally{opened?.db.close()}
} else {
 let passed=0,failed=0
 const eq=(label,a,b)=>{if(JSON.stringify(a)===JSON.stringify(b)){passed++;console.log(' ok '+label)}else{failed++;console.error(' FAIL '+label,{a,b})}}
 const dir=mkdtempSync(join(tmpdir(),'psyche-group-process-')),file=join(dir,'memory.sqlite3')
 const {db}=await openDatabase({file,logger:{}}),core=new Core({db,config:{},logger:{},dataDir:dir})
 const now=Date.parse('2026-11-14T04:00:00Z'),ownerId='multi-process-fixture',{epoch}=await core.groupSchedule({kind:'start',ownerId,now})
 const policies=[],batches=[],rooms=[]
 for(let i=0;i<9;i++) {
  const p=roomPolicy({externalRoomId:String(41001+i),names:['心灵'],reply:{enabled:true},silence:{timezone:'UTC'}});policies.push(p)
  const r=await core.ingestGroupMessage({externalRoomId:p.externalRoomId,stableUserId:'31001',selfId:'39999',messageId:'m'+i,text:'心灵，跨进程领取',parts:[{type:'text',text:'心灵，跨进程领取'}],policy:p,captureMode:p.captureMode,schedulingReady:true,at:new Date(now).toISOString()});rooms.push(r.roomId)
  batches.push((await core.groupSchedule({kind:'seal',ownerId,epoch,now:now+2000,roomId:r.roomId,policy:p,accountKey:groupHash('39999'),transportId:'qq-onebot',provider:'fixed',model:'m'})).batchId)
 }
 async function race(payloads){
  const children=payloads.map(payload=>{
   const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'child',Buffer.from(JSON.stringify({file,...payload})).toString('base64url')],{windowsHide:true,stdio:['pipe','pipe','pipe']})
   let output='',stderr='',readyResolve
   const ready=new Promise(resolve=>{readyResolve=resolve})
   const timer=setTimeout(()=>child.kill(),20000)
   child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('ready\n'))readyResolve()});child.stderr.on('data',c=>{stderr+=c})
   const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);if(code!==0){reject(Error('Child failed '+stderr));return}try{resolve(JSON.parse(output.trim().split(/\r?\n/).at(-1)))}catch(e){reject(e)}})})
   return {child,ready,done}
  })
  await Promise.all(children.map(c=>c.ready));for(const c of children)c.child.stdin.end('GO\n')
  return Promise.all(children.map(c=>c.done))
 }
 const command=index=>({kind:'claim',ownerId,epoch,now:now+2000,batchId:batches[index],policy:policies[index]})
 const same=await race(Array.from({length:4},()=>({command:command(0)})))
 eq('同批跨进程只有一次新领取',same.filter(r=>r.claimed===true&&!r.replayed).length,1)
 eq('其他领取明确不重复授权',same.filter(r=>r.claimed===false).length,3)
 const rest=await race(Array.from({length:8},(_,i)=>({command:command(i+1)})))
 eq('全局剩余仅三个执行槽',rest.filter(r=>r.claimed===true&&!r.replayed).length,3)
 eq('数据库全局恰好4在途',db.get("SELECT COUNT(*) AS n FROM room_batches WHERE state='submitting'").n,4)
 eq('每Room仅一个在途',db.get("SELECT MAX(n) AS n FROM (SELECT COUNT(*) AS n FROM room_batches WHERE state='submitting' GROUP BY room_id)").n,1)
 const replayIndex=batches.findIndex((id,i)=>i>0&&db.get('SELECT state FROM room_batches WHERE batch_id=?',[id]).state==='queued')
 await core.groupSchedule({kind:'finish',ownerId,epoch,now:now+2100,batchId:batches[0]})
 const replayCommand={...command(replayIndex),now:now+2100,opId:'same-claim-op'}
 const replay=await race(Array.from({length:3},()=>({command:replayCommand})))
 eq('opId重放只有一次可执行领取',replay.filter(r=>r.claimed&&!r.replayed).length,1)
 eq('其余明确标replayed',replay.filter(r=>r.replayed).length,2)
 let conflict=false
 try{await core.groupSchedule({...replayCommand,now:now+2101})}catch{conflict=true}
 eq('同opId异参明确冲突',conflict,true)
 const lock=await acquireGroupLease(file)
 try {
  eq('跨进程第二宿主租约被拒',(await race([{lease:true}]))[0].error,'GROUP_OWNER_BUSY')
  const alias=join(dir,'alias');symlinkSync(dir,alias,'junction')
  eq('路径别名不能绕过独占',(await race([{lease:true,file:join(alias,'memory.sqlite3')}]))[0].error,'GROUP_OWNER_BUSY')
 }finally{await lock.release()}
 const later=await race([{lease:true}]);eq('释放后新宿主可取得租约',later[0].acquired,true)
 db.close()
 console.log(`[P4-D-2 group-scheduler-concurrency] ${passed} 通过 ${failed} 失败`)
 if(failed)process.exitCode=1
}
