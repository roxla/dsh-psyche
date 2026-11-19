import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../packages/core/dist/adapter.js'
import { MIGRATIONS } from '../packages/core/dist/schema.js'
let passed=0,failed=0
function eq(label,a,b){if(JSON.stringify(a)===JSON.stringify(b)){passed++;console.log('  ok '+label)}else{failed++;console.error(' FAIL '+label,{a,b})}}
const T='2026-11-13T04:00:00.000Z'
const log={info(){},debug(){},warn(){},error(){}}
function legacy(){
 const file=join(mkdtempSync(join(tmpdir(),'psyche-group-v21-')),'memory.sqlite3')
 const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON')
 for(const m of MIGRATIONS.filter((m)=>m.version<=21)){db.exec(m.sql);m.seed?.({run:(sql,params=[])=>db.prepare(sql).run(...params)},T);db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)').run(m.version,m.name,T)}
 db.exec('PRAGMA user_version=21')
 const room=(rid,external='41001')=>db.prepare("INSERT INTO rooms(room_id,persona_id,platform,channel,external_room_id,created_at,updated_at) VALUES (?,'main','qq','group',?,?,?)").run(rid,external,T,T)
 const source=(sid,rid,mid,at=T)=>db.prepare("INSERT INTO sources(source_id,persona_id,platform,channel,room_id,message_id,origin,kind,text,captured_at,created_at) VALUES (?,'main','qq','group',?,?,'user','message','LEGACY',?,?)").run(sid,rid,mid,at,T)
 return {file,db,room,source}
}
for(const driverPreference of ['node:sqlite','better-sqlite3']){
 const old=legacy();old.room('rm_old');old.source('src_old_a','rm_old','a','2026-11-13T05:00:00.000Z');old.source('src_old_b','rm_old','b','2026-11-13T03:00:00.000Z');old.source('src_unknown',null,'unknown')
 const before=old.db.prepare('SELECT * FROM sources ORDER BY source_id').all();old.db.close()
 const opened=await openDatabase({file:old.file,logger:log,driverPreference});const db=opened.db
 eq('真实v21经v26升级到v31',db.userVersion(),31)
 eq('业务表70',db.tableCount(),70)
 eq('当前触发器40',db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'").n,40)
 eq('历史Source完全不改写',db.all('SELECT * FROM sources ORDER BY source_id'),before)
 eq('历史序号按落库顺序而非时间',db.all('SELECT source_id,room_seq FROM room_message_seq ORDER BY room_seq'),[{source_id:'src_old_a',room_seq:1},{source_id:'src_old_b',room_seq:2}])
 eq('缺Room历史不伪造映射',db.get("SELECT COUNT(*) AS n FROM room_message_seq WHERE source_id='src_unknown'").n,0)
 eq('历史水位未伪装已读',db.get('SELECT last_seq,read_through_seq FROM room_participation_state WHERE room_id=?',['rm_old']),{last_seq:2,read_through_seq:0})
 db.close();const reopened=await openDatabase({file:old.file,logger:log,driverPreference});eq('重复启动不重复迁移',reopened.db.get('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=22').n,1);reopened.db.close()
}
for(const conflict of ['room','message']){
 const old=legacy();old.room('rm_a');if(conflict==='room')old.room('rm_b');else{old.source('src_a','rm_a','dup');old.source('src_b','rm_a','dup')}
 const before=old.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n;old.db.close()
 let rejected=false;try{const opened=await openDatabase({file:old.file,logger:log});opened.db.close()}catch{rejected=true}
 eq(`${conflict}重复预检拒绝`,rejected,true)
 const read=new DatabaseSync(old.file,{readOnly:true})
 eq(`${conflict}失败保持v21`,read.prepare('PRAGMA user_version').get().user_version,21)
 eq(`${conflict}整版回滚不留新表`,read.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='room_message_seq'").get().n,0)
 eq(`${conflict}不删旧Source`,read.prepare('SELECT COUNT(*) AS n FROM sources').get().n,before);read.close()
}
{
 const old=legacy();old.db.exec('PRAGMA user_version=32');old.db.close();let rejected=false
 try{const value=await openDatabase({file:old.file,logger:log});value.db.close()}catch{rejected=true}
 eq('拒绝读取比实现更新的Schema',rejected,true)
}
console.log(`[P4-D-1 group-schema] ${passed} 通过 ${failed} 失败`)
if(failed)process.exitCode=1
