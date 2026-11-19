import {test,expect,type Page} from "@playwright/test";
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from "node:fs/promises";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {randomUUID} from "node:crypto";

type Api=(path:string,method?:string,data?:any,revision?:number)=>Promise<any>;
async function authenticate(page:Page):Promise<Api> {
  const password="Synthetic-browser-password-041";
  const initialized=(await(await page.request.get("/api/v1/auth/state")).json()).data.initialized;
  const auth=await page.request.post("/api/v1/auth/"+(initialized?"session":"bootstrap"),{data:initialized?{password}:{password,setupToken:await readFile(join(process.env.FLOWHUB_UI_DATA_DIR!,"admin-setup-token"),"utf8")}});
  expect(auth.ok(),await auth.text()).toBeTruthy();const csrf=(await auth.json()).data.csrf;
  return async(path,method="GET",data?,revision?)=>{
    const response=await page.request.fetch(path,{method,headers:{"X-CSRF-Token":csrf,...(revision===undefined?{}:{"If-Match":String(revision)})},...(data===undefined?{}:{data})});
    expect(response.ok(),await response.text()).toBeTruthy();return(await response.json()).data;
  };
}

// Both executable fixtures and the synthetic Codex home stay beneath the UI
// runner's disposable directory. No user Codex installation/config is read.
async function discoveryFixture(withCapabilities=true) {
  const root=await realpath(await mkdtemp(join(process.env.FLOWHUB_UI_DATA_DIR!,"capability-acceptance-")));
  const home=join(root,"codex-home"),cwd=join(root,"project"),cli=join(root,"synthetic-codex.mjs"),servers=join(home,"servers.json"),delay=join(root,"delay-ms"),calls=join(root,"cli-calls.jsonl"),mcpStarted=join(root,"mcp-started"),skillExecuted=join(root,"skill-executed");
  const skillName="ui-synthetic-report-"+randomUUID().slice(0,8),sourceName="ui-synthetic-mcp-"+randomUUID().slice(0,8),mcp=join(root,"synthetic-mcp.mjs");
  await mkdir(home);await mkdir(cwd);await writeFile(join(home,"config.toml"),"");await writeFile(delay,"700");
  await writeFile(cli,`import fs from 'node:fs';const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args.includes('--version'))console.log('codex-cli synthetic-ui-capability');else if(args.includes('--help'))console.log('--json');else if(args.includes('--json')){await new Promise(r=>setTimeout(r,Number(fs.readFileSync(${JSON.stringify(delay)},'utf8'))));console.log(fs.readFileSync(${JSON.stringify(servers)},'utf8'));}else process.exit(2);`);
  // The wrapper launches the real SDK mock server, not a mocked browser route.
  await writeFile(mcp,`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(mcpStarted)},'started\\n');const {serveStdio}=await import(${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))});const {createMockServer}=await import(${JSON.stringify(pathToFileURL(resolve("dist/packages/mock-mcps/src/index.js")).href)});serveStdio(createMockServer,{legacy:'serve'});`);
  await writeFile(servers,JSON.stringify(withCapabilities?[{name:sourceName,enabled:true,transport:{type:"stdio",command:process.execPath,args:[mcp]}}]:[]));
  if(withCapabilities) {
    const skill=join(home,"skills",skillName);await mkdir(skill,{recursive:true});
    await writeFile(join(skill,"script.mjs"),`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(skillExecuted)},'must not execute during discovery or insertion');`);
    await writeFile(join(skill,"SKILL.md"),`---\nname: ${skillName}\ndescription: Synthetic browser acceptance report Skill requiring Codex host execution.\n---\nThis indexed fixture is not evidence of actual Codex host execution. script.mjs must never run while discovering or inserting this capability.\n`);
  }
  return {root,home,cwd,cli,servers,delay,calls,mcpStarted,skillExecuted,skillName,sourceName};
}
async function openDiscovery(page:Page,api:Api,fixture:Awaited<ReturnType<typeof discoveryFixture>>) {
  const context=await api("/api/v2/host-contexts","POST",{codexHome:fixture.home,cwd:fixture.cwd,codexPath:fixture.cli,discoveryMode:"auto"});
  await page.addInitScript(contextId=>localStorage.setItem("flowhub.discovery.context",contextId),context.id);
  await page.goto("/discovery");return context;
}
async function createBlank(api:Api,name:string) {
  const workflowId="ui-cap-"+randomUUID().slice(0,8);
  await api("/api/v2/workflows","POST",{workflowId,name,environment:"test",mode:"guided",template:"blank",idempotencyKey:randomUUID()});return workflowId;
}

test("UI-02: real discovery and CapabilityPicker persist hub_direct bindings and indexed codex_host Skill references",async({page})=>{
  test.setTimeout(90000);const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  const api=await authenticate(page),fixture=await discoveryFixture();
  try {
    if ((await api("/api/v1/auth/state")).vaultLocked)
      await api("/api/v1/vault/unlock", "POST", { password: "Synthetic-browser-password-041" });
    const context=await openDiscovery(page,api,fixture),status=page.locator(".v2-discovery [role=status]");
    await expect(status).toContainText("正在扫描");await expect(status).toContainText("扫描完成");
    await page.getByRole("tab",{name:/Skills 技能/}).click(); await expect(page.locator(".d-cap-row").filter({hasText:fixture.skillName})).toContainText("仅 Codex 调用"); await page.getByRole("tab",{name:/MCP 服务/}).click();
    await page.getByRole("button",{name:"同步工具目录",exact:true}).click();await expect(status).toContainText("正在扫描");await expect(status).toContainText("扫描完成");
    const catalog=await api("/api/v2/capabilities?contextId="+context.id),direct=catalog.items.find((cap:any)=>cap.name==="synthetic_order_lookup"),skill=catalog.items.find((cap:any)=>cap.name===fixture.skillName);
    expect(direct).toMatchObject({executor:"hub_direct",availability:"ready",kind:"mcp_tool"});expect(skill).toMatchObject({executor:"codex_host",availability:"host_only",kind:"skill"});
    await page.locator(".d-cap-row").filter({hasText:fixture.sourceName}).getByRole("button").click();
    const drawer=page.getByRole("dialog");await drawer.locator(".d-tool-card").filter({hasText:"synthetic_order_lookup"}).getByRole("button",{name:"参数与结果",exact:true}).click();
    await expect(drawer.getByRole("heading",{name:"synthetic_order_lookup",exact:true})).toBeVisible();
    await drawer.getByText("原始说明与技术信息",{exact:true}).click();
    await expect(drawer.locator("pre")).toContainText('"orderNo"');
    await expect(drawer.locator("pre")).toContainText(direct.sourceRefs[0].sourceId);
    await page.keyboard.press("Escape");
    expect(await readFile(fixture.mcpStarted,"utf8")).toContain("started");
    const invocations=(await readFile(fixture.calls,"utf8")).trim().split("\n").map(line=>JSON.parse(line));expect(invocations).toContainEqual(["mcp","list","--json"]);

    const workflowId=await createBlank(api,"真实能力插入与持久化");await page.goto("/workflows/"+workflowId+"/editor");await expect(page.locator(".react-flow__node")).toHaveCount(2);
    const picker=page.locator(".v2-capability-picker");
    await picker.getByLabel("能力来源").selectOption(direct.sourceRefs[0].sourceId);await picker.getByLabel("查找工具",{exact:true}).fill(direct.name);await picker.getByRole("button",{name:"搜索能力",exact:true}).click();
    await expect(picker.getByRole("button",{name:/^synthetic_order_lookup/})).toContainText("FlowHub 直连");
    const imported=page.waitForResponse(response=>response.url().endsWith("/api/v2/capabilities/"+direct.id+"/import")&&response.request().method()==="POST");
    const patched=page.waitForResponse(response=>response.url().endsWith("/api/v2/workflows/"+workflowId+"/operations")&&response.request().method()==="POST");
    await picker.getByRole("button",{name:/^synthetic_order_lookup/}).click();
    const importResponse=await imported;expect(importResponse.ok(),await importResponse.text()).toBeTruthy();const importedBinding=(await importResponse.json()).data;
    const patchResponse=await patched;expect(patchResponse.ok(),await patchResponse.text()).toBeTruthy();await expect(page.locator(".react-flow__node")).toHaveCount(3);
    let persisted=await api("/api/v2/workflows/"+workflowId+"/draft");const tool=persisted.draft.nodes.find((node:any)=>node.type==="mcp_tool");
    expect(tool.config.capabilityRef).toEqual({capabilityId:direct.id,revision:direct.revision});expect(tool.config.toolName).toBe(direct.name);expect(tool.config.toolSchemaHash).toMatch(/^sha256:/);
    expect(persisted.draft.bindings[tool.config.bindingKey]).toBe(importedBinding.bindingId);
    const bindings=await api("/api/v1/bindings"),binding=bindings.find((item:any)=>item.id===importedBinding.bindingId);
    expect(binding).toMatchObject({environment:"test",sourceCapabilityId:direct.id,sourceCapabilityRevision:direct.revision,validationStatus:"UNVERIFIED"});
    const connections=await api("/api/v1/connections"),connection=connections.find((item:any)=>item.id===importedBinding.connectionId);
    expect(connection.transport).toBe("stdio");expect(connection.tools.find((item:any)=>item.name===direct.name).schemaHash).toBe(tool.config.toolSchemaHash);
    await page.reload();await expect(page.locator(".react-flow__node")).toHaveCount(3);await expect(page.locator(".react-flow__node").filter({hasText:direct.name})).toHaveCount(1);

    await picker.getByLabel("能力来源").selectOption(skill.sourceRefs[0].sourceId);await picker.getByLabel("查找工具",{exact:true}).fill(skill.name);await picker.getByRole("button",{name:"搜索能力",exact:true}).click();
    const hostImported=page.waitForResponse(response=>response.url().endsWith("/api/v2/capabilities/"+skill.id+"/import")&&response.request().method()==="POST");
    const hostPatched=page.waitForResponse(response=>response.url().endsWith("/api/v2/workflows/"+workflowId+"/operations")&&response.request().method()==="POST");
    await picker.getByRole("button",{name:new RegExp("^"+skill.name)}).click();
    const hostResponse=await hostImported;expect(hostResponse.ok(),await hostResponse.text()).toBeTruthy();expect((await hostResponse.json()).data).toMatchObject({status:"host_reference",hostReference:{capabilityId:skill.id,revision:skill.revision,executor:"codex_host"}});
    const hostPatchResponse=await hostPatched;expect(hostPatchResponse.ok(),await hostPatchResponse.text()).toBeTruthy();await expect(page.locator(".react-flow__node")).toHaveCount(4);
    persisted=await api("/api/v2/workflows/"+workflowId+"/draft");const hostNode=persisted.draft.nodes.find((node:any)=>node.config.kind==="host_skill");
    expect(hostNode.config).toMatchObject({skillRef:skill.name,executorRef:"codex_host",reportContractRef:"incident-report/v1",capabilityRef:{capabilityId:skill.id,revision:skill.revision},outputSchema:{required:["reportMarkdown","evidenceRefs"]}});
    expect(persisted.draft.executionRequirements.requiresCodex).toBe(true);expect(persisted.capabilityRefs).toEqual(expect.arrayContaining([{capabilityId:direct.id,revision:direct.revision},{capabilityId:skill.id,revision:skill.revision}]));
    expect((await api("/api/v1/bindings")).length).toBe(bindings.length);expect((await api("/api/v1/connections")).length).toBe(connections.length);
    expect(persisted.issues.some((issue:any)=>["SCHEMA_INVALID","TEMPLATE_INVALID"].includes(issue.code))).toBe(false);
    await page.reload();await expect(page.locator(".react-flow__node")).toHaveCount(4);await expect(page.locator(".react-flow__node").filter({hasText:skill.name})).toHaveCount(1);await expect(picker.getByRole("alert")).toHaveCount(0);
    await expect(readFile(fixture.skillExecuted,"utf8")).rejects.toMatchObject({code:"ENOENT"});expect(errors).toEqual([]);
  } finally {await rm(fixture.root,{recursive:true,force:true});}
});

test("UI-07: successful real Mock evidence becomes stale after a browser draft edit",async({page})=>{
  const api=await authenticate(page),workflowId=await createBlank(api,"浏览器自测基线过期");
  await page.goto("/workflows/"+workflowId+"/editor");const panel=page.getByRole("region",{name:"工作流自测",exact:true});
  await panel.getByRole("button",{name:"生成用例",exact:true}).click();await expect(panel.getByText("正常数据流 · 1 项独立断言",{exact:true})).toBeVisible();
  const accepted=page.waitForResponse(response=>/\/api\/v2\/test-suites\/[^/]+\/runs$/.test(new URL(response.url()).pathname)&&response.request().method()==="POST");
  await panel.getByRole("button",{name:"运行 Mock",exact:true}).click();const runResponse=await accepted;expect(runResponse.ok(),await runResponse.text()).toBeTruthy();const testRunId=(await runResponse.json()).data.testRunId;
  await expect(panel.getByText("实际自测状态：SUCCEEDED",{exact:true})).toBeVisible();expect(await api("/api/v2/test-runs/"+testRunId)).toMatchObject({status:"SUCCEEDED",stale:false});
  const before=await api("/api/v2/workflows/"+workflowId+"/draft");
  await page.locator(".react-flow__node[data-id=input]").click();await page.getByLabel("节点名称",{exact:true}).fill("浏览器修改后的输入");await page.getByRole("button",{name:"保存草稿",exact:true}).click();
  await expect.poll(async()=>(await api("/api/v2/workflows/"+workflowId+"/draft")).revision).toBe(before.revision+1);
  await expect(panel.getByText("测试基线已过期：请重新生成用例。",{exact:true})).toBeVisible();await expect(panel.getByRole("button",{name:"运行 Mock",exact:true})).toBeDisabled();
  expect(await api("/api/v2/test-runs/"+testRunId)).toMatchObject({status:"SUCCEEDED",stale:true});
  await expect(panel.getByText("实际自测状态：SUCCEEDED · 基线已过期",{exact:true})).toBeVisible();await expect(panel.getByText("实际自测状态：SUCCEEDED",{exact:true})).toHaveCount(0);
  await page.reload();await expect(page.locator(".react-flow__node[data-id=input]")).toContainText("浏览器修改后的输入");await expect(panel.getByText("测试基线已过期：请重新生成用例。",{exact:true})).toBeVisible();await expect(panel.getByRole("button",{name:"运行 Mock",exact:true})).toBeDisabled();
});

test("UI-01: real discovery displays loading, complete empty, partial and registration error states",async({page})=>{
  const api=await authenticate(page),fixture=await discoveryFixture(false);
  try {
    await openDiscovery(page,api,fixture);const status=page.locator(".v2-discovery [role=status]");
    await expect(status).toContainText("正在扫描");await expect(status).toContainText("扫描完成");await expect(status).toContainText("来源覆盖：完整");
    await expect(page.getByText("已扫描范围内没有MCP 服务。",{exact:true})).toBeVisible();
    await expect(page.locator(".d-cap-row")).toHaveCount(0); await expect(page.locator(".d-stat").first()).toContainText("0");
    await writeFile(join(fixture.home,"config.toml"),"[malformed TOML");await page.getByRole("button",{name:"重新扫描",exact:true}).click();await expect(status).toContainText("正在扫描");await expect(status).toContainText("部分完成");await expect(status).toContainText("来源覆盖：部分");
    await page.getByRole("tab",{name:/需处理/}).click();await expect(page.getByRole("heading",{name:"配置格式无法解析",exact:true})).toBeVisible(); await expect(page.locator(".d-stat").first()).toContainText("未知");await expect(page.getByText(/0\s*项已安装/)).toHaveCount(0);
    await page.getByText("登记本机 Codex 上下文",{exact:true}).click();await page.getByLabel("Codex Home（留空使用默认）",{exact:true}).fill(join(fixture.root,"missing-home"));await page.getByRole("button",{name:"登记上下文",exact:true}).click();
    await expect(page.locator(".v2-discovery [role=alert]")).toBeVisible();await expect(page.locator(".v2-discovery [role=alert]")).not.toBeEmpty();await expect(status).toContainText("部分完成");
  } finally {await rm(fixture.root,{recursive:true,force:true});}
});
