import { test,expect } from "@playwright/test";
import { readFile,mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
const password="Synthetic-browser-password-041";
test("real UI model settings, assistant create/patch, canvas persistence, undo, dirty conflict and Mock selftest",async({page})=>{
  test.setTimeout(60000);const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  const initialized=(await(await page.request.get("/api/v1/auth/state")).json()).data.initialized;
  const auth=await page.request.post("/api/v1/auth/"+(initialized?"session":"bootstrap"),{data:initialized?{password}:{password,setupToken:await readFile(process.env.FLOWHUB_UI_DATA_DIR+"/admin-setup-token","utf8")}});expect(auth.ok()).toBeTruthy();const csrf=(await auth.json()).data.csrf;
  const api=async(path:string,method="GET",data?:any,revision?:number)=>{
    const response=await page.request.fetch(path,{method,headers:{"X-CSRF-Token":csrf,...(revision?{"If-Match":String(revision)}:{})},...(data===undefined?{}:{data})});expect(response.ok(),await response.text()).toBeTruthy();return(await response.json()).data;
  };
  const workflowId="ui-v2-"+randomUUID().slice(0,8);
  let action={name:"workflow_draft_create",args:{workflowId,name:"浏览器 AI 创建",environment:"test",mode:"auto",template:"blank",idempotencyKey:randomUUID()}};
  const model=createServer(async(req,res)=>{let body="";for await(const p of req)body+=p;const input=JSON.parse(body);
    res.writeHead(200,{"Content-Type":"text/event-stream"});const completed=input.messages.some((m:any)=>m.role==="tool");
    const event=completed?{choices:[{delta:{content:"已根据真实工具回执保存草稿。"},finish_reason:"stop"}]}:{choices:[{delta:{tool_calls:[{index:0,id:"ui-call-"+randomUUID(),type:"function",function:{name:action.name,arguments:JSON.stringify(action.args)}}]},finish_reason:"tool_calls"}]};
    res.end("data: "+JSON.stringify(event)+"\n\ndata: [DONE]\n\n");
  });await new Promise<void>(resolve=>model.listen(0,"127.0.0.1",resolve));
  try {
    await page.goto("/models");await page.getByLabel("模型配置名称").fill("隔离合成模型");await page.getByLabel("API 协议").selectOption("openai_compatible_chat");await page.getByLabel("Base URL").fill("http://127.0.0.1:"+(model.address()as any).port+"/v1");await page.getByLabel("Model",{exact:true}).fill("synthetic-browser");await page.getByLabel("API Key",{exact:true}).fill("synthetic-browser-key-only");await page.getByRole("button",{name:"保存模型",exact:true}).click();
    await expect(page.getByText("Key 已配置",{exact:false})).toBeVisible();expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain("synthetic-browser-key-only");
    await page.goto("/assistant");await page.getByLabel("助手模式").selectOption("compose");await page.getByLabel("发送给助手").fill("创建合成流程并保存草稿，不执行");await page.getByRole("button",{name:"发送",exact:true}).click();
    await expect(page.getByText("任务：COMPLETED",{exact:true})).toBeVisible();await expect.poll(async()=>(await api("/api/v2/workflows/"+workflowId+"/draft")).revision).toBe(1);
    await page.getByRole("button",{name:"打开工作流",exact:true}).click();await expect(page.locator(".react-flow__node")).toHaveCount(2);
    const current=await api("/api/v2/workflows/"+workflowId+"/draft");
    action={name:"workflow_draft_patch",args:{workflowId,expectedRevision:current.revision,idempotencyKey:randomUUID(),operations:[{op:"add_node",nodeId:"branch",nodeType:"condition",title:"AI 条件节点",config:{expression:{op:"eq",left:{value:1},right:{value:1}}}},{op:"disconnect",source:"input",target:"end",port:"next"},{op:"connect",source:"input",target:"branch",port:"next"},{op:"connect",source:"branch",target:"end",port:"true"},{op:"connect",source:"branch",target:"end",port:"false"}]} as any};
    await page.locator(".editor-toolbar").getByRole("button",{name:"AI 助手",exact:true}).click();await page.getByLabel("助手模式").selectOption("compose");await page.getByLabel("发送给助手").fill("为当前流程增加条件分支并保存，不执行");await page.getByRole("button",{name:"发送",exact:true}).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);await expect(page.getByText("任务：COMPLETED",{exact:true})).toBeVisible();
    await mkdir("docs/evidence/v2",{recursive:true});await page.evaluate(()=>{document.querySelectorAll<HTMLElement>("*").forEach(e=>{if(e.scrollTop)e.scrollTop=0;});});await page.screenshot({path:"docs/evidence/v2/S5-ui-assistant-canvas.png",fullPage:false});
    await page.reload();await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await page.locator(".editor-toolbar").getByRole("button",{name:"AI 助手",exact:true}).click();await page.getByRole("button",{name:"撤销此改图",exact:true}).click();await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await page.getByRole("button",{name:"重做此改图",exact:true}).click();await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await page.locator(".inspector").getByRole("button",{name:"属性",exact:true}).click();await page.locator(".react-flow__node").filter({hasText:"AI 条件节点"}).click();await page.getByLabel("节点名称",{exact:true}).fill("用户未保存输入");
    const before=await api("/api/v2/workflows/"+workflowId+"/draft");await api("/api/v2/workflows/"+workflowId+"/operations","POST",{expectedRevision:before.revision,idempotencyKey:randomUUID(),operations:[{op:"set_metadata",changes:{name:"其他会话真实保存"}}]},before.revision);
    await expect(page.getByRole("region",{name:"草稿冲突处理"})).toBeVisible();await expect(page.getByLabel("节点名称",{exact:true})).toHaveValue("用户未保存输入");
    await page.getByRole("button",{name:"丢弃本地修改并重新加载",exact:true}).click();await expect(page.getByRole("region",{name:"草稿冲突处理"})).toHaveCount(0);
    await page.getByRole("button",{name:"生成用例",exact:true}).click();await page.getByRole("button",{name:"运行 Mock",exact:true}).click();await expect(page.getByText("实际自测状态：SUCCEEDED",{exact:true})).toBeVisible();
    await mkdir("docs/evidence/v2",{recursive:true});await page.screenshot({path:"docs/evidence/v2/S5-ui-1440.png",fullPage:false});
    for(const width of [1366,390]){await page.setViewportSize({width,height:900});await page.goto("/assistant");await expect(page.getByRole("heading",{name:"AI 工作台",exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();await page.screenshot({path:"docs/evidence/v2/S5-ui-"+width+".png",fullPage:false});}
    expect(errors).toEqual([]);
  }finally{await new Promise<void>((resolve,reject)=>model.close(e=>e?reject(e):resolve()));}
});
