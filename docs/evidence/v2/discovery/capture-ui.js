async (page) => {
 const base='output/playwright/discovery-runtime/', errors=[],consoleErrors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
 await page.reload();await page.getByRole('button',{name:'查看合成订单服务详情'}).waitFor();
 await page.setViewportSize({width:1440,height:1040});await page.screenshot({path:base+'desktop.png',scale:'css'});
 await page.getByRole('button',{name:'查看合成订单服务详情'}).click();await page.locator('.d-tool-card').first().waitFor();
 await page.screenshot({path:base+'mcp-detail.png',scale:'css'});
 await page.getByRole('button',{name:'相关 Skills',exact:true}).click();await page.getByRole('button',{name:'订单分析报告',exact:true}).click();await page.getByRole('heading',{name:'订单分析报告',exact:true}).waitFor();
 await page.screenshot({path:base+'skill-detail.png',scale:'css'});await page.keyboard.press('Escape');
 await page.getByRole('tab',{name:/插件与关系/}).click();await page.locator('.d-tree-item').first().waitFor();await page.screenshot({path:base+'plugin-relations.png',scale:'css'});
 await page.getByRole('tab',{name:/Skills 技能/}).click();await page.locator('.d-cap-row').first().waitFor();await page.screenshot({path:base+'skills.png',scale:'css'});
 await page.getByRole('button',{name:'中文整理方式',exact:true}).click();await page.getByRole('heading',{name:'让能力说明更好懂',exact:true}).waitFor();await page.screenshot({path:base+'localization.png',scale:'css'});await page.keyboard.press('Escape');
 await page.getByRole('tab',{name:/MCP 服务/}).click();await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'查看合成订单服务详情'}).waitFor();await page.screenshot({path:base+'mobile.png',scale:'css'});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(overflow)throw Error('Mobile horizontal overflow');
 await page.getByRole('button',{name:'查看合成订单服务详情'}).click();await page.locator('.d-tool-card').first().waitFor();await page.screenshot({path:base+'mobile-detail.png',scale:'css'});await page.keyboard.press('Escape');
 if(errors.length||consoleErrors.length)throw Error(JSON.stringify({errors,consoleErrors}));
 await page.setViewportSize({width:1440,height:1040});
 return {scope:'real built UI, real daemon and official MCP Client; synthetic isolated Codex/MCP fixture only',errors,consoleErrors,mobileHorizontalOverflow:overflow,modelCalls:0,businessToolCalls:0,images:8};
}
