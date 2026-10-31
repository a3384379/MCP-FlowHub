const actionPatterns:Record<string,RegExp>={
  edit_draft:/创建|新建|保存|修改|编辑|增加|添加|删除|修复|更新|连接|编排|\b(?:create|save|edit|modify|add|remove|fix|update|connect|compose)\b/gi,
  test:/自测|测试|\btest\b/gi,
  publish:/发布|\bpublish\b/gi,
  run:/取消(?=当前|选中|这个|该|工作流|流程|任务|运行)|\bcancel\b|(?<!试|运)运行(?=一下|一次|一遍|当前|选中|这个|该|已发布|工作流|流程|任务|它|此|并|\s|$)|(?:启动|执行)(?=一下|一次|一遍|当前|选中|这个|该|已发布|工作流|流程|任务|它|此|并|\s|$)|\b(?:run|execute|start)\b(?!\s+(?:mode|principle|environment|workflow\s+design))/gi,
  discover:/扫描|发现|导入|\b(?:scan|discover|import)\b/gi,
};
const negative=/请勿|切勿|勿|莫|不要|不许|不想|不希望|不需要|不应(?:该)?|不用|不必|不能|不准|不允许|不接受|不打算|不计划|不准备|不愿意|无需|无须|没有必要|没有(?:要求|授权|打算)|并非(?:要)?|暂不|尚不|先不|禁止|避免|别|算了|免了|作罢|放弃|不(?=(?:实际|自动|马上|立即|直接)?(?:执行|运行|启动|发布|测试|自测|保存|修改|扫描|发现|导入))|(?:都|均|一律)不|^\s*不\s*$|\b(?:do\s+not|don['’]t|cannot|can['’]t|won['’]t|shouldn['’]t|mustn['’]t|not|no|never|without|avoid|unnecessary|refrain\s+from)\b/i;
const question=/[?？]|是否|要不要|需不需要|能不能|可不可以|能否|可否|会不会|行不行|运行不运行|发布不发布|吗\s*$|\b(?:whether|should\s+(?:i|we)|can\s+(?:i|we)|could\s+(?:i|we))\b/i;
/** Shared affirmative intent envelope. Negative/quoted/question clauses cannot grant actions. */
export function requestedActions(text:string):string[] {
  const states=new Map<string,boolean>();
  const unquoted=text.replace(/`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"|(?<![a-z])'[^']*'(?![a-z])/g," ").replace(/\bnot\s+only\b/gi,"also");
  for(const sentence of unquoted.split(/(?<=[。；;!?！？])|\n/)) {
    const sentenceActions=new Set<string>();
    for(const rawClause of sentence.split(/[，,。；;!！?？]|但是|不过|但|而是|\bbut\b/i)) {
      let clause=rawClause.trim();if(!clause)continue;
      if(/解释|说明|原理|如何|怎么|为什么|\b(?:explain|describe|how|why|what)\b/i.test(clause))continue;
      const asking=question.test(clause)||(/[?？]/.test(sentence)&&sentence.trim().replace(/[?？]+$/,"").endsWith(clause));
      clause=clause.replace(/(?:dry|trial|test)[-\s]run|试运行|运行原理|运行模式|运行环境/gi," ");
      const occurrences=Object.entries(actionPatterns).flatMap(([action,pattern])=>[...clause.matchAll(pattern)].map(match=>({action,index:match.index!}))).sort((a,b)=>a.index-b.index);
      const neg=negative.exec(clause);
      if(asking){for(const action of occurrences.length?occurrences.map(item=>item.action):sentenceActions)states.set(action,false);continue;}
      if(!occurrences.length){if(neg)for(const action of sentenceActions)states.set(action,false);continue;}
      const lastAction=occurrences.at(-1)!.index,postfix=!!neg&&neg.index>lastAction;
      for(const occurrence of occurrences){const allowed=!neg||!postfix&&occurrence.index<neg.index;states.set(occurrence.action,allowed);sentenceActions.add(occurrence.action);}
    }
  }
  // An exclusive request narrows the action envelope; deterministic self-test remains available.
  if(/只(?:做|进行)?(?:自测|测试)|仅(?:做|进行)?(?:自测|测试)|\bonly\s+(?:self[- ]?)?test\b/i.test(unquoted))for(const action of ["publish","run","discover"])states.set(action,false);
  if(/只保存|仅保存|\bonly\s+save\b/i.test(unquoted)){states.set("publish",false);states.set("run",false);}
  return ["edit_draft","test","publish","run","discover"].filter(action=>states.get(action));
}
