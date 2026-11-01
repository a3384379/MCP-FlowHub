import {test,expect} from "@playwright/test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";

test("a fresh installation logs in with admin/admin without a setup-code step",async({page})=>{
  const {startDaemon}=await import(pathToFileURL(resolve("dist/apps/daemon/src/index.js")).href);
  const dataDir=await mkdtemp(join(tmpdir(),"flowhub-default-login-ui-"));
  const daemon=await startDaemon({dataDir,port:0});
  try{
    await page.goto(`http://127.0.0.1:${daemon.port}/`);
    await expect(page.getByText("默认账号：admin，默认密码：admin。",{exact:true})).toBeVisible();
    await expect(page.getByLabel("本机一次性设置码")).toHaveCount(0);
    await expect(page.getByLabel("管理员账号",{exact:true})).toHaveValue("admin");
    await page.getByLabel("管理员密码",{exact:true}).fill("admin");
    await page.getByRole("button",{name:"登录管理中心",exact:true}).click();
    await expect(page.getByRole("heading",{name:"工作流",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"退出登录",exact:true}).click();
    await expect(page.getByLabel("本机一次性设置码")).toHaveCount(0);
    await page.getByLabel("管理员密码",{exact:true}).fill("admin");
    await page.getByRole("button",{name:"登录管理中心",exact:true}).click();
    await expect(page.getByRole("heading",{name:"工作流",exact:true})).toBeVisible();
  }finally{await daemon.close();await rm(dataDir,{recursive:true,force:true});}
});
