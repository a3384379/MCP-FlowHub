import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve, relative } from "node:path";
import { parse } from "smol-toml";
import { ensure, hash, HubError, type Json } from "../../contracts/src/domain.js";
import { readAppServer } from "./app-server.js";
const exec=promisify(execFile);
export const executionLocation=process.platform==="win32"?"windows_native":process.platform==="darwin"?"macos":process.env.WSL_DISTRO_NAME?"wsl":"linux";
export async function locateCodex() {
  for(const root of (process.env.PATH??"").split(delimiter)) for(const file of process.platform==="win32"?["codex.exe","codex.cmd"]:["codex"])
    try {const path=await realpath(join(root,file));if((await stat(path)).isFile()&&!/\.cmd$/i.test(path))return path;}catch{}
  return null;
}
const output=async(context:Json,args:string[])=> (await exec(context.codexPath,args,{cwd:context.canonicalCwd,env:{...process.env,CODEX_HOME:context.codexHome},timeout:5000,maxBuffer:4*1024*1024,windowsHide:true})).stdout;
export async function createContext(a:Json={}) {
  const codexHome=await realpath(a.codexHome??process.env.CODEX_HOME??join(homedir(),".codex")),canonicalCwd=await realpath(a.cwd??process.cwd());
  const codexPath=a.codexPath??await locateCodex();
  ensure(!codexPath || isAbsolute(codexPath),"INPUT_INVALID","An absolute Codex executable is required.");
  const context:Json={hostId:process.platform,executionLocation,codexHome,canonicalCwd,profile:a.profile??null,codexPath,codexVersion:null,
    projectTrusted:a.projectTrusted===true,useAppServer:a.useAppServer===true,revision:1};
  if(codexPath)try{context.codexVersion=(await output(context,["--version"])).trim();}catch{}
  context.id="ctx_"+hash([context.hostId,executionLocation,codexHome,canonicalCwd,context.profile,context.codexVersion]).slice(0,24);
  return context;
}
export async function readConfig(path:string) { return parse(await readFile(path,"utf8")) as Json; }
const safeChild=async(root:string,child:string)=>{
  const path=await realpath(resolve(root,child)),rel=relative(await realpath(root),path);
  ensure(!rel.startsWith("..")&&!isAbsolute(rel),"SOURCE_UNREADABLE","Plugin component escaped its installed root.");return path;
};
const skillMeta=(text:string)=>({name:text.match(/^name:\s*["']?([^\n"']+)/m)?.[1]?.trim(),description:text.match(/^description:\s*["']?([^\n"']+)/m)?.[1]?.trim()??""});
export async function scanHost(context:Json) {
  const sources:Json[]=[],issues:Json[]=[],components:Json[]=[];let quality="partial";
  const report=(path:string,code:string)=>issues.push({source:path,code});
  let config:Json={};
  const userPath=join(context.codexHome,"config.toml"),projectPath=join(context.canonicalCwd,".codex","config.toml");
  try{config=await readConfig(userPath);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")report(userPath,"CONFIG_PARSE_ERROR");}
  const addServers=(servers:Json,path:string,locator:Json,enabled=true)=>{
    for(const [name,config] of Object.entries(servers??{}) as [string,Json][]) sources.push({sourceKey:path+"#"+name,name,kind:"mcp_server",config,locator:{...locator,name,path},enabled:enabled && config.enabled!==false});
  };
  let effective=false;
  if(context.executionLocation!==executionLocation)report(context.id,"EXECUTION_LOCATION_UNSUPPORTED");
  else if(context.codexPath)try{
    const help=await output(context,["mcp","list","--help"]);
    if(help.includes("--json") && !context.profile) {
      const servers=JSON.parse(await output(context,["mcp","list","--json"]));
      ensure(Array.isArray(servers),"CONFIG_PARSE_ERROR","CLI server list must be an array.");
      for(const server of servers)sources.push({sourceKey:"effective#"+server.name,name:server.name,kind:"mcp_server",enabled:server.enabled!==false,
        config:{...(server.transport??server),enabled:server.enabled!==false},locator:{kind:"cli",name:server.name,path:userPath}});
      effective=true;quality="host_effective";
    }
  }catch{report(context.codexPath,"SOURCE_UNREADABLE");}
  else report(context.id,"CODEX_NOT_FOUND");
  if(!effective) {
    addServers(config.mcp_servers,userPath,{kind:"config"});
    if(context.projectTrusted)try{const project=await readConfig(projectPath);addServers(project.mcp_servers,projectPath,{kind:"config"});}
      catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")report(projectPath,"CONFIG_PARSE_ERROR");}
    if(context.profile) {
      const profile=config.profiles?.[context.profile];
      if(profile?.mcp_servers)addServers(profile.mcp_servers,userPath+"#profile:"+context.profile,{kind:"profile",profile:context.profile});
      report(context.id,"STATIC_PROFILE_PARTIAL");
    }
    // Do not claim static duplicates represent the host's effective override resolution.
    quality="partial";
  }
  const addSkills=async(root:string,parent?:string)=>{
    let entries;try{entries=await readdir(root,{withFileTypes:true});}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")report(root,"SOURCE_UNREADABLE");return;}
    for(const entry of entries.slice(0,500))if(entry.isDirectory()&&!entry.name.startsWith(".")) {
      const path=join(root,entry.name,"SKILL.md");
      try{const real=await safeChild(root,entry.name+"/SKILL.md"),text=await readFile(real,"utf8");
        ensure(Buffer.byteLength(text)<=131072,"SCHEMA_LIMIT","Skill exceeds discovery size limit.");
        const meta=skillMeta(text);components.push({sourceKey:path,name:meta.name??entry.name,description:meta.description,kind:"skill",path:real,parent,contentHash:hash(text),content:text,enabled:true});
      }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")report(path,"SOURCE_UNREADABLE");}
    }
  };
  await addSkills(join(context.codexHome,"skills"));
  if(context.projectTrusted)await addSkills(join(context.canonicalCwd,".agents","skills"));
  // Only installed local packages selected by config or an explicit remote installation marker.
  const cache=join(context.codexHome,"plugins","cache");
  let markets:string[]=[];try{markets=await readdir(cache);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")report(cache,"SOURCE_UNREADABLE");}
  for(const market of markets.slice(0,100)) {
    let plugins:string[]=[];try{plugins=await readdir(join(cache,market));}catch{continue;}
    for(const name of plugins.slice(0,500)) {
      const base=join(cache,market,name),key=name+"@"+market;
      let installed=Object.hasOwn(config.plugins??{},key);
      try{const marker=JSON.parse(await readFile(join(base,".codex-remote-plugin-install.json"),"utf8"));installed ||= marker.schema_version===1;}catch{}
      if(!installed)continue;
      let versions:string[]=[];try{versions=await readdir(base);}catch{continue;}
      const candidates:Json[]=[];
      for(const version of versions.filter(v=>!v.startsWith(".")).slice(0,50)) {
        const root=join(base,version);try {
          const path=await safeChild(root,".codex-plugin/plugin.json"),manifest=JSON.parse(await readFile(path,"utf8"));
          if(manifest.name===name)candidates.push({root,manifest,version});
        }catch{}
      }
      const selected=config.plugins?.[key]?.version;
      const item=selected?candidates.find(c=>c.version===selected):candidates.length===1?candidates[0]:null;
      if(!item){report(base,candidates.length>1?"PLUGIN_VERSION_AMBIGUOUS":"PLUGIN_MANIFEST_UNSUPPORTED");continue;}
      const enabled=config.plugins?.[key]?.enabled!==false;
      components.push({sourceKey:key,name,kind:"plugin",installed:true,enabled,version:item.version,path:item.root,executor:"informational"});
      try{
        if(typeof item.manifest.mcpServers==="string") {
          const path=await safeChild(item.root,item.manifest.mcpServers),mcp=JSON.parse(await readFile(path,"utf8"));
          addServers(mcp.mcpServers,path,{kind:"plugin",plugin:key,root:item.root},enabled);
        }
        await addSkills(join(item.root,"skills"),key);
        for(const component of components)if(component.parent===key)component.enabled=enabled;
      }catch{report(item.root,"PLUGIN_MANIFEST_UNSUPPORTED");}
    }
  }
  if(context.useAppServer)try{
    const response=await readAppServer(context,"skills/list",{cwds:[context.canonicalCwd],forceReload:true});
    for(const group of response.data??[])for(const skill of group.skills??[]) {
      if(!components.some(c=>c.path===skill.path))components.push({sourceKey:skill.path,name:skill.name,description:skill.description,kind:"skill",path:skill.path,enabled:skill.enabled,executor:"codex_host",contentHash:hash([skill.name,skill.description]),hostOnly:true});
    }
  }catch{report(context.id,"APP_SERVER_PARTIAL");}
  return {sources,components,issues,resolutionQuality:quality,coverage:issues.length?"partial":"complete"};
}

/** Re-read the selected source only; no credentials are persisted in the public directory. */
export async function resolveSource(context:Json,locator:Json):Promise<Json> {
  if(locator.kind==="cli") {
    const list=JSON.parse(await output(context,["mcp","list","--json"]));const server=list.find((s:Json)=>s.name===locator.name);
    ensure(server,"CAPABILITY_STALE","Source disappeared.",409);return {...server.transport,enabled:server.enabled!==false};
  }
  if(locator.kind==="plugin") {
    const path=await safeChild(locator.root,relative(locator.root,locator.path));
    return JSON.parse(await readFile(path,"utf8")).mcpServers[locator.name];
  }
  const config=await readConfig(locator.kind==="profile"?join(context.codexHome,"config.toml"):locator.path);
  return locator.kind==="profile"?config.profiles?.[locator.profile]?.mcp_servers?.[locator.name]:config.mcp_servers?.[locator.name];
}
