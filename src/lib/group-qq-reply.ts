import {QqBridge,type QqBridgeDeps} from './qq-bridge.js'
/** One RPC per connection. It keeps the logical source Transport, endpoint and account. */
export function createGroupReplyConnection(options:{wsUrl:string;token:string;account:string;groupId:string;active():boolean;timeoutMs?:number;webSocket?:QqBridgeDeps['webSocket']}) {
  let used=false,closed=false
  const bridge=new QqBridge({enabled:true,wsUrl:options.wsUrl,accessToken:options.token,provider:'',model:'',receiveMessages:false,singleConnection:true,sendTimeoutMs:options.timeoutMs??10000}, {
    host:{on:()=>()=>{}},adapter:{announce(){throw new Error('GROUP_REPLY_CANNOT_ANNOUNCE')},forget(){},size:()=>0},
    logger:{info(){},warn(){},error(){}},webSocket:options.webSocket,
    setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:timer=>clearTimeout(timer as ReturnType<typeof setTimeout>),
  })
  const close=async()=>{if(closed)return;closed=true;await bridge.stop()}
  return {
    close,
    async connect():Promise<boolean> {
      if(closed||used||!options.active())return false
      bridge.start()
      const ready=await bridge.transportWaitConnected(options.timeoutMs??10000)
      if(!ready||bridge.adminSnapshot().selfId!==options.account||!options.active()){await close();return false}
      return true
    },
    async send(text:string):Promise<{outcome:'sent'|'failed'|'unknown'|'cancelled';platformMessageId?:string;reason?:string}> {
      if(closed||used||!options.active()||bridge.adminSnapshot().selfId!==options.account)return {outcome:'cancelled',reason:'connection_or_epoch_unavailable'}
      used=true
      try {
        const result=await bridge.sendOutgoingText({kind:'group',groupId:options.groupId},text,{strictAck:true,isActive:options.active})
        if(result.ok) {
          const id=result.messageId
          return {outcome:'sent',...(id&&/^[A-Za-z0-9_:-]{1,120}$/.test(id)?{platformMessageId:id}:{reason:'binding_unavailable'})}
        }
        if(result.error==='inactive-before-send'||result.error==='not-connected')return {outcome:'cancelled',reason:'not_sent'}
        if(result.error?.startsWith('retcode:'))return {outcome:'failed',reason:result.error}
        return {outcome:'unknown',reason:'result_unknown'}
      }catch{return {outcome:'unknown',reason:'send_exception'}}finally{await close()}
    },
  }
}
