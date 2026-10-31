export { requestedActions } from "../../../../packages/contracts/src/assistant-intent.js";
export type Api=(path:string,method?:string,body?:any,revision?:number)=>Promise<any>;
let eventCursor=0;
export function subscribeEvents(listener:(event:any)=>void,after=eventCursor) {
  const source=new EventSource('/api/v2/events?afterEventId='+after);
  source.onmessage=event=>{try{const value=JSON.parse(event.data);eventCursor=Math.max(eventCursor,Number(event.lastEventId)||value.eventId||0);if(value.type!=='cursor')listener(value);}catch{}};
  return ()=>source.close();
}
