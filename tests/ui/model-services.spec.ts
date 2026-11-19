import {test,expect,type Page} from "@playwright/test";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";

async function admin(page:Page){
  const state=(await(await page.request.get("/api/v1/auth/state")).json()).data,password="Synthetic-browser-password-041";
  const login=await page.request.post("/api/v1/auth/"+(state.initialized?"session":"bootstrap"),{data:state.initialized?{password}:{password,setupToken:await readFile(process.env.FLOWHUB_UI_DATA_DIR+"/admin-setup-token","utf8")}});
  expect(login.ok()).toBeTruthy();return(await login.json()).data.csrf as string;
}

test("model service fills official URL, offers queried models and ignores stale catalog replies after switching service",async({page})=>{
  await page.route("**/api/v2/model-docs?*",route=>route.fulfill({json:{data:{status:"available",contextWindow:123456,maxInputTokens:120000,maxOutputTokens:3456,reasoningEfforts:["none","high"],sourceUrl:"https://developers.openai.com/api/docs/models/official-fixture-model",fetchedAt:"2026-10-31T09:00:00Z"}}}));
  const csrf=await admin(page);let requests=0,release!:()=>void,captured!:()=>void,hold=false;
  const gate=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>captured=r);
  // Official UI fixture; the backend origin pin and real HTTP catalog are tested separately.
  await page.route("**/api/v2/model-catalog",async route=>{
    const body=route.request().postDataJSON();expect(body.serviceId).toBe("openai");expect(body.baseUrl).toBe("https://api.openai.com/v1");expect(route.request().headers()["x-csrf-token"]).toBe(csrf);requests++;
    if(hold){captured();await gate;}
    await route.fulfill({json:{data:{models:[{id:"official-fixture-model",created:1700000000,ownedBy:"openai",shutdownDate:null},{id:"retired-fixture-model",created:1600000000,ownedBy:"openai",shutdownDate:"2020-01-01"}],endpoint:"https://api.openai.com/v1/models",fetchedAt:"2026-10-31T09:00:00Z",docsUrl:"https://developers.openai.com/api/docs/models"}}});
  });
  try{
    await page.goto("/models");await expect(page.getByLabel("模型服务",{exact:true})).toHaveValue("openai");
    await expect(page.getByLabel("Base URL",{exact:true})).toHaveValue("https://api.openai.com/v1");await expect(page.getByLabel("Base URL",{exact:true})).toHaveAttribute("readonly","");
    await expect(page.getByLabel("Model",{exact:true})).toBeDisabled();await expect(page.getByRole("button",{name:"保存模型",exact:true})).toBeDisabled();
    await page.getByLabel("API Key",{exact:true}).fill("synthetic-official-ui-key");await page.getByRole("button",{name:"刷新可用模型",exact:true}).click();
    await page.getByLabel("Model",{exact:true}).selectOption("official-fixture-model");await expect(page.getByText("模型信息：official-fixture-model",{exact:true})).toBeVisible();
    await expect(page.getByRole("link",{name:"OpenAI 官方模型与参数文档",exact:true})).toHaveAttribute("href","https://developers.openai.com/api/docs/models/official-fixture-model");
    await expect(page.getByText("上下文窗口：123456",{exact:false})).toBeVisible();
    await expect(page.getByLabel("Model",{exact:true}).locator('option[value="retired-fixture-model"]')).toHaveJSProperty("disabled",true);
    await page.getByLabel("搜索模型",{exact:true}).fill("official-fixture");await expect(page.getByLabel("Model",{exact:true}).locator("option")).toHaveCount(2);
    await page.getByLabel("API Key",{exact:true}).fill("synthetic-replacement-ui-key");await expect(page.getByRole("button",{name:"保存模型",exact:true})).toBeDisabled();
    hold=true;await page.getByRole("button",{name:"刷新可用模型",exact:true}).click();await seen;
    await page.getByLabel("模型服务",{exact:true}).selectOption("custom");release();
    await expect(page.getByLabel("Model",{exact:true})).toHaveValue("");await expect(page.getByText("模型信息：official-fixture-model",{exact:true})).toHaveCount(0);
    expect(requests).toBe(2);expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain("synthetic-replacement-ui-key");
  }finally{release?.();}
});

test("real compatible catalog selects and persists an actual ID, reuses its saved Key, and explains model rejection",async({page})=>{
  const csrf=await admin(page),key="synthetic-model-service-key",name="catalog-ui-"+randomUUID().slice(0,8),requests:string[]=[];
  let mode="models";
  const server=createServer((req,res)=>{requests.push(req.method+" "+req.url);expect(req.headers.authorization).toBe("Bearer "+key);res.setHeader("Content-Type","application/json");
    if(req.method==="GET"&&mode==="models")res.end(JSON.stringify({data:[{id:"fixture-valid-model",created:1700000000,owned_by:"fixture"}]}));
    else {res.statusCode=mode==="auth"?401:404;res.end(JSON.stringify({error:{code:mode==="auth"?"invalid_api_key":"model_not_found",message:"synthetic private diagnostic "+key}}));}
  });await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  try{
    const base="http://127.0.0.1:"+(server.address() as any).port+"/v1";
    await page.goto("/models");await page.getByLabel("模型服务",{exact:true}).selectOption("custom");await page.getByLabel("模型配置名称",{exact:true}).fill(name);
    await page.getByLabel("Base URL",{exact:true}).fill(base+"/responses");await page.getByLabel("API Key",{exact:true}).fill(key);
    await page.getByRole("button",{name:"刷新可用模型",exact:true}).click();await page.getByRole("combobox",{name:"Model",exact:true}).selectOption("fixture-valid-model");await page.getByRole("button",{name:"保存模型",exact:true}).click();
    const card=page.locator("article").filter({has:page.getByRole("heading",{name,exact:true})});await expect(card.getByText("Key 已配置",{exact:false})).toBeVisible();
    let profile=(await(await page.request.get("/api/v2/model-profiles")).json()).data.find((p:any)=>p.name===name);expect(profile.baseUrl).toBe(base);expect(profile.model).toBe("fixture-valid-model");const secretRef=profile.secretRef;
    await card.getByRole("button",{name:"编辑模型",exact:true}).click();await expect(page.getByLabel("API Key",{exact:true})).toHaveValue("");await page.getByRole("button",{name:"刷新可用模型",exact:true}).click();await expect(page.getByLabel("Model",{exact:true})).toHaveValue("fixture-valid-model");
    await page.getByRole("button",{name:"保存模型",exact:true}).click();await expect(page.getByRole("heading",{name:"添加模型",exact:true})).toBeVisible();profile=(await(await page.request.get("/api/v2/model-profiles")).json()).data.find((p:any)=>p.name===name);expect(profile.secretRef).toBe(secretRef);
    await card.getByRole("button",{name:"测试文本 / 工具 / 流式",exact:true}).click();await expect(card.getByText("MODEL_NOT_AVAILABLE",{exact:false}).first()).toBeVisible();await expect(card.getByText("当前 Key 无法使用这个模型",{exact:false}).first()).toBeVisible();
    await card.getByRole("button",{name:"编辑模型",exact:true}).click();mode="auth";await page.getByRole("button",{name:"刷新可用模型",exact:true}).click();await expect(page.getByRole("alert")).toContainText("MODEL_AUTH_FAILED");await expect(page.getByRole("alert")).toContainText("API Key 无效");
    expect(requests.filter(item=>item==="GET /v1/models")).toHaveLength(3);expect(await page.locator("body").innerText()).not.toContain(key);expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain(key);
    const previousRequests=requests.length;
    await page.request.post("/api/v1/vault/lock",{headers:{"X-CSRF-Token":csrf},data:{}});
    await page.evaluate(()=>window.dispatchEvent(new Event("flowhub-credentials-changed")));
    await expect(page.getByRole("button",{name:"测试文本 / 工具 / 流式",exact:true}).first()).toBeDisabled();
    await expect(page.getByText("凭据库已锁定",{exact:false})).toBeVisible();
    await page.getByLabel("模型配置名称",{exact:true}).fill("解锁前保留的模型草稿");
    await expect(page.locator("#model-save-block")).toContainText("先解锁本机凭据库");
    await page.getByRole("button",{name:"去解锁凭据库",exact:true}).click();
    const unlock=page.getByRole("dialog",{name:"解锁凭据库",exact:true});
    await unlock.getByLabel("凭据库口令",{exact:true}).fill("Synthetic-browser-password-041");
    await unlock.getByRole("button",{name:"确认",exact:true}).click();
    await expect(unlock).toHaveCount(0);
    await expect(page.getByRole("button",{name:"测试文本 / 工具 / 流式",exact:true}).first()).toBeEnabled();
    await expect(page.getByLabel("模型配置名称",{exact:true})).toHaveValue("解锁前保留的模型草稿");
    expect(requests).toHaveLength(previousRequests);
    const denied=await page.request.post("/api/v2/model-catalog",{data:{serviceId:"custom",baseUrl:base,apiKey:key}});expect(denied.status()).toBe(403);
    const remove=await page.request.delete("/api/v2/model-profiles/"+profile.id,{headers:{"X-CSRF-Token":csrf}});expect(remove.ok()).toBeTruthy();
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
