const actionPatterns:Record<string,RegExp>={
  edit_draft:/创建|新建|保存|修改|编辑|增加|添加|删除|修复|更新|连接|编排|\b(?:create|save|edit|modify|add|remove|fix|update|connect|compose)\b/gi,
  test:/自测|测试|\btest\b/gi,
  publish:/发布|\bpublish\b/gi,
  start_run:/(?<!试|运)运行(?=一下|一次|一遍|当前|选中|这个|该|已发布|工作流|流程|任务|它|此|并|\s|$)|(?:启动|执行)(?=一下|一次|一遍|当前|选中|这个|该|已发布|工作流|流程|任务|它|此|并|\s|$)|\b(?:run|execute|start)\b(?!\s+(?:mode|principle|environment|workflow\s+design))/gi,
  cancel_run:/取消(?=当前|选中|这个|该|工作流|流程|任务|运行)(?:(?:当前|选中|这个|该)?(?:运行|任务|工作流|流程))?|\bcancel\b(?:\s+(?:the|current|selected|this|workflow))*\s*(?:run\b|execution\b)?/gi,
  advance_run:/继续(?:执行|运行)|推进(?:当前|选中|这个|该|工作流|流程|任务|运行|检查点)|完成分析|\b(?:advance|resume)\b/gi,
  scan:/扫描|发现|同步(?:当前|选中|这个|该)?(?:MCP|工具|能力|连接)?目录|\b(?:scan|discover)\b/gi,
  import:/导入|\bimport\b/gi,
};
const negative=/请勿|切勿|勿|莫|不要|不许|不想|不希望|不需要|不应(?:该)?|不用|不必|不能|不准|不允许|不接受|不打算|不计划|不准备|不愿意|无需|无须|没有必要|没有(?:要求|授权|打算)|并非(?:要)?|暂不|尚不|先不|禁止|避免|别|算了|免了|作罢|放弃|不(?=(?:实际|自动|马上|立即|直接)?(?:执行|运行|启动|发布|测试|自测|保存|修改|扫描|发现|导入))|(?:都|均|一律)不|^\s*不\s*$|\b(?:do\s+not|don['’]t|cannot|can['’]t|won['’]t|shouldn['’]t|mustn['’]t|not|no|never|without|avoid|unnecessary|refrain\s+from)\b/i;
const question=/[?？]|哪|什么|啥|咋|多久|多(?:长|少|大|小|高|低|快|慢|远|近|难|重|宽|深)|(?:有|为|缘)何|何(?:时|处|地|种|人|用|意|故|事|风险|权限|条件)|几点|几次|几步|(?:需要|要|需).{0,8}几|谁|怎样|是否|要不要|需不需要|能不能|可不可以|能否|可否|会不会|行不行|运行不运行|发布不发布|吗\s*$|\b(?:whether|when|where|which|who|should\s+(?:i|we)|can\s+(?:i|we)|could\s+(?:i|we))\b/i;
const informationalDependency=/(?:运行|执行|启动|发布|取消|扫描|发现|导入|测试|自测|创建|保存|修改|删除)(?:当前|选中|这个|该|此)?(?:工作流|流程|任务|运行|工具|能力|目录|MCP|它)(?:前|之前|时|的)?(?:需要|所需|要求|依赖|必须具有|必须具备|须具备).{0,64}(?:权限|条件|授权|准备|资质|配置|前提|环境|凭据|确认|同意)|(?:运行|执行|启动|发布|取消|扫描|发现|导入|测试|自测|创建|保存|修改|删除)(?:当前|选中|这个|该|此)?(?:工作流|流程|任务|运行|工具|能力|目录|MCP)的(?:权限|前置条件|先决条件|必备条件|依赖|限制|要求)\s*$/i;
// An unmet future condition does not grant permission to execute right now.
// This is intent parsing, not an approval node or an approval workflow.
const futureCondition=/(?:等(?:待)?|待)(?:我|你|您|用户|条件|权限|环境|配置|测试|自测|验证|检查|结果|准备|拿到|得到)|(?:等(?:待)?|待)[^，,。；;!?！？\n]*?(?:后|再|才|确认|同意|批准|完成|通过|就绪|满足)|(?:如果|假如|假若|若|要是|假设|倘若|除非|只有|一旦).{0,80}(?:确认|同意|条件|权限|通过|完成|成功|准备|可行)|当(?:我|你|您|用户|条件|权限|环境|配置|测试|自测|验证|检查|结果).{0,80}(?:确认|同意|满足|通过|完成|成功|准备|就绪)|(?:我|用户|你|您)(?:确认|同意|批准)(?:后|之后|以后|前|之前)|(?:确认|同意|条件满足|验证通过|检查通过|自测通过)(?:后|之后|以后)/i;
const immediateCommand=/^(?:请|帮我|请帮我|麻烦你|麻烦)?\s*(?:现在|立即|马上|立刻|此刻)/i;
const englishFutureCondition=/\b(?:after|until|when|if|unless|wait(?:ing)?|await(?:ing)?)\b|\bonce\b(?=\s+(?!(?:more|again|now|only|please|today)\b)\S)/i;
const englishImmediateCommand=/^(?:please\s+)?(?:now|immediately|right\s+now)\b|^(?:please\s+)?(?:run|execute|start|create|save|edit|modify|publish|scan|discover|import)\b[^,;.!?\n]*\b(?:now|immediately)\b/i;
function verbsIn(text:string) {
  return new Set(Object.entries(actionPatterns).filter(([,pattern])=>[...text.matchAll(pattern)].length).map(([verb])=>verb));
}
function englishCondition(clause:string) {
  const match=englishFutureCondition.exec(clause);
  if(!match)return null;
  // "Add/move a node after input" is a graph position, not a future condition.
  if(match[0].toLowerCase()==="after"&&/\b(?:add|insert|move|connect)\b/i.test(clause.slice(0,match.index))&&
    /^(?:the\s+)?(?:input|end|node\s+[a-z][a-z0-9_-]*|[a-z][a-z0-9_-]*)\s*$/i.test(clause.slice(match.index+match[0].length).trim())&&
    !/\b(?:confirmation|approval|permission|authorization|checks?|tests?|validation|verification|tomorrow)\b/i.test(clause.slice(match.index+match[0].length))&&
    !["start_run","advance_run","cancel_run"].some(verb=>verbsIn(clause).has(verb)))return null;
  return match;
}
function independentEnglishPrefix(clause:string,conditionIndex:number) {
  const before=clause.slice(0,conditionIndex);
  const joiner=[...before.matchAll(/\b(?:and(?:\s+then)?|then)\s+(?=(?:please\s+)?(?:create|save|edit|modify|add|remove|fix|update|connect|compose|publish|test|scan|discover|import|cancel|advance|resume|run|execute|start)\b)/gi)].at(-1);
  if(!joiner)return "";
  const prefix=before.slice(0,joiner.index).trim(),current=verbsIn(prefix),conditioned=verbsIn(before.slice(joiner.index));
  // A suffix binds the preceding predicate: "run ... after I confirm" cannot
  // authorize run. Keep only a distinct, complete earlier instruction, such
  // as "create a draft now and run ... after I confirm".
  if(!current.size||[...current].some(verb=>conditioned.has(verb))||
    !prefix.replace(/\b(?:please|now|immediately|first|and|then|create|save|edit|modify|add|remove|fix|update|connect|compose|publish|test|scan|discover|import|cancel|advance|resume|run|execute|start)\b/gi,"").trim())return "";
  return prefix;
}
/** Shared affirmative intent envelope. Negative/quoted/question clauses cannot grant actions. */
export function affirmativeVerbs(text:string):string[] {
  const states=new Map<string,boolean>();
  let deferred=false;
  const unquoted=text.replace(/`[^`]*`|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|(?<![a-z])'[^']*'(?![a-z])/g," ").replace(/\bnot\s+only\b/gi,"also");
  for(const sentence of unquoted.split(/(?<=[。；;!?！？])|\n/)) {
    const sentenceActions=new Set<string>();
    for(const rawClause of sentence.split(/[，,。；;!！?？]|但是|不过|但|而是|\bbut\b|(?=(?:然后|之后|接着|完成后)(?:请)?(?:告诉|说明|汇报|报告|展示|看看))|(?=\b(?:and(?:\s+then)?|then)\s+(?:tell|report|show|explain)\b)/i)) {
      let clause=rawClause.trim();if(!clause)continue;
      const condition=futureCondition.exec(clause),english=englishCondition(clause);
      if(!condition&&!english&&(immediateCommand.test(clause)||englishImmediateCommand.test(clause)))deferred=false;
      const deferredBefore=deferred;
      if(english&&(!condition||english.index<condition.index)){deferred=true;clause=independentEnglishPrefix(clause,english.index);if(!clause)continue;}
      else if(condition){deferred=true;clause=clause.slice(0,condition.index).trim();if(!clause)continue;}
      // A later future clause cannot overwrite an earlier denial. Current
      // instructions before the condition remain independent of that clause.
      if(deferredBefore&&!negative.test(clause))continue;
      if(/解释|说明|原理|如何|怎么|为什么|讲讲|谈谈|说说|介绍|\b(?:explain|describe|how|why|what)\b/i.test(clause))continue;
      if(informationalDependency.test(clause))continue;
      if(/(?:运行|执行|启动|发布|取消|扫描|发现|导入|测试|自测|创建|保存|修改|删除).{0,24}(?:需要|所需|必要|前置|满足).{0,16}条件|(?:运行|执行|启动|发布|取消|扫描|发现|导入|测试|自测|创建|保存|修改|删除)(?:当前|选中|这个|该)?(?:工作流|流程|任务)?的?条件\s*$/.test(clause))continue;
      if(/(?:给(?:我|个|出|一份|一个)?|提供|列出).{0,20}(?:方案|建议|思路)|(?:只|仅|先).{0,8}(?:方案|设计图)/.test(clause)&&!/(?:并|然后|接着)(?:保存|修改|应用|实现)/.test(clause))continue;
      const asking=question.test(clause)||(/[?？]/.test(sentence)&&sentence.trim().replace(/[?？]+$/,"").endsWith(clause));
      clause=clause.replace(/(?:dry|trial|test)[-\s]run|试运行|运行原理|运行模式|运行环境/gi," ");
      const matches=Object.entries(actionPatterns).flatMap(([action,pattern])=>[...clause.matchAll(pattern)].map(match=>({action,index:match.index!,end:match.index!+match[0].length})));
      // In "cancel current run", run is the object of cancel, not another command.
      const occurrences=matches.filter(item=>item.action!=="start_run"||!matches.some(other=>["cancel_run","advance_run"].includes(other.action)&&other.index<=item.index&&other.end>item.index)).sort((a,b)=>a.index-b.index);
      const neg=negative.exec(clause);
      if(asking){
        const reportAfter=/^(?:然后|之后|接着|完成后|运行后|保存后|再)(?:请|帮我|给我)?(?:告诉|说明|汇报|报告|展示|看看)|^(?:and\s+)?then\b|^(?:and(?:\s+then)?|then)\s+(?:tell|report|show|explain)\b/i.test(clause);
        for(const action of reportAfter?[]:occurrences.length?occurrences.map(item=>item.action):sentenceActions)states.set(action,false);
        continue;
      }
      if(!occurrences.length){if(neg)for(const action of sentenceActions)states.set(action,false);continue;}
      const lastAction=occurrences.at(-1)!.index,postfix=!!neg&&neg.index>lastAction;
      for(const occurrence of occurrences){const allowed=!deferredBefore&&(!neg||!postfix&&occurrence.index<neg.index);states.set(occurrence.action,allowed);sentenceActions.add(occurrence.action);}
    }
  }
  // An exclusive request narrows the action envelope; deterministic self-test remains available.
  if(/只(?:做|进行)?(?:自测|测试)|仅(?:做|进行)?(?:自测|测试)|\bonly\s+(?:self[- ]?)?test\b/i.test(unquoted))for(const action of ["publish","start_run","advance_run","cancel_run","scan","import"])states.set(action,false);
  if(/只保存|仅保存|\bonly\s+save\b/i.test(unquoted))for(const action of ["publish","start_run","advance_run","cancel_run"])states.set(action,false);
  return Object.keys(actionPatterns).filter(action=>states.get(action));
}
export function requestedActions(text:string):string[] {
  const verbs=new Set(affirmativeVerbs(text));
  return ["edit_draft","test","publish","run","discover"].filter(action=>action==="run"?["start_run","advance_run","cancel_run"].some(verb=>verbs.has(verb)):action==="discover"?["scan","import"].some(verb=>verbs.has(verb)):verbs.has(action));
}
