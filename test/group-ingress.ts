import { QqBridge } from '../dist/lib/qq-bridge.js'
import { groupCapturePolicies, groupMessageForCapture } from '../dist/lib/qq-group-ingress.js'
let passed=0,failed=0
function eq(label,a,b){if(JSON.stringify(a)===JSON.stringify(b)){passed++;console.log('  ok '+label)}else{failed++;console.error(' FAIL '+label,{a,b})}}
const entry=(externalRoomId='41001',extra={})=>({externalRoomId,captureMode:'mentioned_only',silence:{timezone:'Asia/Shanghai'},...extra})
const config=(allowed=[entry()])=>({enabled:true,allowed})
for(const [label,value] of [['缺配置',undefined],['默认关闭',{enabled:false,allowed:[entry()]}],['非布尔enabled',{enabled:'true',allowed:[entry()]}],['非法名单',{enabled:true,allowed:'*'}]])eq(label,groupCapturePolicies(value).size,0)
for(const [label,extra] of [['非法模式',{captureMode:'any'}],['缺时区',{silence:{}}],['未知时区',{silence:{timezone:'Unknown/Zone'}}],['固定偏移不猜IANA',{silence:{timezone:'+08:00'}}],['非法静默窗口',{silence:{timezone:'Asia/Shanghai',windows:['25:00-08:00']}}],['未实现调度项',{merge:{quietMs:2000}}]])eq(label,groupCapturePolicies(config([entry('41001',extra)])).size,0)
eq('单项非法不破坏其他白名单',groupCapturePolicies(config([entry('41001',{captureMode:'bad'}),entry('41002')])).has('41002'),true)
eq('重复群号不择一授予',groupCapturePolicies(config([entry(),entry()])).size,0)
eq('配置群号必须是字符串',groupCapturePolicies(config([entry(41001)])).size,0)
eq('默认mentioned_only',groupCapturePolicies(config([{externalRoomId:'41001',silence:{timezone:'UTC'}}])).get('41001'),'mentioned_only')
const event=(mid='m1',extra={})=>({post_type:'message',message_type:'group',sub_type:'normal',self_id:'39999',user_id:'31001',group_id:'41001',message_id:mid,raw_message:'GROUP-INGRESS-SECRET',...extra})
const policies=groupCapturePolicies(config())
eq('纯文本CQ伪造不当真实at',groupMessageForCapture(event('cq',{raw_message:'[CQ:at,qq=39999]'}),policies,'text','2026-11-13T04:00:00.000Z').mentions,[])
eq('真实at/reply段取协议身份',groupMessageForCapture(event('seg',{message:[{type:'at',data:{qq:'39999'}},{type:'reply',data:{id:-123}}]}),policies,'text','2026-11-13T04:00:00.000Z').replyToMessageId,'-123')
eq('发送者字段矛盾拒绝',groupMessageForCapture(event('bad',{sender:{user_id:'31002'}}),policies,'text','2026-11-13T04:00:00.000Z'),null)
class Socket {
 static last
 listeners=new Map();sent=[]
 constructor(){Socket.last=this}
 addEventListener(type,fn){this.listeners.set(type,[...(this.listeners.get(type)??[]),fn])}
 emit(type,value){for(const fn of this.listeners.get(type)??[])fn(value)}
 message(value){this.emit('message',{data:JSON.stringify(value)})}
 send(value){this.sent.push(value)}
 close(){}
}
const flush=async()=>{for(let i=0;i<30;i++)await new Promise((r)=>setImmediate(r))}
function harness(groups=config(),sinkOverride){
 const inputs=[],logs=[];const calls={announce:0,agent:0,followup:0}
 const bridge=new QqBridge({enabled:true,wsUrl:'ws://127.0.0.1:1',accessToken:'',provider:'',model:'',groups,allowFrom:{owner:'31001',extra:[]}}, {
 host:{on:()=>()=>{},agents:{get:()=>({followup(){calls.followup++}}),create:async()=>{calls.agent++;throw Error('must not create')},resume:async()=>{calls.agent++;throw Error('must not resume')}}},
 adapter:{announce(){calls.announce++},forget(){},size:()=>0},logger:{info:(...v)=>logs.push(v),warn:(...v)=>logs.push(v),error:(...v)=>logs.push(v)},
 webSocket:Socket,isSessionBound:()=>true,
 ingestGroupMessage:sinkOverride??(async(input)=>{inputs.push(input);return {retained:false,replayed:false}}),
 })
 bridge.start();const socket=Socket.last;socket.emit('open');return {bridge,socket,inputs,logs,calls}
}
{
 const h=harness();h.socket.message(event());await flush()
 eq('白名单群交给采集一次',h.inputs.length,1)
 eq('D1群不声明Adapter/Agent/投递',[h.calls.announce,h.calls.agent,h.calls.followup],[0,0,0])
 eq('D1群不回复',h.socket.sent.length,0)
 eq('群只计received不计delivered',[h.bridge.adminSnapshot().counts.received,h.bridge.adminSnapshot().counts.delivered],[1,0])
 eq('日志不含群正文',JSON.stringify(h.logs).includes('GROUP-INGRESS-SECRET'),false)
 h.socket.message(event());await flush();eq('重放交给持久化去重不被内存吞掉',h.inputs.length,2)
 h.socket.message(event('shared',{message_type:'private',sub_type:'friend'}));await flush();h.socket.message(event('shared'));await flush()
 eq('私聊与群同消息ID不互相遮蔽',h.inputs.length,3)
 eq('私聊原路径仍可投递',h.calls.followup,1)
 await h.bridge.stop()
}
for(const [label,groups,value] of [
 ['关闭群',{enabled:false,allowed:[entry()]},event()],['白名单外',config(),event('outside',{group_id:'49999'})],['临时私聊',config(),event('tmp',{message_type:'private',sub_type:'group'})],
 ['非normal群消息',config(),event('anonymous',{sub_type:'anonymous'})],['缺消息身份',config(),event(undefined,{message_id:undefined})],['缺发送者',config(),event('sender',{user_id:undefined})],
]){
 const h=harness(groups);h.socket.message(value);await flush()
 eq(`${label}零采集/Agent/回复`,[h.inputs.length,h.calls.announce,h.calls.agent,h.socket.sent.length],[0,0,0,0]);await h.bridge.stop()
}
{
 let release;let writes=0
 const held=new Promise((r)=>{release=r})
 const h=harness(config(),async(_input,isActive)=>{await held;if(!isActive())return null;writes++;return {retained:false,replayed:false}})
 h.socket.message(event());h.socket.message(event('late'));await flush();await h.bridge.stop();release();await flush()
 eq('卸载后迟到准备和队列不写库',writes,0)
}
{
 const h=harness(config(),async()=>{throw Error('GROUP-INGRESS-SECRET')});h.socket.message(event());await flush()
 eq('采集错误日志不泄露正文',JSON.stringify(h.logs).includes('GROUP-INGRESS-SECRET'),false)
 eq('采集错误可观测',JSON.stringify(h.logs).includes('GROUP_INTAKE_FAILED'),true)
 await h.bridge.stop()
}
console.log(`[P4-D-1 group-ingress] ${passed} 通过 ${failed} 失败`)
if(failed)process.exitCode=1
