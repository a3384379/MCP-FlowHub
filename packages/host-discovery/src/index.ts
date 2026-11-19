import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, basename, dirname, isAbsolute, join, resolve, relative } from "node:path";
import { parse, TomlError } from "smol-toml";
import { ensure, hash, HubError, type Json } from "../../contracts/src/domain.js";
import { readAppServer } from "./app-server.js";
import {discoveryCommand,type DiscoveryRuntime} from "./runtime.js";
import { skillMetadata } from "./metadata.js";
import { addLocalMarketplaces } from "./marketplace.js";
export type {DiscoveryRuntime} from "./runtime.js";
const exec=promisify(execFile);
export const executionLocation=process.platform==="win32"?"windows_native":process.platform==="darwin"?"macos":process.env.WSL_DISTRO_NAME?"wsl":"linux";
export async function locateCodex() {
  const windows = process.platform === "win32";
  const roots = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
  const file = windows ? "codex.exe" : "codex";
  async function firstExisting(paths: string[]) {
    for (const candidate of paths) {
      try {
        const path = await realpath(candidate);
        if ((await stat(path)).isFile()) return path;
      } catch { /* Continue through installed executable candidates. */ }
    }
    return null;
  }
  const onPath = await firstExisting(roots.map(root => join(root, file)));
  if (onPath || !windows) return onPath;

  const applicationRoots = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Codex"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "OpenAI", "Codex"),
    process.env.ProgramFiles && join(process.env.ProgramFiles, "OpenAI", "Codex"),
  ].filter((path): path is string => !!path && isAbsolute(path));
  const desktopBinaries = (directory: string) =>
    ["resources/codex.exe", "app/resources/codex.exe", "resources/bin/codex.exe", "app/resources/bin/codex.exe"]
      .map(path => join(directory, path));
  const desktop = await firstExisting(applicationRoots.flatMap(desktopBinaries));
  if (desktop) return desktop;
  try {
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = exec(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-AppxPackage -Name 'OpenAI.*' | Where-Object { $_.Name -match 'Codex|ChatGPT' } | Select-Object -First 8 -ExpandProperty InstallLocation"],
      { windowsHide: true, timeout: 5000, maxBuffer: 32768 });
    result.child.stdin?.end();
    return await firstExisting((await result).stdout.split(/\r?\n/).filter(isAbsolute).flatMap(desktopBinaries));
  } catch { /* Package discovery may be unavailable on managed Windows. */ }
  return null;
}
export type DiscoveryControl = { signal?: AbortSignal; deadline?: number };
const output=async(context:Json,args:string[],control:DiscoveryControl={},runtime:DiscoveryRuntime={})=> {const command=discoveryCommand(context,args,runtime);return (await exec(command.executable,command.args,{cwd:context.canonicalCwd,env:{...process.env,CODEX_HOME:context.codexHome},timeout:Math.max(1,Math.min(5000,(control.deadline??Infinity)-Date.now())),maxBuffer:4*1024*1024,windowsHide:true,killSignal:"SIGKILL",...(control.signal?{signal:control.signal}:{})})).stdout;};
export function normalizedServer(server:Json):Json {
  const transport=server.transport??server;
  return {...transport,enabled:server.enabled!==false && transport.enabled!==false,
    ...Object.fromEntries(["enabled_tools","disabled_tools","cwd","env_http_headers","http_headers_helper","placement"].filter(k=>server[k]!==undefined).map(k=>[k,server[k]]))};
}
export function toolEnabled(config:Json,name:string) {
  return config.enabled!==false && (!Array.isArray(config.enabled_tools)||config.enabled_tools.includes(name)) && !(config.disabled_tools??[]).includes(name);
}
/** Authentication locations only; business payloads never pass through this classifier. */
export function sourcePolicy(config:Json) {
  const args=config.args??[],launcher=basename(config.command??"").replace(/\.exe$/i,"").toLowerCase();
  const genericFlags=/^(?:-y|-q|-v|--yes|--quiet|--verbose|--stdio|--http|--sse|--transport|--port|--host|--config|--directory|--root|--readonly|--read-only|--log-level|--no-color)(?:=|$)/;
  // Launcher dialects are explicit; unsupported options remain metadata only.
  // Python -m/-u, uvx --from, and npm exec/npx --package are startup controls,
  // while -c/--eval and shell dispatch are deliberately outside discovery import.
  const launcherFlag=(value:string)=>
    /^python(?:[23](?:\.\d+)*)?$/.test(launcher)?/^(?:-m|-u|-B|-E|-I|-s|-S)$/.test(value):
    ["node","nodejs"].includes(launcher)?/^(?:--no-warnings|--enable-source-maps|--experimental-strip-types|--experimental-transform-types)$/.test(value):
    launcher==="uvx"?/^(?:--from|--with|--python|--python-preference|--isolated|--no-cache|--offline)(?:=|$)/.test(value):
    ["npx","npm"].includes(launcher)?/^(?:--package|-p|--yes|--no|--offline|--prefer-offline|--ignore-scripts)(?:=|$)/.test(value):false;
  const credentialArgs=args.some((value:Json,index:number)=>typeof value==="string" && (
    /^--?[a-z0-9_-]*(?:key|token|password|passwd|secret|authorization|credential|cookie)(?:[=_-]|$)/i.test(value) ||
    /^(?:--header|-H)(?:=|$)/i.test(value) || /^(?:authorization|proxy-authorization|cookie|x-api-key)\s*:/i.test(value) ||
    /[a-z][a-z0-9+.-]*:\/\/[^\s]*[@?#]/i.test(value) ||
    (index>0 && /^(?:--header|-H)$/i.test(args[index-1]))));
  const unsupportedArgs=!credentialArgs&&args.some((value:Json)=>typeof value!=="string" || value.startsWith("-")&&!genericFlags.test(value)&&!launcherFlag(value));
  let embeddedUrl=false;try {if(config.url){const url=new URL(config.url);embeddedUrl=!!(url.username||url.password||url.search||url.hash);}}catch{embeddedUrl=true;}
  const unsupported=unsupportedArgs||!!(config.cwd||config.http_headers_helper||config.placement && config.placement!=="local" || config.remote || config.type && !["stdio","http","streamable_http"].includes(config.type));
  const credentialVariables=[...(config.env_vars??[]),...Object.keys(config.env??{}),...Object.values(config.env_http_headers??{}),...(config.bearer_token_env_var?[config.bearer_token_env_var]:[])];
  return {credentialArgs,embeddedUrl,unsupportedArgs,unsupported,credentialVariables:[...new Set(credentialVariables)],requiresCredentials:credentialArgs||embeddedUrl||credentialVariables.length>0||Object.keys(config.http_headers??{}).length>0};
}
export function selfSource(source:Json,identity:Json={}) {
  const config=source.config??{},normal=(value:string)=>{try{const u=new URL(value);u.hostname=["localhost","[::1]"].includes(u.hostname)?"127.0.0.1":u.hostname;u.pathname=u.pathname.replace(/\/+$/,"");return u.origin+u.pathname;}catch{return value;}};
  return /^(?:flowhub|mcp-flowhub)(?:[-_].*)?$/i.test(source.name??"") ||
    !!config.url&&(identity.endpoints??[]).some((url:string)=>normal(url)===normal(config.url)) ||
    !!config.instanceId&&config.instanceId===identity.instanceId ||
    (config.args??[]).some((v:Json)=>typeof v==="string"&&/(?:^|[/\\])apps[/\\]daemon[/\\]src[/\\]cli\.js$/i.test(v)) ||
    /mcp-flowhub|flowhub(?:\.exe)?$/i.test(config.command??"");
}
export async function createContext(a:Json={},runtime:DiscoveryRuntime={}) {
  const codexHome=await realpath(a.codexHome??process.env.CODEX_HOME??join(homedir(),".codex")),canonicalCwd=await realpath(a.cwd??process.cwd());
  ensure(a.discoveryMode===undefined||["auto","config_only"].includes(a.discoveryMode),"INPUT_INVALID","Select auto or config_only discovery.");
  const configOnly=a.discoveryMode==="config_only"||Object.hasOwn(a,"codexPath")&&a.codexPath===null;
  const codexPath=configOnly?null:typeof a.codexPath==="string"?a.codexPath:await locateCodex();
  ensure(!codexPath || isAbsolute(codexPath),"INPUT_INVALID","An absolute Codex executable is required.");
  const context:Json={hostId:process.platform,executionLocation,codexHome,canonicalCwd,profile:a.profile??null,codexPath,codexVersion:null,
    projectTrusted:a.projectTrusted===true,useAppServer:!configOnly&&a.useAppServer===true,discoveryMode:configOnly?"config_only":"auto",revision:1};
  if(codexPath)try{context.codexVersion=(await output(context,["--version"],{},runtime)).trim();}catch{}
  context.id="ctx_"+hash([context.hostId,executionLocation,codexHome,canonicalCwd,context.profile,context.codexVersion,...(configOnly?["config_only"]:[])]).slice(0,24);
  return context;
}
export async function readConfig(path:string) { return parse(await readFile(path,"utf8")) as Json; }
const safeChild=async(root:string,child:string)=>{
  const path=await realpath(resolve(root,child)),rel=relative(await realpath(root),path);
  ensure(!rel.startsWith("..")&&!isAbsolute(rel),"SOURCE_UNREADABLE","Plugin component escaped its installed root.");return path;
};
export async function scanHost(context:Json,depth="metadata",control:DiscoveryControl={},identity:Json={},runtime:DiscoveryRuntime={}) {
  const sources:Json[]=[],issues:Json[]=[],components:Json[]=[];let quality="partial";
  const report=(path:string,code:string)=>issues.push({source:path,code});
  let config:Json={};
  const skillOverrides=new Map<string,boolean>();
  const overrides=(c:Json)=>{for(const value of c.skills?.config??[])if(typeof value.path==="string")skillOverrides.set(resolve(value.path),value.enabled!==false);};
  const userPath=join(context.codexHome,"config.toml"),projectPath=join(context.canonicalCwd,".codex","config.toml");
  try{config=await readConfig(userPath);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")report(userPath,e instanceof TomlError?"CONFIG_PARSE_ERROR":"SOURCE_UNREADABLE");}
  overrides(config);
  let project:Json={};
  if(context.projectTrusted)try{project=await readConfig(projectPath);overrides(project);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")report(projectPath,e instanceof TomlError?"CONFIG_PARSE_ERROR":"SOURCE_UNREADABLE");}
  // These are observed declarations in read order, not a home-grown precedence
  // resolver. Only the host CLI may declare an effective merged configuration.
  const declarations=(name:string)=>[
    ...(Object.hasOwn(config.mcp_servers??{},name)?[{path:userPath,layer:"user"}]:[]),
    ...(Object.hasOwn(project.mcp_servers??{},name)?[{path:projectPath,layer:"trusted_project"}]:[]),
    ...(context.profile&&Object.hasOwn(config.profiles?.[context.profile]?.mcp_servers??{},name)?[{path:userPath+"#profile:"+context.profile,layer:"profile"}]:[]),
  ];
  const addServers=(servers:Json,path:string,locator:Json,enabled=true,serverOverrides:Json={})=>{
    for(const [name,raw] of Object.entries(servers??{}) as [string,Json][]) {
      const config={...raw,...serverOverrides[name],enabled:enabled&&raw.enabled!==false&&serverOverrides[name]?.enabled!==false};
      sources.push({sourceKey:path+"#"+name,name,kind:"mcp_server",config,locator:{...locator,name,path},enabled:config.enabled,sourceChain:[path],
        resolutionEvidence:locator.kind==="plugin"
          ?{kind:"plugin_component",declarations:[{path,layer:"installed_plugin"}],declarationOrder:"not_applicable"}
          :{kind:"static_candidate",profile:context.profile??null,declarations:declarations(name),declarationOrder:"read_order_not_precedence"}});
    }
  };
  let effective=false, untrustedProject=false;
  if(context.executionLocation!==executionLocation)report(context.id,"EXECUTION_LOCATION_UNSUPPORTED");
  else if(context.codexPath&&context.discoveryMode!=="config_only")try{
    const help=await output(context,["mcp","list","--help"],control,runtime);
    // The local reading choice must not silently let an untrusted project's
    // config enter through the CLI's own trust settings. Without a documented
    // no-project flag, retain conservative static candidates in that case.
    if(!context.projectTrusted)try{untrustedProject=(await stat(projectPath)).isFile();}catch{}
    if(untrustedProject)report(projectPath,"PROJECT_CONFIGURATION_NOT_TRUSTED");
    const profileSupported=!context.profile||/(?:^|\s)--profile(?:[=\s,<]|$)/m.test(await output(context,["--help"],control,runtime));
    if(help.includes("--json") && profileSupported && !untrustedProject) {
      const args=context.profile?["--profile",context.profile,"mcp","list","--json"]:["mcp","list","--json"];
      const servers=JSON.parse(await output(context,args,control,runtime));
      ensure(Array.isArray(servers),"CONFIG_PARSE_ERROR","CLI server list must be an array.");
      for(const server of servers)sources.push({sourceKey:"effective#"+server.name,name:server.name,kind:"mcp_server",enabled:server.enabled!==false,
        config:normalizedServer(server),sourceChain:["host CLI effective configuration",...declarations(server.name).map(d=>d.path)],
        resolutionEvidence:{kind:"host_effective",profile:context.profile??null,declarations:declarations(server.name),declarationOrder:"read_order_not_precedence"},
        locator:{kind:"cli",name:server.name,path:userPath,...(context.profile?{profile:context.profile}:{})}});
      effective=true;quality="host_effective";
    }
  }catch{report(context.codexPath,"SOURCE_UNREADABLE");}
  else if(context.discoveryMode!=="config_only")report(context.id,"CODEX_NOT_FOUND");
  if(!effective) {
    addServers(config.mcp_servers,userPath,{kind:"config"});
    if(context.projectTrusted)addServers(project.mcp_servers,projectPath,{kind:"config"});
    if(context.profile) {
      const profile=config.profiles?.[context.profile];
      if(profile?.mcp_servers)addServers(profile.mcp_servers,userPath+"#profile:"+context.profile,{kind:"profile",profile:context.profile});
      report(context.id,"STATIC_PROFILE_PARTIAL");
    }
    // Do not claim static duplicates represent the host's effective override resolution.
    quality="partial";
  }
  const addSkills=async(root:string,parent?:string)=>{
    try {
      const real=await safeChild(root,"SKILL.md"),text=await readFile(real,"utf8");ensure(Buffer.byteLength(text)<=131072,"SCHEMA_LIMIT","Skill exceeds discovery size limit.");const meta=await skillMetadata(real,text,report);
      components.push({sourceKey:real,...meta,name:meta.name||basename(root),kind:"skill",path:real,parent,contentHash:hash(text),content:text,enabled:skillOverrides.get(resolve(real))??skillOverrides.get(dirname(real))??true});return;
    }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT"){report(root,"SOURCE_UNREADABLE");return;}}
    let entries;try{entries=await readdir(root,{withFileTypes:true});}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")report(root,"SOURCE_UNREADABLE");return;}
    for(const entry of entries.slice(0,500))if(entry.isDirectory()&&!entry.name.startsWith(".")) {
      const path=join(root,entry.name,"SKILL.md");
      try{const real=await safeChild(root,entry.name+"/SKILL.md"),text=await readFile(real,"utf8");
        ensure(Buffer.byteLength(text)<=131072,"SCHEMA_LIMIT","Skill exceeds discovery size limit.");
        const meta=await skillMetadata(real,text,report);components.push({sourceKey:path,...meta,name:meta.name||entry.name,kind:"skill",path:real,parent,contentHash:hash(text),content:text,enabled:skillOverrides.get(resolve(real))??skillOverrides.get(dirname(real))??true});
      }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")report(path,"SOURCE_UNREADABLE");}
    }
  };
  await addSkills(join(context.codexHome,"skills"));
  await addSkills(join(context.codexHome,"skills",".system"));
  // The user skill directory is derived from this registered home, never from daemon env.
  await addSkills(join(dirname(context.codexHome),".agents","skills"));
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
      let versions:string[], canonicalBase:string;
      try {
        canonicalBase=await safeChild(cache,relative(cache,base));
        if(canonicalBase!==join(await realpath(cache),market,name)) {
          report(base,"SOURCE_UNREADABLE");continue;
        }
        versions=await readdir(canonicalBase);
      } catch {continue;}
      const candidates=new Map<string, Json>();
      const aliases=new Map<string,string>();
      for(const version of versions.filter(v=>!v.startsWith(".")).slice(0,50)) {
        try {
          // A cache alias (for example Chrome's latest) is another path to the
          // same installation. Also confine symlinks to this plugin's own root.
          const root=await safeChild(canonicalBase,version);
          const canonicalVersion=basename(root);
          if(dirname(root)!==canonicalBase)continue;
          if(candidates.has(root)){aliases.set(version,root);continue;}
          const path=await safeChild(root,".codex-plugin/plugin.json"),manifest=JSON.parse(await readFile(path,"utf8"));
          // This adapter supports the legacy unversioned format only. A plugin's
          // release `version` is separate from an explicitly declared format version.
          ensure(["schemaVersion","schema_version","manifest_version"].every(key=>manifest[key]===undefined),"PLUGIN_MANIFEST_UNSUPPORTED","Plugin manifest format version is unsupported.");
          if(manifest.name===name){candidates.set(root,{root,manifest,version:canonicalVersion});aliases.set(version,root);}
        }catch{}
      }
      const selected=config.plugins?.[key]?.version;
      const item=selected?candidates.get(aliases.get(selected)??""):candidates.size===1?candidates.values().next().value:null;
      if(!item){report(base,candidates.size>1?"PLUGIN_VERSION_AMBIGUOUS":"PLUGIN_MANIFEST_UNSUPPORTED");continue;}
      const enabled=config.plugins?.[key]?.enabled!==false;
      components.push({sourceKey:key,name,description:typeof item.manifest.description==="string"?item.manifest.description.slice(0,8000):"",kind:"plugin",installed:true,enabled,version:item.version,path:item.root,executor:"informational",manifestHash:hash(item.manifest)});
      try{
        if(typeof item.manifest.mcpServers==="string") {
          const path=await safeChild(item.root,item.manifest.mcpServers),mcp=JSON.parse(await readFile(path,"utf8"));
          addServers(mcp.mcpServers,path,{kind:"plugin",plugin:key,root:item.root},enabled,config.plugins?.[key]?.mcp_servers??{});
        }
        const skillRoots=item.manifest.skills===undefined?["skills"]:Array.isArray(item.manifest.skills)?item.manifest.skills:[item.manifest.skills];
        for(const skillRoot of skillRoots)if(typeof skillRoot==="string")try{await addSkills(await safeChild(item.root,skillRoot),key);}catch(e){if(item.manifest.skills!==undefined||(e as NodeJS.ErrnoException).code!=="ENOENT")report(item.root,"SOURCE_UNREADABLE");}
        if(typeof item.manifest.apps==="string") {
          const appPath=await safeChild(item.root,item.manifest.apps),apps=JSON.parse(await readFile(appPath,"utf8"));
          for(const [appName] of Object.entries(apps.apps??{}))components.push({sourceKey:key+"#app:"+appName,name:appName,kind:"app",parent:key,path:appPath,enabled,executor:"informational",installation:"unknown"});
        }
        for(const component of components)if(component.parent===key)component.enabled=enabled&&component.enabled;
      }catch{report(item.root,"PLUGIN_MANIFEST_UNSUPPORTED");}
    }
  }
  await addLocalMarketplaces(context,components,report);
  if(context.executionLocation===executionLocation&&(context.useAppServer||depth==="host_catalog")&&context.codexPath&&context.discoveryMode!=="config_only")try{
    // A registered context can survive a Codex update.
    ensure(!untrustedProject&&(!context.profile||effective),"HOST_VERSION_UNSUPPORTED","App Server scan cannot establish the selected project/profile.");
    const host={...context,codexVersion:(await output(context,["--version"],control,runtime)).trim()};
    const response=await readAppServer(host,"skills/list",{cwds:[context.canonicalCwd],forceReload:true},control,runtime);
    for(const group of response.data)if(group.errors?.length)report(context.id,"HOST_SKILLS_PARTIAL");
    for(const group of response.data??[])for(const skill of group.skills??[]) {
      const existing=components.find(c=>c.path===skill.path||dirname(c.path??"")===skill.path);
      if(existing){existing.enabled=existing.enabled!==false&&skill.enabled!==false;existing.hostReported=true;}
      else components.push({sourceKey:skill.path,name:skill.name,description:skill.description,kind:"skill",path:skill.path,enabled:skill.enabled!==false,executor:"codex_host",contentHash:hash([skill.name,skill.description]),hostOnly:true});
    }
    if(depth==="catalog"||depth==="host_catalog") {
      const catalog=await readAppServer(host,"mcpServerStatus/list",{detail:"toolsAndAuthOnly",limit:100},control,runtime);
      for(const server of catalog.data??[]) {
        const matches=sources.filter(s=>s.name===server.name),source=matches.length===1?matches[0]:undefined;
        if(matches.some(s=>selfSource(s,identity))||selfSource(server,identity))continue;
        if(matches.length>1)report(server.name,"HOST_SOURCE_AMBIGUOUS");
        if(server.toolsError)report(server.name,"HOST_CATALOG_PARTIAL");
        if(server.authStatus==="notLoggedIn")report(source?.sourceKey??server.name,"CODEX_AUTH_REQUIRED");
        for(const tool of Object.values(server.tools??{}) as Json[])components.push({sourceKey:"app-server:"+server.name+"#"+tool.name,name:tool.name,description:tool.description??"",kind:"host_tool",tool,serverName:server.name,serverSourceKey:source?.sourceKey??null,ambiguousSource:matches.length>1,executor:"codex_host",enabled:matches.length>1?false:source?source.enabled&&toolEnabled(source.config,tool.name):true});
      }
      if(catalog.nextCursor)report(context.id,"HOST_CATALOG_PARTIAL");
    }
  }catch(error){report(context.id,error instanceof HubError&&error.code==="HOST_VERSION_UNSUPPORTED"?"HOST_VERSION_UNSUPPORTED":"APP_SERVER_PARTIAL");}
  else if(depth==="host_catalog")report(context.id,"HOST_VERSION_UNSUPPORTED");
  if(!effective)issues.push({source:context.id,code:"STATIC_RESOLUTION_PARTIAL"});
  if(control.signal?.aborted)throw new HubError("DISCOVERY_CANCELLED","Discovery cancelled.");
  return {sources,components,issues,resolutionQuality:quality,coverage:issues.length?"partial":"complete"};
}

/** Re-read the selected source only; no credentials are persisted in the public directory. */
export async function resolveSource(context:Json,locator:Json,control:DiscoveryControl={},runtime:DiscoveryRuntime={}):Promise<Json> {
  if(locator.kind==="cli") {
    const args=locator.profile?["--profile",locator.profile,"mcp","list","--json"]:["mcp","list","--json"];
    const list=JSON.parse(await output(context,args,control,runtime));const server=list.find((s:Json)=>s.name===locator.name);
    ensure(server,"CAPABILITY_STALE","Source disappeared.",409);return normalizedServer(server);
  }
  if(locator.kind==="plugin") {
    const path=await safeChild(locator.root,relative(locator.root,locator.path));
    const config=await readConfig(join(context.codexHome,"config.toml")),plugin=config.plugins?.[locator.plugin],raw=JSON.parse(await readFile(path,"utf8")).mcpServers[locator.name],over=plugin?.mcp_servers?.[locator.name];
    return {...raw,...over,enabled:plugin?.enabled!==false&&raw?.enabled!==false&&over?.enabled!==false};
  }
  const config=await readConfig(locator.kind==="profile"?join(context.codexHome,"config.toml"):locator.path);
  const raw=locator.kind==="profile"?config.profiles?.[locator.profile]?.mcp_servers?.[locator.name]:config.mcp_servers?.[locator.name];
  ensure(raw,"CAPABILITY_STALE","Source disappeared.",409);return normalizedServer(raw);
}
