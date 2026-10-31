import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { HubError, type Json } from "../../contracts/src/domain.js";
import type { ConfigReadParams } from "./generated/v2/ConfigReadParams.js";
import type { SkillsListParams } from "./generated/v2/SkillsListParams.js";
import type { ListMcpServerStatusParams } from "./generated/v2/ListMcpServerStatusParams.js";

export const APP_SERVER_SCHEMA_VERSION="0.164.0-alpha.11.1";
/** A new, bounded, read-only session; never attaches to a Desktop thread. */
export async function readAppServer(context: Json, method: "config/read"|"skills/list"|"mcpServerStatus/list", params: ConfigReadParams|SkillsListParams|ListMcpServerStatusParams): Promise<Json> {
  if(context.codexVersion!=="codex-cli "+APP_SERVER_SCHEMA_VERSION) throw new HubError("HOST_VERSION_UNSUPPORTED","App Server schema does not match the installed version.");
  return new Promise((resolve,reject)=>{
    const child=spawn(context.codexPath,["app-server","--stdio"],{cwd:context.canonicalCwd,env:{...process.env,CODEX_HOME:context.codexHome},stdio:["pipe","pipe","pipe"],windowsHide:true});
    const lines=createInterface({input:child.stdout});let done=false;
    const finish=(error?:Error,value?:Json)=>{if(done)return;done=true;clearTimeout(timer);lines.close();child.stdin.end();child.kill();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new HubError("SOURCE_UNREADABLE","App Server discovery timed out.")),8000);
    child.stderr.resume(); child.on("error",()=>finish(new HubError("CODEX_NOT_FOUND","Codex App Server could not start.")));
    child.on("exit",()=>finish(new HubError("SOURCE_UNREADABLE","App Server exited before discovery completed.")));
    lines.on("line",line=>{try{const message=JSON.parse(line);
      if(message.id===1) {
        if(message.error)return finish(new HubError("HOST_VERSION_UNSUPPORTED","App Server initialization failed."));
        child.stdin.write(JSON.stringify({method:"initialized",params:{}})+"\n");
        child.stdin.write(JSON.stringify({id:2,method,params})+"\n");
      } else if(message.id===2) message.error?finish(new HubError("HOST_VERSION_UNSUPPORTED","App Server method unavailable.")):finish(undefined,message.result);
    }catch{finish(new HubError("SOURCE_UNREADABLE","Invalid App Server response."));}});
    child.stdin.write(JSON.stringify({id:1,method:"initialize",params:{clientInfo:{name:"flowhub-discovery",version:"2.0.0-alpha.1"},capabilities:{experimentalApi:false}}})+"\n");
  });
}
