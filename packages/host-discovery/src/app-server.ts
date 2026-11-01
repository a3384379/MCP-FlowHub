import {VERSION} from "../../contracts/src/index.js";
import type { DiscoveryControl } from "./index.js";
import {discoveryCommand,type DiscoveryRuntime} from "./runtime.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { HubError, type Json } from "../../contracts/src/domain.js";
import type { ConfigReadParams } from "./generated/v2/ConfigReadParams.js";
import type { SkillsListParams } from "./generated/v2/SkillsListParams.js";
import type { ListMcpServerStatusParams } from "./generated/v2/ListMcpServerStatusParams.js";

export const APP_SERVER_SCHEMA_VERSION="0.164.0-alpha.11.1";
/** A new, bounded, read-only session; never attaches to a Desktop thread. */
export async function readAppServer(context: Json, method: "config/read"|"skills/list"|"mcpServerStatus/list", params: ConfigReadParams|SkillsListParams|ListMcpServerStatusParams, control:DiscoveryControl={},runtime:DiscoveryRuntime={}): Promise<Json> {
  if(context.codexVersion!=="codex-cli "+APP_SERVER_SCHEMA_VERSION) throw new HubError("HOST_VERSION_UNSUPPORTED","App Server schema does not match the installed version.");
  return new Promise((resolve,reject)=>{
    const command=discoveryCommand(context,["app-server","--stdio"],runtime);
    const child=spawn(command.executable,command.args,{cwd:context.canonicalCwd,env:{...process.env,CODEX_HOME:context.codexHome},stdio:["pipe","pipe","pipe"],windowsHide:true});
    const abort=()=>finish(new HubError("DISCOVERY_CANCELLED","Discovery cancelled."));
    const lines=createInterface({input:child.stdout});let done=false;
    const finish=(error?:Error,value?:Json)=>{if(done)return;done=true;clearTimeout(timer);control.signal?.removeEventListener("abort",abort);lines.close();child.stdin.end();
      const settled=()=>{clearTimeout(hardStop);error?reject(error):resolve(value);};
      const hardStop=setTimeout(()=>{child.kill("SIGKILL");},250);
      if(!child.pid){clearTimeout(hardStop);error?reject(error):resolve(value);return;}
      child.once("close",settled);child.kill();
    };
    const timer=setTimeout(()=>finish(new HubError("SOURCE_UNREADABLE","App Server discovery timed out.")),Math.max(1,Math.min(8000,(control.deadline??Infinity)-Date.now())));
    if(control.signal?.aborted){abort();return;}control.signal?.addEventListener("abort",abort,{once:true});
    child.stderr.resume(); child.on("error",()=>finish(new HubError("CODEX_NOT_FOUND","Codex App Server could not start.")));
    child.on("exit",()=>finish(new HubError("SOURCE_UNREADABLE","App Server exited before discovery completed.")));
    lines.on("line",line=>{try{const message=JSON.parse(line);
      if(message.id===1) {
        if(message.error)return finish(new HubError("HOST_VERSION_UNSUPPORTED","App Server initialization failed."));
        child.stdin.write(JSON.stringify({method:"initialized",params:{}})+"\n");
        child.stdin.write(JSON.stringify({id:2,method,params})+"\n");
      } else if(message.id===2) message.error?finish(new HubError("HOST_VERSION_UNSUPPORTED","App Server method unavailable.")):finish(undefined,message.result);
    }catch{finish(new HubError("SOURCE_UNREADABLE","Invalid App Server response."));}});
    child.stdin.write(JSON.stringify({id:1,method:"initialize",params:{clientInfo:{name:"flowhub-discovery",version:VERSION},capabilities:{experimentalApi:false}}})+"\n");
  });
}
