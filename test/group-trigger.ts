import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Core,openDatabase,groupRoomPolicies,roomPolicy,groupNameMatches,groupPartsText,groupSilenced} from '../packages/core/dist/index.js'
import {groupMessageForCapture} from '../dist/lib/qq-group-ingress.js'
let passed=0,failed=0
const eq=(name,a,b)=>{if(JSON.stringify(a)===JSON.stringify(b)){passed++;console.log(' ok '+name)}else{failed++;console.error(' FAIL '+name,{a,b})}}
const rejects=async(name,fn)=>{let no=false;try{await fn()}catch{no=true}eq(name,no,true)}
const raw=(extra={})=>({externalRoomId:'41001',silence:{timezone:'Asia/Shanghai'},names:['心灵'],...extra})
const parse=(entry=raw())=>groupRoomPolicies({enabled:true,allowed:[entry]})
for(const value of [null,{}, {enabled:'true',allowed:[raw()]},{enabled:true,allowed:[raw()],extra:1}])eq('非法根全拒',groupRoomPolicies(value).size,0)
for(const extra of [{externalRoomId:41001},{names:['心灵','心灵']},{names:['']},{names:['小 伴']},{names:['x'.repeat(33)]},{triggers:{question:true}},{reply:{enabled:'true'}},{merge:{maxMessages:21}},{merge:{quietMs:2001}},{merge:{quietMs:10,maxWaitMs:9}},{maxTurnsPerHour:7},{silence:{timezone:'UTC',windows:['08:00-08:00']}},{silence:{timezone:'+08:00'}},{extra:1},{captureMode:null},{names:null},{silence:{timezone:'UTC',mode:null}},{silence:{timezone:'UTC',windows:null}},{policyHash:'forged'}])eq('非法条目全拒',parse(raw(extra)).size,0)
eq('重复群号全部失效',groupRoomPolicies({enabled:true,allowed:[raw(),raw()]}).size,0)
eq('非法项不影响其他群',groupRoomPolicies({enabled:true,allowed:[raw({names:['']}),raw({externalRoomId:'41002'})]}).size,1)
const p=roomPolicy(raw())
eq('缺省值与独立回复开关',[p.captureMode,p.reply.enabled,p.maxTurnsPerHour,p.merge.maxChars],['mentioned_only',false,6,4000])
eq('策略及嵌套不可变',[Object.isFrozen(p),Object.isFrozen(p.names),Object.isFrozen(p.merge)],[true,true,true])
eq('策略重建hash稳定',roomPolicy(p).policyHash,p.policyHash)
await rejects('伪造策略摘要拒绝',()=>roomPolicy({...p,policyHash:'fake'}))
for(const [text,hit] of [['心灵，你好',true],['?心灵?',true],['小心灵',false],['心灵2',false],['心灵你觉得呢',false],['？',false],['Psyche',false]])eq('精确token '+text,groupNameMatches([{type:'text',text}],p.names).length>0,hit)
eq('相邻段不能伪造边界',groupNameMatches([{type:'text',text:'小'},{type:'text',text:'心灵'}],p.names).length,0)
eq('真实非文本形成边界',groupNameMatches([{type:'text',text:'小'},{type:'other'},{type:'text',text:'心灵'}],p.names).length,1)
const parts=[{type:'text',text:'   '},{type:'reply',id:'123'},{type:'text',text:'  心灵，你好 '}]
const hit=groupNameMatches(parts,p.names)[0],text=groupPartsText(parts)
eq('trim及段偏移可重建',text.slice(hit.start,hit.end),'心灵')
const nfc=groupNameMatches([{type:'text',text:'  Cafe\u0301!'}],['Café'])[0]
eq('NFC匹配保留原文偏移',['  Cafe\u0301!'.trim().slice(nfc.start,nfc.end).normalize('NFC'),nfc.name],['Café','Café'])
const at=Date.parse('2026-11-14T15:00:00Z')
const silent=roomPolicy(raw({silence:{timezone:'Asia/Shanghai',windows:['23:00-08:00']}}))
eq('23点左闭',groupSilenced(silent,at),true)
eq('8点右开',groupSilenced(silent,Date.parse('2026-11-15T00:00:00Z')),false)
eq('direct-only只允许既定直接触发',groupSilenced(roomPolicy({...silent,policyHash:undefined,silence:{...silent.silence,mode:'direct-only'}}),at),false)
const event={post_type:'message',message_type:'group',sub_type:'normal',group_id:'41001',user_id:'31001',self_id:'39999',message_id:'m1',message:[{type:'reply',data:{id:'old',text:'心灵？'}},{type:'text',data:{text:'普通聊天'}}],raw_message:'心灵？'}
const input=groupMessageForCapture(event,parse(),'fake','2026-11-14T04:00:00.000Z')
eq('旧引用/raw内容不成为当前name',groupNameMatches(input.parts,p.names).length,0)
eq('当前正文仅取顶层段',input.text.includes('心灵'),false)
const stringEvent=groupMessageForCapture({...event,message:'心灵，你好'},parse(),'raw','2026-11-14T04:00:00.000Z')
eq('纯文本字符串格式可验证点名',groupNameMatches(stringEvent.parts,p.names).length,1)
const cqEvent=groupMessageForCapture({...event,message:'[CQ:reply,id=123,text=心灵]'},parse(),'raw','2026-11-14T04:00:00.000Z')
eq('CQ字符串不推断结构化点名证据',cqEvent.parts,undefined)
const dir=mkdtempSync(join(tmpdir(),'psyche-group-trigger-'))
const {db}=await openDatabase({file:join(dir,'memory.sqlite3'),logger:{}})
const core=new Core({db,config:{},logger:{},dataDir:dir})
const make=(id,parts,policy=p)=>({externalRoomId:'41001',stableUserId:'31001',selfId:'39999',messageId:id,parts,text:groupPartsText(parts),policy,captureMode:policy.captureMode,at:'2026-11-14T04:00:00.000Z'})
const selected=await core.ingestGroupMessage(make('named',[{type:'text',text:'心灵，你好'}]))
eq('首次点名保留正文',selected.retained,true)
eq('默认不唤醒',db.get('SELECT state FROM room_triggers').state,'suppressed')
const old=await core.ingestGroupMessage(make('old',[{type:'text',text:'普通群聊'}]))
eq('未选中仍最小记录',[old.sourceId,old.eventId],[null,null])
eq('重放不升级',(await core.ingestGroupMessage(make('old',[{type:'text',text:'心灵，你好'}]))).sourceId,null)
await rejects('Core拒绝伪造当前段/正文',()=>core.ingestGroupMessage({...make('forged',[{type:'text',text:'心灵'}]),text:'没有点名'}))
await rejects('Core复核结构化at身份',()=>core.ingestGroupMessage({...make('forged-at',[{type:'text',text:'普通群消息'}]),mentions:['39999']}))
await rejects('Core拒绝换群策略',()=>core.ingestGroupMessage(make('wrong',[{type:'text',text:'心灵'}],roomPolicy(raw({externalRoomId:'41002'})))))
const source=db.get('SELECT * FROM sources WHERE source_id=?',[selected.sourceId])
eq('来源只存一份正文',JSON.stringify(JSON.parse(source.metadata)).includes('心灵，你好'),false)
eq('未采正文不进operations',JSON.stringify(db.all('SELECT result,error FROM operations')).includes('普通群聊'),false)
eq('仍零Turn/水位',core.readGroupIntake(selected.roomId).state.read_through_seq,0)
db.close()
console.log(`[P4-D-2 group-trigger] ${passed} 通过 ${failed} 失败`)
if(failed)process.exitCode=1
