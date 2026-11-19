import { openDatabase } from '../../packages/core/dist/adapter.js'
import { Core } from '../../packages/core/dist/store.js'
const file=process.argv[2]
const log={info(){},debug(){},warn(){},error(){}}
const {db}=await openDatabase({file,logger:log})
const core=new Core({db,config:{},logger:log,dataDir:file})
try {
 const results=[]
 for(const [room,message] of [['41001','m1'],['41001','m2'],['41002','m1']]) results.push(await core.ingestGroupMessage({externalRoomId:room,stableUserId:'31001',messageId:message,selfId:'39999',mentions:['39999'],text:'CONCURRENT-GROUP',captureMode:'mentioned_only',at:'2026-11-13T04:00:00.000Z'}))
 console.log(JSON.stringify(results.map((r)=>({roomId:r.roomId,roomSeq:r.roomSeq,sourceId:r.sourceId,replayed:r.replayed}))))
}finally{db.close()}
