export { requestedActions } from "../../../../packages/contracts/src/assistant-intent.js";
export type Api=(path:string,method?:string,body?:any,revision?:number)=>Promise<any>;
let eventCursor=0;
export function subscribeEvents(listener:(event:any)=>void,after=eventCursor,onConnection?:(state:"open"|"reconnecting")=>void) {
  const source=new EventSource('/api/v2/events?afterEventId='+after);
  let delivered=after;
  source.onopen=()=>onConnection?.("open");source.onerror=()=>onConnection?.("reconnecting");
  source.onmessage=event=>{try{const value=JSON.parse(event.data),id=Number(event.lastEventId)||value.eventId||0;eventCursor=Math.max(eventCursor,id);if(id&&id<=delivered)return;delivered=Math.max(delivered,id);if(value.type!=='cursor')listener(value);}catch{}};
  return ()=>source.close();
}
