import type {DiscoveryRuntime} from "../../packages/host-discovery/src/index.js";

/** Real subprocesses on every OS: no executable-script/shebang or shell support is assumed. */
export const nodeScriptRuntime:DiscoveryRuntime={command:(context,args)=>({executable:process.execPath,args:[context.codexPath,...args]})};
