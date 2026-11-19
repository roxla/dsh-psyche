// H21: final injection must agree with the evidence-domain Recall matrix.
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Core,openDatabase,resolveRoomId,createInjectionManifest,InjectionManifestStore,hashText,validateFinalRequest,RuntimeInputStore,createHostBindingCapability,PreStepInjector,composeInjection} from '../packages/core/dist/index.js'
import {qqGroupAllowed} from '../dist/lib/qq-group-admission.js'

let passed=0,failed=0
const eq=(label:string,actual:unknown,expected:unknown)=>{
  if(JSON.stringify(actual)===JSON.stringify(expected)){passed++;console.log(' ok '+label)}
  else{failed++;console.error(' FAIL '+label,{actual,expected})}
}
const T='2026-11-14T04:00:00.000Z',dir=mkdtempSync(join(tmpdir(),'psyche-group-final-'))
const {db}=await openDatabase({file:join(dir,'memory.sqlite3'),logger:{}})
const core=new Core({db,config:{},logger:{},dataDir:dir})
for(const id of ['ct_a','ct_aa','ct_b'])db.run(`INSERT INTO contacts(contact_id,persona_id,platform,stable_user_id,created_at,updated_at) VALUES(?,'main','qq',?,?,?)`,[id,id,T,T])
let serial=0
const rows:Array<{id:string;label:string;text:string;allowed:[boolean,boolean,boolean]}>=[]
async function fact(label:string,domains:string[],allowed:[boolean,boolean,boolean],subject='ct_a'){
  const text='H21FINAL '+label,sourceIds:string[]=[]
  for(const domain of domains){
    serial++
    const s=await core.capture({platform:'qq',channel:domain==='private'?'private':'group',senderContactId:'ct_a',
      ...(domain==='private'||domain==='null-room'?{}:{externalRoomId:domain}),sessionRef:'h21-final-'+serial,captureKey:'h21-final-'+serial,origin:'user',kind:'message',text:text+' '+serial,at:T})
    sourceIds.push(s.sourceId)
  }
  const r=await core.remember({text,statement:text,sourceIds,subjectRefs:[subject],kind:'fact',disclosure:'public'})
  if(!r.artifactId)throw Error('Fixture did not promote: '+label)
  rows.push({id:r.artifactId,label,text,allowed});return r.artifactId
}
const a=await fact('room-a',['42001','42001'],[true,false,false])
await fact('room-b',['42002','42002'],[false,true,false])
const privateA=await fact('private-a',['private','private'],[false,false,true])
await fact('mixed-ab',['42001','42002'],[false,false,false])
await fact('mixed-ap',['42001','private'],[false,false,false])
const empty=await fact('no-evidence',['42001','42001'],[false,false,true])
db.run('DELETE FROM artifact_evidence WHERE artifact_id=?',[empty])
const missing=await fact('missing-source',['42001','42001'],[false,false,false])
db.run('PRAGMA foreign_keys=OFF')
db.run(`INSERT INTO artifact_evidence(artifact_id,revision,source_id,relation,independence_key,created_at) VALUES(?,1,'h21-final-missing','supports','h21-final-missing',?)`,[missing,T])
db.run('PRAGMA foreign_keys=ON')
await fact('null-room',['null-room','null-room'],[false,false,false])
const bad=await fact('invalid-json',['42001','42001'],[false,false,false])
db.run(`INSERT INTO artifact_revisions(artifact_id,revision,state,statement,subject_refs,disclosure,created_at,updated_at)
 SELECT artifact_id,2,state,statement,'{broken',disclosure,created_at,updated_at FROM artifact_revisions WHERE artifact_id=? AND revision=1`,[bad])
db.run(`INSERT INTO artifact_evidence(artifact_id,revision,source_id,relation,independence_key,created_at)
 SELECT artifact_id,2,source_id,relation,independence_key,created_at FROM artifact_evidence WHERE artifact_id=? AND revision=1`,[bad])
await fact('exact-aa',['42001','42001'],[true,false,false],'ct_aa')
await fact('private-subject-aa',['private','private'],[false,false,false],'ct_aa')
const roomA=resolveRoomId(db,'qq','42001'),roomB=resolveRoomId(db,'qq','42002')
const scopeA={contactId:'ct_b',surface:'group',roomId:roomA,groupId:'42001'}
const scopeB={contactId:'ct_b',surface:'group',roomId:roomB,groupId:'42002'}
const scopePrivate={contactId:'ct_a',surface:'private',roomId:null,groupId:null}
const whitelist=new Set(['42001','42002'])
function check(id:string,scope:any,extra:any={}){
  const head=db.get<{revision:number;statement:string}>('SELECT revision,statement FROM artifact_revisions WHERE artifact_id=? ORDER BY revision DESC LIMIT 1',[id])!
  const requestId='inj_h21_'+(++serial),sessionId='group-final-session'
  const block=`<memory-context request-id="${requestId}" turn="1" step="1">${head.statement}</memory-context>`
  const manifests=new InjectionManifestStore()
  manifests.register(createInjectionManifest({requestId,sessionId,turn:1,step:1,contactId:scope.contactId,channelId:null,groupId:scope.groupId,surface:scope.surface,roomId:scope.roomId,purpose:null,
    items:[{artifactId:id,revision:head.revision,contentHash:hashText(head.statement)}],messageHash:hashText(block),createdAt:T,...extra.manifest}))
  return validateFinalRequest({db,manifests,messages:[{role:'user',content:block}],sessionId,groupAllowed:Object.hasOwn(extra,'groupAllowed')?extra.groupAllowed:input=>whitelist.has(input.groupId??''),runtimeInput:extra.input===null?null:{platform:'qq',stableUserId:'fixture-sender',sessionId,contactId:scope.contactId,groupId:scope.groupId,channelId:null,trustedSource:'channel-adapter',boundAt:T,...extra.input}})
}
const before=JSON.stringify(db.all("SELECT name,(SELECT COUNT(*) FROM operations) AS operations FROM sqlite_master WHERE type='table' ORDER BY name"))
for(const [scope,index,label] of [[scopeA,0,'A群乙'],[scopeB,1,'B群乙'],[scopePrivate,2,'甲私聊']] as const){
  for(const row of rows)eq(label+' '+row.label,check(row.id,scope).ok,row.allowed[index])
}
for(const [scope,index,label] of [[{...scopeA,contactId:null},0,'A群Room-only'],[{...scopeB,contactId:null},1,'B群Room-only']] as const){
  for(const row of rows){
    eq(label+' 最终检查 '+row.label,check(row.id,scope).ok,row.allowed[index])
    eq(label+' Composer '+row.label,composeInjection(db,[{artifactId:row.id}],scope).items.length>0,row.allowed[index])
  }
}
eq('同一 Subject 的群发送者不能绕过无 Evidence 拒绝',check(empty,{...scopeA,contactId:'ct_a'}).ok,false)
eq('群外仍不能跨 Contact',check(a,{...scopePrivate,contactId:'ct_b'}).ok,false)
eq('群 Room 无法解析保持拒绝',check(a,{...scopeA,roomId:null,groupId:'999999'}).ok,false)
eq('manifest Room 与可信 Room 不一致保持拒绝',check(a,scopeA,{manifest:{roomId:roomB}}).ok,false)
eq('manifest Contact 换绑保持拒绝',check(a,scopeA,{manifest:{contactId:'ct_aa'}}).ok,false)
eq('可信运行表面变化保持拒绝',check(a,scopeA,{input:{groupId:null}}).ok,false)
eq('没有 RuntimeInput 不产生群例外',check(a,scopeA,{input:null}).ok,false)
eq('非群匿名 manifest 不能读成员私聊',check(privateA,{...scopePrivate,contactId:null}).ok,false)
eq('白名单内 NULL manifest 可使用精确 Room 证据',check(a,{...scopeA,contactId:null}).ok,true)
eq('群匿名但 Room 无法解析仍拒绝',check(a,{...scopeA,contactId:null,roomId:null,groupId:'999999'}).ok,false)
eq('缺 manifest Room 元数据不能获得群例外',check(a,scopeA,{manifest:{roomId:undefined}}).ok,false)
eq('缺 manifest surface 元数据不能获得群例外',check(a,scopeA,{manifest:{surface:undefined}}).ok,false)
eq('没有当前白名单证明时 NULL 仍拒绝',check(a,{...scopeA,contactId:null},{groupAllowed:undefined}).ok,false)
eq('名单校验异常时拒绝',check(a,{...scopeA,contactId:null},{groupAllowed:()=>{throw Error('fixture')}}).ok,false)
whitelist.delete('42001')
eq('移出白名单后既有 manifest 立即拒绝',check(a,{...scopeA,contactId:null}).ok,false)
eq('白名单不能由 manifest 自报',check(a,{...scopeA,contactId:null},{manifest:{groupAllowed:true}}).ok,false)
whitelist.add('42001')
eq('检查路径不写 operations/Schema',JSON.stringify(db.all("SELECT name,(SELECT COUNT(*) FROM operations) AS operations FROM sqlite_master WHERE type='table' ORDER BY name")),before)
const groupConfig={enabled:true,groups:{enabled:true,allowed:[{externalRoomId:'42001',silence:{timezone:'UTC'}}]}}
const groupInput={platform:'qq',stableUserId:'fixture-member-b',contactId:null,sessionId:'auto-group-session',groupId:'42001',trustedSource:'channel-adapter',boundAt:T}
eq('宿主白名单只允许配置的群',qqGroupAllowed(groupConfig,groupInput),true)
eq('已建 Room 但不在名单不可交互',qqGroupAllowed(groupConfig,{...groupInput,groupId:'42002'}),false)
eq('群总开关关闭时拒绝',qqGroupAllowed({...groupConfig,groups:{...groupConfig.groups,enabled:false}},groupInput),false)
eq('私聊名单不授予群权限',qqGroupAllowed({enabled:true,allowFrom:{owner:'fixture-member-b'}},groupInput),false)
eq('非法条目仍拒绝',qqGroupAllowed({enabled:true,groups:{enabled:true,allowed:[{externalRoomId:'42001',silence:{timezone:'UTC'},unknown:true}]}},groupInput),false)
const runtimeInputs=new RuntimeInputStore(),manifests=new InjectionManifestStore()
runtimeInputs.bind(createHostBindingCapability({sessionId:groupInput.sessionId,platform:'qq',adapterId:'qq-snowluma'}),groupInput)
const injector=new PreStepInjector({db,runtimeInputs,manifests,maxChars:2000,maxItems:10})
const injected=injector.inject({id:groupInput.sessionId},[{role:'user',content:'H21FINAL'}],{turn:1,step:1})
eq('真实注入器为 Room-only 群生成成员记忆',injected.injected,true)
eq('注入正文含本群成员事实',JSON.stringify(injected.messages).includes('H21FINAL room-a'),true)
eq('自动注入不带跨群或私聊事实',/H21FINAL (?:room-b|private-a|mixed-ab|mixed-ap)/.test(JSON.stringify(injected.messages)),false)
const finalOptions={db,manifests,messages:injected.messages,sessionId:groupInput.sessionId,runtimeInput:runtimeInputs.read(groupInput.sessionId),groupAllowed:input=>qqGroupAllowed(groupConfig,input)}
eq('检索到 Composer 到最终检查的完整链路通过',validateFinalRequest(finalOptions).ok,true)
groupConfig.groups.allowed=[]
eq('管理配置移除群后旧注入块被拒绝',validateFinalRequest(finalOptions).ok,false)
eq('没有记忆块的群请求也不能绕过名单',validateFinalRequest({...finalOptions,messages:[{role:'user',content:'ordinary'}]}).ok,false)
db.close()
console.log(`[P4-D-2 H21 group-recall-final-check] ${passed} 通过 ${failed} 失败`)
if(failed)process.exitCode=1
