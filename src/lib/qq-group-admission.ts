import {groupRoomPolicies,type RuntimeInput} from 'dsh-psyche-core'

/** Host configuration only. Existing Rooms and private allowFrom never grant group admission. */
export function qqGroupAllowed(config:{enabled?:boolean;groups?:unknown}|undefined,input:RuntimeInput):boolean {
  return config?.enabled===true&&input.platform==='qq'&&typeof input.groupId==='string'&&groupRoomPolicies(config.groups).has(input.groupId)
}
