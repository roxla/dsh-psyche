import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { openDatabase } from '../packages/core/dist/adapter.js'
let passed=0,failed=0
function eq(label,a,b){if(JSON.stringify(a)===JSON.stringify(b)){passed++;console.log('  ok '+label)}else{failed++;console.error('FAIL '+label,{a,b})}}
const file=join(mkdtempSync(join(tmpdir(),'psyche-group-concurrent-')),'memory.sqlite3')
const {db}=await openDatabase({file,logger:{info(){},debug(){},warn(){},error(){}}})
const launch=()=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,['test/helpers/group-intake-child.mjs',file],{cwd:resolvePath,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',errors=''
 child.stdout.on('data',(c)=>{output+=c});child.stderr.on('data',(c)=>{errors+=c});child.on('error',reject)
 child.on('exit',(code)=>{if(code!==0)reject(Error(errors));else resolve(JSON.parse(output.trim()))})
})
const resolvePath=resolve('.')
try{
 const results=await Promise.all(Array.from({length:4},launch))
 eq('四进程全部完成',results.length,4)
 eq('12次投递仅3次首次写入',results.flat().filter((r)=>!r.replayed).length,3)
 eq('其余均稳定重放',results.flat().filter((r)=>r.replayed).length,9)
 eq('仅两个群Room',db.get("SELECT COUNT(*) AS n FROM rooms WHERE channel='group'").n,2)
 eq('Source/Event/序号无重复',[db.get('SELECT COUNT(*) AS n FROM sources').n,db.get('SELECT COUNT(*) AS n FROM events').n,db.get('SELECT COUNT(*) AS n FROM room_message_seq').n],[3,3,3])
 eq('每Room序号无缺口',db.all('SELECT last_seq,read_through_seq FROM room_participation_state ORDER BY last_seq'),[{last_seq:1,read_through_seq:0},{last_seq:2,read_through_seq:0}])
 eq('跨进程重放结果一致',results.every((r)=>JSON.stringify(r.map(({replayed,...v})=>v))===JSON.stringify(results[0].map(({replayed,...v})=>v))),true)
 eq('证据关联无重复',db.get('SELECT COUNT(*) AS n FROM event_sources').n,3)
}finally{db.close()}
console.log(`[P4-D-1 group-concurrency] ${passed} 通过 ${failed} 失败`)
if(failed)process.exitCode=1
