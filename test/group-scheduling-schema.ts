import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {Core,MIGRATIONS,openDatabase,roomPolicy,groupHash} from '../packages/core/dist/index.js'
let passed=0,failed=0
const eq=(label,a,b)=>{if(JSON.stringify(a)===JSON.stringify(b)){passed++;console.log(' ok '+label)}else{failed++;console.error(' FAIL '+label,{a,b})}}
const rejects=async(label,fn)=>{let no=false;try{await fn()}catch{no=true}eq(label,no,true)}
const T='2026-11-14T04:00:00.000Z',N=Date.parse(T)
function legacy(){
 const dir=mkdtempSync(join(tmpdir(),'psyche-group-v22-')),file=join(dir,'memory.sqlite3'),db=new DatabaseSync(file)
 db.exec('PRAGMA foreign_keys=ON')
 for(const m of MIGRATIONS.filter(m=>m.version<=22)){db.exec(m.sql);m.seed?.({run:(sql,params=[])=>db.prepare(sql).run(...params)},T);db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(m.version,m.name,T)}
 db.exec('PRAGMA user_version=22');return {dir,file,db}
}
for(const driverPreference of ['node:sqlite','better-sqlite3']) {
 const old=legacy()
 const before=old.db.prepare('SELECT * FROM persona_config').all();old.db.close()
 const {db}=await openDatabase({file:old.file,logger:{},driverPreference})
 eq('v22升级v42',db.userVersion(),42)
 eq('81业务表',db.tableCount(),81)
 eq('44触发器',db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'").n,44)
 eq('旧事实不修改',db.all('SELECT * FROM persona_config'),before)
 eq('已有v22迁移仍只一条',db.get('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=22').n,1)
 eq('新调度表无正文列',db.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'room_%'").filter(r=>!['room_members','room_message_seq','room_participation_state'].includes(r.name)).every(r=>db.all('PRAGMA table_info('+r.name+')').every(c=>!['text','body','payload_text','message_text'].includes(c.name))),true)
 await rejects('owner不能删除',()=>db.run('DELETE FROM room_schedule_owner'))
 const core=new Core({db,config:{},logger:{},dataDir:old.dir})
 const ownerId='schema-fixture',{epoch}=await core.groupSchedule({kind:'start',ownerId,now:N})
 const policy=roomPolicy({externalRoomId:'41001',names:['心灵'],reply:{enabled:true},silence:{timezone:'UTC'}})
 const row=await core.ingestGroupMessage({externalRoomId:'41001',stableUserId:'31001',selfId:'39999',messageId:'m',text:'心灵，升级后正常采集',parts:[{type:'text',text:'心灵，升级后正常采集'}],captureMode:policy.captureMode,policy,schedulingReady:true,at:T})
 const result=await core.groupSchedule({kind:'seal',ownerId,epoch,now:N+2000,roomId:row.roomId,policy,provider:'fixed',model:'m',accountKey:groupHash('39999'),transportId:'qq-onebot'})
 eq('升级后可封存批次',result.status,'queued')
 await rejects('批次输入摘要不可更改',()=>db.run("UPDATE room_batches SET projection_hash='changed'"))
 await rejects('批次证据不可删除',()=>db.run('DELETE FROM room_batches'))
 await rejects('成员绑定不可更改',()=>db.run("UPDATE room_batch_members SET source_hash='changed'"))
 await rejects('成员证据不可删除',()=>db.run('DELETE FROM room_batch_members'))
 await rejects('旧映射仍append-only',()=>db.run("UPDATE room_message_seq SET message_id='changed'"))
 db.close()
 const reopened=await openDatabase({file:old.file,logger:{},driverPreference})
 eq('重复启动不重复迁移',reopened.db.get('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=23').n,1)
 reopened.db.close()
}
{
 const old=legacy()
 old.db.prepare("INSERT INTO rooms(room_id,persona_id,platform,channel,external_room_id,created_at,updated_at) VALUES('r','main','qq','group','41001',?,?)").run(T,T)
 old.db.prepare("INSERT INTO room_message_seq(room_id,platform,message_id,room_seq,received_at) VALUES('r','qq','m',1,?)").run(T)
 old.db.prepare("INSERT INTO room_participation_state(room_id,last_seq,read_through_seq,updated_at) VALUES('r',1,1,?)").run(T)
 old.db.close()
 await rejects('旧非零水位无证明拒绝升级',async()=>{const x=await openDatabase({file:old.file,logger:{}});x.db.close()})
 const db=new DatabaseSync(old.file,{readOnly:true})
 eq('失败整版回滚仍v22',db.prepare('PRAGMA user_version').get().user_version,22)
 eq('失败不留下调度表',db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='room_batches'").get().n,0)
 eq('不偷偷重置旧水位',db.prepare('SELECT read_through_seq FROM room_participation_state').get().read_through_seq,1)
 db.close()
}
console.log(`[P4-D-2 group-scheduling-schema] ${passed} 通过 ${failed} 失败`)
if(failed)process.exitCode=1
