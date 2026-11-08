import {test,expect,type Page} from "@playwright/test";
import {readFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {randomUUID} from "node:crypto";
import {createServer} from "node:http";
import {McpServer,fromJsonSchema} from "@modelcontextprotocol/server";

type Api=(path:string,method?:string,body?:any,revision?:number)=>Promise<any>;
async function authenticate(page:Page):Promise<Api>{
  const password="Synthetic-browser-password-041",state=(await(await page.request.get("/api/v1/auth/state")).json()).data;
  const response=await page.request.post("/api/v1/auth/"+(state.initialized?"session":"bootstrap"),{data:state.initialized?{password}:{password,setupToken:await readFile(join(process.env.FLOWHUB_UI_DATA_DIR!,"admin-setup-token"),"utf8")}});
  expect(response.ok(),await response.text()).toBeTruthy();const csrf=(await response.json()).data.csrf;
  const api:Api=async(path,method="GET",body?,revision?)=>{const r=await page.request.fetch(path,{method,headers:{"X-CSRF-Token":csrf,...(revision===undefined?{}:{"If-Match":String(revision)})},...(body===undefined?{}:{data:body})});expect(r.ok(),await r.text()).toBeTruthy();return(await r.json()).data;};
  if((await api("/api/v1/auth/state")).vaultLocked)await api("/api/v1/vault/unlock","POST",{password});
  return api;
}
async function createBlank(api:Api,name:string){const id="ui-mode-"+randomUUID().slice(0,8);await api("/api/v2/workflows","POST",{workflowId:id,name,environment:"test",mode:"auto",template:"blank",idempotencyKey:randomUUID()});return id;}

// This real SDK endpoint is a disposable, in-memory protocol fixture. Its
// read-only implementation and data are synthetic; it cannot prove enterprise
// permissions, real production behavior, or current Windows compatibility.
async function scopedFixture(api:Api){
  const control={hold:false,release:()=>{}},calls:any[]=[],token="Synthetic-ui-scoped-token-"+randomUUID(),inputSchema={type:"object",properties:{id:{type:"string"},environment:{const:"test"},resourceId:{const:"UI_ONLY"}},required:["id","environment","resourceId"],additionalProperties:false},outputSchema={type:"object",properties:{environment:{const:"test"},value:{type:"string"}},required:["environment","value"],additionalProperties:false};
  const {createLocalHttp}=await import(pathToFileURL(resolve("dist/apps/daemon/src/http.js")).href);
  const server=createLocalHttp(()=>{const mcp=new McpServer({name:"isolated-ui-scope-fixture",version:"1.0.0"},{capabilities:{tools:{}}});mcp.registerTool("ui_scoped_read",{inputSchema:fromJsonSchema(inputSchema),outputSchema:fromJsonSchema(outputSchema),annotations:{readOnlyHint:true}},async(args:any)=>{calls.push(args);if(control.hold)await new Promise<void>(resolve=>{control.release=resolve;});const value={environment:"test",value:"local-fixture:"+args.id};return {content:[{type:"text",text:JSON.stringify(value)}],structuredContent:value};});return mcp;},token);
  await server.listen({host:"127.0.0.1",port:0});const port=(server.server.address() as any).port;
  try{
    const secret=await api("/api/v1/secrets","POST",{label:"Isolated UI MCP token",purpose:"mcp_auth",value:token,idempotencyKey:randomUUID()}),connection=await api("/api/v1/connections","POST",{name:"Isolated UI scope MCP",transport:"streamable_http",protocolEra:"modern",endpoint:"http://127.0.0.1:"+port+"/mcp",allowedHosts:["127.0.0.1"],secretRef:secret.id});
    await api("/api/v1/connections/"+connection.id+"/sync-tools","POST",{});
    const created=await api("/api/v1/bindings","POST",{name:"UI限定读取",connectionId:connection.id,environment:"test",allowedTools:["ui_scoped_read"],lockedArguments:{"/environment":"test","/resourceId":"UI_ONLY"},allowedQueryTemplates:[],maxRows:10,timeoutSeconds:5});
    const binding=await api("/api/v1/bindings/"+created.id+"/verify","POST",{probe:{toolName:"ui_scoped_read",arguments:{id:"PROBE",environment:"test",resourceId:"UI_ONLY"}},serverEnforcedReadOnly:true,scope:"disposable in-memory UI fixture only",expectedEnvironmentPointer:"/environment"});
    expect(binding.validationStatus).toBe("BINDING_VERIFIED");
    const conn=(await api("/api/v1/connections")).find((c:any)=>c.id===connection.id),tool=conn.tools.find((t:any)=>t.name==="ui_scoped_read");
    return {binding,tool,calls,control,close:async()=>{control.release();server.server.closeAllConnections();await server.close();}};
  }catch(e){await server.close();throw e;}
}

test("testing UI keeps Mock default, Contract catalog-only and Live explicitly scoped through real MCP",async({page})=>{
  test.setTimeout(90000);const started=Date.now(),phases:any[]=[];const api=await authenticate(page),fixture=await scopedFixture(api),workflowId=await createBlank(api,"分级验证真实交互");
  try{
    await api("/api/v2/workflows/"+workflowId+"/operations","POST",{expectedRevision:1,idempotencyKey:randomUUID(),operations:[{op:"set_input_schema",schema:{type:"object",properties:{orderNo:{type:"string"}},required:["orderNo"],additionalProperties:false}},{op:"set_binding",key:"read",bindingId:fixture.binding.id},{op:"add_node",nodeId:"lookup",nodeType:"mcp_tool",title:"限定读取",config:{bindingKey:"read",toolName:fixture.tool.name,toolSchemaHash:fixture.tool.schemaHash,argumentsMappings:{"/id":{ref:{source:"input",pointer:"/orderNo"}}}}},{op:"disconnect",source:"input",target:"end",port:"next"},{op:"connect",source:"input",target:"lookup",port:"next"},{op:"connect",source:"lookup",target:"end",port:"next"}]},1);
    const created=await api("/api/v2/workflows/"+workflowId+"/test-suites","POST",{expectedRevision:2,strategy:"agent_proposed",idempotencyKey:randomUUID(),proposedCases:[{id:"scoped",name:"限定输入",inputs:{orderNo:"UI-ONLY-1"},mockResults:[],agentSubmissions:[],assertions:[{kind:"terminal_state",expected:"SUCCEEDED"},{kind:"output_equals",nodeId:"lookup",pointer:"/value",expected:"local-fixture:UI-ONLY-1"}],expectedValidationErrors:[]}]});
    const suite=await api("/api/v2/test-suites/"+created.suiteId);const baseline=fixture.calls.length;
    await page.goto("/workflows/"+workflowId+"/editor");const panel=page.getByRole("region",{name:"工作流自测",exact:true});
    await expect(panel.getByLabel("验证级别",{exact:true})).toHaveValue("mock");await expect(panel.getByRole("button",{name:"运行 Mock",exact:true})).toBeEnabled();
    let requests=0;page.on("request",request=>{if(/\/test-suites\/[^/]+\/runs$/.test(new URL(request.url()).pathname)&&request.method()==="POST")requests++;});
    await panel.getByLabel("验证级别",{exact:true}).selectOption("contract");await expect(panel.getByRole("button",{name:"验证协议契约",exact:true})).toBeDisabled();
    expect(requests).toBe(0);expect(fixture.calls.length).toBe(baseline);
    await panel.getByLabel("UI限定读取 · test",{exact:true}).check();await panel.getByLabel("最大调用次数",{exact:true}).fill("2");
    const contractResponse=page.waitForResponse(response=>/\/test-suites\/[^/]+\/runs$/.test(new URL(response.url()).pathname)&&response.request().method()==="POST");
    await panel.getByRole("button",{name:"验证协议契约",exact:true}).click();const contract=await contractResponse;expect(contract.ok(),await contract.text()).toBeTruthy();
    const contractRequest=contract.request().postDataJSON();expect(contractRequest).toMatchObject({mode:"contract",allowedBindingIds:[fixture.binding.id],budgets:{maxCalls:2,timeoutMs:10000}});expect(contractRequest.inputScope).toBeUndefined();
    await expect(panel.getByText("实际自测状态：SUCCEEDED",{exact:true})).toBeVisible();await expect(panel.getByText("协议契约结果不等于数据流自测或真实业务权限验证。",{exact:true})).toBeVisible();expect(fixture.calls.length).toBe(baseline);
    const contractRun=await api("/api/v2/test-runs/"+(await contract.json()).data.testRunId);expect(contractRun).toMatchObject({mode:"contract",validationLevel:"contract",toolCalls:0});expect(contractRun.cases).toEqual([]);
    await panel.getByLabel("验证级别",{exact:true}).selectOption("live");await expect(panel.getByRole("button",{name:"运行 Live",exact:true})).toBeDisabled();await expect(panel.getByLabel("UI限定读取 · test",{exact:true})).not.toBeChecked();expect(requests).toBe(1);
    await panel.getByLabel("UI限定读取 · test",{exact:true}).check();await expect(panel.getByRole("button",{name:"运行 Live",exact:true})).toBeDisabled();
    await panel.getByLabel("限定输入 · scoped",{exact:true}).check();await expect(panel.locator('pre[aria-label="输入范围：限定输入"]')).toContainText('"orderNo": "UI-ONLY-1"');
    const liveResponse=page.waitForResponse(response=>/\/test-suites\/[^/]+\/runs$/.test(new URL(response.url()).pathname)&&response.request().method()==="POST");
    await panel.getByRole("button",{name:"运行 Live",exact:true}).click();const live=await liveResponse;expect(live.ok(),await live.text()).toBeTruthy();expect(live.request().postDataJSON()).toMatchObject({mode:"live",caseIds:["scoped"],allowedBindingIds:[fixture.binding.id],inputScope:{fixtureHash:suite.fixtureHash,caseInputs:[{caseId:"scoped",inputs:{orderNo:"UI-ONLY-1"}}]},budgets:{maxCalls:2,timeoutMs:10000}});
    await expect.poll(()=>fixture.calls.length).toBe(baseline+1);await expect(panel.getByText("实际自测状态：SUCCEEDED",{exact:true})).toBeVisible();expect(fixture.calls.at(-1)).toEqual({id:"UI-ONLY-1",environment:"test",resourceId:"UI_ONLY"});
    const run=await api("/api/v2/test-runs/"+(await live.json()).data.testRunId);expect(run).toMatchObject({status:"SUCCEEDED",mode:"live",toolCalls:1,stale:false});
    await expect(panel.getByText(/实际验证级别：Live/)).toBeVisible();await expect(panel.getByText(/凭据读取统计：未计量/)).toBeVisible();
    phases.push({phase:"verified_first_live",elapsedMs:Date.now()-started});fixture.control.hold=true;
    const pendingResponse=page.waitForResponse(response=>/\/test-suites\/[^/]+\/runs$/.test(new URL(response.url()).pathname)&&response.request().method()==="POST");
    await panel.getByRole("button",{name:"运行 Live",exact:true}).click();const pendingRunId=(await(await pendingResponse).json()).data.testRunId;
    await expect.poll(()=>fixture.calls.length).toBe(baseline+2);await panel.getByRole("button",{name:"取消自测",exact:true}).click();
    await expect(panel.getByText("已派发调用的远端结果未知；取消仅停止本地后续执行，不会自动重试。",{exact:true})).toBeVisible();
    phases.push({phase:"cancel_outcome_displayed",elapsedMs:Date.now()-started});fixture.control.release();const cancelled=await api("/api/v2/test-runs/"+pendingRunId);expect(cancelled.outcomeUnknown).toBe(true);expect(["CANCELLED","FAILED","OUTCOME_UNKNOWN"]).toContain(cancelled.status);
    expect(fixture.calls.length).toBe(baseline+2);
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();
    await panel.getByLabel("验证级别",{exact:true}).selectOption("mock");expect(requests).toBe(3);
  }finally{phases.push({phase:"start_fixture_close",elapsedMs:Date.now()-started});await fixture.close();phases.push({phase:"fixture_closed",elapsedMs:Date.now()-started});console.info(JSON.stringify({scopedUiPhases:phases}));}
});

test("testing UI uses configured synthetic Provider for asynchronous AI suite generation and cancel",async({page})=>{
  test.setTimeout(90000);const api=await authenticate(page),workflowId=await createBlank(api,"异步用例生成");let modelCalls=0,delay=false,releaseModel=()=>{};
  const generatedCase={id:"ai-normal",name:"AI合成场景",inputs:{},mockResults:[],agentSubmissions:[],assertions:[{kind:"terminal_state",expected:"SUCCEEDED"}],expectedValidationErrors:[]};
  const model=createServer(async(req,res)=>{let body="";for await(const chunk of req)body+=chunk;const input=JSON.parse(body);modelCalls++;
    expect(input.tools?.some((tool:any)=>tool.function?.name==="submit_test_cases")).toBeTruthy();
    if(delay)await new Promise<void>(resolve=>{releaseModel=resolve;});if(res.destroyed)return;
    res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({choices:[{message:{role:"assistant",content:"",tool_calls:[{id:"ui-cases-"+modelCalls,type:"function",function:{name:"submit_test_cases",arguments:JSON.stringify({cases:[generatedCase]})}}]},finish_reason:"tool_calls"}],usage:{input_tokens:20,output_tokens:20}}));
  });await new Promise<void>(resolve=>model.listen(0,"127.0.0.1",resolve));
  try{
    const profile=await api("/api/v2/model-profiles","POST",{name:"UI用例生成模型",providerKind:"openai_compatible_chat",baseUrl:"http://127.0.0.1:"+(model.address()as any).port+"/v1",model:"synthetic-ui-generator",apiKey:"SYNTHETIC-UI-GENERATOR-KEY",stream:false});
    await page.goto("/workflows/"+workflowId+"/editor");const panel=page.getByRole("region",{name:"工作流自测",exact:true});await expect(panel.getByLabel("用例生成方式",{exact:true})).toHaveValue("deterministic");
    await panel.getByLabel("用例生成方式",{exact:true}).selectOption("ai_assisted");await expect(panel.getByRole("button",{name:"生成用例",exact:true})).toBeDisabled();expect(modelCalls).toBe(0);
    await panel.getByLabel("生成使用模型",{exact:true}).selectOption(profile.id);await panel.getByLabel("生成场景提示（每行一项）",{exact:true}).fill("正常合成输入");
    const accepted=page.waitForResponse(response=>response.url().endsWith("/api/v2/workflows/"+workflowId+"/test-suites")&&response.request().method()==="POST");await panel.getByRole("button",{name:"生成用例",exact:true}).click();const generated=await accepted;expect(generated.ok(),await generated.text()).toBeTruthy();expect(generated.request().postDataJSON()).toMatchObject({strategy:"ai_assisted",modelProfileId:profile.id,expectedModelRevision:profile.revision});
    await expect(panel.getByText("用例生成任务：SUCCEEDED",{exact:true})).toBeVisible();await expect(panel.getByText("AI合成场景 · 1 项独立断言",{exact:true})).toBeVisible();await expect(panel.getByText(/^实际自测状态：/)).toHaveCount(0);expect(modelCalls).toBe(1);
    await panel.getByRole("button",{name:"运行 Mock",exact:true}).click();await expect(panel.getByText("实际自测状态：SUCCEEDED",{exact:true})).toBeVisible();
    let generationPosts=0;page.on("request",request=>{if(request.url().endsWith("/api/v2/workflows/"+workflowId+"/test-suites")&&request.method()==="POST")generationPosts++;});
    delay=true;await panel.getByRole("button",{name:"生成用例",exact:true}).click();await expect.poll(()=>modelCalls).toBe(2);
    await page.reload();await expect(panel.getByText("用例生成任务：RUNNING",{exact:true})).toBeVisible();expect(generationPosts).toBe(1);expect(modelCalls).toBe(2);
    await panel.getByRole("button",{name:"取消用例生成",exact:true}).click();await expect(panel.getByText("用例生成任务：CANCELLED",{exact:true})).toBeVisible();releaseModel();
    await expect(panel.getByText("AI合成场景 · 1 项独立断言",{exact:true})).toBeVisible();expect(JSON.stringify(await page.evaluate(()=>localStorage))).not.toContain("SYNTHETIC-UI-GENERATOR-KEY");
  }finally{releaseModel();model.closeAllConnections();await new Promise<void>((resolve,reject)=>model.close(error=>error?reject(error):resolve()));}
});

test("lost AI acceptance retries its original command after viewing another validation level without another model call",async({page})=>{
  test.setTimeout(90000);const api=await authenticate(page),workflowId=await createBlank(api,"生成回执丢失恢复");let modelCalls=0;
  const c={id:"once",name:"仅生成一次",inputs:{},mockResults:[],agentSubmissions:[],assertions:[{kind:"terminal_state",expected:"SUCCEEDED"}],expectedValidationErrors:[]};
  const model=createServer(async(req,res)=>{for await(const _ of req){}modelCalls++;await new Promise(resolve=>setTimeout(resolve,200));if(res.destroyed)return;res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({choices:[{message:{role:"assistant",content:"",tool_calls:[{id:"once",type:"function",function:{name:"submit_test_cases",arguments:JSON.stringify({cases:[c]})}}]},finish_reason:"tool_calls"}]}));});
  await new Promise<void>(resolve=>model.listen(0,"127.0.0.1",resolve));
  try{
    const profile=await api("/api/v2/model-profiles","POST",{name:"UI回执恢复模型",providerKind:"openai_compatible_chat",baseUrl:"http://127.0.0.1:"+(model.address()as any).port+"/v1",model:"synthetic-receipt-generator",apiKey:"SYNTHETIC-RECEIPT-ONLY-KEY",stream:false});
    await page.goto("/workflows/"+workflowId+"/editor");const panel=page.getByRole("region",{name:"工作流自测",exact:true});await panel.getByLabel("用例生成方式",{exact:true}).selectOption("ai_assisted");await panel.getByLabel("生成使用模型",{exact:true}).selectOption(profile.id);
    const commands:any[]=[];
    await page.route("**/api/v2/workflows/"+workflowId+"/test-suites",async route=>{
      if(route.request().method()!=="POST"){await route.continue();return;}
      commands.push(route.request().postDataJSON());const response=await route.fetch();expect(response.ok()).toBeTruthy();
      if(commands.length===1)await route.abort("failed");else await route.fulfill({response});
    });
    await panel.getByRole("button",{name:"生成用例",exact:true}).click();await expect(panel.getByRole("alert")).toBeVisible();
    await panel.getByLabel("验证级别",{exact:true}).selectOption("contract");await panel.getByLabel("验证级别",{exact:true}).selectOption("mock");
    await panel.getByRole("button",{name:"生成用例",exact:true}).click();await expect(panel.getByText("用例生成任务：SUCCEEDED",{exact:true})).toBeVisible();await expect(panel.getByText("仅生成一次 · 1 项独立断言",{exact:true})).toBeVisible();
    expect(commands).toHaveLength(2);expect(commands[1]).toEqual(commands[0]);expect(modelCalls).toBe(1);expect(await api("/api/v2/workflows/"+workflowId+"/test-suites")).toHaveLength(1);
  }finally{await new Promise<void>((resolve,reject)=>model.close(error=>error?reject(error):resolve()));}
});
