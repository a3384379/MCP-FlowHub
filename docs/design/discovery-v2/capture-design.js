async (page) => {
 const base='output/playwright/discovery-design/';
 await page.reload();
 await page.setViewportSize({width:1440,height:1240});
 await page.screenshot({path:base+'overview.png',scale:'css'});
 await page.getByRole('tab',{name:'Skills 技能 8'}).click();
 await page.setViewportSize({width:1440,height:1420});
 await page.screenshot({path:base+'skills.png',scale:'css'});
 await page.getByRole('tab',{name:'插件与关系 3'}).click();
 await page.setViewportSize({width:1440,height:1320});
 await page.screenshot({path:base+'plugin-relations.png',scale:'css'});
 await page.getByRole('tab',{name:'MCP 服务 6'}).click();
 await page.setViewportSize({width:1440,height:1060});
 return {screenshots:['overview.png','skills.png','plugin-relations.png'],scope:'Synthetic design fixtures only'};
}
