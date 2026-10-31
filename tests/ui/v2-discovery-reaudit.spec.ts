import {test,expect} from "@playwright/test";
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";

test("discovery accepts an explicit executable and remembers configuration-only selection without launching Codex",async({page})=>{
  const root=await realpath(await mkdtemp(join(process.env.FLOWHUB_UI_DATA_DIR!,"flowhub-ui-discovery-"))),home=join(root,"home"),cwd=join(root,"project"),cli=join(root,"synthetic-codex.mjs"),marker=join(root,"invoked");await mkdir(home);await mkdir(cwd);await writeFile(join(home,"config.toml"),"");
  await writeFile(cli,`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},process.argv.slice(2).join(' ')+'\\n');console.log(process.argv.includes('--version')?'codex-cli synthetic-ui':process.argv.includes('--help')?'--json':'[]');`);
  const password="Synthetic-browser-password-041",initialized=(await(await page.request.get("/api/v1/auth/state")).json()).data.initialized;
  const auth=await page.request.post("/api/v1/auth/"+(initialized?"session":"bootstrap"),{data:initialized?{password}:{password,setupToken:await readFile(process.env.FLOWHUB_UI_DATA_DIR+"/admin-setup-token","utf8")}});expect(auth.ok()).toBeTruthy();const csrf=(await auth.json()).data.csrf;
  const seed=await page.request.post("/api/v2/host-contexts",{headers:{"X-CSRF-Token":csrf},data:{codexHome:home,cwd,codexPath:null,discoveryMode:"config_only"}});expect(seed.ok()).toBeTruthy();const configContext=(await seed.json()).data;
  await page.addInitScript(contextId=>{if(!localStorage.getItem("flowhub.discovery.context"))localStorage.setItem("flowhub.discovery.context",contextId);},configContext.id);
  try {
    await page.goto("/discovery");await page.getByText("登记本机 Codex 上下文",{exact:true}).click();await expect(page.getByLabel("发现模式",{exact:true})).toHaveValue("config_only");await page.getByLabel("发现模式",{exact:true}).selectOption("auto");await page.getByLabel("Codex 可执行文件绝对路径（留空自动查找）",{exact:true}).fill(cli);await page.getByRole("button",{name:"登记上下文",exact:true}).click();
    await expect(page.locator(".v2-discovery [role=status]")).toContainText("SUCCEEDED");const contexts=(await(await page.request.get("/api/v2/host-contexts")).json()).data,manual=contexts.find((context:any)=>context.codexPath===cli);expect(manual).toBeTruthy();expect(manual.discoveryMode).toBe("auto");expect(await page.evaluate(()=>localStorage.getItem("flowhub.discovery.context"))).toBe(manual.id);expect(await readFile(marker,"utf8")).toContain("--version");
    await page.getByLabel("发现模式",{exact:true}).selectOption("config_only");await page.getByRole("button",{name:"登记上下文",exact:true}).click();await expect(page.locator(".v2-discovery [role=status]")).toContainText("PARTIAL");await expect(page.getByLabel("Codex 可执行文件绝对路径（留空自动查找）",{exact:true})).toBeDisabled();expect(await page.evaluate(()=>localStorage.getItem("flowhub.discovery.context"))).toBe(configContext.id);const before=await readFile(marker,"utf8");
    await page.reload();await page.getByText("登记本机 Codex 上下文",{exact:true}).click();await expect(page.getByLabel("发现模式",{exact:true})).toHaveValue("config_only");await expect(page.getByLabel("补充查询独立 App Server 会话目录",{exact:true})).toBeDisabled();expect(await readFile(marker,"utf8")).toBe(before);
  }finally{await rm(root,{recursive:true,force:true});}
});
