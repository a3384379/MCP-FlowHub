export type Api=(path:string,method?:string,body?:any,revision?:number)=>Promise<any>;
export function subscribeEvents(listener:(event:any)=>void,after=0) {
  const source=new EventSource('/api/v2/events?afterEventId='+after);
  source.onmessage=event=>{try{const value=JSON.parse(event.data);if(value.type!=='cursor')listener(value);}catch{}};
  return ()=>source.close();
}
export function requestedActions(text:string) {
  if(/只解释|仅解释|只问|不要修改|explain only/i.test(text))return [];
  const actions=['edit_draft'];
  if(/测试|自测|test/i.test(text)&&!/不要测试|不测试/.test(text))actions.push('test');
  if(/发布|publish/i.test(text)&&!/不要发布|不发布|不执行发布|仅保存|只保存/.test(text))actions.push('publish');
  if(/运行|执行|run/i.test(text)&&!/不要执行|不执行|不要运行|不运行|仅保存|只保存/.test(text))actions.push('run');
  if(/扫描|发现|导入|scan|discover|import/i.test(text))actions.push('discover');
  return actions;
}
