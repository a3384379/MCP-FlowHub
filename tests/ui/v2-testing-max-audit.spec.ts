import {test,expect,type Page} from "@playwright/test";
import {readFile,mkdtemp,mkdir,writeFile,rm,realpath} from "node:fs/promises";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {McpServer,fromJsonSchema} from "@modelcontextprotocol/server";
import {randomUUID} from "node:crypto";
import {createServer} from "node:http";

// The daemon outlives each isolated browser context. Close only this test's
// authenticated session so the full suite retains the real 64-session cap.
test.afterEach(async({page})=>{
  await page.unrouteAll({behavior:"wait"});
  const session=await page.request.get("/api/v1/auth/session");
  if(!session.ok())return;
  const {csrf}=(await session.json()).data;
  const closed=await page.request.delete("/api/v1/auth/session",{headers:{"X-CSRF-Token":csrf}});
  expect(closed.ok(),await closed.text()).toBeTruthy();
});

type Api=(path:string,method?:string,body?:any,revision?:number)=>Promise<any>;
async function authenticate(page:Page):Promise<Api>{
  const password="Synthetic-browser-password-041",state=(await(await page.request.get("/api/v1/auth/state")).json()).data;
  const response=await page.request.post("/api/v1/auth/"+(state.initialized?"session":"bootstrap"),{data:state.initialized?{password}:{password,setupToken:await readFile(join(process.env.FLOWHUB_UI_DATA_DIR!,"admin-setup-token"),"utf8")}});
  expect(response.ok(),await response.text()).toBeTruthy();const csrf=(await response.json()).data.csrf;
  const api:Api=async(path,method="GET",body?,revision?)=>{const r=await page.request.fetch(path,{method,headers:{"X-CSRF-Token":csrf,...(revision===undefined?{}:{"If-Match":String(revision)})},...(body===undefined?{}:{data:body})});expect(r.ok(),await r.text()).toBeTruthy();return(await r.json()).data;};
  if((await api("/api/v1/auth/state")).vaultLocked)await api("/api/v1/vault/unlock","POST",{password});return api;
}
const normal=(name="旧套件的用例")=>({id:"normal",name,inputs:{},mockResults:[],agentSubmissions:[],assertions:[{kind:"terminal_state",expected:"SUCCEEDED"}],expectedValidationErrors:[]});
async function blank(api:Api,mode="auto"){const id="ui-max-"+randomUUID().slice(0,8);await api("/api/v2/workflows","POST",{workflowId:id,name:"隔离自测审计回归",environment:"test",mode,template:"blank",idempotencyKey:randomUUID()});return id;}
async function suite(api:Api,id:string,cases=[normal()],revision=1){const accepted=await api("/api/v2/workflows/"+id+"/test-suites","POST",{expectedRevision:revision,strategy:"agent_proposed",proposedCases:cases,idempotencyKey:randomUUID()});return api("/api/v2/test-suites/"+accepted.suiteId);}
const panel=(page:Page)=>page.getByRole("region",{name:"工作流自测",exact:true});
async function open(page:Page,id:string){await page.goto("/workflows/"+id+"/editor");await expect(panel(page).getByRole("button",{name:"运行 Mock",exact:true})).toBeEnabled();}
async function run(page:Page){const response=page.waitForResponse(r=>/\/test-suites\/[^/]+\/runs$/.test(new URL(r.url()).pathname)&&r.request().method()==="POST");await panel(page).getByRole("button",{name:"运行 Mock",exact:true}).click();const accepted=await response;expect(accepted.ok(),await accepted.text()).toBeTruthy();const id=(await accepted.json()).data.testRunId;await expect(panel(page).getByText("实际自测状态：SUCCEEDED",{exact:true})).toBeVisible();await expect(panel(page).getByText(/实际验证级别：Mock.*模拟工具调用：/)).toBeVisible();await expect(panel(page).getByText(/实际验证级别：Mock.*真实工具调用：/)).toHaveCount(0);return id;}
async function syntheticModel(api:Api){
  let calls=0;const generated=normal("新生成的合成套件");
  const model=createServer(async(req,res)=>{for await(const _ of req){}calls++;res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({choices:[{message:{role:"assistant",content:"",tool_calls:[{id:"synthetic-"+calls,type:"function",function:{name:"submit_test_cases",arguments:JSON.stringify({cases:[generated]})}}]},finish_reason:"tool_calls"}]}));});
  await new Promise<void>(resolve=>model.listen(0,"127.0.0.1",resolve));
  const profile=await api("/api/v2/model-profiles","POST",{name:"本地合成生成器",providerKind:"openai_compatible_chat",baseUrl:"http://127.0.0.1:"+(model.address()as any).port+"/v1",model:"synthetic-max-regression",apiKey:"SYNTHETIC-LOCAL-TEST-ONLY",stream:false});
  return {profile,generated,calls:()=>calls,close:async()=>{model.closeAllConnections();await new Promise<void>((resolve,reject)=>model.close(e=>e?reject(e):resolve()));}};
}

test("UI-01: exact lost run retries keep their key; an equal body targeting another suite gets a distinct key",async({page})=>{
  const api=await authenticate(page),id=await blank(api),first=await suite(api,id);await open(page,id);const commands:any[]=[];
  await page.route("**/api/v2/test-suites/*/runs",async route=>{
    if(route.request().method()!=="POST"){await route.continue();return;}
    const response=await route.fetch();commands.push({url:route.request().url(),body:route.request().postDataJSON(),status:response.status(),result:(await response.json()).data});
    if(commands.length<=2)await route.abort("failed");else await route.fulfill({response});
  });
  await panel(page).getByRole("button",{name:"运行 Mock",exact:true}).click();await expect(panel(page).getByRole("alert")).toBeVisible();
  await panel(page).getByRole("button",{name:"运行 Mock",exact:true}).click();await expect.poll(()=>commands.length).toBe(2);await expect(panel(page).getByRole("button",{name:"生成用例",exact:true})).toBeEnabled();
  expect(commands[1]).toEqual(commands[0]);expect((await api("/api/v2/workflows/"+id+"/test-runs")).filter((r:any)=>r.kind!=="generation")).toHaveLength(1);
  await panel(page).getByRole("button",{name:"生成用例",exact:true}).click();await expect(panel(page).getByText("正常数据流 · 1 项独立断言",{exact:true})).toBeVisible();
  await run(page);expect(commands).toHaveLength(3);expect(commands[2].status).toBe(200);expect(commands[2].url).not.toBe(commands[0].url);expect(commands[2].body.idempotencyKey).not.toBe(commands[0].body.idempotencyKey);
  const {idempotencyKey:_,...body}=commands[0].body,{idempotencyKey:__,...other}=commands[2].body;expect(body).toEqual(other);expect(commands[0].url).toContain(first.id);
  expect((await api("/api/v2/workflows/"+id+"/test-runs")).filter((r:any)=>r.kind!=="generation")).toHaveLength(2);
});

test("UI-01: identical PUT content for distinct suites cannot inherit a lost receipt key",async({page})=>{
  const api=await authenticate(page),id=await blank(api);await suite(api,id);await open(page,id);const commands:any[]=[],pendingJson=JSON.stringify([normal("相同编辑内容")],null,2);
  await page.route("**/api/v2/test-suites/*",async route=>{
    if(route.request().method()!=="PUT"){await route.continue();return;}
    const response=await route.fetch();commands.push({url:route.request().url(),body:route.request().postDataJSON(),status:response.status()});
    if(commands.length===1)await route.abort("failed");else await route.fulfill({response});
  });
  await panel(page).getByRole("button",{name:"编辑夹具与断言",exact:true}).click();await panel(page).getByLabel("合成用例 JSON",{exact:true}).fill(pendingJson);
  await panel(page).getByRole("button",{name:"保存夹具",exact:true}).click();await expect(panel(page).getByRole("alert")).toBeVisible();
  await panel(page).getByRole("button",{name:"生成用例",exact:true}).click();await expect(panel(page).getByRole("button",{name:"查看更新套件（保留夹具草稿）",exact:true})).toBeVisible();
  await panel(page).getByRole("button",{name:"查看更新套件（保留夹具草稿）",exact:true}).click();await expect(panel(page).getByText("正常数据流 · 1 项独立断言",{exact:true})).toBeVisible();
  await panel(page).getByRole("button",{name:"编辑夹具与断言",exact:true}).click();await panel(page).getByLabel("合成用例 JSON",{exact:true}).fill(pendingJson);await panel(page).getByRole("button",{name:"保存夹具",exact:true}).click();
  await expect(panel(page).getByLabel("合成用例 JSON",{exact:true})).toHaveCount(0);expect(commands).toHaveLength(2);expect(commands.map(c=>c.status)).toEqual([200,200]);
  const {idempotencyKey:a,...first}=commands[0].body,{idempotencyKey:b,...second}=commands[1].body;expect(first).toEqual(second);expect(a).not.toBe(b);expect(commands[0].url).not.toBe(commands[1].url);
});

test("UI-02: late AI suite receipts lock loading and preserve, switch and restore an existing dirty fixture draft",async({page})=>{
  const api=await authenticate(page),id=await blank(api),original=await suite(api,id),model=await syntheticModel(api);let held=false,release=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  try{
    await open(page,id);await panel(page).getByLabel("用例生成方式",{exact:true}).selectOption("ai_assisted");await panel(page).getByLabel("生成使用模型",{exact:true}).selectOption(model.profile.id);
    await panel(page).getByRole("button",{name:"编辑夹具与断言",exact:true}).click();
    const pendingJson=JSON.stringify([{...original.cases[0],name:"未保存 token/password 文本 user@example.test",inputs:{}}],null,2);
    await panel(page).getByLabel("合成用例 JSON",{exact:true}).fill(pendingJson);
    await page.route("**/api/v2/test-suites/*",async route=>{if(route.request().method()!=="GET"||route.request().url().endsWith("/"+original.id)){await route.continue();return;}const response=await route.fetch();held=true;await gate;await route.fulfill({response});});
    await panel(page).getByRole("button",{name:"生成用例",exact:true}).click();await expect.poll(()=>held).toBe(true);await expect(panel(page).getByText("用例生成任务：SUCCEEDED",{exact:true})).toBeVisible();
    await expect(panel(page).getByText("正在读取生成套件，夹具编辑暂时锁定。",{exact:true})).toBeVisible();await expect(panel(page).getByLabel("合成用例 JSON",{exact:true})).toBeDisabled();await expect(panel(page).getByLabel("合成用例 JSON",{exact:true})).toHaveValue(pendingJson);
    release();await expect(panel(page).getByRole("button",{name:"查看更新套件（保留夹具草稿）",exact:true})).toBeEnabled();await expect(panel(page).getByLabel("合成用例 JSON",{exact:true})).toHaveValue(pendingJson);expect((await api("/api/v2/test-suites/"+original.id)).cases).toEqual(original.cases);
    await panel(page).getByRole("button",{name:"查看更新套件（保留夹具草稿）",exact:true}).click();await expect(panel(page).getByText(model.generated.name+" · 1 项独立断言",{exact:true})).toBeVisible();
    await panel(page).getByRole("button",{name:"恢复未保存夹具（旧套件的用例）",exact:true}).click();await expect(panel(page).getByLabel("合成用例 JSON",{exact:true})).toHaveValue(pendingJson);expect(model.calls()).toBe(1);
    await panel(page).getByRole("button",{name:"保存夹具",exact:true}).click();await expect(panel(page).getByLabel("合成用例 JSON",{exact:true})).toHaveCount(0);expect((await api("/api/v2/test-suites/"+original.id)).cases).toEqual(JSON.parse(pendingJson));
  }finally{release();await page.unrouteAll({behavior:"wait"});await model.close();}
});

test("UI-02: recovered successful generation keeps editing locked until its real suite receipt arrives",async({page})=>{
  const api=await authenticate(page),id=await blank(api),original=await suite(api,id),model=await syntheticModel(api);let release=()=>{},held=false;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  try{
    const accepted=await api("/api/v2/workflows/"+id+"/test-suites","POST",{expectedRevision:1,strategy:"ai_assisted",modelProfileId:model.profile.id,expectedModelRevision:model.profile.revision,idempotencyKey:randomUUID()});
    await expect.poll(async()=>(await api("/api/v2/test-runs/"+accepted.testRunId)).status).toBe("SUCCEEDED");
    await page.route("**/api/v2/test-suites/*",async route=>{if(route.request().method()!=="GET"||route.request().url().endsWith("/"+original.id)){await route.continue();return;}const response=await route.fetch();held=true;await gate;await route.fulfill({response});});
    let posts=0;page.on("request",r=>{if(r.method()==="POST"&&r.url().endsWith("/test-suites"))posts++;});
    await page.goto("/workflows/"+id+"/editor");await expect.poll(()=>held).toBe(true);await expect(panel(page).getByRole("button",{name:"编辑夹具与断言",exact:true})).toBeDisabled();release();
    await expect(panel(page).getByText(model.generated.name+" · 1 项独立断言",{exact:true})).toBeVisible();await expect(panel(page).getByRole("button",{name:"编辑夹具与断言",exact:true})).toBeEnabled();expect(model.calls()).toBe(1);expect(posts).toBe(0);
  }finally{release();await page.unrouteAll({behavior:"wait"});await model.close();}
});

test("UI-03: external suite updates refresh terminal stale evidence while dirty JSON survives and no run POST repeats",async({page})=>{
  const api=await authenticate(page),id=await blank(api),s=await suite(api,id);await open(page,id);let posts=0;page.on("request",r=>{if(r.method()==="POST"&&/\/test-suites\/[^/]+\/runs$/.test(new URL(r.url()).pathname))posts++;});
  const runId=await run(page);await panel(page).getByRole("button",{name:"编辑夹具与断言",exact:true}).click();const pendingJson=JSON.stringify([normal("尚未保存的本地夹具")],null,2);await panel(page).getByLabel("合成用例 JSON",{exact:true}).fill(pendingJson);
  const cases=[{...normal("外部已修改断言"),assertions:[{kind:"terminal_state",expected:"FAILED"}]}];await api("/api/v2/test-suites/"+s.id,"PUT",{cases,expectedRevision:1,expectedSuiteRevision:1,idempotencyKey:randomUUID()});
  expect((await api("/api/v2/test-runs/"+runId)).stale).toBe(true);
  await expect(panel(page).getByText("实际自测状态：SUCCEEDED · 基线已过期",{exact:true})).toBeVisible({timeout:6000});await expect(panel(page).getByLabel("合成用例 JSON",{exact:true})).toHaveValue(pendingJson);
  await expect(panel(page).getByRole("button",{name:"查看更新套件（保留夹具草稿）",exact:true})).toBeVisible();expect(posts).toBe(1);
  await panel(page).getByRole("button",{name:"查看更新套件（保留夹具草稿）",exact:true}).click();await expect(panel(page).getByText("外部已修改断言 · 1 项独立断言",{exact:true})).toBeVisible();await expect(panel(page).getByText(/草稿 r1 · 套件 r2/)).toBeVisible();expect(posts).toBe(1);
});

test("UI-03: a delayed read of an old suite cannot roll back a newer same-workflow fixture save",async({page})=>{
  const api=await authenticate(page),id=await blank(api),s=await suite(api,id);await open(page,id);let held=false,delivered=false,first=true,release=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/api/v2/test-suites/"+s.id,async route=>{if(route.request().method()!=="GET"||!first){await route.continue();return;}first=false;const response=await route.fetch();held=true;await gate;await route.fulfill({response});delivered=true;});
  try{
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));await expect.poll(()=>held).toBe(true);await panel(page).getByRole("button",{name:"编辑夹具与断言",exact:true}).click();await panel(page).getByLabel("合成用例 JSON",{exact:true}).fill(JSON.stringify([normal("刚保存的新夹具")],null,2));await panel(page).getByRole("button",{name:"保存夹具",exact:true}).click();
    await expect(panel(page).getByText(/草稿 r1 · 套件 r2/)).toBeVisible();release();await expect.poll(()=>delivered).toBe(true);await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await expect(panel(page).getByText(/草稿 r1 · 套件 r2/)).toBeVisible();await expect(panel(page).getByText("刚保存的新夹具 · 1 项独立断言",{exact:true})).toBeVisible();expect((await api("/api/v2/test-suites/"+s.id)).suiteRevision).toBe(2);
  }finally{release();await page.unrouteAll({behavior:"wait"});}
});

test("UI-03: discovered Skill changes stale terminal Mock evidence without changing draft revision or posting another run",async({page})=>{
  test.setTimeout(90000);const api=await authenticate(page),root=await realpath(await mkdtemp(join(process.env.FLOWHUB_UI_DATA_DIR!,"testing-cap-drift-"))),home=join(root,"home"),cwd=join(root,"project"),cli=join(root,"synthetic-codex.mjs"),name="synthetic-stale-"+randomUUID().slice(0,8),skill=join(home,"skills",name,"SKILL.md");
  try{
    await mkdir(cwd);await mkdir(join(home,"skills",name),{recursive:true});await writeFile(join(home,"config.toml"),"");await writeFile(skill,"---\nname: "+name+"\ndescription: Synthetic terminal evidence baseline.\n---\nVersion one synthetic instructions.\n");
    await writeFile(cli,"const a=process.argv.slice(2);console.log(a.includes('--version')?'codex-cli synthetic-testing':a.includes('--help')?'--json':'[]');");
    const context=await api("/api/v2/host-contexts","POST",{codexHome:home,cwd,codexPath:cli,discoveryMode:"auto"});
    const scan=async()=>{const accepted=await api("/api/v2/host-scans","POST",{contextId:context.id,depth:"metadata",idempotencyKey:randomUUID()});await expect.poll(async()=>(await api("/api/v2/host-scans/"+accepted.scanId)).status).toBe("SUCCEEDED");};
    await scan();const cap=(await api("/api/v2/capabilities?contextId="+context.id)).items.find((c:any)=>c.name===name);expect(cap).toBeTruthy();const id=await blank(api,"guided"),outputSchema={type:"object",properties:{reportMarkdown:{type:"string"},evidenceRefs:{type:"array",items:{type:"string"}}},required:["reportMarkdown","evidenceRefs"],additionalProperties:false};
    await api("/api/v2/workflows/"+id+"/operations","POST",{expectedRevision:1,idempotencyKey:randomUUID(),operations:[{op:"add_node",nodeId:"host",nodeType:"agent_task",title:"合成宿主夹具",capabilityRef:{capabilityId:cap.id,revision:cap.revision},config:{kind:"host_skill",skillRef:cap.name,executorRef:"codex_host",instructions:"Synthetic fixture only",reportContractRef:"incident-report/v1",inputMappings:{},outputSchema}},{op:"disconnect",source:"input",target:"end",port:"next"},{op:"connect",source:"input",target:"host",port:"next"},{op:"connect",source:"host",target:"end",port:"next"}]},1);
    await suite(api,id,[{...normal(),agentSubmissions:[{nodeId:"host",payload:{reportMarkdown:["问题摘要","环境与范围","时间线","日志证据","数据库核对","判断与置信依据","尚未验证的假设","建议下一步","证据索引","运行版本与限制"].map(heading=>"## "+heading+"\n合成夹具，无真实宿主执行证据。").join("\n\n"),evidenceRefs:[]}}]}]as any,2);await open(page,id);let posts=0;page.on("request",r=>{if(r.method()==="POST"&&/\/test-suites\/[^/]+\/runs$/.test(new URL(r.url()).pathname))posts++;});const runId=await run(page);
    await writeFile(skill,"---\nname: "+name+"\ndescription: Synthetic terminal evidence baseline.\n---\nVersion two synthetic instructions.\n");await scan();expect((await api("/api/v2/workflows/"+id+"/draft")).revision).toBe(2);expect((await api("/api/v2/test-runs/"+runId)).stale).toBe(true);
    await expect(panel(page).getByText("实际自测状态：SUCCEEDED · 基线已过期",{exact:true})).toBeVisible({timeout:6000});expect(posts).toBe(1);
  }finally{await rm(root,{recursive:true,force:true});}
});

// A real local SDK service exposes a callable tool, but Mock must never call it.
test("Mock call evidence is labelled simulated even when one fixture tool was traced and the real local service received zero calls",async({page})=>{
  const api=await authenticate(page),id=await blank(api),token="SYNTHETIC-MOCK-COUNT-"+randomUUID();let realCalls=0;
  const inputSchema={type:"object",properties:{environment:{const:"test"}},required:["environment"],additionalProperties:false},outputSchema={type:"object",properties:{value:{type:"string"}},required:["value"],additionalProperties:false};
  const {createLocalHttp}=await import(pathToFileURL(resolve("dist/apps/daemon/src/http.js")).href);
  const server=createLocalHttp(()=>{const mcp=new McpServer({name:"synthetic-mock-counter",version:"1"},{capabilities:{tools:{}}});mcp.registerTool("synthetic_counted_read",{inputSchema:fromJsonSchema(inputSchema),outputSchema:fromJsonSchema(outputSchema)},async()=>{realCalls++;return {content:[],structuredContent:{value:"REAL-SYNTHETIC-ONLY"}};});return mcp;},token);
  await server.listen({host:"127.0.0.1",port:0});
  try{
    const secret=await api("/api/v1/secrets","POST",{label:"Synthetic Mock counter token",purpose:"mcp_auth",value:token,idempotencyKey:randomUUID()}),connection=await api("/api/v1/connections","POST",{name:"Synthetic Mock counter",transport:"streamable_http",protocolEra:"modern",endpoint:"http://127.0.0.1:"+(server.server.address()as any).port+"/mcp",allowedHosts:["127.0.0.1"],secretRef:secret.id});
    await api("/api/v1/connections/"+connection.id+"/sync-tools","POST",{});const tool=(await api("/api/v1/connections")).find((c:any)=>c.id===connection.id).tools[0];
    const binding=await api("/api/v1/bindings","POST",{name:"Synthetic Mock count binding",connectionId:connection.id,environment:"test",allowedTools:[tool.name],lockedArguments:{"/environment":"test"},allowedQueryTemplates:[],maxRows:10,timeoutSeconds:5});
    await api("/api/v2/workflows/"+id+"/operations","POST",{expectedRevision:1,idempotencyKey:randomUUID(),operations:[{op:"set_binding",key:"read",bindingId:binding.id},{op:"add_node",nodeId:"read",nodeType:"mcp_tool",title:"合成调用计数",config:{bindingKey:"read",toolName:tool.name,toolSchemaHash:tool.schemaHash,argumentsMappings:{}}},{op:"disconnect",source:"input",target:"end",port:"next"},{op:"connect",source:"input",target:"read",port:"next"},{op:"connect",source:"read",target:"end",port:"next"}]},1);
    await suite(api,id,[{...normal("一次模拟调用"),mockResults:[{nodeId:"read",capabilityId:tool.name,responseMode:"structured",result:{content:[],structuredContent:{value:"SYNTHETIC-FIXTURE"}}}]}]as any,2);
    expect(realCalls).toBe(0);await open(page,id);const runId=await run(page),result=await api("/api/v2/test-runs/"+runId);
    expect(result).toMatchObject({mode:"mock",toolCalls:1,networkCalls:0});await expect(panel(page).getByText(/实际验证级别：Mock.*模拟工具调用：1/)).toBeVisible();expect(realCalls).toBe(0);
  }finally{server.server.closeAllConnections();await server.close();}
});
